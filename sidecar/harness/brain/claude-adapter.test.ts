/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import {
	ClaudeAdapter,
	type ClaudeQueryFn,
	type ClaudeQueryOptions,
	type ClaudeSdkMessage,
} from './claude-adapter';
import type { BrainError, BrainMessage, BrainRequest, BrainStreamEvent } from './types';
import type { ToolSchema } from '../tools/types';

function scriptedQuery(
	messages: ReadonlyArray<ClaudeSdkMessage | Error>,
): { query: ClaudeQueryFn; captured: { options?: ClaudeQueryOptions; prompt?: string } } {
	const captured: { options?: ClaudeQueryOptions; prompt?: string } = {};
	const query: ClaudeQueryFn = ({ prompt, options }) => {
		captured.prompt = prompt;
		captured.options = options;
		return (async function* () {
			for (const entry of messages) {
				if (entry instanceof Error) {
					throw entry;
				}
				yield entry;
			}
		})();
	};
	return { query, captured };
}

function userMsg(text: string): BrainMessage {
	return { role: 'user', content: [{ type: 'text', text }] };
}

function assistantText(text: string, sessionId?: string): ClaudeSdkMessage {
	return {
		type: 'assistant',
		message: { content: [{ type: 'text', text }] },
		session_id: sessionId,
	};
}

function assistantToolUse(id: string, name: string, input: Record<string, unknown>): ClaudeSdkMessage {
	return {
		type: 'assistant',
		message: { content: [{ type: 'tool_use', id, name, input }] },
	};
}

function resultSuccess(sessionId = 'sess-1', stopReason?: string): ClaudeSdkMessage {
	return {
		type: 'result',
		subtype: 'success',
		session_id: sessionId,
		result: 'ok',
		is_error: false,
		...(stopReason !== undefined ? { stop_reason: stopReason } : {}),
	} as ClaudeSdkMessage;
}

async function collect(iter: AsyncIterable<BrainStreamEvent>): Promise<BrainStreamEvent[]> {
	const out: BrainStreamEvent[] = [];
	for await (const ev of iter) {
		out.push(ev);
	}
	return out;
}

function baseRequest(overrides: Partial<BrainRequest> = {}): BrainRequest {
	return {
		system: 'be brief',
		messages: [userMsg('hello')],
		tools: [],
		...overrides,
	};
}

const readTool: ToolSchema = {
	name: 'Read',
	description: 'read a file',
	inputSchema: { type: 'object' },
	tier: 'read',
};

describe('ClaudeAdapter.send', () => {
	it('streams assistant text chunks and ends with done carrying sessionId + stopReason', async () => {
		const { query, captured } = scriptedQuery([
			{ type: 'system', subtype: 'init', session_id: 'sess-42' },
			assistantText('hi '),
			assistantText('there', 'sess-42'),
			{
				type: 'assistant',
				message: { content: [], stop_reason: 'end_turn' },
			} as ClaudeSdkMessage,
			resultSuccess('sess-42'),
		]);
		const adapter = new ClaudeAdapter({ query, cwd: '/tmp' });

		const events = await collect(adapter.send(baseRequest()));

		expect(events).toEqual([
			{ kind: 'text', text: 'hi ' },
			{ kind: 'text', text: 'there' },
			{ kind: 'done', sessionId: 'sess-42', stopReason: 'end_turn' },
		]);
		expect(captured.prompt).toBe('hello');
		expect(captured.options?.systemPrompt).toBe('be brief');
		expect(captured.options?.settingSources).toEqual([]);
		expect(captured.options?.cwd).toBe('/tmp');
	});

	it('emits tool_use events with the call forwarded verbatim', async () => {
		const { query } = scriptedQuery([
			assistantToolUse('tu_1', 'Read', { file_path: '/etc/hosts' }),
			resultSuccess(),
		]);
		const adapter = new ClaudeAdapter({ query });

		const events = await collect(adapter.send(baseRequest({ tools: [readTool] })));

		expect(events[0]).toEqual({
			kind: 'tool_use',
			call: { id: 'tu_1', name: 'Read', input: { file_path: '/etc/hosts' } },
		});
		expect(events.at(-1)?.kind).toBe('done');
	});

	it('passes requested tool names through as the SDK tools list and omits when empty', async () => {
		const { query, captured } = scriptedQuery([resultSuccess()]);
		const adapter = new ClaudeAdapter({ query });
		await collect(adapter.send(baseRequest({ tools: [readTool] })));
		expect(captured.options?.tools).toEqual(['Read']);

		const { query: q2, captured: c2 } = scriptedQuery([resultSuccess()]);
		await collect(new ClaudeAdapter({ query: q2 }).send(baseRequest()));
		expect(c2.options?.tools).toBeUndefined();
	});

	it('maps a failed result into a terminal error event and stops', async () => {
		const { query } = scriptedQuery([
			assistantText('thinking...'),
			{
				type: 'result',
				subtype: 'error',
				session_id: 'sess-err',
				result: 'turn exploded',
				is_error: true,
			},
			assistantText('should not appear'),
		]);
		const adapter = new ClaudeAdapter({ query });

		const events = await collect(adapter.send(baseRequest()));

		expect(events).toEqual([
			{ kind: 'text', text: 'thinking...' },
			{
				kind: 'error',
				error: {
					kind: 'unknown',
					message: 'turn exploded',
					retriable: false,
				},
			},
		]);
	});

	it('ignores SDK-internal user/system messages (tool results, init)', async () => {
		const { query } = scriptedQuery([
			{ type: 'system', subtype: 'init', session_id: 'sess-x' },
			{
				type: 'user',
				message: {
					content: [
						{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file bytes' },
					],
				},
			} as ClaudeSdkMessage,
			assistantText('done'),
			resultSuccess('sess-x'),
		]);
		const adapter = new ClaudeAdapter({ query });

		const events = await collect(adapter.send(baseRequest()));

		expect(events.map(e => e.kind)).toEqual(['text', 'done']);
	});

	it('errors with tool_schema when no user message has text content', async () => {
		const { query } = scriptedQuery([resultSuccess()]);
		const adapter = new ClaudeAdapter({ query });

		const emptyUser: BrainMessage = { role: 'user', content: [] };
		const events = await collect(adapter.send(baseRequest({ messages: [emptyUser] })));

		expect(events).toEqual([
			{
				kind: 'error',
				error: {
					kind: 'tool_schema',
					message:
						'BrainRequest.messages did not end with a user message containing text content.',
					retriable: false,
				},
			},
		]);
	});

	it('emits a cancelled error when signal is already aborted', async () => {
		const { query } = scriptedQuery([resultSuccess()]);
		const adapter = new ClaudeAdapter({ query });
		const controller = new AbortController();
		controller.abort();

		const events = await collect(
			adapter.send(baseRequest({ signal: controller.signal })),
		);

		expect(events.length).toBe(1);
		expect(events[0].kind).toBe('error');
		expect(events[0]).toMatchObject({
			error: { kind: 'cancelled', retriable: false },
		});
	});

	it('classifies thrown SDK errors by message content', async () => {
		const cases: Array<{ err: Error; kind: string; retriable: boolean }> = [
			{ err: new Error('401 Unauthorized'), kind: 'auth', retriable: false },
			{ err: new Error('HTTP 429 rate limit hit'), kind: 'rate_limit', retriable: true },
			{ err: new Error('fetch failed: ECONNREFUSED'), kind: 'network', retriable: true },
			{ err: new Error('wat'), kind: 'unknown', retriable: false },
		];
		for (const c of cases) {
			const { query } = scriptedQuery([c.err]);
			const adapter = new ClaudeAdapter({ query });
			const events = await collect(adapter.send(baseRequest()));
			expect(events.at(-1)?.kind).toBe('error');
			expect(events.at(-1)).toMatchObject({
				error: { kind: c.kind, retriable: c.retriable },
			});
		}
	});

	it('classifies AbortError as cancelled', async () => {
		const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
		const { query } = scriptedQuery([abortErr]);
		const adapter = new ClaudeAdapter({ query });

		const events = await collect(adapter.send(baseRequest()));

		expect(events.at(-1)).toMatchObject({
			kind: 'error',
			error: { kind: 'cancelled', retriable: false },
		});
	});

	it('uses the last user message when the transcript has mixed roles', async () => {
		const { query, captured } = scriptedQuery([resultSuccess()]);
		const adapter = new ClaudeAdapter({ query });
		const messages: BrainMessage[] = [
			userMsg('first user turn'),
			{ role: 'assistant', content: [{ type: 'text', text: 'prior response' }] },
			userMsg('second user turn'),
		];
		await collect(adapter.send(baseRequest({ messages })));
		expect(captured.prompt).toBe('second user turn');
	});

	it('concatenates multiple text blocks on the last user message with newlines', async () => {
		const { query, captured } = scriptedQuery([resultSuccess()]);
		const adapter = new ClaudeAdapter({ query });
		const lastUser: BrainMessage = {
			role: 'user',
			content: [
				{ type: 'text', text: 'line one' },
				{ type: 'text', text: 'line two' },
			],
		};
		await collect(adapter.send(baseRequest({ messages: [lastUser] })));
		expect(captured.prompt).toBe('line one\nline two');
	});

	it('cancels mid-stream: forwards abort to SDK, drops subsequent events, terminates with cancelled', async () => {
		const captured: { sdkAbort?: AbortController } = {};
		const cancelWhenAborted = (signal: AbortSignal) =>
			new Promise<void>(resolve => {
				if (signal.aborted) {
					resolve();
					return;
				}
				signal.addEventListener('abort', () => resolve(), { once: true });
			});

		const query: ClaudeQueryFn = ({ options }) => {
			captured.sdkAbort = options?.abortController;
			return (async function* () {
				yield assistantText('partial ');
				await cancelWhenAborted(options!.abortController!.signal);
				throw Object.assign(new Error('aborted by caller'), { name: 'AbortError' });
			})();
		};

		const controller = new AbortController();
		const adapter = new ClaudeAdapter({ query });
		const events: BrainStreamEvent[] = [];
		for await (const ev of adapter.send(baseRequest({ signal: controller.signal }))) {
			events.push(ev);
			if (ev.kind === 'text') {
				controller.abort();
			}
		}

		expect(captured.sdkAbort?.signal.aborted).toBe(true);
		expect(events[0]).toEqual({ kind: 'text', text: 'partial ' });
		const terminal = events.at(-1);
		expect(terminal?.kind).toBe('error');
		expect(terminal).toMatchObject({
			error: { kind: 'cancelled', retriable: false },
		});
		expect(events.some(e => e.kind === 'done')).toBe(false);
	});

	it('network disconnect mid-stream: forwards earlier text then terminates with network error', async () => {
		const { query } = scriptedQuery([
			assistantText('streaming '),
			assistantText('bytes'),
			Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
		]);
		const adapter = new ClaudeAdapter({ query });

		const events = await collect(adapter.send(baseRequest()));

		expect(events.slice(0, -1)).toEqual([
			{ kind: 'text', text: 'streaming ' },
			{ kind: 'text', text: 'bytes' },
		]);
		expect(events.at(-1)).toMatchObject({
			kind: 'error',
			error: { kind: 'network', retriable: true },
		});
		expect(events.some(e => e.kind === 'done')).toBe(false);
	});

	it('rate-limit response: surfaces retryAfterMs from Retry-After-Ms header', async () => {
		const err = Object.assign(new Error('HTTP 429 too many requests'), {
			status: 429,
			headers: { 'retry-after-ms': '1500' },
		});
		const { query } = scriptedQuery([err]);
		const adapter = new ClaudeAdapter({ query });

		const events = await collect(adapter.send(baseRequest()));

		expect(events).toHaveLength(1);
		const terminal = events[0];
		expect(terminal.kind).toBe('error');
		const error = (terminal as Extract<BrainStreamEvent, { kind: 'error' }>).error as BrainError & { kind: 'rate_limit' };
		expect(error.kind).toBe('rate_limit');
		expect(error.retriable).toBe(true);
		expect(error.retryAfterMs).toBe(1500);
	});

	it('rate-limit response: converts delta-seconds Retry-After to milliseconds', async () => {
		const err = Object.assign(new Error('429: slow down'), {
			status: 429,
			headers: { 'Retry-After': '2' },
		});
		const { query } = scriptedQuery([err]);
		const adapter = new ClaudeAdapter({ query });

		const events = await collect(adapter.send(baseRequest()));

		const error = (events[0] as Extract<BrainStreamEvent, { kind: 'error' }>).error as BrainError & { kind: 'rate_limit' };
		expect(error.kind).toBe('rate_limit');
		expect(error.retryAfterMs).toBe(2000);
	});

	it('rate-limit response: omits retryAfterMs when the provider gives no hint', async () => {
		const { query } = scriptedQuery([new Error('HTTP 429 rate limit hit')]);
		const adapter = new ClaudeAdapter({ query });

		const events = await collect(adapter.send(baseRequest()));

		const error = (events[0] as Extract<BrainStreamEvent, { kind: 'error' }>).error as BrainError & { kind: 'rate_limit' };
		expect(error.kind).toBe('rate_limit');
		expect(error.retryAfterMs).toBeUndefined();
	});
});
