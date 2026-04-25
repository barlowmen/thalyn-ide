/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type {
	ApprovalDecision,
	BudgetApprovalReplyParams,
	BudgetApprovalRequestParams,
	BudgetCategorySnapshot,
	BudgetSnapshotResult,
	BudgetUnit,
	BudgetWindow,
} from '../../protocol';
import type { Persistence } from '../persistence';
import type { Estimator } from './estimator';
import {
	BudgetHardCapExceeded,
	BudgetPerCallExceeded,
	BudgetPreflightDeclined,
	BudgetSoftCapDeclined,
	BudgetUnitMismatch,
	BudgetUnknownCategory,
	type BudgetConfig,
	type CallDescriptor,
	type CategoryCaps,
	type Estimate,
	type Reservation,
} from './types';

/**
 * The gate every cost-bearing operation passes through. Call sites use
 * the reserve → commit / rollback protocol:
 *
 * ```ts
 * const { reservation, estimate } = await meter.reserve(category, call, ctx);
 * try {
 *   const result = await operation();
 *   await meter.commit(reservation, actual);
 * } catch (err) {
 *   await meter.rollback(reservation);
 *   throw err;
 * }
 * ```
 *
 * `reserve()` validates the per-call cap, checks the daily and weekly
 * hard caps, and — if either soft cap would be crossed — routes a
 * `budget.approval.request` to the webview and waits for the reply.
 * It throws {@link BudgetPerCallExceeded}, {@link BudgetHardCapExceeded},
 * or {@link BudgetSoftCapDeclined} on policy rejection; otherwise the
 * returned {@link Reservation} is durable in the `budget_ledger` table
 * until `commit()` or `rollback()` flips it.
 */
export class BudgetMeter {
	private readonly pendingApprovals = new Map<string, PendingApproval>();
	private readonly softApprovedForSession = new Set<string>(); // `${category}:${window}`
	private readonly preflightApprovedForSession = new Set<string>(); // `${category}`

	constructor(
		private readonly config: BudgetConfig,
		private readonly estimator: Estimator,
		private readonly persistence: Persistence,
		private readonly deps: BudgetMeterDeps,
	) { }

	/**
	 * Sweep any `reserved` rows left over from a previous crash,
	 * marking them `rolled_back`. Safe to call every time the harness
	 * opens the DB; idempotent. Returns the sweep count so the harness
	 * can log a warning when it's non-zero.
	 */
	sweepOrphans(): number {
		return this.persistence.sweepOrphans();
	}

	/**
	 * Validate caps, prompt on soft-cap cross, and insert a reservation.
	 * Throws on any cap rejection.
	 */
	async reserve(
		category: string,
		call: CallDescriptor,
		ctx: ReserveContext,
	): Promise<ReserveResult> {
		const caps = this.lookupCategory(category);
		const estimate = this.estimator.estimate(category, call);
		if (estimate.unit !== caps.unit) {
			throw new BudgetUnitMismatch(category, caps.unit, estimate.unit);
		}

		if (estimate.value > caps.per_call_cap) {
			throw new BudgetPerCallExceeded(category, estimate.value, caps.per_call_cap, caps.unit);
		}

		const now = ctx.now ?? this.deps.now();
		const dailyStart = startOfLocalDay(now);
		const weeklyStart = now - WEEK_MS;

		const dailyCurrent = this.persistence.rollup(category, dailyStart, Number.MAX_SAFE_INTEGER);
		const weeklyCurrent = this.persistence.rollup(category, weeklyStart, Number.MAX_SAFE_INTEGER);
		const dailyProjected = dailyCurrent + estimate.value;
		const weeklyProjected = weeklyCurrent + estimate.value;

		// Hard caps first — they override any prior soft approval.
		if (dailyProjected > caps.daily_hard_cap) {
			throw new BudgetHardCapExceeded(category, 'daily', dailyProjected, caps.daily_hard_cap, caps.unit);
		}
		if (weeklyProjected > caps.weekly_hard_cap) {
			throw new BudgetHardCapExceeded(category, 'weekly', weeklyProjected, caps.weekly_hard_cap, caps.unit);
		}

		// Preflight runs before soft-cap so a single expensive call asks
		// even on a fresh window. Once approved-for-session it stops
		// prompting until the soft cap eventually fires.
		if (caps.preflight_prompt_cap !== undefined && estimate.value > caps.preflight_prompt_cap) {
			await this.requirePreflightApproval(category, estimate, caps);
		}

		if (dailyProjected > caps.daily_soft_cap) {
			await this.requireSoftApproval(category, 'daily', dailyCurrent, estimate, caps);
		}
		if (weeklyProjected > caps.weekly_soft_cap) {
			await this.requireSoftApproval(category, 'weekly', weeklyCurrent, estimate, caps);
		}

		const id = this.persistence.insertReservation({
			ts: now,
			sessionId: ctx.sessionId,
			category,
			unit: caps.unit,
			estimated: estimate.value,
			traceId: ctx.traceId,
			spanId: ctx.spanId,
			metadata: call.model === undefined ? undefined : { model: call.model },
		});

		const reservation: Reservation = {
			id,
			category,
			unit: caps.unit,
			estimated: estimate.value,
			ts: now,
			sessionId: ctx.sessionId,
			traceId: ctx.traceId,
			spanId: ctx.spanId,
		};
		this.deps.onLedgerChanged?.();
		return { reservation, estimate };
	}

	/**
	 * Mark `reservation` as committed with the actual cost. `actualCost`
	 * must be in the same unit as the reservation; callers that don't
	 * have a measured cost should still call `commit()` with their best
	 * final estimate (for example, token counts from the response).
	 */
	commit(reservation: Reservation, actualCost: number, nowMs?: number): void {
		const ts = nowMs ?? this.deps.now();
		this.persistence.commitReservation(reservation.id, actualCost, ts);
		this.deps.onLedgerChanged?.();
	}

	/** Release `reservation` without committing spend. */
	rollback(reservation: Reservation): void {
		this.persistence.rollbackReservation(reservation.id);
		this.deps.onLedgerChanged?.();
	}

	/**
	 * Build a point-in-time snapshot of every configured category's daily
	 * and weekly spend alongside the caps. Drives the chat-panel budget
	 * strip and the `budget.snapshot` RPC. Pure read — never prompts,
	 * never mutates.
	 */
	snapshot(nowMs?: number): BudgetSnapshotResult {
		const now = nowMs ?? this.deps.now();
		const dailyStart = startOfLocalDay(now);
		const weeklyStart = now - WEEK_MS;
		const categories: BudgetCategorySnapshot[] = [];
		for (const [name, caps] of Object.entries(this.config.categories)) {
			categories.push({
				category: name,
				unit: caps.unit as BudgetUnit,
				dailySpend: this.persistence.rollup(name, dailyStart, Number.MAX_SAFE_INTEGER),
				weeklySpend: this.persistence.rollup(name, weeklyStart, Number.MAX_SAFE_INTEGER),
				dailySoftCap: caps.daily_soft_cap,
				dailyHardCap: caps.daily_hard_cap,
				weeklySoftCap: caps.weekly_soft_cap,
				weeklyHardCap: caps.weekly_hard_cap,
				perCallCap: caps.per_call_cap,
				...(caps.preflight_prompt_cap !== undefined ? { preflightCap: caps.preflight_prompt_cap } : {}),
			});
		}
		return { asOf: now, categories };
	}

	/** Sum of spend in category over the current local day. */
	rollupDaily(category: string, nowMs?: number): number {
		const now = nowMs ?? this.deps.now();
		return this.persistence.rollup(category, startOfLocalDay(now), Number.MAX_SAFE_INTEGER);
	}

	/** Sum of spend in category over the trailing 7 days. */
	rollupWeekly(category: string, nowMs?: number): number {
		const now = nowMs ?? this.deps.now();
		return this.persistence.rollup(category, now - WEEK_MS, Number.MAX_SAFE_INTEGER);
	}

	/** Resolve a pending soft-cap approval. Called by the RPC layer on a `budget.approval.reply`. */
	handleApprovalReply(reply: BudgetApprovalReplyParams): void {
		const pending = this.pendingApprovals.get(reply.correlationId);
		if (!pending) {
			return;
		}
		this.pendingApprovals.delete(reply.correlationId);
		pending.resolve(reply.decision);
	}

	/** Test-only hook. */
	isSoftApprovedForSession(category: string, window: BudgetWindow): boolean {
		return this.softApprovedForSession.has(sessionKey(category, window));
	}

	/** Test-only hook. */
	isPreflightApprovedForSession(category: string): boolean {
		return this.preflightApprovedForSession.has(category);
	}

	private lookupCategory(category: string): CategoryCaps {
		const caps = this.config.categories[category];
		if (!caps) {
			throw new BudgetUnknownCategory(category);
		}
		return caps;
	}

	private async requireSoftApproval(
		category: string,
		window: BudgetWindow,
		currentSpend: number,
		estimate: Estimate,
		caps: CategoryCaps,
	): Promise<void> {
		if (this.softApprovedForSession.has(sessionKey(category, window))) {
			return;
		}
		const decision = await this.requestApproval({
			category,
			reason: 'soft-cap',
			unit: caps.unit as BudgetUnit,
			estimate: estimate.value,
			currentSpend,
			window,
			softCap: window === 'daily' ? caps.daily_soft_cap : caps.weekly_soft_cap,
			hardCap: window === 'daily' ? caps.daily_hard_cap : caps.weekly_hard_cap,
		});
		if (decision === 'approve') {
			return;
		}
		if (decision === 'approve-for-session') {
			this.softApprovedForSession.add(sessionKey(category, window));
			return;
		}
		throw new BudgetSoftCapDeclined(category, window);
	}

	private async requirePreflightApproval(
		category: string,
		estimate: Estimate,
		caps: CategoryCaps,
	): Promise<void> {
		if (this.preflightApprovedForSession.has(category)) {
			return;
		}
		const preflightCap = caps.preflight_prompt_cap!;
		const decision = await this.requestApproval({
			category,
			reason: 'preflight',
			unit: caps.unit as BudgetUnit,
			estimate: estimate.value,
			preflightCap,
		});
		if (decision === 'approve') {
			return;
		}
		if (decision === 'approve-for-session') {
			this.preflightApprovedForSession.add(category);
			return;
		}
		throw new BudgetPreflightDeclined(category, estimate.value, preflightCap, caps.unit);
	}

	private requestApproval(
		request: Omit<BudgetApprovalRequestParams, 'correlationId'>,
	): Promise<ApprovalDecision> {
		const correlationId = this.deps.newApprovalId();
		return new Promise<ApprovalDecision>(resolve => {
			this.pendingApprovals.set(correlationId, { resolve });
			this.deps.requestApproval({ correlationId, ...request });
		});
	}
}

export interface BudgetMeterDeps {
	/** Emit a `budget.approval.request` notification to the webview. */
	readonly requestApproval: (params: BudgetApprovalRequestParams) => void;
	/** Mint a unique correlation id for a new approval prompt. */
	readonly newApprovalId: () => string;
	/** Wall-clock source, injected for deterministic tests. */
	readonly now: () => number;
	/**
	 * Fired after every ledger transition (reserve/commit/rollback). Wired
	 * to the webview as a `budget.changed` notification — the webview
	 * re-fetches the snapshot rather than trying to apply a delta. Optional
	 * so unit tests don't need to stub it.
	 */
	readonly onLedgerChanged?: () => void;
}

export interface ReserveContext {
	readonly sessionId: string;
	/** Optional override for the reservation's timestamp. Default: `deps.now()`. */
	readonly now?: number;
	readonly traceId?: string;
	readonly spanId?: string;
}

export interface ReserveResult {
	readonly reservation: Reservation;
	readonly estimate: Estimate;
}

interface PendingApproval {
	resolve(decision: ApprovalDecision): void;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function startOfLocalDay(nowMs: number): number {
	const d = new Date(nowMs);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

function sessionKey(category: string, window: BudgetWindow): string {
	return `${category}:${window}`;
}
