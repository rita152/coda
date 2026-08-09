import type { IdGenerator } from "@coda/agent";
import {
	createFauxCore,
	createModels,
	createProvider,
	envApiKeyAuth,
	fauxAssistantMessage,
	fauxProvider,
} from "@coda/ai";
import { describe, expect, it } from "vitest";
import { type ApplicationOutput, createCodingAgentApplication, type SettingsStore } from "../src/application.ts";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import { createNodeProcessRunner } from "../src/host/node-process-runner.ts";
import { InMemorySessionManager } from "../src/session/memory-session-manager.ts";
import { testTimeRuntime } from "./time-runtime.ts";

class BufferOutput implements ApplicationOutput {
	readonly isTTY: boolean;
	value = "";

	constructor(isTTY = false) {
		this.isTTY = isTTY;
	}

	write(chunk: string): void {
		this.value += chunk;
	}
}

const settings: SettingsStore = {
	load: async () => ({}),
	save: async () => undefined,
};

describe("Coding Agent print mode", () => {
	it("prints help without resolving settings, credentials, or a Model", async () => {
		const models = createModels({ runtime: testTimeRuntime() });
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let settingsLoaded = false;
		const application = createCodingAgentApplication({
			models,
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			settings: {
				load: async () => {
					settingsLoaded = true;
					return {};
				},
				save: async () => undefined,
			},
			io: {
				stdin: { isTTY: true, readAll: async () => "" },
				stdout,
				stderr,
			},
			runtime: {
				cwd: "/tmp",
				homeDirectory: "/home/test",
				platform: "darwin",
				environment: {},
				clock: { now: () => 0 },
				idGenerator: { generate: (kind) => `${kind}:unused` },
			},
		});

		await expect(application.run(["--help"])).resolves.toBe(0);
		expect(stdout.value).toContain("Usage: coda");
		expect(stdout.value).toContain("--allow-workspace-write");
		expect(stderr.value).toBe("");
		expect(settingsLoaded).toBe(false);
	});

	it("lists Workspace Sessions without resolving settings or a Model", async () => {
		const models = createModels({ runtime: testTimeRuntime() });
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let settingsLoaded = false;
		let id = 0;
		const idGenerator: IdGenerator = { generate: (kind) => `${kind}:${++id}` };
		const runtime = {
			cwd: "/tmp",
			homeDirectory: "/home/test",
			platform: "darwin" as const,
			environment: {},
			clock: { now: () => 0 },
			idGenerator,
		};
		const sessions = new InMemorySessionManager({
			clock: runtime.clock,
			idGenerator,
		});
		const application = createCodingAgentApplication({
			models,
			sessions,
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			settings: {
				load: async () => {
					settingsLoaded = true;
					return {};
				},
				save: async () => undefined,
			},
			io: {
				stdin: { isTTY: false, readAll: async () => "" },
				stdout,
				stderr,
			},
			runtime: {
				...runtime,
				idGenerator,
			},
		});

		await expect(application.run(["sessions", "--workspace", "/tmp"])).resolves.toBe(0);
		expect(stdout.value).toBe("(no Sessions)\n");
		expect(stderr.value).toBe("");
		expect(settingsLoaded).toBe(false);
	});

	it("runs an explicit Model through @coda/agent and writes only the final assistant text", async () => {
		const faux = fauxProvider({ runtime: testTimeRuntime(100) });
		faux.setResponses([fauxAssistantMessage("hello from Coda", { timestamp: 100 })]);
		const models = createModels({ runtime: testTimeRuntime(100) });
		models.setProvider(faux.provider);
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			settings,
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			io: {
				stdin: { isTTY: true, readAll: async () => "" },
				stdout,
				stderr,
			},
			runtime: {
				cwd: "/tmp",
				homeDirectory: "/home/test",
				platform: "darwin",
				environment: {},
				clock: { now: () => 100 },
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
			},
		});

		const exitCode = await application.run([
			"--print",
			"--model",
			`${faux.getModel().provider}/${faux.getModel().id}`,
			"say hello",
		]);

		expect(exitCode).toBe(0);
		expect(stdout.value).toBe("hello from Coda\n");
		expect(stderr.value).toBe("");
		expect(faux.state.callCount).toBe(1);
	});

	it("treats --no-tui as print mode without constructing a Terminal", async () => {
		const runtime = testTimeRuntime(150);
		const faux = fauxProvider({ runtime });
		faux.setResponses([fauxAssistantMessage("plain output", { timestamp: 150 })]);
		const models = createModels({ runtime });
		models.setProvider(faux.provider);
		const stdout = new BufferOutput(true);
		const stderr = new BufferOutput(true);
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			settings,
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			terminalFactory: {
				create: () => {
					throw new Error("print mode must not construct a Terminal");
				},
			},
			io: {
				stdin: { isTTY: true, readAll: async () => "" },
				stdout,
				stderr,
			},
			runtime: {
				cwd: "/tmp",
				homeDirectory: "/home/test",
				platform: "darwin",
				environment: {},
				clock: runtime.clock,
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
			},
		});

		await expect(
			application.run(["--no-tui", "--model", `${faux.getModel().provider}/${faux.getModel().id}`, "hello"]),
		).resolves.toBe(0);
		expect(stdout.value).toBe("plain output\n");
		expect(stderr.value).toBe("");
	});

	it("writes stable JSONL Agent events and enriches run_start with Model and reasoning", async () => {
		const faux = fauxProvider({ runtime: testTimeRuntime(200) });
		faux.setResponses([fauxAssistantMessage("json answer", { timestamp: 200 })]);
		const models = createModels({ runtime: testTimeRuntime(200) });
		models.setProvider(faux.provider);
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			settings: {
				load: async () => ({ defaultReasoning: "high" }),
				save: async () => undefined,
			},
			io: {
				stdin: { isTTY: true, readAll: async () => "" },
				stdout,
				stderr,
			},
			runtime: {
				cwd: "/tmp",
				homeDirectory: "/home/test",
				platform: "darwin",
				environment: {},
				clock: { now: () => 200 },
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
			},
		});

		const exitCode = await application.run([
			"--print",
			"--json",
			"--model",
			`${faux.getModel().provider}/${faux.getModel().id}`,
			"answer as json events",
		]);

		expect(exitCode).toBe(0);
		const events = stdout.value
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(events[0]).toMatchObject({
			schemaVersion: 2,
			type: "run_start",
			model: { provider: faux.getModel().provider, id: faux.getModel().id },
			reasoning: "off",
		});
		expect(events.at(-1)).toMatchObject({ schemaVersion: 2, type: "run_end", outcome: "success" });
		expect(stdout.value).not.toContain("json answer\n");
		expect(stderr.value).toBe("");
	});

	it("resolves CLI reasoning before settings and exposes the effective level", async () => {
		const faux = fauxProvider({
			runtime: testTimeRuntime(250),
			models: [{ id: "reasoning-model", reasoning: true }],
		});
		faux.setResponses([
			(_context, streamOptions) => {
				expect(streamOptions?.reasoning).toBe("high");
				return fauxAssistantMessage("reasoned answer", { timestamp: 250 });
			},
		]);
		const models = createModels({ runtime: testTimeRuntime(250) });
		models.setProvider(faux.provider);
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			settings: { load: async () => ({ defaultReasoning: "low" }), save: async () => undefined },
			io: {
				stdin: { isTTY: true, readAll: async () => "" },
				stdout,
				stderr,
			},
			runtime: {
				cwd: "/tmp",
				homeDirectory: "/home/test",
				platform: "darwin",
				environment: {},
				clock: { now: () => 250 },
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
			},
		});

		const exitCode = await application.run([
			"--print",
			"--json",
			"--reasoning",
			"high",
			"--model",
			`${faux.getModel().provider}/${faux.getModel().id}`,
			"reason",
		]);

		expect(exitCode).toBe(0);
		const runStart = JSON.parse(stdout.value.split("\n")[0]!) as Record<string, unknown>;
		expect(runStart).toMatchObject({ type: "run_start", reasoning: "high" });
		expect(stderr.value).toBe("");
	});

	it("fails as configuration before starting a Run when the selected Model is not authenticated", async () => {
		const faux = createFauxCore({
			runtime: testTimeRuntime(275),
			provider: "locked",
			models: [{ id: "locked-model" }],
		});
		const models = createModels({
			runtime: testTimeRuntime(275),
			authContext: { env: async () => undefined, fileExists: async () => false },
		});
		models.setProvider(
			createProvider({
				id: "locked",
				auth: { apiKey: envApiKeyAuth("Locked key", ["LOCKED_API_KEY"]) },
				models: faux.models,
				api: { stream: faux.stream, streamSimple: faux.streamSimple },
			}),
		);
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			settings: { load: async () => ({}), save: async () => undefined },
			io: {
				stdin: { isTTY: true, readAll: async () => "" },
				stdout,
				stderr,
			},
			runtime: {
				cwd: "/tmp",
				homeDirectory: "/home/test",
				platform: "darwin",
				environment: {},
				clock: { now: () => 275 },
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
			},
		});

		const exitCode = await application.run(["--print", "--model", "locked/locked-model", "do not send this"]);

		expect(exitCode).toBe(1);
		expect(stdout.value).toBe("");
		expect(stderr.value).toBe("coda: Model is not authenticated: locked/locked-model\n");
		expect(faux.state.callCount).toBe(0);
	});

	it("fails closed before the provider call on definite Context Overflow", async () => {
		const faux = fauxProvider({
			runtime: testTimeRuntime(280),
			models: [{ id: "tiny", contextWindow: 128, maxTokens: 32 }],
		});
		faux.setResponses([fauxAssistantMessage("must not run", { timestamp: 280 })]);
		const models = createModels({ runtime: testTimeRuntime(280) });
		models.setProvider(faux.provider);
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			settings: { load: async () => ({}), save: async () => undefined },
			io: {
				stdin: { isTTY: true, readAll: async () => "" },
				stdout,
				stderr,
			},
			runtime: {
				cwd: "/tmp",
				homeDirectory: "/home/test",
				platform: "darwin",
				environment: {},
				clock: { now: () => 280 },
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
			},
		});

		const exitCode = await application.run([
			"--print",
			"--model",
			`${faux.getModel().provider}/${faux.getModel().id}`,
			"x".repeat(4_000),
		]);

		expect(exitCode).toBe(1);
		expect(stderr.value).toContain("Context Overflow");
		expect(stdout.value).toBe("");
		expect(faux.state.callCount).toBe(0);
	});
});
