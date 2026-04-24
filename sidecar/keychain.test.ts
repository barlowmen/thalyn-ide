/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { loadAnthropicApiKey, type KeytarLike } from './keychain';

function fakeKeytar(result: string | null | Error): KeytarLike {
	return {
		getPassword: async () => {
			if (result instanceof Error) {
				throw result;
			}
			return result;
		},
	};
}

describe('loadAnthropicApiKey', () => {
	it('prefers the Keychain value when one is present', async () => {
		const source = await loadAnthropicApiKey({
			keytarModule: fakeKeytar('sk-keychain'),
			env: { ANTHROPIC_API_KEY: 'sk-env' },
			logger: () => { },
		});
		expect(source).toEqual({ key: 'sk-keychain', origin: 'keychain' });
	});

	it('falls back to the env var when the Keychain entry is empty', async () => {
		const source = await loadAnthropicApiKey({
			keytarModule: fakeKeytar(null),
			env: { ANTHROPIC_API_KEY: 'sk-env' },
			logger: () => { },
		});
		expect(source).toEqual({ key: 'sk-env', origin: 'env' });
	});

	it('falls back to the env var when the Keychain lookup throws', async () => {
		const source = await loadAnthropicApiKey({
			keytarModule: fakeKeytar(new Error('boom')),
			env: { ANTHROPIC_API_KEY: 'sk-env' },
			logger: () => { },
		});
		expect(source.origin).toBe('env');
		expect(source.key).toBe('sk-env');
	});

	it('returns null when neither source has a value, so the SDK can use Claude Code OAuth', async () => {
		const source = await loadAnthropicApiKey({
			keytarModule: fakeKeytar(null),
			env: {},
			logger: () => { },
		});
		expect(source).toBeNull();
	});
});
