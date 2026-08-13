import type { AgentTool } from "@coda/agent";
import { Type } from "@coda/ai";
import type { FileSystem } from "../host/file-system.ts";
import type { Workspace } from "../workspace.ts";
import type { AtomicMutationWriter } from "./atomic-mutation-writer.ts";
import { toolFailure } from "./failure.ts";
import { atomicWrite, type TargetMutationCoordinator } from "./mutation.ts";
import { mutationFacts, mutationObservationFacts } from "./mutation-contract.ts";
import { decodeTextFile, encodeTextFile, normalizeNewlines, sha256 } from "./text-mutation.ts";

const EditParameters = Type.Object(
	{
		path: Type.String({
			minLength: 1,
			description: "Required on every edit call: the Workspace-relative or absolute path of the file to edit.",
		}),
		oldText: Type.String({ minLength: 1 }),
		newText: Type.String(),
		replaceAll: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

function occurrenceIndexes(text: string, search: string): number[] {
	const indexes: number[] = [];
	let offset = 0;
	while (offset <= text.length - search.length) {
		const found = text.indexOf(search, offset);
		if (found < 0) break;
		indexes.push(found);
		offset = found + search.length;
	}
	return indexes;
}

export function createEditTool(
	workspace: Workspace,
	fileSystem: FileSystem,
	coordinator: TargetMutationCoordinator,
	writer: AtomicMutationWriter,
): AgentTool<typeof EditParameters> {
	return {
		name: "edit",
		description:
			"Atomically replace an exact text match while preserving file encoding style and mode. Always include path, oldText, and newText in every call.",
		parameters: EditParameters,
		replaySafety: "never",
		execute: async (arguments_, context) => {
			const initial = await workspace.resolvePath(arguments_.path);
			if (!initial.exists) {
				return toolFailure(`File does not exist: ${initial.canonicalPath}`, {
					code: "not_found",
					path: initial.canonicalPath,
				});
			}
			return coordinator.run(initial.canonicalPath, async () => {
				context.signal.throwIfAborted();
				const current = await workspace.resolvePath(arguments_.path);
				if (!current.exists || current.canonicalPath !== initial.canonicalPath) {
					return toolFailure("Target changed before edit could begin", {
						code: "target_changed",
						path: initial.canonicalPath,
					});
				}
				const status = await fileSystem.stat(current.canonicalPath);
				if (status.kind !== "file") {
					return toolFailure(`Path is not a file: ${current.canonicalPath}`, {
						code: "not_file",
						path: current.canonicalPath,
					});
				}
				if (status.size > 2 * 1024 * 1024) {
					return toolFailure("Text file exceeds the 2 MiB edit limit", {
						code: "too_large",
						path: current.canonicalPath,
						limitBytes: 2 * 1024 * 1024,
					});
				}
				const beforeBytes = await fileSystem.readFile(current.canonicalPath);
				let decoded: ReturnType<typeof decodeTextFile>;
				try {
					decoded = decodeTextFile(beforeBytes);
				} catch {
					return toolFailure("edit supports UTF-8 text files only", {
						code: "invalid_utf8",
						path: current.canonicalPath,
					});
				}
				const before = decoded.text;
				if (before.includes("\0")) {
					return toolFailure("edit supports text files only", {
						code: "not_text",
						path: current.canonicalPath,
					});
				}
				const newline = decoded.newline;
				const oldText = normalizeNewlines(arguments_.oldText, newline);
				const newText = normalizeNewlines(arguments_.newText, newline);
				const occurrences = occurrenceIndexes(before, oldText);
				if (occurrences.length === 0) {
					return toolFailure("Expected oldText was not found", {
						code: "no_match",
						path: current.canonicalPath,
					});
				}
				if (occurrences.length > 1 && !arguments_.replaceAll) {
					return toolFailure(
						`Expected oldText is not unique (${occurrences.length} matches); use replaceAll explicitly`,
						{
							code: "ambiguous_match",
							path: current.canonicalPath,
							matches: occurrences.length,
						},
					);
				}
				const after = arguments_.replaceAll
					? before.split(oldText).join(newText)
					: `${before.slice(0, occurrences[0])}${newText}${before.slice(occurrences[0]! + oldText.length)}`;
				const afterBytes = encodeTextFile(after, decoded.bom);
				const beforeDigest = sha256(beforeBytes);
				const result = await atomicWrite(workspace, fileSystem, current, afterBytes, context, writer, beforeDigest);
				const replacements = arguments_.replaceAll ? occurrences.length : 1;
				const afterDigest = sha256(afterBytes);
				const mutation = mutationFacts({
					atomicity: "single-file",
					attemptedPaths: [arguments_.path],
					committedDelta: [
						{
							path: arguments_.path,
							operation: "update",
							beforeSha256: beforeDigest,
							afterSha256: afterDigest,
							previousBytes: result.previousSize,
							bytes: result.size,
						},
					],
				});
				return {
					content: `Edited ${arguments_.path}: ${replacements} replacement${replacements === 1 ? "" : "s"}.`,
					observation: {
						status: "ok",
						truncated: false,
						facts: mutationObservationFacts(mutation, { replacements, bytes: result.size }),
					},
					details: {
						requestedPath: arguments_.path,
						path: current.canonicalPath,
						replacements,
						previousBytes: result.previousSize,
						bytes: result.size,
						beforeSha256: beforeDigest,
						afterSha256: afterDigest,
						diff: `--- ${arguments_.path}\n+++ ${arguments_.path}\n@@ exact replacement @@\n-${arguments_.oldText}\n+${arguments_.newText}`,
					},
				};
			});
		},
	};
}
