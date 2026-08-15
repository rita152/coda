import type { WorkspaceTooling } from "./ports.ts";
import type {
	CodingAgentCloseResult,
	PublicationOutcome,
	WorkGraphId,
	WorkItemId,
	WorkResult,
	WorkspaceArtifact,
} from "./types.ts";
import {
	WorkGraphPersistenceController,
	type WorkGraphPersistenceHost,
	type WorkGraphPersistencePort,
} from "./work-graph-persistence.ts";
import type { GraphRecord, ItemRecord } from "./work-graph-records.ts";
import {
	WorkGraphSettlementController,
	type WorkGraphSettlementDurabilityPort,
	type WorkGraphSettlementHost,
	type WorkGraphSettlementPublicationPort,
	type WorkGraphSettlementWorkerPort,
} from "./work-graph-settlement.ts";

type WorkGraphLifecycleHost = Omit<WorkGraphPersistenceHost, "trySettleGraph"> &
	Omit<WorkGraphSettlementHost, "notifySettlementWaiters">;

/** Owns persistence failure handling and settlement as one Work Graph lifecycle. */
export class WorkGraphLifecycle {
	readonly #persistence: WorkGraphPersistenceController;
	readonly #settlement: WorkGraphSettlementController;

	constructor(input: {
		readonly graphs: ReadonlyMap<WorkGraphId, GraphRecord>;
		readonly graphOrder: readonly GraphRecord[];
		readonly durable: WorkGraphPersistencePort & WorkGraphSettlementDurabilityPort;
		readonly tooling: Pick<WorkspaceTooling, "quiesce" | "capture">;
		readonly worker: WorkGraphSettlementWorkerPort;
		readonly publication: WorkGraphSettlementPublicationPort;
		readonly host: WorkGraphLifecycleHost;
	}) {
		let settlement: WorkGraphSettlementController;
		this.#persistence = new WorkGraphPersistenceController({
			graphs: input.graphs,
			graphOrder: input.graphOrder,
			durable: input.durable,
			host: {
				now: input.host.now,
				applyWorkerCancellation: input.host.applyWorkerCancellation,
				interruptInMemory: input.host.interruptInMemory,
				settleAfterPersistenceFailure: input.host.settleAfterPersistenceFailure,
				trySettleGraph: (graph) => settlement.trySettleGraph(graph),
				diagnose: input.host.diagnose,
				publish: input.host.publish,
				requestSchedule: input.host.requestSchedule,
				closePlacement: input.host.closePlacement,
				closeObservations: input.host.closeObservations,
			},
		});
		settlement = new WorkGraphSettlementController({
			durable: input.durable,
			tooling: input.tooling,
			worker: input.worker,
			publication: input.publication,
			host: {
				now: input.host.now,
				graphMutation: input.host.graphMutation,
				appendGraphFacts: input.host.appendGraphFacts,
				archiveDurableGraph: input.host.archiveDurableGraph,
				transition: input.host.transition,
				interruptInMemory: input.host.interruptInMemory,
				afterItemTerminal: input.host.afterItemTerminal,
				publish: input.host.publish,
				notifySettlementWaiters: () => this.#persistence.notifySettlementWaiters(),
			},
		});
		this.#settlement = settlement;
	}

	get closed(): boolean {
		return this.#persistence.closed;
	}

	get closing(): boolean {
		return this.#persistence.closing;
	}

	trackSubmission<Result>(operation: Promise<Result>): Promise<Result> {
		return this.#persistence.trackSubmission(operation);
	}

	close(): Promise<CodingAgentCloseResult> {
		return this.#persistence.close();
	}

	failStopGraph(graphId: WorkGraphId, error: unknown): Promise<void> {
		return this.#persistence.failStopGraph(graphId, error);
	}

	failStopLedger(error: unknown): Promise<void> {
		return this.#persistence.failStopLedger(error);
	}

	reportDiagnostic(code: string, message: string, graphId?: WorkGraphId): void {
		this.#persistence.reportDiagnostic(code, message, graphId);
	}

	noteUndurable(graph: GraphRecord, item: ItemRecord): void {
		this.#persistence.noteUndurable(graph, item);
	}

	trySettleItem(graph: GraphRecord, item: ItemRecord): Promise<void> {
		return this.#settlement.trySettleItem(graph, item);
	}

	finalizeWithoutRun(
		graph: GraphRecord,
		item: ItemRecord,
		terminal: "canceled" | "blocked" | "interrupted",
		blockedBy: readonly WorkItemId[] = [],
	): Promise<void> {
		return this.#settlement.finalizeWithoutRun(graph, item, terminal, blockedBy);
	}

	makeResult(
		item: ItemRecord,
		state: WorkResult["state"],
		publication: PublicationOutcome,
		artifact?: WorkspaceArtifact,
		evidence?: WorkResult["evidence"],
		blockedBy: readonly WorkItemId[] = [],
		durability: WorkResult["durability"] = "confirmed",
	): WorkResult {
		return this.#settlement.makeResult(item, state, publication, artifact, evidence, blockedBy, durability);
	}

	trySettleGraph(graph: GraphRecord): Promise<void> {
		return this.#settlement.trySettleGraph(graph);
	}
}
