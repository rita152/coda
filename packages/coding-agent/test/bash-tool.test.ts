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
	it("uses the Workspace cwd and strips provider secrets from a non-login Shell", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-bash-"));
		temporaryDirectories.push(workspace);
		const canonicalWorkspace = await realpath(workspace);

		const faux = fauxProvider({ runtime: testTimeRuntime(900) });
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall(
					"bash",
					{ command: `printf "%s|%s" "$PWD" "\${OPENCODE_API_KEY-unset}"` },
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
			"--allow-bash",
			"--model",
			`${faux.getModel().provider}/${faux.getModel().id}`,
			"run a safe shell check",
		]);

		expect(exitCode, stderr.value).toBe(0);
		expect(stdout.value).toBe("The command was isolated from provider secrets.\n");
		expect(stderr.value).toBe("");
	});
});
