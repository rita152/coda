import { createHash } from "node:crypto";
import {
	chmod,
	lstat,
	mkdtemp,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionContext, ToolPolicyRequest } from "@coda/agent";
import { compileSandboxPolicy } from "@coda/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import { createPermissionEngine, type PermissionEngine } from "../src/permissions/permission-engine.ts";
import { TargetMutationCoordinator } from "../src/tools/mutation.ts";
import { createPatchTool } from "../src/tools/patch.ts";
import type {
	AtomicDeletionRequest,
	AtomicMutationRequest,
	AtomicMutationWriter,
} from "../src/tools/sandboxed-mutation-writer.ts";
import { createWorkspace, type Workspace } from "../src/workspace.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("native patch Tool", () => {
	it("adds, updates with multiple hunks, and deletes while preserving BOM, CRLF, and mode", async () => {
		const harness = await createHarness();
		const updatedPath = join(harness.root, "updated.txt");
		await writeFile(
			updatedPath,
			Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("alpha\r\nbeta\r\ngamma\r\ndelta\r\n")]),
		);
		await chmod(updatedPath, 0o755);
		await writeFile(join(harness.root, "obsolete.txt"), "remove me\n");
		const patch = `*** Begin Patch
*** Update File: updated.txt
@@ alpha
-beta
+BETA
@@ gamma
-delta
+DELTA
*** Add File: added.txt
+new one
+new two
*** Delete File: obsolete.txt
*** End Patch`;

		const output = await runPatch(harness, patch, "patch:complete");

		expect(output.isError).toBeUndefined();
		expect(output).toMatchObject({
			observation: {
				status: "ok",
				facts: {
					mutation: {
						schemaVersion: 1,
						atomicity: "per-file",
						attemptedPaths: ["updated.txt", "added.txt", "obsolete.txt"],
						committedPaths: ["updated.txt", "added.txt", "obsolete.txt"],
						committedDelta: [
							expect.objectContaining({ path: "updated.txt", operation: "update" }),
							expect.objectContaining({ path: "added.txt", operation: "add", beforeSha256: null }),
							expect.objectContaining({ path: "obsolete.txt", operation: "delete", afterSha256: null }),
						],
					},
				},
			},
			details: {
				atomicity: "per-file",
				committedPaths: ["updated.txt", "added.txt", "obsolete.txt"],
				notAppliedPaths: [],
			},
		});
		expect(await readFile(updatedPath)).toEqual(
			Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("alpha\r\nBETA\r\ngamma\r\nDELTA\r\n")]),
		);
		expect((await stat(updatedPath)).mode & 0o777).toBe(0o755);
		expect(await readFile(join(harness.root, "added.txt"), "utf8")).toBe("new one\nnew two\n");
		await expect(readFile(join(harness.root, "obsolete.txt"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("preflights every hunk before committing any file", async () => {
		const calls: string[] = [];
		const harness = await createHarness({ calls });
		await writeFile(join(harness.root, "first.txt"), "one\n");
		await writeFile(join(harness.root, "second.txt"), "two\n");
		const patch = `*** Begin Patch
*** Update File: first.txt
-one
+ONE
*** Update File: second.txt
-missing
+TWO
*** End Patch`;

		const output = await runPatch(harness, patch, "patch:preflight");

		expect(output).toMatchObject({
			isError: true,
			observation: {
				status: "error",
				facts: { mutation: { attemptedPaths: ["first.txt", "second.txt"], committedPaths: [] } },
			},
			details: { phase: "preflight", committedPaths: [], notAppliedPaths: ["first.txt", "second.txt"] },
		});
		expect(calls).toEqual([]);
		expect(await readFile(join(harness.root, "first.txt"), "utf8")).toBe("one\n");
		expect(await readFile(join(harness.root, "second.txt"), "utf8")).toBe("two\n");
	});

	it("rejects an ambiguous exact hunk before committing any file", async () => {
		const calls: string[] = [];
		const harness = await createHarness({ calls });
		await writeFile(join(harness.root, "first.txt"), "one\n");
		await writeFile(join(harness.root, "second.txt"), "repeat\nrepeat\n");
		const patch = `*** Begin Patch
*** Update File: first.txt
-one
+ONE
*** Update File: second.txt
-repeat
+REPLACED
*** End Patch`;

		const output = await runPatch(harness, patch, "patch:ambiguous-preflight");

		expect(output).toMatchObject({
			isError: true,
			details: { phase: "preflight", committedPaths: [], notAppliedPaths: ["first.txt", "second.txt"] },
		});
		expect(output.content).toContain("precondition is ambiguous");
		expect(calls).toEqual([]);
		expect(await readFile(join(harness.root, "first.txt"), "utf8")).toBe("one\n");
		expect(await readFile(join(harness.root, "second.txt"), "utf8")).toBe("repeat\nrepeat\n");
	});

	it("reports an explicit partial application when a later target races after preflight", async () => {
		const harness = await createHarness({
			beforeMutation: async ({ index, target }) => {
				if (index === 2) await writeFile(target, "raced\n");
			},
		});
		await writeFile(join(harness.root, "first.txt"), "one\n");
		await writeFile(join(harness.root, "second.txt"), "two\n");
		const patch = `*** Begin Patch
*** Update File: first.txt
-one
+ONE
*** Update File: second.txt
-two
+TWO
*** End Patch`;

		const output = await runPatch(harness, patch, "patch:partial");

		expect(output.content).toContain("Patch partially applied: 1 of 2 files committed atomically");
		expect(output.content).toContain("No cross-file rollback was attempted");
		expect(output).toMatchObject({
			isError: true,
			observation: {
				status: "error",
				facts: {
					code: "partial_application",
					mutation: {
						atomicity: "per-file",
						attemptedPaths: ["first.txt", "second.txt"],
						committedPaths: ["first.txt"],
					},
				},
			},
			details: {
				phase: "commit",
				committedPaths: ["first.txt"],
				notAppliedPaths: ["second.txt"],
			},
		});
		expect(await readFile(join(harness.root, "first.txt"), "utf8")).toBe("ONE\n");
		expect(await readFile(join(harness.root, "second.txt"), "utf8")).toBe("raced\n");
	});

	it("rejects a same-content file identity replacement after preflight", async () => {
		const harness = await createHarness({
			beforeMutation: async ({ index, target }) => {
				if (index !== 2) return;
				await rename(target, `${target}.parked`);
				await writeFile(target, "two\n");
			},
		});
		await writeFile(join(harness.root, "first.txt"), "one\n");
		await writeFile(join(harness.root, "second.txt"), "two\n");
		const patch = `*** Begin Patch
*** Update File: first.txt
-one
+ONE
*** Update File: second.txt
-two
+TWO
*** End Patch`;

		const output = await runPatch(harness, patch, "patch:identity-race");

		expect(output).toMatchObject({
			isError: true,
			details: {
				code: "partial_application",
				committedPaths: ["first.txt"],
				notAppliedPaths: ["second.txt"],
			},
		});
		expect(output.content).toContain("target identity changed during mutation");
		expect(await readFile(join(harness.root, "first.txt"), "utf8")).toBe("ONE\n");
		expect(await readFile(join(harness.root, "second.txt"), "utf8")).toBe("two\n");
	});

	it("rejects a symlink target swap after authorization", async () => {
		const calls: string[] = [];
		const harness = await createHarness({ calls });
		await writeFile(join(harness.root, "original.txt"), "old\n");
		await writeFile(join(harness.root, "replacement.txt"), "old\n");
		const alias = join(harness.root, "alias.txt");
		await symlink("original.txt", alias);
		const patch = `*** Begin Patch
*** Update File: alias.txt
-old
+new
*** End Patch`;
		const execution = context("patch:symlink-swap");
		await expect(harness.permissions.check(policyRequest(patch, execution))).resolves.toEqual({ decision: "allow" });
		await unlink(alias);
		await symlink("replacement.txt", alias);

		const output = await harness.tool.execute({ patch }, execution);

		expect(output).toMatchObject({ isError: true, details: { phase: "preflight", committedPaths: [] } });
		expect(calls).toEqual([]);
		expect(await readFile(join(harness.root, "original.txt"), "utf8")).toBe("old\n");
		expect(await readFile(join(harness.root, "replacement.txt"), "utf8")).toBe("old\n");
	});
});

interface MutationHookInput {
	readonly index: number;
	readonly operation: "write" | "delete";
	readonly target: string;
}

interface PatchHarness {
	readonly root: string;
	readonly workspace: Workspace;
	readonly permissions: PermissionEngine;
	readonly tool: ReturnType<typeof createPatchTool>;
}

async function createHarness(
	options: {
		readonly calls?: string[];
		readonly beforeMutation?: (input: MutationHookInput) => Promise<void> | void;
	} = {},
): Promise<PatchHarness> {
	const root = await mkdtemp(join(tmpdir(), "coda-patch-tool-"));
	temporaryDirectories.push(root);
	const fileSystem = createNodeFileSystem();
	const workspace = await createWorkspace(root, fileSystem);
	const permissions = createPermissionEngine({
		cwd: workspace.root,
		workspace,
		profile: compileSandboxPolicy({
			profile: "workspace",
			workspaceRoots: [workspace.root],
			temporaryDirectory: await realpath(tmpdir()),
		}),
		approvalPolicy: "on-request",
		approval: { decide: async () => ({ type: "approved" }) },
	});
	const writer = hostMutationWriter(options);
	return {
		root: workspace.root,
		workspace,
		permissions,
		tool: createPatchTool(workspace, fileSystem, new TargetMutationCoordinator(), writer),
	};
}

async function runPatch(harness: PatchHarness, patch: string, invocationId: string) {
	const execution = context(invocationId);
	await expect(harness.permissions.check(policyRequest(patch, execution))).resolves.toEqual({ decision: "allow" });
	return harness.tool.execute({ patch }, execution);
}

function context(invocationId: string): ToolExecutionContext {
	return {
		signal: new AbortController().signal,
		runId: "run:patch" as ToolExecutionContext["runId"],
		turnId: "turn:patch" as ToolExecutionContext["turnId"],
		invocationId: invocationId as ToolExecutionContext["invocationId"],
		resultMessageId: `result:${invocationId}` as ToolExecutionContext["resultMessageId"],
		providerToolCallId: `provider:${invocationId}`,
	};
}

function policyRequest(patch: string, execution: ToolExecutionContext): ToolPolicyRequest {
	return {
		...execution,
		toolName: "patch",
		arguments: { patch },
		replaySafety: "never",
	};
}

function hostMutationWriter(options: {
	readonly calls?: string[];
	readonly beforeMutation?: (input: MutationHookInput) => Promise<void> | void;
}): AtomicMutationWriter {
	let index = 0;
	const prepare = async (operation: MutationHookInput["operation"], target: string) => {
		index++;
		options.calls?.push(`${operation}:${target}`);
		await options.beforeMutation?.({ index, operation, target });
	};
	return {
		write: async (request) => {
			await prepare("write", request.target);
			const before = await optionalFile(request.target);
			assertWritePrecondition(request, before);
			await writeFile(request.target, request.data);
			return {
				created: before === undefined,
				previousSize: before?.bytes.byteLength ?? 0,
				size: request.data.byteLength,
			};
		},
		delete: async (request) => {
			await prepare("delete", request.target);
			const before = await optionalFile(request.target);
			assertDeletePrecondition(request, before);
			await unlink(request.target);
			return { previousSize: before!.bytes.byteLength };
		},
	};
}

interface HostFileSnapshot {
	readonly bytes: Uint8Array;
	readonly device: string;
	readonly inode: string;
}

function assertWritePrecondition(request: AtomicMutationRequest, before: HostFileSnapshot | undefined): void {
	if ((before !== undefined) !== request.expectedExists) throw new Error("target existence changed during mutation");
	if (request.expectedIdentity && !identityMatches(before, request.expectedIdentity)) {
		throw new Error("target identity changed during mutation");
	}
	if (request.expectedSha256 !== undefined && (!before || digest(before.bytes) !== request.expectedSha256)) {
		throw new Error("target content changed during mutation");
	}
}

function assertDeletePrecondition(request: AtomicDeletionRequest, before: HostFileSnapshot | undefined): void {
	if (!before) throw new Error("target existence changed during mutation");
	if (request.expectedIdentity && !identityMatches(before, request.expectedIdentity)) {
		throw new Error("target identity changed during mutation");
	}
	if (digest(before.bytes) !== request.expectedSha256) throw new Error("target content changed during mutation");
}

function identityMatches(
	file: HostFileSnapshot | undefined,
	expected: { readonly device: string; readonly inode: string },
): boolean {
	return file?.device === expected.device && file.inode === expected.inode;
}

async function optionalFile(path: string): Promise<HostFileSnapshot | undefined> {
	try {
		const status = await lstat(path);
		return { bytes: await readFile(path), device: String(status.dev), inode: String(status.ino) };
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

function digest(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}
