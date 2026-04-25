/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BudgetApprovalRequestParams } from '../../protocol.js';
import { Persistence } from '../persistence.js';
import { DefaultEstimator } from './estimator.js';
import { BudgetMeter, type BudgetMeterDeps } from './meter.js';
import {
	BudgetHardCapExceeded,
	BudgetPerCallExceeded,
	BudgetPreflightDeclined,
	BudgetSoftCapDeclined,
	type BudgetConfig,
} from './types.js';

const SESSION_ID = 's_test';

// Real category names used throughout: the estimator looks them up against
// the production pricing table. Caps below are test-only — tight values that
// let soft/hard-cap paths fire on small reservations.
const CONFIG: BudgetConfig = {
	version: 1,
	categories: {
		subagent_opus: {
			unit: 'usd',
			per_call_cap: 5.0,
			daily_soft_cap: 30.0,
			daily_hard_cap: 60.0,
			weekly_soft_cap: 180.0,
			weekly_hard_cap: 360.0,
		},
		// Tight USD caps for the soft/hard-cap paths.
		browser_loop: {
			unit: 'usd',
			per_call_cap: 0.50,
			daily_soft_cap: 0.50,
			daily_hard_cap: 1.00,
			weekly_soft_cap: 1.00,
			weekly_hard_cap: 2.00,
		},
		// Same shape as browser_loop but with a preflight prompt cap, so
		// soft-cap and preflight paths exercise independently.
		document_gen: {
			unit: 'usd',
			per_call_cap: 3.00,
			preflight_prompt_cap: 1.00,
			daily_soft_cap: 50.00,
			daily_hard_cap: 100.00,
			weekly_soft_cap: 200.00,
			weekly_hard_cap: 400.00,
		},
		// gpu_seconds category, isolated from USD rollups.
		local_inference: {
			unit: 'gpu_seconds',
			per_call_cap: 300,
			daily_soft_cap: 600,
			daily_hard_cap: 1200,
			weekly_soft_cap: 3600,
			weekly_hard_cap: 7200,
		},
	},
};

interface Harness {
	persistence: Persistence;
	meter: BudgetMeter;
	approvals: BudgetApprovalRequestParams[];
	ledgerChanges: () => number;
	now: () => number;
	setNow: (ts: number) => void;
}

function build(initialNow = Date.parse('2026-04-24T12:00:00Z')): Harness {
	let nowMs = initialNow;
	const approvals: BudgetApprovalRequestParams[] = [];
	const persistence = new Persistence(':memory:');
	persistence.upsertSession(SESSION_ID, nowMs);
	let counter = 0;
	let ledgerChanges = 0;
	const deps: BudgetMeterDeps = {
		requestApproval: params => approvals.push(params),
		newApprovalId: () => `budget-${++counter}`,
		now: () => nowMs,
		onLedgerChanged: () => { ledgerChanges++; },
	};
	const meter = new BudgetMeter(CONFIG, new DefaultEstimator(), persistence, deps);
	return {
		persistence,
		meter,
		approvals,
		ledgerChanges: () => ledgerChanges,
		now: () => nowMs,
		setNow: ts => {
			nowMs = ts;
		},
	};
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error('waitFor timed out');
		}
		await new Promise(resolve => setTimeout(resolve, 5));
	}
}

describe('BudgetMeter', () => {
	let h: Harness;
	beforeEach(() => {
		h = build();
	});
	afterEach(() => {
		h.persistence.close();
	});

	describe('per-call cap', () => {
		it('rejects an estimate above per_call_cap', async () => {
			// Opus at 10M input = $150; per_call_cap = $5 → hard block.
			await expect(
				h.meter.reserve(
					'subagent_opus',
					{ model: 'claude-opus-4-7', inputTokens: 10_000_000, maxOutputTokens: 0 },
					{ sessionId: SESSION_ID },
				),
			).rejects.toBeInstanceOf(BudgetPerCallExceeded);
		});

		it('allows an estimate at or under per_call_cap', async () => {
			// 300k in + 20k out Opus = $15*0.3 + $75*0.02 = $4.50 + $1.50 = $6.00 — over.
			// Smaller: 200k in + 10k out = $3.00 + $0.75 = $3.75 — under $5.
			const { reservation, estimate } = await h.meter.reserve(
				'subagent_opus',
				{ model: 'claude-opus-4-7', inputTokens: 200_000, maxOutputTokens: 10_000 },
				{ sessionId: SESSION_ID },
			);
			expect(estimate.value).toBeCloseTo(3.75, 6);
			expect(reservation.category).toBe('subagent_opus');
		});
	});

	describe('daily hard cap', () => {
		it('blocks a reservation that would cross the daily hard cap', async () => {
			// browser_loop caps: per_call=0.5, daily_hard=1.0. Seed 0.6 committed,
			// then reserve ~0.5 → projected 1.1 > 1.0 → BudgetHardCapExceeded.
			seedCommitted(h.persistence, {
				category: 'browser_loop',
				unit: 'usd',
				actual: 0.6,
				ts: h.now(),
				sessionId: SESSION_ID,
			});
			await expect(
				h.meter.reserve(
					// Opus model × 33_333 input = $0.5 — matches per_call_cap without
					// exceeding it, so we hit the daily hard cap first.
					'browser_loop',
					{ model: 'claude-opus-4-7', inputTokens: 33_333, maxOutputTokens: 0 },
					{ sessionId: SESSION_ID },
				),
			).rejects.toBeInstanceOf(BudgetHardCapExceeded);
		});
	});

	describe('preflight approval flow', () => {
		it('prompts with reason=preflight when a single estimate exceeds preflight_prompt_cap', async () => {
			// document_gen preflight_prompt_cap=$1.00. Opus × 100_000 in + 1_000 out
			// = $1.50 + $0.075 = $1.575 — well above $1.00, well below per_call $3.00.
			const pending = h.meter.reserve(
				'document_gen',
				{ model: 'claude-opus-4-7', inputTokens: 100_000, maxOutputTokens: 1_000 },
				{ sessionId: SESSION_ID },
			);
			await waitFor(() => h.approvals.length === 1);
			expect(h.approvals[0].reason).toBe('preflight');
			expect(h.approvals[0].category).toBe('document_gen');
			expect(h.approvals[0].preflightCap).toBeCloseTo(1.00, 6);
			expect(h.approvals[0].window).toBeUndefined();
			expect(h.approvals[0].softCap).toBeUndefined();
			h.meter.handleApprovalReply({ correlationId: h.approvals[0].correlationId, decision: 'approve' });
			const result = await pending;
			expect(result.reservation.category).toBe('document_gen');
			expect(h.meter.isPreflightApprovedForSession('document_gen')).toBe(false);
		});

		it('caches preflight approval per-category on approve-for-session', async () => {
			const first = h.meter.reserve(
				'document_gen',
				{ model: 'claude-opus-4-7', inputTokens: 100_000, maxOutputTokens: 1_000 },
				{ sessionId: SESSION_ID },
			);
			await waitFor(() => h.approvals.length === 1);
			h.meter.handleApprovalReply({
				correlationId: h.approvals[0].correlationId,
				decision: 'approve-for-session',
			});
			const firstResult = await first;
			expect(h.meter.isPreflightApprovedForSession('document_gen')).toBe(true);

			// Second preflight-triggering call must NOT prompt again. Roll back the
			// first so this test stays focused on preflight rather than soft-cap.
			h.meter.rollback(firstResult.reservation);
			const second = await h.meter.reserve(
				'document_gen',
				{ model: 'claude-opus-4-7', inputTokens: 100_000, maxOutputTokens: 1_000 },
				{ sessionId: SESSION_ID },
			);
			expect(h.approvals).toHaveLength(1);
			expect(second.reservation.category).toBe('document_gen');
		});

		it('throws BudgetPreflightDeclined when the user declines', async () => {
			const pending = h.meter.reserve(
				'document_gen',
				{ model: 'claude-opus-4-7', inputTokens: 100_000, maxOutputTokens: 1_000 },
				{ sessionId: SESSION_ID },
			);
			await waitFor(() => h.approvals.length === 1);
			h.meter.handleApprovalReply({ correlationId: h.approvals[0].correlationId, decision: 'decline' });
			await expect(pending).rejects.toBeInstanceOf(BudgetPreflightDeclined);
		});

		it('does not prompt when the estimate is at or below preflight_prompt_cap', async () => {
			// Opus × 60_000 in + 1_000 out = $0.90 + $0.075 = $0.975 — under $1.00 cap.
			const result = await h.meter.reserve(
				'document_gen',
				{ model: 'claude-opus-4-7', inputTokens: 60_000, maxOutputTokens: 1_000 },
				{ sessionId: SESSION_ID },
			);
			expect(h.approvals).toHaveLength(0);
			expect(result.reservation.category).toBe('document_gen');
		});
	});

	describe('soft-cap approval flow', () => {
		it('prompts for approval when crossing the daily soft cap and proceeds on approve', async () => {
			seedCommitted(h.persistence, {
				category: 'browser_loop',
				unit: 'usd',
				actual: 0.4,
				ts: h.now(),
				sessionId: SESSION_ID,
			});
			// Next reservation of 0.3 → projected 0.7; soft_cap 0.5, hard_cap 1.0.
			const pending = h.meter.reserve(
				'browser_loop',
				{ model: 'claude-opus-4-7', inputTokens: 20_000, maxOutputTokens: 0 },
				{ sessionId: SESSION_ID },
			);
			await waitFor(() => h.approvals.length === 1);
			expect(h.approvals[0].category).toBe('browser_loop');
			expect(h.approvals[0].window).toBe('daily');
			expect(h.approvals[0].softCap).toBe(0.5);
			expect(h.approvals[0].hardCap).toBe(1.0);
			expect(h.approvals[0].currentSpend).toBeCloseTo(0.4, 6);
			expect(h.approvals[0].estimate).toBeCloseTo(0.3, 6);
			h.meter.handleApprovalReply({ correlationId: h.approvals[0].correlationId, decision: 'approve' });
			const result = await pending;
			expect(result.reservation.category).toBe('browser_loop');
			expect(h.meter.isSoftApprovedForSession('browser_loop', 'daily')).toBe(false);
		});

		it('caches approval for the session on approve-for-session', async () => {
			seedCommitted(h.persistence, {
				category: 'browser_loop',
				unit: 'usd',
				actual: 0.4,
				ts: h.now(),
				sessionId: SESSION_ID,
			});
			const first = h.meter.reserve(
				'browser_loop',
				{ model: 'claude-opus-4-7', inputTokens: 20_000, maxOutputTokens: 0 },
				{ sessionId: SESSION_ID },
			);
			await waitFor(() => h.approvals.length === 1);
			h.meter.handleApprovalReply({
				correlationId: h.approvals[0].correlationId,
				decision: 'approve-for-session',
			});
			await first;
			expect(h.meter.isSoftApprovedForSession('browser_loop', 'daily')).toBe(true);

			// Second reservation in the same category/window must NOT prompt.
			const second = await h.meter.reserve(
				'browser_loop',
				{ model: 'claude-opus-4-7', inputTokens: 5_000, maxOutputTokens: 0 },
				{ sessionId: SESSION_ID },
			);
			expect(h.approvals).toHaveLength(1);
			expect(second.reservation.category).toBe('browser_loop');
		});

		it('throws BudgetSoftCapDeclined on decline', async () => {
			seedCommitted(h.persistence, {
				category: 'browser_loop',
				unit: 'usd',
				actual: 0.4,
				ts: h.now(),
				sessionId: SESSION_ID,
			});
			const pending = h.meter.reserve(
				'browser_loop',
				{ model: 'claude-opus-4-7', inputTokens: 20_000, maxOutputTokens: 0 },
				{ sessionId: SESSION_ID },
			);
			await waitFor(() => h.approvals.length === 1);
			h.meter.handleApprovalReply({ correlationId: h.approvals[0].correlationId, decision: 'decline' });
			await expect(pending).rejects.toBeInstanceOf(BudgetSoftCapDeclined);
		});

		it('hard cap still blocks regardless of prior approve-for-session', async () => {
			// Seed 0.4 committed. Approve-for-session on a 0.3 soft-cross reservation;
			// commit it → rollup 0.7. Then a 0.5 reservation projects to 1.2 > hard 1.0.
			seedCommitted(h.persistence, {
				category: 'browser_loop',
				unit: 'usd',
				actual: 0.4,
				ts: h.now(),
				sessionId: SESSION_ID,
			});
			const first = h.meter.reserve(
				'browser_loop',
				{ model: 'claude-opus-4-7', inputTokens: 20_000, maxOutputTokens: 0 },
				{ sessionId: SESSION_ID },
			);
			await waitFor(() => h.approvals.length === 1);
			h.meter.handleApprovalReply({
				correlationId: h.approvals[0].correlationId,
				decision: 'approve-for-session',
			});
			const firstResult = await first;
			h.meter.commit(firstResult.reservation, 0.3);
			expect(h.meter.rollupDaily('browser_loop')).toBeCloseTo(0.7, 6);

			await expect(
				h.meter.reserve(
					'browser_loop',
					// 33_333 input @ $15/MTok = $0.50 exactly — at per_call_cap, below it,
					// but projected 0.7 + 0.5 = 1.2 > hard 1.0.
					{ model: 'claude-opus-4-7', inputTokens: 33_333, maxOutputTokens: 0 },
					{ sessionId: SESSION_ID },
				),
			).rejects.toBeInstanceOf(BudgetHardCapExceeded);
		});
	});

	describe('commit / rollback', () => {
		it('commit writes actual spend and moves row out of reserved', async () => {
			const { reservation } = await h.meter.reserve(
				'subagent_opus',
				{ model: 'claude-opus-4-7', inputTokens: 100_000, maxOutputTokens: 1_000 },
				{ sessionId: SESSION_ID },
			);
			h.meter.commit(reservation, 1.80);
			const row = h.persistence._rawForTests()
				.prepare('SELECT status, actual FROM budget_ledger WHERE id = ?')
				.get(reservation.id) as { status: string; actual: number };
			expect(row.status).toBe('committed');
			expect(row.actual).toBeCloseTo(1.80, 6);
			expect(h.meter.rollupDaily('subagent_opus')).toBeCloseTo(1.80, 6);
		});

		it('rollback releases the reservation with no committed spend', async () => {
			const { reservation } = await h.meter.reserve(
				'subagent_opus',
				{ model: 'claude-opus-4-7', inputTokens: 100_000, maxOutputTokens: 1_000 },
				{ sessionId: SESSION_ID },
			);
			expect(h.meter.rollupDaily('subagent_opus')).toBeGreaterThan(0);
			h.meter.rollback(reservation);
			expect(h.meter.rollupDaily('subagent_opus')).toBe(0);
		});
	});

	describe('orphan sweep', () => {
		it('marks leftover reserved rows rolled_back on call', async () => {
			await h.meter.reserve(
				'subagent_opus',
				{ model: 'claude-opus-4-7', inputTokens: 100_000, maxOutputTokens: 1_000 },
				{ sessionId: SESSION_ID },
			);
			// The reservation is live — sweep should flip it.
			const swept = h.meter.sweepOrphans();
			expect(swept).toBe(1);
			expect(h.meter.rollupDaily('subagent_opus')).toBe(0);
			expect(h.persistence.listOrphanReservations()).toHaveLength(0);
		});
	});

	describe('snapshot', () => {
		it('returns one row per configured category with caps and current rollups', async () => {
			seedCommitted(h.persistence, {
				category: 'subagent_opus',
				unit: 'usd',
				actual: 2.5,
				ts: h.now(),
				sessionId: SESSION_ID,
			});
			const snap = h.meter.snapshot();
			expect(snap.categories.map(c => c.category).sort()).toEqual([
				'browser_loop',
				'document_gen',
				'local_inference',
				'subagent_opus',
			]);
			const opus = snap.categories.find(c => c.category === 'subagent_opus')!;
			expect(opus.unit).toBe('usd');
			expect(opus.dailySpend).toBeCloseTo(2.5, 6);
			expect(opus.dailySoftCap).toBe(30.0);
			expect(opus.dailyHardCap).toBe(60.0);
			expect(opus.weeklySoftCap).toBe(180.0);
			expect(opus.weeklyHardCap).toBe(360.0);
			expect(opus.perCallCap).toBe(5.0);
			expect(opus.preflightCap).toBeUndefined();

			const docs = snap.categories.find(c => c.category === 'document_gen')!;
			expect(docs.preflightCap).toBeCloseTo(1.0, 6);
		});
	});

	describe('onLedgerChanged notifications', () => {
		it('fires on reserve, commit, and rollback', async () => {
			const before = h.ledgerChanges();
			const { reservation } = await h.meter.reserve(
				'subagent_opus',
				{ model: 'claude-opus-4-7', inputTokens: 100_000, maxOutputTokens: 1_000 },
				{ sessionId: SESSION_ID },
			);
			h.meter.commit(reservation, 1.5);

			const { reservation: rolled } = await h.meter.reserve(
				'subagent_opus',
				{ model: 'claude-opus-4-7', inputTokens: 50_000, maxOutputTokens: 0 },
				{ sessionId: SESSION_ID },
			);
			h.meter.rollback(rolled);

			expect(h.ledgerChanges() - before).toBe(4);
		});
	});

	describe('two-unit isolation', () => {
		it('gpu_seconds rollups do not mix with usd rollups', async () => {
			const { reservation: local } = await h.meter.reserve(
				'local_inference',
				{ model: 'llama-3.3-70b', maxOutputTokens: 1_000 }, // 1000 * 0.1 = 100 gpu_s
				{ sessionId: SESSION_ID },
			);
			h.meter.commit(local, 100);
			const { reservation: opus } = await h.meter.reserve(
				'subagent_opus',
				{ model: 'claude-opus-4-7', inputTokens: 100_000, maxOutputTokens: 0 },
				{ sessionId: SESSION_ID },
			);
			h.meter.commit(opus, 1.5);
			expect(h.meter.rollupDaily('local_inference')).toBe(100);
			expect(h.meter.rollupDaily('subagent_opus')).toBeCloseTo(1.5, 6);
		});
	});
});

function seedCommitted(
	persistence: Persistence,
	row: { category: string; unit: 'usd' | 'gpu_seconds'; actual: number; ts: number; sessionId: string },
): void {
	persistence._rawForTests().prepare(
		`INSERT INTO budget_ledger (ts, session_id, category, unit, estimated, actual, status) VALUES (?, ?, ?, ?, ?, ?, 'committed')`,
	).run(row.ts, row.sessionId, row.category, row.unit, row.actual, row.actual);
}
