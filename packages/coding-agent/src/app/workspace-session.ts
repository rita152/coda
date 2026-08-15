import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { Clock, IdGenerator } from "@coda/agent";
import type { Api, AuthResult, Model, Models, ThinkingLevel } from "@coda/ai";
import type { McpElicitationResult } from "@coda/mcp";
import type { OpenCodingAgentOptions } from "@coda/runtime";
import type { DiagnosticSink, Scheduler } from "@coda/tui";
import { collectWorkspaceDiff } from "../completion/workspace-diff.ts";
import type { ApplicationIO } from "../host/application-io.ts";
import type { FileSystem } from "../host/file-system.ts";
import type { ProcessRunner, ProcessSessionRunner } from "../host/process-runner.ts";
import { createWorkspace, type Workspace } from "../host/workspace.ts";
import { cleanupSessionMedia } from "../maintenance/session-media.ts";
import { cleanupTemporaryLogs } from "../maintenance/temporary-logs.ts";
import type { CodingMcpRegistry } from "../mcp/registry.ts";
import type { McpAgentElicitation } from "../mcp/run-capability.ts";
import type { MediaLibrary } from "../media/media-library.ts";
import { ProcessSessionManager } from "../process/process-session-manager.ts";
import type { AgentRunControlBinding, RunControlConfiguration } from "../run-control/index.ts";
import type { SessionWorkController } from "../runtime/session-work-controller.ts";
import { WorkspaceInputResources } from "../runtime/workspace-input-resources.ts";
import {
	createWorkspaceWorkCoordinator,
	type WorkspaceWorkCoordinator,
} from "../runtime/workspace-work-coordinator.ts";
import type { Session, SessionManager } from "../session/types.ts";
import type { TrustedProjectInstructions } from "../settings/project-context.ts";
import type { CodingSkillsManager } from "../skills/manager.ts";
import { codingAgentRunBudget } from "./argument-parsing.ts";
import { bindInteractiveRunControl, openInteractiveRuntime } from "./interactive-session-options.ts";

const unavailableProcessSessionRunner: ProcessSessionRunner = Object.freeze({
	start: async () => {
		throw new Error("Process sessions require a configured ProcessSessionRunner");
	},
});

export interface WorkspaceSessionRuntime {
	readonly cwd: string;
	readonly homeDirectory: string;
	readonly platform: NodeJS.Platform;
	readonly environment: Readonly<Record<string, string | undefined>>;
	readonly clock: Clock;
	readonly idGenerator: IdGenerator;
	readonly scheduler?: Scheduler;
}

export interface WorkspaceSessionApplicationOptions {
	readonly models: Models;
	readonly fileSystem: FileSystem;
	readonly processRunner: ProcessRunner;
	readonly processSessionRunner?: ProcessSessionRunner;
	readonly runtime: WorkspaceSessionRuntime;
	readonly workspacePersistence?: (request: {
		readonly workspaceId: string;
		readonly workspaceRoot: string;
	}) => NonNullable<OpenCodingAgentOptions["persistence"]>;
}

export interface WorkspaceContext {
	readonly workspace: Workspace;
	readonly workspaceId: string;
}

export async function resolveWorkspaceContext(
	path: string | undefined,
	options: Pick<WorkspaceSessionApplicationOptions, "fileSystem" | "runtime">,
): Promise<WorkspaceContext> {
	const workspace = await createWorkspace(path ?? options.runtime.cwd, options.fileSystem);
	return {
		workspace,
		workspaceId: createHash("sha256").update(workspace.root).digest("hex").slice(0, 32),
	};
}

export async function openWorkspaceSession(input: {
	readonly path?: string;
	readonly options: Pick<WorkspaceSessionApplicationOptions, "fileSystem" | "runtime">;
	readonly sessions: SessionManager;
	readonly mode: "interactive" | "print";
	readonly resumeId?: string;
	readonly forceUnlock: boolean;
	readonly persistent: boolean;
}): Promise<WorkspaceContext & { readonly session: Session }> {
	const context = await resolveWorkspaceContext(input.path, input.options);
	const session = await input.sessions.open({
		workspace: { id: context.workspaceId, path: context.workspace.root },
		mode: input.mode,
		resumeId: input.resumeId,
		forceUnlock: input.forceUnlock,
		persistent: input.persistent,
	});
	return { ...context, session };
}

export function createMaintenanceDiagnostics(options: {
	readonly diagnostics?: DiagnosticSink;
	readonly io: Pick<ApplicationIO, "stderr">;
}): DiagnosticSink {
	return (
		options.diagnostics ??
		((diagnostic) => options.io.stderr.write(`coda: [${diagnostic.code}] ${diagnostic.message}\n`))
	);
}

export function dispatchMaintenanceCleanup(input: {
	readonly explicit: boolean;
	readonly output: "json" | "text";
	readonly options: Pick<WorkspaceSessionApplicationOptions, "fileSystem" | "runtime"> & {
		readonly io: Pick<ApplicationIO, "stdout">;
	};
	readonly diagnostics: DiagnosticSink;
}): Promise<number> | undefined {
	const cleanup = async () => {
		const [logs, media] = await Promise.all([
			cleanupTemporaryLogs({
				fileSystem: input.options.fileSystem,
				homeDirectory: input.options.runtime.homeDirectory,
				now: input.options.runtime.clock.now(),
				diagnostics: input.diagnostics,
			}),
			cleanupSessionMedia({
				fileSystem: input.options.fileSystem,
				homeDirectory: input.options.runtime.homeDirectory,
				now: input.options.runtime.clock.now(),
				diagnostics: input.diagnostics,
			}),
		]);
		return {
			removed: [...logs.removed, ...media.removed],
			retainedBytes: logs.retainedBytes + media.retainedBytes,
		};
	};
	if (input.explicit) {
		return (async () => {
			const result = await cleanup();
			if (input.output === "json") {
				await input.options.io.stdout.write(
					`${JSON.stringify({ schemaVersion: 1, type: "cleanup", removed: result.removed.length, retainedBytes: result.retainedBytes })}\n`,
				);
			} else {
				await input.options.io.stdout.write(
					`Removed ${result.removed.length} unreferenced artifact${result.removed.length === 1 ? "" : "s"}; ${result.retainedBytes} bytes retained.\n`,
				);
			}
			return 0;
		})();
	}
	void cleanup().catch(async (error: unknown) => {
		await input.diagnostics({
			code: "temporary-log.cleanup-failed",
			message: error instanceof Error ? error.message : String(error),
		});
	});
	return undefined;
}

export interface WorkspaceDiffTracker {
	begin(session: Session, runId: string): Promise<void>;
	drain(session: Session): Promise<void>;
}

export function createWorkspaceDiffTracker(input: {
	readonly processRunner: ProcessRunner;
	readonly workspace: string;
	readonly environment: Readonly<Record<string, string | undefined>>;
}): WorkspaceDiffTracker {
	const pendingBySession = new Map<string, Set<Promise<void>>>();
	return {
		begin: (session, runId) => {
			const operation = (async () => {
				const diff = await collectWorkspaceDiff(input);
				session.supplementRunEvidence(runId, diff);
			})();
			const key = session.descriptor.id;
			const pending = pendingBySession.get(key) ?? new Set<Promise<void>>();
			pending.add(operation);
			pendingBySession.set(key, pending);
			const remove = () => {
				pending.delete(operation);
				if (pending.size === 0) pendingBySession.delete(key);
			};
			void operation.then(remove, remove);
			return operation;
		},
		drain: async (session) => {
			for (;;) {
				const pending = [...(pendingBySession.get(session.descriptor.id) ?? [])];
				if (pending.length === 0) return;
				await Promise.allSettled(pending);
			}
		},
	};
}

export function trackWorkspaceDiffs(input: {
	readonly work: SessionWorkController;
	readonly session: Session;
	readonly mode: "interactive" | "print";
	readonly tracker: WorkspaceDiffTracker;
}): void {
	input.work.subscribeResult(async (result) => {
		if (!result.run) return;
		const supplement = input.tracker.begin(input.session, result.run.runId);
		if (input.mode === "interactive" && !input.work.state().closed) void supplement.catch(() => undefined);
		else await supplement;
	});
}

export interface WorkspaceSessionResources {
	useMcpRegistry(registry: CodingMcpRegistry): void;
	useProcessSessionManager(manager: ProcessSessionManager): void;
	useWorkCoordinator(coordinator: WorkspaceWorkCoordinator): void;
	close(): Promise<void>;
}

export function createWorkspaceSessionResources(input: {
	readonly session: Session;
	readonly mediaLibrary: MediaLibrary;
	readonly workspaceDiffs: WorkspaceDiffTracker;
}): WorkspaceSessionResources {
	let mcpRegistry: CodingMcpRegistry | undefined;
	let processSessionManager: ProcessSessionManager | undefined;
	let workCoordinator: WorkspaceWorkCoordinator | undefined;
	return {
		useMcpRegistry: (registry) => {
			mcpRegistry = registry;
		},
		useProcessSessionManager: (manager) => {
			processSessionManager = manager;
		},
		useWorkCoordinator: (coordinator) => {
			workCoordinator = coordinator;
		},
		close: async () => {
			const failures: unknown[] = [];
			try {
				await input.workspaceDiffs.drain(input.session);
			} catch (error) {
				failures.push(error);
			}
			try {
				if (workCoordinator) await workCoordinator.close();
				else await input.session.close();
			} catch (error) {
				failures.push(error);
			}
			try {
				await input.workspaceDiffs.drain(input.session);
			} catch (error) {
				failures.push(error);
			}
			try {
				await processSessionManager?.close();
			} catch (error) {
				failures.push(error);
			}
			try {
				await mcpRegistry?.close();
			} catch (error) {
				failures.push(error);
			}
			try {
				await input.mediaLibrary.dispose();
			} catch (error) {
				failures.push(error);
			}
			if (failures.length === 1) throw failures[0];
			if (failures.length > 1) throw new AggregateError(failures, "Could not close the Agent runtime");
		},
	};
}

export interface OpenedWorkspaceRuntime {
	readonly processSessionManager: ProcessSessionManager;
	readonly inputResources: WorkspaceInputResources;
	readonly coordinator: WorkspaceWorkCoordinator;
	readonly work: SessionWorkController;
	readonly runControl?: AgentRunControlBinding;
}

export async function openWorkspaceRuntime(input: {
	readonly options: WorkspaceSessionApplicationOptions;
	readonly resources: WorkspaceSessionResources;
	readonly sessions: SessionManager;
	readonly session: Session;
	readonly workspace: Workspace;
	readonly workspaceId: string;
	readonly mode: "interactive" | "print";
	readonly forceUnlock: boolean;
	readonly maxTurns?: number;
	readonly disableRunBudget: boolean;
	readonly maxOutputTokens?: number;
	readonly skillsManager: CodingSkillsManager;
	readonly mcpRegistry?: CodingMcpRegistry;
	readonly projectInstructions?: TrustedProjectInstructions;
	readonly model: Model<Api>;
	readonly reasoning: ThinkingLevel | "off";
	readonly authSnapshot: AuthResult;
	readonly mcpElicitation?: (request: McpAgentElicitation) => Promise<McpElicitationResult>;
	readonly runControl?: RunControlConfiguration;
}): Promise<OpenedWorkspaceRuntime> {
	const configuredShell = input.options.runtime.environment.SHELL;
	const shellExecutable = configuredShell && isAbsolute(configuredShell) ? configuredShell : "/bin/sh";
	const processSessionManager = new ProcessSessionManager({
		fileSystem: input.options.fileSystem,
		homeDirectory: input.options.runtime.homeDirectory,
		runner: input.options.processSessionRunner ?? unavailableProcessSessionRunner,
		idGenerator: input.options.runtime.idGenerator,
	});
	const inputResources = new WorkspaceInputResources();
	input.resources.useProcessSessionManager(processSessionManager);
	const workspacePersistence = input.options.workspacePersistence?.({
		workspaceId: input.workspaceId,
		workspaceRoot: input.workspace.root,
	});
	const coordinator = createWorkspaceWorkCoordinator({
		workspace: input.workspace,
		fileSystem: input.options.fileSystem,
		processRunner: input.options.processRunner,
		processSessionManager,
		shellExecutable,
		hostRuntime: input.options.runtime,
		skillsManager: input.skillsManager,
		mcpRegistry: input.mcpRegistry,
		models: input.options.models,
		clock: input.options.runtime.clock,
		idGenerator: input.options.runtime.idGenerator,
		runBudget: codingAgentRunBudget(input.maxTurns, input.disableRunBudget),
		maxOutputTokens: input.maxOutputTokens,
		platform: input.options.runtime.platform,
		interactionMode: input.mode,
		projectInstructions: input.projectInstructions,
		resources: inputResources.adapter,
		resumeDurableRoot: (sessionId) =>
			input.sessions.open({
				workspace: { id: input.workspaceId, path: input.workspace.root },
				mode: input.mode,
				resumeId: sessionId,
				forceUnlock: input.forceUnlock,
				persistent: true,
			}),
		...(workspacePersistence ? { persistence: workspacePersistence } : {}),
		...(input.options.runtime.scheduler ? { scheduler: input.options.runtime.scheduler } : {}),
	});
	input.resources.useWorkCoordinator(coordinator);
	await input.session.record({
		type: "model_selected",
		model: { provider: input.model.provider, id: input.model.id },
		reasoning: input.reasoning,
	});
	const work = await openInteractiveRuntime({
		coordinator,
		session: input.session,
		selection: { model: input.model, reasoning: input.reasoning, authSnapshot: input.authSnapshot },
		mcpElicitation: input.mcpElicitation,
	});
	const runControl = bindInteractiveRunControl({
		work,
		configuration: input.runControl,
		clock: input.options.runtime.clock,
		scheduler: input.options.runtime.scheduler,
	});
	return {
		processSessionManager,
		inputResources,
		coordinator,
		work,
		...(runControl ? { runControl } : {}),
	};
}

export interface SecondarySessionResource {
	readonly session: Session;
	readonly work: SessionWorkController;
	readonly mediaLibrary: MediaLibrary;
	readonly runControl?: AgentRunControlBinding;
}

export async function closeSecondarySessionResources(
	resources: Iterable<SecondarySessionResource>,
	workspaceDiffs: WorkspaceDiffTracker,
): Promise<void> {
	await Promise.all(
		[...resources].map(async (resource) => {
			const failures: unknown[] = [];
			resource.runControl?.dispose();
			try {
				await workspaceDiffs.drain(resource.session);
			} catch (error) {
				failures.push(error);
			}
			try {
				await resource.work.close();
			} catch (error) {
				failures.push(error);
			}
			try {
				await workspaceDiffs.drain(resource.session);
			} catch (error) {
				failures.push(error);
			}
			try {
				await resource.mediaLibrary.dispose();
			} catch (error) {
				failures.push(error);
			}
			if (failures.length === 1) throw failures[0];
			if (failures.length > 1) {
				throw new AggregateError(failures, "Could not close an interactive Session runtime");
			}
		}),
	);
}
