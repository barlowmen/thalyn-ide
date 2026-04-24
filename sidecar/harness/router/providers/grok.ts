/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	LlmError,
	type LlmGenerateResult,
	type LlmMessage,
	type LlmProvider,
	type LlmRequest,
	type LlmStreamEvent,
	type LlmToolCall,
	type LlmToolDef,
} from '../types';

/**
 * Narrow view of an OpenAI-style chat-completion client pointed at
 * `https://api.x.ai/v1`. Accepted as a dependency so tests can inject
 * a fake. The real implementation wraps `new OpenAI({ apiKey, baseURL:
 * 'https://api.x.ai/v1' })`.
 */
export interface GrokClient {
	chatCompletions: {
		create(request: GrokRequest & { stream?: false }): Promise<GrokResponse>;
		create(request: GrokRequest & { stream: true }): Promise<AsyncIterable<GrokStreamChunk>>;
	};
}

export interface GrokRequest {
	readonly model: string;
	readonly messages: ReadonlyArray<GrokMessage>;
	readonly tools?: ReadonlyArray<GrokTool>;
	readonly temperature?: number;
	readonly max_tokens?: number;
}

export type GrokMessage =
	| { role: 'system' | 'user'; content: string }
	| {
		role: 'assistant';
		content: string | null;
		tool_calls?: ReadonlyArray<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
	}
	| { role: 'tool'; content: string; tool_call_id: string };

export interface GrokTool {
	readonly type: 'function';
	readonly function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface GrokResponse {
	readonly id: string;
	readonly model: string;
	readonly choices: ReadonlyArray<{
		message: {
			content: string | null;
			tool_calls?: ReadonlyArray<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
		};
		finish_reason?: string;
	}>;
	readonly usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface GrokStreamChunk {
	readonly choices: ReadonlyArray<{
		delta: {
			content?: string;
			tool_calls?: ReadonlyArray<{
				index: number;
				id?: string;
				type?: 'function';
				function?: { name?: string; arguments?: string };
			}>;
		};
		finish_reason?: string;
	}>;
	readonly model?: string;
	readonly usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface GrokProviderOptions {
	readonly client: GrokClient;
	readonly defaultModel?: string;
}

/**
 * Grok via xAI's OpenAI-compatible API. The chat-completions shape is
 * stable enough that this is a thin translation; the one real concern
 * is tool_calls streaming, which xAI emits as indexed deltas we
 * reassemble before yielding a `tool_call` event.
 */
export class GrokProvider implements LlmProvider {
	readonly name = 'grok';
	private readonly defaultModel: string;

	constructor(private readonly opts: GrokProviderOptions) {
		this.defaultModel = opts.defaultModel ?? 'grok-4-fast-non-reasoning';
	}

	async generate(request: LlmRequest): Promise<LlmGenerateResult> {
		const req = this.buildRequest(request);
		try {
			const response = await this.opts.client.chatCompletions.create(req);
			return fromGrokResponse(response);
		} catch (err) {
			throw translate(err);
		}
	}

	async *stream(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
		const req = { ...this.buildRequest(request), stream: true as const };
		let iterator: AsyncIterable<GrokStreamChunk>;
		try {
			iterator = await this.opts.client.chatCompletions.create(req);
		} catch (err) {
			throw translate(err);
		}

		const pendingToolCalls = new Map<number, { id?: string; name?: string; argsJson: string }>();
		let text = '';
		let stopReason: string | undefined;
		let model = req.model;
		let inputTokens: number | undefined;
		let outputTokens: number | undefined;

		try {
			for await (const chunk of iterator) {
				if (request.signal?.aborted) {
					throw new LlmError('cancelled', 'Caller aborted the request.', false);
				}
				if (chunk.model) {
					model = chunk.model;
				}
				if (chunk.usage) {
					inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
					outputTokens = chunk.usage.completion_tokens ?? outputTokens;
				}
				const choice = chunk.choices[0];
				if (!choice) {
					continue;
				}
				if (choice.finish_reason) {
					stopReason = choice.finish_reason;
				}
				const delta = choice.delta;
				if (delta.content) {
					text += delta.content;
					yield { kind: 'text', text: delta.content };
				}
				for (const tc of delta.tool_calls ?? []) {
					const slot = pendingToolCalls.get(tc.index) ?? { id: undefined, name: undefined, argsJson: '' };
					if (tc.id) {
						slot.id = tc.id;
					}
					if (tc.function?.name) {
						slot.name = tc.function.name;
					}
					if (tc.function?.arguments) {
						slot.argsJson += tc.function.arguments;
					}
					pendingToolCalls.set(tc.index, slot);
				}
			}
		} catch (err) {
			if (err instanceof LlmError) {
				throw err;
			}
			throw translate(err);
		}

		const toolCalls: LlmToolCall[] = [];
		for (const [, slot] of pendingToolCalls) {
			if (!slot.name) {
				continue;
			}
			const args = safeParseJson(slot.argsJson);
			const call: LlmToolCall = { id: slot.id ?? `grok_${slot.name}_${toolCalls.length}`, name: slot.name, args };
			toolCalls.push(call);
			yield { kind: 'tool_call', call };
		}

		yield {
			kind: 'done',
			result: {
				text,
				toolCalls,
				stopReason,
				model,
				usage: inputTokens !== undefined || outputTokens !== undefined
					? { inputTokens, outputTokens }
					: undefined,
			},
		};
	}

	private buildRequest(request: LlmRequest): GrokRequest {
		const req: GrokRequest = {
			model: request.options?.model ?? this.defaultModel,
			messages: request.messages.map(toGrokMessage),
			tools: request.tools?.map(toGrokTool),
			temperature: request.options?.temperature,
			max_tokens: request.options?.maxOutputTokens,
		};
		return req;
	}
}

function toGrokMessage(m: LlmMessage): GrokMessage {
	if (m.role === 'tool') {
		return { role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content };
	}
	if (m.role === 'assistant') {
		const tool_calls = m.toolCalls?.map(tc => ({
			id: tc.id,
			type: 'function' as const,
			function: { name: tc.name, arguments: JSON.stringify(tc.args) },
		}));
		return { role: 'assistant', content: m.content || null, ...(tool_calls?.length ? { tool_calls } : {}) };
	}
	return { role: m.role, content: m.content };
}

function toGrokTool(tool: LlmToolDef): GrokTool {
	return {
		type: 'function',
		function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
	};
}

function fromGrokResponse(response: GrokResponse): LlmGenerateResult {
	const choice = response.choices[0];
	const toolCalls: LlmToolCall[] = (choice?.message.tool_calls ?? []).map(tc => ({
		id: tc.id,
		name: tc.function.name,
		args: safeParseJson(tc.function.arguments),
	}));
	return {
		text: choice?.message.content ?? '',
		toolCalls,
		stopReason: choice?.finish_reason,
		model: response.model,
		usage: response.usage && {
			inputTokens: response.usage.prompt_tokens,
			outputTokens: response.usage.completion_tokens,
		},
	};
}

function safeParseJson(raw: string): Record<string, unknown> {
	if (!raw) {
		return {};
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
	} catch {
		throw new LlmError('tool_schema', `Grok returned tool_call arguments that are not valid JSON: ${raw}`, false);
	}
}

function translate(err: unknown): LlmError {
	if (err instanceof LlmError) {
		return err;
	}
	const message = err instanceof Error ? err.message : String(err);
	const lower = message.toLowerCase();
	const status = (err as { status?: number })?.status;
	if (status === 401 || status === 403 || lower.includes('unauthorized') || lower.includes('api key')) {
		return new LlmError('auth', message, false, err);
	}
	if (status === 429 || lower.includes('rate limit')) {
		return new LlmError('rate_limit', message, true, err);
	}
	if (lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('fetch failed') || lower.includes('network')) {
		return new LlmError('network', message, true, err);
	}
	return new LlmError('unknown', message, false, err);
}
