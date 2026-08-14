import type { AgentInput, RunResult } from "@coda/agent";
import type { JsonValue } from "@coda/ai";
import { createDelegateTool, type DelegateChildSpecification } from "./delegate-tool.ts";
import { MemoryWorkspacePersistence } from "./memory-workspace-persistence.ts";
import type {
	InputResourceReservation,
	OpenCodingAgentOptions,
	WorkGraphStore,
	WorkSessionReservation,
	WorkspaceLedger,
	WorkspaceLedgerRestore,
	WorkspacePersistence,
	WorkspacePersistenceLease,
	WorkspacePlacementReservation,
	WorkspaceSessionOwner,
} from "./ports.ts";
import type {
	AddWorkItemSpecification,
	CodingAgent,
	CodingAgentCloseResult,
	CodingAgentCommandBatch,
	CodingAgentObservation,
	CodingAgentReceipt,
	CodingAgentRejection,
	CodingAgentSnapshot,
	ConfigureWorkItem,
	DeliverWorkItemInput,
	DesiredRuntimeConfiguration,
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
	WorkSessionTarget,
	WorkspaceArtifact,
	WorkspacePlacementDescriptor,
} from "./types.ts";
import { WorkGraphAggregate } from "./work-graph-aggregate.ts";
import { WORK_GRAPH_FACT_VERSION, type WorkGraphFact, type WorkGraphItemDefinition } from "./work-graph-fact.ts";
import { WorkScheduler } from "./work-scheduler.ts";
import {
	INITIAL_WORKER_FACT_PROJECTION,
	type WorkerFact,
	type WorkerFactProjection,
	workerFactHasOpenEffects,
} from "./worker-fact.ts";
import type {
	WorkerBarrierFailure,
	WorkerControlEvent,
	WorkerObservation,
	WorkerSubmission,
} from "./worker-protocol.ts";
import { openPrivateWorkerRuntime, type PrivateWorkerRuntime } from "./worker-runtime.ts";

const TERMINAL_STATES = new Set<WorkItemState>(["succeeded", "failed", "canceled", "interrupted", "blocked"]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

function isTerminal(state: WorkItemState): state is WorkResult["state"] {
	return TERMINAL_STATES.has(state);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const entry of Object.values(value)) deepFreeze(entry);
	return value;
}

function immutableData<T>(value: T): T {
	return deepFreeze(structuredClone(value));
}

function jsonValue(value: unknown): JsonValue {
	const text = JSON.stringify(value);
	if (text === undefined) return null;
	return JSON.parse(text) as JsonValue;
}

function graphId(value: string): WorkGraphId {
	return value as WorkGraphId;
}

function itemId(value: string): WorkItemId {
	return value as WorkItemId;
}

function assertIdentity(value: unknown, kind: "graph" | "item" | "session"): string {
	if (typeof value !== "string" || !ID_PATTERN.test(value)) {
		throw rejected({ code: "invalid_identity", message: `Invalid ${kind} identity: ${String(value)}` });
	}
	return value;
}

function assertObjective(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw rejected({ code: "invalid_command", message: `${label} must not be empty` });
	}
	return value;
}

function assertConfiguration(configuration: DesiredRuntimeConfiguration): void {
	if (
		!configuration ||
		typeof configuration !== "object" ||
		typeof configuration.model?.provider !== "string" ||
		configuration.model.provider.length === 0 ||
		typeof configuration.model.id !== "string" ||
		configuration.model.id.length === 0 ||
		typeof configuration.reasoning !== "string"
	) {
		throw rejected({ code: "invalid_command", message: "Desired Runtime Configuration is invalid" });
	}
}

class SubmissionRejection extends Error {
	readonly rejection: CodingAgentRejection;

	constructor(rejection: CodingAgentRejection) {
		super(rejection.message);
		this.name = "SubmissionRejection";
		this.rejection = rejection;
	}
}

function rejected(rejection: CodingAgentRejection): SubmissionRejection {
	return new SubmissionRejection(rejection);
}

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

interface AdmissionTurn {
	readonly ready: Promise<void>;
	release(): void;
}

class AdmissionOrder {
	#tail: Promise<void> = Promise.resolve();

	reserve(): AdmissionTurn {
		const ready = this.#tail;
		let finish!: () => void;
		const completed = new Promise<void>((resolve) => {
			finish = resolve;
		});
		this.#tail = ready.then(() => completed);
		let released = false;
		return {
			ready,
			release: () => {
				if (released) return;
				released = true;
				finish();
			},
		};
	}
}

interface PendingInput {
	readonly submission: WorkerSubmission;
}

interface InputAdmission {
	readonly deliveryId: string;
	readonly command: DeliverWorkItemInput;
	settlement?: { readonly outcome: "committed" | "failed"; readonly diagnostic?: string };
}

interface ItemRecord {
	readonly id: WorkItemId;
	readonly graphId: WorkGraphId;
	readonly order: number;
	readonly parentId?: WorkItemId;
	readonly dependencies: readonly WorkItemId[];
	readonly objective: string;
	readonly executionMode: "read_only" | "write";
	acceptedAt: number;
	readonly publicationOrder: number;
	readonly runtimeId: string;
	desiredConfiguration: DesiredRuntimeConfiguration;
	state: WorkItemState;
	cancellationRequested: boolean;
	startedAt?: number;
	run?: RunResult;
	result?: WorkResult;
	runtime?: PrivateWorkerRuntime;
	runtimeOpening?: Promise<PrivateWorkerRuntime>;
	runtimeTeardown?: Promise<boolean>;
	controller?: AbortController;
	placement?: WorkspacePlacementReservation;
	session?: WorkSessionReservation;
	sessionId?: string;
	placementDescriptor?: WorkspacePlacementDescriptor;
	readonly diagnostics: WorkDiagnostic[];
	readonly pendingInputs: PendingInput[];
	readonly inputAdmissions: InputAdmission[];
	promptAccepted: boolean;
	promptInput?: WorkerSubmission;
	droppedInputs: number;
	factProjection: WorkerFactProjection;
	barrierFailure?: WorkerBarrierFailure;
	uncertainExternalEffect: boolean;
	active: boolean;
	settling?: Promise<void>;
	resourcesReleased: boolean;
	delegationWaiting: boolean;
	delegationResume?: {
		readonly resolve: () => void;
		readonly reject: (error: unknown) => void;
	};
}

interface GraphRecord {
	readonly id: WorkGraphId;
	readonly order: number;
	readonly objective: string;
	readonly rootId: WorkItemId;
	readonly maximumConcurrency: number;
	acceptedAt: number;
	readonly items: Map<WorkItemId, ItemRecord>;
	readonly itemOrder: ItemRecord[];
	nextItemOrder: number;
	activeConcurrency: number;
	effectiveConcurrency: number;
	cancellationRequested: boolean;
	aggregate: WorkGraphAggregate;
	result?: WorkGraphResult;
	settlement?: Promise<void>;
}

interface DeliveryPlan {
	readonly commandIndex: number;
	readonly deliveryId: string;
	readonly command: DeliverWorkItemInput;
	readonly graph: GraphRecord;
	readonly item: ItemRecord;
	resource?: InputResourceReservation;
}

interface ConfigurationPlan {
	readonly command: ConfigureWorkItem;
	readonly graph: GraphRecord;
	readonly item: ItemRecord;
}

interface CancellationPlan {
	readonly graph: GraphRecord;
	readonly item?: ItemRecord;
}

interface NewItemPlan {
	readonly graph: GraphRecord;
	readonly item: ItemRecord;
	readonly sessionTarget: WorkSessionTarget;
}

interface BatchPlan {
	readonly batchId: string;
	readonly targetGraphId: WorkGraphId;
	readonly newGraphs: GraphRecord[];
	readonly newItems: NewItemPlan[];
	readonly deliveries: DeliveryPlan[];
	readonly configurations: ConfigurationPlan[];
	readonly cancellations: CancellationPlan[];
	readonly graphIds: WorkGraphId[];
	readonly itemIds: WorkItemId[];
}

interface Subscriber {
	readonly capacity: number;
	readonly queue: CodingAgentObservation[];
	readonly waiters: Array<(value: IteratorResult<CodingAgentObservation>) => void>;
	closed: boolean;
	resync: boolean;
}

function makeItem(input: {
	readonly graphId: WorkGraphId;
	readonly itemId: WorkItemId;
	readonly order: number;
	readonly parentId?: WorkItemId;
	readonly dependencies?: readonly WorkItemId[];
	readonly objective: string;
	readonly executionMode: "read_only" | "write";
	readonly configuration: DesiredRuntimeConfiguration;
	readonly acceptedAt: number;
	readonly publicationOrder: number;
	readonly runtimeId: string;
}): ItemRecord {
	return {
		id: input.itemId,
		graphId: input.graphId,
		order: input.order,
		...(input.parentId ? { parentId: input.parentId } : {}),
		dependencies: Object.freeze([...(input.dependencies ?? [])]),
		objective: input.objective,
		executionMode: input.executionMode,
		desiredConfiguration: immutableData(input.configuration),
		acceptedAt: input.acceptedAt,
		publicationOrder: input.publicationOrder,
		runtimeId: input.runtimeId,
		state: "pending",
		cancellationRequested: false,
		diagnostics: [],
		pendingInputs: [],
		inputAdmissions: [],
		promptAccepted: false,
		droppedInputs: 0,
		factProjection: INITIAL_WORKER_FACT_PROJECTION,
		uncertainExternalEffect: false,
		active: false,
		resourcesReleased: false,
		delegationWaiting: false,
	};
}

class WorkCoordinator implements CodingAgent {
	readonly #options: OpenCodingAgentOptions;
	readonly #persistence: WorkspacePersistence;
	#persistenceLease?: WorkspacePersistenceLease;
	#ledger?: WorkspaceLedger;
	readonly #graphStores = new Map<WorkGraphId, WorkGraphStore>();
	readonly #graphFailures = new Map<WorkGraphId, unknown>();
	readonly #graphFailStops = new Map<WorkGraphId, Promise<void>>();
	readonly #graphs = new Map<WorkGraphId, GraphRecord>();
	readonly #graphOrder: GraphRecord[] = [];
	readonly #sessionLeases = new Map<string, { readonly graphId: WorkGraphId; readonly itemId: WorkItemId }>();
	readonly #quarantinedSessionIds = new Set<string>();
	readonly #subscribers = new Set<Subscriber>();
	readonly #capacity: WorkCapacityPolicy;
	readonly #workScheduler: WorkScheduler;
	readonly #mutationFence = new MutationFence();
	readonly #graphMutationFences = new Map<WorkGraphId, MutationFence>();
	readonly #admissionOrder = new AdmissionOrder();
	readonly #submissions = new Set<Promise<CodingAgentReceipt>>();
	#processActiveConcurrency = 0;
	#nextGraphOrder = 0;
	#nextPublicationOrder = 0;
	#sequence = 0;
	#closed = false;
	#closing = false;
	#closeOperation?: Promise<CodingAgentCloseResult>;
	#workerControllerAttached = true;
	#ledgerFailure?: unknown;
	#ledgerFailStop?: Promise<void>;
	readonly #undurableWork = new Map<string, CodingAgentCloseResult["unknownWork"][number]>();
	#scheduling = false;
	#scheduleAgain = false;
	readonly #settlementWaiters: Array<() => void> = [];
	readonly #itemTerminalWaiters: Array<() => void> = [];

	constructor(options: OpenCodingAgentOptions) {
		this.#options = options;
		this.#persistence = options.persistence ?? new MemoryWorkspacePersistence();
		this.#capacity = immutableData(options.capacity);
		this.#workScheduler = new WorkScheduler(this.#capacity);
	}

	async initialize(): Promise<void> {
		const lease = await this.#persistence.acquire();
		this.#persistenceLease = lease;
		this.#ledger = lease.ledger;
		let ledgerRestore: WorkspaceLedgerRestore;
		try {
			ledgerRestore = await lease.ledger.load();
		} catch (error) {
			await lease.close().catch(() => undefined);
			this.#persistenceLease = undefined;
			this.#ledger = undefined;
			throw error;
		}
		this.#nextGraphOrder = ledgerRestore.nextGraphOrder;
		this.#nextPublicationOrder = ledgerRestore.nextPublicationOrder;
		for (const owner of ledgerRestore.sessionOwners) {
			this.#sessionLeases.set(owner.sessionId, { graphId: owner.graphId, itemId: owner.itemId });
		}
		for (const entry of [...ledgerRestore.activeGraphs].sort((left, right) => left.order - right.order)) {
			try {
				const store = await lease.openGraph(entry.graphId);
				this.#graphStores.set(entry.graphId, store);
				const restored = await store.load();
				for (const diagnostic of restored.diagnostics) {
					this.#diagnose({ code: "work_graph_recovery", message: diagnostic }, entry.graphId);
				}
				const aggregate = WorkGraphAggregate.replay(restored.facts);
				const graph = this.#restoreAggregate(aggregate);
				if (graph.id !== entry.graphId || graph.order !== entry.order) {
					throw new Error(`Workspace Ledger index does not match Work Graph ${entry.graphId}`);
				}
				this.#graphs.set(graph.id, graph);
				this.#graphOrder.push(graph);
			} catch (error) {
				this.#graphFailures.set(entry.graphId, error);
				this.#diagnose(
					{ code: "work_graph_recovery_failed", message: errorMessage(error).slice(0, 512) },
					entry.graphId,
				);
			}
		}
		if (this.#graphOrder.length === 0) return;
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
		for (const graph of this.#graphOrder) {
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

		this.#graphOrder.sort((left, right) => left.order - right.order);
		this.#nextGraphOrder = Math.max(this.#nextGraphOrder, 0, ...this.#graphOrder.map((graph) => graph.order + 1));
		for (const graph of this.#graphOrder) graph.itemOrder.sort((left, right) => left.order - right.order);
		this.#nextPublicationOrder = Math.max(
			this.#nextPublicationOrder,
			0,
			...this.#graphOrder.flatMap((graph) => graph.itemOrder.map((item) => item.publicationOrder + 1)),
		);
		await this.#reconcileWorkspaceSessionOwners(ledgerRestore);
		const uncertainPublicationTargets = new Set<string>();
		for (const graph of this.#graphOrder) {
			for (const item of graph.itemOrder) {
				if (!openPublications.has(itemKey(graph.id, item.id))) continue;
				const targetPlacementId = item.placementDescriptor?.targetPlacementId;
				if (targetPlacementId) uncertainPublicationTargets.add(targetPlacementId);
			}
		}
		for (const graph of this.#graphOrder) {
			if (graph.result) {
				await this.#archiveDurableGraph(graph);
				continue;
			}
			for (const item of graph.itemOrder) {
				if (item.result) continue;
				const key = itemKey(graph.id, item.id);
				const reasons: string[] = [];
				if (item.state === "preparing" || item.state === "running" || item.state === "settling") {
					reasons.push(`uncertain_${item.state}`);
				}
				if (item.factProjection.openAttempts.length > 0) reasons.push("unclosed_model_attempt");
				if (item.factProjection.openTools.length > 0) reasons.push("unclosed_tool_invocation");
				if (openPublications.has(key)) reasons.push("unclosed_publication");
				const targetPlacementId = item.placementDescriptor?.targetPlacementId;
				if (targetPlacementId && uncertainPublicationTargets.has(targetPlacementId)) {
					reasons.push("uncertain_publication_target");
				}
				reasons.push(...(resourceRecoveryFailures.get(key) ?? []));
				if (isTerminal(item.state)) reasons.push("terminal_without_result");
				if (reasons.length > 0) {
					await this.#markRecoveredInterrupted(graph, item, reasons, publicationArtifacts.get(key));
					continue;
				}
				try {
					const expectedTargetIdentity = targetPlacementId
						? (settledTargetIdentities.get(targetPlacementId) ?? item.placementDescriptor?.targetIdentity)
						: undefined;
					await this.#recoverOwnership(graph, item, expectedTargetIdentity);
				} catch (error) {
					await this.#markRecoveredInterrupted(graph, item, ["ownership_recovery_failed", errorMessage(error)]);
				}
			}
			await this.#trySettleGraph(graph);
		}
		this.#requestSchedule();
	}

	async abortInitialization(): Promise<void> {
		await this.#persistenceLease?.close().catch(() => undefined);
		this.#persistenceLease = undefined;
		this.#ledger = undefined;
	}

	async #reconcileWorkspaceSessionOwners(ledgerRestore: WorkspaceLedgerRestore): Promise<void> {
		const durableOwners = new Map(ledgerRestore.sessionOwners.map((owner) => [owner.sessionId, owner]));
		for (const graph of this.#graphOrder) {
			if (graph.result) continue;
			const expectedOwners = new Map<string, WorkspaceSessionOwner>();
			for (const item of graph.itemOrder) {
				if (!item.sessionId || item.resourcesReleased) continue;
				expectedOwners.set(item.sessionId, {
					sessionId: item.sessionId,
					graphId: graph.id,
					itemId: item.id,
				});
			}
			for (const owner of ledgerRestore.sessionOwners.filter((candidate) => candidate.graphId === graph.id)) {
				if (expectedOwners.has(owner.sessionId)) continue;
				await this.#releaseWorkspaceSession(owner);
				durableOwners.delete(owner.sessionId);
				const current = this.#sessionLeases.get(owner.sessionId);
				if (current?.graphId === owner.graphId && current.itemId === owner.itemId) {
					this.#sessionLeases.delete(owner.sessionId);
				}
			}
			const missing: WorkspaceSessionOwner[] = [];
			for (const owner of expectedOwners.values()) {
				const durable = durableOwners.get(owner.sessionId);
				if (durable && (durable.graphId !== owner.graphId || durable.itemId !== owner.itemId)) {
					throw new Error(`Workspace Ledger Session owner conflicts with active Work Graph: ${owner.sessionId}`);
				}
				if (!durable) missing.push(owner);
				this.#sessionLeases.set(owner.sessionId, { graphId: owner.graphId, itemId: owner.itemId });
			}
			if (missing.length > 0) {
				await this.#acceptWorkspaceSessionOwners(missing);
				for (const owner of missing) durableOwners.set(owner.sessionId, owner);
			}
		}
	}

	#restoreAggregate(aggregate: WorkGraphAggregate): GraphRecord {
		const snapshot = aggregate.snapshot().graph;
		if (!snapshot) throw new Error("Active Work Graph store has no graph_accepted Fact");
		if (snapshot.maximumConcurrency > this.#capacity.graphMaximumConcurrency) {
			throw new Error(`Restored Work Graph exceeds the configured Graph capacity: ${snapshot.graphId}`);
		}
		const graph: GraphRecord = {
			id: snapshot.graphId,
			order: snapshot.order,
			objective: snapshot.objective,
			rootId: snapshot.rootItemId,
			maximumConcurrency: snapshot.maximumConcurrency,
			acceptedAt: snapshot.acceptedAt,
			items: new Map(),
			itemOrder: [],
			nextItemOrder: snapshot.items.length,
			activeConcurrency: 0,
			effectiveConcurrency: snapshot.result?.effectiveConcurrency ?? 0,
			cancellationRequested: snapshot.cancellationRequested,
			aggregate,
			...(snapshot.result ? { result: snapshot.result } : {}),
		};
		for (const state of [...snapshot.items].sort((left, right) => left.order - right.order)) {
			const item = makeItem({
				graphId: graph.id,
				itemId: state.itemId,
				order: state.order,
				...(state.parentItemId ? { parentId: state.parentItemId } : {}),
				dependencies: state.dependencies,
				objective: state.objective,
				executionMode: state.executionMode,
				configuration: state.desiredConfiguration,
				acceptedAt: state.acceptedAt,
				publicationOrder: state.publicationOrder,
				runtimeId: state.runtimeId,
			});
			item.sessionId = state.sessionId;
			item.placementDescriptor = state.placement;
			item.state = state.state;
			item.cancellationRequested = state.cancellationRequested;
			item.startedAt = state.startedAt;
			item.factProjection = state.worker;
			item.resourcesReleased = state.ownershipReleased !== undefined;
			item.promptAccepted = state.inputs.some(({ kind }) => kind === "prompt");
			if (state.result) {
				item.result = state.result;
				item.diagnostics.push(...state.result.diagnostics);
			} else {
				for (const input of state.inputs) {
					const command: DeliverWorkItemInput = {
						type: "deliver_work_item_input",
						graphId: graph.id,
						itemId: item.id,
						kind: input.kind,
						input: input.input,
						...(input.resourceReferences.length > 0 ? { resources: input.resourceReferences } : {}),
					};
					item.inputAdmissions.push({
						deliveryId: input.deliveryId,
						command,
						...(input.settlement === "pending"
							? {}
							: {
									settlement: {
										outcome: input.settlement,
										...(input.diagnostic ? { diagnostic: input.diagnostic } : {}),
									},
								}),
					});
				}
				this.#drainInputAdmissions(item);
			}
			graph.items.set(item.id, item);
			graph.itemOrder.push(item);
		}
		return graph;
	}

	async #recoverOwnership(graph: GraphRecord, item: ItemRecord, expectedTargetIdentity?: string): Promise<void> {
		if (!item.sessionId || !item.placementDescriptor) throw new Error("Persisted Work ownership is incomplete");
		let placement: WorkspacePlacementReservation | undefined;
		let session: WorkSessionReservation | undefined;
		try {
			placement = await this.#options.workspaceExecution.recover({
				graphId: graph.id,
				itemId: item.id,
				...(item.parentId ? { parentItemId: item.parentId } : {}),
				placement: item.placementDescriptor,
				mode: item.executionMode,
				sourceOrder: item.order,
				publicationOrder: item.publicationOrder,
				...(expectedTargetIdentity ? { expectedTargetIdentity } : {}),
			});
			session = await this.#options.sessions.reserve({
				graphId: graph.id,
				itemId: item.id,
				...(item.parentId ? { parentItemId: item.parentId } : {}),
				target: { type: "resume", sessionId: item.sessionId },
				placement: placement.placement,
			});
			if (String(session.session.id) !== item.sessionId) {
				throw new Error(
					`Recovered Session identity changed from ${item.sessionId} to ${String(session.session.id)}`,
				);
			}
			const currentOwner = this.#sessionLeases.get(item.sessionId);
			if (currentOwner && (currentOwner.graphId !== graph.id || currentOwner.itemId !== item.id)) {
				throw new Error(`Recovered Session is already leased: ${item.sessionId}`);
			}
			await placement.commit();
			await session.commit();
			item.placement = placement;
			item.session = session;
			this.#sessionLeases.set(item.sessionId, { graphId: graph.id, itemId: item.id });
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
		const from = item.state;
		await this.#appendGraphFacts(graph, [
			{
				version: WORK_GRAPH_FACT_VERSION,
				type: "recovery_interrupted",
				graphId: graph.id,
				itemId: item.id,
				timestamp: Math.max(this.#options.clock.now(), graph.aggregate.snapshot().lastTimestamp ?? 0),
				from,
				reasons: [...reasons],
				...(artifact ? { artifact } : {}),
			},
		]);
		const state = graph.aggregate.snapshot().graph!.items.find(({ itemId }) => itemId === item.id)!;
		item.state = state.state;
		item.resourcesReleased = true;
		item.result = state.result;
		item.diagnostics.splice(0, item.diagnostics.length, ...(state.result?.diagnostics ?? []));
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

	submit(batch: CodingAgentCommandBatch): Promise<CodingAgentReceipt> {
		const operation = this.#submit(batch);
		this.#submissions.add(operation);
		void operation.then(
			() => this.#submissions.delete(operation),
			() => this.#submissions.delete(operation),
		);
		return operation;
	}

	observe(options: ObservationOptions = {}): AsyncIterable<CodingAgentObservation> {
		const capacity = options.capacity ?? 256;
		if (!Number.isSafeInteger(capacity) || capacity < 1) {
			throw new Error("Observation capacity must be a positive safe integer");
		}
		const coordinator = this;
		return Object.freeze({
			async *[Symbol.asyncIterator]() {
				const subscriber: Subscriber = {
					capacity,
					queue: [],
					waiters: [],
					closed: false,
					resync: false,
				};
				coordinator.#subscribers.add(subscriber);
				try {
					yield immutableData({
						type: "snapshot",
						sequence: coordinator.#sequence,
						snapshot: coordinator.#snapshot(),
					} satisfies CodingAgentObservation);
					while (true) {
						const next = await coordinator.#nextObservation(subscriber);
						if (next.done) return;
						yield next.value;
						if (next.value.type === "resync_required" || next.value.type === "closed") return;
					}
				} finally {
					coordinator.#removeSubscriber(subscriber);
				}
			},
		});
	}

	close(): Promise<CodingAgentCloseResult> {
		if (this.#closeOperation) return this.#closeOperation;
		this.#closing = true;
		const operation = this.#close();
		this.#closeOperation = operation;
		return operation;
	}

	async #submit(batch: CodingAgentCommandBatch): Promise<CodingAgentReceipt> {
		const batchId =
			typeof batch?.batchId === "string" && ID_PATTERN.test(batch.batchId)
				? batch.batchId
				: `batch:${this.#options.idGenerator.generate("queue_item")}`;
		if (this.#closing || this.#closed) {
			return immutableData({
				status: "rejected",
				batchId,
				rejection: { code: "closed", message: "Coding Agent is closing or closed" },
			});
		}
		if (this.#ledgerFailure) {
			return immutableData({
				status: "rejected",
				batchId,
				rejection: {
					code: "ledger_failed",
					message: `Workspace Ledger persistence is unavailable: ${errorMessage(this.#ledgerFailure)}`,
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

		const admission = this.#admissionOrder.reserve();
		let plan: BatchPlan | undefined;
		let durablyAccepted = false;
		let sequence = 0;
		try {
			plan = await this.#mutationFence.run(() => this.#plan(batch, batchId));
			await this.#validateConfigurations(plan);
			await this.#reserve(plan);
			await this.#commitOwnershipReservations(plan);
			await admission.ready;
			await this.#mutationFence.run(() =>
				this.#graphMutation(plan!.targetGraphId, async () => {
					this.#revalidate(plan!);
					const graph = plan!.newGraphs[0] ?? this.#graphs.get(plan!.targetGraphId)!;
					if (plan!.newGraphs.length === 0 && plan!.newItems.length > 0) {
						await this.#acceptWorkspaceGraphs(plan!);
					}
					await this.#appendGraphFacts(graph, this.#acceptedFacts(plan!));
					if (plan!.newGraphs.length > 0) {
						await this.#graphStores.get(plan!.targetGraphId)!.flush();
						await this.#acceptWorkspaceGraphs(plan!);
					}
					durablyAccepted = true;
					this.#accept(plan!);
					this.#acceptInputAdmissions(plan!);
					this.#acceptOperations(plan!);
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
				await this.#rollbackReservations(plan);
			}
			admission.release();
			if (durablyAccepted && plan) {
				this.#requestSchedule();
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
					: this.#ledgerFailure
						? { code: "ledger_failed" as const, message: errorMessage(error) }
						: { code: "graph_store_failed" as const, message: errorMessage(error), graphId: plan?.targetGraphId };
			this.#requestSchedule();
			return immutableData({ status: "rejected", batchId, rejection });
		}
		if (!plan) throw new Error("Accepted command batch has no plan");
		admission.release();
		this.#requestSchedule();

		// The atomic Fact segment plus any required Ledger index is the durable
		// acceptance point. Later bookkeeping cannot turn it into a rejection.
		try {
			await this.#applyAcceptedOperations(plan);
		} catch (error) {
			this.#diagnose({ code: "accepted_operation_failed", message: errorMessage(error) });
		}
		try {
			await this.#settleAcceptedInputResources(plan);
		} catch (error) {
			this.#diagnose({ code: "input_resource_settlement_failed", message: errorMessage(error) });
		}
		this.#requestSchedule();
		return immutableData({
			status: "accepted",
			batchId,
			sequence,
			graphIds: plan.graphIds,
			itemIds: plan.itemIds,
		});
	}

	#plan(batch: CodingAgentCommandBatch, batchId: string): BatchPlan {
		const now = this.#options.clock.now();
		const newGraphs: GraphRecord[] = [];
		const newItems: NewItemPlan[] = [];
		const deliveries: DeliveryPlan[] = [];
		const configurations: ConfigurationPlan[] = [];
		const cancellations: CancellationPlan[] = [];
		const graphIds: WorkGraphId[] = [];
		const itemIds: WorkItemId[] = [];
		const targetGraphIds = new Set<WorkGraphId>();
		const graphs = new Map(this.#graphs);
		const itemViews = new Map<WorkGraphId, Map<WorkItemId, ItemRecord>>();
		const view = (graph: GraphRecord): Map<WorkItemId, ItemRecord> => {
			let items = itemViews.get(graph.id);
			if (!items) {
				items = new Map(graph.items);
				itemViews.set(graph.id, items);
			}
			return items;
		};
		const findGraph = (value: string, commandIndex: number): GraphRecord => {
			const id = graphId(assertIdentity(value, "graph"));
			const persistenceFailure = this.#graphFailures.get(id);
			if (persistenceFailure) {
				throw rejected({
					code: "graph_store_failed",
					message: `Work Graph persistence is unavailable: ${errorMessage(persistenceFailure)}`,
					commandIndex,
					graphId: id,
				});
			}
			const graph = graphs.get(id);
			if (!graph) {
				throw rejected({
					code: "graph_not_found",
					message: `Work Graph not found: ${id}`,
					commandIndex,
					graphId: id,
				});
			}
			targetGraphIds.add(id);
			return graph;
		};
		const findItem = (graph: GraphRecord, value: string, commandIndex: number): ItemRecord => {
			const id = itemId(assertIdentity(value, "item"));
			const item = view(graph).get(id);
			if (!item) {
				throw rejected({
					code: "item_not_found",
					message: `Work Item not found: ${id}`,
					commandIndex,
					graphId: graph.id,
					itemId: id,
				});
			}
			return item;
		};

		for (const [commandIndex, command] of batch.commands.entries()) {
			if (!command || typeof command !== "object" || typeof command.type !== "string") {
				throw rejected({
					code: "invalid_command",
					message: "Command must be a discriminated object",
					commandIndex,
				});
			}
			switch (command.type) {
				case "start_work_graph": {
					const id = graphId(
						command.graphId === undefined
							? `graph:${this.#options.idGenerator.generate("queue_item")}`
							: assertIdentity(String(command.graphId), "graph"),
					);
					if (graphs.has(id)) {
						throw rejected({
							code: "duplicate_identity",
							message: `Duplicate Work Graph identity: ${id}`,
							commandIndex,
							graphId: id,
						});
					}
					const persistenceFailure = this.#graphFailures.get(id);
					if (persistenceFailure) {
						throw rejected({
							code: "graph_store_failed",
							message: `Work Graph persistence is unavailable: ${errorMessage(persistenceFailure)}`,
							commandIndex,
							graphId: id,
						});
					}
					targetGraphIds.add(id);
					const rootId = itemId(assertIdentity(String(command.root?.itemId), "item"));
					if (
						!Number.isSafeInteger(command.maximumConcurrency) ||
						command.maximumConcurrency < 1 ||
						command.maximumConcurrency > this.#capacity.graphMaximumConcurrency
					) {
						throw rejected({
							code: "invalid_command",
							message: `maximumConcurrency must be between 1 and ${this.#capacity.graphMaximumConcurrency}`,
							commandIndex,
						});
					}
					if (command.root.executionMode !== "read_only" && command.root.executionMode !== "write") {
						throw rejected({
							code: "invalid_command",
							message: "Invalid Work Item execution mode",
							commandIndex,
						});
					}
					assertConfiguration(command.configuration);
					const objective = assertObjective(command.objective, "Work Graph objective");
					const rootObjective = assertObjective(command.root.objective ?? objective, "Root Work Item objective");
					if (
						!command.session ||
						(command.session.type !== "create" && command.session.type !== "resume") ||
						(command.session.sessionId !== undefined &&
							!ID_PATTERN.test(assertIdentity(command.session.sessionId, "session")))
					) {
						throw rejected({ code: "invalid_command", message: "Invalid Session target", commandIndex });
					}
					if (command.session.type === "resume" && !command.session.sessionId) {
						throw rejected({
							code: "invalid_command",
							message: "A resume target requires a Session identity",
							commandIndex,
						});
					}
					const graph: GraphRecord = {
						id,
						order: this.#nextGraphOrder++,
						objective,
						rootId,
						maximumConcurrency: command.maximumConcurrency,
						acceptedAt: now,
						items: new Map(),
						itemOrder: [],
						nextItemOrder: 1,
						activeConcurrency: 0,
						effectiveConcurrency: 0,
						cancellationRequested: false,
						aggregate: WorkGraphAggregate.empty(),
					};
					const root = makeItem({
						graphId: id,
						itemId: rootId,
						order: 0,
						objective: rootObjective,
						executionMode: command.root.executionMode,
						configuration: command.configuration,
						acceptedAt: now,
						publicationOrder: this.#nextPublicationOrder++,
						runtimeId: `worker:${id}:${rootId}:${this.#options.idGenerator.generate("queue_item")}`,
					});
					graphs.set(id, graph);
					view(graph).set(rootId, root);
					newGraphs.push(graph);
					newItems.push({ graph, item: root, sessionTarget: immutableData(command.session) });
					graphIds.push(id);
					itemIds.push(rootId);
					break;
				}
				case "add_work_items": {
					const graph = findGraph(String(command.graphId), commandIndex);
					if (graph.result || graph.cancellationRequested || command.items.length === 0) {
						throw rejected({
							code: "invalid_state",
							message: graph.result
								? "Work Graph is already settled"
								: "AddWorkItems requires an active graph and items",
							commandIndex,
							graphId: graph.id,
						});
					}
					for (const specification of command.items) {
						this.#planAddedItem({
							graph,
							specification,
							commandIndex,
							items: view(graph),
							now,
							newItems,
							itemIds,
						});
					}
					if (!graphIds.includes(graph.id)) graphIds.push(graph.id);
					break;
				}
				case "deliver_work_item_input": {
					const graph = findGraph(String(command.graphId), commandIndex);
					const item = findItem(graph, String(command.itemId), commandIndex);
					if (isTerminal(item.state) || item.cancellationRequested) {
						throw rejected({
							code: "invalid_state",
							message: `Work Item ${item.id} cannot accept input in ${item.state}`,
							commandIndex,
							graphId: graph.id,
							itemId: item.id,
						});
					}
					if (!(["prompt", "steering", "follow_up"] as const).includes(command.kind)) {
						throw rejected({ code: "invalid_command", message: "Invalid Work Item input kind", commandIndex });
					}
					if (
						command.kind === "prompt" &&
						(item.promptAccepted ||
							item.runtime !== undefined ||
							item.state === "running" ||
							item.state === "settling" ||
							deliveries.some((candidate) => candidate.item === item && candidate.command.kind === "prompt"))
					) {
						throw rejected({
							code: "invalid_state",
							message: `Work Item ${item.id} already owns its Prompt input`,
							commandIndex,
							graphId: graph.id,
							itemId: item.id,
						});
					}
					deliveries.push({
						commandIndex,
						deliveryId: `${batchId}:${commandIndex}`,
						command: immutableData(command),
						graph,
						item,
					});
					break;
				}
				case "configure_work_item": {
					const graph = findGraph(String(command.graphId), commandIndex);
					const item = findItem(graph, String(command.itemId), commandIndex);
					if (isTerminal(item.state) || item.cancellationRequested) {
						throw rejected({
							code: "invalid_state",
							message: `Work Item ${item.id} cannot be configured in ${item.state}`,
							commandIndex,
							graphId: graph.id,
							itemId: item.id,
						});
					}
					assertConfiguration(command.configuration);
					configurations.push({ command: immutableData(command), graph, item });
					break;
				}
				case "cancel_work": {
					if (command.target?.type === "graph") {
						const graph = findGraph(String(command.target.graphId), commandIndex);
						cancellations.push({ graph });
					} else if (command.target?.type === "item") {
						const graph = findGraph(String(command.target.graphId), commandIndex);
						cancellations.push({ graph, item: findItem(graph, String(command.target.itemId), commandIndex) });
					} else {
						throw rejected({ code: "invalid_command", message: "Invalid cancellation target", commandIndex });
					}
					break;
				}
				default:
					throw rejected({
						code: "invalid_command",
						message: `Unknown Coding Agent command: ${String((command as { type?: unknown }).type)}`,
						commandIndex,
					});
			}
		}
		for (const [id, items] of itemViews) this.#assertAcyclic(id, items);
		if (targetGraphIds.size !== 1) {
			throw rejected({
				code: "invalid_command",
				message: "One command batch must target exactly one Work Graph",
			});
		}
		const targetGraphId = [...targetGraphIds][0]!;
		if (!graphIds.includes(targetGraphId)) graphIds.push(targetGraphId);
		return {
			batchId,
			targetGraphId,
			newGraphs,
			newItems,
			deliveries,
			configurations,
			cancellations,
			graphIds,
			itemIds,
		};
	}

	#planAddedItem(input: {
		readonly graph: GraphRecord;
		readonly specification: AddWorkItemSpecification;
		readonly commandIndex: number;
		readonly items: Map<WorkItemId, ItemRecord>;
		readonly now: number;
		readonly newItems: NewItemPlan[];
		readonly itemIds: WorkItemId[];
	}): void {
		const { graph, specification, commandIndex, items } = input;
		const id = itemId(assertIdentity(String(specification.itemId), "item"));
		if (items.has(id)) {
			throw rejected({
				code: "duplicate_identity",
				message: `Duplicate Work Item identity: ${id}`,
				commandIndex,
				graphId: graph.id,
				itemId: id,
			});
		}
		const parentId = itemId(assertIdentity(String(specification.parentItemId), "item"));
		const parent = items.get(parentId);
		if (!parent) {
			throw rejected({
				code: "missing_parent",
				message: `Parent Work Item not found: ${parentId}`,
				commandIndex,
				graphId: graph.id,
				itemId: id,
			});
		}
		if (parent.state === "settling" || isTerminal(parent.state) || parent.cancellationRequested) {
			throw rejected({
				code: "invalid_state",
				message: `Parent Work Item ${parentId} no longer permits delegation`,
				commandIndex,
				graphId: graph.id,
				itemId: id,
			});
		}
		if (specification.executionMode !== "read_only" && specification.executionMode !== "write") {
			throw rejected({ code: "invalid_command", message: "Invalid Work Item execution mode", commandIndex });
		}
		const dependencies: WorkItemId[] = [];
		const seen = new Set<WorkItemId>();
		for (const value of specification.dependencies ?? []) {
			const dependencyId = itemId(assertIdentity(String(value), "item"));
			if (dependencyId === id || seen.has(dependencyId)) {
				throw rejected({
					code: dependencyId === id ? "dependency_cycle" : "duplicate_identity",
					message:
						dependencyId === id
							? `Work Item ${id} cannot depend on itself`
							: `Duplicate dependency: ${dependencyId}`,
					commandIndex,
					graphId: graph.id,
					itemId: id,
				});
			}
			if (!items.has(dependencyId)) {
				throw rejected({
					code: "missing_dependency",
					message: `Dependency Work Item not found or not earlier in this batch: ${dependencyId}`,
					commandIndex,
					graphId: graph.id,
					itemId: id,
				});
			}
			seen.add(dependencyId);
			dependencies.push(dependencyId);
		}
		const configuration = specification.configuration ?? parent.desiredConfiguration;
		assertConfiguration(configuration);
		const item = makeItem({
			graphId: graph.id,
			itemId: id,
			order: graph.nextItemOrder++,
			parentId,
			dependencies,
			objective: assertObjective(specification.objective, "Work Item objective"),
			executionMode: specification.executionMode,
			configuration,
			acceptedAt: input.now,
			publicationOrder: this.#nextPublicationOrder++,
			runtimeId: `worker:${graph.id}:${id}:${this.#options.idGenerator.generate("queue_item")}`,
		});
		items.set(id, item);
		input.newItems.push({
			graph,
			item,
			sessionTarget: {
				type: "create",
				sessionId: `session:${graph.id}:${id}:${this.#options.idGenerator.generate("queue_item")}`,
			},
		});
		input.itemIds.push(id);
	}

	#assertAcyclic(id: WorkGraphId, items: ReadonlyMap<WorkItemId, ItemRecord>): void {
		const visiting = new Set<WorkItemId>();
		const visited = new Set<WorkItemId>();
		const visit = (item: ItemRecord): void => {
			if (visited.has(item.id)) return;
			if (visiting.has(item.id)) {
				throw rejected({
					code: "dependency_cycle",
					message: `Dependency cycle detected at Work Item ${item.id}`,
					graphId: id,
					itemId: item.id,
				});
			}
			visiting.add(item.id);
			for (const dependencyId of item.dependencies) {
				const dependency = items.get(dependencyId);
				if (dependency) visit(dependency);
			}
			visiting.delete(item.id);
			visited.add(item.id);
		};
		for (const item of items.values()) visit(item);
	}

	async #validateConfigurations(plan: BatchPlan): Promise<void> {
		try {
			for (const { item } of plan.newItems) await this.#options.resolveConfiguration(item.desiredConfiguration);
			for (const { command } of plan.configurations) await this.#options.resolveConfiguration(command.configuration);
		} catch (error) {
			throw rejected({
				code: "resource_reservation_failed",
				message: `Runtime configuration failed: ${errorMessage(error)}`,
			});
		}
	}

	async #reserve(plan: BatchPlan): Promise<void> {
		const batchSessions = new Set<string>();
		for (const entry of plan.newItems) {
			const parent = entry.item.parentId
				? (plan.newItems.find(
						(candidate) => candidate.graph.id === entry.graph.id && candidate.item.id === entry.item.parentId,
					)?.item ?? entry.graph.items.get(entry.item.parentId))
				: undefined;
			try {
				entry.item.placement = await this.#options.workspaceExecution.reserve({
					graphId: entry.graph.id,
					itemId: entry.item.id,
					...(entry.item.parentId ? { parentItemId: entry.item.parentId } : {}),
					...(parent?.placement ? { parent: parent.placement.placement } : {}),
					mode: entry.item.executionMode,
					sourceOrder: entry.item.order,
					publicationOrder: entry.item.publicationOrder,
				});
			} catch (error) {
				throw rejected({
					code: "placement_reservation_failed",
					message: `Workspace Placement reservation failed for ${entry.item.id}: ${errorMessage(error)}`,
					graphId: entry.graph.id,
					itemId: entry.item.id,
				});
			}
			try {
				entry.item.session = await this.#options.sessions.reserve({
					graphId: entry.graph.id,
					itemId: entry.item.id,
					...(entry.item.parentId ? { parentItemId: entry.item.parentId } : {}),
					target: entry.sessionTarget,
					placement: entry.item.placement.placement,
				});
			} catch (error) {
				throw rejected({
					code: "session_reservation_failed",
					message: `Session reservation failed for ${entry.item.id}: ${errorMessage(error)}`,
					graphId: entry.graph.id,
					itemId: entry.item.id,
				});
			}
			const sessionId = assertIdentity(String(entry.item.session.session.id), "session");
			entry.item.sessionId = sessionId;
			entry.item.placementDescriptor = entry.item.placement.placement;
			if (this.#sessionLeases.has(sessionId) || batchSessions.has(sessionId)) {
				throw rejected({
					code: "session_leased",
					message: `Session is already leased by another Work Item: ${sessionId}`,
					graphId: entry.graph.id,
					itemId: entry.item.id,
				});
			}
			batchSessions.add(sessionId);
		}
		for (const delivery of plan.deliveries) {
			if ((delivery.command.resources?.length ?? 0) === 0) continue;
			if (!this.#options.resources) {
				throw rejected({
					code: "resource_reservation_failed",
					message: "Input resources were supplied but no resource store is configured",
					graphId: delivery.graph.id,
					itemId: delivery.item.id,
				});
			}
			try {
				delivery.resource = await this.#options.resources.reserve({
					graphId: delivery.graph.id,
					itemId: delivery.item.id,
					input: delivery.command.input,
					references: delivery.command.resources ?? [],
				});
			} catch (error) {
				throw rejected({
					code: "resource_reservation_failed",
					message: `Input resource reservation failed: ${errorMessage(error)}`,
					graphId: delivery.graph.id,
					itemId: delivery.item.id,
				});
			}
		}
	}

	#revalidate(plan: BatchPlan): void {
		const newGraphIds = new Set(plan.newGraphs.map(({ id }) => id));
		for (const graph of plan.newGraphs) {
			if (this.#graphs.has(graph.id)) {
				throw rejected({
					code: "duplicate_identity",
					message: `Work Graph ${graph.id} was accepted by an earlier batch`,
					graphId: graph.id,
				});
			}
		}
		for (const entry of plan.newItems) {
			if (!newGraphIds.has(entry.graph.id)) {
				if (this.#graphs.get(entry.graph.id) !== entry.graph || entry.graph.items.has(entry.item.id)) {
					throw rejected({
						code: "duplicate_identity",
						message: `Work Item ${entry.item.id} was accepted by an earlier batch`,
						graphId: entry.graph.id,
						itemId: entry.item.id,
					});
				}
			}
			if (entry.graph.result || entry.graph.cancellationRequested) {
				throw rejected({
					code: "invalid_state",
					message: `Work Graph ${entry.graph.id} settled while the batch was reserving resources`,
					graphId: entry.graph.id,
					itemId: entry.item.id,
				});
			}
			if (entry.item.sessionId && this.#sessionLeases.has(entry.item.sessionId)) {
				throw rejected({
					code: "session_leased",
					message: `Session was leased by an earlier batch: ${entry.item.sessionId}`,
					graphId: entry.graph.id,
					itemId: entry.item.id,
				});
			}
			if (!entry.item.parentId) continue;
			const parent =
				plan.newItems.find(
					(candidate) => candidate.graph.id === entry.graph.id && candidate.item.id === entry.item.parentId,
				)?.item ?? entry.graph.items.get(entry.item.parentId);
			if (!parent || parent.state === "settling" || isTerminal(parent.state) || parent.cancellationRequested) {
				throw rejected({
					code: "invalid_state",
					message: `Parent Work Item ${entry.item.parentId} settled while the batch was reserving resources`,
					graphId: entry.graph.id,
					itemId: entry.item.id,
				});
			}
		}
		for (const delivery of plan.deliveries) {
			const { graph, item, command, commandIndex } = delivery;
			if (
				graph.result ||
				graph.cancellationRequested ||
				item.state === "settling" ||
				isTerminal(item.state) ||
				item.cancellationRequested
			) {
				throw rejected({
					code: "invalid_state",
					message: `Work Item ${item.id} changed state while the batch was reserving resources`,
					commandIndex,
					graphId: graph.id,
					itemId: item.id,
				});
			}
			if (
				command.kind === "prompt" &&
				(item.promptAccepted ||
					item.runtime !== undefined ||
					item.state === "preparing" ||
					item.state === "running")
			) {
				throw rejected({
					code: "invalid_state",
					message: `Work Item ${item.id} already owns its Prompt input`,
					commandIndex,
					graphId: graph.id,
					itemId: item.id,
				});
			}
		}
		for (const { graph, item, command } of plan.configurations) {
			if (
				graph.result ||
				graph.cancellationRequested ||
				item.state === "settling" ||
				isTerminal(item.state) ||
				item.cancellationRequested
			) {
				throw rejected({
					code: "invalid_state",
					message: `Work Item ${item.id} changed state while the batch was validating configuration`,
					graphId: graph.id,
					itemId: item.id,
				});
			}
			assertConfiguration(command.configuration);
		}
	}

	async #commitOwnershipReservations(plan: BatchPlan): Promise<void> {
		try {
			for (const entry of plan.newItems) await entry.item.placement?.commit();
			for (const entry of plan.newItems) await entry.item.session?.commit();
		} catch (error) {
			throw rejected({
				code: "resource_reservation_failed",
				message: `Reservation commit failed: ${errorMessage(error)}`,
			});
		}
	}

	async #settleAcceptedInputResources(plan: BatchPlan): Promise<void> {
		await Promise.all(
			plan.deliveries
				.filter(({ command }) => (command.resources?.length ?? 0) > 0)
				.map((delivery) => this.#settleAcceptedInputResource(delivery)),
		);
	}

	async #settleAcceptedInputResource(delivery: DeliveryPlan): Promise<void> {
		let outcome: "committed" | "failed" = "committed";
		let diagnostic: string | undefined;
		try {
			if (!delivery.resource) throw new Error("Accepted input has no resource reservation");
			// Resource I/O is intentionally outside the Coordinator mutation fence.
			await delivery.resource.commit();
		} catch (error) {
			outcome = "failed";
			diagnostic = errorMessage(error);
		}

		let failures: readonly string[] = [];
		try {
			failures = await this.#graphMutation(delivery.graph.id, async () => {
				await this.#appendGraphFacts(delivery.graph, [
					{
						version: WORK_GRAPH_FACT_VERSION,
						type: "input_resources_settled",
						graphId: delivery.graph.id,
						itemId: delivery.item.id,
						deliveryId: delivery.deliveryId,
						outcome,
						timestamp: Math.max(
							this.#options.clock.now(),
							delivery.graph.aggregate.snapshot().lastTimestamp ?? 0,
						),
						...(outcome === "failed" ? { diagnostic: diagnostic ?? "Input resource commit failed" } : {}),
					},
				]);
				return this.#settleInputAdmission(delivery.item, delivery.deliveryId, outcome, diagnostic);
			});
		} catch (error) {
			this.#diagnose(
				{
					code: "input_resource_settlement_unknown",
					message: `Input resource settlement was not persisted: ${errorMessage(error)}`,
				},
				delivery.graph.id,
				delivery.item.id,
			);
			return;
		}

		if (failures.length > 0) await this.#interruptForInputResourceFailure(delivery.graph, delivery.item);
		else this.#flushPendingInputs(delivery.item);
		this.#requestSchedule();
	}

	async #rollbackReservations(plan: BatchPlan): Promise<void> {
		const failures: unknown[] = [];
		for (const delivery of [...plan.deliveries].reverse()) {
			try {
				await delivery.resource?.rollback();
			} catch (error) {
				failures.push(error);
			}
		}
		for (const entry of [...plan.newItems].reverse()) {
			try {
				await entry.item.session?.rollback();
			} catch (error) {
				failures.push(error);
			}
			try {
				await entry.item.placement?.rollback();
			} catch (error) {
				failures.push(error);
			}
		}
		if (failures.length > 0) {
			this.#diagnose({
				code: "reservation_rollback_failed",
				message: `${failures.length} unaccepted reservation rollback operation(s) failed`,
			});
		}
	}

	#accept(plan: BatchPlan): void {
		for (const graph of plan.newGraphs) {
			graph.acceptedAt = graph.aggregate.snapshot().graph!.acceptedAt;
			this.#graphs.set(graph.id, graph);
			this.#graphOrder.push(graph);
		}
		for (const entry of plan.newItems) {
			entry.item.acceptedAt = entry.graph.aggregate
				.snapshot()
				.graph!.items.find(({ itemId }) => itemId === entry.item.id)!.acceptedAt;
			entry.graph.items.set(entry.item.id, entry.item);
			entry.graph.itemOrder.push(entry.item);
		}
	}

	#acceptOperations(plan: BatchPlan): void {
		for (const { command, item } of plan.configurations) {
			item.desiredConfiguration = immutableData(command.configuration);
		}
		for (const cancellation of plan.cancellations) {
			this.#markCancellation(cancellation.graph, cancellation.item);
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
				if (!isTerminal(item.state) && !item.cancellationRequested) this.#queueDelivery(item, admission.command);
				continue;
			}
			const diagnostic = settlement.diagnostic ?? "Input resource commit failed";
			item.diagnostics.push({ code: "input_resource_commit_failed", message: diagnostic });
			item.uncertainExternalEffect = true;
			item.cancellationRequested = true;
			failures.push(`input_resource_commit_failed${settlement.diagnostic ? `:${settlement.diagnostic}` : ""}`);
		}
		return failures;
	}

	#queueDelivery(item: ItemRecord, command: DeliverWorkItemInput): void {
		const submission = this.#createSubmission(item, command.kind, command.input, command.resources ?? []);
		if (command.kind === "prompt") item.promptInput = submission;
		else item.pendingInputs.push({ submission });
	}

	#markCancellation(graph: GraphRecord, target?: ItemRecord): void {
		if (target) target.cancellationRequested = true;
		else graph.cancellationRequested = true;
		for (const item of graph.itemOrder) {
			if (!target || item.id === target.id || this.#isDescendant(graph, item, target.id)) {
				item.cancellationRequested = true;
			}
		}
	}

	#itemDefinition(item: ItemRecord): WorkGraphItemDefinition {
		if (!item.sessionId || !item.placementDescriptor) {
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
			sessionId: item.sessionId,
			placement: item.placementDescriptor,
		};
	}

	#acceptedFacts(plan: BatchPlan): readonly WorkGraphFact[] {
		const graph = plan.newGraphs[0] ?? this.#graphs.get(plan.targetGraphId);
		if (!graph) throw new Error(`Accepted Work Graph is unavailable: ${plan.targetGraphId}`);
		const timestamp = Math.max(this.#options.clock.now(), graph.aggregate.snapshot().lastTimestamp ?? 0);
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
		const ledger = this.#ledger;
		if (!ledger) throw new Error("Workspace Ledger is not open");
		// Planning reserves monotonically increasing ordinals under the mutation
		// fence. Rejections may leave gaps, but an accepted Ledger watermark must
		// never allocate the same ordinal a second time.
		const nextGraphOrder = this.#nextGraphOrder;
		const nextPublicationOrder = this.#nextPublicationOrder;
		try {
			await ledger.accept({
				activeGraphs: plan.newGraphs.map((graph) => ({ graphId: graph.id, order: graph.order })),
				nextGraphOrder,
				nextPublicationOrder,
				sessionOwners: plan.newItems.map(({ graph, item }) => ({
					sessionId: item.sessionId!,
					graphId: graph.id,
					itemId: item.id,
				})),
			});
			this.#nextGraphOrder = nextGraphOrder;
			this.#nextPublicationOrder = nextPublicationOrder;
			for (const { graph, item } of plan.newItems) {
				this.#sessionLeases.set(item.sessionId!, { graphId: graph.id, itemId: item.id });
			}
		} catch (error) {
			this.#latchLedgerFailure(error);
			throw error;
		}
	}

	async #acceptWorkspaceSessionOwners(owners: readonly WorkspaceSessionOwner[]): Promise<void> {
		const ledger = this.#ledger;
		if (!ledger) throw new Error("Workspace Ledger is not open");
		try {
			await ledger.accept({
				activeGraphs: [],
				nextGraphOrder: this.#nextGraphOrder,
				nextPublicationOrder: this.#nextPublicationOrder,
				sessionOwners: owners,
			});
		} catch (error) {
			this.#latchLedgerFailure(error);
			throw error;
		}
	}

	async #releaseWorkspaceSession(owner: WorkspaceSessionOwner): Promise<void> {
		try {
			await this.#ledger?.releaseSession(owner);
		} catch (error) {
			this.#latchLedgerFailure(error);
			throw error;
		}
	}

	async #recordWorkspaceTargetIdentity(targetPlacementId: string, targetIdentity: string): Promise<void> {
		try {
			await this.#ledger?.recordTargetIdentity({ targetPlacementId, targetIdentity });
		} catch (error) {
			this.#latchLedgerFailure(error);
			throw error;
		}
	}

	async #archiveDurableGraph(graph: GraphRecord): Promise<void> {
		const ledger = this.#ledger;
		if (!ledger) throw new Error("Workspace Ledger is not open");
		try {
			await ledger.archiveGraph(graph.id);
			for (const [sessionId, owner] of this.#sessionLeases) {
				if (owner.graphId === graph.id && !this.#quarantinedSessionIds.has(sessionId)) {
					this.#sessionLeases.delete(sessionId);
				}
			}
		} catch (error) {
			this.#latchLedgerFailure(error);
			throw error;
		}
		try {
			await this.#persistenceLease?.archiveGraph(graph.id);
			this.#graphStores.delete(graph.id);
		} catch (error) {
			this.#diagnose({ code: "work_graph_archive_failed", message: errorMessage(error).slice(0, 512) }, graph.id);
		}
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
			await this.#applyCancellation(cancellation.graph, cancellation.item);
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
			preparationId: `preparation:${item.graphId}:${item.id}:${this.#options.idGenerator.generate("queue_item")}`,
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

	async #applyCancellation(graph: GraphRecord, target?: ItemRecord): Promise<void> {
		const targets = graph.itemOrder.filter(
			(item) => !target || item.id === target.id || this.#isDescendant(graph, item, target.id),
		);
		for (const item of targets) {
			if (isTerminal(item.state)) continue;
			item.cancellationRequested = true;
			item.controller?.abort(new Error("Work cancellation requested"));
			try {
				item.runtime?.cancel();
			} catch (error) {
				this.#diagnose({ code: "worker_cancel_failed", message: errorMessage(error) }, graph.id, item.id);
			}
		}
		for (const item of targets) {
			if (isTerminal(item.state)) continue;
			if (item.state === "pending" || item.state === "ready")
				await this.#finalizeWithoutRun(graph, item, "canceled");
		}
		this.#requestSchedule();
	}

	#isDescendant(graph: GraphRecord, candidate: ItemRecord, ancestorId: WorkItemId): boolean {
		let current = candidate.parentId;
		while (current) {
			if (current === ancestorId) return true;
			current = graph.items.get(current)?.parentId;
		}
		return false;
	}

	#requestSchedule(): void {
		if (this.#scheduling) {
			this.#scheduleAgain = true;
			return;
		}
		queueMicrotask(() => void this.#drainSchedule());
	}

	async #drainSchedule(): Promise<void> {
		if (this.#scheduling) {
			this.#scheduleAgain = true;
			return;
		}
		this.#scheduling = true;
		try {
			do {
				this.#scheduleAgain = false;
				if (this.#ledgerFailure) continue;
				await this.#refreshPendingStates();
				for (;;) {
					const selected = this.#workScheduler.next({
						activeProcessConcurrency: this.#processActiveConcurrency,
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
						this.#activate(selected.graph, selected.item);
						pending.resolve();
						continue;
					}
					if (!(await this.#transition(selected.graph, selected.item, "preparing"))) continue;
					this.#activate(selected.graph, selected.item);
					void this.#runItem(selected.graph, selected.item).catch((error) => {
						this.#diagnose(
							{ code: "worker_lifecycle_failed", message: errorMessage(error) },
							selected.graph.id,
							selected.item.id,
						);
					});
					await this.#refreshPendingStates();
				}
			} while (this.#scheduleAgain);
		} catch (error) {
			this.#diagnose({ code: "scheduler_failed", message: errorMessage(error) });
		} finally {
			this.#scheduling = false;
			if (this.#scheduleAgain) this.#requestSchedule();
		}
	}

	#nextSchedulableInGraph(graph: GraphRecord):
		| {
				readonly kind: "delegation_resume" | "start";
				readonly graph: GraphRecord;
				readonly item: ItemRecord;
		  }
		| undefined {
		if (this.#ledgerFailure || this.#graphFailures.has(graph.id) || graph.result) return undefined;
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
						await this.#finalizeWithoutRun(graph, item, "canceled");
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
						await this.#finalizeWithoutRun(graph, item, "blocked", blockedBy);
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
						await this.#transition(graph, item, "ready");
						changed = true;
					}
				}
				await this.#trySettleGraph(graph);
			}
		}
	}

	async #runItem(graph: GraphRecord, item: ItemRecord): Promise<void> {
		item.startedAt = this.#options.clock.now();
		item.controller = new AbortController();
		let runtimeOpening: Promise<PrivateWorkerRuntime> | undefined;
		try {
			if (!item.session || !item.placement) throw new Error("Accepted Work Item is missing reserved ownership");
			const session = item.session;
			const placement = item.placement;
			const controller = item.controller;
			runtimeOpening = Promise.resolve().then(() =>
				openPrivateWorkerRuntime({
					options: this.#options,
					graphId: graph.id,
					itemId: item.id,
					runtimeId: item.runtimeId,
					mode: item.executionMode,
					configuration: item.desiredConfiguration,
					signal: controller.signal,
					session,
					placement,
					...(item.executionMode === "write"
						? {
								coordinatorTools: [
									createDelegateTool({
										execute: (specifications, context) =>
											this.#delegate(graph, item, specifications, context.signal),
									}),
								],
							}
						: {}),
					commitFact: (fact, runtimeId, sessionId) =>
						this.#commitWorkerFact(graph, item, fact, runtimeId, sessionId),
					publishObservation: (observation, runtimeId, sessionId) =>
						this.#publishWorkerObservation(graph, item, observation, runtimeId, sessionId),
					resynchronizeObservations: (runtimeId, sessionId) =>
						this.#resynchronizeWorkerObservations(item, runtimeId, sessionId),
					controlWorker: (event, runtimeId, sessionId) =>
						this.#deliverWorkerControl(graph, item, event, runtimeId, sessionId),
					barrierFailed: (failure, runtimeId, sessionId) =>
						this.#workerBarrierFailed(graph, item, failure, runtimeId, sessionId),
					assertProgressAllowed: () => this.#assertProgressAllowed(graph.id),
				}),
			);
			item.runtimeOpening = runtimeOpening;
			const runtime = await runtimeOpening;
			item.runtime = runtime;
			if (item.runtimeOpening === runtimeOpening) item.runtimeOpening = undefined;
			if (item.runtimeTeardown || item.resourcesReleased || item.result || isTerminal(item.state)) {
				await this.#teardownRuntime(item);
				return;
			}
			if (item.cancellationRequested || item.controller.signal.aborted) {
				item.runtime.cancel();
				item.run = {
					runId: `canceled:${item.id}` as RunResult["runId"],
					outcome: "aborted",
				};
				await this.#transition(graph, item, "settling");
				this.#deactivate(graph, item);
				await this.#trySettleItem(graph, item);
				return;
			}
			const run = item.runtime.prompt(
				item.promptInput ?? this.#createSubmission(item, "prompt", item.objective, []),
			);
			item.promptInput = undefined;
			for (const pending of item.pendingInputs.splice(0)) {
				if (pending.submission.kind === "steering") item.runtime.steer(pending.submission);
				else item.runtime.followUp(pending.submission);
			}
			item.run = await run;
			await item.runtime.waitForIdle();
			await this.#transition(graph, item, "settling");
			this.#deactivate(graph, item);
		} catch (error) {
			if (item.runtimeOpening === runtimeOpening) item.runtimeOpening = undefined;
			if (item.runtimeTeardown || item.resourcesReleased || item.result || isTerminal(item.state)) return;
			const runtime = item.runtime;
			const barrierFailure = runtime?.barrierFailure();
			if (barrierFailure && !item.barrierFailure) {
				this.#workerBarrierFailed(graph, item, barrierFailure, runtime!.runtimeId, runtime!.sessionId);
			}
			if (!barrierFailure) item.diagnostics.push({ code: "worker_failed", message: errorMessage(error) });
			item.run = {
				runId: `failed:${item.id}` as RunResult["runId"],
				outcome: item.cancellationRequested ? "aborted" : "error",
				...(item.cancellationRequested
					? {}
					: { failure: { kind: "runtime" as const, message: errorMessage(error) } }),
			};
			if (this.#ledgerFailure || this.#graphFailures.has(graph.id)) {
				this.#deactivate(graph, item);
				await this.#settleAfterPersistenceFailure(graph, item);
				return;
			}
			if (!isTerminal(item.state) && item.state !== "settling") {
				try {
					await this.#transition(graph, item, "settling");
				} catch (transitionError) {
					item.diagnostics.push({ code: "settlement_transition_failed", message: errorMessage(transitionError) });
					await this.#interruptInMemory(graph, item, transitionError);
					return;
				}
			}
		}
		this.#deactivate(graph, item);
		await this.#trySettleItem(graph, item);
	}

	async #settleAfterPersistenceFailure(graph: GraphRecord, item: ItemRecord): Promise<void> {
		if (item.result) return;
		const from = item.state;
		const safeFailedBarrier =
			item.barrierFailure?.barrier === "work_graph_store" && !item.barrierFailure.externalEffectMayHaveOccurred;
		const terminal: WorkResult["state"] = safeFailedBarrier ? "failed" : "interrupted";
		await this.#teardownRuntime(item);
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
		await this.#releaseResources(graph, item, true);
		await this.#afterItemTerminal(graph, item);
	}

	async #commitWorkerFact(
		graph: GraphRecord,
		item: ItemRecord,
		fact: WorkerFact,
		runtimeId: string,
		sessionId: string,
	): Promise<WorkerFactProjection> {
		return this.#graphMutation(graph.id, async () => {
			this.#assertWorkerOwnership(item, runtimeId, sessionId);
			const transitionFrom = fact.type === "run_started" && item.state === "preparing" ? "preparing" : undefined;
			if (fact.type === "run_started" && !transitionFrom && item.state !== "running") {
				throw new Error(`Work Item ${item.id} cannot start a Run in ${item.state}`);
			}
			await this.#appendGraphFacts(graph, [
				{
					version: WORK_GRAPH_FACT_VERSION,
					type: "worker_fact_recorded",
					graphId: graph.id,
					timestamp: fact.timestamp,
					itemId: item.id,
					runtimeId,
					sessionId,
					fact,
				},
			]);
			const aggregateItem = graph.aggregate.snapshot().graph!.items.find(({ itemId }) => itemId === item.id)!;
			item.factProjection = aggregateItem.worker;
			if (transitionFrom) {
				item.state = aggregateItem.state;
				this.#publish((sequence) => ({
					type: "item_state_changed",
					sequence,
					graphId: graph.id,
					itemId: item.id,
					from: transitionFrom,
					to: "running",
				}));
			}
			return item.factProjection;
		});
	}

	#publishWorkerObservation(
		graph: GraphRecord,
		item: ItemRecord,
		observation: WorkerObservation,
		runtimeId: string,
		sessionId: string,
	): void {
		this.#assertWorkerOwnership(item, runtimeId, sessionId);
		let event: JsonValue;
		try {
			event = jsonValue(observation);
		} catch (error) {
			this.#diagnose(
				{
					code: "worker_observation_dropped",
					message: `Worker Observation projection failed: ${errorMessage(error).slice(0, 384)}`,
				},
				graph.id,
				item.id,
			);
			return;
		}
		this.#publish((sequence) => ({
			type: "work_item_event",
			sequence,
			graphId: graph.id,
			itemId: item.id,
			runtimeId,
			sessionId,
			event,
		}));
	}

	#resynchronizeWorkerObservations(item: ItemRecord, runtimeId: string, sessionId: string): void {
		this.#assertWorkerOwnership(item, runtimeId, sessionId);
		const sequence = ++this.#sequence;
		const observation = immutableData({
			type: "resync_required",
			sequence,
			reason: "upstream_overflow",
		} satisfies CodingAgentObservation);
		for (const subscriber of this.#subscribers) this.#requireSubscriberResynchronization(subscriber, observation);
	}

	#workerBarrierFailed(
		graph: GraphRecord,
		item: ItemRecord,
		failure: WorkerBarrierFailure,
		runtimeId: string,
		sessionId: string,
	): void {
		this.#assertWorkerOwnership(item, runtimeId, sessionId);
		if (item.barrierFailure) return;
		item.barrierFailure = failure;
		if (failure.externalEffectMayHaveOccurred) item.uncertainExternalEffect = true;
		item.diagnostics.push({
			code: `${failure.barrier}_barrier_failed`,
			message: `${failure.source}: ${failure.diagnostic}`,
		});
		if (failure.barrier === "work_graph_store") {
			this.#latchGraphFailure(graph.id, new Error(failure.diagnostic));
			return;
		}
		this.#diagnose(
			{
				code: "session_barrier_failed",
				message: `${failure.source}: ${failure.diagnostic}`.slice(0, 512),
			},
			graph.id,
			item.id,
		);
	}

	async #deliverWorkerControl(
		graph: GraphRecord,
		item: ItemRecord,
		event: WorkerControlEvent,
		runtimeId: string,
		sessionId: string,
	): Promise<void> {
		this.#assertWorkerOwnership(item, runtimeId, sessionId);
		const controller = this.#options.controlWorker;
		if (!controller || !this.#workerControllerAttached) return;
		if (!item.placementDescriptor) throw new Error(`Running Work Item ${item.id} has no Workspace placement`);
		const envelope = {
			graphId: graph.id,
			itemId: item.id,
			runtimeId,
			sessionId,
			placement: item.placementDescriptor,
			event,
		};
		try {
			await controller(envelope);
		} catch (error) {
			this.#workerControllerAttached = false;
			this.#diagnose(
				{ code: "worker_controller_detached", message: errorMessage(error).slice(0, 512) },
				graph.id,
				item.id,
			);
		}
	}

	#assertWorkerOwnership(item: ItemRecord, runtimeId: string, sessionId: string): void {
		if (item.runtimeId !== runtimeId || item.sessionId !== sessionId) {
			throw new Error(`Worker ownership changed for Work Item ${item.id}`);
		}
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
			this.#ledgerFailure || this.#graphFailures.has(graph.id)
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
				await this.#options.workspaceExecution.quiesce({
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
				artifact = await this.#options.workspaceExecution.capture({
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
				if (item.cancellationRequested) {
					publication = { state: "not_published", reason: "canceled" };
				} else if (terminal !== "succeeded") {
					publication = {
						state: "not_published",
						reason: terminal === "interrupted" ? "interrupted" : "failed",
					};
				} else {
					const target = item.parentId ? graph.items.get(item.parentId)?.placement?.placement : undefined;
					let publicationStarted = false;
					try {
						publicationStarted = await this.#graphMutation(graph.id, async () => {
							if (item.cancellationRequested || graph.cancellationRequested) return false;
							await this.#appendGraphFacts(graph, [
								{
									version: WORK_GRAPH_FACT_VERSION,
									type: "publication_started",
									graphId: graph.id,
									itemId: item.id,
									timestamp: Math.max(
										this.#options.clock.now(),
										graph.aggregate.snapshot().lastTimestamp ?? 0,
									),
									artifact: artifact!,
									...(target ? { target } : {}),
								},
							]);
							return true;
						});
					} catch (error) {
						terminal = "failed";
						publication = { state: "not_published", reason: "failed", diagnostic: errorMessage(error) };
						item.diagnostics.push({ code: "publication_start_barrier_failed", message: errorMessage(error) });
					}
					if (!publicationStarted && (item.cancellationRequested || graph.cancellationRequested)) {
						terminal = "canceled";
						publication = { state: "not_published", reason: "canceled" };
					}
					if (publicationStarted) {
						try {
							publication = await this.#options.workspaceExecution.publish({
								graphId: graph.id,
								itemId: item.id,
								artifact: artifact!,
								placement,
								...(target ? { target } : {}),
								signal: item.controller?.signal ?? new AbortController().signal,
							});
						} catch (error) {
							terminal = "interrupted";
							publication = { state: "not_published", reason: "interrupted", diagnostic: errorMessage(error) };
							item.diagnostics.push({ code: "publication_interrupted", message: errorMessage(error) });
						}
					}
				}
				try {
					await this.#graphMutation(graph.id, () =>
						this.#appendGraphFacts(graph, [
							{
								version: WORK_GRAPH_FACT_VERSION,
								type: "publication_settled",
								graphId: graph.id,
								itemId: item.id,
								timestamp: Math.max(this.#options.clock.now(), graph.aggregate.snapshot().lastTimestamp ?? 0),
								artifact: artifact!,
								publication,
							},
						]),
					);
					if (
						(publication.state === "published" || publication.state === "not_required") &&
						publication.targetPlacementId &&
						publication.targetIdentity
					) {
						await this.#recordWorkspaceTargetIdentity(publication.targetPlacementId, publication.targetIdentity);
					}
				} catch (error) {
					terminal = "interrupted";
					publication = { state: "not_published", reason: "interrupted", diagnostic: errorMessage(error) };
					item.diagnostics.push({ code: "publication_barrier_failed", message: errorMessage(error) });
				}
			}
		}

		const evidence = item.run && item.session ? item.session.evidence(String(item.run.runId)) : undefined;
		if (!(await this.#teardownRuntime(item)) && terminal === "succeeded") terminal = "failed";
		this.#deactivate(graph, item);
		await this.#transition(graph, item, terminal);
		const result = this.#makeResult(item, terminal, publication, artifact, evidence);
		await this.#recordResult(graph, item, result);
		await this.#releaseResources(graph, item, publication.state === "not_published" || terminal === "interrupted");
		await this.#afterItemTerminal(graph, item);
	}

	async #finalizeWithoutRun(
		graph: GraphRecord,
		item: ItemRecord,
		terminal: "canceled" | "blocked" | "interrupted",
		blockedBy: readonly WorkItemId[] = [],
	): Promise<void> {
		if (isTerminal(item.state)) return;
		this.#deactivate(graph, item);
		await this.#transition(graph, item, terminal);
		const publication: PublicationOutcome =
			terminal === "canceled"
				? { state: "not_published", reason: "canceled" }
				: terminal === "interrupted"
					? { state: "not_published", reason: "interrupted" }
					: { state: "not_required" };
		const result = this.#makeResult(item, terminal, publication, undefined, undefined, blockedBy);
		await this.#recordResult(graph, item, result);
		await this.#releaseResources(graph, item, false);
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
		const settledAt = this.#options.clock.now();
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
			item.result = authoritative;
			this.#publish((sequence) => ({
				type: "work_item_settled",
				sequence,
				graphId: graph.id,
				result: authoritative,
			}));
		});
	}

	async #releaseResources(graph: GraphRecord, item: ItemRecord, preserve: boolean): Promise<void> {
		const runtimeReleased = await this.#teardownRuntime(item);
		if (item.resourcesReleased) return;
		item.resourcesReleased = true;
		let sessionReleased = runtimeReleased;
		if (!item.runtime && item.session) {
			try {
				await item.session.session.close();
			} catch (error) {
				sessionReleased = false;
				item.diagnostics.push({ code: "session_close_failed", message: errorMessage(error) });
			}
		}
		if (item.placement) {
			try {
				await this.#options.workspaceExecution.release({
					graphId: graph.id,
					itemId: item.id,
					placement: item.placement.placement,
					preserve,
				});
			} catch (error) {
				item.diagnostics.push({ code: "placement_release_failed", message: errorMessage(error) });
			}
		}
		if (item.sessionId && !sessionReleased) {
			this.#quarantinedSessionIds.add(item.sessionId);
			return;
		}
		try {
			const durableItem = graph.aggregate.snapshot().graph!.items.find(({ itemId }) => itemId === item.id)!;
			if (durableItem.result) {
				await this.#graphMutation(graph.id, () =>
					this.#appendGraphFacts(graph, [
						{
							version: WORK_GRAPH_FACT_VERSION,
							type: "ownership_released",
							graphId: graph.id,
							itemId: item.id,
							timestamp: Math.max(this.#options.clock.now(), graph.aggregate.snapshot().lastTimestamp ?? 0),
							preservePlacement: preserve,
						},
					]),
				);
			}
			if (item.sessionId) {
				await this.#releaseWorkspaceSession({
					sessionId: item.sessionId,
					graphId: graph.id,
					itemId: item.id,
				});
				this.#sessionLeases.delete(item.sessionId);
				this.#quarantinedSessionIds.delete(item.sessionId);
			}
		} catch (error) {
			item.diagnostics.push({ code: "ownership_release_not_recorded", message: errorMessage(error) });
		}
	}

	#teardownRuntime(item: ItemRecord): Promise<boolean> {
		if (item.runtimeTeardown) return item.runtimeTeardown;
		if (!item.runtime && !item.runtimeOpening) return Promise.resolve(true);
		item.runtimeTeardown = (async () => {
			const opening = item.runtimeOpening;
			if (opening) {
				item.controller?.abort(new Error("Worker Runtime opening interrupted by teardown"));
				try {
					item.runtime ??= await opening;
				} catch {}
				if (item.runtimeOpening === opening) item.runtimeOpening = undefined;
			}
			const runtime = item.runtime;
			if (!runtime) return true;
			try {
				const closed = await runtime.close();
				item.droppedInputs += closed.droppedExternalWork;
				return true;
			} catch (error) {
				item.diagnostics.push({ code: "worker_close_failed", message: errorMessage(error) });
				return false;
			}
		})();
		return item.runtimeTeardown;
	}

	#deactivate(graph: GraphRecord, item: ItemRecord): void {
		if (!item.active) return;
		item.active = false;
		graph.activeConcurrency = Math.max(0, graph.activeConcurrency - 1);
		this.#processActiveConcurrency = Math.max(0, this.#processActiveConcurrency - 1);
		this.#requestSchedule();
	}

	#activate(graph: GraphRecord, item: ItemRecord): void {
		if (item.active) throw new Error(`Work Item ${item.id} already owns an execution slot`);
		item.active = true;
		graph.activeConcurrency++;
		graph.effectiveConcurrency = Math.max(graph.effectiveConcurrency, graph.activeConcurrency);
		this.#processActiveConcurrency++;
	}

	async #delegate(
		graph: GraphRecord,
		parent: ItemRecord,
		specifications: readonly DelegateChildSpecification[],
		signal: AbortSignal,
	): Promise<readonly WorkResult[]> {
		if (parent.executionMode !== "write" || parent.state !== "running" || parent.cancellationRequested) {
			throw new Error(`Work Item ${parent.id} cannot delegate in ${parent.state}`);
		}
		if (parent.delegationWaiting) throw new Error(`Work Item ${parent.id} is already waiting on delegation`);
		parent.delegationWaiting = true;
		this.#deactivate(graph, parent);
		try {
			signal.throwIfAborted();
			const receipt = await this.submit({
				commands: [
					{
						type: "add_work_items",
						graphId: graph.id,
						items: specifications.map((specification) => ({
							itemId: specification.itemId,
							parentItemId: parent.id,
							objective: specification.objective,
							executionMode: specification.executionMode,
							...(specification.dependencies ? { dependencies: specification.dependencies } : {}),
							...(specification.configuration ? { configuration: specification.configuration } : {}),
						})),
					},
				],
			});
			if (receipt.status === "rejected") {
				throw new Error(`Delegation was rejected (${receipt.rejection.code}): ${receipt.rejection.message}`);
			}
			const delegatedIds = receipt.itemIds;
			while (true) {
				signal.throwIfAborted();
				const results = delegatedIds.map((id) => graph.items.get(id)?.result);
				if (results.every((result): result is WorkResult => result !== undefined)) {
					return Object.freeze(results);
				}
				await this.#waitForItemTerminalChange(signal);
			}
		} finally {
			await this.#resumeDelegatingItem(parent, signal);
		}
	}

	#waitForItemTerminalChange(signal: AbortSignal): Promise<void> {
		if (signal.aborted) return Promise.reject(signal.reason);
		return new Promise<void>((resolve, reject) => {
			const cleanup = (): void => {
				signal.removeEventListener("abort", onAbort);
				const index = this.#itemTerminalWaiters.indexOf(onTerminal);
				if (index >= 0) this.#itemTerminalWaiters.splice(index, 1);
			};
			const onTerminal = (): void => {
				cleanup();
				resolve();
			};
			const onAbort = (): void => {
				cleanup();
				reject(signal.reason);
			};
			this.#itemTerminalWaiters.push(onTerminal);
			signal.addEventListener("abort", onAbort, { once: true });
		});
	}

	async #resumeDelegatingItem(item: ItemRecord, signal: AbortSignal): Promise<void> {
		if (item.active) {
			item.delegationWaiting = false;
			return;
		}
		if (item.cancellationRequested || signal.aborted || isTerminal(item.state)) {
			item.delegationWaiting = false;
			return;
		}
		await new Promise<void>((resolve, reject) => {
			const onAbort = (): void => {
				if (item.delegationResume?.resolve !== onResume) return;
				item.delegationResume = undefined;
				item.delegationWaiting = false;
				reject(signal.reason);
			};
			const onResume = (): void => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			};
			item.delegationResume = {
				resolve: onResume,
				reject: (error) => {
					signal.removeEventListener("abort", onAbort);
					reject(error);
				},
			};
			signal.addEventListener("abort", onAbort, { once: true });
			this.#requestSchedule();
		});
	}

	async #afterItemTerminal(graph: GraphRecord, item: ItemRecord): Promise<void> {
		for (const resolve of this.#itemTerminalWaiters.splice(0)) resolve();
		for (const parent of graph.itemOrder.filter((candidate) => candidate.id === item.parentId)) {
			await this.#trySettleItem(graph, parent);
		}
		await this.#trySettleGraph(graph);
		this.#requestSchedule();
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
			const settledAt = Math.max(this.#options.clock.now(), graph.aggregate.snapshot().lastTimestamp ?? 0);
			let result: WorkGraphResult = immutableData({
				durability:
					this.#ledgerFailure ||
					this.#graphFailures.has(graph.id) ||
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
					if (!this.#ledgerFailure && !this.#graphFailures.has(graph.id)) {
						throw new Error("Work Graph result persistence failed");
					}
					result = immutableData({ ...result, durability: "unknown" });
				}
			}
			graph.result = result;
			this.#publish((sequence) => ({ type: "work_graph_settled", sequence, result }));
			this.#notifySettlementWaiters();
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
					this.#processActiveConcurrency >= this.#capacity.processMaximumConcurrency)
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
					timestamp: Math.max(this.#options.clock.now(), graph.aggregate.snapshot().lastTimestamp ?? 0),
				},
			]);
			item.state = graph.aggregate.snapshot().graph!.items.find(({ itemId }) => itemId === item.id)!.state;
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
		if (!item.result) {
			this.#undurableWork.set(`${graph.id}\0${item.id}`, {
				graphId: graph.id,
				itemId: item.id,
				phase: isTerminal(item.state) ? "result" : item.state,
			});
		}
		item.controller?.abort(error);
		try {
			item.runtime?.cancel();
		} catch {}
		await this.#teardownRuntime(item);
		this.#deactivate(graph, item);
		item.state = "interrupted";
		const publication: PublicationOutcome = { state: "not_published", reason: "interrupted" };
		const result = this.#makeResult(item, "interrupted", publication, undefined, undefined, [], "unknown");
		item.result = result;
		this.#publish((sequence) => ({ type: "work_item_settled", sequence, graphId: graph.id, result }));
		await this.#releaseResources(graph, item, true);
		await this.#afterItemTerminal(graph, item);
	}

	#snapshot(): CodingAgentSnapshot {
		return immutableData({
			closed: this.#closed,
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
		const sequence = ++this.#sequence;
		const observation = immutableData(factory(sequence));
		for (const subscriber of this.#subscribers) this.#pushObservation(subscriber, observation);
		return sequence;
	}

	#pushObservation(subscriber: Subscriber, observation: CodingAgentObservation): void {
		if (subscriber.closed || subscriber.resync) return;
		const waiter = subscriber.waiters.shift();
		if (waiter) {
			waiter({ done: false, value: observation });
			return;
		}
		if (subscriber.queue.length >= subscriber.capacity) {
			subscriber.queue.splice(0);
			subscriber.resync = true;
			subscriber.queue.push(
				immutableData({
					type: "resync_required",
					sequence: observation.sequence,
					reason: "slow_consumer",
				} satisfies CodingAgentObservation),
			);
			return;
		}
		subscriber.queue.push(observation);
	}

	#requireSubscriberResynchronization(
		subscriber: Subscriber,
		observation: Extract<CodingAgentObservation, { readonly type: "resync_required" }>,
	): void {
		if (subscriber.closed || subscriber.resync) return;
		subscriber.queue.splice(0);
		subscriber.resync = true;
		const waiter = subscriber.waiters.shift();
		if (waiter) waiter({ done: false, value: observation });
		else subscriber.queue.push(observation);
	}

	#nextObservation(subscriber: Subscriber): Promise<IteratorResult<CodingAgentObservation>> {
		const queued = subscriber.queue.shift();
		if (queued) return Promise.resolve({ done: false, value: queued });
		if (subscriber.closed) return Promise.resolve({ done: true, value: undefined });
		return new Promise((resolve) => subscriber.waiters.push(resolve));
	}

	#removeSubscriber(subscriber: Subscriber): void {
		if (subscriber.closed) return;
		subscriber.closed = true;
		this.#subscribers.delete(subscriber);
		for (const waiter of subscriber.waiters.splice(0)) waiter({ done: true, value: undefined });
		subscriber.queue.splice(0);
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
		let fence = this.#graphMutationFences.get(graphId);
		if (!fence) {
			fence = new MutationFence();
			this.#graphMutationFences.set(graphId, fence);
		}
		return fence.run(operation);
	}

	async #openGraphStore(graphId: WorkGraphId): Promise<WorkGraphStore> {
		const current = this.#graphStores.get(graphId);
		if (current) return current;
		const lease = this.#persistenceLease;
		if (!lease) throw new Error("Workspace persistence lease is not open");
		const store = await lease.openGraph(graphId);
		this.#graphStores.set(graphId, store);
		return store;
	}

	async #appendGraphFacts(graph: GraphRecord, facts: readonly WorkGraphFact[]): Promise<void> {
		if (facts.length === 0) throw new Error("A Work Graph segment must contain Facts");
		if (facts.some(({ graphId }) => graphId !== graph.id)) {
			throw new Error(`A Work Graph segment cannot cross Graph ${graph.id}`);
		}
		let aggregate = graph.aggregate;
		for (const fact of facts) aggregate = aggregate.apply(fact);
		const failure = this.#graphFailures.get(graph.id);
		if (failure) throw failure;
		try {
			await (await this.#openGraphStore(graph.id)).append(facts);
			graph.aggregate = aggregate;
		} catch (error) {
			this.#latchGraphFailure(graph.id, error);
			throw error;
		}
	}

	#interruptGraphForPersistence(graph: GraphRecord, error: unknown): void {
		for (const item of graph.itemOrder) {
			if (item.result) continue;
			this.#undurableWork.set(`${graph.id}\0${item.id}`, {
				graphId: graph.id,
				itemId: item.id,
				phase: isTerminal(item.state) ? "result" : item.state,
			});
			if (isTerminal(item.state)) continue;
			if (workerFactHasOpenEffects(item.factProjection)) item.uncertainExternalEffect = true;
			item.controller?.abort(error);
			item.delegationResume?.reject(error);
			item.delegationResume = undefined;
			item.delegationWaiting = false;
			try {
				item.runtime?.cancel();
			} catch {}
		}
	}

	#latchGraphFailure(graphId: WorkGraphId, error: unknown): void {
		if (this.#graphFailures.has(graphId)) return;
		this.#graphFailures.set(graphId, error);
		const graph = this.#graphs.get(graphId);
		if (graph) this.#interruptGraphForPersistence(graph, error);
		this.#diagnose(
			{
				code: "work_graph_persistence_failed",
				message: errorMessage(error).slice(0, 512),
			},
			graphId,
		);
		if (!graph) return;
		const failStop = this.#settleUnstartedAfterPersistenceFailure([graph]).catch((settlementError) => {
			this.#diagnose(
				{
					code: "work_graph_fail_stop_settlement_failed",
					message: errorMessage(settlementError).slice(0, 512),
				},
				graphId,
			);
		});
		this.#graphFailStops.set(graphId, failStop);
	}

	#latchLedgerFailure(error: unknown): void {
		if (this.#ledgerFailure) return;
		this.#ledgerFailure = error;
		for (const graph of this.#graphOrder) this.#interruptGraphForPersistence(graph, error);
		this.#diagnose({
			code: "workspace_ledger_persistence_failed",
			message: errorMessage(error).slice(0, 512),
		});
		this.#ledgerFailStop = this.#settleUnstartedAfterPersistenceFailure(this.#graphOrder).catch((settlementError) => {
			this.#diagnose({
				code: "ledger_fail_stop_settlement_failed",
				message: errorMessage(settlementError).slice(0, 512),
			});
		});
	}

	async #settleUnstartedAfterPersistenceFailure(graphs: readonly GraphRecord[]): Promise<void> {
		await Promise.resolve();
		for (const graph of graphs) {
			for (const item of graph.itemOrder) {
				if (item.state !== "pending" && item.state !== "ready") continue;
				await this.#settleAfterPersistenceFailure(graph, item);
			}
			await this.#trySettleGraph(graph);
		}
	}

	#assertProgressAllowed(graphId: WorkGraphId): void {
		if (this.#ledgerFailure) {
			throw new Error(`Workspace Ledger persistence is unavailable: ${errorMessage(this.#ledgerFailure)}`);
		}
		const graphFailure = this.#graphFailures.get(graphId);
		if (graphFailure) throw new Error(`Work Graph persistence is unavailable: ${errorMessage(graphFailure)}`);
	}

	async #close(): Promise<CodingAgentCloseResult> {
		while (this.#submissions.size > 0) await Promise.allSettled([...this.#submissions]);
		await this.#ledgerFailStop;
		await Promise.all(this.#graphFailStops.values());
		const canceledGraphIds = this.#graphOrder.filter((graph) => !graph.result).map((graph) => graph.id);
		for (const graph of this.#graphOrder) {
			if (graph.result) continue;
			if (this.#graphFailures.has(graph.id) || this.#ledgerFailure) {
				for (const item of graph.itemOrder) {
					if (!isTerminal(item.state))
						await this.#interruptInMemory(graph, item, this.#graphFailures.get(graph.id));
				}
				continue;
			}
			try {
				await this.#graphMutation(graph.id, async () => {
					await this.#appendGraphFacts(graph, [
						{
							version: WORK_GRAPH_FACT_VERSION,
							type: "cancellation_requested",
							graphId: graph.id,
							timestamp: Math.max(this.#options.clock.now(), graph.aggregate.snapshot().lastTimestamp ?? 0),
							batchId: "batch:close",
							target: { type: "graph" },
						},
					]);
					this.#markCancellation(graph);
				});
				await this.#applyCancellation(graph);
			} catch (error) {
				this.#diagnose({ code: "close_cancellation_failed", message: errorMessage(error) }, graph.id);
				for (const item of graph.itemOrder) {
					if (!isTerminal(item.state)) await this.#interruptInMemory(graph, item, error);
				}
			}
		}
		this.#requestSchedule();
		await this.#waitForGraphSettlement();
		const droppedInputs = this.#graphOrder.reduce(
			(total, graph) =>
				total +
				graph.itemOrder.reduce(
					(count, item) => count + item.droppedInputs + item.pendingInputs.length + (item.promptInput ? 1 : 0),
					0,
				),
			0,
		);
		const unsettledWork = this.#graphOrder.flatMap((graph) =>
			graph.itemOrder.flatMap((item) => {
				if (item.state !== "preparing" && item.state !== "running" && item.state !== "settling") return [];
				return [{ graphId: graph.id, itemId: item.id, phase: item.state } as const];
			}),
		);
		const unknownWork = [
			...this.#undurableWork.values(),
			...unsettledWork.filter((candidate) => !this.#undurableWork.has(`${candidate.graphId}\0${candidate.itemId}`)),
		];
		const result: CodingAgentCloseResult = immutableData({ canceledGraphIds, droppedInputs, unknownWork });
		const failures: unknown[] = [];
		if (!this.#ledgerFailure) {
			try {
				await this.#ledger?.flush();
			} catch (error) {
				failures.push(error);
			}
		}
		for (const [graphId, store] of this.#graphStores) {
			if (this.#graphFailures.has(graphId)) continue;
			try {
				await store.flush();
			} catch (error) {
				failures.push(error);
			}
		}
		try {
			await this.#options.workspaceExecution.close();
		} catch (error) {
			failures.push(error);
		}
		try {
			await this.#persistenceLease?.close();
		} catch (error) {
			if (!this.#ledgerFailure && this.#graphFailures.size === 0) failures.push(error);
		}
		this.#closed = true;
		this.#publish((sequence) => ({ type: "closed", sequence, result }));
		for (const subscriber of this.#subscribers) subscriber.closed = true;
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1) throw new AggregateError(failures, "Coding Agent close failed");
		return result;
	}

	#waitForGraphSettlement(): Promise<void> {
		if (this.#graphOrder.every((graph) => graph.result)) return Promise.resolve();
		return new Promise((resolve) => this.#settlementWaiters.push(resolve));
	}

	#notifySettlementWaiters(): void {
		if (!this.#graphOrder.every((graph) => graph.result)) return;
		for (const resolve of this.#settlementWaiters.splice(0)) resolve();
	}
}

export async function openCodingAgent(options: OpenCodingAgentOptions): Promise<CodingAgent> {
	const coordinator = new WorkCoordinator(options);
	try {
		await coordinator.initialize();
	} catch (error) {
		await coordinator.abortInitialization();
		throw error;
	}
	return Object.freeze(coordinator);
}
