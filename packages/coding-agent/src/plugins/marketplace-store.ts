import { createHash } from "node:crypto";
import { isAbsolute, join, posix, relative, sep } from "node:path";
import type { IdGenerator } from "@coda/agent";
import { withFileMutex } from "../host/file-mutex.ts";
import type { FileStatus, FileSystem, WritableFile } from "../host/file-system.ts";
import { isFileSystemError } from "../host/file-system.ts";
import type { ProcessRunner } from "../host/process-runner.ts";
import {
	type CodingPluginMarketplace,
	type CodingPluginMarketplaceDiagnostic,
	type CodingPluginMarketplaceEntry,
	loadCodingPluginMarketplace,
} from "./marketplace.ts";
import { pathHasComponent, resolvePluginTreeEntry } from "./package-tree.ts";
import { isCodingPluginLocalSource } from "./types.ts";

export interface CodingPluginMarketplaceStoreLocalSource {
	readonly source: "local";
	readonly root: string;
}

export interface CodingPluginMarketplaceStoreGitSource {
	readonly source: "git";
	readonly url: string;
	readonly ref?: string;
	readonly sparse?: readonly string[];
}

export type CodingPluginMarketplaceStoreSource =
	| CodingPluginMarketplaceStoreLocalSource
	| CodingPluginMarketplaceStoreGitSource;

export interface CodingPluginMarketplaceStoreRecord {
	readonly name: string;
	readonly source: CodingPluginMarketplaceStoreSource;
	readonly root: string;
	readonly revision?: string;
	/** Exact protocol-relevant checkout tree identity for immutable Git cache records. */
	readonly digest?: string;
}

export interface CodingPluginMarketplaceStoreSnapshot {
	readonly version: 1;
	readonly marketplaces: readonly CodingPluginMarketplaceStoreRecord[];
}

export interface CodingPluginMarketplaceStoreDiagnostic {
	readonly code: string;
	readonly severity: "error";
	readonly phase: "marketplace-store";
	readonly message: string;
	readonly path: string;
	readonly marketplace?: string;
}

export interface CodingPluginMarketplaceCatalogSnapshot {
	readonly version: 1;
	readonly marketplaces: readonly CodingPluginMarketplace[];
	readonly entries: readonly CodingPluginMarketplaceEntry[];
	readonly diagnostics: readonly (CodingPluginMarketplaceDiagnostic | CodingPluginMarketplaceStoreDiagnostic)[];
}

export type AddCodingPluginMarketplaceInput = CodingPluginMarketplaceStoreSource & {
	readonly signal?: AbortSignal;
};

export interface CodingPluginMarketplaceStore {
	list(): Promise<CodingPluginMarketplaceStoreSnapshot>;
	add(input: AddCodingPluginMarketplaceInput): Promise<CodingPluginMarketplaceStoreRecord>;
	upgrade(name: string, options?: { readonly signal?: AbortSignal }): Promise<CodingPluginMarketplaceStoreRecord>;
	remove(name: string, options?: { readonly signal?: AbortSignal }): Promise<void>;
	catalog(): Promise<CodingPluginMarketplaceCatalogSnapshot>;
}

export interface CreateCodingPluginMarketplaceStoreOptions {
	readonly root: string;
	readonly fileSystem: FileSystem;
	readonly processRunner: ProcessRunner;
	readonly idGenerator: IdGenerator;
	readonly environment: Readonly<Record<string, string>>;
}

class FileCodingPluginMarketplaceStore implements CodingPluginMarketplaceStore {
	readonly #configuredRoot: string;
	readonly #fileSystem: FileSystem;
	readonly #processRunner: ProcessRunner;
	readonly #idGenerator: IdGenerator;
	readonly #environment: Readonly<Record<string, string>>;
	#canonicalRoot: string | undefined;
	#serial: Promise<void> = Promise.resolve();

	constructor(options: CreateCodingPluginMarketplaceStoreOptions) {
		this.#configuredRoot = options.root;
		this.#fileSystem = options.fileSystem;
		this.#processRunner = options.processRunner;
		this.#idGenerator = options.idGenerator;
		this.#environment = Object.freeze({ ...options.environment });
	}

	list(): Promise<CodingPluginMarketplaceStoreSnapshot> {
		return this.#enqueue(async () => this.#readState(await this.#root()));
	}

	add(input: AddCodingPluginMarketplaceInput): Promise<CodingPluginMarketplaceStoreRecord> {
		return this.#enqueue(async () => {
			const root = await this.#root();
			return this.#withStoreMutex(root, input?.signal, () => this.#add(input));
		});
	}

	upgrade(name: string, options?: { readonly signal?: AbortSignal }): Promise<CodingPluginMarketplaceStoreRecord> {
		return this.#enqueue(async () => {
			const root = await this.#root();
			return this.#withStoreMutex(root, options?.signal, () => this.#upgrade(name, options?.signal));
		});
	}

	remove(name: string, options?: { readonly signal?: AbortSignal }): Promise<void> {
		return this.#enqueue(async () => {
			const root = await this.#root();
			await this.#withStoreMutex(root, options?.signal, async () => {
				options?.signal?.throwIfAborted();
				assertMarketplaceName(name);
				const state = await this.#readState(root);
				if (!state.marketplaces.some((entry) => entry.name === name)) {
					throw new Error(`Plugin Marketplace "${name}" is not configured`);
				}
				await this.#writeState(
					root,
					state.marketplaces.filter((entry) => entry.name !== name),
					options?.signal,
				);
			});
		});
	}

	catalog(): Promise<CodingPluginMarketplaceCatalogSnapshot> {
		return this.#enqueue(async () => {
			const root = await this.#root();
			return this.#withStoreMutex(root, undefined, async () => {
				const state = await this.#readState(root);
				const marketplaces: CodingPluginMarketplace[] = [];
				const entries: CodingPluginMarketplaceEntry[] = [];
				const diagnostics: (CodingPluginMarketplaceDiagnostic | CodingPluginMarketplaceStoreDiagnostic)[] = [];
				for (const record of state.marketplaces) {
					if (record.source.source === "git") {
						try {
							await this.#validateCachedMarketplace(record.root, record.name, record.digest);
						} catch (error) {
							marketplaces.push(
								Object.freeze({
									status: "rejected" as const,
									root: record.root,
									entries: Object.freeze([] as const),
									diagnostics: Object.freeze([]),
								}),
							);
							diagnostics.push(
								Object.freeze({
									code: "plugin-marketplace-store-integrity-invalid",
									severity: "error" as const,
									phase: "marketplace-store" as const,
									message: `Configured Git Plugin Marketplace "${record.name}" failed immutable cache verification: ${error instanceof Error ? error.message : String(error)}`,
									path: record.root,
									marketplace: record.name,
								}),
							);
							continue;
						}
					}
					const marketplace = await loadCodingPluginMarketplace({
						root: record.root,
						fileSystem: this.#fileSystem,
					});
					marketplaces.push(marketplace);
					diagnostics.push(...marketplace.diagnostics);
					if (marketplace.status !== "loaded") continue;
					if (marketplace.name !== record.name) {
						diagnostics.push(
							Object.freeze({
								code: "plugin-marketplace-store-name-changed",
								severity: "error" as const,
								phase: "marketplace-store" as const,
								message: `Configured Plugin Marketplace "${record.name}" now declares "${marketplace.name}"`,
								path: record.root,
								marketplace: record.name,
							}),
						);
						continue;
					}
					entries.push(...marketplace.entries);
				}
				return freezeCatalog(marketplaces, entries, diagnostics);
			});
		});
	}

	#enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#serial.then(operation, operation);
		this.#serial = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	#withStoreMutex<Result>(
		root: string,
		signal: AbortSignal | undefined,
		operation: () => Promise<Result>,
	): Promise<Result> {
		return withFileMutex({
			fileSystem: this.#fileSystem,
			path: join(root, "marketplaces.v1.lock"),
			operation,
			...(signal ? { signal } : {}),
		});
	}

	async #add(input: AddCodingPluginMarketplaceInput): Promise<CodingPluginMarketplaceStoreRecord> {
		if (!input || typeof input !== "object") throw new TypeError("Plugin Marketplace source is required");
		input.signal?.throwIfAborted();
		const root = await this.#root();
		const state = await this.#readState(root);
		const sourceKind: unknown = (input as unknown as { readonly source?: unknown }).source;
		if (sourceKind !== "local" && sourceKind !== "git") {
			throw new Error(`Unsupported Plugin Marketplace source: ${String(sourceKind)}`);
		}
		if (input.source === "git") {
			if (!hasOnlyKeys(input, ["source", "url", "ref", "sparse", "signal"])) {
				throw new TypeError("Git Plugin Marketplace source contains an unknown field");
			}
			const source = normalizeGitSource({
				source: "git",
				url: input.url,
				...(input.ref !== undefined ? { ref: input.ref } : {}),
				...(input.sparse !== undefined ? { sparse: input.sparse } : {}),
			});
			if (state.marketplaces.some((record) => sourceIdentity(record.source) === sourceIdentity(source))) {
				throw new Error("Plugin Marketplace source is already configured");
			}
			const record = await this.#stageGit(root, source, undefined, input.signal);
			if (state.marketplaces.some((entry) => entry.name === record.name)) {
				throw new Error(`Plugin Marketplace "${record.name}" is already configured`);
			}
			await this.#writeState(root, [...state.marketplaces, record], input.signal);
			return record;
		}
		if (!hasOnlyKeys(input, ["source", "root", "signal"]) || !isAbsolute(input.root)) {
			throw new TypeError("Local Plugin Marketplace root must be absolute");
		}
		if (pathHasComponent(input.root, ".codex-plugin")) {
			throw new Error('Local Plugin Marketplace roots below ".codex-plugin" are reserved');
		}
		if ((await this.#fileSystem.lstat(input.root)).kind !== "directory") {
			throw new Error("Local Plugin Marketplace root must be a directory");
		}
		const sourceRoot = await this.#fileSystem.realpath(input.root);
		if (pathHasComponent(sourceRoot, ".codex-plugin")) {
			throw new Error('Local Plugin Marketplace root resolves below reserved ".codex-plugin" content');
		}
		if ((await this.#fileSystem.stat(sourceRoot)).kind !== "directory") {
			throw new Error("Local Plugin Marketplace root must resolve to a directory");
		}
		if (state.marketplaces.some((record) => sourceIdentity(record.source) === `local:${sourceRoot}`)) {
			throw new Error("Plugin Marketplace source is already configured");
		}
		const marketplace = await loadCodingPluginMarketplace({ root: sourceRoot, fileSystem: this.#fileSystem });
		if (marketplace.status !== "loaded") {
			throw new Error(marketplace.diagnostics[0]?.message ?? "Plugin Marketplace is invalid");
		}
		if (state.marketplaces.some((record) => record.name === marketplace.name)) {
			throw new Error(`Plugin Marketplace "${marketplace.name}" is already configured`);
		}
		const record = freezeRecord({
			name: marketplace.name,
			source: Object.freeze({ source: "local" as const, root: sourceRoot }),
			root: sourceRoot,
		});
		await this.#writeState(root, [...state.marketplaces, record], input.signal);
		return record;
	}

	async #upgrade(name: string, signal?: AbortSignal): Promise<CodingPluginMarketplaceStoreRecord> {
		signal?.throwIfAborted();
		assertMarketplaceName(name);
		const root = await this.#root();
		const state = await this.#readState(root);
		const current = state.marketplaces.find((entry) => entry.name === name);
		if (!current) throw new Error(`Plugin Marketplace "${name}" is not configured`);
		if (current.source.source !== "git") {
			throw new Error(`Local Plugin Marketplace "${name}" does not have a staged upgrade`);
		}
		const upgraded = await this.#stageGit(root, current.source, name, signal);
		await this.#writeState(
			root,
			state.marketplaces.map((entry) => (entry.name === name ? upgraded : entry)),
			signal,
		);
		return upgraded;
	}

	async #stageGit(
		storeRoot: string,
		source: CodingPluginMarketplaceStoreGitSource,
		expectedName: string | undefined,
		signal?: AbortSignal,
	): Promise<CodingPluginMarketplaceStoreRecord> {
		const operationSignal = signal ?? new AbortController().signal;
		operationSignal.throwIfAborted();
		const stagingParent = await this.#ensureStoreDirectory(
			join(storeRoot, "staging"),
			storeRoot,
			"Plugin Marketplace staging directory",
		);
		const stagingRoot = join(stagingParent, safeIdentity(this.#idGenerator.generate("queue_item")));
		let moved = false;
		try {
			await this.#runGit(
				["clone", "--no-checkout", ...(source.sparse ? ["--filter=blob:none"] : []), "--", source.url, stagingRoot],
				stagingParent,
				operationSignal,
				"clone",
			);
			if ((await this.#fileSystem.lstat(stagingRoot)).kind !== "directory") {
				throw new Error("Git clone did not create a regular checkout directory");
			}
			const canonicalStagingRoot = await this.#fileSystem.realpath(stagingRoot);
			if (!isContained(stagingParent, canonicalStagingRoot) || relative(stagingRoot, canonicalStagingRoot) !== "") {
				throw new Error("Git clone checkout escaped its staging location");
			}
			if (source.sparse) {
				await this.#runGit(
					["-C", canonicalStagingRoot, "sparse-checkout", "init", "--no-cone"],
					storeRoot,
					operationSignal,
					"sparse-checkout init",
				);
				await this.#runGit(
					["-C", canonicalStagingRoot, "sparse-checkout", "set", "--no-cone", "--", ...source.sparse],
					storeRoot,
					operationSignal,
					"sparse-checkout set",
				);
			}
			await this.#runGit(
				["-C", canonicalStagingRoot, "checkout", "--detach", source.ref ?? "HEAD", "--"],
				storeRoot,
				operationSignal,
				"checkout",
			);
			const head = await this.#runGit(
				["-C", canonicalStagingRoot, "rev-parse", "--verify", "HEAD"],
				storeRoot,
				operationSignal,
				"revision discovery",
			);
			const revision = head.stdout.trim().toLowerCase();
			if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(revision)) {
				throw new Error("Git Plugin Marketplace HEAD is not a full object revision");
			}
			const staged = await loadCodingPluginMarketplace({
				root: canonicalStagingRoot,
				fileSystem: this.#fileSystem,
			});
			if (staged.status !== "loaded") {
				throw new Error(staged.diagnostics[0]?.message ?? "Staged Git Plugin Marketplace is invalid");
			}
			if (expectedName !== undefined && staged.name !== expectedName) {
				throw new Error(`Git Plugin Marketplace upgrade declared "${staged.name}" instead of "${expectedName}"`);
			}
			const digest = await this.#digestMarketplace(canonicalStagingRoot, operationSignal);
			const cacheRoot = await this.#ensureStoreDirectory(
				join(storeRoot, "cache"),
				storeRoot,
				"Plugin Marketplace cache directory",
			);
			const cacheParent = await this.#ensureStoreDirectory(
				join(cacheRoot, marketplaceCacheNamespace(staged.name)),
				storeRoot,
				"Plugin Marketplace cache namespace",
			);
			const sourceParent = await this.#ensureStoreDirectory(
				join(cacheParent, marketplaceSourceNamespace(source)),
				storeRoot,
				"Plugin Marketplace source namespace",
			);
			await this.#ensureStoreDirectory(
				join(sourceParent, revision),
				storeRoot,
				"Plugin Marketplace revision namespace",
			);
			const selectedRoot = marketplaceCacheRoot(storeRoot, staged.name, source, revision, digest);
			if (await this.#exists(selectedRoot)) {
				await this.#validateCachedMarketplace(selectedRoot, staged.name, digest);
			} else {
				await this.#fileSystem.rename(canonicalStagingRoot, selectedRoot);
				moved = true;
				await this.#validateCachedMarketplace(selectedRoot, staged.name, digest);
			}
			return freezeRecord({
				name: staged.name,
				source,
				root: selectedRoot,
				revision,
				digest,
			});
		} finally {
			if (!moved) await this.#removeTreeIfPresent(stagingRoot).catch(() => undefined);
		}
	}

	async #runGit(args: readonly string[], cwd: string, signal: AbortSignal, operation: string) {
		signal.throwIfAborted();
		const result = await this.#processRunner.run({
			executable: "git",
			args: Object.freeze([...args]),
			cwd,
			environment: this.#environment,
			signal,
			timeoutMs: 120_000,
			maxOutputBytes: 1024 * 1024,
			maxOutputLines: 10_000,
		});
		signal.throwIfAborted();
		if (result.exitCode !== 0 || result.signal !== null || result.timedOut || result.truncated) {
			const detail = result.stderr.trim() || result.stdout.trim() || `exit ${String(result.exitCode)}`;
			throw new Error(`Git Plugin Marketplace ${operation} failed: ${detail}`);
		}
		return result;
	}

	async #validateCachedMarketplace(root: string, expectedName: string, expectedDigest?: string): Promise<void> {
		if ((await this.#fileSystem.lstat(root)).kind !== "directory") {
			throw new Error("Cached Plugin Marketplace revision is not a directory");
		}
		const canonical = await this.#fileSystem.realpath(root);
		if (relative(root, canonical) !== "") throw new Error("Cached Plugin Marketplace revision resolves elsewhere");
		const digest = await this.#digestMarketplace(canonical);
		if (!expectedDigest || digest !== expectedDigest) {
			throw new Error("Cached Plugin Marketplace content digest does not match its selected revision");
		}
		const marketplace = await loadCodingPluginMarketplace({ root: canonical, fileSystem: this.#fileSystem });
		if (marketplace.status !== "loaded" || marketplace.name !== expectedName) {
			throw new Error("Cached Plugin Marketplace revision failed validation");
		}
	}

	async #digestMarketplace(root: string, signal?: AbortSignal): Promise<string> {
		const hash = createHash("sha256");
		await this.#hashMarketplaceDirectory(root, root, "", 0, { files: 0, bytes: 0 }, hash, new Set([root]), signal);
		return hash.digest("hex");
	}

	async #hashMarketplaceDirectory(
		canonicalRoot: string,
		root: string,
		relativeDirectory: string,
		depth: number,
		accounting: { files: number; bytes: number },
		hash: ReturnType<typeof createHash>,
		ancestorDirectories: ReadonlySet<string>,
		signal?: AbortSignal,
	): Promise<void> {
		signal?.throwIfAborted();
		const entries = [...(await this.#fileSystem.readDirectory(root))].sort((left, right) =>
			compareText(left.name, right.name),
		);
		for (const entry of entries) {
			signal?.throwIfAborted();
			if (entry.name.toLowerCase() === ".git" || entry.name.toLowerCase() === ".codex-plugin") continue;
			assertSafeEntryName(entry.name);
			const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
			if (depth + 1 > 32) throw new Error("Cached Plugin Marketplace exceeds the maximum tree depth");
			const path = join(root, entry.name);
			const resolved = await resolvePluginTreeEntry({
				fileSystem: this.#fileSystem,
				canonicalRoot,
				path,
				relativePath,
				ancestorDirectories,
				followSymbolicLinks: true,
				reservedCanonicalComponents: new Set([".codex-plugin", ".git"]),
			});
			const { status } = resolved;
			if (status.kind === "directory") {
				updateMarketplaceDigest(hash, "directory", relativePath, status);
				await this.#hashMarketplaceDirectory(
					canonicalRoot,
					resolved.path,
					relativePath,
					depth + 1,
					accounting,
					hash,
					new Set([...ancestorDirectories, resolved.path]),
					signal,
				);
				continue;
			}
			if (status.kind !== "file") {
				throw new Error(`Cached Plugin Marketplace contains an unsafe entry: ${relativePath}`);
			}
			accounting.files++;
			if (accounting.files > 10_000) throw new Error("Cached Plugin Marketplace exceeds the maximum file count");
			if (status.size > 100 * 1024 * 1024 - accounting.bytes) {
				throw new Error("Cached Plugin Marketplace exceeds the maximum byte count");
			}
			const bytes = await this.#fileSystem.readFile(resolved.path);
			accounting.bytes += bytes.byteLength;
			if (accounting.bytes > 100 * 1024 * 1024) {
				throw new Error("Cached Plugin Marketplace exceeds the maximum byte count");
			}
			updateMarketplaceDigest(hash, "file", relativePath, status, bytes);
		}
	}

	async #ensureStoreDirectory(path: string, storeRoot: string, label: string): Promise<string> {
		await this.#fileSystem.makeDirectory(path, { recursive: true, mode: 0o700 });
		const status = await this.#fileSystem.lstat(path);
		const canonical = await this.#fileSystem.realpath(path);
		if (!isContained(storeRoot, canonical) || relative(path, canonical) !== "") {
			throw new Error(`${label} resolves outside its store-owned location`);
		}
		if (status.kind !== "directory" || (await this.#fileSystem.stat(canonical)).kind !== "directory") {
			throw new Error(`${label} must be a directory`);
		}
		return canonical;
	}

	async #root(): Promise<string> {
		if (this.#canonicalRoot) return this.#canonicalRoot;
		await this.#fileSystem.makeDirectory(this.#configuredRoot, { recursive: true, mode: 0o700 });
		if ((await this.#fileSystem.lstat(this.#configuredRoot)).kind !== "directory") {
			throw new Error("Plugin Marketplace store root must be a directory");
		}
		const root = await this.#fileSystem.realpath(this.#configuredRoot);
		if ((await this.#fileSystem.stat(root)).kind !== "directory") {
			throw new Error("Plugin Marketplace store root must resolve to a directory");
		}
		this.#canonicalRoot = root;
		return root;
	}

	async #readState(root: string): Promise<CodingPluginMarketplaceStoreSnapshot> {
		const path = join(root, "marketplaces.v1.json");
		let bytes: Uint8Array;
		try {
			const status = await this.#fileSystem.lstat(path);
			if (status.kind !== "file") throw new Error("Plugin Marketplace state must be a regular file");
			bytes = await this.#fileSystem.readFile(path);
		} catch (error) {
			if (isFileSystemError(error, "ENOENT")) return freezeSnapshot([]);
			throw error;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
		} catch (error) {
			throw new Error(
				`Plugin Marketplace state is invalid: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return parseState(parsed, root);
	}

	async #writeState(
		root: string,
		marketplaces: readonly CodingPluginMarketplaceStoreRecord[],
		signal?: AbortSignal,
	): Promise<void> {
		const path = join(root, "marketplaces.v1.json");
		const token = safeIdentity(this.#idGenerator.generate("queue_item"));
		const temporary = `${path}.${token}.tmp`;
		let handle: WritableFile | undefined;
		let installed = false;
		try {
			handle = await this.#fileSystem.open(temporary, "wx", 0o600);
			await handle.write(`${JSON.stringify({ version: 1, marketplaces: sortedRecords(marketplaces) })}\n`);
			await handle.sync();
			await handle.close();
			handle = undefined;
			signal?.throwIfAborted();
			await this.#fileSystem.rename(temporary, path);
			installed = true;
		} finally {
			await handle?.close().catch(() => undefined);
			if (!installed) await this.#removeFileIfPresent(temporary);
		}
	}

	async #removeFileIfPresent(path: string): Promise<void> {
		try {
			await this.#fileSystem.removeFile(path);
		} catch (error) {
			if (!isFileSystemError(error, "ENOENT")) throw error;
		}
	}

	async #exists(path: string): Promise<boolean> {
		try {
			await this.#fileSystem.lstat(path);
			return true;
		} catch (error) {
			if (isFileSystemError(error, "ENOENT")) return false;
			throw error;
		}
	}

	async #removeTreeIfPresent(path: string): Promise<void> {
		let kind: "directory" | "file" | "other" | "symbolic-link";
		try {
			kind = (await this.#fileSystem.lstat(path)).kind;
		} catch (error) {
			if (isFileSystemError(error, "ENOENT")) return;
			throw error;
		}
		if (kind !== "directory") {
			await this.#fileSystem.removeFile(path);
			return;
		}
		for (const entry of await this.#fileSystem.readDirectory(path)) {
			assertSafeEntryName(entry.name);
			if (entry.name.toLowerCase() === ".codex-plugin") {
				throw new Error("Reserved Codex package content is not inspected during staging cleanup");
			}
			await this.#removeTreeIfPresent(join(path, entry.name));
		}
		await this.#fileSystem.removeDirectory(path);
	}
}

export function createCodingPluginMarketplaceStore(
	options: CreateCodingPluginMarketplaceStoreOptions,
): CodingPluginMarketplaceStore {
	if (!options || typeof options !== "object") throw new TypeError("Plugin Marketplace store options are required");
	if (!isAbsolute(options.root)) throw new TypeError("Plugin Marketplace store root must be absolute");
	if (!options.fileSystem) throw new TypeError("fileSystem is required");
	if (!options.processRunner) throw new TypeError("processRunner is required");
	if (!options.idGenerator) throw new TypeError("idGenerator is required");
	if (!options.environment || typeof options.environment !== "object") throw new TypeError("environment is required");
	return new FileCodingPluginMarketplaceStore(options);
}

function parseState(value: unknown, storeRoot: string): CodingPluginMarketplaceStoreSnapshot {
	if (!isRecord(value) || !hasOnlyKeys(value, ["version", "marketplaces"]) || value.version !== 1) {
		throw new Error("Plugin Marketplace state is invalid");
	}
	if (!Array.isArray(value.marketplaces)) throw new Error("Plugin Marketplace state is invalid");
	const records = value.marketplaces.map((entry) => parseRecord(entry, storeRoot));
	const names = new Set<string>();
	const sources = new Set<string>();
	for (const record of records) {
		if (names.has(record.name) || sources.has(sourceIdentity(record.source))) {
			throw new Error("Plugin Marketplace state contains a duplicate name or source");
		}
		names.add(record.name);
		sources.add(sourceIdentity(record.source));
	}
	return freezeSnapshot(records);
}

function parseRecord(value: unknown, storeRoot: string): CodingPluginMarketplaceStoreRecord {
	if (!isRecord(value) || !hasOnlyKeys(value, ["name", "source", "root", "revision", "digest"])) {
		throw new Error("Plugin Marketplace state contains an invalid record");
	}
	assertMarketplaceName(value.name);
	if (typeof value.root !== "string" || !isAbsolute(value.root)) {
		throw new Error("Plugin Marketplace state contains an invalid root");
	}
	const source = parseSource(value.source);
	if (source.source === "local") {
		if (value.revision !== undefined || value.digest !== undefined || source.root !== value.root) {
			throw new Error("Plugin Marketplace state contains an invalid local record");
		}
	} else {
		if (typeof value.revision !== "string" || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value.revision)) {
			throw new Error("Plugin Marketplace state contains an invalid Git revision");
		}
		if (typeof value.digest !== "string" || !/^[a-f0-9]{64}$/u.test(value.digest)) {
			throw new Error("Plugin Marketplace state contains an invalid Git content digest");
		}
		const expected = marketplaceCacheRoot(storeRoot, value.name, source, value.revision, value.digest);
		if (relative(expected, value.root) !== "") {
			throw new Error("Plugin Marketplace state contains a Git root outside its content-addressed cache identity");
		}
	}
	return freezeRecord({
		name: value.name,
		source,
		root: value.root,
		...(typeof value.revision === "string" ? { revision: value.revision } : {}),
		...(typeof value.digest === "string" ? { digest: value.digest } : {}),
	});
}

function parseSource(value: unknown): CodingPluginMarketplaceStoreSource {
	if (!isRecord(value) || typeof value.source !== "string") {
		throw new Error("Plugin Marketplace state contains an invalid source");
	}
	if (value.source === "local") {
		if (!hasOnlyKeys(value, ["source", "root"]) || typeof value.root !== "string" || !isAbsolute(value.root)) {
			throw new Error("Plugin Marketplace state contains an invalid local source");
		}
		if (pathHasComponent(value.root, ".codex-plugin")) {
			throw new Error("Plugin Marketplace state contains a reserved local source");
		}
		return Object.freeze({ source: "local" as const, root: value.root });
	}
	if (value.source === "git") return normalizeGitSource(value);
	throw new Error("Plugin Marketplace state contains an unsupported source");
}

function normalizeGitSource(value: Record<string, unknown>): CodingPluginMarketplaceStoreGitSource {
	if (!hasOnlyKeys(value, ["source", "url", "ref", "sparse"])) {
		throw new Error("Git Plugin Marketplace source contains an unknown field");
	}
	const url = normalizeGitUrl(value.url);
	if (!url) throw new Error("Git Plugin Marketplace URL is invalid");
	if (value.ref !== undefined && !validGitRef(value.ref)) throw new Error("Git Plugin Marketplace ref is invalid");
	const sparse = value.sparse === undefined ? undefined : normalizeSparse(value.sparse);
	return Object.freeze({
		source: "git" as const,
		url,
		...(typeof value.ref === "string" ? { ref: value.ref } : {}),
		...(sparse ? { sparse } : {}),
	});
}

function normalizeGitUrl(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value.startsWith("-")) {
		return undefined;
	}
	try {
		const url = new URL(value);
		if ((url.protocol !== "https:" && url.protocol !== "ssh:") || !url.hostname || url.password) return undefined;
		if (url.protocol === "https:" && url.username) return undefined;
		const username = decodeURIComponent(url.username);
		if (url.hostname.startsWith("-") || username.startsWith("-")) return undefined;
		if (username && !/^[A-Za-z0-9._~+-]+$/u.test(username)) return undefined;
		if (url.search || url.hash || url.pathname === "/") return undefined;
		for (const segment of url.pathname.split("/")) {
			const decoded = decodeURIComponent(segment);
			if (
				decoded === "." ||
				decoded === ".." ||
				decoded.includes("/") ||
				decoded.includes("\\") ||
				[...decoded].some((character) => character.charCodeAt(0) <= 0x20)
			) {
				return undefined;
			}
		}
		url.pathname = url.pathname.replace(/\/+$/u, "");
		return url.toString();
	} catch {
		return undefined;
	}
}

function validGitRef(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 255 &&
		value.trim() === value &&
		!value.startsWith("-") &&
		![...value].some((character) => character.charCodeAt(0) <= 0x20 || "~^:?*[\\".includes(character)) &&
		!value.includes("..") &&
		!value.includes("@{") &&
		!value.includes("//") &&
		!value.endsWith("/") &&
		!value.endsWith(".") &&
		!value.split("/").some((segment) => segment.startsWith(".") || segment.endsWith(".lock"))
	);
}

function normalizeSparse(value: unknown): readonly string[] {
	if (!Array.isArray(value) || value.length === 0) throw new Error("Git sparse paths must be a non-empty array");
	const paths: string[] = [];
	const seen = new Set<string>();
	for (const path of value) {
		if (
			typeof path !== "string" ||
			path.length === 0 ||
			path.trim() !== path ||
			path.startsWith("-") ||
			path.startsWith(":") ||
			path.includes("\\") ||
			[...path].some((character) => character.charCodeAt(0) <= 0x20) ||
			posix.isAbsolute(path) ||
			posix.normalize(path) !== path ||
			path.split("/").some((segment) => segment === "..")
		) {
			throw new Error("Git sparse path is invalid");
		}
		if (seen.has(path)) throw new Error("Git sparse paths contain a duplicate");
		seen.add(path);
		paths.push(path);
	}
	return Object.freeze(paths);
}

function freezeRecord(record: CodingPluginMarketplaceStoreRecord): CodingPluginMarketplaceStoreRecord {
	return Object.freeze({ ...record, source: cloneSource(record.source) });
}

function cloneSource(source: CodingPluginMarketplaceStoreSource): CodingPluginMarketplaceStoreSource {
	if (source.source === "local") return Object.freeze({ ...source });
	return Object.freeze({ ...source, ...(source.sparse ? { sparse: Object.freeze([...source.sparse]) } : {}) });
}

function freezeSnapshot(
	marketplaces: readonly CodingPluginMarketplaceStoreRecord[],
): CodingPluginMarketplaceStoreSnapshot {
	return Object.freeze({ version: 1 as const, marketplaces: Object.freeze(sortedRecords(marketplaces)) });
}

function freezeCatalog(
	marketplaces: readonly CodingPluginMarketplace[],
	entries: readonly CodingPluginMarketplaceEntry[],
	diagnostics: readonly (CodingPluginMarketplaceDiagnostic | CodingPluginMarketplaceStoreDiagnostic)[],
): CodingPluginMarketplaceCatalogSnapshot {
	return Object.freeze({
		version: 1 as const,
		marketplaces: Object.freeze([...marketplaces]),
		entries: Object.freeze([...entries]),
		diagnostics: Object.freeze([...diagnostics]),
	});
}

function sortedRecords(
	marketplaces: readonly CodingPluginMarketplaceStoreRecord[],
): CodingPluginMarketplaceStoreRecord[] {
	return marketplaces.map(freezeRecord).sort((left, right) => compareText(left.name, right.name));
}

function sourceIdentity(source: CodingPluginMarketplaceStoreSource): string {
	if (source.source === "local") return `local:${source.root}`;
	return `git:${source.url}\0${source.ref ?? ""}\0${source.sparse?.join("\0") ?? ""}`;
}

function marketplaceCacheNamespace(name: string): string {
	return createHash("sha256").update("coda-agent-plugin-marketplace-cache-namespace-v1\0").update(name).digest("hex");
}

function marketplaceSourceNamespace(source: CodingPluginMarketplaceStoreGitSource): string {
	return createHash("sha256")
		.update("coda-agent-plugin-marketplace-source-namespace-v1\0")
		.update(sourceIdentity(source))
		.digest("hex");
}

function marketplaceCacheRoot(
	storeRoot: string,
	name: string,
	source: CodingPluginMarketplaceStoreGitSource,
	revision: string,
	digest: string,
): string {
	return join(
		storeRoot,
		"cache",
		marketplaceCacheNamespace(name),
		marketplaceSourceNamespace(source),
		revision,
		digest,
	);
}

function safeIdentity(value: string): string {
	const safe = value.replace(/[^a-zA-Z0-9._-]/gu, "-");
	if (!safe || safe === "." || safe === ".." || safe.length > 128) {
		throw new Error("IdGenerator returned an invalid Plugin Marketplace identity");
	}
	return safe;
}

function assertMarketplaceName(value: unknown): asserts value is string {
	if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) {
		throw new TypeError("Plugin Marketplace name is invalid");
	}
	if (isCodingPluginLocalSource(value)) {
		throw new TypeError(`Plugin Marketplace name "${value}" is reserved for direct Agent Plugin installations`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
	const accepted = new Set(allowed);
	return Object.keys(value).every((key) => accepted.has(key));
}

function assertSafeEntryName(name: string): void {
	if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
		throw new Error(`Plugin Marketplace staging contains an unsafe path entry: ${JSON.stringify(name)}`);
	}
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function isContained(root: string, target: string): boolean {
	const fromRoot = relative(root, target);
	return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

function updateMarketplaceDigest(
	hash: ReturnType<typeof createHash>,
	kind: "directory" | "file",
	path: string,
	status: FileStatus,
	bytes: Uint8Array = new Uint8Array(),
): void {
	const encodedPath = new TextEncoder().encode(path);
	hash.update(Uint8Array.of(kind === "directory" ? 0 : 1));
	hash.update(marketplaceModeBytes(status.mode));
	hash.update(marketplaceLengthBytes(encodedPath.byteLength));
	hash.update(encodedPath);
	hash.update(marketplaceLengthBytes(bytes.byteLength));
	hash.update(bytes);
}

function marketplaceModeBytes(mode: number): Uint8Array {
	const bytes = new Uint8Array(2);
	new DataView(bytes.buffer).setUint16(0, mode & 0o777, false);
	return bytes;
}

function marketplaceLengthBytes(value: number): Uint8Array {
	const bytes = new Uint8Array(8);
	new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
	return bytes;
}
