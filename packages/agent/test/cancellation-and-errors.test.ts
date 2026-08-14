import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
} from "@coda/ai";
import { describe, expect, it } from "vitest";
import { Agent, AgentError, type AgentEvent, type ModelStream } from "../src/index.ts";
import { baseOptions, observeAgentEvents, response, TestClock, withPreparedRun } from "./helpers.ts";

describe("Agent cancellation and failure outcomes", () => {
	it("classifies caller cancellation as aborted and discards partial assistant output", async () => {
		const clock = new TestClock();
		const agent = new Agent(baseOptions([response("a response long enough to interrupt", clock)], { clock }));
		const events: AgentEvent[] = [];
		observeAgentEvents(agent, (event) => {
			events.push(event);
			if (event.type === "message_update" && event.delta.type === "text_delta") agent.abort();
		});

		const result = await agent.prompt("stop soon");

		expect(result.outcome).toBe("aborted");
		expect(result.failure).toBeUndefined();
		expect(agent.state.messages).toHaveLength(1);
		const attemptEnd = events.find((event) => event.type === "attempt_end");
		expect(attemptEnd).toMatchObject({ type: "attempt_end", outcome: "aborted", discarded: true });
		if (attemptEnd?.type === "attempt_end") {
			expect(attemptEnd.candidate.message.stopReason).toBe("aborted");
			expect(attemptEnd.candidate.message.diagnostics).toBeUndefined();
		}
		expect(events.at(-1)?.type).toBe("run_end");
		expect(agent.state.status).toBe("idle");
	});

	it("keeps model terminal errors as Run outcomes and out of the transcript", async () => {
		const clock = new TestClock();
		const failure: AssistantMessage = fauxAssistantMessage("partial", {
			stopReason: "error",
			errorMessage: "provider unavailable",
			timestamp: clock.now(),
		});
		const agent = new Agent(baseOptions([failure], { clock }));

		const result = await agent.prompt("try");

		expect(result).toMatchObject({
			outcome: "error",
			failure: { kind: "model", message: "provider unavailable" },
		});
		expect(agent.state.messages).toHaveLength(1);
		expect(agent.state.lastRun).toMatchObject({ outcome: "error" });
	});

	it("rejects concurrent prompt calls with the stable busy control error", async () => {
		const clock = new TestClock();
		let stream!: AssistantMessageEventStream;
		const modelStream: ModelStream = () => {
			stream = createAssistantMessageEventStream();
			return stream;
		};
		const agent = new Agent(withPreparedRun(baseOptions([], { clock }), { stream: modelStream }));
		const first = agent.prompt("first");
		await Promise.resolve();

		await expect(agent.prompt("second")).rejects.toMatchObject({ code: "busy" });
		stream.push({ type: "done", reason: "stop", message: response("done", clock) });
		await first;
	});

	it("makes prompt busy and waitForIdle observable before run_start listeners execute", async () => {
		const clock = new TestClock();
		const agent = new Agent(baseOptions([response("done", clock)], { clock }));
		const seen: AgentEvent["type"][] = [];
		let reentrant!: Promise<unknown>;
		let idle!: Promise<void>;
		let idleResolvedAfter: AgentEvent["type"] | undefined;
		agent.onSemanticEvent((event) => {
			seen.push(event.type);
			if (event.type !== "run_start") return;
			reentrant = agent.prompt("must be busy");
			void reentrant.catch(() => undefined);
			idle = agent.waitForIdle().then(() => {
				idleResolvedAfter = seen.at(-1);
			});
		});

		await agent.prompt("first");
		await expect(reentrant).rejects.toMatchObject({ code: "busy" });
		await idle;
		expect(idleResolvedAfter).toBe("run_end");
		expect(seen.filter((type) => type === "run_start")).toHaveLength(1);
	});

	it("does not resolve prompt or waitForIdle until run_end listeners finish and state is idle", async () => {
		const clock = new TestClock();
		const agent = new Agent(baseOptions([response("done", clock)], { clock }));
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let enteredRunEnd!: () => void;
		const runEndEntered = new Promise<void>((resolve) => {
			enteredRunEnd = resolve;
		});
		let promptSettled = false;
		let idleSettled = false;
		agent.onSemanticEvent(async (event) => {
			if (event.type !== "run_end") return;
			expect(agent.state.status).toBe("settling");
			enteredRunEnd();
			await gate;
		});

		const prompt = agent.prompt("go").then(() => {
			promptSettled = true;
		});
		const idle = agent.waitForIdle().then(() => {
			idleSettled = true;
		});
		await runEndEntered;
		expect(agent.state.status).toBe("settling");
		expect([promptSettled, idleSettled]).toEqual([false, false]);

		release();
		await Promise.all([prompt, idle]);
		expect(agent.state.status).toBe("idle");
		expect([promptSettled, idleSettled]).toEqual([true, true]);
	});

	it("fails explicitly when a model stream ends without a terminal event", async () => {
		const clock = new TestClock();
		const streamWithoutTerminal: ModelStream = () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => stream.end(fauxAssistantMessage("hidden result", { timestamp: clock.now() })));
			return stream;
		};
		const agent = new Agent(withPreparedRun(baseOptions([], { clock }), { stream: streamWithoutTerminal }));

		await expect(agent.prompt("go")).rejects.toThrow("without a terminal event");
		expect(agent.state.status).toBe("idle");
		expect(agent.state.lastRun?.outcome).toBe("error");
	});

	it("rejects abort while idle as an invalid lifecycle operation", () => {
		const agent = new Agent(baseOptions([]));
		expect(() => agent.abort()).toThrowError(AgentError);
		try {
			agent.abort();
		} catch (error) {
			expect(error).toMatchObject({ code: "invalid_lifecycle" });
		}
	});
});
