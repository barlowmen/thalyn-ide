/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Webview <-> extension host message protocol. Sidecar / RPC traffic is
// added by extending these discriminated unions.

export type CorrelationId = string;

export type ToolApprovalDecision = 'approve' | 'decline' | 'approve-for-session';
export type ToolErrorKind = 'network' | 'auth' | 'rate_limit' | 'declined' | 'unknown';
export type ToolTier = 'read' | 'write' | 'delete' | 'external';

export type BudgetUnit = 'usd' | 'gpu_seconds';
export type BudgetWindow = 'daily' | 'weekly';
export type BudgetApprovalReason = 'soft-cap' | 'preflight';

export interface BudgetCategorySnapshot {
	readonly category: string;
	readonly unit: BudgetUnit;
	readonly dailySpend: number;
	readonly weeklySpend: number;
	readonly dailySoftCap: number;
	readonly dailyHardCap: number;
	readonly weeklySoftCap: number;
	readonly weeklyHardCap: number;
	readonly perCallCap: number;
	readonly preflightCap?: number;
}

export interface BudgetSnapshot {
	readonly asOf: number;
	readonly categories: readonly BudgetCategorySnapshot[];
}

export type WebviewToHostMessage =
	| {
		readonly type: 'user.submit';
		readonly correlationId: CorrelationId;
		readonly text: string;
	}
	| {
		readonly type: 'tool.approval.reply';
		readonly correlationId: CorrelationId;
		readonly decision: ToolApprovalDecision;
		readonly declineReason?: string;
	}
	| {
		readonly type: 'budget.approval.reply';
		readonly correlationId: CorrelationId;
		readonly decision: ToolApprovalDecision;
	}
	| {
		readonly type: 'budget.refresh';
	};

export type HostToWebviewMessage =
	| {
		readonly type: 'message.chunk';
		readonly correlationId: CorrelationId;
		readonly kind: 'text' | 'tool_use' | 'tool_result' | 'tool_denied' | 'done' | 'error';
		readonly text?: string;
		readonly toolName?: string;
		readonly toolUseId?: string;
		readonly toolInput?: Record<string, unknown>;
		readonly toolSummary?: string;
		readonly toolResult?: string;
		readonly toolIsError?: boolean;
		readonly errorKind?: ToolErrorKind;
		readonly errorMessage?: string;
	}
	| {
		readonly type: 'message.complete';
		readonly correlationId: CorrelationId;
		readonly subtype: 'success' | 'error';
		readonly errorKind?: ToolErrorKind;
		readonly errorMessage?: string;
	}
	| {
		readonly type: 'tool.approval.request';
		readonly correlationId: CorrelationId;
		readonly turnCorrelationId: CorrelationId;
		readonly toolName: string;
		readonly toolTier: ToolTier;
		readonly toolUseId: string;
		readonly summary: string;
		readonly input: Record<string, unknown>;
	}
	| {
		readonly type: 'budget.approval.request';
		readonly correlationId: CorrelationId;
		readonly category: string;
		readonly reason: BudgetApprovalReason;
		readonly unit: BudgetUnit;
		readonly estimate: number;
		readonly currentSpend?: number;
		readonly window?: BudgetWindow;
		readonly softCap?: number;
		readonly hardCap?: number;
		readonly preflightCap?: number;
	}
	| {
		readonly type: 'budget.snapshot';
		readonly snapshot: BudgetSnapshot;
	};
