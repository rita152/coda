import { createHash } from "node:crypto";
import type { AgentTool } from "@coda/agent";
import { Type } from "@coda/ai";
import type { FileSystem } from "../host/file-system.ts";
import { hasPermissionedPathAccess } from "../permissions/file-access.ts";
import type { Workspace } from "../workspace.ts";
import { toolFailure } from "./failure.ts";
import { atomicWrite, type TargetMutationCoordinator } from "./mutation.ts";
import type { AtomicMutationWriter } from "./sandboxed-mutation-writer.ts";

const EditParameters = Type.Object(
	{
		path: Type.String({ minLength: 1 }),
		oldText: Type.String({ minLength: 1 }),
		newText: Type.String(),
		replaceAll: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

const UTF8_BOM = new Uint8Array([0xef, 0xbb, 0xbf]);

function hasBom(bytes: Uint8Array): boolean {
	return bytes.length >= 3 && bytes[0] === UTF8_BOM[0] && bytes[1] === UTF8_BOM[1] && bytes[2] === UTF8_BOM[2];
}

function newlineStyle(text: string): "\n" | "\r" | "\r\n" {
	if (text.includes("\r\n")) return "\r\n";
	if (text.includes("\r")) return "\r";
	return "\n";
}

function normalizeNewlines(text: string, newline: "\n" | "\r" | "\r\n"): string {
	return text.replace(/\r\n|\r|\n/g, newline);
}

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

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function encodeText(text: string, bom: boolean): Uint8Array {
	const encoded = new TextEncoder().encode(text);
	if (!bom) return encoded;
	const bytes = new Uint8Array(UTF8_BOM.length + encoded.length);
	bytes.set(UTF8_BOM);
	bytes.set(encoded, UTF8_BOM.length);
	return bytes;
}

export function createEditTool(
	workspace: Workspace,
	fileSystem: FileSystem,
	coordinator: TargetMutationCoordinator,
	writer: AtomicMutationWriter,
): AgentTool<typeof EditParameters> {
	return {
		name: "edit",
		description: "Atomically replace an exact text match while preserving file encoding style and mode.",
		parameters: EditParameters,
		replaySafety: "never",
		execute: async (arguments_, context) => {
			const initial = await workspace.resolvePath(arguments_.path, "write");
			if (!hasPermissionedPathAccess(workspace, initial, context.invocationId, "edit", "write")) {
				return toolFailure(`Path access was not granted: ${initial.canonicalPath}`, {
					code: "access_denied",
					path: initial.canonicalPath,
				});
			}
			if (!initial.exists) {
				return toolFailure(`File does not exist: ${initial.canonicalPath}`, {
					code: "not_found",
					path: initial.canonicalPath,
				});
			}
			return coordinator.run(initial.canonicalPath, async () => {
				context.signal.throwIfAborted();
				const current = await workspace.resolvePath(arguments_.path, "write");
				if (
					!current.exists ||
					current.canonicalPath !== initial.canonicalPath ||
					!hasPermissionedPathAccess(workspace, current, context.invocationId, "edit", "write")
				) {
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
				const bom = hasBom(beforeBytes);
				let before: string;
				try {
					before = new TextDecoder("utf-8", { fatal: true }).decode(bom ? beforeBytes.slice(3) : beforeBytes);
				} catch {
					return toolFailure("edit supports UTF-8 text files only", {
						code: "invalid_utf8",
						path: current.canonicalPath,
					});
				}
				if (before.includes("\0")) {
					return toolFailure("edit supports text files only", {
						code: "not_text",
						path: current.canonicalPath,
					});
				}
				const newline = newlineStyle(before);
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
				const afterBytes = encodeText(after, bom);
				const beforeDigest = sha256(beforeBytes);
				const result = await atomicWrite(
					workspace,
					fileSystem,
					current,
					afterBytes,
					context,
					"edit",
					writer,
					beforeDigest,
				);
				const replacements = arguments_.replaceAll ? occurrences.length : 1;
				return {
					content: `Edited ${arguments_.path}: ${replacements} replacement${replacements === 1 ? "" : "s"}.`,
					details: {
						requestedPath: arguments_.path,
						path: current.canonicalPath,
						replacements,
						previousBytes: result.previousSize,
						bytes: result.size,
						beforeSha256: beforeDigest,
						afterSha256: sha256(afterBytes),
						diff: `--- ${arguments_.path}\n+++ ${arguments_.path}\n@@ exact replacement @@\n-${arguments_.oldText}\n+${arguments_.newText}`,
					},
				};
			});
		},
	};
}
