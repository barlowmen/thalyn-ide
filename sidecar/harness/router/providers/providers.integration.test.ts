/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Live three-provider round-trip. Gated behind `RUN_LIVE=1` — the
 * default suite stays offline and free.
 *
 * Run with:  RUN_LIVE=1 npx vitest run harness/router/providers/providers.integration
 *
 * Requires:
 *  - `GEMINI_API_KEY`, `XAI_API_KEY` either in the environment or in
 *    `sidecar/.env` (loaded below).
 *  - A local Ollama daemon reachable at `http://127.0.0.1:11434` with
 *    `llama3.1:8b` pulled.
 */
const RUN_LIVE = process.env.RUN_LIVE === '1';

// Lazy-load the .env so typecheck passes even when the file is absent.
if (RUN_LIVE) {
	try {
		const raw = readFileSync(new URL('../../../.env', import.meta.url), 'utf8');
		for (const line of raw.split('\n')) {
			const m = line.match(/^([A-Z_]+)=(.*)$/);
			if (m && process.env[m[1]] === undefined) {
				process.env[m[1]] = m[2];
			}
		}
	} catch {
		// Absent .env is fine if the caller set the vars directly.
	}
}

const describeLive = RUN_LIVE ? describe : describe.skip;

describeLive('Live provider round-trips', () => {
	it('Gemini: non-streaming "ok" round-trip', async () => {
		const { GoogleGenerativeAI } = await import('@google/generative-ai');
		const { GeminiProvider } = await import('./gemini');
		const apiKey = process.env.GEMINI_API_KEY;
		expect(apiKey, 'GEMINI_API_KEY missing').toBeTruthy();
		const provider = new GeminiProvider({ client: new GoogleGenerativeAI(apiKey!) });
		const result = await provider.generate({
			messages: [
				{ role: 'system', content: 'Respond with exactly the single word "ok" and nothing else.' },
				{ role: 'user', content: 'ping' },
			],
		});
		expect(result.text.toLowerCase()).toContain('ok');
		expect(result.model).toBe('gemini-2.5-flash');
	}, 30_000);

	it('Grok: non-streaming round-trip', async () => {
		const OpenAI = (await import('openai')).default;
		const { GrokProvider } = await import('./grok');
		const apiKey = process.env.XAI_API_KEY;
		expect(apiKey, 'XAI_API_KEY missing').toBeTruthy();
		const openai = new OpenAI({ apiKey: apiKey!, baseURL: 'https://api.x.ai/v1' });
		const provider = new GrokProvider({
			client: {
				chatCompletions: {
					create: openai.chat.completions.create.bind(openai.chat.completions),
				} as never,
			},
		});
		const result = await provider.generate({
			messages: [
				{
					role: 'user',
					content: 'What is 2 + 2? Reply with the single digit only, no punctuation, no spaces.',
				},
			],
			options: { temperature: 0 },
		});
		expect(result.text).toContain('4');
		expect(result.toolCalls).toEqual([]);
		expect(result.model).toContain('grok');
	}, 120_000);

	it('Ollama: tool-call round-trip with llama3.1:8b', async () => {
		const { Ollama } = await import('ollama');
		const { OllamaProvider } = await import('./ollama');
		const provider = new OllamaProvider({ client: new Ollama() as never });
		const getWeather = {
			name: 'get_weather',
			description: 'Get the current weather for a city.',
			inputSchema: {
				type: 'object',
				properties: { city: { type: 'string', description: 'City name' } },
				required: ['city'],
			},
		};
		const step1 = await provider.generate({
			messages: [
				{ role: 'user', content: 'What is the weather in San Francisco? Use the get_weather tool.' },
			],
			tools: [getWeather],
		});
		expect(step1.toolCalls.length, `expected a tool_call; got text=${step1.text}`).toBeGreaterThan(0);
		expect(step1.toolCalls[0].name).toBe('get_weather');
		expect((step1.toolCalls[0].args as { city?: unknown }).city).toBeTruthy();

		const step2 = await provider.generate({
			messages: [
				{ role: 'user', content: 'What is the weather in San Francisco? Use the get_weather tool.' },
				{ role: 'assistant', content: step1.text, toolCalls: step1.toolCalls },
				{
					role: 'tool',
					toolCallId: step1.toolCalls[0].id,
					content: JSON.stringify({ temperature_f: 72, condition: 'sunny' }),
				},
			],
			tools: [getWeather],
		});
		expect(step2.text.toLowerCase()).toMatch(/72|sunny/);
	}, 60_000);
});

if (!RUN_LIVE) {
	describe('Live provider round-trips — skipped', () => {
		it.skip('set RUN_LIVE=1 to run', () => {
			// intentionally empty
		});
	});
}
