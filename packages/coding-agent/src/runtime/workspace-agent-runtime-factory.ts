import type { Clock, IdGenerator, RunBudget } from "@coda/agent";
import type { Models } from "@coda/ai";
import type { McpElicitationResult, McpToolSnapshot } from "@coda/mcp";
import {
	type CodingAgentRuntime,
	type CodingMcpRegistry,
	type CodingRuntimeSelection,
	type CodingSkillsSnapshot,
	type McpAgentElicitation,
	openCodingAgentRuntime,
	type RuntimeScheduler,
	type TrustedProjectInstructions,
} from "@coda/runtime";
import type { FileSystem } from "../host/file-system.ts";
import type { ProcessRunner } from "../host/process-runner.ts";
import type { HostProcessRuntime } from "../host/runtime.ts";
import type { ProcessSessionManager } from "../process/process-session-manager.ts";
import type { Session } from "../session/types.ts";
import type { CodingSkillsManager, SkillCommandRegistryBinding } from "../skills/manager.ts";
import type { Workspace } from "../workspace.ts";
import { createWorkspaceRuntimeServices } from "./workspace-runtime-services.ts";

export interface OpenWorkspaceAgentRuntimeRequest {
	readonly session: Session;
	readonly selection: CodingRuntimeSelection;
	readonly interactionMode: "interactive" | "print";
	readonly autoDrainFollowUps: boolean;
	readonly mcpElicitation?: (request: McpAgentElicitation) => Promise<McpElicitationResult>;
}

export interface WorkspaceAgentRuntimeFactory {
	open(request: OpenWorkspaceAgentRuntimeRequest): Promise<CodingAgentRuntime>;
}

/**
 * The sole Workspace/Node Adapter that turns a product Session into the
 * headless Runtime's ports. Primary, secondary, print, and interactive paths
 * all cross the Runtime Seam through this factory.
 */
export function createWorkspaceAgentRuntimeFactory(options: {
	readonly workspace: Workspace;
	readonly fileSystem: FileSystem;
	readonly processRunner: ProcessRunner;
	readonly processSessionManager: ProcessSessionManager;
	readonly shellExecutable: string;
	readonly hostRuntime: HostProcessRuntime;
	readonly skillsManager: CodingSkillsManager;
	readonly initialSkills: CodingSkillsSnapshot;
	readonly skillRegistryBinding: SkillCommandRegistryBinding;
	readonly mcpRegistry?: CodingMcpRegistry;
	readonly initialMcp: McpToolSnapshot;
	readonly models: Models;
	readonly clock: Clock;
	readonly idGenerator: IdGenerator;
	readonly scheduler?: RuntimeScheduler;
	readonly runBudget?: RunBudget;
	readonly maxOutputTokens?: number;
	readonly platform: NodeJS.Platform;
	readonly projectInstructions?: TrustedProjectInstructions;
}): WorkspaceAgentRuntimeFactory {
	return Object.freeze({
		open: (request: OpenWorkspaceAgentRuntimeRequest) =>
			openCodingAgentRuntime({
				...createWorkspaceRuntimeServices({
					session: request.session,
					workspace: options.workspace,
					fileSystem: options.fileSystem,
					processRunner: options.processRunner,
					processSessionManager: options.processSessionManager,
					shellExecutable: options.shellExecutable,
					applicationRuntime: options.hostRuntime,
					skillsManager: options.skillsManager,
					initialSkills: options.skillsManager.current ?? options.initialSkills,
					skillRegistryBinding: options.skillRegistryBinding,
					mcpRegistry: options.mcpRegistry,
					initialMcp: options.initialMcp,
				}),
				selection: request.selection,
				models: options.models,
				clock: options.clock,
				idGenerator: options.idGenerator,
				...(options.runBudget ? { runBudget: options.runBudget } : {}),
				autoDrainFollowUps: request.autoDrainFollowUps,
				interactionMode: request.interactionMode,
				...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens }),
				workspaceRoot: options.workspace.root,
				platform: options.platform,
				...(options.projectInstructions === undefined ? {} : { projectInstructions: options.projectInstructions }),
				...(request.mcpElicitation === undefined ? {} : { mcpElicitation: request.mcpElicitation }),
				...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
			}),
	});
}
