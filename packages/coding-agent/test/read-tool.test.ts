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

	it("reads dotfiles and key-shaped paths because every profile has full-disk read access", async () => {
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
					isError: false,
					content: [{ type: "text", text: "SECRET=do-not-leak\n" }],
				});
				return fauxAssistantMessage("The dotfile is readable under this profile.", { timestamp: 400 });
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
		expect(stdout.value).toBe("The dotfile is readable under this profile.\n");
		expect(stderr.value).toBe("");
	});

	it("returns recoverable read failures to the Model and continues the Run", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-read-missing-"));
		temporaryDirectories.push(workspace);
		await writeFile(join(workspace, "binary.dat"), new Uint8Array([0xff]));
		await writeFile(join(workspace, "large.txt"), new Uint8Array(2 * 1024 * 1024 + 1));
		await writeFile(join(workspace, "nul.txt"), new Uint8Array([0x61, 0x00, 0x62]));

		const faux = fauxProvider({ runtime: testTimeRuntime(500) });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "missing.txt" }, { id: "provider-read-missing" }), {
				stopReason: "toolUse",
				timestamp: 500,
			}),
			(context) => {
				expect(context.messages.at(-1)).toMatchObject({
					role: "toolResult",
					toolCallId: "provider-read-missing",
					toolName: "read",
					isError: true,
					content: [{ type: "text", text: expect.stringContaining("File does not exist") }],
					details: { status: "failed", code: "not_found", path: expect.stringContaining("/missing.txt") },
				});
				return fauxAssistantMessage(fauxToolCall("read", { path: "." }, { id: "provider-read-directory" }), {
					stopReason: "toolUse",
					timestamp: 500,
				});
			},
			(context) => {
				expect(context.messages.at(-1)).toMatchObject({
					role: "toolResult",
					toolCallId: "provider-read-directory",
					toolName: "read",
					isError: true,
					content: [{ type: "text", text: expect.stringContaining("Path is not a file") }],
					details: { status: "failed", code: "not_file", path: expect.any(String) },
				});
				return fauxAssistantMessage(fauxToolCall("read", { path: "binary.dat" }, { id: "provider-read-binary" }), {
					stopReason: "toolUse",
					timestamp: 500,
				});
			},
			(context) => {
				expect(context.messages.at(-1)).toMatchObject({
					role: "toolResult",
					toolCallId: "provider-read-binary",
					toolName: "read",
					isError: true,
					content: [{ type: "text", text: "read supports UTF-8 text files only" }],
					details: { status: "failed", code: "invalid_utf8", path: expect.stringContaining("/binary.dat") },
				});
				return fauxAssistantMessage(fauxToolCall("read", { path: "large.txt" }, { id: "provider-read-large" }), {
					stopReason: "toolUse",
					timestamp: 500,
				});
			},
			(context) => {
				expect(context.messages.at(-1)).toMatchObject({
					role: "toolResult",
					toolCallId: "provider-read-large",
					toolName: "read",
					isError: true,
					content: [{ type: "text", text: "Text file exceeds the 2 MiB read limit" }],
					details: {
						status: "failed",
						code: "too_large",
						path: expect.stringContaining("/large.txt"),
						limitBytes: 2 * 1024 * 1024,
					},
				});
				return fauxAssistantMessage(fauxToolCall("read", { path: "nul.txt" }, { id: "provider-read-nul" }), {
					stopReason: "toolUse",
					timestamp: 500,
				});
			},
			(context) => {
				expect(context.messages.at(-1)).toMatchObject({
					role: "toolResult",
					toolCallId: "provider-read-nul",
					toolName: "read",
					isError: true,
					content: [{ type: "text", text: "read supports text files only" }],
					details: { status: "failed", code: "not_text", path: expect.stringContaining("/nul.txt") },
				});
				return fauxAssistantMessage("The requested file is absent.", { timestamp: 500 });
			},
		]);
		const models = createModels({ runtime: testTimeRuntime(500) });
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
				clock: { now: () => 500 },
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
			},
		});

		const exitCode = await application.run([
			"--print",
			"--model",
			`${faux.getModel().provider}/${faux.getModel().id}`,
			"read missing.txt",
		]);

		expect(exitCode, stderr.value).toBe(0);
		expect(stdout.value).toBe("The requested file is absent.\n");
		expect(stderr.value).toBe("");
	});
});
