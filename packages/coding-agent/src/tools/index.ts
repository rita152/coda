import type { ToolExecutionOutput } from "@coda/agent";
import type { WorkspaceExecution } from "@coda/runtime";
import type { ProcessConfinement } from "@coda/sandbox";
import type { FileSystem } from "../host/file-system.ts";
import type { ProcessRunner } from "../host/process-runner.ts";
import type { HostProcessRuntime } from "../host/runtime.ts";
import type { Workspace } from "../host/workspace.ts";
import type { ProcessSessionManager } from "../process/process-session-manager.ts";
import { createProcessTool } from "../process/tools.ts";
import type { SessionHistoryReadPort } from "../session-history/reader.ts";
import { createAtomicMutationWriter } from "./atomic-mutation-writer.ts";
import { createBashTool } from "./bash.ts";
import { BUILT_IN_CODING_TOOL_NAMES } from "./contracts.ts";
import { createEditTool } from "./edit.ts";
import { createFetchTool } from "./fetch.ts";
import { createFindTool } from "./find.ts";
import { createGrepTool } from "./grep.ts";
import { createLsTool } from "./ls.ts";
import type { TargetMutationCoordinator } from "./mutation.ts";
import { createReadTool } from "./read.ts";
import { createReadSessionHistoryTool } from "./read-session-history.ts";
import { createReadToolOutputTool } from "./read-tool-output.ts";
import type { WebRuntime } from "./web/runtime.ts";
import { createWebSearchTool } from "./web-search.ts";
import { createWriteTool } from "./write.ts";

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
	readonly web: WebRuntime;
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
		createWebSearchTool(options.web),
		createFetchTool(options.web),
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
		createEditTool(options.workspace, options.fileSystem, mutations, mutationWriter),
		createWriteTool(options.workspace, options.fileSystem, mutations, mutationWriter),
		createBashTool(options),
		createProcessTool({
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
		["web_search", "read"],
		["fetch", "read"],
		["grep", "read"],
		["find", "read"],
		["ls", "read"],
		["edit", "write"],
		["write", "write"],
	]);
	return Object.freeze(
		tools.map((tool): WorkspaceToolContribution => {
			if (tool.name !== "process") {
				return {
					tool,
					effect: effects.get(tool.name) ?? "unknown",
				};
			}
			return {
				tool,
				effect: "unknown",
				leaseIdentity: (arguments_) => {
					if (typeof arguments_ !== "object" || arguments_ === null) return undefined;
					const record = arguments_ as { readonly action?: unknown; readonly processId?: unknown };
					if (record.action === "start") return undefined;
					return typeof record.processId === "string" ? record.processId : undefined;
				},
				retainLease: (output: ToolExecutionOutput) => {
					const details = output.details as
						| { readonly processId?: unknown; readonly state?: unknown; readonly retainLease?: unknown }
						| undefined;
					return details?.retainLease === true &&
						details.state === "running" &&
						typeof details.processId === "string"
						? {
								identity: details.processId,
								settled: options.processSessionManager.waitForSettlement(details.processId),
							}
						: undefined;
				},
			};
		}),
	);
}
