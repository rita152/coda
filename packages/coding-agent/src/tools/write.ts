import { createHash } from "node:crypto";
import type { AgentTool } from "@coda/agent";
import { Type } from "@coda/ai";
import type { FileSystem } from "../host/file-system.ts";
import { hasWorkspacePathAccess } from "../policy.ts";
import type { Workspace } from "../workspace.ts";
import { atomicWrite, type TargetMutationCoordinator } from "./mutation.ts";

const WriteParameters = Type.Object(
	{
		path: Type.String({ minLength: 1 }),
		content: Type.String(),
	},
	{ additionalProperties: false },
);

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function createWriteTool(
	workspace: Workspace,
	fileSystem: FileSystem,
	coordinator: TargetMutationCoordinator,
): AgentTool<typeof WriteParameters> {
	return {
		name: "write",
		description: "Create or atomically overwrite a UTF-8 text file in the Workspace.",
		parameters: WriteParameters,
		replaySafety: "never",
		execute: async (arguments_, context) => {
			const initial = await workspace.resolvePath(arguments_.path, "write");
			if (!hasWorkspacePathAccess(workspace, initial, context.invocationId, "write", "write")) {
				throw new Error(`Path access was not granted: ${initial.canonicalPath}`);
			}
			const bytes = new TextEncoder().encode(arguments_.content);
			return coordinator.run(initial.canonicalPath, async () => {
				const result = await atomicWrite(workspace, fileSystem, initial, bytes, context, "write");
				return {
					content: `${result.created ? "Created" : "Overwrote"} ${arguments_.path} (${result.size} bytes).`,
					details: {
						requestedPath: arguments_.path,
						path: initial.canonicalPath,
						operation: result.created ? "create" : "overwrite",
						previousBytes: result.previousSize,
						bytes: result.size,
						sha256: sha256(bytes),
					},
				};
			});
		},
	};
}
