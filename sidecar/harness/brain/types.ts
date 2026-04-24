/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ToolCall, ToolResult, ToolSchema } from '../tools/types';

/**
 * `CentralBrain` is the narrow interface every primary-brain adapter
 * implements. The harness talks to one brain per session; brain selection
 * is per-session, not per-call.
 *
 * The interface is deliberately narrow. Permissions, approval prompts,
 * budget enforcement, rate-limit retries, tool execution, session
 * persistence, worker dispatch, memory compaction, rule-file loading, and
 * observability all live *above* this interface in the harness. The
 * brain's job is: turn a request into a stream of text and tool calls,
 * and surface errors. Everything else is the harness's.
 */
export interface CentralBrain {
	/**
	 * Run a single brain turn against `request`. The returned async
	 * iterable yields `BrainStreamEvent`s until either a `done` event or
	 * an `error` event arrives — both are terminal, and no further events
	 * follow. Consumers may `break` out of the iteration to stop early;
	 * the brain must treat that as cancellation and release any
	 * underlying network resources.
	 *
	 * Cancellation: `request.signal`, if provided, signals the caller's
	 * intent to abort. The brain must stop streaming promptly, close any
	 * open connection, and yield a terminal `error` event of kind
	 * `cancelled`.
	 *
	 * Errors: every error path terminates the stream with an `error`
	 * event carrying a typed `BrainError`. Thrown exceptions from the
	 * async iterable are also permitted but discouraged — consumers must
	 * handle both.
	 */
	send(request: BrainRequest): AsyncIterable<BrainStreamEvent>;
}

/**
 * The payload `CentralBrain.send` accepts.
 *
 * `system` is the system prompt the harness constructs from identity,
 * agent preferences, and project rules (three-layer memory; see
 * `sidecar/harness/memory/`). `messages` is the full transcript the
 * brain should act on, including prior tool-use and tool-result blocks.
 * `tools` is the set of tools the brain may invoke — the dispatcher's
 * schemas, regardless of whether a given tool is backed by a direct
 * function call or by an MCP server.
 */
export interface BrainRequest {
	readonly system: string;
	readonly messages: readonly BrainMessage[];
	readonly tools: readonly ToolSchema[];
	/**
	 * If present, aborting the signal instructs the brain to cancel the
	 * in-flight turn. The brain yields a terminal `error` event of kind
	 * `cancelled` in response.
	 */
	readonly signal?: AbortSignal;
}

/**
 * One turn of the transcript. Content is an ordered list of blocks —
 * assistant turns may contain text and tool-use blocks; user turns may
 * contain text and tool-result blocks. Richer shapes (for example,
 * provider-native multimodal blocks) are deferred until a concrete
 * feature demands them.
 */
export interface BrainMessage {
	readonly role: 'user' | 'assistant';
	readonly content: readonly BrainContent[];
}

/** A content block inside a `BrainMessage`. */
export type BrainContent =
	| BrainTextContent
	| BrainToolUseContent
	| BrainToolResultContent;

/** Plain text. Present on both user and assistant turns. */
export interface BrainTextContent {
	readonly type: 'text';
	readonly text: string;
}

/**
 * A tool call the assistant emitted in a prior turn. The shape mirrors
 * `ToolCall` from the dispatcher — `id`, `name`, `input` — so the same
 * call object flows from the brain's stream out to the dispatcher and
 * back into the transcript without reshaping.
 */
export interface BrainToolUseContent extends ToolCall {
	readonly type: 'tool_use';
}

/**
 * The dispatcher's outcome for an earlier `tool_use`. Mirrors
 * `ToolResult` (`id`, `content`, `isError`) plus the `type` tag.
 */
export interface BrainToolResultContent extends ToolResult {
	readonly type: 'tool_result';
}

/**
 * Events the brain emits while a turn is in progress. The stream is
 * terminated by exactly one of `done` or `error`.
 */
export type BrainStreamEvent =
	| BrainTextEvent
	| BrainToolUseEvent
	| BrainDoneEvent
	| BrainErrorEvent;

/**
 * A chunk of assistant text. Multiple `text` events may arrive in a
 * single turn; consumers concatenate them in order to reconstruct the
 * message text.
 */
export interface BrainTextEvent {
	readonly kind: 'text';
	readonly text: string;
}

/**
 * A fully assembled tool call. The brain emits exactly one `tool_use`
 * event per call — delta-level streaming of partial-JSON input is an
 * adapter-internal concern and is not exposed here. Consumers pass the
 * `call` to the dispatcher's `invoke()` to execute it.
 */
export interface BrainToolUseEvent {
	readonly kind: 'tool_use';
	readonly call: ToolCall;
}

/**
 * Terminal event on a successful turn. `sessionId` is the adapter's
 * opaque session identifier, surfaced for later resume support.
 * `stopReason` is adapter-defined metadata — consumers should not
 * switch on specific values.
 */
export interface BrainDoneEvent {
	readonly kind: 'done';
	readonly sessionId?: string;
	readonly stopReason?: string;
}

/** Terminal event on a failed turn. */
export interface BrainErrorEvent {
	readonly kind: 'error';
	readonly error: BrainError;
}

/**
 * Typed error surface. Flat discriminated union rather than a class
 * hierarchy: the `kind` tag + `retriable` flag is what the harness's
 * retry layer (exponential backoff) needs, and richer structure
 * (chained causes, per-provider error codes) belongs inside `cause`
 * when present.
 */
export type BrainError =
	| BrainAuthError
	| BrainRateLimitError
	| BrainNetworkError
	| BrainCancelledError
	| BrainToolSchemaError
	| BrainUnknownError;

/**
 * The provider refused the request on auth grounds — missing key,
 * expired key, revoked token. Not retriable without user intervention.
 */
export interface BrainAuthError {
	readonly kind: 'auth';
	readonly message: string;
	readonly retriable: false;
	readonly cause?: unknown;
}

/**
 * The provider applied a rate limit. Retriable after the suggested
 * delay; `retryAfterMs`, when present, carries the provider's hint.
 */
export interface BrainRateLimitError {
	readonly kind: 'rate_limit';
	readonly message: string;
	readonly retriable: true;
	readonly retryAfterMs?: number;
	readonly cause?: unknown;
}

/**
 * Transport-level failure — connection refused, timeout, DNS
 * resolution failure, abrupt socket close. Retriable.
 */
export interface BrainNetworkError {
	readonly kind: 'network';
	readonly message: string;
	readonly retriable: true;
	readonly cause?: unknown;
}

/**
 * The caller aborted via `request.signal`, or the stream was
 * otherwise cancelled. Not retriable — the caller has signalled
 * intent to stop.
 */
export interface BrainCancelledError {
	readonly kind: 'cancelled';
	readonly message: string;
	readonly retriable: false;
	readonly cause?: unknown;
}

/**
 * The brain received tool schemas it could not use, or emitted a tool
 * call whose input failed schema validation. A programming error on
 * either side; not retriable at the call site.
 */
export interface BrainToolSchemaError {
	readonly kind: 'tool_schema';
	readonly message: string;
	readonly retriable: false;
	readonly cause?: unknown;
}

/**
 * Anything else. `retriable` is `false` by default; adapters that can
 * detect a retriable condition should classify it as one of the
 * specific kinds above instead of setting this to `true`.
 */
export interface BrainUnknownError {
	readonly kind: 'unknown';
	readonly message: string;
	readonly retriable: false;
	readonly cause?: unknown;
}
