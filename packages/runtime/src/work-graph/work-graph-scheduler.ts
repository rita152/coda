import type { WorkAdmission } from "./ports.ts";
import type { WorkDiagnostic, WorkGraphId, WorkItemId, WorkItemState } from "./types.ts";
import { errorMessage, type GraphRecord, type ItemRecord, isTerminal } from "./work-graph-records.ts";

interface SchedulableCandidate {
	readonly kind: "delegation_resume" | "start";
	readonly graph: GraphRecord;
	readonly item: ItemRecord;
}

export interface WorkGraphSchedulerHost {
	ledgerFailure(): unknown;
	hasGraphFailure(graphId: WorkGraphId): boolean;
	processActiveConcurrency(): number;
	activate(graph: GraphRecord, item: ItemRecord): void;
	runItem(graph: GraphRecord, item: ItemRecord): Promise<void>;
	applyCancellation(graph: GraphRecord, targets: readonly ItemRecord[]): Promise<void>;
	transition(graph: GraphRecord, item: ItemRecord, to: WorkItemState): Promise<boolean>;
	finalizeWithoutRun(
		graph: GraphRecord,
		item: ItemRecord,
		terminal: "canceled" | "blocked" | "interrupted",
		blockedBy?: readonly WorkItemId[],
	): Promise<void>;
	trySettleGraph(graph: GraphRecord): Promise<void>;
	diagnose(diagnostic: WorkDiagnostic, graphId?: WorkGraphId, itemId?: WorkItemId): void;
}

export class WorkGraphScheduler {
	readonly #graphOrder: readonly GraphRecord[];
	readonly #admission: Pick<WorkAdmission, "select">;
	readonly #host: WorkGraphSchedulerHost;
	#scheduling = false;
	#scheduleAgain = false;

	constructor(input: {
		readonly graphOrder: readonly GraphRecord[];
		readonly admission: Pick<WorkAdmission, "select">;
		readonly host: WorkGraphSchedulerHost;
	}) {
		this.#graphOrder = input.graphOrder;
		this.#admission = input.admission;
		this.#host = input.host;
	}

	request(): void {
		if (this.#scheduling) {
			this.#scheduleAgain = true;
			return;
		}
		queueMicrotask(() => void this.#drain());
	}

	async applyWorkerCancellation(graph: GraphRecord, target?: ItemRecord): Promise<void> {
		const targets = graph.itemOrder.filter(
			(item) => !target || item.id === target.id || this.#isDescendant(graph, item, target.id),
		);
		await this.#host.applyCancellation(graph, targets);
	}

	async #drain(): Promise<void> {
		if (this.#scheduling) {
			this.#scheduleAgain = true;
			return;
		}
		this.#scheduling = true;
		try {
			do {
				this.#scheduleAgain = false;
				if (this.#host.ledgerFailure()) continue;
				await this.#refreshPendingStates();
				for (;;) {
					const selected = this.#admission.select<SchedulableCandidate>({
						activeProcessConcurrency: this.#host.processActiveConcurrency(),
						graphs: this.#graphOrder.map((graph) => ({
							graphId: graph.id,
							activeConcurrency: graph.activeConcurrency,
							maximumConcurrency: graph.maximumConcurrency,
							next: () => this.#nextSchedulableInGraph(graph),
						})),
					});
					if (!selected) break;
					if (selected.kind === "delegation_resume") {
						const pending = selected.item.delegationResume;
						if (!pending) continue;
						selected.item.delegationResume = undefined;
						selected.item.delegationWaiting = false;
						this.#host.activate(selected.graph, selected.item);
						pending.resolve();
						continue;
					}
					if (!(await this.#host.transition(selected.graph, selected.item, "preparing"))) continue;
					this.#host.activate(selected.graph, selected.item);
					void this.#host.runItem(selected.graph, selected.item).catch((error) => {
						this.#host.diagnose(
							{ code: "worker_lifecycle_failed", message: errorMessage(error) },
							selected.graph.id,
							selected.item.id,
						);
					});
					await this.#refreshPendingStates();
				}
			} while (this.#scheduleAgain);
		} catch (error) {
			this.#host.diagnose({ code: "scheduler_failed", message: errorMessage(error) });
		} finally {
			this.#scheduling = false;
			if (this.#scheduleAgain) this.request();
		}
	}

	#nextSchedulableInGraph(graph: GraphRecord): SchedulableCandidate | undefined {
		if (this.#host.ledgerFailure() || this.#host.hasGraphFailure(graph.id) || graph.result) return undefined;
		for (const item of graph.itemOrder) {
			if (item.delegationResume) return { kind: "delegation_resume", graph, item };
			if (item.state === "ready" && item.inputAdmissions.length === 0) return { kind: "start", graph, item };
		}
		return undefined;
	}

	async #refreshPendingStates(): Promise<void> {
		let changed = true;
		while (changed) {
			changed = false;
			for (const graph of this.#graphOrder) {
				if (graph.result) continue;
				for (const item of graph.itemOrder) {
					if (item.state !== "pending" && item.state !== "ready") continue;
					if (graph.cancellationRequested || item.cancellationRequested) {
						await this.#host.finalizeWithoutRun(graph, item, "canceled");
						changed = true;
						continue;
					}
					const blockedBy = item.dependencies.filter((dependencyId) => {
						const state = graph.items.get(dependencyId)?.state;
						return state !== undefined && isTerminal(state) && state !== "succeeded";
					});
					const parent = item.parentId ? graph.items.get(item.parentId) : undefined;
					if (parent && isTerminal(parent.state) && parent.state !== "succeeded") blockedBy.push(parent.id);
					if (blockedBy.length > 0) {
						await this.#host.finalizeWithoutRun(graph, item, "blocked", blockedBy);
						changed = true;
						continue;
					}
					if (item.state !== "pending") continue;
					const dependenciesSucceeded = item.dependencies.every(
						(dependencyId) => graph.items.get(dependencyId)?.state === "succeeded",
					);
					const parentPermits =
						!parent ||
						parent.state === "preparing" ||
						parent.state === "running" ||
						parent.state === "settling" ||
						parent.state === "succeeded";
					if (dependenciesSucceeded && parentPermits && item.inputAdmissions.length === 0) {
						await this.#host.transition(graph, item, "ready");
						changed = true;
					}
				}
				await this.#host.trySettleGraph(graph);
			}
		}
	}

	#isDescendant(graph: GraphRecord, candidate: ItemRecord, ancestorId: WorkItemId): boolean {
		let current = candidate.parentId;
		while (current) {
			if (current === ancestorId) return true;
			current = graph.items.get(current)?.parentId;
		}
		return false;
	}
}
