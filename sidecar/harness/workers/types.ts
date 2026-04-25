/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { BrainMessage, BrainStreamEvent, BrainToolUseContent, CentralBrain } from '../brain/types';
import type { RetryPolicy } from '../brain/retry';

/**
 * A role is a registered unit of worker behavior. Role modules live under
 * `sidecar/harness/workers/roles/` and self-register with a
 * `WorkerDispatcher` at startup; the dispatcher contains no role-specific
 * knowledge.
 *
 * The fields on a `RoleDefinition` are *defaults*. User overrides from
 * `sidecar/config/workers.yaml` may replace any of them at startup, and a
 * per-spawn `SpawnOptions` may replace the retry policy on a single call.
 * The dispatcher resolves the *effective role* by layering:
 *
 *   registered defaults ← workers.yaml overrides ← SpawnOptions
 */
export interface RoleDefinition {
	/**
	 * Stable role id. Used in `spawn(role, ...)` calls and as the key in
	 * `workers.yaml`. Must be unique across registered roles.
	 */
	readonly id: string;
	/**
	 * Default model identifier passed to the `CentralBrainFactory`.
	 * Built-in roles default to `'opus'`; YAML overrides allow a
	 * per-role downshift without code changes.
	 */
	readonly defaultModel: string;
	/**
	 * Default tool-name allowlist. Each name must resolve to a tool
	 * registered on the parent `ToolDispatcher`; unresolved names fail
	 * fast at spawn time rather than masquerading as permission denials.
	 */
	readonly defaultAllowlist: readonly string[];
	/**
	 * Render the worker's system prompt from the task the parent
	 * brain supplied. Templates live with the role so they can be tuned
	 * without touching the dispatcher.
	 */
	readonly systemPromptTemplate: (task: string) => string;
	/**
	 * Role-level retry override. When present, replaces the dispatcher's
	 * default retry policy for every spawn of this role. `false` disables
	 * retry wrapping entirely; a policy object replaces the defaults.
	 * A per-spawn `SpawnOptions.retry` still takes precedence over this.
	 */
	readonly retry?: RetryPolicy | false;
}

/**
 * Per-spawn overrides. Keeps `spawn(role, task, context)` narrow while
 * allowing the caller to disable retry, swap a retry policy, or thread
 * in a parent-provided cancellation signal.
 */
export interface SpawnOptions {
	/**
	 * `false` disables retry for this spawn. A `RetryPolicy` replaces
	 * whatever the role/dispatcher would otherwise use. Omitted =
	 * use the effective-role retry policy.
	 */
	readonly retry?: RetryPolicy | false;
	/**
	 * Parent-provided cancellation signal. Accepted on the surface
	 * today so callers can pass it through; propagation into the
	 * worker loop is not yet wired.
	 */
	readonly signal?: AbortSignal;
	/**
	 * Per-spawn model override. Rarely needed — prefer YAML overrides
	 * for persistent changes — but useful for one-off experiments and
	 * tests. Replaces the effective role's model for this call.
	 */
	readonly model?: string;
	/**
	 * Override the session id the brain factory receives for this spawn.
	 * Defaults to `WorkerDispatcherDeps.sessionId`. Lets a parent thread
	 * its own session id into a worker — useful only when test fixtures
	 * need deterministic ledger attribution.
	 */
	readonly sessionId?: string;
}

/**
 * Handle returned by `dispatcher.spawn(...)`. Supports two consumption
 * shapes:
 *
 * - **Streaming.** `for await (const ev of handle) { ... }` yields the
 *   worker's `BrainStreamEvent`s in order, terminating on either
 *   `done` or `error` exactly once.
 * - **Awaiting.** `await handle.result` resolves to the aggregated
 *   `WorkerResult` after the stream terminates. The same handle may be
 *   both iterated and awaited; whichever finishes first populates the
 *   other.
 *
 * Cancellation: `handle.cancel()` aborts the worker's internal signal.
 * Aborting a parent-provided `SpawnOptions.signal` will do the same
 * once the worker loop wires propagation through.
 */
export interface WorkerHandle extends AsyncIterable<BrainStreamEvent> {
	readonly role: string;
	readonly result: Promise<WorkerResult>;
	cancel(): void;
}

/**
 * The terminal outcome of a worker turn. Aggregates what streamed
 * through the handle into a single object the parent brain can act on
 * without replaying the stream.
 *
 * `text` concatenates every `text` event's contents in order.
 * `toolCalls` preserves the ordered tool_use events the worker emitted
 * (as `BrainToolUseContent` blocks so they round-trip directly into a
 * parent transcript if needed). `stopReason` carries the adapter's
 * opaque terminal tag when the stream ended on `done`; `error` is set
 * when the stream ended on `error`.
 *
 * Cost rollups (token counts, USD, category-labeled spend) will be
 * added additively once the budget meter lands.
 */
export interface WorkerResult {
	readonly text: string;
	readonly toolCalls: readonly BrainToolUseContent[];
	readonly stopReason?: string;
	readonly error?: import('../brain/types').BrainError;
}

/**
 * The dispatcher's brain-agnostic construction seam. A Claude-backed
 * factory returns a `ClaudeAdapter` per `create(...)`; a Llama-backed
 * factory returns a Llama adapter per call; a mixed factory can route
 * by model.
 *
 * Every worker spawn constructs a fresh `CentralBrain` via this
 * factory — the dispatcher itself never imports an adapter module.
 */
export interface CentralBrainFactory {
	create(params: CentralBrainFactoryParams): CentralBrain;
}

export interface CentralBrainFactoryParams {
	/** Effective model for this worker, post-override resolution. */
	readonly model: string;
	/**
	 * Budget category resolved from the effective model
	 * (`subagent_opus`, `subagent_sonnet`, `gemini`, …). The factory
	 * forwards this into the constructed adapter so its meter
	 * reservations land in the correct ledger bucket. Brain-agnostic by
	 * construction — the dispatcher computes the category and the factory
	 * only has to pass it through.
	 */
	readonly budgetCategory: string;
	/** Session id the meter reservations and OTEL spans tag onto. */
	readonly sessionId: string;
}

/**
 * User-override shape from `sidecar/config/workers.yaml`. Mirrors the
 * subset of `RoleDefinition` that users may override. Fields are
 * optional; anything omitted falls back to the registered default.
 */
export interface WorkersYamlOverrides {
	readonly roles?: {
		readonly [roleId: string]: RoleOverride | undefined;
	};
}

export interface RoleOverride {
	readonly model?: string;
	readonly allowlist?: readonly string[];
}

/**
 * The "effective" role — registered defaults + YAML overrides, resolved
 * once at startup. Per-spawn options layer on top of this at `spawn()`
 * time, not here. The dispatcher caches this per role id.
 */
export interface EffectiveRole {
	readonly id: string;
	readonly model: string;
	readonly allowlist: readonly string[];
	readonly systemPromptTemplate: (task: string) => string;
	readonly retry?: RetryPolicy | false;
}

/**
 * The user message shape the dispatcher assembles for a worker's first
 * turn: the role's system prompt renders the task, and the parent's
 * `context` messages precede it in the transcript. Re-exported here so
 * test fixtures can construct transcripts without reaching into the
 * brain module.
 */
export type WorkerContext = readonly BrainMessage[];
