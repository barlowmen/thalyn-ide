/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DEFAULT_RETRY_POLICY, type RetryPolicy, withRetry } from '../brain/retry';
import type {
	BrainError,
	BrainMessage,
	BrainRequest,
	BrainStreamEvent,
	BrainToolUseContent,
	CentralBrain,
} from '../brain/types';
import type { ToolDispatcher } from '../tools/dispatcher';
import type { ToolSchema } from '../tools/types';
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
	 * Spawn a worker. Returns a `WorkerHandle` synchronously; the worker
	 * begins execution on the next microtask tick. Parallel spawning is
	 * supported by construction — each call builds its own isolated
	 * `CentralBrain` and its own handle, sharing only the parent's
	 * `ToolDispatcher` (so approvals route to one user) and the
	 * observability pipeline.
	 *
	 * Validation failures (unknown role, unresolved allowlist tool) are
	 * raised synchronously from this call so the caller learns about
	 * them before a handle gets into the wild.
	 */
	spawn(
		role: string,
		task: string,
		context: WorkerContext,
		options?: SpawnOptions,
	): WorkerHandle {
		const effective = this.effectiveRole(role);
		const model = options?.model ?? effective.model;
		const tools = this.resolveAllowlist(effective);

		const system = effective.systemPromptTemplate(task);
		const messages: readonly BrainMessage[] = [
			...context,
			{ role: 'user', content: [{ type: 'text', text: task }] },
		];

		const rawBrain = this.deps.brainFactory.create({ model });
		const retry = resolveRetryPolicy(effective.retry, options?.retry);
		const brain = retry === false ? rawBrain : withRetry(rawBrain, retry);

		return new WorkerRun({
			role: effective.id,
			brain,
			request: { system, messages, tools },
			parentSignal: options?.signal,
		});
	}

	private resolveAllowlist(effective: EffectiveRole): ToolSchema[] {
		const resolved: ToolSchema[] = [];
		for (const name of effective.allowlist) {
			const schema = this.deps.tools.schemaFor(name);
			if (!schema) {
				throw new Error(
					`Role '${effective.id}' allowlist references unknown tool: ${name}`,
				);
			}
			resolved.push(schema);
		}
		return resolved;
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
	readonly tools: Pick<ToolDispatcher, 'schemaFor'>;
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

function resolveRetryPolicy(
	roleRetry: RetryPolicy | false | undefined,
	spawnRetry: RetryPolicy | false | undefined,
): RetryPolicy | false {
	if (spawnRetry !== undefined) {
		return spawnRetry;
	}
	if (roleRetry !== undefined) {
		return roleRetry;
	}
	return DEFAULT_RETRY_POLICY;
}

interface WorkerRunInit {
	readonly role: string;
	readonly brain: CentralBrain;
	readonly request: Omit<BrainRequest, 'signal'>;
	readonly parentSignal?: AbortSignal;
}

/**
 * In-process worker execution. Constructed by `WorkerDispatcher.spawn`;
 * starts the brain turn on the next microtask so parallel `spawn` calls
 * are not serialised. Implements `WorkerHandle` so callers can stream
 * events, await the aggregated terminal result, or both against the
 * same handle.
 */
class WorkerRun implements WorkerHandle {
	readonly role: string;
	readonly result: Promise<WorkerResult>;

	private readonly controller = new AbortController();
	private readonly buffered: BrainStreamEvent[] = [];
	private readonly waiters: Array<(ev: IteratorResult<BrainStreamEvent>) => void> = [];
	private finished = false;
	private parentSignal?: AbortSignal;
	private parentAbortListener?: () => void;

	constructor(init: WorkerRunInit) {
		this.role = init.role;
		if (init.parentSignal) {
			if (init.parentSignal.aborted) {
				this.controller.abort();
			} else {
				const listener = () => this.controller.abort();
				init.parentSignal.addEventListener('abort', listener, { once: true });
				this.parentSignal = init.parentSignal;
				this.parentAbortListener = listener;
			}
		}
		this.result = this.run(init.brain, init.request);
	}

	cancel(): void {
		this.controller.abort();
	}

	[Symbol.asyncIterator](): AsyncIterator<BrainStreamEvent> {
		return {
			next: (): Promise<IteratorResult<BrainStreamEvent>> => {
				if (this.buffered.length > 0) {
					return Promise.resolve({ value: this.buffered.shift()!, done: false });
				}
				if (this.finished) {
					return Promise.resolve({ value: undefined, done: true });
				}
				return new Promise(resolve => this.waiters.push(resolve));
			},
		};
	}

	private async run(
		brain: CentralBrain,
		request: Omit<BrainRequest, 'signal'>,
	): Promise<WorkerResult> {
		let text = '';
		const toolCalls: BrainToolUseContent[] = [];
		let stopReason: string | undefined;
		let error: BrainError | undefined;

		try {
			for await (const ev of brain.send({ ...request, signal: this.controller.signal })) {
				this.emit(ev);
				switch (ev.kind) {
					case 'text':
						text += ev.text;
						break;
					case 'tool_use':
						toolCalls.push({ type: 'tool_use', ...ev.call });
						break;
					case 'done':
						stopReason = ev.stopReason;
						break;
					case 'error':
						error = ev.error;
						break;
				}
			}
		} finally {
			this.finish();
		}

		return { text, toolCalls, stopReason, error };
	}

	private emit(ev: BrainStreamEvent): void {
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter({ value: ev, done: false });
		} else {
			this.buffered.push(ev);
		}
	}

	private finish(): void {
		this.finished = true;
		if (this.parentSignal && this.parentAbortListener) {
			this.parentSignal.removeEventListener('abort', this.parentAbortListener);
			this.parentSignal = undefined;
			this.parentAbortListener = undefined;
		}
		while (this.waiters.length > 0) {
			const waiter = this.waiters.shift()!;
			waiter({ value: undefined, done: true });
		}
	}
}
