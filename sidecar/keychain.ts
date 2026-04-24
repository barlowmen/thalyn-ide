/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Credential lookup for the sidecar.
 *
 * The bundled Claude Code CLI authenticates in one of two ways:
 *  1. An `ANTHROPIC_API_KEY` env var, which we optionally populate from a
 *     Thalyn-scoped Keychain entry (`thalyn/anthropic-api-key`).
 *  2. OAuth tokens written by `claude login`, picked up by the CLI itself
 *     from `~/.claude/` — no env var needed.
 *
 * This module covers path (1) only and is **best-effort**: if no key is
 * configured, it returns `null` and the sidecar leaves `process.env`
 * untouched so the CLI can fall back to its own OAuth creds. The alternative
 * (throwing) would break the zero-config Claude Code path, which is the
 * common case for this developer.
 *
 * TODO: formalise the credential flow and the key-path schema. The current
 * service/account pair is a placeholder.
 */

const KEYCHAIN_SERVICE = 'thalyn';
const KEYCHAIN_ACCOUNT = 'anthropic-api-key';

export interface ApiKeySource {
	readonly key: string;
	readonly origin: 'keychain' | 'env';
}

export interface KeychainOptions {
	readonly service?: string;
	readonly account?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly keytarModule?: KeytarLike;
	readonly logger?: (line: string) => void;
}

/** Subset of `keytar`'s surface we actually use. Lets tests inject a double. */
export interface KeytarLike {
	getPassword(service: string, account: string): Promise<string | null>;
}

/**
 * Returns the Anthropic API key from Keychain (preferred) or env, or `null`
 * if neither is configured. Callers should treat `null` as "let the bundled
 * CLI handle auth itself" rather than an error.
 */
export async function loadAnthropicApiKey(options: KeychainOptions = {}): Promise<ApiKeySource | null> {
	const env = options.env ?? process.env;
	const service = options.service ?? env.THALYN_KEYCHAIN_SERVICE ?? KEYCHAIN_SERVICE;
	const account = options.account ?? env.THALYN_KEYCHAIN_ACCOUNT ?? KEYCHAIN_ACCOUNT;
	const log = options.logger ?? (line => process.stderr.write(line + '\n'));

	const keytar = options.keytarModule ?? await loadKeytar(log);
	if (keytar) {
		try {
			const stored = await keytar.getPassword(service, account);
			if (stored && stored.length > 0) {
				return { key: stored, origin: 'keychain' };
			}
		} catch (err) {
			log(`keychain: lookup failed (${(err as Error).message}); falling back to env`);
		}
	}

	const fromEnv = env.ANTHROPIC_API_KEY;
	if (fromEnv && fromEnv.length > 0) {
		return { key: fromEnv, origin: 'env' };
	}

	log(`keychain: no ${service}/${account} entry and no ANTHROPIC_API_KEY env; deferring to Claude Code OAuth`);
	return null;
}

async function loadKeytar(log: (line: string) => void): Promise<KeytarLike | undefined> {
	try {
		const mod = require('keytar') as KeytarLike;
		return mod;
	} catch (err) {
		log(`keychain: keytar module unavailable (${(err as Error).message}); env-only mode`);
		return undefined;
	}
}
