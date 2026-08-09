import { createHash } from "node:crypto";
import type { ToolExecutionContext } from "@coda/agent";
import type { FileSystem } from "../host/file-system.ts";
import { hasPermissionedPathAccess } from "../permissions/file-access.ts";
import type { ResolvedWorkspacePath, Workspace } from "../workspace.ts";
import type { AtomicMutationWriter } from "./sandboxed-mutation-writer.ts";

export class TargetMutationCoordinator {
	readonly #tails = new Map<string, Promise<unknown>>();

	async run<T>(canonicalPath: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.#tails.get(canonicalPath) ?? Promise.resolve();
		const current = previous.catch(() => undefined).then(operation);
		this.#tails.set(canonicalPath, current);
		try {
			return await current;
		} finally {
			if (this.#tails.get(canonicalPath) === current) this.#tails.delete(canonicalPath);
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
	toolName: "edit" | "write",
	writer: AtomicMutationWriter,
	expectedSha256?: string,
): Promise<AtomicWriteResult> {
	if (!hasPermissionedPathAccess(workspace, initial, context.invocationId, toolName, "write")) {
		throw new Error(`Path access was not granted: ${initial.canonicalPath}`);
	}
	const previous = initial.exists ? await fileSystem.stat(initial.canonicalPath) : undefined;
	if (previous && previous.kind !== "file") throw new Error(`Path is not a file: ${initial.canonicalPath}`);
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
		},
		context,
	);
}
