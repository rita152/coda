import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionContext, ToolPolicyRequest } from "@coda/agent";
import { compileSandboxPolicy } from "@coda/sandbox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileSystem } from "../src/host/file-system.ts";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import type { ReadAccessAuditEvent } from "../src/permissions/audit.ts";
import type { ModelProcessRunner } from "../src/permissions/model-process-runner.ts";
import {
	createPermissionEngine,
	type PermissionApprovalRequest,
	type PermissionEngine,
} from "../src/permissions/permission-engine.ts";
import { createFindTool } from "../src/tools/find.ts";
import { createGrepTool } from "../src/tools/grep.ts";
import { createLsTool } from "../src/tools/ls.ts";
import { createReadTool } from "../src/tools/read.ts";
import { createWorkspace, type Workspace } from "../src/workspace.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function context(invocationId: string): ToolExecutionContext {
	return {
		signal: new AbortController().signal,
		runId: "run:read-access" as ToolExecutionContext["runId"],
		turnId: "turn:read-access" as ToolExecutionContext["turnId"],
		invocationId: invocationId as ToolExecutionContext["invocationId"],
		resultMessageId: `message:${invocationId}` as ToolExecutionContext["resultMessageId"],
		providerToolCallId: `provider:${invocationId}`,
	};
}

function policyRequest(
	toolName: "read" | "grep" | "find" | "ls",
	arguments_: Record<string, unknown>,
	invocationId: string,
): ToolPolicyRequest {
	return {
		...context(invocationId),
		toolName,
		arguments: arguments_,
		replaySafety: "safe",
	};
}

function unavailableProcessRunner(): ModelProcessRunner {
	return {
		run: async () => {
			throw Object.assign(new Error("search executable unavailable"), { code: "ENOENT" });
		},
	};
}

function permissionsFor(
	workspace: Workspace,
	deniedReadRoots: readonly string[],
	approval: PermissionApprovalRequest[] = [],
): PermissionEngine {
	return createPermissionEngine({
		cwd: workspace.root,
		workspace,
		profile: compileSandboxPolicy({
			profile: "workspace",
			workspaceRoots: [workspace.root],
			temporaryDirectory: "/tmp",
			deniedReadRoots,
		}),
		approvalPolicy: "on-request",
		approval: {
			decide: async (request) => {
				approval.push(request);
				return { type: "denied", rejection: "read not approved" };
			},
		},
	});
}

describe("native File Tool ReadAccessPolicy", () => {
	it("keeps denied descendants out of ls, grep, and find traversals", async () => {
		const root = await mkdtemp(join(tmpdir(), "coda-native-read-roots-"));
		temporaryDirectories.push(root);
		await mkdir(join(root, ".ssh"));
		await writeFile(join(root, ".ssh", "id_ed25519"), "needle-private\n");
		await writeFile(join(root, "public.txt"), "needle-public\n");
		const fileSystem = createNodeFileSystem();
		const workspace = await createWorkspace(root, fileSystem);
		const permissions = permissionsFor(workspace, [join(workspace.root, ".ssh")]);

		await expect(permissions.check(policyRequest("ls", { path: "." }, "invocation:ls"))).resolves.toEqual({
			decision: "allow",
		});
		await expect(
			permissions.check(policyRequest("grep", { pattern: "needle", path: "." }, "invocation:grep")),
		).resolves.toEqual({ decision: "allow" });
		await expect(
			permissions.check(policyRequest("find", { pattern: "*", path: "." }, "invocation:find")),
		).resolves.toEqual({ decision: "allow" });

		const ls = createLsTool(workspace, fileSystem, permissions);
		const grep = createGrepTool({
			workspace,
			fileSystem,
			permissions,
			processRunner: unavailableProcessRunner(),
			runtime: { homeDirectory: root, environment: {} },
		});
		const find = createFindTool({
			workspace,
			fileSystem,
			permissions,
			processRunner: unavailableProcessRunner(),
			runtime: { homeDirectory: root, environment: {} },
		});

		expect((await ls.execute({ path: "." }, context("invocation:ls"))).content).toBe("public.txt");
		expect((await grep.execute({ pattern: "needle", path: "." }, context("invocation:grep"))).content).toBe(
			"public.txt:1:1:needle-public",
		);
		expect((await find.execute({ pattern: "*", path: "." }, context("invocation:find"))).content).toBe("public.txt");
	});

	it("fails before reading contents when approval is unavailable", async () => {
		const root = await mkdtemp(join(tmpdir(), "coda-native-read-denied-"));
		temporaryDirectories.push(root);
		await mkdir(join(root, ".ssh"));
		await writeFile(join(root, ".ssh", "id_ed25519"), "must-not-be-read\n");
		const delegate = createNodeFileSystem();
		const readFile = vi.fn<FileSystem["readFile"]>(delegate.readFile);
		const fileSystem: FileSystem = { ...delegate, readFile };
		const workspace = await createWorkspace(root, fileSystem);
		const readEvents: ReadAccessAuditEvent[] = [];
		const permissions = createPermissionEngine({
			cwd: workspace.root,
			workspace,
			profile: compileSandboxPolicy({
				profile: "read-only",
				workspaceRoots: [workspace.root],
				temporaryDirectory: "/tmp",
				deniedReadRoots: [join(workspace.root, ".ssh")],
			}),
			approvalPolicy: "never",
			approval: { decide: async () => ({ type: "approved" }) },
			onReadAccessDecision: (event) => {
				readEvents.push(event);
			},
		});
		const invocationId = "invocation:denied-read";

		await expect(
			permissions.check(policyRequest("read", { path: ".ssh/id_ed25519" }, invocationId)),
		).resolves.toMatchObject({ decision: "reject", reason: expect.stringContaining("approval policy is never") });
		const result = await createReadTool(workspace, fileSystem, permissions).execute(
			{ path: ".ssh/id_ed25519" },
			context(invocationId),
		);

		expect(result).toMatchObject({ isError: true, details: { code: "access_denied" } });
		expect(readFile).not.toHaveBeenCalled();
		expect(readEvents).toEqual([
			expect.objectContaining({
				type: "read_access",
				outcome: "denied",
				reason: "denied-read-root",
				canonicalPath: join(workspace.root, ".ssh", "id_ed25519"),
			}),
		]);
	});

	it("canonicalizes a symlink target before requesting approval", async () => {
		const fixture = await mkdtemp(join(tmpdir(), "coda-native-read-symlink-"));
		temporaryDirectories.push(fixture);
		const root = join(fixture, "workspace");
		const credentialRoot = join(fixture, "credential-root");
		await mkdir(root);
		await mkdir(credentialRoot);
		await writeFile(join(credentialRoot, "token"), "must-not-leak\n");
		await symlink(credentialRoot, join(root, "credentials"));
		const fileSystem = createNodeFileSystem();
		const workspace = await createWorkspace(root, fileSystem);
		const approvals: PermissionApprovalRequest[] = [];
		const permissions = permissionsFor(workspace, [await realpath(credentialRoot)], approvals);

		await expect(
			permissions.check(policyRequest("read", { path: "credentials/token" }, "invocation:symlink")),
		).resolves.toEqual({ decision: "reject", reason: "read not approved" });

		expect(approvals).toHaveLength(1);
		expect(approvals[0]).toMatchObject({
			requestedPath: "credentials/token",
			canonicalPath: await realpath(join(credentialRoot, "token")),
			reason: "path is within a protected Credential root",
		});
	});
});
