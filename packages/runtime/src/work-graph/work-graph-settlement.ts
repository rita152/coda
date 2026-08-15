import type { WorkspaceTooling } from "./ports.ts";
import type {
	CodingAgentObservation,
	PublicationOutcome,
	WorkBudgetUsage,
	WorkDiagnostic,
	WorkGraphId,
	WorkGraphOutcome,
	WorkGraphResult,
	WorkItemId,
	WorkItemState,
	WorkResult,
	WorkRunResult,
	WorkspaceArtifact,
	WorkspacePlacementDescriptor,
} from "./types.ts";
import { WORK_GRAPH_FACT_VERSION, type WorkGraphFact } from "./work-graph-fact.ts";
import { errorMessage, type GraphRecord, type ItemRecord, immutableData, isTerminal } from "./work-graph-records.ts";
import { workerFactHasOpenEffects } from "./worker-fact.ts";

export interface WorkGraphSettlementDurabilityPort {
	readonly ledgerFailure: unknown;
	hasGraphFailure(graphId: WorkGraphId): boolean;
}

export interface WorkGraphSettlementWorkerPort {
	teardown(item: ItemRecord): Promise<boolean>;
	deactivate(graph: GraphRecord, item: ItemRecord): void;
	releaseResources(graph: GraphRecord, item: ItemRecord, preserve: boolean): Promise<void>;
}

export interface WorkGraphSettlementPublicationPort {
	publish(request: {
		readonly graph: GraphRecord;
		readonly item: ItemRecord;
		readonly artifact: WorkspaceArtifact;
		readonly placement: WorkspacePlacementDescriptor;
		readonly target?: WorkspacePlacementDescriptor;
		readonly signal: AbortSignal;
		readonly terminal: WorkResult["state"];
	}): Promise<{
		readonly terminal: WorkResult["state"];
		readonly publication: PublicationOutcome;
		readonly diagnostics: readonly WorkDiagnostic[];
	}>;
}

export interface WorkGraphSettlementHost {
	now(): number;
	graphMutation<Result>(graphId: WorkGraphId, operation: () => Promise<Result> | Result): Promise<Result>;
	appendGraphFacts(graph: GraphRecord, facts: readonly WorkGraphFact[]): Promise<void>;
	archiveDurableGraph(graph: GraphRecord): Promise<void>;
	transition(graph: GraphRecord, item: ItemRecord, to: WorkItemState): Promise<boolean>;
	interruptInMemory(graph: GraphRecord, item: ItemRecord, error: unknown): Promise<void>;
	afterItemTerminal(graph: GraphRecord, item: ItemRecord): Promise<void>;
	publish(factory: (sequence: number) => CodingAgentObservation): number;
	notifySettlementWaiters(): void;
}

export class WorkGraphSettlementController {
	readonly #durable: WorkGraphSettlementDurabilityPort;
	readonly #tooling: Pick<WorkspaceTooling, "quiesce" | "capture">;
	readonly #worker: WorkGraphSettlementWorkerPort;
	readonly #publication: WorkGraphSettlementPublicationPort;
	readonly #host: WorkGraphSettlementHost;

	constructor(input: {
		readonly durable: WorkGraphSettlementDurabilityPort;
		readonly tooling: Pick<WorkspaceTooling, "quiesce" | "capture">;
		readonly worker: WorkGraphSettlementWorkerPort;
		readonly publication: WorkGraphSettlementPublicationPort;
		readonly host: WorkGraphSettlementHost;
	}) {
		this.#durable = input.durable;
		this.#tooling = input.tooling;
		this.#worker = input.worker;
		this.#publication = input.publication;
		this.#host = input.host;
	}

	async trySettleItem(graph: GraphRecord, item: ItemRecord): Promise<void> {
		if (item.projection.state !== "settling" || item.process.settling) return item.process.settling;
		const children = graph.itemOrder.filter((candidate) => candidate.parentId === item.id);
		if (children.some((child) => !isTerminal(child.projection.state))) return;
		const operation = this.#settleItem(graph, item).catch((error) =>
			this.#host.interruptInMemory(graph, item, error),
		);
		item.process.settling = operation;
		await operation;
	}

	async finalizeWithoutRun(
		graph: GraphRecord,
		item: ItemRecord,
		terminal: "canceled" | "blocked" | "interrupted",
		blockedBy: readonly WorkItemId[] = [],
	): Promise<void> {
		if (isTerminal(item.projection.state)) return;
		this.#worker.deactivate(graph, item);
		await this.#host.transition(graph, item, terminal);
		const publication: PublicationOutcome =
			terminal === "canceled"
				? { state: "not_published", reason: "canceled" }
				: terminal === "interrupted"
					? { state: "not_published", reason: "interrupted" }
					: { state: "not_required" };
		const result = this.makeResult(item, terminal, publication, undefined, undefined, blockedBy);
		await this.#recordResult(graph, item, result);
		await this.#worker.releaseResources(graph, item, false);
		await this.#host.afterItemTerminal(graph, item);
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
		const settledAt = this.#host.now();
		const run: WorkRunResult | undefined = item.process.run
			? {
					runId: String(item.process.run.runId),
					outcome: item.process.run.outcome,
					...(item.process.run.failure ? { failure: item.process.run.failure } : {}),
					...(item.process.runtime?.assistantText()
						? { assistantText: item.process.runtime.assistantText() }
						: {}),
				}
			: undefined;
		const budget: WorkBudgetUsage = {
			modelAttempts: item.projection.factProjection.modelAttempts,
			toolInvocations: item.projection.factProjection.toolInvocations,
			totalTokens: item.projection.factProjection.totalTokens,
			elapsedMs: Math.max(0, settledAt - item.projection.acceptedAt),
			...(item.projection.factProjection.exhaustion
				? { exhaustion: item.projection.factProjection.exhaustion }
				: {}),
		};
		return immutableData({
			durability,
			itemId: item.id,
			...(item.parentId ? { parentItemId: item.parentId } : {}),
			dependencies: item.dependencies,
			runtimeId: item.runtimeId,
			sessionId: item.projection.sessionId ?? String(item.process.session?.session.id ?? "session:unknown"),
			state,
			...(run ? { run } : {}),
			...(evidence ? { evidence } : {}),
			placement: item.projection.placementDescriptor ??
				item.process.placement?.placement ?? {
					placementId: "placement:unknown",
					root: "",
					baseIdentity: "unknown",
					kind: "memory",
				},
			...(artifact ? { artifact } : {}),
			publication,
			diagnostics: item.process.diagnostics,
			timing: {
				acceptedAt: item.projection.acceptedAt,
				...(item.projection.startedAt === undefined ? {} : { startedAt: item.projection.startedAt }),
				settledAt,
			},
			budget,
			...(blockedBy.length > 0 ? { blockedBy } : {}),
		});
	}

	async trySettleGraph(graph: GraphRecord): Promise<void> {
		if (graph.result || graph.itemOrder.length === 0) return;
		if (graph.itemOrder.some((item) => !isTerminal(item.projection.state) || !item.projection.result)) return;
		if (graph.settlement) return graph.settlement;
		const operation = this.#host.graphMutation(graph.id, async () => {
			if (graph.result || graph.itemOrder.length === 0) return;
			if (graph.itemOrder.some((item) => !isTerminal(item.projection.state) || !item.projection.result)) return;
			const root = graph.items.get(graph.rootId);
			if (!root?.projection.result) return;
			const results = graph.itemOrder.map((item) => item.projection.result!);
			const outcome: WorkGraphOutcome = results.some((result) => result.state === "interrupted")
				? "interrupted"
				: graph.cancellationRequested || root.projection.result.state === "canceled"
					? "canceled"
					: root.projection.result.state === "failed" || root.projection.result.state === "blocked"
						? "failed"
						: results.some((result) => result.state !== "succeeded")
							? "partial"
							: "succeeded";
			const publications = results.map((result) => result.publication.state);
			const finalPublication = publications.includes("not_published")
				? publications.includes("published")
					? "mixed"
					: "not_published"
				: publications.includes("published")
					? "published"
					: "not_required";
			const settledAt = Math.max(this.#host.now(), graph.aggregate.snapshot().lastTimestamp ?? 0);
			let result: WorkGraphResult = immutableData({
				durability:
					this.#durable.ledgerFailure ||
					this.#durable.hasGraphFailure(graph.id) ||
					results.some(({ durability }) => durability === "unknown")
						? "unknown"
						: "confirmed",
				graphId: graph.id,
				rootItemId: graph.rootId,
				objective: graph.objective,
				outcome,
				maximumConcurrency: graph.maximumConcurrency,
				effectiveConcurrency: graph.effectiveConcurrency,
				results,
				cancellationRequested: graph.cancellationRequested,
				acceptedAt: graph.acceptedAt,
				settledAt,
				finalPublication,
			});
			if (result.durability === "confirmed") {
				try {
					await this.#host.appendGraphFacts(graph, [
						{
							version: WORK_GRAPH_FACT_VERSION,
							type: "graph_result_recorded",
							graphId: graph.id,
							timestamp: settledAt,
							effectiveConcurrency: graph.effectiveConcurrency,
						},
					]);
					result = graph.aggregate.snapshot().graph!.result!;
					await this.#host.archiveDurableGraph(graph);
				} catch {
					if (!this.#durable.ledgerFailure && !this.#durable.hasGraphFailure(graph.id)) {
						throw new Error("Work Graph result persistence failed");
					}
					result = immutableData({ ...result, durability: "unknown" });
				}
			}
			if (result.durability === "unknown") {
				// Persistence-failure exception: no authoritative Graph projection can represent unknown durability.
				graph.result = result;
			}
			this.#host.publish((sequence) => ({ type: "work_graph_settled", sequence, result }));
			this.#host.notifySettlementWaiters();
		});
		graph.settlement = operation;
		try {
			await operation;
		} finally {
			if (graph.settlement === operation) graph.settlement = undefined;
		}
	}

	async #settleItem(graph: GraphRecord, item: ItemRecord): Promise<void> {
		const hasUnclosedEffects = workerFactHasOpenEffects(item.projection.factProjection);
		if (hasUnclosedEffects) {
			item.process.diagnostics.push({
				code: "worker_effect_window_unclosed",
				message: "Worker settled while a Model Attempt or Tool Invocation effect window remained open",
			});
		}
		let terminal: WorkResult["state"] =
			this.#durable.ledgerFailure || this.#durable.hasGraphFailure(graph.id)
				? "interrupted"
				: item.process.uncertainExternalEffect
					? "interrupted"
					: item.projection.cancellationRequested || item.process.run?.outcome === "aborted"
						? "canceled"
						: hasUnclosedEffects
							? "interrupted"
							: item.process.run?.outcome === "success"
								? "succeeded"
								: "failed";
		let artifact: WorkspaceArtifact | undefined;
		let publication: PublicationOutcome = { state: "not_required" };
		const placement = item.process.placement?.placement;
		if (!placement) {
			terminal = "interrupted";
			item.process.diagnostics.push({
				code: "placement_missing",
				message: "Workspace Placement was lost before settlement",
			});
		} else {
			try {
				await this.#tooling.quiesce({
					graphId: graph.id,
					itemId: item.id,
					sessionId: item.projection.sessionId ?? String(item.process.session?.session.id ?? "session:unknown"),
					placement,
				});
			} catch (error) {
				terminal = "interrupted";
				item.process.diagnostics.push({ code: "workspace_quiescence_interrupted", message: errorMessage(error) });
			}
			try {
				artifact = await this.#tooling.capture({
					graphId: graph.id,
					itemId: item.id,
					placement,
					signal: item.process.controller?.signal ?? new AbortController().signal,
				});
			} catch (error) {
				terminal = "interrupted";
				item.process.diagnostics.push({ code: "artifact_capture_interrupted", message: errorMessage(error) });
			}
			if (artifact) {
				const target = item.parentId ? graph.items.get(item.parentId)?.process.placement?.placement : undefined;
				const settled = await this.#publication.publish({
					graph,
					item,
					artifact,
					placement,
					...(target ? { target } : {}),
					signal: item.process.controller?.signal ?? new AbortController().signal,
					terminal,
				});
				terminal = settled.terminal;
				publication = settled.publication;
				item.process.diagnostics.push(...settled.diagnostics);
			}
		}

		const evidence =
			item.process.run && item.process.session
				? item.process.session.evidence(String(item.process.run.runId))
				: undefined;
		if (!(await this.#worker.teardown(item)) && terminal === "succeeded") terminal = "failed";
		this.#worker.deactivate(graph, item);
		await this.#host.transition(graph, item, terminal);
		const result = this.makeResult(item, terminal, publication, artifact, evidence);
		await this.#recordResult(graph, item, result);
		await this.#worker.releaseResources(
			graph,
			item,
			publication.state === "not_published" || terminal === "interrupted",
		);
		await this.#host.afterItemTerminal(graph, item);
	}

	async #recordResult(graph: GraphRecord, item: ItemRecord, result: WorkResult): Promise<void> {
		await this.#host.graphMutation(graph.id, async () => {
			if (item.projection.result) return;
			if (result.durability !== "confirmed") {
				throw new Error(`Undurable Work Result ${item.id} cannot enter the Work Graph store`);
			}
			await this.#host.appendGraphFacts(graph, [
				{
					version: WORK_GRAPH_FACT_VERSION,
					type: "item_result_recorded",
					graphId: graph.id,
					itemId: item.id,
					timestamp: result.timing.settledAt,
					state: result.state,
					...(result.run ? { run: result.run } : {}),
					...(result.evidence ? { evidence: result.evidence } : {}),
					diagnostics: result.diagnostics,
					...(result.blockedBy ? { blockedBy: result.blockedBy } : {}),
				},
			]);
			const authoritative = graph.aggregate.snapshot().graph!.items.find(({ itemId }) => itemId === item.id)!
				.result!;
			this.#host.publish((sequence) => ({
				type: "work_item_settled",
				sequence,
				graphId: graph.id,
				result: authoritative,
			}));
		});
	}
}
