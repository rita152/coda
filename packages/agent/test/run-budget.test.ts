import { type AssistantMessage, fauxAssistantMessage, fauxToolCall, Type } from "@coda/ai";
import { describe, expect, it } from "vitest";
import {
	Agent,
	AgentError,
	type AgentEvent,
	type AgentTool,
	type Clock,
	type RunBudget,
	type RunLimits,
} from "../src/index.ts";
import { baseOptions, response, TestClock, withPreparedRun } from "./helpers.ts";

const valueSchema = Type.Object({ value: Type.String() }, { additionalProperties: false });

function budget(limits: RunLimits): RunBudget {
	return { limits };
}

function metered(message: AssistantMessage, totalTokens: number, totalCostUsd?: number): AssistantMessage {
	message.usage = {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		...(totalCostUsd === undefined
			? {}
			: {
					cost: {
						input: totalCostUsd,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						total: totalCostUsd,
					},
				}),
	};
	return message;
}

function transientFailure(clock: Clock, tokens = 0): AssistantMessage {
	const message = metered(
		fauxAssistantMessage("partial", {
			stopReason: "error",
			errorMessage: "temporary network failure",
			timestamp: clock.now(),
		}),
		tokens,
	);
	message.diagnostics = [
		{
			type: "stream_error",
			timestamp: clock.now(),
			error: { message: message.errorMessage!, code: "ECONNRESET" },
			details: { phase: "stream", provider: "faux", api: "faux", status: 503, retryable: true },
		},
	];
	return message;
}

function testTool(name: string, execute: AgentTool<typeof valueSchema>["execute"]): AgentTool<typeof valueSchema> {
	return {
		name,
		description: `${name} test Tool`,
		parameters: valueSchema,
		replaySafety: "safe",
		execute,
	};
}

class ManualClock implements Clock {
	value = 0;

	now(): number {
		return this.value;
	}
}

function selectTypes(events: readonly AgentEvent[], selected: ReadonlySet<AgentEvent["type"]>): AgentEvent["type"][] {
	return events.filter((event) => selected.has(event.type)).map(({ type }) => type);
}

describe("Agent RunBudget", () => {
	it("freezes a per-Run limits snapshot and validates configured limits", async () => {
		const clock = new TestClock();
		const mutableLimits = { maxTurns: 1 };
		const calls = fauxAssistantMessage([fauxToolCall("step", { value: "one" }, { id: "call:one" })], {
			stopReason: "toolUse",
			timestamp: clock.now(),
		});
		const agent = new Agent(
			withPreparedRun(
				{ ...baseOptions([calls], { clock }), runBudget: { limits: mutableLimits } },
				{ tools: [testTool("step", () => ({ content: "done" }))] },
			),
		);
		mutableLimits.maxTurns = 10;
		let snapshot: RunBudget | undefined;
		agent.onEvent((event) => {
			if (event.type === "run_start") snapshot = event.budget;
		});

		await expect(agent.prompt("bounded")).resolves.toMatchObject({
			outcome: "error",
			failure: { kind: "budget", exhaustion: { limit: "turns", maximum: 1, observed: 1 } },
		});
		expect(snapshot).toEqual({ limits: { maxTurns: 1 } });
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot?.limits)).toBe(true);

		for (const limits of [
			{ maxTurns: 0 },
			{ maxModelAttempts: 1.5 },
			{ maxToolInvocations: Number.POSITIVE_INFINITY },
			{ maxElapsedMs: -1 },
			{ maxTotalTokens: 0 },
			{ maxTotalCostUsd: Number.NaN },
			{ maxConsecutiveEquivalentToolBatches: 0 },
		] satisfies RunLimits[]) {
			expect(() => new Agent({ ...baseOptions([]), runBudget: budget(limits) })).toThrowError(AgentError);
		}
	});

	it("ends after the maximum number of complete Turns", async () => {
		const clock = new TestClock();
		const calls = fauxAssistantMessage([fauxToolCall("step", { value: "one" }, { id: "call:one" })], {
			stopReason: "toolUse",
			timestamp: clock.now(),
		});
		const events: AgentEvent[] = [];
		const agent = new Agent(
			withPreparedRun(
				{ ...baseOptions([calls], { clock }), runBudget: budget({ maxTurns: 1 }) },
				{ tools: [testTool("step", () => ({ content: "done" }))] },
			),
		);
		let exhaustionVisibleFromState = false;
		agent.onEvent((event) => {
			events.push(event);
			if (event.type === "tool_execution_start") agent.steer("must not leak");
			if (event.type === "run_budget_exhausted") {
				exhaustionVisibleFromState = agent.state.activeRun?.budgetExhaustion === event.exhaustion;
			}
		});

		const result = await agent.prompt("one turn");

		expect(result).toMatchObject({
			outcome: "error",
			failure: { kind: "budget", exhaustion: { limit: "turns", maximum: 1, observed: 1 } },
		});
		expect(events.slice(-3).map(({ type }) => type)).toEqual(["turn_end", "run_budget_exhausted", "run_end"]);
		expect(exhaustionVisibleFromState).toBe(true);
		expect(agent.state.pendingSteering).toEqual([]);
		expect(agent.state.lastRun?.failure).toEqual(result.failure);
	});

	it("counts retry Attempts and emits no retry schedule when the Attempt limit prevents it", async () => {
		const clock = new TestClock();
		const events: AgentEvent[] = [];
		let decisions = 0;
		const agent = new Agent({
			...baseOptions([transientFailure(clock), response("unused", clock)], { clock }),
			runBudget: budget({ maxModelAttempts: 1 }),
			retry: {
				policy: {
					decide: () => {
						decisions++;
						return { retry: true, delayMs: 0, reason: "retry" };
					},
				},
				delay: { wait: async () => undefined },
			},
		});
		agent.onEvent((event) => events.push(event));

		const result = await agent.prompt("retry once");

		expect(decisions).toBe(1);
		expect(result).toMatchObject({
			outcome: "error",
			failure: { kind: "budget", exhaustion: { limit: "model_attempts", maximum: 1, observed: 1 } },
		});
		expect(events.filter(({ type }) => type === "attempt_start")).toHaveLength(1);
		expect(events.filter(({ type }) => type === "retry_scheduled")).toEqual([]);
		expect(selectTypes(events, new Set(["attempt_end", "run_budget_exhausted", "turn_end", "run_end"]))).toEqual([
			"attempt_end",
			"run_budget_exhausted",
			"turn_end",
			"run_end",
		]);
	});

	it("rejects an entire Tool batch before side effects when it exceeds the Invocation limit", async () => {
		const clock = new TestClock();
		const events: AgentEvent[] = [];
		const executed: string[] = [];
		const calls = fauxAssistantMessage(
			[
				fauxToolCall("step", { value: "one" }, { id: "call:one" }),
				fauxToolCall("step", { value: "two" }, { id: "call:two" }),
			],
			{ stopReason: "toolUse", timestamp: clock.now() },
		);
		const agent = new Agent(
			withPreparedRun(
				{ ...baseOptions([calls], { clock }), runBudget: budget({ maxToolInvocations: 1 }) },
				{
					tools: [
						testTool("step", ({ value }) => {
							executed.push(value);
							return { content: value };
						}),
					],
				},
			),
		);
		agent.onEvent((event) => events.push(event));

		const result = await agent.prompt("too many Tools");

		expect(result).toMatchObject({
			outcome: "error",
			failure: { kind: "budget", exhaustion: { limit: "tool_invocations", maximum: 1, observed: 2 } },
		});
		expect(executed).toEqual([]);
		expect(events.filter(({ type }) => type === "tool_execution_start")).toEqual([]);
		expect(events.filter((event) => event.type === "tool_execution_rejected").map(({ reason }) => reason)).toEqual([
			"budget",
			"budget",
		]);
		expect(
			selectTypes(
				events,
				new Set(["message_end", "tool_execution_rejected", "run_budget_exhausted", "turn_end", "run_end"]),
			),
		).toEqual([
			"message_end",
			"tool_execution_rejected",
			"tool_execution_rejected",
			"run_budget_exhausted",
			"turn_end",
			"run_end",
		]);
	});

	it("observes elapsed time only after an active Tool settles", async () => {
		const clock = new ManualClock();
		const events: AgentEvent[] = [];
		let started!: () => void;
		const toolStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let toolSignal: AbortSignal | undefined;
		const calls = fauxAssistantMessage([fauxToolCall("wait", { value: "one" }, { id: "call:wait" })], {
			stopReason: "toolUse",
			timestamp: clock.now(),
		});
		const agent = new Agent(
			withPreparedRun(
				{ ...baseOptions([calls]), clock, runBudget: budget({ maxElapsedMs: 50 }) },
				{
					tools: [
						testTool("wait", async (_arguments, { signal }) => {
							toolSignal = signal;
							started();
							await gate;
							return { content: "settled" };
						}),
					],
				},
			),
		);
		agent.onEvent((event) => events.push(event));

		const prompt = agent.prompt("wait safely");
		await toolStarted;
		clock.value = 100;
		expect(toolSignal?.aborted).toBe(false);
		release();
		const result = await prompt;

		expect(toolSignal?.aborted).toBe(false);
		expect(result).toMatchObject({
			outcome: "error",
			failure: { kind: "budget", exhaustion: { limit: "elapsed_ms", maximum: 50, observed: 100 } },
		});
		expect(
			selectTypes(events, new Set(["tool_execution_end", "run_budget_exhausted", "turn_end", "run_end"])).slice(-4),
		).toEqual(["tool_execution_end", "run_budget_exhausted", "turn_end", "run_end"]);
	});

	it("counts total tokens across discarded retry Attempts", async () => {
		const clock = new TestClock();
		const events: AgentEvent[] = [];
		const final = metered(response("complete", clock), 6);
		const agent = new Agent({
			...baseOptions([transientFailure(clock, 6), final], { clock }),
			runBudget: budget({ maxTotalTokens: 10 }),
			retry: {
				policy: { decide: () => ({ retry: true, delayMs: 0, reason: "retry" }) },
				delay: { wait: async () => undefined },
			},
		});
		agent.onEvent((event) => events.push(event));

		const result = await agent.prompt("meter retries");

		expect(result).toMatchObject({
			outcome: "error",
			failure: { kind: "budget", exhaustion: { limit: "total_tokens", maximum: 10, observed: 12 } },
		});
		expect(events.filter(({ type }) => type === "attempt_start")).toHaveLength(2);
		expect(events.filter(({ type }) => type === "retry_scheduled")).toHaveLength(1);
		expect(events.slice(-4).map(({ type }) => type)).toEqual([
			"message_end",
			"run_budget_exhausted",
			"turn_end",
			"run_end",
		]);
	});

	it("enforces an explicitly configured total USD cost cap", async () => {
		const clock = new TestClock();
		const agent = new Agent({
			...baseOptions([metered(response("costly", clock), 1, 1.25)], { clock }),
			runBudget: budget({ maxTotalCostUsd: 1 }),
		});

		await expect(agent.prompt("cap cost")).resolves.toMatchObject({
			outcome: "error",
			failure: {
				kind: "budget",
				exhaustion: { limit: "total_cost_usd", maximum: 1, observed: 1.25 },
			},
		});
	});

	it("detects equivalent consecutive Tool batches despite nested argument key order", async () => {
		const clock = new TestClock();
		const schema = Type.Object(
			{
				alpha: Type.Number(),
				nested: Type.Object({ left: Type.Number(), right: Type.Number() }, { additionalProperties: false }),
			},
			{ additionalProperties: false },
		);
		let executions = 0;
		const inspect: AgentTool<typeof schema> = {
			name: "inspect",
			description: "inspect values",
			parameters: schema,
			replaySafety: "safe",
			execute: () => {
				executions++;
				return { content: "inspected" };
			},
		};
		const first = fauxAssistantMessage(
			[fauxToolCall("inspect", { alpha: 1, nested: { left: 2, right: 3 } }, { id: "call:first" })],
			{ stopReason: "toolUse", timestamp: clock.now() },
		);
		const reordered = fauxAssistantMessage(
			[fauxToolCall("inspect", { nested: { right: 3, left: 2 }, alpha: 1 }, { id: "call:second" })],
			{ stopReason: "toolUse", timestamp: clock.now() },
		);
		const agent = new Agent(
			withPreparedRun(
				{
					...baseOptions([first, reordered], { clock }),
					runBudget: budget({ maxConsecutiveEquivalentToolBatches: 1 }),
				},
				{ tools: [inspect] },
			),
		);

		const result = await agent.prompt("detect a loop");

		expect(executions).toBe(1);
		expect(result).toMatchObject({
			outcome: "error",
			failure: {
				kind: "budget",
				exhaustion: {
					limit: "consecutive_equivalent_tool_batches",
					maximum: 1,
					observed: 2,
				},
			},
		});
	});

	it("resets equivalent-batch detection when a different batch intervenes", async () => {
		const clock = new TestClock();
		const executions: string[] = [];
		const step = testTool("step", ({ value }) => {
			executions.push(value);
			return { content: value };
		});
		const call = (value: string, id: string) =>
			fauxAssistantMessage([fauxToolCall("step", { value }, { id })], {
				stopReason: "toolUse",
				timestamp: clock.now(),
			});
		const agent = new Agent(
			withPreparedRun(
				{
					...baseOptions(
						[call("a", "call:a1"), call("b", "call:b"), call("a", "call:a2"), response("done", clock)],
						{ clock },
					),
					runBudget: budget({ maxConsecutiveEquivalentToolBatches: 1 }),
				},
				{ tools: [step] },
			),
		);

		await expect(agent.prompt("no loop")).resolves.toMatchObject({ outcome: "success" });
		expect(executions).toEqual(["a", "b", "a"]);
	});

	it("starts each Follow-up Run with fresh accounting and pauses later Follow-ups after exhaustion", async () => {
		const clock = new TestClock();
		const initial = metered(response("initial", clock), 6);
		const exhaustedFollowUp = metered(response("first follow-up", clock), 11);
		const unusedFollowUp = metered(response("second follow-up", clock), 1);
		const agent = new Agent({
			...baseOptions([initial, exhaustedFollowUp, unusedFollowUp], { clock }),
			runBudget: budget({ maxTotalTokens: 10 }),
		});
		let firstFollowUp: string | undefined;
		let secondFollowUp: string | undefined;
		agent.onEvent((event) => {
			if (event.type !== "run_start" || event.source !== "prompt") return;
			firstFollowUp = agent.followUp("first");
			secondFollowUp = agent.followUp("second");
		});

		await expect(agent.prompt("initial")).resolves.toMatchObject({ outcome: "success" });

		expect(firstFollowUp).toBeTruthy();
		expect(agent.state.lastRun).toMatchObject({
			outcome: "error",
			failure: { kind: "budget", exhaustion: { limit: "total_tokens", maximum: 10, observed: 11 } },
		});
		expect(agent.state.pendingFollowUps.map(({ id }) => id)).toEqual([secondFollowUp]);
		expect(
			agent.state.messages.filter(({ message }) => message.role === "user").map(({ message }) => message.content),
		).toEqual(["initial", "first"]);
	});

	it("keeps caller cancellation authoritative over a limit crossed by an active Tool", async () => {
		const clock = new ManualClock();
		const events: AgentEvent[] = [];
		let started!: () => void;
		const toolStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const wait = testTool("wait", async (_arguments, { signal }) => {
			started();
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
			return { content: "settled" };
		});
		const calls = fauxAssistantMessage([fauxToolCall("wait", { value: "one" }, { id: "call:wait" })], {
			stopReason: "toolUse",
			timestamp: clock.now(),
		});
		const agent = new Agent(
			withPreparedRun(
				{ ...baseOptions([calls]), clock, runBudget: budget({ maxElapsedMs: 50 }) },
				{ tools: [wait] },
			),
		);
		agent.onEvent((event) => events.push(event));

		const prompt = agent.prompt("cancel");
		await toolStarted;
		clock.value = 100;
		agent.abort();

		await expect(prompt).resolves.toMatchObject({ outcome: "aborted", failure: undefined });
		expect(events.filter(({ type }) => type === "run_budget_exhausted")).toEqual([]);
		expect(events.at(-1)).toMatchObject({ type: "run_end", outcome: "aborted", failure: undefined });
	});
});
