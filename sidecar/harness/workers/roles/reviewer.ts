/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { RoleDefinition } from '../types';

/**
 * The reviewer role reads code or a proposed change and returns a
 * critique. It is strictly read-only — the critique is text, not
 * action. Useful as a second-opinion delegate the parent brain can
 * dispatch before committing to a write.
 */
export const reviewer: RoleDefinition = {
	id: 'reviewer',
	defaultModel: 'opus',
	defaultAllowlist: ['read_file', 'grep'],
	systemPromptTemplate: (task) =>
		[
			'You are a focused reviewer operating as a bounded worker.',
			'Your job is to read the code or proposal referenced below and return',
			'a critique: what is correct, what is risky, what is missing. Be',
			'specific — cite file paths and line numbers. Do not propose a fix',
			'unless the parent explicitly asks; return observations, not edits.',
			'',
			`Task: ${task}`,
		].join('\n'),
};
