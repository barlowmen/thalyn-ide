/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Unit } from './types';

/**
 * Pricing table the estimator consults. Kept deliberately small — one
 * record per model or flat-fee category — so same-day provider-pricing
 * updates land in a file we own.
 *
 * All LLM prices are USD per million tokens. All flat-fee prices are USD
 * per unit described by the category. `local_inference` meters in
 * `gpu_seconds` (see {@link GPU_DECODE_RATE}).
 *
 * Spot-check the totals in `pricing.test.ts`: accidentally typing
 * `0.015` where `15.0` was intended silently under-reports spend by
 * 1000×; the guard test exists because a small typed table is only
 * safe when a review artefact keeps the magnitudes honest.
 */

export interface ModelPricing {
	/** USD per million input tokens. */
	readonly inputPerMTok: number;
	/** USD per million output tokens. */
	readonly outputPerMTok: number;
}

export const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = {
	// Anthropic Claude 4.x — https://www.anthropic.com/pricing (checked 2026-04).
	'claude-opus-4-7': { inputPerMTok: 15.0, outputPerMTok: 75.0 },
	'claude-opus-4-6': { inputPerMTok: 15.0, outputPerMTok: 75.0 },
	'claude-sonnet-4-6': { inputPerMTok: 3.0, outputPerMTok: 15.0 },
	'claude-haiku-4-5': { inputPerMTok: 1.0, outputPerMTok: 5.0 },

	// Google Gemini 2.x — https://ai.google.dev/pricing (checked 2026-04).
	'gemini-2.5-pro': { inputPerMTok: 1.25, outputPerMTok: 10.0 },
	'gemini-2.5-flash': { inputPerMTok: 0.3, outputPerMTok: 2.5 },

	// xAI Grok 4 — https://x.ai/api (checked 2026-04).
	'grok-4': { inputPerMTok: 3.0, outputPerMTok: 15.0 },
	'grok-4-mini': { inputPerMTok: 0.3, outputPerMTok: 0.5 },
};

/** Flat per-call USD for categories that don't meter by token. */
export const FLAT_FEE_USD: Readonly<Record<string, number>> = {
	// Brave Pro tier — ~$0.003/query. Paid per query.
	search_brave: 0.003,
	// Perplexity Sonar — ~$0.005 flat + token fees. This base fee is the
	// floor; the estimator layers the token fee on top for the
	// `search_perplexity` category via a model entry if we ever add one.
	search_perplexity: 0.005,
};

/**
 * USD per character for text-to-speech. ElevenLabs: ~$0.30 per 1000
 * chars on the Creator plan.
 */
export const TTS_USD_PER_CHAR: Readonly<Record<string, number>> = {
	elevenlabs_tts: 0.0003,
};

/**
 * GPU-seconds per output token for `local_inference`. Llama 3.3 70B on
 * M-series hardware sustains ~8-12 tok/s in steady state; at 10 tok/s
 * a 500-token reply is 50 GPU-seconds. The rate is a planning
 * heuristic; replace with measured values once a real run is in hand.
 */
export const GPU_DECODE_RATE: Readonly<Record<string, number>> = {
	'llama-3.3-70b': 0.1, // seconds per output token
};

/**
 * The estimator's per-category dispatch table. Declares the shape the
 * category expects and the unit it meters in.
 */
export type PricingKind =
	| { readonly kind: 'model_tokens'; readonly unit: 'usd' }
	| { readonly kind: 'flat_fee'; readonly unit: 'usd' }
	| { readonly kind: 'tts_chars'; readonly unit: 'usd' }
	| { readonly kind: 'gpu_seconds'; readonly unit: 'gpu_seconds' };

export const CATEGORY_PRICING: Readonly<Record<string, PricingKind>> = {
	subagent_opus: { kind: 'model_tokens', unit: 'usd' },
	subagent_sonnet: { kind: 'model_tokens', unit: 'usd' },
	subagent_haiku: { kind: 'model_tokens', unit: 'usd' },
	browser_loop: { kind: 'model_tokens', unit: 'usd' },
	gemini: { kind: 'model_tokens', unit: 'usd' },
	grok: { kind: 'model_tokens', unit: 'usd' },
	search_brave: { kind: 'flat_fee', unit: 'usd' },
	search_perplexity: { kind: 'flat_fee', unit: 'usd' },
	elevenlabs_tts: { kind: 'tts_chars', unit: 'usd' },
	document_gen: { kind: 'model_tokens', unit: 'usd' },
	local_inference: { kind: 'gpu_seconds', unit: 'gpu_seconds' },
};

/** Helper for the estimator: resolve the {@link Unit} a category reports. */
export function unitForCategory(category: string): Unit | undefined {
	return CATEGORY_PRICING[category]?.unit;
}
