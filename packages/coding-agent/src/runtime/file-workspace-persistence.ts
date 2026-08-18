import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { WorkGraphId } from "@coda/runtime";
import {
	decodeWorkGraphEnvelope,
	decodeWorkspaceLedger,
	emptyWorkspaceLedger,
	encodeWorkGraphEnvelope,
	encodeWorkspaceLedger,
	mergeWorkGraphCommits,
	type WorkGraphStore,
	type WorkGraphStoreRestore,
	type WorkspaceGraphIndexEntry,
	type WorkspaceLedger,
	type WorkspaceLedgerAcceptance,
	type WorkspaceLedgerRestore,
	type WorkspaceOrderReservation,
	type WorkspacePersistence,
	type WorkspacePersistenceLease,
	type WorkspaceSessionOwner,
	type WorkspaceTargetIdentity,
} from "@coda/runtime/workspace-persistence";
import { processIsAlive, withFileMutex } from "../host/file-mutex.ts";
import { type FileSystem, isFileSystemError, type WritableFile } from "../host/file-system.ts";

interface EpochRecord {
	readonly version: 1;
	readonly epoch: string;
	readonly pid: number;
	readonly acquiredAt: string;
}

const LEASE_EPOCH_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function decodeEpochRecord(source: string): EpochRecord {
	const value: unknown = JSON.parse(source);
	if (
		typeof value !== "object" ||
		value === null ||
		!("version" in value) ||
		value.version !== 1 ||
		!("epoch" in value) ||
		typeof value.epoch !== "string" ||
		!LEASE_EPOCH_PATTERN.test(value.epoch) ||
		!("pid" in value) ||
		!Number.isSafeInteger(value.pid) ||
		(value.pid as number) < 1 ||
		!("acquiredAt" in value) ||
		typeof value.acquiredAt !== "string"
	) {
		throw new Error("Invalid Workspace process epoch");
	}
	return value as EpochRecord;
}

function graphFileName(graphId: WorkGraphId): string {
	return `${Buffer.from(String(graphId), "utf8").toString("base64url")}.jsonl`;
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

async function exists(fileSystem: FileSystem, path: string): Promise<boolean> {
	try {
		await fileSystem.lstat(path);
		return true;
	} catch (error) {
		if (isFileSystemError(error, "ENOENT")) return false;
		throw error;
	}
}

class FileWorkGraphStore implements WorkGraphStore {
	readonly #fileSystem: FileSystem;
	readonly #graphId: WorkGraphId;
	readonly #path: string;
	readonly #mustExist: boolean;
	readonly #readOnly: boolean;
	#loadOperation?: Promise<void>;
	readonly #commits: unknown[] = [];
	readonly #diagnostics: string[] = [];
	#handle?: WritableFile;
	#sequence = 0;
	#tail: Promise<void> = Promise.resolve();
	#failure?: unknown;
	#closed = false;

	constructor(
		fileSystem: FileSystem,
		graphId: WorkGraphId,
		path: string,
		options: { mustExist: boolean; readOnly?: boolean },
	) {
		this.#fileSystem = fileSystem;
		this.#graphId = graphId;
		this.#path = path;
		this.#mustExist = options.mustExist;
		this.#readOnly = options.readOnly ?? false;
	}

	async load(): Promise<WorkGraphStoreRestore> {
		if (this.#closed) throw new Error("Work Graph store is closed");
		await this.#ensureLoaded();
		return {
			restore: mergeWorkGraphCommits(clone(this.#commits)),
			diagnostics: Object.freeze([...this.#diagnostics]),
		};
	}

	async append(commit: unknown): Promise<void> {
		if (this.#readOnly) throw new Error("Historical Work Graph store is read-only");
		if (this.#closed) throw new Error("Work Graph store is closed");
		await this.#ensureLoaded();
		const durable = clone(commit);
		const envelope = decodeWorkGraphEnvelope(encodeWorkGraphEnvelope(durable, 1), 1);
		if (envelope.graphId !== this.#graphId) {
			throw new Error(`Work Graph store ${this.#graphId} cannot append Facts for another Graph`);
		}
		await this.#enqueue(async () => {
			const sequence = this.#sequence + 1;
			const handle = await this.#fileHandle();
			await handle.write(`${encodeWorkGraphEnvelope(durable, sequence)}\n`);
			await handle.sync();
			this.#sequence = sequence;
			this.#commits.push(durable);
		});
	}

	async flush(): Promise<void> {
		if (this.#closed) throw new Error("Work Graph store is closed");
		await this.#tail;
		this.#assertHealthy();
		try {
			await this.#handle?.sync();
		} catch (error) {
			this.#poison(error);
			throw error;
		}
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#tail;
		let failure = this.#failure;
		if (!failure && !this.#readOnly) {
			try {
				await this.#handle?.sync();
			} catch (error) {
				this.#poison(error);
				failure = error;
			}
		}
		try {
			await this.#handle?.close();
		} catch (error) {
			failure ??= error;
		}
		this.#handle = undefined;
		if (failure) throw failure;
	}

	#ensureLoaded(): Promise<void> {
		this.#loadOperation ??= this.#load();
		return this.#loadOperation;
	}

	async #load(): Promise<void> {
		let source = "";
		try {
			source = new TextDecoder().decode(await this.#fileSystem.readFile(this.#path));
		} catch (error) {
			if (!isFileSystemError(error, "ENOENT") || this.#mustExist) throw error;
		}
		const diagnostics: string[] = [];
		const lines = source.split("\n");
		const hasPartialTail = lines.at(-1)?.length !== 0;
		if (!hasPartialTail) lines.pop();
		const commits: unknown[] = [];
		let repaired = false;
		for (const [index, line] of lines.entries()) {
			try {
				const envelope = decodeWorkGraphEnvelope(line, index + 1);
				if (envelope.graphId !== this.#graphId) {
					throw new Error(`Work Graph store ${this.#graphId} contains Facts for another Graph`);
				}
				commits.push(envelope.commit);
				this.#sequence = envelope.sequence;
			} catch (error) {
				if (hasPartialTail && index === lines.length - 1) {
					try {
						JSON.parse(line);
					} catch {
						diagnostics.push(`Ignored incomplete Work Graph tail at sequence ${index + 1}`);
						repaired = true;
						break;
					}
				}
				throw error;
			}
		}
		if (repaired && !this.#readOnly) {
			const encoded = lines.slice(0, this.#sequence).join("\n");
			await this.#replace(encoded.length > 0 ? `${encoded}\n` : "");
		}
		this.#commits.push(...commits);
		this.#diagnostics.push(...diagnostics);
	}

	async #replace(value: string): Promise<void> {
		await this.#fileSystem.makeDirectory(dirname(this.#path), { recursive: true, mode: 0o700 });
		const temporary = `${this.#path}.repair-${process.pid}-${randomUUID()}`;
		try {
			const handle = await this.#fileSystem.open(temporary, "wx", 0o600);
			try {
				await handle.write(value);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await this.#fileSystem.rename(temporary, this.#path);
		} catch (error) {
			await this.#fileSystem.removeFile(temporary).catch(() => undefined);
			throw error;
		}
	}

	async #fileHandle(): Promise<WritableFile> {
		if (this.#handle) return this.#handle;
		await this.#fileSystem.makeDirectory(dirname(this.#path), { recursive: true, mode: 0o700 });
		this.#handle = await this.#fileSystem.open(this.#path, "a", 0o600);
		return this.#handle;
	}

	#enqueue(operation: () => Promise<void>): Promise<void> {
		const result = this.#tail.then(async () => {
			this.#assertHealthy();
			try {
				await operation();
			} catch (error) {
				this.#poison(error);
				throw error;
			}
		});
		this.#tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	#assertHealthy(): void {
		if (this.#failure) throw this.#failure;
	}

	#poison(error: unknown): void {
		this.#failure ??= error;
	}
}

class FileWorkspaceLedger implements WorkspaceLedger {
	readonly #fileSystem: FileSystem;
	readonly #path: string;
	readonly #lockPath: string;
	readonly #epoch: string;
	readonly #epochIsLive: (epoch?: string) => Promise<boolean>;
	#persistentState: WorkspaceLedgerRestore = emptyWorkspaceLedger();
	#loaded?: Promise<void>;
	#tail: Promise<void> = Promise.resolve();
	#failure?: unknown;
	#closed = false;

	constructor(options: {
		readonly fileSystem: FileSystem;
		readonly path: string;
		readonly epoch: string;
		readonly epochIsLive: (epoch?: string) => Promise<boolean>;
	}) {
		this.#fileSystem = options.fileSystem;
		this.#path = options.path;
		this.#lockPath = `${options.path}.lock`;
		this.#epoch = options.epoch;
		this.#epochIsLive = options.epochIsLive;
	}

	async load(): Promise<WorkspaceLedgerRestore> {
		if (this.#closed) throw new Error("Workspace Ledger is closed");
		await this.#ensureLoaded();
		return clone(this.#visible(this.#persistentState));
	}

	async refresh(): Promise<WorkspaceLedgerRestore> {
		if (this.#closed) throw new Error("Workspace Ledger is closed");
		await this.#tail;
		if (this.#failure) throw this.#failure;
		this.#persistentState = await this.#read();
		return clone(this.#visible(this.#persistentState));
	}

	isActive(graphId: WorkGraphId): boolean {
		return this.#persistentState.activeGraphs.some(
			(entry) => entry.graphId === graphId && entry.ownerEpoch === this.#epoch,
		);
	}

	ownerEpoch(graphId: WorkGraphId): string | undefined {
		return this.#persistentState.activeGraphs.find((entry) => entry.graphId === graphId)?.ownerEpoch;
	}

	async reserveOrders(request: {
		readonly graphCount: number;
		readonly publicationCount: number;
	}): Promise<WorkspaceOrderReservation> {
		for (const [name, value] of Object.entries(request)) {
			if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
		}
		return this.#transact((state) => {
			const graphOrderStart = state.nextGraphOrder;
			const publicationOrderStart = state.nextPublicationOrder;
			const nextGraphOrder = graphOrderStart + request.graphCount;
			const nextPublicationOrder = publicationOrderStart + request.publicationCount;
			if (!Number.isSafeInteger(nextGraphOrder) || !Number.isSafeInteger(nextPublicationOrder)) {
				throw new Error("Workspace order reservation exceeds the safe integer range");
			}
			return {
				state: { ...state, nextGraphOrder, nextPublicationOrder },
				result: { graphOrderStart, publicationOrderStart, nextGraphOrder, nextPublicationOrder },
			};
		});
	}

	accept(acceptance: WorkspaceLedgerAcceptance): Promise<void> {
		return this.#mutate((state) => {
			const active = new Map(state.activeGraphs.map((entry) => [entry.graphId, entry]));
			for (const entry of acceptance.activeGraphs) {
				const existing = active.get(entry.graphId);
				if (existing?.ownerEpoch && existing.ownerEpoch !== this.#epoch) {
					throw new Error(`Work Graph is owned by another Workspace epoch: ${entry.graphId}`);
				}
				active.set(entry.graphId, { ...clone(entry), ownerEpoch: this.#epoch });
			}
			const owners = new Map(state.sessionOwners.map((owner) => [owner.sessionId, owner]));
			for (const owner of acceptance.sessionOwners) {
				const existing = owners.get(owner.sessionId);
				if (existing && (existing.graphId !== owner.graphId || existing.itemId !== owner.itemId)) {
					throw new Error(`Session is already owned: ${owner.sessionId}`);
				}
				owners.set(owner.sessionId, clone(owner));
			}
			return {
				activeGraphs: [...active.values()].sort((left, right) => left.order - right.order),
				nextGraphOrder: Math.max(state.nextGraphOrder, acceptance.nextGraphOrder),
				nextPublicationOrder: Math.max(state.nextPublicationOrder, acceptance.nextPublicationOrder),
				sessionOwners: [...owners.values()],
				targetIdentities: state.targetIdentities,
				diagnostics: [],
			};
		});
	}

	releaseSession(owner: WorkspaceSessionOwner): Promise<void> {
		return this.#mutate((state) => ({
			...state,
			sessionOwners: state.sessionOwners.filter(
				(candidate) =>
					candidate.sessionId !== owner.sessionId ||
					candidate.graphId !== owner.graphId ||
					candidate.itemId !== owner.itemId,
			),
		}));
	}

	recordTargetIdentity(identity: WorkspaceTargetIdentity): Promise<void> {
		return this.#mutate((state) => {
			const identities = new Map(state.targetIdentities.map((entry) => [entry.targetPlacementId, entry]));
			identities.set(identity.targetPlacementId, clone(identity));
			return { ...state, targetIdentities: [...identities.values()] };
		});
	}

	archiveGraph(graphId: WorkGraphId): Promise<void> {
		return this.#mutate((state) => ({
			...state,
			activeGraphs: state.activeGraphs.filter((entry) => entry.graphId !== graphId),
			sessionOwners: state.sessionOwners.filter((owner) => owner.graphId !== graphId),
		}));
	}

	async flush(): Promise<void> {
		if (this.#closed) throw new Error("Workspace Ledger is closed");
		await this.#tail;
		if (this.#failure) throw this.#failure;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#tail;
		if (this.#failure) throw this.#failure;
	}

	#ensureLoaded(): Promise<void> {
		this.#loaded ??= this.#load();
		return this.#loaded;
	}

	async #load(): Promise<void> {
		await withFileMutex({
			fileSystem: this.#fileSystem,
			path: this.#lockPath,
			operation: async () => {
				const current = await this.#read();
				const claimed = await this.#claimRecoverableGraphs(current);
				if (claimed.changed) {
					const encoded = encodeWorkspaceLedger(claimed.state);
					await this.#replace(`${encoded}\n`);
					this.#persistentState = decodeWorkspaceLedger(encoded);
				} else {
					this.#persistentState = claimed.state;
				}
			},
		});
	}

	async #claimRecoverableGraphs(state: WorkspaceLedgerRestore): Promise<{
		readonly state: WorkspaceLedgerRestore;
		readonly changed: boolean;
	}> {
		let changed = false;
		const activeGraphs: WorkspaceGraphIndexEntry[] = [];
		for (const entry of state.activeGraphs) {
			if (entry.ownerEpoch === this.#epoch) {
				activeGraphs.push(entry);
				continue;
			}
			const live = await this.#epochIsLive(entry.ownerEpoch);
			if (live) {
				activeGraphs.push(entry);
				continue;
			}
			activeGraphs.push({ ...entry, ownerEpoch: this.#epoch });
			changed = true;
		}
		return { state: { ...state, activeGraphs, diagnostics: [] }, changed };
	}

	#visible(state: WorkspaceLedgerRestore): WorkspaceLedgerRestore {
		const activeGraphs = state.activeGraphs.filter((entry) => entry.ownerEpoch === this.#epoch);
		const visible = new Set(activeGraphs.map((entry) => entry.graphId));
		return {
			...state,
			activeGraphs,
			sessionOwners: state.sessionOwners.filter((owner) => visible.has(owner.graphId)),
			diagnostics: [],
		};
	}

	async #read(): Promise<WorkspaceLedgerRestore> {
		try {
			return decodeWorkspaceLedger(new TextDecoder().decode(await this.#fileSystem.readFile(this.#path)));
		} catch (error) {
			if (!isFileSystemError(error, "ENOENT")) throw error;
			return emptyWorkspaceLedger();
		}
	}

	#mutate(change: (state: WorkspaceLedgerRestore) => WorkspaceLedgerRestore): Promise<void> {
		return this.#transact((state) => ({ state: change(state), result: undefined }));
	}

	async #transact<Result>(
		change: (state: WorkspaceLedgerRestore) => { readonly state: WorkspaceLedgerRestore; readonly result: Result },
	): Promise<Result> {
		if (this.#closed) throw new Error("Workspace Ledger is closed");
		await this.#ensureLoaded();
		const operation = this.#tail.then(async () => {
			if (this.#failure) throw this.#failure;
			return withFileMutex({
				fileSystem: this.#fileSystem,
				path: this.#lockPath,
				operation: async () => {
					const current = await this.#read();
					const changed = change(clone(current));
					const encoded = encodeWorkspaceLedger(changed.state);
					const next = decodeWorkspaceLedger(encoded);
					try {
						await this.#replace(`${encoded}\n`);
						this.#persistentState = next;
						return changed.result;
					} catch (error) {
						this.#failure ??= error;
						throw error;
					}
				},
			});
		});
		this.#tail = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	async #replace(value: string): Promise<void> {
		await this.#fileSystem.makeDirectory(dirname(this.#path), { recursive: true, mode: 0o700 });
		const temporary = `${this.#path}.next-${process.pid}-${randomUUID()}`;
		try {
			const handle = await this.#fileSystem.open(temporary, "wx", 0o600);
			try {
				await handle.write(value);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await this.#fileSystem.rename(temporary, this.#path);
		} catch (error) {
			await this.#fileSystem.removeFile(temporary).catch(() => undefined);
			throw error;
		}
	}
}

class FileWorkspacePersistence implements WorkspacePersistence {
	readonly #fileSystem: FileSystem;
	readonly #root: string;
	#leased = false;

	constructor(fileSystem: FileSystem, root: string) {
		if (root.length === 0) throw new Error("Workspace persistence root must not be empty");
		this.#fileSystem = fileSystem;
		this.#root = root;
	}

	async acquire(): Promise<WorkspacePersistenceLease> {
		if (this.#leased) throw new Error("Workspace persistence lease is already held by this process");
		await this.#fileSystem.makeDirectory(this.#root, { recursive: true, mode: 0o700 });
		const epoch = randomUUID();
		const epochRoot = join(this.#root, "epochs");
		const epochPath = join(epochRoot, `${epoch}.json`);
		await this.#fileSystem.makeDirectory(epochRoot, { recursive: true, mode: 0o700 });
		const epochHandle = await this.#fileSystem.open(epochPath, "wx", 0o600);
		const epochRecord: EpochRecord = {
			version: 1,
			epoch,
			pid: process.pid,
			acquiredAt: new Date().toISOString(),
		};
		try {
			await epochHandle.write(`${JSON.stringify(epochRecord)}\n`);
			await epochHandle.sync();
		} catch (error) {
			await epochHandle.close().catch(() => undefined);
			await this.#fileSystem.removeFile(epochPath).catch(() => undefined);
			throw error;
		} finally {
			await epochHandle.close().catch(() => undefined);
		}
		const epochIsLive = async (candidate?: string): Promise<boolean> => {
			const candidatePath = candidate ? join(epochRoot, `${candidate}.json`) : join(this.#root, "workspace.lease");
			try {
				const record = decodeEpochRecord(new TextDecoder().decode(await this.#fileSystem.readFile(candidatePath)));
				const live = (candidate === undefined || record.epoch === candidate) && processIsAlive(record.pid);
				if (candidate !== undefined && !live) {
					await this.#fileSystem.removeFile(candidatePath).catch(() => undefined);
				}
				return live;
			} catch (error) {
				if (isFileSystemError(error, "ENOENT")) return false;
				return true;
			}
		};
		const ledger = new FileWorkspaceLedger({
			fileSystem: this.#fileSystem,
			path: join(this.#root, "ledger.json"),
			epoch,
			epochIsLive,
		});
		const activeRoot = join(this.#root, "graphs", "active");
		const archiveRoot = join(this.#root, "graphs", "archive");
		const orphanRoot = join(this.#root, "graphs", "orphan");
		try {
			await ledger.load();
			await this.#fileSystem.makeDirectory(activeRoot, { recursive: true, mode: 0o700 });
			await this.#fileSystem.makeDirectory(archiveRoot, { recursive: true, mode: 0o700 });
			await this.#fileSystem.makeDirectory(orphanRoot, { recursive: true, mode: 0o700 });
		} catch (error) {
			await ledger.close().catch(() => undefined);
			await this.#fileSystem.removeFile(epochPath).catch(() => undefined);
			throw error;
		}
		this.#leased = true;
		const stores = new Map<WorkGraphId, FileWorkGraphStore>();
		let closed = false;
		const activePath = (graphId: WorkGraphId) => join(activeRoot, graphFileName(graphId));
		const archivePath = (graphId: WorkGraphId) => join(archiveRoot, graphFileName(graphId));
		const orphanPath = async (graphId: WorkGraphId): Promise<string | undefined> => {
			const prefix = `${graphFileName(graphId)}.orphan-`;
			const matches = (await this.#fileSystem.readDirectory(orphanRoot))
				.filter((entry) => entry.kind === "file" && entry.name.startsWith(prefix))
				.map((entry) => entry.name)
				.sort();
			const latest = matches.at(-1);
			return latest ? join(orphanRoot, latest) : undefined;
		};
		return Object.freeze({
			epoch,
			ledger,
			openGraph: async (graphId: WorkGraphId) => {
				if (closed) throw new Error("Workspace persistence lease is closed");
				const current = stores.get(graphId);
				if (current) return current;
				await ledger.refresh();
				const owner = ledger.ownerEpoch(graphId);
				if (owner && owner !== epoch) throw new Error(`Work Graph is active in another process: ${graphId}`);
				if (await exists(this.#fileSystem, archivePath(graphId))) {
					throw new Error(`Work Graph is archived: ${graphId}`);
				}
				const path = activePath(graphId);
				if (!ledger.isActive(graphId) && (await exists(this.#fileSystem, path))) {
					await this.#fileSystem.rename(path, join(orphanRoot, `${graphFileName(graphId)}.orphan-${epoch}`));
				}
				const store = new FileWorkGraphStore(this.#fileSystem, graphId, path, {
					mustExist: ledger.isActive(graphId),
				});
				stores.set(graphId, store);
				return store;
			},
			openHistoricalGraph: async (graphId: WorkGraphId) => {
				if (closed) throw new Error("Workspace persistence lease is closed");
				const archived = archivePath(graphId);
				if (await exists(this.#fileSystem, archived)) {
					return new FileWorkGraphStore(this.#fileSystem, graphId, archived, { mustExist: true, readOnly: true });
				}
				const unrelocated = activePath(graphId);
				if (!ledger.ownerEpoch(graphId) && (await exists(this.#fileSystem, unrelocated))) {
					return new FileWorkGraphStore(this.#fileSystem, graphId, unrelocated, {
						mustExist: true,
						readOnly: true,
					});
				}
				const orphan = await orphanPath(graphId);
				if (orphan) {
					return new FileWorkGraphStore(this.#fileSystem, graphId, orphan, { mustExist: true, readOnly: true });
				}
				return undefined;
			},
			archiveGraph: async (graphId: WorkGraphId) => {
				if (closed) throw new Error("Workspace persistence lease is closed");
				await stores.get(graphId)?.close();
				stores.delete(graphId);
				const from = activePath(graphId);
				const to = archivePath(graphId);
				if (await exists(this.#fileSystem, to)) return;
				if (await exists(this.#fileSystem, from)) await this.#fileSystem.rename(from, to);
			},
			close: async () => {
				if (closed) return;
				closed = true;
				const failures: unknown[] = [];
				for (const store of stores.values()) {
					try {
						await store.close();
					} catch (error) {
						failures.push(error);
					}
				}
				try {
					await ledger.close();
				} catch (error) {
					failures.push(error);
				}
				try {
					const persistedEpoch = decodeEpochRecord(
						new TextDecoder().decode(await this.#fileSystem.readFile(epochPath)),
					);
					if (persistedEpoch.epoch !== epoch) {
						throw new Error(`Workspace process epoch ownership changed: ${this.#root}`);
					}
					await this.#fileSystem.removeFile(epochPath);
				} catch (error) {
					if (!isFileSystemError(error, "ENOENT")) failures.push(error);
				}
				this.#leased = false;
				if (failures.length === 1) throw failures[0];
				if (failures.length > 1) throw new AggregateError(failures, "Workspace persistence close failed");
			},
		} satisfies WorkspacePersistenceLease);
	}
}

export function createFileWorkspacePersistence(fileSystem: FileSystem, root: string): WorkspacePersistence {
	return new FileWorkspacePersistence(fileSystem, root);
}
