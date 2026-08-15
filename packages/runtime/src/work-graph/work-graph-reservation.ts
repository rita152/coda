import type { InputResourceStore, WorkSessionStore, WorkspacePlacement } from "./ports.ts";
import type { CodingAgentRejection, WorkDiagnostic, WorkGraphId, WorkItemId } from "./types.ts";
import { WORK_GRAPH_FACT_VERSION, type WorkGraphFact } from "./work-graph-fact.ts";
import type { BatchPlan } from "./work-graph-planner.ts";
import { type DeliveryPlan, errorMessage, type GraphRecord, type ItemRecord } from "./work-graph-records.ts";

export interface ReservationRejectionPort {
	assertIdentity(value: unknown, kind: "graph" | "item" | "session"): string;
	rejected(rejection: CodingAgentRejection): Error;
}

export async function reserveBatch(
	plan: BatchPlan,
	input: {
		readonly placement: WorkspacePlacement;
		readonly sessions: WorkSessionStore;
		readonly resources?: InputResourceStore;
		readonly sessionLeases: { has(sessionId: string): boolean };
		readonly rejection: ReservationRejectionPort;
	},
): Promise<void> {
	const batchSessions = new Set<string>();
	for (const entry of plan.newItems) {
		const parent = entry.item.parentId
			? (plan.newItems.find(
					(candidate) => candidate.graph.id === entry.graph.id && candidate.item.id === entry.item.parentId,
				)?.item ?? entry.graph.items.get(entry.item.parentId))
			: undefined;
		try {
			entry.item.placement = await input.placement.reserve({
				graphId: entry.graph.id,
				itemId: entry.item.id,
				...(entry.item.parentId ? { parentItemId: entry.item.parentId } : {}),
				...(parent?.placement ? { parent: parent.placement.placement } : {}),
				mode: entry.item.executionMode,
				sourceOrder: entry.item.order,
				publicationOrder: entry.item.publicationOrder,
			});
		} catch (error) {
			throw input.rejection.rejected({
				code: "placement_reservation_failed",
				message: `Workspace Placement reservation failed for ${entry.item.id}: ${errorMessage(error)}`,
				graphId: entry.graph.id,
				itemId: entry.item.id,
			});
		}
		try {
			entry.item.session = await input.sessions.reserve({
				graphId: entry.graph.id,
				itemId: entry.item.id,
				...(entry.item.parentId ? { parentItemId: entry.item.parentId } : {}),
				target: entry.sessionTarget,
				placement: entry.item.placement.placement,
			});
		} catch (error) {
			throw input.rejection.rejected({
				code: "session_reservation_failed",
				message: `Session reservation failed for ${entry.item.id}: ${errorMessage(error)}`,
				graphId: entry.graph.id,
				itemId: entry.item.id,
			});
		}
		const sessionId = input.rejection.assertIdentity(String(entry.item.session.session.id), "session");
		entry.item.reservedSessionId = sessionId;
		entry.item.reservedPlacementDescriptor = entry.item.placement.placement;
		if (input.sessionLeases.has(sessionId) || batchSessions.has(sessionId)) {
			throw input.rejection.rejected({
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
		if (!input.resources) {
			throw input.rejection.rejected({
				code: "resource_reservation_failed",
				message: "Input resources were supplied but no resource store is configured",
				graphId: delivery.graph.id,
				itemId: delivery.item.id,
			});
		}
		try {
			delivery.resource = await input.resources.reserve({
				graphId: delivery.graph.id,
				itemId: delivery.item.id,
				input: delivery.command.input,
				references: delivery.command.resources ?? [],
			});
		} catch (error) {
			throw input.rejection.rejected({
				code: "resource_reservation_failed",
				message: `Input resource reservation failed: ${errorMessage(error)}`,
				graphId: delivery.graph.id,
				itemId: delivery.item.id,
			});
		}
	}
}

export async function commitOwnershipReservations(
	plan: BatchPlan,
	rejected: ReservationRejectionPort["rejected"],
): Promise<void> {
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

export async function rollbackReservations(
	plan: BatchPlan,
	diagnose: (diagnostic: WorkDiagnostic) => void,
): Promise<void> {
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
		diagnose({
			code: "reservation_rollback_failed",
			message: `${failures.length} unaccepted reservation rollback operation(s) failed`,
		});
	}
}

export interface AcceptedInputResourceHost {
	now(): number;
	graphMutation<Result>(graphId: WorkGraphId, operation: () => Promise<Result> | Result): Promise<Result>;
	appendGraphFacts(graph: GraphRecord, facts: readonly WorkGraphFact[]): Promise<void>;
	settleInputAdmission(
		item: ItemRecord,
		deliveryId: string,
		outcome: "committed" | "failed",
		diagnostic?: string,
	): readonly string[];
	diagnose(diagnostic: WorkDiagnostic, graphId?: WorkGraphId, itemId?: WorkItemId): void;
	interruptForInputResourceFailure(graph: GraphRecord, item: ItemRecord): Promise<void>;
	flushPendingInputs(item: ItemRecord): void;
	requestSchedule(): void;
}

export async function settleAcceptedInputResources(plan: BatchPlan, host: AcceptedInputResourceHost): Promise<void> {
	await Promise.all(
		plan.deliveries
			.filter(({ command }) => (command.resources?.length ?? 0) > 0)
			.map((delivery) => settleAcceptedInputResource(delivery, host)),
	);
}

async function settleAcceptedInputResource(delivery: DeliveryPlan, host: AcceptedInputResourceHost): Promise<void> {
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
		failures = await host.graphMutation(delivery.graph.id, async () => {
			await host.appendGraphFacts(delivery.graph, [
				{
					version: WORK_GRAPH_FACT_VERSION,
					type: "input_resources_settled",
					graphId: delivery.graph.id,
					itemId: delivery.item.id,
					deliveryId: delivery.deliveryId,
					outcome,
					timestamp: Math.max(host.now(), delivery.graph.aggregate.snapshot().lastTimestamp ?? 0),
					...(outcome === "failed" ? { diagnostic: diagnostic ?? "Input resource commit failed" } : {}),
				},
			]);
			return host.settleInputAdmission(delivery.item, delivery.deliveryId, outcome, diagnostic);
		});
	} catch (error) {
		host.diagnose(
			{
				code: "input_resource_settlement_unknown",
				message: `Input resource settlement was not persisted: ${errorMessage(error)}`,
			},
			delivery.graph.id,
			delivery.item.id,
		);
		return;
	}

	if (failures.length > 0) await host.interruptForInputResourceFailure(delivery.graph, delivery.item);
	else host.flushPendingInputs(delivery.item);
	host.requestSchedule();
}
