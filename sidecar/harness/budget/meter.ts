/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type {
	ApprovalDecision,
	BudgetApprovalReplyParams,
	BudgetApprovalRequestParams,
	BudgetUnit,
	BudgetWindow,
} from '../../protocol';
import type { Persistence } from '../persistence';
import type { Estimator } from './estimator';
import {
	BudgetHardCapExceeded,
	BudgetPerCallExceeded,
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
	}

	/** Release `reservation` without committing spend. */
	rollback(reservation: Reservation): void {
		this.persistence.rollbackReservation(reservation.id);
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
		const correlationId = this.deps.newApprovalId();
		const decision = await new Promise<ApprovalDecision>(resolve => {
			this.pendingApprovals.set(correlationId, { resolve });
			const params: BudgetApprovalRequestParams = {
				correlationId,
				category,
				window,
				unit: caps.unit as BudgetUnit,
				currentSpend,
				estimate: estimate.value,
				softCap: window === 'daily' ? caps.daily_soft_cap : caps.weekly_soft_cap,
				hardCap: window === 'daily' ? caps.daily_hard_cap : caps.weekly_hard_cap,
			};
			this.deps.requestApproval(params);
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
}

export interface BudgetMeterDeps {
	/** Emit a `budget.approval.request` notification to the webview. */
	readonly requestApproval: (params: BudgetApprovalRequestParams) => void;
	/** Mint a unique correlation id for a new approval prompt. */
	readonly newApprovalId: () => string;
	/** Wall-clock source, injected for deterministic tests. */
	readonly now: () => number;
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
