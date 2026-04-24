/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from './registry';
import type { LlmProvider } from './types';

const stub = (name: string): LlmProvider => ({
	name,
	generate: async () => ({ text: '', toolCalls: [], model: name }),
});

describe('ProviderRegistry', () => {
	it('registers, lists, and resolves by name', () => {
		const reg = new ProviderRegistry();
		reg.register(stub('gemini'));
		reg.register(stub('grok'));
		expect(reg.list()).toEqual(['gemini', 'grok']);
		expect(reg.get('gemini').name).toBe('gemini');
		expect(reg.has('grok')).toBe(true);
		expect(reg.has('ollama')).toBe(false);
	});

	it('rejects duplicate names', () => {
		const reg = new ProviderRegistry();
		reg.register(stub('gemini'));
		expect(() => reg.register(stub('gemini'))).toThrowError(/already registered/);
	});

	it('throws when asked for an unregistered name', () => {
		const reg = new ProviderRegistry();
		expect(() => reg.get('nope')).toThrowError(/No provider registered/);
	});
});
