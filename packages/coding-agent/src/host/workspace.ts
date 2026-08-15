import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { FileSystem } from "./file-system.ts";
import { isFileSystemError } from "./file-system.ts";

export interface ResolvedWorkspacePath {
	readonly requestedPath: string;
	readonly lexicalPath: string;
	readonly canonicalPath: string;
	readonly exists: boolean;
	readonly insideWorkspace: boolean;
}

export interface Workspace {
	readonly root: string;
	resolvePath(requestedPath: string): Promise<ResolvedWorkspacePath>;
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
	};
}
