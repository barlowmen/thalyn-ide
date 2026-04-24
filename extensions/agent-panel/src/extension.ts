/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ExtensionContext, window } from 'vscode';
import { AgentPanelProvider } from './agent-panel';

export function activate(context: ExtensionContext): void {
	const provider = new AgentPanelProvider(context.extensionUri);
	context.subscriptions.push(
		window.registerWebviewViewProvider(AgentPanelProvider.viewType, provider, {
			webviewOptions: { retainContextWhenHidden: true }
		})
	);
}

export function deactivate(): void {
	// Sidecar lifecycle arrives in Phase 2 Day 3.
}
