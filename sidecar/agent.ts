/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ApprovalGate } from './harness/tools/approval';
import type {
	MessageChunkParams,
	MessageSendParams,
	MessageSendResult,
} from './protocol';
import { allowedTools, enabledTools, getToolDefinition } from './tools';

/**
 * Minimal view of `query` from `@anthropic-ai/claude-agent-sdk`. Captured as
 * an interface so tests can inject a fake and so the sidecar doesn't have to
 * import the full SDK surface at type-resolution time.
 *
 * The real `PermissionResult` has more fields than we use here (see
 * `sdk.d.ts`). We model only `behavior`, `updatedInput`, and `message` —
 * the fields our approval bridge actually reads and writes.
 */
export type PermissionResult =
	| { behavior: 'allow'; updatedInput?: Record<string, unknown> }
	| { behavior: 'deny'; message: string };

export type CanUseToolCallback = (
	toolName: string,
	input: Record<string, unknown>,
	options: { signal: AbortSignal; toolUseID: string },
) => Promise<PermissionResult>;

export interface QueryOptions {
	readonly allowedTools?: string[];
	readonly tools?: string[];
	readonly permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';
	readonly canUseTool?: CanUseToolCallback;
	readonly cwd?: string;
	readonly env?: Record<string, string | undefined>;
	readonly abortController?: AbortController;
	readonly model?: string;
	readonly debug?: boolean;
	/**
	 * Restricts which filesystem config sources the SDK loads. Passing `[]`
	 * opts out of `~/.claude/settings.json`, `.claude/settings.json`, and
	 * their local overrides — we do this because those files can carry the
	 * user's own Claude-Code permission allowlists, which would bypass the
	 * harness approval gate.
	 */
	readonly settingSources?: Array<'user' | 'project' | 'local'>;
}

export interface QueryFn {
	(params: { prompt: string; options?: QueryOptions }): AsyncIterable<SdkMessageSurface>;
}

/** Narrow subset of `SDKMessage` the agent module actually inspects. */
export type SdkMessageSurface =
	| {
		type: 'assistant';
		message: { content: Array<SdkContentBlock>; stop_reason?: string | null };
		session_id?: string;
	}
	| {
		type: 'system';
		subtype: 'init';
		session_id?: string;
	}
	| {
		type: 'user';
		message: { content: Array<SdkContentBlock> };
		session_id?: string;
	}
	| {
		type: 'result';
		subtype: 'success' | string;
		session_id?: string;
		result?: string;
		is_error?: boolean;
	};

export type SdkContentBlock =
	| { type: 'text'; text: string }
	| { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
	| { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean }
	| { type: string; [key: string]: unknown };

export interface AgentTurnContext {
	readonly query: QueryFn;
	readonly env: NodeJS.ProcessEnv;
}

export interface AgentDeps {
	/**
	 * Resolves the SDK query function and the env (populated with an API key)
	 * on the first turn. Lets the sidecar defer keychain lookup and the
	 * expensive SDK import until the user actually sends a message, and lets
	 * tests inject a synchronous fake.
	 */
	readonly getTurnContext: () => Promise<AgentTurnContext>;
	/** Emits a `message.chunk` notification to the webview. */
	readonly emitChunk: (params: MessageChunkParams) => void;
	/**
	 * Harness-owned approval gate. The Claude adapter's SDK-level
	 * `canUseTool` hook delegates to this; the hook fires under API-key
	 * auth and is bypassed under OAuth auth by the bundled CLI. The gate
	 * is the authoritative decision-maker in either case.
	 */
	readonly approvalGate: ApprovalGate;
	/** Working directory used for the SDK session. */
	readonly cwd: string;
}

/**
 * Orchestrates a single turn against the Claude Agent SDK.
 *
 * A single in-flight turn is supported. Concurrent `message.send` calls
 * are rejected; multi-turn interleaving belongs in the harness dispatcher,
 * not the adapter.
 */
export class Agent {
	private activeTurn: string | undefined;

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
		let context: AgentTurnContext;
		try {
			context = await this.deps.getTurnContext();
		} catch (err) {
			const classification = classifyError(err);
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

		// Note: when the bundled Claude Code CLI authenticates via OAuth
		// (`claude login`), it currently bypasses the SDK's `canUseTool` /
		// `permissionMode` surface and resolves permissions itself. The
		// hook below stays wired for API-key auth; the harness-level gate
		// is authoritative either way and will be the only enforcement
		// point once tool execution routes through `ToolDispatcher.invoke`.
		const iterator = context.query({
			prompt: params.text,
			options: {
				allowedTools: allowedTools(),
				tools: enabledTools(),
				permissionMode: 'default',
				canUseTool: (toolName, input, opts) =>
					this.onCanUseTool(params.correlationId, toolName, input, opts.toolUseID),
				cwd: this.deps.cwd,
				env: { ...context.env },
				settingSources: [],
			},
		});

		let sessionId: string | undefined;
		let terminalSubtype: 'success' | 'error' = 'success';
		let errorKind: MessageSendResult['errorKind'];
		let errorMessage: string | undefined;

		try {
			for await (const message of iterator) {
				if (!sessionId && message.session_id) {
					sessionId = message.session_id;
				}
				this.handleSdkMessage(params.correlationId, message);
				if (message.type === 'result') {
					if (message.subtype !== 'success' || message.is_error) {
						terminalSubtype = 'error';
						errorKind = 'unknown';
						errorMessage = message.result ?? 'Agent turn ended with an error.';
					}
				}
			}
		} catch (err) {
			const classification = classifyError(err);
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

	private handleSdkMessage(correlationId: string, message: SdkMessageSurface): void {
		if (message.type === 'assistant') {
			for (const block of message.message.content ?? []) {
				if (block.type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
					this.deps.emitChunk({
						correlationId,
						kind: 'text',
						text: (block as { text: string }).text,
					});
				} else if (block.type === 'tool_use') {
					const toolUse = block as { id: string; name: string; input: Record<string, unknown> };
					const def = getToolDefinition(toolUse.name);
					this.deps.emitChunk({
						correlationId,
						kind: 'tool_use',
						toolName: toolUse.name,
						toolUseId: toolUse.id,
						toolInput: toolUse.input,
						toolSummary: def ? def.summarize(toolUse.input) : undefined,
					});
				}
			}
			return;
		}
		if (message.type === 'user') {
			for (const block of message.message.content ?? []) {
				if (block.type === 'tool_result') {
					const toolResult = block as { tool_use_id: string; content: unknown; is_error?: boolean };
					this.deps.emitChunk({
						correlationId,
						kind: 'tool_result',
						toolUseId: toolResult.tool_use_id,
						toolResult: renderToolResult(toolResult.content),
						toolIsError: Boolean(toolResult.is_error),
					});
				}
			}
		}
	}

	private async onCanUseTool(
		turnCorrelationId: string,
		toolName: string,
		input: Record<string, unknown>,
		toolUseId: string,
	): Promise<PermissionResult> {
		const def = getToolDefinition(toolName);
		const tier = def ? def.tier : 'external';
		const summary = def ? def.summarize(input) : `Use ${toolName}`;

		const outcome = await this.deps.approvalGate.check({
			toolName,
			tier,
			toolUseId,
			turnCorrelationId,
			summary,
			input,
		});

		if (outcome.outcome === 'approve') {
			return { behavior: 'allow', updatedInput: input };
		}

		this.deps.emitChunk({
			correlationId: turnCorrelationId,
			kind: 'tool_denied',
			toolName,
			toolUseId,
			errorKind: 'declined',
			errorMessage: outcome.reason,
		});
		return { behavior: 'deny', message: outcome.reason };
	}
}

function renderToolResult(content: unknown): string {
	if (typeof content === 'string') {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.map(block => {
				const text = (block as { text?: unknown } | null | undefined)?.text;
				if (typeof text === 'string') {
					return text;
				}
				return JSON.stringify(block);
			})
			.join('\n');
	}
	return JSON.stringify(content);
}

function classifyError(err: unknown): { kind: NonNullable<MessageSendResult['errorKind']>; message: string } {
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
