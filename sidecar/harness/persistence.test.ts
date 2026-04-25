/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Persistence } from './persistence.js';

describe('Persistence', () => {
	let tmp: string;
	let dbPath: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), 'thalyn-persistence-'));
		dbPath = join(tmp, 'session.db');
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it('migrates from a fresh DB: schema is at the latest user_version', () => {
		const p = new Persistence(dbPath);
		const version = p._rawForTests().pragma('user_version', { simple: true });
		p.close();
		expect(version).toBe(2);
	});

	it('exposes branching columns on the sessions table after migration', () => {
		const p = new Persistence(dbPath);
		const cols = p._rawForTests().pragma('table_info(sessions)') as Array<{ name: string }>;
		const names = cols.map(c => c.name);
		p.close();
		expect(names).toEqual(
			expect.arrayContaining(['id', 'created_ts', 'parent_session_id', 'branch_id', 'title', 'last_active_ts']),
		);
	});

	it('appends messages with monotonic positions and reads them back in order', () => {
		const p = new Persistence(dbPath);
		p.upsertSession('s1', 1000);
		p.appendMessage({ sessionId: 's1', ts: 1001, role: 'user', text: 'hello' });
		p.appendMessage({ sessionId: 's1', ts: 1002, role: 'assistant', text: 'hi back', stopReason: 'end_turn' });
		p.appendMessage({ sessionId: 's1', ts: 1003, role: 'user', text: 'thanks' });
		const msgs = p.listMessages('s1');
		p.close();
		expect(msgs.map(m => ({ pos: m.position, role: m.role, text: m.text }))).toEqual([
			{ pos: 0, role: 'user', text: 'hello' },
			{ pos: 1, role: 'assistant', text: 'hi back' },
			{ pos: 2, role: 'user', text: 'thanks' },
		]);
	});

	it('round-trips tool calls with results and surfaces them via loadSession', () => {
		const p = new Persistence(dbPath);
		p.upsertSession('s1', 1000);
		const mid = p.appendMessage({ sessionId: 's1', ts: 1001, role: 'assistant', text: '' });
		const tcid = p.appendToolCall({
			messageId: mid,
			sessionId: 's1',
			toolUseId: 'tu_1',
			toolName: 'read_file',
			input: { path: '/etc/hosts' },
			ts: 1002,
		});
		p.recordToolResult(tcid, '127.0.0.1 localhost\n', false, 1003);

		const resume = p.loadSession('s1')!;
		p.close();
		expect(resume.session.id).toBe('s1');
		expect(resume.messages).toHaveLength(1);
		expect(resume.messages[0].toolCalls).toHaveLength(1);
		const tc = resume.messages[0].toolCalls[0];
		expect(tc.tool_name).toBe('read_file');
		expect(JSON.parse(tc.input_json)).toEqual({ path: '/etc/hosts' });
		expect(tc.result_content).toBe('127.0.0.1 localhost\n');
		expect(tc.result_is_error).toBe(0);
	});

	it('survives a "restart": close + reopen retains messages, tool calls, and ledger rows', () => {
		// First run: write.
		const p1 = new Persistence(dbPath);
		p1.upsertSession('s1', 1000);
		const mid = p1.appendMessage({ sessionId: 's1', ts: 1001, role: 'user', text: 'plan it' });
		p1.appendMessage({ sessionId: 's1', ts: 1002, role: 'assistant', text: 'planning' });
		p1.appendToolCall({
			messageId: mid,
			sessionId: 's1',
			toolUseId: 'tu_a',
			toolName: 'list_dir',
			input: {},
			ts: 1003,
		});
		const reservation = p1.insertReservation({
			ts: 1100,
			sessionId: 's1',
			category: 'subagent_opus',
			unit: 'usd',
			estimated: 1.5,
		});
		p1.commitReservation(reservation, 1.4, 1200);
		p1.close();

		// Second run: reopen, read.
		const p2 = new Persistence(dbPath);
		const resume = p2.loadSession('s1');
		const dailyRollup = p2.rollup('subagent_opus', 0, Number.MAX_SAFE_INTEGER);
		p2.close();

		expect(resume).toBeDefined();
		expect(resume!.messages.map(m => m.text)).toEqual(['plan it', 'planning']);
		expect(resume!.messages[0].toolCalls).toHaveLength(1);
		expect(dailyRollup).toBeCloseTo(1.4);
	});

	it('forks a session: copies messages and tool calls under a new session id with the parent link', () => {
		const p = new Persistence(dbPath);
		p.upsertSession('parent', 1000);
		const m1 = p.appendMessage({ sessionId: 'parent', ts: 1001, role: 'user', text: 'one' });
		p.appendMessage({ sessionId: 'parent', ts: 1002, role: 'assistant', text: 'two' });
		p.appendMessage({ sessionId: 'parent', ts: 1003, role: 'user', text: 'three' });
		p.appendToolCall({
			messageId: m1,
			sessionId: 'parent',
			toolUseId: 'tu_x',
			toolName: 'grep',
			input: { pattern: 'foo' },
			ts: 1001,
		});

		p.forkSession({
			parentSessionId: 'parent',
			newSessionId: 'fork',
			createdTs: 2000,
			branchId: 'branch-a',
			throughPosition: 1, // copy positions 0 and 1; drop position 2
		});

		const forkResume = p.loadSession('fork');
		const parentResume = p.loadSession('parent');
		p.close();

		expect(forkResume!.session.parent_session_id).toBe('parent');
		expect(forkResume!.session.branch_id).toBe('branch-a');
		expect(forkResume!.messages.map(m => m.text)).toEqual(['one', 'two']);
		// Tool call carried into the forked copy of message 0, with its own row id.
		expect(forkResume!.messages[0].toolCalls).toHaveLength(1);
		expect(forkResume!.messages[0].toolCalls[0].tool_name).toBe('grep');
		expect(forkResume!.messages[0].toolCalls[0].id).not.toBe(
			parentResume!.messages[0].toolCalls[0].id,
		);
		// Parent unchanged.
		expect(parentResume!.messages.map(m => m.text)).toEqual(['one', 'two', 'three']);
	});

	it('records routing decisions and budget snapshots and reads them back', () => {
		const p = new Persistence(dbPath);
		p.upsertSession('s1', 1000);
		p.recordRoutingDecision({
			sessionId: 's1',
			ts: 1100,
			role: 'researcher',
			model: 'claude-opus-4-7',
			rationale: 'broad search',
		});
		p.recordBudgetSnapshot({
			sessionId: 's1',
			ts: 1200,
			snapshot: { asOf: 1200, categories: [] },
		});
		const decisions = p.listRoutingDecisions('s1');
		const snap = p.latestBudgetSnapshot('s1');
		p.close();
		expect(decisions).toHaveLength(1);
		expect(decisions[0].role).toBe('researcher');
		expect(snap?.ts).toBe(1200);
		expect(JSON.parse(snap!.snapshot_json)).toEqual({ asOf: 1200, categories: [] });
	});

	it('migrates a v1-shaped DB in place: ALTERs sessions, creates new tables', () => {
		// Build a v1 DB by hand: original two-column sessions table, no
		// user_version pragma. Mirrors what an existing on-disk DB looks
		// like before this change.
		const raw = new Database(dbPath);
		raw.exec(`
			CREATE TABLE sessions (id TEXT PRIMARY KEY, created_ts INTEGER NOT NULL);
			CREATE TABLE budget_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, session_id TEXT NOT NULL, category TEXT NOT NULL, unit TEXT NOT NULL, estimated REAL NOT NULL, actual REAL, status TEXT NOT NULL, trace_id TEXT, span_id TEXT, metadata_json TEXT);
			CREATE TABLE traces (trace_id TEXT NOT NULL, span_id TEXT NOT NULL, parent_span_id TEXT, ts_start INTEGER NOT NULL, ts_end INTEGER NOT NULL, name TEXT NOT NULL, session_id TEXT NOT NULL, attributes_json TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY (trace_id, span_id));
			INSERT INTO sessions (id, created_ts) VALUES ('legacy', 500);
		`);
		raw.close();

		// Open through Persistence — migrations run, columns get added.
		const p = new Persistence(dbPath);
		const cols = (p._rawForTests().pragma('table_info(sessions)') as Array<{ name: string }>)
			.map(c => c.name);
		const messagesCols = (p._rawForTests().pragma('table_info(messages)') as Array<{ name: string }>)
			.map(c => c.name);
		const legacy = p.getSession('legacy');
		const version = p._rawForTests().pragma('user_version', { simple: true });
		p.close();

		expect(cols).toEqual(
			expect.arrayContaining(['parent_session_id', 'branch_id', 'title', 'last_active_ts']),
		);
		expect(messagesCols).toEqual(expect.arrayContaining(['session_id', 'position', 'role', 'text']));
		expect(legacy?.created_ts).toBe(500);
		expect(version).toBe(2);
	});

	it('returns undefined for unknown sessions on resume', () => {
		const p = new Persistence(dbPath);
		const out = p.loadSession('does-not-exist');
		p.close();
		expect(out).toBeUndefined();
	});
});
