import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, realpath, rename, rmdir, stat, unlink } from "node:fs/promises";
import type { DirectoryEntry, FileKind, FileStatus, FileSystem, WritableFile } from "./file-system.ts";

function kindOf(status: Stats): FileKind {
	if (status.isSymbolicLink()) return "symbolic-link";
	if (status.isFile()) return "file";
	if (status.isDirectory()) return "directory";
	return "other";
}

function snapshot(status: Stats): FileStatus {
	return {
		kind: kindOf(status),
		size: status.size,
		mode: status.mode,
		modifiedAt: status.mtimeMs,
		device: String(status.dev),
		inode: String(status.ino),
	};
}

export function createNodeFileSystem(): FileSystem {
	return {
		realpath,
		stat: async (path) => snapshot(await stat(path)),
		lstat: async (path) => snapshot(await lstat(path)),
		readFile: async (path) => readFile(path),
		readDirectory: async (path): Promise<readonly DirectoryEntry[]> =>
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
		makeDirectory: async (path, options) => {
			await mkdir(path, options);
		},
		open: async (path, flags, mode): Promise<WritableFile> => {
			const handle = await open(path, flags, mode);
			return {
				write: async (data) => {
					await handle.writeFile(data);
				},
				sync: async () => handle.sync(),
				close: async () => handle.close(),
			};
		},
		rename,
		removeFile: unlink,
		removeDirectory: rmdir,
		setMode: chmod,
	};
}
