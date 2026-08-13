import type { ProcessRunner } from "../host/process-runner.ts";
import type { RunEvidenceWorkspaceDiffSupplement } from "./run-evidence.ts";

const MAX_GIT_STATUS_BYTES = 512 * 1024;
const MAX_GIT_PREFIX_BYTES = 8 * 1024;

const GIT_ENVIRONMENT_NAMES = Object.freeze([
	"HOME",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"PATH",
	"Path",
	"SystemRoot",
	"TEMP",
	"TMP",
	"TMPDIR",
	"USERPROFILE",
	"WINDIR",
] as const);

/** Collects the final Git-visible Workspace delta, including untracked files and rename endpoints. */
export async function collectWorkspaceDiff(options: {
	readonly processRunner: ProcessRunner;
	readonly workspace: string;
	readonly environment: Readonly<Record<string, string | undefined>>;
}): Promise<RunEvidenceWorkspaceDiffSupplement> {
	try {
		const environment = gitEnvironment(options.environment);
		const prefixResult = await options.processRunner.run({
			executable: "git",
			args: ["rev-parse", "--show-prefix"],
			cwd: options.workspace,
			environment,
			signal: new AbortController().signal,
			timeoutMs: 2_000,
			maxOutputBytes: MAX_GIT_PREFIX_BYTES,
			maxOutputLines: 2,
		});
		if (prefixResult.exitCode !== 0 || prefixResult.timedOut || prefixResult.truncated) return unavailable();
		const workspacePrefix = parseWorkspacePrefix(prefixResult.stdout);
		if (workspacePrefix === undefined) return unavailable();
		const result = await options.processRunner.run({
			executable: "git",
			args: ["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."],
			cwd: options.workspace,
			environment,
			signal: new AbortController().signal,
			timeoutMs: 2_000,
			maxOutputBytes: MAX_GIT_STATUS_BYTES,
			maxOutputLines: 10_000,
		});
		if (result.exitCode !== 0 || result.timedOut) return unavailable();
		const parsed = parseGitStatusPaths(result.stdout, workspacePrefix);
		return Object.freeze({
			status: result.truncated || parsed.partial ? ("partial" as const) : ("complete" as const),
			paths: parsed.paths,
			...(result.truncated || parsed.partial ? { omitted: 1 } : {}),
		});
	} catch {
		return unavailable();
	}
}

export function parseGitStatusPaths(
	output: string,
	workspacePrefix = "",
): {
	readonly paths: readonly string[];
	readonly partial: boolean;
} {
	if (!isWorkspacePrefix(workspacePrefix)) return Object.freeze({ paths: Object.freeze([]), partial: true });
	const records = output.split("\0");
	if (records.at(-1) === "") records.pop();
	const paths: string[] = [];
	let partial = false;
	for (let index = 0; index < records.length; index++) {
		const record = records[index]!;
		if (record.length < 4 || record[2] !== " ") {
			partial = true;
			continue;
		}
		const status = record.slice(0, 2);
		const path = record.slice(3);
		if (path.length === 0) {
			partial = true;
			continue;
		}
		const relativePath = workspaceRelativeGitPath(path, workspacePrefix);
		if (relativePath === undefined) partial = true;
		else paths.push(relativePath);
		if (/[RC]/u.test(status)) {
			const original = records[++index];
			if (!original) partial = true;
			else {
				const relativeOriginal = workspaceRelativeGitPath(original, workspacePrefix);
				if (relativeOriginal === undefined) partial = true;
				else paths.push(relativeOriginal);
			}
		}
	}
	return Object.freeze({ paths: Object.freeze([...new Set(paths)]), partial });
}

function unavailable(): RunEvidenceWorkspaceDiffSupplement {
	return Object.freeze({ status: "unavailable", paths: Object.freeze([]) });
}

function parseWorkspacePrefix(output: string): string | undefined {
	const value = output.endsWith("\n") ? output.slice(0, -1) : output;
	return isWorkspacePrefix(value) ? value : undefined;
}

function isWorkspacePrefix(value: string): boolean {
	if (value === "") return true;
	return (
		value.endsWith("/") &&
		!value.startsWith("/") &&
		!value.includes("\\") &&
		!value.includes("\0") &&
		!value.includes("\r") &&
		!value.includes("\n") &&
		value
			.split("/")
			.slice(0, -1)
			.every((part) => part !== "" && part !== "." && part !== "..")
	);
}

function workspaceRelativeGitPath(path: string, prefix: string): string | undefined {
	if (prefix === "") return path;
	return path.startsWith(prefix) && path.length > prefix.length ? path.slice(prefix.length) : undefined;
}

function gitEnvironment(environment: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string>> {
	const selected = Object.fromEntries(
		GIT_ENVIRONMENT_NAMES.flatMap((name) => {
			const value = environment[name];
			return value === undefined ? [] : [[name, value]];
		}),
	);
	return Object.freeze({ ...selected, GIT_OPTIONAL_LOCKS: "0" });
}
