import { isAbsolute, relative, sep } from "node:path";
import type { FileStatus, FileSystem } from "../host/file-system.ts";

export interface ResolvedPluginTreeEntry {
	readonly path: string;
	readonly status: FileStatus;
}

export function pathHasComponent(path: string, component: string): boolean {
	const expected = component.toLowerCase();
	return path.split(/[\\/]/u).some((entry) => entry.toLowerCase() === expected);
}

export function pathIsContained(root: string, target: string): boolean {
	const fromRoot = relative(root, target);
	return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

/**
 * Resolves one already-enumerated package entry without letting a symbolic link
 * move traversal outside the canonical package root. Reserved canonical targets
 * are rejected before any operation is performed through the returned path.
 */
export async function resolvePluginTreeEntry(options: {
	readonly fileSystem: FileSystem;
	readonly canonicalRoot: string;
	readonly path: string;
	readonly relativePath: string;
	readonly ancestorDirectories: ReadonlySet<string>;
	readonly followSymbolicLinks: boolean;
	readonly reservedCanonicalComponents?: ReadonlySet<string>;
}): Promise<ResolvedPluginTreeEntry> {
	let status = await options.fileSystem.lstat(options.path);
	if (status.kind !== "symbolic-link") return Object.freeze({ path: options.path, status });
	if (!options.followSymbolicLinks) {
		throw new Error(`Plugin tree contains a symbolic link: ${options.relativePath}`);
	}

	const canonicalTarget = await options.fileSystem.realpath(options.path);
	if (!pathIsContained(options.canonicalRoot, canonicalTarget)) {
		throw new Error(
			`Plugin tree contains an unsafe symbolic link: ${options.relativePath} (target escapes its package root)`,
		);
	}
	for (const component of options.reservedCanonicalComponents ?? []) {
		if (pathHasComponent(canonicalTarget, component)) {
			throw new Error(
				`Plugin tree symbolic link resolves through reserved ${component} content: ${options.relativePath}`,
			);
		}
	}
	if (options.ancestorDirectories.has(canonicalTarget)) {
		throw new Error(`Plugin tree contains a symbolic-link cycle: ${options.relativePath}`);
	}
	status = await options.fileSystem.lstat(canonicalTarget);
	if (status.kind === "symbolic-link") {
		throw new Error(`Plugin tree symbolic link did not resolve to a stable target: ${options.relativePath}`);
	}
	return Object.freeze({ path: canonicalTarget, status });
}
