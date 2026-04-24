/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	LlmError,
	type LlmGenerateResult,
	type LlmProvider,
	type LlmRequest,
	type LlmStreamEvent,
	type LlmToolCall,
	type LlmToolDef,
} from '../types';

/**
 * Narrow view of `@google/generative-ai`'s client surface. Accepting it
 * as an injected dependency lets tests supply a fake and lets the
 * sidecar stay decoupled from the SDK's exact types.
 */
export interface GeminiClient {
	getGenerativeModel(config: { model: string }): GeminiModel;
}

export interface GeminiModel {
	generateContent(request: GeminiGenerateRequest): Promise<{ response: GeminiResponse }>;
	generateContentStream(request: GeminiGenerateRequest): Promise<{
		stream: AsyncIterable<GeminiStreamChunk>;
		response: Promise<GeminiResponse>;
	}>;
}

export interface GeminiGenerateRequest {
	readonly contents: ReadonlyArray<{ role: string; parts: ReadonlyArray<{ text: string }> }>;
	readonly systemInstruction?: { role: 'system'; parts: ReadonlyArray<{ text: string }> };
	readonly tools?: ReadonlyArray<{ functionDeclarations: ReadonlyArray<GeminiFunctionDeclaration> }>;
	readonly generationConfig?: { temperature?: number; maxOutputTokens?: number };
}

export interface GeminiFunctionDeclaration {
	readonly name: string;
	readonly description: string;
	readonly parameters: Record<string, unknown>;
}

export interface GeminiResponse {
	text(): string;
	functionCalls?(): Array<{ name: string; args: Record<string, unknown> }> | undefined;
	usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
	candidates?: Array<{ finishReason?: string }>;
}

export interface GeminiStreamChunk {
	text(): string;
	functionCalls?(): Array<{ name: string; args: Record<string, unknown> }> | undefined;
}

export interface GeminiProviderOptions {
	readonly client: GeminiClient;
	readonly defaultModel?: string;
}

/**
 * Gemini via `@google/generative-ai`. Owns the translation between the
 * router's cross-provider shape (`LlmRequest` / `LlmStreamEvent`) and
 * Gemini's content / function-calling format.
 */
export class GeminiProvider implements LlmProvider {
	readonly name = 'gemini';
	private readonly defaultModel: string;

	constructor(private readonly opts: GeminiProviderOptions) {
		this.defaultModel = opts.defaultModel ?? 'gemini-2.5-flash';
	}

	async generate(request: LlmRequest): Promise<LlmGenerateResult> {
		const modelName = request.options?.model ?? this.defaultModel;
		const model = this.opts.client.getGenerativeModel({ model: modelName });
		const geminiReq = toGeminiRequest(request);
		try {
			const { response } = await this.runSignalAware(
				() => model.generateContent(geminiReq),
				request.signal,
			);
			return fromGeminiResponse(response, modelName);
		} catch (err) {
			throw translate(err);
		}
	}

	async *stream(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
		const modelName = request.options?.model ?? this.defaultModel;
		const model = this.opts.client.getGenerativeModel({ model: modelName });
		const geminiReq = toGeminiRequest(request);
		let streamHandle: Awaited<ReturnType<GeminiModel['generateContentStream']>>;
		try {
			streamHandle = await this.runSignalAware(
				() => model.generateContentStream(geminiReq),
				request.signal,
			);
		} catch (err) {
			throw translate(err);
		}
		try {
			for await (const chunk of streamHandle.stream) {
				if (request.signal?.aborted) {
					throw new LlmError('cancelled', 'Caller aborted the request.', false);
				}
				const text = chunk.text();
				if (text) {
					yield { kind: 'text', text };
				}
				for (const fc of chunk.functionCalls?.() ?? []) {
					yield {
						kind: 'tool_call',
						call: { id: synthesizeCallId(fc.name), name: fc.name, args: fc.args },
					};
				}
			}
			const final = await streamHandle.response;
			yield { kind: 'done', result: fromGeminiResponse(final, modelName) };
		} catch (err) {
			if (err instanceof LlmError) {
				throw err;
			}
			throw translate(err);
		}
	}

	private async runSignalAware<T>(fn: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
		if (!signal) {
			return fn();
		}
		if (signal.aborted) {
			throw new LlmError('cancelled', 'Caller aborted the request.', false);
		}
		return Promise.race([
			fn(),
			new Promise<T>((_, reject) => {
				signal.addEventListener(
					'abort',
					() => reject(new LlmError('cancelled', 'Caller aborted the request.', false)),
					{ once: true },
				);
			}),
		]);
	}
}

function toGeminiRequest(request: LlmRequest): GeminiGenerateRequest {
	const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];
	let systemInstruction: GeminiGenerateRequest['systemInstruction'];
	for (const m of request.messages) {
		if (m.role === 'system') {
			systemInstruction = { role: 'system', parts: [{ text: m.content }] };
			continue;
		}
		if (m.role === 'tool') {
			// Gemini represents tool results as user-turn functionResponse parts;
			// for the simple string-content router shape, surface them as plain
			// text until a worker needs the richer mapping.
			contents.push({ role: 'user', parts: [{ text: m.content }] });
			continue;
		}
		contents.push({
			role: m.role === 'assistant' ? 'model' : 'user',
			parts: [{ text: m.content }],
		});
	}
	const gc: { temperature?: number; maxOutputTokens?: number } = {};
	if (request.options?.temperature !== undefined) {
		gc.temperature = request.options.temperature;
	}
	if (request.options?.maxOutputTokens !== undefined) {
		gc.maxOutputTokens = request.options.maxOutputTokens;
	}
	const out: {
		contents: typeof contents;
		systemInstruction?: GeminiGenerateRequest['systemInstruction'];
		tools?: GeminiGenerateRequest['tools'];
		generationConfig?: GeminiGenerateRequest['generationConfig'];
	} = { contents };
	if (systemInstruction) {
		out.systemInstruction = systemInstruction;
	}
	if (request.tools && request.tools.length > 0) {
		out.tools = [{ functionDeclarations: request.tools.map(toGeminiTool) }];
	}
	if (Object.keys(gc).length > 0) {
		out.generationConfig = gc;
	}
	return out;
}

function toGeminiTool(tool: LlmToolDef): GeminiFunctionDeclaration {
	return {
		name: tool.name,
		description: tool.description,
		parameters: stripJsonSchemaUnsupported(tool.inputSchema),
	};
}

/**
 * Gemini's function-declaration schema is a strict subset of JSON
 * Schema — `$schema`, `additionalProperties`, and a handful of other
 * keywords cause the API to reject the call. Drop them recursively;
 * everything else is passed through untouched.
 */
function stripJsonSchemaUnsupported(schema: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(schema)) {
		if (k === '$schema' || k === 'additionalProperties' || k === 'definitions' || k === '$id') {
			continue;
		}
		if (v && typeof v === 'object' && !Array.isArray(v)) {
			out[k] = stripJsonSchemaUnsupported(v as Record<string, unknown>);
		} else if (Array.isArray(v)) {
			out[k] = v.map(item =>
				item && typeof item === 'object'
					? stripJsonSchemaUnsupported(item as Record<string, unknown>)
					: item,
			);
		} else {
			out[k] = v;
		}
	}
	return out;
}

function fromGeminiResponse(response: GeminiResponse, model: string): LlmGenerateResult {
	const text = response.text();
	const fcs = response.functionCalls?.() ?? [];
	const toolCalls: LlmToolCall[] = fcs.map(fc => ({
		id: synthesizeCallId(fc.name),
		name: fc.name,
		args: fc.args,
	}));
	return {
		text,
		toolCalls,
		model,
		stopReason: response.candidates?.[0]?.finishReason,
		usage: response.usageMetadata && {
			inputTokens: response.usageMetadata.promptTokenCount,
			outputTokens: response.usageMetadata.candidatesTokenCount,
		},
	};
}

let callIdCounter = 0;
function synthesizeCallId(name: string): string {
	callIdCounter = (callIdCounter + 1) % Number.MAX_SAFE_INTEGER;
	return `gemini_${name}_${callIdCounter}`;
}

function translate(err: unknown): LlmError {
	if (err instanceof LlmError) {
		return err;
	}
	const message = err instanceof Error ? err.message : String(err);
	const lower = message.toLowerCase();
	if (lower.includes('api key') || lower.includes('unauthorized') || lower.includes('permission denied')) {
		return new LlmError('auth', message, false, err);
	}
	if (lower.includes('429') || lower.includes('rate limit') || lower.includes('quota')) {
		return new LlmError('rate_limit', message, true, err);
	}
	if (lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('fetch failed') || lower.includes('network')) {
		return new LlmError('network', message, true, err);
	}
	return new LlmError('unknown', message, false, err);
}

// Used by unit tests to reset the synthetic id counter for deterministic
// assertions.
export function __resetCallIdCounterForTests(): void {
	callIdCounter = 0;
}
