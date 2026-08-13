import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionContext, ToolPolicyRequest } from "@coda/agent";
import { compileSandboxPolicy, createReadAccessPolicy } from "@coda/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import { createPermissionEngine } from "../src/permissions/permission-engine.ts";
import { createSandboxedMutationWriter } from "../src/tools/sandboxed-mutation-writer.ts";
import { createWorkspace } from "../src/workspace.ts";

const supported = process.platform === "darwin" || process.platform === "linux";
const integration = supported ? describe : describe.skip;
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function context(invocationId: string): ToolExecutionContext {
	return {
		signal: new AbortController().signal,
		runId: "run-1" as ToolExecutionContext["runId"],
		turnId: "turn-1" as ToolExecutionContext["turnId"],
		invocationId: invocationId as ToolExecutionContext["invocationId"],
		resultMessageId: "message-1" as ToolExecutionContext["resultMessageId"],
		providerToolCallId: "provider-call-1",
	};
}

function writeRequest(invocationId: string, path: string): ToolPolicyRequest {
	return {
		...context(invocationId),
		toolName: "write",
		arguments: { path, content: "approved" },
		replaySafety: "never",
	};
}

integration("sandboxed file-mutation boundary", () => {
	it("executes an approved exact write outside the Workspace without broadening the active profile", async () => {
		const fixture = await mkdtemp(join(tmpdir(), "coda-approved-outside-"));
		temporaryDirectories.push(fixture);
		const workspacePath = join(fixture, "workspace");
		const outsidePath = join(fixture, "outside");
		await Promise.all([mkdir(workspacePath), mkdir(outsidePath)]);
		const workspace = await createWorkspace(workspacePath, createNodeFileSystem());
		const canonicalTmp = await realpath(tmpdir());
		const active = compileSandboxPolicy({
			profile: "workspace",
			workspaceRoots: [workspace.root],
			temporaryDirectory: canonicalTmp,
		});
		const permissions = createPermissionEngine({
			cwd: workspace.root,
			workspace,
			profile: active,
			approvalPolicy: "on-request",
			approval: { decide: async () => ({ type: "approved" }) },
		});
		const invocation = "approved-outside";
		const canonicalOutside = await realpath(outsidePath);
		const target = join(canonicalOutside, "approved.txt");
		await expect(permissions.check(writeRequest(invocation, target))).resolves.toEqual({ decision: "allow" });
		const writer = createSandboxedMutationWriter({ workspace, permissions });

		await expect(
			writer.write({ target, data: Buffer.from("exact authority\n"), expectedExists: false }, context(invocation)),
		).resolves.toMatchObject({ created: true, size: 16 });
		expect(await readFile(target, "utf8")).toBe("exact authority\n");
		expect(permissions.configuration().profile).toBe(active);
	});

	it("fails closed when a writable parent is replaced by an outside symlink after authorization", async () => {
		const fixture = await mkdtemp(join(tmpdir(), "coda-mutation-race-"));
		temporaryDirectories.push(fixture);
		const workspacePath = join(fixture, "workspace");
		const initialParent = join(workspacePath, "slot");
		const outsidePath = join(fixture, "outside");
		await Promise.all([mkdir(initialParent, { recursive: true }), mkdir(outsidePath)]);
		const workspace = await createWorkspace(workspacePath, createNodeFileSystem());
		const canonicalTmp = await realpath(tmpdir());
		const originalParent = join(workspace.root, "slot");
		const parkedParent = join(workspace.root, "slot-original");
		const canonicalOutside = await realpath(outsidePath);
		const policy = compileSandboxPolicy({
			profile: "workspace",
			workspaceRoots: [workspace.root],
			temporaryDirectory: canonicalTmp,
		});
		const target = join(originalParent, "escape.txt");
		const writer = createSandboxedMutationWriter({
			workspace,
			permissions: { readAccessPolicyFor: () => createReadAccessPolicy(policy) },
			beforeLaunch: async () => {
				await rename(originalParent, parkedParent);
				await symlink(canonicalOutside, originalParent, "dir");
			},
		});

		await expect(
			writer.write({ target, data: Buffer.from("must not escape"), expectedExists: false }, context("race-attempt")),
		).rejects.toThrow(/Sandbox|parent|mutation/iu);
		await expect(readFile(join(canonicalOutside, "escape.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("fails closed when a missing parent is replaced by an outside symlink after authorization", async () => {
		const fixture = await mkdtemp(join(tmpdir(), "coda-mutation-missing-parent-race-"));
		temporaryDirectories.push(fixture);
		const workspacePath = join(fixture, "workspace");
		const outsidePath = join(fixture, "outside");
		await Promise.all([mkdir(workspacePath), mkdir(outsidePath)]);
		const workspace = await createWorkspace(workspacePath, createNodeFileSystem());
		const canonicalTmp = await realpath(tmpdir());
		const canonicalOutside = await realpath(outsidePath);
		const policy = compileSandboxPolicy({
			profile: "workspace",
			workspaceRoots: [workspace.root],
			temporaryDirectory: canonicalTmp,
		});
		const missingParent = join(workspace.root, "generated");
		const target = join(missingParent, "parser", "escape.txt");
		const writer = createSandboxedMutationWriter({
			workspace,
			permissions: { readAccessPolicyFor: () => createReadAccessPolicy(policy) },
			beforeLaunch: async () => {
				await symlink(canonicalOutside, missingParent, "dir");
			},
		});

		await expect(
			writer.write({ target, data: Buffer.from("must not escape"), expectedExists: false }, context("missing-race")),
		).rejects.toThrow(/Sandbox|parent|canonical|mutation/iu);
		await expect(readFile(join(canonicalOutside, "parser", "escape.txt"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("rejects a same-content target identity replacement before commit", async () => {
		const workspacePath = await mkdtemp(join(tmpdir(), "coda-mutation-identity-race-"));
		temporaryDirectories.push(workspacePath);
		const workspace = await createWorkspace(workspacePath, createNodeFileSystem());
		const target = join(workspace.root, "target.txt");
		const parked = join(workspace.root, "target.parked.txt");
		const content = Buffer.from("same content\n");
		await writeFile(target, content);
		const before = await lstat(target);
		const policy = compileSandboxPolicy({
			profile: "workspace",
			workspaceRoots: [workspace.root],
			temporaryDirectory: await realpath(tmpdir()),
		});
		const writer = createSandboxedMutationWriter({
			workspace,
			permissions: { readAccessPolicyFor: () => createReadAccessPolicy(policy) },
			beforeLaunch: async () => {
				await rename(target, parked);
				await writeFile(target, content);
			},
		});

		await expect(
			writer.write(
				{
					target,
					data: Buffer.from("replacement\n"),
					expectedExists: true,
					expectedSha256: createHash("sha256").update(content).digest("hex"),
					expectedIdentity: { device: String(before.dev), inode: String(before.ino) },
				},
				context("identity-race"),
			),
		).rejects.toThrow(/identity changed/iu);
		expect(await readFile(target, "utf8")).toBe("same content\n");
	});
});
