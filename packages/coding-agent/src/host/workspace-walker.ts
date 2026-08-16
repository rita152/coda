import { join, relative, sep } from "node:path";
import type { FileSystem } from "./file-system.ts";
import { isFileSystemError } from "./file-system.ts";
import type { Workspace } from "./workspace.ts";

const IGNORED_DIRECTORY_NAMES = new Set([".git", ".coda", "node_modules"]);

export interface WalkedWorkspaceFile {
	readonly canonicalPath: string;
	readonly relativePath: string;
}

export interface WalkedWorkspaceEntry extends WalkedWorkspaceFile {
	readonly kind: "directory" | "file";
}

export interface WalkWorkspaceOptions {
	readonly signal?: AbortSignal;
	readonly insideWorkspaceOnly?: boolean;
}

export function displayWorkspacePath(workspace: Workspace, canonicalPath: string): string {
	const value = relative(workspace.root, canonicalPath);
	return value === "" ? "." : value.split(sep).join("/");
}

export async function walkWorkspaceEntries(
	workspace: Workspace,
	fileSystem: FileSystem,
	requestedRoot: string,
	options: WalkWorkspaceOptions = {},
): Promise<readonly WalkedWorkspaceEntry[]> {
	const root = await workspace.resolvePath(requestedRoot);
	if (!root.exists) throw new Error(`Path does not exist: ${root.canonicalPath}`);
	if (options.insideWorkspaceOnly && !root.insideWorkspace) {
		throw new Error(`Path is outside the Workspace: ${root.canonicalPath}`);
	}

	const entries: WalkedWorkspaceEntry[] = [];
	const visitedDirectories = new Set<string>();
	const visitedFiles = new Set<string>();

	const visit = async (canonicalPath: string): Promise<void> => {
		options.signal?.throwIfAborted();
		const status = await fileSystem.stat(canonicalPath);
		if (status.kind === "file") {
			if (visitedFiles.has(canonicalPath)) return;
			visitedFiles.add(canonicalPath);
			entries.push({
				canonicalPath,
				relativePath: displayWorkspacePath(workspace, canonicalPath),
				kind: "file",
			});
			return;
		}
		if (status.kind !== "directory" || visitedDirectories.has(canonicalPath)) return;
		visitedDirectories.add(canonicalPath);

		const children = [...(await fileSystem.readDirectory(canonicalPath))].sort((left, right) =>
			left.name.localeCompare(right.name),
		);
		for (const entry of children) {
			options.signal?.throwIfAborted();
			if (IGNORED_DIRECTORY_NAMES.has(entry.name) && entry.kind !== "file") continue;
			try {
				const child = await workspace.resolvePath(join(canonicalPath, entry.name));
				if (!child.exists || (options.insideWorkspaceOnly && !child.insideWorkspace)) continue;
				const childStatus = await fileSystem.stat(child.canonicalPath);
				if (childStatus.kind === "directory" && !visitedDirectories.has(child.canonicalPath)) {
					entries.push({
						canonicalPath: child.canonicalPath,
						relativePath: displayWorkspacePath(workspace, child.canonicalPath),
						kind: "directory",
					});
				}
				await visit(child.canonicalPath);
			} catch (error) {
				if (!isSkippableFileSystemError(error)) throw error;
			}
		}
	};

	await visit(root.canonicalPath);
	return entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export async function walkWorkspaceFiles(
	workspace: Workspace,
	fileSystem: FileSystem,
	requestedRoot: string,
	options: WalkWorkspaceOptions = {},
): Promise<readonly WalkedWorkspaceFile[]> {
	return (await walkWorkspaceEntries(workspace, fileSystem, requestedRoot, options)).filter(
		(entry) => entry.kind === "file",
	);
}

function isSkippableFileSystemError(error: unknown): boolean {
	return isFileSystemError(error, "EACCES") || isFileSystemError(error, "ENOENT") || isFileSystemError(error, "ELOOP");
}
