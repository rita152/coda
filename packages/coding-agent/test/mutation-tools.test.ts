import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

describe("mutation Tools", () => {
	it("atomically creates a Workspace file under the explicit Workspace profile", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-write-"));
		temporaryDirectories.push(workspace);

		const faux = fauxProvider({ runtime: testTimeRuntime(700) });
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("write", { path: "created.txt", content: "created by Coda\n" }, { id: "provider-write-1" }),
				{ stopReason: "toolUse", timestamp: 700 },
			),
			(context) => {
				const result = context.messages.at(-1);
				expect(result).toMatchObject({
					role: "toolResult",
					toolCallId: "provider-write-1",
					toolName: "write",
					isError: false,
				});
				return fauxAssistantMessage("The file was created.", { timestamp: 700 });
			},
			fauxAssistantMessage("The file was created.", { timestamp: 700 }),
		]);
		const models = createModels({ runtime: testTimeRuntime(700) });
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
				clock: { now: () => 700 },
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
			},
		});

		const exitCode = await application.run([
			"--print",
			"--sandbox",
			"workspace-write",
			"--model",
			`${faux.getModel().provider}/${faux.getModel().id}`,
			"create created.txt",
		]);

		expect(exitCode).toBe(1);
		expect(await readFile(join(workspace, "created.txt"), "utf8")).toBe("created by Coda\n");
		expect(stdout.value).toBe("The file was created.\n");
		expect(stderr.value).toContain("coda: completion unverified");
	});

	it("atomically creates missing parent directories for a Workspace file", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-write-nested-"));
		temporaryDirectories.push(workspace);

		const faux = fauxProvider({ runtime: testTimeRuntime(750) });
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall(
					"write",
					{ path: "generated/parser/table.ts", content: "export const table = [];\n" },
					{ id: "provider-write-nested" },
				),
				{ stopReason: "toolUse", timestamp: 750 },
			),
			(context) => {
				expect(context.messages.at(-1)).toMatchObject({
					role: "toolResult",
					toolCallId: "provider-write-nested",
					toolName: "write",
					isError: false,
				});
				return fauxAssistantMessage("The nested file was created.", { timestamp: 750 });
			},
			fauxAssistantMessage("The nested file was created.", { timestamp: 750 }),
		]);
		const models = createModels({ runtime: testTimeRuntime(750) });
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
				clock: { now: () => 750 },
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
			},
		});

		const exitCode = await application.run([
			"--print",
			"--sandbox",
			"workspace-write",
			"--model",
			`${faux.getModel().provider}/${faux.getModel().id}`,
			"create generated/parser/table.ts",
		]);

		expect(exitCode, stderr.value).toBe(1);
		expect(await readFile(join(workspace, "generated", "parser", "table.ts"), "utf8")).toBe(
			"export const table = [];\n",
		);
		expect(stdout.value).toBe("The nested file was created.\n");
		expect(stderr.value).toContain("coda: completion unverified");
	});

	it("edits an exact unique match while preserving BOM, CRLF, and file mode", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-edit-"));
		temporaryDirectories.push(workspace);
		const target = join(workspace, "existing.txt");
		await writeFile(target, Buffer.from("\uFEFFalpha\r\nold\r\nomega\r\n", "utf8"));
		await chmod(target, 0o640);

		const faux = fauxProvider({ runtime: testTimeRuntime(800) });
		faux.setResponses([
			(context) => {
				const edit = context.tools?.find(({ name }) => name === "edit");
				expect(edit?.description).toContain("Always include path");
				expect(
					(edit?.parameters as { properties?: { path?: { description?: string } } }).properties?.path?.description,
				).toContain("Required on every edit call");
				return fauxAssistantMessage(
					fauxToolCall(
						"edit",
						{ path: "existing.txt", oldText: "old\n", newText: "new\n" },
						{ id: "provider-edit-1" },
					),
					{ stopReason: "toolUse", timestamp: 800 },
				);
			},
			(context) => {
				const result = context.messages.at(-1);
				expect(result).toMatchObject({
					role: "toolResult",
					toolCallId: "provider-edit-1",
					toolName: "edit",
					isError: false,
					details: { replacements: 1 },
				});
				return fauxAssistantMessage("The edit was applied.", { timestamp: 800 });
			},
			fauxAssistantMessage("The edit was applied.", { timestamp: 800 }),
		]);
		const models = createModels({ runtime: testTimeRuntime(800) });
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
				clock: { now: () => 800 },
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
			},
		});

		const exitCode = await application.run([
			"--print",
			"--sandbox",
			"workspace-write",
			"--model",
			`${faux.getModel().provider}/${faux.getModel().id}`,
			"edit existing.txt",
		]);

		expect(exitCode).toBe(1);
		expect(await readFile(target)).toEqual(Buffer.from("\uFEFFalpha\r\nnew\r\nomega\r\n", "utf8"));
		expect((await stat(target)).mode & 0o777).toBe(0o640);
		expect(stdout.value).toBe("The edit was applied.\n");
		expect(stderr.value).toContain("coda: completion unverified");
	});

	it("returns recoverable mutation failures to the Model and continues the Run", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-edit-missing-"));
		temporaryDirectories.push(workspace);
		await writeFile(join(workspace, "existing.txt"), "alpha\nomega\n", "utf8");
		await writeFile(join(workspace, "duplicates.txt"), "same\nsame\n", "utf8");
		await mkdir(join(workspace, "directory"));
		await writeFile(join(workspace, "large.txt"), new Uint8Array(2 * 1024 * 1024 + 1));
		await writeFile(join(workspace, "binary.dat"), new Uint8Array([0xff]));
		await writeFile(join(workspace, "nul.txt"), new Uint8Array([0x61, 0x00, 0x62]));

		const faux = fauxProvider({ runtime: testTimeRuntime(900) });
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall(
					"edit",
					{ path: "missing.txt", oldText: "before", newText: "after" },
					{ id: "provider-edit-missing" },
				),
				{ stopReason: "toolUse", timestamp: 900 },
			),
			(context) => {
				expect(context.messages.at(-1)).toMatchObject({
					role: "toolResult",
					toolCallId: "provider-edit-missing",
					toolName: "edit",
					isError: true,
					content: [{ type: "text", text: expect.stringContaining("File does not exist") }],
					details: { status: "failed", code: "not_found", path: expect.stringContaining("/missing.txt") },
				});
				return fauxAssistantMessage(
					fauxToolCall(
						"edit",
						{ path: "existing.txt", oldText: "missing", newText: "replacement" },
						{ id: "provider-edit-no-match" },
					),
					{ stopReason: "toolUse", timestamp: 900 },
				);
			},
			(context) => {
				expect(context.messages.at(-1)).toMatchObject({
					role: "toolResult",
					toolCallId: "provider-edit-no-match",
					toolName: "edit",
					isError: true,
					content: [{ type: "text", text: "Expected oldText was not found" }],
					details: {
						status: "failed",
						code: "no_match",
						path: expect.stringContaining("/existing.txt"),
					},
				});
				return fauxAssistantMessage(
					fauxToolCall(
						"edit",
						{ path: "duplicates.txt", oldText: "same", newText: "replacement" },
						{ id: "provider-edit-ambiguous" },
					),
					{ stopReason: "toolUse", timestamp: 900 },
				);
			},
			(context) => {
				expect(context.messages.at(-1)).toMatchObject({
					role: "toolResult",
					toolCallId: "provider-edit-ambiguous",
					toolName: "edit",
					isError: true,
					content: [{ type: "text", text: expect.stringContaining("Expected oldText is not unique") }],
					details: {
						status: "failed",
						code: "ambiguous_match",
						path: expect.stringContaining("/duplicates.txt"),
						matches: 2,
					},
				});
				return fauxAssistantMessage(
					fauxToolCall(
						"edit",
						{ path: "directory", oldText: "before", newText: "after" },
						{ id: "provider-edit-directory" },
					),
					{ stopReason: "toolUse", timestamp: 900 },
				);
			},
			(context) => {
				expect(context.messages.at(-1)).toMatchObject({
					role: "toolResult",
					toolCallId: "provider-edit-directory",
					toolName: "edit",
					isError: true,
					content: [{ type: "text", text: expect.stringContaining("Path is not a file") }],
					details: { status: "failed", code: "not_file", path: expect.stringContaining("/directory") },
				});
				return fauxAssistantMessage(
					fauxToolCall(
						"edit",
						{ path: "large.txt", oldText: "before", newText: "after" },
						{ id: "provider-edit-large" },
					),
					{ stopReason: "toolUse", timestamp: 900 },
				);
			},
			(context) => {
				expect(context.messages.at(-1)).toMatchObject({
					role: "toolResult",
					toolCallId: "provider-edit-large",
					toolName: "edit",
					isError: true,
					content: [{ type: "text", text: "Text file exceeds the 2 MiB edit limit" }],
					details: {
						status: "failed",
						code: "too_large",
						path: expect.stringContaining("/large.txt"),
						limitBytes: 2 * 1024 * 1024,
					},
				});
				return fauxAssistantMessage(
					fauxToolCall(
						"edit",
						{ path: "binary.dat", oldText: "before", newText: "after" },
						{ id: "provider-edit-binary" },
					),
					{ stopReason: "toolUse", timestamp: 900 },
				);
			},
			(context) => {
				expect(context.messages.at(-1)).toMatchObject({
					role: "toolResult",
					toolCallId: "provider-edit-binary",
					toolName: "edit",
					isError: true,
					content: [{ type: "text", text: "edit supports UTF-8 text files only" }],
					details: { status: "failed", code: "invalid_utf8", path: expect.stringContaining("/binary.dat") },
				});
				return fauxAssistantMessage(
					fauxToolCall(
						"edit",
						{ path: "nul.txt", oldText: "before", newText: "after" },
						{ id: "provider-edit-nul" },
					),
					{ stopReason: "toolUse", timestamp: 900 },
				);
			},
			(context) => {
				expect(context.messages.at(-1)).toMatchObject({
					role: "toolResult",
					toolCallId: "provider-edit-nul",
					toolName: "edit",
					isError: true,
					content: [{ type: "text", text: "edit supports text files only" }],
					details: { status: "failed", code: "not_text", path: expect.stringContaining("/nul.txt") },
				});
				return fauxAssistantMessage(
					fauxToolCall("write", { path: "directory", content: "replacement" }, { id: "provider-write-directory" }),
					{ stopReason: "toolUse", timestamp: 900 },
				);
			},
			(context) => {
				expect(context.messages.at(-1)).toMatchObject({
					role: "toolResult",
					toolCallId: "provider-write-directory",
					toolName: "write",
					isError: true,
					content: [{ type: "text", text: expect.stringContaining("Path is not a file") }],
					details: { status: "failed", code: "not_file", path: expect.stringContaining("/directory") },
				});
				return fauxAssistantMessage("The edit target is absent.", { timestamp: 900 });
			},
			fauxAssistantMessage("The edit target is still absent.", { timestamp: 900 }),
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
				environment: {},
				clock: { now: () => 900 },
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
			},
		});

		const exitCode = await application.run([
			"--print",
			"--sandbox",
			"workspace-write",
			"--model",
			`${faux.getModel().provider}/${faux.getModel().id}`,
			"edit missing.txt",
		]);

		expect(exitCode, stderr.value).toBe(1);
		expect(stdout.value).toBe("The edit target is still absent.\n");
		expect(stderr.value).toContain("coda: completion partial");
	});
});
