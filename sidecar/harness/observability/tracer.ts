/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Resource } from '@opentelemetry/resources';
import { NodeTracerProvider, SimpleSpanProcessor, type SpanExporter } from '@opentelemetry/sdk-trace-node';

/**
 * Construct the harness's `TracerProvider`. The SQLite exporter
 * registers as a `SimpleSpanProcessor` so spans hit the ledger as soon
 * as they end — essential for a personal tool where "the user closed
 * the app" should not lose the last few seconds of spans to a batch
 * processor's flush interval. Additional exporters (Langfuse, Helicone,
 * Datadog, SigNoz) can be appended via `addExporter()`.
 *
 * The provider is not registered globally — call sites take it by
 * dependency injection. That keeps parallel test isolation cheap and
 * avoids cross-talk with any other OTEL-using module the sidecar might
 * host in the future.
 */
export class HarnessTracerProvider {
	readonly provider: NodeTracerProvider;

	constructor(options: HarnessTracerOptions) {
		this.provider = new NodeTracerProvider({
			resource: new Resource({
				'service.name': options.serviceName ?? 'thalyn-harness',
				'service.version': options.serviceVersion ?? '0.0.0',
			}),
		});
		for (const exporter of options.exporters) {
			this.provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
		}
	}

	/** Add another exporter after construction (e.g. Langfuse at runtime). */
	addExporter(exporter: SpanExporter): void {
		this.provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
	}

	/** Convenience: get a scoped tracer. */
	getTracer(name: string, version?: string) {
		return this.provider.getTracer(name, version);
	}

	async shutdown(): Promise<void> {
		await this.provider.shutdown();
	}
}

export interface HarnessTracerOptions {
	readonly serviceName?: string;
	readonly serviceVersion?: string;
	readonly exporters: readonly SpanExporter[];
}
