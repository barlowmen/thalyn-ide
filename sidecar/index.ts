/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Tracer } from '@opentelemetry/api';
import { randomUUID } from 'crypto';
import { mkdir } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { z } from 'zod';
import { Agent } from './agent';
import {
	ClaudeAdapter,
	type ClaudeCanUseTool,
	type ClaudePermissionResult,
	type ClaudeQueryFn,
} from './harness/brain/claude-adapter';
import type { BrainRequest, CentralBrain } from './harness/brain/types';
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
import { loadWorkersConfig } from './harness/workers/config';
import { type WorkerDispatcher } from './harness/workers/dispatcher';
import {
	buildWorkerDispatcher,
	runSpawnWorker,
} from './harness/workers/spawn-worker-tool';
import type { CentralBrainFactory, CentralBrainFactoryParams } from './harness/workers/types';
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

	const sdk = await defaultSdkLoader();
	const apiKey = await loadAnthropicApiKey();
	// When no Thalyn-managed key is configured, pass process.env through
	// unchanged so the bundled Claude Code CLI can authenticate using the
	// OAuth tokens it manages under ~/.claude/.
	const env: NodeJS.ProcessEnv = apiKey
		? { ...process.env, ANTHROPIC_API_KEY: apiKey.key }
		: { ...process.env };

	const workerDispatcher = await buildWorkerSubsystem({
		sdk, env, budget, tracer, paths,
	});
	const mcpServers = {
		thalyn: sdk.createSdkMcpServer({
			name: 'thalyn',
			version: '0.3.0',
			tools: [
				sdk.tool(
					'spawn_worker',
					[
						'Delegate a bounded task to a sub-agent worker. Returns the',
						'worker\'s text response after it finishes. Use a role that',
						'matches the task: `researcher` for read-only investigation,',
						'`implementer` for write actions, `reviewer` for read-only',
						'critique, `tester` for running tests. The worker has its',
						'own context window and tool allowlist; it cannot see this',
						'conversation\'s history.',
					].join(' '),
					{
						role: z.enum(['researcher', 'implementer', 'reviewer', 'tester']),
						task: z.string(),
					},
					async (args: unknown) => {
						const { role, task } = args as { role: 'researcher' | 'implementer' | 'reviewer' | 'tester'; task: string };
						const out = await runSpawnWorker(workerDispatcher, { role, task });
						return {
							content: [{ type: 'text', text: out.text }],
							isError: out.isError,
						};
					},
				),
			],
		}),
	};

	const agent = buildAgent({
		server, gate, budget, tracer,
		sdk, env,
		wiring: {
			systemPrompt: memory.systemPrompt,
			memoryDirectory: memory.memoryDirectory,
			mcpServers,
		},
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
 * consume. Loaded once because per-session semantics: rule files, the
 * memory directory, and MCP server bindings don't change mid-session.
 */
export interface AgentWiring {
	/** Three-layer rules concatenated into a system-prompt prefix. */
	readonly systemPrompt: string;
	/** Absolute path the SDK Memory Tool should write to. */
	readonly memoryDirectory: string;
	/**
	 * Inline MCP servers to register with the SDK. The harness uses this
	 * to inject `spawn_worker` (and any future built-ins) so the brain
	 * sees them as `mcp__<server>__<tool>`.
	 */
	readonly mcpServers: Record<string, unknown>;
	/** Defaults to {@link DEFAULT_BRAIN_MODEL} when omitted. */
	readonly model?: string;
}

export interface BuildAgentOptions {
	readonly server: RpcServer;
	readonly gate: ApprovalGate;
	readonly budget: BudgetSubsystem;
	readonly tracer: Tracer;
	readonly sdk: SdkSurface;
	readonly env: NodeJS.ProcessEnv;
	readonly wiring: AgentWiring;
}

/**
 * Constructs an Agent driving a {@link ClaudeAdapter}-backed brain.
 *
 * The SDK is injected pre-loaded so the worker subsystem (built before
 * this) can share the same `query` and `createSdkMcpServer` references.
 * Every turn shares the same adapter (and therefore the same SDK
 * session, budget meter, approval gate state, and rule-loaded system
 * prompt).
 */
export function buildAgent(opts: BuildAgentOptions): Agent {
	const canUseTool = buildCanUseTool(opts.server, opts.gate);
	const model = opts.wiring.model ?? DEFAULT_BRAIN_MODEL;
	const adapter = buildPrimaryAdapter({
		sdk: opts.sdk,
		env: opts.env,
		budget: opts.budget,
		tracer: opts.tracer,
		model,
		canUseTool,
		memoryDirectory: opts.wiring.memoryDirectory,
		mcpServers: opts.wiring.mcpServers,
	});

	return new Agent({
		getBrain: async () => adapter,
		emitChunk: params => opts.server.notify('message.chunk', params),
		approvalGate: opts.gate,
		systemPrompt: opts.wiring.systemPrompt,
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

/**
 * Narrow handle on the `@anthropic-ai/claude-agent-sdk` exports the
 * sidecar uses. Captured as a structural type so tests can supply a
 * fake without dragging in the SDK's full surface and so the worker
 * subsystem and primary adapter can share one resolved reference.
 */
export interface SdkSurface {
	readonly query: ClaudeQueryFn;
	readonly createSdkMcpServer: (options: {
		name: string;
		version?: string;
		tools?: ReadonlyArray<unknown>;
	}) => unknown;
	readonly tool: <Schema extends Record<string, unknown>>(
		name: string,
		description: string,
		inputSchema: Schema,
		handler: (args: unknown, extra: unknown) => Promise<unknown>,
	) => unknown;
}

interface BuildPrimaryAdapterDeps {
	readonly sdk: SdkSurface;
	readonly env: NodeJS.ProcessEnv;
	readonly budget: BudgetSubsystem;
	readonly tracer: Tracer;
	readonly model: string;
	readonly canUseTool: ClaudeCanUseTool;
	readonly memoryDirectory: string;
	readonly mcpServers: Record<string, unknown>;
}

/**
 * Construct the primary brain adapter the Agent drives. The harness
 * Agent calls this directly — no laziness — because the SDK and API
 * key were resolved at sidecar startup so the worker subsystem could
 * pre-build its `mcpServers` registration before the first turn.
 */
function buildPrimaryAdapter(deps: BuildPrimaryAdapterDeps): ClaudeAdapter {
	return new ClaudeAdapter({
		query: deps.sdk.query,
		cwd: process.cwd(),
		env: deps.env,
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
		mcpServers: deps.mcpServers,
		budget: {
			meter: deps.budget.meter,
			tracer: deps.tracer,
			category: subagentCategoryForModel(deps.model),
			sessionId: deps.budget.sessionId,
			system: '',
			estimateCall: estimateBrainCall,
		},
	});
}

/**
 * Build the worker dispatcher subsystem the primary brain delegates
 * sub-tasks to via `spawn_worker`. The brain factory constructs a
 * fresh {@link ClaudeAdapter} per spawn so each worker has an isolated
 * brain, isolated cancellation signal, and its own ledger reservation
 * — sharing only the meter, tracer, and gate with the parent.
 */
async function buildWorkerSubsystem(deps: {
	readonly sdk: SdkSurface;
	readonly env: NodeJS.ProcessEnv;
	readonly budget: BudgetSubsystem;
	readonly tracer: Tracer;
	readonly paths: ThalynPaths;
}): Promise<WorkerDispatcher> {
	const overrides = await loadWorkersConfig(deps.paths.committedWorkersPath);
	const brainFactory: CentralBrainFactory = {
		create: ({ model, budgetCategory, sessionId }: CentralBrainFactoryParams): CentralBrain => {
			return new ClaudeAdapter({
				query: deps.sdk.query,
				cwd: process.cwd(),
				env: deps.env,
				model,
				// Workers do not get the harness allowlist, the canUseTool
				// hook, or the settings/mcpServers from the parent. Tool
				// allowlisting is the WorkerDispatcher's job; tool
				// execution is intentionally unwired pending the dispatcher
				// pivot. Reservations and OTEL spans still flow through
				// the shared meter and tracer.
				budget: {
					meter: deps.budget.meter,
					tracer: deps.tracer,
					category: budgetCategory,
					sessionId,
					system: '',
					estimateCall: estimateBrainCall,
				},
			});
		},
	};
	return buildWorkerDispatcher({
		brainFactory,
		sessionId: deps.budget.sessionId,
		overrides,
	});
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
	readonly committedWorkersPath: string;
	readonly sessionDbPath: string;
}

export function thalynPaths(): ThalynPaths {
	const configDir = join(homedir(), '.config', 'thalyn');
	return {
		configDir,
		committedBudgetsPath: join(__dirname, '..', 'config', 'budgets.yaml'),
		budgetsOverridePath: join(configDir, 'budgets.yaml'),
		committedWorkersPath: join(__dirname, '..', 'config', 'workers.yaml'),
		sessionDbPath: join(configDir, 'sessions.db'),
	};
}

async function defaultSdkLoader(): Promise<SdkSurface> {
	const sdk = await import('@anthropic-ai/claude-agent-sdk');
	return {
		query: sdk.query as unknown as ClaudeQueryFn,
		createSdkMcpServer: sdk.createSdkMcpServer as unknown as SdkSurface['createSdkMcpServer'],
		tool: sdk.tool as unknown as SdkSurface['tool'],
	};
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
