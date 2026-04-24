/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, Uri, WebviewView, WebviewViewProvider, WebviewViewResolveContext } from 'vscode';

export class AgentPanelProvider implements WebviewViewProvider {
	public static readonly viewType = 'agentPanel.chat';

	constructor(private readonly extensionUri: Uri) { }

	resolveWebviewView(
		webviewView: WebviewView,
		_context: WebviewViewResolveContext,
		_token: CancellationToken
	): void {
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.extensionUri]
		};
		webviewView.webview.html = this.getPlaceholderHtml();
	}

	private getPlaceholderHtml(): string {
		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Thalyn Agent</title>
	<style>
		body {
			font-family: var(--vscode-font-family);
			color: var(--vscode-foreground);
			padding: 12px;
		}
		h2 {
			font-size: 1.1em;
			margin: 0 0 8px 0;
		}
		p {
			margin: 0;
			color: var(--vscode-descriptionForeground);
			font-size: 0.9em;
		}
	</style>
</head>
<body>
	<h2>Thalyn Agent</h2>
	<p>Placeholder panel. Day 2 brings the chat UI; Day 4 wires up Claude.</p>
</body>
</html>`;
	}
}
