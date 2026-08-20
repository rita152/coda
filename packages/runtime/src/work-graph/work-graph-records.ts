import { cloneFrozen, type RunResult } from "@coda/agent";
import type { InputResourceReservation, WorkSessionReservation, WorkspacePlacementReservation } from "./ports.ts";
import type {
	DeliverWorkItemInput,
	DesiredRuntimeConfiguration,
	WorkCapacityPolicy,
	WorkDiagnostic,
	WorkGraphId,
	WorkGraphResult,
	WorkItemId,
	WorkItemState,
	WorkResult,
	WorkspacePlacementDescriptor,
} from "./types.ts";
import type { WorkGraphAggregate, WorkGraphAggregateItem } from "./work-graph-aggregate.ts";
import { INITIAL_WORKER_FACT_PROJECTION, type WorkerFactProjection } from "./worker-fact.ts";
import type { WorkerBarrierFailure, WorkerSubmission } from "./worker-protocol.ts";

const TERMINAL_STATES = new Set<WorkItemState>(["succeeded", "failed", "canceled", "interrupted", "blocked"]);

export function isTerminal(state: WorkItemState): state is WorkResult["state"] {
	return TERMINAL_STATES.has(state);
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function immutableData<T>(value: T): T {
	return cloneFrozen(value) as T;
}

export interface PrivateWorkerRuntimeHandle {
	readonly runtimeId: string;
	readonly sessionId: string;
	prompt(submission: WorkerSubmission): Promise<RunResult>;
	steer(submission: WorkerSubmission): void;
	followUp(submission: WorkerSubmission): void;
	cancel(): void;
	waitForIdle(): Promise<void>;
	configure(configuration: DesiredRuntimeConfiguration): Promise<void>;
	assistantText(): string | undefined;
	barrierFailure(): WorkerBarrierFailure | undefined;
	close(): Promise<{ readonly droppedExternalWork: number }>;
}

export interface PendingInput {
	readonly submission: WorkerSubmission;
}

export interface InputAdmission {
	readonly deliveryId: string;
	readonly command: DeliverWorkItemInput;
	settlement?: { readonly outcome: "committed" | "failed"; readonly diagnostic?: string };
}

/** Immutable durable state replaced only by WorkGraphMirror after Aggregate application. */
export interface ItemProjection {
	readonly acceptedAt: number;
	readonly desiredConfiguration: DesiredRuntimeConfiguration;
	readonly state: WorkItemState;
	readonly cancellationRequested: boolean;
	readonly startedAt?: number;
	readonly sessionId?: string;
	readonly placementDescriptor?: WorkspacePlacementDescriptor;
	readonly factProjection: WorkerFactProjection;
	readonly result?: WorkResult;
	readonly ownershipReleased: boolean;
	readonly promptAccepted: boolean;
}

/** Process-local state. None of these fields may define restored durable state. */
export interface ItemRuntimeState {
	run?: RunResult;
	runtime?: PrivateWorkerRuntimeHandle;
	runtimeOpening?: Promise<PrivateWorkerRuntimeHandle>;
	runtimeTeardown?: Promise<boolean>;
	controller?: AbortController;
	placement?: WorkspacePlacementReservation;
	session?: WorkSessionReservation;
	/** Admission-owned reservation identity before the acceptance Fact is durable. */
	reservedSessionId?: string;
	/** Admission-owned reservation descriptor before the acceptance Fact is durable. */
	reservedPlacementDescriptor?: WorkspacePlacementDescriptor;
	readonly diagnostics: WorkDiagnostic[];
	readonly pendingInputs: PendingInput[];
	readonly inputAdmissions: InputAdmission[];
	promptInput?: WorkerSubmission;
	droppedInputs: number;
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

export interface ItemRecord {
	readonly id: WorkItemId;
	readonly graphId: WorkGraphId;
	readonly order: number;
	readonly parentId?: WorkItemId;
	readonly dependencies: readonly WorkItemId[];
	readonly objective: string;
	readonly executionMode: "read_only" | "write";
	publicationOrder: number;
	readonly runtimeId: string;
	readonly projection: ItemProjection;
	readonly process: ItemRuntimeState;
}

export interface GraphRecord {
	readonly id: WorkGraphId;
	order: number;
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

export interface DeliveryPlan {
	readonly commandIndex: number;
	readonly deliveryId: string;
	readonly command: DeliverWorkItemInput;
	readonly graph: GraphRecord;
	readonly item: ItemRecord;
	resource?: InputResourceReservation;
}

export function makeItem(input: {
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
		publicationOrder: input.publicationOrder,
		runtimeId: input.runtimeId,
		projection: immutableData({
			acceptedAt: input.acceptedAt,
			desiredConfiguration: input.configuration,
			state: "pending",
			cancellationRequested: false,
			factProjection: INITIAL_WORKER_FACT_PROJECTION,
			ownershipReleased: false,
			promptAccepted: false,
		}),
		process: {
			diagnostics: [],
			pendingInputs: [],
			inputAdmissions: [],
			droppedInputs: 0,
			uncertainExternalEffect: false,
			active: false,
			resourcesReleased: false,
			delegationWaiting: false,
		},
	};
}

/** The only projection from authoritative Aggregate state into mutable Work Graph records. */
export class WorkGraphMirror {
	readonly #capacity: WorkCapacityPolicy;

	constructor(capacity: WorkCapacityPolicy) {
		this.#capacity = capacity;
	}

	restoreAggregate(aggregate: WorkGraphAggregate): GraphRecord {
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
			this.projectItem(item, state);
			item.process.resourcesReleased = state.ownershipReleased !== undefined;
			if (state.result) {
				item.process.diagnostics.push(...state.result.diagnostics);
			} else {
				for (const input of state.inputs) {
					const command: DeliverWorkItemInput = {
						type: "deliver_work_item_input",
						graphId: graph.id,
						itemId: item.id,
						kind: input.kind,
						input: input.input,
						...(input.resourceReferences.length > 0 ? { resources: input.resourceReferences } : {}),
						...(input.capabilitySelections ? { capabilitySelections: input.capabilitySelections } : {}),
					};
					item.process.inputAdmissions.push({
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
			}
			graph.items.set(item.id, item);
			graph.itemOrder.push(item);
		}
		return graph;
	}

	projectGraph(graph: GraphRecord): void {
		const snapshot = graph.aggregate.snapshot().graph;
		if (!snapshot) throw new Error(`Work Graph ${graph.id} has no authoritative Aggregate state`);
		graph.acceptedAt = snapshot.acceptedAt;
		graph.cancellationRequested = snapshot.cancellationRequested;
		graph.result = snapshot.result;
		if (snapshot.result) graph.effectiveConcurrency = snapshot.result.effectiveConcurrency;
		for (const state of snapshot.items) {
			const item = graph.items.get(state.itemId);
			if (item) this.projectItem(item, state);
		}
	}

	projectItem(item: ItemRecord, state: WorkGraphAggregateItem): void {
		const mutable = item as { projection: ItemProjection };
		mutable.projection = immutableData({
			acceptedAt: state.acceptedAt,
			desiredConfiguration: state.desiredConfiguration,
			state: state.state,
			cancellationRequested: state.cancellationRequested,
			...(state.startedAt === undefined ? {} : { startedAt: state.startedAt }),
			...(state.sessionId === undefined ? {} : { sessionId: state.sessionId }),
			...(state.placement === undefined ? {} : { placementDescriptor: state.placement }),
			factProjection: state.worker,
			...(state.result === undefined ? {} : { result: state.result }),
			ownershipReleased: state.ownershipReleased !== undefined,
			promptAccepted: state.inputs.some(({ kind }) => kind === "prompt"),
		});
	}

	/** Projects one documented process-local settlement when persistence is unavailable. */
	projectUndurableSettlement(item: ItemRecord, state: WorkResult["state"], result: WorkResult): void {
		const mutable = item as { projection: ItemProjection };
		mutable.projection = immutableData({ ...item.projection, state, result });
	}
}
