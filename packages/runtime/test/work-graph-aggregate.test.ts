import { describe, expect, it } from "vitest";
import type {
	DesiredRuntimeConfiguration,
	WorkGraphId,
	WorkItemId,
	WorkspaceArtifact,
	WorkspacePlacementDescriptor,
} from "../src/work-graph/types.ts";
import { WorkGraphAggregate } from "../src/work-graph/work-graph-aggregate.ts";
import {
	MAXIMUM_WORK_GRAPH_IDENTITY_LENGTH,
	type WorkGraphFact,
	WorkGraphFactCodec,
	type WorkGraphItemDefinition,
} from "../src/work-graph/work-graph-fact.ts";
import type { WorkerFact } from "../src/work-graph/worker-fact.ts";

const graphId = "graph:test" as WorkGraphId;

function configuration(seed = 0): DesiredRuntimeConfiguration {
	return {
		model: { provider: "test", id: `model:${seed}` },
		reasoning: seed % 2 === 0 ? "high" : "off",
		runLimits: { maxTurns: 8 + seed, maxToolInvocations: 32 + seed },
	};
}

function placement(itemId: string): WorkspacePlacementDescriptor {
	return {
		placementId: `placement:${itemId}`,
		root: `/workspace/${itemId}`,
		baseIdentity: `base:${itemId}`,
		targetPlacementId: `target:${itemId}`,
		targetIdentity: `target-state:${itemId}`,
		kind: "memory",
	};
}

function definition(item: string, order: number, publicationOrder: number, parent?: string): WorkGraphItemDefinition {
	return {
		itemId: item as WorkItemId,
		order,
		...(parent ? { parentItemId: parent as WorkItemId } : {}),
		dependencies: [],
		objective: `Objective for ${item}`,
		executionMode: "write",
		desiredConfiguration: configuration(order),
		publicationOrder,
		runtimeId: `worker:${item}`,
		sessionId: `session:${item}`,
		placement: placement(item),
	};
}

function artifact(item: WorkGraphItemDefinition): WorkspaceArtifact {
	return {
		artifactId: `artifact:${item.itemId}`,
		placementId: item.placement.placementId,
		baseIdentity: item.placement.baseIdentity,
		kind: "memory",
		reference: `memory:${item.itemId}`,
		metadata: { changedPaths: [`${item.itemId}.ts`] },
	};
}

function codecFacts(): readonly WorkGraphFact[] {
	const root = definition("item:root", 0, 10);
	const child = definition("item:child", 1, 11, "item:root");
	return [
		{
			version: 1,
			type: "graph_accepted",
			graphId,
			timestamp: 1,
			batchId: "batch:1",
			order: 0,
			objective: "Test graph",
			maximumConcurrency: 4,
			root,
		},
		{
			version: 1,
			type: "items_accepted",
			graphId,
			timestamp: 2,
			batchId: "batch:2",
			items: [child],
		},
		{
			version: 1,
			type: "input_accepted",
			graphId,
			timestamp: 3,
			batchId: "batch:3",
			deliveryId: "delivery:1",
			itemId: root.itemId,
			kind: "prompt",
			input: [
				{ type: "text", text: "Implement it" },
				{ type: "skill", name: "design", path: "/skills/design/SKILL.md" },
			],
			resourceReferences: ["resource:1"],
		},
		{
			version: 1,
			type: "input_resources_settled",
			graphId,
			timestamp: 4,
			deliveryId: "delivery:1",
			itemId: root.itemId,
			outcome: "failed",
			diagnostic: "resource commit failed",
		},
		{
			version: 1,
			type: "item_configuration_changed",
			graphId,
			timestamp: 5,
			batchId: "batch:4",
			itemId: root.itemId,
			configuration: configuration(4),
		},
		{
			version: 1,
			type: "item_transitioned",
			graphId,
			timestamp: 6,
			itemId: root.itemId,
			from: "pending",
			to: "ready",
		},
		{
			version: 1,
			type: "worker_fact_recorded",
			graphId,
			timestamp: 7,
			itemId: root.itemId,
			runtimeId: root.runtimeId,
			sessionId: root.sessionId,
			fact: { type: "run_started", runId: "run:1", source: "prompt", timestamp: 7 },
		},
		{
			version: 1,
			type: "cancellation_requested",
			graphId,
			timestamp: 8,
			batchId: "batch:5",
			target: { type: "item", itemId: child.itemId },
		},
		{
			version: 1,
			type: "publication_started",
			graphId,
			timestamp: 9,
			itemId: child.itemId,
			artifact: artifact(child),
			target: root.placement,
		},
		{
			version: 1,
			type: "publication_settled",
			graphId,
			timestamp: 10,
			itemId: child.itemId,
			artifact: artifact(child),
			publication: { state: "not_published", reason: "failed", diagnostic: "conflict" },
		},
		{
			version: 1,
			type: "ownership_released",
			graphId,
			timestamp: 11,
			itemId: child.itemId,
			preservePlacement: true,
		},
		{
			version: 1,
			type: "recovery_interrupted",
			graphId,
			timestamp: 12,
			itemId: child.itemId,
			from: "running",
			reasons: ["unclosed_tool_invocation"],
			artifact: artifact(child),
		},
		{
			version: 1,
			type: "item_result_recorded",
			graphId,
			timestamp: 13,
			itemId: child.itemId,
			state: "blocked",
			diagnostics: [{ code: "dependency_failed", message: "Dependency failed" }],
			blockedBy: [root.itemId],
		},
		{
			version: 1,
			type: "graph_result_recorded",
			graphId,
			timestamp: 14,
			effectiveConcurrency: 2,
		},
	];
}

type ChildMode = "succeeded" | "canceled" | "recovered";

function sequence(seed: number, modes?: readonly ChildMode[]): readonly WorkGraphFact[] {
	const root = definition("item:root", 0, seed * 100 + 1);
	const childModes =
		modes ??
		Array.from({ length: 1 + (seed % 5) }, (_, index) => {
			const value = (seed * 17 + index * 13) % 7;
			return value === 0 ? "recovered" : value < 3 ? "canceled" : "succeeded";
		});
	const children = childModes.map((_, index) =>
		definition(`item:child:${index}`, index + 1, seed * 100 + index + 2, String(root.itemId)),
	);
	const facts: WorkGraphFact[] = [];
	let timestamp = 0;
	let batch = 0;
	const record = (value: Record<string, unknown>): void => {
		facts.push({ version: 1, graphId, timestamp: ++timestamp, ...value } as WorkGraphFact);
	};
	const worker = (item: WorkGraphItemDefinition, value: Record<string, unknown>): void => {
		const workerTimestamp = ++timestamp;
		facts.push({
			version: 1,
			type: "worker_fact_recorded",
			graphId,
			timestamp: workerTimestamp,
			itemId: item.itemId,
			runtimeId: item.runtimeId,
			sessionId: item.sessionId,
			fact: { ...value, timestamp: workerTimestamp } as WorkerFact,
		});
	};
	const input = (item: WorkGraphItemDefinition, resources: boolean): void => {
		record({
			type: "input_accepted",
			batchId: `batch:${++batch}`,
			deliveryId: `delivery:${item.itemId}`,
			itemId: item.itemId,
			kind: "prompt",
			input: `Prompt for ${item.itemId}`,
			resourceReferences: resources ? [`resource:${item.itemId}`] : [],
		});
	};
	const start = (item: WorkGraphItemDefinition): void => {
		record({ type: "item_transitioned", itemId: item.itemId, from: "pending", to: "ready" });
		record({ type: "item_transitioned", itemId: item.itemId, from: "ready", to: "preparing" });
		worker(item, { type: "run_started", runId: `run:${item.itemId}`, source: "prompt" });
		worker(item, {
			type: "attempt_started",
			runId: `run:${item.itemId}`,
			turnId: `turn:${item.itemId}`,
			attemptId: `attempt:${item.itemId}`,
			messageId: `message:${item.itemId}`,
			attempt: 1,
		});
		worker(item, {
			type: "attempt_settled",
			runId: `run:${item.itemId}`,
			turnId: `turn:${item.itemId}`,
			attemptId: `attempt:${item.itemId}`,
			messageId: `message:${item.itemId}`,
			attempt: 1,
			outcome: "success",
			discarded: false,
			totalTokens: 10 + seed,
		});
		if ((seed + item.order) % 2 === 0) {
			worker(item, {
				type: "tool_started",
				runId: `run:${item.itemId}`,
				turnId: `turn:${item.itemId}`,
				invocationId: `tool:${item.itemId}`,
				toolName: "read",
				replaySafety: "safe",
			});
			worker(item, {
				type: "tool_settled",
				runId: `run:${item.itemId}`,
				turnId: `turn:${item.itemId}`,
				invocationId: `tool:${item.itemId}`,
				settlement: "returned",
				outcome: "success",
			});
		}
	};
	const finish = (item: WorkGraphItemDefinition, publish: boolean): void => {
		worker(item, { type: "run_settled", runId: `run:${item.itemId}`, outcome: "success" });
		record({ type: "item_transitioned", itemId: item.itemId, from: "running", to: "settling" });
		if (publish) {
			const target = item.parentItemId
				? (children.find(({ itemId }) => itemId === item.parentItemId)?.placement ?? root.placement)
				: undefined;
			record({
				type: "publication_started",
				itemId: item.itemId,
				artifact: artifact(item),
				...(target ? { target } : {}),
			});
			record({
				type: "publication_settled",
				itemId: item.itemId,
				artifact: artifact(item),
				publication: {
					state: "published",
					publicationId: `publication:${item.itemId}`,
					targetPlacementId: target?.placementId ?? "workspace:source",
					targetIdentity: `published:${item.itemId}`,
				},
			});
		}
		record({ type: "item_transitioned", itemId: item.itemId, from: "settling", to: "succeeded" });
		record({
			type: "item_result_recorded",
			itemId: item.itemId,
			state: "succeeded",
			run: { runId: `run:${item.itemId}`, outcome: "success", assistantText: "Done" },
			evidence: { version: 1, facts: { verified: true, seed } },
			diagnostics: [],
		});
		record({ type: "ownership_released", itemId: item.itemId, preservePlacement: false });
	};

	record({
		type: "graph_accepted",
		batchId: `batch:${++batch}`,
		order: seed,
		objective: `Graph ${seed}`,
		maximumConcurrency: 8,
		root,
	});
	if (children.length > 0) {
		record({ type: "items_accepted", batchId: `batch:${++batch}`, items: children });
	}
	input(root, false);
	start(root);

	for (const [index, item] of children.entries()) {
		const mode = childModes[index];
		const usesResources = (seed + index) % 2 === 0;
		input(item, usesResources);
		if (usesResources) {
			record({
				type: "input_resources_settled",
				deliveryId: `delivery:${item.itemId}`,
				itemId: item.itemId,
				outcome: mode === "recovered" ? "failed" : "committed",
				...(mode === "recovered" ? { diagnostic: "resource settlement failed" } : {}),
			});
		}
		if (mode === "canceled") {
			record({
				type: "cancellation_requested",
				batchId: `batch:${++batch}`,
				target: { type: "item", itemId: item.itemId },
			});
			record({ type: "item_transitioned", itemId: item.itemId, from: "pending", to: "canceled" });
			record({ type: "item_result_recorded", itemId: item.itemId, state: "canceled", diagnostics: [] });
			record({ type: "ownership_released", itemId: item.itemId, preservePlacement: false });
			continue;
		}
		if (mode === "recovered") {
			record({
				type: "recovery_interrupted",
				itemId: item.itemId,
				from: "pending",
				reasons: ["input_resource_commit_failed"],
			});
			record({ type: "ownership_released", itemId: item.itemId, preservePlacement: true });
			continue;
		}
		start(item);
		finish(item, true);
	}

	finish(root, seed % 3 === 0);
	record({ type: "graph_result_recorded", effectiveConcurrency: Math.min(2 + (seed % 4), 8) });
	return facts;
}

function reduce(facts: readonly WorkGraphFact[]): WorkGraphAggregate {
	let aggregate = WorkGraphAggregate.empty();
	for (const fact of facts) aggregate = aggregate.apply(fact);
	return aggregate;
}

describe("WorkGraphFact codec", () => {
	it("round-trips every fact variant as immutable exact data", () => {
		const expectedTypes: WorkGraphFact["type"][] = [
			"graph_accepted",
			"items_accepted",
			"input_accepted",
			"input_resources_settled",
			"item_configuration_changed",
			"item_transitioned",
			"worker_fact_recorded",
			"cancellation_requested",
			"publication_started",
			"publication_settled",
			"ownership_released",
			"recovery_interrupted",
			"item_result_recorded",
			"graph_result_recorded",
		];
		const facts = codecFacts();
		expect(facts.map(({ type }) => type)).toEqual(expectedTypes);
		for (const fact of facts) {
			const encoded = WorkGraphFactCodec.encode(fact);
			const decoded = WorkGraphFactCodec.decode(JSON.parse(JSON.stringify(encoded)));
			expect(decoded, fact.type).toEqual(fact);
			expect(Object.isFrozen(decoded), fact.type).toBe(true);
		}
		const accepted = facts[0] as Extract<WorkGraphFact, { readonly type: "graph_accepted" }>;
		expect(() =>
			WorkGraphFactCodec.decode({
				...accepted,
				root: {
					...accepted.root,
					placement: { ...accepted.root.placement, baseIdentity: "direct:/Users/example/workspace" },
				},
			}),
		).not.toThrow();
	});

	it("rejects hidden keys, malformed nested values, unknown versions, and unbounded identities", () => {
		const accepted = codecFacts()[0] as Extract<WorkGraphFact, { readonly type: "graph_accepted" }>;
		expect(() => WorkGraphFactCodec.decode({ ...accepted, payload: {} })).toThrow("unexpected field payload");
		expect(() => WorkGraphFactCodec.decode({ ...accepted, root: { ...accepted.root, secret: true } })).toThrow(
			"unexpected field secret",
		);
		expect(() =>
			WorkGraphFactCodec.decode({
				...accepted,
				root: {
					...accepted.root,
					desiredConfiguration: {
						...accepted.root.desiredConfiguration,
						model: { ...accepted.root.desiredConfiguration.model, secret: "value" },
					},
				},
			}),
		).toThrow("unexpected field secret");
		expect(() => WorkGraphFactCodec.decode({ ...accepted, version: 2 })).toThrow("version must be 1");
		expect(() =>
			WorkGraphFactCodec.decode({ ...accepted, graphId: `g${"x".repeat(MAXIMUM_WORK_GRAPH_IDENTITY_LENGTH)}` }),
		).toThrow("bounded opaque identity");
		expect(() => WorkGraphFactCodec.decode({ ...accepted, timestamp: Number.NaN })).toThrow("finite numbers");
		expect(() => WorkGraphFactCodec.decode({ ...codecFacts()[8], target: undefined })).toThrow("not JSON-compatible");
	});

	it("rejects invalid Result, Publication, and settlement combinations before reduction", () => {
		const blocked = codecFacts()[12] as Extract<WorkGraphFact, { readonly type: "item_result_recorded" }>;
		expect(() => WorkGraphFactCodec.decode({ ...blocked, blockedBy: undefined })).toThrow("not JSON-compatible");
		expect(() => WorkGraphFactCodec.decode({ ...blocked, state: "succeeded" })).toThrow(
			"only blocked results may carry blockedBy",
		);
		const publication = codecFacts()[9] as Extract<WorkGraphFact, { readonly type: "publication_settled" }>;
		expect(() =>
			WorkGraphFactCodec.decode({ ...publication, publication: { ...publication.publication, secret: true } }),
		).toThrow("unexpected field secret");
		const settlement = codecFacts()[3] as Extract<WorkGraphFact, { readonly type: "input_resources_settled" }>;
		expect(() => WorkGraphFactCodec.decode({ ...settlement, outcome: "committed" })).toThrow(
			"committed settlement cannot carry diagnostic",
		);
	});
});

describe("WorkGraphAggregate", () => {
	it("reduces the complete lifecycle into structured durable state without runtime handles", () => {
		const aggregate = reduce(sequence(6, ["succeeded", "canceled"]));
		const snapshot = aggregate.snapshot();
		expect(snapshot.graph?.result).toMatchObject({
			durability: "confirmed",
			outcome: "partial",
			finalPublication: "mixed",
			effectiveConcurrency: 4,
		});
		expect(snapshot.graph?.items.map(({ state }) => state)).toEqual(["succeeded", "succeeded", "canceled"]);
		expect(snapshot.graph?.items[0]?.worker).toMatchObject({ modelAttempts: 1, totalTokens: 16 });
		expect(snapshot.graph?.items[1]?.publication).toMatchObject({
			phase: "settled",
			publication: { state: "published" },
		});
		for (const item of snapshot.graph?.items ?? []) {
			expect(item).not.toHaveProperty("runtime");
			expect(item).not.toHaveProperty("session");
			expect(item).not.toHaveProperty("controller");
			expect(item).not.toHaveProperty("promise");
			expect(Object.isFrozen(item)).toBe(true);
		}
	});

	it("uses apply for both live mutation and decoded replay across randomized valid histories", () => {
		for (let seed = 0; seed < 64; seed++) {
			const facts = sequence(seed);
			let live = WorkGraphAggregate.empty();
			const encoded: unknown[] = [];
			for (const fact of facts) {
				live = live.apply(fact);
				encoded.push(JSON.parse(JSON.stringify(WorkGraphFactCodec.encode(fact))));
				if (seed < 8) {
					const replayedPrefix = WorkGraphAggregate.replay(encoded);
					expect(replayedPrefix.snapshot(), `seed ${seed}, fact ${fact.type}`).toEqual(live.snapshot());
				}
			}
			expect(WorkGraphAggregate.replay(encoded).snapshot()).toEqual(live.snapshot());
		}
	});

	it("records recovery interruption as a confirmed terminal result while preserving open-effect evidence", () => {
		const aggregate = reduce(sequence(5, ["recovered"]));
		const recovered = aggregate.snapshot().graph?.items[1];
		expect(recovered).toMatchObject({
			state: "interrupted",
			recoveryInterruption: { reasons: ["input_resource_commit_failed"] },
			result: {
				durability: "confirmed",
				state: "interrupted",
				publication: { state: "not_published", reason: "interrupted" },
			},
			ownershipReleased: { preservePlacement: true },
		});
		expect(aggregate.snapshot().graph?.result?.outcome).toBe("interrupted");
	});

	it("rejects invalid order deterministically without mutating the prior aggregate", () => {
		const accepted = codecFacts()[0] as Extract<WorkGraphFact, { readonly type: "graph_accepted" }>;
		const aggregate = WorkGraphAggregate.empty().apply(accepted);
		const before = aggregate.snapshot();
		const invalidFacts: WorkGraphFact[] = [
			{ ...accepted, timestamp: 2 },
			{
				version: 1,
				type: "item_transitioned",
				graphId,
				timestamp: 2,
				itemId: accepted.root.itemId,
				from: "pending",
				to: "running",
			},
			{
				version: 1,
				type: "publication_started",
				graphId,
				timestamp: 2,
				itemId: accepted.root.itemId,
				artifact: artifact(accepted.root),
			},
			{
				version: 1,
				type: "ownership_released",
				graphId,
				timestamp: 2,
				itemId: accepted.root.itemId,
				preservePlacement: false,
			},
			{
				version: 1,
				type: "graph_result_recorded",
				graphId,
				timestamp: 2,
				effectiveConcurrency: 1,
			},
		];
		for (const fact of invalidFacts) {
			expect(() => aggregate.apply(fact), fact.type).toThrow();
			expect(aggregate.snapshot(), fact.type).toBe(before);
		}
		expect(() =>
			aggregate.apply({
				version: 1,
				type: "item_transitioned",
				graphId,
				timestamp: 0,
				itemId: accepted.root.itemId,
				from: "pending",
				to: "ready",
			}),
		).toThrow("precedes");
	});

	it("rejects recovery ownership mismatches and malformed effect ordering", () => {
		const facts = sequence(1, []);
		const startedIndex = facts.findIndex(
			(fact) => fact.type === "worker_fact_recorded" && fact.fact.type === "run_started",
		);
		const running = reduce(facts.slice(0, startedIndex + 1));
		const started = facts[startedIndex] as Extract<WorkGraphFact, { readonly type: "worker_fact_recorded" }>;
		expect(() =>
			running.apply({
				...started,
				timestamp: started.timestamp + 1,
				runtimeId: "worker:other",
				fact: { ...started.fact, timestamp: started.timestamp + 1 },
			}),
		).toThrow("Worker ownership changed");
		expect(() =>
			running.apply({
				version: 1,
				type: "item_result_recorded",
				graphId,
				timestamp: started.timestamp + 1,
				itemId: started.itemId,
				state: "succeeded",
				run: { runId: String(started.fact.runId), outcome: "success" },
				diagnostics: [],
			}),
		).toThrow("not terminal");
		expect(() =>
			running.apply({
				version: 1,
				type: "recovery_interrupted",
				graphId,
				timestamp: started.timestamp + 1,
				itemId: started.itemId,
				from: "preparing",
				reasons: ["unclosed_model_attempt"],
			}),
		).toThrow("not preparing");
	});
});
