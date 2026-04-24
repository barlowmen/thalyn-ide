/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Readable, Writable } from 'stream';
import type { JsonRpcRequest, JsonRpcResponse } from './protocol';

/** Sidecar-internal names for the JSON-RPC 2.0 standard error codes. */
const enum ErrorCode {
	ParseError = -32700,
	InvalidRequest = -32600,
	MethodNotFound = -32601,
	InternalError = -32603,
}

export type RpcHandler<TParams = unknown, TResult = unknown> =
	(params: TParams) => Promise<TResult> | TResult;

/**
 * Minimal JSON-RPC 2.0 server over newline-delimited JSON.
 *
 * One line == one complete JSON message. Handlers are registered by method
 * name; unknown methods, malformed JSON, and handler exceptions are all
 * reported as standard JSON-RPC error responses.
 */
export class RpcServer {
	private readonly handlers = new Map<string, RpcHandler>();
	private buffer = '';
	private closed = false;

	constructor(
		private readonly input: Readable,
		private readonly output: Writable,
	) {
		this.input.setEncoding('utf8');
		this.input.on('data', chunk => this.onData(chunk as string));
		this.input.on('end', () => { this.closed = true; });
	}

	register<TParams, TResult>(method: string, handler: RpcHandler<TParams, TResult>): void {
		this.handlers.set(method, handler as RpcHandler);
	}

	private onData(chunk: string): void {
		if (this.closed) {
			return;
		}
		this.buffer += chunk;
		let idx: number;
		while ((idx = this.buffer.indexOf('\n')) >= 0) {
			const line = this.buffer.slice(0, idx);
			this.buffer = this.buffer.slice(idx + 1);
			if (line.length === 0) {
				continue;
			}
			void this.dispatch(line);
		}
	}

	private async dispatch(line: string): Promise<void> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			this.send({
				jsonrpc: '2.0',
				id: null,
				error: { code: ErrorCode.ParseError, message: 'Parse error' },
			});
			return;
		}

		if (!isJsonRpcRequest(parsed)) {
			this.send({
				jsonrpc: '2.0',
				id: idOrNull(parsed),
				error: { code: ErrorCode.InvalidRequest, message: 'Invalid Request' },
			});
			return;
		}

		const request = parsed as JsonRpcRequest;
		const handler = this.handlers.get(request.method);
		if (!handler) {
			this.send({
				jsonrpc: '2.0',
				id: request.id,
				error: {
					code: ErrorCode.MethodNotFound,
					message: `Method not found: ${request.method}`,
				},
			});
			return;
		}

		try {
			const result = await handler(request.params);
			this.send({ jsonrpc: '2.0', id: request.id, result });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.send({
				jsonrpc: '2.0',
				id: request.id,
				error: { code: ErrorCode.InternalError, message },
			});
		}
	}

	private send(message: JsonRpcResponse): void {
		this.output.write(JSON.stringify(message) + '\n');
	}
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const candidate = value as Partial<JsonRpcRequest>;
	if (candidate.jsonrpc !== '2.0') {
		return false;
	}
	if (typeof candidate.method !== 'string') {
		return false;
	}
	if (typeof candidate.id !== 'number' && typeof candidate.id !== 'string') {
		return false;
	}
	return true;
}

function idOrNull(value: unknown): number | string | null {
	if (typeof value !== 'object' || value === null) {
		return null;
	}
	const id = (value as { id?: unknown }).id;
	return typeof id === 'number' || typeof id === 'string' ? id : null;
}
