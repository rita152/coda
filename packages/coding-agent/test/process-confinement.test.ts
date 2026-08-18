import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionContext } from "@coda/agent";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@coda/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ApplicationOutput, createCodingAgentApplication } from "../src/application.ts";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import type { ProcessRunRequest } from "../src/host/process-runner.ts";
import { createBashTool } from "../src/tools/bash.ts";
import { stableCompletionWorkspaceEvidence } from "./completion-test-helpers.ts";
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

describe("Bash Process Confinement", () => {
	it("wraps the script before the host ProcessRunner runs", async () => {
		const runs: Array<{ readonly executable: string; readonly args: readonly string[] }> = [];
		const tool = createBashTool({
			workspace: {
				root: "/workspace",
				resolvePath: async (requestedPath) => ({
					requestedPath,
					lexicalPath: requestedPath,
					canonicalPath: requestedPath,
					exists: true,
					insideWorkspace: true,
				}),
			},
			fileSystem: {
				readFile: async () => new Uint8Array(),
			} as never,
			processRunner: {
				run: async (request) => {
					runs.push({ executable: request.executable, args: request.args });
					return {
						exitCode: 0,
						signal: null,
						stdout: "ok",
						stderr: "",
						timedOut: false,
						truncated: false,
					};
				},
			},
			shellExecutable: "/bin/zsh",
			runtime: {
				homeDirectory: "/home",
				environment: { PATH: "/usr/bin", HOME: "/home" },
			},
			wrapScript: async ({ command, shell }) => ({
				executable: "/usr/bin/srt",
				args: [shell, "-c", command],
				environment: { PATH: "/usr/bin", SANDBOX_RUNTIME: "1" },
			}),
		});

		const output = await tool.execute(
			{ command: "npm test" },
			{
				runId: "run-1" as ToolExecutionContext["runId"],
				turnId: "turn-1" as ToolExecutionContext["turnId"],
				invocationId: "inv-1" as ToolExecutionContext["invocationId"],
				resultMessageId: "msg-1" as ToolExecutionContext["resultMessageId"],
				providerToolCallId: "call-1",
				signal: new AbortController().signal,
			},
		);
		expect(output.content).toBe("ok");
		expect(runs).toEqual([{ executable: "/usr/bin/srt", args: ["/bin/zsh", "-c", "npm test"] }]);
	});

	it("skips Process Confinement when sandbox_permissions is require_escalated", async () => {
		const runs: Array<{ readonly executable: string; readonly args: readonly string[] }> = [];
		const wrapScript = vi.fn(async () => ({
			executable: "/usr/bin/srt",
			args: ["/bin/zsh", "-c", "curl example.test"],
			environment: { PATH: "/usr/bin" },
		}));
		const tool = createBashTool({
			workspace: {
				root: "/workspace",
				resolvePath: async (requestedPath) => ({
					requestedPath,
					lexicalPath: requestedPath,
					canonicalPath: requestedPath,
					exists: true,
					insideWorkspace: true,
				}),
			},
			fileSystem: {
				readFile: async () => new Uint8Array(),
			} as never,
			processRunner: {
				run: async (request) => {
					runs.push({ executable: request.executable, args: request.args });
					return {
						exitCode: 0,
						signal: null,
						stdout: "ok",
						stderr: "",
						timedOut: false,
						truncated: false,
					};
				},
			},
			shellExecutable: "/bin/zsh",
			runtime: {
				homeDirectory: "/home",
				environment: { PATH: "/usr/bin", HOME: "/home" },
			},
			wrapScript,
		});

		await tool.execute(
			{ command: "curl example.test", sandbox_permissions: "require_escalated" },
			{
				runId: "run-1" as ToolExecutionContext["runId"],
				turnId: "turn-1" as ToolExecutionContext["turnId"],
				invocationId: "inv-1" as ToolExecutionContext["invocationId"],
				resultMessageId: "msg-1" as ToolExecutionContext["resultMessageId"],
				providerToolCallId: "call-1",
				signal: new AbortController().signal,
			},
		);
		expect(wrapScript).not.toHaveBeenCalled();
		expect(runs[0]?.executable).toBe("/bin/zsh");
	});
});

describe("Process Confinement application integration", () => {
	it("uses an injected wrapScript seam for Bash", async () => {
		const root = await mkdtemp(join(tmpdir(), "coda-sandbox-app-"));
		temporaryDirectories.push(root);
		const runs: ProcessRunRequest[] = [];
		const faux = fauxProvider({ runtime: testTimeRuntime(1_000) });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "printf confined" }, { id: "confined-bash" }), {
				stopReason: "toolUse",
				timestamp: 1_000,
			}),
			(context) => {
				expect(context.messages.at(-1)).toMatchObject({
					role: "toolResult",
					toolCallId: "confined-bash",
					content: [{ type: "text", text: "ok" }],
				});
				return fauxAssistantMessage("confined", { timestamp: 1_000 });
			},
		]);
		const models = createModels({ runtime: testTimeRuntime(1_000) });
		models.setProvider(faux.provider);
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let identity = 0;
		const application = createCodingAgentApplication({
			models,
			settings: { load: async () => ({}), save: async () => undefined },
			fileSystem: createNodeFileSystem(),
			processRunner: {
				run: async (request) => {
					runs.push(request);
					if (request.executable !== "/usr/bin/srt") {
						return {
							exitCode: 1,
							signal: null,
							stdout: "",
							stderr: "",
							timedOut: false,
							truncated: false,
						};
					}
					return {
						exitCode: 0,
						signal: null,
						stdout: "ok",
						stderr: "",
						timedOut: false,
						truncated: false,
					};
				},
			},
			processConfinement: {
				wrapScript: async ({ command, shell, environment }) => ({
					executable: "/usr/bin/srt",
					args: [shell, "-c", command],
					environment: { ...environment, SANDBOX_RUNTIME: "1" },
				}),
				close: async () => undefined,
			},
			completionWorkspaceEvidence: stableCompletionWorkspaceEvidence(1_000),
			io: { stdin: { isTTY: false, readAll: async () => "" }, stdout, stderr },
			runtime: {
				cwd: root,
				homeDirectory: root,
				platform: process.platform,
				environment: { HOME: root, PATH: process.env.PATH, SHELL: "/bin/zsh" },
				clock: { now: () => 1_000 },
				idGenerator: { generate: (kind) => `${kind}:${++identity}` },
			},
		});

		await expect(
			application.run(["--print", "--model", `${faux.getModel().provider}/${faux.getModel().id}`, "run bash"]),
		).resolves.toBe(0);
		expect(stdout.value).toBe("confined\n");
		expect(runs.filter((run) => run.executable === "/usr/bin/srt")).toEqual([
			expect.objectContaining({
				executable: "/usr/bin/srt",
				args: ["/bin/zsh", "-c", "printf confined"],
				environment: expect.objectContaining({ SANDBOX_RUNTIME: "1" }),
			}),
		]);
	});
});
