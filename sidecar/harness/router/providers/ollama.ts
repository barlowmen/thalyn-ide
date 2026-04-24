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
 * Narrow view of the `ollama` package's client. Injected so tests can
 * substitute a fake and so the provider's contract is the shape we
 * control — not whatever `ollama`'s type surface happens to be at any
 * given version.
 */
export interface OllamaClient {
	chat(request: OllamaChatRequest & { stream?: false }): Promise<OllamaChatResponse>;
	chat(request: OllamaChatRequest & { stream: true }): Promise<AsyncIterable<OllamaChatResponse>>;
}

export interface OllamaChatRequest {
	readonly model: string;
	readonly messages: ReadonlyArray<OllamaMessage>;
	readonly tools?: ReadonlyArray<OllamaTool>;
	readonly options?: { temperature?: number; num_predict?: number };
}

export interface OllamaMessage {
	readonly role: 'system' | 'user' | 'assistant' | 'tool';
	readonly content: string;
	readonly tool_calls?: ReadonlyArray<{ function: { name: string; arguments: Record<string, unknown> } }>;
}

export interface OllamaTool {
	readonly type: 'function';
	readonly function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface OllamaChatResponse {
	readonly model?: string;
	readonly done?: boolean;
	readonly done_reason?: string;
	readonly message?: {
		role: string;
		content?: string;
		tool_calls?: ReadonlyArray<{ function: { name: string; arguments: Record<string, unknown> } }>;
	};
	readonly prompt_eval_count?: number;
	readonly eval_count?: number;
}

export interface OllamaProviderOptions {
	readonly client: OllamaClient;
	readonly defaultModel?: string;
}

/**
 * Ollama provider. Owning the JSON-Schema → Ollama-tool translation
 * here — rather than relying on a cross-provider abstraction — means
 * Llama-family quirks in tool-call response shape get fixed in our
 * code instead of in a third-party package's backlog.
 */
export class OllamaProvider implements LlmProvider {
	readonly name = 'ollama';
	private readonly defaultModel: string;
	private callIdCounter = 0;

	constructor(private readonly opts: OllamaProviderOptions) {
		this.defaultModel = opts.defaultModel ?? 'llama3.1:8b';
	}

	async generate(request: LlmRequest): Promise<LlmGenerateResult> {
		const req = this.buildRequest(request);
		try {
			const response = await this.opts.client.chat(req);
			return this.fromResponse(response, req.model);
		} catch (err) {
			throw translate(err);
		}
	}

	async *stream(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
		const req = { ...this.buildRequest(request), stream: true as const };
		let iterator: AsyncIterable<OllamaChatResponse>;
		try {
			iterator = await this.opts.client.chat(req);
		} catch (err) {
			throw translate(err);
		}

		let text = '';
		let stopReason: string | undefined;
		const toolCalls: LlmToolCall[] = [];
		let inputTokens: number | undefined;
		let outputTokens: number | undefined;

		try {
			for await (const chunk of iterator) {
				if (request.signal?.aborted) {
					throw new LlmError('cancelled', 'Caller aborted the request.', false);
				}
				if (chunk.message?.content) {
					text += chunk.message.content;
					yield { kind: 'text', text: chunk.message.content };
				}
				for (const tc of chunk.message?.tool_calls ?? []) {
					const call = this.mintToolCall(tc.function.name, tc.function.arguments);
					toolCalls.push(call);
					yield { kind: 'tool_call', call };
				}
				if (chunk.done) {
					stopReason = chunk.done_reason;
					inputTokens = chunk.prompt_eval_count ?? inputTokens;
					outputTokens = chunk.eval_count ?? outputTokens;
				}
			}
		} catch (err) {
			if (err instanceof LlmError) {
				throw err;
			}
			throw translate(err);
		}

		yield {
			kind: 'done',
			result: {
				text,
				toolCalls,
				stopReason,
				model: req.model,
				usage: inputTokens !== undefined || outputTokens !== undefined
					? { inputTokens, outputTokens }
					: undefined,
			},
		};
	}

	private buildRequest(request: LlmRequest): OllamaChatRequest {
		const req: OllamaChatRequest = {
			model: request.options?.model ?? this.defaultModel,
			messages: request.messages.map(toOllamaMessage),
			tools: request.tools?.map(toOllamaTool),
			options: (request.options?.temperature !== undefined || request.options?.maxOutputTokens !== undefined)
				? {
					temperature: request.options.temperature,
					num_predict: request.options.maxOutputTokens,
				}
				: undefined,
		};
		return req;
	}

	private mintToolCall(name: string, args: Record<string, unknown>): LlmToolCall {
		this.callIdCounter = (this.callIdCounter + 1) % Number.MAX_SAFE_INTEGER;
		return { id: `ollama_${name}_${this.callIdCounter}`, name, args: args ?? {} };
	}

	private fromResponse(response: OllamaChatResponse, model: string): LlmGenerateResult {
		const text = response.message?.content ?? '';
		const toolCalls: LlmToolCall[] = (response.message?.tool_calls ?? []).map(tc =>
			this.mintToolCall(tc.function.name, tc.function.arguments),
		);
		return {
			text,
			toolCalls,
			stopReason: response.done_reason,
			model: response.model ?? model,
			usage: response.prompt_eval_count !== undefined || response.eval_count !== undefined
				? { inputTokens: response.prompt_eval_count, outputTokens: response.eval_count }
				: undefined,
		};
	}
}

function toOllamaMessage(m: LlmMessage): OllamaMessage {
	if (m.role === 'assistant' && m.toolCalls?.length) {
		return {
			role: 'assistant',
			content: m.content,
			tool_calls: m.toolCalls.map(tc => ({ function: { name: tc.name, arguments: tc.args } })),
		};
	}
	return { role: m.role, content: m.content };
}

function toOllamaTool(tool: LlmToolDef): OllamaTool {
	return {
		type: 'function',
		function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
	};
}

function translate(err: unknown): LlmError {
	if (err instanceof LlmError) {
		return err;
	}
	const message = err instanceof Error ? err.message : String(err);
	const lower = message.toLowerCase();
	if (lower.includes('econnrefused') || lower.includes('fetch failed') || lower.includes('enotfound')) {
		return new LlmError('network', `Ollama daemon unreachable: ${message}`, true, err);
	}
	if (lower.includes('model not found') || lower.includes('does not exist')) {
		return new LlmError('tool_schema', message, false, err);
	}
	return new LlmError('unknown', message, false, err);
}
