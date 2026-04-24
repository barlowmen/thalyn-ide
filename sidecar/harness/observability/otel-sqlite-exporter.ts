/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { hrTimeToMilliseconds, type ExportResult, ExportResultCode } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';

import type { Persistence } from '../persistence';

/**
 * `SpanExporter` that writes finished OTEL spans to the harness's SQLite
 * `traces` table via {@link Persistence.insertTrace}. Attributes are
 * serialised verbatim as JSON, so the column remains decodable by
 * anything that understands the OTEL GenAI semantic conventions.
 *
 * Sits alongside the standard OTEL exporters: plugging in a second
 * exporter (Langfuse, Helicone, Datadog, SigNoz) is a one-line
 * addition to the `TracerProvider`. We aren't "locked in" to SQLite —
 * the SQLite log is the system of record, everything else is a read
 * replica.
 *
 * Write failures are reported through the `ExportResult`; they don't
 * throw. An export batch is all-or-nothing: the first failure short-
 * circuits the rest and the batch returns `FAILED` with the error.
 */
export class SqliteSpanExporter implements SpanExporter {
	private shuttingDown = false;

	constructor(
		private readonly persistence: Persistence,
		private readonly deps: SqliteSpanExporterDeps = {},
	) { }

	export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
		if (this.shuttingDown) {
			resultCallback({
				code: ExportResultCode.FAILED,
				error: new Error('SqliteSpanExporter is shutting down'),
			});
			return;
		}
		try {
			for (const span of spans) {
				this.writeSpan(span);
			}
			resultCallback({ code: ExportResultCode.SUCCESS });
		} catch (error) {
			resultCallback({
				code: ExportResultCode.FAILED,
				error: error instanceof Error ? error : new Error(String(error)),
			});
		}
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
	}

	async forceFlush(): Promise<void> {
		// No internal buffer — the backing writes are synchronous via
		// better-sqlite3. Present for API parity with other exporters.
	}

	private writeSpan(span: ReadableSpan): void {
		const ctx = span.spanContext();
		const attributes = span.attributes;

		const sessionId = attributes['thalyn.session.id'];
		if (typeof sessionId !== 'string' || sessionId.length === 0) {
			throw new Error(
				`SqliteSpanExporter: span ${span.name} is missing required attribute thalyn.session.id`,
			);
		}

		this.persistence.insertTrace({
			traceId: ctx.traceId,
			spanId: ctx.spanId,
			parentSpanId: span.parentSpanId,
			tsStart: hrTimeToMilliseconds(span.startTime),
			tsEnd: hrTimeToMilliseconds(span.endTime),
			name: span.name,
			sessionId,
			attributes: attributes as Record<string, unknown>,
			status: span.status.code === 2 /* ERROR */ ? 'error' : 'ok',
		});
		this.deps.onSpanWritten?.(span);
	}
}

export interface SqliteSpanExporterDeps {
	/** Test-only hook fired after each span is persisted. */
	readonly onSpanWritten?: (span: ReadableSpan) => void;
}
