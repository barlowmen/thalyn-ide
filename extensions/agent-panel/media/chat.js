/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Webview script for the Thalyn Agent chat panel.
// Protocol source of truth: extensions/agent-panel/src/protocol.ts

(function () {
	'use strict';

	// @ts-ignore - acquireVsCodeApi is injected into the webview global scope.
	const vscode = acquireVsCodeApi();

	const messagesEl = /** @type {HTMLUListElement} */ (document.getElementById('messages'));
	const composerEl = /** @type {HTMLFormElement} */ (document.getElementById('composer'));
	const inputEl = /** @type {HTMLTextAreaElement} */ (document.getElementById('input'));
	const submitEl = /** @type {HTMLButtonElement} */ (document.getElementById('submit'));

	/** @type {Map<string, { textEl: HTMLElement | null, toolsEl: HTMLElement | null, statusEl: HTMLElement }>} */
	const turns = new Map();
	/** @type {Map<string, HTMLElement>} */
	const approvalCards = new Map();

	/** @param {string} role */
	function createMessageElement(role) {
		const li = document.createElement('li');
		li.className = 'message ' + role;
		const roleEl = document.createElement('div');
		roleEl.className = 'message-role';
		roleEl.textContent = role === 'user' ? 'You' : role === 'agent' ? 'Agent' : role;
		li.appendChild(roleEl);
		return li;
	}

	/** @param {string} correlationId */
	function ensureTurnContainer(correlationId) {
		const existing = turns.get(correlationId);
		if (existing) {
			return existing;
		}
		const li = createMessageElement('agent');
		const textEl = document.createElement('div');
		textEl.className = 'message-text';
		li.appendChild(textEl);
		const toolsEl = document.createElement('div');
		toolsEl.className = 'message-tools';
		li.appendChild(toolsEl);
		const statusEl = document.createElement('div');
		statusEl.className = 'message-status';
		statusEl.textContent = 'thinking...';
		li.appendChild(statusEl);
		messagesEl.appendChild(li);
		const record = { textEl, toolsEl, statusEl };
		turns.set(correlationId, record);
		scrollToBottom();
		return record;
	}

	function scrollToBottom() {
		messagesEl.scrollTop = messagesEl.scrollHeight;
	}

	/**
	 * @param {HTMLElement} container
	 * @param {string} className
	 * @param {string} text
	 */
	function appendToolLine(container, className, text) {
		const row = document.createElement('div');
		row.className = 'tool-line ' + className;
		row.textContent = text;
		container.appendChild(row);
		scrollToBottom();
	}

	/** @param {string} text */
	function renderUserMessage(text) {
		const li = createMessageElement('user');
		const textEl = document.createElement('div');
		textEl.className = 'message-text';
		textEl.textContent = text;
		li.appendChild(textEl);
		messagesEl.appendChild(li);
		scrollToBottom();
	}

	/** @param {any} chunk */
	function handleChunk(chunk) {
		const turn = ensureTurnContainer(chunk.correlationId);
		switch (chunk.kind) {
			case 'text': {
				if (turn.textEl && typeof chunk.text === 'string') {
					turn.textEl.textContent = (turn.textEl.textContent || '') + chunk.text;
					scrollToBottom();
				}
				return;
			}
			case 'tool_use': {
				if (turn.toolsEl) {
					const summary = chunk.toolSummary || chunk.toolName || 'Tool call';
					appendToolLine(turn.toolsEl, 'tool-use', '> ' + summary);
				}
				return;
			}
			case 'tool_result': {
				if (turn.toolsEl) {
					const text = typeof chunk.toolResult === 'string' ? chunk.toolResult : '';
					const trimmed = text.length > 240 ? text.slice(0, 240) + '...' : text;
					appendToolLine(turn.toolsEl, chunk.toolIsError ? 'tool-result-error' : 'tool-result', '< ' + trimmed);
				}
				return;
			}
			case 'tool_denied': {
				if (turn.toolsEl) {
					const label = chunk.toolName ? chunk.toolName + ' declined' : 'tool declined';
					appendToolLine(turn.toolsEl, 'tool-denied', 'x ' + label);
				}
				return;
			}
			case 'error': {
				if (turn.toolsEl) {
					const msg = chunk.errorMessage || 'Error';
					appendToolLine(turn.toolsEl, 'tool-error', '! ' + msg);
				}
				turn.statusEl.textContent = '';
				return;
			}
			case 'done': {
				turn.statusEl.textContent = '';
				return;
			}
		}
	}

	/** @param {any} completion */
	function handleComplete(completion) {
		const turn = turns.get(completion.correlationId);
		if (!turn) {
			return;
		}
		if (completion.subtype === 'error') {
			const msg = completion.errorMessage || 'Turn ended with an error';
			appendToolLine(turn.toolsEl || turn.statusEl, 'tool-error', '! ' + msg);
		}
		turn.statusEl.textContent = '';
		setComposerEnabled(true);
	}

	/** @param {any} request */
	function handleApprovalRequest(request) {
		const turn = ensureTurnContainer(request.turnCorrelationId);
		const card = document.createElement('div');
		card.className = 'approval-card';

		const title = document.createElement('div');
		title.className = 'approval-title';
		title.textContent = 'Approve ' + request.toolName + '?';
		card.appendChild(title);

		const summary = document.createElement('div');
		summary.className = 'approval-summary';
		summary.textContent = request.summary || '';
		card.appendChild(summary);

		const details = document.createElement('pre');
		details.className = 'approval-details';
		try {
			details.textContent = JSON.stringify(request.input, null, 2);
		} catch (_e) {
			details.textContent = String(request.input);
		}
		card.appendChild(details);

		const actions = document.createElement('div');
		actions.className = 'approval-actions';
		const approveBtn = document.createElement('button');
		approveBtn.type = 'button';
		approveBtn.className = 'approval-btn approve';
		approveBtn.textContent = 'Approve';
		approveBtn.addEventListener('click', () => respondToApproval(request.correlationId, 'approve'));
		const sessionBtn = document.createElement('button');
		sessionBtn.type = 'button';
		sessionBtn.className = 'approval-btn approve-session';
		sessionBtn.textContent = 'Approve for session';
		sessionBtn.addEventListener('click', () => respondToApproval(request.correlationId, 'approve-for-session'));
		const declineBtn = document.createElement('button');
		declineBtn.type = 'button';
		declineBtn.className = 'approval-btn decline';
		declineBtn.textContent = 'Decline';
		declineBtn.addEventListener('click', () => respondToApproval(request.correlationId, 'decline'));
		actions.appendChild(approveBtn);
		actions.appendChild(sessionBtn);
		actions.appendChild(declineBtn);
		card.appendChild(actions);

		if (turn.toolsEl) {
			turn.toolsEl.appendChild(card);
		} else {
			messagesEl.appendChild(card);
		}
		approvalCards.set(request.correlationId, card);
		scrollToBottom();
	}

	/**
	 * @param {string} correlationId
	 * @param {'approve' | 'decline' | 'approve-for-session'} decision
	 */
	function respondToApproval(correlationId, decision) {
		const card = approvalCards.get(correlationId);
		if (card) {
			card.classList.add('decided', 'decision-' + decision);
			const buttons = card.querySelectorAll('button');
			buttons.forEach(btn => { btn.disabled = true; });
			const tag = document.createElement('div');
			tag.className = 'approval-decision';
			tag.textContent = decision === 'approve'
				? 'Approved'
				: decision === 'approve-for-session'
					? 'Approved for session'
					: 'Declined';
			card.appendChild(tag);
			approvalCards.delete(correlationId);
		}
		vscode.postMessage({ type: 'tool.approval.reply', correlationId, decision });
	}

	/** @param {boolean} enabled */
	function setComposerEnabled(enabled) {
		inputEl.disabled = !enabled;
		submitEl.disabled = !enabled;
		if (enabled) {
			inputEl.focus();
		}
	}

	function submit() {
		const text = inputEl.value.trim();
		if (!text) {
			return;
		}
		const correlationId = crypto.randomUUID();
		renderUserMessage(text);
		ensureTurnContainer(correlationId);
		vscode.postMessage({ type: 'user.submit', correlationId, text });
		inputEl.value = '';
		setComposerEnabled(false);
	}

	composerEl.addEventListener('submit', (event) => {
		event.preventDefault();
		submit();
	});

	inputEl.addEventListener('keydown', (event) => {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			submit();
		}
	});

	window.addEventListener('message', (event) => {
		const message = event.data;
		if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
			return;
		}
		switch (message.type) {
			case 'message.chunk':
				handleChunk(message);
				return;
			case 'message.complete':
				handleComplete(message);
				return;
			case 'tool.approval.request':
				handleApprovalRequest(message);
				return;
		}
	});

	inputEl.focus();
}());
