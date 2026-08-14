import { describe, expect, it } from "vitest";
import { Agent, type AgentEvent } from "../src/index.ts";
import { initialRuntimeState, reduceState } from "../src/reducer.ts";
import { baseOptions, observeAgentEvents, response, TestClock } from "./helpers.ts";

describe("internal Agent state reduction", () => {
	it("reconstructs the settled public state from a valid immutable Run event sequence", async () => {
		const clock = new TestClock();
		const agent = new Agent(baseOptions([response("replay me", clock)], { clock }));
		const events: AgentEvent[] = [];
		observeAgentEvents(agent, (event) => events.push(event));

		await agent.prompt("record me");

		const initial = initialRuntimeState();
		let replayed = initial;
		for (const event of events) {
			replayed = reduceState(replayed, { type: "event", event });
			if (event.type === "run_end") replayed = reduceState(replayed, { type: "settled" });
		}
		expect(replayed.public).toEqual(agent.state);
		expect(initial.public).toEqual({
			status: "idle",
			messages: [],
			pendingSteering: [],
			pendingFollowUps: [],
		});
		expect(Object.isFrozen(replayed.public)).toBe(true);
	});

	it("reconstructs budget exhaustion from the public Run event sequence", async () => {
		let now = 0;
		const agent = new Agent({
			...baseOptions([]),
			clock: { now: () => now },
			prepareRun: () => {
				now = 2;
				return { stream: async () => Promise.reject(new Error("unreachable")), tools: [] };
			},
			runBudget: { limits: { maxElapsedMs: 1 } },
		});
		const events: AgentEvent[] = [];
		observeAgentEvents(agent, (event) => events.push(event));

		await expect(agent.prompt("replay a limit")).resolves.toMatchObject({
			outcome: "error",
			failure: { kind: "budget", exhaustion: { limit: "elapsed_ms", maximum: 1, observed: 2 } },
		});

		let replayed = initialRuntimeState();
		for (const event of events) {
			replayed = reduceState(replayed, { type: "event", event });
			if (event.type === "run_end") replayed = reduceState(replayed, { type: "settled" });
		}
		expect(events.map(({ type }) => type)).toEqual(["run_start", "run_budget_exhausted", "run_end"]);
		expect(replayed.public).toEqual(agent.state);
	});
});
