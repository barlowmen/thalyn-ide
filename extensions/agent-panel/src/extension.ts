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
	const provider = new AgentPanelProvider(context.extensionUri);
	context.subscriptions.push(
		window.registerWebviewViewProvider(AgentPanelProvider.viewType, provider, {
			webviewOptions: { retainContextWhenHidden: true }
		})
	);

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
}

export function deactivate(): void {
	sidecarClient?.dispose();
	sidecarClient = undefined;
}
