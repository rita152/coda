import type { AgentEvent, IdGenerator, IdKind } from "@coda/agent";
import { createFauxCore, fauxAssistantMessage, Type } from "@coda/ai";
import { describe, expect, it, vi } from "vitest";
import { openAgentRuntime, type RuntimeSession } from "../src/index.ts";

class TestIds implements IdGenerator {
	readonly prefix: string;
	#next = 0;

	constructor(prefix: string) {
		this.prefix = prefix;
	}

	generate(kind: IdKind): string {
		return `${this.prefix}:${kind}:${++this.#next}`;
	}
}

class MemoryRuntimeSession implements RuntimeSession {
	readonly id: string;
	readonly events: AgentEvent[] = [];
	closed = false;

	constructor(id: string) {
		this.id = id;
	}

	accept(event: AgentEvent): void {
		this.events.push(event);
	}

	async close(): Promise<void> {
		this.closed = true;
	}
}

interface DesiredConfiguration {
	readonly model: string;
	readonly tool: string;
	readonly prompt: string;
}

interface ActiveSnapshot extends DesiredConfiguration {
	readonly preparation: number;
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

function clock() {
	let now = 1_000;
	return { now: () => now++ };
}

describe("Agent Runtime isolation", () => {
	it("overlaps two independent instances without crossing Session or Prepared Run snapshots", async () => {
		const gates = { alpha: deferred(), beta: deferred() };
		const entered: string[] = [];
		const contexts = new Map<string, { readonly prompt?: string; readonly tools: readonly string[] }>();
		const disposed: string[] = [];

		const open = async (name: "alpha" | "beta") => {
			const runtimeClock = clock();
			const fauxRuntime = {
				clock: runtimeClock,
				random: { next: () => 0 },
				sleep: { wait: async () => {} },
			};
			const faux = createFauxCore({ runtime: fauxRuntime });
			faux.setResponses([fauxAssistantMessage(`${name} answer`, { timestamp: runtimeClock.now() })]);
			return openAgentRuntime<DesiredConfiguration, ActiveSnapshot>({
				runtimeId: `runtime:${name}`,
				session: new MemoryRuntimeSession(`session:${name}`),
				clock: runtimeClock,
				idGenerator: new TestIds(name),
				configuration: { model: `model:${name}`, tool: `tool:${name}`, prompt: `prompt:${name}` },
				prepareRun: ({ configuration }) => ({
					snapshot: { ...configuration, preparation: 1 },
					systemPrompt: configuration.prompt,
					tools: [
						{
							name: configuration.tool,
							description: `${name} Tool`,
							parameters: Type.Object({}, { additionalProperties: false }),
							replaySafety: "safe",
							execute: () => ({ content: name }),
						},
					],
					stream: async ({ context, signal }) => {
						entered.push(name);
						contexts.set(name, {
							prompt: context.systemPrompt,
							tools: context.tools?.map(({ name: toolName }) => toolName) ?? [],
						});
						await gates[name].promise;
						return faux.streamSimple(faux.getModel(), context, { runtime: fauxRuntime, signal });
					},
					dispose: () => {
						disposed.push(name);
					},
				}),
			});
		};

		const [alpha, beta] = await Promise.all([open("alpha"), open("beta")]);
		const alphaRun = alpha.prompt("alpha input");
		const betaRun = beta.prompt("beta input");
		await vi.waitFor(() => expect(new Set(entered)).toEqual(new Set(["alpha", "beta"])));

		expect(alpha.snapshot().activeRun).toMatchObject({
			configuration: { model: "model:alpha" },
			prepared: { tool: "tool:alpha", prompt: "prompt:alpha" },
		});
		expect(beta.snapshot().activeRun).toMatchObject({
			configuration: { model: "model:beta" },
			prepared: { tool: "tool:beta", prompt: "prompt:beta" },
		});
		expect(contexts).toEqual(
			new Map([
				["alpha", { prompt: "prompt:alpha", tools: ["tool:alpha"] }],
				["beta", { prompt: "prompt:beta", tools: ["tool:beta"] }],
			]),
		);

		gates.alpha.resolve();
		gates.beta.resolve();
		await expect(Promise.all([alphaRun, betaRun])).resolves.toMatchObject([
			{ outcome: "success" },
			{ outcome: "success" },
		]);
		expect(disposed.sort()).toEqual(["alpha", "beta"]);
		expect(alpha.snapshot().agent.messages.every(({ id }) => String(id).startsWith("alpha:"))).toBe(true);
		expect(beta.snapshot().agent.messages.every(({ id }) => String(id).startsWith("beta:"))).toBe(true);
		await Promise.all([alpha.close(), beta.close()]);
	});

	it("applies Desired Runtime Configuration updates only to the next Run", async () => {
		const firstGate = deferred();
		const seen: DesiredConfiguration[] = [];
		const runtimeClock = clock();
		const fauxRuntime = {
			clock: runtimeClock,
			random: { next: () => 0 },
			sleep: { wait: async () => {} },
		};
		const faux = createFauxCore({ runtime: fauxRuntime });
		faux.setResponses([
			fauxAssistantMessage("first", { timestamp: runtimeClock.now() }),
			fauxAssistantMessage("second", { timestamp: runtimeClock.now() }),
		]);
		let preparation = 0;
		const runtime = await openAgentRuntime<DesiredConfiguration, ActiveSnapshot>({
			runtimeId: "runtime:update",
			session: new MemoryRuntimeSession("session:update"),
			clock: runtimeClock,
			idGenerator: new TestIds("update"),
			configuration: { model: "model:one", tool: "tool_one", prompt: "prompt one" },
			prepareRun: ({ configuration }) => {
				const selected = { ...configuration };
				const current = ++preparation;
				return {
					snapshot: { ...selected, preparation: current },
					systemPrompt: selected.prompt,
					tools: [
						{
							name: selected.tool,
							description: selected.model,
							parameters: Type.Object({}, { additionalProperties: false }),
							replaySafety: "safe",
							execute: () => ({ content: selected.model }),
						},
					],
					stream: async ({ context, signal }) => {
						seen.push(selected);
						expect(context.systemPrompt).toBe(selected.prompt);
						expect(context.tools?.map(({ name }) => name)).toEqual([selected.tool]);
						if (current === 1) await firstGate.promise;
						return faux.streamSimple(faux.getModel(), context, { runtime: fauxRuntime, signal });
					},
				};
			},
		});

		const first = runtime.prompt("first");
		await vi.waitFor(() => expect(seen).toHaveLength(1));
		runtime.updateConfiguration({ model: "model:two", tool: "tool_two", prompt: "prompt two" });
		expect(runtime.snapshot().activeRun?.prepared).toMatchObject({
			model: "model:one",
			tool: "tool_one",
			prompt: "prompt one",
		});
		firstGate.resolve();
		await first;
		await runtime.prompt("second");

		expect(seen).toEqual([
			{ model: "model:one", tool: "tool_one", prompt: "prompt one" },
			{ model: "model:two", tool: "tool_two", prompt: "prompt two" },
		]);
		await runtime.close();
	});

	it("routes identity-rich events and owns Session close", async () => {
		const runtimeClock = clock();
		const fauxRuntime = {
			clock: runtimeClock,
			random: { next: () => 0 },
			sleep: { wait: async () => {} },
		};
		const faux = createFauxCore({ runtime: fauxRuntime });
		faux.setResponses([fauxAssistantMessage("done", { timestamp: runtimeClock.now() })]);
		const session = new MemoryRuntimeSession("session:events");
		const runtime = await openAgentRuntime({
			runtimeId: "runtime:events",
			session,
			clock: runtimeClock,
			idGenerator: new TestIds("events"),
			configuration: { model: "events" },
			prepareRun: () => ({
				snapshot: { model: "events" },
				tools: [],
				stream: ({ context, signal }) =>
					faux.streamSimple(faux.getModel(), context, { runtime: fauxRuntime, signal }),
			}),
		});
		const routed: string[] = [];
		runtime.subscribe((event) => {
			routed.push(
				event.type === "agent"
					? `${event.runtimeId}/${event.sessionId}/${event.runId}/${event.event.type}`
					: `${event.runtimeId}/${event.sessionId}/closed`,
			);
		});

		await runtime.prompt("go");
		await runtime.close();

		expect(routed[0]).toMatch(/^runtime:events\/session:events\/events:run:1\/run_start$/u);
		expect(routed.at(-1)).toBe("runtime:events/session:events/closed");
		expect(session.closed).toBe(true);
	});

	it("clears the active snapshot when Agent validation rejects a prepared capability", async () => {
		const duplicate = {
			name: "duplicate",
			description: "duplicate",
			parameters: Type.Object({}, { additionalProperties: false }),
			replaySafety: "safe" as const,
			execute: () => ({ content: "unused" }),
		};
		const runtime = await openAgentRuntime({
			runtimeId: "runtime:invalid-preparation",
			session: new MemoryRuntimeSession("session:invalid-preparation"),
			clock: clock(),
			idGenerator: new TestIds("invalid-preparation"),
			configuration: { model: "model", tool: "duplicate", prompt: "prompt" },
			prepareRun: ({ configuration }) => ({
				snapshot: { ...configuration, preparation: 1 },
				tools: [duplicate, duplicate],
				stream: async () => {
					throw new Error("must not stream");
				},
			}),
		});

		await expect(runtime.prompt("validate")).rejects.toThrow("Tool names must be unique");
		expect(runtime.snapshot().activeRun).toBeUndefined();
		await runtime.close();
	});
});
