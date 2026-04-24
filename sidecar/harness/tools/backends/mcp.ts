/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ToolTier } from '../../../protocol';
import type {
	RegisteredTool,
	ToolBackend,
	ToolCall,
	ToolInvocationContext,
	ToolResult,
	ToolSchema,
} from '../types';

/**
 * Minimal view of the MCP SDK's `Client` type. Captured as an interface
 * so the harness does not import the full SDK surface at type-resolution
 * time, and so tests can inject a fake.
 *
 * The real methods carry several extra parameters we do not need; this
 * type only exposes what the backend actually calls.
 */
export interface McpClientLike {
	listTools(): Promise<{ tools: readonly McpToolDescriptor[] }>;
	callTool(
		params: { name: string; arguments?: Record<string, unknown> },
		resultSchema?: unknown,
		options?: { signal?: AbortSignal },
	): Promise<McpCallToolResult>;
}

/** The subset of MCP's `Tool` descriptor the harness maps onto `ToolSchema`. */
export interface McpToolDescriptor {
	readonly name: string;
	readonly description?: string;
	readonly inputSchema: Record<string, unknown>;
}

/**
 * The subset of MCP's `CallToolResult` the backend reads. The MCP
 * protocol supports two result shapes — structured content blocks (the
 * common case) and a legacy `toolResult` carrier. We accept either and
 * flatten both to a string at the dispatcher boundary.
 */
export type McpCallToolResult =
	| {
		readonly content: readonly McpContentBlock[];
		readonly isError?: boolean;
	}
	| {
		readonly toolResult: unknown;
		readonly isError?: boolean;
	};

export type McpContentBlock =
	| { readonly type: 'text'; readonly text: string }
	| { readonly type: string;[key: string]: unknown };

/**
 * `ToolBackend` implementation that invokes a tool on an MCP client.
 * The backend holds a reference to the shared `McpClientLike` (one
 * client may serve many tools) plus the remote tool name — the name
 * the MCP server knows the tool by, which the harness keeps identical
 * to the dispatcher's registered name.
 */
export class McpBackend implements ToolBackend {
	constructor(
		private readonly client: McpClientLike,
		private readonly remoteName: string,
	) { }

	async invoke(call: ToolCall, ctx: ToolInvocationContext): Promise<ToolResult> {
		if (ctx.signal.aborted) {
			return {
				id: call.id,
				content: 'Tool call aborted before it started.',
				isError: true,
			};
		}
		try {
			const result = await this.client.callTool(
				{ name: this.remoteName, arguments: call.input },
				undefined,
				{ signal: ctx.signal },
			);
			const content = hasContentBlocks(result)
				? flattenContent(result.content)
				: stringify(result.toolResult);
			return {
				id: call.id,
				content,
				isError: Boolean(result.isError),
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { id: call.id, content: message, isError: true };
		}
	}
}

/**
 * Discover every tool an MCP client advertises and wrap each as a
 * `RegisteredTool` ready for `ToolDispatcher.register()`. Schemas come
 * directly from the server's `tools/list` reply; the caller supplies a
 * `tierPolicy` that classifies each tool by destructive potential so
 * the approval gate knows how to treat it.
 *
 * `tierPolicy` is required — destructive MCP tools must opt-in to the
 * approval gate with an honest tier. Silent defaults here would be a
 * correctness hazard.
 */
export async function registerMcpClient(
	client: McpClientLike,
	tierPolicy: (toolName: string, descriptor: McpToolDescriptor) => ToolTier,
): Promise<RegisteredTool[]> {
	const { tools } = await client.listTools();
	return tools.map(descriptor => {
		const schema: ToolSchema = {
			name: descriptor.name,
			description: descriptor.description ?? '',
			inputSchema: descriptor.inputSchema,
			tier: tierPolicy(descriptor.name, descriptor),
		};
		const backend = new McpBackend(client, descriptor.name);
		return { schema, backend };
	});
}

function hasContentBlocks(
	result: McpCallToolResult,
): result is { readonly content: readonly McpContentBlock[]; readonly isError?: boolean } {
	return Array.isArray((result as { content?: unknown }).content);
}

function stringify(value: unknown): string {
	if (typeof value === 'string') {
		return value;
	}
	if (value === null || value === undefined) {
		return '';
	}
	return JSON.stringify(value);
}

function flattenContent(content: readonly McpContentBlock[]): string {
	if (content.length === 0) {
		return '';
	}
	return content
		.map(block => {
			if (block.type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
				return (block as { text: string }).text;
			}
			return JSON.stringify(block);
		})
		.join('\n');
}
