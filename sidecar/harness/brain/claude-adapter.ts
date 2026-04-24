/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type {
	BrainContent,
	BrainError,
	BrainMessage,
	BrainRequest,
	BrainStreamEvent,
	CentralBrain,
} from './types';

/**
 * Narrow view of a `@anthropic-ai/claude-agent-sdk` content block. The
 * adapter only inspects the handful of shapes it actually maps; everything
 * else flows through as an unknown block and is ignored.
 */
export type ClaudeContentBlock =
	| { type: 'text'; text: string }
	| { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
	| { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean }
	| { type: string; [key: string]: unknown };

/**
 * Narrow view of the SDK's streamed messages. Mirrors the subset of
 * `SDKMessage` the adapter inspects — `assistant`, `user`, `system` (init),
 * and `result`. Injecting this as a type lets tests supply a fake without
 * coupling to the full SDK surface.
 */
export type ClaudeSdkMessage =
	| {
		type: 'assistant';
		message: { content: ReadonlyArray<ClaudeContentBlock>; stop_reason?: string | null };
		session_id?: string;
	}
	| {
		type: 'user';
		message: { content: ReadonlyArray<ClaudeContentBlock> };
		session_id?: string;
	}
	| {
		type: 'system';
		subtype: 'init';
		session_id?: string;
	}
	| {
		type: 'result';
		subtype: 'success' | string;
		session_id?: string;
		result?: string;
		is_error?: boolean;
	};

/**
 * The SDK-level options the adapter passes through to `query`. Kept as a
 * structural type so we are not forced to depend on the SDK's own `Options`
 * shape at type-resolution time — the runtime `query` call still accepts
 * the full thing.
 */
export interface ClaudeQueryOptions {
	readonly systemPrompt?: string;
	readonly tools?: string[];
	readonly allowedTools?: string[];
	readonly cwd?: string;
	readonly env?: Record<string, string | undefined>;
	readonly abortController?: AbortController;
	readonly model?: string;
	readonly settingSources?: Array<'user' | 'project' | 'local'>;
	readonly permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';
}

/** Narrow callable shape of the SDK's `query` function. */
export type ClaudeQueryFn = (params: {
	prompt: string;
	options?: ClaudeQueryOptions;
}) => AsyncIterable<ClaudeSdkMessage>;

/** Dependencies the adapter needs to run a turn. */
export interface ClaudeAdapterDeps {
	/**
	 * The SDK's `query` function — injected so tests can supply a fake and
	 * so the sidecar need not import the SDK surface for type resolution.
	 */
	readonly query: ClaudeQueryFn;
	/** Working directory passed through to the SDK session. */
	readonly cwd?: string;
	/** Environment passed through to the SDK session. Defaults to `process.env`. */
	readonly env?: Record<string, string | undefined>;
	/** Optional model override. Defaults to whatever the SDK chooses. */
	readonly model?: string;
}

/**
 * `ClaudeAdapter` implements `CentralBrain` against `@anthropic-ai/claude-
 * agent-sdk`. The only Anthropic-touching code in the harness.
 *
 * Scope (basic send/stream): translate a `BrainRequest` into a single-turn
 * SDK `query` call and re-emit its message stream as `BrainStreamEvent`s.
 * Tool-call blocks surface so observers (harness, future OTEL span writer)
 * can see them, but tool *execution* stays inside the SDK for now — the
 * rewrite that routes tool calls through `ToolDispatcher.invoke()` lands
 * alongside richer cancel/error handling in a follow-up pass.
 *
 * History handling: today the adapter sends only the last user message's
 * text content as the prompt string. Replaying full transcripts through the
 * SDK requires either the streaming-input prompt mode or session
 * `resume`/`continue` — both depend on harness-owned session persistence
 * that does not yet exist. When it does, this adapter switches to
 * streaming-input mode and this limitation goes away.
 */
export class ClaudeAdapter implements CentralBrain {
	constructor(private readonly deps: ClaudeAdapterDeps) { }

	async *send(request: BrainRequest): AsyncIterable<BrainStreamEvent> {
		const prompt = extractLastUserPrompt(request.messages);
		if (prompt === undefined) {
			yield errorEvent({
				kind: 'tool_schema',
				message: 'BrainRequest.messages did not end with a user message containing text content.',
				retriable: false,
			});
			return;
		}

		const abortController = new AbortController();
		const abortForCaller = () => abortController.abort();
		if (request.signal) {
			if (request.signal.aborted) {
				yield errorEvent(cancelledError());
				return;
			}
			request.signal.addEventListener('abort', abortForCaller, { once: true });
		}

		let iterator: AsyncIterable<ClaudeSdkMessage>;
		try {
			iterator = this.deps.query({
				prompt,
				options: {
					systemPrompt: request.system || undefined,
					tools: request.tools.length > 0 ? request.tools.map(t => t.name) : undefined,
					cwd: this.deps.cwd,
					env: this.deps.env,
					model: this.deps.model,
					abortController,
					// Opt out of user/project settings files so a stray
					// `~/.claude/settings.json` allowlist cannot widen the
					// adapter's permissions behind the harness's back.
					settingSources: [],
				},
			});
		} catch (err) {
			request.signal?.removeEventListener('abort', abortForCaller);
			yield errorEvent(classifyError(err));
			return;
		}

		let sessionId: string | undefined;
		let stopReason: string | undefined;

		try {
			for await (const message of iterator) {
				if (request.signal?.aborted) {
					yield errorEvent(cancelledError());
					return;
				}
				if (!sessionId && message.session_id) {
					sessionId = message.session_id;
				}
				if (message.type === 'assistant') {
					for (const block of message.message.content) {
						if (block.type === 'text') {
							const text = (block as { text?: unknown }).text;
							if (typeof text === 'string' && text.length > 0) {
								yield { kind: 'text', text };
							}
						} else if (block.type === 'tool_use') {
							const tu = block as { id: string; name: string; input: Record<string, unknown> };
							yield {
								kind: 'tool_use',
								call: { id: tu.id, name: tu.name, input: tu.input ?? {} },
							};
						}
					}
					if (typeof message.message.stop_reason === 'string') {
						stopReason = message.message.stop_reason;
					}
					continue;
				}
				if (message.type === 'result') {
					if (message.subtype !== 'success' || message.is_error) {
						yield errorEvent({
							kind: 'unknown',
							message: message.result ?? 'Claude turn ended with an error.',
							retriable: false,
						});
						return;
					}
					// Successful `result` is terminal; fall through to the
					// `done` event below.
					break;
				}
				// `user` and `system` messages carry SDK-internal bookkeeping
				// (tool results produced by the SDK's own tool runner,
				// session init). The brain contract does not expose them.
			}
			if (request.signal?.aborted) {
				yield errorEvent(cancelledError());
				return;
			}
			yield { kind: 'done', sessionId, stopReason };
		} catch (err) {
			yield errorEvent(classifyError(err, request.signal));
		} finally {
			request.signal?.removeEventListener('abort', abortForCaller);
		}
	}
}

function extractLastUserPrompt(messages: readonly BrainMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== 'user') {
			continue;
		}
		const text = joinText(msg.content);
		if (text.length === 0) {
			return undefined;
		}
		return text;
	}
	return undefined;
}

function joinText(content: readonly BrainContent[]): string {
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === 'text') {
			parts.push(block.text);
		}
	}
	return parts.join('\n');
}

function errorEvent(error: BrainError): BrainStreamEvent {
	return { kind: 'error', error };
}

function cancelledError(): BrainError {
	return {
		kind: 'cancelled',
		message: 'Caller aborted the brain request.',
		retriable: false,
	};
}

/**
 * Map a thrown SDK error to a typed `BrainError`. The harness's retry
 * wrapper reads `retriable` + (for rate-limit) `retryAfterMs` to decide
 * backoff, so the classification here is load-bearing: misclassifying a
 * transient failure as `unknown` silently turns off retry.
 *
 * Classification order: abort → auth → rate-limit → network → dropped
 * socket → unknown. `AbortError` and an aborted caller signal both map to
 * `cancelled`. Substring tells cover what the Agent SDK and its fetch
 * underlayer surface in practice (`401`, `429`, `ECONNREFUSED`,
 * `ECONNRESET`, `socket hang up`, `premature close`, `fetch failed`).
 */
function classifyError(err: unknown, signal?: AbortSignal): BrainError {
	if (err instanceof Error && (err.name === 'AbortError' || signal?.aborted)) {
		return { ...cancelledError(), cause: err };
	}
	const message = err instanceof Error ? err.message : String(err);
	const lower = message.toLowerCase();
	const status = readHttpStatus(err);
	if (status === 401 || status === 403 || lower.includes('401') || lower.includes('unauthorized') || lower.includes('api key') || lower.includes('authentication')) {
		return { kind: 'auth', message, retriable: false, cause: err };
	}
	if (status === 429 || lower.includes('429') || lower.includes('rate limit') || lower.includes('too many requests')) {
		const retryAfterMs = extractRetryAfterMs(err);
		if (retryAfterMs !== undefined) {
			return { kind: 'rate_limit', message, retriable: true, retryAfterMs, cause: err };
		}
		return { kind: 'rate_limit', message, retriable: true, cause: err };
	}
	if (
		(typeof status === 'number' && status >= 500 && status < 600) ||
		lower.includes('econnrefused') ||
		lower.includes('econnreset') ||
		lower.includes('enotfound') ||
		lower.includes('etimedout') ||
		lower.includes('epipe') ||
		lower.includes('socket hang up') ||
		lower.includes('premature close') ||
		lower.includes('fetch failed') ||
		lower.includes('network')
	) {
		return { kind: 'network', message, retriable: true, cause: err };
	}
	return { kind: 'unknown', message, retriable: false, cause: err };
}

/**
 * Pull a `Retry-After` hint off a thrown error. Checks `retry-after-ms`
 * (already milliseconds) before `retry-after` (delta-seconds per RFC
 * 9110) and inspects both `err.headers` and common top-level shapes
 * (`retryAfter`, `retry_after`) so the adapter works whether the SDK
 * forwards the raw fetch `Response`'s headers or a flattened error object.
 */
function extractRetryAfterMs(err: unknown): number | undefined {
	if (err === null || typeof err !== 'object') {
		return undefined;
	}
	const record = err as Record<string, unknown>;
	const headers = record.headers;
	if (headers && typeof headers === 'object') {
		const h = headers as Record<string, unknown>;
		const ms = numeric(h['retry-after-ms'] ?? h['Retry-After-Ms']);
		if (ms !== undefined) {
			return ms;
		}
		const seconds = numeric(h['retry-after'] ?? h['Retry-After']);
		if (seconds !== undefined) {
			return Math.round(seconds * 1000);
		}
	}
	const direct = numeric(record.retryAfterMs);
	if (direct !== undefined) {
		return direct;
	}
	const directSeconds = numeric(record.retryAfter ?? record.retry_after);
	if (directSeconds !== undefined) {
		return Math.round(directSeconds * 1000);
	}
	return undefined;
}

function numeric(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
		return value;
	}
	if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value)) {
		return Number(value);
	}
	return undefined;
}

function readHttpStatus(err: unknown): number | undefined {
	if (err === null || typeof err !== 'object') {
		return undefined;
	}
	const record = err as Record<string, unknown>;
	const status = record.status ?? record.statusCode;
	return typeof status === 'number' && Number.isFinite(status) ? status : undefined;
}
