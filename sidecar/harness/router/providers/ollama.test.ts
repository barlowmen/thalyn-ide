/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import {
	OllamaProvider,
	type OllamaChatRequest,
	type OllamaChatResponse,
	type OllamaClient,
} from './ollama';
import type { LlmStreamEvent } from '../types';

function fakeClient(handler: {
	nonStreaming?: (req: OllamaChatRequest) => Promise<OllamaChatResponse>;
	streaming?: (req: OllamaChatRequest) => Promise<AsyncIterable<OllamaChatResponse>>;
	captured?: { lastRequest?: OllamaChatRequest & { stream?: boolean } };
}): OllamaClient {
	return {
		chat: (async (req: OllamaChatRequest & { stream?: boolean }) => {
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
		}) as OllamaClient['chat'],
	};
}

describe('OllamaProvider.generate', () => {
	it('returns text + tool calls + usage from a full response', async () => {
		const client = fakeClient({
			nonStreaming: async () => ({
				model: 'llama3.1:8b',
				done: true,
				done_reason: 'stop',
				message: {
					role: 'assistant',
					content: '',
					tool_calls: [
						{ function: { name: 'get_weather', arguments: { city: 'SF' } } },
					],
				},
				prompt_eval_count: 20,
				eval_count: 2,
			}),
		});
		const provider = new OllamaProvider({ client });
		const result = await provider.generate({
			messages: [{ role: 'user', content: 'weather?' }],
			tools: [
				{
					name: 'get_weather',
					description: 'Weather.',
					inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
				},
			],
		});
		expect(result.text).toBe('');
		expect(result.toolCalls).toHaveLength(1);
		expect(result.toolCalls[0]).toMatchObject({ name: 'get_weather', args: { city: 'SF' } });
		expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 2 });
		expect(result.stopReason).toBe('stop');
	});

	it('round-trips assistant tool_calls and tool-role results in the request', async () => {
		const captured: { lastRequest?: OllamaChatRequest & { stream?: boolean } } = {};
		const client = fakeClient({
			captured,
			nonStreaming: async () => ({ done: true, message: { role: 'assistant', content: 'ok' } }),
		});
		const provider = new OllamaProvider({ client });
		await provider.generate({
			messages: [
				{ role: 'user', content: 'weather?' },
				{
					role: 'assistant',
					content: '',
					toolCalls: [{ id: 'x', name: 'get_weather', args: { city: 'SF' } }],
				},
				{ role: 'tool', toolCallId: 'x', content: '{"temp":72}' },
			],
		});
		expect(captured.lastRequest?.messages[1]).toMatchObject({
			role: 'assistant',
			tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'SF' } } }],
		});
		expect(captured.lastRequest?.messages[2]).toMatchObject({
			role: 'tool',
			content: '{"temp":72}',
		});
	});

	it('classifies ECONNREFUSED as a network error', async () => {
		const client = fakeClient({
			nonStreaming: async () => {
				throw new Error('fetch failed: ECONNREFUSED 127.0.0.1:11434');
			},
		});
		const provider = new OllamaProvider({ client });
		await expect(provider.generate({ messages: [{ role: 'user', content: 'x' }] }))
			.rejects.toMatchObject({ kind: 'network', retriable: true });
	});
});

describe('OllamaProvider.stream', () => {
	it('yields text chunks, tool_call events, and done with usage', async () => {
		async function* chunks(): AsyncIterable<OllamaChatResponse> {
			yield { message: { role: 'assistant', content: 'hel' } };
			yield { message: { role: 'assistant', content: 'lo' } };
			yield {
				message: {
					role: 'assistant',
					content: '',
					tool_calls: [{ function: { name: 'f', arguments: { x: 1 } } }],
				},
			};
			yield { done: true, done_reason: 'stop', prompt_eval_count: 5, eval_count: 3 };
		}
		const client = fakeClient({ streaming: async () => chunks() });
		const provider = new OllamaProvider({ client });
		const events: LlmStreamEvent[] = [];
		for await (const ev of provider.stream!({ messages: [{ role: 'user', content: 'x' }] })) {
			events.push(ev);
		}
		expect(events.map(e => e.kind)).toEqual(['text', 'text', 'tool_call', 'done']);
		expect(events.at(-1)).toMatchObject({
			kind: 'done',
			result: {
				text: 'hello',
				toolCalls: [{ name: 'f', args: { x: 1 } }],
				usage: { inputTokens: 5, outputTokens: 3 },
				stopReason: 'stop',
			},
		});
	});
});
