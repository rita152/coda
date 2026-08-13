import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createModels,
	type FauxProviderHandle,
	type FauxResponseFactory,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@coda/ai";
import { afterEach, describe, expect, it } from "vitest";
import { type ApplicationOutput, createCodingAgentApplication } from "../src/application.ts";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import { createNodeProcessRunner } from "../src/host/node-process-runner.ts";
import { planShellExecution } from "../src/tools/shell-execution.ts";
import { testTimeRuntime } from "./time-runtime.ts";

class BufferOutput implements ApplicationOutput {
	readonly isTTY = false;
	value = "";

	write(chunk: string): void {
		this.value += chunk;
	}
}

interface BashCase {
	readonly command: string;
	readonly exitCode: number;
	readonly status: "ok" | "error";
	readonly pipelineDetected: boolean;
	readonly pipelineStatusMode: "pipefail" | "not-applicable" | "rejected";
	readonly preview?: { readonly mode: "head" | "tail"; readonly lines: number };
	readonly content?: string;
	readonly truncated?: boolean;
	readonly exitCodeScope?: "shell-command" | "coda-shell-policy";
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function toolCall(testCase: BashCase, index: number) {
	return fauxAssistantMessage(
		fauxToolCall(
			"bash",
			{
				command: testCase.command,
				...(testCase.preview ? { preview: testCase.preview } : {}),
			},
			{ id: `pipeline-${index}` },
		),
		{ stopReason: "toolUse", timestamp: 870 },
	);
}

function conversation(
	cases: readonly BashCase[],
	shell: string,
	shellDialect: string,
	finalText: string,
): FauxResponseStep[] {
	const checks = cases.map<FauxResponseFactory>((testCase, index) => (context) => {
		const result = context.messages.at(-1);
		expect(result, testCase.command).toMatchObject({
			role: "toolResult",
			toolCallId: `pipeline-${index}`,
			isError: testCase.status !== "ok",
			...(testCase.content ? { content: [{ type: "text", text: expect.stringContaining(testCase.content) }] } : {}),
			observation: {
				status: testCase.status,
				...(testCase.truncated === undefined ? {} : { truncated: testCase.truncated }),
				facts: {
					shellExecutionFactsVersion: 1,
					exitCode: testCase.exitCode,
					exitCodeScope: testCase.exitCodeScope ?? "shell-command",
					shell,
					shellDialect,
					pipelineDetected: testCase.pipelineDetected,
					pipelineStatusMode: testCase.pipelineStatusMode,
					outputRefComplete: expect.any(Boolean),
				},
			},
		});
		const next = cases[index + 1];
		return next ? toolCall(next, index + 1) : fauxAssistantMessage(finalText, { timestamp: 870 });
	});
	return [
		toolCall(cases[0]!, 0),
		...checks,
		(context) => {
			expect(JSON.stringify(context.messages.at(-1))).toContain("Completion evidence is not sufficient yet");
			return fauxAssistantMessage(finalText, { timestamp: 870 });
		},
	];
}

async function runConversation(options: {
	readonly faux: FauxProviderHandle;
	readonly shell: string;
	readonly prompt: string;
}): Promise<{ readonly stdout: string; readonly stderr: string; readonly launches: readonly (readonly string[])[] }> {
	const workspace = await mkdtemp(join(tmpdir(), "coda-bash-pipeline-"));
	temporaryDirectories.push(workspace);
	const models = createModels({ runtime: testTimeRuntime(870) });
	models.setProvider(options.faux.provider);
	const runner = createNodeProcessRunner({ platform: process.platform });
	const launches: string[][] = [];
	const stdout = new BufferOutput();
	const stderr = new BufferOutput();
	let id = 0;
	const application = createCodingAgentApplication({
		models,
		settings: { load: async () => ({}), save: async () => undefined },
		fileSystem: createNodeFileSystem(),
		processRunner: runner,
		modelProcessRunner: {
			run: async (request) => {
				launches.push([request.executable, ...request.args]);
				return { ...(await runner.run(request)), backend: "none" };
			},
		},
		io: { stdin: { isTTY: false, readAll: async () => "" }, stdout, stderr },
		runtime: {
			cwd: workspace,
			homeDirectory: workspace,
			platform: process.platform,
			environment: { HOME: workspace, PATH: process.env.PATH, SHELL: options.shell, USER: "tester" },
			clock: { now: () => 870 },
			idGenerator: { generate: (kind) => `${kind}:${++id}` },
		},
	});

	const exitCode = await application.run([
		"--print",
		"--dangerously-bypass-approvals-and-sandbox",
		"--model",
		`${options.faux.getModel().provider}/${options.faux.getModel().id}`,
		options.prompt,
	]);
	expect(exitCode, stderr.value).toBe(1);
	return { stdout: stdout.value, stderr: stderr.value, launches };
}

describe("bash Tool strict pipeline semantics", () => {
	it("selects only explicit pipefail dialects", () => {
		expect(planShellExecution("/bin/bash", "false | tail")).toEqual({
			kind: "execute",
			shell: "/bin/bash",
			shellDialect: "bash",
			pipelineDetected: true,
			pipelineStatusMode: "pipefail",
			args: ["-o", "pipefail", "-c", "false | tail"],
		});
		expect(planShellExecution("/bin/zsh", "printf ready")).toEqual({
			kind: "execute",
			shell: "/bin/zsh",
			shellDialect: "zsh",
			pipelineDetected: false,
			pipelineStatusMode: "pipefail",
			args: ["-o", "pipefail", "-c", "printf ready"],
		});
		expect(planShellExecution("/bin/sh", "false | tail")).toMatchObject({
			kind: "reject",
			shellDialect: "sh",
			pipelineDetected: true,
			pipelineStatusMode: "rejected",
			diagnostic: expect.stringContaining("not explicitly supported with pipefail"),
		});
		expect(planShellExecution("/bin/sh", "false || printf '%s' 'literal | value'")).toEqual({
			kind: "execute",
			shell: "/bin/sh",
			shellDialect: "sh",
			pipelineDetected: false,
			pipelineStatusMode: "not-applicable",
			args: ["-c", "false || printf '%s' 'literal | value'"],
		});
	});

	it("preserves upstream, multi-stage, Boa-style, and downstream failures", async () => {
		const cases = [
			{
				command: "false | tail",
				exitCode: 1,
				status: "error",
				pipelineDetected: true,
				pipelineStatusMode: "pipefail",
			},
			{
				command: "producer() { printf 'needle\\n'; return 7; }; producer | grep needle | head -n 1",
				exitCode: 7,
				status: "error",
				pipelineDetected: true,
				pipelineStatusMode: "pipefail",
			},
			{
				command: "cargo() { printf 'Compiling\\nerror: failed\\n'; return 19; }; cargo test | tail -n 1",
				exitCode: 19,
				status: "error",
				pipelineDetected: true,
				pipelineStatusMode: "pipefail",
			},
			{
				command: "printf 'ready\\n' | grep ready | head -n 1",
				exitCode: 0,
				status: "ok",
				pipelineDetected: true,
				pipelineStatusMode: "pipefail",
			},
			{
				command: "printf 'ready\\n' | grep missing",
				exitCode: 1,
				status: "error",
				pipelineDetected: true,
				pipelineStatusMode: "pipefail",
			},
			{
				command: "false | tail || printf handled",
				exitCode: 0,
				status: "ok",
				pipelineDetected: true,
				pipelineStatusMode: "pipefail",
				content: "handled",
			},
			{
				command: "producer() { printf 'one\\ntwo\\n'; return 23; }; producer | tail -n 2",
				exitCode: 23,
				status: "error",
				pipelineDetected: true,
				pipelineStatusMode: "pipefail",
				preview: { mode: "tail", lines: 1 },
				content: "two",
				truncated: true,
			},
			{
				command: "printf plain",
				exitCode: 0,
				status: "ok",
				pipelineDetected: false,
				pipelineStatusMode: "pipefail",
				content: "plain",
			},
		] as const satisfies readonly BashCase[];
		const faux = fauxProvider({ runtime: testTimeRuntime(870) });
		faux.setResponses(conversation(cases, "/bin/bash", "bash", "Strict pipeline checks completed."));

		const result = await runConversation({ faux, shell: "/bin/bash", prompt: "run strict pipelines" });
		expect(result.launches).toHaveLength(cases.length);
		for (const [index, launch] of result.launches.entries()) {
			expect(launch).toEqual(["/bin/bash", "-o", "pipefail", "-c", cases[index]!.command]);
		}
		expect(result.stdout).toBe("Strict pipeline checks completed.\n");
		expect(result.stderr).toContain("coda: completion partial");
	});

	it("rejects unsupported pipelines before launch and preserves non-pipeline commands", async () => {
		const cases = [
			{
				command: "false | tail",
				exitCode: 2,
				status: "error",
				pipelineDetected: true,
				pipelineStatusMode: "rejected",
				exitCodeScope: "coda-shell-policy",
				content: "Coda refused to execute this pipeline",
				truncated: false,
			},
			{
				command: "false || printf handled",
				exitCode: 0,
				status: "ok",
				pipelineDetected: false,
				pipelineStatusMode: "not-applicable",
				content: "handled",
			},
			{
				command: "printf '%s' 'literal | value'",
				exitCode: 0,
				status: "ok",
				pipelineDetected: false,
				pipelineStatusMode: "not-applicable",
				content: "literal | value",
			},
		] as const satisfies readonly BashCase[];
		const faux = fauxProvider({ runtime: testTimeRuntime(870) });
		faux.setResponses(conversation(cases, "/bin/sh", "sh", "Unsupported shell handling completed."));

		const result = await runConversation({ faux, shell: "/bin/sh", prompt: "check unsupported shell" });
		expect(result.launches).toEqual([
			["/bin/sh", "-c", cases[1].command],
			["/bin/sh", "-c", cases[2].command],
		]);
		expect(result.stdout).toBe("Unsupported shell handling completed.\n");
		expect(result.stderr).toContain("coda: completion partial");
	});
});
