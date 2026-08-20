import { deepFreeze } from "@coda/agent";
import type {
	PublicationOutcome,
	WorkBudgetUsage,
	WorkGraphId,
	WorkGraphOutcome,
	WorkGraphResult,
	WorkItemId,
	WorkItemState,
	WorkResult,
	WorkspaceArtifact,
	WorkspacePlacementDescriptor,
} from "./types.ts";
import {
	WORK_GRAPH_FACT_VERSION,
	type WorkGraphFact,
	WorkGraphFactCodec,
	type WorkGraphItemDefinition,
} from "./work-graph-fact.ts";
import { isTerminalWorkItemState as isTerminal, workItemTransitionPermitted } from "./work-item-transition.ts";
import {
	INITIAL_WORKER_FACT_PROJECTION,
	reduceWorkerFact,
	type WorkerFactProjection,
	workerFactHasOpenEffects,
} from "./worker-fact.ts";

type TerminalWorkItemState = WorkResult["state"];

export interface WorkGraphInputState {
	readonly batchId: string;
	readonly deliveryId: string;
	readonly kind: Extract<WorkGraphFact, { readonly type: "input_accepted" }>["kind"];
	readonly input: Extract<WorkGraphFact, { readonly type: "input_accepted" }>["input"];
	readonly resourceReferences: readonly string[];
	readonly capabilitySelections?: Extract<WorkGraphFact, { readonly type: "input_accepted" }>["capabilitySelections"];
	readonly acceptedAt: number;
	readonly settlement: "pending" | "committed" | "failed";
	readonly settledAt?: number;
	readonly diagnostic?: string;
}

export type WorkGraphPublicationState =
	| {
			readonly phase: "started";
			readonly startedAt: number;
			readonly artifact: WorkspaceArtifact;
			readonly target?: WorkspacePlacementDescriptor;
	  }
	| {
			readonly phase: "settled";
			readonly startedAt?: number;
			readonly settledAt: number;
			readonly artifact: WorkspaceArtifact;
			readonly publication: PublicationOutcome;
			readonly target?: WorkspacePlacementDescriptor;
	  };

export interface WorkGraphAggregateItem extends WorkGraphItemDefinition {
	readonly acceptedAt: number;
	readonly state: WorkItemState;
	readonly cancellationRequested: boolean;
	readonly startedAt?: number;
	readonly inputs: readonly WorkGraphInputState[];
	readonly worker: WorkerFactProjection;
	readonly publication?: WorkGraphPublicationState;
	readonly ownershipReleased?: {
		readonly timestamp: number;
		readonly preservePlacement: boolean;
	};
	readonly recoveryInterruption?: {
		readonly timestamp: number;
		readonly reasons: readonly string[];
	};
	readonly result?: WorkResult;
}

export interface WorkGraphAggregateGraph {
	readonly graphId: WorkGraphId;
	readonly order: number;
	readonly objective: string;
	readonly rootItemId: WorkItemId;
	readonly maximumConcurrency: number;
	readonly acceptedAt: number;
	readonly cancellationRequested: boolean;
	readonly items: readonly WorkGraphAggregateItem[];
	readonly result?: WorkGraphResult;
}

export interface WorkGraphAggregateSnapshot {
	readonly version: typeof WORK_GRAPH_FACT_VERSION;
	readonly lastTimestamp?: number;
	readonly graph?: WorkGraphAggregateGraph;
}

const EMPTY_WORK_GRAPH_AGGREGATE: WorkGraphAggregateSnapshot = Object.freeze({
	version: WORK_GRAPH_FACT_VERSION,
});

function invalid(fact: WorkGraphFact, diagnostic: string): never {
	throw new Error(`Cannot apply Work Graph Fact ${fact.type}: ${diagnostic}`);
}

function immutableSnapshot(value: WorkGraphAggregateSnapshot): WorkGraphAggregateSnapshot {
	return deepFreeze(value);
}

function dataEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
		return left.every((entry, index) => dataEqual(entry, right[index]));
	}
	const leftRecord = left as Record<string, unknown>;
	const rightRecord = right as Record<string, unknown>;
	const leftKeys = Object.keys(leftRecord).sort();
	const rightKeys = Object.keys(rightRecord).sort();
	return (
		leftKeys.length === rightKeys.length &&
		leftKeys.every((key, index) => key === rightKeys[index] && dataEqual(leftRecord[key], rightRecord[key]))
	);
}

function requireGraph(snapshot: WorkGraphAggregateSnapshot, fact: WorkGraphFact): WorkGraphAggregateGraph {
	const graph = snapshot.graph;
	if (!graph) invalid(fact, "graph_accepted must be the first fact");
	if (graph.graphId !== fact.graphId) invalid(fact, `Graph identity is ${graph.graphId}, not ${fact.graphId}`);
	if (graph.result) invalid(fact, `Work Graph ${graph.graphId} is already settled`);
	return graph;
}

function requireItem(graph: WorkGraphAggregateGraph, itemId: WorkItemId, fact: WorkGraphFact): WorkGraphAggregateItem {
	const item = graph.items.find((candidate) => candidate.itemId === itemId);
	if (!item) invalid(fact, `Work Item ${itemId} does not exist`);
	return item;
}

function replaceItem(
	graph: WorkGraphAggregateGraph,
	itemId: WorkItemId,
	value: WorkGraphAggregateItem,
): WorkGraphAggregateGraph {
	return {
		...graph,
		items: graph.items.map((item) => (item.itemId === itemId ? value : item)),
	};
}

function newItem(definition: WorkGraphItemDefinition, acceptedAt: number): WorkGraphAggregateItem {
	return {
		...definition,
		acceptedAt,
		state: "pending",
		cancellationRequested: false,
		inputs: [],
		worker: INITIAL_WORKER_FACT_PROJECTION,
	};
}

function assertDefinitionIdentityAvailable(
	items: readonly WorkGraphAggregateItem[],
	definition: WorkGraphItemDefinition,
	fact: WorkGraphFact,
): void {
	if (items.some(({ itemId }) => itemId === definition.itemId)) {
		invalid(fact, `duplicate Work Item ${definition.itemId}`);
	}
	if (items.some(({ order }) => order === definition.order)) {
		invalid(fact, `duplicate Work Item order ${definition.order}`);
	}
	if (items.some(({ publicationOrder }) => publicationOrder === definition.publicationOrder)) {
		invalid(fact, `duplicate Publication order ${definition.publicationOrder}`);
	}
	if (items.some(({ runtimeId }) => runtimeId === definition.runtimeId)) {
		invalid(fact, `duplicate Worker Runtime identity ${definition.runtimeId}`);
	}
	if (items.some(({ sessionId }) => sessionId === definition.sessionId)) {
		invalid(fact, `duplicate Session identity ${definition.sessionId}`);
	}
}

function assertAddedItem(
	items: readonly WorkGraphAggregateItem[],
	definition: WorkGraphItemDefinition,
	fact: WorkGraphFact,
): void {
	assertDefinitionIdentityAvailable(items, definition, fact);
	if (definition.order !== items.length) {
		invalid(fact, `Work Item ${definition.itemId} order must be ${items.length}`);
	}
	if (!definition.parentItemId) invalid(fact, `Work Item ${definition.itemId} requires a parent`);
	const parent = items.find(({ itemId }) => itemId === definition.parentItemId);
	if (!parent)
		invalid(fact, `parent Work Item ${definition.parentItemId} does not exist earlier in the fact sequence`);
	if (parent.cancellationRequested || parent.state === "settling" || isTerminal(parent.state)) {
		invalid(fact, `parent Work Item ${parent.itemId} no longer permits delegation`);
	}
	const dependencies = new Set<WorkItemId>();
	for (const dependencyId of definition.dependencies) {
		if (dependencyId === definition.itemId) invalid(fact, `Work Item ${definition.itemId} cannot depend on itself`);
		if (dependencies.has(dependencyId)) invalid(fact, `duplicate dependency ${dependencyId}`);
		if (!items.some(({ itemId }) => itemId === dependencyId)) {
			invalid(fact, `dependency ${dependencyId} does not exist earlier in the fact sequence`);
		}
		dependencies.add(dependencyId);
	}
}

function isDescendant(
	items: readonly WorkGraphAggregateItem[],
	candidate: WorkGraphAggregateItem,
	ancestorId: WorkItemId,
): boolean {
	let current = candidate.parentItemId;
	while (current) {
		if (current === ancestorId) return true;
		current = items.find(({ itemId }) => itemId === current)?.parentItemId;
	}
	return false;
}

function assertArtifactPlacement(item: WorkGraphAggregateItem, artifact: WorkspaceArtifact, fact: WorkGraphFact): void {
	if (artifact.placementId !== item.placement.placementId) {
		invalid(fact, `Workspace Artifact placement changed for Work Item ${item.itemId}`);
	}
	if (artifact.baseIdentity !== item.placement.baseIdentity) {
		invalid(fact, `Workspace Artifact base identity changed for Work Item ${item.itemId}`);
	}
}

function publicationFor(
	item: WorkGraphAggregateItem,
	state: TerminalWorkItemState,
	fact: WorkGraphFact,
): { readonly artifact?: WorkspaceArtifact; readonly publication: PublicationOutcome } {
	if (item.publication?.phase === "started") invalid(fact, `Work Item ${item.itemId} has an open Publication`);
	if (item.publication?.phase === "settled") {
		return { artifact: item.publication.artifact, publication: item.publication.publication };
	}
	if (state === "canceled") return { publication: { state: "not_published", reason: "canceled" } };
	if (state === "interrupted") return { publication: { state: "not_published", reason: "interrupted" } };
	return { publication: { state: "not_required" } };
}

function workBudget(item: WorkGraphAggregateItem, settledAt: number): WorkBudgetUsage {
	return {
		modelAttempts: item.worker.modelAttempts,
		toolInvocations: item.worker.toolInvocations,
		totalTokens: item.worker.totalTokens,
		elapsedMs: Math.max(0, settledAt - item.acceptedAt),
		...(item.worker.exhaustion ? { exhaustion: item.worker.exhaustion } : {}),
	};
}

function createWorkResult(
	item: WorkGraphAggregateItem,
	input: {
		readonly state: TerminalWorkItemState;
		readonly timestamp: number;
		readonly run?: WorkResult["run"];
		readonly evidence?: WorkResult["evidence"];
		readonly diagnostics: WorkResult["diagnostics"];
		readonly blockedBy?: readonly WorkItemId[];
		readonly artifact?: WorkspaceArtifact;
		readonly publication: PublicationOutcome;
	},
): WorkResult {
	return {
		durability: "confirmed",
		itemId: item.itemId,
		...(item.parentItemId ? { parentItemId: item.parentItemId } : {}),
		dependencies: item.dependencies,
		runtimeId: item.runtimeId,
		sessionId: item.sessionId,
		state: input.state,
		...(input.run ? { run: input.run } : {}),
		...(input.evidence ? { evidence: input.evidence } : {}),
		placement: item.placement,
		...(input.artifact ? { artifact: input.artifact } : {}),
		publication: input.publication,
		diagnostics: input.diagnostics,
		timing: {
			acceptedAt: item.acceptedAt,
			...(item.startedAt === undefined ? {} : { startedAt: item.startedAt }),
			settledAt: input.timestamp,
		},
		budget: workBudget(item, input.timestamp),
		...(input.blockedBy ? { blockedBy: input.blockedBy } : {}),
	};
}

function graphOutcome(graph: WorkGraphAggregateGraph, results: readonly WorkResult[]): WorkGraphOutcome {
	const root = results.find(({ itemId }) => itemId === graph.rootItemId);
	if (!root) throw new Error(`Work Graph ${graph.graphId} has no root Work Result`);
	return results.some(({ state }) => state === "interrupted")
		? "interrupted"
		: graph.cancellationRequested || root.state === "canceled"
			? "canceled"
			: root.state === "failed" || root.state === "blocked"
				? "failed"
				: results.some(({ state }) => state !== "succeeded")
					? "partial"
					: "succeeded";
}

function finalPublication(results: readonly WorkResult[]): WorkGraphResult["finalPublication"] {
	const publications = results.map(({ publication }) => publication.state);
	return publications.includes("not_published")
		? publications.includes("published")
			? "mixed"
			: "not_published"
		: publications.includes("published")
			? "published"
			: "not_required";
}

function reduceWorkGraphFact(snapshot: WorkGraphAggregateSnapshot, fact: WorkGraphFact): WorkGraphAggregateSnapshot {
	if (fact.type === "graph_accepted") {
		if (snapshot.graph) invalid(fact, `Work Graph ${snapshot.graph.graphId} is already accepted`);
		if (fact.root.parentItemId !== undefined) invalid(fact, "root Work Item cannot have a parent");
		if (fact.root.dependencies.length > 0) invalid(fact, "root Work Item cannot have dependencies");
		if (fact.root.order !== 0) invalid(fact, "root Work Item order must be zero");
		return {
			version: WORK_GRAPH_FACT_VERSION,
			lastTimestamp: fact.timestamp,
			graph: {
				graphId: fact.graphId,
				order: fact.order,
				objective: fact.objective,
				rootItemId: fact.root.itemId,
				maximumConcurrency: fact.maximumConcurrency,
				acceptedAt: fact.timestamp,
				cancellationRequested: false,
				items: [newItem(fact.root, fact.timestamp)],
			},
		};
	}

	const graph = requireGraph(snapshot, fact);
	let nextGraph: WorkGraphAggregateGraph;
	switch (fact.type) {
		case "items_accepted": {
			if (graph.cancellationRequested) invalid(fact, `Work Graph ${graph.graphId} is canceled`);
			const items = [...graph.items];
			for (const definition of fact.items) {
				assertAddedItem(items, definition, fact);
				items.push(newItem(definition, fact.timestamp));
			}
			nextGraph = { ...graph, items };
			break;
		}
		case "input_accepted": {
			const item = requireItem(graph, fact.itemId, fact);
			if (graph.cancellationRequested || item.cancellationRequested || item.result || isTerminal(item.state)) {
				invalid(fact, `Work Item ${item.itemId} cannot accept input in ${item.state}`);
			}
			if (graph.items.some(({ inputs }) => inputs.some(({ deliveryId }) => deliveryId === fact.deliveryId))) {
				invalid(fact, `duplicate input delivery ${fact.deliveryId}`);
			}
			if (fact.kind === "prompt" && item.inputs.some(({ kind }) => kind === "prompt")) {
				invalid(fact, `Work Item ${item.itemId} already owns a Prompt input`);
			}
			const input: WorkGraphInputState = {
				batchId: fact.batchId,
				deliveryId: fact.deliveryId,
				kind: fact.kind,
				input: fact.input,
				resourceReferences: fact.resourceReferences,
				...(fact.capabilitySelections ? { capabilitySelections: fact.capabilitySelections } : {}),
				acceptedAt: fact.timestamp,
				settlement: fact.resourceReferences.length === 0 ? "committed" : "pending",
				...(fact.resourceReferences.length === 0 ? { settledAt: fact.timestamp } : {}),
			};
			nextGraph = replaceItem(graph, item.itemId, { ...item, inputs: [...item.inputs, input] });
			break;
		}
		case "input_resources_settled": {
			const item = requireItem(graph, fact.itemId, fact);
			const input = item.inputs.find(({ deliveryId }) => deliveryId === fact.deliveryId);
			if (!input) invalid(fact, `input delivery ${fact.deliveryId} does not exist on Work Item ${item.itemId}`);
			if (input.settlement !== "pending") invalid(fact, `input delivery ${fact.deliveryId} is already settled`);
			nextGraph = replaceItem(graph, item.itemId, {
				...item,
				...(fact.outcome === "failed" ? { cancellationRequested: true } : {}),
				inputs: item.inputs.map((candidate) =>
					candidate.deliveryId === fact.deliveryId
						? {
								...candidate,
								settlement: fact.outcome,
								settledAt: fact.timestamp,
								...(fact.diagnostic ? { diagnostic: fact.diagnostic } : {}),
							}
						: candidate,
				),
			});
			break;
		}
		case "item_configuration_changed": {
			const item = requireItem(graph, fact.itemId, fact);
			if (
				graph.cancellationRequested ||
				item.cancellationRequested ||
				item.state === "settling" ||
				isTerminal(item.state)
			) {
				invalid(fact, `Work Item ${item.itemId} cannot be configured in ${item.state}`);
			}
			nextGraph = replaceItem(graph, item.itemId, { ...item, desiredConfiguration: fact.configuration });
			break;
		}
		case "item_transitioned": {
			const item = requireItem(graph, fact.itemId, fact);
			if (item.state !== fact.from) invalid(fact, `Work Item ${item.itemId} is ${item.state}, not ${fact.from}`);
			if (!workItemTransitionPermitted(fact.from, fact.to)) {
				invalid(fact, `invalid Work Item transition ${fact.from} -> ${fact.to}`);
			}
			if (fact.from === "pending" && fact.to === "ready") {
				const dependenciesReady = item.dependencies.every(
					(dependencyId) =>
						graph.items.find(({ itemId }) => itemId === dependencyId)?.result?.state === "succeeded",
				);
				const parent = item.parentItemId
					? graph.items.find(({ itemId }) => itemId === item.parentItemId)
					: undefined;
				const parentReady = !parent || ["preparing", "running", "settling", "succeeded"].includes(parent.state);
				if (!dependenciesReady || !parentReady) {
					invalid(fact, `Work Item ${item.itemId} dependencies or parent are not ready`);
				}
			}
			if (
				(fact.to === "succeeded" || fact.to === "failed") &&
				graph.items.some((candidate) => {
					return candidate.parentItemId === item.itemId && !candidate.result;
				})
			) {
				invalid(fact, `Work Item ${item.itemId} has an unsettled child`);
			}
			if (fact.to !== "interrupted" && isTerminal(fact.to)) {
				if (item.worker.activeRun || workerFactHasOpenEffects(item.worker)) {
					invalid(fact, `Work Item ${item.itemId} has an active Run or open Worker effects`);
				}
			}
			nextGraph = replaceItem(graph, item.itemId, {
				...item,
				state: fact.to,
				...(fact.to === "preparing" && item.startedAt === undefined ? { startedAt: fact.timestamp } : {}),
			});
			break;
		}
		case "worker_fact_recorded": {
			const item = requireItem(graph, fact.itemId, fact);
			if (item.runtimeId !== fact.runtimeId || item.sessionId !== fact.sessionId) {
				invalid(fact, `Worker ownership changed for Work Item ${item.itemId}`);
			}
			if (item.result) invalid(fact, `Work Item ${item.itemId} is already settled`);
			if (fact.fact.type === "run_started") {
				if (item.state !== "preparing" && item.state !== "running") {
					invalid(fact, `Run cannot start in ${item.state}`);
				}
				if (item.state === "preparing" && !workItemTransitionPermitted(item.state, "running", "run_started")) {
					invalid(fact, `invalid Work Item transition ${item.state} -> running`);
				}
			} else if (item.state !== "running") invalid(fact, `Worker Fact cannot be recorded in ${item.state}`);
			const worker = reduceWorkerFact(item.worker, fact.fact);
			nextGraph = replaceItem(graph, item.itemId, {
				...item,
				worker,
				...(fact.fact.type === "run_started" ? { state: "running" as const } : {}),
			});
			break;
		}
		case "cancellation_requested": {
			if (fact.target.type === "graph") {
				nextGraph = {
					...graph,
					cancellationRequested: true,
					items: graph.items.map((item) => ({ ...item, cancellationRequested: true })),
				};
			} else {
				const target = requireItem(graph, fact.target.itemId, fact);
				nextGraph = {
					...graph,
					items: graph.items.map((item) =>
						item.itemId === target.itemId || isDescendant(graph.items, item, target.itemId)
							? { ...item, cancellationRequested: true }
							: item,
					),
				};
			}
			break;
		}
		case "publication_started": {
			const item = requireItem(graph, fact.itemId, fact);
			if (item.state !== "settling") invalid(fact, `Publication cannot start in ${item.state}`);
			if (item.cancellationRequested || graph.cancellationRequested) {
				invalid(fact, `Publication cannot start after cancellation`);
			}
			if (item.publication) invalid(fact, `Work Item ${item.itemId} already has Publication state`);
			assertArtifactPlacement(item, fact.artifact, fact);
			if (item.parentItemId) {
				const target = graph.items.find(({ itemId }) => itemId === item.parentItemId)?.placement;
				if (!fact.target || !target || !dataEqual(fact.target, target)) {
					invalid(fact, `child Work Item ${item.itemId} Publication target must be its parent Placement`);
				}
			} else if (fact.target) invalid(fact, "root Work Item Publication cannot target a parent Placement");
			nextGraph = replaceItem(graph, item.itemId, {
				...item,
				publication: {
					phase: "started",
					startedAt: fact.timestamp,
					artifact: fact.artifact,
					...(fact.target ? { target: fact.target } : {}),
				},
			});
			break;
		}
		case "publication_settled": {
			const item = requireItem(graph, fact.itemId, fact);
			if (item.state !== "settling") invalid(fact, `Publication cannot settle in ${item.state}`);
			if (item.publication?.phase === "settled") invalid(fact, `Work Item ${item.itemId} Publication is settled`);
			assertArtifactPlacement(item, fact.artifact, fact);
			if (item.publication?.phase === "started" && !dataEqual(item.publication.artifact, fact.artifact)) {
				invalid(fact, `Workspace Artifact changed while Publication was open`);
			}
			if (!item.publication && fact.publication.state === "published") {
				invalid(fact, "published outcome requires publication_started");
			}
			if (fact.publication.state === "published") {
				if (!fact.publication.targetPlacementId || !fact.publication.targetIdentity) {
					invalid(fact, "published outcome requires targetPlacementId and targetIdentity");
				}
				if (
					item.publication?.phase === "started" &&
					item.publication.target &&
					item.publication.target.placementId !== fact.publication.targetPlacementId
				) {
					invalid(fact, "published target does not match publication_started");
				}
			}
			nextGraph = replaceItem(graph, item.itemId, {
				...item,
				publication: {
					phase: "settled",
					...(item.publication?.phase === "started" ? { startedAt: item.publication.startedAt } : {}),
					settledAt: fact.timestamp,
					artifact: fact.artifact,
					publication: fact.publication,
					...(item.publication?.phase === "started" && item.publication.target
						? { target: item.publication.target }
						: {}),
				},
			});
			break;
		}
		case "ownership_released": {
			const item = requireItem(graph, fact.itemId, fact);
			if (!item.result) invalid(fact, `Work Item ${item.itemId} has no durable result`);
			if (item.ownershipReleased) invalid(fact, `Work Item ${item.itemId} ownership is already released`);
			nextGraph = replaceItem(graph, item.itemId, {
				...item,
				ownershipReleased: { timestamp: fact.timestamp, preservePlacement: fact.preservePlacement },
			});
			break;
		}
		case "recovery_interrupted": {
			const item = requireItem(graph, fact.itemId, fact);
			if (item.result) invalid(fact, `Work Item ${item.itemId} already has a result`);
			if (item.state !== fact.from) invalid(fact, `Work Item ${item.itemId} is ${item.state}, not ${fact.from}`);
			if (fact.artifact) assertArtifactPlacement(item, fact.artifact, fact);
			if (
				item.publication?.phase === "started" &&
				fact.artifact &&
				!dataEqual(item.publication.artifact, fact.artifact)
			) {
				invalid(fact, "recovered Workspace Artifact changed while Publication was open");
			}
			const diagnostic = fact.reasons.join(", ");
			const settledPublication = item.publication?.phase === "settled" ? item.publication : undefined;
			const artifact = fact.artifact ?? settledPublication?.artifact ?? item.publication?.artifact;
			const publication: PublicationOutcome = settledPublication?.publication ?? {
				state: "not_published",
				reason: "interrupted",
				diagnostic,
			};
			const interrupted: WorkGraphAggregateItem = {
				...item,
				state: "interrupted",
				recoveryInterruption: { timestamp: fact.timestamp, reasons: fact.reasons },
				...(artifact
					? {
							publication: {
								phase: "settled",
								...(item.publication?.startedAt === undefined ? {} : { startedAt: item.publication.startedAt }),
								settledAt: fact.timestamp,
								artifact,
								publication,
								...(item.publication?.target ? { target: item.publication.target } : {}),
							},
						}
					: {}),
			};
			const result = createWorkResult(interrupted, {
				state: "interrupted",
				timestamp: fact.timestamp,
				diagnostics: [
					{
						code: "recovered_interruption",
						message: `Work Item was not replayed after recovery: ${diagnostic}`,
					},
				],
				...(artifact ? { artifact } : {}),
				publication,
			});
			nextGraph = replaceItem(graph, item.itemId, { ...interrupted, result });
			break;
		}
		case "item_result_recorded": {
			const item = requireItem(graph, fact.itemId, fact);
			if (!isTerminal(item.state) || item.state !== fact.state) {
				invalid(fact, `Work Item ${item.itemId} is ${item.state}, not terminal ${fact.state}`);
			}
			if (item.result) invalid(fact, `Work Item ${item.itemId} already has a result`);
			if (fact.state !== "interrupted" && (item.worker.activeRun || workerFactHasOpenEffects(item.worker))) {
				invalid(fact, `Work Item ${item.itemId} has an active Run or open Worker effects`);
			}
			if (fact.state === "succeeded" && fact.run?.outcome !== "success") {
				invalid(fact, "succeeded Work Result requires a successful Run");
			}
			if (fact.state === "blocked") {
				for (const blockedBy of fact.blockedBy ?? []) {
					if (!graph.items.some(({ itemId }) => itemId === blockedBy)) {
						invalid(fact, `blockedBy Work Item ${blockedBy} does not exist`);
					}
				}
			}
			const settled = publicationFor(item, fact.state, fact);
			const result = createWorkResult(item, {
				state: fact.state,
				timestamp: fact.timestamp,
				...(fact.run ? { run: fact.run } : {}),
				...(fact.evidence ? { evidence: fact.evidence } : {}),
				diagnostics: fact.diagnostics,
				...(fact.blockedBy ? { blockedBy: fact.blockedBy } : {}),
				...(settled.artifact ? { artifact: settled.artifact } : {}),
				publication: settled.publication,
			});
			nextGraph = replaceItem(graph, item.itemId, { ...item, result });
			break;
		}
		case "graph_result_recorded": {
			if (graph.items.some(({ result }) => !result)) invalid(fact, "every Work Item must have a durable result");
			if (fact.effectiveConcurrency > graph.maximumConcurrency) {
				invalid(fact, "effectiveConcurrency exceeds maximumConcurrency");
			}
			const results = [...graph.items].sort((left, right) => left.order - right.order).map(({ result }) => result!);
			const result: WorkGraphResult = {
				durability: "confirmed",
				graphId: graph.graphId,
				rootItemId: graph.rootItemId,
				objective: graph.objective,
				outcome: graphOutcome(graph, results),
				maximumConcurrency: graph.maximumConcurrency,
				effectiveConcurrency: fact.effectiveConcurrency,
				results,
				cancellationRequested: graph.cancellationRequested,
				acceptedAt: graph.acceptedAt,
				settledAt: fact.timestamp,
				finalPublication: finalPublication(results),
			};
			nextGraph = { ...graph, result };
			break;
		}
	}
	return {
		version: WORK_GRAPH_FACT_VERSION,
		lastTimestamp: Math.max(snapshot.lastTimestamp ?? 0, fact.timestamp),
		graph: nextGraph,
	};
}

/**
 * Immutable authoritative Work Graph reducer. `apply` is the only transition
 * operation; `replay` decodes persisted values and delegates to that same path.
 */
export class WorkGraphAggregate {
	readonly #snapshot: WorkGraphAggregateSnapshot;

	private constructor(snapshot: WorkGraphAggregateSnapshot) {
		this.#snapshot = snapshot;
	}

	static empty(): WorkGraphAggregate {
		return new WorkGraphAggregate(EMPTY_WORK_GRAPH_AGGREGATE);
	}

	static replay(values: readonly unknown[]): WorkGraphAggregate {
		let aggregate = WorkGraphAggregate.empty();
		for (const value of values) aggregate = aggregate.apply(WorkGraphFactCodec.decode(value));
		return aggregate;
	}

	apply(fact: WorkGraphFact): WorkGraphAggregate {
		const validated = WorkGraphFactCodec.decode(fact);
		return new WorkGraphAggregate(immutableSnapshot(reduceWorkGraphFact(this.#snapshot, validated)));
	}

	snapshot(): WorkGraphAggregateSnapshot {
		return this.#snapshot;
	}
}
