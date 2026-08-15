import type {
	CodingAgentCloseResult,
	CodingAgentObservation,
	WorkDiagnostic,
	WorkGraphId,
	WorkItemId,
} from "./types.ts";
import { WORK_GRAPH_FACT_VERSION, type WorkGraphFact } from "./work-graph-fact.ts";
import { errorMessage, type GraphRecord, type ItemRecord, immutableData, isTerminal } from "./work-graph-records.ts";
import { workerFactHasOpenEffects } from "./worker-fact.ts";

export interface WorkGraphPersistencePort {
	readonly ledgerFailure: unknown;
	hasGraphFailure(graphId: WorkGraphId): boolean;
	graphFailure(graphId: WorkGraphId): unknown;
	waitForFailStops(): Promise<void>;
	mutation<Result>(graphId: WorkGraphId, operation: () => Promise<Result> | Result): Promise<Result>;
	appendFacts(graph: GraphRecord, facts: readonly WorkGraphFact[]): Promise<void>;
	flush(): Promise<readonly unknown[]>;
	close(): Promise<readonly unknown[]>;
}

export interface WorkGraphPersistenceHost {
	now(): number;
	applyWorkerCancellation(graph: GraphRecord): Promise<void>;
	interruptInMemory(graph: GraphRecord, item: ItemRecord, error: unknown): Promise<void>;
	settleAfterPersistenceFailure(graph: GraphRecord, item: ItemRecord): Promise<void>;
	trySettleGraph(graph: GraphRecord): Promise<void>;
	diagnose(diagnostic: WorkDiagnostic, graphId?: WorkGraphId, itemId?: WorkItemId): void;
	publish(factory: (sequence: number) => CodingAgentObservation): number;
	requestSchedule(): void;
	closePlacement(): Promise<void>;
	closeObservations(): void;
}

export class WorkGraphPersistenceController {
	readonly #graphs: ReadonlyMap<WorkGraphId, GraphRecord>;
	readonly #graphOrder: readonly GraphRecord[];
	readonly #durable: WorkGraphPersistencePort;
	readonly #host: WorkGraphPersistenceHost;
	readonly #submissions = new Set<Promise<unknown>>();
	readonly #undurableWork = new Map<string, CodingAgentCloseResult["unknownWork"][number]>();
	readonly #settlementWaiters: Array<() => void> = [];
	#closed = false;
	#closing = false;
	#closeOperation?: Promise<CodingAgentCloseResult>;

	constructor(input: {
		readonly graphs: ReadonlyMap<WorkGraphId, GraphRecord>;
		readonly graphOrder: readonly GraphRecord[];
		readonly durable: WorkGraphPersistencePort;
		readonly host: WorkGraphPersistenceHost;
	}) {
		this.#graphs = input.graphs;
		this.#graphOrder = input.graphOrder;
		this.#durable = input.durable;
		this.#host = input.host;
	}

	get closed(): boolean {
		return this.#closed;
	}

	get closing(): boolean {
		return this.#closing;
	}

	trackSubmission<Result>(operation: Promise<Result>): Promise<Result> {
		this.#submissions.add(operation);
		void operation.then(
			() => this.#submissions.delete(operation),
			() => this.#submissions.delete(operation),
		);
		return operation;
	}

	close(): Promise<CodingAgentCloseResult> {
		if (this.#closeOperation) return this.#closeOperation;
		this.#closing = true;
		const operation = this.#performClose();
		this.#closeOperation = operation;
		return operation;
	}

	async failStopGraph(graphId: WorkGraphId, error: unknown): Promise<void> {
		const graph = this.#graphs.get(graphId);
		if (!graph) return;
		this.#interruptGraphForPersistence(graph, error);
		await this.#settleUnstartedAfterPersistenceFailure([graph]);
	}

	async failStopLedger(error: unknown): Promise<void> {
		for (const graph of this.#graphOrder) this.#interruptGraphForPersistence(graph, error);
		await this.#settleUnstartedAfterPersistenceFailure(this.#graphOrder);
	}

	reportDiagnostic(code: string, message: string, graphId?: WorkGraphId): void {
		this.#host.diagnose({ code, message }, graphId);
	}

	noteUndurable(graph: GraphRecord, item: ItemRecord): void {
		if (item.projection.result) return;
		this.#undurableWork.set(`${graph.id}\0${item.id}`, {
			graphId: graph.id,
			itemId: item.id,
			phase: isTerminal(item.projection.state) ? "result" : item.projection.state,
		});
	}

	notifySettlementWaiters(): void {
		if (!this.#graphOrder.every((graph) => graph.result)) return;
		for (const resolve of this.#settlementWaiters.splice(0)) resolve();
	}

	#interruptGraphForPersistence(graph: GraphRecord, error: unknown): void {
		for (const item of graph.itemOrder) {
			if (item.projection.result) continue;
			this.noteUndurable(graph, item);
			if (isTerminal(item.projection.state)) continue;
			if (workerFactHasOpenEffects(item.projection.factProjection)) item.process.uncertainExternalEffect = true;
			item.process.controller?.abort(error);
			item.process.delegationResume?.reject(error);
			item.process.delegationResume = undefined;
			item.process.delegationWaiting = false;
			try {
				item.process.runtime?.cancel();
			} catch {}
		}
	}

	async #settleUnstartedAfterPersistenceFailure(graphs: readonly GraphRecord[]): Promise<void> {
		await Promise.resolve();
		for (const graph of graphs) {
			for (const item of graph.itemOrder) {
				if (item.projection.state !== "pending" && item.projection.state !== "ready") continue;
				await this.#host.settleAfterPersistenceFailure(graph, item);
			}
			await this.#host.trySettleGraph(graph);
		}
	}

	async #performClose(): Promise<CodingAgentCloseResult> {
		while (this.#submissions.size > 0) await Promise.allSettled([...this.#submissions]);
		await this.#durable.waitForFailStops();
		const canceledGraphIds = this.#graphOrder.filter((graph) => !graph.result).map((graph) => graph.id);
		for (const graph of this.#graphOrder) {
			if (graph.result) continue;
			if (this.#durable.hasGraphFailure(graph.id) || this.#durable.ledgerFailure) {
				for (const item of graph.itemOrder) {
					if (!isTerminal(item.projection.state))
						await this.#host.interruptInMemory(graph, item, this.#durable.graphFailure(graph.id));
				}
				continue;
			}
			try {
				await this.#durable.mutation(graph.id, async () => {
					await this.#durable.appendFacts(graph, [
						{
							version: WORK_GRAPH_FACT_VERSION,
							type: "cancellation_requested",
							graphId: graph.id,
							timestamp: Math.max(this.#host.now(), graph.aggregate.snapshot().lastTimestamp ?? 0),
							batchId: "batch:close",
							target: { type: "graph" },
						},
					]);
				});
				await this.#host.applyWorkerCancellation(graph);
			} catch (error) {
				this.#host.diagnose({ code: "close_cancellation_failed", message: errorMessage(error) }, graph.id);
				for (const item of graph.itemOrder) {
					if (!isTerminal(item.projection.state)) await this.#host.interruptInMemory(graph, item, error);
				}
			}
		}
		this.#host.requestSchedule();
		await this.#waitForGraphSettlement();
		const droppedInputs = this.#graphOrder.reduce(
			(total, graph) =>
				total +
				graph.itemOrder.reduce(
					(count, item) =>
						count +
						item.process.droppedInputs +
						item.process.pendingInputs.length +
						(item.process.promptInput ? 1 : 0),
					0,
				),
			0,
		);
		const unsettledWork = this.#graphOrder.flatMap((graph) =>
			graph.itemOrder.flatMap((item) => {
				if (
					item.projection.state !== "preparing" &&
					item.projection.state !== "running" &&
					item.projection.state !== "settling"
				)
					return [];
				return [{ graphId: graph.id, itemId: item.id, phase: item.projection.state } as const];
			}),
		);
		const unknownWork = [
			...this.#undurableWork.values(),
			...unsettledWork.filter((candidate) => !this.#undurableWork.has(`${candidate.graphId}\0${candidate.itemId}`)),
		];
		const result: CodingAgentCloseResult = immutableData({ canceledGraphIds, droppedInputs, unknownWork });
		const failures: unknown[] = [...(await this.#durable.flush())];
		try {
			await this.#host.closePlacement();
		} catch (error) {
			failures.push(error);
		}
		failures.push(...(await this.#durable.close()));
		this.#closed = true;
		this.#host.publish((sequence) => ({ type: "closed", sequence, result }));
		this.#host.closeObservations();
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1) throw new AggregateError(failures, "Coding Agent close failed");
		return result;
	}

	#waitForGraphSettlement(): Promise<void> {
		if (this.#graphOrder.every((graph) => graph.result)) return Promise.resolve();
		return new Promise((resolve) => this.#settlementWaiters.push(resolve));
	}
}
