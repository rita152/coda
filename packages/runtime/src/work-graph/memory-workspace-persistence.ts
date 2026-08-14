import { decodeWorkspaceLedger, emptyWorkspaceLedger, encodeWorkspaceLedger } from "./persistence-codec.ts";
import type {
	WorkGraphRecord,
	WorkGraphStore,
	WorkspaceLedger,
	WorkspaceLedgerAcceptance,
	WorkspaceLedgerRestore,
	WorkspacePersistence,
	WorkspacePersistenceLease,
	WorkspaceSessionOwner,
	WorkspaceTargetIdentity,
} from "./ports.ts";
import type { WorkGraphId } from "./types.ts";

interface GraphMemory {
	readonly records: WorkGraphRecord[];
	archived: boolean;
}

export interface MemoryWorkspacePersistenceSeed {
	readonly ledger?: WorkspaceLedgerRestore;
	readonly graphs?: ReadonlyMap<WorkGraphId, readonly WorkGraphRecord[]>;
}

function recordGraphId(record: WorkGraphRecord): WorkGraphId {
	if (record.type !== "batch_accepted") return record.graphId;
	const payload = record.payload;
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		throw new Error("Memory Work Graph batch has no Graph identity");
	}
	const graphs = Array.isArray(payload.graphs) ? payload.graphs : [];
	const items = Array.isArray(payload.items) ? payload.items : [];
	const candidate = graphs[0] ?? items[0];
	if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
		throw new Error("Memory Work Graph batch has no Graph identity");
	}
	const graphId = candidate.graphId;
	if (typeof graphId !== "string") throw new Error("Memory Work Graph batch has an invalid Graph identity");
	return graphId as WorkGraphId;
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function validatedLedger(state: WorkspaceLedgerRestore): WorkspaceLedgerRestore {
	return decodeWorkspaceLedger(encodeWorkspaceLedger(state));
}

class MemoryWorkGraphStore implements WorkGraphStore {
	readonly #memory: GraphMemory;
	readonly #readOnly: boolean;
	#closed = false;
	#failure?: unknown;
	#tail: Promise<void> = Promise.resolve();

	constructor(memory: GraphMemory, readOnly = false) {
		this.#memory = memory;
		this.#readOnly = readOnly;
	}

	load() {
		if (this.#closed) return Promise.reject(new Error("Work Graph store is closed"));
		return Promise.resolve({ records: Object.freeze(clone(this.#memory.records)), diagnostics: Object.freeze([]) });
	}

	append(record: WorkGraphRecord): Promise<void> {
		if (this.#readOnly) return Promise.reject(new Error("Historical Work Graph store is read-only"));
		if (this.#closed) return Promise.reject(new Error("Work Graph store is closed"));
		const durable = clone(record);
		const operation = this.#tail.then(() => {
			if (this.#failure) throw this.#failure;
			this.#memory.records.push(durable);
		});
		this.#tail = operation.catch((error) => {
			this.#failure ??= error;
		});
		return operation;
	}

	async flush(): Promise<void> {
		if (this.#closed) throw new Error("Work Graph store is closed");
		await this.#tail;
		if (this.#failure) throw this.#failure;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#tail;
		if (this.#failure) throw this.#failure;
	}
}

export class MemoryWorkspacePersistence implements WorkspacePersistence {
	readonly #graphs = new Map<WorkGraphId, GraphMemory>();
	readonly #orphans = new Map<WorkGraphId, GraphMemory[]>();
	#state: WorkspaceLedgerRestore;
	#leased = false;
	#nextEpoch = 0;

	constructor(seed: MemoryWorkspacePersistenceSeed | readonly WorkGraphRecord[] = {}) {
		if (Array.isArray(seed)) {
			const grouped = new Map<WorkGraphId, WorkGraphRecord[]>();
			for (const record of seed) {
				const graphId = recordGraphId(record);
				const records = grouped.get(graphId) ?? [];
				records.push(clone(record));
				grouped.set(graphId, records);
			}
			const activeGraphs = [...grouped.keys()].map((graphId, order) => ({ graphId, order }));
			this.#state = Object.freeze({
				...emptyWorkspaceLedger(),
				activeGraphs: Object.freeze(activeGraphs),
				nextGraphOrder: activeGraphs.length,
			});
			for (const [graphId, records] of grouped) {
				this.#graphs.set(graphId, { records, archived: false });
			}
			return;
		}
		const configured = seed as MemoryWorkspacePersistenceSeed;
		this.#state = validatedLedger(configured.ledger ?? emptyWorkspaceLedger());
		for (const [graphId, records] of configured.graphs ?? []) {
			this.#graphs.set(graphId, { records: clone([...records]), archived: false });
		}
	}

	get records(): readonly WorkGraphRecord[] {
		return Object.freeze([
			...[...this.#graphs.values()].flatMap(({ records }) => clone(records)),
			...[...this.#orphans.values()].flatMap((memories) => memories.flatMap(({ records }) => clone(records))),
		]);
	}

	graphRecords(graphId: WorkGraphId): readonly WorkGraphRecord[] {
		return Object.freeze(clone(this.#graphs.get(graphId)?.records ?? []));
	}

	ledgerSnapshot(): WorkspaceLedgerRestore {
		return clone(this.#state);
	}

	async acquire(): Promise<WorkspacePersistenceLease> {
		if (this.#leased) throw new Error("Workspace persistence lease is already held");
		const active = new Set(this.#state.activeGraphs.map(({ graphId }) => graphId));
		for (const [graphId, memory] of this.#graphs) {
			if (active.has(graphId) || memory.archived || memory.records.length === 0) continue;
			memory.archived = true;
			const orphans = this.#orphans.get(graphId) ?? [];
			orphans.push(memory);
			this.#orphans.set(graphId, orphans);
			this.#graphs.delete(graphId);
		}
		this.#leased = true;
		const epoch = `memory-workspace:${++this.#nextEpoch}`;
		const stores = new Map<WorkGraphId, MemoryWorkGraphStore>();
		let closed = false;
		let ledgerClosed = false;
		const assertLedgerOpen = () => {
			if (ledgerClosed || closed) throw new Error("Workspace Ledger is closed");
		};
		const ledger: WorkspaceLedger = Object.freeze({
			load: async () => {
				assertLedgerOpen();
				return clone(this.#state);
			},
			accept: async (acceptance: WorkspaceLedgerAcceptance) => {
				assertLedgerOpen();
				const active = new Map(this.#state.activeGraphs.map((entry) => [entry.graphId, entry]));
				for (const entry of acceptance.activeGraphs) active.set(entry.graphId, clone(entry));
				const owners = new Map(this.#state.sessionOwners.map((owner) => [owner.sessionId, owner]));
				for (const owner of acceptance.sessionOwners) {
					const existing = owners.get(owner.sessionId);
					if (existing && (existing.graphId !== owner.graphId || existing.itemId !== owner.itemId)) {
						throw new Error(`Session is already owned: ${owner.sessionId}`);
					}
					owners.set(owner.sessionId, clone(owner));
				}
				this.#state = validatedLedger({
					activeGraphs: [...active.values()].sort((left, right) => left.order - right.order),
					nextGraphOrder: Math.max(this.#state.nextGraphOrder, acceptance.nextGraphOrder),
					nextPublicationOrder: Math.max(this.#state.nextPublicationOrder, acceptance.nextPublicationOrder),
					sessionOwners: [...owners.values()],
					targetIdentities: this.#state.targetIdentities,
					diagnostics: [],
				});
			},
			releaseSession: async (owner: WorkspaceSessionOwner) => {
				assertLedgerOpen();
				this.#state = validatedLedger({
					...this.#state,
					sessionOwners: this.#state.sessionOwners.filter(
						(candidate) =>
							candidate.sessionId !== owner.sessionId ||
							candidate.graphId !== owner.graphId ||
							candidate.itemId !== owner.itemId,
					),
				});
			},
			recordTargetIdentity: async (identity: WorkspaceTargetIdentity) => {
				assertLedgerOpen();
				const identities = new Map(
					this.#state.targetIdentities.map((candidate) => [candidate.targetPlacementId, candidate]),
				);
				identities.set(identity.targetPlacementId, clone(identity));
				this.#state = validatedLedger({
					...this.#state,
					targetIdentities: [...identities.values()],
				});
			},
			archiveGraph: async (graphId: WorkGraphId) => {
				assertLedgerOpen();
				this.#state = validatedLedger({
					...this.#state,
					activeGraphs: this.#state.activeGraphs.filter((entry) => entry.graphId !== graphId),
					sessionOwners: this.#state.sessionOwners.filter((owner) => owner.graphId !== graphId),
				});
			},
			flush: async () => assertLedgerOpen(),
			close: async () => {
				ledgerClosed = true;
			},
		});
		const lease: WorkspacePersistenceLease = Object.freeze({
			epoch,
			ledger,
			openGraph: async (graphId: WorkGraphId) => {
				if (closed) throw new Error("Workspace persistence lease is closed");
				const current = stores.get(graphId);
				if (current) return current;
				let memory = this.#graphs.get(graphId);
				if (memory?.archived) throw new Error(`Work Graph is archived: ${graphId}`);
				memory ??= { records: [], archived: false };
				this.#graphs.set(graphId, memory);
				const store = new MemoryWorkGraphStore(memory);
				stores.set(graphId, store);
				return store;
			},
			openHistoricalGraph: async (graphId: WorkGraphId) => {
				if (closed) throw new Error("Workspace persistence lease is closed");
				const memory = this.#graphs.get(graphId);
				const orphan = this.#orphans.get(graphId)?.at(-1);
				const historical = memory?.archived ? memory : orphan;
				return historical ? new MemoryWorkGraphStore(historical, true) : undefined;
			},
			archiveGraph: async (graphId: WorkGraphId) => {
				if (closed) throw new Error("Workspace persistence lease is closed");
				await stores.get(graphId)?.close();
				stores.delete(graphId);
				const memory = this.#graphs.get(graphId);
				if (memory) memory.archived = true;
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
				this.#leased = false;
				if (failures.length === 1) throw failures[0];
				if (failures.length > 1) throw new AggregateError(failures, "Workspace persistence close failed");
			},
		});
		return lease;
	}
}
