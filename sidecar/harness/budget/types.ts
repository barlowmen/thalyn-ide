/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared types for the budget subsystem. The concrete configuration
 * loader, estimator, and meter live next to this file; this module is
 * the common surface they all import from.
 *
 * Design reference: `.claude/adrs/0005-budget-subsystem.md`.
 */

/** The unit a category is denominated in. USD for paid APIs and LLMs; `gpu_seconds` for local inference. */
export type Unit = 'usd' | 'gpu_seconds';

/** Per-category caps as loaded from `sidecar/config/budgets.yaml`. */
export interface CategoryCaps {
	readonly unit: Unit;
	readonly per_call_cap: number;
	readonly daily_soft_cap: number;
	readonly daily_hard_cap: number;
	readonly weekly_soft_cap: number;
	readonly weekly_hard_cap: number;
}

/** Parsed `budgets.yaml` after schema validation. */
export interface BudgetConfig {
	readonly version: 1;
	readonly categories: Readonly<Record<string, CategoryCaps>>;
}

/**
 * Describes a prospective cost-bearing call. The estimator reads this
 * to produce an {@link Estimate}; the meter attaches fields to the
 * OTEL span.
 */
export interface CallDescriptor {
	/**
	 * Model id for LLM categories (`subagent_opus`, `browser_loop`,
	 * `gemini`, `grok`, `document_gen`, `local_inference`). Absent for
	 * flat-fee categories (`search_brave`, `search_perplexity`,
	 * `elevenlabs_tts`).
	 */
	readonly model?: string;
	/** Exact prompt-token count. For LLM categories, the estimator requires this. */
	readonly inputTokens?: number;
	/**
	 * Upper bound on output tokens. Estimates assume the call fills this
	 * ceiling so reservations over-shoot; `commit()` reconciles to
	 * actual.
	 */
	readonly maxOutputTokens?: number;
	/** Character count for text-to-speech. */
	readonly characters?: number;
	/** Unit count for flat-fee categories (e.g. Brave queries in a batched request). */
	readonly count?: number;
}

export interface Estimate {
	readonly unit: Unit;
	readonly value: number;
	readonly breakdown?: EstimateBreakdown;
}

export interface EstimateBreakdown {
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly characters?: number;
	readonly count?: number;
}

/**
 * The opaque handle returned by `BudgetMeter.reserve()`. The meter
 * commits or rolls back using this; callers never inspect its shape
 * beyond passing it back.
 */
export interface Reservation {
	readonly id: number;
	readonly category: string;
	readonly unit: Unit;
	readonly estimated: number;
	readonly ts: number;
	readonly sessionId: string;
	readonly traceId?: string;
	readonly spanId?: string;
}

// -----------------------------------------------------------------------------
// Typed errors
// -----------------------------------------------------------------------------

export class BudgetUnknownCategory extends Error {
	readonly code = 'BUDGET_UNKNOWN_CATEGORY';
	constructor(public readonly category: string) {
		super(`Unknown budget category: ${category}`);
		this.name = 'BudgetUnknownCategory';
	}
}

export class BudgetUnitMismatch extends Error {
	readonly code = 'BUDGET_UNIT_MISMATCH';
	constructor(public readonly category: string, public readonly expected: Unit, public readonly actual: Unit) {
		super(`Category ${category} is denominated in ${expected} but estimate reported ${actual}`);
		this.name = 'BudgetUnitMismatch';
	}
}

export class BudgetPerCallExceeded extends Error {
	readonly code = 'BUDGET_PER_CALL_EXCEEDED';
	constructor(
		public readonly category: string,
		public readonly estimate: number,
		public readonly perCallCap: number,
		public readonly unit: Unit,
	) {
		super(
			`Per-call cap exceeded for ${category}: estimate ${estimate} ${unit} > cap ${perCallCap} ${unit}`,
		);
		this.name = 'BudgetPerCallExceeded';
	}
}

export class BudgetHardCapExceeded extends Error {
	readonly code = 'BUDGET_HARD_CAP_EXCEEDED';
	constructor(
		public readonly category: string,
		public readonly window: 'daily' | 'weekly',
		public readonly projected: number,
		public readonly hardCap: number,
		public readonly unit: Unit,
	) {
		super(
			`${window} hard cap exceeded for ${category}: projected ${projected} ${unit} > cap ${hardCap} ${unit}`,
		);
		this.name = 'BudgetHardCapExceeded';
	}
}

export class BudgetSoftCapDeclined extends Error {
	readonly code = 'BUDGET_SOFT_CAP_DECLINED';
	constructor(
		public readonly category: string,
		public readonly window: 'daily' | 'weekly',
	) {
		super(`User declined soft-cap approval for ${category} (${window}).`);
		this.name = 'BudgetSoftCapDeclined';
	}
}
