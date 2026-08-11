import { join } from "node:path";
import type { AgentTool } from "@coda/agent";
import { Type } from "@coda/ai";
import type { FileSystem } from "../host/file-system.ts";
import { hasPermissionedPathAccess } from "../permissions/file-access.ts";
import type { Workspace } from "../workspace.ts";
import { toolFailure } from "./failure.ts";

const LsParameters = Type.Object(
	{
		path: Type.Optional(Type.String({ minLength: 1 })),
		depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
	},
	{ additionalProperties: false },
);

export function createLsTool(workspace: Workspace, fileSystem: FileSystem): AgentTool<typeof LsParameters> {
	return {
		name: "ls",
		description: "List directory entries in stable name order.",
		parameters: LsParameters,
		replaySafety: "safe",
		parallelSafe: true,
		execute: async (arguments_, context) => {
			const root = await workspace.resolvePath(arguments_.path ?? ".", "read");
			if (!hasPermissionedPathAccess(workspace, root, context.invocationId, "ls", "read")) {
				return toolFailure(`Path access was not granted: ${root.canonicalPath}`, {
					code: "access_denied",
					path: root.canonicalPath,
				});
			}
			if (!root.exists) {
				return toolFailure(`Directory does not exist: ${root.canonicalPath}`, {
					code: "not_found",
					path: root.canonicalPath,
				});
			}
			const status = await fileSystem.stat(root.canonicalPath);
			if (status.kind !== "directory") {
				return toolFailure(`Path is not a directory: ${root.canonicalPath}`, {
					code: "not_directory",
					path: root.canonicalPath,
				});
			}

			const maxDepth = arguments_.depth ?? 1;
			const limit = arguments_.limit ?? 500;
			const lines: string[] = [];
			let truncated = false;
			const visit = async (directory: string, prefix: string, depth: number): Promise<void> => {
				context.signal.throwIfAborted();
				const entries = [...(await fileSystem.readDirectory(directory))].sort((left, right) =>
					left.name.localeCompare(right.name),
				);
				for (const entry of entries) {
					context.signal.throwIfAborted();
					const child = await workspace.resolvePath(join(directory, entry.name), "read");
					if (!child.exists || !hasPermissionedPathAccess(workspace, child, context.invocationId, "ls", "read")) {
						continue;
					}
					if (lines.length >= limit) {
						truncated = true;
						return;
					}
					const childStatus = await fileSystem.stat(child.canonicalPath);
					const display = `${prefix}${entry.name}`;
					if (entry.kind === "symbolic-link") {
						lines.push(`${display}@`);
						continue;
					}
					if (childStatus.kind === "directory") {
						lines.push(`${display}/`);
						if (depth < maxDepth) await visit(child.canonicalPath, `${display}/`, depth + 1);
					} else {
						lines.push(display);
					}
					if (truncated) return;
				}
			};
			await visit(root.canonicalPath, "", 1);
			return {
				content: lines.length === 0 ? "(empty directory)" : lines.join("\n"),
				observation: { status: "ok", truncated, facts: { count: lines.length } },
				details: { count: lines.length, truncated },
			};
		},
	};
}
