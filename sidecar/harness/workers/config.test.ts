/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadWorkersConfig, parseWorkersConfig, WorkersConfigError } from './config';

describe('parseWorkersConfig', () => {
	it('returns the empty override when source is empty', () => {
		expect(parseWorkersConfig('')).toEqual({});
		expect(parseWorkersConfig('\n   \n')).toEqual({});
	});

	it('returns the empty override when roles is null or absent', () => {
		expect(parseWorkersConfig('roles:\n')).toEqual({});
		expect(parseWorkersConfig('# nothing here')).toEqual({});
	});

	it('parses model and allowlist for each role', () => {
		const yaml = [
			'roles:',
			'  researcher:',
			'    model: sonnet',
			'    allowlist:',
			'      - read_file',
			'      - grep',
			'  implementer:',
			'    model: opus',
			'',
		].join('\n');
		expect(parseWorkersConfig(yaml)).toEqual({
			roles: {
				researcher: { model: 'sonnet', allowlist: ['read_file', 'grep'] },
				implementer: { model: 'opus' },
			},
		});
	});

	it('rejects a role with a non-string model', () => {
		const yaml = `roles:\n  researcher:\n    model: 1\n`;
		expect(() => parseWorkersConfig(yaml)).toThrow(WorkersConfigError);
	});

	it('rejects an allowlist that is not an array of strings', () => {
		const yaml = `roles:\n  researcher:\n    allowlist: [read_file, 5]\n`;
		expect(() => parseWorkersConfig(yaml)).toThrow(WorkersConfigError);
	});
});

describe('loadWorkersConfig', () => {
	const dirs: string[] = [];
	afterEach(async () => {
		while (dirs.length > 0) {
			await rm(dirs.pop()!, { recursive: true, force: true });
		}
	});

	it('returns the empty override when the file is missing', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'workers-cfg-'));
		dirs.push(dir);
		const result = await loadWorkersConfig(join(dir, 'workers.yaml'));
		expect(result).toEqual({});
	});

	it('parses an on-disk workers.yaml', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'workers-cfg-'));
		dirs.push(dir);
		const path = join(dir, 'workers.yaml');
		await writeFile(path, 'roles:\n  reviewer:\n    model: haiku\n', 'utf8');
		const result = await loadWorkersConfig(path);
		expect(result).toEqual({ roles: { reviewer: { model: 'haiku' } } });
	});
});
