import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import type { IdGenerator, ToolExecutionContext } from "@coda/agent";
import { compileSandboxPolicy } from "@coda/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import {
	createModelProcessSessionRunner,
	type ModelProcessAuthority,
	type ModelProcessSessionRunner,
} from "../src/permissions/model-process-runner.ts";
import { ProcessSessionManager, type ProcessSessionSnapshot } from "../src/process/process-session-manager.ts";
import { createReadToolOutputTool } from "../src/tools/read-tool-output.ts";

const temporaryDirectories: string[] = [];
const managers: ProcessSessionManager[] = [];

afterEach(async () => {
	await Promise.all(managers.splice(0).map((manager) => manager.close()));
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function context(): ToolExecutionContext {
	return {
		signal: new AbortController().signal,
		runId: "run:process" as ToolExecutionContext["runId"],
		turnId: "turn:process" as ToolExecutionContext["turnId"],
		invocationId: "invocation:process" as ToolExecutionContext["invocationId"],
		resultMessageId: "message:process" as ToolExecutionContext["resultMessageId"],
		providerToolCallId: "provider:process",
	};
}

async function fixture(
	runner: ModelProcessSessionRunner = createModelProcessSessionRunner(),
	limits: { readonly maxPollOutputBytes?: number; readonly maxPollOutputLines?: number } = {},
): Promise<{
	readonly manager: ProcessSessionManager;
	readonly workspace: string;
	readonly authority: ModelProcessAuthority;
}> {
	const directory = await mkdtemp(join(tmpdir(), "coda-process-session-"));
	temporaryDirectories.push(directory);
	const workspace = await realpath(directory);
	let nextId = 0;
	const idGenerator: IdGenerator = { generate: (kind) => `${kind}:${++nextId}` };
	const manager = new ProcessSessionManager({
		fileSystem: createNodeFileSystem(),
		homeDirectory: workspace,
		runner,
		idGenerator,
		...limits,
	});
	managers.push(manager);
	return {
		manager,
		workspace,
		authority: {
			policy: compileSandboxPolicy({
				profile: "full-access",
				workspaceRoots: [workspace],
				temporaryDirectory: await realpath(tmpdir()),
			}),
		},
	};
}

function request(workspace: string, script: string, timeoutMs = 5_000) {
	return {
		executable: process.execPath,
		args: ["-e", script],
		cwd: workspace,
		environment: {},
		signal: new AbortController().signal,
		timeoutMs,
	};
}

async function terminal(
	manager: ProcessSessionManager,
	processId: string,
): Promise<{
	readonly snapshot: ProcessSessionSnapshot;
	readonly output: string;
}> {
	let output = "";
	for (let attempt = 0; attempt < 100; attempt++) {
		const snapshot = await manager.poll(processId);
		output += snapshot.output;
		if (snapshot.state !== "running") return { snapshot, output };
		await wait(10);
	}
	throw new Error(`Process ${processId} did not settle`);
}

async function waitForOutput(manager: ProcessSessionManager, processId: string, expected: string): Promise<string> {
	let output = "";
	for (let attempt = 0; attempt < 100; attempt++) {
		const snapshot = await manager.poll(processId);
		output += snapshot.output;
		if (output.includes(expected)) return output;
		if (snapshot.state !== "running") throw new Error(`Process exited before producing ${expected}`);
		await wait(10);
	}
	throw new Error(`Process ${processId} did not produce ${expected}`);
}

function descendantScript(sentinel: string, parentExits: boolean): string {
	const child = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'leaked'), 300); setInterval(() => {}, 1000)`;
	return [
		"const { spawn } = require('node:child_process');",
		`spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { stdio: 'ignore' }).unref();`,
		"process.stdout.write('ready');",
		parentExits ? "" : "setInterval(() => {}, 1000);",
	].join("\n");
}

describe("ProcessSessionManager", () => {
	it("runs concurrent processes with independent incremental stdin and output", async () => {
		const { manager, workspace, authority } = await fixture();
		const echo =
			"process.stdin.setEncoding('utf8'); process.stdin.on('data', value => process.stdout.write(value)); process.stdin.on('end', () => process.exit(0))";
		const [first, second] = await Promise.all([
			manager.start(request(workspace, echo), authority),
			manager.start(request(workspace, echo), authority),
		]);

		expect(first.processId).not.toBe(second.processId);
		await Promise.all([
			manager.write(first.processId, "first", true),
			manager.write(second.processId, "second", true),
		]);
		const [firstResult, secondResult] = await Promise.all([
			terminal(manager, first.processId),
			terminal(manager, second.processId),
		]);

		expect(firstResult.snapshot.state).toBe("completed");
		expect(secondResult.snapshot.state).toBe("completed");
		expect(firstResult.output).toContain("first");
		expect(firstResult.output).not.toContain("second");
		expect(secondResult.output).toContain("second");
	});

	it("bounds each poll and exposes omitted output through read_tool_output", async () => {
		const { manager, workspace, authority } = await fixture(createModelProcessSessionRunner(), {
			maxPollOutputBytes: 64,
			maxPollOutputLines: 5,
		});
		const started = await manager.start(
			request(workspace, "for (let index = 0; index < 4000; index++) console.log('line-' + index)"),
			authority,
		);
		let result: ProcessSessionSnapshot | undefined;
		let observedTruncation = false;
		for (let attempt = 0; attempt < 100; attempt++) {
			result = await manager.poll(started.processId);
			observedTruncation ||= result.truncated;
			expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(64);
			if (result.state !== "running") break;
			await wait(10);
		}
		if (!result) throw new Error("Process did not produce a poll result");
		expect(result.state).toBe("completed");
		expect(observedTruncation).toBe(true);
		expect(result.outputRef).toMatch(/^tool-output:v1:/u);

		const read = createReadToolOutputTool({ fileSystem: createNodeFileSystem(), homeDirectory: workspace });
		const recovered = await read.execute({ ref: result.outputRef!, offset: 3_500, limit: 1_000 }, context());
		expect(recovered.content).toContain("line-3999");
	});

	it("reports timeout, Sandbox denial, and stale identities as explicit states", async () => {
		const live = await fixture();
		const timed = await live.manager.start(
			request(live.workspace, "setInterval(() => {}, 1000)", 25),
			live.authority,
		);
		const timedResult = await terminal(live.manager, timed.processId);
		expect(timedResult.snapshot).toMatchObject({ state: "failed", timedOut: true });

		const denialRunner: ModelProcessSessionRunner = {
			start: async (processRequest) => {
				processRequest.onOutput?.({ channel: "stderr", text: "permission denied" });
				const completion = Promise.resolve({
					exitCode: 1,
					signal: null,
					stdout: "",
					stderr: "permission denied",
					timedOut: false,
					truncated: false,
					backend: "macos-seatbelt" as const,
					denial: {
						kind: "filesystem" as const,
						backend: "seatbelt" as const,
						reason: "permission_denied" as const,
						path: "/outside",
						outputSnippet: "permission denied",
					},
				});
				return {
					backend: "macos-seatbelt",
					completion,
					write: async () => undefined,
					closeStdin: async () => undefined,
					stop: () => completion,
				};
			},
		};
		const denied = await fixture(denialRunner);
		const deniedStart = await denied.manager.start(request(denied.workspace, "ignored"), denied.authority);
		await wait(0);
		const deniedResult = await denied.manager.poll(deniedStart.processId);
		expect(deniedResult).toMatchObject({
			state: "denied",
			denial: { kind: "filesystem", path: "/outside" },
		});
		expect(await denied.manager.poll(deniedStart.processId)).toMatchObject({ state: "stale" });
		expect(await denied.manager.poll("process_session:from-an-earlier-process")).toMatchObject({ state: "stale" });
	});

	it.each(["stop", "close"] as const)("kills descendants on explicit %s", async (operation) => {
		const { manager, workspace, authority } = await fixture();
		const sentinel = join(workspace, `${operation}-descendant.txt`);
		const started = await manager.start(request(workspace, descendantScript(sentinel, false)), authority);
		await waitForOutput(manager, started.processId, "ready");

		if (operation === "stop") {
			await expect(manager.stop(started.processId)).resolves.toMatchObject({ state: "stopped" });
		} else {
			await manager.close();
		}
		await wait(450);
		await expect(access(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("cleans up descendants when the direct child exits", async () => {
		const { manager, workspace, authority } = await fixture();
		const sentinel = join(workspace, "exit-descendant.txt");
		const started = await manager.start(request(workspace, descendantScript(sentinel, true)), authority);
		const result = await terminal(manager, started.processId);

		expect(result.snapshot.state).toBe("completed");
		await wait(450);
		await expect(access(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
