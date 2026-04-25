/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';

import type { RetryPolicy } from '../brain/retry';
import type {
	BrainError,
	BrainMessage,
	BrainRequest,
	BrainStreamEvent,
	CentralBrain,
} from '../brain/types';
import type { ToolDispatcher } from '../tools/dispatcher';
import type { ToolSchema } from '../tools/types';
import { budgetCategoryForModel, drainWorker, WorkerDispatcher, type WorkerDispatcherDeps } from './dispatcher';
import { registerAllRoles } from './roles';
import type {
	CentralBrainFactory,
	RoleDefinition,
	WorkerContext,
	WorkerResult,
} from './types';

const noopFactory: CentralBrainFactory = {
	create: () => {
		throw new Error('brain factory not wired yet');
	},
};

const noopTools = {} as unknown as ToolDispatcher;

const TEST_SESSION_ID = 's_test';

function makeSchema(name: string): ToolSchema {
	return {
		name,
		description: `test tool ${name}`,
		inputSchema: { type: 'object' },
		tier: name === 'run_command' || name === 'write_file' || name === 'edit_file' ? 'write' : 'read',
	};
}

function makeTools(names: readonly string[]): Pick<ToolDispatcher, 'schemaFor'> {
	const byName = new Map(names.map(n => [n, makeSchema(n)] as const));
	return {
		schemaFor: (name: string) => byName.get(name),
	};
}

const defaultToolNames = [
	'read_file',
	'grep',
	'write_file',
	'edit_file',
	'run_command',
] as const;

const fastRetryPolicy: RetryPolicy = {
	maxAttempts: 3,
	baseMs: 1,
	capMs: 2,
	jitter: () => 0,
	sleep: async () => { /* no wait in tests */ },
};

interface CreateCall {
	readonly model: string;
	readonly brain: CentralBrain;
	readonly budgetCategory: string;
	readonly sessionId: string;
}

interface SendCall {
	readonly model: string;
	readonly request: BrainRequest;
}

type Script = (call: SendCall) => AsyncIterable<BrainStreamEvent>;

function makeFactory(script: Script): {
	factory: CentralBrainFactory;
	creates: CreateCall[];
	sends: SendCall[];
} {
	const creates: CreateCall[] = [];
	const sends: SendCall[] = [];
	const factory: CentralBrainFactory = {
		create: ({ model, budgetCategory, sessionId }) => {
			const brain: CentralBrain = {
				async *send(request) {
					const call: SendCall = { model, request };
					sends.push(call);
					yield* script(call);
				},
			};
			creates.push({ model, brain, budgetCategory, sessionId });
			return brain;
		},
	};
	return { factory, creates, sends };
}

function makeDispatcher(
	deps: Partial<WorkerDispatcherDeps> = {},
	overrides = {},
): WorkerDispatcher {
	const dispatcher = new WorkerDispatcher(
		{
			brainFactory: deps.brainFactory ?? noopFactory,
			tools: deps.tools ?? makeTools(defaultToolNames),
			sessionId: deps.sessionId ?? TEST_SESSION_ID,
		},
		overrides,
	);
	registerAllRoles(dispatcher);
	return dispatcher;
}

async function collect(
	iter: AsyncIterable<BrainStreamEvent>,
): Promise<BrainStreamEvent[]> {
	const out: BrainStreamEvent[] = [];
	for await (const ev of iter) {
		out.push(ev);
	}
	return out;
}

describe('WorkerDispatcher — role registration', () => {
	it('registers the four built-in roles with defaults from their modules', () => {
		const dispatcher = new WorkerDispatcher({ brainFactory: noopFactory, tools: noopTools, sessionId: TEST_SESSION_ID });
		registerAllRoles(dispatcher);
		expect(dispatcher.roleIds()).toEqual(['researcher', 'implementer', 'reviewer', 'tester']);
	});

	it('defaults every registered role to Opus', () => {
		const dispatcher = new WorkerDispatcher({ brainFactory: noopFactory, tools: noopTools, sessionId: TEST_SESSION_ID });
		registerAllRoles(dispatcher);
		for (const id of dispatcher.roleIds()) {
			expect(dispatcher.effectiveRole(id).model).toBe('opus');
		}
	});

	it('rejects duplicate role registration', () => {
		const dispatcher = new WorkerDispatcher({ brainFactory: noopFactory, tools: noopTools, sessionId: TEST_SESSION_ID });
		registerAllRoles(dispatcher);
		expect(() => registerAllRoles(dispatcher)).toThrow(/Role already registered/);
	});

	it('throws a clear error for unknown role ids', () => {
		const dispatcher = new WorkerDispatcher({ brainFactory: noopFactory, tools: noopTools, sessionId: TEST_SESSION_ID });
		expect(() => dispatcher.effectiveRole('nonexistent')).toThrow(/Unknown role/);
	});

	it('applies workers.yaml model overrides on top of registered defaults', () => {
		const dispatcher = new WorkerDispatcher(
			{ brainFactory: noopFactory, tools: noopTools, sessionId: TEST_SESSION_ID },
			{ roles: { researcher: { model: 'sonnet' } } },
		);
		registerAllRoles(dispatcher);
		expect(dispatcher.effectiveRole('researcher').model).toBe('sonnet');
		expect(dispatcher.effectiveRole('implementer').model).toBe('opus');
	});

	it('applies workers.yaml allowlist overrides by replacement (not deep-merge)', () => {
		const dispatcher = new WorkerDispatcher(
			{ brainFactory: noopFactory, tools: noopTools, sessionId: TEST_SESSION_ID },
			{ roles: { researcher: { allowlist: ['read_file'] } } },
		);
		registerAllRoles(dispatcher);
		expect(dispatcher.effectiveRole('researcher').allowlist).toEqual(['read_file']);
	});
});

describe('WorkerDispatcher.spawn — isolated execution', () => {
	it('spawns a researcher that streams its brain events to completion', async () => {
		const { factory, sends } = makeFactory(async function* () {
			yield { kind: 'text', text: 'findings' };
			yield { kind: 'done', stopReason: 'end_turn' };
		});
		const dispatcher = makeDispatcher({ brainFactory: factory });

		const handle = dispatcher.spawn('researcher', 'look into X', []);
		const events = await collect(handle);
		const result = await handle.result;

		expect(events).toEqual([
			{ kind: 'text', text: 'findings' },
			{ kind: 'done', stopReason: 'end_turn' },
		]);
		expect(result).toEqual<WorkerResult>({
			text: 'findings',
			toolCalls: [],
			stopReason: 'end_turn',
			error: undefined,
		});
		expect(sends).toHaveLength(1);
		expect(sends[0].model).toBe('opus');
		expect(sends[0].request.system).toContain('focused researcher');
	});

	it('spawns an implementer that can reach write_file via the parent tool dispatcher', async () => {
		const { factory, sends } = makeFactory(async function* () {
			yield { kind: 'done' };
		});
		const dispatcher = makeDispatcher({ brainFactory: factory });

		const handle = dispatcher.spawn('implementer', 'add a field', []);
		await drainWorker(handle);

		const toolNames = sends[0].request.tools.map(t => t.name);
		expect(toolNames).toEqual(['read_file', 'grep', 'write_file', 'edit_file']);
	});

	it('spawns a reviewer with a read-only allowlist view', async () => {
		const { factory, sends } = makeFactory(async function* () {
			yield { kind: 'done' };
		});
		const dispatcher = makeDispatcher({ brainFactory: factory });

		await drainWorker(dispatcher.spawn('reviewer', 'critique the diff', []));

		const toolNames = sends[0].request.tools.map(t => t.name);
		expect(toolNames).toEqual(['read_file', 'grep']);
		expect(toolNames).not.toContain('write_file');
		expect(toolNames).not.toContain('edit_file');
	});

	it('spawns a tester with run_command available', async () => {
		const { factory, sends } = makeFactory(async function* () {
			yield { kind: 'done' };
		});
		const dispatcher = makeDispatcher({ brainFactory: factory });

		await drainWorker(dispatcher.spawn('tester', 'run unit tests', []));

		const toolNames = sends[0].request.tools.map(t => t.name);
		expect(toolNames).toContain('run_command');
	});

	it('constructs an isolated CentralBrain per spawn', async () => {
		const { factory, creates } = makeFactory(async function* () {
			yield { kind: 'done' };
		});
		const dispatcher = makeDispatcher({ brainFactory: factory });

		await drainWorker(dispatcher.spawn('researcher', 'one', []));
		await drainWorker(dispatcher.spawn('researcher', 'two', []));

		expect(creates).toHaveLength(2);
		expect(creates[0].brain).not.toBe(creates[1].brain);
	});

	it('gives the worker a transcript of only the provided context + task (no parent history leak)', async () => {
		const { factory, sends } = makeFactory(async function* () {
			yield { kind: 'done' };
		});
		const dispatcher = makeDispatcher({ brainFactory: factory });

		const context: WorkerContext = [
			{ role: 'user', content: [{ type: 'text', text: 'prior question' }] },
			{ role: 'assistant', content: [{ type: 'text', text: 'prior answer' }] },
		];

		await drainWorker(dispatcher.spawn('researcher', 'now check Y', context));

		expect(sends[0].request.messages).toEqual<readonly BrainMessage[]>([
			...context,
			{ role: 'user', content: [{ type: 'text', text: 'now check Y' }] },
		]);
	});

	it('fails fast when the effective allowlist references an unknown tool', () => {
		const dispatcher = new WorkerDispatcher({
			brainFactory: noopFactory,
			tools: makeTools(['read_file']),
			sessionId: TEST_SESSION_ID,
		});
		registerAllRoles(dispatcher);
		expect(() => dispatcher.spawn('implementer', 'task', [])).toThrow(
			/allowlist references unknown tool: grep/,
		);
	});
});

describe('WorkerDispatcher.spawn — retry wrapping', () => {
	function retriableErrorEvent(): BrainStreamEvent {
		const error: BrainError = {
			kind: 'network',
			message: 'boom',
			retriable: true,
		};
		return { kind: 'error', error };
	}

	it('wraps the worker brain in withRetry by default', async () => {
		let attempt = 0;
		const { factory } = makeFactory(async function* () {
			attempt++;
			if (attempt === 1) {
				yield retriableErrorEvent();
				return;
			}
			yield { kind: 'text', text: 'ok' };
			yield { kind: 'done' };
		});
		const dispatcher = makeDispatcher({ brainFactory: factory });

		const handle = dispatcher.spawn('researcher', 't', [], { retry: fastRetryPolicy });
		const result = await drainWorker(handle);

		expect(attempt).toBe(2);
		expect(result.text).toBe('ok');
		expect(result.error).toBeUndefined();
	});

	it('honors SpawnOptions.retry = false to disable retry for one call', async () => {
		let attempt = 0;
		const { factory } = makeFactory(async function* () {
			attempt++;
			yield retriableErrorEvent();
		});
		const dispatcher = makeDispatcher({ brainFactory: factory });

		const result = await drainWorker(
			dispatcher.spawn('researcher', 't', [], { retry: false }),
		);

		expect(attempt).toBe(1);
		expect(result.error?.kind).toBe('network');
	});

	it('honors a per-spawn SpawnOptions.retry policy override', async () => {
		let attempt = 0;
		const { factory } = makeFactory(async function* () {
			attempt++;
			yield retriableErrorEvent();
		});
		const dispatcher = makeDispatcher({ brainFactory: factory });

		const override: RetryPolicy = { ...fastRetryPolicy, maxAttempts: 1 };
		const result = await drainWorker(
			dispatcher.spawn('researcher', 't', [], { retry: override }),
		);

		expect(attempt).toBe(1);
		expect(result.error?.kind).toBe('network');
	});

	it('honors role-level retry override below SpawnOptions but above the dispatcher default', async () => {
		let attempt = 0;
		const { factory } = makeFactory(async function* () {
			attempt++;
			yield retriableErrorEvent();
		});
		const custom: RoleDefinition = {
			id: 'no-retry',
			defaultModel: 'opus',
			defaultAllowlist: ['read_file'],
			systemPromptTemplate: () => 'do the thing',
			retry: false,
		};
		const dispatcher = new WorkerDispatcher({
			brainFactory: factory,
			tools: makeTools(defaultToolNames),
			sessionId: TEST_SESSION_ID,
		});
		dispatcher.registerRole(custom);

		const result = await drainWorker(dispatcher.spawn('no-retry', 't', []));

		expect(attempt).toBe(1);
		expect(result.error?.kind).toBe('network');
	});
});

describe('WorkerDispatcher — budget category resolution', () => {
	it('maps Anthropic model aliases and ids to subagent_* categories', () => {
		expect(budgetCategoryForModel('opus')).toBe('subagent_opus');
		expect(budgetCategoryForModel('sonnet')).toBe('subagent_sonnet');
		expect(budgetCategoryForModel('haiku')).toBe('subagent_haiku');
		expect(budgetCategoryForModel('claude-opus-4-7')).toBe('subagent_opus');
		expect(budgetCategoryForModel('claude-sonnet-4-6')).toBe('subagent_sonnet');
	});

	it('maps multi-provider workers to their categories', () => {
		expect(budgetCategoryForModel('gemini-2.5-pro')).toBe('gemini');
		expect(budgetCategoryForModel('grok-4')).toBe('grok');
		expect(budgetCategoryForModel('llama-3.3-70b')).toBe('local_inference');
	});

	it('throws for unknown models so unmetered spend is impossible', () => {
		expect(() => budgetCategoryForModel('mystery-9000')).toThrow(/Cannot resolve budget category/);
	});

	it('forwards budgetCategory and sessionId through the brain factory on spawn', async () => {
		const { factory, creates } = makeFactory(async function* () {
			yield { kind: 'done' };
		});
		const dispatcher = new WorkerDispatcher(
			{ brainFactory: factory, tools: makeTools(defaultToolNames), sessionId: 's_alpha' },
		);
		registerAllRoles(dispatcher);

		await drainWorker(dispatcher.spawn('researcher', 't', [], { retry: false }));
		expect(creates[0]).toMatchObject({ model: 'opus', budgetCategory: 'subagent_opus', sessionId: 's_alpha' });
	});

	it('honors a per-spawn sessionId override', async () => {
		const { factory, creates } = makeFactory(async function* () {
			yield { kind: 'done' };
		});
		const dispatcher = new WorkerDispatcher(
			{ brainFactory: factory, tools: makeTools(defaultToolNames), sessionId: 's_default' },
		);
		registerAllRoles(dispatcher);

		await drainWorker(dispatcher.spawn('researcher', 't', [], { retry: false, sessionId: 's_override' }));
		expect(creates[0].sessionId).toBe('s_override');
	});
});

describe('WorkerDispatcher.spawn — overrides and parallelism', () => {
	it('honors a per-spawn SpawnOptions.model override', async () => {
		const { factory, creates } = makeFactory(async function* () {
			yield { kind: 'done' };
		});
		const dispatcher = makeDispatcher({ brainFactory: factory });

		await drainWorker(
			dispatcher.spawn('researcher', 't', [], { model: 'sonnet', retry: false }),
		);

		expect(creates[0].model).toBe('sonnet');
	});

	it('supports Promise.all parallel spawns without shared state', async () => {
		const { factory, creates, sends } = makeFactory(async function* (call) {
			yield { kind: 'text', text: `task=${(call.request.messages.at(-1)!.content[0] as { text: string }).text}` };
			yield { kind: 'done' };
		});
		const dispatcher = makeDispatcher({ brainFactory: factory });

		const [a, b] = await Promise.all([
			drainWorker(dispatcher.spawn('researcher', 'alpha', [], { retry: false })),
			drainWorker(dispatcher.spawn('implementer', 'beta', [], { retry: false })),
		]);

		expect(creates).toHaveLength(2);
		expect(sends.map(s => (s.request.messages.at(-1)!.content[0] as { text: string }).text))
			.toEqual(['alpha', 'beta']);
		expect(a.text).toBe('task=alpha');
		expect(b.text).toBe('task=beta');
	});
});

describe('WorkerDispatcher.spawn — cancellation', () => {
	function cancellableBrain(): { factory: CentralBrainFactory; signals: AbortSignal[] } {
		const signals: AbortSignal[] = [];
		const factory: CentralBrainFactory = {
			create: () => ({
				async *send(request) {
					signals.push(request.signal!);
					await new Promise<void>((resolve) => {
						if (request.signal?.aborted) {
							resolve();
							return;
						}
						request.signal?.addEventListener('abort', () => resolve(), { once: true });
					});
					const error: BrainError = {
						kind: 'cancelled',
						message: 'aborted',
						retriable: false,
					};
					yield { kind: 'error', error };
				},
			}),
		};
		return { factory, signals };
	}

	it('propagates handle.cancel() into the worker brain signal', async () => {
		const { factory, signals } = cancellableBrain();
		const dispatcher = makeDispatcher({ brainFactory: factory });

		const handle = dispatcher.spawn('researcher', 't', [], { retry: false });
		const drain = drainWorker(handle);
		// Let the brain register its abort listener before we cancel.
		await Promise.resolve();
		handle.cancel();

		const result = await drain;
		expect(signals[0].aborted).toBe(true);
		expect(result.error?.kind).toBe('cancelled');
	});

	it('propagates parent SpawnOptions.signal abort to the worker brain signal', async () => {
		const { factory, signals } = cancellableBrain();
		const dispatcher = makeDispatcher({ brainFactory: factory });

		const parent = new AbortController();
		const handle = dispatcher.spawn('researcher', 't', [], {
			retry: false,
			signal: parent.signal,
		});
		const drain = drainWorker(handle);
		await Promise.resolve();
		parent.abort();

		const result = await drain;
		expect(signals[0].aborted).toBe(true);
		expect(result.error?.kind).toBe('cancelled');
	});

	it('honors an already-aborted parent signal before the worker starts', async () => {
		const { factory, signals } = cancellableBrain();
		const dispatcher = makeDispatcher({ brainFactory: factory });

		const parent = new AbortController();
		parent.abort();

		const handle = dispatcher.spawn('researcher', 't', [], {
			retry: false,
			signal: parent.signal,
		});
		const result = await drainWorker(handle);

		expect(signals[0].aborted).toBe(true);
		expect(result.error?.kind).toBe('cancelled');
	});
});

describe('WorkerDispatcher.spawn — terminal result aggregation', () => {
	it('concatenates text events into WorkerResult.text in emission order', async () => {
		const { factory } = makeFactory(async function* () {
			yield { kind: 'text', text: 'one ' };
			yield { kind: 'text', text: 'two ' };
			yield { kind: 'text', text: 'three' };
			yield { kind: 'done' };
		});
		const dispatcher = makeDispatcher({ brainFactory: factory });

		const result = await drainWorker(
			dispatcher.spawn('researcher', 't', [], { retry: false }),
		);

		expect(result.text).toBe('one two three');
	});

	it('preserves WorkerResult.toolCalls in emission order', async () => {
		const { factory } = makeFactory(async function* () {
			yield { kind: 'tool_use', call: { id: '1', name: 'read_file', input: { path: 'a' } } };
			yield { kind: 'tool_use', call: { id: '2', name: 'grep', input: { pattern: 'x' } } };
			yield { kind: 'done' };
		});
		const dispatcher = makeDispatcher({ brainFactory: factory });

		const result = await drainWorker(
			dispatcher.spawn('researcher', 't', [], { retry: false }),
		);

		expect(result.toolCalls).toEqual([
			{ type: 'tool_use', id: '1', name: 'read_file', input: { path: 'a' } },
			{ type: 'tool_use', id: '2', name: 'grep', input: { pattern: 'x' } },
		]);
	});

	it('surfaces WorkerResult.error when the worker terminates on error', async () => {
		const errorPayload: BrainError = {
			kind: 'auth',
			message: 'missing key',
			retriable: false,
		};
		const { factory } = makeFactory(async function* () {
			yield { kind: 'error', error: errorPayload };
		});
		const dispatcher = makeDispatcher({ brainFactory: factory });

		const result = await drainWorker(
			dispatcher.spawn('researcher', 't', [], { retry: false }),
		);

		expect(result.error).toEqual(errorPayload);
		expect(result.stopReason).toBeUndefined();
	});

	it('allows iterating the handle and awaiting .result against the same run', async () => {
		const { factory } = makeFactory(async function* () {
			yield { kind: 'text', text: 'chunk' };
			yield { kind: 'done', stopReason: 'end_turn' };
		});
		const dispatcher = makeDispatcher({ brainFactory: factory });

		const handle = dispatcher.spawn('researcher', 't', [], { retry: false });
		const events: BrainStreamEvent[] = [];
		for await (const ev of handle) {
			events.push(ev);
		}
		const result = await handle.result;

		expect(events.map(e => e.kind)).toEqual(['text', 'done']);
		expect(result.text).toBe('chunk');
		expect(result.stopReason).toBe('end_turn');
	});
});

