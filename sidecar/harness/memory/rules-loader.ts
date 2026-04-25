/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Three-layer rule files loaded at session start and prepended to the
 * brain's system prompt:
 *
 * 1. Identity — `~/.config/thalyn/identity.md`. Stable user-level facts:
 *    name, role, communication preferences. Authored by the user.
 * 2. Agent preferences — `~/.config/thalyn/agent-preferences.md`.
 *    Behaviour the agent has learned about the user across sessions.
 *    Edited by the agent (via the memory tool) or the user directly.
 * 3. Project rules — `<workspace>/.thalyn/rules.md`. Per-project conventions
 *    (test runner, style, layout). Authored by the user; checked into VCS.
 *
 * Precedence on conflict: project rules > agent preferences > identity
 * (most specific wins). Implementation: identity is rendered first,
 * preferences second, project rules last — system-prompt readers favour
 * the closer instruction, so later sections override earlier ones.
 */
export class RulesLoader {
	constructor(private readonly opts: RulesLoaderOptions) { }

	/**
	 * Read all three rule files. Missing files are not errors — they
	 * silently produce `undefined` for that layer. Other I/O errors
	 * (permission denied, EISDIR, …) propagate so the harness fails fast
	 * rather than silently dropping rules.
	 */
	async load(): Promise<RuleFiles> {
		const [identity, preferences, projectRules] = await Promise.all([
			readOptional(this.opts.identityPath),
			readOptional(this.opts.preferencesPath),
			readOptional(this.opts.projectRulesPath),
		]);
		const out: RuleFiles = {};
		if (identity !== undefined) {
			(out as { identity: string }).identity = identity;
		}
		if (preferences !== undefined) {
			(out as { preferences: string }).preferences = preferences;
		}
		if (projectRules !== undefined) {
			(out as { projectRules: string }).projectRules = projectRules;
		}
		return out;
	}

	/**
	 * Concatenate the loaded rule layers into a single system-prompt
	 * prefix. Empty input produces an empty string. Sections are headed
	 * `# Identity`, `# Agent preferences`, `# Project rules` so the
	 * resulting prompt is human-readable in logs.
	 */
	static assemble(files: RuleFiles): string {
		const sections: string[] = [];
		if (files.identity) {
			sections.push(`# Identity\n\n${files.identity.trim()}`);
		}
		if (files.preferences) {
			sections.push(`# Agent preferences\n\n${files.preferences.trim()}`);
		}
		if (files.projectRules) {
			sections.push(`# Project rules\n\n${files.projectRules.trim()}`);
		}
		return sections.join('\n\n');
	}

	/**
	 * Construct paths from the standard layout: identity and preferences
	 * under `~/.config/thalyn/`, project rules under `<workspace>/.thalyn/`.
	 * Override individual paths via `overrides` for tests or unusual
	 * environments.
	 */
	static defaultPaths(workspaceDir: string, overrides?: Partial<RulesLoaderOptions>): RulesLoaderOptions {
		const home = homedir();
		const config = join(home, '.config', 'thalyn');
		return {
			identityPath: overrides?.identityPath ?? join(config, 'identity.md'),
			preferencesPath: overrides?.preferencesPath ?? join(config, 'agent-preferences.md'),
			projectRulesPath: overrides?.projectRulesPath ?? join(resolve(workspaceDir), '.thalyn', 'rules.md'),
		};
	}
}

async function readOptional(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, 'utf8');
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === 'ENOENT') {
			return undefined;
		}
		throw e;
	}
}

export interface RulesLoaderOptions {
	readonly identityPath: string;
	readonly preferencesPath: string;
	readonly projectRulesPath: string;
}

export interface RuleFiles {
	readonly identity?: string;
	readonly preferences?: string;
	readonly projectRules?: string;
}
