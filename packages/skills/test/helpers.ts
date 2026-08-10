import type { Stats } from "node:fs";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import type { SkillFileKind, SkillFileStatus, SkillFileSystem } from "../src/index.ts";

function kindOf(status: Stats): SkillFileKind {
	if (status.isSymbolicLink()) return "symbolic-link";
	if (status.isFile()) return "file";
	if (status.isDirectory()) return "directory";
	return "other";
}

function snapshot(status: Stats): SkillFileStatus {
	return {
		kind: kindOf(status),
		size: status.size,
		modifiedAt: status.mtimeMs,
		device: String(status.dev),
		inode: String(status.ino),
	};
}

export function nodeSkillFileSystem(): SkillFileSystem {
	return {
		realpath,
		stat: async (path) => snapshot(await stat(path)),
		lstat: async (path) => snapshot(await lstat(path)),
		readFile,
		readDirectory: async (path) =>
			(await readdir(path, { withFileTypes: true })).map((entry) => ({
				name: entry.name,
				kind: entry.isSymbolicLink()
					? "symbolic-link"
					: entry.isFile()
						? "file"
						: entry.isDirectory()
							? "directory"
							: "other",
			})),
	};
}

export function skillText(
	name: string,
	description = `${name} does useful work`,
	body = `# ${name}\n\nFollow these instructions.\n`,
): string {
	return `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
}
