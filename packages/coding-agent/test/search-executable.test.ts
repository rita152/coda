import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionContext } from "@coda/agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import type { ProcessRunner } from "../src/host/process-runner.ts";
import { createFindTool } from "../src/tools/find.ts";
import { createGrepTool } from "../src/tools/grep.ts";
import { createWorkspace } from "../src/workspace.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function context(): ToolExecutionContext {
	return {
		signal: new AbortController().signal,
		runId: "run-1" as ToolExecutionContext["runId"],
		turnId: "turn-1" as ToolExecutionContext["turnId"],
		invocationId: "invocation-1" as ToolExecutionContext["invocationId"],
		resultMessageId: "message-1" as ToolExecutionContext["resultMessageId"],
		providerToolCallId: "provider-1",
	};
}

describe("optional search executables", () => {
	it("prefers installed rg with an argument vector and sanitizes the result through Workspace policy", async () => {
		const root = await mkdtemp(join(tmpdir(), "coda-rg-"));
		temporaryDirectories.push(root);
		await mkdir(join(root, "src"));
		await writeFile(join(root, "src", "hit.ts"), "const needle = true;\n", "utf8");
		const fileSystem = createNodeFileSystem();
		const workspace = await createWorkspace(root, fileSystem);
		const run = vi.fn<ProcessRunner["run"]>(async () => ({
			exitCode: 0,
			signal: null,
			stdout: "src/hit.ts:1:7:needle\n.env:1:1:needle=secret\n",
			stderr: "",
			timedOut: false,
			truncated: false,
		}));
		const tool = createGrepTool({
			workspace,
			fileSystem,
			processRunner: { run },
			runtime: { homeDirectory: root, environment: { PATH: "/tools" } },
		});

		const result = await tool.execute({ pattern: "needle", path: ".", limit: 20 }, context());

		expect(result.content).toBe("src/hit.ts:1:7:needle");
		expect(result.details).toMatchObject({ engine: "rg", count: 1 });
		expect(run).toHaveBeenCalledWith(
			expect.objectContaining({
				executable: "rg",
				args: expect.arrayContaining(["--no-heading", "--color", "never", "-e", "needle", "."]),
				environment: { LC_ALL: "C", PATH: "/tools" },
			}),
		);
	});

	it("falls back to the deterministic Node search only when rg is unavailable", async () => {
		const root = await mkdtemp(join(tmpdir(), "coda-rg-fallback-"));
		temporaryDirectories.push(root);
		await writeFile(join(root, "hit.txt"), "needle\n", "utf8");
		const fileSystem = createNodeFileSystem();
		const workspace = await createWorkspace(root, fileSystem);
		const missing = Object.assign(new Error("spawn rg ENOENT"), { code: "ENOENT" });
		const tool = createGrepTool({
			workspace,
			fileSystem,
			processRunner: { run: async () => Promise.reject(missing) },
			runtime: { homeDirectory: root, environment: {} },
		});

		const result = await tool.execute({ pattern: "needle", path: ".", limit: 20 }, context());

		expect(result.content).toBe("hit.txt:1:1:needle");
		expect(result.details).toMatchObject({ engine: "node", count: 1 });
	});

	it("prefers installed fd and returns stable, typed paths", async () => {
		const root = await mkdtemp(join(tmpdir(), "coda-fd-"));
		temporaryDirectories.push(root);
		await mkdir(join(root, "src", "nested"), { recursive: true });
		await writeFile(join(root, "src", "z.ts"), "z\n", "utf8");
		await writeFile(join(root, "src", "a.ts"), "a\n", "utf8");
		const fileSystem = createNodeFileSystem();
		const workspace = await createWorkspace(root, fileSystem);
		const run = vi.fn<ProcessRunner["run"]>(async () => ({
			exitCode: 0,
			signal: null,
			stdout: "src/z.ts\nsrc/a.ts\nsrc/nested\n",
			stderr: "",
			timedOut: false,
			truncated: false,
		}));
		const tool = createFindTool({
			workspace,
			fileSystem,
			processRunner: { run },
			runtime: { homeDirectory: root, environment: { PATH: "/tools" } },
		});

		const result = await tool.execute({ pattern: "*.ts", path: "src", type: "file" }, context());

		expect(result.content).toBe("src/a.ts\nsrc/z.ts");
		expect(result.details).toMatchObject({ engine: "fd", count: 2 });
		expect(run).toHaveBeenCalledWith(
			expect.objectContaining({
				executable: "fd",
				args: expect.arrayContaining(["--glob", "--type", "f", "*.ts", "src"]),
			}),
		);
	});
});
