/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Indistinguishability test for the tool-dispatch boundary.
 *
 * Per ADR 0011's extension mechanism (hybrid built-in + MCP, MCP-primary
 * migration path preserved) and ADR 0003's tool-dispatch contract, a
 * tool's schema, invocation surface, streaming/cancel semantics, and
 * error channel must be identical regardless of whether the tool is
 * backed by a direct function call or by an MCP server.
 *
 * This suite exercises the invariant with `read_file` implemented two
 * ways: once as a `BuiltinBackend` wrapping `fs.readFile`, once as an
 * MCP server talking to a `Client` over an in-memory transport. Both
 * are registered with the dispatcher and asserted to produce identical
 * schemas and identical `ToolResult`s for the same input.
 *
 * Out-of-process MCP (real stdio subprocess) is deferred to Phase 4,
 * where the browser MCP server lands and gives us a non-test reason
 * to exercise the transport under real conditions.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { ApprovalGate, type ApprovalGateDeps } from './approval.js';
import { ToolDispatcher } from './dispatcher.js';
import { BuiltinBackend, toolError, toolSuccess } from './backends/builtin.js';
import { registerMcpClient } from './backends/mcp.js';
import type { RegisteredTool, ToolSchema } from './types.js';

const READ_FILE_SCHEMA = {
	type: 'object',
	properties: {
		path: { type: 'string', description: 'Absolute path to the file.' },
	},
	required: ['path'],
	additionalProperties: false,
} as const;

const READ_FILE_DESCRIPTION = 'Read a UTF-8 text file from the local filesystem.';

function buildBuiltinReadFile(): RegisteredTool {
	const schema: ToolSchema = {
		name: 'read_file',
		description: READ_FILE_DESCRIPTION,
		inputSchema: READ_FILE_SCHEMA,
		tier: 'read',
	};
	const backend = new BuiltinBackend(async input => {
		const path = input.path;
		if (typeof path !== 'string') {
			return toolError(`Missing or non-string 'path' argument.`);
		}
		try {
			const content = readFileSync(path, 'utf8');
			return toolSuccess(content);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return toolError(message);
		}
	});
	return { schema, backend };
}

async function buildMcpReadFile(): Promise<{ tool: RegisteredTool; close: () => Promise<void> }> {
	const server = new Server(
		{ name: 'read-file-test-server', version: '0.0.1' },
		{ capabilities: { tools: {} } },
	);
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [
			{
				name: 'read_file',
				description: READ_FILE_DESCRIPTION,
				inputSchema: READ_FILE_SCHEMA as unknown as {
					type: 'object';
					properties?: Record<string, object>;
					required?: string[];
				},
			},
		],
	}));
	server.setRequestHandler(CallToolRequestSchema, async request => {
		if (request.params.name !== 'read_file') {
			return {
				content: [{ type: 'text' as const, text: `Unknown tool: ${request.params.name}` }],
				isError: true,
			};
		}
		const path = (request.params.arguments ?? {}).path;
		if (typeof path !== 'string') {
			return {
				content: [{ type: 'text' as const, text: `Missing or non-string 'path' argument.` }],
				isError: true,
			};
		}
		try {
			const content = readFileSync(path, 'utf8');
			return { content: [{ type: 'text' as const, text: content }], isError: false };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { content: [{ type: 'text' as const, text: message }], isError: true };
		}
	});

	const client = new Client({ name: 'dispatcher-test-client', version: '0.0.1' });

	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

	const registered = await registerMcpClient(client, () => 'read');
	const tool = registered.find(r => r.schema.name === 'read_file');
	if (!tool) {
		throw new Error('read_file not advertised by test MCP server');
	}

	const close = async () => {
		await client.close();
		await server.close();
	};
	return { tool, close };
}

function buildDispatcher(tool: RegisteredTool): ToolDispatcher {
	const deps: ApprovalGateDeps = {
		requestApproval: () => {
			throw new Error('Read-tier tools must not request approval.');
		},
		newApprovalId: () => 'should-not-be-called',
	};
	const gate = new ApprovalGate(deps);
	const dispatcher = new ToolDispatcher(gate, {});
	dispatcher.register(tool);
	return dispatcher;
}

function makeTempFile(contents: string): string {
	const dir = mkdtempSync(join(tmpdir(), 'thalyn-dispatch-'));
	const path = join(dir, 'sample.txt');
	writeFileSync(path, contents, 'utf8');
	return path;
}

describe('tool-dispatch boundary: built-in and MCP backings are indistinguishable', () => {
	it('exposes identical ToolSchema to the brain', async () => {
		const builtinTool = buildBuiltinReadFile();
		const mcp = await buildMcpReadFile();
		try {
			const builtinDispatcher = buildDispatcher(builtinTool);
			const mcpDispatcher = buildDispatcher(mcp.tool);

			const builtinSchemas = builtinDispatcher.schemas();
			const mcpSchemas = mcpDispatcher.schemas();

			expect(mcpSchemas).toEqual(builtinSchemas);
		} finally {
			await mcp.close();
		}
	});

	it('returns identical ToolResult for the same call', async () => {
		const path = makeTempFile('hello from thalyn');
		const builtinTool = buildBuiltinReadFile();
		const mcp = await buildMcpReadFile();
		try {
			const builtinDispatcher = buildDispatcher(builtinTool);
			const mcpDispatcher = buildDispatcher(mcp.tool);
			const call = { id: 'call-1', name: 'read_file', input: { path } };
			const ctx = { turnCorrelationId: 't1', signal: new AbortController().signal };

			const builtinResult = await builtinDispatcher.invoke(call, ctx);
			const mcpResult = await mcpDispatcher.invoke(call, ctx);

			expect(mcpResult).toEqual(builtinResult);
			expect(builtinResult).toEqual({
				id: 'call-1',
				content: 'hello from thalyn',
				isError: false,
			});
		} finally {
			await mcp.close();
		}
	});

	it('surfaces tool-level failures identically (missing file → isError: true)', async () => {
		const missingPath = join(tmpdir(), 'thalyn-nonexistent-' + Date.now() + '.txt');
		const builtinTool = buildBuiltinReadFile();
		const mcp = await buildMcpReadFile();
		try {
			const builtinDispatcher = buildDispatcher(builtinTool);
			const mcpDispatcher = buildDispatcher(mcp.tool);
			const call = { id: 'call-2', name: 'read_file', input: { path: missingPath } };
			const ctx = { turnCorrelationId: 't1', signal: new AbortController().signal };

			const builtinResult = await builtinDispatcher.invoke(call, ctx);
			const mcpResult = await mcpDispatcher.invoke(call, ctx);

			expect(builtinResult.isError).toBe(true);
			expect(mcpResult.isError).toBe(true);
			expect(builtinResult.id).toBe('call-2');
			expect(mcpResult.id).toBe('call-2');
			// Both backends surface the underlying I/O error message. The
			// exact text is Node's `ENOENT: no such file or directory` —
			// identical across backings because both call `fs.readFileSync`
			// on the same path.
			expect(mcpResult.content).toBe(builtinResult.content);
		} finally {
			await mcp.close();
		}
	});

	it('aborts before invocation when the signal is pre-aborted', async () => {
		const path = makeTempFile('x');
		const builtinTool = buildBuiltinReadFile();
		const mcp = await buildMcpReadFile();
		try {
			const builtinDispatcher = buildDispatcher(builtinTool);
			const mcpDispatcher = buildDispatcher(mcp.tool);
			const controller = new AbortController();
			controller.abort();
			const call = { id: 'call-3', name: 'read_file', input: { path } };
			const ctx = { turnCorrelationId: 't1', signal: controller.signal };

			const builtinResult = await builtinDispatcher.invoke(call, ctx);
			const mcpResult = await mcpDispatcher.invoke(call, ctx);

			expect(builtinResult.isError).toBe(true);
			expect(mcpResult.isError).toBe(true);
			// The built-in backend short-circuits with a canonical aborted
			// message; the MCP client raises its own aborted error. Both
			// surface as `isError: true` with the correlation id preserved
			// — that is the invariant the brain sees.
			expect(builtinResult.id).toBe('call-3');
			expect(mcpResult.id).toBe('call-3');
		} finally {
			await mcp.close();
		}
	});
});
