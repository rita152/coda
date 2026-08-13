import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
		expect(stdout.value).toContain("--sandbox <mode>");
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
			permissions: { profile: "read-only", approvalPolicy: "on-request" },
		});
		expect(events.at(-2)).toMatchObject({ schemaVersion: 2, type: "run_end", outcome: "success" });
		expect(events.at(-1)).toMatchObject({
			schemaVersion: 2,
			type: "run_evidence",
			outcome: "success",
			paths: { inspected: [], changed: [] },
			commands: [],
			toolIssues: [],
			unresolvedFailures: [],
		});
		expect(events.at(-1)?.runId).toBe(events.at(-2)?.runId);
		expect(events.some((event) => event.type === "message_update")).toBe(true);
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
		expect(events.at(-2)).toMatchObject({ schemaVersion: 2, type: "run_end", outcome: "success" });
		expect(events.at(-1)).toMatchObject({ schemaVersion: 1, type: "run_evidence", outcome: "success" });
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

	it("lets CLI Permission options override settings", async () => {
		const faux = fauxProvider({ runtime: testTimeRuntime(225) });
		faux.setResponses([fauxAssistantMessage("permission snapshot", { timestamp: 225 })]);
		const models = createModels({ runtime: testTimeRuntime(225) });
		models.setProvider(faux.provider);
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			settings: {
				load: async () => ({ permissions: { profile: "full-access", approvalPolicy: "never" } }),
				save: async () => undefined,
			},
			io: { stdin: { isTTY: false, readAll: async () => "" }, stdout, stderr },
			runtime: {
				cwd: "/tmp",
				homeDirectory: "/home/test",
				platform: "darwin",
				environment: {},
				clock: { now: () => 225 },
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
			},
		});

		const exitCode = await application.run([
			"--print",
			"--json",
			"--sandbox",
			"read-only",
			"--ask-for-approval",
			"on-request",
			"--model",
			`${faux.getModel().provider}/${faux.getModel().id}`,
			"inspect permissions",
		]);

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout.value.split("\n")[0]!)).toMatchObject({
			type: "run_start",
			permissions: { profile: "read-only", approvalPolicy: "on-request" },
		});
		expect(stderr.value).toBe("");
	});

	it("reports unresolved print-mode approval as structured output and a nonzero exit", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-print-approval-"));
		try {
			const faux = fauxProvider({ runtime: testTimeRuntime(235) });
			faux.setResponses([
				fauxAssistantMessage(
					fauxToolCall("write", { path: "denied.txt", content: "must not be written" }, { id: "write-denied" }),
					{ stopReason: "toolUse", timestamp: 235 },
				),
				fauxAssistantMessage("I could not write without approval.", { timestamp: 235 }),
			]);
			const models = createModels({ runtime: testTimeRuntime(235) });
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
					homeDirectory: tmpdir(),
					platform: "darwin",
					environment: {},
					clock: { now: () => 235 },
					idGenerator: { generate: (kind) => `${kind}:${++id}` },
				},
			});

			const exitCode = await application.run([
				"--print",
				"--json",
				"--model",
				`${faux.getModel().provider}/${faux.getModel().id}`,
				"write denied.txt",
			]);
			const events = stdout.value
				.trimEnd()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);

			expect(exitCode).toBe(1);
			expect(events).toContainEqual(
				expect.objectContaining({
					schemaVersion: 3,
					type: "approval_required",
					request: expect.objectContaining({ kind: "filesystem", toolName: "write" }),
				}),
			);
			expect(events).toContainEqual(
				expect.objectContaining({
					schemaVersion: 2,
					type: "run_evidence",
					toolIssues: [expect.objectContaining({ toolName: "write", status: "denied" })],
					unresolvedFailures: [expect.objectContaining({ kind: "tool", status: "denied" })],
				}),
			);
			await expect(readFile(join(workspace, "denied.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
			expect(stderr.value).toBe("");
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});

	it("fails closed on external and default Credential Root reads when approval is unavailable", async () => {
		const fixture = await mkdtemp(join(process.cwd(), ".coda-print-external-read-"));
		try {
			const workspace = join(fixture, "workspace");
			const outside = join(fixture, "outside.txt");
			const credential = join(workspace, ".ssh", "id_ed25519");
			await mkdir(join(workspace, ".ssh"), { recursive: true });
			await writeFile(outside, "classified-read-content\n");
			await writeFile(credential, "classified-credential-content\n");
			const canonicalOutside = await realpath(outside);
			const canonicalCredential = await realpath(credential);
			const faux = fauxProvider({ runtime: testTimeRuntime(237) });
			faux.setResponses([
				fauxAssistantMessage(fauxToolCall("read", { path: outside }, { id: "read-external" }), {
					stopReason: "toolUse",
					timestamp: 237,
				}),
				(context) => {
					const result = context.messages.at(-1);
					expect(result).toMatchObject({
						role: "toolResult",
						toolCallId: "read-external",
						isError: true,
					});
					expect(JSON.stringify(result)).not.toContain("classified-read-content");
					return fauxAssistantMessage(
						fauxToolCall("read", { path: ".ssh/id_ed25519" }, { id: "read-credential" }),
						{
							stopReason: "toolUse",
							timestamp: 237,
						},
					);
				},
				(context) => {
					const result = context.messages.at(-1);
					expect(result).toMatchObject({
						role: "toolResult",
						toolCallId: "read-credential",
						isError: true,
					});
					expect(JSON.stringify(result)).not.toContain("classified-credential-content");
					return fauxAssistantMessage("Both reads require approval.", { timestamp: 237 });
				},
			]);
			const models = createModels({ runtime: testTimeRuntime(237) });
			models.setProvider(faux.provider);
			const stdout = new BufferOutput();
			const stderr = new BufferOutput();
			let id = 0;
			const application = createCodingAgentApplication({
				models,
				settings: {
					load: async () => ({ permissions: { profile: "workspace", approvalPolicy: "on-request" } }),
					save: async () => undefined,
				},
				fileSystem: createNodeFileSystem(),
				processRunner: createNodeProcessRunner({ platform: "darwin" }),
				io: { stdin: { isTTY: false, readAll: async () => "" }, stdout, stderr },
				runtime: {
					cwd: workspace,
					homeDirectory: workspace,
					platform: "darwin",
					environment: {},
					clock: { now: () => 237 },
					idGenerator: { generate: (kind) => `${kind}:${++id}` },
				},
			});

			const exitCode = await application.run([
				"--print",
				"--json",
				"--model",
				`${faux.getModel().provider}/${faux.getModel().id}`,
				"read the external file",
			]);
			const events = stdout.value
				.trimEnd()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);

			expect(exitCode).toBe(1);
			expect(events).toContainEqual(
				expect.objectContaining({
					type: "approval_required",
					request: expect.objectContaining({
						kind: "filesystem",
						toolName: "read",
						operation: "read",
						canonicalPath: canonicalOutside,
					}),
				}),
			);
			expect(events).toContainEqual(
				expect.objectContaining({
					type: "approval_required",
					request: expect.objectContaining({
						kind: "filesystem",
						toolName: "read",
						operation: "read",
						canonicalPath: canonicalCredential,
						reason: "path is within a protected Credential root",
					}),
				}),
			);
			expect(stdout.value).not.toContain("classified-read-content");
			expect(stdout.value).not.toContain("classified-credential-content");
			expect(stderr.value).toBe("");
		} finally {
			await rm(fixture, { recursive: true, force: true });
		}
	});

	it("aborts the current Run when an in-flight managed-network review chooses abort", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-network-abort-"));
		try {
			const faux = fauxProvider({ runtime: testTimeRuntime(240) });
			faux.setResponses([
				fauxAssistantMessage(
					fauxToolCall("bash", { command: "curl https://example.com" }, { id: "network-abort" }),
					{ stopReason: "toolUse", timestamp: 240 },
				),
				fauxAssistantMessage("this response must not be requested", { timestamp: 240 }),
			]);
			const models = createModels({ runtime: testTimeRuntime(240) });
			models.setProvider(faux.provider);
			const stdout = new BufferOutput();
			const stderr = new BufferOutput();
			let id = 0;
			const application = createCodingAgentApplication({
				models,
				settings,
				fileSystem: createNodeFileSystem(),
				processRunner: createNodeProcessRunner({ platform: "darwin" }),
				approval: {
					decide: async (request) => {
						expect(request.kind).toBe("network");
						return { type: "abort" };
					},
				},
				modelProcessRunner: {
					run: async (_request, authority) => {
						const destination = {
							environmentId: "local",
							host: "example.com",
							protocol: "https" as const,
							port: 443,
						};
						const decision = await authority.managedNetwork?.decide(destination);
						if (!decision || decision.action !== "deny") throw new Error("expected network denial");
						return {
							exitCode: 1,
							signal: null,
							stdout: "",
							stderr: "network denied",
							timedOut: false,
							truncated: false,
							backend: "macos-seatbelt",
							denial: {
								kind: "network",
								backend: "managed-network-proxy",
								...destination,
								decision: "deny",
								source: decision.source,
								reason: decision.reason,
								timestamp: 240,
							},
						};
					},
				},
				io: { stdin: { isTTY: false, readAll: async () => "" }, stdout, stderr },
				runtime: {
					cwd: workspace,
					homeDirectory: tmpdir(),
					platform: "darwin",
					environment: {},
					clock: { now: () => 240 },
					idGenerator: { generate: (kind) => `${kind}:${++id}` },
				},
			});

			const exitCode = await application.run([
				"--print",
				"--json",
				"--model",
				`${faux.getModel().provider}/${faux.getModel().id}`,
				"try the network",
			]);
			const events = stdout.value
				.trimEnd()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);

			expect(exitCode).toBe(1);
			expect(faux.state.callCount).toBe(1);
			expect(events.at(-2)).toMatchObject({ type: "run_end", outcome: "aborted" });
			expect(events.at(-1)).toMatchObject({ type: "run_evidence", outcome: "aborted" });
			expect(stderr.value).toContain("Run ended with outcome aborted");
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});

	it("catalogs a user Skill and revision-binds model activation to Skill Approval", async () => {
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
			const approvals: Array<{ kind: string; reason: string }> = [];
			const stdout = new BufferOutput();
			const stderr = new BufferOutput();
			let id = 0;
			const application = createCodingAgentApplication({
				models,
				settings,
				fileSystem: createNodeFileSystem(),
				processRunner: createNodeProcessRunner({ platform: "darwin" }),
				approval: {
					decide: async (request) => {
						approvals.push({ kind: request.kind, reason: request.reason });
						return { type: "approved-for-session" };
					},
				},
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
			expect(approvals).toHaveLength(1);
			expect(approvals[0]).toMatchObject({ kind: "skill" });
			expect(approvals[0]!.reason).toContain(selectedSkillId);
			expect(approvals[0]!.reason).toMatch(/revision [a-f0-9]{64}/u);
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
