/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { JsonRpcRequest, PingResult } from '../../../sidecar/protocol';
import {
	SidecarClient,
	SidecarRpcError,
	type SidecarProcess,
	type SidecarState,
} from './sidecar-client';

/**
 * In-memory `SidecarProcess` double. Exposes the stdio streams so tests can
 * drive the sidecar side directly, and extends `EventEmitter` so the client
 * can subscribe to `exit` / `error` events via `.on(...)` the same way it
 * would against a real `ChildProcess`.
 */
class FakeSidecar extends EventEmitter implements SidecarProcess {
	public readonly stdin = new PassThrough();
	public readonly stdout = new PassThrough();
	public readonly stderr = new PassThrough();
	public killed = false;

	kill(): boolean {
		this.killed = true;
		setImmediate(() => this.emit('exit', 0, null));
		return true;
	}

	/** Test helper: parse outbound JSON-RPC requests written on stdin. */
	async readRequest(): Promise<JsonRpcRequest> {
		return new Promise((resolve, reject) => {
			let buffer = '';
			const onData = (chunk: Buffer | string) => {
				buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
				const idx = buffer.indexOf('\n');
				if (idx < 0) {
					return;
				}
				this.stdin.off('data', onData);
				try {
					resolve(JSON.parse(buffer.slice(0, idx)) as JsonRpcRequest);
				} catch (err) {
					reject(err as Error);
				}
			};
			this.stdin.on('data', onData);
		});
	}

	/** Test helper: emit a JSON-RPC response line on stdout. */
	respond(response: unknown): void {
		this.stdout.write(JSON.stringify(response) + '\n');
	}

	/** Test helper: simulate an unexpected exit. */
	crash(code = 1, signal: NodeJS.Signals | null = null): void {
		this.emit('exit', code, signal);
	}
}

suite('SidecarClient', () => {

	test('round-trips a successful ping call', async () => {
		const fake = new FakeSidecar();
		const client = new SidecarClient({ spawner: () => fake });
		client.start();

		const callPromise = client.call<PingResult>('ping');
		const request = await fake.readRequest();
		assert.strictEqual(request.jsonrpc, '2.0');
		assert.strictEqual(request.method, 'ping');
		assert.strictEqual(typeof request.id, 'number');

		fake.respond({ jsonrpc: '2.0', id: request.id, result: { timestamp: 1234 } });
		const result = await callPromise;
		assert.deepStrictEqual(result, { timestamp: 1234 });

		client.dispose();
	});

	test('rejects with SidecarRpcError when the sidecar returns an error', async () => {
		const fake = new FakeSidecar();
		const client = new SidecarClient({ spawner: () => fake });
		client.start();

		const callPromise = client.call('unknown.method');
		const request = await fake.readRequest();
		fake.respond({
			jsonrpc: '2.0',
			id: request.id,
			error: { code: -32601, message: 'Method not found: unknown.method' },
		});

		await assert.rejects(callPromise, (err: unknown) => {
			assert.ok(err instanceof SidecarRpcError);
			assert.strictEqual((err as SidecarRpcError).method, 'unknown.method');
			assert.strictEqual((err as SidecarRpcError).code, -32601);
			return true;
		});

		client.dispose();
	});

	test('rejects in-flight calls when the sidecar exits', async () => {
		const fake = new FakeSidecar();
		const client = new SidecarClient({
			spawner: () => fake,
			maxRestarts: 0,
		});
		client.start();

		const callPromise = client.call('ping');
		await fake.readRequest();
		fake.crash();

		await assert.rejects(callPromise, /sidecar exited/);
		assert.strictEqual(client.getState(), 'failed');

		client.dispose();
	});

	test('restarts on unexpected exit up to maxRestarts, then fails', async () => {
		const spawned: FakeSidecar[] = [];
		const states: SidecarState[] = [];
		const client = new SidecarClient({
			spawner: () => {
				const fake = new FakeSidecar();
				spawned.push(fake);
				return fake;
			},
			maxRestarts: 2,
			backoffMs: () => 0,
			setTimeoutFn: cb => { setImmediate(cb); return 0; },
			onStateChanged: s => states.push(s),
		});

		client.start();
		assert.strictEqual(spawned.length, 1);
		spawned[0].crash();
		await flush();
		assert.strictEqual(spawned.length, 2);
		spawned[1].crash();
		await flush();
		assert.strictEqual(spawned.length, 3);
		spawned[2].crash();
		await flush();

		// After the third crash the client has exhausted its restart gate.
		assert.strictEqual(spawned.length, 3);
		assert.strictEqual(client.getState(), 'failed');
		assert.ok(states.includes('restarting'));
		assert.ok(states.includes('failed'));

		await assert.rejects(client.call('ping'), /will not restart/);
		client.dispose();
	});

	test('dispose kills the child and rejects future calls', async () => {
		const fake = new FakeSidecar();
		const client = new SidecarClient({ spawner: () => fake });
		client.start();

		client.dispose();
		assert.strictEqual(fake.killed, true);
		await assert.rejects(client.call('ping'), /not running/);
	});

	test('handles two responses arriving in a single stdout chunk', async () => {
		const fake = new FakeSidecar();
		const client = new SidecarClient({ spawner: () => fake });
		client.start();

		const a = client.call<{ n: number }>('echo');
		const reqA = await fake.readRequest();
		const b = client.call<{ n: number }>('echo');
		const reqB = await fake.readRequest();

		fake.stdout.write(
			JSON.stringify({ jsonrpc: '2.0', id: reqA.id, result: { n: 1 } }) + '\n' +
			JSON.stringify({ jsonrpc: '2.0', id: reqB.id, result: { n: 2 } }) + '\n',
		);

		assert.deepStrictEqual(await a, { n: 1 });
		assert.deepStrictEqual(await b, { n: 2 });

		client.dispose();
	});
});

function flush(): Promise<void> {
	return new Promise(resolve => setImmediate(() => setImmediate(resolve)));
}
