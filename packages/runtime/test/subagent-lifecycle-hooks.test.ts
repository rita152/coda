import type { IdGenerator, IdKind } from "@coda/agent";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@coda/ai";
import { describe, expect, it } from "vitest";
import { createHeadlessCodingAgent, waitForGraph } from "../src/headless.ts";
import type { LifecycleHookHost, OpenCodingAgentOptions, SubagentHookContext, WorkGraphId } from "../src/index.ts";

class TestIds implements IdGenerator {
	#next = 0;
	generate(kind: IdKind): string {
		return `test:${kind}:${++this.#next}`;
	}
}

function recordingHooks(): LifecycleHookHost & {
	readonly starts: SubagentHookContext[];
	readonly stops: string[];
} {
	const starts: SubagentHookContext[] = [];
	const stops: string[] = [];
	return {
		starts,
		stops,
		sessionStart: async () => ({ continue: true }),
		sessionEnd: async () => undefined,
		userPromptSubmit: async () => ({ continue: true }),
		preToolUse: async () => ({ continue: true }),
		postToolUse: async () => ({ continue: true }),
		preCompact: async () => ({ continue: true }),
		postCompact: async () => ({ continue: true }),
		stop: async () => ({ continue: true }),
		subagentStart: async (context) => {
			starts.push(context);
			return { continue: true };
		},
		subagentStop: async (context) => {
			stops.push(context.agentId);
			return { continue: true };
		},
		takeAdditionalContext: () => [],
		close: async () => undefined,
	};
}

describe("Subagent lifecycle Hooks", () => {
	it("fires SubagentStart when a child enters running and SubagentStop at its terminal state", async () => {
		const hooks = recordingHooks();
		const agent = await openDelegatedAgent(hooks);
		await agent.submit({
			commands: [
				{
					type: "start_work_graph",
					graphId: "graph:subagent-hooks",
					objective: "delegate one writer",
					root: { itemId: "root", executionMode: "write" },
					maximumConcurrency: 2,
					configuration: { model: { provider: "work", id: "one" }, reasoning: "off" },
					session: { type: "create", sessionId: "session:graph:subagent-hooks" },
				},
			],
		});
		const result = await waitForGraph(agent, "graph:subagent-hooks" as WorkGraphId, { capacity: 1_024 });
		expect(result.results.map(({ itemId, state }) => [itemId, state])).toEqual([
			["root", "succeeded"],
			["alpha", "succeeded"],
		]);
		expect(hooks.starts.map((context) => [context.agentId, context.agentType, context.sessionId])).toEqual([
			["alpha", "write", "session:graph:subagent-hooks"],
		]);
		expect(hooks.stops).toEqual(["alpha"]);
		await agent.close();
	});

	it("keeps the Work Graph moving when SubagentStart throws", async () => {
		const hooks = recordingHooks();
		hooks.subagentStart = async () => {
			throw new Error("hook exploded");
		};
		const agent = await openDelegatedAgent(hooks);
		await agent.submit({
			commands: [
				{
					type: "start_work_graph",
					graphId: "graph:subagent-hook-failure",
					objective: "delegate one writer",
					root: { itemId: "root", executionMode: "write" },
					maximumConcurrency: 2,
					configuration: { model: { provider: "work", id: "one" }, reasoning: "off" },
					session: { type: "create", sessionId: "session:graph:subagent-hook-failure" },
				},
			],
		});
		await expect(
			waitForGraph(agent, "graph:subagent-hook-failure" as WorkGraphId, { capacity: 1_024 }),
		).resolves.toMatchObject({
			results: expect.arrayContaining([
				expect.objectContaining({ itemId: "alpha", state: "succeeded" }),
				expect.objectContaining({ itemId: "root", state: "succeeded" }),
			]),
		});
		await agent.close();
	});
});

async function openDelegatedAgent(lifecycleHooks: LifecycleHookHost) {
	let now = 1_000;
	const clock = { now: () => now++ };
	const runtime = {
		clock,
		random: { next: () => 0 },
		scheduler: { schedule: () => ({ cancel: () => undefined }) },
		sleep: { wait: async () => undefined },
	};
	const faux = createFauxCore({
		runtime,
		provider: "work",
		models: [{ id: "one", input: ["text"], contextWindow: 64_000 }],
	});
	faux.appendResponses([
		async () =>
			fauxAssistantMessage(
				[
					fauxToolCall(
						"delegate",
						{ items: [{ itemId: "alpha", objective: "write", executionMode: "write" }] },
						{ id: "d1" },
					),
				],
				{ stopReason: "toolUse", timestamp: clock.now() },
			),
		async () => fauxAssistantMessage("alpha done", { timestamp: clock.now() }),
		async () => fauxAssistantMessage("parent done", { timestamp: clock.now() }),
	]);
	const modelProvider: OpenCodingAgentOptions["modelProvider"] = {
		resolve: (configuration) => {
			const model = faux.getModel(configuration.model.id);
			if (!model) throw new Error(`Model is unavailable: ${configuration.model.id}`);
			return { model, reasoning: configuration.reasoning, authSnapshot: { auth: {} } };
		},
		lease: (selection) => ({
			model: selection.model,
			revision: `test:${selection.model.id}`,
			stream: (context, options) => faux.streamSimple(selection.model, context, { ...options, runtime }),
			complete: (context, options) => faux.streamSimple(selection.model, context, { ...options, runtime }).result(),
			dispose: () => undefined,
		}),
	};
	return createHeadlessCodingAgent({
		modelProvider,
		capabilitySources: [],
		time: runtime,
		identity: new TestIds(),
		capacity: { processMaximumConcurrency: 8, graphMaximumConcurrency: 8 },
		platform: "linux",
		interactionMode: "evaluation",
		lifecycleHooks,
	});
}
