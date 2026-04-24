/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Webview <-> extension host message protocol. Sidecar / RPC traffic is
// added by extending these discriminated unions.

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
