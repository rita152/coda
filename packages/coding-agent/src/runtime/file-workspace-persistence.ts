import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { WorkGraphId } from "@coda/runtime";
import {
	decodeWorkGraphEnvelope,
	decodeWorkspaceLedger,
	emptyWorkspaceLedger,
	encodeWorkGraphEnvelope,
	encodeWorkspaceLedger,
	type WorkGraphFact,
	type WorkGraphStore,
	type WorkGraphStoreRestore,
	type WorkspaceLedger,
	type WorkspaceLedgerAcceptance,
	type WorkspaceLedgerRestore,
	type WorkspacePersistence,
	type WorkspacePersistenceLease,
	type WorkspaceSessionOwner,
	type WorkspaceTargetIdentity,
} from "@coda/runtime/workspace-persistence";
import { type FileSystem, isFileSystemError, type WritableFile } from "../host/file-system.ts";

interface LeaseRecord {
	readonly version: 1;
	readonly epoch: string;
	readonly pid: number;
	readonly acquiredAt: string;
}

const LEASE_EPOCH_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function decodeLeaseRecord(source: string): LeaseRecord {
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
		throw new Error("Invalid Workspace process lease");
	}
	return value as LeaseRecord;
}

function ownerProcessIsDead(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return isFileSystemError(error, "ESRCH");
	}
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
	readonly #facts: WorkGraphFact[] = [];
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
			facts: Object.freeze(clone(this.#facts)),
			diagnostics: Object.freeze([...this.#diagnostics]),
		};
	}

	async append(facts: readonly WorkGraphFact[]): Promise<void> {
		if (this.#readOnly) throw new Error("Historical Work Graph store is read-only");
		if (this.#closed) throw new Error("Work Graph store is closed");
		await this.#ensureLoaded();
		const durable = clone([...facts]);
		encodeWorkGraphEnvelope(durable, 1);
		if (durable.some((fact) => fact.graphId !== this.#graphId)) {
			throw new Error(`Work Graph store ${this.#graphId} cannot append Facts for another Graph`);
		}
		await this.#enqueue(async () => {
			const sequence = this.#sequence + 1;
			const handle = await this.#fileHandle();
			await handle.write(`${encodeWorkGraphEnvelope(durable, sequence)}\n`);
			await handle.sync();
			this.#sequence = sequence;
			this.#facts.push(...durable);
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
		const facts: WorkGraphFact[] = [];
		let repaired = false;
		for (const [index, line] of lines.entries()) {
			try {
				const envelope = decodeWorkGraphEnvelope(line, index + 1);
				if (envelope.facts.some((fact) => fact.graphId !== this.#graphId)) {
					throw new Error(`Work Graph store ${this.#graphId} contains Facts for another Graph`);
				}
				facts.push(...envelope.facts);
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
		this.#facts.push(...facts);
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
	#state: WorkspaceLedgerRestore = emptyWorkspaceLedger();
	#loaded?: Promise<void>;
	#tail: Promise<void> = Promise.resolve();
	#failure?: unknown;
	#closed = false;

	constructor(fileSystem: FileSystem, path: string) {
		this.#fileSystem = fileSystem;
		this.#path = path;
	}

	async load(): Promise<WorkspaceLedgerRestore> {
		if (this.#closed) throw new Error("Workspace Ledger is closed");
		await this.#ensureLoaded();
		return clone(this.#state);
	}

	isActive(graphId: WorkGraphId): boolean {
		return this.#state.activeGraphs.some((entry) => entry.graphId === graphId);
	}

	accept(acceptance: WorkspaceLedgerAcceptance): Promise<void> {
		return this.#mutate((state) => {
			const active = new Map(state.activeGraphs.map((entry) => [entry.graphId, entry]));
			for (const entry of acceptance.activeGraphs) active.set(entry.graphId, clone(entry));
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
		try {
			this.#state = decodeWorkspaceLedger(new TextDecoder().decode(await this.#fileSystem.readFile(this.#path)));
		} catch (error) {
			if (!isFileSystemError(error, "ENOENT")) throw error;
			this.#state = emptyWorkspaceLedger();
		}
	}

	async #mutate(change: (state: WorkspaceLedgerRestore) => WorkspaceLedgerRestore): Promise<void> {
		if (this.#closed) throw new Error("Workspace Ledger is closed");
		await this.#ensureLoaded();
		const operation = this.#tail.then(async () => {
			if (this.#failure) throw this.#failure;
			const next = decodeWorkspaceLedger(encodeWorkspaceLedger(change(clone(this.#state))));
			try {
				await this.#replace(`${encodeWorkspaceLedger(next)}\n`);
				this.#state = next;
			} catch (error) {
				this.#failure ??= error;
				throw error;
			}
		});
		this.#tail = operation.then(
			() => undefined,
			() => undefined,
		);
		await operation;
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
		const leasePath = join(this.#root, "workspace.lease");
		let leaseHandle: WritableFile;
		const createLease = () => this.#fileSystem.open(leasePath, "wx", 0o600);
		try {
			leaseHandle = await createLease();
		} catch (error) {
			if (!isFileSystemError(error, "EEXIST")) throw error;
			const existing = decodeLeaseRecord(new TextDecoder().decode(await this.#fileSystem.readFile(leasePath)));
			if (!ownerProcessIsDead(existing.pid)) {
				throw new Error(`Workspace process lease is already held: ${this.#root}`, { cause: error });
			}
			await this.#fileSystem.rename(leasePath, `${leasePath}.stale-${existing.epoch}-${randomUUID()}`);
			try {
				leaseHandle = await createLease();
			} catch (retryError) {
				if (isFileSystemError(retryError, "EEXIST")) {
					throw new Error(`Workspace process lease is already held: ${this.#root}`, { cause: retryError });
				}
				throw retryError;
			}
		}
		const epoch = randomUUID();
		const leaseRecord: LeaseRecord = {
			version: 1,
			epoch,
			pid: process.pid,
			acquiredAt: new Date().toISOString(),
		};
		try {
			await leaseHandle.write(`${JSON.stringify(leaseRecord)}\n`);
			await leaseHandle.sync();
		} catch (error) {
			await leaseHandle.close().catch(() => undefined);
			await this.#fileSystem.removeFile(leasePath).catch(() => undefined);
			throw error;
		}
		const ledger = new FileWorkspaceLedger(this.#fileSystem, join(this.#root, "ledger.json"));
		const activeRoot = join(this.#root, "graphs", "active");
		const archiveRoot = join(this.#root, "graphs", "archive");
		const orphanRoot = join(this.#root, "graphs", "orphan");
		try {
			const restored = await ledger.load();
			await this.#fileSystem.makeDirectory(activeRoot, { recursive: true, mode: 0o700 });
			await this.#fileSystem.makeDirectory(archiveRoot, { recursive: true, mode: 0o700 });
			await this.#fileSystem.makeDirectory(orphanRoot, { recursive: true, mode: 0o700 });
			const indexedFiles = new Set(restored.activeGraphs.map(({ graphId }) => graphFileName(graphId)));
			for (const entry of await this.#fileSystem.readDirectory(activeRoot)) {
				if (entry.kind !== "file" || !entry.name.endsWith(".jsonl") || indexedFiles.has(entry.name)) continue;
				await this.#fileSystem.rename(
					join(activeRoot, entry.name),
					join(orphanRoot, `${entry.name}.orphan-${epoch}`),
				);
			}
		} catch (error) {
			await ledger.close().catch(() => undefined);
			await leaseHandle.close().catch(() => undefined);
			await this.#fileSystem.removeFile(leasePath).catch(() => undefined);
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
				if (await exists(this.#fileSystem, archivePath(graphId))) {
					throw new Error(`Work Graph is archived: ${graphId}`);
				}
				const store = new FileWorkGraphStore(this.#fileSystem, graphId, activePath(graphId), {
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
				if (!ledger.isActive(graphId) && (await exists(this.#fileSystem, unrelocated))) {
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
					await leaseHandle.close();
				} catch (error) {
					failures.push(error);
				}
				try {
					const persistedLease = decodeLeaseRecord(
						new TextDecoder().decode(await this.#fileSystem.readFile(leasePath)),
					);
					if (persistedLease.epoch !== epoch) {
						throw new Error(`Workspace process lease ownership changed: ${this.#root}`);
					}
					await this.#fileSystem.removeFile(leasePath);
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
