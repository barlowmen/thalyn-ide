/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { ClaudeAdapter, type ClaudeQueryFn, type ClaudeSdkMessage } from './claude-adapter';
import type { BrainRequest, BrainStreamEvent } from './types';

/**
 * Live Claude Agent SDK round-trip. Gated behind `RUN_LIVE=1` so the
 * default test suite stays offline and free. Uses the bundled Claude Code
 * CLI's auth (OAuth / Max subscription); no Anthropic API key required or
 * desired — the harness invariant is that Claude goes through Claude
 * Code, not the raw Messages API.
 *
 * Run with:  RUN_LIVE=1 npx vitest run harness/brain/claude-adapter.integration
 */
const RUN_LIVE = process.env.RUN_LIVE === '1';
const describeLive = RUN_LIVE ? describe : describe.skip;

describeLive('ClaudeAdapter (live Agent SDK)', () => {
	it('round-trips a cheap prompt and ends with done', async () => {
		const { query } = await import('@anthropic-ai/claude-agent-sdk');
		const adapter = new ClaudeAdapter({
			query: query as unknown as ClaudeQueryFn,
			cwd: process.cwd(),
			env: process.env as Record<string, string | undefined>,
		});

		const request: BrainRequest = {
			system:
				'Reply with exactly the single word "ok" and nothing else. Do not use any tools.',
			messages: [
				{ role: 'user', content: [{ type: 'text', text: 'ready?' }] },
			],
			// Deny the SDK every built-in tool — the assistant should answer
			// from its head and terminate in one turn.
			tools: [],
		};

		const events: BrainStreamEvent[] = [];
		for await (const ev of adapter.send(request)) {
			events.push(ev);
		}

		const kinds = events.map(e => e.kind);
		expect(kinds, `stream kinds: ${kinds.join(',')}`).toContain('done');
		expect(kinds).not.toContain('error');

		const text = events
			.filter((e): e is Extract<BrainStreamEvent, { kind: 'text' }> => e.kind === 'text')
			.map(e => e.text)
			.join('');
		expect(text.toLowerCase()).toContain('ok');

		const done = events.find(e => e.kind === 'done') as
			| Extract<BrainStreamEvent, { kind: 'done' }>
			| undefined;
		expect(done?.sessionId, 'Agent SDK should surface a session id').toBeTruthy();
	}, 60_000);
});

// Placate vitest's "no tests" error when RUN_LIVE is unset.
if (!RUN_LIVE) {
	describe('ClaudeAdapter (live Agent SDK) — skipped', () => {
		it.skip('set RUN_LIVE=1 to run', () => {
			// intentionally empty
		});
	});
}

// Reference the unused import so the test file compiles even when the
// describeLive block is skipped and tsc runs over the file.
export type _Unused = ClaudeSdkMessage;
