/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import type {
	JsonRpcErrorResponse,
	JsonRpcRequest,
	JsonRpcResponse,
	JsonRpcSuccessResponse,
} from '../../../sidecar/protocol';

/**
 * Minimal view of a `child_process.ChildProcess` used by the sidecar client.
 * Carved out as an interface so tests can inject an in-memory double driven
 * by `PassThrough` streams.
 */
export interface SidecarProcess {
	readonly stdin: NodeJS.WritableStream | null;
	readonly stdout: NodeJS.ReadableStream | null;
	readonly stderr: NodeJS.ReadableStream | null;
	kill(signal?: NodeJS.Signals | number): boolean;
	on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
	on(event: 'error', listener: (err: Error) => void): unknown;
}

export type Spawner = () => SidecarProcess;

export type SidecarState =
	| 'stopped'
	| 'starting'
	| 'running'
	| 'restarting'
	| 'failed';

export interface SidecarClientOptions {
	readonly spawner: Spawner;
	/** Maximum automatic restarts after unexpected exits. Default: 3. */
	readonly maxRestarts?: number;
	/** Backoff between restart attempts. Default: 500ms * attempt. */
	readonly backoffMs?: (attempt: number) => number;
	/** Emitted for each `stderr` line from the sidecar. */
	readonly onStderr?: (line: string) => void;
	readonly onStateChanged?: (state: SidecarState) => void;
	/** Allows tests to replace `setTimeout` for deterministic scheduling. */
	readonly setTimeoutFn?: (cb: () => void, ms: number) => unknown;
}

/**
 * Create a default spawner that runs `node <entryPath>` as a child process
 * with stdio piped. Used in production; tests inject their own spawner.
 *
 * When the caller is itself inside Electron (the extension host is),
 * `process.execPath` points at the Electron binary. `ELECTRON_RUN_AS_NODE=1`
 * switches Electron into plain-Node mode so the sidecar runs as a normal
 * Node process rather than an Electron helper.
 */
export function createNodeSpawner(entryPath: string): Spawner {
	return () => spawn(process.execPath, [entryPath], {
		stdio: ['pipe', 'pipe', 'pipe'],
		env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
	}) as unknown as SidecarProcess;
}

interface PendingCall {
	readonly method: string;
	resolve(value: unknown): void;
	reject(err: Error): void;
}

/**
 * Client for the Thalyn sidecar. Owns the child-process lifecycle, frames
 * JSON-RPC 2.0 requests over stdio (newline-delimited JSON), and restarts
 * the sidecar up to `maxRestarts` times on unexpected exits. Once the gate
 * is exhausted the client enters `failed` state and future `call()`s reject
 * immediately.
 */
export class SidecarClient {
	private readonly spawner: Spawner;
	private readonly maxRestarts: number;
	private readonly backoffMs: (attempt: number) => number;
	private readonly onStderr: (line: string) => void;
	private readonly onStateChanged: (state: SidecarState) => void;
	private readonly setTimeoutFn: (cb: () => void, ms: number) => unknown;

	private state: SidecarState = 'stopped';
	private child: SidecarProcess | undefined;
	private stdoutBuffer = '';
	private stderrBuffer = '';
	private readonly pending = new Map<number, PendingCall>();
	private nextRequestId = 1;
	private restartAttempts = 0;
	private disposed = false;

	constructor(opts: SidecarClientOptions) {
		this.spawner = opts.spawner;
		this.maxRestarts = opts.maxRestarts ?? 3;
		this.backoffMs = opts.backoffMs ?? (attempt => attempt * 500);
		this.onStderr = opts.onStderr ?? (() => { });
		this.onStateChanged = opts.onStateChanged ?? (() => { });
		this.setTimeoutFn = opts.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms));
	}

	/** Current client state. Exposed for tests and future telemetry. */
	getState(): SidecarState {
		return this.state;
	}

	/** Start the sidecar. Idempotent: no-op if already starting/running. */
	start(): void {
		if (this.disposed) {
			throw new Error('SidecarClient has been disposed');
		}
		if (this.state === 'starting' || this.state === 'running' || this.state === 'restarting') {
			return;
		}
		this.spawnOnce();
	}

	/**
	 * Call a sidecar method. Rejects if the client is `failed` or `stopped`,
	 * or if the sidecar exits before responding.
	 */
	call<TResult, TParams = unknown>(method: string, params?: TParams): Promise<TResult> {
		if (this.disposed || this.state === 'stopped') {
			return Promise.reject(new Error('SidecarClient is not running'));
		}
		if (this.state === 'failed') {
			return Promise.reject(new Error('SidecarClient has failed and will not restart'));
		}
		if (!this.child || !this.child.stdin) {
			return Promise.reject(new Error('SidecarClient has no active child process'));
		}

		const id = this.nextRequestId++;
		const request: JsonRpcRequest = {
			jsonrpc: '2.0',
			id,
			method,
			...(params !== undefined ? { params } : {}),
		};

		return new Promise<TResult>((resolve, reject) => {
			this.pending.set(id, {
				method,
				resolve: value => resolve(value as TResult),
				reject,
			});
			this.child!.stdin!.write(JSON.stringify(request) + '\n');
		});
	}

	/** Stop the sidecar and release resources. Further calls reject. */
	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		if (this.child) {
			try {
				this.child.kill('SIGTERM');
			} catch {
				// Process may already be dead; ignore.
			}
		}
		this.rejectAllPending(new Error('SidecarClient disposed'));
		this.setState('stopped');
	}

	private spawnOnce(): void {
		this.setState(this.restartAttempts === 0 ? 'starting' : 'restarting');
		const child = this.spawner();
		this.child = child;
		this.stdoutBuffer = '';
		this.stderrBuffer = '';

		if (child.stdout) {
			child.stdout.setEncoding?.('utf8');
			child.stdout.on('data', (chunk: string | Buffer) => {
				this.onStdout(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
			});
		}
		if (child.stderr) {
			child.stderr.setEncoding?.('utf8');
			child.stderr.on('data', (chunk: string | Buffer) => {
				this.onStderrChunk(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
			});
		}

		child.on('error', err => {
			// Failure to spawn (ENOENT, etc) — treat like an exit.
			this.onExit(null, null, err);
		});
		child.on('exit', (code, signal) => this.onExit(code, signal));

		this.setState('running');
	}

	private onStdout(chunk: string): void {
		this.stdoutBuffer += chunk;
		let idx: number;
		while ((idx = this.stdoutBuffer.indexOf('\n')) >= 0) {
			const line = this.stdoutBuffer.slice(0, idx);
			this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
			if (line.length === 0) {
				continue;
			}
			this.handleResponseLine(line);
		}
	}

	private onStderrChunk(chunk: string): void {
		this.stderrBuffer += chunk;
		let idx: number;
		while ((idx = this.stderrBuffer.indexOf('\n')) >= 0) {
			const line = this.stderrBuffer.slice(0, idx);
			this.stderrBuffer = this.stderrBuffer.slice(idx + 1);
			if (line.length > 0) {
				this.onStderr(line);
			}
		}
	}

	private handleResponseLine(line: string): void {
		let parsed: JsonRpcResponse;
		try {
			parsed = JSON.parse(line) as JsonRpcResponse;
		} catch {
			this.onStderr(`sidecar sent non-JSON line: ${line}`);
			return;
		}
		if (typeof parsed.id !== 'number') {
			// Notifications (no id) aren't part of this protocol surface; ignore.
			return;
		}
		const pending = this.pending.get(parsed.id);
		if (!pending) {
			return;
		}
		this.pending.delete(parsed.id);
		if (isErrorResponse(parsed)) {
			pending.reject(new SidecarRpcError(pending.method, parsed.error.code, parsed.error.message));
		} else {
			pending.resolve((parsed as JsonRpcSuccessResponse).result);
		}
	}

	private onExit(code: number | null, signal: NodeJS.Signals | null, err?: Error): void {
		const wasRunning = this.state === 'running' || this.state === 'restarting';
		const rejectReason = err
			? new Error(`sidecar failed to start: ${err.message}`)
			: new Error(`sidecar exited (code=${code}, signal=${signal ?? 'none'})`);
		this.rejectAllPending(rejectReason);
		this.child = undefined;

		if (this.disposed) {
			return;
		}
		if (!wasRunning) {
			return;
		}

		if (this.restartAttempts >= this.maxRestarts) {
			this.setState('failed');
			return;
		}
		this.restartAttempts++;
		this.setState('restarting');
		const delay = this.backoffMs(this.restartAttempts);
		this.setTimeoutFn(() => {
			if (!this.disposed) {
				this.spawnOnce();
			}
		}, delay);
	}

	private rejectAllPending(err: Error): void {
		for (const pending of this.pending.values()) {
			pending.reject(err);
		}
		this.pending.clear();
	}

	private setState(next: SidecarState): void {
		if (this.state === next) {
			return;
		}
		this.state = next;
		try {
			this.onStateChanged(next);
		} catch {
			// Listener failures must not take down the client.
		}
	}
}

export class SidecarRpcError extends Error {
	constructor(
		public readonly method: string,
		public readonly code: number,
		message: string,
	) {
		super(`sidecar method ${method} failed (code ${code}): ${message}`);
		this.name = 'SidecarRpcError';
	}
}

function isErrorResponse(response: JsonRpcResponse): response is JsonRpcErrorResponse {
	return 'error' in response;
}
