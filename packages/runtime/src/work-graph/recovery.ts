import type { DurableGraphStore } from "./durable-graph-store.ts";
import type {
	ObservationBus,
	RuntimeTime,
	WorkSessionReservation,
	WorkSessionStore,
	WorkspaceLedgerRestore,
	WorkspacePlacement,
	WorkspacePlacementReservation,
	WorkspaceSessionOwner,
} from "./ports.ts";
import type { SessionLeaseRegistry } from "./session-registry.ts";
import type { CodingAgentObservation, WorkGraphId, WorkItemId, WorkspaceArtifact } from "./types.ts";
import { WorkGraphAggregate } from "./work-graph-aggregate.ts";
import { WORK_GRAPH_FACT_VERSION } from "./work-graph-fact.ts";
import {
	errorMessage,
	type GraphRecord,
	type ItemRecord,
	isTerminal,
	type WorkGraphMirror,
} from "./work-graph-records.ts";

/** State-machine operations recovery may request after it has rebuilt durable ownership. */
export interface RecoveryProgressionHost {
	drainPendingInputAdmissions(item: ItemRecord): void;
	settleGraph(graph: GraphRecord): Promise<void>;
	schedule(): void;
}

export interface WorkGraphRecoveryOptions {
	readonly time: RuntimeTime;
	readonly placement: WorkspacePlacement;
	readonly sessions: WorkSessionStore;
	readonly durable: DurableGraphStore<GraphRecord>;
	readonly sessionRegistry: SessionLeaseRegistry;
	readonly observations: ObservationBus;
	readonly mirror: WorkGraphMirror;
	readonly graphs: Map<WorkGraphId, GraphRecord>;
	readonly graphOrder: GraphRecord[];
	readonly progression: RecoveryProgressionHost;
}

/** Owns durable replay, ownership reconciliation, and interrupted-run recovery. */
export class WorkGraphRecovery {
	readonly #options: WorkGraphRecoveryOptions;

	constructor(options: WorkGraphRecoveryOptions) {
		this.#options = options;
	}

	async initialize(): Promise<void> {
		try {
			await this.#initialize();
		} catch (error) {
			await this.#options.durable.abortInitialization();
			throw error;
		}
	}

	async #initialize(): Promise<void> {
		const ledgerRestore = await this.#options.durable.initialize();
		this.#options.sessionRegistry.hydrate(ledgerRestore.sessionOwners);
		for (const entry of [...ledgerRestore.activeGraphs].sort((left, right) => left.order - right.order)) {
			try {
				const restored = await this.#options.durable.loadGraph(entry.graphId);
				for (const diagnostic of restored.diagnostics) {
					this.#diagnose("work_graph_recovery", diagnostic, entry.graphId);
				}
				const aggregate = WorkGraphAggregate.replay(restored.facts);
				const graph = this.#options.mirror.restoreAggregate(aggregate);
				for (const item of graph.itemOrder) this.#options.progression.drainPendingInputAdmissions(item);
				if (graph.id !== entry.graphId || graph.order !== entry.order) {
					throw new Error(`Workspace Ledger index does not match Work Graph ${entry.graphId}`);
				}
				this.#options.graphs.set(graph.id, graph);
				this.#options.graphOrder.push(graph);
			} catch (error) {
				this.#options.durable.recordRecoveryFailure(entry.graphId, error);
				this.#diagnose("work_graph_recovery_failed", errorMessage(error).slice(0, 512), entry.graphId);
			}
		}
		if (this.#options.graphOrder.length === 0) return;

		const openPublications = new Set<string>();
		const publicationArtifacts = new Map<string, WorkspaceArtifact>();
		const settledTargetIdentities = new Map(
			ledgerRestore.targetIdentities.map(({ targetPlacementId, targetIdentity }) => [
				targetPlacementId,
				targetIdentity,
			]),
		);
		const resourceRecoveryFailures = new Map<string, string[]>();
		const itemKey = (graph: WorkGraphId, item: WorkItemId): string => `${graph}\0${item}`;
		const recordResourceFailure = (graph: WorkGraphId, item: WorkItemId, reason: string): void => {
			const key = itemKey(graph, item);
			const reasons = resourceRecoveryFailures.get(key) ?? [];
			reasons.push(reason);
			resourceRecoveryFailures.set(key, reasons);
		};
		for (const graph of this.#options.graphOrder) {
			const snapshot = graph.aggregate.snapshot().graph!;
			for (const aggregateItem of snapshot.items) {
				const key = itemKey(graph.id, aggregateItem.itemId);
				if (aggregateItem.publication?.phase === "started") {
					openPublications.add(key);
					publicationArtifacts.set(key, aggregateItem.publication.artifact);
				}
				if (aggregateItem.publication?.phase === "settled") {
					const publication = aggregateItem.publication.publication;
					if (
						(publication.state === "published" || publication.state === "not_required") &&
						publication.targetPlacementId &&
						publication.targetIdentity
					) {
						settledTargetIdentities.set(publication.targetPlacementId, publication.targetIdentity);
					}
				}
				for (const input of aggregateItem.inputs) {
					if (input.settlement === "pending") {
						recordResourceFailure(
							graph.id,
							aggregateItem.itemId,
							`input_resource_settlement_unknown:${input.deliveryId}`,
						);
					} else if (input.settlement === "failed") {
						recordResourceFailure(
							graph.id,
							aggregateItem.itemId,
							`input_resource_commit_failed:${input.diagnostic ?? input.deliveryId}`,
						);
					}
				}
			}
		}

		this.#options.graphOrder.sort((left, right) => left.order - right.order);
		this.#options.durable.nextGraphOrder = Math.max(
			this.#options.durable.nextGraphOrder,
			0,
			...this.#options.graphOrder.map((graph) => graph.order + 1),
		);
		for (const graph of this.#options.graphOrder) graph.itemOrder.sort((left, right) => left.order - right.order);
		this.#options.durable.nextPublicationOrder = Math.max(
			this.#options.durable.nextPublicationOrder,
			0,
			...this.#options.graphOrder.flatMap((graph) => graph.itemOrder.map((item) => item.publicationOrder + 1)),
		);
		await this.#reconcileWorkspaceSessionOwners(ledgerRestore);
		if (
			this.#options.durable.nextGraphOrder > ledgerRestore.nextGraphOrder ||
			this.#options.durable.nextPublicationOrder > ledgerRestore.nextPublicationOrder
		) {
			await this.#options.durable.accept({
				activeGraphs: [],
				nextGraphOrder: this.#options.durable.nextGraphOrder,
				nextPublicationOrder: this.#options.durable.nextPublicationOrder,
				sessionOwners: [],
			});
		}

		const uncertainPublicationTargets = new Set<string>();
		for (const graph of this.#options.graphOrder) {
			for (const item of graph.itemOrder) {
				if (!openPublications.has(itemKey(graph.id, item.id))) continue;
				const targetPlacementId = item.projection.placementDescriptor?.targetPlacementId;
				if (targetPlacementId) uncertainPublicationTargets.add(targetPlacementId);
			}
		}
		for (const graph of this.#options.graphOrder) {
			if (graph.result) {
				await this.#archiveDurableGraph(graph);
				continue;
			}
			for (const item of graph.itemOrder) {
				if (item.projection.result) continue;
				const key = itemKey(graph.id, item.id);
				const reasons: string[] = [];
				if (
					item.projection.state === "preparing" ||
					item.projection.state === "running" ||
					item.projection.state === "settling"
				) {
					reasons.push(`uncertain_${item.projection.state}`);
				}
				if (item.projection.factProjection.openAttempts.length > 0) reasons.push("unclosed_model_attempt");
				if (item.projection.factProjection.openTools.length > 0) reasons.push("unclosed_tool_invocation");
				if (openPublications.has(key)) reasons.push("unclosed_publication");
				const targetPlacementId = item.projection.placementDescriptor?.targetPlacementId;
				if (targetPlacementId && uncertainPublicationTargets.has(targetPlacementId)) {
					reasons.push("uncertain_publication_target");
				}
				reasons.push(...(resourceRecoveryFailures.get(key) ?? []));
				if (isTerminal(item.projection.state)) reasons.push("terminal_without_result");
				if (reasons.length > 0) {
					await this.#markRecoveredInterrupted(graph, item, reasons, publicationArtifacts.get(key));
					continue;
				}
				try {
					const expectedTargetIdentity = targetPlacementId
						? (settledTargetIdentities.get(targetPlacementId) ??
							item.projection.placementDescriptor?.targetIdentity)
						: undefined;
					await this.#recoverOwnership(graph, item, expectedTargetIdentity);
				} catch (error) {
					await this.#markRecoveredInterrupted(graph, item, ["ownership_recovery_failed", errorMessage(error)]);
				}
			}
			await this.#options.progression.settleGraph(graph);
		}
		this.#options.progression.schedule();
	}

	async #reconcileWorkspaceSessionOwners(ledgerRestore: WorkspaceLedgerRestore): Promise<void> {
		const durableOwners = new Map(ledgerRestore.sessionOwners.map((owner) => [owner.sessionId, owner]));
		for (const graph of this.#options.graphOrder) {
			if (graph.result) continue;
			const expectedOwners = new Map<string, WorkspaceSessionOwner>();
			for (const item of graph.itemOrder) {
				if (!item.projection.sessionId || item.projection.ownershipReleased) continue;
				expectedOwners.set(item.projection.sessionId, {
					sessionId: item.projection.sessionId,
					graphId: graph.id,
					itemId: item.id,
				});
			}
			for (const owner of ledgerRestore.sessionOwners.filter((candidate) => candidate.graphId === graph.id)) {
				if (expectedOwners.has(owner.sessionId)) continue;
				await this.#options.durable.releaseSession(owner);
				durableOwners.delete(owner.sessionId);
				const current = this.#options.sessionRegistry.owner(owner.sessionId);
				if (current?.graphId === owner.graphId && current.itemId === owner.itemId) {
					this.#options.sessionRegistry.release(owner.sessionId);
				}
			}
			const missing: WorkspaceSessionOwner[] = [];
			for (const owner of expectedOwners.values()) {
				const durable = durableOwners.get(owner.sessionId);
				if (durable && (durable.graphId !== owner.graphId || durable.itemId !== owner.itemId)) {
					throw new Error(`Workspace Ledger Session owner conflicts with active Work Graph: ${owner.sessionId}`);
				}
				if (!durable) missing.push(owner);
				this.#options.sessionRegistry.claim(owner.sessionId, owner.graphId, owner.itemId);
			}
			if (missing.length > 0) {
				await this.#options.durable.accept({
					activeGraphs: [],
					nextGraphOrder: this.#options.durable.nextGraphOrder,
					nextPublicationOrder: this.#options.durable.nextPublicationOrder,
					sessionOwners: missing,
				});
				for (const owner of missing) durableOwners.set(owner.sessionId, owner);
			}
		}
	}

	async #recoverOwnership(graph: GraphRecord, item: ItemRecord, expectedTargetIdentity?: string): Promise<void> {
		if (!item.projection.sessionId || !item.projection.placementDescriptor)
			throw new Error("Persisted Work ownership is incomplete");
		let placement: WorkspacePlacementReservation | undefined;
		let session: WorkSessionReservation | undefined;
		try {
			placement = await this.#options.placement.recover({
				graphId: graph.id,
				itemId: item.id,
				...(item.parentId ? { parentItemId: item.parentId } : {}),
				placement: item.projection.placementDescriptor,
				mode: item.executionMode,
				sourceOrder: item.order,
				publicationOrder: item.publicationOrder,
				...(expectedTargetIdentity ? { expectedTargetIdentity } : {}),
			});
			session = await this.#options.sessions.reserve({
				graphId: graph.id,
				itemId: item.id,
				...(item.parentId ? { parentItemId: item.parentId } : {}),
				target: { type: "resume", sessionId: item.projection.sessionId },
				placement: placement.placement,
			});
			if (String(session.session.id) !== item.projection.sessionId) {
				throw new Error(
					`Recovered Session identity changed from ${item.projection.sessionId} to ${String(session.session.id)}`,
				);
			}
			const currentOwner = this.#options.sessionRegistry.owner(item.projection.sessionId);
			if (currentOwner && (currentOwner.graphId !== graph.id || currentOwner.itemId !== item.id)) {
				throw new Error(`Recovered Session is already leased: ${item.projection.sessionId}`);
			}
			await placement.commit();
			await session.commit();
			item.process.placement = placement;
			item.process.session = session;
			this.#options.sessionRegistry.claim(item.projection.sessionId, graph.id, item.id);
		} catch (error) {
			try {
				await session?.rollback();
			} catch {}
			try {
				await placement?.rollback();
			} catch {}
			throw error;
		}
	}

	async #markRecoveredInterrupted(
		graph: GraphRecord,
		item: ItemRecord,
		reasons: readonly string[],
		artifact?: WorkspaceArtifact,
	): Promise<void> {
		const from = item.projection.state;
		await this.#options.durable.appendFacts(graph, [
			{
				version: WORK_GRAPH_FACT_VERSION,
				type: "recovery_interrupted",
				graphId: graph.id,
				itemId: item.id,
				timestamp: Math.max(this.#options.time.clock.now(), graph.aggregate.snapshot().lastTimestamp ?? 0),
				from,
				reasons: [...reasons],
				...(artifact ? { artifact } : {}),
			},
		]);
		item.process.resourcesReleased = true;
		const state = graph.aggregate.snapshot().graph!.items.find(({ itemId }) => itemId === item.id)!;
		this.#publish((sequence) => ({
			type: "item_state_changed",
			sequence,
			graphId: graph.id,
			itemId: item.id,
			from,
			to: "interrupted",
		}));
		this.#publish((sequence) => ({
			type: "work_item_settled",
			sequence,
			graphId: graph.id,
			result: state.result!,
		}));
	}

	async #archiveDurableGraph(graph: GraphRecord): Promise<void> {
		await this.#options.durable.archiveGraph(graph.id);
		this.#options.sessionRegistry.releaseGraph(graph.id);
	}

	#publish(factory: (sequence: number) => CodingAgentObservation): number {
		return this.#options.observations.publish(factory);
	}

	#diagnose(code: string, message: string, graphId?: WorkGraphId): void {
		this.#publish((sequence) => ({
			type: "diagnostic",
			sequence,
			diagnostic: { code, message },
			...(graphId ? { graphId } : {}),
		}));
	}
}
