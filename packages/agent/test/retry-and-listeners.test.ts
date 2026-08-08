import { type AssistantMessage, type Context, fauxAssistantMessage, fauxToolCall, Type } from "@coda/ai";
import { describe, expect, it } from "vitest";
import {
	Agent,
	AgentError,
	type AgentEvent,
	type AgentTool,
	type RetryDelay,
	type TurnRetryPolicy,
} from "../src/index.ts";
import { baseOptions, response, TestClock } from "./helpers.ts";

function transientFailure(clock: TestClock, retryable = true): AssistantMessage {
	const message = fauxAssistantMessage("discarded partial", {
		stopReason: "error",
		errorMessage: retryable ? "temporary network failure" : "authentication failed",
		timestamp: clock.now(),
	});
	message.diagnostics = [
		{
			type: "stream_error",
			timestamp: clock.now(),
			error: { message: message.errorMessage!, code: retryable ? "ECONNRESET" : "auth" },
			details: { phase: "stream", provider: "faux", api: "faux", status: retryable ? 503 : 401, retryable },
		},
	];
	return message;
}

describe("Agent whole-turn retry", () => {
	it("is disabled by default", async () => {
		const clock = new TestClock();
		const contexts: Context[] = [];
		const agent = new Agent(
			baseOptions([transientFailure(clock), response("would succeed", clock)], { clock, contexts }),
		);

		const result = await agent.prompt("try once");

		expect(result.outcome).toBe("error");
		expect(contexts).toHaveLength(1);
	});

	it("retries a transient failed Attempt without committing its partial Message", async () => {
		const clock = new TestClock();
		const contexts: Context[] = [];
		const decisions: { attempt: number; transient: boolean }[] = [];
		const waits: number[] = [];
		const policy: TurnRetryPolicy = {
			decide(context) {
				decisions.push({ attempt: context.attempt, transient: context.transient });
				return { retry: true, delayMs: 7, reason: "temporary provider failure" };
			},
		};
		const delay: RetryDelay = {
			async wait(delayMs, signal) {
				expect(signal.aborted).toBe(false);
				waits.push(delayMs);
			},
		};
		const agent = new Agent({
			...baseOptions([transientFailure(clock), response("recovered", clock)], { clock, contexts }),
			retry: { policy, delay },
		});
		const events: AgentEvent[] = [];
		agent.onEvent((event) => events.push(event));

		const result = await agent.prompt("retry");

		expect(result.outcome).toBe("success");
		expect(decisions).toEqual([{ attempt: 1, transient: true }]);
		expect(waits).toEqual([7]);
		expect(contexts).toHaveLength(2);
		expect(contexts[0]?.messages).toEqual(contexts[1]?.messages);
		expect(agent.state.messages.map(({ message }) => message.role)).toEqual(["user", "assistant"]);
		expect(agent.state.messages[1]?.message.content).toEqual([{ type: "text", text: "recovered" }]);
		const attempts = events.filter((event) => event.type === "attempt_start");
		expect(attempts).toHaveLength(2);
		expect(new Set(attempts.map(({ turnId }) => turnId))).toHaveLength(1);
		expect(new Set(attempts.map(({ attemptId }) => attemptId)).size).toBe(2);
		expect(new Set(attempts.map(({ messageId }) => messageId)).size).toBe(2);
		const attemptEnds = events.filter((event) => event.type === "attempt_end");
		expect(attemptEnds.map(({ outcome, discarded }) => ({ outcome, discarded }))).toEqual([
			{ outcome: "error", discarded: true },
			{ outcome: "success", discarded: false },
		]);
		expect(events.filter((event) => event.type === "retry_scheduled")).toMatchObject([
			{ delayMs: 7, reason: "temporary provider failure", attempt: 1 },
		]);
		expect(events.filter((event) => event.type === "message_end")).toHaveLength(1);
	});

	it("never consults the retry policy for an explicitly non-transient failure", async () => {
		const clock = new TestClock();
		let decisions = 0;
		let waits = 0;
		const agent = new Agent({
			...baseOptions([transientFailure(clock, false), response("must remain unused", clock)], { clock }),
			retry: {
				policy: {
					decide() {
						decisions++;
						return { retry: true, delayMs: 1, reason: "incorrect" };
					},
				},
				delay: {
					async wait() {
						waits++;
					},
				},
			},
		});

		const result = await agent.prompt("do not retry auth");

		expect(result.outcome).toBe("error");
		expect([decisions, waits]).toEqual([0, 0]);
	});

	it("ignores an unrecognized failure even when a provider marks it retryable", async () => {
		const clock = new TestClock();
		const failure = fauxAssistantMessage("discarded partial", {
			stopReason: "error",
			errorMessage: "unexpected provider failure",
			timestamp: clock.now(),
		});
		failure.diagnostics = [
			{
				type: "stream_error",
				timestamp: clock.now(),
				error: { message: failure.errorMessage!, code: "mystery" },
				details: { phase: "stream", provider: "faux", api: "faux", status: 418, retryable: true },
			},
		];
		let decisions = 0;
		const agent = new Agent({
			...baseOptions([failure, response("must remain unused", clock)], { clock }),
			retry: {
				policy: {
					decide() {
						decisions++;
						return { retry: true, delayMs: 1, reason: "incorrect" };
					},
				},
				delay: { wait: async () => undefined },
			},
		});

		await expect(agent.prompt("do not retry unknown failures")).resolves.toMatchObject({ outcome: "error" });
		expect(decisions).toBe(0);
	});

	it("classifies cancellation during retry delay as an aborted Run", async () => {
		const clock = new TestClock();
		let enteredDelay!: () => void;
		const delayEntered = new Promise<void>((resolve) => {
			enteredDelay = resolve;
		});
		const agent = new Agent({
			...baseOptions([transientFailure(clock)], { clock }),
			retry: {
				policy: { decide: () => ({ retry: true, delayMs: 50, reason: "backoff" }) },
				delay: {
					wait(_delayMs, signal) {
						enteredDelay();
						return new Promise<void>((_resolve, reject) => {
							signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), {
								once: true,
							});
						});
					},
				},
			},
		});

		const prompt = agent.prompt("cancel backoff");
		await delayEntered;
		agent.abort();
		const result = await prompt;

		expect(result.outcome).toBe("aborted");
		expect(result.failure).toBeUndefined();
		expect(agent.state.status).toBe("idle");
	});
});

describe("Agent listener failure containment", () => {
	it("notifies remaining listeners, starts no later model effect, emits run_end, and rejects with listener_failed", async () => {
		const clock = new TestClock();
		const contexts: Context[] = [];
		const agent = new Agent(baseOptions([], { clock, contexts }));
		const observed: AgentEvent["type"][] = [];
		agent.onEvent((event) => {
			if (event.type === "run_start") throw new Error("listener broke");
		});
		agent.onEvent((event) => observed.push(event.type));

		const prompt = agent.prompt("fail listener");
		const idle = agent.waitForIdle();
		await expect(prompt).rejects.toMatchObject({ code: "listener_failed" });
		await expect(idle).rejects.toMatchObject({ code: "listener_failed" });

		expect(contexts).toEqual([]);
		expect(observed).toEqual(["run_start", "run_end"]);
		expect(agent.state.status).toBe("idle");
		expect(agent.state.lastRun).toMatchObject({ outcome: "error", failure: { kind: "listener" } });
	});

	it("does not invoke Tool execute after a tool_execution_start listener fails", async () => {
		const clock = new TestClock();
		let executed = false;
		const schema = Type.Object({ value: Type.String() });
		const dangerous: AgentTool<typeof schema> = {
			name: "dangerous",
			description: "must not run",
			parameters: schema,
			replaySafety: "never",
			execute() {
				executed = true;
				return { content: "ran" };
			},
		};
		const calls = fauxAssistantMessage([fauxToolCall("dangerous", { value: "x" }, { id: "provider:dangerous" })], {
			stopReason: "toolUse",
			timestamp: clock.now(),
		});
		const agent = new Agent({ ...baseOptions([calls], { clock }), tools: [dangerous] });
		agent.onEvent((event) => {
			if (event.type === "tool_execution_start") throw new Error("sink unavailable");
		});

		await expect(agent.prompt("run")).rejects.toMatchObject({ code: "listener_failed" });
		expect(executed).toBe(false);
		expect(agent.state.messages.map(({ message }) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(agent.state.status).toBe("idle");
	});

	it("completes every Tool result relationship when a preflight rejection listener fails", async () => {
		const clock = new TestClock();
		const calls = fauxAssistantMessage(
			[fauxToolCall("missing-one", {}, { id: "missing:1" }), fauxToolCall("missing-two", {}, { id: "missing:2" })],
			{ stopReason: "toolUse", timestamp: clock.now() },
		);
		const agent = new Agent(baseOptions([calls], { clock }));
		agent.onEvent((event) => {
			if (event.type === "tool_execution_rejected" && event.invocation.providerToolCallId === "missing:1") {
				throw new Error("rejection listener failed");
			}
		});

		await expect(agent.prompt("preflight")).rejects.toMatchObject({ code: "listener_failed" });

		const toolResults = agent.state.messages
			.map(({ message }) => message)
			.filter((message) => message.role === "toolResult");
		expect(toolResults.map(({ toolCallId }) => toolCallId)).toEqual(["missing:1", "missing:2"]);
		expect(agent.state.status).toBe("idle");
	});

	it("aborts and awaits an already-running parallel Tool when a later start listener fails", async () => {
		const clock = new TestClock();
		const schema = Type.Object({ value: Type.String() });
		let firstStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			firstStarted = resolve;
		});
		let firstSawAbort!: () => void;
		const sawAbort = new Promise<void>((resolve) => {
			firstSawAbort = resolve;
		});
		let releaseFirst!: () => void;
		const settleGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let firstSettled = false;
		let secondExecuted = false;
		const first: AgentTool<typeof schema> = {
			name: "first",
			description: "first parallel Tool",
			parameters: schema,
			replaySafety: "safe",
			parallelSafe: true,
			async execute(_arguments, { signal }) {
				firstStarted();
				await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
				firstSawAbort();
				await settleGate;
				firstSettled = true;
				return { content: "settled" };
			},
		};
		const second: AgentTool<typeof schema> = {
			...first,
			name: "second",
			execute() {
				secondExecuted = true;
				return { content: "must not execute" };
			},
		};
		const calls = fauxAssistantMessage(
			[
				fauxToolCall("first", { value: "1" }, { id: "provider:first" }),
				fauxToolCall("second", { value: "2" }, { id: "provider:second" }),
			],
			{ stopReason: "toolUse", timestamp: clock.now() },
		);
		const agent = new Agent({ ...baseOptions([calls], { clock }), tools: [first, second] });
		agent.onEvent((event) => {
			if (event.type === "tool_execution_start" && event.invocation.toolName === "second") {
				throw new Error("second start listener failed");
			}
		});

		let promptSettled = false;
		const prompt = agent.prompt("parallel").finally(() => {
			promptSettled = true;
		});
		void prompt.catch(() => undefined);
		await started;
		await sawAbort;
		expect(promptSettled).toBe(false);
		expect(secondExecuted).toBe(false);
		releaseFirst();
		await expect(prompt).rejects.toMatchObject({ code: "listener_failed" });
		expect(firstSettled).toBe(true);
		expect(agent.state.messages.map(({ message }) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"toolResult",
		]);
	});

	it("restores idle state even when the run_end listener itself fails", async () => {
		const clock = new TestClock();
		const agent = new Agent(baseOptions([response("done", clock)], { clock }));
		agent.onEvent((event) => {
			if (event.type === "run_end") throw new Error("final listener failed");
		});

		await expect(agent.prompt("run")).rejects.toBeInstanceOf(AgentError);
		expect(agent.state.status).toBe("idle");
		expect(agent.state.lastRun?.outcome).toBe("success");
	});
});
