/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';

import { BudgetConfigError, parseBudgetConfig } from './config.js';

const VALID = [
	'version: 1',
	'categories:',
	'  subagent_opus:',
	'    unit: usd',
	'    per_call_cap: 5.0',
	'    daily_soft_cap: 30.0',
	'    daily_hard_cap: 60.0',
	'    weekly_soft_cap: 180.0',
	'    weekly_hard_cap: 360.0',
].join('\n');

describe('parseBudgetConfig', () => {
	it('parses a valid document', () => {
		const cfg = parseBudgetConfig(VALID);
		expect(cfg.version).toBe(1);
		expect(cfg.categories.subagent_opus.unit).toBe('usd');
		expect(cfg.categories.subagent_opus.daily_hard_cap).toBe(60);
	});

	it('rejects unknown units', () => {
		const bad = VALID.replace('unit: usd', 'unit: euros');
		expect(() => parseBudgetConfig(bad)).toThrow(BudgetConfigError);
	});

	it('rejects soft_cap > hard_cap inversions (daily)', () => {
		const bad = VALID.replace('daily_soft_cap: 30.0', 'daily_soft_cap: 90.0');
		expect(() => parseBudgetConfig(bad)).toThrow(/daily_soft_cap .* exceed/);
	});

	it('rejects soft_cap > hard_cap inversions (weekly)', () => {
		const bad = VALID.replace('weekly_soft_cap: 180.0', 'weekly_soft_cap: 500.0');
		expect(() => parseBudgetConfig(bad)).toThrow(/weekly_soft_cap .* exceed/);
	});

	it('rejects negative caps', () => {
		const bad = VALID.replace('per_call_cap: 5.0', 'per_call_cap: -1.0');
		expect(() => parseBudgetConfig(bad)).toThrow(BudgetConfigError);
	});

	it('rejects a missing cap field', () => {
		const bad = VALID.replace('weekly_hard_cap: 360.0', '');
		expect(() => parseBudgetConfig(bad)).toThrow(/weekly_hard_cap/);
	});

	it('rejects an unsupported version', () => {
		const bad = VALID.replace('version: 1', 'version: 2');
		expect(() => parseBudgetConfig(bad)).toThrow(/version/);
	});

	it('parses preflight_prompt_cap when present', () => {
		const withPreflight = VALID + '\n    preflight_prompt_cap: 2.0';
		const cfg = parseBudgetConfig(withPreflight);
		expect(cfg.categories.subagent_opus.preflight_prompt_cap).toBe(2.0);
	});

	it('omits preflight_prompt_cap when absent', () => {
		const cfg = parseBudgetConfig(VALID);
		expect(cfg.categories.subagent_opus.preflight_prompt_cap).toBeUndefined();
	});

	it('rejects preflight_prompt_cap that exceeds per_call_cap', () => {
		const bad = VALID + '\n    preflight_prompt_cap: 6.0';
		expect(() => parseBudgetConfig(bad)).toThrow(/preflight_prompt_cap .* per_call_cap/);
	});

	it('rejects negative preflight_prompt_cap', () => {
		const bad = VALID + '\n    preflight_prompt_cap: -0.5';
		expect(() => parseBudgetConfig(bad)).toThrow(/preflight_prompt_cap/);
	});

	it('loads the day-one categories from the committed budgets.yaml', async () => {
		const { readFile } = await import('node:fs/promises');
		const { resolve } = await import('node:path');
		const yamlPath = resolve(__dirname, '../../config/budgets.yaml');
		const cfg = parseBudgetConfig(await readFile(yamlPath, 'utf8'));
		expect(Object.keys(cfg.categories)).toEqual(
			expect.arrayContaining([
				'subagent_opus',
				'subagent_sonnet',
				'subagent_haiku',
				'browser_loop',
				'gemini',
				'grok',
				'search_brave',
				'search_perplexity',
				'elevenlabs_tts',
				'document_gen',
				'local_inference',
			]),
		);
		expect(cfg.categories.local_inference.unit).toBe('gpu_seconds');
		expect(cfg.categories.subagent_haiku.daily_hard_cap).toBe(0);
	});
});
