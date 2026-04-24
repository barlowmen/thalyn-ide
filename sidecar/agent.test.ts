/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import {
	Agent,
	type AgentDeps,
	type QueryFn,
	type SdkMessageSurface,
} from './agent';
import type {
	MessageChunkParams,
	ToolApprovalRequestParams,
} from './protocol';

/**
 * Drives a scripted AsyncIterable of SDK messages so we can exercise the
 * streaming/approval flow without touching the real Claude Agent SDK. The
 * `capturedOptions` handle lets tests assert that the SDK is invoked with
 * the expected `allowedTools` / `canUseTool` / env shape.
 */
function scriptedQuery(messages: Array<SdkMessageSurface | ((canUseTool: NonNullable<Parameters<QueryFn>[0]['options']>['canUseTool']) => Promise<SdkMessageSurface>)>) {
	const capturedOptions: { value: NonNullable<Parameters<QueryFn>[0]['options']> | undefined } = { value: undefined };
	const query: QueryFn = ({ options }) => {
		capturedOptions.value = options;
		const iterator = (async function* () {
			for (const entry of messages) {
				if (typeof entry === 'function') {
					yield await entry(options!.canUseTool);
				} else {
					yield entry;
				}
			}
		})();
		return iterator;
	};
	return { query, capturedOptions };
}

interface Captured {
	readonly chunks: MessageChunkParams[];
	readonly approvals: ToolApprovalRequestParams[];
}

function buildDeps(query: QueryFn): { deps: AgentDeps; captured: Captured } {
	const chunks: MessageChunkParams[] = [];
	const approvals: ToolApprovalRequestParams[] = [];
	let approvalCounter = 0;
	const deps: AgentDeps = {
		getTurnContext: async () => ({ query, env: { ANTHROPIC_API_KEY: 'sk-test' } }),
		emitChunk: params => chunks.push(params),
		requestApproval: params => approvals.push(params),
		cwd: '/tmp',
		newApprovalId: () => `approval-${++approvalCounter}`,
	};
	return { deps, captured: { chunks, approvals } };
}

const assistantMessage = (text: string, sessionId?: string): SdkMessageSurface => ({
	type: 'assistant',
	message: { content: [{ type: 'text', text }] },
	session_id: sessionId,
});

const resultSuccess = (sessionId = 'session-1'): SdkMessageSurface => ({
	type: 'result',
	subtype: 'success',
	session_id: sessionId,
	result: 'done',
	is_error: false,
});

describe('Agent.runTurn', () => {
	it('forwards assistant text as message.chunk notifications and resolves on result', async () => {
		const { query } = scriptedQuery([
			assistantMessage('Hello'),
			assistantMessage(' world'),
			resultSuccess(),
		]);
		const { deps, captured } = buildDeps(query);
		const agent = new Agent(deps);

		const result = await agent.runTurn({ correlationId: 't1', text: 'hi' });

		expect(result).toEqual({
			correlationId: 't1',
			subtype: 'success',
			sessionId: 'session-1',
			errorKind: undefined,
			errorMessage: undefined,
		});
		const textChunks = captured.chunks.filter(c => c.kind === 'text');
		expect(textChunks.map(c => c.text)).toEqual(['Hello', ' world']);
		expect(captured.chunks[captured.chunks.length - 1]).toEqual({ correlationId: 't1', kind: 'done' });
	});

	it('auto-approves Read without emitting a tool.approval.request', async () => {
		const { query } = scriptedQuery([
			async (canUseTool) => {
				const decision = await canUseTool!('Read', { file_path: '/tmp/a.txt' }, { signal: new AbortController().signal, toolUseID: 'tu1' });
				expect(decision).toEqual({ behavior: 'allow', updatedInput: { file_path: '/tmp/a.txt' } });
				return resultSuccess();
			},
		]);
		const { deps, captured } = buildDeps(query);
		const agent = new Agent(deps);

		await agent.runTurn({ correlationId: 't1', text: 'read the file' });

		expect(captured.approvals).toHaveLength(0);
	});

	it('routes Write through tool.approval.request and honours approve', async () => {
		const { query } = scriptedQuery([
			async (canUseTool) => {
				const decision = await canUseTool!('Write', { file_path: '/tmp/a.txt', content: 'hi' }, { signal: new AbortController().signal, toolUseID: 'tu1' });
				expect(decision).toEqual({ behavior: 'allow', updatedInput: { file_path: '/tmp/a.txt', content: 'hi' } });
				return resultSuccess();
			},
		]);
		const { deps, captured } = buildDeps(query);
		const agent = new Agent(deps);

		const turnPromise = agent.runTurn({ correlationId: 't1', text: 'write a file' });

		// Wait for the approval request to land, then reply `approve`.
		await waitFor(() => captured.approvals.length === 1);
		expect(captured.approvals[0].toolName).toBe('Write');
		expect(captured.approvals[0].toolTier).toBe('write');
		expect(captured.approvals[0].summary).toBe('Create or overwrite /tmp/a.txt');
		agent.handleApprovalReply({ correlationId: captured.approvals[0].correlationId, decision: 'approve' });

		await turnPromise;
	});

	it('returns a deny decision with the user reason on decline', async () => {
		const { query } = scriptedQuery([
			async (canUseTool) => {
				const decision = await canUseTool!('Bash', { command: 'rm -rf /' }, { signal: new AbortController().signal, toolUseID: 'tu1' });
				expect(decision).toEqual({ behavior: 'deny', message: 'Dangerous command rejected.' });
				return resultSuccess();
			},
		]);
		const { deps, captured } = buildDeps(query);
		const agent = new Agent(deps);

		const turnPromise = agent.runTurn({ correlationId: 't1', text: 'cleanup' });
		await waitFor(() => captured.approvals.length === 1);
		agent.handleApprovalReply({
			correlationId: captured.approvals[0].correlationId,
			decision: 'decline',
			declineReason: 'Dangerous command rejected.',
		});
		await turnPromise;

		const denied = captured.chunks.find(c => c.kind === 'tool_denied');
		expect(denied).toBeDefined();
		expect(denied!.toolName).toBe('Bash');
		expect(denied!.errorMessage).toBe('Dangerous command rejected.');
	});

	it('approve-for-session skips the approval prompt on subsequent calls of the same tool', async () => {
		let firstCall = true;
		const { query } = scriptedQuery([
			async (canUseTool) => {
				if (firstCall) {
					firstCall = false;
					const first = await canUseTool!('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID: 'tu1' });
					expect(first.behavior).toBe('allow');
					const second = await canUseTool!('Bash', { command: 'pwd' }, { signal: new AbortController().signal, toolUseID: 'tu2' });
					expect(second.behavior).toBe('allow');
					return resultSuccess();
				}
				throw new Error('scripted query consumed twice');
			},
		]);
		const { deps, captured } = buildDeps(query);
		const agent = new Agent(deps);

		const turnPromise = agent.runTurn({ correlationId: 't1', text: 'run commands' });
		await waitFor(() => captured.approvals.length === 1);
		agent.handleApprovalReply({
			correlationId: captured.approvals[0].correlationId,
			decision: 'approve-for-session',
		});
		await turnPromise;

		// Only the first invocation should have surfaced an approval request.
		expect(captured.approvals).toHaveLength(1);
	});

	it.each([
		{ name: 'network (ECONNREFUSED)', message: 'fetch failed: ECONNREFUSED localhost:443', kind: 'network' },
		{ name: 'auth (401)', message: 'Request failed with status 401: Unauthorized', kind: 'auth' },
		{ name: 'auth (invalid api key)', message: 'Invalid API key provided', kind: 'auth' },
		{ name: 'rate limit (429)', message: 'Request failed with status 429: Too Many Requests', kind: 'rate_limit' },
		{ name: 'rate limit (phrase)', message: 'You have hit the rate limit for this model', kind: 'rate_limit' },
		{ name: 'unknown (500)', message: 'Internal server error', kind: 'unknown' },
	])('classifies SDK iterator error: $name', async ({ message, kind }) => {
		const failingQuery: QueryFn = () => {
			return (async function* (): AsyncGenerator<SdkMessageSurface, void, unknown> {
				throw new Error(message);
			})();
		};
		const { deps, captured } = buildDeps(failingQuery);
		const agent = new Agent(deps);

		const result = await agent.runTurn({ correlationId: 't1', text: 'hi' });

		expect(result.subtype).toBe('error');
		expect(result.errorKind).toBe(kind);
		const errorChunk = captured.chunks.find(c => c.kind === 'error');
		expect(errorChunk).toBeDefined();
		expect(errorChunk!.errorKind).toBe(kind);
	});

	it('reports an auth error when getTurnContext throws', async () => {
		const deps: AgentDeps = {
			getTurnContext: async () => { throw new Error('Anthropic API key not found'); },
			emitChunk: () => { },
			requestApproval: () => { },
			cwd: '/tmp',
			newApprovalId: () => 'a',
		};
		const agent = new Agent(deps);
		const result = await agent.runTurn({ correlationId: 't1', text: 'hi' });
		expect(result.subtype).toBe('error');
		expect(result.errorKind).toBe('auth');
	});

	it('rejects a second concurrent message.send', async () => {
		const { query } = scriptedQuery([
			async () => {
				await new Promise(resolve => setTimeout(resolve, 20));
				return resultSuccess();
			},
		]);
		const { deps } = buildDeps(query);
		const agent = new Agent(deps);

		const first = agent.runTurn({ correlationId: 't1', text: 'first' });
		const second = await agent.runTurn({ correlationId: 't2', text: 'second' });

		expect(second.subtype).toBe('error');
		expect(second.errorMessage).toMatch(/already in progress/);
		await first;
	});
});

describe('Agent SDK option shape', () => {
	it('configures the SDK with Read pre-approved and destructive tools gated through canUseTool', async () => {
		const { query, capturedOptions } = scriptedQuery([resultSuccess()]);
		const { deps } = buildDeps(query);
		const agent = new Agent(deps);
		await agent.runTurn({ correlationId: 't1', text: 'hi' });

		const options = capturedOptions.value!;
		expect(options.allowedTools).toEqual(['Read']);
		expect(options.tools).toEqual(['Read', 'Write', 'Edit', 'Bash']);
		expect(options.permissionMode).toBe('default');
		expect(typeof options.canUseTool).toBe('function');
		expect(options.env!.ANTHROPIC_API_KEY).toBe('sk-test');
		// settingSources must be [] so the user's ~/.claude/settings.json
		// allowlist does not bypass the harness approval gate.
		expect(options.settingSources).toEqual([]);
	});
});

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error('waitFor timed out');
		}
		await new Promise(resolve => setTimeout(resolve, 5));
	}
}
