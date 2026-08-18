import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import type { ToolExecutionContext } from "@coda/agent";
import type { FileStatus, FileSystem } from "../host/file-system.ts";
import { isFileSystemError } from "../host/file-system.ts";

export interface AtomicMutationRequest {
	readonly target: string;
	readonly data: Uint8Array;
	readonly expectedExists: boolean;
	readonly expectedSha256?: string;
	readonly expectedIdentity?: MutationTargetIdentity;
}

export interface MutationTargetIdentity {
	readonly device: string;
	readonly inode: string;
}

export interface AtomicMutationResult {
	readonly created: boolean;
	readonly previousSize: number;
	readonly size: number;
}

export interface AtomicMutationWriter {
	write(request: AtomicMutationRequest, context: ToolExecutionContext): Promise<AtomicMutationResult>;
}

async function optionalStatus(fileSystem: FileSystem, path: string): Promise<FileStatus | undefined> {
	try {
		return await fileSystem.lstat(path);
	} catch (error) {
		if (isFileSystemError(error, "ENOENT")) return undefined;
		throw error;
	}
}

function assertTarget(target: string): void {
	if (!isAbsolute(target) || normalize(target) !== target || target.includes("\0")) {
		throw new Error("Mutation target must be a canonical absolute path");
	}
}

function identityMatches(status: FileStatus | undefined, expected: MutationTargetIdentity | undefined): boolean {
	return expected === undefined || (status?.device === expected.device && status.inode === expected.inode);
}

async function digest(fileSystem: FileSystem, path: string): Promise<string> {
	return createHash("sha256")
		.update(await fileSystem.readFile(path))
		.digest("hex");
}

async function verifyExistingTarget(
	fileSystem: FileSystem,
	target: string,
	status: FileStatus | undefined,
	expectedIdentity: MutationTargetIdentity | undefined,
	expectedSha256: string | undefined,
): Promise<void> {
	if (status && status.kind !== "file") throw new Error(`Mutation target is not a regular file: ${target}`);
	if (!identityMatches(status, expectedIdentity)) throw new Error("Mutation target identity changed");
	if (expectedSha256 !== undefined) {
		if (!status) throw new Error("Mutation target existence changed");
		if ((await digest(fileSystem, target)) !== expectedSha256) throw new Error("Mutation target content changed");
	}
}

export function createAtomicMutationWriter(fileSystem: FileSystem): AtomicMutationWriter {
	return {
		write: async (request, context) => {
			assertTarget(request.target);
			context.signal.throwIfAborted();
			await fileSystem.makeDirectory(dirname(request.target), { recursive: true });
			const before = await optionalStatus(fileSystem, request.target);
			if (Boolean(before) !== request.expectedExists) throw new Error("Mutation target existence changed");
			await verifyExistingTarget(
				fileSystem,
				request.target,
				before,
				request.expectedIdentity,
				request.expectedSha256,
			);
			const previousSize = before?.size ?? 0;
			const mode = before ? before.mode & 0o7777 : 0o644;
			const invocation = context.invocationId.replace(/[^A-Za-z0-9_-]/gu, "-");
			const temporary = join(dirname(request.target), `.${basename(request.target)}.coda-${invocation}.tmp`);
			let handle: Awaited<ReturnType<FileSystem["open"]>> | undefined;
			let committed = false;
			try {
				handle = await fileSystem.open(temporary, "wx", mode);
				await handle.write(request.data);
				await handle.sync();
				await handle.close();
				handle = undefined;
				await fileSystem.setMode(temporary, mode);
				context.signal.throwIfAborted();
				const current = await optionalStatus(fileSystem, request.target);
				if (Boolean(current) !== request.expectedExists) throw new Error("Mutation target existence changed");
				await verifyExistingTarget(
					fileSystem,
					request.target,
					current,
					request.expectedIdentity,
					request.expectedSha256,
				);
				await fileSystem.rename(temporary, request.target);
				committed = true;
				return { created: !before, previousSize, size: request.data.byteLength };
			} finally {
				await handle?.close().catch(() => undefined);
				if (!committed) {
					await fileSystem.removeFile(temporary).catch((error) => {
						if (!isFileSystemError(error, "ENOENT")) throw error;
					});
				}
			}
		},
	};
}
