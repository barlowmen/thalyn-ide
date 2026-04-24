/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ToolBackend, ToolCall, ToolInvocationContext, ToolResult } from '../types';

/**
 * Async function backing a built-in tool. Implementations receive the
 * brain's raw input and the invocation context, and return a string
 * rendering of the result. Implementations should honour
 * `ctx.signal` where cheap — long-running I/O must stop when the
 * signal aborts.
 *
 * Throwing is reserved for programming errors. Tool-level failures
 * (file not found, subprocess non-zero exit) should be returned as
 * strings from an implementation that calls `toolError()` below.
 */
export type BuiltinToolFn = (
	input: Record<string, unknown>,
	ctx: ToolInvocationContext,
) => Promise<BuiltinToolOutcome>;

/** A successful built-in outcome — render content into the tool_result block. */
export interface BuiltinToolSuccess {
	readonly kind: 'success';
	readonly content: string;
}

/** A tool-level failure. Distinct from thrown exceptions, which indicate bugs. */
export interface BuiltinToolFailure {
	readonly kind: 'error';
	readonly message: string;
}

export type BuiltinToolOutcome = BuiltinToolSuccess | BuiltinToolFailure;

/** Convenience constructor for successful outcomes. */
export function toolSuccess(content: string): BuiltinToolSuccess {
	return { kind: 'success', content };
}

/** Convenience constructor for failure outcomes. */
export function toolError(message: string): BuiltinToolFailure {
	return { kind: 'error', message };
}

/**
 * `ToolBackend` implementation that wraps a plain async function. The
 * tool's `ToolSchema` is registered separately with the dispatcher;
 * the backend's job is execution only.
 */
export class BuiltinBackend implements ToolBackend {
	constructor(private readonly fn: BuiltinToolFn) { }

	async invoke(call: ToolCall, ctx: ToolInvocationContext): Promise<ToolResult> {
		if (ctx.signal.aborted) {
			return {
				id: call.id,
				content: 'Tool call aborted before it started.',
				isError: true,
			};
		}
		try {
			const outcome = await this.fn(call.input, ctx);
			if (outcome.kind === 'success') {
				return { id: call.id, content: outcome.content, isError: false };
			}
			return { id: call.id, content: outcome.message, isError: true };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { id: call.id, content: message, isError: true };
		}
	}
}
