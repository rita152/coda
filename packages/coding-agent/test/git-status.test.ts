import { describe, expect, it, vi } from "vitest";
import type { ProcessRunner } from "../src/host/process-runner.ts";
import { parseGitStatus, WorkspaceGitStatus } from "../src/ui/git-status.ts";

describe("workspace Git status", () => {
	it("parses branches, detached heads, and dirty worktrees", () => {
		expect(parseGitStatus("# branch.oid abcdef123456\n# branch.head main\n1 .M N... file.ts\n")).toEqual({
			branch: "main",
			dirty: true,
		});
		expect(parseGitStatus("# branch.oid a1b2c3d9988\n# branch.head (detached)\n")).toEqual({
			detachedHead: "a1b2c3d",
			dirty: false,
		});
		expect(parseGitStatus("fatal: not a git repository\n")).toBeUndefined();
	});

	it("publishes only changed asynchronous snapshots", async () => {
		const onChange = vi.fn();
		const run = vi
			.fn<ProcessRunner["run"]>()
			.mockResolvedValueOnce(result("# branch.oid abc\n# branch.head main\n"))
			.mockResolvedValueOnce(result("# branch.oid abc\n# branch.head main\n"))
			.mockResolvedValueOnce(result("# branch.oid abc\n# branch.head main\n? new.ts\n"));
		const status = new WorkspaceGitStatus({
			processRunner: { run },
			workspace: "/workspace",
			environment: { PATH: "/usr/bin" },
			onChange,
		});

		await status.refresh();
		await status.refresh();
		await status.refresh();

		expect(run).toHaveBeenCalledWith(expect.objectContaining({ executable: "git", cwd: "/workspace" }));
		expect(onChange).toHaveBeenCalledTimes(2);
		expect(status.snapshot).toEqual({ branch: "main", dirty: true });
		status.dispose();
	});
});

function result(stdout: string) {
	return {
		exitCode: 0,
		signal: null,
		stdout,
		stderr: "",
		timedOut: false,
		truncated: false,
	};
}
