/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { DEFAULT_RETRY_POLICY, type RetryPolicy, withRetry } from './retry';
import type {
	BrainRequest,
	BrainStreamEvent,
	CentralBrain,
} from './types';

function request(overrides: Partial<BrainRequest> = {}): BrainRequest {
	return {
		system: '',
		messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
		tools: [],
		...overrides,
	};
}

function streamingBrain(
	scripts: ReadonlyArray<ReadonlyArray<BrainStreamEvent>>,
): { brain: CentralBrain; attempts: () => number } {
	let attempt = 0;
	const brain: CentralBrain = {
		async *send(): AsyncIterable<BrainStreamEvent> {
			const chunks = scripts[attempt] ?? scripts[scripts.length - 1];
			attempt++;
			for (const ev of chunks) {
				yield ev;
			}
		},
	};
	return { brain, attempts: () => attempt };
}

async function collect(iter: AsyncIterable<BrainStreamEvent>): Promise<BrainStreamEvent[]> {
	const out: BrainStreamEvent[] = [];
	for await (const ev of iter) {
		out.push(ev);
	}
	return out;
}

function recordingSleep(): {
	sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	delays: number[];
} {
	const delays: number[] = [];
	const sleep = async (ms: number): Promise<void> => {
		delays.push(ms);
	};
	return { sleep, delays };
}

const fixedPolicy = (overrides: Partial<RetryPolicy> = {}): RetryPolicy => ({
	maxAttempts: 3,
	baseMs: 500,
	capMs: 10_000,
	jitter: () => 0.5,
	sleep: async () => { /* no wait in tests */ },
	...overrides,
});

describe('withRetry', () => {
	it('passes through on first-attempt success without sleeping', async () => {
		const { sleep, delays } = recordingSleep();
		const { brain, attempts } = streamingBrain([
			[
				{ kind: 'text', text: 'hello' },
				{ kind: 'done', sessionId: 's1' },
			],
		]);

		const events = await collect(withRetry(brain, fixedPolicy({ sleep })).send(request()));

		expect(events).toEqual([
			{ kind: 'text', text: 'hello' },
			{ kind: 'done', sessionId: 's1' },
		]);
		expect(attempts()).toBe(1);
		expect(delays).toEqual([]);
	});

	it('retries retriable errors when no content was emitted, then succeeds', async () => {
		const { sleep, delays } = recordingSleep();
		const { brain, attempts } = streamingBrain([
			[{ kind: 'error', error: { kind: 'network', message: 'ECONNRESET', retriable: true } }],
			[
				{ kind: 'text', text: 'second try' },
				{ kind: 'done' },
			],
		]);

		const events = await collect(withRetry(brain, fixedPolicy({ sleep })).send(request()));

		expect(attempts()).toBe(2);
		expect(events).toEqual([
			{ kind: 'text', text: 'second try' },
			{ kind: 'done' },
		]);
		expect(delays).toEqual([Math.floor(0.5 * 500)]);
	});

	it('does not retry non-retriable errors', async () => {
		const { sleep, delays } = recordingSleep();
		const { brain, attempts } = streamingBrain([
			[{ kind: 'error', error: { kind: 'auth', message: 'bad key', retriable: false } }],
			[{ kind: 'done' }],
		]);

		const events = await collect(withRetry(brain, fixedPolicy({ sleep })).send(request()));

		expect(attempts()).toBe(1);
		expect(events).toEqual([
			{ kind: 'error', error: { kind: 'auth', message: 'bad key', retriable: false } },
		]);
		expect(delays).toEqual([]);
	});

	it('does not retry a retriable error once content has been emitted', async () => {
		const { sleep, delays } = recordingSleep();
		const { brain, attempts } = streamingBrain([
			[
				{ kind: 'text', text: 'partial' },
				{ kind: 'error', error: { kind: 'network', message: 'drop', retriable: true } },
			],
			[{ kind: 'done' }],
		]);

		const events = await collect(withRetry(brain, fixedPolicy({ sleep })).send(request()));

		expect(attempts()).toBe(1);
		expect(events).toEqual([
			{ kind: 'text', text: 'partial' },
			{ kind: 'error', error: { kind: 'network', message: 'drop', retriable: true } },
		]);
		expect(delays).toEqual([]);
	});

	it('honors retryAfterMs verbatim even when it exceeds capMs', async () => {
		const { sleep, delays } = recordingSleep();
		const { brain } = streamingBrain([
			[{
				kind: 'error',
				error: { kind: 'rate_limit', message: '429', retriable: true, retryAfterMs: 42_000 },
			}],
			[
				{ kind: 'text', text: 'done-ish' },
				{ kind: 'done' },
			],
		]);

		const events = await collect(
			withRetry(brain, fixedPolicy({ sleep, capMs: 1_000 })).send(request()),
		);

		expect(delays).toEqual([42_000]);
		expect(events.at(-1)?.kind).toBe('done');
	});

	it('gives up after maxAttempts and surfaces the final retriable error', async () => {
		const { sleep, delays } = recordingSleep();
		const { brain, attempts } = streamingBrain([
			[{ kind: 'error', error: { kind: 'network', message: 'try 1', retriable: true } }],
			[{ kind: 'error', error: { kind: 'network', message: 'try 2', retriable: true } }],
			[{ kind: 'error', error: { kind: 'network', message: 'try 3', retriable: true } }],
		]);

		const events = await collect(
			withRetry(brain, fixedPolicy({ sleep, maxAttempts: 3 })).send(request()),
		);

		expect(attempts()).toBe(3);
		expect(events).toEqual([
			{ kind: 'error', error: { kind: 'network', message: 'try 3', retriable: true } },
		]);
		// Two sleeps between three attempts (exp: 500, 1000 with jitter 0.5 → 250, 500).
		expect(delays).toEqual([250, 500]);
	});

	it('uses full-jitter exponential backoff capped at capMs', async () => {
		const { sleep, delays } = recordingSleep();
		const jitterValues = [0.9, 0.9, 0.9];
		let i = 0;
		const jitter = () => jitterValues[i++] ?? 0;
		const retriable: BrainStreamEvent = {
			kind: 'error',
			error: { kind: 'network', message: 'nope', retriable: true },
		};
		const { brain } = streamingBrain([[retriable], [retriable], [retriable], [retriable]]);

		await collect(
			withRetry(brain, {
				maxAttempts: 4,
				baseMs: 1000,
				capMs: 3000,
				jitter,
				sleep,
			}).send(request()),
		);

		// exp per attempt: 1000, 2000, 3000 (capped). jitter 0.9 → 900, 1800, 2700.
		expect(delays).toEqual([900, 1800, 2700]);
	});

	it('aborts during backoff and terminates with cancelled', async () => {
		const controller = new AbortController();
		const sleep = (_ms: number, signal?: AbortSignal): Promise<void> =>
			new Promise((_resolve, reject) => {
				signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
				controller.abort();
			});
		const { brain, attempts } = streamingBrain([
			[{ kind: 'error', error: { kind: 'network', message: 'nope', retriable: true } }],
			[{ kind: 'done' }],
		]);

		const events = await collect(
			withRetry(brain, fixedPolicy({ sleep })).send(request({ signal: controller.signal })),
		);

		expect(attempts()).toBe(1);
		expect(events).toEqual([
			{
				kind: 'error',
				error: {
					kind: 'cancelled',
					message: 'Caller aborted while waiting to retry.',
					retriable: false,
				},
			},
		]);
	});

	it('does not retry when the caller signal is already aborted by the time the error arrives', async () => {
		const controller = new AbortController();
		const sleep = async (): Promise<void> => {
			throw new Error('should not sleep');
		};
		const { brain, attempts } = streamingBrain([
			[{ kind: 'error', error: { kind: 'network', message: 'drop', retriable: true } }],
			[{ kind: 'done' }],
		]);
		controller.abort();

		const events = await collect(
			withRetry(brain, fixedPolicy({ sleep })).send(request({ signal: controller.signal })),
		);

		expect(attempts()).toBe(1);
		expect(events).toEqual([
			{ kind: 'error', error: { kind: 'network', message: 'drop', retriable: true } },
		]);
	});

	it('synthesises an unknown error when the brain stream ends with no terminal event', async () => {
		const { sleep } = recordingSleep();
		const malformed: CentralBrain = {
			async *send(): AsyncIterable<BrainStreamEvent> {
				yield { kind: 'text', text: 'half' };
				// no done / error
			},
		};

		const events = await collect(withRetry(malformed, fixedPolicy({ sleep })).send(request()));

		expect(events).toEqual([
			{ kind: 'text', text: 'half' },
			{
				kind: 'error',
				error: {
					kind: 'unknown',
					message: 'Brain stream ended without a terminal event.',
					retriable: false,
				},
			},
		]);
	});

	it('rejects maxAttempts < 1 at construction', () => {
		const { brain } = streamingBrain([[{ kind: 'done' }]]);
		expect(() => withRetry(brain, { ...DEFAULT_RETRY_POLICY, maxAttempts: 0 })).toThrow();
	});
});
