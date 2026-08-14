import { describe, expect, it } from "vitest";
import { Agent, type AgentEvent } from "../src/index.ts";
import { baseOptions, observeAgentEvents, response, TestClock } from "./helpers.ts";

describe("Agent run lifecycle", () => {
	it("commits a user message and a successful streamed assistant message", async () => {
		const clock = new TestClock();
		const options = baseOptions([response("hello", clock)], { clock });
		const agent = new Agent(options);
		const events: AgentEvent[] = [];
		observeAgentEvents(agent, (event) => events.push(event));

		const result = await agent.prompt("hi");

		expect(result.outcome).toBe("success");
		expect(result.runId).toBe("run:1");
		expect(agent.state.status).toBe("idle");
		expect(agent.state.messages.map(({ message }) => message.role)).toEqual(["user", "assistant"]);
		expect(agent.state.messages[0]?.id).toBe("message:2");
		expect(agent.state.messages[1]?.id).toBe("message:5");
		expect(agent.state.messages[1]?.message.content).toEqual([{ type: "text", text: "hello" }]);
		expect(events.map(({ type }) => type)).toEqual([
			"run_start",
			"turn_start",
			"attempt_start",
			"message_start",
			"message_update",
			"message_update",
			"message_update",
			"message_update",
			"message_update",
			"attempt_end",
			"message_end",
			"turn_end",
			"run_end",
		]);
		expect(events.map(({ sequence }) => sequence)).toEqual(events.map((_, index) => index + 1));
		expect(new Set(events.map(({ runId }) => runId))).toEqual(new Set([result.runId]));
	});

	it("applies state before listeners and awaits listeners in registration order", async () => {
		const clock = new TestClock();
		const agent = new Agent(baseOptions([response("ok", clock)], { clock }));
		const observations: string[] = [];
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});

		agent.onSemanticEvent(async (event) => {
			if (event.type !== "run_start") return;
			observations.push(`${agent.state.status}:${agent.state.messages.length}:first`);
			await gate;
			observations.push("first:done");
		});
		agent.onSemanticEvent((event) => {
			if (event.type === "run_start") observations.push("second");
		});

		const prompt = agent.prompt("go");
		await Promise.resolve();
		expect(observations).toEqual(["running:1:first"]);
		release();
		await prompt;
		expect(observations).toEqual(["running:1:first", "first:done", "second"]);
	});

	it("publishes frozen event payloads and immutable state snapshots", async () => {
		const clock = new TestClock();
		const agent = new Agent(baseOptions([response("immutable", clock)], { clock }));
		const seen: AgentEvent[] = [];
		observeAgentEvents(agent, (event) => seen.push(event));

		await agent.prompt("protect me");

		const messageEnd = seen.find((event) => event.type === "message_end");
		expect(Object.isFrozen(messageEnd)).toBe(true);
		if (messageEnd?.type === "message_end") {
			expect(Object.isFrozen(messageEnd.message)).toBe(true);
			expect(Object.isFrozen(messageEnd.message.message.content)).toBe(true);
		}
		expect(Object.isFrozen(agent.state)).toBe(true);
		expect(Object.isFrozen(agent.state.messages)).toBe(true);
	});

	it("bounds a stalled Observation consumer without delaying Agent progression", async () => {
		const clock = new TestClock();
		const agent = new Agent(baseOptions([response("observation".repeat(64), clock)], { clock }));
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let started!: () => void;
		const observationStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		let resynchronized!: () => void;
		const resynchronization = new Promise<void>((resolve) => {
			resynchronized = resolve;
		});
		let first = true;
		agent.subscribeObservations(
			{
				accept: async () => {
					if (!first) return;
					first = false;
					started();
					await gate;
				},
				resynchronize: ({ reason, state }) => {
					expect(reason).toBe("slow_consumer");
					expect(state.status).toBe("idle");
					resynchronized();
				},
			},
			{ capacity: 2 },
		);

		const operation = agent.prompt("keep progressing");
		await observationStarted;
		await expect(operation).resolves.toMatchObject({ outcome: "success" });
		release();
		await resynchronization;
	});
});
