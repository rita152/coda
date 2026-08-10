import { createFauxCore, fauxAssistantMessage, Type } from "@coda/ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/index.ts";
import { TestIds, testTimeRuntime } from "./helpers.ts";

describe("System Prompt factory", () => {
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
			tools: [],
			policyGate: { check: async () => ({ decision: "allow" }) },
			stream: ({ context, signal }) => faux.streamSimple(faux.getModel(), context, { signal, runtime }),
			systemPrompt: () => `snapshot-${++snapshots}`,
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
		let factories = 0;
		const agent = new Agent({
			clock,
			idGenerator: new TestIds(),
			beforeRun: async () => {
				await Promise.resolve();
				prepared++;
			},
			tools: () => {
				factories++;
				return [
					{
						name: `run_tool_${prepared}`,
						description: "Run-local Tool",
						parameters: Type.Object({}, { additionalProperties: false }),
						replaySafety: "safe",
						execute: async () => ({ content: "ok" }),
					},
				];
			},
			policyGate: { check: async () => ({ decision: "allow" }) },
			stream: ({ context, signal }) => faux.streamSimple(faux.getModel(), context, { signal, runtime }),
		});

		await agent.prompt("one");
		await agent.prompt("two");

		expect(contexts).toEqual([["run_tool_1"], ["run_tool_2"]]);
		expect(factories).toBe(2);
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
		let snapshot = "unprepared";
		const agent = new Agent({
			clock,
			idGenerator: new TestIds(),
			tools: [],
			policyGate: { check: async () => ({ decision: "allow" }) },
			stream: ({ context, signal }) => faux.streamSimple(faux.getModel(), context, { signal, runtime }),
			beforeRun: ({ source, inputMessage }) => {
				const content = inputMessage.message.content;
				snapshot = `${source}:${typeof content === "string" ? content : "media"}`;
			},
			systemPrompt: () => snapshot,
		});
		agent.onEvent((event) => {
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
			tools: [],
			policyGate: { check: async () => ({ decision: "allow" }) },
			stream: async () => {
				throw new Error("stream must not start");
			},
			beforeRun: () => {
				throw new Error("Context Overflow");
			},
			seed: { version: 1, messages: [], pendingFollowUps: [{ id: queueId, content: "too large" }] },
		});
		const events: string[] = [];
		agent.onEvent((event) => events.push(event.type));

		await expect(agent.resumeFollowUps()).rejects.toThrow("Context Overflow");
		expect(agent.state.pendingFollowUps.map(({ id }) => id)).toEqual([queueId]);
		expect(events).toEqual([]);
		expect(agent.state.lastRun).toBeUndefined();
	});
});
