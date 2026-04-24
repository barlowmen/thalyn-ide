/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { LlmProvider } from './types';

/**
 * Name → provider map. Kept intentionally tiny: the worker dispatcher
 * resolves a role's provider by name (`gemini`, `grok`, `ollama`,
 * eventually `claude`) once per session and calls it directly. No
 * routing rules beyond the name lookup live here — role→provider
 * mapping is a dispatcher concern driven by `workers.yaml`.
 */
export class ProviderRegistry {
	private readonly byName = new Map<string, LlmProvider>();

	register(provider: LlmProvider): void {
		if (this.byName.has(provider.name)) {
			throw new Error(`Provider "${provider.name}" is already registered.`);
		}
		this.byName.set(provider.name, provider);
	}

	get(name: string): LlmProvider {
		const provider = this.byName.get(name);
		if (!provider) {
			throw new Error(`No provider registered for "${name}".`);
		}
		return provider;
	}

	has(name: string): boolean {
		return this.byName.has(name);
	}

	list(): readonly string[] {
		return Array.from(this.byName.keys());
	}
}
