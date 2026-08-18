import type { Identity, RunModelProvider } from "./ports.ts";
import type {
	AddWorkItemSpecification,
	CodingAgentCommandBatch,
	CodingAgentRejection,
	ConfigureWorkItem,
	DesiredRuntimeConfiguration,
	WorkCapacityPolicy,
	WorkGraphId,
	WorkItemId,
	WorkSessionTarget,
} from "./types.ts";
import { WorkGraphAggregate } from "./work-graph-aggregate.ts";
import {
	type DeliveryPlan,
	errorMessage,
	type GraphRecord,
	type ItemProjection,
	type ItemRecord,
	immutableData,
	isTerminal,
	makeItem,
} from "./work-graph-records.ts";

export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

function graphId(value: string): WorkGraphId {
	return value as WorkGraphId;
}

function itemId(value: string): WorkItemId {
	return value as WorkItemId;
}

export function assertIdentity(value: unknown, kind: "graph" | "item" | "session"): string {
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

export function assertConfiguration(configuration: DesiredRuntimeConfiguration): void {
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

export class SubmissionRejection extends Error {
	readonly rejection: CodingAgentRejection;

	constructor(rejection: CodingAgentRejection) {
		super(rejection.message);
		this.name = "SubmissionRejection";
		this.rejection = rejection;
	}
}

export function rejected(rejection: CodingAgentRejection): SubmissionRejection {
	return new SubmissionRejection(rejection);
}

export interface ConfigurationPlan {
	readonly command: ConfigureWorkItem;
	readonly graph: GraphRecord;
	readonly item: ItemRecord;
}

export interface CancellationPlan {
	readonly graph: GraphRecord;
	readonly item?: ItemRecord;
}

export interface NewItemPlan {
	readonly graph: GraphRecord;
	readonly item: ItemRecord;
	readonly sessionTarget: WorkSessionTarget;
}

export interface BatchPlan {
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

export interface WorkGraphPlanningView {
	readonly graphs: Map<WorkGraphId, GraphRecord>;
	items(graph: GraphRecord): Map<WorkItemId, ItemRecord>;
	touchedItems(): Iterable<readonly [WorkGraphId, Map<WorkItemId, ItemRecord>]>;
}

export function createWorkGraphPlanningView(graphs: ReadonlyMap<WorkGraphId, GraphRecord>): WorkGraphPlanningView {
	const planningGraphs = new Map(graphs);
	const itemViews = new Map<WorkGraphId, Map<WorkItemId, ItemRecord>>();
	return {
		graphs: planningGraphs,
		items: (graph) => {
			let items = itemViews.get(graph.id);
			if (!items) {
				items = new Map(graph.items);
				itemViews.set(graph.id, items);
			}
			return items;
		},
		touchedItems: () => itemViews,
	};
}

export interface WorkGraphPlanningDurability {
	graphFailure(graphId: WorkGraphId): unknown;
}

export function planBatch(input: {
	readonly batch: CodingAgentCommandBatch;
	readonly batchId: string;
	readonly now: number;
	readonly identity: Identity;
	readonly capacity: WorkCapacityPolicy;
	readonly durable: WorkGraphPlanningDurability;
	readonly view: WorkGraphPlanningView;
}): BatchPlan {
	const { batch, batchId, now, identity, capacity, durable, view } = input;
	const newGraphs: GraphRecord[] = [];
	const newItems: NewItemPlan[] = [];
	const deliveries: DeliveryPlan[] = [];
	const configurations: ConfigurationPlan[] = [];
	const cancellations: CancellationPlan[] = [];
	const graphIds: WorkGraphId[] = [];
	const itemIds: WorkItemId[] = [];
	const targetGraphIds = new Set<WorkGraphId>();
	const findGraph = (value: string, commandIndex: number): GraphRecord => {
		const id = graphId(assertIdentity(value, "graph"));
		const persistenceFailure = durable.graphFailure(id);
		if (persistenceFailure) {
			throw rejected({
				code: "graph_store_failed",
				message: `Work Graph persistence is unavailable: ${errorMessage(persistenceFailure)}`,
				commandIndex,
				graphId: id,
			});
		}
		const graph = view.graphs.get(id);
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
		const item = view.items(graph).get(id);
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
						? `graph:${identity.generate("queue_item")}`
						: assertIdentity(String(command.graphId), "graph"),
				);
				if (view.graphs.has(id)) {
					throw rejected({
						code: "duplicate_identity",
						message: `Duplicate Work Graph identity: ${id}`,
						commandIndex,
						graphId: id,
					});
				}
				const persistenceFailure = durable.graphFailure(id);
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
					command.maximumConcurrency > capacity.graphMaximumConcurrency
				) {
					throw rejected({
						code: "invalid_command",
						message: `maximumConcurrency must be between 1 and ${capacity.graphMaximumConcurrency}`,
						commandIndex,
					});
				}
				if (command.root.executionMode !== "read_only" && command.root.executionMode !== "write") {
					throw rejected({ code: "invalid_command", message: "Invalid Work Item execution mode", commandIndex });
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
					order: 0,
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
					publicationOrder: 0,
					runtimeId: `worker:${id}:${rootId}:${identity.generate("queue_item")}`,
				});
				view.graphs.set(id, graph);
				view.items(graph).set(rootId, root);
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
					planAddedItem({
						graph,
						specification,
						commandIndex,
						items: view.items(graph),
						now,
						newItems,
						itemIds,
						identity,
					});
				}
				if (!graphIds.includes(graph.id)) graphIds.push(graph.id);
				break;
			}
			case "deliver_work_item_input": {
				const graph = findGraph(String(command.graphId), commandIndex);
				const item = findItem(graph, String(command.itemId), commandIndex);
				if (isTerminal(item.projection.state) || item.projection.cancellationRequested) {
					throw rejected({
						code: "invalid_state",
						message: `Work Item ${item.id} cannot accept input in ${item.projection.state}`,
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
					(item.projection.promptAccepted ||
						item.process.runtime !== undefined ||
						item.projection.state === "running" ||
						item.projection.state === "settling" ||
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
				if (isTerminal(item.projection.state) || item.projection.cancellationRequested) {
					throw rejected({
						code: "invalid_state",
						message: `Work Item ${item.id} cannot be configured in ${item.projection.state}`,
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
	for (const [id, items] of view.touchedItems()) assertAcyclic(id, items);
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

function planAddedItem(input: {
	readonly graph: GraphRecord;
	readonly specification: AddWorkItemSpecification;
	readonly commandIndex: number;
	readonly items: Map<WorkItemId, ItemRecord>;
	readonly now: number;
	readonly newItems: NewItemPlan[];
	readonly itemIds: WorkItemId[];
	readonly identity: Identity;
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
	if (
		parent.projection.state === "settling" ||
		isTerminal(parent.projection.state) ||
		parent.projection.cancellationRequested
	) {
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
	const configuration = mergeChildConfiguration(specification.configuration, parent.projection.desiredConfiguration);
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
		publicationOrder: 0,
		runtimeId: `worker:${graph.id}:${id}:${input.identity.generate("queue_item")}`,
	});
	items.set(id, item);
	input.newItems.push({
		graph,
		item,
		sessionTarget: {
			type: "create",
			sessionId: `session:${graph.id}:${id}:${input.identity.generate("queue_item")}`,
		},
	});
	input.itemIds.push(id);
}

function assertAcyclic(id: WorkGraphId, items: ReadonlyMap<WorkItemId, ItemRecord>): void {
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

export async function validatePlanConfigurations(
	plan: BatchPlan,
	modelProvider: Pick<RunModelProvider, "resolve">,
): Promise<void> {
	const signal = new AbortController().signal;
	try {
		for (const entry of plan.newItems) {
			await resolveNewItemConfiguration(entry, plan, modelProvider, signal);
		}
		for (const { command } of plan.configurations) {
			await modelProvider.resolve(command.configuration, signal);
		}
	} catch (error) {
		throw rejected({
			code: "resource_reservation_failed",
			message: `Runtime configuration failed: ${errorMessage(error)}`,
		});
	}
}

function mergeChildConfiguration(
	requested: AddWorkItemSpecification["configuration"],
	parent: DesiredRuntimeConfiguration,
): DesiredRuntimeConfiguration {
	const runLimits = requested?.runLimits ?? parent.runLimits;
	return {
		model: requested?.model ?? parent.model,
		reasoning: requested?.reasoning ?? parent.reasoning,
		...(runLimits ? { runLimits } : {}),
	};
}

function parentItem(entry: NewItemPlan, plan: BatchPlan): ItemRecord | undefined {
	const parentId = entry.item.parentId;
	if (!parentId) return undefined;
	const fromBatch = plan.newItems.find(
		(candidate) => candidate.graph.id === entry.graph.id && candidate.item.id === parentId,
	)?.item;
	return fromBatch ?? entry.graph.items.get(parentId);
}

function sameModel(left: DesiredRuntimeConfiguration, right: DesiredRuntimeConfiguration): boolean {
	return left.model.provider === right.model.provider && left.model.id === right.model.id;
}

function assignDesiredConfiguration(item: ItemRecord, configuration: DesiredRuntimeConfiguration): void {
	const mutable = item as { projection: ItemProjection };
	mutable.projection = immutableData({
		...item.projection,
		desiredConfiguration: configuration,
	});
}

async function resolveNewItemConfiguration(
	entry: NewItemPlan,
	plan: BatchPlan,
	modelProvider: Pick<RunModelProvider, "resolve">,
	signal: AbortSignal,
): Promise<void> {
	const requested = entry.item.projection.desiredConfiguration;
	try {
		await modelProvider.resolve(requested, signal);
		return;
	} catch (error) {
		const parent = parentItem(entry, plan);
		if (!parent) throw error;
		const inherited = parent.projection.desiredConfiguration;
		if (sameModel(requested, inherited)) throw error;
		const fallback: DesiredRuntimeConfiguration = {
			model: inherited.model,
			reasoning: requested.reasoning,
			...(requested.runLimits ? { runLimits: requested.runLimits } : {}),
		};
		assignDesiredConfiguration(entry.item, fallback);
		try {
			await modelProvider.resolve(fallback, signal);
		} catch {
			throw error;
		}
	}
}

export interface SessionLeaseLookup {
	has(sessionId: string): boolean;
}

export function revalidateBatchPlan(
	plan: BatchPlan,
	input: {
		readonly graphs: ReadonlyMap<WorkGraphId, GraphRecord>;
		readonly sessions: SessionLeaseLookup;
	},
): void {
	const newGraphIds = new Set(plan.newGraphs.map(({ id }) => id));
	for (const graph of plan.newGraphs) {
		if (input.graphs.has(graph.id)) {
			throw rejected({
				code: "duplicate_identity",
				message: `Work Graph ${graph.id} was accepted by an earlier batch`,
				graphId: graph.id,
			});
		}
	}
	for (const entry of plan.newItems) {
		if (!newGraphIds.has(entry.graph.id)) {
			if (input.graphs.get(entry.graph.id) !== entry.graph || entry.graph.items.has(entry.item.id)) {
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
		if (entry.item.process.reservedSessionId && input.sessions.has(entry.item.process.reservedSessionId)) {
			throw rejected({
				code: "session_leased",
				message: `Session was leased by an earlier batch: ${entry.item.process.reservedSessionId}`,
				graphId: entry.graph.id,
				itemId: entry.item.id,
			});
		}
		if (!entry.item.parentId) continue;
		const parent =
			plan.newItems.find(
				(candidate) => candidate.graph.id === entry.graph.id && candidate.item.id === entry.item.parentId,
			)?.item ?? entry.graph.items.get(entry.item.parentId);
		if (
			!parent ||
			parent.projection.state === "settling" ||
			isTerminal(parent.projection.state) ||
			parent.projection.cancellationRequested
		) {
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
			item.projection.state === "settling" ||
			isTerminal(item.projection.state) ||
			item.projection.cancellationRequested
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
			(item.projection.promptAccepted ||
				item.process.runtime !== undefined ||
				item.projection.state === "preparing" ||
				item.projection.state === "running")
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
			item.projection.state === "settling" ||
			isTerminal(item.projection.state) ||
			item.projection.cancellationRequested
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
