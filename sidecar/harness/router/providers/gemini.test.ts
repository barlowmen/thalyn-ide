/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it } from 'vitest';
import {
	GeminiProvider,
	__resetCallIdCounterForTests,
	type GeminiClient,
	type GeminiGenerateRequest,
	type GeminiResponse,
	type GeminiStreamChunk,
} from './gemini';
import { LlmError, type LlmStreamEvent } from '../types';

interface FakeResponseOptions {
	readonly text?: string;
	readonly functionCalls?: ReadonlyArray<{ name: string; args: Record<string, unknown> }>;
	readonly usage?: { promptTokenCount?: number; candidatesTokenCount?: number };
	readonly finishReason?: string;
}

function fakeResponse(opts: FakeResponseOptions = {}): GeminiResponse {
	return {
		text: () => opts.text ?? '',
		functionCalls: () => (opts.functionCalls?.length ? Array.from(opts.functionCalls) : undefined),
		usageMetadata: opts.usage,
		candidates: opts.finishReason ? [{ finishReason: opts.finishReason }] : undefined,
	};
}

function fakeClient(options: {
	generate?: (req: GeminiGenerateRequest) => Promise<GeminiResponse> | never;
	stream?: (req: GeminiGenerateRequest) => {
		stream: AsyncIterable<GeminiStreamChunk>;
		response: Promise<GeminiResponse>;
	};
	captured?: { lastRequest?: GeminiGenerateRequest };
}): GeminiClient {
	return {
		getGenerativeModel: () => ({
			generateContent: async req => {
				if (options.captured) {
					options.captured.lastRequest = req;
				}
				if (!options.generate) {
					throw new Error('no generate impl');
				}
				return { response: await options.generate(req) };
			},
			generateContentStream: async req => {
				if (options.captured) {
					options.captured.lastRequest = req;
				}
				if (!options.stream) {
					throw new Error('no stream impl');
				}
				return options.stream(req);
			},
		}),
	};
}

beforeEach(() => __resetCallIdCounterForTests());

describe('GeminiProvider.generate', () => {
	it('returns text, tool calls, and usage from a Gemini response', async () => {
		const client = fakeClient({
			generate: async () =>
				fakeResponse({
					text: 'hello',
					functionCalls: [{ name: 'get_weather', args: { city: 'SF' } }],
					usage: { promptTokenCount: 10, candidatesTokenCount: 5 },
					finishReason: 'STOP',
				}),
		});
		const provider = new GeminiProvider({ client });
		const result = await provider.generate({
			messages: [{ role: 'user', content: 'hi' }],
		});
		expect(result.text).toBe('hello');
		expect(result.toolCalls).toEqual([
			{ id: 'gemini_get_weather_1', name: 'get_weather', args: { city: 'SF' } },
		]);
		expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
		expect(result.model).toBe('gemini-2.5-flash');
		expect(result.stopReason).toBe('STOP');
	});

	it('maps system messages to systemInstruction and user/assistant to contents', async () => {
		const captured: { lastRequest?: GeminiGenerateRequest } = {};
		const client = fakeClient({ generate: async () => fakeResponse(), captured });
		const provider = new GeminiProvider({ client });
		await provider.generate({
			messages: [
				{ role: 'system', content: 'be brief' },
				{ role: 'user', content: 'hi' },
				{ role: 'assistant', content: 'hello' },
				{ role: 'user', content: 'weather?' },
			],
		});
		expect(captured.lastRequest?.systemInstruction).toEqual({
			role: 'system',
			parts: [{ text: 'be brief' }],
		});
		expect(captured.lastRequest?.contents).toEqual([
			{ role: 'user', parts: [{ text: 'hi' }] },
			{ role: 'model', parts: [{ text: 'hello' }] },
			{ role: 'user', parts: [{ text: 'weather?' }] },
		]);
	});

	it('translates tool defs and strips unsupported JSON Schema keywords', async () => {
		const captured: { lastRequest?: GeminiGenerateRequest } = {};
		const client = fakeClient({ generate: async () => fakeResponse(), captured });
		const provider = new GeminiProvider({ client });
		await provider.generate({
			messages: [{ role: 'user', content: 'x' }],
			tools: [
				{
					name: 'get_weather',
					description: 'Weather.',
					inputSchema: {
						$schema: 'http://json-schema.org/draft-07/schema#',
						type: 'object',
						additionalProperties: false,
						properties: { city: { type: 'string' } },
						required: ['city'],
					},
				},
			],
		});
		const fd = captured.lastRequest?.tools?.[0]?.functionDeclarations?.[0];
		expect(fd?.name).toBe('get_weather');
		expect(fd?.parameters).toEqual({
			type: 'object',
			properties: { city: { type: 'string' } },
			required: ['city'],
		});
	});

	it('classifies provider errors by message content', async () => {
		const client = fakeClient({
			generate: async () => {
				throw new Error('API key invalid');
			},
		});
		const provider = new GeminiProvider({ client });
		await expect(provider.generate({ messages: [{ role: 'user', content: 'x' }] }))
			.rejects.toMatchObject({ kind: 'auth', retriable: false });
	});

	it('rejects before calling the model when signal is already aborted', async () => {
		let called = false;
		const client = fakeClient({
			generate: async () => {
				called = true;
				return fakeResponse();
			},
		});
		const provider = new GeminiProvider({ client });
		const controller = new AbortController();
		controller.abort();
		await expect(
			provider.generate({ messages: [{ role: 'user', content: 'x' }], signal: controller.signal }),
		).rejects.toBeInstanceOf(LlmError);
		expect(called).toBe(false);
	});
});

describe('GeminiProvider.stream', () => {
	it('yields text, tool_call, then done', async () => {
		async function* chunks(): AsyncIterable<GeminiStreamChunk> {
			yield { text: () => 'hel', functionCalls: () => undefined };
			yield { text: () => 'lo', functionCalls: () => undefined };
			yield {
				text: () => '',
				functionCalls: () => [{ name: 'f', args: { x: 1 } }],
			};
		}
		const client = fakeClient({
			stream: () => ({
				stream: chunks(),
				response: Promise.resolve(
					fakeResponse({ text: 'hello', functionCalls: [{ name: 'f', args: { x: 1 } }] }),
				),
			}),
		});
		const provider = new GeminiProvider({ client });
		const events: LlmStreamEvent[] = [];
		for await (const ev of provider.stream!({ messages: [{ role: 'user', content: 'x' }] })) {
			events.push(ev);
		}
		expect(events.map(e => e.kind)).toEqual(['text', 'text', 'tool_call', 'done']);
		expect(events[2]).toMatchObject({ kind: 'tool_call', call: { name: 'f', args: { x: 1 } } });
		expect(events[3]).toMatchObject({ kind: 'done', result: { text: 'hello' } });
	});
});
