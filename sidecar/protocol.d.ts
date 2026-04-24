/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * JSON-RPC 2.0 protocol definitions for the Thalyn agent sidecar.
 *
 * Framing is newline-delimited JSON over stdio: each message is a single JSON
 * object followed by `\n`. All payloads are UTF-8 text; binary data is not
 * supported at this layer.
 *
 * Declared as `.d.ts` (not `.ts`) so the extension host can include this file
 * from outside its `rootDir` without a cross-project compile dependency.
 * Declaration files bypass `rootDir`; regular `.ts` files don't. Both sides
 * import the same declaration and are responsible for keeping their runtime
 * views of the protocol aligned with it.
 */

/** Outbound request from the caller. */
export interface JsonRpcRequest<TParams = unknown> {
	readonly jsonrpc: '2.0';
	readonly id: number | string;
	readonly method: string;
	readonly params?: TParams;
}

/** Notification: a request without an `id` (no response expected). */
export interface JsonRpcNotification<TParams = unknown> {
	readonly jsonrpc: '2.0';
	readonly method: string;
	readonly params?: TParams;
}

/** Successful response. `id` echoes the request. */
export interface JsonRpcSuccessResponse<TResult = unknown> {
	readonly jsonrpc: '2.0';
	readonly id: number | string;
	readonly result: TResult;
}

/** Error response. `id` is `null` when the failure is framing-level (bad JSON, etc). */
export interface JsonRpcErrorResponse {
	readonly jsonrpc: '2.0';
	readonly id: number | string | null;
	readonly error: JsonRpcError;
}

export type JsonRpcResponse<TResult = unknown> =
	| JsonRpcSuccessResponse<TResult>
	| JsonRpcErrorResponse;

export interface JsonRpcError {
	readonly code: number;
	readonly message: string;
	readonly data?: unknown;
}

/**
 * Standard JSON-RPC 2.0 error codes. The range -32768..-32000 is reserved for
 * protocol-level errors; applications use codes outside that range.
 */
export type StandardJsonRpcErrorCode =
	| -32700  // Parse error
	| -32600  // Invalid Request
	| -32601  // Method not found
	| -32602  // Invalid params
	| -32603; // Internal error

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

/** `ping` — liveness probe. Returns the sidecar's current timestamp. */
export type PingMethod = 'ping';
export type PingParams = undefined;
export interface PingResult {
	readonly timestamp: number;
}

/**
 * Tool-permission tier, ordered by destructive potential
 * (`read < write < delete < external`). `read` is auto-approved by the
 * sidecar; anything else requires explicit user approval before the tool
 * can execute.
 */
export type ToolTier = 'read' | 'write' | 'delete' | 'external';

/** Decision the user returns for a pending approval request. */
export type ApprovalDecision = 'approve' | 'decline' | 'approve-for-session';

// ---------------------------------------------------------------------------
// `message.send` — webview → sidecar, initiates a turn.
//
// Request/response: the response resolves when the turn is complete. Streaming
// text, tool events, and approval prompts all flow as JSON-RPC notifications
// (see below), correlated by `correlationId`.
// ---------------------------------------------------------------------------

export type MessageSendMethod = 'message.send';

export interface MessageSendParams {
	/** Unique id minted per turn; echoed on every `message.chunk`. */
	readonly correlationId: string;
	/** Raw user text. */
	readonly text: string;
}

export interface MessageSendResult {
	readonly correlationId: string;
	/** SDK terminal reason. `success` on normal completion. */
	readonly subtype: 'success' | 'error';
	/** SDK session id — surfaced for later resume support. */
	readonly sessionId?: string;
	/** Populated when `subtype === 'error'`. */
	readonly errorKind?: 'network' | 'auth' | 'rate_limit' | 'declined' | 'unknown';
	readonly errorMessage?: string;
}

// ---------------------------------------------------------------------------
// `message.chunk` — sidecar → webview, streaming notifications for a turn.
// ---------------------------------------------------------------------------

export type MessageChunkMethod = 'message.chunk';

export type MessageChunkKind = 'text' | 'tool_use' | 'tool_result' | 'tool_denied' | 'done' | 'error';

export interface MessageChunkParams {
	readonly correlationId: string;
	readonly kind: MessageChunkKind;
	/** Present on `kind: 'text'`. Concatenated text from an assistant turn. */
	readonly text?: string;
	/** Present on tool events. SDK-assigned id, distinct from approval correlationId. */
	readonly toolUseId?: string;
	readonly toolName?: string;
	readonly toolInput?: Record<string, unknown>;
	readonly toolSummary?: string;
	/** Present on `kind: 'tool_result'`. String-rendered tool output. */
	readonly toolResult?: string;
	readonly toolIsError?: boolean;
	/** Present on `kind: 'error' | 'tool_denied'`. */
	readonly errorKind?: 'network' | 'auth' | 'rate_limit' | 'declined' | 'unknown';
	readonly errorMessage?: string;
}

// ---------------------------------------------------------------------------
// `tool.approval.request` — sidecar → webview, asks the user to approve a
// destructive tool call. Fired from the Agent SDK's `canUseTool` hook.
// ---------------------------------------------------------------------------

export type ToolApprovalRequestMethod = 'tool.approval.request';

export interface ToolApprovalRequestParams {
	/** Unique id minted per approval prompt. Must match on the reply. */
	readonly correlationId: string;
	/** The enclosing turn's correlationId, so the webview can group events. */
	readonly turnCorrelationId: string;
	readonly toolName: string;
	readonly toolTier: ToolTier;
	readonly toolUseId: string;
	/** One-line user-facing description of the proposed action. */
	readonly summary: string;
	readonly input: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// `tool.approval.reply` — webview → sidecar, user's response to an approval
// request. Notification (no response expected).
// ---------------------------------------------------------------------------

export type ToolApprovalReplyMethod = 'tool.approval.reply';

export interface ToolApprovalReplyParams {
	readonly correlationId: string;
	readonly decision: ApprovalDecision;
	/** Optional reason for `decline`; surfaced to the model via SDK deny message. */
	readonly declineReason?: string;
}
