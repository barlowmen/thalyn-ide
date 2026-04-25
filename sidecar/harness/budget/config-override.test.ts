/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	BudgetConfigError,
	loadBudgetConfigWithOverride,
	mergeBudgetConfig,
	parseBudgetConfig,
	parseBudgetOverride,
} from './config.js';

const DEFAULTS_YAML = [
	'version: 1',
	'categories:',
	'  subagent_opus:',
	'    unit: usd',
	'    per_call_cap: 5.0',
	'    preflight_prompt_cap: 2.0',
	'    daily_soft_cap: 30.0',
	'    daily_hard_cap: 60.0',
	'    weekly_soft_cap: 180.0',
	'    weekly_hard_cap: 360.0',
	'  search_brave:',
	'    unit: usd',
	'    per_call_cap: 0.05',
	'    daily_soft_cap: 1.0',
	'    daily_hard_cap: 2.0',
	'    weekly_soft_cap: 5.0',
	'    weekly_hard_cap: 10.0',
].join('\n');

describe('mergeBudgetConfig', () => {
	const defaults = parseBudgetConfig(DEFAULTS_YAML);

	it('returns defaults when override is empty', () => {
		const merged = mergeBudgetConfig(defaults, {});
		expect(merged.categories.subagent_opus.daily_soft_cap).toBe(30);
	});

	it('overrides individual fields without disturbing siblings', () => {
		const merged = mergeBudgetConfig(defaults, {
			categories: {
				subagent_opus: { daily_soft_cap: 20, daily_hard_cap: 40 },
			},
		});
		expect(merged.categories.subagent_opus.daily_soft_cap).toBe(20);
		expect(merged.categories.subagent_opus.daily_hard_cap).toBe(40);
		// Untouched fields fall through.
		expect(merged.categories.subagent_opus.per_call_cap).toBe(5);
		expect(merged.categories.subagent_opus.weekly_soft_cap).toBe(180);
		expect(merged.categories.subagent_opus.preflight_prompt_cap).toBe(2);
		// Other categories untouched.
		expect(merged.categories.search_brave.daily_hard_cap).toBe(2);
	});

	it('lets the user remove a preflight cap', () => {
		const merged = mergeBudgetConfig(defaults, {
			categories: {
				subagent_opus: { preflight_prompt_cap: undefined },
			},
		});
		expect(merged.categories.subagent_opus.preflight_prompt_cap).toBeUndefined();
	});

	it('rejects unknown category in override', () => {
		expect(() =>
			mergeBudgetConfig(defaults, {
				categories: { subageny_opus: { daily_soft_cap: 99 } },
			}),
		).toThrow(/unknown category/i);
	});

	it('rejects unit mismatch with defaults', () => {
		expect(() =>
			mergeBudgetConfig(defaults, {
				categories: { subagent_opus: { unit: 'gpu_seconds' } },
			}),
		).toThrow(/cannot change unit/i);
	});

	it('rejects daily soft > hard inversion after merge', () => {
		expect(() =>
			mergeBudgetConfig(defaults, {
				categories: { subagent_opus: { daily_soft_cap: 999 } },
			}),
		).toThrow(/daily_soft_cap .* not exceed/i);
	});

	it('rejects weekly soft > hard inversion after merge', () => {
		expect(() =>
			mergeBudgetConfig(defaults, {
				categories: { subagent_opus: { weekly_soft_cap: 9999 } },
			}),
		).toThrow(/weekly_soft_cap .* not exceed/i);
	});

	it('rejects preflight_prompt_cap > per_call_cap after merge', () => {
		expect(() =>
			mergeBudgetConfig(defaults, {
				categories: { subagent_opus: { preflight_prompt_cap: 99 } },
			}),
		).toThrow(/preflight_prompt_cap .* per_call_cap/i);
	});
});

describe('parseBudgetOverride', () => {
	it('handles empty source', () => {
		expect(parseBudgetOverride('')).toEqual({});
	});

	it('rejects unsupported version', () => {
		expect(() => parseBudgetOverride('version: 2\ncategories: {}')).toThrow(/version/i);
	});

	it('rejects negative cap fields', () => {
		expect(() =>
			parseBudgetOverride('categories:\n  subagent_opus:\n    daily_soft_cap: -1'),
		).toThrow(BudgetConfigError);
	});

	it('rejects unknown unit values', () => {
		expect(() =>
			parseBudgetOverride('categories:\n  subagent_opus:\n    unit: euros'),
		).toThrow(/unknown unit/i);
	});

	it('parses partial overrides cleanly', () => {
		const out = parseBudgetOverride([
			'categories:',
			'  subagent_opus:',
			'    daily_soft_cap: 25',
			'    daily_hard_cap: 50',
		].join('\n'));
		expect(out.categories?.subagent_opus).toEqual({ daily_soft_cap: 25, daily_hard_cap: 50 });
	});
});

describe('loadBudgetConfigWithOverride', () => {
	let tmp: string;
	let defaultsPath: string;
	let overridePath: string;

	beforeEach(async () => {
		tmp = mkdtempSync(join(tmpdir(), 'thalyn-budget-merge-'));
		defaultsPath = join(tmp, 'budgets.yaml');
		overridePath = join(tmp, 'override.yaml');
		await writeFile(defaultsPath, DEFAULTS_YAML, 'utf8');
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it('returns defaults when no override path is supplied', async () => {
		const cfg = await loadBudgetConfigWithOverride(defaultsPath);
		expect(cfg.categories.subagent_opus.daily_soft_cap).toBe(30);
	});

	it('returns defaults when override file is missing on disk', async () => {
		const cfg = await loadBudgetConfigWithOverride(defaultsPath, overridePath);
		expect(cfg.categories.subagent_opus.daily_soft_cap).toBe(30);
	});

	it('merges override on top when present', async () => {
		await writeFile(
			overridePath,
			[
				'categories:',
				'  subagent_opus:',
				'    daily_soft_cap: 12',
			].join('\n'),
			'utf8',
		);
		const cfg = await loadBudgetConfigWithOverride(defaultsPath, overridePath);
		expect(cfg.categories.subagent_opus.daily_soft_cap).toBe(12);
		expect(cfg.categories.subagent_opus.daily_hard_cap).toBe(60);
	});

	it('fails fast on invalid override', async () => {
		await writeFile(
			overridePath,
			[
				'categories:',
				'  unknown_cat:',
				'    daily_soft_cap: 1.0',
			].join('\n'),
			'utf8',
		);
		await expect(loadBudgetConfigWithOverride(defaultsPath, overridePath)).rejects.toThrow(
			/unknown category/i,
		);
	});
});
