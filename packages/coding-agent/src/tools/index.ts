import type { AgentTool } from "@coda/agent";
import type { ApplicationRuntime, UserSettings } from "../application.ts";
import type { FileSystem } from "../host/file-system.ts";
import type { PermissionAuditSink } from "../permissions/audit.ts";
import type { ModelProcessRunner } from "../permissions/model-process-runner.ts";
import type { PermissionEngine } from "../permissions/permission-engine.ts";
import type { Workspace } from "../workspace.ts";
import { createBashTool } from "./bash.ts";
import { createEditTool } from "./edit.ts";
import { createFindTool } from "./find.ts";
import { createGrepTool } from "./grep.ts";
import { createLsTool } from "./ls.ts";
import { TargetMutationCoordinator } from "./mutation.ts";
import { createReadTool } from "./read.ts";
import { createReadToolOutputTool } from "./read-tool-output.ts";
import { createSandboxedMutationWriter } from "./sandboxed-mutation-writer.ts";
import { createWriteTool } from "./write.ts";

export function createCodingTools(options: {
	readonly workspace: Workspace;
	readonly fileSystem: FileSystem;
	readonly processRunner: ModelProcessRunner;
	readonly permissions: PermissionEngine;
	readonly shellExecutable: string;
	readonly runtime: ApplicationRuntime;
	readonly settings: UserSettings;
	readonly onAudit?: PermissionAuditSink;
}): readonly AgentTool[] {
	const mutations = new TargetMutationCoordinator();
	const mutationWriter = createSandboxedMutationWriter({
		workspace: options.workspace,
		permissions: options.permissions,
		onAudit: options.onAudit,
	});
	return [
		createReadTool(options.workspace, options.fileSystem),
		createReadToolOutputTool({ fileSystem: options.fileSystem, homeDirectory: options.runtime.homeDirectory }),
		createGrepTool({
			workspace: options.workspace,
			fileSystem: options.fileSystem,
			processRunner: options.processRunner,
			permissions: options.permissions,
			runtime: options.runtime,
		}),
		createFindTool({
			workspace: options.workspace,
			fileSystem: options.fileSystem,
			processRunner: options.processRunner,
			permissions: options.permissions,
			runtime: options.runtime,
		}),
		createLsTool(options.workspace, options.fileSystem),
		createEditTool(options.workspace, options.fileSystem, mutations, mutationWriter),
		createWriteTool(options.workspace, options.fileSystem, mutations, mutationWriter),
		createBashTool(options),
	];
}
