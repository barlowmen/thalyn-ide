/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'crypto';
import { Agent, type AgentTurnContext, type QueryFn } from './agent';
import { loadAnthropicApiKey } from './keychain';
import type {
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
 *    stream `message.chunk` notifications back; request user approval for
 *    destructive tools via `tool.approval.request` notifications and wait
 *    for `tool.approval.reply`.
 */
export function main(): void {
	const server = new RpcServer(process.stdin, process.stdout);
	server.register<PingParams, PingResult>('ping', () => ({ timestamp: Date.now() }));

	const agent = buildAgent(server, defaultSdkLoader);
	server.register<MessageSendParams, MessageSendResult>(
		'message.send',
		params => agent.runTurn(params),
	);
	server.registerNotification<ToolApprovalReplyParams>(
		'tool.approval.reply',
		params => agent.handleApprovalReply(params),
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
 * Constructs an Agent wired to the given RPC server. The SDK loader is
 * injected so tests can substitute a fake; production supplies
 * `defaultSdkLoader` which dynamically imports `@anthropic-ai/claude-agent-sdk`
 * and reads the API key from Keychain (with an env-var fallback) on the
 * first turn.
 */
export function buildAgent(server: RpcServer, sdkLoader: () => Promise<QueryFn>): Agent {
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
		requestApproval: params => server.notify('tool.approval.request', params),
		cwd: process.cwd(),
		newApprovalId: () => randomUUID(),
	});
}

async function defaultSdkLoader(): Promise<QueryFn> {
	const sdk = await import('@anthropic-ai/claude-agent-sdk');
	return sdk.query as unknown as QueryFn;
}

if (require.main === module) {
	main();
}
