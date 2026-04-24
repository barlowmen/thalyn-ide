/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { RoleDefinition } from '../types';

/**
 * The implementer role writes or edits code against a narrowly scoped
 * task. Write and edit are allowed; deletion and external actions are
 * not — destructive operations still flow through the approval gate,
 * and leaving delete off the default allowlist keeps the happy path
 * bounded.
 */
export const implementer: RoleDefinition = {
	id: 'implementer',
	defaultModel: 'opus',
	defaultAllowlist: ['read_file', 'grep', 'write_file', 'edit_file'],
	systemPromptTemplate: (task) =>
		[
			'You are a focused implementer operating as a bounded worker.',
			'Your job is to make the narrow change described below. Read what you',
			'need to read, then write the smallest correct change. Do not refactor',
			'adjacent code or "clean up" unrelated files. Report back with the',
			'paths you touched and a one-line summary of each edit.',
			'',
			`Task: ${task}`,
		].join('\n'),
};
