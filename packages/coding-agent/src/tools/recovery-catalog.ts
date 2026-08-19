import type { AgentTool } from "@coda/agent";
import type { FileSystem } from "../host/file-system.ts";
import type { ProcessRunner } from "../host/process-runner.ts";
import { createWorkspace } from "../host/workspace.ts";
import { createFindTool } from "./find.ts";
import { createGrepTool } from "./grep.ts";
import { createLsTool } from "./ls.ts";
import { createReadTool } from "./read.ts";
import { createReadToolOutputTool } from "./read-tool-output.ts";

/** Built-in `replaySafety: "safe"` Tools that can be constructed without a Prepared Run. */
export async function createInterruptedToolRecoveryCatalog(options: {
	readonly workspacePath: string;
	readonly fileSystem: FileSystem;
	readonly processRunner: ProcessRunner;
	readonly homeDirectory: string;
	readonly environment: Readonly<Record<string, string | undefined>>;
}): Promise<readonly AgentTool[]> {
	const workspace = await createWorkspace(options.workspacePath, options.fileSystem);
	const runtime = { homeDirectory: options.homeDirectory, environment: options.environment };
	return Object.freeze([
		createReadTool(workspace, options.fileSystem),
		createReadToolOutputTool({ fileSystem: options.fileSystem, homeDirectory: options.homeDirectory }),
		createGrepTool({
			workspace,
			fileSystem: options.fileSystem,
			processRunner: options.processRunner,
			runtime,
		}),
		createFindTool({
			workspace,
			fileSystem: options.fileSystem,
			processRunner: options.processRunner,
			runtime,
		}),
		createLsTool(workspace, options.fileSystem),
	]);
}
