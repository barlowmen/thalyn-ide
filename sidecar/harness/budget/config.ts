/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';

import type { BudgetConfig, CategoryCaps, Unit } from './types';

/**
 * Optional user override loaded from `~/.config/thalyn/budgets.yaml`.
 * Categories absent from the override are taken from the committed
 * defaults verbatim; categories present override only the fields they
 * declare — `daily_soft_cap` alone replaces just that field. Adding
 * categories that aren't in the committed file is rejected so a typo
 * (`subagentopus:` instead of `subagent_opus:`) fails fast rather than
 * silently registering a brand-new category nothing meters against.
 */
export interface BudgetOverride {
	readonly version?: 1;
	readonly categories?: Readonly<Record<string, Partial<CategoryCaps> | null>>;
}

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
 * Load and parse `sidecar/config/budgets.yaml`. Pair with
 * {@link loadBudgetConfigWithOverride} when the optional user override
 * should layer on top.
 */
export async function loadBudgetConfig(path: string): Promise<BudgetConfig> {
	const contents = await readFile(path, 'utf8');
	return parseBudgetConfig(contents);
}

/**
 * Parse a user override document. Partial — missing categories or
 * fields are allowed. Type and shape errors fail loudly; cap inversions
 * and preflight-vs-per-call invariants are enforced after merge so a
 * partial override that flips an inversion in the committed defaults
 * is still caught.
 */
export function parseBudgetOverride(source: string): BudgetOverride {
	const trimmed = source.trim();
	if (trimmed.length === 0) {
		return {};
	}
	const raw: unknown = parseYaml(source);
	if (raw === null || raw === undefined) {
		return {};
	}
	if (typeof raw !== 'object') {
		throw new BudgetConfigError('User budgets.yaml override must be a YAML mapping.');
	}
	const r = raw as Record<string, unknown>;
	if (r.version !== undefined && r.version !== 1) {
		throw new BudgetConfigError(
			`Unsupported budgets.yaml override version: ${String(r.version)} (expected 1).`,
		);
	}
	const out: BudgetOverride = { version: 1 };
	if (r.categories === undefined || r.categories === null) {
		return out;
	}
	if (typeof r.categories !== 'object') {
		throw new BudgetConfigError('User budgets.yaml override `categories` must be a mapping.');
	}
	const categories: Record<string, Partial<CategoryCaps> | null> = {};
	for (const [name, value] of Object.entries(r.categories as Record<string, unknown>)) {
		categories[name] = validateOverrideCategory(name, value);
	}
	return { ...out, categories };
}

/**
 * Deep-merge a user override into a validated defaults config. Per
 * category, override fields replace individual default fields; absent
 * fields fall through to the default. Adding a category not present
 * in defaults is rejected; setting `unit` to a different value than
 * defaults is rejected; inverted soft/hard caps and a
 * preflight > per-call inversion in the merged result are all
 * rejected so the merge can never weaken the invariants
 * {@link parseBudgetConfig} guarantees.
 */
export function mergeBudgetConfig(
	defaults: BudgetConfig,
	override: BudgetOverride,
): BudgetConfig {
	const merged: Record<string, CategoryCaps> = { ...defaults.categories };
	const overrideCats = override.categories ?? {};
	for (const [name, patch] of Object.entries(overrideCats)) {
		const base = defaults.categories[name];
		if (!base) {
			throw new BudgetConfigError(
				`User budgets.yaml override declares unknown category ${name} (not present in committed defaults).`,
			);
		}
		if (patch === null || patch === undefined) {
			continue;
		}
		merged[name] = mergeCategory(name, base, patch);
	}
	return { version: 1, categories: merged };
}

/**
 * Load committed defaults from `defaultsPath` and (if present) merge
 * the optional user override at `overridePath`. A missing override
 * file is normal — most users will tune defaults directly in the
 * committed YAML, and the override is for unsynced per-machine tuning.
 */
export async function loadBudgetConfigWithOverride(
	defaultsPath: string,
	overridePath?: string,
): Promise<BudgetConfig> {
	const defaults = await loadBudgetConfig(defaultsPath);
	if (!overridePath) {
		return defaults;
	}
	let overrideSource: string;
	try {
		overrideSource = await readFile(overridePath, 'utf8');
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
			return defaults;
		}
		throw e;
	}
	const override = parseBudgetOverride(overrideSource);
	return mergeBudgetConfig(defaults, override);
}

function validateOverrideCategory(name: string, raw: unknown): Partial<CategoryCaps> {
	if (raw === null || raw === undefined) {
		return {};
	}
	if (typeof raw !== 'object') {
		throw new BudgetConfigError(`Override category ${name} must be a mapping.`);
	}
	const r = raw as Record<string, unknown>;
	const out: Partial<CategoryCaps> = {};
	if (r.unit !== undefined) {
		if (typeof r.unit !== 'string' || !KNOWN_UNITS.includes(r.unit as Unit)) {
			throw new BudgetConfigError(
				`Override category ${name} declares unknown unit ${String(r.unit)} (expected one of ${KNOWN_UNITS.join(', ')}).`,
			);
		}
		(out as { unit: Unit }).unit = r.unit as Unit;
	}
	for (const field of CAP_FIELDS) {
		if (r[field] === undefined) {
			continue;
		}
		const v = r[field];
		if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
			throw new BudgetConfigError(
				`Override category ${name}.${field} must be a non-negative finite number (got ${String(v)}).`,
			);
		}
		(out as Record<string, number>)[field] = v;
	}
	if (r.preflight_prompt_cap !== undefined) {
		const v = r.preflight_prompt_cap;
		if (v === null) {
			(out as { preflight_prompt_cap?: number }).preflight_prompt_cap = undefined;
		} else if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
			throw new BudgetConfigError(
				`Override category ${name}.preflight_prompt_cap must be a non-negative finite number or null (got ${String(v)}).`,
			);
		} else {
			(out as { preflight_prompt_cap: number }).preflight_prompt_cap = v;
		}
	}
	return out;
}

function mergeCategory(name: string, base: CategoryCaps, patch: Partial<CategoryCaps>): CategoryCaps {
	if (patch.unit !== undefined && patch.unit !== base.unit) {
		throw new BudgetConfigError(
			`Override category ${name} cannot change unit from ${base.unit} to ${patch.unit}.`,
		);
	}
	const merged: CategoryCaps = {
		unit: base.unit,
		per_call_cap: patch.per_call_cap ?? base.per_call_cap,
		daily_soft_cap: patch.daily_soft_cap ?? base.daily_soft_cap,
		daily_hard_cap: patch.daily_hard_cap ?? base.daily_hard_cap,
		weekly_soft_cap: patch.weekly_soft_cap ?? base.weekly_soft_cap,
		weekly_hard_cap: patch.weekly_hard_cap ?? base.weekly_hard_cap,
		...resolvePreflight(base, patch),
	};
	if (merged.daily_soft_cap > merged.daily_hard_cap) {
		throw new BudgetConfigError(
			`Override category ${name}: daily_soft_cap (${merged.daily_soft_cap}) must not exceed daily_hard_cap (${merged.daily_hard_cap}).`,
		);
	}
	if (merged.weekly_soft_cap > merged.weekly_hard_cap) {
		throw new BudgetConfigError(
			`Override category ${name}: weekly_soft_cap (${merged.weekly_soft_cap}) must not exceed weekly_hard_cap (${merged.weekly_hard_cap}).`,
		);
	}
	if (merged.preflight_prompt_cap !== undefined && merged.preflight_prompt_cap > merged.per_call_cap) {
		throw new BudgetConfigError(
			`Override category ${name}: preflight_prompt_cap (${merged.preflight_prompt_cap}) must not exceed per_call_cap (${merged.per_call_cap}).`,
		);
	}
	return merged;
}

function resolvePreflight(
	base: CategoryCaps,
	patch: Partial<CategoryCaps>,
): { preflight_prompt_cap?: number } {
	if (!Object.prototype.hasOwnProperty.call(patch, 'preflight_prompt_cap')) {
		return base.preflight_prompt_cap !== undefined
			? { preflight_prompt_cap: base.preflight_prompt_cap }
			: {};
	}
	const v = patch.preflight_prompt_cap;
	if (v === undefined) {
		return {};
	}
	return { preflight_prompt_cap: v };
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
