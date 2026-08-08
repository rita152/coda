import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

describe("read Tool", () => {
	it("reads UTF-8 text relative to the canonical Workspace and returns it to the Model", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-read-"));
		temporaryDirectories.push(workspace);
		await writeFile(join(workspace, "notes.txt"), "first line\nsecond line\n", "utf8");

		const faux = fauxProvider({ runtime: testTimeRuntime(300) });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "notes.txt" }, { id: "provider-tool-1" }), {
				stopReason: "toolUse",
				timestamp: 300,
			}),
			(context) => {
				const result = context.messages.at(-1);
				expect(result).toMatchObject({
					role: "toolResult",
					toolCallId: "provider-tool-1",
					toolName: "read",
					isError: false,
					content: [{ type: "text", text: "first line\nsecond line\n" }],
				});
				return fauxAssistantMessage("I read the file.", { timestamp: 300 });
			},
		]);
		const models = createModels({ runtime: testTimeRuntime(300) });
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
				environment: {},
				clock: { now: () => 300 },
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
			},
		});

		const exitCode = await application.run([
			"--print",
			"--model",
			`${faux.getModel().provider}/${faux.getModel().id}`,
			"read notes.txt",
		]);

		expect(exitCode).toBe(0);
		expect(stdout.value).toBe("I read the file.\n");
		expect(stderr.value).toBe("");
	});

	it("fails closed on a sensitive path in non-interactive mode", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-sensitive-"));
		temporaryDirectories.push(workspace);
		await writeFile(join(workspace, ".env"), "SECRET=do-not-leak\n", "utf8");

		const faux = fauxProvider({ runtime: testTimeRuntime(400) });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: ".env" }, { id: "provider-tool-sensitive" }), {
				stopReason: "toolUse",
				timestamp: 400,
			}),
			(context) => {
				const result = context.messages.at(-1);
				expect(result).toMatchObject({
					role: "toolResult",
					toolCallId: "provider-tool-sensitive",
					toolName: "read",
					isError: true,
				});
				expect(JSON.stringify(result)).toContain("approval");
				expect(JSON.stringify(result)).not.toContain("do-not-leak");
				return fauxAssistantMessage("The protected read was rejected.", { timestamp: 400 });
			},
		]);
		const models = createModels({ runtime: testTimeRuntime(400) });
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
				environment: {},
				clock: { now: () => 400 },
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
			},
		});

		const exitCode = await application.run([
			"--print",
			"--model",
			`${faux.getModel().provider}/${faux.getModel().id}`,
			"read .env",
		]);

		expect(exitCode).toBe(0);
		expect(stdout.value).toBe("The protected read was rejected.\n");
		expect(stderr.value).toBe("");
	});
});
