import type { AgentTool } from "@coda/agent";
import { Type } from "@coda/ai";
import type { FileSystem } from "../host/file-system.ts";
import { createRunEvidenceToolFacts } from "../run-evidence/observation-semantics.ts";
import type { Workspace } from "../workspace.ts";
import { toolFailure } from "./failure.ts";

const ReadParameters = Type.Object(
	{
		path: Type.String({ minLength: 1 }),
		offset: Type.Optional(Type.Integer({ minimum: 1 })),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000 })),
	},
	{ additionalProperties: false },
);

function lineChunks(value: string): string[] {
	return value.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

export function createReadTool(workspace: Workspace, fileSystem: FileSystem): AgentTool<typeof ReadParameters> {
	return {
		name: "read",
		description: "Read UTF-8 text from a file. Paths are resolved from the Workspace root.",
		parameters: ReadParameters,
		replaySafety: "safe",
		parallelSafe: true,
		execute: async (arguments_, context) => {
			context.signal.throwIfAborted();
			const resolved = await workspace.resolvePath(arguments_.path);
			if (!resolved.exists) {
				return toolFailure(`File does not exist: ${resolved.canonicalPath}`, {
					code: "not_found",
					path: resolved.canonicalPath,
				});
			}
			const status = await fileSystem.stat(resolved.canonicalPath);
			if (status.kind !== "file") {
				return toolFailure(`Path is not a file: ${resolved.canonicalPath}`, {
					code: "not_file",
					path: resolved.canonicalPath,
				});
			}
			if (status.size > 2 * 1024 * 1024) {
				return toolFailure("Text file exceeds the 2 MiB read limit", {
					code: "too_large",
					path: resolved.canonicalPath,
					limitBytes: 2 * 1024 * 1024,
				});
			}
			const bytes = await fileSystem.readFile(resolved.canonicalPath);
			context.signal.throwIfAborted();
			let text: string;
			try {
				text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			} catch {
				return toolFailure("read supports UTF-8 text files only", {
					code: "invalid_utf8",
					path: resolved.canonicalPath,
				});
			}
			if (text.includes("\0")) {
				return toolFailure("read supports text files only", {
					code: "not_text",
					path: resolved.canonicalPath,
				});
			}
			const lines = lineChunks(text);
			const start = (arguments_.offset ?? 1) - 1;
			const limit = arguments_.limit ?? 2_000;
			const end = Math.min(start + limit, lines.length);
			const selected = lines.slice(start, end).join("");
			const hasPrevious = start > 0;
			const hasMore = end < lines.length;
			const truncated = hasPrevious || hasMore;
			const completeness = truncated ? "windowed" : "complete";
			return {
				content: selected,
				observation: {
					status: "ok",
					truncated,
					facts: {
						startLine: start + 1,
						endLine: end,
						totalLines: lines.length,
						hasPrevious,
						hasMore,
						runEvidence: createRunEvidenceToolFacts({
							completeness,
							...(truncated ? { limitationReason: "pagination" as const } : {}),
							paths: [{ path: arguments_.path, effect: "inspected" }],
							resolutionTarget: { kind: "path", value: arguments_.path },
						}),
					},
				},
				details: {
					requestedPath: arguments_.path,
					path: resolved.canonicalPath,
					startLine: start + 1,
					endLine: end,
					totalLines: lines.length,
					hasPrevious,
					hasMore,
					completeness,
					truncated,
				},
			};
		},
	};
}
