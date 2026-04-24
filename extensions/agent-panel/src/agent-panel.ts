/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, Disposable, Uri, Webview, WebviewView, WebviewViewProvider, WebviewViewResolveContext } from 'vscode';
import { HostToWebviewMessage, WebviewToHostMessage } from './protocol';

export class AgentPanelProvider implements WebviewViewProvider {
	public static readonly viewType = 'agentPanel.chat';

	constructor(private readonly extensionUri: Uri) { }

	resolveWebviewView(
		webviewView: WebviewView,
		_context: WebviewViewResolveContext,
		_token: CancellationToken
	): void {
		const mediaRoot = Uri.joinPath(this.extensionUri, 'media');
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [mediaRoot]
		};
		webviewView.webview.html = this.renderHtml(webviewView.webview, mediaRoot);

		const subscription: Disposable = webviewView.webview.onDidReceiveMessage((message: WebviewToHostMessage) => {
			this.handleMessage(webviewView.webview, message);
		});
		webviewView.onDidDispose(() => subscription.dispose());
	}

	private handleMessage(webview: Webview, message: WebviewToHostMessage): void {
		if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
			return;
		}
		switch (message.type) {
			case 'user.submit': {
				// Day 2 stub: echo the submission back. Day 4 replaces this
				// with a dispatch into the sidecar's message.send flow.
				const reply: HostToWebviewMessage = {
					type: 'echo.result',
					correlationId: message.correlationId,
					text: message.text
				};
				void webview.postMessage(reply);
				return;
			}
		}
	}

	private renderHtml(webview: Webview, mediaRoot: Uri): string {
		const styleUri = webview.asWebviewUri(Uri.joinPath(mediaRoot, 'chat.css'));
		const scriptUri = webview.asWebviewUri(Uri.joinPath(mediaRoot, 'chat.js'));
		const nonce = generateNonce();
		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy"
		content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="stylesheet" href="${styleUri}">
	<title>Thalyn Agent</title>
</head>
<body>
	<div class="chat">
		<ul id="messages" class="messages" aria-live="polite" aria-label="Chat messages"></ul>
		<form id="composer" class="composer">
			<textarea
				id="input"
				class="input"
				rows="2"
				placeholder="Message the agent&#8230;"
				aria-label="Message the agent"></textarea>
			<button type="submit" id="submit" class="submit">Send</button>
		</form>
	</div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}

function generateNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let result = '';
	for (let i = 0; i < 32; i++) {
		result += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return result;
}
