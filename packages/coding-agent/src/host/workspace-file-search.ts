import { basename } from "node:path";
import type { FileSystem } from "./file-system.ts";
import type { Workspace } from "./workspace.ts";
import { walkWorkspaceFiles } from "./workspace-walker.ts";

const RESULT_LIMIT = 200;

export type WorkspaceFileSearchSession = (query: string) => Promise<readonly string[]>;

export interface WorkspaceFileSearch {
	startSession(): WorkspaceFileSearchSession;
}

/**
 * Creates a lazy file index scoped to one Workspace. Paths are always returned
 * relative to the Workspace root and use forward slashes for Composer display.
 */
export function createWorkspaceFileSearch(workspace: Workspace, fileSystem: FileSystem): WorkspaceFileSearch {
	return Object.freeze({
		startSession: () => {
			let indexedFiles: Promise<readonly string[]> | undefined;
			return async (query: string) => {
				if (!indexedFiles) indexedFiles = collectWorkspaceFiles(workspace, fileSystem);
				const operation = indexedFiles;
				try {
					return rankWorkspaceFiles(await operation, query);
				} catch (error) {
					if (indexedFiles === operation) indexedFiles = undefined;
					throw error;
				}
			};
		},
	});
}

async function collectWorkspaceFiles(workspace: Workspace, fileSystem: FileSystem): Promise<readonly string[]> {
	return Object.freeze(
		(await walkWorkspaceFiles(workspace, fileSystem, ".", { insideWorkspaceOnly: true })).map(
			({ relativePath }) => relativePath,
		),
	);
}

function rankWorkspaceFiles(files: readonly string[], query: string): readonly string[] {
	const normalizedQuery = normalize(query);
	if (normalizedQuery.length === 0) return Object.freeze(files.slice(0, RESULT_LIMIT));

	return Object.freeze(
		files
			.flatMap((path) => {
				const score = matchScore(path, normalizedQuery);
				return score === undefined ? [] : [{ path, score }];
			})
			.sort(
				(left, right) =>
					left.score - right.score || left.path.length - right.path.length || left.path.localeCompare(right.path),
			)
			.slice(0, RESULT_LIMIT)
			.map(({ path }) => path),
	);
}

function matchScore(path: string, query: string): number | undefined {
	const normalizedPath = normalize(path);
	const normalizedName = normalize(basename(path));
	if (normalizedPath === query) return 0;
	if (normalizedName === query) return 1;
	if (normalizedName.startsWith(query)) return 10;
	if (normalizedPath.startsWith(query)) return 20;
	const nameIndex = normalizedName.indexOf(query);
	if (nameIndex >= 0) return 30 + nameIndex;
	const pathIndex = normalizedPath.indexOf(query);
	if (pathIndex >= 0) return 100 + pathIndex;
	const subsequenceSpan = matchedSubsequenceSpan(query, normalizedPath);
	return subsequenceSpan === undefined ? undefined : 1_000 + subsequenceSpan;
}

function matchedSubsequenceSpan(query: string, value: string): number | undefined {
	let queryIndex = 0;
	let firstIndex = -1;
	let lastIndex = -1;
	for (let valueIndex = 0; valueIndex < value.length && queryIndex < query.length; valueIndex++) {
		if (value[valueIndex] !== query[queryIndex]) continue;
		if (firstIndex < 0) firstIndex = valueIndex;
		lastIndex = valueIndex;
		queryIndex++;
	}
	return queryIndex === query.length ? lastIndex - firstIndex : undefined;
}

function normalize(value: string): string {
	return value.normalize("NFKC").toLocaleLowerCase("en-US");
}
