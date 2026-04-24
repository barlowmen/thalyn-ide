/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import {
	GrokProvider,
	type GrokClient,
	type GrokRequest,
	type GrokResponse,
	type GrokStreamChunk,
} from './grok';
import { LlmError, type LlmStreamEvent } from '../types';

function fakeClient(handler: {
	nonStreaming?: (req: GrokRequest) => Promise<GrokResponse>;
	streaming?: (req: GrokRequest) => Promise<AsyncIterable<GrokStreamChunk>>;
	captured?: { lastRequest?: GrokRequest & { stream?: boolean } };
}): GrokClient {
	return {
		chatCompletions: {
			create: (async (req: GrokRequest & { stream?: boolean }) => {
				if (handler.captured) {
					handler.captured.lastRequest = req;
				}
				if (req.stream) {
					if (!handler.streaming) {
						throw new Error('no stream impl');
					}
					return handler.streaming(req);
				}
				if (!handler.nonStreaming) {
					throw new Error('no non-stream impl');
				}
				return handler.nonStreaming(req);
			}) as GrokClient['chatCompletions']['create'],
		},
	};
}

describe('GrokProvider.generate', () => {
	it('parses text, tool_calls (with JSON-decoded args), and usage from the response', async () => {
		const client = fakeClient({
			nonStreaming: async () => ({
				id: 'c1',
				model: 'grok-4-fast-non-reasoning',
				choices: [
					{
						message: {
							content: 'thinking...',
							tool_calls: [
								{
									id: 'call_1',
									type: 'function',
									function: { name: 'get_weather', arguments: '{"city":"SF"}' },
								},
							],
						},
						finish_reason: 'tool_calls',
					},
				],
				usage: { prompt_tokens: 12, completion_tokens: 3 },
			}),
		});
		const provider = new GrokProvider({ client });
		const result = await provider.generate({
			messages: [{ role: 'user', content: 'weather?' }],
		});
		expect(result).toEqual({
			text: 'thinking...',
			toolCalls: [{ id: 'call_1', name: 'get_weather', args: { city: 'SF' } }],
			stopReason: 'tool_calls',
			model: 'grok-4-fast-non-reasoning',
			usage: { inputTokens: 12, outputTokens: 3 },
		});
	});

	it('round-trips tool results in the message history', async () => {
		const captured: { lastRequest?: GrokRequest & { stream?: boolean } } = {};
		const client = fakeClient({
			captured,
			nonStreaming: async () => ({
				id: 'c2',
				model: 'grok-4-fast-non-reasoning',
				choices: [{ message: { content: 'ok' } }],
			}),
		});
		const provider = new GrokProvider({ client });
		await provider.generate({
			messages: [
				{ role: 'user', content: 'weather?' },
				{
					role: 'assistant',
					content: '',
					toolCalls: [{ id: 'call_1', name: 'get_weather', args: { city: 'SF' } }],
				},
				{ role: 'tool', toolCallId: 'call_1', content: '{"temp":72}' },
			],
		});
		const msgs = captured.lastRequest?.messages;
		expect(msgs?.[1]).toMatchObject({
			role: 'assistant',
			content: null,
			tool_calls: [
				{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } },
			],
		});
		expect(msgs?.[2]).toEqual({
			role: 'tool',
			tool_call_id: 'call_1',
			content: '{"temp":72}',
		});
	});

	it('raises tool_schema on malformed tool-call arguments', async () => {
		const client = fakeClient({
			nonStreaming: async () => ({
				id: 'c3',
				model: 'grok-4-fast-non-reasoning',
				choices: [
					{
						message: {
							content: '',
							tool_calls: [
								{
									id: 'call_bad',
									type: 'function',
									function: { name: 'x', arguments: 'not-json' },
								},
							],
						},
					},
				],
			}),
		});
		const provider = new GrokProvider({ client });
		await expect(provider.generate({ messages: [{ role: 'user', content: 'x' }] }))
			.rejects.toMatchObject({ kind: 'tool_schema', retriable: false });
	});

	it('classifies status codes on thrown errors', async () => {
		for (const [status, kind, retriable] of [
			[401, 'auth', false],
			[429, 'rate_limit', true],
		] as const) {
			const client = fakeClient({
				nonStreaming: async () => {
					throw Object.assign(new Error(`HTTP ${status}`), { status });
				},
			});
			const provider = new GrokProvider({ client });
			await expect(provider.generate({ messages: [{ role: 'user', content: 'x' }] }))
				.rejects.toMatchObject({ kind, retriable });
		}
	});
});

describe('GrokProvider.stream', () => {
	it('reassembles streamed tool_calls across delta indices', async () => {
		async function* chunks(): AsyncIterable<GrokStreamChunk> {
			yield {
				choices: [
					{
						delta: {
							tool_calls: [
								{ index: 0, id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"a":' } },
							],
						},
					},
				],
			};
			yield {
				choices: [
					{
						delta: {
							tool_calls: [{ index: 0, function: { arguments: '1}' } }],
						},
					},
				],
			};
			yield {
				choices: [{ delta: { content: 'done' }, finish_reason: 'tool_calls' }],
				model: 'grok-4-fast-non-reasoning',
				usage: { prompt_tokens: 4, completion_tokens: 1 },
			};
		}
		const client = fakeClient({ streaming: async () => chunks() });
		const provider = new GrokProvider({ client });
		const events: LlmStreamEvent[] = [];
		for await (const ev of provider.stream!({ messages: [{ role: 'user', content: 'x' }] })) {
			events.push(ev);
		}
		const kinds = events.map(e => e.kind);
		expect(kinds).toEqual(['text', 'tool_call', 'done']);
		expect(events[1]).toMatchObject({
			kind: 'tool_call',
			call: { id: 'call_1', name: 'f', args: { a: 1 } },
		});
		expect(events[2]).toMatchObject({
			kind: 'done',
			result: {
				text: 'done',
				stopReason: 'tool_calls',
				usage: { inputTokens: 4, outputTokens: 1 },
			},
		});
	});

	it('throws LlmError cancelled when the caller aborts mid-stream', async () => {
		const controller = new AbortController();
		async function* chunks(): AsyncIterable<GrokStreamChunk> {
			yield { choices: [{ delta: { content: 'part1' } }] };
			controller.abort();
			yield { choices: [{ delta: { content: 'part2' } }] };
		}
		const client = fakeClient({ streaming: async () => chunks() });
		const provider = new GrokProvider({ client });
		const run = async () => {
			for await (const _ of provider.stream!({
				messages: [{ role: 'user', content: 'x' }],
				signal: controller.signal,
			})) {
				// drain
			}
		};
		await expect(run()).rejects.toMatchObject({ kind: 'cancelled' });
		expect(run).toBeDefined(); // keep linter happy
		void LlmError;
	});
});
