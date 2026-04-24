/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Webview <-> extension host message protocol.
// Design rationale and decisions: .claude/adrs/0002-webview-message-protocol.md
// Day 2: echo stub only. Sidecar / RPC traffic (message.send, message.chunk,
// error.*) is added in Day 3+ by extending these unions.

export type CorrelationId = string;

export type WebviewToHostMessage =
	| {
		readonly type: 'user.submit';
		readonly correlationId: CorrelationId;
		readonly text: string;
	};

export type HostToWebviewMessage =
	| {
		readonly type: 'echo.result';
		readonly correlationId: CorrelationId;
		readonly text: string;
	};
