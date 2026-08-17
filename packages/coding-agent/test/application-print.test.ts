import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IdGenerator } from "@coda/agent";
import {
	createFauxCore,
	createModels,
	createProvider,
	envApiKeyAuth,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@coda/ai";
import type { ScheduledTask, Scheduler } from "@coda/tui";
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

class RecordingScheduler implements Scheduler {
	readonly tasks: Array<{ cancelled: boolean; readonly delayMs: number }> = [];

	schedule(delayMs: number, _run: () => void | Promise<void>): ScheduledTask {
		const task = { cancelled: false, delayMs };
		this.tasks.push(task);
		return {
			cancel: () => {
				task.cancelled = true;
			},
		};
	}
}

const settings: SettingsStore = {
	load: async () => ({}),
	save: async () => undefined,
};

describe("Coding Agent print mode", () => {
	it.each(["--allow-bash", "--allow-workspace-write"])("rejects removed legacy authority flag %s", async (flag) => {
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		const application = createCodingAgentApplication({
			models: createModels({ runtime: testTimeRuntime() }),
			settings,
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			io: { stdin: { isTTY: false, readAll: async () => "" }, stdout, stderr },
			runtime: {
				cwd: "/tmp",
				homeDirectory: "/home/test",
				platform: "darwin",
				environment: {},
				clock: { now: () => 0 },
				idGenerator: { generate: (kind) => `${kind}:unused` },
			},
		});

		await expect(application.run(["--print", flag, "prompt"])).resolves.toBe(1);
		expect(stderr.value).toContain(`Unknown option: ${flag}`);
		expect(stdout.value).toBe("");
	});

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
		expect(stdout.value).toContain("--json-mode <mode>");
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

	it("passes explicit output-token and Run-turn budgets", async () => {
		const runtime = testTimeRuntime(125);
		const faux = fauxProvider({
			runtime,
			models: [{ id: "reasoner", contextWindow: 1_000_000, maxTokens: 384_000 }],
		});
		let observedMaxTokens: number | undefined;
		faux.setResponses([
			(_context, options) => {
				observedMaxTokens = options.maxTokens;
				return fauxAssistantMessage("budgeted output", { timestamp: 125 });
			},
		]);
		const models = createModels({ runtime });
		models.setProvider(faux.provider);
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			settings,
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			io: { stdin: { isTTY: true, readAll: async () => "" }, stdout, stderr },
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
			application.run([
				"--print",
				"--json",
				"--max-output-tokens",
				"32768",
				"--max-turns",
				"96",
				"--model",
				`${faux.getModel().provider}/${faux.getModel().id}`,
				"solve the task",
			]),
		).resolves.toBe(0);
		expect(observedMaxTokens).toBe(32_768);
		expect(JSON.parse(stdout.value.split("\n")[0]!)).toMatchObject({
			type: "run_start",
			budget: { limits: { maxTurns: 96 } },
		});
		expect(stderr.value).toBe("");
	});

	it("passes the model's full explicit output limit with no Run budget", async () => {
		const runtime = testTimeRuntime(126);
		const faux = fauxProvider({
			runtime,
			models: [{ id: "unbounded-reasoner", contextWindow: 1_000_000, maxTokens: 384_000 }],
		});
		let observedMaxTokens: number | undefined;
		faux.setResponses([
			(_context, options) => {
				observedMaxTokens = options.maxTokens;
				return fauxAssistantMessage("unbudgeted output", { timestamp: 126 });
			},
		]);
		const models = createModels({ runtime });
		models.setProvider(faux.provider);
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			settings,
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			io: { stdin: { isTTY: true, readAll: async () => "" }, stdout, stderr },
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
			application.run([
				"--print",
				"--json",
				"--max-output-tokens",
				"384000",
				"--no-run-budget",
				"--model",
				`${faux.getModel().provider}/${faux.getModel().id}`,
				"solve the task",
			]),
		).resolves.toBe(0);
		expect(observedMaxTokens).toBe(384_000);
		expect(JSON.parse(stdout.value.split("\n")[0]!)).toMatchObject({ type: "run_start" });
		expect(JSON.parse(stdout.value.split("\n")[0]!)).not.toHaveProperty("budget");
		expect(stderr.value).toBe("");
	});

	it("emits one semantic stream with Tool lifecycle, terminal candidate, evidence, completion, and RunControl", async () => {
		const runtime = testTimeRuntime(127);
		const faux = fauxProvider({ runtime });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "package.json" }, { id: "controlled-read" }), {
				stopReason: "toolUse",
				timestamp: 127,
			}),
			(context) => {
				expect(context.messages.at(-1)).toMatchObject({
					role: "toolResult",
					toolCallId: "controlled-read",
					toolName: "read",
				});
				return fauxAssistantMessage("controlled output", { timestamp: 127 });
			},
		]);
		const models = createModels({ runtime });
		models.setProvider(faux.provider);
		const scheduler = new RecordingScheduler();
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			settings,
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			io: { stdin: { isTTY: true, readAll: async () => "" }, stdout, stderr },
			runtime: {
				cwd: process.cwd(),
				homeDirectory: "/home/test",
				platform: "darwin",
				environment: {},
				clock: runtime.clock,
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
				scheduler,
			},
		});

		await expect(
			application.run([
				"--print",
				"--json",
				"--json-mode",
				"semantic",
				"--trust-project",
				"--no-run-budget",
				"--run-control-work-ms",
				"1000",
				"--run-control-grace-ms",
				"200",
				"--run-control-stationary-turns",
				"4",
				"--model",
				`${faux.getModel().provider}/${faux.getModel().id}`,
				"solve the task",
			]),
		).resolves.toBe(0);
		const events = stdout.value
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(events[0]).toMatchObject({
			schemaVersion: 3,
			type: "run_start",
			runControl: {
				schemaVersion: 1,
				phase: "running",
				configured: { workDurationMs: 1_000, graceDurationMs: 200, maxStationaryTurns: 4 },
			},
		});
		expect(events[0]).not.toHaveProperty("budget");
		expect(events.some(({ type }) => type === "message_update")).toBe(false);
		expect(events.some(({ type }) => type === "tool_execution_start")).toBe(true);
		expect(events.some(({ type }) => type === "tool_execution_end")).toBe(true);
		expect([...events].reverse().find(({ type }) => type === "attempt_end")).toMatchObject({
			candidate: { message: { content: [{ type: "text", text: "controlled output" }] } },
		});
		expect(events.at(-3)).toMatchObject({
			schemaVersion: 3,
			type: "run_end",
			outcome: "success",
			runControl: { phase: "terminal", reason: "run_ended", trigger: null },
		});
		expect(events.at(-2)).toMatchObject({
			schemaVersion: 4,
			type: "run_evidence",
			outcome: "success",
			operations: [
				expect.objectContaining({
					toolName: "read",
					status: "ok",
					paths: [expect.objectContaining({ path: "package.json", effect: "inspected" })],
				}),
			],
			runControl: { phase: "terminal", reason: "run_ended", trigger: null },
		});
		expect(events.at(-1)).toMatchObject({
			schemaVersion: 1,
			type: "completion_disposition",
			disposition: "verified",
		});
		expect(scheduler.tasks).toEqual([{ delayMs: 1_000, cancelled: true }]);
		expect(stderr.value).toBe("");
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
			budget: {
				limits: {
					maxTurns: 64,
					maxToolInvocations: 256,
					maxElapsedMs: 3_600_000,
					maxConsecutiveEquivalentToolBatches: 4,
				},
			},
			model: { provider: faux.getModel().provider, id: faux.getModel().id },
			reasoning: "off",
		});
		expect(events.at(-3)).toMatchObject({ schemaVersion: 2, type: "run_end", outcome: "success" });
		expect(events.at(-2)).toMatchObject({
			schemaVersion: 3,
			type: "run_evidence",
			outcome: "success",
			paths: { inspected: [], changed: [] },
			commands: [],
		});
		expect(events.at(-1)).toMatchObject({
			schemaVersion: 1,
			type: "completion_disposition",
			disposition: "verified",
			modelTermination: "completed",
			evidenceCompleteness: "complete",
			verification: { result: "not_run", hiddenVerifier: "not_evaluated" },
		});
		expect(events.at(-1)?.runId).toBe(events.at(-2)?.runId);
		expect(events.some((event) => event.type === "message_update")).toBe(true);
		expect(events.at(-2)?.runId).toBe(events.at(-3)?.runId);
		expect(stdout.value).not.toContain("json answer\n");
		expect(stderr.value).toBe("");
	});

	it("emits terminal Agent events without transient deltas in semantic JSON mode", async () => {
		const faux = fauxProvider({ runtime: testTimeRuntime(210) });
		faux.setResponses([fauxAssistantMessage("semantic answer", { timestamp: 210 })]);
		const models = createModels({ runtime: testTimeRuntime(210) });
		models.setProvider(faux.provider);
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			settings,
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			io: { stdin: { isTTY: true, readAll: async () => "" }, stdout, stderr },
			runtime: {
				cwd: "/tmp",
				homeDirectory: "/home/test",
				platform: "darwin",
				environment: {},
				clock: { now: () => 210 },
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
			},
		});

		await expect(
			application.run([
				"--print",
				"--json",
				"--json-mode",
				"semantic",
				"--model",
				`${faux.getModel().provider}/${faux.getModel().id}`,
				"answer semantically",
			]),
		).resolves.toBe(0);
		const events = stdout.value
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);

		expect(events.some((event) => event.type === "message_update")).toBe(false);
		expect(events.some((event) => event.type === "attempt_end")).toBe(true);
		expect(events.some((event) => event.type === "message_end")).toBe(true);
		expect(events.at(-3)).toMatchObject({ schemaVersion: 2, type: "run_end", outcome: "success" });
		expect(events.at(-2)).toMatchObject({ schemaVersion: 3, type: "run_evidence", outcome: "success" });
		expect(events.at(-1)).toMatchObject({ schemaVersion: 1, type: "completion_disposition" });
		const terminal = [...events].reverse().find((event) => event.type === "attempt_end");
		expect(terminal).toMatchObject({
			candidate: { message: { content: [{ type: "text", text: "semantic answer" }] } },
		});
		expect(stderr.value).toBe("");
	});

	it("requires an explicit JSON output stream for --json-mode", async () => {
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		const application = createCodingAgentApplication({
			models: createModels({ runtime: testTimeRuntime() }),
			settings,
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			io: { stdin: { isTTY: true, readAll: async () => "" }, stdout, stderr },
			runtime: {
				cwd: "/tmp",
				homeDirectory: "/home/test",
				platform: "darwin",
				environment: {},
				clock: { now: () => 0 },
				idGenerator: { generate: (kind) => `${kind}:unused` },
			},
		});

		await expect(application.run(["--print", "--json-mode", "semantic", "prompt"])).resolves.toBe(1);
		expect(stderr.value).toContain("--json-mode requires --json");
		expect(stdout.value).toBe("");
	});

	it("supplements native evidence with final Git-visible Shell mutations", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-shell-evidence-"));
		try {
			const canonicalWorkspace = await realpath(workspace);
			const faux = fauxProvider({ runtime: testTimeRuntime(215) });
			faux.setResponses([
				fauxAssistantMessage(
					fauxToolCall("bash", { command: "printf shell > shell-created.txt" }, { id: "shell-mutation" }),
					{ stopReason: "toolUse", timestamp: 215 },
				),
				(context) => {
					expect(context.messages.at(-1)).toMatchObject({
						role: "toolResult",
						toolName: "bash",
					});
					return fauxAssistantMessage("Shell mutation complete.", { timestamp: 215 });
				},
				(context) => {
					expect(JSON.stringify(context.messages)).toContain(
						"run a focused verification after the latest mutation",
					);
					return fauxAssistantMessage(
						fauxToolCall("bash", { command: "npm test" }, { id: "shell-verification" }),
						{ stopReason: "toolUse", timestamp: 215 },
					);
				},
				fauxAssistantMessage("Shell mutation verified.", { timestamp: 215 }),
			]);
			const models = createModels({ runtime: testTimeRuntime(215) });
			models.setProvider(faux.provider);
			const stdout = new BufferOutput();
			const stderr = new BufferOutput();
			let id = 0;
			let workspaceCaptures = 0;
			const application = createCodingAgentApplication({
				models,
				settings,
				fileSystem: createNodeFileSystem(),
				processRunner: {
					run: async (request) => {
						if (request.executable !== "git") {
							if (request.args.at(-1)?.includes("printf shell")) {
								await writeFile(join(workspace, "shell-created.txt"), "shell");
							}
							return {
								exitCode: 0,
								signal: null,
								stdout: "",
								stderr: "",
								timedOut: false,
								truncated: false,
							};
						}
						if (request.args[0] === "rev-parse") {
							expect(request).toMatchObject({
								executable: "git",
								args: ["rev-parse", "--show-prefix"],
								cwd: canonicalWorkspace,
							});
							return {
								exitCode: 0,
								signal: null,
								stdout: "\n",
								stderr: "",
								timedOut: false,
								truncated: false,
							};
						}
						expect(request).toMatchObject({
							executable: "git",
							args: [
								"-c",
								"core.fsmonitor=false",
								"status",
								"--porcelain=v1",
								"-z",
								"--untracked-files=all",
								"--",
								".",
							],
							cwd: canonicalWorkspace,
						});
						return {
							exitCode: 0,
							signal: null,
							stdout: "?? shell-created.txt\0",
							stderr: "",
							timedOut: false,
							truncated: false,
						};
					},
				},
				completionWorkspaceEvidence: {
					capture: async () => {
						const changed = workspaceCaptures++ > 0;
						return {
							schemaVersion: 1,
							status: "complete" as const,
							capturedAt: 215,
							dirty: changed,
							changedPaths: changed ? ["shell-created.txt"] : [],
							omittedChangedPaths: 0,
							statusSha256: changed ? "changed:status" : "baseline:status",
							diffSha256: changed ? "changed:diff" : "baseline:diff",
							untrackedSha256: changed ? "changed:untracked" : "baseline:untracked",
							fingerprint: changed ? "changed" : "baseline",
							diagnostics: [],
						};
					},
				},
				io: { stdin: { isTTY: false, readAll: async () => "" }, stdout, stderr },
				runtime: {
					cwd: workspace,
					homeDirectory: workspace,
					platform: "darwin",
					environment: {},
					clock: { now: () => 215 },
					idGenerator: { generate: (kind) => `${kind}:${++id}` },
				},
			});

			await expect(
				application.run([
					"--print",
					"--json",
					"--model",
					`${faux.getModel().provider}/${faux.getModel().id}`,
					"mutate through Shell",
				]),
			).resolves.toBe(0);
			const events = stdout.value
				.trimEnd()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			expect(events.at(-2)).toMatchObject({
				schemaVersion: 3,
				type: "run_evidence",
				paths: {
					changed: ["shell-created.txt"],
					changedWithProvenance: [{ path: "shell-created.txt", provenance: ["workspace-diff"] }],
					workspaceDiff: { status: "complete", omitted: 0 },
				},
			});
			expect(events.at(-1)).toMatchObject({
				type: "completion_disposition",
				disposition: "verified",
				verification: { result: "passed", afterLatestMutation: true },
				repair: { attempts: 1, maxAttempts: 1 },
			});
			expect(stderr.value).toBe("");
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});

	it("catalogs a user Skill and loads its revision-bound instructions", async () => {
		const fixture = await mkdtemp(join(tmpdir(), "coda-print-skill-"));
		try {
			const workspace = join(fixture, "workspace");
			const home = join(fixture, "home");
			const skillDirectory = join(home, ".agents", "skills", "inspect");
			await Promise.all([mkdir(workspace, { recursive: true }), mkdir(skillDirectory, { recursive: true })]);
			await writeFile(
				join(skillDirectory, "SKILL.md"),
				"---\nname: inspect\ndescription: Inspect the current change\n---\n\nFollow the inspection checklist.\n",
			);
			const faux = fauxProvider({ runtime: testTimeRuntime(245) });
			let selectedSkillId = "";
			faux.setResponses([
				(context) => {
					expect(context.systemPrompt).toContain("Available Skills (metadata only)");
					expect(context.systemPrompt).toContain("Inspect the current change");
					selectedSkillId = JSON.stringify(context.tools).match(/skill:[a-f0-9]{32}/u)?.[0] ?? "";
					expect(selectedSkillId).not.toBe("");
					return fauxAssistantMessage(
						fauxToolCall("skill", { skill: selectedSkillId, arguments: "focus here" }, { id: "skill-call" }),
						{ stopReason: "toolUse", timestamp: 245 },
					);
				},
				(context) => {
					expect(JSON.stringify(context.messages)).toContain("Follow the inspection checklist");
					expect(JSON.stringify(context.messages)).toContain("focus here");
					return fauxAssistantMessage("inspection complete", { timestamp: 245 });
				},
			]);
			const models = createModels({ runtime: testTimeRuntime(245) });
			models.setProvider(faux.provider);
			const stdout = new BufferOutput();
			const stderr = new BufferOutput();
			let id = 0;
			const application = createCodingAgentApplication({
				models,
				settings,
				fileSystem: createNodeFileSystem(),
				processRunner: createNodeProcessRunner({ platform: "darwin" }),
				io: { stdin: { isTTY: false, readAll: async () => "" }, stdout, stderr },
				runtime: {
					cwd: workspace,
					homeDirectory: home,
					platform: "darwin",
					environment: {},
					clock: { now: () => 245 },
					idGenerator: { generate: (kind) => `${kind}:${++id}` },
				},
			});

			await expect(
				application.run(["--print", "--model", `${faux.getModel().provider}/${faux.getModel().id}`, "inspect"]),
			).resolves.toBe(0);
			expect(stdout.value).toBe("inspection complete\n");
			expect(stderr.value).toBe("");
		} finally {
			await rm(fixture, { recursive: true, force: true });
		}
	});

	it("loads workspace Skills without a trust prompt or CLI flag", async () => {
		const fixture = await mkdtemp(join(tmpdir(), "coda-workspace-skill-discovery-"));
		try {
			const workspace = join(fixture, "workspace");
			const home = join(fixture, "home");
			const skillDirectory = join(workspace, ".agents", "skills", "workspace-review");
			await Promise.all([mkdir(skillDirectory, { recursive: true }), mkdir(home, { recursive: true })]);
			await writeFile(
				join(skillDirectory, "SKILL.md"),
				"---\nname: workspace-review\ndescription: Workspace-only review\n---\n\nReview the workspace.\n",
			);
			const faux = fauxProvider({ runtime: testTimeRuntime(246) });
			const skillVisibility: boolean[] = [];
			faux.setResponses([
				(context) => {
					skillVisibility.push(context.tools?.some(({ name }) => name === "skill") ?? false);
					return fauxAssistantMessage("workspace Skill available", { timestamp: 246 });
				},
			]);
			const models = createModels({ runtime: testTimeRuntime(246) });
			models.setProvider(faux.provider);
			let storedSettings: Awaited<ReturnType<SettingsStore["load"]>> = {};
			const stdout = new BufferOutput();
			const stderr = new BufferOutput();
			let id = 0;
			const application = createCodingAgentApplication({
				models,
				settings: {
					load: async () => storedSettings,
					save: async (next) => {
						storedSettings = next;
					},
				},
				fileSystem: createNodeFileSystem(),
				processRunner: createNodeProcessRunner({ platform: "darwin" }),
				io: { stdin: { isTTY: false, readAll: async () => "" }, stdout, stderr },
				runtime: {
					cwd: workspace,
					homeDirectory: home,
					platform: "darwin",
					environment: {},
					clock: { now: () => 246 },
					idGenerator: { generate: (kind) => `${kind}:${++id}` },
				},
			});
			const model = `${faux.getModel().provider}/${faux.getModel().id}`;

			await expect(application.run(["--print", "--model", model, "first"])).resolves.toBe(0);

			expect(skillVisibility).toEqual([true]);
			expect(storedSettings).toEqual({});
			expect(storedSettings.projectTrust).toBeUndefined();
			expect(stderr.value).toBe("");
		} finally {
			await rm(fixture, { recursive: true, force: true });
		}
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
