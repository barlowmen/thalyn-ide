/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { WorkerDispatcher } from '../dispatcher';
import { implementer } from './implementer';
import { researcher } from './researcher';
import { reviewer } from './reviewer';
import { tester } from './tester';

export { implementer, researcher, reviewer, tester };

/**
 * Register every built-in role on a dispatcher. Adding a new role is
 * one new file plus one line here; `dispatcher.ts` stays untouched.
 */
export function registerAllRoles(dispatcher: WorkerDispatcher): void {
	dispatcher.registerRole(researcher);
	dispatcher.registerRole(implementer);
	dispatcher.registerRole(reviewer);
	dispatcher.registerRole(tester);
}
