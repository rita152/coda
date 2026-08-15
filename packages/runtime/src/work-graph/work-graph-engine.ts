import type { AgentInput, RunBudget } from "@coda/agent";
import type { TimeRuntime } from "@coda/ai";
import type { RunCapabilityHost } from "../run-capabilities.ts";
import type { DurableGraphStore } from "./durable-graph-store.ts";
import type {
	Identity,
	InputResourceStore,
	ObservationBus,
	RunModelProvider,
	WorkAdmission,
	WorkerControlSink,
	WorkSessionStore,
	WorkspacePlacement,
	WorkspaceTooling,
} from "./ports.ts";
import type { PublicationSequencer } from "./publication-sequencer.ts";
import type { SessionLeaseRegistry } from "./session-registry.ts";
import type {
	CodingAgent,
	CodingAgentCloseResult,
	CodingAgentCommandBatch,
	CodingAgentObservation,
	CodingAgentReceipt,
	CodingAgentSnapshot,
	DeliverWorkItemInput,
	ObservationOptions,
	PublicationOutcome,
	WorkBudgetUsage,
	WorkCapacityPolicy,
	WorkDiagnostic,
	WorkGraphId,
	WorkGraphOutcome,
	WorkGraphResult,
	WorkGraphSnapshot,
	WorkItemId,
	WorkItemInputKind,
	WorkItemSnapshot,
	WorkItemState,
	WorkResult,
	WorkRunResult,
	WorkspaceArtifact,
} from "./types.ts";
import { WorkGraphDelegationController } from "./work-graph-delegation.ts";
import { WORK_GRAPH_FACT_VERSION, type WorkGraphFact, type WorkGraphItemDefinition } from "./work-graph-fact.ts";
import { WorkGraphPersistenceController } from "./work-graph-persistence.ts";
import {
	errorMessage,
	type GraphRecord,
	type ItemRecord,
	immutableData,
	isTerminal,
	type WorkGraphMirror,
} from "./work-graph-records.ts";
import { WorkGraphScheduler } from "./work-graph-scheduler.ts";
import {
	assertIdentity,
	type BatchPlan,
	commitOwnershipReservations,
	createWorkGraphPlanningView,
	ID_PATTERN,
	planBatch,
	rejected,
	reserveBatch,
	revalidateBatchPlan,
	rollbackReservations,
	SubmissionRejection,
	settleAcceptedInputResources,
	validatePlanConfigurations,
} from "./work-graph-submission.ts";
import { workerFactHasOpenEffects } from "./worker-fact.ts";
import type { WorkerRuntimePort } from "./worker-lifecycle.ts";
import type { WorkerSubmission } from "./worker-protocol.ts";

export interface WorkGraphEngineOptions {
	readonly time: TimeRuntime;
	readonly identity: Identity;
	readonly modelProvider: RunModelProvider;
	readonly runCapabilities: RunCapabilityHost;
	readonly placement: WorkspacePlacement;
	readonly tooling: WorkspaceTooling;
	readonly sessions: WorkSessionStore;
	readonly resources?: InputResourceStore;
	readonly capacity: WorkCapacityPolicy;
	readonly admission: WorkAdmission;
	readonly runBudget?: RunBudget;
	readonly maxOutputTokens?: number;
	readonly workerControl?: WorkerControlSink;
}

export class WorkGraphEngine implements CodingAgent {
	readonly #options: WorkGraphEngineOptions;
	readonly #durable: DurableGraphStore<GraphRecord>;
	readonly #graphs: Map<WorkGraphId, GraphRecord>;
	readonly #graphOrder: GraphRecord[];
	readonly #sessionRegistry: SessionLeaseRegistry;
	readonly #observations: ObservationBus;
	readonly #capacity: WorkCapacityPolicy;
	readonly #mirror: WorkGraphMirror;
	readonly #workerLifecycle: WorkerRuntimePort;
	readonly #publicationSequencer: PublicationSequencer;
	readonly #admission: WorkAdmission;
	readonly #scheduler: WorkGraphScheduler;
	readonly #delegation: WorkGraphDelegationController;
	readonly #persistence: WorkGraphPersistenceController;

	constructor(
		options: WorkGraphEngineOptions,
		dependencies: {
			readonly graphs: Map<WorkGraphId, GraphRecord>;
			readonly graphOrder: GraphRecord[];
			readonly observations: ObservationBus;
			readonly sessionRegistry: SessionLeaseRegistry;
			readonly mirror: WorkGraphMirror;
			readonly workerLifecycle: WorkerRuntimePort;
			readonly publicationSequencer: PublicationSequencer;
			readonly durable: DurableGraphStore<GraphRecord>;
		},
	) {
		this.#options = options;
		this.#graphs = dependencies.graphs;
		this.#graphOrder = dependencies.graphOrder;
		this.#durable = dependencies.durable;
		this.#capacity = immutableData(options.capacity);
		this.#observations = dependencies.observations;
		this.#sessionRegistry = dependencies.sessionRegistry;
		this.#mirror = dependencies.mirror;
		this.#workerLifecycle = dependencies.workerLifecycle;
		this.#publicationSequencer = dependencies.publicationSequencer;
		this.#admission = options.admission;
		this.#scheduler = new WorkGraphScheduler({
			graphOrder: this.#graphOrder,
			admission: this.#admission,
			host: {
				ledgerFailure: () => this.#durable.ledgerFailure,
				hasGraphFailure: (graphId) => this.#durable.hasGraphFailure(graphId),
				processActiveConcurrency: () => this.#workerLifecycle.processActiveConcurrency,
				activate: (graph, item) => this.#workerLifecycle.activate(graph, item),
				runItem: (graph, item) =>
					this.#workerLifecycle.runItem(graph, item, {
						delegate: (specifications, signal) => this.#delegation.delegate(graph, item, specifications, signal),
						promptSubmission: () => this.#createSubmission(item, "prompt", item.objective, []),
						transition: (to) => this.#transition(graph, item, to),
						settleItem: () => this.#trySettleItem(graph, item),
						settleAfterPersistenceFailure: () => this.#settleAfterPersistenceFailure(graph, item),
						interruptInMemory: (error) => this.#interruptInMemory(graph, item, error),
					}),
				applyCancellation: (graph, targets) =>
					this.#workerLifecycle.applyCancellation(targets, {
						diagnose: (code, message, itemId) => this.#diagnose({ code, message }, graph.id, itemId),
						finalizeUnstarted: (item) => this.#finalizeWithoutRun(graph, item, "canceled"),
					}),
				transition: (graph, item, to) => this.#transition(graph, item, to),
				finalizeWithoutRun: (graph, item, terminal, blockedBy) =>
					this.#finalizeWithoutRun(graph, item, terminal, blockedBy),
				trySettleGraph: (graph) => this.#trySettleGraph(graph),
				diagnose: (diagnostic, graphId, itemId) => this.#diagnose(diagnostic, graphId, itemId),
			},
		});
		this.#delegation = new WorkGraphDelegationController({
			submit: (batch) => this.submit(batch),
			deactivate: (graph, item) => this.#workerLifecycle.deactivate(graph, item),
			requestSchedule: () => this.#scheduler.request(),
		});
		this.#persistence = new WorkGraphPersistenceController({
			graphs: this.#graphs,
			graphOrder: this.#graphOrder,
			durable: this.#durable,
			host: {
				now: () => this.#options.time.clock.now(),
				applyWorkerCancellation: (graph) => this.#scheduler.applyWorkerCancellation(graph),
				interruptInMemory: (graph, item, error) => this.#interruptInMemory(graph, item, error),
				settleAfterPersistenceFailure: (graph, item) => this.#settleAfterPersistenceFailure(graph, item),
				trySettleGraph: (graph) => this.#trySettleGraph(graph),
				diagnose: (diagnostic, graphId, itemId) => this.#diagnose(diagnostic, graphId, itemId),
				publish: (factory) => this.#publish(factory),
				requestSchedule: () => this.#scheduler.request(),
				closePlacement: () => this.#options.placement.close(),
				closeObservations: () => this.#observations.closeAll(),
			},
		});
	}

	drainPendingInputAdmissions(item: ItemRecord): void {
		this.#drainInputAdmissions(item);
	}

	settleGraph(graph: GraphRecord): Promise<void> {
		return this.#trySettleGraph(graph);
	}

	schedule(): void {
		this.#scheduler.request();
	}

	submit(batch: CodingAgentCommandBatch): Promise<CodingAgentReceipt> {
		return this.#persistence.trackSubmission(this.#submit(batch));
	}

	observe(options: ObservationOptions = {}): AsyncIterable<CodingAgentObservation> {
		const capacity = options.capacity ?? 256;
		const coordinator = this;
		return Object.freeze({
			async *[Symbol.asyncIterator]() {
				const subscription = coordinator.#observations.subscribe(capacity);
				yield immutableData({
					type: "snapshot",
					sequence: coordinator.#observations.sequence,
					snapshot: coordinator.#snapshot(),
				} satisfies CodingAgentObservation);
				yield* subscription;
			},
		});
	}

	close(): Promise<CodingAgentCloseResult> {
		return this.#persistence.close();
	}

	async #submit(batch: CodingAgentCommandBatch): Promise<CodingAgentReceipt> {
		const batchId =
			typeof batch?.batchId === "string" && ID_PATTERN.test(batch.batchId)
				? batch.batchId
				: `batch:${this.#options.identity.generate("queue_item")}`;
		if (this.#persistence.closing || this.#persistence.closed) {
			return immutableData({
				status: "rejected",
				batchId,
				rejection: { code: "closed", message: "Coding Agent is closing or closed" },
			});
		}
		if (this.#durable.ledgerFailure) {
			return immutableData({
				status: "rejected",
				batchId,
				rejection: {
					code: "ledger_failed",
					message: `Workspace Ledger persistence is unavailable: ${errorMessage(this.#durable.ledgerFailure)}`,
				},
			});
		}
		if (!batch || !Array.isArray(batch.commands) || batch.commands.length === 0) {
			return immutableData({
				status: "rejected",
				batchId,
				rejection: { code: "empty_batch", message: "A command batch must contain at least one command" },
			});
		}

		const admission = this.#admission.reserve();
		let plan: BatchPlan | undefined;
		let durablyAccepted = false;
		let sequence = 0;
		try {
			plan = await this.#admission.mutation(() =>
				planBatch({
					batch,
					batchId,
					now: this.#options.time.clock.now(),
					identity: this.#options.identity,
					capacity: this.#capacity,
					durable: {
						graphFailure: (graphId) => this.#durable.graphFailure(graphId),
						allocateGraphOrder: () => this.#durable.allocateGraphOrder(),
						allocatePublicationOrder: () => this.#durable.allocatePublicationOrder(),
					},
					view: createWorkGraphPlanningView(this.#graphs),
				}),
			);
			await validatePlanConfigurations(plan, this.#options.modelProvider);
			await reserveBatch(plan, {
				placement: this.#options.placement,
				sessions: this.#options.sessions,
				...(this.#options.resources ? { resources: this.#options.resources } : {}),
				sessionLeases: this.#sessionRegistry,
				rejection: { assertIdentity, rejected },
			});
			await commitOwnershipReservations(plan, rejected);
			await admission.ready;
			await this.#admission.mutation(() =>
				this.#graphMutation(plan!.targetGraphId, async () => {
					revalidateBatchPlan(plan!, { graphs: this.#graphs, sessions: this.#sessionRegistry });
					const graph = plan!.newGraphs[0] ?? this.#graphs.get(plan!.targetGraphId)!;
					if (plan!.newGraphs.length === 0 && plan!.newItems.length > 0) {
						await this.#acceptWorkspaceGraphs(plan!);
					}
					await this.#appendGraphFacts(graph, this.#acceptedFacts(plan!));
					if (plan!.newGraphs.length > 0) {
						await this.#durable.flushGraph(plan!.targetGraphId);
						await this.#acceptWorkspaceGraphs(plan!);
					}
					durablyAccepted = true;
					this.#accept(plan!);
					this.#acceptInputAdmissions(plan!);
					sequence = this.#publish((value) => ({
						type: "batch_accepted",
						sequence: value,
						batchId,
						graphIds: plan!.graphIds,
						itemIds: plan!.itemIds,
					}));
				}),
			);
		} catch (error) {
			if (durablyAccepted) {
				this.#diagnose({ code: "accepted_operation_failed", message: errorMessage(error) });
			} else if (plan) {
				await rollbackReservations(plan, (diagnostic) => this.#diagnose(diagnostic));
			}
			admission.release();
			if (durablyAccepted && plan) {
				this.#scheduler.request();
				return immutableData({
					status: "accepted",
					batchId,
					sequence,
					graphIds: plan.graphIds,
					itemIds: plan.itemIds,
				});
			}
			const rejection =
				error instanceof SubmissionRejection
					? error.rejection
					: this.#durable.ledgerFailure
						? { code: "ledger_failed" as const, message: errorMessage(error) }
						: { code: "graph_store_failed" as const, message: errorMessage(error), graphId: plan?.targetGraphId };
			this.#scheduler.request();
			return immutableData({ status: "rejected", batchId, rejection });
		}
		if (!plan) throw new Error("Accepted command batch has no plan");
		admission.release();
		this.#scheduler.request();

		// The atomic Fact segment plus any required Ledger index is the durable
		// acceptance point. Later bookkeeping cannot turn it into a rejection.
		try {
			await this.#applyAcceptedOperations(plan);
		} catch (error) {
			this.#diagnose({ code: "accepted_operation_failed", message: errorMessage(error) });
		}
		try {
			await settleAcceptedInputResources(plan, {
				now: () => this.#options.time.clock.now(),
				graphMutation: (graphId, operation) => this.#graphMutation(graphId, operation),
				appendGraphFacts: (graph, facts) => this.#appendGraphFacts(graph, facts),
				settleInputAdmission: (item, deliveryId, outcome, diagnostic) =>
					this.#settleInputAdmission(item, deliveryId, outcome, diagnostic),
				diagnose: (diagnostic, graphId, itemId) => this.#diagnose(diagnostic, graphId, itemId),
				interruptForInputResourceFailure: (graph, item) => this.#interruptForInputResourceFailure(graph, item),
				flushPendingInputs: (item) => this.#flushPendingInputs(item),
				requestSchedule: () => this.#scheduler.request(),
			});
		} catch (error) {
			this.#diagnose({ code: "input_resource_settlement_failed", message: errorMessage(error) });
		}
		this.#scheduler.request();
		return immutableData({
			status: "accepted",
			batchId,
			sequence,
			graphIds: plan.graphIds,
			itemIds: plan.itemIds,
		});
	}

	#accept(plan: BatchPlan): void {
		for (const graph of plan.newGraphs) {
			this.#graphs.set(graph.id, graph);
			this.#graphOrder.push(graph);
		}
		for (const entry of plan.newItems) {
			const state = entry.graph.aggregate.snapshot().graph!.items.find(({ itemId }) => itemId === entry.item.id);
			if (!state) throw new Error(`Accepted Work Item ${entry.item.id} is absent from the Aggregate projection`);
			this.#mirror.projectItem(entry.item, state);
			entry.item.reservedSessionId = undefined;
			entry.item.reservedPlacementDescriptor = undefined;
			entry.graph.items.set(entry.item.id, entry.item);
			entry.graph.itemOrder.push(entry.item);
		}
	}

	#acceptInputAdmissions(plan: BatchPlan): void {
		const touched = new Set<ItemRecord>();
		for (const delivery of plan.deliveries) {
			if (delivery.command.kind === "prompt") delivery.item.promptAccepted = true;
			delivery.item.inputAdmissions.push({
				deliveryId: delivery.deliveryId,
				command: delivery.command,
				...((delivery.command.resources?.length ?? 0) === 0
					? { settlement: { outcome: "committed" as const } }
					: {}),
			});
			touched.add(delivery.item);
		}
		for (const item of touched) this.#drainInputAdmissions(item);
	}

	#settleInputAdmission(
		item: ItemRecord,
		deliveryId: string,
		outcome: "committed" | "failed",
		diagnostic?: string,
	): readonly string[] {
		const admission = item.inputAdmissions.find((candidate) => candidate.deliveryId === deliveryId);
		if (!admission) throw new Error(`Input admission not found: ${deliveryId}`);
		if (admission.settlement) throw new Error(`Input admission already settled: ${deliveryId}`);
		admission.settlement = { outcome, ...(diagnostic ? { diagnostic } : {}) };
		return this.#drainInputAdmissions(item);
	}

	#drainInputAdmissions(item: ItemRecord): readonly string[] {
		const failures: string[] = [];
		while (item.inputAdmissions[0]?.settlement) {
			const admission = item.inputAdmissions.shift()!;
			const settlement = admission.settlement!;
			if (settlement.outcome === "committed") {
				if (!isTerminal(item.state) && !item.cancellationRequested && !item.uncertainExternalEffect) {
					this.#queueDelivery(item, admission.command);
				}
				continue;
			}
			const diagnostic = settlement.diagnostic ?? "Input resource commit failed";
			item.diagnostics.push({ code: "input_resource_commit_failed", message: diagnostic });
			item.uncertainExternalEffect = true;
			failures.push(`input_resource_commit_failed${settlement.diagnostic ? `:${settlement.diagnostic}` : ""}`);
		}
		return failures;
	}

	#queueDelivery(item: ItemRecord, command: DeliverWorkItemInput): void {
		const submission = this.#createSubmission(item, command.kind, command.input, command.resources ?? []);
		if (command.kind === "prompt") item.promptInput = submission;
		else item.pendingInputs.push({ submission });
	}

	#itemDefinition(item: ItemRecord): WorkGraphItemDefinition {
		const sessionId = item.sessionId ?? item.reservedSessionId;
		const placement = item.placementDescriptor ?? item.reservedPlacementDescriptor;
		if (!sessionId || !placement) {
			throw new Error(`Accepted Work Item ${item.id} has incomplete ownership`);
		}
		return {
			itemId: item.id,
			order: item.order,
			...(item.parentId ? { parentItemId: item.parentId } : {}),
			dependencies: item.dependencies,
			objective: item.objective,
			executionMode: item.executionMode,
			desiredConfiguration: item.desiredConfiguration,
			publicationOrder: item.publicationOrder,
			runtimeId: item.runtimeId,
			sessionId,
			placement,
		};
	}

	#acceptedFacts(plan: BatchPlan): readonly WorkGraphFact[] {
		const graph = plan.newGraphs[0] ?? this.#graphs.get(plan.targetGraphId);
		if (!graph) throw new Error(`Accepted Work Graph is unavailable: ${plan.targetGraphId}`);
		const timestamp = Math.max(this.#options.time.clock.now(), graph.aggregate.snapshot().lastTimestamp ?? 0);
		const facts: WorkGraphFact[] = [];
		const root =
			plan.newGraphs.length > 0 ? plan.newItems.find(({ item }) => item.id === graph.rootId)?.item : undefined;
		if (plan.newGraphs.length > 0) {
			if (!root) throw new Error(`Accepted Work Graph ${graph.id} has no root Work Item`);
			facts.push({
				version: WORK_GRAPH_FACT_VERSION,
				type: "graph_accepted",
				graphId: graph.id,
				timestamp,
				batchId: plan.batchId,
				order: graph.order,
				objective: graph.objective,
				maximumConcurrency: graph.maximumConcurrency,
				root: this.#itemDefinition(root),
			});
		}
		const added = plan.newItems.filter(({ item }) => item !== root).map(({ item }) => this.#itemDefinition(item));
		if (added.length > 0) {
			facts.push({
				version: WORK_GRAPH_FACT_VERSION,
				type: "items_accepted",
				graphId: graph.id,
				timestamp,
				batchId: plan.batchId,
				items: added,
			});
		}
		for (const { deliveryId, command, item } of plan.deliveries) {
			facts.push({
				version: WORK_GRAPH_FACT_VERSION,
				type: "input_accepted",
				graphId: graph.id,
				timestamp,
				batchId: plan.batchId,
				deliveryId,
				itemId: item.id,
				kind: command.kind,
				input: command.input,
				resourceReferences: command.resources ?? [],
			});
		}
		for (const { command, item } of plan.configurations) {
			facts.push({
				version: WORK_GRAPH_FACT_VERSION,
				type: "item_configuration_changed",
				graphId: graph.id,
				timestamp,
				batchId: plan.batchId,
				itemId: item.id,
				configuration: command.configuration,
			});
		}
		for (const cancellation of plan.cancellations) {
			facts.push({
				version: WORK_GRAPH_FACT_VERSION,
				type: "cancellation_requested",
				graphId: graph.id,
				timestamp,
				batchId: plan.batchId,
				target: cancellation.item ? { type: "item", itemId: cancellation.item.id } : { type: "graph" },
			});
		}
		if (facts.length === 0) throw new Error(`Accepted batch ${plan.batchId} produced no Work Graph Facts`);
		return facts;
	}

	async #acceptWorkspaceGraphs(plan: BatchPlan): Promise<void> {
		// Planning reserves monotonically increasing ordinals under the mutation
		// fence. Rejections may leave gaps, but an accepted Ledger watermark must
		// never allocate the same ordinal a second time.
		await this.#durable.accept({
			activeGraphs: plan.newGraphs.map((graph) => ({ graphId: graph.id, order: graph.order })),
			nextGraphOrder: this.#durable.nextGraphOrder,
			nextPublicationOrder: this.#durable.nextPublicationOrder,
			sessionOwners: plan.newItems.map(({ graph, item }) => ({
				sessionId: item.reservedSessionId!,
				graphId: graph.id,
				itemId: item.id,
			})),
		});
		for (const { graph, item } of plan.newItems) {
			this.#sessionRegistry.claim(item.reservedSessionId!, graph.id, item.id);
		}
	}

	async #archiveDurableGraph(graph: GraphRecord): Promise<void> {
		await this.#durable.archiveGraph(graph.id);
		this.#sessionRegistry.releaseGraph(graph.id);
	}

	async #applyAcceptedOperations(plan: BatchPlan): Promise<void> {
		for (const { command, item } of plan.configurations) {
			if (item.runtime) {
				try {
					await item.runtime.configure(command.configuration);
				} catch (error) {
					this.#diagnose({ code: "configuration_failed", message: errorMessage(error) }, item.graphId, item.id);
				}
			}
		}
		for (const delivery of plan.deliveries) {
			this.#flushPendingInputs(delivery.item);
		}
		for (const cancellation of plan.cancellations) {
			await this.#scheduler.applyWorkerCancellation(cancellation.graph, cancellation.item);
		}
	}

	async #interruptForInputResourceFailure(graph: GraphRecord, item: ItemRecord): Promise<void> {
		item.controller?.abort(new Error("Input resource commit failed"));
		try {
			item.runtime?.cancel();
		} catch (error) {
			this.#diagnose({ code: "worker_cancel_failed", message: errorMessage(error) }, graph.id, item.id);
		}
		if (item.state === "pending" || item.state === "ready") {
			await this.#finalizeWithoutRun(graph, item, "interrupted");
		}
	}

	#createSubmission(
		item: ItemRecord,
		kind: WorkItemInputKind,
		input: AgentInput,
		resourceReferences: readonly string[],
	): WorkerSubmission {
		return immutableData({
			preparationId: `preparation:${item.graphId}:${item.id}:${this.#options.identity.generate("queue_item")}`,
			graphId: item.graphId,
			itemId: item.id,
			kind,
			input,
			resourceReferences,
		});
	}

	#flushPendingInputs(item: ItemRecord): void {
		if (!item.runtime || item.state === "pending" || item.state === "ready" || item.state === "preparing") return;
		for (const pending of item.pendingInputs.splice(0)) {
			if (pending.submission.kind === "steering") item.runtime.steer(pending.submission);
			else item.runtime.followUp(pending.submission);
		}
	}

	async #settleAfterPersistenceFailure(graph: GraphRecord, item: ItemRecord): Promise<void> {
		if (item.result) return;
		const from = item.state;
		const safeFailedBarrier =
			item.barrierFailure?.barrier === "work_graph_store" && !item.barrierFailure.externalEffectMayHaveOccurred;
		const terminal: WorkResult["state"] = safeFailedBarrier ? "failed" : "interrupted";
		await this.#workerLifecycle.teardown(item);
		// Single-fact-source exception: persistence has failed, so this unknown-durability result cannot be projected.
		item.state = terminal;
		const publication: PublicationOutcome =
			terminal === "failed" ? { state: "not_required" } : { state: "not_published", reason: "interrupted" };
		const result = this.#makeResult(item, terminal, publication, undefined, undefined, [], "unknown");
		item.result = result;
		this.#publish((sequence) => ({
			type: "item_state_changed",
			sequence,
			graphId: graph.id,
			itemId: item.id,
			from,
			to: terminal,
		}));
		this.#publish((sequence) => ({ type: "work_item_settled", sequence, graphId: graph.id, result }));
		await this.#workerLifecycle.releaseResources(graph, item, true);
		await this.#afterItemTerminal(graph, item);
	}

	async #trySettleItem(graph: GraphRecord, item: ItemRecord): Promise<void> {
		if (item.state !== "settling" || item.settling) return item.settling;
		const children = graph.itemOrder.filter((candidate) => candidate.parentId === item.id);
		if (children.some((child) => !isTerminal(child.state))) return;
		const operation = this.#settleItem(graph, item).catch((error) => this.#interruptInMemory(graph, item, error));
		item.settling = operation;
		await operation;
	}

	async #settleItem(graph: GraphRecord, item: ItemRecord): Promise<void> {
		const hasUnclosedEffects = workerFactHasOpenEffects(item.factProjection);
		if (hasUnclosedEffects) {
			item.diagnostics.push({
				code: "worker_effect_window_unclosed",
				message: "Worker settled while a Model Attempt or Tool Invocation effect window remained open",
			});
		}
		let terminal: WorkResult["state"] =
			this.#durable.ledgerFailure || this.#durable.hasGraphFailure(graph.id)
				? "interrupted"
				: item.uncertainExternalEffect
					? "interrupted"
					: item.cancellationRequested || item.run?.outcome === "aborted"
						? "canceled"
						: hasUnclosedEffects
							? "interrupted"
							: item.run?.outcome === "success"
								? "succeeded"
								: "failed";
		let artifact: WorkspaceArtifact | undefined;
		let publication: PublicationOutcome = { state: "not_required" };
		const placement = item.placement?.placement;
		if (!placement) {
			terminal = "interrupted";
			item.diagnostics.push({
				code: "placement_missing",
				message: "Workspace Placement was lost before settlement",
			});
		} else {
			try {
				await this.#options.tooling.quiesce({
					graphId: graph.id,
					itemId: item.id,
					sessionId: item.sessionId ?? String(item.session?.session.id ?? "session:unknown"),
					placement,
				});
			} catch (error) {
				terminal = "interrupted";
				item.diagnostics.push({ code: "workspace_quiescence_interrupted", message: errorMessage(error) });
			}
			try {
				artifact = await this.#options.tooling.capture({
					graphId: graph.id,
					itemId: item.id,
					placement,
					signal: item.controller?.signal ?? new AbortController().signal,
				});
			} catch (error) {
				terminal = "interrupted";
				item.diagnostics.push({ code: "artifact_capture_interrupted", message: errorMessage(error) });
			}
			if (artifact) {
				const target = item.parentId ? graph.items.get(item.parentId)?.placement?.placement : undefined;
				const settled = await this.#publicationSequencer.publish({
					graph,
					item,
					artifact,
					placement,
					...(target ? { target } : {}),
					signal: item.controller?.signal ?? new AbortController().signal,
					terminal,
				});
				terminal = settled.terminal;
				publication = settled.publication;
				item.diagnostics.push(...settled.diagnostics);
			}
		}

		const evidence = item.run && item.session ? item.session.evidence(String(item.run.runId)) : undefined;
		if (!(await this.#workerLifecycle.teardown(item)) && terminal === "succeeded") terminal = "failed";
		this.#workerLifecycle.deactivate(graph, item);
		await this.#transition(graph, item, terminal);
		const result = this.#makeResult(item, terminal, publication, artifact, evidence);
		await this.#recordResult(graph, item, result);
		await this.#workerLifecycle.releaseResources(
			graph,
			item,
			publication.state === "not_published" || terminal === "interrupted",
		);
		await this.#afterItemTerminal(graph, item);
	}

	async #finalizeWithoutRun(
		graph: GraphRecord,
		item: ItemRecord,
		terminal: "canceled" | "blocked" | "interrupted",
		blockedBy: readonly WorkItemId[] = [],
	): Promise<void> {
		if (isTerminal(item.state)) return;
		this.#workerLifecycle.deactivate(graph, item);
		await this.#transition(graph, item, terminal);
		const publication: PublicationOutcome =
			terminal === "canceled"
				? { state: "not_published", reason: "canceled" }
				: terminal === "interrupted"
					? { state: "not_published", reason: "interrupted" }
					: { state: "not_required" };
		const result = this.#makeResult(item, terminal, publication, undefined, undefined, blockedBy);
		await this.#recordResult(graph, item, result);
		await this.#workerLifecycle.releaseResources(graph, item, false);
		await this.#afterItemTerminal(graph, item);
	}

	#makeResult(
		item: ItemRecord,
		state: WorkResult["state"],
		publication: PublicationOutcome,
		artifact?: WorkspaceArtifact,
		evidence?: WorkResult["evidence"],
		blockedBy: readonly WorkItemId[] = [],
		durability: WorkResult["durability"] = "confirmed",
	): WorkResult {
		const settledAt = this.#options.time.clock.now();
		const run: WorkRunResult | undefined = item.run
			? {
					runId: String(item.run.runId),
					outcome: item.run.outcome,
					...(item.run.failure ? { failure: item.run.failure } : {}),
					...(item.runtime?.assistantText() ? { assistantText: item.runtime.assistantText() } : {}),
				}
			: undefined;
		const budget: WorkBudgetUsage = {
			modelAttempts: item.factProjection.modelAttempts,
			toolInvocations: item.factProjection.toolInvocations,
			totalTokens: item.factProjection.totalTokens,
			elapsedMs: Math.max(0, settledAt - item.acceptedAt),
			...(item.factProjection.exhaustion ? { exhaustion: item.factProjection.exhaustion } : {}),
		};
		return immutableData({
			durability,
			itemId: item.id,
			...(item.parentId ? { parentItemId: item.parentId } : {}),
			dependencies: item.dependencies,
			runtimeId: item.runtimeId,
			sessionId: item.sessionId ?? String(item.session?.session.id ?? "session:unknown"),
			state,
			...(run ? { run } : {}),
			...(evidence ? { evidence } : {}),
			placement: item.placementDescriptor ??
				item.placement?.placement ?? {
					placementId: "placement:unknown",
					root: "",
					baseIdentity: "unknown",
					kind: "memory",
				},
			...(artifact ? { artifact } : {}),
			publication,
			diagnostics: item.diagnostics,
			timing: {
				acceptedAt: item.acceptedAt,
				...(item.startedAt === undefined ? {} : { startedAt: item.startedAt }),
				settledAt,
			},
			budget,
			...(blockedBy.length > 0 ? { blockedBy } : {}),
		});
	}

	async #recordResult(graph: GraphRecord, item: ItemRecord, result: WorkResult): Promise<void> {
		await this.#graphMutation(graph.id, async () => {
			if (item.result) return;
			if (result.durability !== "confirmed") {
				throw new Error(`Undurable Work Result ${item.id} cannot enter the Work Graph store`);
			}
			await this.#appendGraphFacts(graph, [
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
			this.#publish((sequence) => ({
				type: "work_item_settled",
				sequence,
				graphId: graph.id,
				result: authoritative,
			}));
		});
	}

	async #afterItemTerminal(graph: GraphRecord, item: ItemRecord): Promise<void> {
		this.#delegation.noteItemTerminal();
		for (const parent of graph.itemOrder.filter((candidate) => candidate.id === item.parentId)) {
			await this.#trySettleItem(graph, parent);
		}
		await this.#trySettleGraph(graph);
		this.#scheduler.request();
	}

	async #trySettleGraph(graph: GraphRecord): Promise<void> {
		if (graph.result || graph.itemOrder.length === 0) return;
		if (graph.itemOrder.some((item) => !isTerminal(item.state) || !item.result)) return;
		if (graph.settlement) return graph.settlement;
		const operation = this.#graphMutation(graph.id, async () => {
			if (graph.result || graph.itemOrder.length === 0) return;
			if (graph.itemOrder.some((item) => !isTerminal(item.state) || !item.result)) return;
			const root = graph.items.get(graph.rootId);
			if (!root?.result) return;
			const results = graph.itemOrder.map((item) => item.result!);
			const outcome: WorkGraphOutcome = results.some((result) => result.state === "interrupted")
				? "interrupted"
				: graph.cancellationRequested || root.result.state === "canceled"
					? "canceled"
					: root.result.state === "failed" || root.result.state === "blocked"
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
			const settledAt = Math.max(this.#options.time.clock.now(), graph.aggregate.snapshot().lastTimestamp ?? 0);
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
					await this.#appendGraphFacts(graph, [
						{
							version: WORK_GRAPH_FACT_VERSION,
							type: "graph_result_recorded",
							graphId: graph.id,
							timestamp: settledAt,
							effectiveConcurrency: graph.effectiveConcurrency,
						},
					]);
					result = graph.aggregate.snapshot().graph!.result!;
					await this.#archiveDurableGraph(graph);
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
			this.#publish((sequence) => ({ type: "work_graph_settled", sequence, result }));
			this.#persistence.notifySettlementWaiters();
		});
		graph.settlement = operation;
		try {
			await operation;
		} finally {
			if (graph.settlement === operation) graph.settlement = undefined;
		}
	}

	async #transition(graph: GraphRecord, item: ItemRecord, to: WorkItemState): Promise<boolean> {
		return this.#graphMutation(graph.id, async () => {
			const from = item.state;
			if (from === to) return false;
			if (
				to === "preparing" &&
				(item.inputAdmissions.length > 0 ||
					item.cancellationRequested ||
					graph.cancellationRequested ||
					graph.result !== undefined ||
					graph.activeConcurrency >= graph.maximumConcurrency ||
					this.#workerLifecycle.processActiveConcurrency >= this.#capacity.processMaximumConcurrency)
			) {
				return false;
			}
			if (!this.#transitionPermitted(from, to)) {
				throw new Error(`Invalid Work Item transition ${item.id}: ${from} -> ${to}`);
			}
			await this.#appendGraphFacts(graph, [
				{
					version: WORK_GRAPH_FACT_VERSION,
					type: "item_transitioned",
					graphId: graph.id,
					itemId: item.id,
					from,
					to,
					timestamp: Math.max(this.#options.time.clock.now(), graph.aggregate.snapshot().lastTimestamp ?? 0),
				},
			]);
			this.#publish((sequence) => ({
				type: "item_state_changed",
				sequence,
				graphId: graph.id,
				itemId: item.id,
				from,
				to,
			}));
			return true;
		});
	}

	#transitionPermitted(from: WorkItemState, to: WorkItemState): boolean {
		if (isTerminal(from)) return false;
		const allowed: Record<
			Exclude<WorkItemState, "succeeded" | "failed" | "canceled" | "interrupted" | "blocked">,
			readonly WorkItemState[]
		> = {
			pending: ["ready", "blocked", "canceled", "interrupted"],
			ready: ["preparing", "blocked", "canceled", "interrupted"],
			preparing: ["running", "settling", "canceled", "failed", "interrupted"],
			running: ["settling", "canceled", "failed", "interrupted"],
			settling: ["succeeded", "failed", "canceled", "interrupted"],
		};
		return allowed[from as keyof typeof allowed].includes(to);
	}

	async #interruptInMemory(graph: GraphRecord, item: ItemRecord, error: unknown): Promise<void> {
		this.#persistence.noteUndurable(graph, item);
		item.controller?.abort(error);
		try {
			item.runtime?.cancel();
		} catch {}
		await this.#workerLifecycle.teardown(item);
		this.#workerLifecycle.deactivate(graph, item);
		// Single-fact-source exception: persistence is unavailable, so durability is explicitly unknown.
		item.state = "interrupted";
		const publication: PublicationOutcome = { state: "not_published", reason: "interrupted" };
		const result = this.#makeResult(item, "interrupted", publication, undefined, undefined, [], "unknown");
		item.result = result;
		this.#publish((sequence) => ({ type: "work_item_settled", sequence, graphId: graph.id, result }));
		await this.#workerLifecycle.releaseResources(graph, item, true);
		await this.#afterItemTerminal(graph, item);
	}

	#snapshot(): CodingAgentSnapshot {
		return immutableData({
			closed: this.#persistence.closed,
			graphs: this.#graphOrder.filter((graph) => !graph.result).map((graph) => this.#graphSnapshot(graph)),
		});
	}

	#graphSnapshot(graph: GraphRecord): WorkGraphSnapshot {
		return {
			graphId: graph.id,
			objective: graph.objective,
			rootItemId: graph.rootId,
			maximumConcurrency: graph.maximumConcurrency,
			activeConcurrency: graph.activeConcurrency,
			effectiveConcurrency: graph.effectiveConcurrency,
			cancellationRequested: graph.cancellationRequested,
			items: graph.itemOrder.map((item) => this.#itemSnapshot(item)),
			...(graph.result ? { result: graph.result } : {}),
		};
	}

	#itemSnapshot(item: ItemRecord): WorkItemSnapshot {
		const activeRun = item.factProjection.activeRun;
		return {
			itemId: item.id,
			...(item.parentId ? { parentItemId: item.parentId } : {}),
			dependencies: item.dependencies,
			objective: item.objective,
			executionMode: item.executionMode,
			state: item.state,
			desiredConfiguration: item.desiredConfiguration,
			...(item.runtime ? { runtimeId: item.runtimeId } : {}),
			...(activeRun ? { activeRun } : {}),
			sessionId: item.sessionId ?? String(item.session?.session.id ?? "session:unreserved"),
			placement: item.placementDescriptor ??
				item.placement?.placement ?? {
					placementId: "placement:unreserved",
					root: "",
					baseIdentity: "unreserved",
					kind: "memory",
				},
			cancellationRequested: item.cancellationRequested,
			...(item.result ? { result: item.result } : {}),
		};
	}

	#publish(factory: (sequence: number) => CodingAgentObservation): number {
		return this.#observations.publish(factory);
	}

	#diagnose(diagnostic: WorkDiagnostic, graphId?: WorkGraphId, workItemId?: WorkItemId): void {
		this.#publish((sequence) => ({
			type: "diagnostic",
			sequence,
			diagnostic,
			...(graphId ? { graphId } : {}),
			...(workItemId ? { itemId: workItemId } : {}),
		}));
	}

	#graphMutation<Result>(graphId: WorkGraphId, operation: () => Promise<Result> | Result): Promise<Result> {
		return this.#durable.mutation(graphId, operation);
	}

	async #appendGraphFacts(graph: GraphRecord, facts: readonly WorkGraphFact[]): Promise<void> {
		await this.#durable.appendFacts(graph, facts);
	}

	async failStopGraph(graphId: WorkGraphId, error: unknown): Promise<void> {
		await this.#persistence.failStopGraph(graphId, error);
	}

	async failStopLedger(error: unknown): Promise<void> {
		await this.#persistence.failStopLedger(error);
	}

	reportPersistenceDiagnostic(code: string, message: string, graphId?: WorkGraphId): void {
		this.#persistence.reportDiagnostic(code, message, graphId);
	}
}
