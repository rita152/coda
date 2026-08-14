import type { AgentTool, IdGenerator, IdKind } from "@coda/agent";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, Type } from "@coda/ai";
import { describe, expect, it } from "vitest";
import { openEvaluationWorkGraph } from "../src/runtime-adapter.ts";

class EvaluationIds implements IdGenerator {
	#next = 0;

	generate(kind: IdKind): string {
		return `evaluation:${kind}:${++this.#next}`;
	}
}

describe("Evaluation Work Graph adapter", () => {
	it("resynchronizes after transient pressure and retains only semantic evaluation events", async () => {
		let now = 1_000;
		const clock = { now: () => now++ };
		const runtime = { clock, random: { next: () => 0 }, sleep: { wait: async () => undefined } };
		const faux = createFauxCore({ runtime, chunkCharacters: 1 });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("progress_storm", {}, { id: "tool:progress" }), {
				stopReason: "toolUse",
				timestamp: clock.now(),
			}),
			fauxAssistantMessage("evaluation complete", { timestamp: clock.now() }),
		]);
		const parameters = Type.Object({}, { additionalProperties: false });
		const progressTool: AgentTool<typeof parameters> = {
			name: "progress_storm",
			description: "Emit enough transient progress to overflow an Observation hop",
			parameters,
			replaySafety: "safe",
			execute: (_arguments, context) => {
				for (let progress = 0; progress < 10_000; progress++) {
					context.reportProgress?.({ progress, total: 10_000, message: `transient:${progress}` });
				}
				return { content: "progress complete" };
			},
		};
		const workGraph = await openEvaluationWorkGraph({
			id: "observation-pressure",
			stream: ({ context, signal }) => faux.streamSimple(faux.getModel(), context, { signal, runtime }),
			tools: [progressTool],
			systemPrompt: "Complete the evaluation.",
			clock,
			idGenerator: new EvaluationIds(),
		});

		const result = await workGraph.run("exercise progress delivery");
		expect(result.results[0]).toMatchObject({ state: "succeeded", run: { outcome: "success" } });
		expect(workGraph.events.some((event) => event.type === "tool_execution_end")).toBe(true);
		expect(workGraph.events.some((event) => event.type === "message_end")).toBe(true);
		expect(
			workGraph.events.some(
				(event) =>
					event.type === "message_start" ||
					event.type === "message_update" ||
					event.type === "tool_execution_progress",
			),
		).toBe(false);
		await workGraph.close();
	});
});
