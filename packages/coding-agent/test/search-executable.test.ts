import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
	it("prefers installed rg with an argument vector and validates results against the Workspace", async () => {
		const root = await mkdtemp(join(tmpdir(), "coda-rg-"));
		temporaryDirectories.push(root);
		await mkdir(join(root, "src"));
		await writeFile(join(root, "src", "hit.ts"), "const needle = true;\n", "utf8");
		const fileSystem = createNodeFileSystem();
		const workspace = await createWorkspace(root, fileSystem);
		const tools = await trustedSearchDirectory("rg");
		const run = vi.fn<ProcessRunner["run"]>(async () => ({
			exitCode: 0,
			signal: null,
			stdout: "src/hit.ts:1:7:leaked-private-key\n.env:1:1:needle=secret\n",
			stderr: "",
			timedOut: false,
			truncated: false,
		}));
		const tool = createGrepTool({
			workspace,
			fileSystem,
			processRunner: { run },
			runtime: { homeDirectory: root, environment: { PATH: tools } },
		});

		const result = await tool.execute({ pattern: "needle", path: ".", limit: 20 }, context());

		expect(result.content).toBe("src/hit.ts:1:7:const needle = true;");
		expect(result.details).toMatchObject({ engine: "rg", count: 1 });
		expect(run).toHaveBeenCalledWith(
			expect.objectContaining({
				executable: join(tools, "rg"),
				args: expect.arrayContaining(["--no-heading", "--color", "never", "-e", "needle", "."]),
				environment: { LC_ALL: "C", PATH: tools },
			}),
		);
		expect(run.mock.calls[0]?.[0].args.slice(-3)).toEqual(["needle", "--", "."]);
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

	it("does not execute a search helper supplied by the Workspace", async () => {
		const root = await mkdtemp(join(tmpdir(), "coda-rg-untrusted-"));
		temporaryDirectories.push(root);
		await writeFile(join(root, "hit.txt"), "needle\n", "utf8");
		await writeFile(join(root, "rg"), "#!/bin/sh\nexit 99\n", "utf8");
		const fileSystem = createNodeFileSystem();
		await fileSystem.setMode(join(root, "rg"), 0o755);
		const workspace = await createWorkspace(root, fileSystem);
		const run = vi.fn<ProcessRunner["run"]>(async () => {
			throw new Error("Workspace search helper must not execute");
		});
		const tool = createGrepTool({
			workspace,
			fileSystem,
			processRunner: { run },
			runtime: { homeDirectory: root, environment: { PATH: root } },
		});

		const result = await tool.execute({ pattern: "needle", path: ".", limit: 20 }, context());

		expect(result.content).toBe("hit.txt:1:1:needle");
		expect(result.details).toMatchObject({ engine: "node", count: 1 });
		expect(run).not.toHaveBeenCalled();
	});

	it("prefers installed fd and returns stable, typed paths", async () => {
		const root = await mkdtemp(join(tmpdir(), "coda-fd-"));
		temporaryDirectories.push(root);
		await mkdir(join(root, "src", "nested"), { recursive: true });
		await writeFile(join(root, "src", "z.ts"), "z\n", "utf8");
		await writeFile(join(root, "src", "a.ts"), "a\n", "utf8");
		const fileSystem = createNodeFileSystem();
		const workspace = await createWorkspace(root, fileSystem);
		const tools = await trustedSearchDirectory("fd");
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
			runtime: { homeDirectory: root, environment: { PATH: tools } },
		});

		const result = await tool.execute({ pattern: "*.ts", path: "src", type: "file" }, context());

		expect(result.content).toBe("src/a.ts\nsrc/z.ts");
		expect(result.details).toMatchObject({ engine: "fd", count: 2 });
		expect(run).toHaveBeenCalledWith(
			expect.objectContaining({
				executable: join(tools, "fd"),
				args: expect.arrayContaining(["--glob", "--type", "f", "*.ts", "src"]),
			}),
		);
		expect(run.mock.calls[0]?.[0].args.slice(-3)).toEqual(["--", "*.ts", "src"]);
	});

	it("returns an rg timeout as a model-visible Tool failure", async () => {
		const root = await mkdtemp(join(tmpdir(), "coda-rg-timeout-"));
		temporaryDirectories.push(root);
		const fileSystem = createNodeFileSystem();
		const workspace = await createWorkspace(root, fileSystem);
		const tools = await trustedSearchDirectory("rg");
		const tool = createGrepTool({
			workspace,
			fileSystem,
			processRunner: {
				run: async () => ({
					exitCode: null,
					signal: "SIGTERM",
					stdout: "",
					stderr: "",
					timedOut: true,
					truncated: false,
				}),
			},
			runtime: { homeDirectory: root, environment: { PATH: tools } },
		});

		const result = await tool.execute({ pattern: "needle", path: "." }, context());

		expect(result).toMatchObject({
			content: "rg search timed out",
			details: { status: "failed", code: "timeout", engine: "rg" },
			isError: true,
		});
	});

	it("returns an fd process failure as a model-visible Tool failure", async () => {
		const root = await mkdtemp(join(tmpdir(), "coda-fd-failure-"));
		temporaryDirectories.push(root);
		const fileSystem = createNodeFileSystem();
		const workspace = await createWorkspace(root, fileSystem);
		const tools = await trustedSearchDirectory("fd");
		const tool = createFindTool({
			workspace,
			fileSystem,
			processRunner: {
				run: async () => ({
					exitCode: 2,
					signal: null,
					stdout: "",
					stderr: "bad query",
					timedOut: false,
					truncated: false,
				}),
			},
			runtime: { homeDirectory: root, environment: { PATH: tools } },
		});

		const result = await tool.execute({ pattern: "*.ts", path: "." }, context());

		expect(result).toMatchObject({
			content: "fd search failed: bad query",
			details: { status: "failed", code: "search_failed", engine: "fd", exitCode: 2 },
			isError: true,
		});
	});
});

async function trustedSearchDirectory(name: "fd" | "rg"): Promise<string> {
	const directory = await mkdtemp(join(process.cwd(), ".search-helper-"));
	temporaryDirectories.push(directory);
	const executable = join(directory, name);
	await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
	await chmod(executable, 0o755);
	return directory;
}
