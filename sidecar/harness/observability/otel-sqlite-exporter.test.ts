/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SpanStatusCode } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Persistence } from '../persistence.js';
import { HarnessTracerProvider } from './tracer.js';
import { SqliteSpanExporter } from './otel-sqlite-exporter.js';

const SESSION_ID = 's_otel';

interface Ctx {
	persistence: Persistence;
	tracer: HarnessTracerProvider;
	exporter: SqliteSpanExporter;
}

function build(): Ctx {
	const persistence = new Persistence(':memory:');
	persistence.upsertSession(SESSION_ID, Date.now());
	const exporter = new SqliteSpanExporter(persistence);
	const tracer = new HarnessTracerProvider({
		serviceName: 'thalyn-sidecar-test',
		serviceVersion: '0.0.0',
		exporters: [exporter],
	});
	return { persistence, tracer, exporter };
}

describe('SqliteSpanExporter', () => {
	let ctx: Ctx;
	beforeEach(() => {
		ctx = build();
	});
	afterEach(async () => {
		await ctx.tracer.shutdown();
		ctx.persistence.close();
	});

	it('writes a GenAI chat span with the expected attribute set', async () => {
		const tracer = ctx.tracer.getTracer('test');
		const span = tracer.startSpan('chat claude-opus-4-7');
		span.setAttributes({
			'gen_ai.system': 'anthropic',
			'gen_ai.operation.name': 'chat',
			'gen_ai.request.model': 'claude-opus-4-7',
			'gen_ai.response.model': 'claude-opus-4-7',
			'gen_ai.request.max_tokens': 4096,
			'gen_ai.usage.input_tokens': 12034,
			'gen_ai.usage.output_tokens': 412,
			'gen_ai.response.finish_reasons': ['end_turn'],
			'thalyn.budget.category': 'subagent_opus',
			'thalyn.budget.unit': 'usd',
			'thalyn.budget.estimated': 0.42,
			'thalyn.budget.actual': 0.38,
			'thalyn.budget.reservation_id': 'r_01',
			'thalyn.session.id': SESSION_ID,
		});
		span.setStatus({ code: SpanStatusCode.OK });
		span.end();
		await ctx.tracer.provider.forceFlush();

		const row = ctx.persistence
			._rawForTests()
			.prepare('SELECT trace_id, span_id, parent_span_id, name, session_id, status, attributes_json FROM traces')
			.get() as {
				trace_id: string;
				span_id: string;
				parent_span_id: string | null;
				name: string;
				session_id: string;
				status: string;
				attributes_json: string;
			};

		expect(row.name).toBe('chat claude-opus-4-7');
		expect(row.session_id).toBe(SESSION_ID);
		expect(row.status).toBe('ok');
		expect(row.trace_id).toMatch(/^[0-9a-f]{32}$/);
		expect(row.span_id).toMatch(/^[0-9a-f]{16}$/);
		expect(row.parent_span_id).toBeNull();

		const attributes = JSON.parse(row.attributes_json);
		expect(attributes).toEqual({
			'gen_ai.system': 'anthropic',
			'gen_ai.operation.name': 'chat',
			'gen_ai.request.model': 'claude-opus-4-7',
			'gen_ai.response.model': 'claude-opus-4-7',
			'gen_ai.request.max_tokens': 4096,
			'gen_ai.usage.input_tokens': 12034,
			'gen_ai.usage.output_tokens': 412,
			'gen_ai.response.finish_reasons': ['end_turn'],
			'thalyn.budget.category': 'subagent_opus',
			'thalyn.budget.unit': 'usd',
			'thalyn.budget.estimated': 0.42,
			'thalyn.budget.actual': 0.38,
			'thalyn.budget.reservation_id': 'r_01',
			'thalyn.session.id': SESSION_ID,
		});
	});

	it('records error status on a failed span', async () => {
		const tracer = ctx.tracer.getTracer('test');
		const span = tracer.startSpan('chat claude-opus-4-7');
		span.setAttributes({
			'gen_ai.system': 'anthropic',
			'gen_ai.operation.name': 'chat',
			'thalyn.session.id': SESSION_ID,
		});
		span.setStatus({ code: SpanStatusCode.ERROR, message: 'rate_limit' });
		span.end();
		await ctx.tracer.provider.forceFlush();

		const row = ctx.persistence
			._rawForTests()
			.prepare('SELECT status FROM traces')
			.get() as { status: string };
		expect(row.status).toBe('error');
	});

	it('records parent/child span hierarchy', async () => {
		const tracer = ctx.tracer.getTracer('test');
		const parent = tracer.startSpan('parent');
		parent.setAttributes({ 'thalyn.session.id': SESSION_ID });

		const api = await import('@opentelemetry/api');
		const ctxWithParent = api.trace.setSpan(api.context.active(), parent);
		const child = tracer.startSpan('child', undefined, ctxWithParent);
		child.setAttributes({ 'thalyn.session.id': SESSION_ID });
		child.end();
		parent.end();
		await ctx.tracer.provider.forceFlush();

		const rows = ctx.persistence
			._rawForTests()
			.prepare('SELECT name, span_id, parent_span_id FROM traces ORDER BY ts_start')
			.all() as ReadonlyArray<{ name: string; span_id: string; parent_span_id: string | null }>;
		expect(rows).toHaveLength(2);
		const parentRow = rows.find(r => r.name === 'parent')!;
		const childRow = rows.find(r => r.name === 'child')!;
		expect(childRow.parent_span_id).toBe(parentRow.span_id);
		expect(parentRow.parent_span_id).toBeNull();
	});

	it('fails the batch when thalyn.session.id is missing', async () => {
		const tracer = ctx.tracer.getTracer('test');
		const span = tracer.startSpan('no-session');
		span.setAttributes({ 'gen_ai.system': 'anthropic' });
		span.end();
		// Give the SimpleSpanProcessor a tick to attempt export.
		await ctx.tracer.provider.forceFlush().catch(() => undefined);

		// Exporter threw → batch rejected → nothing persisted.
		const count = ctx.persistence
			._rawForTests()
			.prepare('SELECT COUNT(*) AS n FROM traces')
			.get() as { n: number };
		expect(count.n).toBe(0);
	});
});
