import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { FileStatus, FileSystem } from "../host/file-system.ts";
import type { ProcessRunner, ProcessRunResult } from "../host/process-runner.ts";
import {
	type CompletionWorkspaceEvidenceProvider,
	WORKSPACE_EVIDENCE_SCHEMA_VERSION,
	type WorkspaceEvidenceSnapshot,
} from "./types.ts";

const MAX_CHANGED_PATHS = 256;
const MAX_PATH_CHARACTERS = 512;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_UNTRACKED_FILE_BYTES = 2 * 1024 * 1024;
const MAX_UNTRACKED_TOTAL_BYTES = 8 * 1024 * 1024;

export interface GitWorkspaceEvidenceOptions {
	readonly processRunner: ProcessRunner;
	readonly fileSystem: FileSystem;
	readonly workspace: string | (() => string);
	readonly environment: Readonly<Record<string, string | undefined>>;
	readonly now: () => number;
}

type ResolvedGitWorkspaceEvidenceOptions = Omit<GitWorkspaceEvidenceOptions, "workspace"> & {
	readonly workspace: string;
};

export function createGitWorkspaceEvidenceProvider(
	options: GitWorkspaceEvidenceOptions,
): CompletionWorkspaceEvidenceProvider {
	return {
		capture: async () =>
			captureGitWorkspace({
				...options,
				workspace: typeof options.workspace === "function" ? options.workspace() : options.workspace,
			}),
	};
}

async function captureGitWorkspace(options: ResolvedGitWorkspaceEvidenceOptions): Promise<WorkspaceEvidenceSnapshot> {
	const [statusAttempt, diffAttempt] = await Promise.all([
		runGit(options, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
		runGit(options, ["diff", "--no-ext-diff", "--binary", "--no-color", "HEAD", "--"]),
	]);
	const capturedAt = options.now();
	const status = statusAttempt.result;
	const diff = diffAttempt.result;
	const statusSucceeded = successful(status);
	const diffSucceeded = successful(diff);
	const parsed = statusSucceeded ? parsePorcelainStatus(status.stdout) : { paths: [], omitted: 0, untrackedPaths: [] };
	const untracked = statusSucceeded
		? await hashUntrackedFiles(options, parsed.untrackedPaths, parsed.omitted)
		: { complete: false, sha256: null, diagnostics: [] };
	const diagnostics = [
		...attemptDiagnostics("git_status", statusAttempt),
		...attemptDiagnostics("git_diff", diffAttempt),
		...untracked.diagnostics,
	];
	if (!statusSucceeded) {
		return freezeSnapshot({
			schemaVersion: WORKSPACE_EVIDENCE_SCHEMA_VERSION,
			status: "unavailable",
			capturedAt,
			dirty: null,
			changedPaths: [],
			omittedChangedPaths: 0,
			statusSha256: null,
			diffSha256: null,
			untrackedSha256: null,
			fingerprint: null,
			diagnostics,
		});
	}
	const statusSha256 = sha256(status.stdout);
	const diffSha256 = diff ? sha256(diff.stdout) : null;
	const complete = statusSucceeded && diffSucceeded && untracked.complete;
	return freezeSnapshot({
		schemaVersion: WORKSPACE_EVIDENCE_SCHEMA_VERSION,
		status: complete ? "complete" : "partial",
		capturedAt,
		dirty: status.stdout.length > 0,
		changedPaths: parsed.paths,
		omittedChangedPaths: parsed.omitted,
		statusSha256,
		diffSha256,
		untrackedSha256: untracked.sha256,
		fingerprint: complete ? sha256(`${statusSha256}\n${diffSha256}\n${untracked.sha256}`) : null,
		diagnostics,
	});
}

interface GitAttempt {
	readonly result?: ProcessRunResult;
	readonly error?: unknown;
}

async function runGit(options: ResolvedGitWorkspaceEvidenceOptions, args: readonly string[]): Promise<GitAttempt> {
	const controller = new AbortController();
	try {
		return {
			result: await options.processRunner.run({
				executable: "git",
				args,
				cwd: options.workspace,
				environment: definedEnvironment(options.environment),
				signal: controller.signal,
				timeoutMs: 2_000,
				maxOutputBytes: MAX_OUTPUT_BYTES,
				maxOutputLines: 16_384,
			}),
		};
	} catch (error) {
		return { error };
	}
}

function successful(result: ProcessRunResult | undefined): result is ProcessRunResult {
	return Boolean(result && result.exitCode === 0 && !result.timedOut && !result.truncated);
}

function attemptDiagnostics(prefix: string, attempt: GitAttempt): readonly string[] {
	if (attempt.error) return [`${prefix}_unavailable`];
	const result = attempt.result;
	if (!result) return [`${prefix}_missing`];
	const diagnostics: string[] = [];
	if (result.timedOut) diagnostics.push(`${prefix}_timed_out`);
	if (result.truncated) diagnostics.push(`${prefix}_truncated`);
	if (result.signal) diagnostics.push(`${prefix}_signal_${result.signal}`);
	if (result.exitCode !== 0) diagnostics.push(`${prefix}_exit_${result.exitCode ?? "unknown"}`);
	return diagnostics;
}

function parsePorcelainStatus(output: string): {
	readonly paths: readonly string[];
	readonly omitted: number;
	readonly untrackedPaths: readonly string[];
} {
	const paths: string[] = [];
	const untrackedPaths: string[] = [];
	const records = output.split("\0");
	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		if (!record || record.length < 4 || record[2] !== " ") continue;
		const state = record.slice(0, 2);
		const path = record.slice(3);
		paths.push(safePath(path));
		if (state === "??") untrackedPaths.push(path);
		if (state.includes("R") || state.includes("C")) {
			const source = records[++index];
			if (source) paths.push(safePath(source));
		}
	}
	const unique = [...new Set(paths)];
	return {
		paths: unique.slice(0, MAX_CHANGED_PATHS),
		omitted: Math.max(0, unique.length - MAX_CHANGED_PATHS),
		untrackedPaths: untrackedPaths.slice(0, MAX_CHANGED_PATHS),
	};
}

async function hashUntrackedFiles(
	options: ResolvedGitWorkspaceEvidenceOptions,
	paths: readonly string[],
	omittedPaths: number,
): Promise<{ readonly complete: boolean; readonly sha256: string; readonly diagnostics: readonly string[] }> {
	const entries: string[] = [];
	const diagnostics: string[] = [];
	let totalBytes = 0;
	let complete = omittedPaths === 0;
	if (omittedPaths > 0) diagnostics.push("untracked_hash_paths_omitted");
	for (const path of paths) {
		const absolutePath = resolve(options.workspace, path);
		if (!isContained(options.workspace, absolutePath)) {
			complete = false;
			diagnostics.push("untracked_hash_path_outside_workspace");
			continue;
		}
		try {
			const before = await options.fileSystem.lstat(absolutePath);
			if (
				before.kind !== "file" ||
				before.size > MAX_UNTRACKED_FILE_BYTES ||
				totalBytes + before.size > MAX_UNTRACKED_TOTAL_BYTES
			) {
				complete = false;
				diagnostics.push(before.kind === "file" ? "untracked_hash_size_limit" : "untracked_hash_not_file");
				continue;
			}
			const bytes = await options.fileSystem.readFile(absolutePath);
			const after = await options.fileSystem.lstat(absolutePath);
			if (bytes.byteLength !== before.size || !sameFileStatus(before, after)) {
				complete = false;
				diagnostics.push("untracked_hash_changed_during_capture");
				continue;
			}
			totalBytes += bytes.byteLength;
			entries.push(`${safePath(path)}\0${sha256(bytes)}`);
		} catch {
			complete = false;
			diagnostics.push("untracked_hash_unavailable");
		}
	}
	return { complete, sha256: sha256(entries.sort().join("\n")), diagnostics: [...new Set(diagnostics)] };
}

function isContained(root: string, target: string): boolean {
	const fromRoot = relative(root, target);
	return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

function sameFileStatus(left: FileStatus, right: FileStatus): boolean {
	return (
		left.kind === right.kind &&
		left.size === right.size &&
		left.modifiedAt === right.modifiedAt &&
		left.device === right.device &&
		left.inode === right.inode
	);
}

function safePath(path: string): string {
	const sanitized = [...path]
		.map((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code < 32 || code === 127 ? "�" : character;
		})
		.join("");
	return sanitized.length <= MAX_PATH_CHARACTERS ? sanitized : `${sanitized.slice(0, MAX_PATH_CHARACTERS - 1)}…`;
}

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function definedEnvironment(
	environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
	return Object.fromEntries(
		Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
}

function freezeSnapshot(snapshot: WorkspaceEvidenceSnapshot): WorkspaceEvidenceSnapshot {
	return Object.freeze({
		...snapshot,
		changedPaths: Object.freeze([...snapshot.changedPaths]),
		diagnostics: Object.freeze([...snapshot.diagnostics]),
	});
}
