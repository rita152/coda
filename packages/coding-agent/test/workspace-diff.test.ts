import { describe, expect, it, vi } from "vitest";
import type { ProcessRunner } from "../src/host/process-runner.ts";
import { collectWorkspaceDiff, parseGitStatusPaths } from "../src/run-evidence/workspace-diff.ts";

describe("final Workspace diff", () => {
	it("parses tracked, untracked, deleted, and both rename endpoints from porcelain -z", () => {
		expect(
			parseGitStatusPaths(" M tracked.ts\0?? untracked.ts\0 D deleted.ts\0R  renamed.ts\0original.ts\0"),
		).toEqual({
			paths: ["tracked.ts", "untracked.ts", "deleted.ts", "renamed.ts", "original.ts"],
			partial: false,
		});
	});

	it("marks malformed or truncated rename records partial without inventing paths", () => {
		expect(parseGitStatusPaths("R  renamed.ts\0")).toEqual({ paths: ["renamed.ts"], partial: true });
		expect(parseGitStatusPaths("malformed\0?? valid.ts\0")).toEqual({ paths: ["valid.ts"], partial: true });
	});

	it("normalizes repository-root paths to the Workspace coordinate", () => {
		expect(
			parseGitStatusPaths(
				" M packages/coding-agent/src/native.ts\0?? packages/coding-agent/shell.txt\0",
				"packages/coding-agent/",
			),
		).toEqual({ paths: ["src/native.ts", "shell.txt"], partial: false });
		expect(parseGitStatusPaths(" M outside.txt\0", "packages/coding-agent/")).toEqual({
			paths: [],
			partial: true,
		});
	});

	it("collects a bounded Git status and exposes incomplete coverage", async () => {
		const run = vi
			.fn<ProcessRunner["run"]>()
			.mockResolvedValueOnce({
				exitCode: 0,
				signal: null,
				stdout: "packages/coding-agent/\n",
				stderr: "",
				timedOut: false,
				truncated: false,
			})
			.mockResolvedValueOnce({
				exitCode: 0,
				signal: null,
				stdout: " M packages/coding-agent/native.txt\0?? packages/coding-agent/shell.txt\0",
				stderr: "",
				timedOut: false,
				truncated: true,
			});

		await expect(
			collectWorkspaceDiff({
				processRunner: { run },
				workspace: "/workspace",
				environment: { PATH: "/usr/bin", SECRET: "do-not-forward" },
			}),
		).resolves.toEqual({ status: "partial", paths: ["native.txt", "shell.txt"], omitted: 1 });
		expect(run).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				executable: "git",
				args: ["rev-parse", "--show-prefix"],
				cwd: "/workspace",
				environment: { PATH: "/usr/bin", GIT_OPTIONAL_LOCKS: "0" },
			}),
		);
		expect(run).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				executable: "git",
				args: ["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."],
				cwd: "/workspace",
				environment: { PATH: "/usr/bin", GIT_OPTIONAL_LOCKS: "0" },
				timeoutMs: 2_000,
				maxOutputBytes: 512 * 1024,
			}),
		);
	});

	it("fails closed to unavailable when Git cannot produce a trustworthy result", async () => {
		const run = vi.fn<ProcessRunner["run"]>().mockResolvedValue({
			exitCode: 128,
			signal: null,
			stdout: "",
			stderr: "not a repository",
			timedOut: false,
			truncated: false,
		});

		await expect(
			collectWorkspaceDiff({ processRunner: { run }, workspace: "/workspace", environment: {} }),
		).resolves.toEqual({ status: "unavailable", paths: [] });
		expect(run).toHaveBeenCalledTimes(1);
	});
});
