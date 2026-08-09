import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

describe("search Tools", () => {
	it("grep returns bounded relative matches including dotfiles under full-disk read semantics", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-grep-"));
		temporaryDirectories.push(workspace);
		await mkdir(join(workspace, "src"));
		await writeFile(join(workspace, "src", "one.ts"), "first\nconst needle = true;\n", "utf8");
		await writeFile(join(workspace, ".env"), "needle=secret-value\n", "utf8");

		const faux = fauxProvider({ runtime: testTimeRuntime(500) });
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("grep", { pattern: "needle", path: ".", limit: 20 }, { id: "provider-grep-1" }),
				{ stopReason: "toolUse", timestamp: 500 },
			),
			(context) => {
				const result = context.messages.at(-1);
				expect(result).toMatchObject({
					role: "toolResult",
					toolCallId: "provider-grep-1",
					toolName: "grep",
					isError: false,
				});
				const serialized = JSON.stringify(result);
				expect(serialized).toContain("src/one.ts:2:7:const needle = true;");
				expect(serialized).toContain(".env:1:1:needle=secret-value");
				return fauxAssistantMessage("The search is clean.", { timestamp: 500 });
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
			"search for needle",
		]);

		expect(exitCode, stderr.value).toBe(0);
		expect(stdout.value).toBe("The search is clean.\n");
		expect(stderr.value).toBe("");
	});

	it("find and ls expose deterministic, structured directory searches", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-find-"));
		temporaryDirectories.push(workspace);
		await mkdir(join(workspace, "src", "nested"), { recursive: true });
		await writeFile(join(workspace, "src", "one.ts"), "one\n", "utf8");
		await writeFile(join(workspace, "src", "two.md"), "two\n", "utf8");
		await writeFile(join(workspace, "src", "nested", "three.ts"), "three\n", "utf8");

		const faux = fauxProvider({ runtime: testTimeRuntime(600) });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("find", { pattern: "*.ts", path: "src" }, { id: "provider-find-1" }), {
				stopReason: "toolUse",
				timestamp: 600,
			}),
			(context) => {
				const result = context.messages.at(-1);
				expect(result).toMatchObject({ role: "toolResult", toolName: "find", isError: false });
				expect(result?.content).toEqual([{ type: "text", text: "src/nested/three.ts\nsrc/one.ts" }]);
				return fauxAssistantMessage(fauxToolCall("ls", { path: "src" }, { id: "provider-ls-1" }), {
					stopReason: "toolUse",
					timestamp: 600,
				});
			},
			(context) => {
				const result = context.messages.at(-1);
				expect(result).toMatchObject({ role: "toolResult", toolName: "ls", isError: false });
				expect(result?.content).toEqual([{ type: "text", text: "nested/\none.ts\ntwo.md" }]);
				return fauxAssistantMessage("Directory search complete.", { timestamp: 600 });
			},
		]);
		const models = createModels({ runtime: testTimeRuntime(600) });
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
				clock: { now: () => 600 },
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
			},
		});

		const exitCode = await application.run([
			"--print",
			"--model",
			`${faux.getModel().provider}/${faux.getModel().id}`,
			"inspect the tree",
		]);

		expect(exitCode, stderr.value).toBe(0);
		expect(stdout.value).toBe("Directory search complete.\n");
		expect(stderr.value).toBe("");
	});
});
