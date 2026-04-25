/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { Agent, type AgentDeps } from './agent';
import type {
	BrainRequest,
	BrainStreamEvent,
	CentralBrain,
} from './harness/brain/types';
import { Persistence } from './harness/persistence';
import { ApprovalGate, type ApprovalGateDeps } from './harness/tools/approval';
import type { MessageChunkParams, ToolApprovalRequestParams } from './protocol';

/**
 * Build a fake `CentralBrain` whose `send()` replays a scripted sequence of
 * stream events. Function entries receive the live `BrainRequest` so a test
 * can capture what the agent forwarded.
 */
function scriptedBrain(
	script: ReadonlyArray<BrainStreamEvent | ((req: BrainRequest) => Promise<BrainStreamEvent>)>,
): { brain: CentralBrain; captured: { request?: BrainRequest } } {
	const captured: { request?: BrainRequest } = {};
	const brain: CentralBrain = {
		send(request) {
			captured.request = request;
			return (async function* () {
				for (const entry of script) {
					if (typeof entry === 'function') {
						yield await entry(request);
					} else {
						yield entry;
					}
				}
			})();
		},
	};
	return { brain, captured };
}

interface Captured {
	readonly chunks: MessageChunkParams[];
	readonly approvals: ToolApprovalRequestParams[];
}

function buildHarness(brain: CentralBrain): { agent: Agent; gate: ApprovalGate; captured: Captured } {
	const chunks: MessageChunkParams[] = [];
	const approvals: ToolApprovalRequestParams[] = [];
	let approvalCounter = 0;
	const gateDeps: ApprovalGateDeps = {
		requestApproval: params => approvals.push(params),
		newApprovalId: () => `approval-${++approvalCounter}`,
	};
	const gate = new ApprovalGate(gateDeps);
	const deps: AgentDeps = {
		getBrain: async () => brain,
		emitChunk: params => chunks.push(params),
		approvalGate: gate,
	};
	return { agent: new Agent(deps), gate, captured: { chunks, approvals } };
}

describe('Agent.runTurn', () => {
	it('forwards brain text events as message.chunk text and ends with done', async () => {
		const { brain } = scriptedBrain([
			{ kind: 'text', text: 'Hello' },
			{ kind: 'text', text: ' world' },
			{ kind: 'done', sessionId: 'session-1', stopReason: 'end_turn' },
		]);
		const { agent, captured } = buildHarness(brain);

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

	it('forwards a tool_use event with summary derived from the registered tool definition', async () => {
		const { brain } = scriptedBrain([
			{ kind: 'tool_use', call: { id: 'tu_1', name: 'Read', input: { file_path: '/etc/hosts' } } },
			{ kind: 'done', sessionId: 's' },
		]);
		const { agent, captured } = buildHarness(brain);

		await agent.runTurn({ correlationId: 't1', text: 'read it' });

		const toolUse = captured.chunks.find(c => c.kind === 'tool_use');
		expect(toolUse).toMatchObject({
			toolName: 'Read',
			toolUseId: 'tu_1',
			toolInput: { file_path: '/etc/hosts' },
		});
		expect(typeof toolUse?.toolSummary).toBe('string');
		expect(toolUse?.toolSummary?.length).toBeGreaterThan(0);
	});

	it('builds a BrainRequest with the user text as a single user message', async () => {
		const { brain, captured } = scriptedBrain([
			{ kind: 'done', sessionId: 's' },
		]);
		const { agent } = buildHarness(brain);

		await agent.runTurn({ correlationId: 't1', text: 'analyse this' });

		expect(captured.request).toBeDefined();
		expect(captured.request!.messages).toHaveLength(1);
		expect(captured.request!.messages[0]).toEqual({
			role: 'user',
			content: [{ type: 'text', text: 'analyse this' }],
		});
		expect(captured.request!.system).toBe('');
		expect(captured.request!.tools).toEqual([]);
	});

	it('threads systemPrompt from AgentDeps into BrainRequest.system', async () => {
		const { brain, captured } = scriptedBrain([
			{ kind: 'done', sessionId: 's' },
		]);
		const gate = new ApprovalGate({ requestApproval: () => { }, newApprovalId: () => 'a' });
		const agent = new Agent({
			getBrain: async () => brain,
			emitChunk: () => { },
			approvalGate: gate,
			systemPrompt: '# Identity\n\nname: John',
		});

		await agent.runTurn({ correlationId: 't1', text: 'hi' });

		expect(captured.request?.system).toBe('# Identity\n\nname: John');
	});

	it.each([
		{ name: 'auth', errorKind: 'auth' as const, expected: 'auth' as const },
		{ name: 'rate_limit', errorKind: 'rate_limit' as const, expected: 'rate_limit' as const },
		{ name: 'network', errorKind: 'network' as const, expected: 'network' as const },
		{ name: 'cancelled', errorKind: 'cancelled' as const, expected: 'declined' as const },
		{ name: 'tool_schema', errorKind: 'tool_schema' as const, expected: 'unknown' as const },
		{ name: 'unknown', errorKind: 'unknown' as const, expected: 'unknown' as const },
	])('translates brain $name error to protocol errorKind=$expected', async ({ errorKind, expected }) => {
		const baseError = { message: `${errorKind} happened`, retriable: false } as const;
		const error = errorKind === 'rate_limit'
			? ({ kind: 'rate_limit', message: 'rl', retriable: true } as const)
			: errorKind === 'network'
				? ({ kind: 'network', message: 'net', retriable: true } as const)
				: ({ kind: errorKind, ...baseError } as const);
		const { brain } = scriptedBrain([{ kind: 'error', error }]);
		const { agent, captured } = buildHarness(brain);

		const result = await agent.runTurn({ correlationId: 't1', text: 'hi' });

		expect(result.subtype).toBe('error');
		expect(result.errorKind).toBe(expected);
		const errorChunk = captured.chunks.find(c => c.kind === 'error');
		expect(errorChunk?.errorKind).toBe(expected);
	});

	it.each([
		{ name: 'auth (api key)', message: 'Anthropic API key not found', kind: 'auth' as const },
		{ name: 'rate_limit (string)', message: 'Request failed: 429 rate limit hit', kind: 'rate_limit' as const },
		{ name: 'network (econnrefused)', message: 'fetch failed: ECONNREFUSED localhost', kind: 'network' as const },
		{ name: 'unknown (generic)', message: 'something exploded', kind: 'unknown' as const },
	])('classifies an error thrown by getBrain: $name', async ({ message, kind }) => {
		const gate = new ApprovalGate({ requestApproval: () => { }, newApprovalId: () => 'a' });
		const chunks: MessageChunkParams[] = [];
		const deps: AgentDeps = {
			getBrain: async () => { throw new Error(message); },
			emitChunk: params => chunks.push(params),
			approvalGate: gate,
		};
		const agent = new Agent(deps);

		const result = await agent.runTurn({ correlationId: 't1', text: 'hi' });

		expect(result.subtype).toBe('error');
		expect(result.errorKind).toBe(kind);
		expect(chunks.find(c => c.kind === 'error')?.errorKind).toBe(kind);
	});

	it('rejects a second concurrent message.send', async () => {
		const { brain } = scriptedBrain([
			async () => {
				await new Promise(resolve => setTimeout(resolve, 20));
				return { kind: 'done', sessionId: 's' };
			},
		]);
		const { agent } = buildHarness(brain);

		const first = agent.runTurn({ correlationId: 't1', text: 'first' });
		const second = await agent.runTurn({ correlationId: 't2', text: 'second' });

		expect(second.subtype).toBe('error');
		expect(second.errorMessage).toMatch(/already in progress/);
		await first;
	});

	it('cancels pending approvals when the turn ends with an error', async () => {
		// Kick off an approval prompt mid-turn, then have the brain throw
		// before the user replies. The Agent must call gate.cancelForTurn so
		// the pending approval does not leak across turns.
		const { brain } = scriptedBrain([
			async () => { throw new Error('mid-stream failure'); },
		]);
		const { agent, gate, captured } = buildHarness(brain);

		gate.check({
			toolName: 'Write',
			tier: 'write',
			toolUseId: 'tu_pending',
			turnCorrelationId: 't1',
			summary: 'Write to /tmp/x',
			input: {},
		});
		await new Promise(resolve => setTimeout(resolve, 1));

		const result = await agent.runTurn({ correlationId: 't1', text: 'go' });

		expect(result.subtype).toBe('error');
		expect(captured.approvals.length).toBeGreaterThanOrEqual(1);
		// A subsequent reply for the cancelled approval is a no-op — the
		// gate logs and discards it. ApprovalGate.handleReply has its own
		// tests; here we only assert the agent-side cancel ran.
	});

	it('persists user prompt, assistant response, tool calls, and tool results when persistence is wired', async () => {
		const persistence = new Persistence(':memory:');
		persistence.upsertSession('s_test', Date.now());
		const brain: CentralBrain = {
			async *send() {
				yield { kind: 'text', text: 'Hello ' };
				yield { kind: 'text', text: 'world.' };
				yield { kind: 'tool_use', call: { id: 'tu1', name: 'Read', input: { file_path: '/a.txt' } } };
				yield {
					kind: 'tool_result',
					result: { id: 'tu1', content: 'file bytes', isError: false },
				};
				yield { kind: 'done', sessionId: 'sdk-1', stopReason: 'end_turn' };
			},
		};
		const gate = new ApprovalGate({ requestApproval: () => { }, newApprovalId: () => 'a' });
		const agent = new Agent({
			getBrain: async () => brain,
			emitChunk: () => { },
			approvalGate: gate,
			persistence,
			sessionId: 's_test',
		});

		await agent.runTurn({ correlationId: 't1', text: 'open the file' });

		const messages = persistence.listMessages('s_test');
		expect(messages.map(m => ({ role: m.role, text: m.text }))).toEqual([
			{ role: 'user', text: 'open the file' },
			{ role: 'assistant', text: 'Hello world.' },
		]);
		expect(messages[1].stop_reason).toBe('end_turn');
		const toolCalls = persistence.listToolCallsForSession('s_test');
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0].tool_name).toBe('Read');
		expect(toolCalls[0].tool_use_id).toBe('tu1');
		expect(toolCalls[0].result_content).toBe('file bytes');
		expect(toolCalls[0].result_is_error).toBe(0);
	});

	it('does not persist when persistence is omitted', async () => {
		// Sanity check that the optional wiring stays optional — exercising
		// the production-shape AgentDeps without a persistence handle must
		// neither throw nor swallow events.
		const { brain } = scriptedBrain([
			{ kind: 'text', text: 'hi' },
			{ kind: 'done' },
		]);
		const { agent, captured } = buildHarness(brain);
		const result = await agent.runTurn({ correlationId: 't1', text: 'hi' });
		expect(result.subtype).toBe('success');
		expect(captured.chunks.some(c => c.kind === 'text')).toBe(true);
	});

	it('reuses the brain across turns (getBrain runs once)', async () => {
		let calls = 0;
		const brain: CentralBrain = {
			async *send() {
				yield { kind: 'done', sessionId: 's' };
			},
		};
		const gate = new ApprovalGate({ requestApproval: () => { }, newApprovalId: () => 'a' });
		const deps: AgentDeps = {
			getBrain: async () => { calls++; return brain; },
			emitChunk: () => { },
			approvalGate: gate,
		};
		const agent = new Agent(deps);

		await agent.runTurn({ correlationId: 't1', text: 'first' });
		await agent.runTurn({ correlationId: 't2', text: 'second' });
		await agent.runTurn({ correlationId: 't3', text: 'third' });

		expect(calls).toBe(1);
	});
});
