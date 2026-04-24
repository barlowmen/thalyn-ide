/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { BrainStreamEvent } from '../brain/types';
import type { ToolDispatcher } from '../tools/dispatcher';
import type {
	CentralBrainFactory,
	EffectiveRole,
	RoleDefinition,
	SpawnOptions,
	WorkerContext,
	WorkerHandle,
	WorkerResult,
	WorkersYamlOverrides,
} from './types';

/**
 * `WorkerDispatcher` is the harness's replacement for the Agent SDK's
 * default `Task` tool. It exposes `spawn(role, task, context, options?)`
 * — the shape the primary brain sees as the `spawn_worker` tool — and
 * contains zero role-specific knowledge. Role modules self-register
 * via `registerRole`; `sidecar/config/workers.yaml` layers user
 * overrides on top at startup.
 *
 * The dispatcher is brain-agnostic by construction: it takes a
 * `CentralBrainFactory` and never imports from any adapter module. A
 * Claude-backed factory returns a Claude adapter per spawn; a Llama-
 * backed factory returns a Llama adapter per spawn; a mixed factory
 * can route per model — the dispatcher is indifferent.
 *
 * Shared vs isolated state:
 * - **Shared with the parent:** `ToolDispatcher` (so approval prompts
 *   flow to the same user), budget meter (when it lands), and the
 *   observability pipeline.
 * - **Isolated per spawn:** `CentralBrain` instance, message history
 *   (the worker sees only `context` + the task), and the tool-
 *   allowlist view (filtered to the effective role's allowlist).
 */
export class WorkerDispatcher {
	private readonly roles = new Map<string, RoleDefinition>();
	private readonly overrides: WorkersYamlOverrides;
	private readonly effectiveCache = new Map<string, EffectiveRole>();

	constructor(
		private readonly deps: WorkerDispatcherDeps,
		overrides: WorkersYamlOverrides = {},
	) {
		this.overrides = overrides;
	}

	/**
	 * Register a role. Role ids must be unique; re-registration throws.
	 * Called once per role at startup, typically from a co-located
	 * `registerAll(dispatcher)` helper in `./roles/`.
	 */
	registerRole(def: RoleDefinition): void {
		if (this.roles.has(def.id)) {
			throw new Error(`Role already registered: ${def.id}`);
		}
		this.roles.set(def.id, def);
		this.effectiveCache.delete(def.id);
	}

	/** Known role ids in registration order. */
	roleIds(): readonly string[] {
		return Array.from(this.roles.keys());
	}

	/**
	 * Resolve the effective role by layering registered defaults with
	 * any `workers.yaml` overrides. Cached per id; cache invalidates on
	 * re-registration.
	 *
	 * Throws if the role id is unknown.
	 */
	effectiveRole(id: string): EffectiveRole {
		const cached = this.effectiveCache.get(id);
		if (cached) {
			return cached;
		}
		const def = this.roles.get(id);
		if (!def) {
			throw new Error(`Unknown role: ${id}`);
		}
		const override = this.overrides.roles?.[id];
		const resolved: EffectiveRole = {
			id: def.id,
			model: override?.model ?? def.defaultModel,
			allowlist: override?.allowlist ?? def.defaultAllowlist,
			systemPromptTemplate: def.systemPromptTemplate,
			retry: def.retry,
		};
		this.effectiveCache.set(id, resolved);
		return resolved;
	}

	/**
	 * Spawn a worker. Returns a `WorkerHandle` immediately; the worker
	 * begins execution on the next microtask tick. Parallel spawning is
	 * supported by construction — each call builds its own isolated
	 * `CentralBrain` and its own handle.
	 *
	 * TODO: implement the in-process worker loop, tool-allowlist
	 * filtering, context transcript assembly, retry wrapping, and
	 * cancellation propagation.
	 */
	spawn(
		role: string,
		task: string,
		context: WorkerContext,
		options?: SpawnOptions,
	): WorkerHandle {
		const effective = this.effectiveRole(role);
		void effective;
		void task;
		void context;
		void options;
		void this.deps;
		throw new Error('WorkerDispatcher.spawn is not implemented yet.');
	}
}

/**
 * Dependencies the dispatcher is constructed with. Everything brain-
 * or harness-level that workers need to reach is handed in here —
 * keeping the dispatcher itself free of singletons.
 */
export interface WorkerDispatcherDeps {
	/**
	 * Factory used to construct a fresh `CentralBrain` for every
	 * spawn. Keeps the dispatcher off any concrete adapter.
	 */
	readonly brainFactory: CentralBrainFactory;
	/**
	 * The parent's `ToolDispatcher`. Workers share the tool surface
	 * (and therefore the approval gate); the worker loop filters
	 * schemas down to the effective role's allowlist.
	 */
	readonly tools: ToolDispatcher;
}

/**
 * Drain a `WorkerHandle` to its terminal `WorkerResult`. The handle
 * already supports both streaming iteration and awaiting `.result`
 * directly; this is a convenience wrapper for callers that want a
 * single await and do not need the events.
 */
export async function drainWorker(handle: WorkerHandle): Promise<WorkerResult> {
	for await (const _ev of handle) {
		void _ev;
	}
	return handle.result;
}

/**
 * Re-exported from the stream types so callers using the dispatcher's
 * public surface don't also need to import `brain/types`.
 */
export type { BrainStreamEvent };
