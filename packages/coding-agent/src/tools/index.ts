import type { ToolExecutionOutput } from "@coda/agent";
import type { WorkspaceExecution } from "@coda/runtime";
import type { ProcessConfinement } from "@coda/sandbox";
import type { FileSystem } from "../host/file-system.ts";
import type { ProcessRunner } from "../host/process-runner.ts";
import type { HostProcessRuntime } from "../host/runtime.ts";
import type { Workspace } from "../host/workspace.ts";
import type { ProcessSessionManager } from "../process/process-session-manager.ts";
import { createProcessTools } from "../process/tools.ts";
import type { SessionHistoryReadPort } from "../session-history/reader.ts";
import { createAtomicMutationWriter } from "./atomic-mutation-writer.ts";
import { createBashTool } from "./bash.ts";
import { BUILT_IN_CODING_TOOL_NAMES } from "./contracts.ts";
import { createEditTool } from "./edit.ts";
import { createFindTool } from "./find.ts";
import { createGrepTool } from "./grep.ts";
import { createLsTool } from "./ls.ts";
import type { TargetMutationCoordinator } from "./mutation.ts";
import { createPatchTool } from "./patch.ts";
import { createReadTool } from "./read.ts";
import { createReadSessionHistoryTool } from "./read-session-history.ts";
import { createReadToolOutputTool } from "./read-tool-output.ts";
import { createWriteTool } from "./write.ts";

export { BUILT_IN_CODING_TOOL_NAMES } from "./contracts.ts";

type WorkspaceToolContribution = Awaited<ReturnType<WorkspaceExecution["tooling"]["tools"]>>[number];

export function createCodingToolContributions(options: {
	readonly workspace: Workspace;
	readonly fileSystem: FileSystem;
	readonly processRunner: ProcessRunner;
	readonly processSessionManager: ProcessSessionManager;
	readonly shellExecutable: string;
	readonly runtime: HostProcessRuntime;
	readonly sessionHistory: SessionHistoryReadPort;
	readonly sessionId: string;
	readonly mutationCoordinator: TargetMutationCoordinator;
	readonly wrapScript?: (
		request: Parameters<ProcessConfinement["wrapScript"]>[0],
	) => Promise<Awaited<ReturnType<ProcessConfinement["wrapScript"]>> | undefined>;
}): readonly WorkspaceToolContribution[] {
	const mutations = options.mutationCoordinator;
	const mutationWriter = createAtomicMutationWriter(options.fileSystem);
	const tools = [
		createReadSessionHistoryTool(options.sessionHistory),
		createReadTool(options.workspace, options.fileSystem),
		createReadToolOutputTool({ fileSystem: options.fileSystem, homeDirectory: options.runtime.homeDirectory }),
		createGrepTool({
			workspace: options.workspace,
			fileSystem: options.fileSystem,
			processRunner: options.processRunner,
			runtime: options.runtime,
		}),
		createFindTool({
			workspace: options.workspace,
			fileSystem: options.fileSystem,
			processRunner: options.processRunner,
			runtime: options.runtime,
		}),
		createLsTool(options.workspace, options.fileSystem),
		createPatchTool(options.workspace, options.fileSystem, mutations, mutationWriter),
		createEditTool(options.workspace, options.fileSystem, mutations, mutationWriter),
		createWriteTool(options.workspace, options.fileSystem, mutations, mutationWriter),
		createBashTool(options),
		...createProcessTools({
			workspace: options.workspace,
			manager: options.processSessionManager,
			shellExecutable: options.shellExecutable,
			runtime: options.runtime,
			sessionId: options.sessionId,
			...(options.wrapScript ? { wrapScript: options.wrapScript } : {}),
		}),
	];
	for (const [index, expectedName] of BUILT_IN_CODING_TOOL_NAMES.entries()) {
		if (tools[index]?.name !== expectedName) {
			throw new Error(`Built-in Tool contract mismatch: expected ${expectedName} at index ${index}`);
		}
	}
	const effects = new Map<string, WorkspaceToolContribution["effect"]>([
		["read_session_history", "read"],
		["read", "read"],
		["read_tool_output", "read"],
		["grep", "read"],
		["find", "read"],
		["ls", "read"],
		["patch", "write"],
		["edit", "write"],
		["write", "write"],
	]);
	return Object.freeze(
		tools.map((tool): WorkspaceToolContribution => {
			const processControl =
				tool.name === "process_poll" || tool.name === "process_write" || tool.name === "process_stop";
			return {
				tool,
				effect: effects.get(tool.name) ?? "unknown",
				...(processControl
					? {
							leaseIdentity: (arguments_: unknown) => {
								if (typeof arguments_ !== "object" || arguments_ === null || !("processId" in arguments_)) {
									return undefined;
								}
								const identity = (arguments_ as { readonly processId?: unknown }).processId;
								return typeof identity === "string" ? identity : undefined;
							},
						}
					: {}),
				...(tool.name === "process_start"
					? {
							retainLease: (output: ToolExecutionOutput) => {
								const details = output.details as
									| { readonly processId?: unknown; readonly state?: unknown }
									| undefined;
								return details?.state === "running" && typeof details.processId === "string"
									? {
											identity: details.processId,
											settled: options.processSessionManager.waitForSettlement(details.processId),
										}
									: undefined;
							},
						}
					: {}),
			};
		}),
	);
}
