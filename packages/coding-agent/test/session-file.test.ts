import { access, appendFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentTool, type IdGenerator, type IdKind } from "@coda/agent";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, Type } from "@coda/ai";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import { FileSessionManager } from "../src/session/file-session-manager.ts";
import { testTimeRuntime } from "./time-runtime.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("JSONL File Session", () => {
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
		const agent = new Agent({
			clock: { now: () => 1_200 },
			idGenerator,
			tools: [tool],
			policyGate: { check: async () => ({ decision: "allow" }) },
			stream: ({ context, signal }) => faux.streamSimple(faux.getModel(), context, { signal, runtime }),
		});
		session.attach(agent);
		await agent.prompt("persist tool lifecycle");
		const sessionId = session.descriptor.id;
		const sessionPath = session.descriptor.path!;
		await session.close();

		expect((await stat(sessionPath)).mode & 0o777).toBe(0o600);
		const lines = (await readFile(sessionPath, "utf8"))
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lines[0]).toMatchObject({ type: "session", version: 1, sessionId });
		const records = lines.slice(1);
		expect(records.map((record) => record.sequence)).toEqual(records.map((_, index) => index + 1));
		expect(records[0].previousRecordId).toBeNull();
		for (let index = 1; index < records.length; index++) {
			expect(records[index].previousRecordId).toBe(records[index - 1].recordId);
		}
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
		await restored.close();
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
		const path = created.descriptor.path!;
		await created.close();
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
		const path = created.descriptor.path!;
		await created.close();
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
			isError: true,
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
		const path = created.descriptor.path!;
		await created.close();
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
		const path = created.descriptor.path!;
		await created.close();
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
