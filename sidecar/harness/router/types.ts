/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Router interface for *non-brain* LLM calls — the worker dispatcher
 * (researcher / implementer / reviewer / tester roles) and the budget
 * estimator.
 *
 * This is deliberately separate from `CentralBrain`. Brains own a single
 * conversation and stream text/tool-use events back to the harness;
 * workers are bounded tasks that either produce a full result or a
 * stream of intermediate events, and the harness rarely needs the full
 * Agent-SDK surface for them. Keeping the shapes separate means we can
 * evolve each independently.
 *
 * Provider implementations own their native SDK translation. The
 * decisive reason this layer is hand-rolled rather than built on a
 * cross-provider SDK (e.g. Vercel AI SDK) is the Claude-via-Claude-Code
 * invariant: the Anthropic path must go through
 * `@anthropic-ai/claude-agent-sdk`, not the raw Messages API, so the
 * "one library across all providers" pitch already breaks on the most
 * important path and the saved integration cost disappears.
 */

/** A single message in an `LlmRequest`. */
export interface LlmMessage {
	readonly role: 'system' | 'user' | 'assistant' | 'tool';
	readonly content: string;
	/**
	 * Tool calls the assistant emitted on this turn. Only populated when
	 * `role === 'assistant'` and the prior turn invoked tools.
	 */
	readonly toolCalls?: readonly LlmToolCall[];
	/**
	 * The id of the `LlmToolCall` this message satisfies. Required when
	 * `role === 'tool'`; omitted otherwise.
	 */
	readonly toolCallId?: string;
}

/** A single tool invocation the model emitted. */
export interface LlmToolCall {
	readonly id: string;
	readonly name: string;
	readonly args: Record<string, unknown>;
}

/**
 * Tool definition as presented to a non-brain model. The shape mirrors
 * the harness's `ToolSchema` deliberately — when the worker dispatcher
 * forwards harness tools to a worker, the translation is a direct copy.
 */
export interface LlmToolDef {
	readonly name: string;
	readonly description: string;
	/** JSON Schema describing the tool's input object. */
	readonly inputSchema: Record<string, unknown>;
}

/** One call to an `LlmProvider`. */
export interface LlmRequest {
	readonly messages: readonly LlmMessage[];
	readonly tools?: readonly LlmToolDef[];
	readonly signal?: AbortSignal;
	/** Optional per-call overrides; providers ignore unknown keys. */
	readonly options?: LlmRequestOptions;
}

/** Cross-provider request knobs. Providers ignore unknown keys. */
export interface LlmRequestOptions {
	readonly model?: string;
	readonly temperature?: number;
	readonly maxOutputTokens?: number;
}

/** Token-accounting data, when the provider reports it. */
export interface LlmUsage {
	readonly inputTokens?: number;
	readonly outputTokens?: number;
}

/** Final result of a non-streaming (`generate`) call. */
export interface LlmGenerateResult {
	readonly text: string;
	readonly toolCalls: readonly LlmToolCall[];
	readonly stopReason?: string;
	readonly usage?: LlmUsage;
	/** Model id the provider actually dispatched to. */
	readonly model: string;
}

/** Events a streaming (`stream`) call emits. Terminated by exactly one `done`. */
export type LlmStreamEvent =
	| { readonly kind: 'text'; readonly text: string }
	| { readonly kind: 'tool_call'; readonly call: LlmToolCall }
	| { readonly kind: 'done'; readonly result: LlmGenerateResult };

/**
 * Uniform provider contract. Every provider (Gemini, Grok, Ollama, and
 * eventually a wrapper over `ClaudeAdapter` for Claude-as-worker)
 * satisfies this.
 *
 * `generate` must be implementable; `stream` is optional for providers
 * whose underlying SDK only exposes non-streaming calls, in which case
 * the registry falls back to buffering a `generate` result.
 */
export interface LlmProvider {
	readonly name: string;
	generate(request: LlmRequest): Promise<LlmGenerateResult>;
	stream?(request: LlmRequest): AsyncIterable<LlmStreamEvent>;
}

/**
 * Signals an LLM call failed. Typed kinds match `BrainError` for the
 * brain path so the harness's retry / approval layers can treat both
 * uniformly.
 */
export class LlmError extends Error {
	constructor(
		readonly kind: LlmErrorKind,
		message: string,
		readonly retriable: boolean,
		readonly cause?: unknown,
	) {
		super(message);
		this.name = 'LlmError';
	}
}

export type LlmErrorKind =
	| 'auth'
	| 'rate_limit'
	| 'network'
	| 'cancelled'
	| 'tool_schema'
	| 'unknown';
