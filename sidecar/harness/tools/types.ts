/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ToolTier } from '../../protocol';

/**
 * The tool shape the brain sees. Identical whether the tool is backed
 * by a direct function call or by an MCP server.
 *
 * `inputSchema` is a JSON Schema describing the `input` object the
 * brain will emit on a `tool_use` call. It is typed as
 * `Record<string, unknown>` here because JSON Schema's own type is
 * unconstrained; adapters that need typed validation wrap the schema
 * at registration time.
 */
export interface ToolSchema {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>;
	/**
	 * Destructive potential tier. Drives the harness's approval gate:
	 * `read` passes through; `write | delete | external` prompt the
	 * user before the backend runs.
	 */
	readonly tier: ToolTier;
}

/**
 * A single tool invocation. `id` is the correlation id the brain
 * assigned to the call — passed through untouched so `ToolResult` can
 * reference it. `input` is the unvalidated payload from the brain;
 * backends are responsible for their own validation against
 * `ToolSchema.inputSchema` if they need it.
 */
export interface ToolCall {
	readonly id: string;
	readonly name: string;
	readonly input: Record<string, unknown>;
}

/**
 * A tool's outcome. `content` is the string rendering the brain will
 * receive as the `tool_result` content block on its next turn;
 * structured-output tools render their payload as JSON. `isError`
 * flips the block's `is_error` flag so the brain can tell success
 * from failure without parsing the content.
 *
 * Rationale for string-only content: the Agent SDK's `tool_result`
 * block accepts either a string or a structured array; MCP's
 * `CallToolResult` emits a structured array. Collapsing both to a
 * string at the dispatcher boundary keeps the brain surface uniform
 * and pushes any richer rendering into the individual backends.
 */
export interface ToolResult {
	readonly id: string;
	readonly content: string;
	readonly isError: boolean;
}

/**
 * Runtime context a backend receives alongside the call. Today this
 * carries only the cancellation signal. Future additions (budget
 * meter handle, correlationId chain for tracing, per-call workspace
 * root) land here rather than broadening `ToolCall` itself.
 */
export interface ToolInvocationContext {
	readonly signal: AbortSignal;
}

/**
 * The internal interface a tool's *backing* implementation satisfies.
 * Two production implementations exist: `BuiltinBackend` wraps a
 * direct async function; `McpBackend` wraps an MCP `Client`.
 *
 * The dispatcher is the only caller of this interface. The brain
 * never sees a `ToolBackend`.
 */
export interface ToolBackend {
	/**
	 * Execute the call and return the result. Must not throw for
	 * tool-level failures (file not found, subprocess exit non-zero,
	 * MCP server returned an error) — those surface as
	 * `ToolResult { isError: true }`. Thrown exceptions are reserved
	 * for programming errors (backend misconfiguration, invariant
	 * violations) that the harness should not paper over.
	 */
	invoke(call: ToolCall, ctx: ToolInvocationContext): Promise<ToolResult>;
}

/**
 * A tool as registered with the dispatcher: its schema (what the
 * brain sees) plus the backend that executes it.
 */
export interface RegisteredTool {
	readonly schema: ToolSchema;
	readonly backend: ToolBackend;
}
