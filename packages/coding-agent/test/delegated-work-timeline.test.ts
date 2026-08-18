import type { AgentEvent, AgentMessage, MessageId } from "@coda/agent";
import type { AssistantMessage } from "@coda/ai";
import type { CodingAgentObservation, WorkGraphId, WorkItemId, WorkResult } from "@coda/runtime";
import { describe, expect, it } from "vitest";
import { ActivityProjection } from "../src/ui/activity-status.ts";
import { SemanticTimeline } from "../src/ui/semantic-timeline.ts";

const GRAPH = "graph:parent" as WorkGraphId;
const ROOT = "root" as WorkItemId;
const ALPHA = "alpha" as WorkItemId;
const BETA = "beta" as WorkItemId;

describe("delegated Work Item Timeline projection", () => {
	it("projects parallel sibling Work Items under the parent delegate Tool", () => {
		const timeline = new SemanticTimeline();
		acceptParentDelegate(timeline);

		timeline.acceptObservation(itemState(ALPHA, "pending", "running"));
		timeline.acceptObservation(itemState(BETA, "pending", "ready"));
		timeline.acceptObservation(
			workEvent(
				ALPHA,
				event({
					type: "tool_execution_start",
					turnId: "child-turn-a",
					sequence: 2,
					invocation: childInvocation("write-a", "write:alpha", "write", { path: "alpha.txt" }),
				}),
			),
		);

		const children = delegatedChildren(timeline);
		expect(children.map((child) => [child.itemId, child.objective, child.executionMode, child.state])).toEqual([
			["alpha", "write alpha", "write", "running"],
			["beta", "write beta", "write", "ready"],
		]);
		expect(children[0]?.currentTool).toEqual({ name: "write", state: "running" });
		expect(children[0]?.tools.map((tool) => tool.invocation.toolName)).toEqual(["write"]);
		expect(children[1]?.currentTool).toBeUndefined();
	});

	it("shows a failed child Work Result summary without using assistant prose as success", () => {
		const timeline = new SemanticTimeline();
		acceptParentDelegate(timeline);
		timeline.acceptObservation(itemState(ALPHA, "running", "failed"));
		timeline.acceptObservation(
			settled({
				itemId: ALPHA,
				state: "failed",
				publication: { state: "not_published", reason: "failed", diagnostic: "write conflict" },
				diagnostics: [{ code: "worker_failed", message: "write failed" }],
				run: { runId: "run:alpha", outcome: "error", assistantText: "I successfully wrote the file." },
			}),
		);

		const [child] = delegatedChildren(timeline);
		expect(child?.state).toBe("failed");
		expect(child?.result).toEqual({
			state: "failed",
			publication: "not_published",
			diagnostics: [{ code: "worker_failed", message: "write failed" }],
		});
		expect(JSON.stringify(child)).not.toContain("I successfully wrote the file.");
	});

	it("shows an interrupted child Work Result summary", () => {
		const timeline = new SemanticTimeline();
		acceptParentDelegate(timeline);
		timeline.acceptObservation(
			settled({
				itemId: ALPHA,
				state: "interrupted",
				publication: { state: "not_published", reason: "interrupted" },
				diagnostics: [{ code: "worker_interrupted", message: "canceled while running" }],
			}),
		);

		const [child] = delegatedChildren(timeline);
		expect(child?.state).toBe("interrupted");
		expect(child?.result).toEqual({
			state: "interrupted",
			publication: "not_published",
			diagnostics: [{ code: "worker_interrupted", message: "canceled while running" }],
		});
	});

	it("rebuilds the same child projection from a Coding Agent snapshot after resync", () => {
		const timeline = new SemanticTimeline();
		acceptParentDelegate(timeline);
		timeline.acceptObservation(itemState(ALPHA, "pending", "running"));
		timeline.acceptObservation(itemState(BETA, "pending", "running"));
		timeline.resynchronizeObservation({
			type: "snapshot",
			sequence: 9,
			snapshot: {
				closed: false,
				graphs: [
					{
						graphId: GRAPH,
						objective: "delegate two writers",
						rootItemId: ROOT,
						maximumConcurrency: 2,
						activeConcurrency: 1,
						effectiveConcurrency: 2,
						cancellationRequested: false,
						items: [
							itemSnapshot(ROOT, { state: "running", parentItemId: undefined, objective: "parent" }),
							itemSnapshot(ALPHA, {
								state: "failed",
								result: workResult({
									itemId: ALPHA,
									state: "failed",
									publication: { state: "not_published", reason: "failed" },
									diagnostics: [{ code: "worker_failed", message: "alpha failed" }],
								}),
							}),
							itemSnapshot(BETA, { state: "running" }),
						],
					},
				],
			},
		});

		expect(delegatedChildren(timeline).map((child) => [child.itemId, child.state, child.result?.state])).toEqual([
			["alpha", "failed", "failed"],
			["beta", "running", undefined],
		]);
	});
});

describe("delegated Work Item Activity projection", () => {
	it("says the parent delegate is waiting for N child Work Items", () => {
		const activity = new ActivityProjection("fallback");
		activity.accept(
			event({
				type: "run_start",
				source: "prompt",
				inputMessage: { id: "user-1", message: { role: "user", content: [{ type: "text", text: "go" }] } },
			}),
		);
		activity.acceptObservation(itemState(ALPHA, "pending", "running"));
		activity.acceptObservation(itemState(BETA, "pending", "ready"));

		expect(activity.status(1_000)?.text).toBe("Waiting for 2 child Work Items");
	});

	it("does not treat the graph-root Work Item as a waiting child", () => {
		const activity = new ActivityProjection("fallback");
		activity.accept(
			event({
				type: "run_start",
				source: "prompt",
				inputMessage: { id: "user-1", message: { role: "user", content: [{ type: "text", text: "go" }] } },
			}),
		);
		activity.acceptObservation({
			type: "snapshot",
			sequence: 0,
			snapshot: {
				closed: false,
				graphs: [
					{
						graphId: GRAPH,
						objective: "parent",
						rootItemId: ROOT,
						maximumConcurrency: 1,
						activeConcurrency: 1,
						effectiveConcurrency: 1,
						cancellationRequested: false,
						items: [itemSnapshot(ROOT, { state: "running", parentItemId: undefined, objective: "parent" })],
					},
				],
			},
		});
		activity.acceptObservation(itemState(ROOT, "pending", "running"));
		expect(activity.status(1_000)?.text).toBe("Working...");
	});
});

function acceptParentDelegate(timeline: SemanticTimeline): void {
	timeline.accept(
		event({
			type: "message_end",
			turnId: "turn-1",
			attemptId: "attempt-1",
			message: assistant("assistant-1", [
				{
					type: "toolCall",
					id: "provider-delegate",
					name: "delegate",
					arguments: {
						items: [
							{ itemId: "alpha", objective: "write alpha", executionMode: "write" },
							{ itemId: "beta", objective: "write beta", executionMode: "write" },
						],
					},
				},
			]),
		}),
	);
	timeline.accept(
		event({
			type: "tool_execution_start",
			turnId: "turn-1",
			sequence: 2,
			invocation: {
				id: "tool-delegate",
				resultMessageId: "result-delegate",
				providerToolCallId: "provider-delegate",
				toolName: "delegate",
				arguments: {
					items: [
						{ itemId: "alpha", objective: "write alpha", executionMode: "write" },
						{ itemId: "beta", objective: "write beta", executionMode: "write" },
					],
				},
				sourceIndex: 0,
			},
		}),
	);
}

function delegatedChildren(timeline: SemanticTimeline) {
	const delegate = timeline.entries.find(
		(entry) => entry.kind === "tool" && entry.invocation.toolName === "delegate",
	);
	if (!delegate || delegate.kind !== "tool") throw new Error("parent delegate Tool is missing");
	return delegate.delegated ?? [];
}

function itemState(itemId: WorkItemId, from: "pending" | "running", to: "ready" | "running" | "failed") {
	return {
		type: "item_state_changed",
		sequence: 1,
		graphId: GRAPH,
		itemId,
		from,
		to,
	} satisfies CodingAgentObservation;
}

function workEvent(itemId: WorkItemId, event: AgentEvent): CodingAgentObservation {
	return {
		type: "work_item_event",
		sequence: 2,
		graphId: GRAPH,
		itemId,
		runtimeId: `runtime:${itemId}`,
		sessionId: `session:${itemId}`,
		event,
	};
}

function settled(result: Pick<WorkResult, "itemId" | "state" | "publication" | "diagnostics"> & Partial<WorkResult>) {
	return {
		type: "work_item_settled",
		sequence: 3,
		graphId: GRAPH,
		result: workResult(result),
	} satisfies CodingAgentObservation;
}

function workResult(
	result: Pick<WorkResult, "itemId" | "state" | "publication" | "diagnostics"> & Partial<WorkResult>,
): WorkResult {
	return {
		durability: "confirmed",
		parentItemId: ROOT,
		dependencies: [],
		runtimeId: `runtime:${result.itemId}`,
		sessionId: `session:${result.itemId}`,
		placement: {
			placementId: `placement:${result.itemId}`,
			root: "/workspace",
			baseIdentity: "base",
			kind: "direct",
		},
		timing: { acceptedAt: 1, settledAt: 2 },
		budget: { modelAttempts: 1, toolInvocations: 1, totalTokens: 0, elapsedMs: 1 },
		...result,
	};
}

function itemSnapshot(
	itemId: WorkItemId,
	overrides: {
		readonly state: WorkResult["state"] | "running";
		readonly parentItemId?: WorkItemId;
		readonly objective?: string;
		readonly result?: WorkResult;
	},
) {
	return {
		itemId,
		...(overrides.parentItemId === undefined && itemId !== ROOT ? { parentItemId: ROOT } : {}),
		dependencies: [],
		objective: overrides.objective ?? (itemId === ALPHA ? "write alpha" : itemId === BETA ? "write beta" : "parent"),
		executionMode: "write" as const,
		state: overrides.state,
		desiredConfiguration: { model: { provider: "faux", id: "faux" }, reasoning: "off" as const },
		sessionId: `session:${itemId}`,
		placement: {
			placementId: `placement:${itemId}`,
			root: "/workspace",
			baseIdentity: "base",
			kind: "direct" as const,
		},
		cancellationRequested: false,
		...(overrides.result ? { result: overrides.result } : {}),
	};
}

function childInvocation(
	id: string,
	providerId: string,
	toolName: string,
	arguments_: Record<string, unknown>,
) {
	return {
		id,
		resultMessageId: `result-${id}`,
		providerToolCallId: providerId,
		toolName,
		arguments: arguments_,
		sourceIndex: 0,
	};
}

function event(payload: Record<string, unknown>): AgentEvent {
	return {
		runId: "run-1",
		sequence: 1,
		timestamp: 1,
		...payload,
	} as unknown as AgentEvent;
}

function assistant(id: string, content: AssistantMessage["content"]): AgentMessage<AssistantMessage> {
	return {
		id: id as MessageId,
		message: {
			role: "assistant",
			content,
			api: "faux",
			provider: "faux",
			model: "faux",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 1,
		},
	};
}
