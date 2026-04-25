/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';

import type { BudgetConfig, CategoryCaps, Unit } from './types';

const CAP_FIELDS = [
	'per_call_cap',
	'daily_soft_cap',
	'daily_hard_cap',
	'weekly_soft_cap',
	'weekly_hard_cap',
] as const;

const KNOWN_UNITS: readonly Unit[] = ['usd', 'gpu_seconds'];

/**
 * Parse a raw YAML string (either the committed `budgets.yaml` or the
 * optional user override) into a validated {@link BudgetConfig}.
 *
 * Validation is strict by design — a silently-accepted typo in a cap
 * field lets spend drift past the cap the user thought they set, which
 * is exactly the mode we're trying to close. Errors include the
 * offending category/field so the failure is actionable.
 */
export function parseBudgetConfig(source: string): BudgetConfig {
	const raw: unknown = parseYaml(source);
	if (raw === null || typeof raw !== 'object') {
		throw new BudgetConfigError('budgets.yaml must be a YAML mapping.');
	}
	const rawAny = raw as Record<string, unknown>;

	if (rawAny.version !== 1) {
		throw new BudgetConfigError(
			`Unsupported budgets.yaml version: ${String(rawAny.version)} (expected 1).`,
		);
	}

	const categoriesField = rawAny.categories;
	if (categoriesField === undefined || categoriesField === null || typeof categoriesField !== 'object') {
		throw new BudgetConfigError('budgets.yaml must declare a `categories` mapping.');
	}

	const out: Record<string, CategoryCaps> = {};
	for (const [name, value] of Object.entries(categoriesField as Record<string, unknown>)) {
		out[name] = validateCategory(name, value);
	}

	return { version: 1, categories: out };
}

/**
 * Load and parse `sidecar/config/budgets.yaml`. No user-override merge
 * happens here; the rules-loader layers user overrides on top.
 */
export async function loadBudgetConfig(path: string): Promise<BudgetConfig> {
	const contents = await readFile(path, 'utf8');
	return parseBudgetConfig(contents);
}

function validateCategory(name: string, raw: unknown): CategoryCaps {
	if (raw === null || typeof raw !== 'object') {
		throw new BudgetConfigError(`Category ${name} must be a mapping.`);
	}
	const r = raw as Record<string, unknown>;

	const unit = r.unit;
	if (typeof unit !== 'string' || !KNOWN_UNITS.includes(unit as Unit)) {
		throw new BudgetConfigError(
			`Category ${name} has unknown unit ${String(unit)} (expected one of ${KNOWN_UNITS.join(', ')}).`,
		);
	}

	const caps: Record<string, number> = {};
	for (const field of CAP_FIELDS) {
		const v = r[field];
		if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
			throw new BudgetConfigError(
				`Category ${name}.${field} must be a non-negative finite number (got ${String(v)}).`,
			);
		}
		caps[field] = v;
	}

	if (caps.daily_soft_cap > caps.daily_hard_cap) {
		throw new BudgetConfigError(
			`Category ${name}: daily_soft_cap (${caps.daily_soft_cap}) must not exceed daily_hard_cap (${caps.daily_hard_cap}).`,
		);
	}
	if (caps.weekly_soft_cap > caps.weekly_hard_cap) {
		throw new BudgetConfigError(
			`Category ${name}: weekly_soft_cap (${caps.weekly_soft_cap}) must not exceed weekly_hard_cap (${caps.weekly_hard_cap}).`,
		);
	}

	let preflightPromptCap: number | undefined;
	if (r.preflight_prompt_cap !== undefined) {
		const v = r.preflight_prompt_cap;
		if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
			throw new BudgetConfigError(
				`Category ${name}.preflight_prompt_cap must be a non-negative finite number (got ${String(v)}).`,
			);
		}
		if (v > caps.per_call_cap) {
			throw new BudgetConfigError(
				`Category ${name}: preflight_prompt_cap (${v}) must not exceed per_call_cap (${caps.per_call_cap}). Otherwise the per-call hard block fires before the preflight prompt could.`,
			);
		}
		preflightPromptCap = v;
	}

	return {
		unit: unit as Unit,
		per_call_cap: caps.per_call_cap,
		daily_soft_cap: caps.daily_soft_cap,
		daily_hard_cap: caps.daily_hard_cap,
		weekly_soft_cap: caps.weekly_soft_cap,
		weekly_hard_cap: caps.weekly_hard_cap,
		...(preflightPromptCap !== undefined ? { preflight_prompt_cap: preflightPromptCap } : {}),
	};
}

export class BudgetConfigError extends Error {
	readonly code = 'BUDGET_CONFIG_INVALID';
	constructor(message: string) {
		super(message);
		this.name = 'BudgetConfigError';
	}
}
