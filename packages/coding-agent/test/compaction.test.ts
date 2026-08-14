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
		await expect(exitWhenIdle(terminal, running)).resolves.toBe(0);
		expect(stderr.value).toBe("");
	});

	it("resumes from an automatically persisted checkpoint while retaining the full Session transcript", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-resumed-compaction-"));
		temporaryDirectories.push(workspace);
		const canonicalWorkspace = await realpath(workspace);
		const oldToolResult = `resumed-old-tool-result:${"x".repeat(100_000)}`;
		await writeFile(join(canonicalWorkspace, "large.txt"), oldToolResult, "utf8");

		const runtime = testTimeRuntime(7_000);
		const faux = fauxProvider({
			runtime,
			models: [{ id: "resumable-compactable", contextWindow: 48_000, maxTokens: 12_000 }],
		});
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "large.txt" }, { id: "provider:resume-read" }), {
				stopReason: "toolUse",
				timestamp: 7_000,
			}),
			fauxAssistantMessage(validSummary("The durable checkpoint decision was retained."), {
				timestamp: 7_000,
			}),
			fauxAssistantMessage("ready after automatic durable compaction", { timestamp: 7_000 }),
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
		await until(() => terminal.readOutput().includes("ready after automatic durable compaction"));
		await expect(exitWhenIdle(terminal, firstRun)).resolves.toBe(0);

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
		const resumedExitCode = await application.run(["--print", "--resume", descriptor!.id, "continue"]);
		expect(stderr.value).toBe("");
		expect(resumedExitCode).toBe(0);
		expect(stdout.value).toContain("continued from durable checkpoint");
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
		await expect(exitWhenIdle(terminal, running)).resolves.toBe(0);
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

async function exitWhenIdle(terminal: VirtualTerminal, running: Promise<number>): Promise<number> {
	const pending = Symbol("pending");
	for (let attempt = 0; attempt < 300; attempt++) {
		if (!terminal.started) return running;
		await terminal.emit(key("d", { control: true, text: "d" }));
		const result = await Promise.race([
			running,
			new Promise<typeof pending>((resolve) => setTimeout(() => resolve(pending), 10)),
		]);
		if (result !== pending) return result;
	}
	throw new Error("Interactive Session did not become idle enough to exit");
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
