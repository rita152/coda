import { createHash } from "node:crypto";
import type { ToolExecutionContext } from "@coda/agent";
import type { FileSystem } from "../host/file-system.ts";
import type { ResolvedWorkspacePath, Workspace } from "../host/workspace.ts";
import type { AtomicMutationWriter, MutationTargetIdentity } from "./atomic-mutation-writer.ts";

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
	writer: AtomicMutationWriter,
	expectedSha256?: string,
	expectedIdentity?: MutationTargetIdentity,
): Promise<AtomicWriteResult> {
	const previous = initial.exists ? await fileSystem.stat(initial.canonicalPath) : undefined;
	if (previous && previous.kind !== "file") throw new Error(`Path is not a file: ${initial.canonicalPath}`);
	if (expectedIdentity && !identityMatches(previous, expectedIdentity)) {
		throw new Error("Target identity changed before mutation identity check");
	}
	context.signal.throwIfAborted();
	const rechecked = await workspace.resolvePath(initial.requestedPath);
	if (rechecked.canonicalPath !== initial.canonicalPath) {
		throw new Error("Target changed during mutation identity check");
	}
	if (!initial.exists && rechecked.exists)
		throw new Error("Target was created concurrently; refusing to overwrite it");
	if (expectedSha256 && initial.exists) {
		const current = await fileSystem.readFile(rechecked.canonicalPath);
		if (createHash("sha256").update(current).digest("hex") !== expectedSha256) {
			throw new Error("Target content changed before mutation identity check");
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

function identityMatches(
	status: { readonly device?: string; readonly inode?: string } | undefined,
	expected: MutationTargetIdentity,
): boolean {
	return status?.device === expected.device && status.inode === expected.inode;
}
