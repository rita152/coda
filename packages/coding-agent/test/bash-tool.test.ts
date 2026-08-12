import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@coda/ai";
import { afterEach, describe, expect, it } from "vitest";
import { type ApplicationOutput, createCodingAgentApplication } from "../src/application.ts";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import { createNodeProcessRunner } from "../src/host/node-process-runner.ts";
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

describe("bash Tool", () => {
	it("executes compound Shell syntax under the explicit approval and Sandbox bypass", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-bash-bypass-"));
		temporaryDirectories.push(workspace);
		const faux = fauxProvider({ runtime: testTimeRuntime(880) });
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("bash", { command: "printf allowed > bypass.txt && cat bypass.txt" }, { id: "bypass-bash" }),
				{ stopReason: "toolUse", timestamp: 880 },
			),
			(context) => {
				expect(context.messages.at(-1)).toMatchObject({
					role: "toolResult",
					toolCallId: "bypass-bash",
					isError: false,
					content: [{ type: "text", text: "allowed" }],
				});
				return fauxAssistantMessage("Compound command executed.", { timestamp: 880 });
			},
		]);
		const models = createModels({ runtime: testTimeRuntime(880) });
		models.setProvider(faux.provider);
		const runner = createNodeProcessRunner({ platform: process.platform });
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			settings: { load: async () => ({}), save: async () => undefined },
			fileSystem: createNodeFileSystem(),
			processRunner: runner,
			modelProcessRunner: { run: async (request) => ({ ...(await runner.run(request)), backend: "none" }) },
			io: { stdin: { isTTY: false, readAll: async () => "" }, stdout, stderr },
			runtime: {
				cwd: workspace,
				homeDirectory: workspace,
				platform: process.platform,
				environment: { HOME: workspace, PATH: process.env.PATH, SHELL: "/bin/sh", USER: "tester" },
				clock: { now: () => 880 },
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
			},
		});

		await expect(
			application.run([
				"--print",
				"--dangerously-bypass-approvals-and-sandbox",
				"--model",
				`${faux.getModel().provider}/${faux.getModel().id}`,
				"run compound command",
			]),
		).resolves.toBe(0);
		expect(await readFile(join(workspace, "bypass.txt"), "utf8")).toBe("allowed");
		expect(stdout.value).toBe("Compound command executed.\n");
		expect(stderr.value).toBe("");
	});

	it("reports a Sandbox denial as an error even when the child exits zero", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-bash-denial-"));
		temporaryDirectories.push(workspace);
		const faux = fauxProvider({ runtime: testTimeRuntime(890) });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "curl https://example.com" }, { id: "denied-bash" }), {
				stopReason: "toolUse",
				timestamp: 890,
			}),
			(context) => {
				expect(context.messages.at(-1)).toMatchObject({
					role: "toolResult",
					toolCallId: "denied-bash",
					isError: true,
					observation: {
						status: "denied",
						truncated: false,
						facts: { denialKind: "network", requiredPermission: "network", exitCode: 0 },
					},
					content: [
						{
							type: "text",
							text: expect.stringContaining("Sandbox denied network access to https://example.com:443"),
						},
					],
				});
				return fauxAssistantMessage("The Sandbox denied the request.", { timestamp: 890 });
			},
		]);
		const models = createModels({ runtime: testTimeRuntime(890) });
		models.setProvider(faux.provider);
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			settings: { load: async () => ({}), save: async () => undefined },
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			modelProcessRunner: {
				run: async () => ({
					exitCode: 0,
					signal: null,
					stdout: "",
					stderr: "",
					timedOut: false,
					truncated: false,
					backend: "macos-seatbelt",
					denial: {
						kind: "network",
						backend: "managed-network-proxy",
						environmentId: "local",
						host: "example.com",
						protocol: "https",
						port: 443,
						decision: "deny",
						source: "user",
						reason: "host was denied",
						timestamp: 890,
					},
				}),
			},
			io: { stdin: { isTTY: false, readAll: async () => "" }, stdout, stderr },
			runtime: {
				cwd: workspace,
				homeDirectory: tmpdir(),
				platform: "darwin",
				environment: { SHELL: "/bin/sh" },
				clock: { now: () => 890 },
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
			},
		});

		await expect(
			application.run(["--print", "--model", `${faux.getModel().provider}/${faux.getModel().id}`, "try network"]),
		).resolves.toBe(0);
		expect(stdout.value).toBe("The Sandbox denied the request.\n");
		expect(stderr.value).toBe("");
	});

	it("uses the Workspace cwd and strips provider secrets from a non-login Shell", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-bash-"));
		temporaryDirectories.push(workspace);
		const canonicalWorkspace = await realpath(workspace);

		const faux = fauxProvider({ runtime: testTimeRuntime(900) });
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall(
					"bash",
					{
						command: `${JSON.stringify(process.execPath)} -e 'process.stdout.write(process.cwd()+"|"+(process.env.OPENCODE_API_KEY??"unset"))'`,
					},
					{ id: "provider-bash-1" },
				),
				{ stopReason: "toolUse", timestamp: 900 },
			),
			(context) => {
				const result = context.messages.at(-1);
				expect(result, JSON.stringify(result, null, 2)).toMatchObject({
					role: "toolResult",
					toolCallId: "provider-bash-1",
					toolName: "bash",
					isError: false,
					observation: { status: "ok", truncated: false, facts: { exitCode: 0 } },
					content: [{ type: "text", text: `${canonicalWorkspace}|unset` }],
					details: { exitCode: 0, timedOut: false, truncated: false },
				});
				return fauxAssistantMessage("The command was isolated from provider secrets.", { timestamp: 900 });
			},
		]);
		const models = createModels({ runtime: testTimeRuntime(900) });
		models.setProvider(faux.provider);
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			settings: { load: async () => ({}), save: async () => undefined },
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			io: {
				stdin: { isTTY: true, readAll: async () => "" },
				stdout,
				stderr,
			},
			runtime: {
				cwd: workspace,
				homeDirectory: tmpdir(),
				platform: "darwin",
				environment: {
					HOME: tmpdir(),
					PATH: process.env.PATH,
					SHELL: "/bin/sh",
					USER: "tester",
					OPENCODE_API_KEY: "must-not-reach-shell",
				},
				clock: { now: () => 900 },
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
			},
		});

		const exitCode = await application.run([
			"--print",
			"--model",
			`${faux.getModel().provider}/${faux.getModel().id}`,
			"run a safe shell check",
		]);

		expect(exitCode, stderr.value).toBe(0);
		expect(stdout.value).toBe("The command was isolated from provider secrets.\n");
		expect(stderr.value).toBe("");
	});

	it("selects a tail preview without masking exit status and exposes recoverable output", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-bash-preview-"));
		temporaryDirectories.push(workspace);
		let outputRef = "";
		const faux = fauxProvider({ runtime: testTimeRuntime(910) });
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall(
					"bash",
					{ command: "printf 'one\\ntwo\\nthree\\nfour\\n'; exit 7", preview: { mode: "tail", lines: 2 } },
					{ id: "preview-bash" },
				),
				{ stopReason: "toolUse", timestamp: 910 },
			),
			(context) => {
				const result = context.messages.at(-1);
				expect(result).toMatchObject({
					role: "toolResult",
					isError: true,
					content: [{ type: "text", text: expect.stringContaining("three\nfour") }],
					observation: {
						status: "error",
						truncated: true,
						facts: { exitCode: 7, previewMode: "tail", previewComplete: true },
						outputRef: expect.any(String),
					},
				});
				if (result?.role !== "toolResult") throw new Error("Expected a Tool Result");
				expect(result.content[0]?.type === "text" ? result.content[0].text : "").not.toContain("one\ntwo");
				outputRef = result.observation?.outputRef ?? "";
				return fauxAssistantMessage(
					fauxToolCall("read_tool_output", { ref: outputRef }, { id: "read-preview-output" }),
					{ stopReason: "toolUse", timestamp: 910 },
				);
			},
			(context) => {
				expect(context.messages.at(-1)).toMatchObject({
					role: "toolResult",
					toolName: "read_tool_output",
					isError: false,
					content: [{ type: "text", text: expect.stringContaining("one\ntwo\nthree\nfour") }],
				});
				return fauxAssistantMessage(
					fauxToolCall(
						"bash",
						{ command: "printf 'alpha\\nbeta\\n'", preview: { mode: "head", lines: 1 } },
						{ id: "head-preview-bash" },
					),
					{ stopReason: "toolUse", timestamp: 910 },
				);
			},
			(context) => {
				const result = context.messages.at(-1);
				expect(result).toMatchObject({
					role: "toolResult",
					isError: false,
					observation: {
						status: "ok",
						truncated: true,
						facts: { exitCode: 0, previewMode: "head", previewComplete: true },
					},
				});
				if (result?.role !== "toolResult") throw new Error("Expected a Tool Result");
				expect(result.content[0]?.type === "text" ? result.content[0].text : "").toMatch(/^alpha\n/);
				expect(result.content[0]?.type === "text" ? result.content[0].text : "").not.toContain("[stdout]");
				return fauxAssistantMessage("Recovered the complete output and kept exit 7.", { timestamp: 910 });
			},
		]);
		const models = createModels({ runtime: testTimeRuntime(910) });
		models.setProvider(faux.provider);
		const runner = createNodeProcessRunner({ platform: process.platform });
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			settings: { load: async () => ({}), save: async () => undefined },
			fileSystem: createNodeFileSystem(),
			processRunner: runner,
			modelProcessRunner: {
				run: async (request) => ({ ...(await runner.run(request)), backend: "none" }),
			},
			io: { stdin: { isTTY: false, readAll: async () => "" }, stdout, stderr },
			runtime: {
				cwd: workspace,
				homeDirectory: workspace,
				platform: process.platform,
				environment: { HOME: workspace, PATH: process.env.PATH, SHELL: "/bin/sh", USER: "tester" },
				clock: { now: () => 910 },
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
			},
		});

		await expect(
			application.run(["--print", "--model", `${faux.getModel().provider}/${faux.getModel().id}`, "preview"]),
		).resolves.toBe(0);
		expect(outputRef).toMatch(/^tool-output:v1:/);
		expect(stdout.value).toBe("Recovered the complete output and kept exit 7.\n");
		expect(stderr.value).toBe("");
	});

	it("keeps Bash usable when its optional output store cannot be created", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-bash-output-store-failure-"));
		temporaryDirectories.push(workspace);
		const baseFileSystem = createNodeFileSystem();
		const fileSystem = {
			...baseFileSystem,
			makeDirectory: async (path: string, options?: { recursive?: boolean; mode?: number }) => {
				if (path.endsWith(join(".coda", "tmp"))) {
					throw Object.assign(new Error("output store denied"), { code: "EPERM" });
				}
				await baseFileSystem.makeDirectory(path, options);
			},
		};
		const faux = fauxProvider({ runtime: testTimeRuntime(920) });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "printf usable" }, { id: "bash-no-store" }), {
				stopReason: "toolUse",
				timestamp: 920,
			}),
			(context) => {
				expect(context.messages.at(-1)).toMatchObject({
					role: "toolResult",
					content: [{ type: "text", text: "usable" }],
					observation: {
						status: "ok",
						truncated: false,
						facts: { exitCode: 0, outputRefAvailable: false },
					},
				});
				return fauxAssistantMessage("Bash remained usable.", { timestamp: 920 });
			},
		]);
		const models = createModels({ runtime: testTimeRuntime(920) });
		models.setProvider(faux.provider);
		const runner = createNodeProcessRunner({ platform: process.platform });
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			settings: { load: async () => ({}), save: async () => undefined },
			fileSystem,
			processRunner: runner,
			modelProcessRunner: {
				run: async (request) => ({ ...(await runner.run(request)), backend: "none" }),
			},
			io: { stdin: { isTTY: false, readAll: async () => "" }, stdout, stderr },
			runtime: {
				cwd: workspace,
				homeDirectory: workspace,
				platform: process.platform,
				environment: { HOME: workspace, PATH: process.env.PATH, SHELL: "/bin/sh", USER: "tester" },
				clock: { now: () => 920 },
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
			},
		});

		await expect(
			application.run(["--print", "--model", `${faux.getModel().provider}/${faux.getModel().id}`, "run"]),
		).resolves.toBe(0);
		expect(stdout.value).toBe("Bash remained usable.\n");
		expect(stderr.value).toBe("");
	});
});
