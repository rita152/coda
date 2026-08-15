import { join } from "node:path";
import type { DiagnosticSink } from "@coda/tui";
import type { DirectoryEntry, FileSystem } from "../host/file-system.ts";

function isFileSystemError(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && (error as Error & { code?: string }).code === code;
}

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;

interface TemporaryLog {
	readonly path: string;
	readonly size: number;
	readonly modifiedAt: number;
}

export interface TemporaryLogCleanupOptions {
	readonly fileSystem: FileSystem;
	readonly homeDirectory: string;
	readonly now: number;
	readonly diagnostics?: DiagnosticSink;
	readonly retentionMs?: number;
	readonly maxTotalBytes?: number;
}

export interface TemporaryLogCleanupResult {
	readonly removed: readonly string[];
	readonly retainedBytes: number;
}

function collectOverflowPaths(value: unknown, paths: Set<string>): void {
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const item of value) collectOverflowPaths(item, paths);
		return;
	}
	for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
		if (name === "overflowPath" && typeof item === "string") paths.add(item);
		else collectOverflowPaths(item, paths);
	}
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

async function activeSessionReferences(fileSystem: FileSystem, homeDirectory: string): Promise<ReadonlySet<string>> {
	const root = join(homeDirectory, ".coda", "sessions");
	let workspaces: readonly DirectoryEntry[];
	try {
		workspaces = await fileSystem.readDirectory(root);
	} catch (error) {
		if (isFileSystemError(error, "ENOENT")) return new Set();
		throw error;
	}
	const references = new Set<string>();
	for (const workspace of workspaces) {
		if (workspace.kind !== "directory") continue;
		const directory = join(root, workspace.name);
		for (const entry of await fileSystem.readDirectory(directory)) {
			if (entry.kind !== "file" || !entry.name.endsWith(".jsonl")) continue;
			const path = join(directory, entry.name);
			if (!(await exists(fileSystem, `${path}.lock`))) continue;
			const text = new TextDecoder("utf-8", { fatal: true }).decode(await fileSystem.readFile(path));
			for (const line of text.split("\n")) {
				if (!line) continue;
				collectOverflowPaths(JSON.parse(line), references);
			}
		}
	}
	return references;
}

async function report(diagnostics: DiagnosticSink | undefined, code: string, message: string): Promise<void> {
	await diagnostics?.({ code, message });
}

export async function cleanupTemporaryLogs(options: TemporaryLogCleanupOptions): Promise<TemporaryLogCleanupResult> {
	const directory = join(options.homeDirectory, ".coda", "tmp");
	let entries: readonly DirectoryEntry[];
	try {
		entries = await options.fileSystem.readDirectory(directory);
	} catch (error) {
		if (isFileSystemError(error, "ENOENT")) return { removed: [], retainedBytes: 0 };
		await report(
			options.diagnostics,
			"temporary-log.cleanup-failed",
			error instanceof Error ? error.message : String(error),
		);
		return { removed: [], retainedBytes: 0 };
	}

	let references: ReadonlySet<string>;
	try {
		references = await activeSessionReferences(options.fileSystem, options.homeDirectory);
	} catch (error) {
		await report(
			options.diagnostics,
			"temporary-log.reference-scan-failed",
			error instanceof Error ? error.message : String(error),
		);
		return { removed: [], retainedBytes: 0 };
	}

	const logs: TemporaryLog[] = [];
	for (const entry of entries) {
		if (entry.kind !== "file" || !entry.name.endsWith(".log")) continue;
		const path = join(directory, entry.name);
		try {
			const status = await options.fileSystem.lstat(path);
			if (status.kind === "file") logs.push({ path, size: status.size, modifiedAt: status.modifiedAt });
		} catch (error) {
			await report(
				options.diagnostics,
				"temporary-log.inspect-failed",
				error instanceof Error ? error.message : String(error),
			);
		}
	}
	logs.sort((left, right) => left.modifiedAt - right.modifiedAt || left.path.localeCompare(right.path));
	let retainedBytes = logs.reduce((total, log) => total + log.size, 0);
	const removed: string[] = [];
	const removedPaths = new Set<string>();
	const remove = async (log: TemporaryLog): Promise<boolean> => {
		try {
			await options.fileSystem.removeFile(log.path);
			removed.push(log.path);
			removedPaths.add(log.path);
			retainedBytes -= log.size;
			return true;
		} catch (error) {
			await report(
				options.diagnostics,
				"temporary-log.remove-failed",
				error instanceof Error ? error.message : String(error),
			);
			return false;
		}
	};

	const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
	for (const log of logs) {
		if (!references.has(log.path) && options.now - log.modifiedAt > retentionMs) await remove(log);
	}
	const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
	for (const log of logs) {
		if (retainedBytes <= maxTotalBytes) break;
		if (!removedPaths.has(log.path) && !references.has(log.path)) await remove(log);
	}
	return { removed, retainedBytes };
}
