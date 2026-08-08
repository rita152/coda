import { type Context, fauxAssistantMessage, fauxToolCall, Type } from "@coda/ai";
import { describe, expect, it } from "vitest";
import { Agent, AgentError, type AgentEvent, type AgentTool } from "../src/index.ts";
import { baseOptions, response, TestClock } from "./helpers.ts";

const inputSchema = Type.Object({ value: Type.String() });

describe("Agent input queues", () => {
	it("injects all queued Steering at the next safe model boundary without interrupting a Tool", async () => {
		const clock = new TestClock();
		const contexts: Context[] = [];
		let releaseTool!: () => void;
		const toolGate = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		let toolStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			toolStarted = resolve;
		});
		const pause: AgentTool<typeof inputSchema> = {
			name: "pause",
			description: "wait for the test",
			parameters: inputSchema,
			replaySafety: "safe",
			async execute() {
				toolStarted();
				await toolGate;
				return { content: "released" };
			},
		};
		const calls = fauxAssistantMessage([fauxToolCall("pause", { value: "x" }, { id: "provider:pause" })], {
			stopReason: "toolUse",
			timestamp: clock.now(),
		});
		const agent = new Agent({
			...baseOptions([calls, response("after steering", clock)], { clock, contexts }),
			tools: [pause],
		});
		const events: AgentEvent[] = [];
		agent.onEvent((event) => events.push(event));

		const prompt = agent.prompt("start");
		await started;
		const first = agent.steer("first correction");
		const second = agent.steer("second correction");
		expect(first).not.toBe(second);
		expect(agent.state.pendingSteering.map(({ id }) => id)).toEqual([first, second]);
		releaseTool();
		await prompt;

		expect(agent.state.pendingSteering).toEqual([]);
		expect(contexts).toHaveLength(2);
		expect(contexts[1]?.messages.map(({ role }) => role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"user",
			"user",
		]);
		expect(contexts[1]?.messages.filter(({ role }) => role === "user").map(({ content }) => content)).toEqual([
			"start",
			"first correction",
			"second correction",
		]);
		const turnStarts = events.filter((event) => event.type === "turn_start");
		expect(turnStarts).toHaveLength(2);
		expect(turnStarts[1]?.steeringMessages.map(({ message }) => message.content)).toEqual([
			"first correction",
			"second correction",
		]);
		expect(new Set(events.map(({ runId }) => runId))).toHaveLength(1);
	});

	it("starts queued Follow-up items as separate Runs in FIFO order and keeps prompt pending", async () => {
		const clock = new TestClock();
		let releaseFirst!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let firstCallStarted!: () => void;
		const firstStarted = new Promise<void>((resolve) => {
			firstCallStarted = resolve;
		});
		const agent = new Agent(
			baseOptions(
				[
					async () => {
						firstCallStarted();
						await gate;
						return response("initial done", clock);
					},
					response("follow one done", clock),
					response("follow two done", clock),
				],
				{ clock },
			),
		);
		const events: AgentEvent[] = [];
		agent.onEvent((event) => events.push(event));

		let settled = false;
		const prompt = agent.prompt("initial").then((result) => {
			settled = true;
			return result;
		});
		await firstStarted;
		const followOne = agent.followUp("follow one");
		const followTwo = agent.followUp("follow two");
		expect(agent.state.pendingFollowUps.map(({ id }) => id)).toEqual([followOne, followTwo]);
		releaseFirst();

		const result = await prompt;
		expect(settled).toBe(true);
		expect(result.outcome).toBe("success");
		const runStarts = events.filter((event) => event.type === "run_start");
		expect(runStarts.map(({ source }) => source)).toEqual(["prompt", "follow_up", "follow_up"]);
		expect(runStarts.map(({ queueItemId }) => queueItemId)).toEqual([undefined, followOne, followTwo]);
		expect(new Set(runStarts.map(({ runId }) => runId)).size).toBe(3);
		for (const runStart of runStarts) {
			const sequences = events.filter(({ runId }) => runId === runStart.runId).map(({ sequence }) => sequence);
			expect(sequences).toEqual(sequences.map((_, index) => index + 1));
		}
		expect(agent.state.messages.map(({ message }) => message.role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
			"user",
			"assistant",
		]);
		expect(agent.state.pendingFollowUps).toEqual([]);
	});

	it("clears pending Steering on abort while preserving and running Follow-up", async () => {
		const clock = new TestClock();
		let toolStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			toolStarted = resolve;
		});
		const waitForAbort: AgentTool<typeof inputSchema> = {
			name: "wait",
			description: "wait until aborted",
			parameters: inputSchema,
			replaySafety: "safe",
			async execute(_arguments, { signal }) {
				toolStarted();
				await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
				return { content: "settled" };
			},
		};
		const calls = fauxAssistantMessage([fauxToolCall("wait", { value: "x" }, { id: "provider:wait" })], {
			stopReason: "toolUse",
			timestamp: clock.now(),
		});
		const agent = new Agent({
			...baseOptions([calls, response("follow-up recovered", clock)], { clock }),
			tools: [waitForAbort],
		});

		const prompt = agent.prompt("initial");
		await started;
		agent.steer("discard this");
		const follow = agent.followUp("recover");
		agent.abort();
		const result = await prompt;

		expect(result.outcome).toBe("aborted");
		expect(agent.state.pendingSteering).toEqual([]);
		expect(agent.state.pendingFollowUps).toEqual([]);
		expect(
			agent.state.messages.some(({ message }) => message.role === "user" && message.content === "discard this"),
		).toBe(false);
		expect(agent.state.messages.some(({ message }) => message.role === "user" && message.content === "recover")).toBe(
			true,
		);
		expect(agent.state.lastRun).toMatchObject({ outcome: "success" });
		expect(follow).toBeTruthy();
	});

	it("cancels pending queue items by stable ID and distinguishes consumed items", async () => {
		const clock = new TestClock();
		let releaseFirst!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let started!: () => void;
		const firstStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const agent = new Agent(
			baseOptions(
				[
					async () => {
						started();
						await gate;
						return response("done", clock);
					},
					response("follow done", clock),
				],
				{ clock },
			),
		);

		const prompt = agent.prompt("initial");
		await firstStarted;
		const steer = agent.steer("cancel steer");
		const cancelledFollow = agent.followUp("cancel follow");
		agent.cancelQueueItem(steer);
		agent.cancelQueueItem(cancelledFollow);
		expect(agent.state.pendingSteering).toEqual([]);
		expect(agent.state.pendingFollowUps).toEqual([]);
		expect(() => agent.cancelQueueItem(steer)).toThrowError(AgentError);

		const consumedFollow = agent.followUp("consume follow");
		let consumedError: unknown;
		agent.onEvent((event) => {
			if (event.type === "run_start" && event.queueItemId === consumedFollow) {
				try {
					agent.cancelQueueItem(consumedFollow);
				} catch (error) {
					consumedError = error;
				}
			}
		});
		releaseFirst();
		await prompt;

		expect(consumedError).toMatchObject({ code: "queue_item_not_cancellable" });
	});

	it("rejects queue operations when no Run can consume them", () => {
		const agent = new Agent(baseOptions([]));
		expect(() => agent.steer("no run")).toThrowError(AgentError);
		expect(() => agent.followUp("no run")).toThrowError(AgentError);
		try {
			agent.steer("no run");
		} catch (error) {
			expect(error).toMatchObject({ code: "invalid_lifecycle" });
		}
	});
});
