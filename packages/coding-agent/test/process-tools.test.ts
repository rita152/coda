import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@coda/ai";
import { createSystemScheduler, type KeyInput, VirtualTerminal } from "@coda/tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ApplicationOutput, createCodingAgentApplication } from "../src/application.ts";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import { createNodeProcessRunner } from "../src/host/node-process-runner.ts";
import type { ProcessSessionRunner } from "../src/host/process-runner.ts";
import { testTimeRuntime } from "./time-runtime.ts";

class BufferOutput implements ApplicationOutput {
	readonly isTTY: boolean;
	value = "";
	constructor(isTTY = false) {
		this.isTTY = isTTY;
	}

	write(chunk: string): void {
		this.value += chunk;
	}
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function controlledRunner() {
	const starts: Array<{ readonly request: Parameters<ProcessSessionRunner["start"]>[0] }> = [];
	let stopCount = 0;
	const runner: ProcessSessionRunner = {
		start: async (request) => {
			starts.push({ request });
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
	};
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

describe("process lifecycle Tools", () => {
	it("wires start, write, poll, stop, stale handling, environment inheritance, and shutdown cleanup", async () => {
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
					content: [{ type: "text", text: expect.stringContaining("inherited|allowed\nhello") }],
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
				load: async () => ({}),
				save: async () => undefined,
			},
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: process.platform }),
			processSessionRunner: controlled.runner,
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
					SECRET: "inherited",
				},
				clock: { now: () => 1_300 },
				idGenerator: { generate: (kind) => `${kind}:${++nextId}` },
			},
		});

		await expect(
			application.run([
				"--print",
				"--model",
				`${faux.getModel().provider}/${faux.getModel().id}`,
				"exercise process lifecycle",
			]),
		).resolves.toBe(0);

		expect(firstProcessId).not.toBe(secondProcessId);
		expect(shutdownProcessId).not.toBe("");
		expect(controlled.starts).toHaveLength(3);
		expect(controlled.starts.map(({ request }) => request.environment.SECRET)).toEqual([
			"inherited",
			"inherited",
			"inherited",
		]);
		expect(controlled.stopCount()).toBe(2);
		expect(stdout.value).toBe("Process lifecycle complete.\n");
		expect(stderr.value).toBe("");
	});

	it("cancels a Work Item during a retained Process lifetime and quiesces the Process before settlement", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-process-cancel-"));
		temporaryDirectories.push(workspace);
		const controlled = controlledRunner();
		const responseGate = deferred();
		const secondCallStarted = deferred();
		const runtime = testTimeRuntime(1_400);
		const faux = fauxProvider({ runtime });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("process_start", { command: "long-worker" }, { id: "start-long" }), {
				stopReason: "toolUse",
				timestamp: 1_400,
			}),
			async () => {
				secondCallStarted.resolve();
				await responseGate.promise;
				return fauxAssistantMessage("unreachable after cancellation", { timestamp: 1_400 });
			},
		]);
		const models = createModels({ runtime });
		models.setProvider(faux.provider);
		const terminal = new VirtualTerminal({ columns: 100, rows: 28 });
		const stdout = new BufferOutput(true);
		const stderr = new BufferOutput(true);
		let nextId = 0;
		const application = createCodingAgentApplication({
			models,
			settings: { load: async () => ({}), save: async () => undefined },
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: process.platform }),
			processSessionRunner: controlled.runner,
			terminalFactory: { create: () => terminal },
			io: { stdin: { isTTY: true, readAll: async () => "" }, stdout, stderr },
			runtime: {
				cwd: workspace,
				homeDirectory: workspace,
				platform: process.platform,
				environment: { HOME: workspace, PATH: process.env.PATH, SHELL: "/bin/sh" },
				clock: runtime.clock,
				idGenerator: { generate: (kind) => `${kind}:${++nextId}` },
				scheduler: createSystemScheduler(),
			},
		});

		const running = application.run([
			"--interactive",
			"--no-color",
			"--no-session",
			"--model",
			`${faux.getModel().provider}/${faux.getModel().id}`,
			"start a long process",
		]);
		await secondCallStarted.promise;
		expect(controlled.starts).toHaveLength(1);
		await terminal.emit(key("c", { control: true, text: "c" }));
		responseGate.resolve();
		await vi.waitFor(() => expect(controlled.stopCount()).toBe(1));
		await expect(exitWhenIdle(terminal, running)).resolves.toBe(0);
		expect(stderr.value).toBe("coda: Run ended with outcome aborted\n");
	});
});

async function exitWhenIdle(terminal: VirtualTerminal, running: Promise<number>): Promise<number> {
	const pending = Symbol("pending");
	for (let attempt = 0; attempt < 300; attempt++) {
		if (!terminal.started) return running;
		await terminal.emit(key("d", { control: true, text: "d" }));
		const result = await Promise.race([
			running,
			new Promise<typeof pending>((resolve) => setTimeout(() => resolve(pending), 10)),
		]);
		if (result !== pending) return result;
	}
	throw new Error("Interactive Session did not become idle enough to exit");
}

function key(keyName: KeyInput["key"], overrides: Partial<KeyInput> = {}): KeyInput {
	return {
		type: "key",
		key: keyName,
		shift: false,
		control: false,
		alt: false,
		meta: false,
		action: "press",
		...overrides,
	};
}
