export type FileKind = "directory" | "file" | "other" | "symbolic-link";

export interface FileStatus {
	readonly kind: FileKind;
	readonly size: number;
	readonly mode: number;
	readonly modifiedAt: number;
	/** Stable device identity when the host filesystem exposes it. */
	readonly device?: string;
	/** Stable inode/file identity when the host filesystem exposes it. */
	readonly inode?: string;
}

export interface DirectoryEntry {
	readonly name: string;
	readonly kind: FileKind;
}

export interface WritableFile {
	write(data: string | Uint8Array): Promise<void>;
	sync(): Promise<void>;
	close(): Promise<void>;
}

export interface FileSystem {
	realpath(path: string): Promise<string>;
	stat(path: string): Promise<FileStatus>;
	lstat(path: string): Promise<FileStatus>;
	readFile(path: string): Promise<Uint8Array>;
	readDirectory(path: string): Promise<readonly DirectoryEntry[]>;
	makeDirectory(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
	open(path: string, flags: string, mode?: number): Promise<WritableFile>;
	rename(from: string, to: string): Promise<void>;
	removeFile(path: string): Promise<void>;
	removeDirectory(path: string): Promise<void>;
	setMode(path: string, mode: number): Promise<void>;
}

export function isFileSystemError(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && (error as Error & { code?: string }).code === code;
}
