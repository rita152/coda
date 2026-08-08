import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
	it("atomically creates a Workspace file only when print-mode writes are explicitly enabled", async () => {
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
			"--allow-workspace-write",
			"--model",
			`${faux.getModel().provider}/${faux.getModel().id}`,
			"create created.txt",
		]);

		expect(exitCode).toBe(0);
		expect(await readFile(join(workspace, "created.txt"), "utf8")).toBe("created by Coda\n");
		expect(stdout.value).toBe("The file was created.\n");
		expect(stderr.value).toBe("");
	});

	it("edits an exact unique match while preserving BOM, CRLF, and file mode", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-edit-"));
		temporaryDirectories.push(workspace);
		const target = join(workspace, "existing.txt");
		await writeFile(target, Buffer.from("\uFEFFalpha\r\nold\r\nomega\r\n", "utf8"));
		await chmod(target, 0o640);

		const faux = fauxProvider({ runtime: testTimeRuntime(800) });
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall(
					"edit",
					{ path: "existing.txt", oldText: "old\n", newText: "new\n" },
					{ id: "provider-edit-1" },
				),
				{ stopReason: "toolUse", timestamp: 800 },
			),
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
			"--allow-workspace-write",
			"--model",
			`${faux.getModel().provider}/${faux.getModel().id}`,
			"edit existing.txt",
		]);

		expect(exitCode).toBe(0);
		expect(await readFile(target)).toEqual(Buffer.from("\uFEFFalpha\r\nnew\r\nomega\r\n", "utf8"));
		expect((await stat(target)).mode & 0o777).toBe(0o640);
		expect(stdout.value).toBe("The edit was applied.\n");
		expect(stderr.value).toBe("");
	});
});
