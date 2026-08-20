import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import type { SkillRoot } from "@coda/skills";
import type { FileSystem } from "../host/file-system.ts";
import type { CodingSkillOrigin } from "./types.ts";

export interface CollectSkillRootsOptions {
	readonly workspace: string;
	readonly homeDirectory: string;
	readonly fileSystem: Pick<FileSystem, "stat">;
}

async function nearestProjectRoot(fileSystem: Pick<FileSystem, "stat">, workspace: string): Promise<string> {
	let directory = workspace;
	for (;;) {
		try {
			await fileSystem.stat(join(directory, ".git"));
			return directory;
		} catch {
			// Missing or unreadable markers do not prevent the rest of the Skill catalog from loading.
		}
		const parent = dirname(directory);
		if (parent === directory) return workspace;
		directory = parent;
	}
}

function directoriesFromRootToWorkspace(projectRoot: string, workspace: string): readonly string[] {
	const directories: string[] = [];
	let directory = workspace;
	for (;;) {
		directories.push(directory);
		if (directory === projectRoot) break;
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	return directories.reverse();
}

function workspaceSourceLabel(root: string, workspace: string): string {
	const path = relative(workspace, root).split(sep).join("/");
	return path === ".." || path.startsWith("../") ? path : `./${path}`;
}

export async function collectSkillRoots(
	options: CollectSkillRootsOptions,
): Promise<readonly SkillRoot<CodingSkillOrigin>[]> {
	if (!isAbsolute(options.workspace) || !isAbsolute(options.homeDirectory)) {
		throw new TypeError("Workspace and home directory must be absolute");
	}
	const workspace = normalize(options.workspace);
	const homeDirectory = normalize(options.homeDirectory);
	const projectRoot = await nearestProjectRoot(options.fileSystem, workspace);
	const directories = directoriesFromRootToWorkspace(projectRoot, workspace);
	const roots: SkillRoot<CodingSkillOrigin>[] = directories.map((directory, index) => {
		const path = join(directory, ".agents", "skills");
		return Object.freeze({
			path,
			origin: Object.freeze({
				scope: "workspace" as const,
				root: path,
				priority: (directories.length - index - 1) / directories.length,
				sourceLabel: workspaceSourceLabel(path, workspace),
				kind: "direct" as const,
			}),
			symlinks: Object.freeze({ mode: "follow" as const, containmentRoot: projectRoot }),
		});
	});
	for (const [path, priority, sourceLabel] of [
		[join(homeDirectory, ".agents", "skills"), 2, "~/.agents/skills"],
		[join(homeDirectory, ".codex", "skills"), 2.5, "~/.codex/skills"],
	] as const) {
		roots.push(
			Object.freeze({
				path,
				origin: Object.freeze({ scope: "user", root: path, priority, sourceLabel, kind: "direct" }),
				symlinks: Object.freeze({ mode: "follow", allowOutsideRoot: true }),
			}),
		);
	}
	const seen = new Set<string>();
	return Object.freeze(
		roots.filter(({ path }) => {
			if (seen.has(path)) return false;
			seen.add(path);
			return true;
		}),
	);
}
