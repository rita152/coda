import type { AgentTool } from "@coda/agent";
import type { ApplicationRuntime, UserSettings } from "../application.ts";
import type { FileSystem } from "../host/file-system.ts";
import type { ProcessRunner } from "../host/process-runner.ts";
import type { Workspace } from "../workspace.ts";
import { createBashTool } from "./bash.ts";
import { createEditTool } from "./edit.ts";
import { createFindTool } from "./find.ts";
import { createGrepTool } from "./grep.ts";
import { createLsTool } from "./ls.ts";
import { TargetMutationCoordinator } from "./mutation.ts";
import { createReadTool } from "./read.ts";
import { createWriteTool } from "./write.ts";

export function createCodingTools(options: {
	readonly workspace: Workspace;
	readonly fileSystem: FileSystem;
	readonly processRunner: ProcessRunner;
	readonly runtime: ApplicationRuntime;
	readonly settings: UserSettings;
}): readonly AgentTool[] {
	const mutations = new TargetMutationCoordinator();
	return [
		createReadTool(options.workspace, options.fileSystem),
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
		createEditTool(options.workspace, options.fileSystem, mutations),
		createWriteTool(options.workspace, options.fileSystem, mutations),
		createBashTool(options),
	];
}
