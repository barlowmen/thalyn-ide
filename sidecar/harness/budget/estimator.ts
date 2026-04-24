/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	CATEGORY_PRICING,
	FLAT_FEE_USD,
	GPU_DECODE_RATE,
	MODEL_PRICING,
	TTS_USD_PER_CHAR,
} from './pricing';
import { BudgetUnknownCategory, type CallDescriptor, type Estimate } from './types';

/**
 * Produces pre-flight cost estimates. Hand-rolled rather than depending
 * on a third-party pricing package: same-day provider-pricing updates
 * land in a file we own, and gpu_seconds for local inference shares one
 * dispatch path with the USD categories.
 *
 * The estimator is deliberately conservative: output-token estimates
 * assume the call fills its `max_tokens` ceiling so reservations
 * over-shoot; the meter reconciles on commit.
 */
export interface Estimator {
	estimate(category: string, call: CallDescriptor): Estimate;
}

export class DefaultEstimator implements Estimator {
	estimate(category: string, call: CallDescriptor): Estimate {
		const pricing = CATEGORY_PRICING[category];
		if (!pricing) {
			throw new BudgetUnknownCategory(category);
		}

		switch (pricing.kind) {
			case 'model_tokens':
				return this.estimateModelTokens(category, call);
			case 'flat_fee':
				return this.estimateFlatFee(category, call);
			case 'tts_chars':
				return this.estimateTts(category, call);
			case 'gpu_seconds':
				return this.estimateGpuSeconds(category, call);
		}
	}

	private estimateModelTokens(category: string, call: CallDescriptor): Estimate {
		if (!call.model) {
			throw new EstimatorInputError(`${category}: call.model is required for model_tokens categories.`);
		}
		const price = MODEL_PRICING[call.model];
		if (!price) {
			throw new EstimatorInputError(`${category}: no pricing entry for model ${call.model}.`);
		}
		if (typeof call.inputTokens !== 'number') {
			throw new EstimatorInputError(`${category}: call.inputTokens is required.`);
		}
		// Output ceiling is the reservation's conservative upper bound. If
		// the caller didn't provide one, assume zero — model_tokens
		// reservations for zero-output prompts still meter input cost.
		const outputCeiling = call.maxOutputTokens ?? 0;
		const value =
			(call.inputTokens / 1_000_000) * price.inputPerMTok +
			(outputCeiling / 1_000_000) * price.outputPerMTok;
		return {
			unit: 'usd',
			value,
			breakdown: { inputTokens: call.inputTokens, outputTokens: outputCeiling },
		};
	}

	private estimateFlatFee(category: string, _call: CallDescriptor): Estimate {
		const rate = FLAT_FEE_USD[category];
		if (rate === undefined) {
			throw new EstimatorInputError(`${category}: no flat-fee entry.`);
		}
		const count = _call.count ?? 1;
		return {
			unit: 'usd',
			value: rate * count,
			breakdown: { count },
		};
	}

	private estimateTts(category: string, call: CallDescriptor): Estimate {
		const rate = TTS_USD_PER_CHAR[category];
		if (rate === undefined) {
			throw new EstimatorInputError(`${category}: no TTS pricing entry.`);
		}
		if (typeof call.characters !== 'number') {
			throw new EstimatorInputError(`${category}: call.characters is required.`);
		}
		return {
			unit: 'usd',
			value: rate * call.characters,
			breakdown: { characters: call.characters },
		};
	}

	private estimateGpuSeconds(category: string, call: CallDescriptor): Estimate {
		if (!call.model) {
			throw new EstimatorInputError(`${category}: call.model is required for gpu_seconds categories.`);
		}
		const rate = GPU_DECODE_RATE[call.model];
		if (rate === undefined) {
			throw new EstimatorInputError(`${category}: no GPU rate for model ${call.model}.`);
		}
		const outputCeiling = call.maxOutputTokens ?? 0;
		return {
			unit: 'gpu_seconds',
			value: rate * outputCeiling,
			breakdown: { outputTokens: outputCeiling },
		};
	}
}

export class EstimatorInputError extends Error {
	readonly code = 'BUDGET_ESTIMATOR_INPUT';
	constructor(message: string) {
		super(message);
		this.name = 'EstimatorInputError';
	}
}
