import { basename, dirname, join } from "node:path";
import type { ToolExecutionContext } from "@coda/agent";
import type { FileSystem } from "../host/file-system.ts";
import { isFileSystemError } from "../host/file-system.ts";
import { hasWorkspacePathAccess } from "../policy.ts";
import type { ResolvedWorkspacePath, Workspace } from "../workspace.ts";

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

function temporaryName(target: string, invocationId: string): string {
	const safeId = invocationId.replace(/[^a-zA-Z0-9_-]/g, "-");
	return join(dirname(target), `.${basename(target)}.coda-${safeId}.tmp`);
}

async function removeTemporary(fileSystem: FileSystem, path: string): Promise<void> {
	try {
		await fileSystem.removeFile(path);
	} catch (error) {
		if (!isFileSystemError(error, "ENOENT")) throw error;
	}
}

export async function atomicWrite(
	workspace: Workspace,
	fileSystem: FileSystem,
	initial: ResolvedWorkspacePath,
	data: Uint8Array,
	context: ToolExecutionContext,
	toolName: "edit" | "write",
): Promise<AtomicWriteResult> {
	if (!hasWorkspacePathAccess(workspace, initial, context.invocationId, toolName, "write")) {
		throw new Error(`Path access was not granted: ${initial.canonicalPath}`);
	}
	const previous = initial.exists ? await fileSystem.stat(initial.canonicalPath) : undefined;
	if (previous && previous.kind !== "file") throw new Error(`Path is not a file: ${initial.canonicalPath}`);
	const targetMode = previous ? previous.mode & 0o7777 : 0o644;
	const temporaryPath = temporaryName(initial.canonicalPath, context.invocationId);
	let committed = false;
	let handle: Awaited<ReturnType<FileSystem["open"]>> | undefined;
	try {
		handle = await fileSystem.open(temporaryPath, "wx", targetMode);
		await handle.write(data);
		await handle.sync();
		await handle.close();
		handle = undefined;
		await fileSystem.setMode(temporaryPath, targetMode);
		context.signal.throwIfAborted();
		const rechecked = await workspace.resolvePath(initial.requestedPath, "write");
		if (
			rechecked.canonicalPath !== initial.canonicalPath ||
			!hasWorkspacePathAccess(workspace, rechecked, context.invocationId, toolName, "write")
		) {
			throw new Error("Target changed during mutation containment check");
		}
		if (!initial.exists && rechecked.exists)
			throw new Error("Target was created concurrently; refusing to overwrite it");
		await fileSystem.rename(temporaryPath, rechecked.canonicalPath);
		committed = true;
		return {
			created: !initial.exists,
			previousSize: previous?.size ?? 0,
			size: data.byteLength,
		};
	} finally {
		await handle?.close().catch(() => undefined);
		if (!committed) await removeTemporary(fileSystem, temporaryPath);
	}
}
