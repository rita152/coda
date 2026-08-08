import { createModels, fauxAssistantMessage, fauxProvider } from "@coda/ai";
import { createSystemScheduler, VirtualTerminal } from "@coda/tui";
import { describe, expect, it } from "vitest";
import { type ApplicationOutput, createCodingAgentApplication } from "../src/application.ts";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import { createNodeProcessRunner } from "../src/host/node-process-runner.ts";
import { testTimeRuntime } from "./time-runtime.ts";

class BufferOutput implements ApplicationOutput {
	readonly isTTY = true;
	value = "";

	write(chunk: string): void {
		this.value += chunk;
	}
}

async function until(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error("Condition did not become true");
}

describe("interactive TUI mode", () => {
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
});
