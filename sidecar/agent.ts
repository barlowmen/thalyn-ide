/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CentralBrain, BrainError, BrainMessage, BrainRequest } from './harness/brain/types';
import type { ApprovalGate } from './harness/tools/approval';
import type {
	MessageChunkParams,
	MessageSendParams,
	MessageSendResult,
} from './protocol';
import { getToolDefinition } from './tools';

/**
 * Maps {@link BrainError.kind} to the protocol-level `errorKind` enum
 * the webview understands. The wire shape is narrower than the brain's
 * internal vocabulary (no `tool_schema`); fold the brain-specific kinds
 * into `unknown` so the protocol stays stable.
 */
function brainErrorKind(error: BrainError): NonNullable<MessageSendResult['errorKind']> {
	switch (error.kind) {
		case 'auth':
		case 'rate_limit':
		case 'network':
			return error.kind;
		case 'cancelled':
			return 'declined';
		default:
			return 'unknown';
	}
}

export interface AgentDeps {
	/**
	 * Lazily resolves the {@link CentralBrain} on the first turn. Loaders
	 * may load API keys from Keychain, dynamically import the SDK, and
	 * construct a configured adapter — none of which we want to run
	 * during sidecar bootstrap. Subsequent turns reuse whatever the loader
	 * returned the first time.
	 */
	readonly getBrain: () => Promise<CentralBrain>;
	/** Emits a `message.chunk` notification to the webview. */
	readonly emitChunk: (params: MessageChunkParams) => void;
	/**
	 * Harness-owned approval gate. The brain adapter's permission hook
	 * delegates to this; the gate is the authoritative decision-maker
	 * regardless of which adapter is active.
	 */
	readonly approvalGate: ApprovalGate;
}

/**
 * Orchestrates a single turn against a {@link CentralBrain}.
 *
 * A single in-flight turn is supported. Concurrent `message.send` calls
 * are rejected; multi-turn interleaving belongs in the harness dispatcher,
 * not the agent layer.
 *
 * The Agent is brain-agnostic: it constructs a {@link BrainRequest} from
 * the user's text, drives `brain.send()`, and translates the resulting
 * {@link BrainStreamEvent}s into wire-protocol `message.chunk` events.
 * Anything brain- or SDK-specific (canUseTool wiring, `cwd`/`env`
 * forwarding, error classification) lives in the adapter that implements
 * `CentralBrain`.
 */
export class Agent {
	private activeTurn: string | undefined;
	private cachedBrain: CentralBrain | undefined;

	constructor(private readonly deps: AgentDeps) { }

	async runTurn(params: MessageSendParams): Promise<MessageSendResult> {
		if (this.activeTurn !== undefined) {
			return {
				correlationId: params.correlationId,
				subtype: 'error',
				errorKind: 'unknown',
				errorMessage: 'Another turn is already in progress. Wait for it to finish.',
			};
		}
		this.activeTurn = params.correlationId;

		try {
			return await this.runTurnInner(params);
		} finally {
			this.activeTurn = undefined;
		}
	}

	private async runTurnInner(params: MessageSendParams): Promise<MessageSendResult> {
		let brain: CentralBrain;
		try {
			brain = await this.brain();
		} catch (err) {
			const classification = classifyAgentError(err);
			this.deps.emitChunk({
				correlationId: params.correlationId,
				kind: 'error',
				errorKind: classification.kind,
				errorMessage: classification.message,
			});
			this.deps.emitChunk({ correlationId: params.correlationId, kind: 'done' });
			return {
				correlationId: params.correlationId,
				subtype: 'error',
				errorKind: classification.kind,
				errorMessage: classification.message,
			};
		}

		const request: BrainRequest = {
			system: '',
			messages: [userMessage(params.text)],
			tools: [],
		};

		let sessionId: string | undefined;
		let terminalSubtype: 'success' | 'error' = 'success';
		let errorKind: MessageSendResult['errorKind'];
		let errorMessage: string | undefined;

		try {
			for await (const event of brain.send(request)) {
				switch (event.kind) {
					case 'text':
						this.deps.emitChunk({
							correlationId: params.correlationId,
							kind: 'text',
							text: event.text,
						});
						break;
					case 'tool_use': {
						const def = getToolDefinition(event.call.name);
						this.deps.emitChunk({
							correlationId: params.correlationId,
							kind: 'tool_use',
							toolName: event.call.name,
							toolUseId: event.call.id,
							toolInput: event.call.input,
							toolSummary: def ? def.summarize(event.call.input) : undefined,
						});
						break;
					}
					case 'tool_result':
						this.deps.emitChunk({
							correlationId: params.correlationId,
							kind: 'tool_result',
							toolUseId: event.result.id,
							toolResult: event.result.content,
							toolIsError: event.result.isError,
						});
						break;
					case 'done':
						sessionId = event.sessionId;
						break;
					case 'error':
						terminalSubtype = 'error';
						errorKind = brainErrorKind(event.error);
						errorMessage = event.error.message;
						this.deps.emitChunk({
							correlationId: params.correlationId,
							kind: 'error',
							errorKind,
							errorMessage,
						});
						break;
				}
			}
		} catch (err) {
			const classification = classifyAgentError(err);
			terminalSubtype = 'error';
			errorKind = classification.kind;
			errorMessage = classification.message;
			this.deps.emitChunk({
				correlationId: params.correlationId,
				kind: 'error',
				errorKind: classification.kind,
				errorMessage: classification.message,
			});
		}

		this.deps.emitChunk({
			correlationId: params.correlationId,
			kind: 'done',
		});

		this.deps.approvalGate.cancelForTurn(params.correlationId);

		return {
			correlationId: params.correlationId,
			subtype: terminalSubtype,
			sessionId,
			errorKind,
			errorMessage,
		};
	}

	private async brain(): Promise<CentralBrain> {
		if (!this.cachedBrain) {
			this.cachedBrain = await this.deps.getBrain();
		}
		return this.cachedBrain;
	}
}

function userMessage(text: string): BrainMessage {
	return { role: 'user', content: [{ type: 'text', text }] };
}

/**
 * Classify errors that escape the brain's stream — typically thrown out of
 * the loader (`getBrain`) before the brain ever produced an event. Mirrors
 * the substring tells used by the adapter's classifier so an auth-failure
 * surfacing during keychain lookup is reported the same way as one that
 * surfaces during the SDK call itself.
 */
function classifyAgentError(err: unknown): { kind: NonNullable<MessageSendResult['errorKind']>; message: string } {
	const message = err instanceof Error ? err.message : String(err);
	const lower = message.toLowerCase();
	if (
		lower.includes('401') ||
		lower.includes('unauthorized') ||
		lower.includes('authentication') ||
		lower.includes('api key')
	) {
		return { kind: 'auth', message };
	}
	if (lower.includes('429') || lower.includes('rate limit')) {
		return { kind: 'rate_limit', message };
	}
	if (
		lower.includes('econnrefused') ||
		lower.includes('enotfound') ||
		lower.includes('etimedout') ||
		lower.includes('network') ||
		lower.includes('fetch failed')
	) {
		return { kind: 'network', message };
	}
	return { kind: 'unknown', message };
}
