import { type Context, fauxAssistantMessage, fauxToolCall, Type } from "@coda/ai";
import { describe, expect, it } from "vitest";
import { Agent, type AgentEvent, type AgentTool } from "../src/index.ts";
import { baseOptions, observeAgentEvents, response, TestClock, withPreparedRun } from "./helpers.ts";

const pathSchema = Type.Object({ path: Type.String() }, { additionalProperties: false });

function tool(
	name: string,
	execute: AgentTool<typeof pathSchema>["execute"],
	options: { parallelSafe?: boolean } = {},
): AgentTool<typeof pathSchema> {
	return {
		name,
		description: `${name} test Tool`,
		parameters: pathSchema,
		replaySafety: "safe",
		parallelSafe: options.parallelSafe,
		execute,
	};
}

describe("Agent Tool execution", () => {
	it("preflights lookup and validation in model order without false start events", async () => {
		const clock = new TestClock();
		const contexts: Context[] = [];
		const executed: string[] = [];
		const reader = tool("read", ({ path }) => {
			executed.push(path);
			return { content: path };
		});
		const first = fauxAssistantMessage(
			[
				fauxToolCall("missing", { path: "a" }, { id: "provider:missing" }),
				fauxToolCall("read", {}, { id: "provider:invalid" }),
				fauxToolCall("read", { path: "/private" }, { id: "provider:valid" }),
			],
			{ stopReason: "toolUse", timestamp: clock.now() },
		);
		const agent = new Agent(
			withPreparedRun(baseOptions([first, response("finished", clock)], { clock, contexts }), { tools: [reader] }),
		);
		const events: AgentEvent[] = [];
		observeAgentEvents(agent, (event) => events.push(event));

		const result = await agent.prompt("inspect");

		expect(result.outcome).toBe("success");
		expect(executed).toEqual(["/private"]);
		expect(events.filter(({ type }) => type === "tool_execution_start")).toHaveLength(1);
		const rejected = events.filter((event) => event.type === "tool_execution_rejected");
		expect(rejected.map(({ reason }) => reason)).toEqual(["missing", "invalid"]);
		expect(rejected.map(({ invocation }) => invocation.providerToolCallId)).toEqual([
			"provider:missing",
			"provider:invalid",
		]);
		expect(rejected.every(({ invocation }) => invocation.id !== invocation.providerToolCallId)).toBe(true);
		expect(agent.state.messages.map(({ message }) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"toolResult",
			"toolResult",
			"assistant",
		]);
		const toolResults = agent.state.messages
			.map(({ message }) => message)
			.filter((message) => message.role === "toolResult");
		expect(toolResults.map(({ toolCallId }) => toolCallId)).toEqual([
			"provider:missing",
			"provider:invalid",
			"provider:valid",
		]);
		expect(toolResults.map(({ observation }) => observation?.status !== "ok")).toEqual([true, true, false]);
		expect(contexts).toHaveLength(2);
		expect(contexts[1]?.messages.map(({ role }) => role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"toolResult",
			"toolResult",
		]);
	});

	it("executes ordinary Tools sequentially", async () => {
		const clock = new TestClock();
		const order: string[] = [];
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let firstStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			firstStarted = resolve;
		});
		const firstTool = tool("first", async () => {
			order.push("first:start");
			firstStarted();
			await firstGate;
			order.push("first:end");
			return { content: "one" };
		});
		const secondTool = tool("second", () => {
			order.push("second:start");
			return { content: "two" };
		});
		const calls = fauxAssistantMessage(
			[
				fauxToolCall("first", { path: "1" }, { id: "call:1" }),
				fauxToolCall("second", { path: "2" }, { id: "call:2" }),
			],
			{ stopReason: "toolUse", timestamp: clock.now() },
		);
		const agent = new Agent(
			withPreparedRun(baseOptions([calls, response("done", clock)], { clock }), {
				tools: [firstTool, secondTool],
			}),
		);

		const prompt = agent.prompt("run");
		await started;
		expect(order).toEqual(["first:start"]);
		releaseFirst();
		await prompt;
		expect(order).toEqual(["first:start", "first:end", "second:start"]);
	});

	it("assigns Tool progress an ordered sequence before the terminal event", async () => {
		const clock = new TestClock();
		const events: AgentEvent[] = [];
		const reporting = tool("reporting", (_arguments, context) => {
			context.reportProgress?.({ progress: 1, total: 2, message: "reading" });
			context.reportProgress?.({ progress: 2, total: 2, message: "done" });
			return { content: "complete" };
		});
		const calls = fauxAssistantMessage([fauxToolCall("reporting", { path: "a" }, { id: "call:progress" })], {
			stopReason: "toolUse",
			timestamp: clock.now(),
		});
		const agent = new Agent(
			withPreparedRun(baseOptions([calls, response("done", clock)], { clock }), { tools: [reporting] }),
		);
		observeAgentEvents(agent, (event) => events.push(event));

		await agent.prompt("report progress");

		const lifecycle = events
			.filter((event) => event.type.startsWith("tool_execution_"))
			.sort((left, right) => left.sequence - right.sequence);
		expect(lifecycle.map(({ type }) => type)).toEqual([
			"tool_execution_start",
			"tool_execution_progress",
			"tool_execution_progress",
			"tool_execution_end",
		]);
		expect(
			lifecycle.filter((event) => event.type === "tool_execution_progress").map(({ progress }) => progress),
		).toEqual([
			{ progress: 1, total: 2, message: "reading" },
			{ progress: 2, total: 2, message: "done" },
		]);
	});

	it("returns model-visible Tool errors to the next Turn without failing the Run", async () => {
		const clock = new TestClock();
		const contexts: Context[] = [];
		const events: AgentEvent[] = [];
		const missing = tool("missing", ({ path }) => ({
			content: `Path does not exist: ${path}`,
			observation: { status: "error", truncated: false, facts: { code: "not_found" } },
			details: { status: "failed", code: "not_found", path },
		}));
		const calls = fauxAssistantMessage([fauxToolCall("missing", { path: "src" }, { id: "call:missing" })], {
			stopReason: "toolUse",
			timestamp: clock.now(),
		});
		const agent = new Agent(
			withPreparedRun(baseOptions([calls, response("recovered", clock)], { clock, contexts }), {
				tools: [missing],
			}),
		);
		observeAgentEvents(agent, (event) => events.push(event));

		const result = await agent.prompt("inspect");

		expect(result.outcome).toBe("success");
		expect(events.filter((event) => event.type === "tool_execution_end")).toMatchObject([
			{
				type: "tool_execution_end",
				settlement: "returned",
				outcome: "error",
				result: {
					message: {
						role: "toolResult",
						toolCallId: "call:missing",
						observation: { status: "error", truncated: false, facts: { code: "not_found" } },
					},
				},
			},
		]);
		expect(contexts).toHaveLength(2);
		expect(contexts[1]?.messages.at(-1)).toMatchObject({
			role: "toolResult",
			toolCallId: "call:missing",
		});
	});

	it("runs only explicitly safe consecutive Tools concurrently and commits results in source order", async () => {
		const clock = new TestClock();
		const events: AgentEvent[] = [];
		const releases = new Map<string, () => void>();
		let bothStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			bothStarted = resolve;
		});
		const startedNames: string[] = [];
		const parallel = (name: string) =>
			tool(
				name,
				async () => {
					startedNames.push(name);
					if (startedNames.length === 2) bothStarted();
					await new Promise<void>((resolve) => releases.set(name, resolve));
					return { content: `${name}:result` };
				},
				{ parallelSafe: true },
			);
		const calls = fauxAssistantMessage(
			[
				fauxToolCall("first", { path: "1" }, { id: "call:first" }),
				fauxToolCall("second", { path: "2" }, { id: "call:second" }),
			],
			{ stopReason: "toolUse", timestamp: clock.now() },
		);
		const agent = new Agent(
			withPreparedRun(baseOptions([calls, response("done", clock)], { clock }), {
				tools: [parallel("first"), parallel("second")],
			}),
		);
		let secondEnded!: () => void;
		const sawSecondEnd = new Promise<void>((resolve) => {
			secondEnded = resolve;
		});
		observeAgentEvents(agent, (event) => {
			events.push(event);
			if (event.type === "tool_execution_end" && event.invocation.toolName === "second") secondEnded();
		});

		const prompt = agent.prompt("parallel");
		await started;
		expect(startedNames).toEqual(["first", "second"]);
		releases.get("second")?.();
		await sawSecondEnd;
		releases.get("first")?.();
		await prompt;

		const ended = events.filter((event) => event.type === "tool_execution_end");
		expect(ended.map(({ invocation }) => invocation.toolName)).toEqual(["second", "first"]);
		const results = agent.state.messages
			.map(({ message }) => message)
			.filter((message) => message.role === "toolResult");
		expect(results.map(({ toolName }) => toolName)).toEqual(["first", "second"]);
	});

	it("does not start another Tool after abort and waits for the running Tool to settle", async () => {
		const clock = new TestClock();
		const events: AgentEvent[] = [];
		let runningSettled = false;
		let executionStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			executionStarted = resolve;
		});
		const running = tool("running", async (_arguments, { signal }) => {
			executionStarted();
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
			runningSettled = true;
			throw new DOMException("cancelled", "AbortError");
		});
		const never = tool("never", () => {
			throw new Error("must not execute");
		});
		const calls = fauxAssistantMessage(
			[
				fauxToolCall("running", { path: "1" }, { id: "call:running" }),
				fauxToolCall("never", { path: "2" }, { id: "call:never" }),
			],
			{ stopReason: "toolUse", timestamp: clock.now() },
		);
		const agent = new Agent(withPreparedRun(baseOptions([calls], { clock }), { tools: [running, never] }));
		observeAgentEvents(agent, (event) => events.push(event));

		const prompt = agent.prompt("abort tools");
		await started;
		agent.abort();
		const result = await prompt;

		expect(result.outcome).toBe("aborted");
		expect(runningSettled).toBe(true);
		expect(
			events.filter((event) => event.type === "tool_execution_start").map(({ invocation }) => invocation.toolName),
		).toEqual(["running"]);
		expect(events.filter((event) => event.type === "tool_execution_rejected").map(({ reason }) => reason)).toEqual([
			"aborted",
		]);
		expect(agent.state.messages.map(({ message }) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"toolResult",
		]);
	});

	it("surfaces unexpected Tool faults, completes result relationships, and starts no later Tool", async () => {
		const clock = new TestClock();
		let laterExecuted = false;
		const broken = tool("broken", () => {
			throw new Error("disk vanished");
		});
		const later = tool("later", () => {
			laterExecuted = true;
			return { content: "must not run" };
		});
		const calls = fauxAssistantMessage(
			[
				fauxToolCall("broken", { path: "1" }, { id: "call:broken" }),
				fauxToolCall("later", { path: "2" }, { id: "call:later" }),
			],
			{ stopReason: "toolUse", timestamp: clock.now() },
		);
		const events: AgentEvent[] = [];
		const agent = new Agent(withPreparedRun(baseOptions([calls], { clock }), { tools: [broken, later] }));
		observeAgentEvents(agent, (event) => events.push(event));

		await expect(agent.prompt("fault")).rejects.toThrow("disk vanished");

		expect(laterExecuted).toBe(false);
		expect(events.at(-1)?.type).toBe("run_end");
		expect(events.filter((event) => event.type === "tool_execution_rejected").map(({ reason }) => reason)).toEqual([
			"not_started",
		]);
		expect(events.filter((event) => event.type === "tool_execution_end")).toMatchObject([
			{ settlement: "threw", outcome: "error" },
		]);
		expect(agent.state.messages.map(({ message }) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"toolResult",
		]);
		expect(agent.state.status).toBe("idle");
	});

	it("rejects every Tool Call from a length-truncated assistant response", async () => {
		const clock = new TestClock();
		let executed = false;
		const reader = tool("read", () => {
			executed = true;
			return { content: "must not execute" };
		});
		const truncated = fauxAssistantMessage(
			[fauxToolCall("read", { path: "possibly-truncated" }, { id: "provider:truncated" })],
			{
				stopReason: "length",
				timestamp: clock.now(),
			},
		);
		const events: AgentEvent[] = [];
		const agent = new Agent(
			withPreparedRun(baseOptions([truncated, response("recovered", clock)], { clock }), { tools: [reader] }),
		);
		observeAgentEvents(agent, (event) => events.push(event));

		const result = await agent.prompt("run");

		expect(result.outcome).toBe("success");
		expect(executed).toBe(false);
		expect(events.filter((event) => event.type === "tool_execution_start")).toEqual([]);
		expect(events.filter((event) => event.type === "tool_execution_rejected").map(({ reason }) => reason)).toEqual([
			"invalid",
		]);
	});

	it("fails closed when a length-truncated response contains only Thinking", async () => {
		const clock = new TestClock();
		const truncated = fauxAssistantMessage(
			[{ type: "thinking", thinking: "I still need to edit the repository", thinkingSignature: "reasoning" }],
			{ stopReason: "length", timestamp: clock.now() },
		);
		const events: AgentEvent[] = [];
		const agent = new Agent(baseOptions([truncated], { clock }));
		observeAgentEvents(agent, (event) => events.push(event));

		const result = await agent.prompt("implement the change");

		expect(result).toMatchObject({
			outcome: "error",
			failure: { kind: "model", message: "Model response was truncated before it completed" },
		});
		expect(events.at(-1)).toMatchObject({ type: "run_end", outcome: "error" });
	});
});
