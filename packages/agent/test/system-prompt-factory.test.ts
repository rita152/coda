import { createFauxCore, fauxAssistantMessage } from "@coda/ai";
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
});
