/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'crypto';
import { mkdir } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { Agent, type AgentTurnContext, type QueryFn } from './agent';
import { loadBudgetConfigWithOverride } from './harness/budget/config';
import { DefaultEstimator } from './harness/budget/estimator';
import { BudgetMeter } from './harness/budget/meter';
import type { BudgetConfig } from './harness/budget/types';
import { Persistence } from './harness/persistence';
import { ApprovalGate } from './harness/tools/approval';
import { loadAnthropicApiKey } from './keychain';
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
	const agent = buildAgent(server, gate, defaultSdkLoader);
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
 * Constructs an Agent wired to the given RPC server and approval gate.
 * The SDK loader is injected so tests can substitute a fake; production
 * supplies `defaultSdkLoader` which dynamically imports
 * `@anthropic-ai/claude-agent-sdk` and reads the API key from Keychain
 * (with an env-var fallback) on the first turn.
 */
export function buildAgent(server: RpcServer, gate: ApprovalGate, sdkLoader: () => Promise<QueryFn>): Agent {
	let cached: AgentTurnContext | undefined;
	return new Agent({
		getTurnContext: async () => {
			if (cached) {
				return cached;
			}
			const apiKey = await loadAnthropicApiKey();
			const query = await sdkLoader();
			// When no Thalyn-managed key is configured, pass process.env through
			// unchanged so the bundled Claude Code CLI can authenticate using the
			// OAuth tokens it manages under ~/.claude/.
			const env: NodeJS.ProcessEnv = apiKey
				? { ...process.env, ANTHROPIC_API_KEY: apiKey.key }
				: { ...process.env };
			cached = { query, env };
			return cached;
		},
		emitChunk: params => server.notify('message.chunk', params),
		approvalGate: gate,
		cwd: process.cwd(),
	});
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

async function defaultSdkLoader(): Promise<QueryFn> {
	const sdk = await import('@anthropic-ai/claude-agent-sdk');
	return sdk.query as unknown as QueryFn;
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
