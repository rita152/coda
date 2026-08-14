import { createFauxCore, fauxAssistantMessage, Type } from "@coda/ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/index.ts";
import { observeAgentEvents, TestIds, testTimeRuntime } from "./helpers.ts";

describe("atomic Prepared Runs", () => {
	it("freezes one snapshot for each Run", async () => {
		const contexts: Array<string | undefined> = [];
		const clock = { now: () => 10 };
		const runtime = testTimeRuntime(clock);
		const faux = createFauxCore({ runtime });
		faux.setResponses([
			(context) => {
				contexts.push(context.systemPrompt);
				return fauxAssistantMessage("first", { timestamp: 10 });
			},
			(context) => {
				contexts.push(context.systemPrompt);
				return fauxAssistantMessage("second", { timestamp: 10 });
			},
		]);
		let snapshots = 0;
		const agent = new Agent({
			clock: { now: () => 10 },
			idGenerator: new TestIds(),
			prepareRun: () => ({
				tools: [],
				stream: ({ context, signal }) => faux.streamSimple(faux.getModel(), context, { signal, runtime }),
				systemPrompt: `snapshot-${++snapshots}`,
			}),
		});

		await agent.prompt("one");
		await agent.prompt("two");

		expect(contexts).toEqual(["snapshot-1", "snapshot-2"]);
		expect(snapshots).toBe(2);
	});

	it("awaits preparation and freezes a dynamic Tool set once per Run", async () => {
		const contexts: string[][] = [];
		const clock = { now: () => 10 };
		const runtime = testTimeRuntime(clock);
		const faux = createFauxCore({ runtime });
		faux.setResponses([
			(context) => {
				contexts.push(context.tools?.map(({ name }) => name) ?? []);
				return fauxAssistantMessage("first", { timestamp: 10 });
			},
			(context) => {
				contexts.push(context.tools?.map(({ name }) => name) ?? []);
				return fauxAssistantMessage("second", { timestamp: 10 });
			},
		]);
		let prepared = 0;
		const agent = new Agent({
			clock,
			idGenerator: new TestIds(),
			prepareRun: async () => {
				await Promise.resolve();
				prepared++;
				return {
					tools: [
						{
							name: `run_tool_${prepared}`,
							description: "Run-local Tool",
							parameters: Type.Object({}, { additionalProperties: false }),
							replaySafety: "safe",
							execute: async () => ({ content: "ok" }),
						},
					],
					stream: ({ context, signal }) => faux.streamSimple(faux.getModel(), context, { signal, runtime }),
				};
			},
		});

		await agent.prompt("one");
		await agent.prompt("two");

		expect(contexts).toEqual([["run_tool_1"], ["run_tool_2"]]);
		expect(prepared).toBe(2);
	});

	it("passes preparation cancellation and deadline context before Run start", async () => {
		let started!: () => void;
		const preparationStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		let receivedDeadline: number | undefined;
		const agent = new Agent({
			clock: { now: () => 10 },
			idGenerator: new TestIds(),
			runBudget: { limits: { maxElapsedMs: 50 } },
			prepareRun: async ({ signal, deadline }) => {
				receivedDeadline = deadline;
				started();
				await new Promise<void>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				});
				throw new Error("unreachable");
			},
		});
		const run = agent.prompt("cancel during preparation");
		await preparationStarted;
		expect(agent.state.status).toBe("idle");
		expect(receivedDeadline).toBe(60);
		agent.abort();
		await expect(run).resolves.toMatchObject({ outcome: "aborted" });
	});

	it("prepares a fresh snapshot before every queued Follow-up Run", async () => {
		const contexts: Array<string | undefined> = [];
		const clock = { now: () => 10 };
		const runtime = testTimeRuntime(clock);
		const faux = createFauxCore({ runtime });
		faux.setResponses([
			(context) => {
				contexts.push(context.systemPrompt);
				return fauxAssistantMessage("first", { timestamp: 10 });
			},
			(context) => {
				contexts.push(context.systemPrompt);
				return fauxAssistantMessage("second", { timestamp: 10 });
			},
		]);
		const agent = new Agent({
			clock,
			idGenerator: new TestIds(),
			prepareRun: ({ source, inputMessage }) => {
				const content = inputMessage.message.content;
				return {
					tools: [],
					stream: ({ context, signal }) => faux.streamSimple(faux.getModel(), context, { signal, runtime }),
					systemPrompt: `${source}:${typeof content === "string" ? content : "media"}`,
				};
			},
		});
		agent.onSemanticEvent((event) => {
			if (event.type === "run_start" && event.source === "prompt") agent.followUp("two");
		});

		await agent.prompt("one");

		expect(contexts).toEqual(["prompt:one", "follow_up:two"]);
	});

	it("keeps a queued Follow-up pending when preparation rejects it before Run start", async () => {
		const queueId = "queue:too-large" as import("../src/index.ts").QueueItemId;
		const agent = new Agent({
			clock: { now: () => 10 },
			idGenerator: new TestIds(),
			prepareRun: () => {
				throw new Error("Context Overflow");
			},
			seed: { version: 1, messages: [], pendingFollowUps: [{ id: queueId, content: "too large" }] },
		});
		const events: string[] = [];
		observeAgentEvents(agent, (event) => events.push(event.type));

		await expect(agent.resumeFollowUps()).rejects.toThrow("Context Overflow");
		expect(agent.state.pendingFollowUps.map(({ id }) => id)).toEqual([queueId]);
		expect(events).toEqual([]);
		expect(agent.state.lastRun).toBeUndefined();
	});

	it("disposes each successfully prepared capability exactly once even when its stream fails", async () => {
		const disposed: string[] = [];
		let preparation = 0;
		const agent = new Agent({
			clock: { now: () => 10 },
			idGenerator: new TestIds(),
			prepareRun: () => {
				const id = `prepared:${++preparation}`;
				return {
					tools: [],
					stream: async () => {
						throw new Error("driver failed");
					},
					dispose: () => {
						disposed.push(id);
					},
				};
			},
		});

		await expect(agent.prompt("one")).rejects.toThrow("driver failed");
		expect(disposed).toEqual(["prepared:1"]);
		expect(agent.state.status).toBe("idle");
	});

	it("disposes a returned capability when snapshot validation rejects it", async () => {
		let disposed = 0;
		const duplicate = {
			name: "duplicate",
			description: "duplicate",
			parameters: Type.Object({}, { additionalProperties: false }),
			replaySafety: "safe" as const,
			execute: () => ({ content: "unused" }),
		};
		const agent = new Agent({
			clock: { now: () => 10 },
			idGenerator: new TestIds(),
			prepareRun: () => ({
				tools: [duplicate, duplicate],
				stream: async () => {
					throw new Error("must not stream");
				},
				dispose: () => {
					disposed++;
				},
			}),
		});

		await expect(agent.prompt("validate")).rejects.toThrow("Tool names must be unique");
		expect(disposed).toBe(1);
	});
});
