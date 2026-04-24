/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ToolApprovalReplyParams } from '../../protocol';
import type { ApprovalGate } from './approval';
import type {
	RegisteredTool,
	ToolCall,
	ToolInvocationContext,
	ToolResult,
	ToolSchema,
} from './types';

/**
 * Unified tool-dispatch surface. The brain sees `schemas()`; brain
 * adapters call `invoke()` to execute a tool; the webview routes
 * approval replies through `handleApprovalReply()`.
 *
 * A tool is `{ schema, backend }` — identical whether the backend is a
 * direct function call or an MCP client. The boundary is designed so a
 * built-in tool and an MCP tool are indistinguishable from the brain's
 * perspective, preserving the option of migrating to MCP-primary
 * without reshaping adapter code.
 *
 * Every `invoke()` passes through the approval gate before the backend
 * runs. Read-tier tools pass through; destructive tools gate on the
 * user's reply to a `tool.approval.request` webview notification.
 *
 * The dispatcher does not enforce budget or emit observability —
 * those concerns wrap the dispatcher rather than living inside it.
 */
export class ToolDispatcher {
	private readonly tools = new Map<string, RegisteredTool>();

	constructor(
		private readonly gate: ApprovalGate,
		private readonly deps: ToolDispatcherDeps,
	) { }

	/** Register a tool. Names must be unique; re-registration throws. */
	register(tool: RegisteredTool): void {
		if (this.tools.has(tool.schema.name)) {
			throw new Error(`Tool already registered: ${tool.schema.name}`);
		}
		this.tools.set(tool.schema.name, tool);
	}

	/** Register many tools at once. */
	registerAll(tools: readonly RegisteredTool[]): void {
		for (const tool of tools) {
			this.register(tool);
		}
	}

	/** The tool schemas the brain may call. */
	schemas(): ToolSchema[] {
		return Array.from(this.tools.values(), t => t.schema);
	}

	/** Lookup a registered tool's schema by name. */
	schemaFor(name: string): ToolSchema | undefined {
		return this.tools.get(name)?.schema;
	}

	/**
	 * Run the approval gate for a proposed call without executing it.
	 * The Claude adapter's SDK-level `canUseTool` hook calls this —
	 * on that code path the SDK, not the dispatcher, executes the
	 * tool, so the adapter only needs the gate's decision. The hook
	 * fires under API-key authentication; under OAuth the bundled
	 * CLI bypasses `canUseTool`, so the authoritative enforcement
	 * point is the approval step inside `invoke()`.
	 */
	async checkApproval(request: DispatcherApprovalRequest): Promise<DispatcherApprovalOutcome> {
		const tool = this.tools.get(request.toolName);
		if (!tool) {
			return { outcome: 'decline', reason: `Unknown tool: ${request.toolName}` };
		}
		const summary = request.summary ?? `Use ${tool.schema.name}`;
		const gateResult = await this.gate.check({
			toolName: tool.schema.name,
			tier: tool.schema.tier,
			toolUseId: request.toolUseId,
			turnCorrelationId: request.turnCorrelationId,
			summary,
			input: request.input,
		});
		return gateResult;
	}

	/**
	 * Full dispatch: gate the call, then invoke the backend. The brain's
	 * adapter calls this once it has a fully assembled `ToolCall` from
	 * its stream.
	 *
	 * Declined calls come back as `ToolResult { isError: true }` with
	 * the decline reason as content — the brain should receive the
	 * refusal as a tool-level failure, not an exception.
	 */
	async invoke(call: ToolCall, ctx: DispatcherInvocationContext): Promise<ToolResult> {
		const tool = this.tools.get(call.name);
		if (!tool) {
			return {
				id: call.id,
				content: `Unknown tool: ${call.name}`,
				isError: true,
			};
		}

		const summary = this.deps.summarize?.(tool.schema, call.input) ?? `Use ${tool.schema.name}`;
		const approval = await this.gate.check({
			toolName: tool.schema.name,
			tier: tool.schema.tier,
			toolUseId: call.id,
			turnCorrelationId: ctx.turnCorrelationId,
			summary,
			input: call.input,
		});
		if (approval.outcome === 'decline') {
			return { id: call.id, content: approval.reason, isError: true };
		}

		const invocation: ToolInvocationContext = { signal: ctx.signal };
		return tool.backend.invoke(call, invocation);
	}

	/** Forward a `tool.approval.reply` notification to the gate. */
	handleApprovalReply(reply: ToolApprovalReplyParams): void {
		this.gate.handleReply(reply);
	}

	/**
	 * Resolve every pending approval tied to `turnCorrelationId` as a
	 * decline. The adapter calls this when its turn ends so no approval
	 * prompt outlives the turn that triggered it.
	 */
	cancelApprovalsForTurn(turnCorrelationId: string): void {
		this.gate.cancelForTurn(turnCorrelationId);
	}
}

export interface ToolDispatcherDeps {
	/**
	 * Optional — renders the one-line description surfaced on an
	 * approval prompt. When omitted, the dispatcher falls back to
	 * `Use <toolName>`. Callers that want richer summaries (as
	 * `sidecar/tools/index.ts`'s `summarize()` provides today) wire
	 * them through here.
	 */
	readonly summarize?: (schema: ToolSchema, input: Record<string, unknown>) => string;
}

export interface DispatcherApprovalRequest {
	readonly toolName: string;
	readonly toolUseId: string;
	readonly turnCorrelationId: string;
	readonly input: Record<string, unknown>;
	readonly summary?: string;
}

export type DispatcherApprovalOutcome =
	| { readonly outcome: 'approve' }
	| { readonly outcome: 'decline'; readonly reason: string };

export interface DispatcherInvocationContext {
	readonly turnCorrelationId: string;
	readonly signal: AbortSignal;
}
