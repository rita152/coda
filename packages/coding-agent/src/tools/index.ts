import type { AgentTool } from "@coda/agent";
import type { ApplicationRuntime, UserSettings } from "../application.ts";
import type { FileSystem } from "../host/file-system.ts";
import type { PermissionAuditSink } from "../permissions/audit.ts";
import type { ModelProcessRunner } from "../permissions/model-process-runner.ts";
import type { PermissionEngine } from "../permissions/permission-engine.ts";
import type { ProcessSessionManager } from "../process/process-session-manager.ts";
import { createProcessTools } from "../process/tools.ts";
import type { SessionHistoryReadPort } from "../session/session-history-reader.ts";
import type { Workspace } from "../workspace.ts";
import { createBashTool } from "./bash.ts";
import { BUILT_IN_CODING_TOOL_NAMES } from "./contracts.ts";
import { createEditTool } from "./edit.ts";
import { createFindTool } from "./find.ts";
import { createGrepTool } from "./grep.ts";
import { createLsTool } from "./ls.ts";
import { TargetMutationCoordinator } from "./mutation.ts";
import { createReadTool } from "./read.ts";
import { createReadSessionHistoryTool } from "./read-session-history.ts";
import { createReadToolOutputTool } from "./read-tool-output.ts";
import { createSandboxedMutationWriter } from "./sandboxed-mutation-writer.ts";
import { createWriteTool } from "./write.ts";

export { BUILT_IN_CODING_TOOL_NAMES } from "./contracts.ts";

export function createCodingTools(options: {
	readonly workspace: Workspace;
	readonly fileSystem: FileSystem;
	readonly processRunner: ModelProcessRunner;
	readonly processSessionManager: ProcessSessionManager;
	readonly permissions: PermissionEngine;
	readonly shellExecutable: string;
	readonly runtime: ApplicationRuntime;
	readonly settings: UserSettings;
	readonly sessionHistory: SessionHistoryReadPort;
	readonly onAudit?: PermissionAuditSink;
}): readonly AgentTool[] {
	const mutations = new TargetMutationCoordinator();
	const mutationWriter = createSandboxedMutationWriter({
		workspace: options.workspace,
		permissions: options.permissions,
		onAudit: options.onAudit,
	});
	const tools = [
		createReadSessionHistoryTool(options.sessionHistory),
		createReadTool(options.workspace, options.fileSystem, options.permissions),
		createReadToolOutputTool({ fileSystem: options.fileSystem, homeDirectory: options.runtime.homeDirectory }),
		createGrepTool({
			workspace: options.workspace,
			fileSystem: options.fileSystem,
			processRunner: options.processRunner,
			permissions: options.permissions,
			runtime: options.runtime,
			onAudit: options.onAudit,
		}),
		createFindTool({
			workspace: options.workspace,
			fileSystem: options.fileSystem,
			processRunner: options.processRunner,
			permissions: options.permissions,
			runtime: options.runtime,
			onAudit: options.onAudit,
		}),
		createLsTool(options.workspace, options.fileSystem, options.permissions),
		createEditTool(options.workspace, options.fileSystem, mutations, mutationWriter),
		createWriteTool(options.workspace, options.fileSystem, mutations, mutationWriter),
		createBashTool(options),
		...createProcessTools({
			workspace: options.workspace,
			manager: options.processSessionManager,
			permissions: options.permissions,
			shellExecutable: options.shellExecutable,
			runtime: options.runtime,
			settings: options.settings,
			onAudit: options.onAudit,
		}),
	];
	for (const [index, expectedName] of BUILT_IN_CODING_TOOL_NAMES.entries()) {
		if (tools[index]?.name !== expectedName) {
			throw new Error(`Built-in Tool contract mismatch: expected ${expectedName} at index ${index}`);
		}
	}
	return tools;
}
