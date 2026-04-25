/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { BrainMessage } from '../brain/types';
import type { ToolDispatcher } from '../tools/dispatcher';
import type { ToolSchema } from '../tools/types';
import { drainWorker, WorkerDispatcher, type WorkerDispatcherDeps } from './dispatcher';
import { registerAllRoles } from './roles';
import type { CentralBrainFactory, WorkersYamlOverrides } from './types';

/**
 * The tool names the built-in role allowlists reference. Until the
 * dispatcher pivot wires real backends for these (Phase 4+), the worker
 * dispatcher only needs their schemas — workers list them in their
 * tools array, but the SDK runs no matching backend, so workers run
 * effectively text-only for now. Schemas live in code (not YAML) so
 * a typo in a role allowlist surfaces as a TypeScript error.
 */
export const WORKER_TOOL_SCHEMAS: readonly ToolSchema[] = [
	{
		name: 'read_file',
		description: 'Read a file from the workspace.',
		inputSchema: {
			type: 'object',
			properties: { path: { type: 'string' } },
			required: ['path'],
		},
		tier: 'read',
	},
	{
		name: 'grep',
		description: 'Search the workspace for a regex.',
		inputSchema: {
			type: 'object',
			properties: { pattern: { type: 'string' } },
			required: ['pattern'],
		},
		tier: 'read',
	},
	{
		name: 'write_file',
		description: 'Create or overwrite a file in the workspace.',
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string' },
				contents: { type: 'string' },
			},
			required: ['path', 'contents'],
		},
		tier: 'write',
	},
	{
		name: 'edit_file',
		description: 'Apply an edit to a file in the workspace.',
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string' },
				old_string: { type: 'string' },
				new_string: { type: 'string' },
			},
			required: ['path', 'old_string', 'new_string'],
		},
		tier: 'write',
	},
	{
		name: 'run_command',
		description: 'Run a shell command and return its output.',
		inputSchema: {
			type: 'object',
			properties: { command: { type: 'string' } },
			required: ['command'],
		},
		tier: 'external',
	},
];

/**
 * Minimal `Pick<ToolDispatcher, 'schemaFor'>` shim that the worker
 * dispatcher uses to resolve the role allowlists. Wraps the static
 * {@link WORKER_TOOL_SCHEMAS} table; once the harness `ToolDispatcher`
 * is the source of truth for both built-ins and MCP tools (Phase 4+),
 * the wiring layer hands the real dispatcher to `WorkerDispatcher` and
 * this shim goes away.
 */
export function buildWorkerToolsView(): Pick<ToolDispatcher, 'schemaFor'> {
	const byName = new Map(WORKER_TOOL_SCHEMAS.map(s => [s.name, s] as const));
	return {
		schemaFor: (name: string) => byName.get(name),
	};
}

/**
 * Build a configured {@link WorkerDispatcher} with all built-in roles
 * registered and the user's `workers.yaml` overrides applied.
 */
export function buildWorkerDispatcher(deps: {
	readonly brainFactory: CentralBrainFactory;
	readonly sessionId: string;
	readonly overrides: WorkersYamlOverrides;
}): WorkerDispatcher {
	const dispatcherDeps: WorkerDispatcherDeps = {
		brainFactory: deps.brainFactory,
		tools: buildWorkerToolsView(),
		sessionId: deps.sessionId,
	};
	const dispatcher = new WorkerDispatcher(dispatcherDeps, deps.overrides);
	registerAllRoles(dispatcher);
	return dispatcher;
}

/**
 * Drain a worker spawn into a single text payload for the
 * `spawn_worker` MCP tool's response. Concatenates streamed text and
 * tool-call summaries; on terminal `error`, returns the error message
 * with `isError: true`. Tool-call serialization stays JSON so the
 * parent brain can reason about what the worker did even though the
 * SDK ran the tools internally.
 */
export async function runSpawnWorker(
	dispatcher: WorkerDispatcher,
	args: { role: string; task: string; context?: readonly BrainMessage[] },
): Promise<{ text: string; isError: boolean }> {
	let handle;
	try {
		handle = dispatcher.spawn(args.role, args.task, args.context ?? []);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { text: message, isError: true };
	}
	const result = await drainWorker(handle);
	if (result.error) {
		return { text: result.error.message, isError: true };
	}
	const parts: string[] = [];
	if (result.text.length > 0) {
		parts.push(result.text);
	}
	for (const call of result.toolCalls) {
		parts.push(`[tool_use ${call.name} ${JSON.stringify(call.input)}]`);
	}
	return { text: parts.join('\n').trim(), isError: false };
}
