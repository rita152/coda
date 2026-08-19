import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@coda/ai";
import type { CodingAgentObservation, WorkItemId } from "@coda/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import { createNodeProcessRunner } from "../src/host/node-process-runner.ts";
import type { ProcessSessionRunner } from "../src/host/process-runner.ts";
import { createWorkspace } from "../src/host/workspace.ts";
import { ProcessSessionManager } from "../src/process/process-session-manager.ts";
import { createWorkspaceWorkCoordinator } from "../src/runtime/workspace-work-coordinator.ts";
import { InMemorySessionManager } from "../src/session/memory-session-manager.ts";
import { CodingSkillsManager } from "../src/skills/manager.ts";
import { testTimeRuntime } from "./time-runtime.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("interactive delegated Work Observation", () => {
	it("delivers child Work Item observations to the parent Session", async () => {
		const { parent, close } = await openDelegatedParent();
		const observations: CodingAgentObservation[] = [];
		const detach = parent.subscribe({
			accept: () => undefined,
			acceptObservation: (observation) => {
				observations.push(observation);
			},
			resynchronize: () => undefined,
		});

		const result = await parent.prompt("delegate one writer");
		expect(result.state).toBe("succeeded");
		detach();

		const childIds = new Set(
			observations.flatMap((observation) => {
				if (observation.type === "item_state_changed") return [String(observation.itemId)];
				if (observation.type === "work_item_event") return [String(observation.itemId)];
				if (observation.type === "work_item_settled") return [String(observation.result.itemId)];
				return [];
			}),
		);
		expect(childIds.has("alpha")).toBe(true);
		expect(observations.some((observation) => observation.type === "item_state_changed")).toBe(true);
		await close();
	});

	it("cancels one child Work Item without claiming side-effect rollback", async () => {
		const { parent, close } = await openDelegatedParent({ holdChild: true });
		const settled: string[] = [];
		const detach = parent.subscribe({
			accept: () => undefined,
			acceptObservation: (observation) => {
				if (observation.type === "item_state_changed" && String(observation.itemId) === "alpha") {
					settled.push(`${observation.itemId}:${observation.to}`);
				}
				if (observation.type === "work_item_settled") {
					settled.push(`${observation.result.itemId}:${observation.result.state}`);
				}
			},
			resynchronize: () => undefined,
		});

		const begun = await parent.beginPrompt("delegate one writer");
		await viWaitFor(() => settled.some((entry) => entry.includes("alpha:running")));
		await parent.cancelItem("alpha" as WorkItemId);
		const result = await begun.result;
		detach();
		expect(["succeeded", "canceled", "failed", "interrupted"]).toContain(result.state);
		expect(settled.some((entry) => /alpha:(canceled|interrupted|failed)/u.test(entry))).toBe(true);
		expect(settled.join(" ")).not.toMatch(/rolled back/i);
		await close();
	});

	it("delivers parallel sibling Work Item observations to the parent Session", async () => {
		const { parent, close } = await openDelegatedParent({ siblings: true });
		const childIds = new Set<string>();
		const detach = parent.subscribe({
			accept: () => undefined,
			acceptObservation: (observation) => {
				if (observation.type === "item_state_changed") childIds.add(String(observation.itemId));
				if (observation.type === "work_item_settled") childIds.add(String(observation.result.itemId));
			},
			resynchronize: () => undefined,
		});
		await expect(parent.prompt("delegate two writers")).resolves.toMatchObject({ state: "succeeded" });
		detach();
		expect(childIds.has("alpha")).toBe(true);
		expect(childIds.has("beta")).toBe(true);
		await close();
	});

	it("keeps the Work Graph moving when a parent observation consumer throws", async () => {
		const { parent, close } = await openDelegatedParent();
		const detach = parent.subscribe({
			accept: () => undefined,
			acceptObservation: () => {
				throw new Error("presentation failed");
			},
			resynchronize: () => undefined,
		});
		await expect(parent.prompt("delegate one writer")).resolves.toMatchObject({ state: "succeeded" });
		detach();
		await close();
	});
});

async function openDelegatedParent(options: { readonly holdChild?: boolean; readonly siblings?: boolean } = {}) {
	const root = await mkdtemp(join(tmpdir(), "coda-delegated-obs-"));
	const home = await mkdtemp(join(tmpdir(), "coda-delegated-obs-home-"));
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
	const hold = options.holdChild
		? (() => {
				let release!: () => void;
				const promise = new Promise<void>((settle) => {
					release = settle;
				});
				return { promise, release };
			})()
		: undefined;
	faux.setResponses(
		options.siblings
			? [
					fauxAssistantMessage(
						fauxToolCall(
							"delegate",
							{
								items: [
									{ itemId: "alpha", objective: "write alpha.txt", executionMode: "write" },
									{ itemId: "beta", objective: "write beta.txt", executionMode: "write" },
								],
							},
							{ id: "delegate:siblings" },
						),
						{ stopReason: "toolUse", timestamp: 10_000 },
					),
					fauxAssistantMessage(
						fauxToolCall("write", { path: "alpha.txt", content: "alpha\n" }, { id: "write:alpha" }),
						{ stopReason: "toolUse", timestamp: 10_000 },
					),
					fauxAssistantMessage("alpha done", { timestamp: 10_000 }),
					fauxAssistantMessage(
						fauxToolCall("write", { path: "beta.txt", content: "beta\n" }, { id: "write:beta" }),
						{ stopReason: "toolUse", timestamp: 10_000 },
					),
					fauxAssistantMessage("beta done", { timestamp: 10_000 }),
					fauxAssistantMessage("parent done", { timestamp: 10_000 }),
				]
			: [
					fauxAssistantMessage(
						fauxToolCall(
							"delegate",
							{
								items: [{ itemId: "alpha", objective: "write alpha.txt", executionMode: "write" }],
							},
							{ id: "delegate:alpha" },
						),
						{ stopReason: "toolUse", timestamp: 10_000 },
					),
					async () => {
						if (hold) await hold.promise;
						return fauxAssistantMessage(
							fauxToolCall("write", { path: "alpha.txt", content: "alpha\n" }, { id: "write:alpha" }),
							{ stopReason: "toolUse", timestamp: 10_000 },
						);
					},
					fauxAssistantMessage("alpha done", { timestamp: 10_000 }),
					fauxAssistantMessage("parent done", { timestamp: 10_000 }),
				],
	);
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
		...(options.siblings ? { capacity: { processMaximumConcurrency: 8, graphMaximumConcurrency: 1 } } : {}),
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
	});
	return {
		parent,
		releaseChild: hold?.release,
		close: async () => {
			hold?.release();
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
