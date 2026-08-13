import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IdGenerator } from "@coda/agent";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import type {
	ProcessRunRequest,
	ProcessRunResult,
	ProcessSession,
	ProcessSessionRunner,
} from "../src/host/process-runner.ts";
import { ProcessSessionManager } from "../src/process/process-session-manager.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("ProcessSessionManager", () => {
	it("starts, streams, writes, closes stdin, and reports completion", async () => {
		const controlled = controlledRunner();
		const { manager, root } = await fixture(controlled.runner);
		const started = await manager.start(request(root), "session:a");

		expect(started).toMatchObject({ state: "running", output: "", timedOut: false });
		controlled.emit("stdout", "hello\n");
		controlled.emit("stderr", "warning\n");
		await expect(manager.write(started.processId, "input")).resolves.toMatchObject({ accepted: true });
		await expect(manager.write(started.processId, "done", true)).resolves.toMatchObject({ accepted: true });
		expect(controlled.inputs()).toEqual(["input", "done"]);

		const running = await manager.poll(started.processId);
		expect(running).toMatchObject({ state: "running", stderrPresent: true });
		expect(running.output).toContain("hello");
		expect(running.output).toContain("warning");

		controlled.finish({
			exitCode: 0,
			signal: null,
			stdout: "hello\n",
			stderr: "warning\n",
			timedOut: false,
			truncated: false,
		});
		await controlled.completion();
		await expect(manager.poll(started.processId)).resolves.toMatchObject({
			state: "completed",
			exitCode: 0,
			stderrPresent: true,
		});
		await manager.close();
	});

	it("stops only processes owned by the retired Session", async () => {
		const first = controlledRunner();
		const second = controlledRunner();
		let starts = 0;
		const { manager, root } = await fixture({
			start: (processRequest) =>
				starts++ === 0 ? first.runner.start(processRequest) : second.runner.start(processRequest),
		});
		const owned = await manager.start(request(root), "session:a");
		const retained = await manager.start(request(root), "session:b");

		await manager.retireSession("session:a");

		expect(first.stopCount()).toBe(1);
		expect(second.stopCount()).toBe(0);
		await expect(manager.poll(owned.processId)).resolves.toMatchObject({ state: "stale" });
		await expect(manager.poll(retained.processId)).resolves.toMatchObject({ state: "running" });
		await manager.close();
		expect(second.stopCount()).toBe(1);
	});

	it("returns a stale snapshot for unknown process identities", async () => {
		const controlled = controlledRunner();
		const { manager } = await fixture(controlled.runner);
		await expect(manager.poll("missing")).resolves.toMatchObject({ state: "stale", processId: "missing" });
		await manager.close();
	});
});

async function fixture(runner: ProcessSessionRunner) {
	const root = await mkdtemp(join(tmpdir(), "coda-process-manager-"));
	temporaryDirectories.push(root);
	let id = 0;
	const idGenerator: IdGenerator = { generate: () => `process:${++id}` };
	return {
		root,
		manager: new ProcessSessionManager({
			fileSystem: createNodeFileSystem(),
			homeDirectory: root,
			runner,
			idGenerator,
		}),
	};
}

function request(cwd: string): Omit<ProcessRunRequest, "maxOutputBytes" | "maxOutputLines" | "onOutput"> {
	return {
		executable: "/bin/sh",
		args: ["-c", "echo test"],
		cwd,
		environment: {},
		signal: new AbortController().signal,
		timeoutMs: 10_000,
	};
}

function controlledRunner(): {
	readonly runner: ProcessSessionRunner;
	emit(channel: "stdout" | "stderr", text: string): void;
	finish(result: ProcessRunResult): void;
	completion(): Promise<ProcessRunResult>;
	inputs(): readonly string[];
	stopCount(): number;
} {
	let activeRequest: ProcessRunRequest | undefined;
	let settle!: (result: ProcessRunResult) => void;
	const completion = new Promise<ProcessRunResult>((resolve) => {
		settle = resolve;
	});
	const inputs: string[] = [];
	let stops = 0;
	const stopped: ProcessRunResult = {
		exitCode: null,
		signal: "SIGTERM",
		stdout: "",
		stderr: "",
		timedOut: false,
		truncated: false,
	};
	const handle: ProcessSession = {
		completion,
		write: async (input) => {
			inputs.push(String(input));
		},
		closeStdin: async (input) => {
			if (input !== undefined) inputs.push(String(input));
		},
		stop: async () => {
			stops++;
			settle(stopped);
			return completion;
		},
	};
	return {
		runner: {
			start: async (processRequest) => {
				activeRequest = processRequest;
				return handle;
			},
		},
		emit: (channel, text) => activeRequest?.onOutput?.({ channel, text }),
		finish: settle,
		completion: () => completion,
		inputs: () => inputs,
		stopCount: () => stops,
	};
}
