import type { AgentEvent, AgentSeed, AgentTool, IdGenerator, IdKind } from "@coda/agent";
import {
	createFauxCore,
	fauxAssistantMessage,
	type Model,
	type Models,
	type SimpleStreamOptions,
	Type,
} from "@coda/ai";
import type { McpToolSnapshot } from "@coda/mcp";
import type { SkillId } from "@coda/skills";
import { describe, expect, it, vi } from "vitest";
import {
	type CodingRuntimeSession,
	type CodingRuntimeSessionChange,
	type CodingSkillsSnapshot,
	openCodingAgentRuntime,
} from "../src/index.ts";

class TestIds implements IdGenerator {
	readonly #prefix: string;
	#next = 0;

	constructor(prefix: string) {
		this.#prefix = prefix;
	}

	generate(kind: IdKind): string {
		return `${this.#prefix}:${kind}:${++this.#next}`;
	}
}

class CodingSession implements CodingRuntimeSession {
	readonly id: string;
	readonly seed: AgentSeed = Object.freeze({ version: 1, messages: [], pendingFollowUps: [] });
	readonly changes: CodingRuntimeSessionChange[] = [];
	readonly events: AgentEvent[] = [];
	closed = false;

	constructor(id: string) {
		this.id = id;
	}

	accept(event: AgentEvent): void {
		this.events.push(event);
	}

	async record(change: CodingRuntimeSessionChange): Promise<void> {
		this.changes.push(change);
	}

	async close(): Promise<void> {
		this.closed = true;
	}
}

function runtimeClock() {
	let now = 10_000;
	return { now: () => now++ };
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

function emptyMcp(revision: number): McpToolSnapshot {
	return Object.freeze({
		revision,
		servers: Object.freeze([]),
		tools: Object.freeze([]),
		callTool: async () => {
			throw new Error("No MCP Tools are available");
		},
	});
}

function skillSnapshot(name: string, suffix: string): CodingSkillsSnapshot {
	const id = `skill:${suffix.padEnd(32, "0").slice(0, 32)}` as SkillId;
	const candidate = {
		id,
		metadata: { name, description: `${name} catalog entry` },
		skillFile: `/skills/${name}/SKILL.md`,
	};
	const resolved = Object.freeze({
		candidate,
		origin: { scope: "workspace" as const, root: "/skills", priority: 0 },
		precedence: 0,
		winner: true,
		collisionCount: 1,
		sourceLabel: "./.agents/skills",
		qualifiedName: name,
	});
	return Object.freeze({
		loader: { candidates: [], diagnostics: [] },
		candidates: Object.freeze([candidate]),
		resolved: Object.freeze([resolved]),
		byId: new Map([[id, resolved]]),
		diagnostics: Object.freeze([]),
		activate: async () => {
			throw new Error("Skill activation is not used by this test");
		},
	}) as unknown as CodingSkillsSnapshot;
}

function baseTool(name: string): AgentTool {
	return Object.freeze({
		name,
		description: `${name} base Tool`,
		parameters: Type.Object({}, { additionalProperties: false }),
		replaySafety: "safe" as const,
		execute: () => ({ content: name }),
	});
}

function modelsFor(options: {
	readonly name: string;
	readonly modelIds: readonly [string, ...string[]];
	readonly gates: readonly Promise<void>[];
	readonly contexts: Array<{
		readonly model: string;
		readonly prompt?: string;
		readonly tools: readonly string[];
	}>;
}) {
	const clock = runtimeClock();
	const time = { clock, random: { next: () => 0 }, sleep: { wait: async () => {} } };
	const faux = createFauxCore({
		runtime: time,
		provider: `provider:${options.name}`,
		models: options.modelIds.map((id) => ({ id, input: ["text"], contextWindow: 32_000 })) as [
			{ id: string; input: ["text"]; contextWindow: number },
			...{ id: string; input: ["text"]; contextWindow: number }[],
		],
	});
	for (const [index, gate] of options.gates.entries()) {
		faux.appendResponses([
			async () => {
				await gate;
				return fauxAssistantMessage(`${options.name}:${index}`, { timestamp: clock.now() });
			},
		]);
	}
	const models = {
		streamSimple: (model: Model, context: Parameters<Models["streamSimple"]>[1], stream: SimpleStreamOptions) => {
			options.contexts.push({
				model: model.id,
				prompt: context.systemPrompt,
				tools: context.tools?.map(({ name }) => name) ?? [],
			});
			return faux.streamSimple(model as Model<string>, context, { ...stream, runtime: time });
		},
	} as unknown as Models;
	return { clock, models, model: (id: string) => faux.getModel(id)! };
}

describe("Coding Agent Runtime", () => {
	it("overlaps complete headless instances with isolated Session, Model, Tool, and Prompt snapshots", async () => {
		const alphaGate = deferred();
		const betaGate = deferred();
		const alphaContexts: Array<{ model: string; prompt?: string; tools: readonly string[] }> = [];
		const betaContexts: Array<{ model: string; prompt?: string; tools: readonly string[] }> = [];
		const alphaDriver = modelsFor({
			name: "alpha",
			modelIds: ["model-alpha"],
			gates: [alphaGate.promise],
			contexts: alphaContexts,
		});
		const betaDriver = modelsFor({
			name: "beta",
			modelIds: ["model-beta"],
			gates: [betaGate.promise],
			contexts: betaContexts,
		});
		const alphaSession = new CodingSession("session:alpha");
		const betaSession = new CodingSession("session:beta");
		const alphaSkill = skillSnapshot("alpha-skill", "a");
		const betaSkill = skillSnapshot("beta-skill", "b");

		const [alpha, beta] = await Promise.all([
			openCodingAgentRuntime({
				runtimeId: "runtime:alpha",
				session: alphaSession,
				selection: { model: alphaDriver.model("model-alpha"), reasoning: "off", authSnapshot: { auth: {} } },
				models: alphaDriver.models,
				clock: alphaDriver.clock,
				idGenerator: new TestIds("alpha"),
				autoDrainFollowUps: true,
				interactionMode: "print",
				workspaceRoot: "/workspace/alpha",
				platform: "linux",
				baseTools: [baseTool("alpha_tool")],
				skills: { initial: alphaSkill, current: () => alphaSkill, refresh: async () => alphaSkill },
				mcp: { current: () => emptyMcp(1) },
			}),
			openCodingAgentRuntime({
				runtimeId: "runtime:beta",
				session: betaSession,
				selection: { model: betaDriver.model("model-beta"), reasoning: "off", authSnapshot: { auth: {} } },
				models: betaDriver.models,
				clock: betaDriver.clock,
				idGenerator: new TestIds("beta"),
				autoDrainFollowUps: true,
				interactionMode: "interactive",
				workspaceRoot: "/workspace/beta",
				platform: "darwin",
				baseTools: [baseTool("beta_tool")],
				skills: { initial: betaSkill, current: () => betaSkill, refresh: async () => betaSkill },
				mcp: { current: () => emptyMcp(2) },
			}),
		]);
		const routed: string[] = [];
		alpha.subscribe((event, identity) => {
			if (event.type === "run_start") {
				routed.push(`${identity.runtimeId}/${identity.sessionId}/${identity.runId}`);
			}
		});
		beta.subscribe((event, identity) => {
			if (event.type === "run_start") {
				routed.push(`${identity.runtimeId}/${identity.sessionId}/${identity.runId}`);
			}
		});

		const alphaRun = alpha.prompt("alpha");
		const betaRun = beta.prompt("beta");
		await vi.waitFor(() => {
			expect(alphaContexts).toHaveLength(1);
			expect(betaContexts).toHaveLength(1);
		});
		expect(alpha.snapshot().activeRun?.prepared).toMatchObject({
			model: { id: "model-alpha" },
			mcp: { revision: 1 },
		});
		expect(beta.snapshot().activeRun?.prepared).toMatchObject({
			model: { id: "model-beta" },
			mcp: { revision: 2 },
		});
		expect(alphaContexts[0]?.tools).toEqual(["alpha_tool", "skill"]);
		expect(betaContexts[0]?.tools).toEqual(["beta_tool", "skill"]);
		expect(alphaContexts[0]?.prompt).toContain("/workspace/alpha");
		expect(alphaContexts[0]?.prompt).toContain("alpha-skill");
		expect(alphaContexts[0]?.prompt).not.toContain("beta-skill");
		expect(betaContexts[0]?.prompt).toContain("/workspace/beta");
		expect(betaContexts[0]?.prompt).toContain("beta-skill");
		expect(betaContexts[0]?.prompt).not.toContain("alpha-skill");
		expect(new Set(routed)).toEqual(
			new Set(["runtime:alpha/session:alpha/alpha:run:1", "runtime:beta/session:beta/beta:run:1"]),
		);

		alphaGate.resolve();
		betaGate.resolve();
		await expect(Promise.all([alphaRun, betaRun])).resolves.toMatchObject([
			{ outcome: "success" },
			{ outcome: "success" },
		]);
		expect(alpha.snapshot().agent.messages.every(({ id }) => String(id).startsWith("alpha:"))).toBe(true);
		expect(beta.snapshot().agent.messages.every(({ id }) => String(id).startsWith("beta:"))).toBe(true);
		expect(alpha.input).not.toHaveProperty("dispose");
		await expect(Promise.all([alpha.close(), beta.close()])).resolves.toEqual([
			{ droppedExternalWork: 0 },
			{ droppedExternalWork: 0 },
		]);
		expect(alphaSession.closed).toBe(true);
		expect(betaSession.closed).toBe(true);
	});

	it("keeps an active Prepared Run atomic while desired Model and catalogs change", async () => {
		const firstGate = deferred();
		const contexts: Array<{ model: string; prompt?: string; tools: readonly string[] }> = [];
		const driver = modelsFor({
			name: "updates",
			modelIds: ["model-one", "model-two"],
			gates: [firstGate.promise, Promise.resolve()],
			contexts,
		});
		const firstSkill = skillSnapshot("first-skill", "1");
		const secondSkill = skillSnapshot("second-skill", "2");
		let desiredSkill = firstSkill;
		let desiredMcp = emptyMcp(1);
		const runtime = await openCodingAgentRuntime({
			runtimeId: "runtime:updates",
			session: new CodingSession("session:updates"),
			selection: { model: driver.model("model-one"), reasoning: "low", authSnapshot: { auth: {} } },
			models: driver.models,
			clock: driver.clock,
			idGenerator: new TestIds("updates"),
			autoDrainFollowUps: true,
			interactionMode: "print",
			workspaceRoot: "/workspace/updates",
			platform: "linux",
			baseTools: [baseTool("stable_tool")],
			skills: {
				initial: firstSkill,
				current: () => desiredSkill,
				refresh: async () => desiredSkill,
			},
			mcp: { current: () => desiredMcp },
		});

		const firstRun = runtime.prompt("first");
		await vi.waitFor(() => expect(contexts).toHaveLength(1));
		desiredSkill = secondSkill;
		desiredMcp = emptyMcp(2);
		runtime.select({ model: driver.model("model-two"), reasoning: "high", authSnapshot: { auth: {} } });

		expect(runtime.snapshot().desired).toMatchObject({ model: { id: "model-two" }, reasoning: "high" });
		expect(runtime.snapshot().activeRun?.prepared).toMatchObject({
			model: { id: "model-one" },
			reasoning: "low",
			skills: firstSkill,
			mcp: { revision: 1 },
		});
		expect(contexts[0]?.prompt).toContain("first-skill");
		expect(contexts[0]?.prompt).not.toContain("second-skill");

		firstGate.resolve();
		await firstRun;
		await runtime.prompt("second");
		expect(contexts.map(({ model }) => model)).toEqual(["model-one", "model-two"]);
		expect(contexts[1]?.prompt).toContain("second-skill");
		expect(contexts[1]?.prompt).not.toContain("first-skill");
		expect(runtime.snapshot().agent.lastRun).toMatchObject({ outcome: "success" });
		await runtime.close();
	});
});
