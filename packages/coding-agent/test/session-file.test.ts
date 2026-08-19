import { access, appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool, IdGenerator, IdKind, QueueItemId } from "@coda/agent";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, Type } from "@coda/ai";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import { FileSessionManager } from "../src/session/file-session-manager.ts";
import { createTestAgent } from "./agent-runtime-adapter.ts";
import { testTimeRuntime } from "./time-runtime.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function installEmptyJournal(session: Awaited<ReturnType<FileSessionManager["open"]>>): Promise<string> {
	const { descriptor } = session;
	const path = descriptor.path!;
	await session.close();
	await writeFile(
		path,
		`${JSON.stringify({
			type: "session",
			version: 10,
			sessionId: descriptor.id,
			workspaceId: descriptor.workspace.id,
			workspacePath: descriptor.workspace.path,
			createdAt: descriptor.createdAt,
		})}\n`,
		{ mode: 0o600 },
	);
	return path;
}

describe("JSONL File Session", () => {
	it("accepts a preallocated identity when materializing a new Session", async () => {
		const homeDirectory = await mkdtemp(join(tmpdir(), "coda-session-preallocated-"));
		temporaryDirectories.push(homeDirectory);
		let id = 0;
		const manager = new FileSessionManager({
			fileSystem: createNodeFileSystem(),
			homeDirectory,
			clock: { now: () => 1_165 },
			idGenerator: { generate: (kind) => `${kind}:${++id}` },
			owner: { token: "owner-token", pid: 123, processStartedAt: 1_000, hostname: "test-host" },
			processInspector: { status: async () => "alive" },
		});

		const session = await manager.open({
			workspace: { id: "workspace-hash", path: "/canonical/workspace" },
			mode: "interactive",
			persistent: true,
			createId: "session-preallocated",
		});

		expect(session.descriptor.id).toBe("session-preallocated");
		expect(session.descriptor.path).toContain("session-preallocated.jsonl");
		await session.close();
	});

	it("does not let a provisional identity overwrite an existing journal", async () => {
		const homeDirectory = await mkdtemp(join(tmpdir(), "coda-session-provisional-collision-"));
		temporaryDirectories.push(homeDirectory);
		const workspace = { id: "workspace-hash", path: "/canonical/workspace" };
		const directory = join(homeDirectory, ".coda", "sessions", workspace.id);
		await mkdir(directory, { recursive: true });
		const path = join(directory, "session-existing.jsonl");
		const original = `${JSON.stringify({
			type: "session",
			version: 10,
			sessionId: "session-existing",
			workspaceId: workspace.id,
			workspacePath: workspace.path,
			createdAt: 1_166,
		})}\n`;
		await writeFile(path, original, { mode: 0o600 });
		let id = 0;
		const manager = new FileSessionManager({
			fileSystem: createNodeFileSystem(),
			homeDirectory,
			clock: { now: () => 1_166 },
			idGenerator: { generate: (kind) => `${kind}:${++id}` },
			owner: { token: "owner-token", pid: 123, processStartedAt: 1_000, hostname: "test-host" },
			processInspector: { status: async () => "alive" },
		});

		await expect(
			manager.open({ workspace, mode: "interactive", persistent: true, createId: "session-existing" }),
		).rejects.toThrow("Session already exists");
		expect(await readFile(path, "utf8")).toBe(original);
		await expect(access(`${path}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("keeps a setup-only persistent Session provisional and out of history", async () => {
		const homeDirectory = await mkdtemp(join(tmpdir(), "coda-session-provisional-"));
		temporaryDirectories.push(homeDirectory);
		let id = 0;
		const manager = new FileSessionManager({
			fileSystem: createNodeFileSystem(),
			homeDirectory,
			clock: { now: () => 1_167 },
			idGenerator: { generate: (kind) => `${kind}:${++id}` },
			owner: { token: "owner-token", pid: 123, processStartedAt: 1_000, hostname: "test-host" },
			processInspector: { status: async () => "alive" },
		});
		const workspace = { id: "workspace-hash", path: "/canonical/workspace" };
		const session = await manager.open({ workspace, mode: "interactive", persistent: true });
		const path = session.descriptor.path!;

		await session.record({
			type: "model_selected",
			model: { provider: "openai", id: "gpt-test" },
			reasoning: "off",
		});

		expect(session.hasRetainedActivity).toBe(false);
		await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await manager.list(workspace)).toEqual([]);
		expect(await manager.listSummaries(workspace)).toEqual([]);
		await session.close();
		await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(access(`${path}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("materializes buffered setup records when the first Composer Submission is accepted", async () => {
		const homeDirectory = await mkdtemp(join(tmpdir(), "coda-session-materialize-"));
		temporaryDirectories.push(homeDirectory);
		let id = 0;
		const manager = new FileSessionManager({
			fileSystem: createNodeFileSystem(),
			homeDirectory,
			clock: { now: () => 1_168 },
			idGenerator: { generate: (kind) => `${kind}:${++id}` },
			owner: { token: "owner-token", pid: 123, processStartedAt: 1_000, hostname: "test-host" },
			processInspector: { status: async () => "alive" },
		});
		const workspace = { id: "workspace-hash", path: "/canonical/workspace" };
		const session = await manager.open({ workspace, mode: "interactive", persistent: true });
		const path = session.descriptor.path!;
		await session.record({
			type: "model_selected",
			model: { provider: "openai", id: "gpt-test" },
			reasoning: "high",
		});
		await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });

		await session.record({
			type: "composer_submission_recorded",
			submission: { id: "submission:materialize", kind: "prompt", text: "Persist this conversation" },
		});

		expect(session.hasRetainedActivity).toBe(true);
		const lines = (await readFile(path, "utf8"))
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lines.map(({ type }) => type)).toEqual(["session", "model_selected", "composer_submission_recorded"]);
		expect(await manager.listSummaries(workspace)).toEqual([
			expect.objectContaining({
				title: "Persist this conversation",
				promptCount: 1,
				model: { provider: "openai", id: "gpt-test" },
			}),
		]);
		await session.close();
	});

	it("persists a generated Session Title and prefers it in the listing", async () => {
		const homeDirectory = await mkdtemp(join(tmpdir(), "coda-session-title-"));
		temporaryDirectories.push(homeDirectory);
		let id = 0;
		const manager = new FileSessionManager({
			fileSystem: createNodeFileSystem(),
			homeDirectory,
			clock: { now: () => 1_171 },
			idGenerator: { generate: (kind) => `${kind}:${++id}` },
			owner: { token: "owner-token", pid: 123, processStartedAt: 1_000, hostname: "test-host" },
			processInspector: { status: async () => "alive" },
		});
		const workspace = { id: "workspace-hash", path: "/canonical/workspace" };
		const session = await manager.open({ workspace, mode: "interactive", persistent: true });
		await session.record({
			type: "composer_submission_recorded",
			submission: { id: "submission:title", kind: "prompt", text: "Please implement a readable session picker" },
		});
		await session.record({ type: "session_title_set", title: "Readable session picker" });
		expect(session.title).toBe("Readable session picker");
		const sessionId = session.descriptor.id;
		await session.close();

		expect(await manager.listSummaries(workspace)).toEqual([
			expect.objectContaining({ title: "Readable session picker", promptCount: 1 }),
		]);
		const restored = await manager.open({ workspace, mode: "interactive", resumeId: sessionId });
		expect(restored.title).toBe("Readable session picker");
		await restored.close();
	});

	it("hides legacy setup-only journals without making direct resume destructive", async () => {
		const homeDirectory = await mkdtemp(join(tmpdir(), "coda-session-hidden-legacy-"));
		temporaryDirectories.push(homeDirectory);
		const workspace = { id: "workspace-hash", path: "/canonical/workspace" };
		const directory = join(homeDirectory, ".coda", "sessions", workspace.id);
		await mkdir(directory, { recursive: true });
		const sessionId = "session-legacy-setup-only";
		const path = join(directory, `${sessionId}.jsonl`);
		await writeFile(
			path,
			`${[
				JSON.stringify({
					type: "session",
					version: 10,
					sessionId,
					workspaceId: workspace.id,
					workspacePath: workspace.path,
					createdAt: 1_169,
				}),
				JSON.stringify({
					type: "model_selected",
					recordId: "record:legacy-setup-only",
					sessionId,
					sequence: 1,
					previousRecordId: null,
					timestamp: 1_169,
					payload: { model: { provider: "anthropic", id: "claude-test" }, reasoning: "off" },
				}),
			].join("\n")}\n`,
			{ mode: 0o600 },
		);
		let id = 0;
		const manager = new FileSessionManager({
			fileSystem: createNodeFileSystem(),
			homeDirectory,
			clock: { now: () => 1_170 },
			idGenerator: { generate: (kind) => `${kind}:${++id}` },
			owner: { token: "owner-token", pid: 123, processStartedAt: 1_000, hostname: "test-host" },
			processInspector: { status: async () => "alive" },
		});

		expect(await manager.list(workspace)).toEqual([]);
		expect(await manager.listSummaries(workspace)).toEqual([]);
		const resumed = await manager.open({ workspace, mode: "interactive", resumeId: sessionId });
		expect(resumed.restored).toMatchObject({ model: { provider: "anthropic", id: "claude-test" } });
		await resumed.close();
		await expect(access(path)).resolves.toBeUndefined();
	});

	it("round-trips Composer extension references through the current validated JSONL journal", async () => {
		const homeDirectory = await mkdtemp(join(tmpdir(), "coda-session-references-"));
		temporaryDirectories.push(homeDirectory);
		let id = 0;
		const manager = new FileSessionManager({
			fileSystem: createNodeFileSystem(),
			homeDirectory,
			clock: { now: () => 1_170 },
			idGenerator: { generate: (kind) => `${kind}:${++id}` },
			owner: { token: "owner-token", pid: 123, processStartedAt: 1_000, hostname: "test-host" },
			processInspector: { status: async () => "alive" },
		});
		const session = await manager.open({
			workspace: { id: "workspace-hash", path: "/canonical/workspace" },
			mode: "interactive",
		});
		const references = [
			{
				id: "extension-reference:file",
				commandId: "skill:review",
				source: "skill" as const,
				name: "review",
				start: 4,
				end: 11,
			},
		];
		await session.record({
			type: "composer_submission_recorded",
			submission: { id: "submission:file", kind: "prompt", text: "Use /review", references },
		});
		const sessionId = session.descriptor.id;
		await session.close();
		expect(await manager.listSummaries({ id: "workspace-hash", path: "/canonical/workspace" })).toEqual([
			expect.objectContaining({
				title: "Use /review",
				updatedAt: 1_170,
				promptCount: 1,
				descriptor: expect.objectContaining({ id: sessionId }),
			}),
		]);

		const restored = await manager.open({
			workspace: { id: "workspace-hash", path: "/canonical/workspace" },
			mode: "interactive",
			resumeId: sessionId,
		});
		expect(restored.composerSubmissions).toEqual([
			{ id: "submission:file", kind: "prompt", text: "Use /review", references },
		]);
		await restored.close();
	});

	it("keeps empty Session v1 through v10 journals readable while upgrading them to v11", async () => {
		const homeDirectory = await mkdtemp(join(tmpdir(), "coda-session-all-migrations-"));
		temporaryDirectories.push(homeDirectory);
		const directory = join(homeDirectory, ".coda", "sessions", "workspace-hash");
		await mkdir(directory, { recursive: true });
		for (const version of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const) {
			const sessionId = `session-v${version}`;
			await writeFile(
				join(directory, `${sessionId}.jsonl`),
				`${JSON.stringify({
					type: "session",
					version,
					sessionId,
					workspaceId: "workspace-hash",
					workspacePath: "/canonical/workspace",
					createdAt: 1_175,
				})}\n`,
				{ mode: 0o600 },
			);
		}
		let id = 0;
		const manager = new FileSessionManager({
			fileSystem: createNodeFileSystem(),
			homeDirectory,
			clock: { now: () => 1_176 },
			idGenerator: { generate: (kind) => `${kind}:${++id}` },
			owner: { token: "owner-token", pid: 123, processStartedAt: 1_000, hostname: "test-host" },
			processInspector: { status: async () => "alive" },
		});

		for (const version of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const) {
			const sessionId = `session-v${version}`;
			const restored = await manager.open({
				workspace: { id: "workspace-hash", path: "/canonical/workspace" },
				mode: "interactive",
				resumeId: sessionId,
			});
			expect(restored.composerSubmissions).toEqual([]);
			await restored.close();
			expect(JSON.parse((await readFile(join(directory, `${sessionId}.jsonl`), "utf8")).trim())).toMatchObject({
				version: 11,
			});
		}
	});

	it("indexes durable media attached to a paused Follow-up by queue identity", async () => {
		const homeDirectory = await mkdtemp(join(tmpdir(), "coda-session-follow-up-media-"));
		temporaryDirectories.push(homeDirectory);
		let id = 0;
		const manager = new FileSessionManager({
			fileSystem: createNodeFileSystem(),
			homeDirectory,
			clock: { now: () => 1_190 },
			idGenerator: { generate: (kind) => `${kind}:${++id}` },
			owner: { token: "owner-token", pid: 123, processStartedAt: 1_000, hostname: "test-host" },
			processInspector: { status: async () => "alive" },
		});
		const session = await manager.open({
			workspace: { id: "workspace-hash", path: "/canonical/workspace" },
			mode: "interactive",
		});
		const queueId = "queue:media" as QueueItemId;
		const image = await sharp({ create: { width: 8, height: 9, channels: 3, background: "#123456" } })
			.png()
			.toBuffer();
		await session.record({
			type: "follow_up_enqueued",
			item: {
				id: queueId,
				content: [
					{ type: "text", text: "inspect" },
					{ type: "image", data: image.toString("base64"), mimeType: "image/png" },
				],
			},
		});
		const sessionId = session.descriptor.id;
		await session.close();

		const restored = await manager.open({
			workspace: { id: "workspace-hash", path: "/canonical/workspace" },
			mode: "interactive",
			resumeId: sessionId,
		});
		expect(restored.mediaReferences.get(queueId)).toEqual([
			expect.objectContaining({ type: "media", width: 8, height: 9, mimeType: "image/png" }),
		]);
		expect(restored.seed.pendingFollowUps[0]?.content).toEqual([
			{ type: "text", text: "inspect" },
			{ type: "image", data: image.toString("base64"), mimeType: "image/png" },
		]);
		await restored.close();
	});

	it("writes private linear records and syncs tool_started before execute()", async () => {
		const homeDirectory = await mkdtemp(join(tmpdir(), "coda-session-"));
		temporaryDirectories.push(homeDirectory);
		let id = 0;
		const idGenerator: IdGenerator = { generate: (kind: IdKind) => `${kind}:${++id}` };
		const manager = new FileSessionManager({
			fileSystem: createNodeFileSystem(),
			homeDirectory,
			clock: { now: () => 1_200 },
			idGenerator,
			owner: { token: "owner-token", pid: 123, processStartedAt: 1_000, hostname: "test-host" },
			processInspector: { status: async () => "alive" },
		});
		const session = await manager.open({
			workspace: { id: "workspace-hash", path: "/canonical/workspace" },
			mode: "interactive",
		});
		await session.record({
			type: "prepare_run",
			promptVersion: "coda-system-prompt-v1",
			promptSha256: "b".repeat(64),
		});

		const parameters = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof parameters> = {
			name: "barrier",
			description: "verify persistence barrier",
			parameters,
			replaySafety: "never",
			execute: async () => {
				const journal = await readFile(session.descriptor.path!, "utf8");
				expect(journal).toContain('"type":"tool_started"');
				return { content: "barrier observed" };
			},
		};
		const runtime = testTimeRuntime(1_200);
		const faux = createFauxCore({ runtime });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("barrier", { value: "go" }, { id: "provider-barrier" }), {
				stopReason: "toolUse",
				timestamp: 1_200,
			}),
			fauxAssistantMessage("done", { timestamp: 1_200 }),
		]);
		const agent = createTestAgent({
			clock: { now: () => 1_200 },
			idGenerator,
			tools: [tool],
			stream: ({ context, signal }) => faux.streamSimple(faux.getModel(), context, { signal, runtime }),
		});
		agent.onSemanticEvent((event) => session.accept(event));
		await agent.prompt("persist tool lifecycle");
		const sessionId = session.descriptor.id;
		const sessionPath = session.descriptor.path!;
		await session.close();

		expect((await stat(sessionPath)).mode & 0o777).toBe(0o600);
		const lines = (await readFile(sessionPath, "utf8"))
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lines[0]).toMatchObject({ type: "session", version: 11, sessionId });
		const records = lines.slice(1);
		expect(records.map((record) => record.sequence)).toEqual(records.map((_, index) => index + 1));
		expect(records[0].previousRecordId).toBeNull();
		for (let index = 1; index < records.length; index++) {
			expect(records[index].previousRecordId).toBe(records[index - 1].recordId);
		}
		expect(records.find((record) => record.type === "tool_finished")?.payload).toMatchObject({
			settlement: "returned",
			outcome: "success",
		});
		expect(
			records.find(
				(record) => record.type === "message_committed" && record.payload?.message?.message?.role === "toolResult",
			)?.payload,
		).toMatchObject({ message: { message: { observation: { status: "ok", truncated: false } } } });
		await expect(access(`${sessionPath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });

		const restored = await manager.open({
			workspace: { id: "workspace-hash", path: "/canonical/workspace" },
			mode: "interactive",
			resumeId: sessionId,
		});
		expect(restored.seed.messages.map(({ message }) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
		expect(restored.seed.messages.find(({ message }) => message.role === "toolResult")?.message).toMatchObject({
			observation: { status: "ok", truncated: false },
		});
		await restored.close();
	});

	it("atomically migrates v1 inline images to v11 media references while preserving a backup", async () => {
		const homeDirectory = await mkdtemp(join(tmpdir(), "coda-session-migration-"));
		temporaryDirectories.push(homeDirectory);
		const directory = join(homeDirectory, ".coda", "sessions", "workspace-hash");
		await mkdir(directory, { recursive: true });
		const sessionId = "session-legacy";
		const path = join(directory, `${sessionId}.jsonl`);
		const imageBytes = await sharp({ create: { width: 32, height: 24, channels: 3, background: "#336699" } })
			.png()
			.toBuffer();
		const imageData = imageBytes.toString("base64");
		const legacyText = `${[
			{
				type: "session",
				version: 1,
				sessionId,
				workspaceId: "workspace-hash",
				workspacePath: "/canonical/workspace",
				createdAt: 1_210,
			},
			{
				type: "message_committed",
				recordId: "record:legacy:1",
				sessionId,
				sequence: 1,
				previousRecordId: null,
				timestamp: 1_210,
				payload: {
					message: {
						id: "message:legacy:user",
						message: {
							role: "user",
							content: [
								{ type: "text", text: "describe" },
								{ type: "image", data: imageData, mimeType: "image/png" },
							],
							timestamp: 1_210,
						},
					},
				},
			},
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n")}\n`;
		await writeFile(path, legacyText, { mode: 0o600 });
		let id = 0;
		const diagnostics: string[] = [];
		const manager = new FileSessionManager({
			fileSystem: createNodeFileSystem(),
			homeDirectory,
			clock: { now: () => 1_220 },
			idGenerator: { generate: (kind) => `${kind}:${++id}` },
			owner: { token: "owner-token", pid: 123, processStartedAt: 1_000, hostname: "test-host" },
			processInspector: { status: async () => "alive" },
			diagnostics: async (diagnostic) => {
				diagnostics.push(diagnostic.code);
			},
		});

		const resumed = await manager.open({
			workspace: { id: "workspace-hash", path: "/canonical/workspace" },
			mode: "interactive",
			resumeId: sessionId,
		});
		const restoredContent = resumed.seed.messages[0]?.message.content;
		expect(Array.isArray(restoredContent) ? restoredContent[1] : undefined).toEqual({
			type: "image",
			data: imageData,
			mimeType: "image/png",
		});
		await resumed.close();

		const migrated = await readFile(path, "utf8");
		expect(JSON.parse(migrated.split("\n")[0]!)).toMatchObject({ version: 11 });
		expect(migrated).not.toContain(imageData);
		expect(migrated).toContain('"type":"media"');
		expect(await readFile(`${path}.v1.backup`, "utf8")).toBe(legacyText);
		expect(diagnostics).toContain("session.migrated");
		const mediaEntry = JSON.parse(migrated.split("\n")[1]!).payload.message.message.content[1];
		const mediaPath = join(`${path}.media`, `${mediaEntry.digest}.model.png`);
		expect((await stat(mediaPath)).mode & 0o777).toBe(0o600);
	});

	it("atomically upgrades a v2 journal to v11 before accepting reclaimed Follow-up records", async () => {
		const homeDirectory = await mkdtemp(join(tmpdir(), "coda-session-v3-migration-"));
		temporaryDirectories.push(homeDirectory);
		const directory = join(homeDirectory, ".coda", "sessions", "workspace-hash");
		await mkdir(directory, { recursive: true });
		const sessionId = "session-v2";
		const path = join(directory, `${sessionId}.jsonl`);
		const legacyText = `${JSON.stringify({
			type: "session",
			version: 2,
			sessionId,
			workspaceId: "workspace-hash",
			workspacePath: "/canonical/workspace",
			createdAt: 1_230,
		})}\n`;
		await writeFile(path, legacyText, { mode: 0o600 });
		let id = 0;
		const diagnostics: string[] = [];
		const manager = new FileSessionManager({
			fileSystem: createNodeFileSystem(),
			homeDirectory,
			clock: { now: () => 1_231 },
			idGenerator: { generate: (kind) => `${kind}:${++id}` },
			owner: { token: "owner-token", pid: 123, processStartedAt: 1_000, hostname: "test-host" },
			processInspector: { status: async () => "alive" },
			diagnostics: async (diagnostic) => {
				diagnostics.push(diagnostic.code);
			},
		});

		const resumed = await manager.open({
			workspace: { id: "workspace-hash", path: "/canonical/workspace" },
			mode: "interactive",
			resumeId: sessionId,
		});
		await resumed.close();

		expect(JSON.parse((await readFile(path, "utf8")).trim())).toMatchObject({ version: 11 });
		expect(await readFile(`${path}.v2.backup`, "utf8")).toBe(legacyText);
		expect(diagnostics).toContain("session.migrated");
	});

	it("atomically upgrades a v3 journal to v11 and preserves a v3 backup", async () => {
		const homeDirectory = await mkdtemp(join(tmpdir(), "coda-session-v4-migration-"));
		temporaryDirectories.push(homeDirectory);
		const directory = join(homeDirectory, ".coda", "sessions", "workspace-hash");
		await mkdir(directory, { recursive: true });
		const sessionId = "session-v3";
		const path = join(directory, `${sessionId}.jsonl`);
		const legacyText = `${JSON.stringify({
			type: "session",
			version: 3,
			sessionId,
			workspaceId: "workspace-hash",
			workspacePath: "/canonical/workspace",
			createdAt: 1_232,
		})}\n`;
		await writeFile(path, legacyText, { mode: 0o600 });
		let id = 0;
		const diagnostics: string[] = [];
		const manager = new FileSessionManager({
			fileSystem: createNodeFileSystem(),
			homeDirectory,
			clock: { now: () => 1_233 },
			idGenerator: { generate: (kind) => `${kind}:${++id}` },
			owner: { token: "owner-token", pid: 123, processStartedAt: 1_000, hostname: "test-host" },
			processInspector: { status: async () => "alive" },
			diagnostics: async (diagnostic) => {
				diagnostics.push(diagnostic.code);
			},
		});

		const resumed = await manager.open({
			workspace: { id: "workspace-hash", path: "/canonical/workspace" },
			mode: "interactive",
			resumeId: sessionId,
		});
		await resumed.close();

		expect(JSON.parse((await readFile(path, "utf8")).trim())).toMatchObject({ version: 11 });
		expect(await readFile(`${path}.v3.backup`, "utf8")).toBe(legacyText);
		expect(diagnostics).toContain("session.migrated");
	});

	it("durably classifies an active Run as interrupted before resuming", async () => {
		const homeDirectory = await mkdtemp(join(tmpdir(), "coda-session-interrupted-"));
		temporaryDirectories.push(homeDirectory);
		let id = 0;
		const manager = new FileSessionManager({
			fileSystem: createNodeFileSystem(),
			homeDirectory,
			clock: { now: () => 1_250 },
			idGenerator: { generate: (kind) => `${kind}:${++id}` },
			owner: { token: "owner-token", pid: 123, processStartedAt: 1_000, hostname: "test-host" },
			processInspector: { status: async () => "alive" },
		});
		const created = await manager.open({
			workspace: { id: "workspace-hash", path: "/canonical/workspace" },
			mode: "interactive",
		});
		const sessionId = created.descriptor.id;
		const path = await installEmptyJournal(created);
		await appendFile(
			path,
			`${JSON.stringify({
				type: "run_started",
				recordId: "record:crashed-run",
				sessionId,
				sequence: 1,
				previousRecordId: null,
				timestamp: 1_240,
				runId: "run:crashed",
				payload: { source: "prompt" },
			})}\n`,
			"utf8",
		);

		const resumed = await manager.open({
			workspace: { id: "workspace-hash", path: "/canonical/workspace" },
			mode: "interactive",
			resumeId: sessionId,
		});
		await resumed.close();

		const records = (await readFile(path, "utf8"))
			.trimEnd()
			.split("\n")
			.slice(1)
			.map((line) => JSON.parse(line));
		expect(records.at(-1)).toMatchObject({
			type: "run_finished",
			sequence: 2,
			previousRecordId: "record:crashed-run",
			runId: "run:crashed",
			payload: { outcome: "interrupted", reason: "process_ended_before_run_finished" },
		});
	});

	it("requires an interactive decision and can durably skip an Interrupted Tool Invocation", async () => {
		const homeDirectory = await mkdtemp(join(tmpdir(), "coda-session-tool-recovery-"));
		temporaryDirectories.push(homeDirectory);
		let id = 0;
		const manager = new FileSessionManager({
			fileSystem: createNodeFileSystem(),
			homeDirectory,
			clock: { now: () => 1_275 },
			idGenerator: { generate: (kind) => `${kind}:${++id}` },
			owner: { token: "owner-token", pid: 123, processStartedAt: 1_000, hostname: "test-host" },
			processInspector: { status: async () => "alive" },
			interruptedToolRecovery: async (request) => {
				expect(request.invocation).toMatchObject({
					id: "invocation:crashed",
					providerToolCallId: "provider:crashed",
					toolName: "write",
					replaySafety: "never",
				});
				return "skip";
			},
		});
		const created = await manager.open({
			workspace: { id: "workspace-hash", path: "/canonical/workspace" },
			mode: "interactive",
		});
		const sessionId = created.descriptor.id;
		const path = await installEmptyJournal(created);
		const records = [
			{
				type: "run_started",
				runId: "run:crashed",
				payload: { source: "prompt" },
			},
			{
				type: "message_committed",
				runId: "run:crashed",
				payload: {
					message: {
						id: "message:user",
						message: { role: "user", content: "write it", timestamp: 1_270 },
					},
				},
			},
			{
				type: "message_committed",
				runId: "run:crashed",
				turnId: "turn:crashed",
				payload: {
					message: {
						id: "message:assistant",
						message: fauxAssistantMessage(
							fauxToolCall("write", { path: "x.txt", content: "x" }, { id: "provider:crashed" }),
							{ stopReason: "toolUse", timestamp: 1_270 },
						),
					},
				},
			},
			{
				type: "tool_started",
				runId: "run:crashed",
				turnId: "turn:crashed",
				payload: {
					invocation: {
						id: "invocation:crashed",
						resultMessageId: "message:tool-result",
						providerToolCallId: "provider:crashed",
						toolName: "write",
						arguments: { path: "x.txt", content: "x" },
						sourceIndex: 0,
						replaySafety: "never",
					},
				},
			},
		];
		let previousRecordId: string | null = null;
		for (const [index, record] of records.entries()) {
			const recordId = `record:crash:${index + 1}`;
			await appendFile(
				path,
				`${JSON.stringify({
					...record,
					recordId,
					sessionId,
					sequence: index + 1,
					previousRecordId,
					timestamp: 1_270,
				})}\n`,
				"utf8",
			);
			previousRecordId = recordId;
		}

		const resumed = await manager.open({
			workspace: { id: "workspace-hash", path: "/canonical/workspace" },
			mode: "interactive",
			resumeId: sessionId,
		});
		expect(resumed.seed.messages.map(({ message }) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(resumed.seed.messages.at(-1)?.message).toMatchObject({
			role: "toolResult",
			toolCallId: "provider:crashed",
			details: { interrupted: true, recovery: "skipped", sideEffects: "unknown" },
		});
		await resumed.close();

		const persisted = (await readFile(path, "utf8"))
			.trimEnd()
			.split("\n")
			.slice(1)
			.map((line) => JSON.parse(line));
		expect(persisted.slice(-3).map((record) => record.type)).toEqual([
			"tool_finished",
			"message_committed",
			"run_finished",
		]);
	});

	it("can re-execute a safe Interrupted Tool Invocation with a new identity", async () => {
		const homeDirectory = await mkdtemp(join(tmpdir(), "coda-session-tool-reexecute-"));
		temporaryDirectories.push(homeDirectory);
		let id = 0;
		const manager = new FileSessionManager({
			fileSystem: createNodeFileSystem(),
			homeDirectory,
			clock: { now: () => 1_276 },
			idGenerator: { generate: (kind) => `${kind}:${++id}` },
			owner: { token: "owner-token", pid: 123, processStartedAt: 1_000, hostname: "test-host" },
			processInspector: { status: async () => "alive" },
			interruptedToolRecovery: async (request) => {
				expect(request.invocation).toMatchObject({
					id: "invocation:crashed",
					providerToolCallId: "provider:crashed",
					toolName: "read",
					replaySafety: "safe",
				});
				return "re-execute";
			},
			recoveryTools: async () => [
				{
					name: "read",
					description: "read",
					parameters: Type.Object({ path: Type.String() }, { additionalProperties: false }),
					replaySafety: "safe" as const,
					execute: ({ path }: { path: string }) => ({ content: `re-executed:${path}` }),
				},
			],
		});
		const created = await manager.open({
			workspace: { id: "workspace-hash", path: "/canonical/workspace" },
			mode: "interactive",
		});
		const sessionId = created.descriptor.id;
		const path = await installEmptyJournal(created);
		const records = [
			{
				type: "run_started",
				runId: "run:crashed",
				payload: { source: "prompt" },
			},
			{
				type: "message_committed",
				runId: "run:crashed",
				payload: {
					message: {
						id: "message:user",
						message: { role: "user", content: "read it", timestamp: 1_276 },
					},
				},
			},
			{
				type: "message_committed",
				runId: "run:crashed",
				turnId: "turn:crashed",
				payload: {
					message: {
						id: "message:assistant",
						message: fauxAssistantMessage(fauxToolCall("read", { path: "x.txt" }, { id: "provider:crashed" }), {
							stopReason: "toolUse",
							timestamp: 1_276,
						}),
					},
				},
			},
			{
				type: "tool_started",
				runId: "run:crashed",
				turnId: "turn:crashed",
				payload: {
					invocation: {
						id: "invocation:crashed",
						resultMessageId: "message:tool-result",
						providerToolCallId: "provider:crashed",
						toolName: "read",
						arguments: { path: "x.txt" },
						sourceIndex: 0,
						replaySafety: "safe",
					},
				},
			},
		];
		let previousRecordId: string | null = null;
		for (const [index, record] of records.entries()) {
			const recordId = `record:crash:${index + 1}`;
			await appendFile(
				path,
				`${JSON.stringify({
					...record,
					recordId,
					sessionId,
					sequence: index + 1,
					previousRecordId,
					timestamp: 1_276,
				})}\n`,
				"utf8",
			);
			previousRecordId = recordId;
		}

		const resumed = await manager.open({
			workspace: { id: "workspace-hash", path: "/canonical/workspace" },
			mode: "interactive",
			resumeId: sessionId,
		});
		expect(resumed.seed.messages.map(({ message }) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(resumed.seed.messages.at(-1)?.message).toMatchObject({
			role: "toolResult",
			toolCallId: "provider:crashed",
			content: [{ type: "text", text: "re-executed:x.txt" }],
		});
		await resumed.close();

		const persisted = (await readFile(path, "utf8"))
			.trimEnd()
			.split("\n")
			.slice(1)
			.map((line) => JSON.parse(line));
		expect(persisted.slice(-5).map((record) => record.type)).toEqual([
			"tool_finished",
			"tool_started",
			"tool_finished",
			"message_committed",
			"run_finished",
		]);
		expect(persisted.at(-4).payload.invocation.id).not.toBe("invocation:crashed");
		expect(persisted.at(-4).payload.invocation.providerToolCallId).toBe("provider:crashed");
	});

	it("refuses a structurally valid line whose typed payload violates the v1 schema", async () => {
		const homeDirectory = await mkdtemp(join(tmpdir(), "coda-session-invalid-payload-"));
		temporaryDirectories.push(homeDirectory);
		let id = 0;
		const manager = new FileSessionManager({
			fileSystem: createNodeFileSystem(),
			homeDirectory,
			clock: { now: () => 1_290 },
			idGenerator: { generate: (kind) => `${kind}:${++id}` },
			owner: { token: "owner-token", pid: 123, processStartedAt: 1_000, hostname: "test-host" },
			processInspector: { status: async () => "alive" },
		});
		const created = await manager.open({
			workspace: { id: "workspace-hash", path: "/canonical/workspace" },
			mode: "interactive",
		});
		const sessionId = created.descriptor.id;
		const path = await installEmptyJournal(created);
		await appendFile(
			path,
			`${JSON.stringify({
				type: "message_committed",
				recordId: "record:invalid-payload",
				sessionId,
				sequence: 1,
				previousRecordId: null,
				timestamp: 1_290,
				payload: {},
			})}\n`,
			"utf8",
		);

		await expect(
			manager.open({
				workspace: { id: "workspace-hash", path: "/canonical/workspace" },
				mode: "interactive",
				resumeId: sessionId,
			}),
		).rejects.toThrow("typed payload");
	});

	it.each([
		["run_started", { source: "prompt", unexpected: true }],
		["attempt_started", { messageId: "message:1" }],
		["attempt_finished", { messageId: "message:1", attempt: 1, outcome: "unknown", discarded: true }],
		["retry_scheduled", { attempt: 1, delayMs: "soon", reason: "network" }],
		[
			"message_committed",
			{
				message: { id: "message:1", message: { role: "user", content: "hello", timestamp: 1 } },
				unexpected: true,
			},
		],
		[
			"tool_started",
			{
				invocation: {
					id: "invocation:1",
					resultMessageId: "message:2",
					providerToolCallId: "provider:1",
					toolName: "read",
					arguments: {},
					sourceIndex: 0,
					unexpected: true,
				},
			},
		],
		[
			"tool_finished",
			{
				invocation: {
					id: "invocation:1",
					resultMessageId: "message:2",
					providerToolCallId: "provider:1",
					toolName: "read",
					arguments: {},
					sourceIndex: 0,
				},
				resultMessageId: "message:2",
			},
		],
		["turn_finished", {}],
		["run_finished", {}],
		["follow_up_enqueued", { item: { id: "queue:1", content: "next", unexpected: true } }],
		["follow_up_consumed", { id: "queue:1", unexpected: true }],
		["follow_up_canceled", { id: "queue:1", unexpected: true }],
		["model_selected", { model: { provider: "faux", id: "faux-1", unexpected: true }, reasoning: "off" }],
		[
			"project_trust_changed",
			{ trust: { workspace: "/workspace", path: "/workspace/AGENTS.md", sha256: "a".repeat(64), unexpected: true } },
		],
	] as const)("rejects non-exact %s payloads", async (type, payload) => {
		const homeDirectory = await mkdtemp(join(tmpdir(), "coda-session-exact-payload-"));
		temporaryDirectories.push(homeDirectory);
		let id = 0;
		const manager = new FileSessionManager({
			fileSystem: createNodeFileSystem(),
			homeDirectory,
			clock: { now: () => 1_295 },
			idGenerator: { generate: (kind) => `${kind}:${++id}` },
			owner: { token: "owner-token", pid: 123, processStartedAt: 1_000, hostname: "test-host" },
			processInspector: { status: async () => "alive" },
		});
		const created = await manager.open({
			workspace: { id: "workspace-hash", path: "/canonical/workspace" },
			mode: "interactive",
		});
		const sessionId = created.descriptor.id;
		const path = await installEmptyJournal(created);
		await appendFile(
			path,
			`${JSON.stringify({
				type,
				recordId: `record:invalid-${type}`,
				sessionId,
				sequence: 1,
				previousRecordId: null,
				timestamp: 1_295,
				payload,
			})}\n`,
			"utf8",
		);

		await expect(
			manager.open({
				workspace: { id: "workspace-hash", path: "/canonical/workspace" },
				mode: "interactive",
				resumeId: sessionId,
			}),
		).rejects.toThrow("typed payload");
	});
});
