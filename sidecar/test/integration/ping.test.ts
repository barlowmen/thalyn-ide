/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { JsonRpcResponse, PingResult } from '../../protocol';

const SIDECAR_ENTRY = path.resolve(__dirname, '..', '..', 'out', 'index.js');

describe('sidecar integration', () => {
	let child: ChildProcessWithoutNullStreams | undefined;

	afterEach(() => {
		if (child && !child.killed) {
			child.kill('SIGTERM');
		}
		child = undefined;
	});

	it('responds to ping with a numeric timestamp', async () => {
		child = spawn(process.execPath, [SIDECAR_ENTRY], {
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		const stderrChunks: string[] = [];
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', chunk => stderrChunks.push(chunk));

		const response = await readOneResponse(child, 5_000, () => {
			child!.stdin.write(JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'ping',
			}) + '\n');
		});

		if ('error' in response) {
			throw new Error(`sidecar returned error: ${JSON.stringify(response.error)}; stderr=${stderrChunks.join('')}`);
		}

		expect(response.jsonrpc).toBe('2.0');
		expect(response.id).toBe(1);
		const result = response.result as PingResult;
		expect(typeof result.timestamp).toBe('number');
		expect(result.timestamp).toBeGreaterThan(0);
	});

	it('exits cleanly when stdin closes', async () => {
		child = spawn(process.execPath, [SIDECAR_ENTRY], {
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		const exited = new Promise<number | null>(resolve => {
			child!.on('exit', code => resolve(code));
		});
		child.stdin.end();
		child.kill('SIGTERM');

		const code = await Promise.race([
			exited,
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error('sidecar did not exit within 5s')), 5_000)),
		]);
		expect(code === 0 || code === null).toBe(true);
	});
});

function readOneResponse(
	child: ChildProcessWithoutNullStreams,
	timeoutMs: number,
	after: () => void,
): Promise<JsonRpcResponse> {
	return new Promise((resolve, reject) => {
		let buffer = '';
		const timer = setTimeout(() => {
			reject(new Error(`timed out waiting for sidecar response after ${timeoutMs}ms; received=${JSON.stringify(buffer)}`));
		}, timeoutMs);

		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			buffer += chunk;
			const newlineIdx = buffer.indexOf('\n');
			if (newlineIdx < 0) {
				return;
			}
			clearTimeout(timer);
			const line = buffer.slice(0, newlineIdx);
			try {
				resolve(JSON.parse(line) as JsonRpcResponse);
			} catch (err) {
				reject(new Error(`sidecar emitted non-JSON on stdout: ${line} (${(err as Error).message})`));
			}
		});

		child.on('error', err => {
			clearTimeout(timer);
			reject(err);
		});

		after();
	});
}
