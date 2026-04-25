/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Thalyn. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Wrapper for the file-based memory directory the Claude Agent SDK's
 * Memory Tool persists to. Cross-session by design: one tree per brain
 * (`~/.config/thalyn/memories/claude/`), shared across every session
 * that brain runs. The agent reads and writes here via the Memory Tool;
 * the harness owns directory creation, backup, and the path passed to
 * the SDK.
 *
 * The Llama adapter, when it ships, exposes the same interface against
 * `…/memories/llama/` — the wrapper hand-rolls compaction and read/
 * write hooks for backends that don't have an SDK-managed memory tool.
 */
export class SdkMemory {
	constructor(private readonly opts: SdkMemoryOptions) { }

	/** Absolute path the SDK Memory Tool should be configured to use. */
	get path(): string {
		return this.opts.dir;
	}

	/** Create the directory if it doesn't exist. Safe to call repeatedly. */
	async ensure(): Promise<void> {
		await mkdir(this.opts.dir, { recursive: true });
	}

	/**
	 * List entries currently in the memory directory. Returns an empty
	 * array if the directory does not exist; non-ENOENT errors propagate.
	 * Used by diagnostics and tests; the agent itself reads via the SDK
	 * Memory Tool, not through this method.
	 */
	async list(): Promise<readonly string[]> {
		try {
			return await readdir(this.opts.dir);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
				return [];
			}
			throw e;
		}
	}

	/**
	 * Recursively copy the memory tree to `destination`, creating parent
	 * directories as needed. Used by the harness to back the memory
	 * directory up alongside the session DB on a tenant snapshot — keeps
	 * agent recall and conversation log consistent at the same point
	 * in time.
	 *
	 * Empty source tree (or missing directory) produces an empty
	 * destination directory — backup is best-effort, not authoritative,
	 * and nothing-to-backup is a normal first-run state.
	 */
	async backup(destination: string): Promise<void> {
		await mkdir(dirname(destination), { recursive: true });
		try {
			await cp(this.opts.dir, destination, { recursive: true, force: true });
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
				await mkdir(destination, { recursive: true });
				return;
			}
			throw e;
		}
	}

	/**
	 * Read a memory entry's contents. Used by tests and the future
	 * inspection UI; the agent does not call through here. Throws on
	 * missing entry — callers wanting "maybe present" semantics should
	 * `list()` first.
	 */
	async read(name: string): Promise<string> {
		return readFile(join(this.opts.dir, name), 'utf8');
	}

	/**
	 * Write a memory entry. Used by tests and the brain-agnostic adapter
	 * fallback (Llama); the Claude SDK's Memory Tool calls bypass this
	 * since the SDK owns the file I/O.
	 */
	async write(name: string, contents: string): Promise<void> {
		const target = join(this.opts.dir, name);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, contents, 'utf8');
	}

	/** Return the size in bytes of `name`, or undefined if missing. */
	async sizeOf(name: string): Promise<number | undefined> {
		try {
			const s = await stat(join(this.opts.dir, name));
			return s.size;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
				return undefined;
			}
			throw e;
		}
	}

	/**
	 * Standard layout for the `claude` brain memory dir. Override `dir`
	 * for tests; production callers should use the default.
	 */
	static defaultDir(brain: 'claude' | 'llama'): string {
		return join(homedir(), '.config', 'thalyn', 'memories', brain);
	}
}

export interface SdkMemoryOptions {
	readonly dir: string;
}
