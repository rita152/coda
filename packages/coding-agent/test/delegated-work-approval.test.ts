import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@coda/ai";
import type { McpElicitationResult, McpToolLease } from "@coda/mcp";
import { createCommandPermissionPolicy } from "@coda/permission";
import type { LifecycleHookHost } from "@coda/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { PermissionLifecycleHookHost } from "../src/hooks/permission-host.ts";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import { createNodeProcessRunner } from "../src/host/node-process-runner.ts";
import type { ProcessSessionRunner } from "../src/host/process-runner.ts";
import { createWorkspace } from "../src/host/workspace.ts";
import type { CodingMcpRegistry } from "../src/mcp/registry.ts";
import { ProcessSessionManager } from "../src/process/process-session-manager.ts";
import { createWorkspaceWorkCoordinator } from "../src/runtime/workspace-work-coordinator.ts";
import { InMemorySessionManager } from "../src/session/memory-session-manager.ts";
import { CodingSkillsManager } from "../src/skills/manager.ts";
import { testTimeRuntime } from "./time-runtime.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("interactive delegated Work approval", () => {
	it("answers a child Command Permission ask on the parent Session ask port", async () => {
		const asked: string[] = [];
		const hooks = new PermissionLifecycleHookHost({
			inner: inertHooks(),
			policy: createCommandPermissionPolicy({ approvalPolicy: "untrusted" }),
			ask: async (request) => {
				asked.push(`${request.sessionId}:${request.toolName}`);
				return { action: "allow" };
			},
		});
		const { parent, close } = await openDelegatedParent({
			lifecycleHooks: hooks,
			responses: [
				fauxAssistantMessage(
					fauxToolCall(
						"delegate",
						{ items: [{ itemId: "alpha", objective: "run a command", executionMode: "write" }] },
						{ id: "delegate:alpha" },
					),
					{ stopReason: "toolUse", timestamp: 10_000 },
				),
				fauxAssistantMessage(fauxToolCall("bash", { command: "npm test" }, { id: "bash:alpha" }), {
					stopReason: "toolUse",
					timestamp: 10_000,
				}),
				fauxAssistantMessage("alpha done", { timestamp: 10_000 }),
				fauxAssistantMessage("parent done", { timestamp: 10_000 }),
			],
		});
		await expect(parent.prompt("delegate a dangerous command")).resolves.toMatchObject({ state: "succeeded" });
		expect(asked.some((entry) => entry.toLowerCase().endsWith(":bash"))).toBe(true);
		expect(asked.join(" ")).not.toMatch(/rolled back/i);
		await close();
	});

	it("answers a child MCP Elicitation on the parent Session handler", async () => {
		const answers: McpElicitationResult[] = [];
		const { parent, close } = await openDelegatedParent({
			mcpRegistry: fakeElicitingRegistry(),
			mcpElicitation: async () => {
				const result = { action: "accept" as const, content: { ok: true } };
				answers.push(result);
				return result;
			},
			responses: [
				fauxAssistantMessage(
					fauxToolCall(
						"delegate",
						{ items: [{ itemId: "alpha", objective: "confirm deploy", executionMode: "write" }] },
						{ id: "delegate:alpha" },
					),
					{ stopReason: "toolUse", timestamp: 10_000 },
				),
				fauxAssistantMessage(fauxToolCall("mcp__ask__confirm", {}, { id: "mcp:alpha" }), {
					stopReason: "toolUse",
					timestamp: 10_000,
				}),
				fauxAssistantMessage("alpha done", { timestamp: 10_000 }),
				fauxAssistantMessage("parent done", { timestamp: 10_000 }),
			],
		});
		await expect(parent.prompt("delegate confirmation")).resolves.toMatchObject({ state: "succeeded" });
		expect(answers).toEqual([{ action: "accept", content: { ok: true } }]);
		await close();
	});

	it("cancels the Work Graph without claiming side-effect rollback", async () => {
		let release!: () => void;
		const held = new Promise<void>((settle) => {
			release = settle;
		});
		const { parent, close } = await openDelegatedParent({
			responses: [
				fauxAssistantMessage(
					fauxToolCall(
						"delegate",
						{ items: [{ itemId: "alpha", objective: "write alpha", executionMode: "write" }] },
						{ id: "delegate:alpha" },
					),
					{ stopReason: "toolUse", timestamp: 10_000 },
				),
				async () => {
					await held;
					return fauxAssistantMessage(
						fauxToolCall("write", { path: "alpha.txt", content: "alpha\n" }, { id: "write:alpha" }),
						{ stopReason: "toolUse", timestamp: 10_000 },
					);
				},
				fauxAssistantMessage("alpha done", { timestamp: 10_000 }),
				fauxAssistantMessage("parent done", { timestamp: 10_000 }),
			],
		});
		const settled: string[] = [];
		const detach = parent.subscribe({
			accept: () => undefined,
			acceptObservation: (observation) => {
				if (observation.type === "item_state_changed" && String(observation.itemId) === "alpha") {
					settled.push(`${observation.itemId}:${observation.to}`);
				}
			},
			resynchronize: () => undefined,
		});
		const begun = await parent.beginPrompt("delegate one writer");
		await viWaitFor(() => settled.some((entry) => entry.includes("alpha:running")));
		await parent.cancel();
		release();
		const result = await begun.result;
		detach();
		expect(["canceled", "interrupted", "failed", "succeeded"]).toContain(result.state);
		expect(JSON.stringify(result)).not.toMatch(/rolled back/i);
		await close();
	});
});

function inertHooks(): LifecycleHookHost {
	return {
		sessionStart: async () => ({ continue: true }),
		sessionEnd: async () => undefined,
		userPromptSubmit: async () => ({ continue: true }),
		preToolUse: async () => ({ continue: true }),
		postToolUse: async () => ({ continue: true }),
		preCompact: async () => ({ continue: true }),
		postCompact: async () => ({ continue: true }),
		stop: async () => ({ continue: true }),
		subagentStart: async () => ({ continue: true }),
		subagentStop: async () => ({ continue: true }),
		takeAdditionalContext: () => [],
		close: async () => undefined,
	};
}

function fakeElicitingRegistry(): CodingMcpRegistry {
	const toolId = "mcp:ask:confirm";
	const lease: McpToolLease = {
		revision: 1,
		servers: [{ id: "ask", status: "ready", toolCount: 1 }],
		tools: [
			{
				id: toolId,
				serverId: "ask",
				remoteName: "confirm",
				name: "mcp__ask__confirm",
				description: "Confirm",
				inputSchema: { type: "object", properties: {} },
			},
		],
		callTool: async (request) => {
			await request.elicit?.({
				mode: "form",
				message: "Confirm?",
				requestedSchema: { type: "object", properties: {} },
			});
			return { isError: false, content: [{ type: "text", text: "confirmed" }] };
		},
		dispose: async () => undefined,
	};
	return {
		refresh: async () => undefined,
		acquireTools: () => lease,
		selectedToolIds: () => new Set([toolId]),
	} as unknown as CodingMcpRegistry;
}

async function openDelegatedParent(options: {
	readonly responses: readonly unknown[];
	readonly lifecycleHooks?: LifecycleHookHost;
	readonly mcpRegistry?: CodingMcpRegistry;
	readonly mcpElicitation?: Parameters<
		Awaited<ReturnType<typeof createWorkspaceWorkCoordinator>>["open"]
	>[0]["mcpElicitation"];
	readonly capacity?: { readonly processMaximumConcurrency: number; readonly graphMaximumConcurrency: number };
}) {
	const root = await mkdtemp(join(tmpdir(), "coda-delegated-approval-"));
	const home = await mkdtemp(join(tmpdir(), "coda-delegated-approval-home-"));
	temporaryDirectories.push(root, home);
	const commandRunner = createNodeProcessRunner({ platform: process.platform });
	const environment = Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
	for (const args of [
		["init"],
		["config", "user.name", "Coda Test"],
		["config", "user.email", "coda-test@localhost"],
		["commit", "--allow-empty", "-m", "initial"],
	]) {
		const result = await commandRunner.run({
			executable: "git",
			args,
			cwd: root,
			environment,
			signal: new AbortController().signal,
			timeoutMs: 30_000,
			maxOutputBytes: 1_048_576,
			maxOutputLines: 10_000,
		});
		if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
	}
	const time = testTimeRuntime(10_000);
	const faux = fauxProvider({ runtime: time });
	faux.setResponses(options.responses as never);
	const models = createModels({ runtime: time });
	models.setProvider(faux.provider);
	const fileSystem = createNodeFileSystem();
	const workspace = await createWorkspace(root, fileSystem);
	let nextId = 0;
	const idGenerator = { generate: (kind: string) => `${kind}:${++nextId}` };
	const sessions = new InMemorySessionManager({ clock: time.clock, idGenerator });
	const session = await sessions.open({ workspace: { id: "workspace:test", path: workspace.root }, mode: "print" });
	const skillsManager = new CodingSkillsManager({ fileSystem, roots: [] });
	await skillsManager.refresh();
	const processSessionManager = new ProcessSessionManager({
		fileSystem,
		homeDirectory: root,
		runner: {
			start: async () => {
				throw new Error("No Process starts are expected");
			},
		} satisfies ProcessSessionRunner,
		idGenerator,
	});
	const coordinator = createWorkspaceWorkCoordinator({
		workspace,
		fileSystem,
		processRunner: commandRunner,
		processSessionManager,
		shellExecutable: "/bin/sh",
		hostRuntime: { homeDirectory: home, environment },
		skillsManager,
		models,
		clock: time.clock,
		idGenerator,
		platform: process.platform,
		interactionMode: "print",
		...(options.capacity ? { capacity: options.capacity } : {}),
		...(options.lifecycleHooks ? { lifecycleHooks: options.lifecycleHooks } : {}),
		...(options.mcpRegistry ? { mcpRegistry: options.mcpRegistry } : {}),
		openPrivateSession: (sessionId) =>
			sessions.open({
				workspace: { id: "workspace:test", path: workspace.root },
				mode: "print",
				createId: sessionId,
				persistent: false,
			}),
	});
	const parent = await coordinator.open({
		session,
		selection: { model: faux.getModel(), reasoning: "off", authSnapshot: { auth: {} } },
		...(options.mcpElicitation ? { mcpElicitation: options.mcpElicitation } : {}),
	});
	return {
		parent,
		close: async () => {
			await parent.close();
			await coordinator.close();
			await processSessionManager.close();
		},
	};
}

async function viWaitFor(assert: () => boolean, timeoutMs = 5_000): Promise<void> {
	const started = Date.now();
	while (true) {
		if (assert()) return;
		if (Date.now() - started > timeoutMs) throw new Error("condition not met");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
