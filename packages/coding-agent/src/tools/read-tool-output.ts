import type { AgentTool } from "@coda/agent";
import { Type } from "@coda/ai";
import type { FileSystem } from "../host/file-system.ts";
import { isFileSystemError } from "../host/file-system.ts";
import { createRunEvidenceToolFacts } from "../run-evidence/observation-semantics.ts";
import { toolFailure } from "./failure.ts";
import { toolOutputPathForRef } from "./tool-output-store.ts";

const MAX_TOOL_OUTPUT_BYTES = 16 * 1024 * 1024;

const ReadToolOutputParameters = Type.Object(
	{
		ref: Type.String({ minLength: 1 }),
		offset: Type.Optional(Type.Integer({ minimum: 1 })),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000 })),
	},
	{ additionalProperties: false },
);

function lineChunks(value: string): string[] {
	return value.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

export function createReadToolOutputTool(options: {
	readonly fileSystem: FileSystem;
	readonly homeDirectory: string;
}): AgentTool<typeof ReadToolOutputParameters> {
	return {
		name: "read_tool_output",
		description: "Continue reading output omitted by another Tool Result using its opaque outputRef.",
		parameters: ReadToolOutputParameters,
		replaySafety: "safe",
		parallelSafe: true,
		execute: async (arguments_, context) => {
			context.signal.throwIfAborted();
			const path = toolOutputPathForRef(options.homeDirectory, arguments_.ref);
			if (!path) return toolFailure("Invalid Tool output reference", { code: "invalid_output_ref" });
			let bytes: Uint8Array;
			try {
				const status = await options.fileSystem.lstat(path);
				if (status.kind !== "file") {
					return toolFailure("Tool output reference is not a regular file", { code: "invalid_output_ref" });
				}
				if (status.size > MAX_TOOL_OUTPUT_BYTES) {
					return toolFailure("Stored Tool output exceeds the read limit", {
						code: "output_too_large",
						limitBytes: MAX_TOOL_OUTPUT_BYTES,
					});
				}
				bytes = await options.fileSystem.readFile(path);
			} catch (error) {
				if (isFileSystemError(error, "ENOENT")) {
					return toolFailure("Tool output is no longer available", { code: "output_not_found" });
				}
				throw error;
			}
			context.signal.throwIfAborted();
			const lines = lineChunks(new TextDecoder("utf-8").decode(bytes));
			const start = (arguments_.offset ?? 1) - 1;
			const limit = arguments_.limit ?? 2_000;
			const end = Math.min(start + limit, lines.length);
			const hasPrevious = start > 0;
			const hasMore = end < lines.length;
			const truncated = hasPrevious || hasMore;
			const completeness = truncated ? "windowed" : "complete";
			return {
				content: lines.slice(start, end).join("") || "(no output)",
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
							resolutionTarget: { kind: "opaque", value: arguments_.ref },
						}),
					},
					...(truncated ? { outputRef: arguments_.ref } : {}),
				},
				details: {
					outputRef: arguments_.ref,
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
