import { createHash } from "node:crypto";
import type { ToolExecutionContext } from "@coda/agent";
import type { FileSystem } from "../host/file-system.ts";
import { hasPermissionedPathAccess } from "../permissions/file-access.ts";
import type { ResolvedWorkspacePath, Workspace } from "../workspace.ts";
import type { MutationToolName } from "./mutation-contract.ts";
import type { AtomicMutationWriter, MutationTargetIdentity } from "./sandboxed-mutation-writer.ts";

export class TargetMutationCoordinator {
	readonly #tails = new Map<string, Promise<unknown>>();

	async run<T>(canonicalPath: string, operation: () => Promise<T>): Promise<T> {
		return this.runMany([canonicalPath], operation);
	}

	/** Reserves a deterministic target set before preflight so native mutations cannot interleave. */
	async runMany<T>(canonicalPaths: readonly string[], operation: () => Promise<T>): Promise<T> {
		const targets = [...new Set(canonicalPaths)].sort();
		if (targets.length === 0) return operation();
		const previous = targets.map((path) => this.#tails.get(path) ?? Promise.resolve());
		const current = Promise.all(previous.map((tail) => tail.catch(() => undefined))).then(operation);
		for (const path of targets) this.#tails.set(path, current);
		try {
			return await current;
		} finally {
			for (const path of targets) {
				if (this.#tails.get(path) === current) this.#tails.delete(path);
			}
		}
	}
}

export interface AtomicWriteResult {
	readonly created: boolean;
	readonly previousSize: number;
	readonly size: number;
}

export async function atomicWrite(
	workspace: Workspace,
	fileSystem: FileSystem,
	initial: ResolvedWorkspacePath,
	data: Uint8Array,
	context: ToolExecutionContext,
	toolName: MutationToolName,
	writer: AtomicMutationWriter,
	expectedSha256?: string,
	expectedIdentity?: MutationTargetIdentity,
): Promise<AtomicWriteResult> {
	if (!hasPermissionedPathAccess(workspace, initial, context.invocationId, toolName, "write")) {
		throw new Error(`Path access was not granted: ${initial.canonicalPath}`);
	}
	const previous = initial.exists ? await fileSystem.stat(initial.canonicalPath) : undefined;
	if (previous && previous.kind !== "file") throw new Error(`Path is not a file: ${initial.canonicalPath}`);
	if (expectedIdentity && !identityMatches(previous, expectedIdentity)) {
		throw new Error("Target identity changed before mutation containment check");
	}
	context.signal.throwIfAborted();
	const rechecked = await workspace.resolvePath(initial.requestedPath, "write");
	if (
		rechecked.canonicalPath !== initial.canonicalPath ||
		!hasPermissionedPathAccess(workspace, rechecked, context.invocationId, toolName, "write")
	) {
		throw new Error("Target changed during mutation containment check");
	}
	if (!initial.exists && rechecked.exists)
		throw new Error("Target was created concurrently; refusing to overwrite it");
	if (expectedSha256 && initial.exists) {
		const current = await fileSystem.readFile(rechecked.canonicalPath);
		if (createHash("sha256").update(current).digest("hex") !== expectedSha256) {
			throw new Error("Target content changed before mutation containment check");
		}
	}
	return writer.write(
		{
			target: rechecked.canonicalPath,
			data,
			expectedExists: initial.exists,
			expectedSha256,
			expectedIdentity,
		},
		context,
	);
}

export interface AtomicDeleteResult {
	readonly previousSize: number;
}

export async function atomicDelete(
	workspace: Workspace,
	fileSystem: FileSystem,
	initial: ResolvedWorkspacePath,
	context: ToolExecutionContext,
	toolName: MutationToolName,
	writer: AtomicMutationWriter,
	expectedSha256: string,
	expectedIdentity?: MutationTargetIdentity,
): Promise<AtomicDeleteResult> {
	if (!hasPermissionedPathAccess(workspace, initial, context.invocationId, toolName, "write")) {
		throw new Error(`Path access was not granted: ${initial.canonicalPath}`);
	}
	if (!initial.exists) throw new Error(`Target does not exist: ${initial.canonicalPath}`);
	const previous = await fileSystem.stat(initial.canonicalPath);
	if (previous.kind !== "file") throw new Error(`Path is not a file: ${initial.canonicalPath}`);
	if (expectedIdentity && !identityMatches(previous, expectedIdentity)) {
		throw new Error("Target identity changed before mutation containment check");
	}
	context.signal.throwIfAborted();
	const rechecked = await workspace.resolvePath(initial.requestedPath, "write");
	if (
		!rechecked.exists ||
		rechecked.canonicalPath !== initial.canonicalPath ||
		!hasPermissionedPathAccess(workspace, rechecked, context.invocationId, toolName, "write")
	) {
		throw new Error("Target changed during mutation containment check");
	}
	const current = await fileSystem.readFile(rechecked.canonicalPath);
	if (createHash("sha256").update(current).digest("hex") !== expectedSha256) {
		throw new Error("Target content changed before mutation containment check");
	}
	return writer.delete(
		{
			target: rechecked.canonicalPath,
			expectedSha256,
			expectedIdentity,
		},
		context,
	);
}

function identityMatches(
	status: { readonly device?: string; readonly inode?: string } | undefined,
	expected: MutationTargetIdentity,
): boolean {
	return status?.device === expected.device && status.inode === expected.inode;
}
