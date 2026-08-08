import { describe, expect, it } from "vitest";
import { Agent, type AgentEvent } from "../src/index.ts";
import { initialRuntimeState, reduceState } from "../src/reducer.ts";
import { baseOptions, response, TestClock } from "./helpers.ts";

describe("internal Agent state reduction", () => {
	it("reconstructs the settled public state from a valid immutable Run event sequence", async () => {
		const clock = new TestClock();
		const agent = new Agent(baseOptions([response("replay me", clock)], { clock }));
		const events: AgentEvent[] = [];
		agent.onEvent((event) => events.push(event));

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
});
