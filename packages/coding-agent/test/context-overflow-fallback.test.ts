import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IdGenerator, IdKind } from "@coda/agent";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@coda/ai";
import { createSystemScheduler, type KeyInput, stripAnsi, VirtualTerminal } from "@coda/tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ApplicationOutput, createCodingAgentApplication } from "../src/application.ts";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import { createNodeProcessRunner } from "../src/host/node-process-runner.ts";
import type { ModelProcessSessionRunner } from "../src/permissions/model-process-runner.ts";
import { FileSessionManager } from "../src/session/file-session-manager.ts";
import type { SessionWorkspace } from "../src/session/types.ts";
import { testTimeRuntime } from "./time-runtime.ts";

class BufferOutput implements ApplicationOutput {
	readonly isTTY: boolean;
	value = "";

	constructor(isTTY = true) {
		this.isTTY = isTTY;
	}

	write(chunk: string): void {
		this.value += chunk;
	}
}

interface OverflowFixture {
	readonly application: ReturnType<typeof createCodingAgentApplication>;
	readonly faux: ReturnType<typeof fauxProvider>;
	readonly idGenerator: IdGenerator;
	readonly sessions: FileSessionManager;
	readonly stderr: BufferOutput;
	readonly stdout: BufferOutput;
	readonly terminal: VirtualTerminal;
	readonly workspace: SessionWorkspace;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Context Overflow empty-Session fallback", () => {
	it("offers exactly cancel or a new Session after local overflow and cancel preserves the journal", async () => {
		const fixture = await createFixture({ contextWindow: 128, maxTokens: 32 });
		fixture.faux.setResponses([fauxAssistantMessage("must not run", { timestamp: 10_000 })]);

		const running = fixture.application.run(["--interactive", "--no-color", "--session", "x".repeat(4_000)]);
		await until(() => stripAnsi(fixture.terminal.readOutput()).includes("Open a new empty Session"));

		const frame = stripAnsi(fixture.terminal.readOutput());
		expect(frame).toContain("Context Overflow");
		expect(frame).toContain("Cancel");
		expect(frame).toContain("Open a new empty Session");
		expect(fixture.faux.state.callCount).toBe(0);
		const [oldDescriptor] = await fixture.sessions.list(fixture.workspace);
		expect(oldDescriptor).toBeDefined();
		const journalBeforeCancel = await readFile(oldDescriptor!.path!, "utf8");

		await fixture.terminal.emit(key("enter"));
		await exit(fixture.terminal);
		await expect(running).resolves.toBe(0);

		const descriptors = await fixture.sessions.list(fixture.workspace);
		expect(descriptors.map(({ id }) => id)).toEqual([oldDescriptor!.id]);
		expect(await readFile(oldDescriptor!.path!, "utf8")).toBe(journalBeforeCancel);
		expect(fixture.stderr.value).toContain("Context Overflow");
	});

	it("closes Provider-overflow state and opens a fresh empty Session in the same Workspace", async () => {
		const fixture = await createFixture({ contextWindow: 128_000, maxTokens: 16_384 });
		fixture.faux.setResponses([
			fauxAssistantMessage([], {
				stopReason: "error",
				errorMessage: "maximum context window exceeded",
				timestamp: 10_000,
			}),
			fauxAssistantMessage("fresh Session answer", { timestamp: 10_001 }),
		]);

		const running = fixture.application.run(["--interactive", "--no-color", "--session", "overflowing request"]);
		await until(() => stripAnsi(fixture.terminal.readOutput()).includes("Open a new empty Session"));
		const [oldDescriptor] = await fixture.sessions.list(fixture.workspace);
		expect(oldDescriptor).toBeDefined();
		const oldJournal = await readFile(oldDescriptor!.path!, "utf8");

		await fixture.terminal.emit(key("down"));
		await fixture.terminal.emit(key("enter"));
		await until(() => fileMissing(`${oldDescriptor!.path!}.lock`));
		await submit(fixture.terminal, "fresh request");
		await until(() => fixture.terminal.readOutput().includes("fresh Session answer"));
		let replacementId: string | undefined;
		await until(async () => {
			const candidate = (await fixture.sessions.list(fixture.workspace)).find(({ id }) => id !== oldDescriptor!.id);
			if (!candidate?.path) return false;
			replacementId = candidate.id;
			return (await readFile(candidate.path, "utf8")).includes('"type":"run_finished"');
		});
		await exit(fixture.terminal);
		await expect(running).resolves.toBe(0);

		const descriptors = await fixture.sessions.list(fixture.workspace);
		expect(descriptors).toHaveLength(2);
		const replacement = descriptors.find(({ id }) => id === replacementId);
		expect(replacement).toBeDefined();
		expect(replacement).toMatchObject({
			workspace: fixture.workspace,
			persistent: true,
		});
		expect(await readFile(oldDescriptor!.path!, "utf8")).toBe(oldJournal);
		const replacementJournal = await readFile(replacement!.path!, "utf8");
		expect(replacementJournal).not.toContain("overflowing request");
		expect(replacementJournal).not.toContain("conversation-checkpoint");

		const restored = await fixture.sessions.open({
			workspace: fixture.workspace,
			mode: "interactive",
			resumeId: replacement!.id,
		});
		try {
			expect(restored.seed.messages.map(({ message }) => message.role)).toEqual(["user", "assistant"]);
			expect(JSON.stringify(restored.seed.messages)).toContain("fresh request");
			expect(JSON.stringify(restored.seed.messages)).not.toContain("overflowing request");
			expect(restored.seed.pendingFollowUps).toEqual([]);
			expect(restored.recoverableFollowUps).toEqual([]);
			expect(restored.composerSubmissions.map(({ text }) => text)).toEqual(["fresh request"]);
			expect(restored.toolInvocations).toEqual([]);
			expect(restored.runEvidence).toHaveLength(1);
			expect(restored.compactionCheckpoint).toBeUndefined();
			expect(restored.mediaReferences.size).toBe(0);
		} finally {
			await restored.close();
		}
		expect(fixture.faux.state.callCount).toBe(2);
		expect(fixture.stdout.value).toContain("fresh Session answer");
		expect(fixture.stdout.value).toContain(replacement!.id);
		expect(fixture.stderr.value).toBe("");
	}, 15_000);

	it("retires the overflowed Session's background processes before closing its journal", async () => {
		const controlled = controlledBackgroundRunner();
		const fixture = await createFixture(
			{ contextWindow: 128_000, maxTokens: 16_384 },
			undefined,
			true,
			controlled.runner,
		);
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("process_start", { command: "long-running" }, { id: "start:old" }), {
				stopReason: "toolUse",
				timestamp: 10_000,
			}),
			fauxAssistantMessage([], {
				stopReason: "error",
				errorMessage: "maximum context window exceeded",
				timestamp: 10_001,
			}),
		]);

		const running = fixture.application.run([
			"--interactive",
			"--no-color",
			"--dangerously-bypass-approvals-and-sandbox",
			"--session",
			"start then overflow",
		]);
		await until(() => stripAnsi(fixture.terminal.readOutput()).includes("Open a new empty Session"));
		const [oldDescriptor] = await fixture.sessions.list(fixture.workspace);
		expect(oldDescriptor?.path).toBeDefined();

		await fixture.terminal.emit(key("down"));
		await fixture.terminal.emit(key("enter"));
		await until(() => fileMissing(`${oldDescriptor!.path!}.lock`));

		expect(controlled.stopCount()).toBe(1);
		const oldJournal = await readFile(oldDescriptor!.path!, "utf8");
		expect(oldJournal).toContain('"toolName":"process_start"');
		expect(oldJournal).toContain('"type":"sandbox_execution"');
		await exit(fixture.terminal);
		await expect(running).resolves.toBe(0);
		expect(controlled.stopCount()).toBe(1);
	}, 15_000);

	it("keeps the overflowed Session active when replacement construction fails", async () => {
		let failReplacementIdentity = false;
		const fixture = await createFixture({ contextWindow: 128_000, maxTokens: 16_384 }, () => failReplacementIdentity);
		fixture.faux.setResponses([
			fauxAssistantMessage([], {
				stopReason: "error",
				errorMessage: "maximum context window exceeded",
				timestamp: 10_000,
			}),
		]);

		const running = fixture.application.run(["--interactive", "--no-color", "--session", "overflowing request"]);
		await until(() => stripAnsi(fixture.terminal.readOutput()).includes("Open a new empty Session"));
		const [oldDescriptor] = await fixture.sessions.list(fixture.workspace);
		const oldJournal = await readFile(oldDescriptor!.path!, "utf8");
		failReplacementIdentity = true;

		await fixture.terminal.emit(key("down"));
		await fixture.terminal.emit(key("enter"));
		await until(() => stripAnsi(fixture.terminal.readOutput()).includes("replacement identity failed"));

		expect(await fixture.sessions.list(fixture.workspace)).toEqual([oldDescriptor]);
		expect(await readFile(oldDescriptor!.path!, "utf8")).toBe(oldJournal);
		await expect(access(`${oldDescriptor!.path!}.lock`)).resolves.toBeUndefined();
		failReplacementIdentity = false;
		await fixture.terminal.emit(key("up"));
		await fixture.terminal.emit(key("enter"));
		await exit(fixture.terminal);
		await expect(running).resolves.toBe(0);
	});

	it("keeps print mode non-interactive and exits 1 for Provider overflow", async () => {
		const fixture = await createFixture({ contextWindow: 128_000, maxTokens: 16_384 }, undefined, false);
		fixture.faux.setResponses([
			fauxAssistantMessage([], {
				stopReason: "error",
				errorMessage: "maximum context window exceeded",
				timestamp: 10_000,
			}),
		]);
		const terminalFactory = vi.spyOn(fixture.terminal, "start");

		await expect(
			fixture.application.run(["--print", "--model", `${fixture.faux.provider.id}/bounded`, "overflow"]),
		).resolves.toBe(1);

		expect(terminalFactory).not.toHaveBeenCalled();
		expect(fixture.stdout.value).toBe("");
		expect(fixture.stderr.value).toContain("maximum context window exceeded");
	});
});

async function createFixture(
	model: { readonly contextWindow: number; readonly maxTokens: number },
	shouldFailIdentity?: () => boolean,
	isTTY = true,
	modelProcessSessionRunner?: ModelProcessSessionRunner,
): Promise<OverflowFixture> {
	const fixture = await mkdtemp(join(tmpdir(), "coda-overflow-fallback-"));
	temporaryDirectories.push(fixture);
	const workspacePath = await realpath(await mkdtemp(join(fixture, "workspace-")));
	const workspace = {
		id: workspaceIdentity(workspacePath),
		path: workspacePath,
	};
	const runtime = testTimeRuntime(10_000);
	const faux = fauxProvider({ runtime, models: [{ id: "bounded", ...model }] });
	const models = createModels({ runtime });
	models.setProvider(faux.provider);
	let id = 0;
	const idGenerator: IdGenerator = {
		generate: (kind: IdKind) => {
			if (kind === "queue_item" && shouldFailIdentity?.()) throw new Error("replacement identity failed");
			return `${kind}:${++id}`;
		},
	};
	const sessions = new FileSessionManager({
		fileSystem: createNodeFileSystem(),
		homeDirectory: fixture,
		clock: runtime.clock,
		idGenerator,
		owner: { token: "overflow-fallback-test", pid: 123, processStartedAt: 1, hostname: "test" },
		processInspector: { status: async () => "alive" },
	});
	const terminal = new VirtualTerminal({ columns: 100, rows: 28 });
	const stdout = new BufferOutput(isTTY);
	const stderr = new BufferOutput(isTTY);
	const application = createCodingAgentApplication({
		models,
		sessions,
		settings: {
			load: async () => ({ defaultModel: { provider: faux.provider.id, id: "bounded" } }),
			save: async () => undefined,
		},
		fileSystem: createNodeFileSystem(),
		processRunner: createNodeProcessRunner({ platform: "darwin" }),
		modelProcessSessionRunner,
		terminalFactory: { create: () => terminal },
		io: { stdin: { isTTY, readAll: async () => "" }, stdout, stderr },
		runtime: {
			cwd: workspacePath,
			homeDirectory: fixture,
			platform: "darwin",
			environment: {},
			clock: runtime.clock,
			idGenerator,
			scheduler: createSystemScheduler(),
		},
	});
	return { application, faux, idGenerator, sessions, stderr, stdout, terminal, workspace };
}

function controlledBackgroundRunner(): {
	readonly runner: ModelProcessSessionRunner;
	readonly stopCount: () => number;
} {
	let stops = 0;
	return {
		stopCount: () => stops,
		runner: {
			start: async () => {
				const stopped = {
					exitCode: null,
					signal: "SIGTERM" as const,
					stdout: "",
					stderr: "",
					timedOut: false,
					truncated: false,
					backend: "none" as const,
				};
				let settle!: (result: typeof stopped) => void;
				const completion = new Promise<typeof stopped>((resolve) => {
					settle = resolve;
				});
				return {
					backend: "none",
					completion,
					write: async () => undefined,
					closeStdin: async () => undefined,
					stop: async () => {
						stops++;
						settle(stopped);
						return completion;
					},
				};
			},
		},
	};
}

function workspaceIdentity(path: string): string {
	return createHash("sha256").update(path).digest("hex").slice(0, 32);
}

function key(
	value: string,
	overrides: Partial<Extract<Parameters<VirtualTerminal["emit"]>[0], { type: "key" }>> = {},
): KeyInput {
	return { type: "key", key: value, action: "press", ...overrides } as KeyInput;
}

async function submit(terminal: VirtualTerminal, text: string): Promise<void> {
	await terminal.emit({ type: "text", text });
	await terminal.emit(key("enter"));
}

async function exit(terminal: VirtualTerminal): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 50));
	await terminal.emit(key("c", { control: true, text: "c" }));
	await new Promise<void>((resolve) => setTimeout(resolve, 10));
	await terminal.emit(key("c", { control: true, text: "c" }));
}

async function fileMissing(path: string): Promise<boolean> {
	try {
		await access(path);
		return false;
	} catch {
		return true;
	}
}

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
	for (let attempt = 0; attempt < 500; attempt++) {
		if (await predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 2));
	}
	throw new Error("Condition did not become true");
}
