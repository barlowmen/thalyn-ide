/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import Database from 'better-sqlite3';

/**
 * The single point of SQLite access in the harness.
 *
 * Session state, conversation history, and budget meters all write
 * through this module; no other module opens its own database handle.
 * Consumers (`BudgetMeter`, `SqliteSpanExporter`, the session/history
 * loader) take a `Persistence` instance as a dep.
 *
 * The schema here is the minimum needed by the budget subsystem and the
 * OTEL→SQLite exporter: `sessions` (as the FK target for `session_id`
 * columns), `budget_ledger`, and `traces`. Additional tables
 * (conversation history, tool calls, routing decisions, budget
 * snapshots) slot in later as additional `CREATE TABLE IF NOT EXISTS`
 * statements in {@link initSchema}.
 */
export class Persistence {
	private readonly db: Database.Database;
	private readonly upsertSessionStmt: Database.Statement<[string, number]>;
	private readonly insertReservationStmt: Database.Statement<[
		number, string, string, string, number, string, string | null, string | null, string | null,
	]>;
	private readonly commitReservationStmt: Database.Statement<[number, number, number]>;
	private readonly rollbackReservationStmt: Database.Statement<[number]>;
	private readonly sweepOrphansStmt: Database.Statement<[]>;
	private readonly rollupStmt: Database.Statement<[string, number, number], { total: number }>;
	private readonly listOrphansStmt: Database.Statement<[], OrphanReservation>;
	private readonly insertTraceStmt: Database.Statement<[
		string, string, string | null, number, number, string, string, string, string,
	]>;

	/**
	 * Open (or create) the session database at `path`. Use `:memory:` for
	 * tests. Schema migrations run on every open; they are idempotent.
	 */
	constructor(path: string) {
		this.db = new Database(path);
		this.db.pragma('journal_mode = WAL');
		this.db.pragma('foreign_keys = ON');
		this.initSchema();

		this.upsertSessionStmt = this.db.prepare(
			`INSERT INTO sessions (id, created_ts) VALUES (?, ?) ON CONFLICT(id) DO NOTHING`,
		);
		this.insertReservationStmt = this.db.prepare(
			`INSERT INTO budget_ledger (ts, session_id, category, unit, estimated, status, trace_id, span_id, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		this.commitReservationStmt = this.db.prepare(
			`UPDATE budget_ledger SET status = 'committed', actual = ?, ts = ? WHERE id = ? AND status = 'reserved'`,
		);
		this.rollbackReservationStmt = this.db.prepare(
			`UPDATE budget_ledger SET status = 'rolled_back' WHERE id = ? AND status = 'reserved'`,
		);
		this.sweepOrphansStmt = this.db.prepare(
			`UPDATE budget_ledger SET status = 'rolled_back' WHERE status = 'reserved'`,
		);
		this.listOrphansStmt = this.db.prepare(
			`SELECT id, session_id, category FROM budget_ledger WHERE status = 'reserved'`,
		);
		// Committed rows use `actual`; rolled-back rows don't count toward spend.
		// Reserved rows (in-flight) count at their estimate so an over-reservation
		// can't be evaded by starting a second call before the first commits.
		this.rollupStmt = this.db.prepare(
			`SELECT COALESCE(SUM(CASE WHEN status = 'committed' THEN actual WHEN status = 'reserved' THEN estimated ELSE 0 END), 0) AS total FROM budget_ledger WHERE category = ? AND ts >= ? AND ts < ?`,
		);
		this.insertTraceStmt = this.db.prepare(
			`INSERT INTO traces (trace_id, span_id, parent_span_id, ts_start, ts_end, name, session_id, attributes_json, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
	}

	/** Close the underlying SQLite handle. */
	close(): void {
		this.db.close();
	}

	/**
	 * Ensure a session row exists. Idempotent — safe to call on every
	 * harness startup for the active session id.
	 */
	upsertSession(sessionId: string, createdTs: number): void {
		this.upsertSessionStmt.run(sessionId, createdTs);
	}

	/**
	 * Record a fresh reservation and return its auto-increment id. The row
	 * lands with `status='reserved'`; commit/rollback flip it.
	 */
	insertReservation(row: ReservationRow): number {
		const metadata = row.metadata === undefined ? null : JSON.stringify(row.metadata);
		const info = this.insertReservationStmt.run(
			row.ts,
			row.sessionId,
			row.category,
			row.unit,
			row.estimated,
			'reserved',
			row.traceId ?? null,
			row.spanId ?? null,
			metadata,
		);
		return Number(info.lastInsertRowid);
	}

	/**
	 * Flip a reserved row to `committed` with `actual` spend and update
	 * `ts` to the commit time (the UI strip reads rollups by commit time
	 * so pending reservations don't flash in and out of yesterday).
	 */
	commitReservation(id: number, actual: number, committedTs: number): void {
		const info = this.commitReservationStmt.run(actual, committedTs, id);
		if (info.changes === 0) {
			throw new Error(`BudgetLedger: reservation ${id} was not in 'reserved' state`);
		}
	}

	/** Flip a reserved row to `rolled_back`. No-op if already terminal. */
	rollbackReservation(id: number): void {
		this.rollbackReservationStmt.run(id);
	}

	/**
	 * List reservations still in `reserved` at startup — these are crash
	 * orphans. Callers sweep them via {@link sweepOrphans}.
	 */
	listOrphanReservations(): readonly OrphanReservation[] {
		return this.listOrphansStmt.all();
	}

	/** Mark every `reserved` row `rolled_back`. Returns the row count. */
	sweepOrphans(): number {
		return this.sweepOrphansStmt.run().changes;
	}

	/**
	 * Sum `actual` (committed) + `estimated` (reserved) for `category`
	 * between `[fromTs, toTs)`. Rolled-back rows are excluded. Indexed on
	 * `(category, ts)`; cost is O(log N + matches).
	 */
	rollup(category: string, fromTs: number, toTs: number): number {
		const row = this.rollupStmt.get(category, fromTs, toTs);
		return row?.total ?? 0;
	}

	/** Insert a finished OTEL span. Called by `SqliteSpanExporter`. */
	insertTrace(row: TraceRow): void {
		this.insertTraceStmt.run(
			row.traceId,
			row.spanId,
			row.parentSpanId ?? null,
			row.tsStart,
			row.tsEnd,
			row.name,
			row.sessionId,
			JSON.stringify(row.attributes),
			row.status,
		);
	}

	/** Test-only: direct SQL access. Not exported for production use. */
	_rawForTests(): Database.Database {
		return this.db;
	}

	private initSchema(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS sessions (
				id TEXT PRIMARY KEY,
				created_ts INTEGER NOT NULL
			);

			CREATE TABLE IF NOT EXISTS budget_ledger (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				ts INTEGER NOT NULL,
				session_id TEXT NOT NULL,
				category TEXT NOT NULL,
				unit TEXT NOT NULL,
				estimated REAL NOT NULL,
				actual REAL,
				status TEXT NOT NULL,
				trace_id TEXT,
				span_id TEXT,
				metadata_json TEXT,
				FOREIGN KEY (session_id) REFERENCES sessions(id)
			);
			CREATE INDEX IF NOT EXISTS idx_budget_ledger_ts ON budget_ledger (ts);
			CREATE INDEX IF NOT EXISTS idx_budget_ledger_session ON budget_ledger (session_id);
			CREATE INDEX IF NOT EXISTS idx_budget_ledger_category_ts ON budget_ledger (category, ts);

			CREATE TABLE IF NOT EXISTS traces (
				trace_id TEXT NOT NULL,
				span_id TEXT NOT NULL,
				parent_span_id TEXT,
				ts_start INTEGER NOT NULL,
				ts_end INTEGER NOT NULL,
				name TEXT NOT NULL,
				session_id TEXT NOT NULL,
				attributes_json TEXT NOT NULL,
				status TEXT NOT NULL,
				PRIMARY KEY (trace_id, span_id)
			);
			CREATE INDEX IF NOT EXISTS idx_traces_session_ts ON traces (session_id, ts_start);
		`);
	}
}

export interface ReservationRow {
	readonly ts: number;
	readonly sessionId: string;
	readonly category: string;
	readonly unit: 'usd' | 'gpu_seconds';
	readonly estimated: number;
	readonly traceId?: string;
	readonly spanId?: string;
	readonly metadata?: Record<string, unknown>;
}

export interface OrphanReservation {
	readonly id: number;
	readonly session_id: string;
	readonly category: string;
}

export interface TraceRow {
	readonly traceId: string;
	readonly spanId: string;
	readonly parentSpanId?: string;
	readonly tsStart: number;
	readonly tsEnd: number;
	readonly name: string;
	readonly sessionId: string;
	readonly attributes: Record<string, unknown>;
	readonly status: 'ok' | 'error';
}
