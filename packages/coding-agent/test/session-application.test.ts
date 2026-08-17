import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IdGenerator, IdKind } from "@coda/agent";
import { createModels, fauxAssistantMessage, fauxProvider } from "@coda/ai";
import { afterEach, describe, expect, it } from "vitest";
import { type ApplicationOutput, createCodingAgentApplication } from "../src/application.ts";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import { createNodeProcessRunner } from "../src/host/node-process-runner.ts";
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

	it("generates a Session Title and lists it from sessions", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-session-title-app-"));
		temporaryDirectories.push(workspace);
		const canonicalWorkspace = await realpath(workspace);
		const workspaceId = createHash("sha256").update(canonicalWorkspace).digest("hex").slice(0, 32);
		let id = 0;
		const idGenerator: IdGenerator = { generate: (kind: IdKind) => `${kind}:${++id}` };
		const sessions = new InMemorySessionManager({ clock: { now: () => 1_400 }, idGenerator });
		const runtime = testTimeRuntime(1_400);
		const faux = fauxProvider({ runtime, api: "openai-completions" });
		const respond = (context: { tools?: unknown }) =>
			context.tools === undefined
				? fauxAssistantMessage("Readable session picker", { timestamp: 1_400 })
				: fauxAssistantMessage("done", { timestamp: 1_400 });
		faux.setResponses([respond, respond]);
		const models = createModels({ runtime });
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
				clock: { now: () => 1_400 },
				idGenerator,
			},
		});

		const prompt = "Please implement a readable session picker for the /session command";
		await expect(
			application.run([
				"--print",
				"--session",
				"--model",
				`${faux.getModel().provider}/${faux.getModel().id}`,
				prompt,
			]),
		).resolves.toBe(0);
		expect(stderr.value).toBe("");
		expect(stdout.value).toBe("done\n");

		const [summary] = await sessions.listSummaries({ id: workspaceId, path: canonicalWorkspace });
		expect(summary?.title).toBe("Readable session picker");
		expect(summary?.title).not.toBe(prompt);

		stdout.value = "";
		await expect(application.run(["sessions", "--workspace", canonicalWorkspace])).resolves.toBe(0);
		expect(stdout.value).toContain("Readable session picker");
		expect(stdout.value).not.toContain(prompt);
	});

	it("keeps the first Prompt as the listing title when the Model protocol cannot generate one", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-session-title-fallback-"));
		temporaryDirectories.push(workspace);
		const canonicalWorkspace = await realpath(workspace);
		const workspaceId = createHash("sha256").update(canonicalWorkspace).digest("hex").slice(0, 32);
		let id = 0;
		const idGenerator: IdGenerator = { generate: (kind: IdKind) => `${kind}:${++id}` };
		const sessions = new InMemorySessionManager({ clock: { now: () => 1_401 }, idGenerator });
		const runtime = testTimeRuntime(1_401);
		const faux = fauxProvider({ runtime });
		faux.setResponses([fauxAssistantMessage("done", { timestamp: 1_401 })]);
		const models = createModels({ runtime });
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
				clock: { now: () => 1_401 },
				idGenerator,
			},
		});

		const prompt = "Please implement a readable session picker for the /session command";
		await expect(
			application.run([
				"--print",
				"--session",
				"--model",
				`${faux.getModel().provider}/${faux.getModel().id}`,
				prompt,
			]),
		).resolves.toBe(0);
		expect(faux.state.callCount).toBe(1);
		const [summary] = await sessions.listSummaries({ id: workspaceId, path: canonicalWorkspace });
		expect(summary?.title).toBe(prompt);
	});
});
