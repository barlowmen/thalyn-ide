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
	};
