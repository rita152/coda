import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { IdGenerator } from "@coda/agent";
import { createPlugins } from "@coda/plugins";
import { processIsAlive, withFileMutex } from "../host/file-mutex.ts";
import type { FileStatus, FileSystem, WritableFile } from "../host/file-system.ts";
import { isFileSystemError } from "../host/file-system.ts";
import type { CodingPluginMarketplaceEntry, CodingPluginMarketplaceSource } from "./marketplace.ts";
import { pathHasComponent, resolvePluginTreeEntry } from "./package-tree.ts";
import type { CodingPluginId } from "./types.ts";
import { isCodingPluginLocalSource } from "./types.ts";

export interface CodingPluginInstallationLimits {
	readonly maxFiles: number;
	readonly maxBytes: number;
	readonly maxDepth: number;
}

export const DEFAULT_CODING_PLUGIN_INSTALLATION_LIMITS: Readonly<CodingPluginInstallationLimits> = Object.freeze({
	maxFiles: 10_000,
	maxBytes: 100 * 1024 * 1024,
	maxDepth: 32,
});

export interface CodingPluginInstallationRecord {
	readonly pluginId: CodingPluginId;
	readonly name: string;
	readonly marketplace: string;
	readonly version?: string;
	readonly digest: string;
	readonly revision: string;
	readonly source: CodingPluginMarketplaceSource;
	readonly selectedRoot: string;
}

export interface CodingPluginInstallationsSnapshot {
	readonly version: 1;
	readonly installations: readonly CodingPluginInstallationRecord[];
}

export interface CodingPluginInstallationRevisionLease {
	/** Idempotently releases every retained content-addressed revision. */
	dispose(): Promise<void>;
}

export type CodingPluginInstallationVerificationCode =
	| "plugin-installation-record-not-selected"
	| "plugin-installation-root-invalid"
	| "plugin-installation-digest-mismatch"
	| "plugin-installation-verification-failed";

export type CodingPluginInstallationVerification =
	| {
			readonly status: "verified";
			readonly record: CodingPluginInstallationRecord;
	  }
	| {
			readonly status: "rejected";
			readonly code: CodingPluginInstallationVerificationCode;
			readonly message: string;
			readonly record: CodingPluginInstallationRecord;
	  };

export interface CodingPluginVerifiedInstallationsSnapshot extends CodingPluginInstallationsSnapshot {
	/** Ordered one-for-one with installations and computed in the same serialized store operation. */
	readonly verifications: readonly CodingPluginInstallationVerification[];
}

export interface CodingPluginInstallationStore {
	install(input: {
		readonly entry: CodingPluginMarketplaceEntry;
		readonly packageRoot: string;
		readonly signal?: AbortSignal;
	}): Promise<CodingPluginInstallationRecord>;
	list(): Promise<CodingPluginInstallationsSnapshot>;
	/** Reads the selected set and verifies every immutable revision without releasing the store queue between them. */
	listVerified(options?: { readonly signal?: AbortSignal }): Promise<CodingPluginVerifiedInstallationsSnapshot>;
	/** Computes the exact content identity used by installation without mutating store state. */
	digestPackage(packageRoot: string, options?: { readonly signal?: AbortSignal }): Promise<string>;
	/** Revalidates one selected cache revision before any portable package read or admission. */
	verify(
		record: CodingPluginInstallationRecord,
		options?: { readonly signal?: AbortSignal },
	): Promise<CodingPluginInstallationVerification>;
	remove(pluginId: CodingPluginId, options?: { readonly signal?: AbortSignal }): Promise<void>;
	/** Retains exact selected roots for lazy Skill activation by one active Run. */
	retainRevisions(
		selectedRoots: readonly string[],
		options?: { readonly signal?: AbortSignal },
	): Promise<CodingPluginInstallationRevisionLease>;
	/** Marks unselected revisions collectable after a newer Project inventory is published. */
	collectRetiredRevisions(options?: { readonly signal?: AbortSignal }): Promise<void>;
}

export interface CreateCodingPluginInstallationStoreOptions {
	readonly root: string;
	readonly fileSystem: FileSystem;
	readonly idGenerator: IdGenerator;
	readonly limits?: Partial<CodingPluginInstallationLimits>;
}

interface CopyAccounting {
	files: number;
	bytes: number;
}

interface RevisionLeaseEntry {
	readonly slot: string;
	readonly digest: string;
}

interface RevisionLeaseRecord {
	readonly version: 1;
	readonly token: string;
	readonly pid: number;
	readonly revisions: readonly RevisionLeaseEntry[];
}

interface RetiredRevisionsState {
	readonly version: 1;
	readonly revisions: readonly RevisionLeaseEntry[];
}

class FileCodingPluginInstallationStore implements CodingPluginInstallationStore {
	readonly #configuredRoot: string;
	readonly #fileSystem: FileSystem;
	readonly #idGenerator: IdGenerator;
	readonly #limits: Readonly<CodingPluginInstallationLimits>;
	#canonicalRoot: string | undefined;
	#serial: Promise<void> = Promise.resolve();

	constructor(options: CreateCodingPluginInstallationStoreOptions) {
		this.#configuredRoot = options.root;
		this.#fileSystem = options.fileSystem;
		this.#idGenerator = options.idGenerator;
		this.#limits = resolveLimits(options.limits);
	}

	install(input: {
		readonly entry: CodingPluginMarketplaceEntry;
		readonly packageRoot: string;
		readonly signal?: AbortSignal;
	}): Promise<CodingPluginInstallationRecord> {
		return this.#enqueue(async () => {
			const root = await this.#root();
			return this.#withStoreMutex(root, input.signal, () => this.#install(input));
		});
	}

	list(): Promise<CodingPluginInstallationsSnapshot> {
		return this.#enqueue(async () => this.#readState(await this.#root()));
	}

	listVerified(options: { readonly signal?: AbortSignal } = {}): Promise<CodingPluginVerifiedInstallationsSnapshot> {
		return this.#enqueue(async () => {
			const root = await this.#root();
			return this.#withStoreMutex(root, options.signal, () => this.#listVerified(options.signal));
		});
	}

	digestPackage(packageRoot: string, options: { readonly signal?: AbortSignal } = {}): Promise<string> {
		return this.#enqueue(() => this.#digestPackage(packageRoot, options.signal));
	}

	verify(
		record: CodingPluginInstallationRecord,
		options: { readonly signal?: AbortSignal } = {},
	): Promise<CodingPluginInstallationVerification> {
		return this.#enqueue(async () => {
			const root = await this.#root();
			return this.#withStoreMutex(root, options.signal, () => this.#verify(record, options.signal));
		});
	}

	remove(pluginId: CodingPluginId, options: { readonly signal?: AbortSignal } = {}): Promise<void> {
		return this.#enqueue(async () => {
			const root = await this.#root();
			await this.#withStoreMutex(root, options.signal, () => this.#remove(pluginId, options.signal));
		});
	}

	retainRevisions(
		selectedRoots: readonly string[],
		options: { readonly signal?: AbortSignal } = {},
	): Promise<CodingPluginInstallationRevisionLease> {
		return this.#enqueue(() => this.#retainRevisions(selectedRoots, options.signal));
	}

	collectRetiredRevisions(options: { readonly signal?: AbortSignal } = {}): Promise<void> {
		return this.#enqueue(() => this.#collectRetiredRevisions(options.signal));
	}

	#enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#serial.then(operation, operation);
		this.#serial = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	async #install(input: {
		readonly entry: CodingPluginMarketplaceEntry;
		readonly packageRoot: string;
		readonly signal?: AbortSignal;
	}): Promise<CodingPluginInstallationRecord> {
		const { entry, signal } = input;
		signal?.throwIfAborted();
		validateMarketplaceEntry(entry);
		if (!isAbsolute(input.packageRoot)) throw new TypeError("Resolved Plugin package root must be absolute");
		assertNonLegacyPackagePath(input.packageRoot);
		const packageRoot = await this.#fileSystem.realpath(input.packageRoot);
		assertNonLegacyPackagePath(packageRoot);
		const sourceStatus = await this.#fileSystem.lstat(input.packageRoot);
		if (sourceStatus.kind !== "directory") throw new Error("Resolved Plugin package root must be a directory");
		const root = await this.#root();
		const state = await this.#readState(root);
		const token = safeIdentity(this.#idGenerator.generate("queue_item"));
		const stagingParent = join(root, "staging");
		const stagingRoot = join(stagingParent, token);
		const cacheSlot = pluginCacheSlot(entry.pluginId);
		const cacheRoot = join(root, "cache");
		const cacheParent = join(cacheRoot, cacheSlot);
		await this.#storeOwnedDirectory(root, stagingParent, { create: true, label: "staging directory" });
		await this.#storeOwnedDirectory(root, cacheRoot, { create: true, label: "cache directory" });
		await this.#storeOwnedDirectory(root, cacheParent, { create: true, label: "cache slot" });
		await this.#storeOwnedDirectory(root, stagingRoot, { create: true, label: "staging revision" });
		let stagingPresent = true;
		try {
			const hash = createHash("sha256");
			const accounting: CopyAccounting = { files: 0, bytes: 0 };
			await this.#copyDirectory(
				packageRoot,
				packageRoot,
				stagingRoot,
				"",
				0,
				accounting,
				hash,
				new Set([packageRoot]),
				signal,
			);
			const digest = hash.digest("hex");
			const staged = await this.#validatePackage(stagingRoot, entry.name, signal);
			const selectedRoot = join(cacheParent, digest);
			if (await this.#exists(selectedRoot)) {
				await this.#assertStoreOwnedRevision(root, selectedRoot);
				await this.#assertCachedPackage(root, selectedRoot, entry.name, digest, signal);
			} else {
				await this.#storeOwnedDirectory(root, stagingRoot, { label: "staging revision" });
				await this.#storeOwnedDirectory(root, cacheParent, { label: "cache slot" });
				await this.#fileSystem.rename(stagingRoot, selectedRoot);
				stagingPresent = false;
				await this.#assertStoreOwnedRevision(root, selectedRoot);
				await this.#assertCachedPackage(root, selectedRoot, entry.name, digest, signal);
			}
			signal?.throwIfAborted();
			const record = freezeRecord({
				pluginId: entry.pluginId,
				name: entry.name,
				marketplace: entry.marketplace,
				...(staged.manifest.version ? { version: staged.manifest.version } : {}),
				digest,
				revision: revisionFor(entry.pluginId, digest),
				source: cloneSource(entry.source),
				selectedRoot,
			});
			const installations = [
				...state.installations.filter(({ pluginId }) => pluginId !== entry.pluginId),
				record,
			].sort((left, right) => compareText(left.pluginId, right.pluginId));
			await this.#assertStoreOwnedRevision(root, selectedRoot);
			await this.#writeState(root, installations, signal);
			return record;
		} finally {
			if (stagingPresent) await this.#removeTreeIfPresent(stagingRoot).catch(() => undefined);
		}
	}

	async #remove(pluginId: CodingPluginId, signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		const root = await this.#root();
		const state = await this.#readState(root);
		const selected = state.installations.find((record) => record.pluginId === pluginId);
		if (!selected) throw new Error(`Plugin is not installed: ${pluginId}`);
		const installations = state.installations.filter((record) => record.pluginId !== pluginId);
		await this.#writeState(root, installations, signal);
	}

	async #digestPackage(packageRoot: string, signal?: AbortSignal): Promise<string> {
		signal?.throwIfAborted();
		if (!isAbsolute(packageRoot)) throw new TypeError("Resolved Plugin package root must be absolute");
		assertNonLegacyPackagePath(packageRoot);
		const canonicalRoot = await this.#fileSystem.realpath(packageRoot);
		assertNonLegacyPackagePath(canonicalRoot);
		const status = await this.#fileSystem.lstat(packageRoot);
		if (status.kind !== "directory") throw new Error("Resolved Plugin package root must be a directory");
		return this.#digestDirectory(canonicalRoot, signal, false, true);
	}

	async #verify(
		record: CodingPluginInstallationRecord,
		signal?: AbortSignal,
	): Promise<CodingPluginInstallationVerification> {
		signal?.throwIfAborted();
		const root = await this.#root();
		let state: CodingPluginInstallationsSnapshot;
		try {
			state = await this.#readState(root);
		} catch (error) {
			return rejectedVerification(
				record,
				"plugin-installation-verification-failed",
				`Could not verify managed Plugin installation "${record.pluginId}": ${errorMessage(error)}`,
			);
		}
		return this.#verifySelected(root, state, record, signal);
	}

	async #listVerified(signal?: AbortSignal): Promise<CodingPluginVerifiedInstallationsSnapshot> {
		signal?.throwIfAborted();
		const root = await this.#root();
		const state = await this.#readState(root);
		const verifications: CodingPluginInstallationVerification[] = [];
		for (const record of state.installations) {
			verifications.push(await this.#verifySelected(root, state, record, signal));
		}
		return Object.freeze({
			version: 1 as const,
			installations: state.installations,
			verifications: Object.freeze(verifications),
		});
	}

	async #verifySelected(
		root: string,
		state: CodingPluginInstallationsSnapshot,
		record: CodingPluginInstallationRecord,
		signal?: AbortSignal,
	): Promise<CodingPluginInstallationVerification> {
		signal?.throwIfAborted();
		try {
			this.#assertRevisionRoot(root, record.selectedRoot);
		} catch {
			return rejectedVerification(
				record,
				"plugin-installation-root-invalid",
				`Managed Plugin installation "${record.pluginId}" selected a root outside its content-addressed cache slot`,
			);
		}
		const selected = state.installations.find(({ pluginId }) => pluginId === record.pluginId);
		if (
			!selected ||
			selected.selectedRoot !== record.selectedRoot ||
			selected.digest !== record.digest ||
			selected.revision !== record.revision
		) {
			return rejectedVerification(
				record,
				"plugin-installation-record-not-selected",
				`Managed Plugin installation "${record.pluginId}" is not the revision selected by the installation store`,
			);
		}
		try {
			await this.#assertStoreOwnedRevision(root, record.selectedRoot);
		} catch (error) {
			return rejectedVerification(
				record,
				"plugin-installation-root-invalid",
				`Managed Plugin installation "${record.pluginId}" selected root is unavailable: ${errorMessage(error)}`,
			);
		}
		let digest: string;
		try {
			digest = await this.#digestDirectory(record.selectedRoot, signal, true);
		} catch (error) {
			signal?.throwIfAborted();
			return rejectedVerification(
				record,
				"plugin-installation-verification-failed",
				`Could not verify managed Plugin installation "${record.pluginId}" content: ${errorMessage(error)}`,
			);
		}
		if (digest !== record.digest) {
			return rejectedVerification(
				record,
				"plugin-installation-digest-mismatch",
				`Managed Plugin installation "${record.pluginId}" content does not match its selected digest`,
			);
		}
		return Object.freeze({ status: "verified" as const, record });
	}

	async #retainRevisions(
		selectedRoots: readonly string[],
		signal?: AbortSignal,
	): Promise<CodingPluginInstallationRevisionLease> {
		signal?.throwIfAborted();
		if (!Array.isArray(selectedRoots) || selectedRoots.some((path) => typeof path !== "string")) {
			throw new TypeError("Plugin revision roots must be strings");
		}
		const revisions = [...new Set(selectedRoots)].sort(compareText);
		if (revisions.length === 0) {
			return Object.freeze({ dispose: async () => undefined });
		}
		const root = await this.#root();
		const lease = await this.#withStoreMutex(root, signal, async () => {
			for (const revision of revisions) {
				signal?.throwIfAborted();
				await this.#assertStoreOwnedRevision(root, revision).catch((error: unknown) => {
					throw new Error(`Plugin installation revision is unavailable: ${revision}`, { cause: error });
				});
			}
			return this.#writeRevisionLease(root, revisions, signal);
		});
		let disposeOperation: Promise<void> | undefined;
		return Object.freeze({
			dispose: () => {
				disposeOperation ??= this.#enqueue(async () => {
					const currentRoot = await this.#root();
					await this.#withStoreMutex(currentRoot, undefined, () => this.#releaseRevisionLease(currentRoot, lease));
				});
				return disposeOperation;
			},
		});
	}

	async #releaseRevisionLease(
		root: string,
		lease: { readonly path: string; readonly record: RevisionLeaseRecord },
	): Promise<void> {
		const current = await this.#readRevisionLease(root, lease.path);
		if (current.token !== lease.record.token || current.pid !== lease.record.pid) {
			throw new Error("Plugin revision lease ownership changed before release");
		}
		await this.#fileSystem.removeFile(lease.path);
		await this.#collectRetiredRevisionsLocked(root, undefined, false);
	}

	async #collectRetiredRevisions(signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		if (!this.#canonicalRoot) {
			try {
				await this.#fileSystem.lstat(this.#configuredRoot);
			} catch (error) {
				if (isFileSystemError(error, "ENOENT")) return;
				throw error;
			}
		}
		const root = await this.#root();
		await this.#withStoreMutex(root, signal, () => this.#collectRetiredRevisionsLocked(root, signal, true));
	}

	async #collectRetiredRevisionsLocked(
		root: string,
		signal: AbortSignal | undefined,
		markNew: boolean,
	): Promise<void> {
		const selectedRoots = new Set(
			(await this.#readState(root)).installations.map(({ selectedRoot }) => selectedRoot),
		);
		const retainedRoots = await this.#readRetainedRevisionRoots(root, signal);
		const retiredRoots = await this.#readRetiredRevisionRoots(root);
		const cacheRoot = join(root, "cache");
		try {
			await this.#fileSystem.lstat(cacheRoot);
		} catch (error) {
			if (isFileSystemError(error, "ENOENT")) {
				await this.#writeRetiredRevisionRoots(root, [], signal);
				return;
			}
			throw error;
		}
		await this.#storeOwnedDirectory(root, cacheRoot, { label: "cache directory" });
		const slots = await this.#fileSystem.readDirectory(cacheRoot);
		const cacheRevisions = new Set<string>();
		const slotRoots = new Set<string>();
		for (const slot of [...slots].sort((left, right) => compareText(left.name, right.name))) {
			signal?.throwIfAborted();
			assertSafeEntryName(slot.name);
			if (!/^[a-f0-9]{64}$/u.test(slot.name)) continue;
			if (slot.kind !== "directory") {
				throw new Error("Plugin installation cache slot must be a store-owned regular directory");
			}
			const slotRoot = join(cacheRoot, slot.name);
			slotRoots.add(slotRoot);
			await this.#storeOwnedDirectory(root, slotRoot, { label: "cache slot" });
			const revisions = await this.#fileSystem.readDirectory(slotRoot);
			for (const entry of [...revisions].sort((left, right) => compareText(left.name, right.name))) {
				signal?.throwIfAborted();
				assertSafeEntryName(entry.name);
				if (!/^[a-f0-9]{64}$/u.test(entry.name)) continue;
				if (entry.kind !== "directory") {
					throw new Error("Plugin installation cache revision must be a store-owned regular directory");
				}
				const revision = join(slotRoot, entry.name);
				await this.#storeOwnedDirectory(root, revision, { label: "cache revision" });
				cacheRevisions.add(revision);
			}
		}
		for (const revision of [...retiredRoots]) {
			if (!cacheRevisions.has(revision) || selectedRoots.has(revision)) retiredRoots.delete(revision);
		}
		if (markNew) {
			for (const revision of cacheRevisions) {
				if (!selectedRoots.has(revision)) retiredRoots.add(revision);
			}
		}
		await this.#writeRetiredRevisionRoots(root, [...retiredRoots], signal);
		for (const revision of [...retiredRoots].sort(compareText)) {
			signal?.throwIfAborted();
			if (retainedRoots.has(revision)) continue;
			await this.#removeTreeIfPresent(revision);
			retiredRoots.delete(revision);
		}
		for (const slotRoot of [...slotRoots].sort(compareText)) {
			if ((await this.#fileSystem.readDirectory(slotRoot)).length === 0) {
				await this.#fileSystem.removeDirectory(slotRoot);
			}
		}
		await this.#writeRetiredRevisionRoots(root, [...retiredRoots], signal);
	}

	#withStoreMutex<Result>(
		root: string,
		signal: AbortSignal | undefined,
		operation: () => Promise<Result>,
	): Promise<Result> {
		return withFileMutex({
			fileSystem: this.#fileSystem,
			path: join(root, "installations.v1.lock"),
			operation,
			...(signal ? { signal } : {}),
		});
	}

	async #writeRevisionLease(
		root: string,
		revisions: readonly string[],
		signal?: AbortSignal,
	): Promise<{ readonly path: string; readonly record: RevisionLeaseRecord }> {
		signal?.throwIfAborted();
		const directory = await this.#revisionLeaseDirectory(root, true);
		const token = randomUUID().replaceAll("-", "").toLowerCase();
		const record: RevisionLeaseRecord = Object.freeze({
			version: 1 as const,
			token,
			pid: process.pid,
			revisions: Object.freeze(
				revisions.map((revision) => {
					const [slot, digest] = relative(join(root, "cache"), revision).split(sep);
					if (!slot || !digest) throw new Error("Plugin revision root leaves the installation cache");
					return Object.freeze({ slot, digest });
				}),
			),
		});
		const path = join(directory, `${String(record.pid)}-${record.token}.json`);
		let handle: WritableFile | undefined;
		let installed = false;
		try {
			handle = await this.#fileSystem.open(path, "wx", 0o600);
			await handle.write(`${JSON.stringify(record)}\n`);
			await handle.sync();
			await handle.close();
			handle = undefined;
			installed = true;
			return Object.freeze({ path, record });
		} finally {
			await handle?.close().catch(() => undefined);
			if (!installed) await this.#removeFileIfPresent(path);
		}
	}

	async #readRetiredRevisionRoots(root: string): Promise<Set<string>> {
		const path = join(root, "retired-revisions.v1.json");
		let bytes: Uint8Array;
		try {
			const status = await this.#fileSystem.lstat(path);
			if (status.kind !== "file" || (await this.#fileSystem.realpath(path)) !== path) {
				throw new Error("retired revision state must be a store-owned regular file");
			}
			bytes = await this.#fileSystem.readFile(path);
		} catch (error) {
			if (isFileSystemError(error, "ENOENT")) return new Set();
			throw new Error("Could not read corrupt retired Plugin revision state", { cause: error });
		}
		try {
			const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
			const state = parseRetiredRevisionsState(value);
			return new Set(
				state.revisions.map((revision) => {
					const path = join(root, "cache", revision.slot, revision.digest);
					this.#assertRevisionRoot(root, path);
					return path;
				}),
			);
		} catch (error) {
			throw new Error("Could not read corrupt retired Plugin revision state", { cause: error });
		}
	}

	async #writeRetiredRevisionRoots(root: string, revisions: readonly string[], signal?: AbortSignal): Promise<void> {
		const records = [...new Set(revisions)].sort(compareText).map((revision) => {
			this.#assertRevisionRoot(root, revision);
			const [slot, digest] = relative(join(root, "cache"), revision).split(sep);
			if (!slot || !digest) throw new Error("Plugin revision root leaves the installation cache");
			return Object.freeze({ slot, digest });
		});
		const path = join(root, "retired-revisions.v1.json");
		const token = safeIdentity(this.#idGenerator.generate("queue_item"));
		const temporary = `${path}.${token}.tmp`;
		let handle: WritableFile | undefined;
		let installed = false;
		try {
			handle = await this.#fileSystem.open(temporary, "wx", 0o600);
			await handle.write(`${JSON.stringify({ version: 1, revisions: records })}\n`);
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

	async #readRetainedRevisionRoots(root: string, signal?: AbortSignal): Promise<ReadonlySet<string>> {
		let directory: string;
		try {
			directory = await this.#revisionLeaseDirectory(root, false);
		} catch (error) {
			if (isFileSystemError(error, "ENOENT")) return new Set();
			throw error;
		}
		const retained = new Set<string>();
		const entries = [...(await this.#fileSystem.readDirectory(directory))].sort((left, right) =>
			compareText(left.name, right.name),
		);
		for (const entry of entries) {
			signal?.throwIfAborted();
			assertSafeEntryName(entry.name);
			if (entry.kind !== "file") throw new Error("Plugin revision lease directory contains an unsafe entry");
			const path = join(directory, entry.name);
			const identity = revisionLeaseFilename(entry.name);
			if (!processIsAlive(identity.pid)) {
				await this.#assertRegularRevisionLease(path);
				await this.#fileSystem.removeFile(path);
				continue;
			}
			const record = await this.#readRevisionLease(root, path);
			for (const revision of record.revisions) {
				retained.add(join(root, "cache", revision.slot, revision.digest));
			}
		}
		return retained;
	}

	async #readRevisionLease(root: string, path: string): Promise<RevisionLeaseRecord> {
		const directory = await this.#revisionLeaseDirectory(root, false);
		const fromDirectory = relative(directory, path);
		if (
			!fromDirectory ||
			fromDirectory === "." ||
			fromDirectory === ".." ||
			fromDirectory.startsWith(`..${sep}`) ||
			fromDirectory.includes(sep)
		) {
			throw new Error("Plugin revision lease path leaves its store-owned directory");
		}
		const identity = revisionLeaseFilename(fromDirectory);
		await this.#assertRegularRevisionLease(path);
		let value: unknown;
		try {
			value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await this.#fileSystem.readFile(path)));
		} catch (error) {
			throw new Error("Plugin revision lease is corrupt", { cause: error });
		}
		const record = parseRevisionLease(value);
		if (record.pid !== identity.pid || record.token !== identity.token) {
			throw new Error("Plugin revision lease identity does not match its filename");
		}
		for (const revision of record.revisions) {
			this.#assertRevisionRoot(root, join(root, "cache", revision.slot, revision.digest));
		}
		return record;
	}

	async #assertRegularRevisionLease(path: string): Promise<void> {
		const status = await this.#fileSystem.lstat(path);
		if (status.kind !== "file") throw new Error("Plugin revision lease must be a regular file");
		if ((await this.#fileSystem.realpath(path)) !== path) {
			throw new Error("Plugin revision lease resolves outside its store-owned location");
		}
	}

	async #revisionLeaseDirectory(root: string, create: boolean): Promise<string> {
		const directory = join(root, "revision-leases.v1");
		return this.#storeOwnedDirectory(root, directory, {
			create,
			label: "revision lease directory",
		});
	}

	#assertRevisionRoot(root: string, revision: string): void {
		if (!isAbsolute(revision)) throw new TypeError("Plugin revision root must be absolute");
		const cacheRoot = join(root, "cache");
		const fromCache = relative(cacheRoot, revision);
		const parts = fromCache.split(sep);
		if (
			fromCache === "" ||
			fromCache === ".." ||
			fromCache.startsWith(`..${sep}`) ||
			parts.length !== 2 ||
			parts.some((part) => !part || part === "." || part === "..") ||
			!/^[a-f0-9]{64}$/u.test(parts[0]!) ||
			!/^[a-f0-9]{64}$/u.test(parts[1]!) ||
			join(cacheRoot, parts[0]!, parts[1]!) !== revision
		) {
			throw new Error("Plugin revision root leaves the installation cache");
		}
	}

	async #assertStoreOwnedRevision(root: string, revision: string): Promise<void> {
		this.#assertRevisionRoot(root, revision);
		await this.#storeOwnedDirectory(root, join(root, "cache"), { label: "cache directory" });
		await this.#storeOwnedDirectory(root, dirname(revision), { label: "cache slot" });
		await this.#storeOwnedDirectory(root, revision, { label: "cache revision" });
	}

	async #storeOwnedDirectory(
		root: string,
		path: string,
		options: { readonly create?: boolean; readonly label: string },
	): Promise<string> {
		if (!isAbsolute(path)) throw new TypeError(`Plugin installation ${options.label} must be absolute`);
		const fromRoot = relative(root, path);
		const parts = fromRoot ? fromRoot.split(sep) : [];
		if (
			fromRoot === ".." ||
			fromRoot.startsWith(`..${sep}`) ||
			parts.some((part) => !part || part === "." || part === "..") ||
			join(root, ...parts) !== path
		) {
			throw new Error(`Plugin installation ${options.label} leaves its store root`);
		}
		let current = root;
		for (const part of parts) {
			current = join(current, part);
			let status: FileStatus;
			try {
				status = await this.#fileSystem.lstat(current);
			} catch (error) {
				if (!options.create || !isFileSystemError(error, "ENOENT")) throw error;
				await this.#fileSystem.makeDirectory(current, { mode: 0o700 });
				status = await this.#fileSystem.lstat(current);
			}
			if (status.kind !== "directory" || (await this.#fileSystem.realpath(current)) !== current) {
				throw new Error(`Plugin installation ${options.label} must be a store-owned regular directory`);
			}
		}
		if (parts.length === 0) {
			const status = await this.#fileSystem.lstat(root);
			if (status.kind !== "directory" || (await this.#fileSystem.realpath(root)) !== root) {
				throw new Error("Plugin installation store root must be a store-owned regular directory");
			}
		}
		return path;
	}

	async #root(): Promise<string> {
		if (this.#canonicalRoot) {
			await this.#storeOwnedDirectory(this.#canonicalRoot, this.#canonicalRoot, { label: "store root" });
			return this.#canonicalRoot;
		}
		await this.#fileSystem.makeDirectory(this.#configuredRoot, { recursive: true, mode: 0o700 });
		if ((await this.#fileSystem.lstat(this.#configuredRoot)).kind !== "directory") {
			throw new Error("Plugin installation store root must be a directory");
		}
		const root = await this.#fileSystem.realpath(this.#configuredRoot);
		this.#canonicalRoot = root;
		return root;
	}

	async #copyDirectory(
		canonicalRoot: string,
		source: string,
		destination: string,
		relativeDirectory: string,
		depth: number,
		accounting: CopyAccounting,
		hash: ReturnType<typeof createHash>,
		ancestorDirectories: ReadonlySet<string>,
		signal?: AbortSignal,
	): Promise<void> {
		signal?.throwIfAborted();
		const entries = [...(await this.#fileSystem.readDirectory(source))].sort((left, right) =>
			compareText(left.name, right.name),
		);
		for (const entry of entries) {
			signal?.throwIfAborted();
			if (entry.name.toLowerCase() === ".codex-plugin") continue;
			assertSafeEntryName(entry.name);
			const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
			const entryDepth = depth + 1;
			if (entryDepth > this.#limits.maxDepth) {
				throw new Error(`Plugin package exceeds the maximum copy depth of ${this.#limits.maxDepth}`);
			}
			const sourcePath = join(source, entry.name);
			const destinationPath = join(destination, entry.name);
			const resolved = await resolvePluginTreeEntry({
				fileSystem: this.#fileSystem,
				canonicalRoot,
				path: sourcePath,
				relativePath,
				ancestorDirectories,
				followSymbolicLinks: true,
				reservedCanonicalComponents: new Set([".codex-plugin"]),
			});
			const { status } = resolved;
			if (status.kind === "directory") {
				updateDigest(hash, "directory", relativePath, directoryMode(status));
				await this.#fileSystem.makeDirectory(destinationPath, { mode: 0o700 });
				await this.#copyDirectory(
					canonicalRoot,
					resolved.path,
					destinationPath,
					relativePath,
					entryDepth,
					accounting,
					hash,
					new Set([...ancestorDirectories, resolved.path]),
					signal,
				);
				await this.#fileSystem.setMode(destinationPath, directoryMode(status));
				continue;
			}
			if (status.kind !== "file") throw new Error(`Plugin package contains a special file: ${relativePath}`);
			accounting.files++;
			if (accounting.files > this.#limits.maxFiles) {
				throw new Error(`Plugin package exceeds the maximum file count of ${this.#limits.maxFiles}`);
			}
			if (status.size > this.#limits.maxBytes - accounting.bytes) {
				throw new Error(`Plugin package exceeds the maximum byte count of ${this.#limits.maxBytes}`);
			}
			const bytes = await this.#fileSystem.readFile(resolved.path);
			accounting.bytes += bytes.byteLength;
			if (accounting.bytes > this.#limits.maxBytes) {
				throw new Error(`Plugin package exceeds the maximum byte count of ${this.#limits.maxBytes}`);
			}
			updateDigest(hash, "file", relativePath, fileMode(status), bytes);
			await writeNewFile(this.#fileSystem, destinationPath, bytes, fileMode(status));
		}
	}

	async #validatePackage(root: string, expectedName: string, signal?: AbortSignal) {
		const snapshot = await createPlugins<null>({ fileSystem: this.#fileSystem }).load({
			root,
			origin: null,
			signal,
		});
		if (snapshot.status !== "loaded") {
			throw new Error(snapshot.diagnostics[0]?.message ?? "Staged Agent Plugin package is invalid");
		}
		if (snapshot.manifest.name !== expectedName) {
			throw new Error(
				`Staged Agent Plugin manifest name "${snapshot.manifest.name}" does not match PluginId name "${expectedName}"`,
			);
		}
		return snapshot;
	}

	async #assertCachedPackage(
		storeRoot: string,
		root: string,
		expectedName: string,
		digest: string,
		signal?: AbortSignal,
	): Promise<void> {
		await this.#assertStoreOwnedRevision(storeRoot, root);
		await this.#validatePackage(root, expectedName, signal);
		await this.#assertStoreOwnedRevision(storeRoot, root);
		const actual = await this.#digestDirectory(root, signal);
		if (actual !== digest) throw new Error("Content-addressed Plugin cache failed digest verification");
	}

	async #digestDirectory(
		root: string,
		signal?: AbortSignal,
		rejectReservedContent = false,
		followSymbolicLinks = false,
	): Promise<string> {
		const hash = createHash("sha256");
		await this.#hashDirectory(
			root,
			root,
			"",
			0,
			{ files: 0, bytes: 0 },
			hash,
			new Set([root]),
			signal,
			rejectReservedContent,
			followSymbolicLinks,
		);
		return hash.digest("hex");
	}

	async #hashDirectory(
		canonicalRoot: string,
		root: string,
		relativeDirectory: string,
		depth: number,
		accounting: CopyAccounting,
		hash: ReturnType<typeof createHash>,
		ancestorDirectories: ReadonlySet<string>,
		signal?: AbortSignal,
		rejectReservedContent = false,
		followSymbolicLinks = false,
	): Promise<void> {
		const entries = [...(await this.#fileSystem.readDirectory(root))].sort((left, right) =>
			compareText(left.name, right.name),
		);
		for (const entry of entries) {
			signal?.throwIfAborted();
			if (entry.name.toLowerCase() === ".codex-plugin") {
				if (rejectReservedContent) {
					throw new Error("Cached Plugin contains reserved .codex-plugin content");
				}
				continue;
			}
			assertSafeEntryName(entry.name);
			const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
			const entryDepth = depth + 1;
			if (entryDepth > this.#limits.maxDepth) throw new Error("Cached Plugin exceeds the maximum copy depth");
			const path = join(root, entry.name);
			const resolved = await resolvePluginTreeEntry({
				fileSystem: this.#fileSystem,
				canonicalRoot,
				path,
				relativePath,
				ancestorDirectories,
				followSymbolicLinks,
				reservedCanonicalComponents: new Set([".codex-plugin"]),
			});
			const { status } = resolved;
			if (status.kind === "directory") {
				updateDigest(hash, "directory", relativePath, directoryMode(status));
				await this.#hashDirectory(
					canonicalRoot,
					resolved.path,
					relativePath,
					entryDepth,
					accounting,
					hash,
					new Set([...ancestorDirectories, resolved.path]),
					signal,
					rejectReservedContent,
					followSymbolicLinks,
				);
				continue;
			}
			if (status.kind !== "file") throw new Error(`Cached Plugin contains an unsafe entry: ${relativePath}`);
			accounting.files++;
			if (accounting.files > this.#limits.maxFiles) throw new Error("Cached Plugin exceeds the maximum file count");
			if (status.size > this.#limits.maxBytes - accounting.bytes) {
				throw new Error("Cached Plugin exceeds the maximum byte count");
			}
			const bytes = await this.#fileSystem.readFile(resolved.path);
			accounting.bytes += bytes.byteLength;
			if (accounting.bytes > this.#limits.maxBytes) throw new Error("Cached Plugin exceeds the maximum byte count");
			updateDigest(hash, "file", relativePath, fileMode(status), bytes);
		}
	}

	async #readState(root: string): Promise<CodingPluginInstallationsSnapshot> {
		const path = join(root, "installations.v1.json");
		let bytes: Uint8Array;
		try {
			const status = await this.#fileSystem.lstat(path);
			if (status.kind !== "file") throw new Error("state path is not a regular file");
			bytes = await this.#fileSystem.readFile(path);
		} catch (error) {
			if (isFileSystemError(error, "ENOENT")) return freezeSnapshot([]);
			throw new Error("Could not read corrupt Plugin installation state", { cause: error });
		}
		try {
			const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
			return parseState(value, root);
		} catch (error) {
			throw new Error("Could not read corrupt Plugin installation state", { cause: error });
		}
	}

	async #writeState(
		root: string,
		installations: readonly CodingPluginInstallationRecord[],
		signal?: AbortSignal,
	): Promise<void> {
		const path = join(root, "installations.v1.json");
		const token = safeIdentity(this.#idGenerator.generate("queue_item"));
		const temporary = `${path}.${token}.tmp`;
		let handle: WritableFile | undefined;
		let installed = false;
		try {
			handle = await this.#fileSystem.open(temporary, "wx", 0o600);
			await handle.write(`${JSON.stringify({ version: 1, installations })}\n`);
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

	async #exists(path: string): Promise<boolean> {
		try {
			await this.#fileSystem.lstat(path);
			return true;
		} catch (error) {
			if (isFileSystemError(error, "ENOENT")) return false;
			throw error;
		}
	}

	async #removeFileIfPresent(path: string): Promise<void> {
		try {
			await this.#fileSystem.removeFile(path);
		} catch (error) {
			if (!isFileSystemError(error, "ENOENT")) throw error;
		}
	}

	async #removeTreeIfPresent(path: string): Promise<void> {
		let status: FileStatus;
		try {
			status = await this.#fileSystem.lstat(path);
		} catch (error) {
			if (isFileSystemError(error, "ENOENT")) return;
			throw error;
		}
		if (status.kind !== "directory") {
			await this.#fileSystem.removeFile(path);
			return;
		}
		for (const entry of await this.#fileSystem.readDirectory(path)) {
			assertSafeEntryName(entry.name);
			await this.#removeTreeIfPresent(join(path, entry.name));
		}
		await this.#fileSystem.removeDirectory(path);
	}
}

export function createCodingPluginInstallationStore(
	options: CreateCodingPluginInstallationStoreOptions,
): CodingPluginInstallationStore {
	if (!options || typeof options !== "object") throw new TypeError("Plugin installation store options are required");
	if (!isAbsolute(options.root)) throw new TypeError("Plugin installation store root must be absolute");
	if (!options.fileSystem) throw new TypeError("fileSystem is required");
	if (!options.idGenerator) throw new TypeError("idGenerator is required");
	return new FileCodingPluginInstallationStore(options);
}

function resolveLimits(
	overrides: Partial<CodingPluginInstallationLimits> | undefined,
): Readonly<CodingPluginInstallationLimits> {
	const limits = { ...DEFAULT_CODING_PLUGIN_INSTALLATION_LIMITS, ...overrides };
	for (const [name, value] of Object.entries(limits)) {
		if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
	}
	return Object.freeze(limits);
}

function validateMarketplaceEntry(entry: CodingPluginMarketplaceEntry): void {
	if (
		!entry ||
		typeof entry !== "object" ||
		typeof entry.name !== "string" ||
		!isPluginName(entry.name) ||
		typeof entry.marketplace !== "string" ||
		!/^[A-Za-z0-9_-]+$/u.test(entry.marketplace) ||
		entry.pluginId !== `${entry.name}@${entry.marketplace}`
	) {
		throw new TypeError("Plugin Marketplace entry has an invalid stable identity");
	}
	if (isCodingPluginLocalSource(entry.marketplace)) {
		throw new TypeError(`Plugin Marketplace name "${entry.marketplace}" is reserved for direct installations`);
	}
}

function parseState(value: unknown, root: string): CodingPluginInstallationsSnapshot {
	if (!isRecord(value) || !hasOnlyKeys(value, ["version", "installations"]) || value.version !== 1) {
		throw new Error("unsupported Plugin installation state version");
	}
	if (!Array.isArray(value.installations)) throw new Error("Plugin installation records must be an array");
	const records: CodingPluginInstallationRecord[] = [];
	const pluginIds = new Set<string>();
	for (const candidate of value.installations) {
		if (
			!isRecord(candidate) ||
			!hasOnlyKeys(candidate, [
				"pluginId",
				"name",
				"marketplace",
				"version",
				"digest",
				"revision",
				"source",
				"selectedRoot",
			]) ||
			typeof candidate.pluginId !== "string" ||
			typeof candidate.name !== "string" ||
			!isPluginName(candidate.name) ||
			typeof candidate.marketplace !== "string" ||
			!/^[A-Za-z0-9_-]+$/u.test(candidate.marketplace) ||
			isCodingPluginLocalSource(candidate.marketplace) ||
			candidate.pluginId !== `${candidate.name}@${candidate.marketplace}` ||
			(candidate.version !== undefined &&
				(typeof candidate.version !== "string" ||
					candidate.version.length === 0 ||
					candidate.version.trim() !== candidate.version)) ||
			typeof candidate.digest !== "string" ||
			!/^[a-f0-9]{64}$/u.test(candidate.digest) ||
			typeof candidate.revision !== "string" ||
			candidate.revision !== revisionFor(candidate.pluginId as CodingPluginId, candidate.digest) ||
			typeof candidate.selectedRoot !== "string"
		) {
			throw new Error("invalid Plugin installation record");
		}
		if (pluginIds.has(candidate.pluginId)) throw new Error("duplicate Plugin installation record");
		pluginIds.add(candidate.pluginId);
		const pluginId = candidate.pluginId as CodingPluginId;
		const expectedRoot = join(root, "cache", pluginCacheSlot(pluginId), candidate.digest);
		if (candidate.selectedRoot !== expectedRoot) throw new Error("Plugin cache pointer leaves its installation slot");
		records.push(
			freezeRecord({
				pluginId,
				name: candidate.name,
				marketplace: candidate.marketplace,
				...(typeof candidate.version === "string" ? { version: candidate.version } : {}),
				digest: candidate.digest,
				revision: candidate.revision,
				source: parseSource(candidate.source),
				selectedRoot: candidate.selectedRoot,
			}),
		);
	}
	const sorted = [...records].sort((left, right) => compareText(left.pluginId, right.pluginId));
	if (records.some((record, index) => record.pluginId !== sorted[index]?.pluginId)) {
		throw new Error("Plugin installation records are not deterministically ordered");
	}
	return freezeSnapshot(records);
}

function parseSource(value: unknown): CodingPluginMarketplaceSource {
	if (!isRecord(value) || typeof value.source !== "string") throw new Error("invalid Plugin source metadata");
	if (value.source === "local") {
		if (
			!hasOnlyKeys(value, ["source", "path", "root"]) ||
			typeof value.path !== "string" ||
			value.path.length === 0 ||
			typeof value.root !== "string" ||
			!isAbsolute(value.root)
		) {
			throw new Error("invalid local Plugin source metadata");
		}
		return Object.freeze({ source: "local" as const, path: value.path, root: value.root });
	}
	if (value.source !== "url" && value.source !== "git-subdir") {
		throw new Error("unsupported Plugin source metadata");
	}
	if (
		!hasOnlyKeys(value, ["source", "url", "path", "ref", "sha"]) ||
		typeof value.url !== "string" ||
		value.url.length === 0 ||
		(value.path !== undefined && typeof value.path !== "string") ||
		(value.source === "git-subdir" && (typeof value.path !== "string" || value.path.length === 0)) ||
		(value.ref !== undefined && typeof value.ref !== "string") ||
		(value.sha !== undefined &&
			(typeof value.sha !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value.sha)))
	) {
		throw new Error("invalid Git Plugin source metadata");
	}
	return Object.freeze({
		source: value.source,
		url: value.url,
		...(typeof value.path === "string" ? { path: value.path } : {}),
		...(typeof value.ref === "string" ? { ref: value.ref } : {}),
		...(typeof value.sha === "string" ? { sha: value.sha } : {}),
	});
}

function parseRevisionLease(value: unknown): RevisionLeaseRecord {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, ["version", "token", "pid", "revisions"]) ||
		value.version !== 1 ||
		typeof value.token !== "string" ||
		!/^[a-f0-9]{32}$/u.test(value.token) ||
		!Number.isSafeInteger(value.pid) ||
		(value.pid as number) < 1 ||
		!Array.isArray(value.revisions) ||
		value.revisions.length === 0
	) {
		throw new Error("Plugin revision lease contains an invalid record");
	}
	const revisions: RevisionLeaseEntry[] = [];
	const identities = new Set<string>();
	for (const candidate of value.revisions) {
		if (
			!isRecord(candidate) ||
			!hasOnlyKeys(candidate, ["slot", "digest"]) ||
			typeof candidate.slot !== "string" ||
			!/^[a-f0-9]{64}$/u.test(candidate.slot) ||
			typeof candidate.digest !== "string" ||
			!/^[a-f0-9]{64}$/u.test(candidate.digest)
		) {
			throw new Error("Plugin revision lease contains an invalid revision identity");
		}
		const identity = `${candidate.slot}/${candidate.digest}`;
		if (identities.has(identity)) throw new Error("Plugin revision lease contains a duplicate revision identity");
		identities.add(identity);
		revisions.push(Object.freeze({ slot: candidate.slot, digest: candidate.digest }));
	}
	const sorted = [...revisions].sort((left, right) =>
		compareText(`${left.slot}/${left.digest}`, `${right.slot}/${right.digest}`),
	);
	if (revisions.some((revision, index) => revision !== sorted[index])) {
		throw new Error("Plugin revision lease identities are not deterministically ordered");
	}
	return Object.freeze({
		version: 1 as const,
		token: value.token,
		pid: value.pid as number,
		revisions: Object.freeze(revisions),
	});
}

function parseRetiredRevisionsState(value: unknown): RetiredRevisionsState {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, ["version", "revisions"]) ||
		value.version !== 1 ||
		!Array.isArray(value.revisions)
	) {
		throw new Error("retired Plugin revision state contains an invalid record");
	}
	const revisions: RevisionLeaseEntry[] = [];
	const identities = new Set<string>();
	for (const candidate of value.revisions) {
		if (
			!isRecord(candidate) ||
			!hasOnlyKeys(candidate, ["slot", "digest"]) ||
			typeof candidate.slot !== "string" ||
			!/^[a-f0-9]{64}$/u.test(candidate.slot) ||
			typeof candidate.digest !== "string" ||
			!/^[a-f0-9]{64}$/u.test(candidate.digest)
		) {
			throw new Error("retired Plugin revision state contains an invalid revision identity");
		}
		const identity = `${candidate.slot}/${candidate.digest}`;
		if (identities.has(identity)) {
			throw new Error("retired Plugin revision state contains a duplicate revision identity");
		}
		identities.add(identity);
		revisions.push(Object.freeze({ slot: candidate.slot, digest: candidate.digest }));
	}
	const sorted = [...revisions].sort((left, right) =>
		compareText(`${left.slot}/${left.digest}`, `${right.slot}/${right.digest}`),
	);
	if (revisions.some((revision, index) => revision !== sorted[index])) {
		throw new Error("retired Plugin revision identities are not deterministically ordered");
	}
	return Object.freeze({ version: 1 as const, revisions: Object.freeze(revisions) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	const allowedKeys = new Set(allowed);
	return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isPluginName(value: string): boolean {
	return value.length <= 64 && /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(value);
}

function cloneSource(source: CodingPluginMarketplaceSource): CodingPluginMarketplaceSource {
	return Object.freeze({ ...source });
}

function freezeRecord(record: CodingPluginInstallationRecord): CodingPluginInstallationRecord {
	return Object.freeze({ ...record, source: cloneSource(record.source) });
}

function rejectedVerification(
	record: CodingPluginInstallationRecord,
	code: CodingPluginInstallationVerificationCode,
	message: string,
): CodingPluginInstallationVerification {
	return Object.freeze({ status: "rejected" as const, code, message, record });
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function freezeSnapshot(installations: readonly CodingPluginInstallationRecord[]): CodingPluginInstallationsSnapshot {
	return Object.freeze({
		version: 1 as const,
		installations: Object.freeze(installations.map(freezeRecord)),
	});
}

function revisionFor(pluginId: CodingPluginId, digest: string): string {
	return createHash("sha256").update(pluginId).update("\0").update(digest).digest("hex");
}

function revisionLeaseFilename(value: string): { readonly pid: number; readonly token: string } {
	const match = /^([1-9][0-9]*)-([a-f0-9]{32})\.json$/u.exec(value);
	const pid = match ? Number(match[1]) : Number.NaN;
	if (!match || !Number.isSafeInteger(pid) || pid < 1) {
		throw new Error("Plugin revision lease has an invalid filename");
	}
	return Object.freeze({ pid, token: match[2]! });
}

function pluginCacheSlot(pluginId: CodingPluginId): string {
	return createHash("sha256").update("coda-agent-plugin-installation-cache-slot-v1\0").update(pluginId).digest("hex");
}

function safeIdentity(value: string): string {
	const safe = value.replace(/[^a-zA-Z0-9._-]/gu, "-");
	if (!safe || safe === "." || safe === ".." || safe.length > 128) {
		throw new Error("IdGenerator returned an invalid Plugin installation identity");
	}
	return safe;
}

function assertSafeEntryName(name: string): void {
	if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
		throw new Error(`Plugin package contains an unsafe path entry: ${JSON.stringify(name)}`);
	}
}

function assertNonLegacyPackagePath(path: string): void {
	if (pathHasComponent(path, ".codex-plugin")) {
		throw new Error('Plugin package roots must not resolve through a reserved ".codex-plugin" path');
	}
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function fileMode(status: FileStatus): number {
	return status.mode & 0o777;
}

function directoryMode(status: FileStatus): number {
	return status.mode & 0o777;
}

async function writeNewFile(fileSystem: FileSystem, path: string, bytes: Uint8Array, mode: number): Promise<void> {
	const handle = await fileSystem.open(path, "wx", mode);
	try {
		await handle.write(bytes);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await fileSystem.setMode(path, mode);
}

function updateDigest(
	hash: ReturnType<typeof createHash>,
	kind: "directory" | "file",
	path: string,
	mode: number,
	bytes: Uint8Array = new Uint8Array(),
): void {
	const encodedPath = new TextEncoder().encode(path);
	hash.update(Uint8Array.of(kind === "directory" ? 0 : 1));
	hash.update(modeBytes(mode));
	hash.update(lengthBytes(encodedPath.byteLength));
	hash.update(encodedPath);
	hash.update(lengthBytes(bytes.byteLength));
	hash.update(bytes);
}

function modeBytes(mode: number): Uint8Array {
	const bytes = new Uint8Array(2);
	new DataView(bytes.buffer).setUint16(0, mode & 0o777, false);
	return bytes;
}

function lengthBytes(value: number): Uint8Array {
	const bytes = new Uint8Array(8);
	new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
	return bytes;
}
