/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Webview script for the Thalyn Agent chat panel.
// Protocol source of truth: extensions/agent-panel/src/protocol.ts

/**
 * @typedef {{ type: 'user.submit', correlationId: string, text: string }} UserSubmit
 * @typedef {UserSubmit} WebviewToHostMessage
 *
 * @typedef {{ type: 'echo.result', correlationId: string, text: string }} EchoResult
 * @typedef {EchoResult} HostToWebviewMessage
 */

(function () {
	'use strict';

	// @ts-ignore - acquireVsCodeApi is injected into the webview global scope.
	const vscode = acquireVsCodeApi();

	const messagesEl = /** @type {HTMLUListElement} */ (document.getElementById('messages'));
	const composerEl = /** @type {HTMLFormElement} */ (document.getElementById('composer'));
	const inputEl = /** @type {HTMLTextAreaElement} */ (document.getElementById('input'));

	// Pending submits keyed by correlationId. Used to drop echoes whose
	// correlationId we did not mint.
	/** @type {Map<string, string>} */
	const pending = new Map();

	/**
	 * @param {'user' | 'echo'} role
	 * @param {string} text
	 */
	function renderMessage(role, text) {
		const li = document.createElement('li');
		li.className = 'message ' + role;

		const roleEl = document.createElement('div');
		roleEl.className = 'message-role';
		roleEl.textContent = role === 'user' ? 'You' : 'Echo';

		const textEl = document.createElement('div');
		textEl.className = 'message-text';
		textEl.textContent = text;

		li.appendChild(roleEl);
		li.appendChild(textEl);
		messagesEl.appendChild(li);
		messagesEl.scrollTop = messagesEl.scrollHeight;
	}

	function submit() {
		const text = inputEl.value.trim();
		if (!text) {
			return;
		}
		const correlationId = crypto.randomUUID();
		renderMessage('user', text);
		pending.set(correlationId, text);
		/** @type {WebviewToHostMessage} */
		const message = { type: 'user.submit', correlationId: correlationId, text: text };
		vscode.postMessage(message);
		inputEl.value = '';
		inputEl.focus();
	}

	composerEl.addEventListener('submit', (event) => {
		event.preventDefault();
		submit();
	});

	inputEl.addEventListener('keydown', (event) => {
		// Enter submits, Shift+Enter inserts a newline.
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			submit();
		}
	});

	window.addEventListener('message', (event) => {
		/** @type {HostToWebviewMessage | undefined} */
		const message = event.data;
		if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
			return;
		}
		switch (message.type) {
			case 'echo.result': {
				if (!pending.has(message.correlationId)) {
					// Echo for a correlationId we did not mint; drop.
					return;
				}
				pending.delete(message.correlationId);
				renderMessage('echo', message.text);
				return;
			}
		}
	});

	inputEl.focus();
}());
