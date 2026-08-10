import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@coda/ai";
import { createSystemScheduler, VirtualTerminal } from "@coda/tui";
import { describe, expect, it } from "vitest";
import { type ApplicationOutput, createCodingAgentApplication } from "../src/application.ts";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import { createNodeProcessRunner } from "../src/host/node-process-runner.ts";
import type { ProcessRunner, ProcessRunRequest } from "../src/host/process-runner.ts";
import { FullScreenOutputGate } from "../src/interactive/full-screen-output.ts";
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
	onSuspend?: () => void | Promise<void>;
	suspendCalls = 0;

	subscribe(handlers: InteractiveLifecycleHandlers): () => void {
		this.handlers = handlers;
		return () => {
			this.handlers = undefined;
		};
	}

	async suspend(): Promise<void> {
		this.suspendCalls++;
		await this.onSuspend?.();
	}

	terminate(signal: InteractiveTerminationSignal): void {
		this.handlers?.terminate(signal);
	}

	requestSuspend(): void {
		this.handlers?.suspend();
	}
}

class TrackingTerminal extends VirtualTerminal {
	startCalls = 0;
	stopCalls = 0;

	override async start(): Promise<boolean> {
		this.startCalls++;
		return super.start();
	}

	override async stop(): Promise<void> {
		this.stopCalls++;
		await super.stop();
	}
}

class UnavailableTerminal extends TrackingTerminal {
	override readonly available = false;
}

async function until(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	}
	throw new Error("Condition did not become true");
}

describe("interactive TUI mode", () => {
	it("lets the CLI color scheme override user settings before Terminal startup", async () => {
		const runtime = testTimeRuntime(1_050);
		const faux = fauxProvider({ runtime });
		const models = createModels({ runtime });
		models.setProvider(faux.provider);
		const terminal = new UnavailableTerminal({ columns: 80, rows: 24 });
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let startup: unknown;
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			settings: {
				load: async () => ({
					defaultModel: { provider: faux.getModel().provider, id: faux.getModel().id },
					ui: { motion: "full", colorScheme: "dark" },
				}),
				save: async () => undefined,
			},
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			terminalFactory: {
				create: (options) => {
					startup = options;
					return terminal;
				},
			},
			io: { stdin: { isTTY: true, readAll: async () => "" }, stdout, stderr },
			runtime: {
				cwd: "/tmp",
				homeDirectory: "/home/test",
				platform: "darwin",
				environment: {},
				clock: runtime.clock,
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
				scheduler: createSystemScheduler(),
			},
		});

		await expect(application.run(["--interactive", "--color-scheme", "light", "--no-session"])).resolves.toBe(1);
		expect(startup).toEqual({ noColor: false, colorScheme: "light" });
	});

	it("releases the output gate after full-screen startup is unavailable", async () => {
		const runtime = testTimeRuntime(1_100);
		const faux = fauxProvider({ runtime });
		const models = createModels({ runtime });
		models.setProvider(faux.provider);
		const terminal = new UnavailableTerminal({ columns: 80, rows: 24 });
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		const rawIo = { stdin: { isTTY: true, readAll: async () => "" }, stdout, stderr };
		const fullScreenOutput = new FullScreenOutputGate(rawIo);
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			settings: {
				load: async () => ({ defaultModel: { provider: faux.getModel().provider, id: faux.getModel().id } }),
				save: async () => undefined,
			},
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			terminalFactory: { create: () => terminal },
			io: rawIo,
			fullScreenOutput,
			runtime: {
				cwd: "/tmp",
				homeDirectory: "/home/test",
				platform: "darwin",
				environment: {},
				clock: runtime.clock,
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
				scheduler: createSystemScheduler(),
			},
		});

		await expect(application.run(["--interactive", "--no-session"])).resolves.toBe(1);
		expect(terminal.startCalls).toBe(0);
		expect(stdout.value).toBe("");
		expect(stderr.value).toContain("Interactive full-screen mode is unavailable");
	});

	it("routes application output through the TUI until full-screen exit", async () => {
		const runtime = testTimeRuntime(1_200);
		const faux = fauxProvider({ runtime });
		const models = createModels({ runtime });
		models.setProvider(faux.provider);
		const terminal = new VirtualTerminal({ columns: 100, rows: 24 });
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		const rawIo = { stdin: { isTTY: true, readAll: async () => "" }, stdout, stderr };
		const fullScreenOutput = new FullScreenOutputGate(rawIo);
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			settings: {
				load: async () => ({ defaultModel: { provider: faux.getModel().provider, id: faux.getModel().id } }),
				save: async () => undefined,
			},
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			terminalFactory: { create: () => terminal },
			io: rawIo,
			fullScreenOutput,
			runtime: {
				cwd: "/tmp",
				homeDirectory: "/home/test",
				platform: "darwin",
				environment: {},
				clock: runtime.clock,
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
				scheduler: createSystemScheduler(),
			},
		});

		const running = application.run(["--interactive", "--no-color", "--no-session"]);
		await until(() => terminal.started && terminal.readOutput().includes("Enter sends"));
		await fullScreenOutput.io.stdout.write("buffered stdout\n");
		await fullScreenOutput.io.stderr.write("buffered stderr\n");
		await fullScreenOutput.diagnostics({
			code: "terminal.unknown-input",
			message: "unknown key",
			details: { sequence: "\x1b[27;2;13~" },
		});

		expect(stdout.value).toBe("");
		expect(stderr.value).toBe("");
		await new Promise<void>((resolve) => setTimeout(resolve, 250));
		expect(terminal.readOutput()).toContain("[terminal.unknown-input]");
		expect(terminal.readOutput()).toContain('sequence="\\u001b[27;2;13~"');
		expect(terminal.readOutput()).toContain("unknown key");
		await terminal.emit({
			type: "key",
			key: "c",
			text: "c",
			shift: false,
			control: true,
			alt: false,
			meta: false,
			action: "press",
		});

		await expect(running).resolves.toBe(0);
		expect(stdout.value).toBe("buffered stdout\n");
		expect(stderr.value).toBe("buffered stderr\n");
	});

	it("runs a leading-bang command locally with live output and without invoking the Model", async () => {
		const runtime = testTimeRuntime(1_300);
		const faux = fauxProvider({ runtime });
		const models = createModels({ runtime });
		models.setProvider(faux.provider);
		const terminal = new VirtualTerminal({ columns: 80, rows: 24 });
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let request: ProcessRunRequest | undefined;
		const processRunner: ProcessRunner = {
			run: async (candidate) => {
				request = candidate;
				candidate.onOutput?.({ channel: "stdout", text: "local output\n" });
				return {
					exitCode: 0,
					signal: null,
					stdout: "",
					stderr: "",
					timedOut: false,
					truncated: false,
				};
			},
		};
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			settings: {
				load: async () => ({ defaultModel: { provider: faux.getModel().provider, id: faux.getModel().id } }),
				save: async () => undefined,
			},
			fileSystem: createNodeFileSystem(),
			processRunner,
			terminalFactory: { create: () => terminal },
			io: { stdin: { isTTY: true, readAll: async () => "" }, stdout, stderr },
			runtime: {
				cwd: "/tmp",
				homeDirectory: "/home/test",
				platform: "darwin",
				environment: { SHELL: "/bin/zsh", SECRET: "explicit-user-authority" },
				clock: runtime.clock,
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
				scheduler: createSystemScheduler(),
			},
		});

		const running = application.run(["--interactive", "--no-color", "--no-session"]);
		await until(() => terminal.started);
		await terminal.emit({ type: "text", text: "!printf hello" });
		await terminal.emit({
			type: "key",
			key: "enter",
			shift: false,
			control: false,
			alt: false,
			meta: false,
			action: "press",
		});
		await until(() => terminal.readOutput().includes("You ran printf hello"));
		expect(terminal.readOutput()).toContain("local output");
		await terminal.emit({
			type: "key",
			key: "c",
			text: "c",
			shift: false,
			control: true,
			alt: false,
			meta: false,
			action: "press",
		});

		await expect(running).resolves.toBe(0);
		expect(request).toMatchObject({
			executable: "/bin/zsh",
			args: ["-lc", "printf hello"],
			environment: { SHELL: "/bin/zsh", SECRET: "explicit-user-authority" },
		});
		expect(request?.cwd).toMatch(/\/tmp$/);
		expect(stdout.value).toBe("");
		expect(stderr.value).toBe("");
	});

	it("accepts terminal text, renders Agent output, and exits cleanly on idle Ctrl-C", async () => {
		const faux = fauxProvider({ runtime: testTimeRuntime(1_400) });
		faux.setResponses([fauxAssistantMessage("interactive answer", { timestamp: 1_400 })]);
		const models = createModels({ runtime: testTimeRuntime(1_400) });
		models.setProvider(faux.provider);
		const terminal = new VirtualTerminal({ columns: 80, rows: 24 });
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			settings: {
				load: async () => ({ defaultModel: { provider: faux.getModel().provider, id: faux.getModel().id } }),
				save: async () => undefined,
			},
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			terminalFactory: {
				create: (startup) => {
					expect(startup.noColor).toBe(true);
					return terminal;
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
				clock: { now: () => 1_400 },
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
				scheduler: createSystemScheduler(),
			},
		});

		const running = application.run(["--interactive", "--no-color", "--no-session"]);
		await until(() => terminal.started);
		await terminal.emit({ type: "text", text: "hello" });
		await terminal.emit({
			type: "key",
			key: "enter",
			shift: false,
			control: false,
			alt: false,
			meta: false,
			action: "press",
		});
		await until(() => terminal.readOutput().includes("interactive answer"));
		await terminal.emit({
			type: "key",
			key: "c",
			text: "c",
			shift: false,
			control: true,
			alt: false,
			meta: false,
			action: "press",
		});

		await expect(running).resolves.toBe(0);
		expect(terminal.started).toBe(false);
		expect(stdout.value).toBe("interactive answer\n");
		expect(stderr.value).toBe("");
	});

	it("freezes a newly built System Prompt snapshot for each submitted Run", async () => {
		let now = 2_000;
		const prompts: Array<string | undefined> = [];
		const runtime = testTimeRuntime({ now: () => now });
		const faux = fauxProvider({ runtime });
		faux.setResponses([
			(context) => {
				prompts.push(context.systemPrompt);
				return fauxAssistantMessage("first answer", { timestamp: now });
			},
			(context) => {
				prompts.push(context.systemPrompt);
				return fauxAssistantMessage("second answer", { timestamp: now });
			},
		]);
		const models = createModels({ runtime });
		models.setProvider(faux.provider);
		const terminal = new VirtualTerminal({ columns: 80, rows: 24 });
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			settings: {
				load: async () => ({ defaultModel: { provider: faux.getModel().provider, id: faux.getModel().id } }),
				save: async () => undefined,
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
				cwd: "/tmp",
				homeDirectory: "/home/test",
				platform: "darwin",
				environment: {},
				clock: { now: () => now },
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
				scheduler: createSystemScheduler(),
			},
		});

		const running = application.run(["--interactive", "--no-session"]);
		await until(() => terminal.started);
		await terminal.emit({ type: "text", text: "first" });
		await terminal.emit({
			type: "key",
			key: "enter",
			shift: false,
			control: false,
			alt: false,
			meta: false,
			action: "press",
		});
		await until(() => terminal.readOutput().includes("first answer"));
		now = 3_000;
		await terminal.emit({ type: "text", text: "second" });
		await terminal.emit({
			type: "key",
			key: "enter",
			shift: false,
			control: false,
			alt: false,
			meta: false,
			action: "press",
		});
		await until(() => terminal.readOutput().includes("second answer"));
		await terminal.emit({
			type: "key",
			key: "c",
			text: "c",
			shift: false,
			control: true,
			alt: false,
			meta: false,
			action: "press",
		});
		await expect(running).resolves.toBe(0);

		expect(prompts[0]).toContain("1970-01-01T00:00:02.000Z");
		expect(prompts[1]).toContain("1970-01-01T00:00:03.000Z");
		expect(prompts[0]).not.toBe(prompts[1]);
	});

	it("applies /permissions only to the active process and updates the visible profile", async () => {
		const runtime = testTimeRuntime(3_500);
		const faux = fauxProvider({ runtime });
		const models = createModels({ runtime });
		models.setProvider(faux.provider);
		const terminal = new VirtualTerminal({ columns: 140, rows: 24 });
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let saves = 0;
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			settings: {
				load: async () => ({ defaultModel: { provider: faux.getModel().provider, id: faux.getModel().id } }),
				save: async () => {
					saves++;
				},
			},
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			terminalFactory: { create: () => terminal },
			io: { stdin: { isTTY: true, readAll: async () => "" }, stdout, stderr },
			runtime: {
				cwd: "/tmp",
				homeDirectory: "/home/test",
				platform: "darwin",
				environment: {},
				clock: runtime.clock,
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
				scheduler: createSystemScheduler(),
			},
		});

		const running = application.run(["--interactive", "--no-color", "--no-session"]);
		await until(() => terminal.started && terminal.readOutput().includes("Read Only / on-request"));
		terminal.clearOutput();
		await terminal.emit({ type: "text", text: "/permissions" });
		await terminal.emit({
			type: "key",
			key: "enter",
			shift: false,
			control: false,
			alt: false,
			meta: false,
			action: "press",
		});
		await until(() => terminal.readOutput().includes("Select Permission Profile"));
		await terminal.emit({
			type: "key",
			key: "2",
			text: "2",
			shift: false,
			control: false,
			alt: false,
			meta: false,
			action: "press",
		});
		await until(() => terminal.readOutput().includes("Workspace / on-request"));
		await terminal.emit({
			type: "key",
			key: "c",
			text: "c",
			shift: false,
			control: true,
			alt: false,
			meta: false,
			action: "press",
		});

		await expect(running).resolves.toBe(0);
		expect(saves).toBe(0);
		expect(stdout.value).toBe("");
		expect(stderr.value).toBe("");
	});

	it("restores the terminal for SIGTERM and returns the conventional signal exit status", async () => {
		const runtime = testTimeRuntime(4_000);
		const faux = fauxProvider({ runtime });
		const models = createModels({ runtime });
		models.setProvider(faux.provider);
		const terminal = new TrackingTerminal({ columns: 80, rows: 24 });
		const lifecycle = new FakeLifecycle();
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			settings: {
				load: async () => ({ defaultModel: { provider: faux.getModel().provider, id: faux.getModel().id } }),
				save: async () => undefined,
			},
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			terminalFactory: { create: () => terminal },
			io: { stdin: { isTTY: true, readAll: async () => "" }, stdout, stderr },
			runtime: {
				cwd: "/tmp",
				homeDirectory: "/home/test",
				platform: "darwin",
				environment: {},
				clock: runtime.clock,
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
				scheduler: createSystemScheduler(),
				interactiveLifecycle: lifecycle,
			},
		});

		const running = application.run(["--interactive", "--no-session"]);
		await until(() => terminal.started && lifecycle.handlers !== undefined);
		lifecycle.terminate("SIGTERM");

		await expect(running).resolves.toBe(143);
		expect(terminal.started).toBe(false);
		expect(terminal.stopCalls).toBe(1);
		expect(lifecycle.handlers).toBeUndefined();
		expect(stderr.value).toBe("");
	});

	it("resolves a pending Approval Request as abort when the process terminates", async () => {
		const runtime = testTimeRuntime(4_050);
		const faux = fauxProvider({ runtime });
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("bash", { command: "printf ready > /tmp/coda-approval-termination" }, { id: "approval" }),
				{ stopReason: "toolUse", timestamp: 4_050 },
			),
		]);
		const models = createModels({ runtime });
		models.setProvider(faux.provider);
		const terminal = new TrackingTerminal({ columns: 80, rows: 24 });
		const lifecycle = new FakeLifecycle();
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			settings: {
				load: async () => ({
					defaultModel: { provider: faux.getModel().provider, id: faux.getModel().id },
					permissions: { profile: "workspace", approvalPolicy: "on-request" },
				}),
				save: async () => undefined,
			},
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			terminalFactory: { create: () => terminal },
			io: {
				stdin: { isTTY: true, readAll: async () => "" },
				stdout: new BufferOutput(),
				stderr: new BufferOutput(),
			},
			runtime: {
				cwd: "/tmp",
				homeDirectory: "/home/test",
				platform: "darwin",
				environment: {},
				clock: runtime.clock,
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
				scheduler: createSystemScheduler(),
				interactiveLifecycle: lifecycle,
			},
		});

		const running = application.run(["--interactive", "--no-session", "trigger approval"]);
		await until(() => terminal.readOutput().includes("Would you like to run the following command?"));
		terminal.clearOutput();
		await terminal.emit({
			type: "key",
			key: "down",
			shift: false,
			control: false,
			alt: false,
			meta: false,
			action: "press",
		});
		await until(() => terminal.readOutput().includes("› 2. No, and tell Coda what to do differently"));
		lifecycle.terminate("SIGTERM");
		const outcome = await Promise.race([
			running.then((code) => ({ code })),
			new Promise<{ readonly timeout: true }>((resolve) => setTimeout(() => resolve({ timeout: true }), 500)),
		]);
		if ("timeout" in outcome) {
			await terminal.emit({
				type: "key",
				key: "c",
				text: "c",
				shift: false,
				control: true,
				alt: false,
				meta: false,
				action: "press",
			});
			await running;
		}

		expect(outcome).toEqual({ code: 143 });
		expect(terminal.started).toBe(false);
	});

	it("leaves full-screen while suspended and re-enters it on resume", async () => {
		const runtime = testTimeRuntime(4_100);
		const faux = fauxProvider({ runtime });
		const models = createModels({ runtime });
		models.setProvider(faux.provider);
		const terminal = new TrackingTerminal({ columns: 80, rows: 24 });
		const lifecycle = new FakeLifecycle();
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		const rawIo = { stdin: { isTTY: true, readAll: async () => "" }, stdout, stderr };
		const fullScreenOutput = new FullScreenOutputGate(rawIo);
		lifecycle.onSuspend = () => fullScreenOutput.io.stderr.write("suspended\n");
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			settings: {
				load: async () => ({ defaultModel: { provider: faux.getModel().provider, id: faux.getModel().id } }),
				save: async () => undefined,
			},
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			terminalFactory: { create: () => terminal },
			io: rawIo,
			fullScreenOutput,
			runtime: {
				cwd: "/tmp",
				homeDirectory: "/home/test",
				platform: "darwin",
				environment: {},
				clock: runtime.clock,
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
				scheduler: createSystemScheduler(),
				interactiveLifecycle: lifecycle,
			},
		});

		const running = application.run(["--interactive", "--no-session"]);
		await until(() => terminal.started && lifecycle.handlers !== undefined);
		lifecycle.requestSuspend();
		await until(() => lifecycle.suspendCalls === 1 && terminal.startCalls === 2 && terminal.started);
		expect(stderr.value).toBe("suspended\n");
		await fullScreenOutput.io.stderr.write("resumed\n");
		expect(stderr.value).toBe("suspended\n");
		await terminal.emit({
			type: "key",
			key: "c",
			text: "c",
			shift: false,
			control: true,
			alt: false,
			meta: false,
			action: "press",
		});

		await expect(running).resolves.toBe(0);
		expect(terminal.stopCalls).toBe(2);
		expect(stdout.value).toBe("");
		expect(stderr.value).toBe("suspended\nresumed\n");
	});
});
