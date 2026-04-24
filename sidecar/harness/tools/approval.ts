/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type {
	ApprovalDecision,
	ToolApprovalReplyParams,
	ToolApprovalRequestParams,
	ToolTier,
} from '../../protocol';

/**
 * Harness-owned approval gate for destructive tool calls.
 *
 * Every tool call the harness dispatches to a backend first passes
 * through `check()`. Tools whose tier is `read` auto-approve; others
 * (`write | delete | external`) prompt the user via the
 * `tool.approval.request` wire protocol and wait for a matching
 * `tool.approval.reply`. Tools the user explicitly approved for the
 * session pass through without re-prompting.
 *
 * This is the authoritative gate. The Claude adapter's
 * SDK-level `canUseTool` hook delegates here; under API-key auth that
 * hook fires and defers to us, under OAuth auth the SDK bypasses the
 * hook, but once the dispatcher's `invoke()` is on the tool execution
 * path the gate runs regardless of the SDK's behaviour. Until then,
 * the adapter continues to call `check()` from its hook as
 * belt-and-braces.
 *
 * Approval state (`sessionApprovedTools`, `pendingApprovals`) lives on
 * the gate so it is shared across adapter rebuilds. State is in-memory
 * only — cross-restart preservation is not yet implemented and will
 * plug in once session persistence exists.
 */
export class ApprovalGate {
	private readonly pendingApprovals = new Map<string, PendingApproval>();
	private readonly sessionApprovedTools = new Set<string>();

	constructor(private readonly deps: ApprovalGateDeps) { }

	/**
	 * Gate a proposed tool call. Returns once the call is approved,
	 * declined, or the user-response wait is cancelled (turn ended).
	 *
	 * The gate never throws for policy decisions — every outcome comes
	 * back as a structured `ApprovalOutcome`. Callers translate decline
	 * outcomes into whatever surface the brain expects (for the SDK
	 * hook: `{ behavior: 'deny', message }`; for the dispatcher's
	 * `invoke()`: `ToolResult { isError: true }`).
	 */
	async check(request: ApprovalCheckRequest): Promise<ApprovalOutcome> {
		if (request.tier === 'read') {
			return { outcome: 'approve' };
		}
		if (this.sessionApprovedTools.has(request.toolName)) {
			return { outcome: 'approve' };
		}

		const correlationId = this.deps.newApprovalId();
		const decision = await new Promise<{ decision: ApprovalDecision; declineReason?: string }>(resolve => {
			this.pendingApprovals.set(correlationId, {
				turnCorrelationId: request.turnCorrelationId,
				resolve: (decision, declineReason) => resolve({ decision, declineReason }),
			});
			this.deps.requestApproval({
				correlationId,
				turnCorrelationId: request.turnCorrelationId,
				toolName: request.toolName,
				toolTier: request.tier,
				toolUseId: request.toolUseId,
				summary: request.summary,
				input: request.input,
			});
		});

		if (decision.decision === 'approve') {
			return { outcome: 'approve' };
		}
		if (decision.decision === 'approve-for-session') {
			this.sessionApprovedTools.add(request.toolName);
			return { outcome: 'approve' };
		}
		return {
			outcome: 'decline',
			reason: decision.declineReason ?? 'User declined the tool call.',
		};
	}

	/** Resolve the approval matching `reply.correlationId`, if any. */
	handleReply(reply: ToolApprovalReplyParams): void {
		const pending = this.pendingApprovals.get(reply.correlationId);
		if (!pending) {
			return;
		}
		this.pendingApprovals.delete(reply.correlationId);
		pending.resolve(reply.decision, reply.declineReason);
	}

	/**
	 * Resolve every pending approval tied to `turnCorrelationId` as a
	 * decline. Called when a turn ends (normally, with an error, or
	 * cancelled) so no approval prompt outlives its turn.
	 */
	cancelForTurn(turnCorrelationId: string): void {
		for (const [id, pending] of this.pendingApprovals) {
			if (pending.turnCorrelationId === turnCorrelationId) {
				this.pendingApprovals.delete(id);
				pending.resolve('decline', 'Turn ended before the user responded.');
			}
		}
	}

	/** Test-only hook — lets tests assert session-approved state. */
	isApprovedForSession(toolName: string): boolean {
		return this.sessionApprovedTools.has(toolName);
	}
}

export interface ApprovalGateDeps {
	/** Emit a `tool.approval.request` notification to the webview. */
	readonly requestApproval: (params: ToolApprovalRequestParams) => void;
	/** Mint a unique correlation id for a new approval prompt. */
	readonly newApprovalId: () => string;
}

export interface ApprovalCheckRequest {
	readonly toolName: string;
	readonly tier: ToolTier;
	readonly toolUseId: string;
	readonly turnCorrelationId: string;
	readonly summary: string;
	readonly input: Record<string, unknown>;
}

export type ApprovalOutcome =
	| { readonly outcome: 'approve' }
	| { readonly outcome: 'decline'; readonly reason: string };

interface PendingApproval {
	readonly turnCorrelationId: string;
	resolve(decision: ApprovalDecision, declineReason?: string): void;
}
