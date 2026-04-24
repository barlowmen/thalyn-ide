/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';

import { FLAT_FEE_USD, GPU_DECODE_RATE, MODEL_PRICING, TTS_USD_PER_CHAR } from './pricing.js';

describe('pricing table magnitude guards', () => {
	it('every model price is in a plausible USD/MTok range', () => {
		// Anthropic, Google, and xAI all quote flagship model prices in the
		// single-digit to double-digit $/MTok range. Anything outside [0.05,
		// 200] is almost certainly a missing decimal point. A silent
		// off-by-1000 here under-reports spend by 1000× for the model's
		// lifetime — the guard exists because a hand-rolled table only
		// stays safe when a test enforces sanity.
		for (const [model, price] of Object.entries(MODEL_PRICING)) {
			expect(price.inputPerMTok, `${model} inputPerMTok`).toBeGreaterThan(0.05);
			expect(price.inputPerMTok, `${model} inputPerMTok`).toBeLessThan(200);
			expect(price.outputPerMTok, `${model} outputPerMTok`).toBeGreaterThan(0.05);
			expect(price.outputPerMTok, `${model} outputPerMTok`).toBeLessThan(500);
			expect(
				price.outputPerMTok,
				`${model}: output pricing below input pricing is almost always a typo`,
			).toBeGreaterThanOrEqual(price.inputPerMTok);
		}
	});

	it('flat-fee entries are in cents-per-call range', () => {
		for (const [key, value] of Object.entries(FLAT_FEE_USD)) {
			expect(value, key).toBeGreaterThan(0);
			expect(value, key).toBeLessThan(1);
		}
	});

	it('TTS rates are in $/char (not $/1k-char)', () => {
		for (const [key, value] of Object.entries(TTS_USD_PER_CHAR)) {
			expect(value, key).toBeGreaterThan(0);
			expect(value, key).toBeLessThan(0.01);
		}
	});

	it('GPU decode rates are in seconds-per-token, not per-second', () => {
		for (const [model, rate] of Object.entries(GPU_DECODE_RATE)) {
			expect(rate, model).toBeGreaterThan(0);
			expect(rate, model).toBeLessThan(5);
		}
	});
});
