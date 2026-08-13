import type { AgentTool, ToolExecutionContext } from "@coda/agent";
import { Type } from "@coda/ai";
import type { FileSystem } from "../host/file-system.ts";
import { hasPermissionedPathAccess } from "../permissions/file-access.ts";
import type { ResolvedWorkspacePath, Workspace } from "../workspace.ts";
import { toolFailure } from "./failure.ts";
import { atomicDelete, atomicWrite, type TargetMutationCoordinator } from "./mutation.ts";
import {
	type MutationDelta,
	type MutationOperation,
	mutationFacts,
	mutationObservationFacts,
} from "./mutation-contract.ts";
import { MAX_PATCH_CHARACTERS, type PatchChunk, type PatchFileOperation, parsePatch } from "./patch/parser.ts";
import type { AtomicMutationWriter, MutationTargetIdentity } from "./sandboxed-mutation-writer.ts";
import { decodeTextFile, encodeTextFile, normalizeNewlines, sha256 } from "./text-mutation.ts";

const MAX_PATCH_TARGET_BYTES = 2 * 1024 * 1024;

const PatchParameters = Type.Object(
	{
		patch: Type.String({
			minLength: 1,
			maxLength: MAX_PATCH_CHARACTERS,
			description:
				"A *** Begin Patch / *** End Patch document containing Workspace-relative *** Add File, *** Update File, or *** Delete File sections. Prefix added content with '+'. Update hunks use optional '@@ exact context' anchors followed by exact ' ', '-', and '+' lines; use *** End of File only for an end-anchored hunk.",
		}),
	},
	{ additionalProperties: false },
);

interface PlannedPatchMutation {
	readonly requestedPath: string;
	readonly target: ResolvedWorkspacePath;
	readonly operation: MutationOperation;
	readonly beforeSha256: string | null;
	readonly afterSha256: string | null;
	readonly previousBytes: number;
	readonly bytes: number;
	readonly expectedIdentity?: MutationTargetIdentity;
	readonly data?: Uint8Array;
}

export function createPatchTool(
	workspace: Workspace,
	fileSystem: FileSystem,
	coordinator: TargetMutationCoordinator,
	writer: AtomicMutationWriter,
): AgentTool<typeof PatchParameters> {
	return {
		name: "patch",
		description:
			"Apply one permission-reviewed, multi-file patch with Add, Update, and Delete File sections. Prefer patch for related multi-hunk or multi-file edits. All files are preflighted before writes; each file commits atomically, but a later race can leave an explicitly reported partial application.",
		parameters: PatchParameters,
		replaySafety: "never",
		execute: async (arguments_, context) => {
			let operations: readonly PatchFileOperation[];
			try {
				operations = parsePatch(arguments_.patch).files;
			} catch (error) {
				return toolFailure(errorMessage(error), { code: "invalid_patch", phase: "parse" });
			}
			const attemptedPaths = operations.map(({ path }) => path);
			const initialTargets: ResolvedWorkspacePath[] = [];
			try {
				for (const operation of operations) {
					const target = await workspace.resolvePath(operation.path, "write");
					if (!hasPermissionedPathAccess(workspace, target, context.invocationId, "patch", "write")) {
						throw new Error(`Path access was not granted: ${target.canonicalPath}`);
					}
					initialTargets.push(target);
				}
				assertUniqueCanonicalTargets(initialTargets);
			} catch (error) {
				return patchFailure("preflight", attemptedPaths, [], [], error);
			}

			return coordinator.runMany(
				initialTargets.map(({ canonicalPath }) => canonicalPath),
				async () => {
					let plans: readonly PlannedPatchMutation[];
					try {
						plans = await preflightPatch(workspace, fileSystem, operations, initialTargets, context);
					} catch (error) {
						return patchFailure("preflight", attemptedPaths, [], [], error);
					}

					const committed: MutationDelta[] = [];
					const canonicalCommitted: string[] = [];
					for (const plan of plans) {
						try {
							context.signal.throwIfAborted();
							if (plan.operation === "delete") {
								await atomicDelete(
									workspace,
									fileSystem,
									plan.target,
									context,
									"patch",
									writer,
									plan.beforeSha256!,
									plan.expectedIdentity,
								);
							} else {
								await atomicWrite(
									workspace,
									fileSystem,
									plan.target,
									plan.data!,
									context,
									"patch",
									writer,
									plan.beforeSha256 ?? undefined,
									plan.expectedIdentity,
								);
							}
							committed.push(deltaFromPlan(plan));
							canonicalCommitted.push(plan.target.canonicalPath);
						} catch (error) {
							return patchFailure("commit", attemptedPaths, committed, canonicalCommitted, error);
						}
					}

					const facts = mutationFacts({ atomicity: "per-file", attemptedPaths, committedDelta: committed });
					return {
						content: `${patchSummary(committed.length, attemptedPaths.length)} Each file committed atomically; no cross-file rollback was needed or claimed.`,
						observation: {
							status: "ok",
							truncated: false,
							facts: mutationObservationFacts(facts),
						},
						details: {
							atomicity: "per-file",
							attemptedPaths,
							committedPaths: facts.committedPaths,
							notAppliedPaths: [],
							canonicalCommittedPaths: canonicalCommitted,
							committedDelta: committed,
						},
					};
				},
			);
		},
	};
}

async function preflightPatch(
	workspace: Workspace,
	fileSystem: FileSystem,
	operations: readonly PatchFileOperation[],
	initialTargets: readonly ResolvedWorkspacePath[],
	context: ToolExecutionContext,
): Promise<readonly PlannedPatchMutation[]> {
	const plans: PlannedPatchMutation[] = [];
	for (const [index, operation] of operations.entries()) {
		context.signal.throwIfAborted();
		const initial = initialTargets[index]!;
		const target = await workspace.resolvePath(operation.path, "write");
		if (
			target.canonicalPath !== initial.canonicalPath ||
			target.exists !== initial.exists ||
			!hasPermissionedPathAccess(workspace, target, context.invocationId, "patch", "write")
		) {
			throw new Error(`Target changed before patch preflight: ${operation.path}`);
		}
		if (operation.operation === "add") {
			if (target.exists) throw new Error(`Add target already exists: ${operation.path}`);
			const data = new TextEncoder().encode(operation.content);
			assertTargetSize(operation.path, data.byteLength);
			plans.push({
				requestedPath: operation.path,
				target,
				operation: "add",
				beforeSha256: null,
				afterSha256: sha256(data),
				previousBytes: 0,
				bytes: data.byteLength,
				data,
			});
			continue;
		}
		if (!target.exists)
			throw new Error(
				`${operation.operation === "delete" ? "Delete" : "Update"} target does not exist: ${operation.path}`,
			);
		const status = await fileSystem.stat(target.canonicalPath);
		if (status.kind !== "file") throw new Error(`Patch target is not a regular file: ${operation.path}`);
		assertTargetSize(operation.path, status.size);
		const before = await fileSystem.readFile(target.canonicalPath);
		const beforeSha256 = sha256(before);
		const expectedIdentity = targetIdentity(status);
		if (operation.operation === "delete") {
			plans.push({
				requestedPath: operation.path,
				target,
				operation: "delete",
				beforeSha256,
				afterSha256: null,
				previousBytes: before.byteLength,
				bytes: 0,
				...(expectedIdentity ? { expectedIdentity } : {}),
			});
			continue;
		}
		let decoded: ReturnType<typeof decodeTextFile>;
		try {
			decoded = decodeTextFile(before);
		} catch {
			throw new Error(`Patch updates support UTF-8 text files only: ${operation.path}`);
		}
		if (decoded.text.includes("\0")) throw new Error(`Patch updates support text files only: ${operation.path}`);
		const updated = applyChunks(decoded.text, operation.chunks, operation.path);
		const data = encodeTextFile(normalizeNewlines(updated, decoded.newline), decoded.bom);
		assertTargetSize(operation.path, data.byteLength);
		const afterSha256 = sha256(data);
		if (afterSha256 === beforeSha256) throw new Error(`Patch produces no content change: ${operation.path}`);
		plans.push({
			requestedPath: operation.path,
			target,
			operation: "update",
			beforeSha256,
			afterSha256,
			previousBytes: before.byteLength,
			bytes: data.byteLength,
			...(expectedIdentity ? { expectedIdentity } : {}),
			data,
		});
	}
	return Object.freeze(plans);
}

function targetIdentity(status: {
	readonly device?: string;
	readonly inode?: string;
}): MutationTargetIdentity | undefined {
	return status.device !== undefined && status.inode !== undefined
		? Object.freeze({ device: status.device, inode: status.inode })
		: undefined;
}

function applyChunks(source: string, chunks: readonly PatchChunk[], path: string): string {
	const normalized = source.replace(/\r\n|\r/gu, "\n");
	const trailingNewline = normalized.endsWith("\n");
	const lines = normalized.length === 0 ? [] : normalized.split("\n");
	if (trailingNewline) lines.pop();
	let cursor = 0;
	for (const chunk of chunks) {
		let searchStart = cursor;
		if (chunk.context !== undefined) {
			const contexts = matchingIndexes(lines, [chunk.context], cursor);
			if (contexts.length === 0) throw new Error(`Patch context was not found in ${path}: ${chunk.context}`);
			if (contexts.length > 1) throw new Error(`Patch context is ambiguous in ${path}: ${chunk.context}`);
			searchStart = contexts[0]! + 1;
		}
		let match: number;
		if (chunk.oldLines.length === 0) {
			match = chunk.endOfFile ? lines.length : searchStart;
		} else {
			const matches = matchingIndexes(lines, chunk.oldLines, searchStart);
			if (matches.length === 0) throw new Error(`Patch hunk precondition was not found in ${path}`);
			if (matches.length > 1) throw new Error(`Patch hunk precondition is ambiguous in ${path}`);
			match = matches[0]!;
		}
		if (chunk.endOfFile && match + chunk.oldLines.length !== lines.length) {
			throw new Error(`Patch hunk was required to match the end of ${path}`);
		}
		lines.splice(match, chunk.oldLines.length, ...chunk.newLines);
		cursor = match + chunk.newLines.length;
	}
	const joined = lines.join("\n");
	return trailingNewline && lines.length > 0 ? `${joined}\n` : joined;
}

function matchingIndexes(lines: readonly string[], expected: readonly string[], start: number): number[] {
	const matches: number[] = [];
	for (let index = start; index <= lines.length - expected.length; index++) {
		if (expected.every((line, offset) => lines[index + offset] === line)) {
			matches.push(index);
		}
	}
	return matches;
}

function assertUniqueCanonicalTargets(targets: readonly ResolvedWorkspacePath[]): void {
	const canonical = new Set<string>();
	for (const target of targets) {
		if (canonical.has(target.canonicalPath)) {
			throw new Error(`Patch paths resolve to the same canonical target: ${target.canonicalPath}`);
		}
		canonical.add(target.canonicalPath);
	}
}

function assertTargetSize(path: string, bytes: number): void {
	if (bytes > MAX_PATCH_TARGET_BYTES) {
		throw new Error(`Patch target exceeds the ${MAX_PATCH_TARGET_BYTES}-byte limit: ${path}`);
	}
}

function deltaFromPlan(plan: PlannedPatchMutation): MutationDelta {
	return Object.freeze({
		path: plan.requestedPath,
		operation: plan.operation,
		beforeSha256: plan.beforeSha256,
		afterSha256: plan.afterSha256,
		previousBytes: plan.previousBytes,
		bytes: plan.bytes,
	});
}

function patchFailure(
	phase: "preflight" | "commit",
	attemptedPaths: readonly string[],
	committedDelta: readonly MutationDelta[],
	canonicalCommittedPaths: readonly string[],
	error: unknown,
) {
	const facts = mutationFacts({ atomicity: "per-file", attemptedPaths, committedDelta });
	const notAppliedPaths = attemptedPaths.slice(committedDelta.length);
	const partial = committedDelta.length > 0;
	const summary = partial
		? `Patch partially applied: ${committedDelta.length} of ${attemptedPaths.length} files committed atomically. No cross-file rollback was attempted.`
		: `Patch was not applied; no files committed during ${phase}.`;
	return toolFailure(
		`${summary}\nApplied: ${pathList(facts.committedPaths)}\nNot applied: ${pathList(notAppliedPaths)}\nFailure: ${errorMessage(error)}`,
		{
			code: partial ? "partial_application" : `${phase}_failed`,
			phase,
			atomicity: "per-file",
			attemptedPaths,
			committedPaths: facts.committedPaths,
			notAppliedPaths,
			canonicalCommittedPaths,
			committedDelta,
		},
		mutationObservationFacts(facts),
	);
}

function pathList(paths: readonly string[]): string {
	if (paths.length === 0) return "(none)";
	const visible = paths.slice(0, 20);
	return `${visible.join(", ")}${paths.length > visible.length ? `, … +${paths.length - visible.length}` : ""}`;
}

function patchSummary(committed: number, attempted: number): string {
	return `Applied patch to ${committed} of ${attempted} file${attempted === 1 ? "" : "s"}.`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
