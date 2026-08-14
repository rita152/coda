import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@coda/ai";
import type { CodingAgentSnapshot } from "@coda/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import { createNodeProcessRunner } from "../src/host/node-process-runner.ts";
import type { ProcessSessionRunner } from "../src/host/process-runner.ts";
import { ProcessSessionManager } from "../src/process/process-session-manager.ts";
import { createWorkspaceWorkCoordinator } from "../src/runtime/workspace-work-coordinator.ts";
import { InMemorySessionManager } from "../src/session/memory-session-manager.ts";
import { CodingSkillsManager } from "../src/skills/manager.ts";
import { createWorkspace } from "../src/workspace.ts";
import { testTimeRuntime } from "./time-runtime.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

describe("Session Work Controller", () => {
	it("composes Git worktrees in production, isolates simultaneous Session transcripts, and resumes one Session later", async () => {
		const root = await mkdtemp(join(tmpdir(), "coda-session-work-"));
		const home = await mkdtemp(join(tmpdir(), "coda-session-work-home-"));
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
		const firstGate = deferred();
		const secondGate = deferred();
		const contexts: string[] = [];
		faux.setResponses([
			async (context) => {
				contexts.push(JSON.stringify(context.messages));
				await firstGate.promise;
				return fauxAssistantMessage("first session answer", { timestamp: 10_000 });
			},
			async (context) => {
				contexts.push(JSON.stringify(context.messages));
				await secondGate.promise;
				return fauxAssistantMessage("second session answer", { timestamp: 10_000 });
			},
			(context) => {
				contexts.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("first session resumed", { timestamp: 10_000 });
			},
			fauxAssistantMessage(
				fauxToolCall(
					"delegate",
					{
						items: [
							{
								itemId: "direct-writer",
								objective: "write delegated.txt",
								executionMode: "write",
							},
						],
					},
					{ id: "delegate:direct-writer" },
				),
				{ stopReason: "toolUse", timestamp: 10_000 },
			),
			fauxAssistantMessage(
				fauxToolCall("write", { path: "delegated.txt", content: "delegated\n" }, { id: "write:delegated" }),
				{ stopReason: "toolUse", timestamp: 10_000 },
			),
			fauxAssistantMessage("delegated writer complete", { timestamp: 10_000 }),
			fauxAssistantMessage("parent observed delegated completion", { timestamp: 10_000 }),
			fauxAssistantMessage("stalled observer did not block", { timestamp: 10_000 }),
		]);
		const models = createModels({ runtime: time });
		models.setProvider(faux.provider);
		const fileSystem = createNodeFileSystem();
		const workspace = await createWorkspace(root, fileSystem);
		let nextId = 0;
		const idGenerator = { generate: (kind: string) => `${kind}:${++nextId}` };
		const sessions = new InMemorySessionManager({ clock: time.clock, idGenerator });
		const firstSession = await sessions.open({
			workspace: { id: "workspace:test", path: workspace.root },
			mode: "print",
		});
		const secondSession = await sessions.open({
			workspace: { id: "workspace:test", path: workspace.root },
			mode: "print",
		});
		const skillsManager = new CodingSkillsManager({ fileSystem, roots: [] });
		await skillsManager.refresh();
		const processSessionRunner: ProcessSessionRunner = {
			start: async () => {
				throw new Error("No Process starts are expected");
			},
		};
		const processSessionManager = new ProcessSessionManager({
			fileSystem,
			homeDirectory: root,
			runner: processSessionRunner,
			idGenerator,
		});
		const coordinator = createWorkspaceWorkCoordinator({
			workspace,
			fileSystem,
			processRunner: commandRunner,
			processSessionManager,
			shellExecutable: "/bin/sh",
			hostRuntime: {
				homeDirectory: home,
				environment,
			},
			skillsManager,
			models,
			clock: time.clock,
			idGenerator,
			platform: process.platform,
			interactionMode: "print",
		});
		const selection = {
			model: faux.getModel(),
			reasoning: "off" as const,
			authSnapshot: { auth: {} },
		};
		const first = await coordinator.open({ session: firstSession, selection });
		const second = await coordinator.open({ session: secondSession, selection });
		await expect(coordinator.open({ session: firstSession, selection })).rejects.toThrow(
			"Session is already open in this Workspace",
		);

		const begunFirst = await first.beginPrompt("first private prompt");
		const begunSecond = await second.beginPrompt("second private prompt");
		await vi.waitFor(() => expect(faux.state.callCount).toBe(2));
		expect(first.isBusy()).toBe(true);
		expect(second.isBusy()).toBe(true);
		expect(first.state().activePlacement).toMatchObject({ kind: "git_worktree" });
		expect(first.state().activePlacement?.root).not.toBe(root);
		expect(second.state().activePlacement).toMatchObject({ kind: "git_worktree" });
		expect(contexts[0]).toContain("first private prompt");
		expect(contexts[0]).not.toContain("second private prompt");
		expect(contexts[1]).toContain("second private prompt");
		expect(contexts[1]).not.toContain("first private prompt");

		secondGate.resolve();
		firstGate.resolve();
		const [firstResult, secondResult] = await Promise.all([begunFirst.result, begunSecond.result]);
		expect(firstResult.sessionId).not.toBe(secondResult.sessionId);
		expect(firstResult.runtimeId).not.toBe(secondResult.runtimeId);

		const resumed = await first.prompt("resume only the first session");
		expect(resumed.sessionId).toBe(firstResult.sessionId);
		expect(resumed.runtimeId).not.toBe(firstResult.runtimeId);
		expect(contexts[2]).toContain("first private prompt");
		expect(contexts[2]).toContain("first session answer");
		expect(contexts[2]).toContain("resume only the first session");
		expect(contexts[2]).not.toContain("second private prompt");

		const delegated = await first.prompt("delegate one Git Workspace writer");
		expect(delegated.state).toBe("succeeded");
		expect(delegated.placement.kind).toBe("git_worktree");
		expect(delegated.publication.state).toBe("published");
		expect(await readFile(join(root, "delegated.txt"), "utf8")).toBe("delegated\n");
		const observerStarted = deferred();
		const observerRelease = deferred();
		const observerResynchronized = deferred();
		let failedObserverCalls = 0;
		const detachFailedObserver = first.subscribe({
			accept: () => {
				failedObserverCalls++;
				throw new Error("failed presentation consumer");
			},
			resynchronize: () => {
				throw new Error("failed presentation consumer");
			},
		});
		const detachObserver = first.subscribe(
			{
				accept: async () => {
					observerStarted.resolve();
					await observerRelease.promise;
				},
				resynchronize: ({ reason, seed }) => {
					expect(reason).toBe("slow_consumer");
					expect(seed.messages.at(-1)?.message.role).toBe("assistant");
					observerResynchronized.resolve();
				},
			},
			{ capacity: 4 },
		);
		const observerIsolated = await first.beginPrompt("prove the public observation projection is isolated");
		const observerGraphId = first.state().activeGraphId;
		if (!observerGraphId) throw new Error("Observer isolation Work Graph did not become active");
		await observerStarted.promise;
		const observerResult = await observerIsolated.result;
		expect(observerResult.state).toBe("succeeded");
		observerRelease.resolve();
		await observerResynchronized.promise;
		expect(failedObserverCalls).toBe(1);
		detachFailedObserver();
		detachObserver();

		const upstreamActive = deferred();
		const upstreamTerminal = deferred();
		const detachUpstreamObserver = first.subscribe({
			accept: () => undefined,
			resynchronize: ({ reason, state, seed }) => {
				expect(reason).toBe("upstream_resync");
				expect(seed.messages.at(-1)?.message.role).toBe("assistant");
				if (state.activeGraphId === observerGraphId) upstreamActive.resolve();
				else if (state.status === "idle") upstreamTerminal.resolve();
			},
		});
		const activeItem = {
			itemId: observerResult.itemId,
			dependencies: [],
			objective: "resynchronize active Work",
			executionMode: "write",
			state: "running",
			desiredConfiguration: {
				model: { provider: selection.model.provider, id: selection.model.id },
				reasoning: "off",
			},
			runtimeId: observerResult.runtimeId,
			activeRun: { id: "run:resynchronized", source: "prompt" },
			sessionId: observerResult.sessionId,
			placement: observerResult.placement,
			cancellationRequested: false,
		};
		first.resynchronize({
			closed: false,
			graphs: [{ graphId: observerGraphId, items: [activeItem] }],
		} as unknown as CodingAgentSnapshot);
		await upstreamActive.promise;
		expect(first.state()).toMatchObject({
			status: "running",
			activeGraphId: observerGraphId,
			activeItemId: observerResult.itemId,
			activePlacement: observerResult.placement,
			activeRun: { id: "run:resynchronized", source: "prompt" },
		});
		first.resynchronize({
			closed: false,
			graphs: [
				{
					graphId: observerGraphId,
					items: [{ ...activeItem, state: "succeeded", result: observerResult }],
					result: {},
				},
			],
		} as unknown as CodingAgentSnapshot);
		await upstreamTerminal.promise;
		expect(first.state().status).toBe("idle");
		expect(first.state().activeGraphId).toBeUndefined();
		detachUpstreamObserver();

		await first.close();
		await second.close();
		await coordinator.close();
		await processSessionManager.close();
	}, 15_000);
});
