/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Persistence } from '../persistence.js';
import { Analytics } from './analytics.js';

describe('Analytics', () => {
	let p: Persistence;
	let a: Analytics;

	beforeEach(() => {
		p = new Persistence(':memory:');
		a = new Analytics(p);
	});

	afterEach(() => {
		p.close();
	});

	it('summarizes recent sessions with message and tool counts', () => {
		p.upsertSession('s1', 1000);
		p.upsertSession('s2', 2000);
		const m1 = p.appendMessage({ sessionId: 's1', ts: 1001, role: 'user', text: 'hi' });
		p.appendMessage({ sessionId: 's1', ts: 1002, role: 'assistant', text: 'hello' });
		p.appendToolCall({
			messageId: m1,
			sessionId: 's1',
			toolUseId: 't1',
			toolName: 'read_file',
			input: {},
			ts: 1002,
		});
		const list = a.listRecentSessions();
		expect(list).toHaveLength(2);
		const s1 = list.find(s => s.sessionId === 's1')!;
		expect(s1.messageCount).toBe(2);
		expect(s1.toolCallCount).toBe(1);
	});

	it('rolls up tool-call frequency over a window', () => {
		p.upsertSession('s1', 1000);
		const m = p.appendMessage({ sessionId: 's1', ts: 1000, role: 'assistant', text: '' });
		p.appendToolCall({ messageId: m, sessionId: 's1', toolUseId: 't1', toolName: 'read_file', input: {}, ts: 1500 });
		p.appendToolCall({ messageId: m, sessionId: 's1', toolUseId: 't2', toolName: 'read_file', input: {}, ts: 1600 });
		p.appendToolCall({ messageId: m, sessionId: 's1', toolUseId: 't3', toolName: 'grep', input: {}, ts: 1700 });
		// One older call outside the window.
		p.appendToolCall({ messageId: m, sessionId: 's1', toolUseId: 't0', toolName: 'read_file', input: {}, ts: 100 });

		const freq = a.toolCallFrequency(1000, 2000); // window = [1000, 2000]
		expect(freq.get('read_file')).toBe(2);
		expect(freq.get('grep')).toBe(1);
	});

	it('rolls up cost by category — committed only, not reserved or rolled-back', () => {
		p.upsertSession('s1', 1000);
		const r1 = p.insertReservation({ ts: 1000, sessionId: 's1', category: 'subagent_opus', unit: 'usd', estimated: 1.0 });
		p.commitReservation(r1, 0.95, 1100);
		const r2 = p.insertReservation({ ts: 1100, sessionId: 's1', category: 'subagent_opus', unit: 'usd', estimated: 2.0 });
		p.commitReservation(r2, 1.85, 1200);
		const r3 = p.insertReservation({ ts: 1200, sessionId: 's1', category: 'browser_loop', unit: 'usd', estimated: 0.4 });
		p.commitReservation(r3, 0.4, 1300);
		// Reserved (in flight): excluded.
		p.insertReservation({ ts: 1300, sessionId: 's1', category: 'subagent_opus', unit: 'usd', estimated: 999 });

		const series = a.costByCategory(0, Number.MAX_SAFE_INTEGER);
		expect(series.get('subagent_opus')).toBeCloseTo(0.95 + 1.85);
		expect(series.get('browser_loop')).toBeCloseTo(0.4);
	});

	it('classifies tool outcomes by success vs failure', () => {
		p.upsertSession('s1', 1000);
		const m = p.appendMessage({ sessionId: 's1', ts: 1000, role: 'assistant', text: '' });
		const ok = p.appendToolCall({ messageId: m, sessionId: 's1', toolUseId: 't1', toolName: 'read_file', input: {}, ts: 1500 });
		p.recordToolResult(ok, '...', false, 1501);
		const bad = p.appendToolCall({ messageId: m, sessionId: 's1', toolUseId: 't2', toolName: 'read_file', input: {}, ts: 1600 });
		p.recordToolResult(bad, 'ENOENT', true, 1601);
		// Pending: no result recorded yet.
		p.appendToolCall({ messageId: m, sessionId: 's1', toolUseId: 't3', toolName: 'read_file', input: {}, ts: 1700 });

		const outcomes = a.toolOutcomePattern(1000, 2000);
		const rf = outcomes.get('read_file')!;
		expect(rf.total).toBe(3);
		expect(rf.succeeded).toBe(1);
		expect(rf.failed).toBe(1);
		expect(rf.pending).toBe(1);
	});
});
