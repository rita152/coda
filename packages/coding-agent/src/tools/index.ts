import type { AgentTool } from "@coda/agent";
import type { ApplicationRuntime } from "../application.ts";
import type { FileSystem } from "../host/file-system.ts";
import type { ProcessRunner } from "../host/process-runner.ts";
import type { ProcessSessionManager } from "../process/process-session-manager.ts";
import { createProcessTools } from "../process/tools.ts";
import type { SessionHistoryReadPort } from "../session/session-history-reader.ts";
import type { Workspace } from "../workspace.ts";
import { createAtomicMutationWriter } from "./atomic-mutation-writer.ts";
import { createBashTool } from "./bash.ts";
import { BUILT_IN_CODING_TOOL_NAMES } from "./contracts.ts";
import { createEditTool } from "./edit.ts";
import { createFindTool } from "./find.ts";
import { createGrepTool } from "./grep.ts";
import { createLsTool } from "./ls.ts";
import { TargetMutationCoordinator } from "./mutation.ts";
import { createPatchTool } from "./patch.ts";
import { createReadTool } from "./read.ts";
import { createReadSessionHistoryTool } from "./read-session-history.ts";
import { createReadToolOutputTool } from "./read-tool-output.ts";
import { createWriteTool } from "./write.ts";

export { BUILT_IN_CODING_TOOL_NAMES } from "./contracts.ts";

export function createCodingTools(options: {
	readonly workspace: Workspace;
	readonly fileSystem: FileSystem;
	readonly processRunner: ProcessRunner;
	readonly processSessionManager: ProcessSessionManager;
	readonly shellExecutable: string;
	readonly runtime: ApplicationRuntime;
	readonly sessionHistory: SessionHistoryReadPort;
	readonly sessionId: string;
}): readonly AgentTool[] {
	const mutations = new TargetMutationCoordinator();
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
		}),
	];
	for (const [index, expectedName] of BUILT_IN_CODING_TOOL_NAMES.entries()) {
		if (tools[index]?.name !== expectedName) {
			throw new Error(`Built-in Tool contract mismatch: expected ${expectedName} at index ${index}`);
		}
	}
	return tools;
}
