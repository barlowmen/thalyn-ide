/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { RoleDefinition } from '../types';

/**
 * The tester role runs tests and reports results. `run_command` is on
 * the allowlist so the worker can invoke the project's test scripts;
 * the approval gate still arbitrates the call (any write-tier tool
 * goes through the gate regardless of which worker invokes it).
 */
export const tester: RoleDefinition = {
	id: 'tester',
	defaultModel: 'opus',
	defaultAllowlist: ['read_file', 'grep', 'run_command'],
	systemPromptTemplate: (task) =>
		[
			'You are a focused tester operating as a bounded worker.',
			'Your job is to run the tests described below, read any failure',
			'output, and report back a structured summary: tests run, tests',
			'failed, the shortest relevant snippet from each failure. Do not',
			'attempt to fix failures — report them.',
			'',
			`Task: ${task}`,
		].join('\n'),
};
