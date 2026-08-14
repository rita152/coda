import type { AgentEvent, AgentTool } from "@coda/agent";
import type { McpToolSnapshot } from "@coda/mcp";
import type {
	CodingMcpRegistry,
	CodingRuntimeMcpSource,
	CodingRuntimeSession,
	CodingRuntimeSessionChange,
	CodingRuntimeSkillsSource,
	CodingSkillsSnapshot,
} from "@coda/runtime";
import type { FileSystem } from "../host/file-system.ts";
import type { ProcessRunner } from "../host/process-runner.ts";
import type { HostProcessRuntime } from "../host/runtime.ts";
import type { ProcessSessionManager } from "../process/process-session-manager.ts";
import type { Session } from "../session/types.ts";
import type { CodingSkillsManager, SkillCommandRegistryBinding } from "../skills/manager.ts";
import { createCodingTools } from "../tools/index.ts";
import type { Workspace } from "../workspace.ts";

export interface WorkspaceRuntimeServices {
	readonly session: CodingRuntimeSession;
	readonly baseTools: readonly AgentTool[];
	readonly skills: CodingRuntimeSkillsSource;
	readonly mcp: CodingRuntimeMcpSource;
}

/** Node/Workspace Adapter for the headless Runtime's host-facing ports. */
export function createWorkspaceRuntimeServices(options: {
	readonly session: Session;
	readonly workspace: Workspace;
	readonly fileSystem: FileSystem;
	readonly processRunner: ProcessRunner;
	readonly processSessionManager: ProcessSessionManager;
	readonly shellExecutable: string;
	readonly applicationRuntime: HostProcessRuntime;
	readonly skillsManager: CodingSkillsManager;
	readonly initialSkills: CodingSkillsSnapshot;
	readonly skillRegistryBinding: SkillCommandRegistryBinding;
	readonly mcpRegistry?: CodingMcpRegistry;
	readonly initialMcp: McpToolSnapshot;
}): WorkspaceRuntimeServices {
	return Object.freeze({
		session: Object.freeze({
			id: options.session.descriptor.id,
			seed: options.session.seed,
			accept: (event: AgentEvent) => options.session.accept(event),
			close: () => options.session.close(),
			compactionCheckpoint: options.session.compactionCheckpoint,
			record: (change: CodingRuntimeSessionChange) => options.session.record(change),
		}),
		baseTools: createCodingTools({
			workspace: options.workspace,
			fileSystem: options.fileSystem,
			processRunner: options.processRunner,
			processSessionManager: options.processSessionManager,
			shellExecutable: options.shellExecutable,
			runtime: options.applicationRuntime,
			sessionHistory: options.session.history,
			sessionId: options.session.descriptor.id,
		}),
		skills: Object.freeze({
			initial: options.initialSkills,
			current: () => options.skillsManager.current,
			refresh: () => options.skillsManager.refresh(),
			synchronize: (snapshot: CodingSkillsSnapshot) => options.skillRegistryBinding.sync(snapshot),
		}),
		mcp: Object.freeze({
			current: () => options.mcpRegistry?.freezeTools() ?? options.initialMcp,
			...(options.mcpRegistry ? { refresh: async () => void (await options.mcpRegistry!.refresh()) } : {}),
		}),
	});
}
