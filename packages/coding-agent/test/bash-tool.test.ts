import { mkdtemp, realpath, rm } from "node:fs/promises";
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
});
