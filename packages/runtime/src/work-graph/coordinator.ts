import type { AgentInput, RunBudgetExhaustion, RunResult } from "@coda/agent";
import type { JsonValue } from "@coda/ai";
import { createDelegateTool, type DelegateChildSpecification } from "./delegate-tool.ts";
import { MemoryWorkJournal } from "./memory-journal.ts";
import type {
	InputResourceReservation,
	OpenCodingAgentOptions,
	WorkJournal,
	WorkSessionReservation,
	WorkspacePlacementReservation,
} from "./ports.ts";
import type {
	AddWorkItemSpecification,
	CodingAgent,
	CodingAgentCloseResult,
	CodingAgentCommand,
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
import type { WorkerRuntimeEvent, WorkerSubmission } from "./worker-protocol.ts";
import { openPrivateWorkerRuntime, type PrivateWorkerRuntime } from "./worker-runtime.ts";

const TERMINAL_STATES = new Set<WorkItemState>(["succeeded", "failed", "canceled", "interrupted", "blocked"]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

function isTerminal(state: WorkItemState): boolean {
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

function isRecordValue(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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

interface PendingInput {
	readonly submission: WorkerSubmission;
}

interface ItemRecord {
	readonly id: WorkItemId;
	readonly graphId: WorkGraphId;
	readonly order: number;
	readonly parentId?: WorkItemId;
	readonly dependencies: readonly WorkItemId[];
	readonly objective: string;
	readonly executionMode: "read_only" | "write";
	readonly acceptedAt: number;
	readonly publicationOrder: number;
	readonly runtimeId: string;
	desiredConfiguration: DesiredRuntimeConfiguration;
	state: WorkItemState;
	cancellationRequested: boolean;
	startedAt?: number;
	run?: RunResult;
	result?: WorkResult;
	runtime?: PrivateWorkerRuntime;
	controller?: AbortController;
	placement?: WorkspacePlacementReservation;
	session?: WorkSessionReservation;
	sessionId?: string;
	placementDescriptor?: WorkspacePlacementDescriptor;
	readonly diagnostics: WorkDiagnostic[];
	readonly pendingInputs: PendingInput[];
	promptInput?: WorkerSubmission;
	droppedInputs: number;
	modelAttempts: number;
	toolInvocations: number;
	totalTokens: number;
	exhaustion?: RunBudgetExhaustion;
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
	readonly acceptedAt: number;
	readonly items: Map<WorkItemId, ItemRecord>;
	readonly itemOrder: ItemRecord[];
	activeConcurrency: number;
	effectiveConcurrency: number;
	cancellationRequested: boolean;
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
	resourceFailure?: string;
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

interface PersistedGraphDefinition {
	readonly graphId: string;
	readonly order: number;
	readonly objective: string;
	readonly rootItemId: string;
	readonly maximumConcurrency: number;
	readonly acceptedAt: number;
}

interface PersistedItemDefinition {
	readonly graphId: string;
	readonly itemId: string;
	readonly order: number;
	readonly parentItemId?: string;
	readonly dependencies: readonly string[];
	readonly objective: string;
	readonly executionMode: "read_only" | "write";
	readonly desiredConfiguration: DesiredRuntimeConfiguration;
	readonly acceptedAt: number;
	readonly publicationOrder: number;
	readonly runtimeId: string;
	readonly sessionId: string;
	readonly placement: WorkspacePlacementDescriptor;
}

interface PersistedBatch {
	readonly schemaVersion: 1;
	readonly commands: readonly CodingAgentCommand[];
	readonly graphs: readonly PersistedGraphDefinition[];
	readonly items: readonly PersistedItemDefinition[];
}

interface RecoveredPendingInput {
	readonly graph: GraphRecord;
	readonly item: ItemRecord;
	readonly command: DeliverWorkItemInput;
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
		droppedInputs: 0,
		modelAttempts: 0,
		toolInvocations: 0,
		totalTokens: 0,
		uncertainExternalEffect: false,
		active: false,
		resourcesReleased: false,
		delegationWaiting: false,
	};
}

class WorkCoordinator implements CodingAgent {
	readonly #options: OpenCodingAgentOptions;
	readonly #journal: WorkJournal;
	readonly #graphs = new Map<WorkGraphId, GraphRecord>();
	readonly #graphOrder: GraphRecord[] = [];
	readonly #sessionLeases = new Map<string, { readonly graphId: WorkGraphId; readonly itemId: WorkItemId }>();
	readonly #subscribers = new Set<Subscriber>();
	readonly #processMaximumConcurrency: number;
	readonly #mutationFence = new MutationFence();
	#processActiveConcurrency = 0;
	#nextGraphOrder = 0;
	#nextPublicationOrder = 0;
	#sequence = 0;
	#closed = false;
	#closing = false;
	#closeOperation?: Promise<CodingAgentCloseResult>;
	#submissionTail: Promise<void> = Promise.resolve();
	#workerControllerAttached = true;
	#acceptingBatches = 0;
	#scheduling = false;
	#scheduleAgain = false;
	readonly #settlementWaiters: Array<() => void> = [];
	readonly #itemTerminalWaiters: Array<() => void> = [];

	constructor(options: OpenCodingAgentOptions) {
		this.#options = options;
		this.#journal = options.journal ?? new MemoryWorkJournal();
		const maximum = options.processMaximumConcurrency ?? 8;
		if (!Number.isSafeInteger(maximum) || maximum < 1) {
			throw new Error("processMaximumConcurrency must be a positive safe integer");
		}
		this.#processMaximumConcurrency = maximum;
	}

	async initialize(): Promise<void> {
		const restored = await this.#journal.load();
		if (restored.records.length === 0) return;
		const openInvocations = new Map<string, Set<string>>();
		const openPublications = new Set<string>();
		const publicationArtifacts = new Map<string, WorkspaceArtifact>();
		const settledTargetIdentities = new Map<string, string>();
		const pendingResourceInputs = new Map<string, RecoveredPendingInput>();
		const resourceRecoveryFailures = new Map<string, string[]>();
		const itemKey = (graph: WorkGraphId, item: WorkItemId): string => `${graph}\0${item}`;
		const recordResourceFailure = (graph: WorkGraphId, item: WorkItemId, reason: string): void => {
			const key = itemKey(graph, item);
			const reasons = resourceRecoveryFailures.get(key) ?? [];
			reasons.push(reason);
			resourceRecoveryFailures.set(key, reasons);
		};
		for (const diagnostic of restored.diagnostics) {
			this.#diagnose({ code: "work_journal_recovery", message: diagnostic });
		}
		for (const record of restored.records) {
			switch (record.type) {
				case "batch_accepted":
					this.#restoreAcceptedBatch(record.payload, record.batchId, pendingResourceInputs);
					break;
				case "input_resources_settled": {
					const pending = pendingResourceInputs.get(record.deliveryId);
					if (!pending) throw new Error(`Restored input resource delivery not found: ${record.deliveryId}`);
					if (pending.graph.id !== record.graphId || pending.item.id !== record.itemId) {
						throw new Error(`Restored input resource delivery target changed: ${record.deliveryId}`);
					}
					pendingResourceInputs.delete(record.deliveryId);
					if (record.outcome === "committed") this.#restoreDelivery(pending.item, pending.command);
					else
						recordResourceFailure(
							record.graphId,
							record.itemId,
							`input_resource_commit_failed${record.diagnostic ? `:${record.diagnostic}` : ""}`,
						);
					break;
				}
				case "item_transition": {
					const item = this.#restoredItem(record);
					if (item.state !== record.from) {
						throw new Error(
							`Work Journal transition mismatch for ${record.graphId}/${record.itemId}: expected ${item.state}, found ${record.from}`,
						);
					}
					item.state = record.to as WorkItemState;
					break;
				}
				case "worker_event": {
					const item = this.#restoredItem(record);
					const key = itemKey(record.graphId, record.itemId);
					if (record.event.type === "attempt_start") item.modelAttempts++;
					if (record.event.type === "attempt_end")
						item.totalTokens += record.event.candidate.message.usage.totalTokens;
					if (record.event.type === "tool_execution_start") {
						item.toolInvocations++;
						let invocations = openInvocations.get(key);
						if (!invocations) {
							invocations = new Set();
							openInvocations.set(key, invocations);
						}
						invocations.add(String(record.event.invocation.id));
					}
					if (record.event.type === "tool_execution_end") {
						openInvocations.get(key)?.delete(String(record.event.invocation.id));
					}
					if (record.event.type === "run_budget_exhausted") item.exhaustion = record.event.exhaustion;
					break;
				}
				case "item_result": {
					const item = this.#restoredItem(record);
					const result = record.payload as unknown as WorkResult;
					if (String(result.itemId) !== String(item.id) || !isTerminal(result.state)) {
						throw new Error(`Invalid restored Work Result for ${record.graphId}/${record.itemId}`);
					}
					item.result = immutableData(result);
					item.state = result.state;
					break;
				}
				case "graph_result": {
					const graph = this.#graphs.get(record.graphId);
					if (!graph) throw new Error(`Restored Work Graph not found: ${record.graphId}`);
					const result = record.payload as unknown as WorkGraphResult;
					if (String(result.graphId) !== String(graph.id)) {
						throw new Error(`Invalid restored Work Graph Result for ${record.graphId}`);
					}
					graph.result = immutableData(result);
					graph.effectiveConcurrency = result.effectiveConcurrency;
					break;
				}
				case "cancellation_requested": {
					const graph = this.#graphs.get(record.graphId);
					if (!graph) throw new Error(`Restored Work Graph not found: ${record.graphId}`);
					if (record.itemId) {
						const target = graph.items.get(record.itemId);
						if (!target) throw new Error(`Restored Work Item not found: ${record.itemId}`);
						for (const item of graph.itemOrder) {
							if (item.id === target.id || this.#isDescendant(graph, item, target.id))
								item.cancellationRequested = true;
						}
					} else {
						graph.cancellationRequested = true;
						for (const item of graph.itemOrder) item.cancellationRequested = true;
					}
					break;
				}
				case "publication": {
					const key = itemKey(record.graphId, record.itemId);
					const payload = record.payload;
					if (!isRecordValue(payload)) throw new Error(`Invalid Publication record for ${key}`);
					if (payload.phase === "started") {
						openPublications.add(key);
						if (isRecordValue(payload.artifact)) {
							publicationArtifacts.set(key, payload.artifact as unknown as WorkspaceArtifact);
						}
					} else if (payload.phase === "settled") {
						openPublications.delete(key);
						const publication = payload.publication;
						if (
							isRecordValue(publication) &&
							(publication.state === "published" || publication.state === "not_required") &&
							typeof publication.targetPlacementId === "string" &&
							typeof publication.targetIdentity === "string"
						) {
							settledTargetIdentities.set(publication.targetPlacementId, publication.targetIdentity);
						}
					}
					break;
				}
				case "ownership_released":
					this.#restoredItem(record).resourcesReleased = true;
					break;
				case "recovery_interrupted": {
					const item = this.#restoredItem(record);
					const result = record.payload as unknown as WorkResult;
					item.state = "interrupted";
					item.result = immutableData(result);
					break;
				}
			}
		}
		for (const [deliveryId, pending] of pendingResourceInputs) {
			recordResourceFailure(pending.graph.id, pending.item.id, `input_resource_settlement_unknown:${deliveryId}`);
		}

		this.#graphOrder.sort((left, right) => left.order - right.order);
		this.#nextGraphOrder = Math.max(0, ...this.#graphOrder.map((graph) => graph.order + 1));
		for (const graph of this.#graphOrder) graph.itemOrder.sort((left, right) => left.order - right.order);
		this.#nextPublicationOrder = Math.max(
			0,
			...this.#graphOrder.flatMap((graph) => graph.itemOrder.map((item) => item.publicationOrder + 1)),
		);
		const uncertainPublicationTargets = new Set<string>();
		for (const graph of this.#graphOrder) {
			for (const item of graph.itemOrder) {
				if (!openPublications.has(itemKey(graph.id, item.id))) continue;
				const targetPlacementId = item.placementDescriptor?.targetPlacementId;
				if (targetPlacementId) uncertainPublicationTargets.add(targetPlacementId);
			}
		}
		for (const graph of this.#graphOrder) {
			if (graph.result) continue;
			for (const item of graph.itemOrder) {
				if (item.result) continue;
				const key = itemKey(graph.id, item.id);
				const reasons: string[] = [];
				if (item.state === "preparing" || item.state === "running" || item.state === "settling") {
					reasons.push(`uncertain_${item.state}`);
				}
				if ((openInvocations.get(key)?.size ?? 0) > 0) reasons.push("unclosed_tool_invocation");
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

	#restoreAcceptedBatch(
		value: JsonValue,
		batchId: string,
		pendingResourceInputs: Map<string, RecoveredPendingInput>,
	): void {
		if (
			!isRecordValue(value) ||
			value.schemaVersion !== 1 ||
			!Array.isArray(value.graphs) ||
			!Array.isArray(value.items)
		) {
			throw new Error("Invalid accepted Work Journal batch payload");
		}
		const batch = value as unknown as PersistedBatch;
		for (const definition of batch.graphs) {
			const id = graphId(assertIdentity(definition.graphId, "graph"));
			if (this.#graphs.has(id)) throw new Error(`Duplicate restored Work Graph: ${id}`);
			if (!Number.isSafeInteger(definition.order) || !Number.isSafeInteger(definition.maximumConcurrency)) {
				throw new Error(`Invalid restored Work Graph definition: ${id}`);
			}
			const graph: GraphRecord = {
				id,
				order: definition.order,
				objective: assertObjective(definition.objective, "Restored Work Graph objective"),
				rootId: itemId(assertIdentity(definition.rootItemId, "item")),
				maximumConcurrency: definition.maximumConcurrency,
				acceptedAt: definition.acceptedAt,
				items: new Map(),
				itemOrder: [],
				activeConcurrency: 0,
				effectiveConcurrency: 0,
				cancellationRequested: false,
			};
			this.#graphs.set(id, graph);
			this.#graphOrder.push(graph);
		}
		for (const definition of batch.items) {
			const graph = this.#graphs.get(graphId(definition.graphId));
			if (!graph) throw new Error(`Restored Work Graph not found for Work Item: ${definition.graphId}`);
			const id = itemId(assertIdentity(definition.itemId, "item"));
			if (graph.items.has(id)) throw new Error(`Duplicate restored Work Item: ${graph.id}/${id}`);
			const sessionId = assertIdentity(definition.sessionId, "session");
			if (!isRecordValue(definition.placement)) throw new Error(`Invalid restored Workspace Placement for ${id}`);
			const item = makeItem({
				graphId: graph.id,
				itemId: id,
				order: definition.order,
				...(definition.parentItemId ? { parentId: itemId(definition.parentItemId) } : {}),
				dependencies: definition.dependencies.map(itemId),
				objective: definition.objective,
				executionMode: definition.executionMode,
				configuration: definition.desiredConfiguration,
				acceptedAt: definition.acceptedAt,
				publicationOrder: definition.publicationOrder,
				runtimeId: definition.runtimeId,
			});
			item.sessionId = sessionId;
			item.placementDescriptor = immutableData(definition.placement);
			graph.items.set(id, item);
			graph.itemOrder.push(item);
		}
		if (!Array.isArray(batch.commands)) throw new Error("Restored Work Journal batch has no command list");
		for (const [commandIndex, command] of batch.commands.entries()) {
			switch (command.type) {
				case "configure_work_item": {
					const graph = this.#graphs.get(graphId(String(command.graphId)));
					const item = graph?.items.get(itemId(String(command.itemId)));
					if (!item) throw new Error(`Restored ConfigureWorkItem target not found: ${command.itemId}`);
					item.desiredConfiguration = immutableData(command.configuration);
					break;
				}
				case "deliver_work_item_input": {
					const graph = this.#graphs.get(graphId(String(command.graphId)));
					const item = graph?.items.get(itemId(String(command.itemId)));
					if (!item) throw new Error(`Restored DeliverWorkItemInput target not found: ${command.itemId}`);
					if ((command.resources?.length ?? 0) > 0) {
						pendingResourceInputs.set(`${batchId}:${commandIndex}`, { graph: graph!, item, command });
					} else this.#restoreDelivery(item, command);
					break;
				}
				case "cancel_work": {
					const graph = this.#graphs.get(graphId(String(command.target.graphId)));
					if (!graph) throw new Error(`Restored CancelWork target not found: ${command.target.graphId}`);
					if (command.target.type === "graph") {
						graph.cancellationRequested = true;
						for (const item of graph.itemOrder) item.cancellationRequested = true;
					} else {
						const target = graph.items.get(itemId(String(command.target.itemId)));
						if (!target) throw new Error(`Restored CancelWork target not found: ${command.target.itemId}`);
						for (const item of graph.itemOrder) {
							if (item.id === target.id || this.#isDescendant(graph, item, target.id))
								item.cancellationRequested = true;
						}
					}
					break;
				}
				case "start_work_graph":
				case "add_work_items":
					break;
			}
		}
	}

	#restoreDelivery(item: ItemRecord, command: DeliverWorkItemInput): void {
		const submission = this.#createSubmission(item, command.kind, command.input, command.resources ?? []);
		if (command.kind === "prompt") {
			if (item.promptInput) throw new Error(`Restored Work Item has duplicate Prompt input: ${item.id}`);
			item.promptInput = submission;
		} else item.pendingInputs.push({ submission });
	}

	#restoredItem(record: { readonly graphId: WorkGraphId; readonly itemId: WorkItemId }): ItemRecord {
		const item = this.#graphs.get(record.graphId)?.items.get(record.itemId);
		if (!item) throw new Error(`Restored Work Item not found: ${record.graphId}/${record.itemId}`);
		return item;
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
			if (this.#sessionLeases.has(item.sessionId))
				throw new Error(`Recovered Session is already leased: ${item.sessionId}`);
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
		item.state = "interrupted";
		item.resourcesReleased = true;
		item.diagnostics.push({
			code: "recovered_interruption",
			message: `Work Item was not replayed after recovery: ${reasons.join(", ")}`,
		});
		const publication: PublicationOutcome = {
			state: "not_published",
			reason: "interrupted",
			diagnostic: reasons.join(", "),
		};
		const result = this.#makeResult(item, "interrupted", publication, artifact);
		item.result = result;
		await this.#journal.append({
			type: "recovery_interrupted",
			graphId: graph.id,
			itemId: item.id,
			timestamp: result.timing.settledAt,
			reasons: [...reasons],
			payload: jsonValue(result),
		});
		this.#publish((sequence) => ({
			type: "item_state_changed",
			sequence,
			graphId: graph.id,
			itemId: item.id,
			from,
			to: "interrupted",
		}));
		this.#publish((sequence) => ({ type: "work_item_settled", sequence, graphId: graph.id, result }));
	}

	submit(batch: CodingAgentCommandBatch): Promise<CodingAgentReceipt> {
		const operation = this.#submissionTail.then(() => this.#submit(batch));
		this.#submissionTail = operation.then(
			() => undefined,
			() => undefined,
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
		if (!batch || !Array.isArray(batch.commands) || batch.commands.length === 0) {
			return immutableData({
				status: "rejected",
				batchId,
				rejection: { code: "empty_batch", message: "A command batch must contain at least one command" },
			});
		}

		this.#acceptingBatches++;
		let plan: BatchPlan | undefined;
		let durablyAccepted = false;
		let sequence = 0;
		try {
			plan = this.#plan(batch, batchId);
			await this.#validateConfigurations(plan);
			await this.#reserve(plan);
			await this.#commitOwnershipReservations(plan);
			await this.#mutationFence.run(async () => {
				this.#revalidate(plan!);
				await this.#journal.append({
					type: "batch_accepted",
					batchId,
					acceptedAt: this.#options.clock.now(),
					payload: this.#acceptedBatchPayload(batch, plan!),
				});
				durablyAccepted = true;
				this.#accept(plan!);
				this.#acceptOperations(plan!);
				await this.#commitAcceptedInputResources(plan!);
				this.#acceptResourceBackedInputs(plan!);
				const resourceFailedItems = new Set(
					plan!.deliveries.filter((delivery) => delivery.resourceFailure).map((delivery) => delivery.item),
				);
				for (const delivery of plan!.deliveries) {
					if (!resourceFailedItems.has(delivery.item)) this.#flushPendingInputs(delivery.item);
				}
				sequence = this.#publish((value) => ({
					type: "batch_accepted",
					sequence: value,
					batchId,
					graphIds: plan!.graphIds,
					itemIds: plan!.itemIds,
				}));
			});
		} catch (error) {
			if (durablyAccepted) {
				this.#diagnose({ code: "accepted_operation_failed", message: errorMessage(error) });
			} else if (plan) {
				await this.#rollbackReservations(plan);
			}
			if (durablyAccepted && plan) {
				this.#acceptingBatches--;
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
					: { code: "journal_failed" as const, message: errorMessage(error) };
			this.#acceptingBatches--;
			this.#requestSchedule();
			return immutableData({ status: "rejected", batchId, rejection });
		}
		if (!plan) throw new Error("Accepted command batch has no plan");

		// batch_accepted is the linearization point. Once that fatal barrier
		// succeeds, this command can never be reported as rejected or rolled back.
		try {
			await this.#applyAcceptedOperations(plan);
		} catch (error) {
			this.#diagnose({ code: "accepted_operation_failed", message: errorMessage(error) });
		}
		this.#acceptingBatches--;
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
		const graphs = new Map(this.#graphs);
		const itemViews = new Map<WorkGraphId, Map<WorkItemId, ItemRecord>>();
		const addedCounts = new Map<WorkGraphId, number>();
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
			const graph = graphs.get(id);
			if (!graph) {
				throw rejected({
					code: "graph_not_found",
					message: `Work Graph not found: ${id}`,
					commandIndex,
					graphId: id,
				});
			}
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
					const rootId = itemId(assertIdentity(String(command.root?.itemId), "item"));
					if (!Number.isSafeInteger(command.maximumConcurrency) || command.maximumConcurrency < 1) {
						throw rejected({
							code: "invalid_command",
							message: "maximumConcurrency must be a positive safe integer",
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
						order: this.#nextGraphOrder + newGraphs.length,
						objective,
						rootId,
						maximumConcurrency: command.maximumConcurrency,
						acceptedAt: now,
						items: new Map(),
						itemOrder: [],
						activeConcurrency: 0,
						effectiveConcurrency: 0,
						cancellationRequested: false,
					};
					const root = makeItem({
						graphId: id,
						itemId: rootId,
						order: 0,
						objective: rootObjective,
						executionMode: command.root.executionMode,
						configuration: command.configuration,
						acceptedAt: now,
						publicationOrder: this.#nextPublicationOrder + newItems.length,
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
							order: graph.itemOrder.length + (addedCounts.get(graph.id) ?? 0),
							now,
							newItems,
							itemIds,
						});
						addedCounts.set(graph.id, (addedCounts.get(graph.id) ?? 0) + 1);
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
						(item.promptInput !== undefined ||
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
		return { newGraphs, newItems, deliveries, configurations, cancellations, graphIds, itemIds };
	}

	#planAddedItem(input: {
		readonly graph: GraphRecord;
		readonly specification: AddWorkItemSpecification;
		readonly commandIndex: number;
		readonly items: Map<WorkItemId, ItemRecord>;
		readonly order: number;
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
			order: input.order,
			parentId,
			dependencies,
			objective: assertObjective(specification.objective, "Work Item objective"),
			executionMode: specification.executionMode,
			configuration,
			acceptedAt: input.now,
			publicationOrder: this.#nextPublicationOrder + input.newItems.length,
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
		for (const entry of plan.newItems) {
			if (entry.graph.result || entry.graph.cancellationRequested) {
				throw rejected({
					code: "invalid_state",
					message: `Work Graph ${entry.graph.id} settled while the batch was reserving resources`,
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
				(item.promptInput !== undefined ||
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

	async #commitAcceptedInputResources(plan: BatchPlan): Promise<void> {
		for (const delivery of plan.deliveries) {
			if ((delivery.command.resources?.length ?? 0) === 0) continue;
			let outcome: "committed" | "failed" = "committed";
			let diagnostic: string | undefined;
			try {
				if (!delivery.resource) throw new Error("Accepted input has no resource reservation");
				await delivery.resource.commit();
			} catch (error) {
				outcome = "failed";
				diagnostic = errorMessage(error);
			}
			try {
				await this.#journal.append({
					type: "input_resources_settled",
					graphId: delivery.graph.id,
					itemId: delivery.item.id,
					deliveryId: delivery.deliveryId,
					outcome,
					timestamp: this.#options.clock.now(),
					...(diagnostic ? { diagnostic } : {}),
				});
			} catch (error) {
				outcome = "failed";
				diagnostic = `Input resource settlement was not journaled: ${errorMessage(error)}`;
			}
			if (outcome === "failed") delivery.resourceFailure = diagnostic ?? "Input resource commit failed";
		}
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
			this.#graphs.set(graph.id, graph);
			this.#graphOrder.push(graph);
		}
		this.#nextGraphOrder += plan.newGraphs.length;
		this.#nextPublicationOrder += plan.newItems.length;
		for (const entry of plan.newItems) {
			entry.graph.items.set(entry.item.id, entry.item);
			entry.graph.itemOrder.push(entry.item);
			const sessionId = entry.item.sessionId!;
			this.#sessionLeases.set(sessionId, { graphId: entry.graph.id, itemId: entry.item.id });
		}
	}

	#acceptOperations(plan: BatchPlan): void {
		for (const { command, item } of plan.configurations) {
			item.desiredConfiguration = immutableData(command.configuration);
		}
		for (const delivery of plan.deliveries) {
			if ((delivery.command.resources?.length ?? 0) === 0) this.#queueDelivery(delivery);
		}
		for (const cancellation of plan.cancellations) {
			this.#markCancellation(cancellation.graph, cancellation.item);
		}
	}

	#acceptResourceBackedInputs(plan: BatchPlan): void {
		for (const delivery of plan.deliveries) {
			if ((delivery.command.resources?.length ?? 0) === 0) continue;
			if (delivery.resourceFailure) {
				delivery.item.diagnostics.push({
					code: "input_resource_commit_failed",
					message: delivery.resourceFailure,
				});
				delivery.item.uncertainExternalEffect = true;
				delivery.item.cancellationRequested = true;
				continue;
			}
			this.#queueDelivery(delivery);
		}
	}

	#queueDelivery(delivery: DeliveryPlan): void {
		const submission = this.#createSubmission(
			delivery.item,
			delivery.command.kind,
			delivery.command.input,
			delivery.command.resources ?? [],
		);
		if (delivery.command.kind === "prompt") delivery.item.promptInput = submission;
		else delivery.item.pendingInputs.push({ submission });
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

	#acceptedBatchPayload(batch: CodingAgentCommandBatch, plan: BatchPlan): JsonValue {
		return jsonValue({
			schemaVersion: 1,
			commands: batch.commands,
			graphs: plan.newGraphs.map((graph) => ({
				graphId: graph.id,
				order: graph.order,
				objective: graph.objective,
				rootItemId: graph.rootId,
				maximumConcurrency: graph.maximumConcurrency,
				acceptedAt: graph.acceptedAt,
			})),
			items: plan.newItems.map(({ item }) => ({
				graphId: item.graphId,
				itemId: item.id,
				order: item.order,
				parentItemId: item.parentId,
				dependencies: item.dependencies,
				objective: item.objective,
				executionMode: item.executionMode,
				desiredConfiguration: item.desiredConfiguration,
				acceptedAt: item.acceptedAt,
				publicationOrder: item.publicationOrder,
				runtimeId: item.runtimeId,
				sessionId: item.sessionId,
				placement: item.placementDescriptor,
			})),
		});
	}

	async #applyAcceptedOperations(plan: BatchPlan): Promise<void> {
		const resourceFailedItems = new Set<ItemRecord>();
		for (const delivery of plan.deliveries) {
			if (!delivery.resourceFailure || resourceFailedItems.has(delivery.item)) continue;
			resourceFailedItems.add(delivery.item);
			await this.#interruptForInputResourceFailure(delivery);
		}
		for (const { command, item } of plan.configurations) {
			if (resourceFailedItems.has(item)) continue;
			if (item.runtime) {
				try {
					await item.runtime.configure(command.configuration);
				} catch (error) {
					this.#diagnose({ code: "configuration_failed", message: errorMessage(error) }, item.graphId, item.id);
				}
			}
		}
		for (const delivery of plan.deliveries) {
			if (resourceFailedItems.has(delivery.item)) continue;
			this.#flushPendingInputs(delivery.item);
		}
		for (const cancellation of plan.cancellations) {
			await this.#applyCancellation(cancellation.graph, cancellation.item);
		}
	}

	async #interruptForInputResourceFailure(delivery: DeliveryPlan): Promise<void> {
		const { graph, item } = delivery;
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
				if (this.#acceptingBatches > 0) continue;
				await this.#refreshPendingStates();
				while (this.#processActiveConcurrency < this.#processMaximumConcurrency) {
					const selected = this.#nextSchedulableItem();
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
					await this.#transition(selected.graph, selected.item, "preparing");
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

	#nextSchedulableItem():
		| {
				readonly kind: "delegation_resume" | "start";
				readonly graph: GraphRecord;
				readonly item: ItemRecord;
		  }
		| undefined {
		for (const graph of this.#graphOrder) {
			if (graph.result || graph.activeConcurrency >= graph.maximumConcurrency) continue;
			for (const item of graph.itemOrder) {
				if (item.delegationResume) return { kind: "delegation_resume", graph, item };
				if (item.state === "ready") return { kind: "start", graph, item };
			}
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
					if (dependenciesSucceeded && parentPermits) {
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
		try {
			if (!item.session || !item.placement) throw new Error("Accepted Work Item is missing reserved ownership");
			item.runtime = await openPrivateWorkerRuntime({
				options: this.#options,
				graphId: graph.id,
				itemId: item.id,
				runtimeId: item.runtimeId,
				mode: item.executionMode,
				configuration: item.desiredConfiguration,
				session: item.session,
				placement: item.placement,
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
				onEvent: (event, runtimeId, sessionId) => this.#workerEvent(graph, item, event, runtimeId, sessionId),
			});
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
			item.diagnostics.push({ code: "worker_failed", message: errorMessage(error) });
			item.run = {
				runId: `failed:${item.id}` as RunResult["runId"],
				outcome: item.cancellationRequested ? "aborted" : "error",
				...(item.cancellationRequested
					? {}
					: { failure: { kind: "runtime" as const, message: errorMessage(error) } }),
			};
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

	async #workerEvent(
		graph: GraphRecord,
		item: ItemRecord,
		event: WorkerRuntimeEvent,
		runtimeId: string,
		sessionId: string,
	): Promise<void> {
		if (event.type === "run_start" && item.state === "preparing") await this.#transition(graph, item, "running");
		const record = async (): Promise<void> => {
			if (event.type === "fatal_barrier_failed" && event.externalEffectMayHaveOccurred) {
				item.uncertainExternalEffect = true;
			}
			if (event.type === "attempt_start") item.modelAttempts++;
			if (event.type === "attempt_end") item.totalTokens += event.candidate.message.usage.totalTokens;
			if (event.type === "tool_execution_start") item.toolInvocations++;
			if (event.type === "run_budget_exhausted") item.exhaustion = event.exhaustion;
			try {
				await this.#journal.append({
					type: "worker_event",
					graphId: graph.id,
					itemId: item.id,
					runtimeId,
					sessionId,
					event,
				});
			} catch (error) {
				const externalEffectMayHaveOccurred =
					event.type === "fatal_barrier_failed"
						? event.externalEffectMayHaveOccurred
						: ![
								"preparation_started",
								"preparation_settled",
								"run_start",
								"turn_start",
								"attempt_start",
							].includes(event.type);
				if (externalEffectMayHaveOccurred) item.uncertainExternalEffect = true;
				throw error;
			}
			this.#publish((sequence) => ({
				type: "work_item_event",
				sequence,
				graphId: graph.id,
				itemId: item.id,
				runtimeId,
				sessionId,
				event: jsonValue(event),
			}));
		};
		if (event.type === "turn_end" || event.type === "run_end") await this.#mutationFence.run(record);
		else await record();
		if (!item.placementDescriptor) throw new Error(`Running Work Item ${item.id} has no Workspace placement`);
		const envelope = {
			graphId: graph.id,
			itemId: item.id,
			runtimeId,
			sessionId,
			placement: item.placementDescriptor,
			event,
		};
		await this.#controlWorkerEvent(envelope);
	}

	async #controlWorkerEvent(
		envelope: Parameters<NonNullable<OpenCodingAgentOptions["controlWorkerEvent"]>>[0],
	): Promise<void> {
		const controller = this.#options.controlWorkerEvent;
		if (!controller || !this.#workerControllerAttached) return;
		try {
			await controller(envelope);
		} catch (error) {
			this.#workerControllerAttached = false;
			this.#diagnose(
				{ code: "worker_controller_detached", message: errorMessage(error) },
				envelope.graphId,
				envelope.itemId,
			);
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
		let terminal: WorkResult["state"] = item.uncertainExternalEffect
			? "interrupted"
			: item.cancellationRequested || item.run?.outcome === "aborted"
				? "canceled"
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
						publicationStarted = await this.#mutationFence.run(async () => {
							if (item.cancellationRequested || graph.cancellationRequested) return false;
							await this.#journal.append({
								type: "publication",
								graphId: graph.id,
								itemId: item.id,
								timestamp: this.#options.clock.now(),
								payload: jsonValue({ phase: "started", artifact, target }),
							});
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
								artifact,
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
					await this.#journal.append({
						type: "publication",
						graphId: graph.id,
						itemId: item.id,
						timestamp: this.#options.clock.now(),
						payload: jsonValue({ phase: "settled", artifact, publication }),
					});
				} catch (error) {
					terminal = "interrupted";
					publication = { state: "not_published", reason: "interrupted", diagnostic: errorMessage(error) };
					item.diagnostics.push({ code: "publication_barrier_failed", message: errorMessage(error) });
				}
			}
		}

		const evidence = item.run && item.session ? item.session.evidence(String(item.run.runId)) : undefined;
		if (item.runtime) {
			try {
				const closed = await item.runtime.close();
				item.droppedInputs += closed.droppedExternalWork;
			} catch (error) {
				item.diagnostics.push({ code: "worker_close_failed", message: errorMessage(error) });
				if (terminal === "succeeded") terminal = "failed";
			}
		}
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
			modelAttempts: item.modelAttempts,
			toolInvocations: item.toolInvocations,
			totalTokens: item.totalTokens,
			elapsedMs: Math.max(0, settledAt - item.acceptedAt),
			...(item.exhaustion ? { exhaustion: item.exhaustion } : {}),
		};
		return immutableData({
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
		await this.#mutationFence.run(async () => {
			if (item.result) return;
			await this.#journal.append({
				type: "item_result",
				graphId: graph.id,
				itemId: item.id,
				timestamp: result.timing.settledAt,
				payload: jsonValue(result),
			});
			item.result = result;
			this.#publish((sequence) => ({ type: "work_item_settled", sequence, graphId: graph.id, result }));
		});
	}

	async #releaseResources(graph: GraphRecord, item: ItemRecord, preserve: boolean): Promise<void> {
		if (item.resourcesReleased) return;
		item.resourcesReleased = true;
		if (!item.runtime && item.session) {
			try {
				await item.session.session.close();
			} catch (error) {
				item.diagnostics.push({ code: "session_close_failed", message: errorMessage(error) });
			}
		}
		if (item.sessionId) this.#sessionLeases.delete(item.sessionId);
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
		try {
			await this.#journal.append({
				type: "ownership_released",
				graphId: graph.id,
				itemId: item.id,
				timestamp: this.#options.clock.now(),
				preservePlacement: preserve,
			});
		} catch (error) {
			item.diagnostics.push({ code: "ownership_release_not_recorded", message: errorMessage(error) });
		}
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
		if (graph.result || graph.itemOrder.length === 0 || this.#acceptingBatches > 0) return;
		if (graph.itemOrder.some((item) => !isTerminal(item.state) || !item.result)) return;
		if (graph.settlement) return graph.settlement;
		const operation = this.#mutationFence.run(async () => {
			if (graph.result || graph.itemOrder.length === 0 || this.#acceptingBatches > 0) return;
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
			const result: WorkGraphResult = immutableData({
				graphId: graph.id,
				rootItemId: graph.rootId,
				objective: graph.objective,
				outcome,
				maximumConcurrency: graph.maximumConcurrency,
				effectiveConcurrency: graph.effectiveConcurrency,
				results,
				cancellationRequested: graph.cancellationRequested,
				acceptedAt: graph.acceptedAt,
				settledAt: this.#options.clock.now(),
				finalPublication,
			});
			await this.#journal.append({
				type: "graph_result",
				graphId: graph.id,
				timestamp: result.settledAt,
				payload: jsonValue(result),
			});
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

	async #transition(graph: GraphRecord, item: ItemRecord, to: WorkItemState): Promise<void> {
		await this.#mutationFence.run(async () => {
			const from = item.state;
			if (from === to) return;
			if (!this.#transitionPermitted(from, to)) {
				throw new Error(`Invalid Work Item transition ${item.id}: ${from} -> ${to}`);
			}
			await this.#journal.append({
				type: "item_transition",
				graphId: graph.id,
				itemId: item.id,
				from,
				to,
				timestamp: this.#options.clock.now(),
			});
			item.state = to;
			this.#publish((sequence) => ({
				type: "item_state_changed",
				sequence,
				graphId: graph.id,
				itemId: item.id,
				from,
				to,
			}));
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
		item.controller?.abort(error);
		try {
			item.runtime?.cancel();
		} catch {}
		this.#deactivate(graph, item);
		item.state = "interrupted";
		const publication: PublicationOutcome = { state: "not_published", reason: "interrupted" };
		const result = this.#makeResult(item, "interrupted", publication);
		item.result = result;
		this.#publish((sequence) => ({ type: "work_item_settled", sequence, graphId: graph.id, result }));
		await this.#releaseResources(graph, item, true);
		await this.#afterItemTerminal(graph, item);
	}

	#snapshot(): CodingAgentSnapshot {
		return immutableData({
			closed: this.#closed,
			graphs: this.#graphOrder.map((graph) => this.#graphSnapshot(graph)),
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
		return {
			itemId: item.id,
			...(item.parentId ? { parentItemId: item.parentId } : {}),
			dependencies: item.dependencies,
			objective: item.objective,
			executionMode: item.executionMode,
			state: item.state,
			desiredConfiguration: item.desiredConfiguration,
			...(item.runtime ? { runtimeId: item.runtimeId } : {}),
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

	async #close(): Promise<CodingAgentCloseResult> {
		await this.#submissionTail;
		const canceledGraphIds = this.#graphOrder.filter((graph) => !graph.result).map((graph) => graph.id);
		for (const graph of this.#graphOrder) {
			if (graph.result) continue;
			try {
				await this.#mutationFence.run(async () => {
					await this.#journal.append({
						type: "cancellation_requested",
						graphId: graph.id,
						timestamp: this.#options.clock.now(),
					});
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
		const unknownWork = this.#graphOrder.flatMap((graph) =>
			graph.itemOrder.flatMap((item) => {
				if (item.state !== "preparing" && item.state !== "running" && item.state !== "settling") return [];
				return [{ graphId: graph.id, itemId: item.id, phase: item.state } as const];
			}),
		);
		const result: CodingAgentCloseResult = immutableData({ canceledGraphIds, droppedInputs, unknownWork });
		const failures: unknown[] = [];
		try {
			await this.#journal.flush();
		} catch (error) {
			failures.push(error);
		}
		try {
			await this.#options.workspaceExecution.close();
		} catch (error) {
			failures.push(error);
		}
		try {
			await this.#journal.close();
		} catch (error) {
			failures.push(error);
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
	await coordinator.initialize();
	return Object.freeze(coordinator);
}
