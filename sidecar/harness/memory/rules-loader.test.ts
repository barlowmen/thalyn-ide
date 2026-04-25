/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RulesLoader, type RulesLoaderOptions } from './rules-loader.js';

describe('RulesLoader', () => {
	let tmp: string;
	let opts: RulesLoaderOptions;

	beforeEach(async () => {
		tmp = mkdtempSync(join(tmpdir(), 'thalyn-rules-'));
		await mkdir(join(tmp, 'config'), { recursive: true });
		await mkdir(join(tmp, 'project', '.thalyn'), { recursive: true });
		opts = {
			identityPath: join(tmp, 'config', 'identity.md'),
			preferencesPath: join(tmp, 'config', 'agent-preferences.md'),
			projectRulesPath: join(tmp, 'project', '.thalyn', 'rules.md'),
		};
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it('loads all three layers when present', async () => {
		await writeFile(opts.identityPath, '# Me\nI am John.\n', 'utf8');
		await writeFile(opts.preferencesPath, 'Prefer terse replies.\n', 'utf8');
		await writeFile(opts.projectRulesPath, 'Use TypeScript strict.\n', 'utf8');
		const files = await new RulesLoader(opts).load();
		expect(files.identity).toContain('I am John');
		expect(files.preferences).toContain('terse');
		expect(files.projectRules).toContain('strict');
	});

	it('treats missing files as absent layers, not as errors', async () => {
		await writeFile(opts.identityPath, 'identity only', 'utf8');
		const files = await new RulesLoader(opts).load();
		expect(files.identity).toBe('identity only');
		expect(files.preferences).toBeUndefined();
		expect(files.projectRules).toBeUndefined();
	});

	it('assembles layers with project rules last so the closer instruction wins', () => {
		const out = RulesLoader.assemble({
			identity: 'I am the user.',
			preferences: 'Be brief.',
			projectRules: 'In this repo, prefer ASCII.',
		});
		const idxIdentity = out.indexOf('# Identity');
		const idxPrefs = out.indexOf('# Agent preferences');
		const idxProject = out.indexOf('# Project rules');
		expect(idxIdentity).toBeGreaterThanOrEqual(0);
		expect(idxPrefs).toBeGreaterThan(idxIdentity);
		expect(idxProject).toBeGreaterThan(idxPrefs);
	});

	it('omits sections for absent layers', () => {
		const out = RulesLoader.assemble({ projectRules: 'rules!' });
		expect(out).toContain('# Project rules');
		expect(out).not.toContain('# Identity');
		expect(out).not.toContain('# Agent preferences');
	});

	it('returns empty string when no layers are present', () => {
		expect(RulesLoader.assemble({})).toBe('');
	});

	it('builds default paths under ~/.config/thalyn and <workspace>/.thalyn', () => {
		const paths = RulesLoader.defaultPaths('/some/workspace');
		expect(paths.identityPath).toMatch(/\/\.config\/thalyn\/identity\.md$/);
		expect(paths.preferencesPath).toMatch(/\/\.config\/thalyn\/agent-preferences\.md$/);
		expect(paths.projectRulesPath).toBe('/some/workspace/.thalyn/rules.md');
	});
});
