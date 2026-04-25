/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import Database from 'better-sqlite3';

/**
 * The single point of SQLite access in the harness.
 *
 * Session state, conversation history, budget meters, routing decisions,
 * trace spans, and analytics rollups all read and write through this
 * module; no other module opens its own database handle. Consumers
 * (`BudgetMeter`, `SqliteSpanExporter`, the session/history loader, the
 * analytics facade) take a `Persistence` instance as a dep.
 *
 * Schema is versioned via `PRAGMA user_version` so additive migrations
 * can run safely on an existing DB without re-running `ALTER` statements.
 * Each migration step is idempotent on a fresh DB and one-shot on an
 * upgraded DB.
 */
export class Persistence {
	private readonly db: Database.Database;

	private readonly upsertSessionStmt: Database.Statement<[string, number, string | null, string | null, number]>;
	private readonly touchSessionStmt: Database.Statement<[number, string]>;
	private readonly setSessionTitleStmt: Database.Statement<[string, string]>;
	private readonly getSessionStmt: Database.Statement<[string], SessionRow>;
	private readonly listSessionsStmt: Database.Statement<[number], SessionRow>;
	private readonly listChildSessionsStmt: Database.Statement<[string], SessionRow>;

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

	private readonly insertMessageStmt: Database.Statement<[
		string, number, number, string, string, string | null,
	]>;
	private readonly nextPositionStmt: Database.Statement<[string], { next_pos: number }>;
	private readonly listMessagesStmt: Database.Statement<[string], MessageRow>;
	private readonly listMessagesUpToStmt: Database.Statement<[string, number], MessageRow>;

	private readonly insertToolCallStmt: Database.Statement<[
		number, string, string, string, string, number,
	]>;
	private readonly recordToolResultStmt: Database.Statement<[
		string, number, number, number,
	]>;
	private readonly listToolCallsForMessageStmt: Database.Statement<[number], ToolCallRow>;
	private readonly listToolCallsForSessionStmt: Database.Statement<[string], ToolCallRow>;

	private readonly insertRoutingStmt: Database.Statement<[
		string, number, string, string, number | null, string | null,
	]>;
	private readonly listRoutingForSessionStmt: Database.Statement<[string], RoutingDecisionRow>;

	private readonly insertSnapshotStmt: Database.Statement<[string, number, string]>;
	private readonly latestSnapshotStmt: Database.Statement<[string], SnapshotRow>;

	private readonly toolFreqStmt: Database.Statement<[number], { tool_name: string; count: number }>;
	private readonly costSeriesStmt: Database.Statement<[number, number], { category: string; total: number }>;

	/**
	 * Open (or create) the session database at `path`. Use `:memory:` for
	 * tests. Schema migrations run on every open; they are idempotent and
	 * gated by `PRAGMA user_version`.
	 */
	constructor(path: string) {
		this.db = new Database(path);
		this.db.pragma('journal_mode = WAL');
		this.db.pragma('foreign_keys = ON');
		this.migrate();

		this.upsertSessionStmt = this.db.prepare(
			`INSERT INTO sessions (id, created_ts, parent_session_id, branch_id, last_active_ts) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
		);
		this.touchSessionStmt = this.db.prepare(
			`UPDATE sessions SET last_active_ts = ? WHERE id = ?`,
		);
		this.setSessionTitleStmt = this.db.prepare(
			`UPDATE sessions SET title = ? WHERE id = ?`,
		);
		this.getSessionStmt = this.db.prepare(
			`SELECT id, created_ts, parent_session_id, branch_id, title, last_active_ts FROM sessions WHERE id = ?`,
		);
		this.listSessionsStmt = this.db.prepare(
			`SELECT id, created_ts, parent_session_id, branch_id, title, last_active_ts FROM sessions ORDER BY COALESCE(last_active_ts, created_ts) DESC LIMIT ?`,
		);
		this.listChildSessionsStmt = this.db.prepare(
			`SELECT id, created_ts, parent_session_id, branch_id, title, last_active_ts FROM sessions WHERE parent_session_id = ? ORDER BY created_ts ASC`,
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

		this.insertMessageStmt = this.db.prepare(
			`INSERT INTO messages (session_id, position, ts, role, text, stop_reason) VALUES (?, ?, ?, ?, ?, ?)`,
		);
		this.nextPositionStmt = this.db.prepare(
			`SELECT COALESCE(MAX(position) + 1, 0) AS next_pos FROM messages WHERE session_id = ?`,
		);
		this.listMessagesStmt = this.db.prepare(
			`SELECT id, session_id, position, ts, role, text, stop_reason FROM messages WHERE session_id = ? ORDER BY position ASC`,
		);
		this.listMessagesUpToStmt = this.db.prepare(
			`SELECT id, session_id, position, ts, role, text, stop_reason FROM messages WHERE session_id = ? AND position <= ? ORDER BY position ASC`,
		);

		this.insertToolCallStmt = this.db.prepare(
			`INSERT INTO tool_calls (message_id, session_id, tool_use_id, tool_name, input_json, ts) VALUES (?, ?, ?, ?, ?, ?)`,
		);
		this.recordToolResultStmt = this.db.prepare(
			`UPDATE tool_calls SET result_content = ?, result_is_error = ?, result_ts = ? WHERE id = ?`,
		);
		this.listToolCallsForMessageStmt = this.db.prepare(
			`SELECT id, message_id, session_id, tool_use_id, tool_name, input_json, ts, result_content, result_is_error, result_ts FROM tool_calls WHERE message_id = ? ORDER BY id ASC`,
		);
		this.listToolCallsForSessionStmt = this.db.prepare(
			`SELECT id, message_id, session_id, tool_use_id, tool_name, input_json, ts, result_content, result_is_error, result_ts FROM tool_calls WHERE session_id = ? ORDER BY id ASC`,
		);

		this.insertRoutingStmt = this.db.prepare(
			`INSERT INTO routing_decisions (session_id, ts, role, model, parent_message_id, rationale) VALUES (?, ?, ?, ?, ?, ?)`,
		);
		this.listRoutingForSessionStmt = this.db.prepare(
			`SELECT id, session_id, ts, role, model, parent_message_id, rationale FROM routing_decisions WHERE session_id = ? ORDER BY ts ASC`,
		);

		this.insertSnapshotStmt = this.db.prepare(
			`INSERT INTO budget_snapshots (session_id, ts, snapshot_json) VALUES (?, ?, ?)`,
		);
		this.latestSnapshotStmt = this.db.prepare(
			`SELECT id, session_id, ts, snapshot_json FROM budget_snapshots WHERE session_id = ? ORDER BY ts DESC LIMIT 1`,
		);

		this.toolFreqStmt = this.db.prepare(
			`SELECT tool_name, COUNT(*) AS count FROM tool_calls WHERE ts >= ? GROUP BY tool_name ORDER BY count DESC`,
		);
		this.costSeriesStmt = this.db.prepare(
			`SELECT category, COALESCE(SUM(CASE WHEN status = 'committed' THEN actual ELSE 0 END), 0) AS total FROM budget_ledger WHERE ts >= ? AND ts < ? GROUP BY category ORDER BY total DESC`,
		);
	}

	/** Close the underlying SQLite handle. */
	close(): void {
		this.db.close();
	}

	// -------------------------------------------------------------------------
	// Sessions
	// -------------------------------------------------------------------------

	/**
	 * Ensure a session row exists. Idempotent — safe to call on every
	 * harness startup for the active session id. Optional `parentSessionId`
	 * + `branchId` populate the branching columns when this session was
	 * forked from another; the schema supports branching even when no UI
	 * surface yet exposes it.
	 */
	upsertSession(sessionId: string, createdTs: number, opts?: UpsertSessionOptions): void {
		this.upsertSessionStmt.run(
			sessionId,
			createdTs,
			opts?.parentSessionId ?? null,
			opts?.branchId ?? null,
			createdTs,
		);
	}

	/** Bump `last_active_ts` on every persist so "recent sessions" lists order correctly. */
	touchSession(sessionId: string, nowTs: number): void {
		this.touchSessionStmt.run(nowTs, sessionId);
	}

	/** Set the session's display title. Optional; if unset, callers fall back to the first user message. */
	setSessionTitle(sessionId: string, title: string): void {
		this.setSessionTitleStmt.run(title, sessionId);
	}

	getSession(sessionId: string): SessionRow | undefined {
		return this.getSessionStmt.get(sessionId);
	}

	listSessions(limit = 50): readonly SessionRow[] {
		return this.listSessionsStmt.all(limit);
	}

	listChildSessions(parentSessionId: string): readonly SessionRow[] {
		return this.listChildSessionsStmt.all(parentSessionId);
	}

	// -------------------------------------------------------------------------
	// Conversation messages + tool calls
	// -------------------------------------------------------------------------

	/**
	 * Append a message to a session. Auto-assigns the next position so
	 * callers don't have to track it. Returns the new row id.
	 */
	appendMessage(row: AppendMessageRow): number {
		const tx = this.db.transaction((r: AppendMessageRow) => {
			const next = this.nextPositionStmt.get(r.sessionId);
			const position = next?.next_pos ?? 0;
			const info = this.insertMessageStmt.run(
				r.sessionId,
				position,
				r.ts,
				r.role,
				r.text,
				r.stopReason ?? null,
			);
			return Number(info.lastInsertRowid);
		});
		return tx(row);
	}

	/**
	 * Append a tool call attached to an assistant message. The result
	 * columns stay null until {@link recordToolResult} fills them in once
	 * the dispatcher returns a {@link ToolResult}.
	 */
	appendToolCall(row: AppendToolCallRow): number {
		const info = this.insertToolCallStmt.run(
			row.messageId,
			row.sessionId,
			row.toolUseId,
			row.toolName,
			JSON.stringify(row.input),
			row.ts,
		);
		return Number(info.lastInsertRowid);
	}

	/** Fill in the result columns once the dispatcher returns. */
	recordToolResult(toolCallId: number, content: string, isError: boolean, ts: number): void {
		const info = this.recordToolResultStmt.run(content, isError ? 1 : 0, ts, toolCallId);
		if (info.changes === 0) {
			throw new Error(`Persistence: tool_call ${toolCallId} not found`);
		}
	}

	listMessages(sessionId: string): readonly MessageRow[] {
		return this.listMessagesStmt.all(sessionId);
	}

	listToolCallsForMessage(messageId: number): readonly ToolCallRow[] {
		return this.listToolCallsForMessageStmt.all(messageId);
	}

	listToolCallsForSession(sessionId: string): readonly ToolCallRow[] {
		return this.listToolCallsForSessionStmt.all(sessionId);
	}

	/**
	 * Read a session's full state for resume: the session row, every
	 * message in order, and every tool_call grouped under its message.
	 * Returns `undefined` if the session id is unknown so the caller can
	 * fall back to creating a fresh session.
	 */
	loadSession(sessionId: string): SessionResume | undefined {
		const session = this.getSession(sessionId);
		if (!session) {
			return undefined;
		}
		const messages = this.listMessages(sessionId);
		const toolCallsBySession = this.listToolCallsForSession(sessionId);
		const byMessage = new Map<number, ToolCallRow[]>();
		for (const tc of toolCallsBySession) {
			const existing = byMessage.get(tc.message_id);
			if (existing) {
				existing.push(tc);
			} else {
				byMessage.set(tc.message_id, [tc]);
			}
		}
		const enriched = messages.map(m => ({
			...m,
			toolCalls: byMessage.get(m.id) ?? [],
		}));
		return { session, messages: enriched };
	}

	// -------------------------------------------------------------------------
	// Branching
	// -------------------------------------------------------------------------

	/**
	 * Fork `parentSessionId` into a new session, copying messages (and
	 * their attached tool_calls) up to and including `throughPosition`
	 * (default: every message in parent). Copy semantics, not reference
	 * semantics — the new session owns its own message rows so post-fork
	 * edits don't disturb the parent. The primitive lives at the DB
	 * level even before any UI surface exposes branch creation.
	 */
	forkSession(opts: ForkSessionOptions): void {
		const tx = this.db.transaction((o: ForkSessionOptions) => {
			const parent = this.getSession(o.parentSessionId);
			if (!parent) {
				throw new Error(`Persistence: cannot fork unknown session ${o.parentSessionId}`);
			}
			this.upsertSessionStmt.run(
				o.newSessionId,
				o.createdTs,
				o.parentSessionId,
				o.branchId ?? null,
				o.createdTs,
			);
			const upTo = o.throughPosition ?? Number.MAX_SAFE_INTEGER;
			const sourceMessages = this.listMessagesUpToStmt.all(o.parentSessionId, upTo);
			for (const m of sourceMessages) {
				const info = this.insertMessageStmt.run(
					o.newSessionId,
					m.position,
					m.ts,
					m.role,
					m.text,
					m.stop_reason,
				);
				const newMessageId = Number(info.lastInsertRowid);
				const sourceToolCalls = this.listToolCallsForMessageStmt.all(m.id);
				for (const tc of sourceToolCalls) {
					const tcInfo = this.insertToolCallStmt.run(
						newMessageId,
						o.newSessionId,
						tc.tool_use_id,
						tc.tool_name,
						tc.input_json,
						tc.ts,
					);
					if (tc.result_content !== null) {
						this.recordToolResultStmt.run(
							tc.result_content,
							tc.result_is_error ?? 0,
							tc.result_ts ?? tc.ts,
							Number(tcInfo.lastInsertRowid),
						);
					}
				}
			}
		});
		tx(opts);
	}

	// -------------------------------------------------------------------------
	// Routing decisions
	// -------------------------------------------------------------------------

	recordRoutingDecision(row: RoutingDecisionInput): number {
		const info = this.insertRoutingStmt.run(
			row.sessionId,
			row.ts,
			row.role,
			row.model,
			row.parentMessageId ?? null,
			row.rationale ?? null,
		);
		return Number(info.lastInsertRowid);
	}

	listRoutingDecisions(sessionId: string): readonly RoutingDecisionRow[] {
		return this.listRoutingForSessionStmt.all(sessionId);
	}

	// -------------------------------------------------------------------------
	// Budget meter (existing) + analytics rollup snapshots
	// -------------------------------------------------------------------------

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

	/**
	 * Persist a point-in-time `BudgetSnapshotResult` for analytics. Kept
	 * separate from the live ledger so dashboards can query without
	 * walking every row, and so historical strip rendering doesn't depend
	 * on rollup recomputation.
	 */
	recordBudgetSnapshot(row: BudgetSnapshotInput): number {
		const info = this.insertSnapshotStmt.run(row.sessionId, row.ts, JSON.stringify(row.snapshot));
		return Number(info.lastInsertRowid);
	}

	latestBudgetSnapshot(sessionId: string): SnapshotRow | undefined {
		return this.latestSnapshotStmt.get(sessionId);
	}

	// -------------------------------------------------------------------------
	// Analytics queries
	// -------------------------------------------------------------------------

	toolCallFrequency(sinceTs: number): readonly ToolFrequencyRow[] {
		return this.toolFreqStmt.all(sinceTs);
	}

	costSeriesByCategory(fromTs: number, toTs: number): readonly CostSeriesRow[] {
		return this.costSeriesStmt.all(fromTs, toTs);
	}

	// -------------------------------------------------------------------------
	// Trace exporter (existing)
	// -------------------------------------------------------------------------

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

	// -------------------------------------------------------------------------
	// Migrations
	// -------------------------------------------------------------------------

	private migrate(): void {
		const current = this.db.pragma('user_version', { simple: true }) as number;
		const target = MIGRATIONS.length;
		if (current >= target) {
			return;
		}
		const tx = this.db.transaction(() => {
			for (let i = current; i < target; i++) {
				MIGRATIONS[i](this.db);
			}
			this.db.pragma(`user_version = ${target}`);
		});
		tx();
	}
}

// -----------------------------------------------------------------------------
// Migrations
// -----------------------------------------------------------------------------

type Migration = (db: Database.Database) => void;

/**
 * v1: initial schema — sessions (FK target), budget_ledger, traces.
 * Idempotent on a fresh DB; the original code shipped these as
 * `CREATE TABLE IF NOT EXISTS`, so an existing v0 DB already has them.
 */
const migration1: Migration = db => {
	db.exec(`
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
};

/**
 * v2: branching columns on sessions; conversation history (messages,
 * tool_calls); routing decisions; budget snapshots.
 */
const migration2: Migration = db => {
	addColumnIfMissing(db, 'sessions', 'parent_session_id', 'TEXT');
	addColumnIfMissing(db, 'sessions', 'branch_id', 'TEXT');
	addColumnIfMissing(db, 'sessions', 'title', 'TEXT');
	addColumnIfMissing(db, 'sessions', 'last_active_ts', 'INTEGER');

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions (parent_session_id);
		CREATE INDEX IF NOT EXISTS idx_sessions_last_active ON sessions (last_active_ts);

		CREATE TABLE IF NOT EXISTS messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT NOT NULL,
			position INTEGER NOT NULL,
			ts INTEGER NOT NULL,
			role TEXT NOT NULL,
			text TEXT NOT NULL,
			stop_reason TEXT,
			FOREIGN KEY (session_id) REFERENCES sessions(id),
			UNIQUE (session_id, position)
		);
		CREATE INDEX IF NOT EXISTS idx_messages_session ON messages (session_id, position);

		CREATE TABLE IF NOT EXISTS tool_calls (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			message_id INTEGER NOT NULL,
			session_id TEXT NOT NULL,
			tool_use_id TEXT NOT NULL,
			tool_name TEXT NOT NULL,
			input_json TEXT NOT NULL,
			ts INTEGER NOT NULL,
			result_content TEXT,
			result_is_error INTEGER,
			result_ts INTEGER,
			FOREIGN KEY (message_id) REFERENCES messages(id),
			FOREIGN KEY (session_id) REFERENCES sessions(id)
		);
		CREATE INDEX IF NOT EXISTS idx_tool_calls_message ON tool_calls (message_id);
		CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls (session_id);
		CREATE INDEX IF NOT EXISTS idx_tool_calls_name_ts ON tool_calls (tool_name, ts);

		CREATE TABLE IF NOT EXISTS routing_decisions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT NOT NULL,
			ts INTEGER NOT NULL,
			role TEXT NOT NULL,
			model TEXT NOT NULL,
			parent_message_id INTEGER,
			rationale TEXT,
			FOREIGN KEY (session_id) REFERENCES sessions(id),
			FOREIGN KEY (parent_message_id) REFERENCES messages(id)
		);
		CREATE INDEX IF NOT EXISTS idx_routing_session ON routing_decisions (session_id, ts);

		CREATE TABLE IF NOT EXISTS budget_snapshots (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT NOT NULL,
			ts INTEGER NOT NULL,
			snapshot_json TEXT NOT NULL,
			FOREIGN KEY (session_id) REFERENCES sessions(id)
		);
		CREATE INDEX IF NOT EXISTS idx_snapshots_session_ts ON budget_snapshots (session_id, ts);
	`);
};

const MIGRATIONS: readonly Migration[] = [migration1, migration2];

function addColumnIfMissing(db: Database.Database, table: string, column: string, decl: string): void {
	const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
	if (cols.some(c => c.name === column)) {
		return;
	}
	db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

// -----------------------------------------------------------------------------
// Row + input shapes
// -----------------------------------------------------------------------------

export interface UpsertSessionOptions {
	readonly parentSessionId?: string;
	readonly branchId?: string;
}

export interface SessionRow {
	readonly id: string;
	readonly created_ts: number;
	readonly parent_session_id: string | null;
	readonly branch_id: string | null;
	readonly title: string | null;
	readonly last_active_ts: number | null;
}

export interface AppendMessageRow {
	readonly sessionId: string;
	readonly ts: number;
	readonly role: 'user' | 'assistant';
	readonly text: string;
	readonly stopReason?: string;
}

export interface MessageRow {
	readonly id: number;
	readonly session_id: string;
	readonly position: number;
	readonly ts: number;
	readonly role: 'user' | 'assistant';
	readonly text: string;
	readonly stop_reason: string | null;
}

export interface AppendToolCallRow {
	readonly messageId: number;
	readonly sessionId: string;
	readonly toolUseId: string;
	readonly toolName: string;
	readonly input: Record<string, unknown>;
	readonly ts: number;
}

export interface ToolCallRow {
	readonly id: number;
	readonly message_id: number;
	readonly session_id: string;
	readonly tool_use_id: string;
	readonly tool_name: string;
	readonly input_json: string;
	readonly ts: number;
	readonly result_content: string | null;
	readonly result_is_error: number | null;
	readonly result_ts: number | null;
}

export interface MessageWithToolCalls extends MessageRow {
	readonly toolCalls: readonly ToolCallRow[];
}

export interface SessionResume {
	readonly session: SessionRow;
	readonly messages: readonly MessageWithToolCalls[];
}

export interface ForkSessionOptions {
	readonly parentSessionId: string;
	readonly newSessionId: string;
	readonly createdTs: number;
	readonly branchId?: string;
	/** Inclusive: copy messages with `position <= throughPosition`. Default: every message. */
	readonly throughPosition?: number;
}

export interface RoutingDecisionInput {
	readonly sessionId: string;
	readonly ts: number;
	readonly role: string;
	readonly model: string;
	readonly parentMessageId?: number;
	readonly rationale?: string;
}

export interface RoutingDecisionRow {
	readonly id: number;
	readonly session_id: string;
	readonly ts: number;
	readonly role: string;
	readonly model: string;
	readonly parent_message_id: number | null;
	readonly rationale: string | null;
}

export interface BudgetSnapshotInput {
	readonly sessionId: string;
	readonly ts: number;
	readonly snapshot: unknown;
}

export interface SnapshotRow {
	readonly id: number;
	readonly session_id: string;
	readonly ts: number;
	readonly snapshot_json: string;
}

export interface ToolFrequencyRow {
	readonly tool_name: string;
	readonly count: number;
}

export interface CostSeriesRow {
	readonly category: string;
	readonly total: number;
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
