import {
	decodeWorkGraphRestore,
	decodeWorkspaceLedger,
	emptyWorkspaceLedger,
	encodeWorkspaceLedger,
} from "./persistence-codec.ts";
import type {
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
import { type WorkGraphFact, WorkGraphFactCodec } from "./work-graph-fact.ts";

interface GraphMemory {
	readonly segments: WorkGraphFact[][];
	archived: boolean;
}

export interface MemoryWorkspacePersistenceSeed {
	readonly ledger?: WorkspaceLedgerRestore;
	readonly graphs?: ReadonlyMap<WorkGraphId, readonly WorkGraphFact[]>;
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function validatedLedger(state: WorkspaceLedgerRestore): WorkspaceLedgerRestore {
	return decodeWorkspaceLedger(encodeWorkspaceLedger(state));
}

class MemoryWorkGraphStore implements WorkGraphStore {
	readonly #graphId: WorkGraphId;
	readonly #memory: GraphMemory;
	readonly #readOnly: boolean;
	#closed = false;
	#failure?: unknown;
	#tail: Promise<void> = Promise.resolve();

	constructor(graphId: WorkGraphId, memory: GraphMemory, readOnly = false) {
		this.#graphId = graphId;
		this.#memory = memory;
		this.#readOnly = readOnly;
	}

	load() {
		if (this.#closed) return Promise.reject(new Error("Work Graph store is closed"));
		return Promise.resolve({
			restore: Object.freeze(clone(this.#memory.segments.flat())),
			diagnostics: Object.freeze([]),
		});
	}

	append(commit: unknown): Promise<void> {
		if (this.#readOnly) return Promise.reject(new Error("Historical Work Graph store is read-only"));
		if (this.#closed) return Promise.reject(new Error("Work Graph store is closed"));
		let durable: readonly WorkGraphFact[];
		try {
			durable = decodeWorkGraphRestore(commit);
		} catch (error) {
			return Promise.reject(error);
		}
		if (durable.length === 0) return Promise.reject(new Error("A Work Graph segment must contain Facts"));
		if (durable.some((fact) => fact.graphId !== this.#graphId)) {
			return Promise.reject(new Error(`Work Graph store ${this.#graphId} cannot append Facts for another Graph`));
		}
		const operation = this.#tail.then(() => {
			if (this.#failure) throw this.#failure;
			this.#memory.segments.push([...durable]);
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

	constructor(seed: MemoryWorkspacePersistenceSeed | readonly WorkGraphFact[] = {}) {
		if (Array.isArray(seed)) {
			const grouped = new Map<WorkGraphId, WorkGraphFact[]>();
			for (const fact of seed) {
				const durable = WorkGraphFactCodec.decode(fact);
				const facts = grouped.get(durable.graphId) ?? [];
				facts.push(durable);
				grouped.set(durable.graphId, facts);
			}
			const activeGraphs = [...grouped.keys()].map((graphId, order) => ({ graphId, order }));
			this.#state = Object.freeze({
				...emptyWorkspaceLedger(),
				activeGraphs: Object.freeze(activeGraphs),
				nextGraphOrder: activeGraphs.length,
			});
			for (const [graphId, facts] of grouped) {
				this.#graphs.set(graphId, { segments: facts.map((fact) => [fact]), archived: false });
			}
			return;
		}
		const configured = seed as MemoryWorkspacePersistenceSeed;
		this.#state = validatedLedger(configured.ledger ?? emptyWorkspaceLedger());
		for (const [graphId, facts] of configured.graphs ?? []) {
			this.#graphs.set(graphId, {
				segments: facts.map((fact) => [WorkGraphFactCodec.decode(fact)]),
				archived: false,
			});
		}
	}

	get facts(): readonly WorkGraphFact[] {
		return Object.freeze([
			...[...this.#graphs.values()].flatMap(({ segments }) => clone(segments.flat())),
			...[...this.#orphans.values()].flatMap((memories) =>
				memories.flatMap(({ segments }) => clone(segments.flat())),
			),
		]);
	}

	graphFacts(graphId: WorkGraphId): readonly WorkGraphFact[] {
		return Object.freeze(clone(this.#graphs.get(graphId)?.segments.flat() ?? []));
	}

	ledgerSnapshot(): WorkspaceLedgerRestore {
		return clone(this.#state);
	}

	async acquire(): Promise<WorkspacePersistenceLease> {
		if (this.#leased) throw new Error("Workspace persistence lease is already held");
		const active = new Set(this.#state.activeGraphs.map(({ graphId }) => graphId));
		for (const [graphId, memory] of this.#graphs) {
			if (active.has(graphId) || memory.archived || memory.segments.length === 0) continue;
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
			reserveOrders: async (request: { readonly graphCount: number; readonly publicationCount: number }) => {
				assertLedgerOpen();
				for (const [name, value] of Object.entries(request)) {
					if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
				}
				const graphOrderStart = this.#state.nextGraphOrder;
				const publicationOrderStart = this.#state.nextPublicationOrder;
				const nextGraphOrder = graphOrderStart + request.graphCount;
				const nextPublicationOrder = publicationOrderStart + request.publicationCount;
				if (!Number.isSafeInteger(nextGraphOrder) || !Number.isSafeInteger(nextPublicationOrder)) {
					throw new Error("Workspace order reservation exceeds the safe integer range");
				}
				this.#state = validatedLedger({ ...this.#state, nextGraphOrder, nextPublicationOrder });
				return { graphOrderStart, publicationOrderStart, nextGraphOrder, nextPublicationOrder };
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
				memory ??= { segments: [], archived: false };
				this.#graphs.set(graphId, memory);
				const store = new MemoryWorkGraphStore(graphId, memory);
				stores.set(graphId, store);
				return store;
			},
			openHistoricalGraph: async (graphId: WorkGraphId) => {
				if (closed) throw new Error("Workspace persistence lease is closed");
				const memory = this.#graphs.get(graphId);
				const orphan = this.#orphans.get(graphId)?.at(-1);
				const historical = memory?.archived ? memory : orphan;
				return historical ? new MemoryWorkGraphStore(graphId, historical, true) : undefined;
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
