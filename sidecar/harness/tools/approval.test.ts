/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';

import { ApprovalGate, type ApprovalGateDeps } from './approval.js';
import type { ToolApprovalRequestParams } from '../../protocol.js';

interface Captured {
	readonly approvals: ToolApprovalRequestParams[];
}

function buildGate(): { gate: ApprovalGate; captured: Captured } {
	const approvals: ToolApprovalRequestParams[] = [];
	let counter = 0;
	const deps: ApprovalGateDeps = {
		requestApproval: params => approvals.push(params),
		newApprovalId: () => `approval-${++counter}`,
	};
	return { gate: new ApprovalGate(deps), captured: { approvals } };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error('waitFor timed out');
		}
		await new Promise(resolve => setTimeout(resolve, 5));
	}
}

describe('ApprovalGate', () => {
	it('auto-approves read-tier calls without a webview round-trip', async () => {
		const { gate, captured } = buildGate();

		const result = await gate.check({
			toolName: 'read_file',
			tier: 'read',
			toolUseId: 'tu1',
			turnCorrelationId: 't1',
			summary: 'Read /tmp/a.txt',
			input: { path: '/tmp/a.txt' },
		});

		expect(result).toEqual({ outcome: 'approve' });
		expect(captured.approvals).toHaveLength(0);
	});

	it('routes write-tier calls through the webview and honours approve', async () => {
		const { gate, captured } = buildGate();

		const pending = gate.check({
			toolName: 'Write',
			tier: 'write',
			toolUseId: 'tu1',
			turnCorrelationId: 't1',
			summary: 'Create /tmp/a.txt',
			input: { file_path: '/tmp/a.txt', content: 'hi' },
		});
		await waitFor(() => captured.approvals.length === 1);
		expect(captured.approvals[0].toolName).toBe('Write');
		expect(captured.approvals[0].toolTier).toBe('write');

		gate.handleReply({ correlationId: captured.approvals[0].correlationId, decision: 'approve' });

		await expect(pending).resolves.toEqual({ outcome: 'approve' });
		expect(gate.isApprovedForSession('Write')).toBe(false);
	});

	it('surfaces the user reason on decline', async () => {
		const { gate, captured } = buildGate();

		const pending = gate.check({
			toolName: 'Bash',
			tier: 'external',
			toolUseId: 'tu1',
			turnCorrelationId: 't1',
			summary: 'Run shell: rm -rf /',
			input: { command: 'rm -rf /' },
		});
		await waitFor(() => captured.approvals.length === 1);

		gate.handleReply({
			correlationId: captured.approvals[0].correlationId,
			decision: 'decline',
			declineReason: 'Dangerous command rejected.',
		});

		await expect(pending).resolves.toEqual({
			outcome: 'decline',
			reason: 'Dangerous command rejected.',
		});
	});

	it('falls back to a generic decline reason when none is provided', async () => {
		const { gate, captured } = buildGate();

		const pending = gate.check({
			toolName: 'Write',
			tier: 'write',
			toolUseId: 'tu1',
			turnCorrelationId: 't1',
			summary: 'Create /tmp/a.txt',
			input: { file_path: '/tmp/a.txt', content: 'hi' },
		});
		await waitFor(() => captured.approvals.length === 1);

		gate.handleReply({
			correlationId: captured.approvals[0].correlationId,
			decision: 'decline',
		});

		await expect(pending).resolves.toEqual({
			outcome: 'decline',
			reason: 'User declined the tool call.',
		});
	});

	it('approve-for-session skips the prompt on subsequent calls to the same tool', async () => {
		const { gate, captured } = buildGate();

		const firstCall = gate.check({
			toolName: 'Bash',
			tier: 'external',
			toolUseId: 'tu1',
			turnCorrelationId: 't1',
			summary: 'Run shell: ls',
			input: { command: 'ls' },
		});
		await waitFor(() => captured.approvals.length === 1);
		gate.handleReply({
			correlationId: captured.approvals[0].correlationId,
			decision: 'approve-for-session',
		});
		await expect(firstCall).resolves.toEqual({ outcome: 'approve' });
		expect(gate.isApprovedForSession('Bash')).toBe(true);

		// A second call to the same tool should not surface a prompt.
		const secondCall = await gate.check({
			toolName: 'Bash',
			tier: 'external',
			toolUseId: 'tu2',
			turnCorrelationId: 't1',
			summary: 'Run shell: pwd',
			input: { command: 'pwd' },
		});

		expect(secondCall).toEqual({ outcome: 'approve' });
		expect(captured.approvals).toHaveLength(1);
	});

	it('cancelForTurn declines every pending approval tied to the given turn', async () => {
		const { gate, captured } = buildGate();

		const pending = gate.check({
			toolName: 'Write',
			tier: 'write',
			toolUseId: 'tu1',
			turnCorrelationId: 't1',
			summary: 'Create /tmp/a.txt',
			input: { file_path: '/tmp/a.txt' },
		});
		await waitFor(() => captured.approvals.length === 1);

		gate.cancelForTurn('t1');

		await expect(pending).resolves.toEqual({
			outcome: 'decline',
			reason: 'Turn ended before the user responded.',
		});
	});

	it('ignores approval replies whose correlationId is unknown', () => {
		const { gate } = buildGate();

		expect(() =>
			gate.handleReply({ correlationId: 'never-asked', decision: 'approve' }),
		).not.toThrow();
	});
});
