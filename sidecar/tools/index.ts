/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ToolTier } from '../protocol';

/**
 * Single source of truth for the tools the agent is allowed to invoke.
 *
 * Each tool carries the minimal metadata the approval layer needs: its
 * permission tier (read auto-approves; anything else requires the user's
 * consent) and a `summarize` function that renders the one-line description
 * surfaced to the user in the approval prompt.
 *
 * The shape here is deliberately narrow so a future refactor moving tool
 * dispatch into the harness (and, later, routing through MCP) re-plumbs
 * these definitions rather than rewriting them. The `name` mirrors the
 * built-in Claude Agent SDK tool names; when a tool is later backed by an
 * MCP server or a harness-owned function, the contract stays identical.
 */
export interface ToolDefinition {
	readonly name: string;
	readonly tier: ToolTier;
	/** Whether the approval gate must prompt the user before executing. */
	readonly requiresApproval: boolean;
	/** Produces a one-line user-facing description of a proposed invocation. */
	summarize(input: Record<string, unknown>): string;
}

function pickString(input: Record<string, unknown>, key: string): string | undefined {
	const value = input[key];
	return typeof value === 'string' ? value : undefined;
}

function truncate(value: string, max: number): string {
	if (value.length <= max) {
		return value;
	}
	return value.slice(0, max - 1) + '…';
}

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
	{
		name: 'Read',
		tier: 'read',
		requiresApproval: false,
		summarize: input => {
			const path = pickString(input, 'file_path') ?? '<unknown path>';
			return `Read ${path}`;
		},
	},
	{
		name: 'Write',
		tier: 'write',
		requiresApproval: true,
		summarize: input => {
			const path = pickString(input, 'file_path') ?? '<unknown path>';
			return `Create or overwrite ${path}`;
		},
	},
	{
		name: 'Edit',
		tier: 'write',
		requiresApproval: true,
		summarize: input => {
			const path = pickString(input, 'file_path') ?? '<unknown path>';
			return `Edit ${path}`;
		},
	},
	{
		name: 'Bash',
		tier: 'external',
		requiresApproval: true,
		summarize: input => {
			const command = pickString(input, 'command');
			if (!command) {
				return 'Run a shell command';
			}
			return `Run shell: ${truncate(command, 120)}`;
		},
	},
	{
		// Surfaced to the brain as `mcp__thalyn__spawn_worker` because the
		// harness registers `spawn_worker` through the SDK's in-process
		// MCP server (server name "thalyn"); the SDK prefixes MCP tools.
		name: 'mcp__thalyn__spawn_worker',
		tier: 'external',
		requiresApproval: true,
		summarize: input => {
			const role = pickString(input, 'role') ?? '<unknown>';
			const task = pickString(input, 'task');
			if (!task) {
				return `Spawn ${role} worker`;
			}
			return `Spawn ${role} worker: ${truncate(task, 100)}`;
		},
	},
];

const BY_NAME = new Map<string, ToolDefinition>(
	TOOL_DEFINITIONS.map(def => [def.name, def]),
);

export function getToolDefinition(name: string): ToolDefinition | undefined {
	return BY_NAME.get(name);
}

/** Tools auto-approved by the SDK's `allowedTools` allowlist. */
export function allowedTools(): string[] {
	return TOOL_DEFINITIONS
		.filter(def => !def.requiresApproval)
		.map(def => def.name);
}

/** Tools the agent may call. Destructive ones gate through `canUseTool`. */
export function enabledTools(): string[] {
	return TOOL_DEFINITIONS.map(def => def.name);
}
