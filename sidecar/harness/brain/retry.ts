/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type {
	BrainError,
	BrainRequest,
	BrainStreamEvent,
	CentralBrain,
} from './types';

/**
 * Exponential-backoff retry policy applied on top of any `CentralBrain`.
 *
 * The wrapper is composable by design: it holds no adapter-specific state,
 * so the same policy applies to the Claude adapter today and to the Llama
 * adapter that lands later.
 */
export interface RetryPolicy {
	/**
	 * Total attempt count including the first one. `3` means one initial
	 * try plus up to two retries. Must be >= 1.
	 */
	readonly maxAttempts: number;
	/** Base delay for attempt 1 → 2, in milliseconds. */
	readonly baseMs: number;
	/**
	 * Hard cap on the computed jittered backoff. A provider's
	 * `retryAfterMs` hint may exceed this cap; see the policy note in
	 * {@link withRetry}.
	 */
	readonly capMs: number;
	/**
	 * Returns a float in `[0, 1)`. Defaults to `Math.random`. Injected so
	 * tests can pin delays.
	 */
	readonly jitter?: () => number;
	/**
	 * Sleep primitive. Defaults to a `setTimeout`-backed sleep that
	 * resolves early if `signal` aborts (rejecting with an abort error).
	 */
	readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
	maxAttempts: 3,
	baseMs: 500,
	capMs: 10_000,
});

/**
 * Wrap a `CentralBrain` in retry semantics:
 *
 * - Retry only when the brain terminates with a `retriable` `BrainError`
 *   **and** no content has been yielded yet on the current attempt.
 *   Once a text or tool-use event reaches the caller, retrying would
 *   duplicate output; the wrapper forwards the error instead.
 * - Backoff is AWS-style full jitter:
 *   `delay = random() * min(capMs, baseMs * 2^(attempt-1))`.
 *   A rate-limit error's `retryAfterMs` overrides the computed backoff
 *   verbatim, even if it exceeds `capMs` — the provider hint is
 *   authoritative; the cap protects us only when no hint exists.
 * - `request.signal` cancels any pending sleep and terminates the outer
 *   stream with a `cancelled` error.
 * - If the brain's stream ends without a terminal `done`/`error` event
 *   the wrapper synthesises a non-retriable `unknown` error — the brain
 *   contract forbids that shape, and silently accepting it would mask
 *   adapter bugs.
 */
export function withRetry(
	brain: CentralBrain,
	policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): CentralBrain {
	if (policy.maxAttempts < 1) {
		throw new Error('RetryPolicy.maxAttempts must be >= 1');
	}
	const sleep = policy.sleep ?? defaultSleep;
	const jitter = policy.jitter ?? Math.random;

	return {
		async *send(request: BrainRequest): AsyncIterable<BrainStreamEvent> {
			for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
				let emittedContent = false;
				let terminalError: BrainError | undefined;
				let sawTerminal = false;

				for await (const ev of brain.send(request)) {
					if (ev.kind === 'error') {
						terminalError = ev.error;
						sawTerminal = true;
						break;
					}
					if (ev.kind === 'done') {
						yield ev;
						return;
					}
					yield ev;
					emittedContent = true;
				}

				if (!sawTerminal) {
					yield {
						kind: 'error',
						error: {
							kind: 'unknown',
							message: 'Brain stream ended without a terminal event.',
							retriable: false,
						},
					};
					return;
				}

				const canRetry =
					terminalError!.retriable &&
					!emittedContent &&
					attempt < policy.maxAttempts &&
					!(request.signal?.aborted ?? false);

				if (!canRetry) {
					yield { kind: 'error', error: terminalError! };
					return;
				}

				const delay = computeDelay(policy, attempt, terminalError!, jitter);
				try {
					await sleep(delay, request.signal);
				} catch {
					yield {
						kind: 'error',
						error: {
							kind: 'cancelled',
							message: 'Caller aborted while waiting to retry.',
							retriable: false,
						},
					};
					return;
				}
				if (request.signal?.aborted) {
					yield {
						kind: 'error',
						error: {
							kind: 'cancelled',
							message: 'Caller aborted while waiting to retry.',
							retriable: false,
						},
					};
					return;
				}
			}
		},
	};
}

function computeDelay(
	policy: RetryPolicy,
	attempt: number,
	error: BrainError,
	jitter: () => number,
): number {
	if (error.kind === 'rate_limit' && typeof error.retryAfterMs === 'number') {
		return error.retryAfterMs;
	}
	const exp = Math.min(policy.capMs, policy.baseMs * 2 ** (attempt - 1));
	return Math.floor(jitter() * exp);
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error('aborted'));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error('aborted'));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}
