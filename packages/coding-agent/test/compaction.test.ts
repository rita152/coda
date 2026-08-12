import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@coda/ai";
import { createSystemScheduler, type KeyInput, VirtualTerminal } from "@coda/tui";
import { afterEach, describe, expect, it } from "vitest";
import { type ApplicationOutput, createCodingAgentApplication } from "../src/application.ts";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import { createNodeProcessRunner } from "../src/host/node-process-runner.ts";
import { FileSessionManager } from "../src/session/file-session-manager.ts";
import { testTimeRuntime } from "./time-runtime.ts";

class BufferOutput implements ApplicationOutput {
	readonly isTTY = true;
	value = "";

	write(chunk: string): void {
		this.value += chunk;
	}
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Context Window Compaction", () => {
	it("lets the user compact through /compact and continues from the replacement Context Window", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-manual-compaction-"));
		temporaryDirectories.push(workspace);
		const oldToolResult = `old-tool-result:${"x".repeat(100_000)}`;
		await writeFile(join(workspace, "large.txt"), oldToolResult, "utf8");

		const runtime = testTimeRuntime(5_000);
		const faux = fauxProvider({
			runtime,
			models: [{ id: "compactable", contextWindow: 128_000, maxTokens: 16_384 }],
		});
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "large.txt" }, { id: "provider:read-large" }), {
				stopReason: "toolUse",
				timestamp: 5_000,
			}),
			fauxAssistantMessage("large file inspected", { timestamp: 5_000 }),
			fauxAssistantMessage(
				[
					"## Objective",
					"- Continue the file inspection task.",
					"## Constraints",
					"- Preserve the deployment decision.",
					"## Decisions",
					"- The large file was inspected.",
					"## Completed",
					"- Read large.txt.",
					"## Current State",
					"- Ready to continue.",
					"## Next Steps",
					"- Answer the next request.",
					"## Relevant Files and Commands",
					"- large.txt",
					"## Errors and Open Questions",
					"- None.",
				].join("\n"),
				{ timestamp: 5_000 },
			),
			(context) => {
				const serialized = JSON.stringify(context.messages);
				expect(serialized).toContain("<conversation-checkpoint");
				expect(serialized).toContain("Preserve the deployment decision");
				expect(serialized).not.toContain("old-tool-result:");
				return fauxAssistantMessage("continued after compaction", { timestamp: 5_000 });
			},
		]);
		const models = createModels({ runtime });
		models.setProvider(faux.provider);
		const terminal = new VirtualTerminal({ columns: 100, rows: 28 });
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			settings: {
				load: async () => ({
					defaultModel: { provider: faux.getModel().provider, id: faux.getModel().id },
				}),
				save: async () => undefined,
			},
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			terminalFactory: { create: () => terminal },
			io: { stdin: { isTTY: true, readAll: async () => "" }, stdout, stderr },
			runtime: {
				cwd: workspace,
				homeDirectory: workspace,
				platform: "darwin",
				environment: {},
				clock: runtime.clock,
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
				scheduler: createSystemScheduler(),
			},
		});

		const running = application.run(["--interactive", "--no-color", "--no-session", "inspect the large file"]);
		await until(() => terminal.readOutput().includes("large file inspected"));

		await submit(terminal, "/compact preserve the deployment decision");
		await until(() => terminal.readOutput().includes("Context compacted"));
		expect(faux.state.callCount).toBe(3);

		await submit(terminal, "continue");
		await until(() => terminal.readOutput().includes("continued after compaction"));
		await terminal.emit(key("c", { control: true, text: "c" }));
		await terminal.emit(key("c", { control: true, text: "c" }));

		await expect(running).resolves.toBe(0);
		expect(stderr.value).toBe("");
	});

	it("auto-compacts a large Tool result before the next model call", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-auto-compaction-"));
		temporaryDirectories.push(workspace);
		const oldToolResult = `auto-old-tool-result:${"x".repeat(100_000)}`;
		await writeFile(join(workspace, "large.txt"), oldToolResult, "utf8");

		const runtime = testTimeRuntime(6_000);
		const faux = fauxProvider({
			runtime,
			models: [{ id: "auto-compactable", contextWindow: 48_000, maxTokens: 12_000 }],
		});
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "large.txt" }, { id: "provider:auto-read" }), {
				stopReason: "toolUse",
				timestamp: 6_000,
			}),
			fauxAssistantMessage(validSummary("Auto-Compaction preserved the inspection state."), {
				timestamp: 6_000,
			}),
			(context) => {
				const serialized = JSON.stringify(context.messages);
				expect(serialized).toContain("<conversation-checkpoint");
				expect(serialized).toContain("Auto-Compaction preserved the inspection state");
				expect(serialized).not.toContain("auto-old-tool-result:");
				return fauxAssistantMessage("continued after automatic compaction", { timestamp: 6_000 });
			},
		]);
		const models = createModels({ runtime });
		models.setProvider(faux.provider);
		const terminal = new VirtualTerminal({ columns: 100, rows: 28 });
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			settings: {
				load: async () => ({
					defaultModel: { provider: faux.getModel().provider, id: faux.getModel().id },
				}),
				save: async () => undefined,
			},
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			terminalFactory: { create: () => terminal },
			io: { stdin: { isTTY: true, readAll: async () => "" }, stdout, stderr },
			runtime: {
				cwd: workspace,
				homeDirectory: workspace,
				platform: "darwin",
				environment: {},
				clock: runtime.clock,
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
				scheduler: createSystemScheduler(),
			},
		});

		const running = application.run(["--interactive", "--no-color", "--no-session", "inspect the large file"]);
		await until(() => terminal.readOutput().includes("continued after automatic compaction"));
		expect(faux.state.callCount).toBe(3);
		await terminal.emit(key("c", { control: true, text: "c" }));
		await terminal.emit(key("c", { control: true, text: "c" }));

		await expect(running).resolves.toBe(0);
		expect(stderr.value).toBe("");
	});

	it("resumes from the durable checkpoint while retaining the full Session transcript", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-resumed-compaction-"));
		temporaryDirectories.push(workspace);
		const canonicalWorkspace = await realpath(workspace);
		const oldToolResult = `resumed-old-tool-result:${"x".repeat(100_000)}`;
		await writeFile(join(canonicalWorkspace, "large.txt"), oldToolResult, "utf8");

		const runtime = testTimeRuntime(7_000);
		const faux = fauxProvider({
			runtime,
			models: [{ id: "resumable-compactable", contextWindow: 128_000, maxTokens: 16_384 }],
		});
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "large.txt" }, { id: "provider:resume-read" }), {
				stopReason: "toolUse",
				timestamp: 7_000,
			}),
			fauxAssistantMessage("ready to compact durably", { timestamp: 7_000 }),
			fauxAssistantMessage(validSummary("The durable checkpoint decision was retained."), {
				timestamp: 7_000,
			}),
		]);
		const models = createModels({ runtime });
		models.setProvider(faux.provider);
		const terminal = new VirtualTerminal({ columns: 100, rows: 28 });
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let id = 0;
		const idGenerator = { generate: (kind: string) => `${kind}:${++id}` };
		const sessions = new FileSessionManager({
			fileSystem: createNodeFileSystem(),
			homeDirectory: canonicalWorkspace,
			clock: runtime.clock,
			idGenerator,
			owner: { token: "compaction-test", pid: 123, processStartedAt: 1, hostname: "test" },
			processInspector: { status: async () => "alive" },
		});
		const application = createCodingAgentApplication({
			models,
			sessions,
			settings: {
				load: async () => ({
					defaultModel: { provider: faux.getModel().provider, id: faux.getModel().id },
				}),
				save: async () => undefined,
			},
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			terminalFactory: { create: () => terminal },
			io: { stdin: { isTTY: true, readAll: async () => "" }, stdout, stderr },
			runtime: {
				cwd: canonicalWorkspace,
				homeDirectory: canonicalWorkspace,
				platform: "darwin",
				environment: {},
				clock: runtime.clock,
				idGenerator,
				scheduler: createSystemScheduler(),
			},
		});

		const firstRun = application.run(["--interactive", "--no-color", "--session", "inspect the large file"]);
		await until(() => terminal.readOutput().includes("ready to compact durably"));
		await submit(terminal, "/compact retain the durable decision");
		await until(() => terminal.readOutput().includes("Context compacted"));
		await terminal.emit(key("c", { control: true, text: "c" }));
		await terminal.emit(key("c", { control: true, text: "c" }));
		await expect(firstRun).resolves.toBe(0);

		const workspaceId = createHash("sha256").update(canonicalWorkspace).digest("hex").slice(0, 32);
		const [descriptor] = await sessions.list({ id: workspaceId, path: canonicalWorkspace });
		expect(descriptor).toBeDefined();
		const journal = await readFile(descriptor!.path!, "utf8");
		expect(JSON.parse(journal.split("\n")[0]!)).toMatchObject({ version: 9 });
		expect(journal).toContain('"type":"context_compacted"');
		expect(journal).toContain("resumed-old-tool-result:");

		faux.setResponses([
			(context) => {
				const serialized = JSON.stringify(context.messages);
				expect(serialized).toContain("<conversation-checkpoint");
				expect(serialized).toContain("durable checkpoint decision was retained");
				expect(serialized).not.toContain("resumed-old-tool-result:");
				return fauxAssistantMessage("continued from durable checkpoint", { timestamp: 7_000 });
			},
		]);
		await expect(application.run(["--print", "--resume", descriptor!.id, "continue"])).resolves.toBe(0);
		expect(stdout.value).toContain("continued from durable checkpoint");
		expect(stderr.value).toBe("");
	});

	it("compacts and retries exactly once when the Provider reports Context Overflow", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-overflow-recovery-"));
		temporaryDirectories.push(workspace);
		const oldToolResult = `overflow-old-tool-result:${"x".repeat(100_000)}`;
		await writeFile(join(workspace, "large.txt"), oldToolResult, "utf8");

		const runtime = testTimeRuntime(8_000);
		const faux = fauxProvider({
			runtime,
			models: [{ id: "overflow-compactable", contextWindow: 128_000, maxTokens: 16_384 }],
		});
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "large.txt" }, { id: "provider:overflow-read" }), {
				stopReason: "toolUse",
				timestamp: 8_000,
			}),
			fauxAssistantMessage("large context is ready", { timestamp: 8_000 }),
			fauxAssistantMessage([], {
				stopReason: "error",
				errorMessage: "maximum context window exceeded",
				timestamp: 8_000,
			}),
			fauxAssistantMessage(validSummary("Provider overflow triggered the shared compactor."), {
				timestamp: 8_000,
			}),
			(context) => {
				const serialized = JSON.stringify(context.messages);
				expect(serialized).toContain("<conversation-checkpoint");
				expect(serialized).not.toContain("overflow-old-tool-result:");
				return fauxAssistantMessage("recovered after provider overflow", { timestamp: 8_000 });
			},
		]);
		const models = createModels({ runtime });
		models.setProvider(faux.provider);
		const terminal = new VirtualTerminal({ columns: 100, rows: 28 });
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			settings: {
				load: async () => ({
					defaultModel: { provider: faux.getModel().provider, id: faux.getModel().id },
				}),
				save: async () => undefined,
			},
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			terminalFactory: { create: () => terminal },
			io: { stdin: { isTTY: true, readAll: async () => "" }, stdout, stderr },
			runtime: {
				cwd: workspace,
				homeDirectory: workspace,
				platform: "darwin",
				environment: {},
				clock: runtime.clock,
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
				scheduler: createSystemScheduler(),
			},
		});

		const running = application.run(["--interactive", "--no-color", "--no-session", "inspect the large file"]);
		await until(() => terminal.readOutput().includes("large context is ready"));
		await submit(terminal, "continue despite provider estimate");
		await until(
			() => terminal.readOutput().includes("recovered after provider overflow"),
			() => `calls=${faux.state.callCount}\n${terminal.readOutput()}`,
		);
		expect(faux.state.callCount).toBe(5);
		await terminal.emit(key("c", { control: true, text: "c" }));
		await terminal.emit(key("c", { control: true, text: "c" }));

		await expect(running).resolves.toBe(0);
		expect(stderr.value).toBe("");
	});

	it("queues /compact during an active Run and commits it at the next safe point", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-queued-manual-compaction-"));
		temporaryDirectories.push(workspace);
		const runtime = testTimeRuntime(9_000);
		const faux = fauxProvider({
			runtime,
			models: [{ id: "queued-compactable", contextWindow: 128_000, maxTokens: 16_384 }],
		});
		let releaseFirst!: () => void;
		const firstReleased = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let firstCallStarted!: () => void;
		const firstStarted = new Promise<void>((resolve) => {
			firstCallStarted = resolve;
		});
		faux.setResponses([
			async () => {
				firstCallStarted();
				await firstReleased;
				return fauxAssistantMessage("first run finished", { timestamp: 9_000 });
			},
			fauxAssistantMessage(validSummary("Queued manual compaction ran only after the active call."), {
				timestamp: 9_000,
			}),
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("<conversation-checkpoint");
				return fauxAssistantMessage("continued after queued compaction", { timestamp: 9_000 });
			},
		]);
		const models = createModels({ runtime });
		models.setProvider(faux.provider);
		const terminal = new VirtualTerminal({ columns: 100, rows: 28 });
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			settings: {
				load: async () => ({
					defaultModel: { provider: faux.getModel().provider, id: faux.getModel().id },
				}),
				save: async () => undefined,
			},
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			terminalFactory: { create: () => terminal },
			io: { stdin: { isTTY: true, readAll: async () => "" }, stdout, stderr },
			runtime: {
				cwd: workspace,
				homeDirectory: workspace,
				platform: "darwin",
				environment: {},
				clock: runtime.clock,
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
				scheduler: createSystemScheduler(),
			},
		});

		const running = application.run(["--interactive", "--no-color", "--no-session", "start work"]);
		await firstStarted;
		await submit(terminal, "/compact retain the active work");
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
		expect(faux.state.callCount).toBe(1);
		expect(terminal.readOutput()).not.toContain("Context compacted");

		releaseFirst();
		await until(() => terminal.readOutput().includes("Context compacted"));
		expect(faux.state.callCount).toBe(2);
		await submit(terminal, "continue");
		await until(() => terminal.readOutput().includes("continued after queued compaction"));
		await terminal.emit(key("c", { control: true, text: "c" }));
		await terminal.emit(key("c", { control: true, text: "c" }));

		await expect(running).resolves.toBe(0);
		expect(stderr.value).toBe("");
	});
});

function validSummary(decision: string): string {
	return [
		"## Objective",
		"- Continue the task.",
		"## Constraints",
		"- Preserve user intent.",
		"## Decisions",
		`- ${decision}`,
		"## Completed",
		"- Prior work completed.",
		"## Current State",
		"- Ready to continue.",
		"## Next Steps",
		"- Continue.",
		"## Relevant Files and Commands",
		"- large.txt",
		"## Errors and Open Questions",
		"- None.",
	].join("\n");
}

async function submit(terminal: VirtualTerminal, text: string): Promise<void> {
	await terminal.emit({ type: "text", text });
	await terminal.emit(key("enter"));
}

async function until(predicate: () => boolean, diagnostics?: () => string): Promise<void> {
	for (let attempt = 0; attempt < 300; attempt++) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 2));
	}
	throw new Error(`Condition did not become true${diagnostics ? `\n${diagnostics()}` : ""}`);
}

function key(keyName: KeyInput["key"], overrides: Partial<KeyInput> = {}): KeyInput {
	return {
		type: "key",
		key: keyName,
		shift: false,
		control: false,
		alt: false,
		meta: false,
		action: "press",
		...overrides,
	};
}
