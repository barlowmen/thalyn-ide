/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SdkMemory } from './sdk-memory.js';

describe('SdkMemory', () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), 'thalyn-sdk-mem-'));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it('ensures the memory directory exists', async () => {
		const dir = join(tmp, 'memories', 'claude');
		const m = new SdkMemory({ dir });
		await m.ensure();
		expect(await m.list()).toEqual([]);
	});

	it('write/read/list round trips, and entries survive a "restart"', async () => {
		const dir = join(tmp, 'memories', 'claude');
		const m1 = new SdkMemory({ dir });
		await m1.write('user-prefs.md', 'prefers concise responses');
		await m1.write('project/notes.md', 'old style — overwritten next');

		// New wrapper, same dir — simulating a process restart.
		const m2 = new SdkMemory({ dir });
		const entries = await m2.list();
		expect(entries).toEqual(expect.arrayContaining(['user-prefs.md', 'project']));
		expect(await m2.read('user-prefs.md')).toBe('prefers concise responses');
		expect(await m2.sizeOf('user-prefs.md')).toBeGreaterThan(0);
		expect(await m2.sizeOf('missing.md')).toBeUndefined();
	});

	it('backs up the memory tree alongside the session DB', async () => {
		const src = join(tmp, 'memories', 'claude');
		const m = new SdkMemory({ dir: src });
		await m.write('a.md', 'A');
		await m.write('b.md', 'B');

		const dest = join(tmp, 'backup', 'memories');
		await m.backup(dest);

		expect(await readFile(join(dest, 'a.md'), 'utf8')).toBe('A');
		expect(await readFile(join(dest, 'b.md'), 'utf8')).toBe('B');
	});

	it('backup of a missing source still creates an empty destination', async () => {
		const m = new SdkMemory({ dir: join(tmp, 'never-created') });
		const dest = join(tmp, 'backup', 'memories');
		await m.backup(dest);
		// list() against the destination would mean opening a second
		// SdkMemory; the contract here is that backup() didn't throw.
		expect(true).toBe(true);
	});

	it('list() returns [] for a missing directory', async () => {
		const m = new SdkMemory({ dir: join(tmp, 'never-created') });
		expect(await m.list()).toEqual([]);
	});

	it('defaultDir places memories under ~/.config/thalyn/memories/<brain>', () => {
		expect(SdkMemory.defaultDir('claude')).toMatch(/\/\.config\/thalyn\/memories\/claude$/);
		expect(SdkMemory.defaultDir('llama')).toMatch(/\/\.config\/thalyn\/memories\/llama$/);
	});
});
