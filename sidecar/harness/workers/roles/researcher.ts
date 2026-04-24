/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { RoleDefinition } from '../types';

/**
 * The researcher role is read-only: it investigates a question and
 * returns a concise factual summary to the parent. It is the default
 * choice for "go find out X" delegations.
 */
export const researcher: RoleDefinition = {
	id: 'researcher',
	defaultModel: 'opus',
	defaultAllowlist: ['read_file', 'grep'],
	systemPromptTemplate: (task) =>
		[
			'You are a focused researcher operating as a bounded worker.',
			'Your job is to investigate the following question against the project and',
			'return a concise factual summary with citations (file paths and line',
			'numbers). Do not propose changes and do not take any write actions.',
			'',
			`Task: ${task}`,
		].join('\n'),
};
