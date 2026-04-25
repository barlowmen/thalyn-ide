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
	const budgetStripEl = /** @type {HTMLDivElement} */ (document.getElementById('budget-strip'));
	const budgetStripToggleEl = /** @type {HTMLButtonElement} */ (document.getElementById('budget-strip-toggle'));
	const budgetStripSummaryEl = /** @type {HTMLSpanElement} */ (document.getElementById('budget-strip-summary'));
	const budgetStripDetailEl = /** @type {HTMLDivElement} */ (document.getElementById('budget-strip-detail'));

	/** @type {Map<string, { textEl: HTMLElement, toolsEl: HTMLElement, statusEl: HTMLElement, errorEl: HTMLElement, errorShown: boolean }>} */
	const turns = new Map();
	/** @type {Map<string, HTMLElement>} */
	const approvalCards = new Map();
	/** @type {Map<string, HTMLElement>} */
	const budgetApprovalCards = new Map();
	/** @type {{ asOf: number, categories: Array<any> } | null} */
	let lastSnapshot = null;
	let budgetStripExpanded = false;

	/** @type {Record<string, string>} */
	const errorKindLabels = {
		network: 'Network error',
		auth: 'Authentication error',
		rate_limit: 'Rate limit',
		declined: 'Declined',
		unknown: 'Error',
	};

	/** @param {string} role */
	function createMessageElement(role) {
		const li = document.createElement('li');
		li.className = 'message ' + role;
		const roleEl = document.createElement('div');
		roleEl.className = 'message-role';
		roleEl.textContent = role === 'user' ? 'You' : role === 'agent' ? 'Thalyn' : role;
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
		const errorEl = document.createElement('div');
		errorEl.className = 'message-error';
		li.appendChild(errorEl);
		const statusEl = document.createElement('div');
		statusEl.className = 'message-status';
		statusEl.textContent = 'thinking...';
		li.appendChild(statusEl);
		messagesEl.appendChild(li);
		const record = { textEl, toolsEl, statusEl, errorEl, errorShown: false };
		turns.set(correlationId, record);
		scrollToBottom();
		return record;
	}

	/**
	 * @param {{ errorEl: HTMLElement, errorShown: boolean }} turn
	 * @param {string | undefined} kind
	 * @param {string | undefined} message
	 */
	function renderTurnError(turn, kind, message) {
		const label = errorKindLabels[kind || 'unknown'] || 'Error';
		const text = message && message.length ? message : 'The turn ended without a response.';
		const block = document.createElement('div');
		block.className = 'error-block error-' + (kind || 'unknown');
		const labelEl = document.createElement('div');
		labelEl.className = 'error-label';
		labelEl.textContent = label;
		block.appendChild(labelEl);
		const textNode = document.createElement('div');
		textNode.className = 'error-text';
		textNode.textContent = text;
		block.appendChild(textNode);
		turn.errorEl.appendChild(block);
		turn.errorShown = true;
		scrollToBottom();
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
				if (typeof chunk.text === 'string') {
					turn.textEl.textContent = (turn.textEl.textContent || '') + chunk.text;
					scrollToBottom();
				}
				return;
			}
			case 'tool_use': {
				const summary = chunk.toolSummary || chunk.toolName || 'Tool call';
				appendToolLine(turn.toolsEl, 'tool-use', '> ' + summary);
				turn.statusEl.textContent = chunk.toolName ? 'running ' + chunk.toolName + '...' : 'running tool...';
				return;
			}
			case 'tool_result': {
				const text = typeof chunk.toolResult === 'string' ? chunk.toolResult : '';
				const trimmed = text.length > 240 ? text.slice(0, 240) + '...' : text;
				appendToolLine(turn.toolsEl, chunk.toolIsError ? 'tool-result-error' : 'tool-result', '< ' + trimmed);
				turn.statusEl.textContent = 'thinking...';
				return;
			}
			case 'tool_denied': {
				const label = chunk.toolName ? chunk.toolName + ' declined' : 'tool declined';
				appendToolLine(turn.toolsEl, 'tool-denied', 'x ' + label);
				turn.statusEl.textContent = 'thinking...';
				return;
			}
			case 'error': {
				renderTurnError(turn, chunk.errorKind, chunk.errorMessage);
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
			setComposerEnabled(true);
			return;
		}
		if (completion.subtype === 'error' && !turn.errorShown) {
			renderTurnError(turn, completion.errorKind, completion.errorMessage);
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

		const details = document.createElement('details');
		details.className = 'approval-details';
		const detailsSummary = document.createElement('summary');
		detailsSummary.textContent = 'Details';
		details.appendChild(detailsSummary);
		const pre = document.createElement('pre');
		pre.className = 'approval-details-body';
		try {
			pre.textContent = JSON.stringify(request.input, null, 2);
		} catch (_e) {
			pre.textContent = String(request.input);
		}
		details.appendChild(pre);
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
			case 'budget.snapshot':
				handleBudgetSnapshot(message.snapshot);
				return;
			case 'budget.approval.request':
				handleBudgetApprovalRequest(message);
				return;
		}
	});

	budgetStripToggleEl.addEventListener('click', () => {
		budgetStripExpanded = !budgetStripExpanded;
		budgetStripDetailEl.hidden = !budgetStripExpanded;
		budgetStripEl.classList.toggle('expanded', budgetStripExpanded);
		budgetStripToggleEl.setAttribute('aria-expanded', budgetStripExpanded ? 'true' : 'false');
	});

	/** @param {{ asOf: number, categories: Array<any> }} snapshot */
	function handleBudgetSnapshot(snapshot) {
		lastSnapshot = snapshot;
		renderBudgetStrip();
	}

	function renderBudgetStrip() {
		if (!lastSnapshot) {
			budgetStripEl.hidden = true;
			return;
		}
		budgetStripEl.hidden = false;
		const categories = lastSnapshot.categories || [];
		const todaySpend = sumDaily(categories);
		const sessionSpend = todaySpend; // session-scoped persistence not yet wired; today's spend is the live floor.
		const nearCap = categories
			.map(decorateWithSeverity)
			.filter(c => c.severity !== 'ok')
			.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));

		while (budgetStripSummaryEl.firstChild) {
			budgetStripSummaryEl.removeChild(budgetStripSummaryEl.firstChild);
		}
		appendPill(budgetStripSummaryEl, 'today: ' + formatUsd(todaySpend), 'ok');
		appendPill(budgetStripSummaryEl, 'session: ' + formatUsd(sessionSpend), 'ok');
		if (nearCap.length === 0) {
			const ok = document.createElement('span');
			ok.textContent = 'all caps comfortable';
			ok.className = 'budget-strip-pill';
			budgetStripSummaryEl.appendChild(ok);
		} else {
			for (const cat of nearCap.slice(0, 2)) {
				appendPill(
					budgetStripSummaryEl,
					cat.category + ' ' + Math.round((cat.dailySpend / Math.max(cat.dailySoftCap, 0.0001)) * 100) + '%',
					cat.severity,
				);
			}
			if (nearCap.length > 2) {
				const more = document.createElement('span');
				more.textContent = '+' + (nearCap.length - 2) + ' more';
				more.className = 'budget-strip-pill';
				budgetStripSummaryEl.appendChild(more);
			}
		}
		renderBudgetDetail(categories);
	}

	/** @param {Array<any>} categories */
	function renderBudgetDetail(categories) {
		while (budgetStripDetailEl.firstChild) {
			budgetStripDetailEl.removeChild(budgetStripDetailEl.firstChild);
		}
		const decorated = categories.map(decorateWithSeverity);
		const sorted = decorated.slice().sort((a, b) => {
			if (a.severity !== b.severity) {
				return severityRank(b.severity) - severityRank(a.severity);
			}
			return a.category.localeCompare(b.category);
		});
		const visible = sorted.filter(c => c.dailySpend > 0 || c.weeklySpend > 0 || c.severity !== 'ok');
		if (visible.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'budget-strip-empty';
			empty.textContent = 'No spend yet today.';
			budgetStripDetailEl.appendChild(empty);
			return;
		}
		for (const cat of visible) {
			const row = document.createElement('div');
			row.className = 'budget-detail-row';
			const name = document.createElement('div');
			name.className = 'budget-detail-name';
			name.textContent = cat.category;
			row.appendChild(name);
			const daily = document.createElement('div');
			daily.className = 'budget-detail-meter ' + (cat.severity === 'ok' ? '' : cat.severity);
			daily.textContent = 'daily ' + formatAmount(cat.dailySpend, cat.unit) + ' / ' + formatAmount(cat.dailySoftCap, cat.unit);
			row.appendChild(daily);
			const weeklyName = document.createElement('div');
			weeklyName.className = 'budget-detail-name';
			weeklyName.textContent = '';
			row.appendChild(weeklyName);
			const weekly = document.createElement('div');
			weekly.className = 'budget-detail-meter';
			weekly.textContent = 'weekly ' + formatAmount(cat.weeklySpend, cat.unit) + ' / ' + formatAmount(cat.weeklySoftCap, cat.unit);
			row.appendChild(weekly);
			budgetStripDetailEl.appendChild(row);
		}
	}

	/** @param {HTMLElement} container @param {string} text @param {string} severity */
	function appendPill(container, text, severity) {
		const pill = document.createElement('span');
		pill.className = 'budget-strip-pill' + (severity && severity !== 'ok' ? ' ' + severity : '');
		pill.textContent = text;
		container.appendChild(pill);
	}

	/** @param {Array<any>} categories */
	function sumDaily(categories) {
		let total = 0;
		for (const c of categories) {
			if (c.unit === 'usd') {
				total += c.dailySpend;
			}
		}
		return total;
	}

	/** @param {any} cat */
	function decorateWithSeverity(cat) {
		const dailyFraction = cat.dailySoftCap > 0 ? cat.dailySpend / cat.dailySoftCap : 0;
		const weeklyFraction = cat.weeklySoftCap > 0 ? cat.weeklySpend / cat.weeklySoftCap : 0;
		const fraction = Math.max(dailyFraction, weeklyFraction);
		let severity = 'ok';
		if (fraction >= 1.0) {
			severity = 'crit';
		} else if (fraction >= 0.75) {
			severity = 'warn';
		}
		return Object.assign({}, cat, { severity });
	}

	function severityRank(s) {
		return s === 'crit' ? 2 : s === 'warn' ? 1 : 0;
	}

	/** @param {number} value */
	function formatUsd(value) {
		return '$' + value.toFixed(2);
	}

	/** @param {number} value @param {string} unit */
	function formatAmount(value, unit) {
		if (unit === 'usd') {
			return formatUsd(value);
		}
		if (unit === 'gpu_seconds') {
			return value.toFixed(0) + 's';
		}
		return String(value);
	}

	/** @param {any} request */
	function handleBudgetApprovalRequest(request) {
		const card = document.createElement('div');
		card.className = 'approval-card budget-approval reason-' + request.reason;

		const title = document.createElement('div');
		title.className = 'approval-title';
		title.textContent = request.reason === 'preflight'
			? 'Approve expensive ' + request.category + ' call?'
			: 'Approve ' + (request.window || '') + ' soft cap for ' + request.category + '?';
		card.appendChild(title);

		const meta = document.createElement('div');
		meta.className = 'approval-meta';
		const lines = [];
		lines.push('estimate ' + formatAmount(request.estimate, request.unit));
		if (request.reason === 'preflight' && typeof request.preflightCap === 'number') {
			lines.push('preflight cap ' + formatAmount(request.preflightCap, request.unit));
		}
		if (request.reason === 'soft-cap') {
			if (typeof request.currentSpend === 'number') {
				lines.push((request.window || 'window') + ' so far ' + formatAmount(request.currentSpend, request.unit));
			}
			if (typeof request.softCap === 'number') {
				lines.push('soft cap ' + formatAmount(request.softCap, request.unit));
			}
			if (typeof request.hardCap === 'number') {
				lines.push('hard cap ' + formatAmount(request.hardCap, request.unit));
			}
		}
		meta.textContent = lines.join(' · ');
		card.appendChild(meta);

		const actions = document.createElement('div');
		actions.className = 'approval-actions';
		const approveBtn = document.createElement('button');
		approveBtn.type = 'button';
		approveBtn.className = 'approval-btn approve';
		approveBtn.textContent = 'Approve';
		approveBtn.addEventListener('click', () => respondToBudgetApproval(request.correlationId, 'approve'));
		const sessionBtn = document.createElement('button');
		sessionBtn.type = 'button';
		sessionBtn.className = 'approval-btn approve-session';
		sessionBtn.textContent = 'Approve for session';
		sessionBtn.addEventListener('click', () => respondToBudgetApproval(request.correlationId, 'approve-for-session'));
		const declineBtn = document.createElement('button');
		declineBtn.type = 'button';
		declineBtn.className = 'approval-btn decline';
		declineBtn.textContent = 'Decline';
		declineBtn.addEventListener('click', () => respondToBudgetApproval(request.correlationId, 'decline'));
		actions.appendChild(approveBtn);
		actions.appendChild(sessionBtn);
		actions.appendChild(declineBtn);
		card.appendChild(actions);

		messagesEl.appendChild(card);
		budgetApprovalCards.set(request.correlationId, card);
		scrollToBottom();
	}

	/**
	 * @param {string} correlationId
	 * @param {'approve' | 'decline' | 'approve-for-session'} decision
	 */
	function respondToBudgetApproval(correlationId, decision) {
		const card = budgetApprovalCards.get(correlationId);
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
			budgetApprovalCards.delete(correlationId);
		}
		vscode.postMessage({ type: 'budget.approval.reply', correlationId, decision });
	}

	inputEl.focus();
	vscode.postMessage({ type: 'budget.refresh' });
}());
