/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { allowedTools, enabledTools, getToolDefinition, TOOL_DEFINITIONS } from './index';

describe('tool definitions', () => {
	it('declares the harness tool surface', () => {
		expect(TOOL_DEFINITIONS.map(t => t.name)).toEqual(
			['Read', 'Write', 'Edit', 'Bash', 'mcp__thalyn__spawn_worker'],
		);
	});

	it('auto-approves only the `read` tier', () => {
		expect(allowedTools()).toEqual(['Read']);
	});

	it('enables every defined tool for the agent', () => {
		expect(enabledTools()).toEqual(
			['Read', 'Write', 'Edit', 'Bash', 'mcp__thalyn__spawn_worker'],
		);
	});

	it('summarises spawn_worker with role and truncated task', () => {
		const def = getToolDefinition('mcp__thalyn__spawn_worker');
		expect(def).toBeDefined();
		expect(def!.tier).toBe('external');
		expect(def!.summarize({ role: 'researcher', task: 'find the bug' }))
			.toBe('Spawn researcher worker: find the bug');
	});

	it('gates destructive tools behind approval', () => {
		for (const def of TOOL_DEFINITIONS) {
			if (def.tier === 'read') {
				expect(def.requiresApproval).toBe(false);
			} else {
				expect(def.requiresApproval).toBe(true);
			}
		}
	});

	it('summarises Bash with a command preview', () => {
		const def = getToolDefinition('Bash');
		expect(def).toBeDefined();
		expect(def!.summarize({ command: 'ls -la' })).toBe('Run shell: ls -la');
	});

	it('truncates very long Bash command summaries', () => {
		const def = getToolDefinition('Bash')!;
		const long = 'echo ' + 'x'.repeat(300);
		const summary = def.summarize({ command: long });
		expect(summary.startsWith('Run shell: ')).toBe(true);
		expect(summary.length).toBeLessThanOrEqual('Run shell: '.length + 120);
		expect(summary.endsWith('…')).toBe(true);
	});

	it('summarises file-path tools using their `file_path` input', () => {
		expect(getToolDefinition('Read')!.summarize({ file_path: '/tmp/a.txt' })).toBe('Read /tmp/a.txt');
		expect(getToolDefinition('Write')!.summarize({ file_path: '/tmp/b.txt' })).toBe('Create or overwrite /tmp/b.txt');
		expect(getToolDefinition('Edit')!.summarize({ file_path: '/tmp/c.txt' })).toBe('Edit /tmp/c.txt');
	});

	it('returns undefined for unknown tool names', () => {
		expect(getToolDefinition('Nonsense')).toBeUndefined();
	});
});
