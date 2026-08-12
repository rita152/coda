import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@coda/ai";
import { afterEach, describe, expect, it } from "vitest";
import { type ApplicationOutput, createCodingAgentApplication } from "../src/application.ts";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import { createNodeProcessRunner } from "../src/host/node-process-runner.ts";
import type { ModelProcessAuthority, ModelProcessSessionRunner } from "../src/permissions/model-process-runner.ts";
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

function controlledRunner() {
	const starts: Array<{
		readonly request: Parameters<ModelProcessSessionRunner["start"]>[0];
		readonly authority: ModelProcessAuthority;
	}> = [];
	let stopCount = 0;
	const runner: ModelProcessSessionRunner = {
		start: async (request, authority) => {
			starts.push({ request, authority });
			request.onOutput?.({
				channel: "stdout",
				text: `${request.environment.SECRET ?? "unset"}|${request.environment.CUSTOM ?? "unset"}\n`,
			});
			let resolveCompletion: ((result: Awaited<ReturnType<typeof completionResult>>) => void) | undefined;
			const completion = new Promise<Awaited<ReturnType<typeof completionResult>>>((resolve) => {
				resolveCompletion = resolve;
			});
			let settled = false;
			const finish = (stopped: boolean) => {
				if (settled) return;
				settled = true;
				resolveCompletion?.(completionResult(stopped));
			};
			return {
				backend: "none",
				completion,
				write: async (input) => {
					request.onOutput?.({ channel: "stdout", text: String(input) });
				},
				closeStdin: async (input) => {
					if (input !== undefined) request.onOutput?.({ channel: "stdout", text: String(input) });
					finish(false);
				},
				stop: async () => {
					stopCount++;
					finish(true);
					return completion;
				},
			};
		},
	};
	return { runner, starts, stopCount: () => stopCount };
}

function completionResult(stopped: boolean) {
	return {
		exitCode: stopped ? null : 0,
		signal: stopped ? ("SIGTERM" as const) : null,
		stdout: "",
		stderr: "",
		timedOut: false,
		truncated: false,
		backend: "none" as const,
	};
}

describe("process lifecycle Tools", () => {
	it("wires start, write, poll, stop, stale handling, filtering, and shutdown cleanup", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-process-tools-"));
		temporaryDirectories.push(workspace);
		const controlled = controlledRunner();
		const faux = fauxProvider({ runtime: testTimeRuntime(1_300) });
		let firstProcessId = "";
		let secondProcessId = "";
		let shutdownProcessId = "";
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("process_start", { command: "worker-one" }, { id: "start-one" }), {
				stopReason: "toolUse",
				timestamp: 1_300,
			}),
			(context) => {
				const result = context.messages.at(-1);
				expect(result).toMatchObject({
					role: "toolResult",
					toolName: "process_start",
					isError: false,
					observation: { status: "ok", facts: { state: "running", processId: expect.any(String) } },
				});
				if (!result || result.role !== "toolResult") throw new Error("Expected process_start result");
				const identity = result.observation?.facts?.processId;
				if (typeof identity !== "string") throw new Error("Expected opaque process identity");
				firstProcessId = identity;
				expect(JSON.stringify(result.details)).not.toContain('"pid"');
				return fauxAssistantMessage(
					fauxToolCall(
						"process_write",
						{ processId: firstProcessId, input: "hello", closeStdin: true },
						{ id: "write-one" },
					),
					{ stopReason: "toolUse", timestamp: 1_300 },
				);
			},
			(context) => {
				expect(context.messages.at(-1)).toMatchObject({
					role: "toolResult",
					toolName: "process_write",
					isError: false,
				});
				return fauxAssistantMessage(
					fauxToolCall("process_poll", { processId: firstProcessId }, { id: "poll-one" }),
					{ stopReason: "toolUse", timestamp: 1_300 },
				);
			},
			(context) => {
				expect(context.messages.at(-1)).toMatchObject({
					role: "toolResult",
					toolName: "process_poll",
					isError: false,
					observation: { status: "ok", truncated: false, facts: { state: "completed", exitCode: 0 } },
					content: [{ type: "text", text: expect.stringContaining("unset|allowed\nhello") }],
				});
				return fauxAssistantMessage(fauxToolCall("process_start", { command: "worker-two" }, { id: "start-two" }), {
					stopReason: "toolUse",
					timestamp: 1_300,
				});
			},
			(context) => {
				const result = context.messages.at(-1);
				if (!result || result.role !== "toolResult") throw new Error("Expected second process_start result");
				const identity = result.observation?.facts?.processId;
				if (typeof identity !== "string") throw new Error("Expected second process identity");
				secondProcessId = identity;
				return fauxAssistantMessage(
					fauxToolCall("process_stop", { processId: secondProcessId }, { id: "stop-two" }),
					{ stopReason: "toolUse", timestamp: 1_300 },
				);
			},
			(context) => {
				expect(context.messages.at(-1)).toMatchObject({
					role: "toolResult",
					toolName: "process_stop",
					isError: false,
					observation: { status: "ok", facts: { state: "stopped", signal: "SIGTERM" } },
				});
				return fauxAssistantMessage(
					fauxToolCall("process_poll", { processId: secondProcessId }, { id: "poll-stale" }),
					{ stopReason: "toolUse", timestamp: 1_300 },
				);
			},
			(context) => {
				expect(context.messages.at(-1)).toMatchObject({
					role: "toolResult",
					toolName: "process_poll",
					isError: true,
					observation: { status: "error", facts: { state: "stale" } },
				});
				return fauxAssistantMessage(
					fauxToolCall("process_start", { command: "worker-shutdown" }, { id: "start-shutdown" }),
					{ stopReason: "toolUse", timestamp: 1_300 },
				);
			},
			(context) => {
				const result = context.messages.at(-1);
				if (!result || result.role !== "toolResult") throw new Error("Expected shutdown process_start result");
				const identity = result.observation?.facts?.processId;
				if (typeof identity !== "string") throw new Error("Expected shutdown process identity");
				shutdownProcessId = identity;
				return fauxAssistantMessage("Process lifecycle complete.", { timestamp: 1_300 });
			},
		]);
		const models = createModels({ runtime: testTimeRuntime(1_300) });
		models.setProvider(faux.provider);
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let nextId = 0;
		const application = createCodingAgentApplication({
			models,
			settings: {
				load: async () => ({ shellEnvironmentAllowlist: ["CUSTOM"] }),
				save: async () => undefined,
			},
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: process.platform }),
			modelProcessSessionRunner: controlled.runner,
			io: { stdin: { isTTY: false, readAll: async () => "" }, stdout, stderr },
			runtime: {
				cwd: workspace,
				homeDirectory: workspace,
				platform: process.platform,
				environment: {
					HOME: workspace,
					PATH: process.env.PATH,
					SHELL: "/bin/sh",
					CUSTOM: "allowed",
					SECRET: "stripped",
				},
				clock: { now: () => 1_300 },
				idGenerator: { generate: (kind) => `${kind}:${++nextId}` },
			},
		});

		await expect(
			application.run([
				"--print",
				"--dangerously-bypass-approvals-and-sandbox",
				"--model",
				`${faux.getModel().provider}/${faux.getModel().id}`,
				"exercise process lifecycle",
			]),
		).resolves.toBe(0);

		expect(firstProcessId).not.toBe(secondProcessId);
		expect(shutdownProcessId).not.toBe("");
		expect(controlled.starts).toHaveLength(3);
		expect(controlled.starts.map(({ request }) => request.environment.SECRET)).toEqual([
			undefined,
			undefined,
			undefined,
		]);
		expect(
			controlled.starts.every(({ authority }) => authority.readAccessPolicy.sandboxPolicy.profile === "full-access"),
		).toBe(true);
		expect(controlled.starts.every(({ authority }) => typeof authority.audit === "function")).toBe(true);
		expect(controlled.starts.every(({ authority }) => typeof authority.sessionId === "string")).toBe(true);
		expect(controlled.stopCount()).toBe(2);
		expect(stdout.value).toBe("Process lifecycle complete.\n");
		expect(stderr.value).toBe("");
	});
});
