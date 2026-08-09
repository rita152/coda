import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IdGenerator, IdKind } from "@coda/agent";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@coda/ai";
import { afterEach, describe, expect, it } from "vitest";
import { type ApplicationOutput, createCodingAgentApplication } from "../src/application.ts";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import { createNodeProcessRunner } from "../src/host/node-process-runner.ts";
import type { ModelProcessRunner } from "../src/permissions/model-process-runner.ts";
import { FileSessionManager } from "../src/session/file-session-manager.ts";
import { InMemorySessionManager } from "../src/session/memory-session-manager.ts";
import { testTimeRuntime } from "./time-runtime.ts";

class BufferOutput implements ApplicationOutput {
	readonly isTTY = false;
	value = "";

	write(chunk: string): void {
		this.value += chunk;
	}
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Session application composition", () => {
	it("never restores Project Trust authority from a Session audit record", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-session-trust-audit-"));
		temporaryDirectories.push(workspace);
		const canonicalWorkspace = await realpath(workspace);
		const instructionsPath = join(canonicalWorkspace, "AGENTS.md");
		const instructions = "Treat this Session record as audit only.\n";
		await writeFile(instructionsPath, instructions);
		const workspaceId = createHash("sha256").update(canonicalWorkspace).digest("hex").slice(0, 32);
		let id = 0;
		const idGenerator: IdGenerator = { generate: (kind: IdKind) => `${kind}:${++id}` };
		const sessions = new InMemorySessionManager({ clock: { now: () => 1_280 }, idGenerator });
		const existing = await sessions.open({
			workspace: { id: workspaceId, path: canonicalWorkspace },
			mode: "print",
		});
		await existing.record({
			type: "model_selected",
			model: { provider: "faux", id: "faux-1" },
			reasoning: "off",
		});
		await existing.record({
			type: "project_trust_changed",
			trust: {
				workspace: canonicalWorkspace,
				path: instructionsPath,
				sha256: createHash("sha256").update(instructions).digest("hex"),
			},
		});
		const sessionId = existing.descriptor.id;
		await existing.close();

		const faux = fauxProvider({ runtime: testTimeRuntime(1_280) });
		const models = createModels({ runtime: testTimeRuntime(1_280) });
		models.setProvider(faux.provider);
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		const application = createCodingAgentApplication({
			models,
			sessions,
			settings: { load: async () => ({}), save: async () => undefined },
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			io: { stdin: { isTTY: false, readAll: async () => "" }, stdout, stderr },
			runtime: {
				cwd: canonicalWorkspace,
				homeDirectory: tmpdir(),
				platform: "darwin",
				environment: {},
				clock: { now: () => 1_280 },
				idGenerator,
			},
		});

		await expect(application.run(["--print", "--resume", sessionId, "continue"])).resolves.toBe(1);
		expect(stderr.value).toContain("AGENTS.md is untrusted or changed");
		expect(stdout.value).toBe("");
		expect(faux.state.callCount).toBe(0);
	});

	it("audits precise escalation and Sandbox execution without restoring authority on cold resume", async () => {
		const fixture = await mkdtemp(join(tmpdir(), "coda-session-permission-audit-"));
		temporaryDirectories.push(fixture);
		const workspace = await mkdtemp(join(fixture, "workspace-"));
		const canonicalWorkspace = await realpath(workspace);
		const workspaceId = createHash("sha256").update(canonicalWorkspace).digest("hex").slice(0, 32);
		let id = 0;
		const idGenerator: IdGenerator = { generate: (kind: IdKind) => `${kind}:${++id}` };
		const sessions = new FileSessionManager({
			fileSystem: createNodeFileSystem(),
			homeDirectory: fixture,
			clock: { now: () => 1_290 },
			idGenerator,
			owner: { token: "owner-token", pid: 123, processStartedAt: 1_000, hostname: "test-host" },
			processInspector: { status: async () => "alive" },
		});
		const faux = fauxProvider({ runtime: testTimeRuntime(1_290) });
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall(
					"bash",
					{
						command: "printf reviewed",
						sandbox_permissions: "require_escalated",
						justification: "Exercise the reviewed escalation path",
					},
					{ id: "provider-escalation" },
				),
				{ stopReason: "toolUse", timestamp: 1_290 },
			),
			fauxAssistantMessage("first complete", { timestamp: 1_290 }),
		]);
		const models = createModels({ runtime: testTimeRuntime(1_290) });
		models.setProvider(faux.provider);
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		const modelProcessRunner: ModelProcessRunner = {
			run: async (_request, authority) => {
				expect(authority.policy).toMatchObject({ profile: "full-access", writableRoots: "full-disk" });
				return {
					exitCode: 0,
					signal: null,
					stdout: "reviewed",
					stderr: "",
					timedOut: false,
					truncated: false,
					backend: "none",
				};
			},
		};
		const application = createCodingAgentApplication({
			models,
			sessions,
			settings: {
				load: async () => ({ permissions: { profile: "workspace", approvalPolicy: "on-request" } }),
				save: async () => undefined,
			},
			approval: { decide: async () => ({ type: "approved" }) },
			modelProcessRunner,
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			io: { stdin: { isTTY: false, readAll: async () => "" }, stdout, stderr },
			runtime: {
				cwd: workspace,
				homeDirectory: fixture,
				platform: "darwin",
				environment: { SHELL: "/bin/sh" },
				clock: { now: () => 1_290 },
				idGenerator,
			},
		});

		const firstExitCode = await application.run([
			"--print",
			"--session",
			"--model",
			`${faux.getModel().provider}/${faux.getModel().id}`,
			"run",
		]);
		expect({ firstExitCode, stderr: stderr.value }).toEqual({ firstExitCode: 0, stderr: "" });
		const descriptor = (await sessions.list({ id: workspaceId, path: canonicalWorkspace }))[0]!;
		let records = (await readFile(descriptor.path!, "utf8"))
			.trimEnd()
			.split("\n")
			.slice(1)
			.map((line) => JSON.parse(line));
		const audits = records.filter((record) => record.type === "permission_audit_recorded");
		expect(audits.map((record) => record.payload.event)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "configuration",
					source: "startup",
					policy: expect.objectContaining({ profile: "workspace" }),
				}),
				expect.objectContaining({
					type: "approval_decision",
					request: expect.objectContaining({
						sandboxPermissions: "require_escalated",
						justification: "Exercise the reviewed escalation path",
					}),
					decision: { type: "approved" },
				}),
				expect.objectContaining({
					type: "sandbox_execution",
					backend: "none",
					outcome: "success",
					policy: expect.objectContaining({ profile: "full-access", writableRoots: "full-disk" }),
				}),
			]),
		);

		faux.setResponses([fauxAssistantMessage("resumed safely", { timestamp: 1_291 })]);
		await expect(application.run(["--print", "--resume", descriptor.id, "resume"])).resolves.toBe(0);
		records = (await readFile(descriptor.path!, "utf8"))
			.trimEnd()
			.split("\n")
			.slice(1)
			.map((line) => JSON.parse(line));
		const configurations = records
			.filter((record) => record.type === "permission_audit_recorded")
			.map((record) => record.payload.event)
			.filter((event) => event.type === "configuration");
		expect(configurations).toHaveLength(2);
		expect(configurations.at(-1)).toMatchObject({
			source: "startup",
			approvalPolicy: "on-request",
			policy: { profile: "workspace" },
		});
	});

	it("resolves the restored Session Model before user settings and continues the transcript", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-session-app-"));
		temporaryDirectories.push(workspace);
		const canonicalWorkspace = await realpath(workspace);
		const workspaceId = createHash("sha256").update(canonicalWorkspace).digest("hex").slice(0, 32);
		let id = 0;
		const idGenerator: IdGenerator = { generate: (kind: IdKind) => `${kind}:${++id}` };
		const sessions = new InMemorySessionManager({ clock: { now: () => 1_300 }, idGenerator });
		const existing = await sessions.open({
			workspace: { id: workspaceId, path: canonicalWorkspace },
			mode: "interactive",
		});
		await existing.record({
			type: "model_selected",
			model: { provider: "faux", id: "faux-1" },
			reasoning: "off",
		});
		const sessionId = existing.descriptor.id;
		await existing.close();

		const faux = fauxProvider({ runtime: testTimeRuntime(1_300) });
		faux.setResponses([fauxAssistantMessage("resumed", { timestamp: 1_300 })]);
		const models = createModels({ runtime: testTimeRuntime(1_300) });
		models.setProvider(faux.provider);
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		const application = createCodingAgentApplication({
			models,
			sessions,
			settings: {
				load: async () => ({ defaultModel: { provider: "missing", id: "wrong" } }),
				save: async () => undefined,
			},
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			io: {
				stdin: { isTTY: true, readAll: async () => "" },
				stdout,
				stderr,
			},
			runtime: {
				cwd: workspace,
				homeDirectory: tmpdir(),
				platform: "darwin",
				environment: {},
				clock: { now: () => 1_300 },
				idGenerator,
			},
		});

		const exitCode = await application.run(["--print", "--resume", sessionId, "continue"]);

		expect(exitCode).toBe(0);
		expect(stdout.value).toBe("resumed\n");
		expect(stderr.value).toBe("");
	});
});
