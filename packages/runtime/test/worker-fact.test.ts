import type { AgentEvent } from "@coda/agent";
import { describe, expect, it } from "vitest";
import { routeWorkerEvent } from "../src/work-graph/worker-event-router.ts";
import { assertWorkerFact, INITIAL_WORKER_FACT_PROJECTION, reduceWorkerFact } from "../src/work-graph/worker-fact.ts";

const invocation = {
	id: "tool:1",
	resultMessageId: "message:tool:1",
	providerToolCallId: "provider:tool:1",
	toolName: "read",
	arguments: { path: "/secret/payload" },
	sourceIndex: 0,
	replaySafety: "safe",
} as const;

const assistant = {
	id: "message:1",
	message: {
		role: "assistant",
		content: [],
		api: "test",
		provider: "test",
		model: "test",
		stopReason: "stop",
		usage: { input: 2, output: 3, cacheRead: 5, cacheWrite: 7, totalTokens: 17 },
		timestamp: 1,
	},
} as const;

function event(type: AgentEvent["type"]): AgentEvent {
	const common = { type, runId: "run:1", sequence: 1, timestamp: 10 };
	switch (type) {
		case "run_start":
			return {
				...common,
				source: "prompt",
				inputMessage: { id: "input:1", message: { role: "user", content: "hi", timestamp: 1 } },
			} as unknown as AgentEvent;
		case "turn_start":
			return { ...common, turnId: "turn:1", steeringMessages: [] } as unknown as AgentEvent;
		case "attempt_start":
			return {
				...common,
				turnId: "turn:1",
				attemptId: "attempt:1",
				messageId: "message:1",
				attempt: 1,
			} as unknown as AgentEvent;
		case "message_start":
			return {
				...common,
				turnId: "turn:1",
				attemptId: "attempt:1",
				messageId: "message:1",
			} as unknown as AgentEvent;
		case "message_update":
			return {
				...common,
				turnId: "turn:1",
				attemptId: "attempt:1",
				messageId: "message:1",
				delta: { type: "text_delta", contentIndex: 0, delta: "token" },
			} as unknown as AgentEvent;
		case "attempt_end":
			return {
				...common,
				turnId: "turn:1",
				attemptId: "attempt:1",
				messageId: "message:1",
				attempt: 1,
				outcome: "success",
				discarded: false,
				candidate: assistant,
			} as unknown as AgentEvent;
		case "retry_scheduled":
			return {
				...common,
				turnId: "turn:1",
				attemptId: "attempt:1",
				attempt: 1,
				delayMs: 1,
				reason: "transient",
			} as unknown as AgentEvent;
		case "message_end":
			return { ...common, turnId: "turn:1", attemptId: "attempt:1", message: assistant } as unknown as AgentEvent;
		case "tool_execution_rejected":
			return {
				...common,
				turnId: "turn:1",
				invocation,
				reason: "missing",
				message: "missing",
				result: assistant,
			} as unknown as AgentEvent;
		case "tool_execution_start":
			return { ...common, turnId: "turn:1", invocation } as unknown as AgentEvent;
		case "tool_execution_progress":
			return {
				...common,
				turnId: "turn:1",
				invocation,
				progress: { progress: 1, message: "large progress" },
			} as unknown as AgentEvent;
		case "tool_execution_end":
			return {
				...common,
				turnId: "turn:1",
				invocation,
				settlement: "returned",
				outcome: "success",
				result: assistant,
			} as unknown as AgentEvent;
		case "turn_end":
			return { ...common, turnId: "turn:1", outcome: "success" } as unknown as AgentEvent;
		case "run_budget_exhausted":
			return {
				...common,
				exhaustion: { limit: "total_tokens", maximum: 10, observed: 17 },
			} as unknown as AgentEvent;
		case "run_end":
			return { ...common, outcome: "success" } as unknown as AgentEvent;
	}
}

describe("Worker event routing", () => {
	it("classifies every Agent event into the exact closed seams", () => {
		const expected: Record<AgentEvent["type"], readonly [boolean, string | undefined, boolean]> = {
			run_start: [true, "run_started", true],
			turn_start: [true, undefined, true],
			attempt_start: [true, "attempt_started", false],
			message_start: [false, undefined, false],
			message_update: [false, undefined, false],
			attempt_end: [true, "attempt_settled", true],
			retry_scheduled: [true, undefined, true],
			message_end: [true, undefined, true],
			tool_execution_rejected: [true, undefined, true],
			tool_execution_start: [true, "tool_started", true],
			tool_execution_progress: [false, undefined, false],
			tool_execution_end: [true, "tool_settled", true],
			turn_end: [true, "turn_settled", true],
			run_budget_exhausted: [false, "budget_exhausted", false],
			run_end: [true, "run_settled", true],
		};
		for (const [type, contract] of Object.entries(expected) as [
			AgentEvent["type"],
			(typeof expected)[AgentEvent["type"]],
		][]) {
			const routed = routeWorkerEvent(event(type));
			expect([routed.session !== undefined, routed.fact?.type, routed.control !== undefined], type).toEqual(
				contract,
			);
			expect(routed.observation.type).toBe(type);
		}
	});

	it("keeps 10,000 deltas and 10,000 progress updates off all fatal and Control seams", () => {
		for (const type of ["message_update", "tool_execution_progress"] as const) {
			for (let index = 0; index < 10_000; index++) {
				const routed = routeWorkerEvent(event(type));
				expect(routed.session).toBeUndefined();
				expect(routed.fact).toBeUndefined();
				expect(routed.control).toBeUndefined();
			}
		}
	});

	it("bounds Facts independently of messages, Tool arguments, results, and progress", () => {
		const tool = routeWorkerEvent(event("tool_execution_start")).fact;
		expect(tool?.type).toBe("tool_started");
		const encoded = JSON.stringify(tool);
		expect(encoded).not.toMatch(/secret|arguments|result|progress|candidate|message_update/u);
		expect(() => assertWorkerFact({ ...tool, candidate: assistant })).toThrow("unexpected field candidate");
	});
});

describe("Worker Fact reducer", () => {
	it("shares live/recovery accounting and tracks parallel open effect windows", () => {
		let projection = reduceWorkerFact(INITIAL_WORKER_FACT_PROJECTION, {
			type: "run_started",
			runId: "run:1",
			timestamp: 1,
		});
		projection = reduceWorkerFact(projection, {
			type: "attempt_started",
			runId: "run:1",
			turnId: "turn:1",
			attemptId: "attempt:1",
			messageId: "message:1",
			attempt: 1,
			timestamp: 2,
		});
		projection = reduceWorkerFact(projection, {
			type: "attempt_settled",
			runId: "run:1",
			turnId: "turn:1",
			attemptId: "attempt:1",
			messageId: "message:1",
			attempt: 1,
			outcome: "success",
			discarded: false,
			totalTokens: 17,
			timestamp: 3,
		});
		for (const invocationId of ["tool:1", "tool:2"]) {
			projection = reduceWorkerFact(projection, {
				type: "tool_started",
				runId: "run:1",
				turnId: "turn:1",
				invocationId,
				toolName: "read",
				replaySafety: "safe",
				timestamp: 4,
			});
		}
		expect(projection).toMatchObject({ modelAttempts: 1, toolInvocations: 2, totalTokens: 17 });
		expect(projection.openTools.map(({ invocationId }) => invocationId)).toEqual(["tool:1", "tool:2"]);
		projection = reduceWorkerFact(projection, {
			type: "tool_settled",
			runId: "run:1",
			turnId: "turn:1",
			invocationId: "tool:2",
			settlement: "returned",
			outcome: "success",
			timestamp: 5,
		});
		expect(projection.openTools.map(({ invocationId }) => invocationId)).toEqual(["tool:1"]);
		expect(() =>
			reduceWorkerFact(projection, {
				type: "tool_settled",
				runId: "run:1",
				turnId: "turn:wrong",
				invocationId: "tool:1",
				settlement: "returned",
				outcome: "success",
				timestamp: 6,
			}),
		).toThrow("identity mismatch");
	});
});
