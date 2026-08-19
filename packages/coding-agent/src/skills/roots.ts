import { isAbsolute, join } from "node:path";
import type { SkillRoot } from "@coda/skills";
import type { CodingSkillOrigin } from "./types.ts";

export interface CollectSkillRootsOptions {
	readonly workspace: string;
	readonly homeDirectory: string;
}

export async function collectSkillRoots(
	options: CollectSkillRootsOptions,
): Promise<readonly SkillRoot<CodingSkillOrigin>[]> {
	if (!isAbsolute(options.workspace) || !isAbsolute(options.homeDirectory)) {
		throw new TypeError("Workspace and home directory must be absolute");
	}
	const workspaceRoot = join(options.workspace, ".agents", "skills");
	const userRoot = join(options.homeDirectory, ".agents", "skills");
	return Object.freeze([
		Object.freeze({
			path: workspaceRoot,
			origin: Object.freeze({
				scope: "workspace",
				root: workspaceRoot,
				priority: 0,
				sourceLabel: "./.agents/skills",
				kind: "direct",
			}),
			symlinks: Object.freeze({ mode: "follow", containmentRoot: options.workspace }),
		}),
		Object.freeze({
			path: userRoot,
			origin: Object.freeze({
				scope: "user",
				root: userRoot,
				priority: 2,
				sourceLabel: "~/.agents/skills",
				kind: "direct",
			}),
			symlinks: Object.freeze({ mode: "follow", allowOutsideRoot: true }),
		}),
	] satisfies readonly SkillRoot<CodingSkillOrigin>[]);
}
