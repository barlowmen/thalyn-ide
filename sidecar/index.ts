/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { PingParams, PingResult } from './protocol';
import { RpcServer } from './rpc';

/**
 * Thalyn sidecar entry point.
 *
 * Spawned by the extension host (`extensions/agent-panel/`) as a long-lived
 * Node child process. Communicates with the extension over stdin/stdout
 * using newline-delimited JSON-RPC 2.0. The choice of `child_process` +
 * stdio over Electron's `UtilityProcess` + MessagePort is deliberate: it
 * keeps the sidecar out of the Electron main-process bootstrap path, so
 * the process boundary is stable against upstream shell changes.
 */
export function main(): void {
	const server = new RpcServer(process.stdin, process.stdout);
	server.register<PingParams, PingResult>('ping', () => ({ timestamp: Date.now() }));

	// Keep the process alive on stdout EPIPE when the parent goes away; Node
	// would otherwise throw an uncaught error. The extension host owns our
	// lifecycle via SIGTERM on deactivation.
	process.stdout.on('error', (err: NodeJS.ErrnoException) => {
		if (err.code === 'EPIPE') {
			process.exit(0);
		}
	});
}

if (require.main === module) {
	main();
}
