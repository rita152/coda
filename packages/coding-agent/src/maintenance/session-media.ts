import { join } from "node:path";
import type { DiagnosticSink } from "@coda/tui";
import type { DirectoryEntry, FileSystem } from "../host/file-system.ts";
import { isFileSystemError } from "../host/file-system.ts";

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const DIGEST_PREFIX = /^([a-f0-9]{64})\./;

export interface SessionMediaCleanupOptions {
	readonly fileSystem: FileSystem;
	readonly homeDirectory: string;
	readonly now: number;
	readonly retentionMs?: number;
	readonly diagnostics?: DiagnosticSink;
}

export interface SessionMediaCleanupResult {
	readonly removed: readonly string[];
	readonly retainedBytes: number;
}

/** Removes only old Session media whose own journal contains no matching digest reference. */
export async function cleanupSessionMedia(options: SessionMediaCleanupOptions): Promise<SessionMediaCleanupResult> {
	const root = join(options.homeDirectory, ".coda", "sessions");
	let workspaces: readonly DirectoryEntry[];
	try {
		workspaces = await options.fileSystem.readDirectory(root);
	} catch (error) {
		if (isFileSystemError(error, "ENOENT")) return { removed: [], retainedBytes: 0 };
		await report(options.diagnostics, "session-media.scan-failed", error);
		return { removed: [], retainedBytes: 0 };
	}
	const removed: string[] = [];
	let retainedBytes = 0;
	for (const workspace of workspaces) {
		if (workspace.kind !== "directory") continue;
		const workspacePath = join(root, workspace.name);
		let entries: readonly DirectoryEntry[];
		try {
			entries = await options.fileSystem.readDirectory(workspacePath);
		} catch (error) {
			await report(options.diagnostics, "session-media.workspace-scan-failed", error);
			continue;
		}
		for (const entry of entries) {
			if (entry.kind !== "directory" || !entry.name.endsWith(".jsonl.media")) continue;
			const mediaDirectory = join(workspacePath, entry.name);
			const journalPath = join(workspacePath, entry.name.slice(0, -".media".length));
			let references: ReadonlySet<string>;
			try {
				references = await journalMediaDigests(options.fileSystem, journalPath);
			} catch (error) {
				if (!isFileSystemError(error, "ENOENT")) {
					await report(options.diagnostics, "session-media.reference-scan-failed", error);
					continue;
				}
				references = new Set();
			}
			let mediaEntries: readonly DirectoryEntry[];
			try {
				mediaEntries = await options.fileSystem.readDirectory(mediaDirectory);
			} catch (error) {
				await report(options.diagnostics, "session-media.directory-scan-failed", error);
				continue;
			}
			for (const mediaEntry of mediaEntries) {
				if (mediaEntry.kind !== "file") continue;
				const digest = DIGEST_PREFIX.exec(mediaEntry.name)?.[1];
				const path = join(mediaDirectory, mediaEntry.name);
				try {
					const status = await options.fileSystem.lstat(path);
					if (status.kind !== "file") continue;
					if (
						digest &&
						!references.has(digest) &&
						options.now - status.modifiedAt > (options.retentionMs ?? DEFAULT_RETENTION_MS)
					) {
						await options.fileSystem.removeFile(path);
						removed.push(path);
					} else {
						retainedBytes += status.size;
					}
				} catch (error) {
					await report(options.diagnostics, "session-media.inspect-or-remove-failed", error);
				}
			}
			try {
				await options.fileSystem.removeDirectory(mediaDirectory);
			} catch (error) {
				if (!isFileSystemError(error, "ENOTEMPTY") && !isFileSystemError(error, "ENOENT")) {
					await report(options.diagnostics, "session-media.directory-remove-failed", error);
				}
			}
		}
	}
	return { removed, retainedBytes };
}

async function journalMediaDigests(fileSystem: FileSystem, path: string): Promise<ReadonlySet<string>> {
	const text = new TextDecoder("utf-8", { fatal: true }).decode(await fileSystem.readFile(path));
	const digests = new Set<string>();
	for (const line of text.split("\n")) {
		if (!line) continue;
		collectDigests(JSON.parse(line), digests);
	}
	return digests;
}

function collectDigests(value: unknown, digests: Set<string>): void {
	if (Array.isArray(value)) {
		for (const entry of value) collectDigests(entry, digests);
		return;
	}
	if (!value || typeof value !== "object") return;
	const record = value as Record<string, unknown>;
	if (record.type === "media" && typeof record.digest === "string" && /^[a-f0-9]{64}$/.test(record.digest)) {
		digests.add(record.digest);
	}
	for (const entry of Object.values(record)) collectDigests(entry, digests);
}

async function report(sink: DiagnosticSink | undefined, code: string, error: unknown): Promise<void> {
	await sink?.({ code, message: error instanceof Error ? error.message : String(error) });
}
