import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@coda/ai";
import { opencodeGoProvider } from "@coda/ai/providers/opencode-go";
import { createSystemScheduler, VirtualTerminal } from "@coda/tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ApplicationOutput, createCodingAgentApplication } from "../src/application.ts";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import { createNodeProcessRunner } from "../src/host/node-process-runner.ts";
import type {
	InteractiveLifecycleHandlers,
	InteractiveProcessLifecycle,
	InteractiveTerminationSignal,
} from "../src/interactive/process-lifecycle.ts";
import { testTimeRuntime } from "./time-runtime.ts";

class BufferOutput implements ApplicationOutput {
	readonly isTTY = true;
	value = "";

	write(chunk: string): void {
		this.value += chunk;
	}
}

class FakeLifecycle implements InteractiveProcessLifecycle {
	handlers?: InteractiveLifecycleHandlers;

	subscribe(handlers: InteractiveLifecycleHandlers): () => void {
		this.handlers = handlers;
		return () => {
			this.handlers = undefined;
		};
	}

	async suspend(): Promise<void> {}

	terminate(signal: InteractiveTerminationSignal): void {
		this.handlers?.terminate(signal);
	}
}

async function until(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("Condition did not become true");
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function key(key: "c" | "down" | "enter", control = false) {
	return {
		type: "key" as const,
		key,
		...(key === "c" ? { text: "c" } : {}),
		shift: false,
		control,
		alt: false,
		meta: false,
		action: "press" as const,
	};
}

describe("interactive first run", () => {
	it("restores the terminal when SIGTERM interrupts Model selection", async () => {
		const faux = fauxProvider({
			runtime: testTimeRuntime(1_450),
			models: [
				{ id: "model-a", name: "Model A" },
				{ id: "model-b", name: "Model B" },
			],
		});
		const models = createModels({ runtime: testTimeRuntime(1_450) });
		models.setProvider(faux.provider);
		const terminal = new VirtualTerminal({ columns: 80, rows: 24 });
		const lifecycle = new FakeLifecycle();
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			settings: { load: async () => ({}), save: async () => undefined },
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			terminalFactory: { create: () => terminal },
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
				clock: { now: () => 1_450 },
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
				scheduler: createSystemScheduler(),
				interactiveLifecycle: lifecycle,
			},
		});

		const running = application.run(["--interactive", "--no-session"]);
		await until(() => terminal.readOutput().includes("Select a Model"));
		lifecycle.terminate("SIGTERM");

		await expect(running).resolves.toBe(143);
		expect(terminal.started).toBe(false);
		expect(terminal.readOutput()).toContain("\x1b[?1049l");
		expect(terminal.readOutput()).toContain("\x1b[?7h");
		expect(terminal.readOutput()).toContain("\x1b[?25h");
		expect(stderr.value).toBe("");
	});

	it("requires an explicit catalog choice and saves it as the default Model", async () => {
		const faux = fauxProvider({
			runtime: testTimeRuntime(1_500),
			models: [
				{ id: "model-a", name: "Model A" },
				{ id: "model-b", name: "Model B" },
			],
		});
		const models = createModels({ runtime: testTimeRuntime(1_500) });
		models.setProvider(faux.provider);
		const terminal = new VirtualTerminal({ columns: 80, rows: 24 });
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		const save = vi.fn(async (_settings: unknown) => undefined);
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			settings: { load: async () => ({}), save },
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			terminalFactory: { create: () => terminal },
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
				clock: { now: () => 1_500 },
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
				scheduler: createSystemScheduler(),
			},
		});

		const running = application.run(["--interactive", "--no-session"]);
		await until(() => terminal.readOutput().includes("Select a Model"));
		await terminal.emit(key("down"));
		await terminal.emit(key("enter"));
		terminal.clearOutput();
		await until(() => terminal.readOutput().includes("faux/model-b"));
		await terminal.emit(key("c", true));
		await terminal.emit(key("c", true));

		await expect(running).resolves.toBe(0);
		expect(save).toHaveBeenCalledWith({ defaultModel: { provider: "faux", id: "model-b" } });
		expect(stderr.value).toBe("");
	});

	it("prompts for and stores an OpenCode Go key before showing authenticated Models", async () => {
		const models = createModels({
			runtime: testTimeRuntime(1_600),
			authContext: { env: async () => undefined, fileExists: async () => false },
		});
		models.setProvider(opencodeGoProvider());
		const terminal = new VirtualTerminal({ columns: 100, rows: 30 });
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		const save = vi.fn(async (_settings: unknown) => undefined);
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			settings: { load: async () => ({}), save },
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			terminalFactory: { create: () => terminal },
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
				clock: { now: () => 1_600 },
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
				scheduler: createSystemScheduler(),
			},
		});

		const running = application.run(["--interactive", "--no-session"]);
		await until(() => terminal.readOutput().includes("Enter OpenCode API key"));
		await terminal.emit({ type: "paste", text: "opencode-secret" });
		expect(terminal.readOutput()).not.toContain("opencode-secret");
		await terminal.emit(key("enter"));
		terminal.clearOutput();
		await until(() => terminal.readOutput().includes("Select a Model"));
		await terminal.emit(key("enter"));
		terminal.clearOutput();
		await until(() => terminal.readOutput().includes("opencode-go/"));
		await terminal.emit(key("c", true));
		await terminal.emit(key("c", true));

		await expect(running).resolves.toBe(0);
		expect(save).toHaveBeenCalledTimes(1);
		expect(save.mock.calls[0]?.[0]).toMatchObject({
			defaultModel: { provider: "opencode-go" },
		});
		expect(stderr.value).toBe("");
	});

	it("asks before binding root AGENTS.md trust to its exact hash", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-project-trust-"));
		temporaryDirectories.push(workspace);
		const canonicalWorkspace = await realpath(workspace);
		await writeFile(join(workspace, "AGENTS.md"), "# Local instructions\n", "utf8");
		const faux = fauxProvider({ runtime: testTimeRuntime(1_700) });
		const models = createModels({ runtime: testTimeRuntime(1_700) });
		models.setProvider(faux.provider);
		const terminal = new VirtualTerminal({ columns: 100, rows: 30 });
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		const save = vi.fn(async (_settings: unknown) => undefined);
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			settings: {
				load: async () => ({ defaultModel: { provider: "faux", id: "faux-1" } }),
				save,
			},
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			terminalFactory: { create: () => terminal },
			io: {
				stdin: { isTTY: true, readAll: async () => "" },
				stdout,
				stderr,
			},
			runtime: {
				cwd: workspace,
				homeDirectory: "/home/test",
				platform: "darwin",
				environment: {},
				clock: { now: () => 1_700 },
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
				scheduler: createSystemScheduler(),
			},
		});

		const running = application.run(["--interactive", "--no-session"]);
		await until(() => terminal.readOutput().includes("Trust this project instruction file?"));
		await terminal.emit(key("down"));
		await terminal.emit(key("enter"));
		terminal.clearOutput();
		await until(() => terminal.readOutput().includes("faux/faux-1"));
		await terminal.emit(key("c", true));
		await terminal.emit(key("c", true));

		await expect(running).resolves.toBe(0);
		expect(save).toHaveBeenCalledTimes(1);
		expect(save.mock.calls[0]?.[0]).toMatchObject({
			projectTrust: [
				{
					workspace: canonicalWorkspace,
					path: join(canonicalWorkspace, "AGENTS.md"),
					sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
				},
			],
		});
		expect(stderr.value).toBe("");
	});
});
