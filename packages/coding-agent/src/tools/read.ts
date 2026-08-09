import type { AgentTool } from "@coda/agent";
import { Type } from "@coda/ai";
import type { FileSystem } from "../host/file-system.ts";
import { hasPermissionedPathAccess } from "../permissions/file-access.ts";
import type { Workspace } from "../workspace.ts";

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
			const resolved = await workspace.resolvePath(arguments_.path, "read");
			if (!hasPermissionedPathAccess(workspace, resolved, context.invocationId, "read", "read")) {
				throw new Error(`Path access was not granted: ${resolved.canonicalPath}`);
			}
			if (!resolved.exists) throw new Error(`File does not exist: ${resolved.canonicalPath}`);
			const status = await fileSystem.stat(resolved.canonicalPath);
			if (status.kind !== "file") throw new Error(`Path is not a file: ${resolved.canonicalPath}`);
			if (status.size > 2 * 1024 * 1024) throw new Error("Text file exceeds the 2 MiB read limit");
			const bytes = await fileSystem.readFile(resolved.canonicalPath);
			context.signal.throwIfAborted();
			let text: string;
			try {
				text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			} catch {
				throw new Error("read supports UTF-8 text files only");
			}
			if (text.includes("\0")) throw new Error("read supports text files only");
			const lines = lineChunks(text);
			const start = (arguments_.offset ?? 1) - 1;
			const limit = arguments_.limit ?? 2_000;
			const selected = lines.slice(start, start + limit).join("");
			return {
				content: selected,
				details: {
					requestedPath: arguments_.path,
					path: resolved.canonicalPath,
					startLine: start + 1,
					endLine: Math.min(start + limit, lines.length),
					totalLines: lines.length,
					truncated: start > 0 || start + limit < lines.length,
				},
			};
		},
	};
}
