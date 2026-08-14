import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentEvent, AgentSeed, AgentTool, ToolExecutionOutput } from "@coda/agent";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@coda/ai";
import {
	type CodingAgent,
	createRunCapabilityHost,
	type OpenCodingAgentOptions,
	openCodingAgent,
	type WorkGraphResult,
} from "@coda/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeProcessRunner } from "../src/host/node-process-runner.ts";
import { createGitWorktreeWorkspaceExecution } from "../src/runtime/git-worktree-workspace-execution.ts";
import { testTimeRuntime } from "./time-runtime.ts";

const executeFile = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

function environment(): Record<string, string> {
	return Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
}

async function waitForGraph(agent: CodingAgent, graphId: string): Promise<WorkGraphResult> {
	for await (const observation of agent.observe({ capacity: 4_096 })) {
		if (observation.type === "work_graph_settled" && observation.result.graphId === graphId) {
			return observation.result;
		}
	}
	throw new Error(`Work Graph ${graphId} did not settle`);
}

describe("Git worktree Work Graph end to end", () => {
	it(
		"runs delegated sibling writers concurrently and publishes them in accepted source order",
		{ timeout: 15_000 },
		async () => {
			const temporary = await mkdtemp(join(tmpdir(), "coda-git-work-graph-"));
			temporaryDirectories.push(temporary);
			const sourceRoot = join(temporary, "repository");
			const stateRoot = join(temporary, "state");
			await mkdir(sourceRoot);
			await mkdir(stateRoot);
			await executeFile("git", ["init", "-q"], { cwd: sourceRoot });
			await executeFile("git", ["config", "user.name", "Coda Test"], { cwd: sourceRoot });
			await executeFile("git", ["config", "user.email", "coda-test@localhost"], { cwd: sourceRoot });
			await writeFile(join(sourceRoot, "base.txt"), "base\n", "utf8");
			await executeFile("git", ["add", "base.txt"], { cwd: sourceRoot });
			await executeFile("git", ["commit", "-qm", "base"], { cwd: sourceRoot });

			const alphaGate = deferred();
			const betaGate = deferred();
			const bothStarted = deferred();
			const betaCompleted = deferred();
			const started: string[] = [];
			const completed: string[] = [];
			const tools = async (
				request: Parameters<Parameters<typeof createGitWorktreeWorkspaceExecution>[0]["createTools"]>[0],
			) => {
				const writeFixture: AgentTool = {
					name: "write_fixture",
					description: "Write one integration-test file in this Work Item's Workspace Placement",
					parameters: Type.Object(
						{ path: Type.String(), content: Type.String() },
						{ additionalProperties: false },
					),
					replaySafety: "never",
					execute: async (arguments_): Promise<ToolExecutionOutput> => {
						const input = arguments_ as { readonly path: string; readonly content: string };
						if (input.path !== "alpha.txt" && input.path !== "beta.txt") {
							throw new Error(`Unexpected fixture path: ${input.path}`);
						}
						started.push(input.path);
						if (started.length === 2) bothStarted.resolve();
						await (input.path === "alpha.txt" ? alphaGate.promise : betaGate.promise);
						await writeFile(join(request.placement.root, input.path), input.content, "utf8");
						completed.push(input.path);
						if (input.path === "beta.txt") betaCompleted.resolve();
						return { content: `wrote ${input.path}` };
					},
				};
				return [{ tool: writeFixture, effect: "write" as const }];
			};
			const gitExecution = await createGitWorktreeWorkspaceExecution({
				sourceRoot,
				stateRoot,
				processRunner: createNodeProcessRunner({ platform: process.platform }),
				environment: environment(),
				createTools: tools,
			});
			const publications: string[] = [];
			const workspaceExecution: OpenCodingAgentOptions["workspaceExecution"] = {
				...gitExecution,
				publish: async (request) => {
					const result = await gitExecution.publish(request);
					publications.push(String(request.itemId));
					return result;
				},
			};

			const time = testTimeRuntime(20_000);
			const faux = fauxProvider({ runtime: time });
			faux.setResponses([
				fauxAssistantMessage(
					fauxToolCall(
						"delegate",
						{
							items: [
								{ itemId: "alpha", objective: "write alpha", executionMode: "write" },
								{ itemId: "beta", objective: "write beta", executionMode: "write" },
							],
						},
						{ id: "delegate:parallel-writers" },
					),
					{ stopReason: "toolUse", timestamp: 20_000 },
				),
				fauxAssistantMessage(
					fauxToolCall("write_fixture", { path: "alpha.txt", content: "alpha\n" }, { id: "write:alpha" }),
					{ stopReason: "toolUse", timestamp: 20_000 },
				),
				fauxAssistantMessage(
					fauxToolCall("write_fixture", { path: "beta.txt", content: "beta\n" }, { id: "write:beta" }),
					{ stopReason: "toolUse", timestamp: 20_000 },
				),
				fauxAssistantMessage("beta complete", { timestamp: 20_000 }),
				fauxAssistantMessage("alpha complete", { timestamp: 20_000 }),
				fauxAssistantMessage("root integrated delegated results", { timestamp: 20_000 }),
			]);
			const models = createModels({ runtime: time });
			models.setProvider(faux.provider);
			const leasedSessions = new Set<string>();
			const sessions: OpenCodingAgentOptions["sessions"] = {
				reserve: async (request) => {
					const id = request.target.sessionId ?? `session:${String(request.graphId)}:${String(request.itemId)}`;
					if (leasedSessions.has(id)) throw new Error(`Session already leased: ${id}`);
					leasedSessions.add(id);
					let closed = false;
					const session = {
						id,
						seed: { version: 1, messages: [], pendingFollowUps: [] } satisfies AgentSeed,
						accept: (_event: AgentEvent) => undefined,
						record: () => Promise.resolve(),
						close: async () => {
							if (closed) return;
							closed = true;
							leasedSessions.delete(id);
						},
					};
					return {
						session,
						commit: () => Promise.resolve(),
						rollback: () => session.close(),
						evidence: () => undefined,
					};
				},
			};
			let nextId = 0;
			const runCapabilities = createRunCapabilityHost({
				model: {
					acquire: (selection) => {
						const driver = models.bindSimple(selection.model, selection.authSnapshot ?? { auth: {} });
						return {
							model: driver.model,
							revision: String(driver.providerGeneration),
							stream: driver.stream,
							complete: driver.complete,
							dispose: () => undefined,
						};
					},
				},
				contributors: [],
				now: time.clock.now,
				platform: process.platform,
				interactionMode: "evaluation",
			});
			const agent = await openCodingAgent({
				workspaceExecution,
				sessions,
				runCapabilities,
				resolveConfiguration: () => ({ model: faux.getModel(), reasoning: "off", authSnapshot: { auth: {} } }),
				clock: time.clock,
				idGenerator: { generate: (kind) => `${kind}:${++nextId}` },
				processMaximumConcurrency: 3,
				platform: process.platform,
				interactionMode: "evaluation",
			});
			await agent.submit({
				commands: [
					{
						type: "start_work_graph",
						graphId: "graph:git-e2e",
						objective: "delegate two independent file writes",
						root: { itemId: "root", executionMode: "write" },
						maximumConcurrency: 3,
						configuration: {
							model: { provider: faux.getModel().provider, id: faux.getModel().id },
							reasoning: "off",
						},
						session: { type: "create", sessionId: "session:git-root" },
					},
				],
			});

			await bothStarted.promise;
			expect(started).toEqual(["alpha.txt", "beta.txt"]);
			betaGate.resolve();
			await betaCompleted.promise;
			expect(completed).toEqual(["beta.txt"]);
			expect(publications).toEqual([]);
			alphaGate.resolve();
			const result = await waitForGraph(agent, "graph:git-e2e");

			expect(completed).toEqual(["beta.txt", "alpha.txt"]);
			expect(publications).toEqual(["alpha", "beta", "root"]);
			expect(result.results.map(({ itemId }) => itemId)).toEqual(["root", "alpha", "beta"]);
			expect(result.results.map(({ state }) => state)).toEqual(["succeeded", "succeeded", "succeeded"]);
			expect(result.effectiveConcurrency).toBe(2);
			expect(new Set(result.results.map(({ runtimeId }) => runtimeId)).size).toBe(3);
			expect(new Set(result.results.map(({ sessionId }) => sessionId)).size).toBe(3);
			expect(await readFile(join(sourceRoot, "alpha.txt"), "utf8")).toBe("alpha\n");
			expect(await readFile(join(sourceRoot, "beta.txt"), "utf8")).toBe("beta\n");
			await agent.close();
			expect(leasedSessions.size).toBe(0);
		},
	);
});
