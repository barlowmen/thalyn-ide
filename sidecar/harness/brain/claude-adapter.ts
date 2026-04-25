/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SpanStatusCode, type Span, type Tracer } from '@opentelemetry/api';

import type { BudgetMeter } from '../budget/meter';
import type { CallDescriptor, Estimate, Reservation } from '../budget/types';
import {
	buildGenAiAttributes,
	buildGenAiCompletionAttributes,
} from '../observability/genai-attributes';
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
	readonly canUseTool?: ClaudeCanUseTool;
	/**
	 * Inline `Settings` payload forwarded to the SDK's `settings` option.
	 * Loaded into the SDK's flag-settings layer (highest priority among
	 * user-controlled settings). Used for fields like
	 * `autoMemoryDirectory` that lack a per-query knob — this is the only
	 * way to point the SDK Memory Tool at our `~/.config/thalyn/memories/...`
	 * directory while keeping `settingSources: []` so an unrelated user
	 * `settings.json` cannot widen tool permissions.
	 */
	readonly settings?: Record<string, unknown>;
}

/**
 * SDK-level permission decision. Mirrors the SDK's `CanUseTool` callback
 * shape but is restated here so the adapter does not depend on the SDK's
 * type at type-resolution time. The harness `ApprovalGate` resolves through
 * this hook.
 */
export type ClaudeCanUseTool = (
	toolName: string,
	input: Record<string, unknown>,
	options: { signal: AbortSignal; toolUseID: string },
) => Promise<ClaudePermissionResult>;

export type ClaudePermissionResult =
	| { behavior: 'allow'; updatedInput?: Record<string, unknown> }
	| { behavior: 'deny'; message: string };

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
	/**
	 * Tools the brain may invoke regardless of `BrainRequest.tools`. Forwarded
	 * verbatim to the SDK's `tools` option when the request does not declare
	 * its own. Use for the harness-managed always-on toolset.
	 */
	readonly tools?: readonly string[];
	/**
	 * Tools the SDK is allowed to invoke without firing `canUseTool`. For
	 * the auto-approved `read` tier (see ADR 0012). The SDK gates anything
	 * not on this list through the `canUseTool` hook below.
	 */
	readonly allowedTools?: readonly string[];
	/**
	 * SDK permission mode forwarded to `query`. Defaults to `'default'`.
	 * Avoid `'bypassPermissions'` — the harness gate is the authoritative
	 * decision-maker.
	 */
	readonly permissionMode?: ClaudeQueryOptions['permissionMode'];
	/**
	 * SDK-level permission hook. The harness `ApprovalGate` plugs in here:
	 * the SDK fires the hook on every tool the model wants to invoke, and
	 * the gate blocks until the user approves or declines. Mirrors the
	 * approval flow before the dispatcher takes ownership of tool execution.
	 */
	readonly canUseTool?: ClaudeCanUseTool;
	/**
	 * Inline SDK `settings` payload — forwarded to the SDK's flag-settings
	 * layer. Used to point the SDK Memory Tool at the harness-managed
	 * directory without enabling `settingSources: ['user']`.
	 */
	readonly settings?: Record<string, unknown>;
	/**
	 * Budget instrumentation. When present, every `send()` reserves a
	 * cost-bearing slot, opens a GenAI span, and either commits or rolls
	 * back depending on the terminal event. Optional so a non-metering
	 * fast-path remains available for tests and future direct uses where
	 * the call is metered out-of-band.
	 */
	readonly budget?: ClaudeAdapterBudgetDeps;
}

/**
 * Budget wiring for the adapter. The `category` and `sessionId` are fixed
 * at construction time — one adapter per logical brain → one category
 * (`subagent_opus`, `subagent_sonnet`, …) — and the meter / tracer are
 * shared across the harness.
 *
 * `estimateCall` builds the {@link CallDescriptor} the meter passes to
 * the estimator. The adapter has the actual `BrainRequest` so it can
 * inspect message lengths, attached tool schemas, and any caller-
 * supplied output ceilings; isolating that logic here keeps the adapter
 * free of estimator-specific knowledge.
 */
export interface ClaudeAdapterBudgetDeps {
	readonly meter: BudgetMeter;
	readonly tracer: Tracer;
	readonly category: string;
	readonly sessionId: string;
	readonly system: string;
	readonly estimateCall: (request: BrainRequest, model: string | undefined) => CallDescriptor;
	/**
	 * Compute the call's actual cost from a successful turn. Defaults to
	 * the reservation's estimate if omitted — better than nothing for the
	 * SQLite ledger, replaceable when the SDK starts surfacing real
	 * usage numbers.
	 */
	readonly resolveActual?: (estimate: Estimate, reservation: Reservation) => number;
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

		const reservationCtx = await this.tryReserve(request);
		if (reservationCtx?.kind === 'rejected') {
			yield errorEvent(reservationCtx.error);
			return;
		}

		const abortController = new AbortController();
		const abortForCaller = () => abortController.abort();
		if (request.signal) {
			if (request.signal.aborted) {
				this.releaseOnEarlyExit(reservationCtx, 'cancelled');
				yield errorEvent(cancelledError());
				return;
			}
			request.signal.addEventListener('abort', abortForCaller, { once: true });
		}

		const requestedTools = request.tools.length > 0
			? request.tools.map(t => t.name)
			: this.deps.tools !== undefined ? [...this.deps.tools] : undefined;
		let iterator: AsyncIterable<ClaudeSdkMessage>;
		try {
			iterator = this.deps.query({
				prompt,
				options: {
					systemPrompt: request.system || undefined,
					tools: requestedTools,
					allowedTools: this.deps.allowedTools !== undefined ? [...this.deps.allowedTools] : undefined,
					cwd: this.deps.cwd,
					env: this.deps.env,
					model: this.deps.model,
					abortController,
					permissionMode: this.deps.permissionMode ?? 'default',
					canUseTool: this.deps.canUseTool,
					settings: this.deps.settings,
					// Opt out of user/project settings files so a stray
					// `~/.claude/settings.json` allowlist cannot widen the
					// adapter's permissions behind the harness's back. The
					// harness gate (via `canUseTool` above) is the
					// authoritative permission decision either way.
					settingSources: [],
				},
			});
		} catch (err) {
			request.signal?.removeEventListener('abort', abortForCaller);
			const error = classifyError(err);
			this.releaseOnEarlyExit(reservationCtx, error.kind, error.message);
			yield errorEvent(error);
			return;
		}

		let sessionId: string | undefined;
		let stopReason: string | undefined;
		let outcome: TurnOutcome = { kind: 'pending' };

		try {
			for await (const message of iterator) {
				if (request.signal?.aborted) {
					outcome = { kind: 'cancelled' };
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
						const msg = message.result ?? 'Claude turn ended with an error.';
						outcome = { kind: 'error', error: { kind: 'unknown', message: msg } };
						yield errorEvent({
							kind: 'unknown',
							message: msg,
							retriable: false,
						});
						return;
					}
					// Successful `result` is terminal; fall through to the
					// `done` event below.
					break;
				}
				if (message.type === 'user') {
					// SDK-internal `user` messages carry the tool runner's
					// output for tool calls the SDK executed itself. Surface
					// them as `tool_result` brain events — adapters that run
					// tools internally report results this way until the
					// harness dispatcher's `invoke()` becomes the
					// authoritative tool path. See the doc on
					// {@link BrainToolResultEvent}.
					for (const block of message.message.content) {
						if (block.type !== 'tool_result') {
							continue;
						}
						const tr = block as { tool_use_id: string; content: unknown; is_error?: boolean };
						yield {
							kind: 'tool_result',
							result: {
								id: tr.tool_use_id,
								content: renderToolResult(tr.content),
								isError: Boolean(tr.is_error),
							},
						};
					}
					continue;
				}
				// `system` messages carry SDK-internal bookkeeping (session
				// init, hook lifecycle, etc.); the brain contract does not
				// expose them.
			}
			if (request.signal?.aborted) {
				outcome = { kind: 'cancelled' };
				yield errorEvent(cancelledError());
				return;
			}
			outcome = { kind: 'success', stopReason };
			yield { kind: 'done', sessionId, stopReason };
		} catch (err) {
			const error = classifyError(err, request.signal);
			outcome = { kind: 'error', error };
			yield errorEvent(error);
		} finally {
			request.signal?.removeEventListener('abort', abortForCaller);
			this.finalizeReservation(reservationCtx, outcome);
		}
	}

	private async tryReserve(request: BrainRequest): Promise<ActiveReservation | RejectedReservation | undefined> {
		const budget = this.deps.budget;
		if (!budget) {
			return undefined;
		}
		const call = budget.estimateCall(request, this.deps.model);
		try {
			const { reservation, estimate } = await budget.meter.reserve(
				budget.category,
				call,
				{ sessionId: budget.sessionId },
			);
			const span = budget.tracer.startSpan(`chat ${this.deps.model ?? budget.category}`);
			span.setAttributes(buildGenAiAttributes({
				system: 'anthropic',
				requestModel: this.deps.model ?? 'unknown',
				sessionId: budget.sessionId,
				reservation,
				inputTokens: call.inputTokens,
				maxOutputTokens: call.maxOutputTokens,
			}));
			return { kind: 'active', reservation, estimate, call, span };
		} catch (err) {
			return { kind: 'rejected', error: budgetErrorToBrainError(err) };
		}
	}

	private releaseOnEarlyExit(
		ctx: ActiveReservation | RejectedReservation | undefined,
		errorKind: BrainError['kind'],
		message?: string,
	): void {
		if (!ctx || ctx.kind !== 'active') {
			return;
		}
		this.finalizeReservation(ctx, { kind: 'error', error: { kind: errorKind, message: message ?? errorKind } });
	}

	private finalizeReservation(
		ctx: ActiveReservation | RejectedReservation | undefined,
		outcome: TurnOutcome,
	): void {
		if (!ctx || ctx.kind !== 'active') {
			return;
		}
		const budget = this.deps.budget!;
		const { reservation, estimate, call, span } = ctx;
		if (outcome.kind === 'success') {
			const actual = budget.resolveActual ? budget.resolveActual(estimate, reservation) : estimate.value;
			budget.meter.commit(reservation, actual);
			span.setAttributes(buildGenAiCompletionAttributes({
				responseModel: this.deps.model,
				outputTokens: call.maxOutputTokens,
				finishReason: outcome.stopReason,
				actualCost: actual,
			}));
			span.setStatus({ code: SpanStatusCode.OK });
		} else {
			budget.meter.rollback(reservation);
			span.setStatus({
				code: SpanStatusCode.ERROR,
				message: outcome.kind === 'error' ? outcome.error.message : outcome.kind,
			});
		}
		span.end();
	}
}

interface ActiveReservation {
	readonly kind: 'active';
	readonly reservation: Reservation;
	readonly estimate: Estimate;
	readonly call: CallDescriptor;
	readonly span: Span;
}

interface RejectedReservation {
	readonly kind: 'rejected';
	readonly error: BrainError;
}

type TurnOutcome =
	| { readonly kind: 'pending' }
	| { readonly kind: 'success'; readonly stopReason?: string }
	| { readonly kind: 'cancelled' }
	| { readonly kind: 'error'; readonly error: { readonly kind: BrainError['kind']; readonly message: string } };

function budgetErrorToBrainError(err: unknown): BrainError {
	const message = err instanceof Error ? err.message : String(err);
	const code = (err as { code?: unknown }).code;
	if (typeof code === 'string' && code.startsWith('BUDGET_')) {
		return { kind: 'unknown', message, retriable: false, cause: err };
	}
	return { kind: 'unknown', message, retriable: false, cause: err };
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

function renderToolResult(content: unknown): string {
	if (typeof content === 'string') {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.map(block => {
				const text = (block as { text?: unknown } | null | undefined)?.text;
				if (typeof text === 'string') {
					return text;
				}
				return JSON.stringify(block);
			})
			.join('\n');
	}
	return JSON.stringify(content);
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
