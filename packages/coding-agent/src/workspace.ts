import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ToolInvocationId } from "@coda/agent";
import type { FileSystem } from "./host/file-system.ts";
import { isFileSystemError } from "./host/file-system.ts";

export type PathIntent = "read" | "write";

export interface ResolvedWorkspacePath {
	readonly requestedPath: string;
	readonly lexicalPath: string;
	readonly canonicalPath: string;
	readonly exists: boolean;
	readonly insideWorkspace: boolean;
}

export interface WorkspacePathGrant {
	readonly invocationId: ToolInvocationId;
	readonly toolName: string;
	readonly intent: PathIntent;
	readonly canonicalPath: string;
	readonly recursive: boolean;
}

export interface Workspace {
	readonly root: string;
	resolvePath(requestedPath: string, intent: PathIntent): Promise<ResolvedWorkspacePath>;
	grantPath(grant: WorkspacePathGrant): void;
	isPathGranted(invocationId: ToolInvocationId, toolName: string, intent: PathIntent, canonicalPath: string): boolean;
}

function isContained(root: string, target: string): boolean {
	const fromRoot = relative(root, target);
	return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

async function exists(fileSystem: FileSystem, path: string): Promise<boolean> {
	try {
		await fileSystem.lstat(path);
		return true;
	} catch (error) {
		if (isFileSystemError(error, "ENOENT")) return false;
		throw error;
	}
}

async function canonicalizeCandidate(
	fileSystem: FileSystem,
	lexicalPath: string,
): Promise<{ canonicalPath: string; exists: boolean }> {
	if (await exists(fileSystem, lexicalPath)) {
		return { canonicalPath: await fileSystem.realpath(lexicalPath), exists: true };
	}

	let ancestor = dirname(lexicalPath);
	let suffix = lexicalPath.slice(ancestor.length + (ancestor.endsWith(sep) ? 0 : 1));
	while (!(await exists(fileSystem, ancestor))) {
		const parent = dirname(ancestor);
		if (parent === ancestor) throw new Error(`No existing ancestor for path: ${lexicalPath}`);
		const name = ancestor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1));
		suffix = join(name, suffix);
		ancestor = parent;
	}
	const canonicalAncestor = await fileSystem.realpath(ancestor);
	return { canonicalPath: resolve(canonicalAncestor, suffix), exists: false };
}

function validateRequestedPath(requestedPath: string): void {
	if (requestedPath.length === 0) throw new Error("Path must not be empty");
	if (requestedPath === "~" || requestedPath.startsWith(`~${sep}`)) {
		throw new Error("Home-directory shorthand is not supported; use an explicit path");
	}
	if (requestedPath.startsWith("file://")) throw new Error("file:// paths are not supported");
}

export async function createWorkspace(root: string, fileSystem: FileSystem): Promise<Workspace> {
	const canonicalRoot = await fileSystem.realpath(resolve(root));
	const rootStatus = await fileSystem.stat(canonicalRoot);
	if (rootStatus.kind !== "directory") throw new Error(`Workspace is not a directory: ${root}`);
	const grants = new Map<ToolInvocationId, WorkspacePathGrant[]>();

	return {
		root: canonicalRoot,
		resolvePath: async (requestedPath) => {
			validateRequestedPath(requestedPath);
			const lexicalPath = resolve(canonicalRoot, requestedPath);
			const canonical = await canonicalizeCandidate(fileSystem, lexicalPath);
			return {
				requestedPath,
				lexicalPath,
				canonicalPath: canonical.canonicalPath,
				exists: canonical.exists,
				insideWorkspace: isContained(canonicalRoot, canonical.canonicalPath),
			};
		},
		grantPath: (grant) => {
			const invocationGrants = grants.get(grant.invocationId) ?? [];
			if (
				invocationGrants.some(
					(existing) =>
						existing.toolName === grant.toolName &&
						existing.intent === grant.intent &&
						existing.canonicalPath === grant.canonicalPath &&
						existing.recursive === grant.recursive,
				)
			) {
				return;
			}
			invocationGrants.push(Object.freeze({ ...grant }));
			grants.set(grant.invocationId, invocationGrants);
		},
		isPathGranted: (invocationId, toolName, intent, canonicalPath) => {
			return (
				grants
					.get(invocationId)
					?.some(
						(grant) =>
							grant.toolName === toolName &&
							grant.intent === intent &&
							(canonicalPath === grant.canonicalPath ||
								(grant.recursive && isContained(grant.canonicalPath, canonicalPath))),
					) ?? false
			);
		},
	};
}
