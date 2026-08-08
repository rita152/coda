import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolPolicyRequest } from "@coda/agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import { createWorkspacePolicy } from "../src/policy.ts";
import { createWorkspace } from "../src/workspace.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function request(overrides: Partial<ToolPolicyRequest>): ToolPolicyRequest {
	return {
		runId: "run-1" as ToolPolicyRequest["runId"],
		turnId: "turn-1" as ToolPolicyRequest["turnId"],
		invocationId: "invocation-1" as ToolPolicyRequest["invocationId"],
		resultMessageId: "message-1" as ToolPolicyRequest["resultMessageId"],
		providerToolCallId: "provider-call-1",
		toolName: "read",
		arguments: { path: ".env" },
		replaySafety: "safe",
		...overrides,
	};
}

describe("interactive Policy Decisions", () => {
	it("scopes sensitive access once, Bash for one Run, and marks deny_and_abort", async () => {
		const root = await mkdtemp(join(tmpdir(), "coda-policy-"));
		temporaryDirectories.push(root);
		await writeFile(join(root, ".env"), "SECRET=value\n", "utf8");
		const workspace = await createWorkspace(root, createNodeFileSystem());
		const decide = vi
			.fn()
			.mockResolvedValueOnce("allow_once")
			.mockResolvedValueOnce("allow_once")
			.mockResolvedValueOnce("allow_run")
			.mockResolvedValueOnce("deny_and_abort");
		const policy = createWorkspacePolicy(workspace, {
			mode: "interactive",
			allowWorkspaceWrite: false,
			allowBash: false,
			approval: { decide },
		});

		await expect(policy.check(request({ invocationId: "sensitive-1" as never }))).resolves.toEqual({
			decision: "allow",
		});
		await expect(policy.check(request({ invocationId: "sensitive-2" as never }))).resolves.toEqual({
			decision: "allow",
		});
		await expect(
			policy.check(
				request({
					invocationId: "bash-1" as never,
					toolName: "bash",
					arguments: { command: "echo first" },
					replaySafety: "never",
				}),
			),
		).resolves.toEqual({ decision: "allow" });
		await expect(
			policy.check(
				request({
					invocationId: "bash-2" as never,
					toolName: "bash",
					arguments: { command: "echo second" },
					replaySafety: "never",
				}),
			),
		).resolves.toEqual({ decision: "allow" });
		expect(decide).toHaveBeenCalledTimes(3);

		await expect(
			policy.check(
				request({
					runId: "run-2" as never,
					invocationId: "bash-3" as never,
					toolName: "bash",
					arguments: { command: "echo denied" },
					replaySafety: "never",
				}),
			),
		).resolves.toMatchObject({ decision: "reject" });
		expect(policy.consumeAbort("bash-3" as never)).toBe(true);
		expect(policy.consumeAbort("bash-3" as never)).toBe(false);
	});
});
