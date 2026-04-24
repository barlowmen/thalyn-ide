/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PassThrough } from 'stream';
import { describe, expect, it } from 'vitest';
import type { JsonRpcResponse } from './protocol';
import { RpcServer } from './rpc';

function makeServer() {
	const input = new PassThrough();
	const output = new PassThrough();
	const server = new RpcServer(input, output);
	const received: JsonRpcResponse[] = [];
	let buffer = '';
	output.on('data', (chunk: Buffer) => {
		buffer += chunk.toString('utf8');
		let idx: number;
		while ((idx = buffer.indexOf('\n')) >= 0) {
			const line = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 1);
			if (line.length > 0) {
				received.push(JSON.parse(line) as JsonRpcResponse);
			}
		}
	});
	return { server, input, received };
}

function send(input: PassThrough, message: unknown): void {
	input.write(JSON.stringify(message) + '\n');
}

async function nextTick(): Promise<void> {
	await new Promise(resolve => setImmediate(resolve));
	await new Promise(resolve => setImmediate(resolve));
}

describe('RpcServer', () => {
	it('dispatches a registered method and echoes the request id', async () => {
		const { server, input, received } = makeServer();
		server.register<{ x: number }, { doubled: number }>('double', params => ({ doubled: params.x * 2 }));

		send(input, { jsonrpc: '2.0', id: 1, method: 'double', params: { x: 21 } });
		await nextTick();

		expect(received).toEqual([
			{ jsonrpc: '2.0', id: 1, result: { doubled: 42 } },
		]);
	});

	it('awaits async handlers', async () => {
		const { server, input, received } = makeServer();
		server.register('slow', async () => {
			await new Promise(resolve => setTimeout(resolve, 5));
			return { ok: true };
		});

		send(input, { jsonrpc: '2.0', id: 'abc', method: 'slow' });
		await new Promise(resolve => setTimeout(resolve, 20));

		expect(received).toEqual([
			{ jsonrpc: '2.0', id: 'abc', result: { ok: true } },
		]);
	});

	it('returns MethodNotFound for unknown methods', async () => {
		const { input, received } = makeServer();
		send(input, { jsonrpc: '2.0', id: 7, method: 'nope' });
		await nextTick();

		expect(received).toEqual([
			{
				jsonrpc: '2.0',
				id: 7,
				error: { code: -32601, message: 'Method not found: nope' },
			},
		]);
	});

	it('returns ParseError with null id for malformed JSON', async () => {
		const { input, received } = makeServer();
		input.write('not json\n');
		await nextTick();

		expect(received).toEqual([
			{
				jsonrpc: '2.0',
				id: null,
				error: { code: -32700, message: 'Parse error' },
			},
		]);
	});

	it('returns InvalidRequest when jsonrpc version or method is missing', async () => {
		const { input, received } = makeServer();
		send(input, { id: 3, method: 'ping' }); // missing jsonrpc
		send(input, { jsonrpc: '2.0', id: 4 }); // missing method
		await nextTick();

		expect(received).toEqual([
			{ jsonrpc: '2.0', id: 3, error: { code: -32600, message: 'Invalid Request' } },
			{ jsonrpc: '2.0', id: 4, error: { code: -32600, message: 'Invalid Request' } },
		]);
	});

	it('returns InternalError when the handler throws', async () => {
		const { server, input, received } = makeServer();
		server.register('boom', () => {
			throw new Error('kaboom');
		});

		send(input, { jsonrpc: '2.0', id: 9, method: 'boom' });
		await nextTick();

		expect(received).toEqual([
			{ jsonrpc: '2.0', id: 9, error: { code: -32603, message: 'kaboom' } },
		]);
	});

	it('handles multiple messages arriving in a single chunk', async () => {
		const { server, input, received } = makeServer();
		server.register<{ n: number }, { n: number }>('echo', p => p);

		input.write(
			JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'echo', params: { n: 1 } }) + '\n' +
			JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'echo', params: { n: 2 } }) + '\n'
		);
		await nextTick();

		expect(received).toEqual([
			{ jsonrpc: '2.0', id: 1, result: { n: 1 } },
			{ jsonrpc: '2.0', id: 2, result: { n: 2 } },
		]);
	});

	it('handles a message split across chunks', async () => {
		const { server, input, received } = makeServer();
		server.register<{ n: number }, { n: number }>('echo', p => p);

		const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'echo', params: { n: 7 } });
		input.write(payload.slice(0, 10));
		await nextTick();
		expect(received).toEqual([]);
		input.write(payload.slice(10) + '\n');
		await nextTick();

		expect(received).toEqual([
			{ jsonrpc: '2.0', id: 1, result: { n: 7 } },
		]);
	});
});

describe('ping handler', () => {
	it('returns a numeric timestamp roughly matching Date.now()', async () => {
		const { server, input, received } = makeServer();
		server.register('ping', () => ({ timestamp: Date.now() }));

		const before = Date.now();
		send(input, { jsonrpc: '2.0', id: 1, method: 'ping' });
		await nextTick();
		const after = Date.now();

		expect(received).toHaveLength(1);
		const response = received[0];
		expect('result' in response).toBe(true);
		if ('result' in response) {
			const result = response.result as { timestamp: number };
			expect(typeof result.timestamp).toBe('number');
			expect(result.timestamp).toBeGreaterThanOrEqual(before);
			expect(result.timestamp).toBeLessThanOrEqual(after);
		}
	});
});
