/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Persistence, SessionRow } from '../persistence';

/**
 * Cross-session analytics over the harness's SQLite store.
 *
 * Used by the chat-panel budget strip and any future dashboard surface.
 * Kept strictly separate from the agent-recall path: the agent reads
 * memories from the SDK Memory Tool's file store, not from these
 * rollups. Mixing the two would force compaction across queries that
 * have nothing to do with what the agent should remember.
 *
 * All methods are read-only and side-effect-free.
 */
export class Analytics {
	constructor(private readonly persistence: Persistence) { }

	/**
	 * Recent sessions enriched with message + tool counts and total
	 * committed cost in USD-denominated categories. Sorted most-recent
	 * first; `limit` defaults to 50.
	 */
	listRecentSessions(limit = 50): readonly SessionAnalytics[] {
		const rows = this.persistence.listSessions(limit);
		return rows.map(row => this.summarize(row));
	}

	/** Summarize one session by id. Returns undefined if unknown. */
	summarizeSession(sessionId: string): SessionAnalytics | undefined {
		const row = this.persistence.getSession(sessionId);
		if (!row) {
			return undefined;
		}
		return this.summarize(row);
	}

	/**
	 * Tool-call frequency over the last `windowMs` milliseconds. Returns
	 * a map keyed by tool name with the call count as the value.
	 */
	toolCallFrequency(windowMs: number, nowMs: number): ReadonlyMap<string, number> {
		const since = nowMs - windowMs;
		const rows = this.persistence.toolCallFrequency(since);
		return new Map(rows.map(r => [r.tool_name, r.count] as const));
	}

	/**
	 * Cost by category in USD over `[fromTs, toTs)`. Only `committed`
	 * ledger rows count; reserved rows do not (they may yet roll back).
	 */
	costByCategory(fromTs: number, toTs: number): ReadonlyMap<string, number> {
		const rows = this.persistence.costSeriesByCategory(fromTs, toTs);
		return new Map(rows.map(r => [r.category, r.total] as const));
	}

	/**
	 * Tool success vs failure counts over the last `windowMs`. A tool
	 * call counts as failed when `result_is_error = 1`. Calls that
	 * never received a result (still in flight, or the harness crashed
	 * between invoke and result) are excluded — they are neither
	 * success nor failure yet.
	 */
	toolOutcomePattern(windowMs: number, nowMs: number): ReadonlyMap<string, ToolOutcome> {
		const since = nowMs - windowMs;
		// Walk the listed frequency rows and pull per-tool result counts
		// off the raw tool_calls table. The Persistence facade keeps
		// query construction in one place; this method composes its
		// outputs.
		const totals = this.persistence.toolCallFrequency(since);
		const out = new Map<string, ToolOutcome>();
		for (const row of totals) {
			out.set(row.tool_name, { total: row.count, succeeded: 0, failed: 0, pending: row.count });
		}
		// Fold actual outcomes from the per-session listing. Cheap because
		// the most active sessions dominate; an O(N) walk over recent
		// tool_calls beats N round-trips.
		const sessions = this.persistence.listSessions(100);
		for (const s of sessions) {
			const calls = this.persistence.listToolCallsForSession(s.id);
			for (const c of calls) {
				if (c.ts < since) {
					continue;
				}
				const o = out.get(c.tool_name);
				if (!o) {
					continue;
				}
				const writable = o as { total: number; succeeded: number; failed: number; pending: number };
				if (c.result_is_error === null) {
					continue;
				}
				if (c.result_is_error === 1) {
					writable.failed += 1;
				} else {
					writable.succeeded += 1;
				}
				writable.pending = Math.max(0, writable.pending - 1);
			}
		}
		return out;
	}

	private summarize(row: SessionRow): SessionAnalytics {
		const messages = this.persistence.listMessages(row.id);
		const toolCalls = this.persistence.listToolCallsForSession(row.id);
		return {
			sessionId: row.id,
			createdTs: row.created_ts,
			lastActiveTs: row.last_active_ts,
			parentSessionId: row.parent_session_id,
			branchId: row.branch_id,
			title: row.title,
			messageCount: messages.length,
			toolCallCount: toolCalls.length,
		};
	}
}

export interface SessionAnalytics {
	readonly sessionId: string;
	readonly createdTs: number;
	readonly lastActiveTs: number | null;
	readonly parentSessionId: string | null;
	readonly branchId: string | null;
	readonly title: string | null;
	readonly messageCount: number;
	readonly toolCallCount: number;
}

export interface ToolOutcome {
	readonly total: number;
	readonly succeeded: number;
	readonly failed: number;
	readonly pending: number;
}
