import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGitWorkspaceEvidenceProvider } from "../src/completion/workspace-evidence.ts";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import type { ProcessRunner, ProcessRunRequest, ProcessRunResult } from "../src/host/process-runner.ts";

describe("Git completion workspace evidence", () => {
	it("captures bounded final status and diff fingerprints without embedding patch content", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-workspace-evidence-"));
		await writeFile(join(workspace, "notes.txt"), "untracked content\n");
		const requests: ProcessRunRequest[] = [];
		const runner: ProcessRunner = {
			run: async (request) => {
				requests.push(request);
				return request.args[0] === "status"
					? result(" M src/value.ts\0R  src/new.ts\0src/old.ts\0?? notes.txt\0")
					: result("diff --git a/src/value.ts b/src/value.ts\n-secret\n+replacement\n");
			},
		};
		const provider = createGitWorkspaceEvidenceProvider({
			processRunner: runner,
			fileSystem: createNodeFileSystem(),
			workspace,
			environment: { PATH: "/bin" },
			now: () => 42,
		});

		const snapshot = await provider.capture();
		await rm(workspace, { recursive: true, force: true });

		expect(snapshot).toMatchObject({
			schemaVersion: 1,
			status: "complete",
			capturedAt: 42,
			dirty: true,
			changedPaths: ["src/value.ts", "src/new.ts", "src/old.ts", "notes.txt"],
			omittedChangedPaths: 0,
			diagnostics: [],
		});
		expect(snapshot.statusSha256).toMatch(/^[a-f0-9]{64}$/u);
		expect(snapshot.diffSha256).toMatch(/^[a-f0-9]{64}$/u);
		expect(snapshot.untrackedSha256).toMatch(/^[a-f0-9]{64}$/u);
		expect(snapshot.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
		expect(JSON.stringify(snapshot)).not.toContain("replacement");
		expect(requests.map(({ args }) => args[0])).toEqual(["status", "diff"]);
	});

	it("reports unavailable evidence instead of treating a non-Git workspace as clean", async () => {
		const runner: ProcessRunner = { run: async () => result("", 128) };
		const snapshot = await createGitWorkspaceEvidenceProvider({
			processRunner: runner,
			fileSystem: createNodeFileSystem(),
			workspace: "/workspace",
			environment: {},
			now: () => 50,
		}).capture();

		expect(snapshot).toMatchObject({
			status: "unavailable",
			dirty: null,
			fingerprint: null,
			diagnostics: ["git_status_exit_128", "git_diff_exit_128"],
		});
	});

	it("resolves the active Workspace placement independently for each capture", async () => {
		const workspaces: string[] = [];
		const runner: ProcessRunner = {
			run: async (request) => {
				workspaces.push(request.cwd);
				return result("");
			},
		};
		let activeWorkspace = "/worktrees/first";
		const provider = createGitWorkspaceEvidenceProvider({
			processRunner: runner,
			fileSystem: createNodeFileSystem(),
			workspace: () => activeWorkspace,
			environment: {},
			now: () => 50,
		});

		await provider.capture();
		activeWorkspace = "/worktrees/second";
		await provider.capture();

		expect(workspaces).toEqual(["/worktrees/first", "/worktrees/first", "/worktrees/second", "/worktrees/second"]);
	});
});

function result(stdout: string, exitCode = 0): ProcessRunResult {
	return {
		exitCode,
		signal: null,
		stdout,
		stderr: "",
		timedOut: false,
		truncated: false,
	};
}
