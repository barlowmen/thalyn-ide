/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Tracer } from '@opentelemetry/api';
import { randomUUID } from 'crypto';
import { mkdir } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { Agent } from './agent';
import {
	ClaudeAdapter,
	type ClaudeCanUseTool,
	type ClaudePermissionResult,
	type ClaudeQueryFn,
} from './harness/brain/claude-adapter';
import type { BrainRequest } from './harness/brain/types';
import { loadBudgetConfigWithOverride } from './harness/budget/config';
import { DefaultEstimator } from './harness/budget/estimator';
import { BudgetMeter } from './harness/budget/meter';
import type { BudgetConfig, CallDescriptor } from './harness/budget/types';
import { RulesLoader } from './harness/memory/rules-loader';
import { SdkMemory } from './harness/memory/sdk-memory';
import { SqliteSpanExporter } from './harness/observability/otel-sqlite-exporter';
import { HarnessTracerProvider } from './harness/observability/tracer';
import { Persistence } from './harness/persistence';
import { ApprovalGate } from './harness/tools/approval';
import { loadAnthropicApiKey } from './keychain';
import { allowedTools as harnessAllowedTools, enabledTools, getToolDefinition } from './tools';
import type {
	BudgetApprovalReplyParams,
	BudgetSnapshotParams,
	BudgetSnapshotResult,
	MessageSendParams,
	MessageSendResult,
	PingParams,
	PingResult,
	ToolApprovalReplyParams,
} from './protocol';
import { RpcServer } from './rpc';

/**
 * Thalyn sidecar entry point.
 *
 * Spawned by the extension host (`extensions/agent-panel/`) as a long-lived
 * Node child process. Communicates with the extension over stdin/stdout
 * using newline-delimited JSON-RPC 2.0.
 *
 * Responsibilities:
 *  - `ping` — liveness.
 *  - `message.send` — run a single turn against the Claude Agent SDK and
 *    stream `message.chunk` notifications back; gate destructive tools
 *    through the harness `ApprovalGate` and wait for
 *    `tool.approval.reply` before the SDK proceeds (API-key auth only —
 *    under OAuth the bundled CLI bypasses the SDK hook, and the gate's
 *    belt-and-braces role carries over to the dispatcher's `invoke()`
 *    path once tool execution routes through it).
 */
export async function main(): Promise<void> {
	const server = new RpcServer(process.stdin, process.stdout);
	server.register<PingParams, PingResult>('ping', () => ({ timestamp: Date.now() }));

	const paths = thalynPaths();
	await mkdir(paths.configDir, { recursive: true });

	const gate = buildApprovalGate(server);
	const budget = await buildBudgetSubsystem(server, paths);
	const tracerProvider = buildTracerProvider(budget.persistence);
	const tracer = tracerProvider.getTracer('thalyn-sidecar');
	const memory = await buildMemoryWiring(process.cwd());
	const agent = buildAgent(server, gate, budget, tracer, defaultSdkLoader, {
		systemPrompt: memory.systemPrompt,
		memoryDirectory: memory.memoryDirectory,
	});

	// Best-effort flush of in-flight spans on graceful shutdown so the
	// last few seconds of a turn don't drop. SIGKILL bypasses this; for
	// that, the SimpleSpanProcessor inside HarnessTracerProvider writes
	// every span synchronously when it ends, so the loss window is at
	// most one in-flight span.
	const shutdown = async (): Promise<void> => {
		try {
			await tracerProvider.shutdown();
		} catch {
			// Ignore — we're going down anyway.
		}
	};
	process.once('SIGTERM', () => { void shutdown().then(() => process.exit(0)); });
	process.once('SIGINT', () => { void shutdown().then(() => process.exit(0)); });
	server.register<MessageSendParams, MessageSendResult>(
		'message.send',
		params => agent.runTurn(params),
	);
	server.registerNotification<ToolApprovalReplyParams>(
		'tool.approval.reply',
		params => gate.handleReply(params),
	);
	server.register<BudgetSnapshotParams, BudgetSnapshotResult>(
		'budget.snapshot',
		() => budget.meter.snapshot(),
	);
	server.registerNotification<BudgetApprovalReplyParams>(
		'budget.approval.reply',
		params => budget.meter.handleApprovalReply(params),
	);

	// Keep the process alive on stdout EPIPE when the parent goes away; Node
	// would otherwise throw an uncaught error. The extension host owns our
	// lifecycle via SIGTERM on deactivation.
	process.stdout.on('error', (err: NodeJS.ErrnoException) => {
		if (err.code === 'EPIPE') {
			process.exit(0);
		}
	});
}

/**
 * Harness-owned approval gate. Fires `tool.approval.request` at the
 * webview and resolves on the matching reply. One gate per sidecar —
 * approval state (`sessionApprovedTools`, pending prompts) is shared
 * across the Claude adapter's SDK-level `canUseTool` hook today and
 * across the dispatcher's `invoke()` path once tool execution routes
 * through it.
 */
export function buildApprovalGate(server: RpcServer): ApprovalGate {
	return new ApprovalGate({
		requestApproval: params => server.notify('tool.approval.request', params),
		newApprovalId: () => randomUUID(),
	});
}

/**
 * Wiring resolved at session start that the Agent and adapter both
 * consume. Loaded once because per-session semantics: rule files and
 * the memory directory don't change mid-session.
 */
export interface AgentWiring {
	/** Three-layer rules concatenated into a system-prompt prefix. */
	readonly systemPrompt: string;
	/** Absolute path the SDK Memory Tool should write to. */
	readonly memoryDirectory: string;
	/** Defaults to {@link DEFAULT_BRAIN_MODEL} when omitted. */
	readonly model?: string;
}

/**
 * Constructs an Agent driving a {@link ClaudeAdapter}-backed brain. The
 * SDK loader is injected so tests can substitute a fake; production
 * supplies `defaultSdkLoader`, which dynamically imports
 * `@anthropic-ai/claude-agent-sdk` and reads the API key from Keychain
 * (with an env-var fallback) on the first turn.
 *
 * The adapter is built lazily on the first message so sidecar bootstrap
 * doesn't trigger a Keychain prompt or pull the SDK into memory until
 * the user actually sends a message. After that, every turn shares the
 * same adapter (and therefore the same SDK session, budget meter, and
 * approval gate state).
 */
export function buildAgent(
	server: RpcServer,
	gate: ApprovalGate,
	budget: BudgetSubsystem,
	tracer: Tracer,
	sdkLoader: () => Promise<ClaudeQueryFn>,
	wiring: AgentWiring,
): Agent {
	const canUseTool = buildCanUseTool(server, gate);
	const model = wiring.model ?? DEFAULT_BRAIN_MODEL;

	return new Agent({
		getBrain: buildBrainLoader({
			server, gate, budget, tracer, sdkLoader, model, canUseTool,
			memoryDirectory: wiring.memoryDirectory,
		}),
		emitChunk: params => server.notify('message.chunk', params),
		approvalGate: gate,
		systemPrompt: wiring.systemPrompt,
	});
}

/**
 * Construct the harness tracer, registering the SQLite exporter so every
 * GenAI span lands in the session DB's `traces` table alongside the
 * budget ledger. SQLite is the system of record; additional exporters
 * (Langfuse, Helicone, Datadog, SigNoz) plug in via standard OTEL
 * exporters with one call to `tracerProvider.addExporter(...)`.
 */
export function buildTracerProvider(persistence: Persistence): HarnessTracerProvider {
	return new HarnessTracerProvider({
		serviceName: 'thalyn-sidecar',
		serviceVersion: '0.3.0',
		exporters: [new SqliteSpanExporter(persistence)],
	});
}

/**
 * Resolve the rules + SDK memory state used by every turn in this session.
 * Identity, agent preferences, and per-project rules are loaded from their
 * standard locations and concatenated into a system-prompt prefix. The
 * SDK memory directory under `~/.config/thalyn/memories/claude/` is
 * created if missing — the Memory Tool then uses it via the adapter's
 * inline `settings.autoMemoryDirectory`.
 */
export async function buildMemoryWiring(workspaceDir: string): Promise<{
	systemPrompt: string;
	memoryDirectory: string;
}> {
	const rules = new RulesLoader(RulesLoader.defaultPaths(workspaceDir));
	const ruleFiles = await rules.load();
	const systemPrompt = RulesLoader.assemble(ruleFiles);

	const memory = new SdkMemory({ dir: SdkMemory.defaultDir('claude') });
	await memory.ensure();

	return { systemPrompt, memoryDirectory: memory.path };
}

/** Default Claude model used by the primary-brain adapter. */
export const DEFAULT_BRAIN_MODEL = 'claude-opus-4-7';

interface BrainLoaderDeps {
	readonly server: RpcServer;
	readonly gate: ApprovalGate;
	readonly budget: BudgetSubsystem;
	readonly tracer: Tracer;
	readonly sdkLoader: () => Promise<ClaudeQueryFn>;
	readonly model: string;
	readonly canUseTool: ClaudeCanUseTool;
	readonly memoryDirectory: string;
}

/**
 * Returns a function that resolves a {@link ClaudeAdapter} on first
 * call and caches it for subsequent calls. Defers Keychain access and
 * SDK import to the first turn.
 */
function buildBrainLoader(deps: BrainLoaderDeps): () => Promise<ClaudeAdapter> {
	let cached: ClaudeAdapter | undefined;
	return async () => {
		if (cached) {
			return cached;
		}
		const apiKey = await loadAnthropicApiKey();
		const query = await deps.sdkLoader();
		// When no Thalyn-managed key is configured, pass process.env through
		// unchanged so the bundled Claude Code CLI can authenticate using the
		// OAuth tokens it manages under ~/.claude/.
		const env: NodeJS.ProcessEnv = apiKey
			? { ...process.env, ANTHROPIC_API_KEY: apiKey.key }
			: { ...process.env };
		cached = new ClaudeAdapter({
			query,
			cwd: process.cwd(),
			env,
			model: deps.model,
			tools: enabledTools(),
			allowedTools: harnessAllowedTools(),
			permissionMode: 'default',
			canUseTool: deps.canUseTool,
			// Inline `settings` redirects the SDK Memory Tool to our
			// harness-managed directory. This is the only place the SDK
			// reads `autoMemoryDirectory` from when `settingSources` is
			// `[]` — and we keep `settingSources: []` so a stray
			// ~/.claude/settings.json cannot widen tool permissions.
			settings: {
				autoMemoryDirectory: deps.memoryDirectory,
			},
			budget: {
				meter: deps.budget.meter,
				tracer: deps.tracer,
				category: subagentCategoryForModel(deps.model),
				sessionId: deps.budget.sessionId,
				system: '',
				estimateCall: estimateBrainCall,
			},
		});
		return cached;
	};
}

/**
 * Glue between the SDK's per-tool permission hook and the harness
 * `ApprovalGate`. The `canUseTool` callback the SDK calls is delegated
 * straight through so the gate's tier policy and session-approval cache
 * are the authoritative decision-maker.
 *
 * Note: the SDK does not surface the enclosing turn's correlation id to
 * `canUseTool`. The gate uses `toolUseID` as the per-prompt identifier
 * and tracks turn membership via {@link ApprovalGate.cancelForTurn},
 * which the Agent invokes when a turn ends. Until the dispatcher's
 * `invoke()` owns tool execution and supplies the turn id directly,
 * passing an empty string here is acceptable: cancel-for-turn keys off
 * the per-prompt id, not the turn id.
 */
function buildCanUseTool(_server: RpcServer, gate: ApprovalGate): ClaudeCanUseTool {
	return async (toolName, input, opts): Promise<ClaudePermissionResult> => {
		const def = getToolDefinition(toolName);
		const tier = def ? def.tier : 'external';
		const summary = def ? def.summarize(input) : `Use ${toolName}`;
		const outcome = await gate.check({
			toolName,
			tier,
			toolUseId: opts.toolUseID,
			turnCorrelationId: '',
			summary,
			input,
		});
		if (outcome.outcome === 'approve') {
			return { behavior: 'allow', updatedInput: input };
		}
		return { behavior: 'deny', message: outcome.reason };
	};
}

/**
 * Map a Claude model id to the budget category it meters against. Opus,
 * Sonnet, and Haiku each have their own per-call/daily/weekly caps so a
 * worker downshift in `workers.yaml` automatically re-buckets the spend.
 */
function subagentCategoryForModel(model: string): string {
	if (model.includes('opus')) {
		return 'subagent_opus';
	}
	if (model.includes('sonnet')) {
		return 'subagent_sonnet';
	}
	if (model.includes('haiku')) {
		return 'subagent_haiku';
	}
	// Unknown Claude families default to opus pricing — conservative
	// (over-reserves rather than under-meters) until a category is added.
	return 'subagent_opus';
}

/**
 * Pre-flight estimator the meter calls before each brain turn. Counts
 * input characters across the system prompt and message history,
 * approximates one token per four characters (a reasonable BPE-ish
 * heuristic for English-heavy content), and assumes the response will
 * fill the conservative output ceiling below. Underestimates input
 * tokens when the messages contain dense non-Latin scripts; overestimates
 * output cost on most turns. Reconciliation at commit time absorbs both
 * directions once real usage numbers are surfaced by the SDK.
 */
function estimateBrainCall(request: BrainRequest, model: string | undefined): CallDescriptor {
	let chars = request.system.length;
	for (const msg of request.messages) {
		for (const block of msg.content) {
			if (block.type === 'text') {
				chars += block.text.length;
			} else if (block.type === 'tool_use') {
				chars += JSON.stringify(block.input).length + block.name.length;
			} else if (block.type === 'tool_result') {
				if (typeof block.content === 'string') {
					chars += block.content.length;
				} else {
					chars += JSON.stringify(block.content).length;
				}
			}
		}
	}
	const inputTokens = Math.max(1, Math.ceil(chars / 4));
	return {
		model: model ?? DEFAULT_BRAIN_MODEL,
		inputTokens,
		maxOutputTokens: 4096,
	};
}

/**
 * Build the budget subsystem the sidecar exposes over RPC. Persistence
 * opens the on-disk session DB at `paths.sessionDbPath`; meters, ledger,
 * conversation history, and OTEL traces survive sidecar restarts. The
 * budget config is the deep-merged result of the committed defaults at
 * `sidecar/config/budgets.yaml` and (when present) the user override at
 * `~/.config/thalyn/budgets.yaml`.
 */
export async function buildBudgetSubsystem(server: RpcServer, paths: ThalynPaths): Promise<BudgetSubsystem> {
	const config = await loadBudgetConfigWithOverride(paths.committedBudgetsPath, paths.budgetsOverridePath);
	const persistence = new Persistence(paths.sessionDbPath);
	const sessionId = `s_${randomUUID()}`;
	persistence.upsertSession(sessionId, Date.now());
	const meter = new BudgetMeter(config, new DefaultEstimator(), persistence, {
		requestApproval: params => server.notify('budget.approval.request', params),
		newApprovalId: () => randomUUID(),
		now: () => Date.now(),
		onLedgerChanged: () => server.notify('budget.changed', undefined),
	});
	return { config, persistence, meter, sessionId };
}

export interface BudgetSubsystem {
	readonly config: BudgetConfig;
	readonly persistence: Persistence;
	readonly meter: BudgetMeter;
	readonly sessionId: string;
}

/**
 * Filesystem paths the sidecar reads and writes during startup. Centralised
 * so tests and alternate hosts (CI, Linux distros without `~/.config`) can
 * inject overrides without touching the wiring.
 */
export interface ThalynPaths {
	readonly configDir: string;
	readonly committedBudgetsPath: string;
	readonly budgetsOverridePath: string;
	readonly sessionDbPath: string;
}

export function thalynPaths(): ThalynPaths {
	const configDir = join(homedir(), '.config', 'thalyn');
	return {
		configDir,
		committedBudgetsPath: join(__dirname, '..', 'config', 'budgets.yaml'),
		budgetsOverridePath: join(configDir, 'budgets.yaml'),
		sessionDbPath: join(configDir, 'sessions.db'),
	};
}

async function defaultSdkLoader(): Promise<ClaudeQueryFn> {
	const sdk = await import('@anthropic-ai/claude-agent-sdk');
	return sdk.query as unknown as ClaudeQueryFn;
}

if (require.main === module) {
	main().catch(err => {
		// Startup failed before the RPC handlers were registered, so the
		// extension host has no way to receive a structured error. Surface
		// the failure on stderr and exit non-zero; the host treats sidecar
		// exits as a connection error and reports them to the user.
		process.stderr.write(`thalyn sidecar startup failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
		process.exit(1);
	});
}
