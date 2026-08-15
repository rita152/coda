import { createHash } from "node:crypto";
import type { AgentTool } from "@coda/agent";
import { Type } from "@coda/ai";
import type { FileSystem } from "../host/file-system.ts";
import type { Workspace } from "../host/workspace.ts";
import type { AtomicMutationWriter } from "./atomic-mutation-writer.ts";
import { toolFailure } from "./failure.ts";
import { atomicWrite, type TargetMutationCoordinator } from "./mutation.ts";
import { mutationFacts, mutationObservationFacts } from "./mutation-contract.ts";

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
	writer: AtomicMutationWriter,
): AgentTool<typeof WriteParameters> {
	return {
		name: "write",
		description: "Create or atomically overwrite a UTF-8 text file in the Workspace.",
		parameters: WriteParameters,
		replaySafety: "never",
		execute: async (arguments_, context) => {
			const initial = await workspace.resolvePath(arguments_.path);
			if (initial.exists) {
				const status = await fileSystem.stat(initial.canonicalPath);
				if (status.kind !== "file") {
					return toolFailure(`Path is not a file: ${initial.canonicalPath}`, {
						code: "not_file",
						path: initial.canonicalPath,
					});
				}
			}
			const bytes = new TextEncoder().encode(arguments_.content);
			return coordinator.run(initial.canonicalPath, async () => {
				const result = await atomicWrite(workspace, fileSystem, initial, bytes, context, writer);
				const afterSha256 = sha256(bytes);
				const mutation = mutationFacts({
					atomicity: "single-file",
					attemptedPaths: [arguments_.path],
					committedDelta: [
						{
							path: arguments_.path,
							operation: result.created ? "add" : "update",
							beforeSha256: null,
							afterSha256,
							previousBytes: result.previousSize,
							bytes: result.size,
						},
					],
				});
				return {
					content: `${result.created ? "Created" : "Overwrote"} ${arguments_.path} (${result.size} bytes).`,
					observation: {
						status: "ok",
						truncated: false,
						facts: mutationObservationFacts(mutation, {
							operation: result.created ? "create" : "overwrite",
							bytes: result.size,
						}),
					},
					details: {
						requestedPath: arguments_.path,
						path: initial.canonicalPath,
						operation: result.created ? "create" : "overwrite",
						previousBytes: result.previousSize,
						bytes: result.size,
						sha256: afterSha256,
					},
				};
			});
		},
	};
}
