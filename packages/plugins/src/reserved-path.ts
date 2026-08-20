import type { SkillFileSystem } from "@coda/skills";

const RESERVED_CODEX_PLUGIN_COMPONENT = ".codex-plugin";

export function containsReservedCodexPluginComponent(path: string): boolean {
	return path.split(/[\\/]/u).some((component) => component.toLowerCase() === RESERVED_CODEX_PLUGIN_COMPONENT);
}

function assertPortablePath(path: string): void {
	if (containsReservedCodexPluginComponent(path)) {
		throw new Error('Reserved ".codex-plugin" content is outside the Agent Plugins protocol');
	}
}

/**
 * A package-scoped filesystem that permits resolving an ordinary alias, but
 * rejects a reserved canonical result before callers can stat, enumerate, or
 * read through it. The conservative case-fold also protects case-insensitive
 * hosts when the directory spelling differs.
 */
export function guardReservedCodexPluginPaths(fileSystem: SkillFileSystem): SkillFileSystem {
	return Object.freeze({
		realpath: async (path: string) => {
			assertPortablePath(path);
			const canonical = await fileSystem.realpath(path);
			assertPortablePath(canonical);
			return canonical;
		},
		stat: async (path: string) => {
			assertPortablePath(path);
			return fileSystem.stat(path);
		},
		lstat: async (path: string) => {
			assertPortablePath(path);
			return fileSystem.lstat(path);
		},
		readFile: async (path: string) => {
			assertPortablePath(path);
			return fileSystem.readFile(path);
		},
		readDirectory: async (path: string) => {
			assertPortablePath(path);
			return fileSystem.readDirectory(path);
		},
	});
}
