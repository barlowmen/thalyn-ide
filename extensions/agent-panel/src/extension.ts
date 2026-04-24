/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { ExtensionContext, window } from 'vscode';
import { AgentPanelProvider } from './agent-panel';
import { createNodeSpawner, SidecarClient } from './sidecar-client';

let sidecarClient: SidecarClient | undefined;

export function activate(context: ExtensionContext): void {
	// Dev-mode path: walk up from `extensions/agent-panel/` to `sidecar/out/index.js`.
	// TODO(packaging): when the extension is packaged (vsix), the `../../sidecar`
	// walk breaks — the unpacked extension lives in a per-install temp dir with
	// no access to the sidecar source. Resolve by bundling `sidecar/out/` inside
	// the extension at package time (e.g., gulp task copies sidecar/out → media/
	// before vsce pack) and detecting bundle-vs-dev here by whether the bundled
	// path exists. Low priority until we ship a packaged build.
	const sidecarEntry = path.resolve(context.extensionPath, '..', '..', 'sidecar', 'out', 'index.js');
	const output = window.createOutputChannel('Thalyn Agent');
	context.subscriptions.push(output);

	sidecarClient = new SidecarClient({
		spawner: createNodeSpawner(sidecarEntry),
		onStderr: line => output.appendLine(`[sidecar] ${line}`),
		onStateChanged: state => output.appendLine(`[sidecar] state=${state}`),
	});
	sidecarClient.start();
	context.subscriptions.push({ dispose: () => sidecarClient?.dispose() });

	const provider = new AgentPanelProvider(context.extensionUri, () => sidecarClient);
	context.subscriptions.push(
		window.registerWebviewViewProvider(AgentPanelProvider.viewType, provider, {
			webviewOptions: { retainContextWhenHidden: true }
		})
	);
}

export function deactivate(): void {
	sidecarClient?.dispose();
	sidecarClient = undefined;
}
