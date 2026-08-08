import { join, relative, sep } from "node:path";
import type { ToolExecutionContext } from "@coda/agent";
import type { FileSystem } from "../host/file-system.ts";
import { isFileSystemError } from "../host/file-system.ts";
import { hasWorkspacePathAccess } from "../policy.ts";
import type { Workspace } from "../workspace.ts";

const IGNORED_DIRECTORY_NAMES = new Set([".git", ".coda", "node_modules"]);

export interface WalkedFile {
	readonly canonicalPath: string;
	readonly relativePath: string;
}

export interface WalkedEntry extends WalkedFile {
	readonly kind: "directory" | "file";
}

export function displayPath(workspace: Workspace, canonicalPath: string): string {
	const value = relative(workspace.root, canonicalPath);
	return value === "" ? "." : value.split(sep).join("/");
}

export async function walkEntries(
	workspace: Workspace,
	fileSystem: FileSystem,
	requestedRoot: string,
	context: Pick<ToolExecutionContext, "invocationId" | "signal">,
	toolName: "find" | "grep",
): Promise<readonly WalkedEntry[]> {
	const root = await workspace.resolvePath(requestedRoot, "read");
	if (!hasWorkspacePathAccess(workspace, root, context.invocationId, toolName, "read")) {
		throw new Error(`Path access was not granted: ${root.canonicalPath}`);
	}
	if (!root.exists) throw new Error(`Path does not exist: ${root.canonicalPath}`);

	const entries: WalkedEntry[] = [];
	const visitedDirectories = new Set<string>();
	const visitedFiles = new Set<string>();

	const visit = async (canonicalPath: string): Promise<void> => {
		context.signal.throwIfAborted();
		const status = await fileSystem.stat(canonicalPath);
		if (status.kind === "file") {
			const resolved = await workspace.resolvePath(canonicalPath, "read");
			if (
				visitedFiles.has(canonicalPath) ||
				!hasWorkspacePathAccess(workspace, resolved, context.invocationId, toolName, "read")
			) {
				return;
			}
			visitedFiles.add(canonicalPath);
			entries.push({ canonicalPath, relativePath: displayPath(workspace, canonicalPath), kind: "file" });
			return;
		}
		if (status.kind !== "directory" || visitedDirectories.has(canonicalPath)) return;
		visitedDirectories.add(canonicalPath);
		const children = [...(await fileSystem.readDirectory(canonicalPath))].sort((left, right) =>
			left.name.localeCompare(right.name),
		);
		for (const entry of children) {
			context.signal.throwIfAborted();
			if (entry.kind === "directory" && IGNORED_DIRECTORY_NAMES.has(entry.name)) continue;
			const requestedChild = join(canonicalPath, entry.name);
			try {
				const child = await workspace.resolvePath(requestedChild, "read");
				if (!child.exists || !hasWorkspacePathAccess(workspace, child, context.invocationId, toolName, "read")) {
					continue;
				}
				const childStatus = await fileSystem.stat(child.canonicalPath);
				if (childStatus.kind === "directory" && !visitedDirectories.has(child.canonicalPath)) {
					entries.push({
						canonicalPath: child.canonicalPath,
						relativePath: displayPath(workspace, child.canonicalPath),
						kind: "directory",
					});
				}
				await visit(child.canonicalPath);
			} catch (error) {
				if (!isFileSystemError(error, "ENOENT") && !isFileSystemError(error, "EACCES")) throw error;
			}
		}
	};

	await visit(root.canonicalPath);
	return entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export async function walkFiles(
	workspace: Workspace,
	fileSystem: FileSystem,
	requestedRoot: string,
	context: Pick<ToolExecutionContext, "invocationId" | "signal">,
	toolName: "find" | "grep",
): Promise<readonly WalkedFile[]> {
	return (await walkEntries(workspace, fileSystem, requestedRoot, context, toolName)).filter(
		(entry) => entry.kind === "file",
	);
}

export async function readSearchableText(fileSystem: FileSystem, path: string): Promise<string | undefined> {
	const status = await fileSystem.stat(path);
	if (status.size > 2 * 1024 * 1024) return undefined;
	const bytes = await fileSystem.readFile(path);
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return undefined;
	}
	return text.includes("\0") ? undefined : text;
}
