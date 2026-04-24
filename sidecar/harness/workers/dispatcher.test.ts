/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';

import { WorkerDispatcher } from './dispatcher';
import { registerAllRoles } from './roles';
import type { CentralBrainFactory } from './types';

const noopFactory: CentralBrainFactory = {
	create: () => {
		throw new Error('brain factory not wired yet');
	},
};

const noopTools = {} as unknown as import('../tools/dispatcher').ToolDispatcher;

describe('WorkerDispatcher — role registration', () => {
	it('registers the four built-in roles with defaults from their modules', () => {
		const dispatcher = new WorkerDispatcher({ brainFactory: noopFactory, tools: noopTools });
		registerAllRoles(dispatcher);
		expect(dispatcher.roleIds()).toEqual(['researcher', 'implementer', 'reviewer', 'tester']);
	});

	it('defaults every registered role to Opus', () => {
		const dispatcher = new WorkerDispatcher({ brainFactory: noopFactory, tools: noopTools });
		registerAllRoles(dispatcher);
		for (const id of dispatcher.roleIds()) {
			expect(dispatcher.effectiveRole(id).model).toBe('opus');
		}
	});

	it('rejects duplicate role registration', () => {
		const dispatcher = new WorkerDispatcher({ brainFactory: noopFactory, tools: noopTools });
		registerAllRoles(dispatcher);
		expect(() => registerAllRoles(dispatcher)).toThrow(/Role already registered/);
	});

	it('throws a clear error for unknown role ids', () => {
		const dispatcher = new WorkerDispatcher({ brainFactory: noopFactory, tools: noopTools });
		expect(() => dispatcher.effectiveRole('nonexistent')).toThrow(/Unknown role/);
	});

	it('applies workers.yaml model overrides on top of registered defaults', () => {
		const dispatcher = new WorkerDispatcher(
			{ brainFactory: noopFactory, tools: noopTools },
			{ roles: { researcher: { model: 'sonnet' } } },
		);
		registerAllRoles(dispatcher);
		expect(dispatcher.effectiveRole('researcher').model).toBe('sonnet');
		expect(dispatcher.effectiveRole('implementer').model).toBe('opus');
	});

	it('applies workers.yaml allowlist overrides by replacement (not deep-merge)', () => {
		const dispatcher = new WorkerDispatcher(
			{ brainFactory: noopFactory, tools: noopTools },
			{ roles: { researcher: { allowlist: ['read_file'] } } },
		);
		registerAllRoles(dispatcher);
		expect(dispatcher.effectiveRole('researcher').allowlist).toEqual(['read_file']);
	});
});

describe.skip('WorkerDispatcher.spawn — pending implementation', () => {
	it('spawns a researcher that streams its brain events to completion');
	it('spawns an implementer that can reach write_file via the parent tool dispatcher');
	it('spawns a reviewer with a read-only allowlist view');
	it('spawns a tester that can invoke run_command through the approval gate');
	it('constructs an isolated CentralBrain per spawn');
	it('gives the worker a transcript of only the provided context + task (no parent history leak)');
	it('filters tool schemas to the effective role allowlist');
	it('wraps the worker brain in withRetry by default');
	it('honors SpawnOptions.retry = false to disable retry for one call');
	it('honors a per-spawn SpawnOptions.retry policy override');
	it('honors a per-spawn SpawnOptions.model override');
	it('supports Promise.all parallel spawns without shared state');
	it('propagates parent SpawnOptions.signal abort to the worker');
	it('surfaces terminal WorkerResult.text concatenated from text events');
	it('surfaces terminal WorkerResult.toolCalls in emission order');
	it('surfaces terminal WorkerResult.error when the worker terminates on error');
});
