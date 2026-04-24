/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';

import { DefaultEstimator, EstimatorInputError } from './estimator.js';
import { BudgetUnknownCategory } from './types.js';

const est = new DefaultEstimator();

describe('DefaultEstimator', () => {
	it('estimates an Opus chat call at input + output-ceiling pricing', () => {
		const result = est.estimate('subagent_opus', {
			model: 'claude-opus-4-7',
			inputTokens: 50_000,
			maxOutputTokens: 5_000,
		});
		// 50k * 15 / 1M = 0.75; 5k * 75 / 1M = 0.375; sum = 1.125.
		expect(result.unit).toBe('usd');
		expect(result.value).toBeCloseTo(1.125, 6);
		expect(result.breakdown).toEqual({ inputTokens: 50_000, outputTokens: 5_000 });
	});

	it('charges flat fee per search call', () => {
		const result = est.estimate('search_brave', { count: 3 });
		expect(result.unit).toBe('usd');
		expect(result.value).toBeCloseTo(0.009, 6);
	});

	it('defaults flat-fee count to 1', () => {
		const result = est.estimate('search_brave', {});
		expect(result.value).toBeCloseTo(0.003, 6);
	});

	it('estimates TTS by character count', () => {
		const result = est.estimate('elevenlabs_tts', { characters: 1_000 });
		expect(result.value).toBeCloseTo(0.3, 6);
	});

	it('estimates local inference in gpu_seconds', () => {
		const result = est.estimate('local_inference', {
			model: 'llama-3.3-70b',
			maxOutputTokens: 500,
		});
		expect(result.unit).toBe('gpu_seconds');
		expect(result.value).toBeCloseTo(50, 6);
	});

	it('throws on unknown category', () => {
		expect(() => est.estimate('not_a_category', {})).toThrow(BudgetUnknownCategory);
	});

	it('throws on missing required fields', () => {
		expect(() => est.estimate('subagent_opus', { model: 'claude-opus-4-7' })).toThrow(
			EstimatorInputError,
		);
		expect(() => est.estimate('elevenlabs_tts', {})).toThrow(EstimatorInputError);
	});

	it('throws on unknown model', () => {
		expect(() =>
			est.estimate('subagent_opus', { model: 'claude-omega-99', inputTokens: 10 }),
		).toThrow(EstimatorInputError);
	});
});
