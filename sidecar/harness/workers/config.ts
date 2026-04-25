/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';

import type { WorkersYamlOverrides } from './types';

/**
 * Load `sidecar/config/workers.yaml` and return the override map the
 * dispatcher layers onto registered role defaults. Missing files and
 * empty `roles:` mappings collapse to the empty override (registered
 * defaults apply unchanged); shape errors throw so a typo in the user's
 * YAML fails fast at session start rather than silently routing every
 * worker to the wrong model.
 */
export async function loadWorkersConfig(path: string): Promise<WorkersYamlOverrides> {
	let source: string;
	try {
		source = await readFile(path, 'utf8');
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
			return {};
		}
		throw e;
	}
	return parseWorkersConfig(source);
}

/**
 * Parse a raw YAML string into a {@link WorkersYamlOverrides}. Exported
 * so test fixtures can drive parsing without going through disk.
 */
export function parseWorkersConfig(source: string): WorkersYamlOverrides {
	const trimmed = source.trim();
	if (trimmed.length === 0) {
		return {};
	}
	const raw: unknown = parseYaml(source);
	if (raw === null || raw === undefined) {
		return {};
	}
	if (typeof raw !== 'object') {
		throw new WorkersConfigError('workers.yaml must be a YAML mapping.');
	}
	const top = raw as Record<string, unknown>;
	const rolesField = top.roles;
	if (rolesField === null || rolesField === undefined) {
		return {};
	}
	if (typeof rolesField !== 'object') {
		throw new WorkersConfigError('workers.yaml `roles` must be a mapping.');
	}
	const roles: Record<string, { model?: string; allowlist?: readonly string[] } | undefined> = {};
	for (const [id, value] of Object.entries(rolesField as Record<string, unknown>)) {
		if (value === null || value === undefined) {
			continue;
		}
		if (typeof value !== 'object') {
			throw new WorkersConfigError(`workers.yaml role ${id} must be a mapping.`);
		}
		const v = value as Record<string, unknown>;
		const out: { model?: string; allowlist?: readonly string[] } = {};
		if (v.model !== undefined) {
			if (typeof v.model !== 'string' || v.model.length === 0) {
				throw new WorkersConfigError(`workers.yaml role ${id}.model must be a non-empty string.`);
			}
			out.model = v.model;
		}
		if (v.allowlist !== undefined) {
			if (!Array.isArray(v.allowlist) || v.allowlist.some(n => typeof n !== 'string')) {
				throw new WorkersConfigError(`workers.yaml role ${id}.allowlist must be an array of strings.`);
			}
			out.allowlist = v.allowlist as readonly string[];
		}
		roles[id] = out;
	}
	return { roles };
}

export class WorkersConfigError extends Error {
	readonly code = 'WORKERS_CONFIG_INVALID';
	constructor(message: string) {
		super(message);
		this.name = 'WorkersConfigError';
	}
}
