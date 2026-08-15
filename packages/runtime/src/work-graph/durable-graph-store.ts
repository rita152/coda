import { decodeWorkGraphRestore } from "./persistence-codec.ts";
import type {
	WorkGraphStore,
	WorkspaceLedger,
	WorkspaceLedgerAcceptance,
	WorkspaceLedgerRestore,
	WorkspacePersistence,
	WorkspacePersistenceLease,
	WorkspaceSessionOwner,
} from "./ports.ts";
import type { WorkGraphId } from "./types.ts";
import type { WorkGraphAggregate } from "./work-graph-aggregate.ts";
import type { WorkGraphFact } from "./work-graph-fact.ts";

class MutationFence {
	#tail: Promise<void> = Promise.resolve();

	async run<T>(operation: () => Promise<T> | T): Promise<T> {
		let release!: () => void;
		const turn = new Promise<void>((resolve) => {
			release = resolve;
		});
		const previous = this.#tail;
		this.#tail = previous.then(() => turn);
		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	}
}

export interface DurableGraphProjection {
	readonly id: WorkGraphId;
	aggregate: WorkGraphAggregate;
}

export interface DurableGraphRestore {
	readonly facts: readonly WorkGraphFact[];
	readonly diagnostics: readonly string[];
}

export interface DurableGraphStoreHost<TGraph extends DurableGraphProjection> {
	readonly projectGraph: (graph: TGraph) => void;
	readonly onGraphFailStop: (graphId: WorkGraphId, error: unknown) => Promise<void> | void;
	readonly onLedgerFailStop: (error: unknown) => Promise<void> | void;
	readonly diagnose: (code: string, message: string, graphId?: WorkGraphId) => void;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Owns durable write ordering, persistence failures, graph fences, and Workspace watermarks. */
export class DurableGraphStore<TGraph extends DurableGraphProjection> {
	readonly #persistence: WorkspacePersistence;
	readonly #host: DurableGraphStoreHost<TGraph>;
	#lease?: WorkspacePersistenceLease;
	#ledger?: WorkspaceLedger;
	readonly #stores = new Map<WorkGraphId, WorkGraphStore>();
	readonly #graphFailures = new Map<WorkGraphId, unknown>();
	readonly #graphFailStops = new Map<WorkGraphId, Promise<void>>();
	readonly #fences = new Map<WorkGraphId, MutationFence>();
	#ledgerFailure?: unknown;
	#ledgerFailStop?: Promise<void>;
	#nextGraphOrder = 0;
	#nextPublicationOrder = 0;

	constructor(persistence: WorkspacePersistence, host: DurableGraphStoreHost<TGraph>) {
		this.#persistence = persistence;
		this.#host = host;
	}

	get ledgerFailure(): unknown {
		return this.#ledgerFailure;
	}

	get nextGraphOrder(): number {
		return this.#nextGraphOrder;
	}

	set nextGraphOrder(value: number) {
		this.#nextGraphOrder = value;
	}

	get nextPublicationOrder(): number {
		return this.#nextPublicationOrder;
	}

	set nextPublicationOrder(value: number) {
		this.#nextPublicationOrder = value;
	}

	allocateGraphOrder(): number {
		return this.#nextGraphOrder++;
	}

	allocatePublicationOrder(): number {
		return this.#nextPublicationOrder++;
	}

	async initialize(): Promise<WorkspaceLedgerRestore> {
		const lease = await this.#persistence.acquire();
		this.#lease = lease;
		this.#ledger = lease.ledger;
		try {
			const restore = await lease.ledger.load();
			this.#nextGraphOrder = restore.nextGraphOrder;
			this.#nextPublicationOrder = restore.nextPublicationOrder;
			return restore;
		} catch (error) {
			await lease.close().catch(() => undefined);
			this.#lease = undefined;
			this.#ledger = undefined;
			throw error;
		}
	}

	async abortInitialization(): Promise<void> {
		await this.#lease?.close().catch(() => undefined);
		this.#lease = undefined;
		this.#ledger = undefined;
	}

	async loadGraph(graphId: WorkGraphId): Promise<DurableGraphRestore> {
		const store = await this.#openGraph(graphId);
		const restored = await store.load();
		return { facts: decodeWorkGraphRestore(restored.restore), diagnostics: restored.diagnostics };
	}

	recordRecoveryFailure(graphId: WorkGraphId, error: unknown): void {
		this.#graphFailures.set(graphId, error);
	}

	graphFailure(graphId: WorkGraphId): unknown {
		return this.#graphFailures.get(graphId);
	}

	hasGraphFailure(graphId: WorkGraphId): boolean {
		return this.#graphFailures.has(graphId);
	}

	mutation<Result>(graphId: WorkGraphId, operation: () => Promise<Result> | Result): Promise<Result> {
		let fence = this.#fences.get(graphId);
		if (!fence) {
			fence = new MutationFence();
			this.#fences.set(graphId, fence);
		}
		return fence.run(operation);
	}

	async appendFacts(graph: TGraph, facts: readonly WorkGraphFact[]): Promise<void> {
		if (facts.length === 0) throw new Error("A Work Graph segment must contain Facts");
		if (facts.some(({ graphId }) => graphId !== graph.id)) {
			throw new Error(`A Work Graph segment cannot cross Graph ${graph.id}`);
		}
		let aggregate = graph.aggregate;
		for (const fact of facts) aggregate = aggregate.apply(fact);
		const failure = this.#graphFailures.get(graph.id);
		if (failure) throw failure;
		try {
			await (await this.#openGraph(graph.id)).append(facts);
			graph.aggregate = aggregate;
			this.#host.projectGraph(graph);
		} catch (error) {
			this.latchGraphFailure(graph.id, error);
			throw error;
		}
	}

	flushGraph(graphId: WorkGraphId): Promise<void> {
		const store = this.#stores.get(graphId);
		if (!store) throw new Error(`Work Graph store is not open: ${graphId}`);
		return store.flush();
	}

	async accept(acceptance: WorkspaceLedgerAcceptance): Promise<void> {
		const ledger = this.#ledger;
		if (!ledger) throw new Error("Workspace Ledger is not open");
		if (this.#ledgerFailure) throw this.#ledgerFailure;
		try {
			await ledger.accept(acceptance);
		} catch (error) {
			this.latchLedgerFailure(error);
			throw error;
		}
	}

	async releaseSession(owner: WorkspaceSessionOwner): Promise<void> {
		try {
			await this.#ledger?.releaseSession(owner);
		} catch (error) {
			this.latchLedgerFailure(error);
			throw error;
		}
	}

	async recordTargetIdentity(targetPlacementId: string, targetIdentity: string): Promise<void> {
		try {
			await this.#ledger?.recordTargetIdentity({ targetPlacementId, targetIdentity });
		} catch (error) {
			this.latchLedgerFailure(error);
			throw error;
		}
	}

	async archiveGraph(graphId: WorkGraphId): Promise<void> {
		const ledger = this.#ledger;
		if (!ledger) throw new Error("Workspace Ledger is not open");
		try {
			await ledger.archiveGraph(graphId);
		} catch (error) {
			this.latchLedgerFailure(error);
			throw error;
		}
		try {
			await this.#lease?.archiveGraph(graphId);
			this.#stores.delete(graphId);
		} catch (error) {
			this.#host.diagnose("work_graph_archive_failed", errorMessage(error).slice(0, 512), graphId);
		}
	}

	latchGraphFailure(graphId: WorkGraphId, error: unknown): void {
		if (this.#graphFailures.has(graphId)) return;
		this.#graphFailures.set(graphId, error);
		this.#host.diagnose("work_graph_persistence_failed", errorMessage(error).slice(0, 512), graphId);
		const failStop = Promise.resolve(this.#host.onGraphFailStop(graphId, error)).catch((settlementError) => {
			this.#host.diagnose(
				"work_graph_fail_stop_settlement_failed",
				errorMessage(settlementError).slice(0, 512),
				graphId,
			);
		});
		this.#graphFailStops.set(graphId, failStop);
	}

	latchLedgerFailure(error: unknown): void {
		if (this.#ledgerFailure) return;
		this.#ledgerFailure = error;
		this.#host.diagnose("workspace_ledger_persistence_failed", errorMessage(error).slice(0, 512));
		this.#ledgerFailStop = Promise.resolve(this.#host.onLedgerFailStop(error)).catch((settlementError) => {
			this.#host.diagnose("ledger_fail_stop_settlement_failed", errorMessage(settlementError).slice(0, 512));
		});
	}

	assertProgressAllowed(graphId: WorkGraphId): void {
		if (this.#ledgerFailure) {
			throw new Error(`Workspace Ledger persistence is unavailable: ${errorMessage(this.#ledgerFailure)}`);
		}
		const graphFailure = this.#graphFailures.get(graphId);
		if (graphFailure) throw new Error(`Work Graph persistence is unavailable: ${errorMessage(graphFailure)}`);
	}

	async waitForFailStops(): Promise<void> {
		await this.#ledgerFailStop;
		await Promise.all(this.#graphFailStops.values());
	}

	async flush(): Promise<readonly unknown[]> {
		const failures: unknown[] = [];
		if (!this.#ledgerFailure) {
			try {
				await this.#ledger?.flush();
			} catch (error) {
				failures.push(error);
			}
		}
		for (const [graphId, store] of this.#stores) {
			if (this.#graphFailures.has(graphId)) continue;
			try {
				await store.flush();
			} catch (error) {
				failures.push(error);
			}
		}
		return failures;
	}

	async close(): Promise<readonly unknown[]> {
		try {
			await this.#lease?.close();
			return [];
		} catch (error) {
			return !this.#ledgerFailure && this.#graphFailures.size === 0 ? [error] : [];
		}
	}

	async #openGraph(graphId: WorkGraphId): Promise<WorkGraphStore> {
		const current = this.#stores.get(graphId);
		if (current) return current;
		const lease = this.#lease;
		if (!lease) throw new Error("Workspace persistence lease is not open");
		const store = await lease.openGraph(graphId);
		this.#stores.set(graphId, store);
		return store;
	}
}
