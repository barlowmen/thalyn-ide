/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';

import type { BrainStreamEvent, CentralBrain } from '../brain/types';
import {
	buildWorkerDispatcher,
	buildWorkerToolsView,
	runSpawnWorker,
	WORKER_TOOL_SCHEMAS,
} from './spawn-worker-tool';
import type { CentralBrainFactory } from './types';

function fakeFactoryEmitting(events: readonly BrainStreamEvent[]): CentralBrainFactory {
	return {
		create: () => {
			const brain: CentralBrain = {
				async *send() {
					for (const ev of events) {
						yield ev;
					}
				},
			};
			return brain;
		},
	};
}

describe('buildWorkerToolsView', () => {
	it('resolves the schema for every tool the built-in role allowlists reference', () => {
		const view = buildWorkerToolsView();
		for (const role of ['read_file', 'grep', 'write_file', 'edit_file', 'run_command']) {
			expect(view.schemaFor(role)).toBeDefined();
		}
	});

	it('returns undefined for unknown tool names so the dispatcher fails fast', () => {
		expect(buildWorkerToolsView().schemaFor('frobnicate')).toBeUndefined();
	});

	it('exposes WORKER_TOOL_SCHEMAS as a readonly source of truth', () => {
		expect(WORKER_TOOL_SCHEMAS.map(s => s.name).sort()).toEqual(
			['edit_file', 'grep', 'read_file', 'run_command', 'write_file'],
		);
	});
});

describe('runSpawnWorker', () => {
	it('aggregates streamed text and tool calls into a single response payload', async () => {
		const factory = fakeFactoryEmitting([
			{ kind: 'text', text: 'looked at it. ' },
			{ kind: 'tool_use', call: { id: '1', name: 'read_file', input: { path: '/a.txt' } } },
			{ kind: 'text', text: 'no issues.' },
			{ kind: 'done', stopReason: 'end_turn' },
		]);
		const dispatcher = buildWorkerDispatcher({
			brainFactory: factory,
			sessionId: 's1',
			overrides: {},
		});

		const result = await runSpawnWorker(dispatcher, {
			role: 'researcher',
			task: 'Look at /a.txt.',
		});

		expect(result.isError).toBe(false);
		expect(result.text).toContain('looked at it.');
		expect(result.text).toContain('no issues.');
		expect(result.text).toContain('[tool_use read_file');
	});

	it('returns isError=true with the error message when the role is unknown', async () => {
		const factory = fakeFactoryEmitting([{ kind: 'done' }]);
		const dispatcher = buildWorkerDispatcher({
			brainFactory: factory,
			sessionId: 's1',
			overrides: {},
		});

		const result = await runSpawnWorker(dispatcher, {
			role: 'nonexistent_role',
			task: 'hi',
		});

		expect(result.isError).toBe(true);
		expect(result.text).toMatch(/Unknown role/);
	});

	it('returns isError=true when the worker stream terminates with a brain error', async () => {
		const factory = fakeFactoryEmitting([
			{
				kind: 'error',
				error: { kind: 'unknown', message: 'worker exploded', retriable: false },
			},
		]);
		const dispatcher = buildWorkerDispatcher({
			brainFactory: factory,
			sessionId: 's1',
			overrides: {},
		});

		const result = await runSpawnWorker(dispatcher, {
			role: 'researcher',
			task: 'do it',
		});

		expect(result.isError).toBe(true);
		expect(result.text).toBe('worker exploded');
	});

	it('honours workers.yaml overrides resolved through the dispatcher', async () => {
		const captured: { model?: string } = {};
		const factory: CentralBrainFactory = {
			create: ({ model }) => {
				captured.model = model;
				return {
					async *send() {
						yield { kind: 'text', text: 'ok' };
						yield { kind: 'done' };
					},
				} as CentralBrain;
			},
		};
		const dispatcher = buildWorkerDispatcher({
			brainFactory: factory,
			sessionId: 's1',
			overrides: { roles: { researcher: { model: 'sonnet' } } },
		});

		await runSpawnWorker(dispatcher, { role: 'researcher', task: 'hi' });

		expect(captured.model).toBe('sonnet');
	});
});
