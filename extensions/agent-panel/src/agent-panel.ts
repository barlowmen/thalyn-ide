/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, Disposable, Uri, Webview, WebviewView, WebviewViewProvider, WebviewViewResolveContext } from 'vscode';
import type {
	BudgetApprovalReplyParams,
	BudgetApprovalRequestParams,
	BudgetSnapshotResult,
	MessageChunkParams,
	MessageSendParams,
	MessageSendResult,
	ToolApprovalRequestParams,
	ToolApprovalReplyParams,
} from '../../../sidecar/protocol';
import type { HostToWebviewMessage, WebviewToHostMessage } from './protocol';
import type { NotificationSubscription, SidecarClient } from './sidecar-client';

/**
 * Bridges the chat webview and the sidecar over the extension host.
 *
 * The webview speaks a small discriminated-union protocol (see `protocol.ts`);
 * the sidecar speaks JSON-RPC. This provider owns the fan-out / fan-in
 * translation between the two so the approval round-trip, streaming chunks,
 * and completion events all correlate by `correlationId`.
 */
export class AgentPanelProvider implements WebviewViewProvider {
	public static readonly viewType = 'agentPanel.chat';

	constructor(
		private readonly extensionUri: Uri,
		private readonly sidecarProvider: () => SidecarClient | undefined,
	) { }

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

		const subscriptions: Disposable[] = [];

		subscriptions.push(webviewView.webview.onDidReceiveMessage((message: WebviewToHostMessage) => {
			this.handleMessageFromWebview(webviewView.webview, message);
		}));

		const sidecar = this.sidecarProvider();
		if (sidecar) {
			subscriptions.push(disposableFor(sidecar.onNotification<MessageChunkParams>(
				'message.chunk',
				params => this.onChunk(webviewView.webview, params),
			)));
			subscriptions.push(disposableFor(sidecar.onNotification<ToolApprovalRequestParams>(
				'tool.approval.request',
				params => this.onApprovalRequest(webviewView.webview, params),
			)));
			subscriptions.push(disposableFor(sidecar.onNotification<BudgetApprovalRequestParams>(
				'budget.approval.request',
				params => this.onBudgetApprovalRequest(webviewView.webview, params),
			)));
			subscriptions.push(disposableFor(sidecar.onNotification<undefined>(
				'budget.changed',
				() => { void this.pushSnapshot(webviewView.webview); },
			)));
			void this.pushSnapshot(webviewView.webview);
		}

		webviewView.onDidDispose(() => {
			for (const sub of subscriptions) {
				sub.dispose();
			}
		});
	}

	private handleMessageFromWebview(webview: Webview, message: WebviewToHostMessage): void {
		if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
			return;
		}
		const sidecar = this.sidecarProvider();
		switch (message.type) {
			case 'user.submit': {
				if (!sidecar) {
					const reply: HostToWebviewMessage = {
						type: 'message.complete',
						correlationId: message.correlationId,
						subtype: 'error',
						errorKind: 'unknown',
						errorMessage: 'Sidecar is not running.',
					};
					void webview.postMessage(reply);
					return;
				}
				const params: MessageSendParams = {
					correlationId: message.correlationId,
					text: message.text,
				};
				sidecar.call<MessageSendResult, MessageSendParams>('message.send', params)
					.then(result => {
						const reply: HostToWebviewMessage = {
							type: 'message.complete',
							correlationId: result.correlationId,
							subtype: result.subtype,
							errorKind: result.errorKind,
							errorMessage: result.errorMessage,
						};
						void webview.postMessage(reply);
					})
					.catch((err: Error) => {
						const reply: HostToWebviewMessage = {
							type: 'message.complete',
							correlationId: message.correlationId,
							subtype: 'error',
							errorKind: 'unknown',
							errorMessage: err.message,
						};
						void webview.postMessage(reply);
					});
				return;
			}
			case 'tool.approval.reply': {
				if (!sidecar) {
					return;
				}
				const reply: ToolApprovalReplyParams = {
					correlationId: message.correlationId,
					decision: message.decision,
					declineReason: message.declineReason,
				};
				sidecar.notify('tool.approval.reply', reply);
				return;
			}
			case 'budget.approval.reply': {
				if (!sidecar) {
					return;
				}
				const reply: BudgetApprovalReplyParams = {
					correlationId: message.correlationId,
					decision: message.decision,
				};
				sidecar.notify('budget.approval.reply', reply);
				return;
			}
			case 'budget.refresh': {
				void this.pushSnapshot(webview);
				return;
			}
		}
	}

	private onChunk(webview: Webview, params: MessageChunkParams): void {
		const host: HostToWebviewMessage = {
			type: 'message.chunk',
			correlationId: params.correlationId,
			kind: params.kind,
			text: params.text,
			toolName: params.toolName,
			toolUseId: params.toolUseId,
			toolInput: params.toolInput,
			toolSummary: params.toolSummary,
			toolResult: params.toolResult,
			toolIsError: params.toolIsError,
			errorKind: params.errorKind,
			errorMessage: params.errorMessage,
		};
		void webview.postMessage(host);
	}

	private onApprovalRequest(webview: Webview, params: ToolApprovalRequestParams): void {
		const host: HostToWebviewMessage = {
			type: 'tool.approval.request',
			correlationId: params.correlationId,
			turnCorrelationId: params.turnCorrelationId,
			toolName: params.toolName,
			toolTier: params.toolTier,
			toolUseId: params.toolUseId,
			summary: params.summary,
			input: params.input,
		};
		void webview.postMessage(host);
	}

	private onBudgetApprovalRequest(webview: Webview, params: BudgetApprovalRequestParams): void {
		const host: HostToWebviewMessage = {
			type: 'budget.approval.request',
			correlationId: params.correlationId,
			category: params.category,
			reason: params.reason,
			unit: params.unit,
			estimate: params.estimate,
			currentSpend: params.currentSpend,
			window: params.window,
			softCap: params.softCap,
			hardCap: params.hardCap,
			preflightCap: params.preflightCap,
		};
		void webview.postMessage(host);
	}

	private async pushSnapshot(webview: Webview): Promise<void> {
		const sidecar = this.sidecarProvider();
		if (!sidecar) {
			return;
		}
		try {
			const snapshot = await sidecar.call<BudgetSnapshotResult>('budget.snapshot');
			const host: HostToWebviewMessage = { type: 'budget.snapshot', snapshot };
			void webview.postMessage(host);
		} catch {
			// The sidecar may have crashed or be restarting. Swallow — the
			// next `budget.changed` (or a manual refresh) will retry.
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
		<div id="budget-strip" class="budget-strip" role="status" aria-live="polite" aria-label="Budget summary" hidden>
			<button type="button" id="budget-strip-toggle" class="budget-strip-toggle"
				aria-expanded="false" aria-controls="budget-strip-detail">
				<span id="budget-strip-summary" class="budget-strip-summary"></span>
				<span class="budget-strip-chevron" aria-hidden="true">&#9660;</span>
			</button>
			<div id="budget-strip-detail" class="budget-strip-detail" hidden></div>
		</div>
		<ul id="messages" class="messages" aria-live="polite" aria-label="Chat messages"></ul>
		<form id="composer" class="composer">
			<textarea
				id="input"
				class="input"
				rows="3"
				placeholder="Message Thalyn&#8230;"
				aria-label="Message Thalyn"></textarea>
			<button type="submit" id="submit" class="submit">Send</button>
		</form>
	</div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}

function disposableFor(sub: NotificationSubscription): Disposable {
	return { dispose: () => sub.dispose() };
}

function generateNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let result = '';
	for (let i = 0; i < 32; i++) {
		result += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return result;
}
