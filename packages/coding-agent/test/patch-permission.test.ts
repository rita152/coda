import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolPolicyRequest } from "@coda/agent";
import { compileSandboxPolicy, type PermissionProfile } from "@coda/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import { createPermissionEngine, type PermissionApprovalRequest } from "../src/permissions/permission-engine.ts";
import { createWorkspace } from "../src/workspace.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("patch permission review", () => {
	it("reviews one bounded preview and grants exactly the complete target set", async () => {
		const root = await temporaryWorkspace();
		const workspace = await createWorkspace(root, createNodeFileSystem());
		const approvals: PermissionApprovalRequest[] = [];
		const permissions = createPermissionEngine({
			cwd: workspace.root,
			workspace,
			profile: policy("read-only", workspace.root),
			approvalPolicy: "on-request",
			approval: {
				decide: async (request) => {
					approvals.push(request);
					return { type: "approved" };
				},
			},
		});
		const payload = Array.from({ length: 500 }, (_, index) => `+preview line ${index}`).join("\n");
		const patch = `*** Begin Patch
*** Add File: first.txt
${payload}
*** Add File: nested/second.txt
+second
*** End Patch`;
		const request = patchRequest(patch, "patch:review");

		await expect(permissions.check(request)).resolves.toEqual({ decision: "allow" });

		const first = await workspace.resolvePath("first.txt", "write");
		const second = await workspace.resolvePath("nested/second.txt", "write");
		expect(approvals).toEqual([
			expect.objectContaining({
				kind: "filesystem",
				toolName: "patch",
				operation: "write",
				requestedPaths: ["first.txt", "nested/second.txt"],
				canonicalPaths: [first.canonicalPath, second.canonicalPath],
				diff: expect.stringContaining("*** Begin Patch"),
			}),
		]);
		expect(approvals[0]).not.toHaveProperty("requestedPath");
		expect(approvals[0]).not.toHaveProperty("canonicalPath");
		expect(Array.from(approvals[0]?.diff ?? "")).toHaveLength(4_096);
		expect(approvals[0]?.diff).toMatch(/…$/u);
		expect(workspace.isPathGranted(request.invocationId, "patch", "write", first.canonicalPath)).toBe(true);
		expect(workspace.isPathGranted(request.invocationId, "patch", "write", second.canonicalPath)).toBe(true);
		expect(
			workspace.isPathGranted(request.invocationId, "patch", "write", join(workspace.root, "unreviewed.txt")),
		).toBe(false);
	});

	it("rejects canonical target conflicts before prompting", async () => {
		const root = await temporaryWorkspace();
		await writeFile(join(root, "target.txt"), "value\n");
		await symlink("target.txt", join(root, "alias.txt"));
		const workspace = await createWorkspace(root, createNodeFileSystem());
		let prompts = 0;
		const permissions = createPermissionEngine({
			cwd: workspace.root,
			workspace,
			profile: policy("read-only", workspace.root),
			approvalPolicy: "on-request",
			approval: {
				decide: async () => {
					prompts++;
					return { type: "approved" };
				},
			},
		});
		const patch = `*** Begin Patch
*** Update File: target.txt
-value
+updated
*** Update File: alias.txt
-value
+updated again
*** End Patch`;

		await expect(permissions.check(patchRequest(patch, "patch:conflict"))).resolves.toMatchObject({
			decision: "reject",
			reason: expect.stringContaining("conflicting canonical path"),
		});
		expect(prompts).toBe(0);
	});

	it("rejects protected metadata even under Full Access", async () => {
		const root = await temporaryWorkspace();
		const workspace = await createWorkspace(root, createNodeFileSystem());
		let prompts = 0;
		const permissions = createPermissionEngine({
			cwd: workspace.root,
			workspace,
			profile: policy("full-access", workspace.root),
			approvalPolicy: "on-request",
			approval: {
				decide: async () => {
					prompts++;
					return { type: "approved" };
				},
			},
		});
		const patch = `*** Begin Patch
*** Add File: .git/config
+blocked
*** End Patch`;

		await expect(permissions.check(patchRequest(patch, "patch:metadata"))).resolves.toMatchObject({
			decision: "reject",
			reason: expect.stringContaining("Protected Workspace metadata"),
		});
		expect(prompts).toBe(0);
	});

	it("does not confuse a protected name above the Workspace with Workspace metadata", async () => {
		const fixture = await mkdtemp(join(tmpdir(), "coda-patch-ancestor-"));
		temporaryDirectories.push(fixture);
		const root = join(fixture, ".codex", "worktrees", "workspace");
		await mkdir(root, { recursive: true });
		const workspace = await createWorkspace(root, createNodeFileSystem());
		const permissions = createPermissionEngine({
			cwd: workspace.root,
			workspace,
			profile: policy("workspace", workspace.root),
			approvalPolicy: "never",
			approval: { decide: async () => ({ type: "denied", rejection: "unexpected" }) },
		});
		const patch = `*** Begin Patch
*** Add File: ordinary.txt
+allowed
*** End Patch`;

		await expect(permissions.check(patchRequest(patch, "patch:protected-ancestor"))).resolves.toEqual({
			decision: "allow",
		});
	});
});

async function temporaryWorkspace(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "coda-patch-permission-"));
	temporaryDirectories.push(root);
	return realpath(root);
}

function policy(profile: PermissionProfile, workspace: string) {
	return compileSandboxPolicy({
		profile,
		workspaceRoots: [workspace],
		temporaryDirectory: "/tmp",
	});
}

function patchRequest(patch: string, invocationId: string): ToolPolicyRequest {
	return {
		runId: "run:patch" as ToolPolicyRequest["runId"],
		turnId: "turn:patch" as ToolPolicyRequest["turnId"],
		invocationId: invocationId as ToolPolicyRequest["invocationId"],
		resultMessageId: `result:${invocationId}` as ToolPolicyRequest["resultMessageId"],
		providerToolCallId: `provider:${invocationId}`,
		toolName: "patch",
		arguments: { patch },
		replaySafety: "never",
	};
}
