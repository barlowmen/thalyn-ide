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
