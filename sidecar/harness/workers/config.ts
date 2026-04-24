/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { WorkersYamlOverrides } from './types';

/**
 * Load `sidecar/config/workers.yaml` and return the override map the
 * dispatcher layers onto registered role defaults.
 *
 * Stub. The real YAML parse lands once the `yaml` runtime dependency
 * is added. Until then, returning an empty override map means
 * registered role defaults apply unchanged — which is the intended
 * initial behavior (all roles on Opus, role-default allowlists).
 */
export async function loadWorkersConfig(_path: string): Promise<WorkersYamlOverrides> {
	return {};
}
