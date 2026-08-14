import { createHash } from "node:crypto";
import { join } from "node:path";
import type { TrustedProjectInstructions } from "@coda/runtime";
import type { FileStatus, FileSystem } from "../host/file-system.ts";
import { isFileSystemError } from "../host/file-system.ts";
import type { Workspace } from "../workspace.ts";

const MAX_PROJECT_INSTRUCTIONS_BYTES = 64 * 1024;

export async function loadProjectInstructions(
	workspace: Workspace,
	fileSystem: FileSystem,
): Promise<TrustedProjectInstructions | undefined> {
	const requestedPath = join(workspace.root, "AGENTS.md");
	let status: FileStatus;
	try {
		status = await fileSystem.lstat(requestedPath);
	} catch (error) {
		if (isFileSystemError(error, "ENOENT")) return undefined;
		throw error;
	}
	if (status.kind === "symbolic-link") throw new Error("Workspace root AGENTS.md must not be a symbolic link");
	if (status.kind !== "file") throw new Error("Workspace root AGENTS.md is not a regular file");
	if (status.size > MAX_PROJECT_INSTRUCTIONS_BYTES) throw new Error("AGENTS.md exceeds the 64 KiB limit");
	const resolved = await workspace.resolvePath(requestedPath);
	if (!resolved.insideWorkspace || resolved.canonicalPath !== requestedPath) {
		throw new Error("Workspace root AGENTS.md failed its canonical path check");
	}
	const bytes = await fileSystem.readFile(resolved.canonicalPath);
	if (bytes.byteLength > MAX_PROJECT_INSTRUCTIONS_BYTES) throw new Error("AGENTS.md exceeds the 64 KiB limit");
	let content: string;
	try {
		content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new Error("AGENTS.md is not valid UTF-8 text");
	}
	if (content.includes("\0")) throw new Error("AGENTS.md must be a text file");
	return {
		path: resolved.canonicalPath,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		content,
	};
}
