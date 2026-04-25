/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Attributes } from '@opentelemetry/api';

import type { Reservation } from '../budget/types';

/**
 * Build the GenAI semantic-convention attribute set for a brain call.
 * Centralised so the adapter and any future LLM-call site agree on the
 * same shape (the SQLite exporter and external observability backends
 * key off these attribute names verbatim).
 *
 * `gen_ai.system` follows the convention's vocabulary — `anthropic`,
 * `google.gemini`, `xai.grok`, `meta.llama`. Pass the string the
 * provider's spec uses; this helper does not normalise.
 */
export function buildGenAiAttributes(input: GenAiAttributesInput): Attributes {
	const attrs: Attributes = {
		'gen_ai.system': input.system,
		'gen_ai.operation.name': 'chat',
		'gen_ai.request.model': input.requestModel,
		'thalyn.session.id': input.sessionId,
		'thalyn.budget.category': input.reservation.category,
		'thalyn.budget.unit': input.reservation.unit,
		'thalyn.budget.estimated': input.reservation.estimated,
		'thalyn.budget.reservation_id': String(input.reservation.id),
	};
	if (input.maxOutputTokens !== undefined) {
		attrs['gen_ai.request.max_tokens'] = input.maxOutputTokens;
	}
	if (input.inputTokens !== undefined) {
		attrs['gen_ai.usage.input_tokens'] = input.inputTokens;
	}
	return attrs;
}

/** Attributes added at span end once the call's actual cost + outcome are known. */
export function buildGenAiCompletionAttributes(input: GenAiCompletionAttributesInput): Attributes {
	const attrs: Attributes = {};
	if (input.responseModel !== undefined) {
		attrs['gen_ai.response.model'] = input.responseModel;
	}
	if (input.outputTokens !== undefined) {
		attrs['gen_ai.usage.output_tokens'] = input.outputTokens;
	}
	if (input.finishReason !== undefined) {
		attrs['gen_ai.response.finish_reasons'] = [input.finishReason];
	}
	if (input.actualCost !== undefined) {
		attrs['thalyn.budget.actual'] = input.actualCost;
	}
	return attrs;
}

export interface GenAiAttributesInput {
	readonly system: string;
	readonly requestModel: string;
	readonly sessionId: string;
	readonly reservation: Reservation;
	readonly inputTokens?: number;
	readonly maxOutputTokens?: number;
}

export interface GenAiCompletionAttributesInput {
	readonly responseModel?: string;
	readonly outputTokens?: number;
	readonly finishReason?: string;
	readonly actualCost?: number;
}
