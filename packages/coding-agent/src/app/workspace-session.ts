import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { Clock, IdGenerator } from "@coda/agent";
import type { Api, AuthResult, Model, Models, ThinkingLevel } from "@coda/ai";
import type { McpElicitationResult } from "@coda/mcp";
import type { LifecycleHookHost, OpenCodingAgentOptions } from "@coda/runtime";
import type { ProcessConfinement } from "@coda/sandbox";
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
import type {
	createWorkspaceWorkCoordinator,
	WorkspaceWorkCoordinator,
} from "../runtime/workspace-work-coordinator.ts";
import { createSessionTitleComplete, subscribeSessionTitleGeneration } from "../session/session-title.ts";
import type { Session, SessionManager } from "../session/types.ts";
import type { TrustedProjectInstructions } from "../settings/project-context.ts";
import type { CodingSkillsManager } from "../skills/manager.ts";
import type { WebRuntime } from "../tools/web/runtime.ts";
import { codingAgentRunBudget } from "./argument-parsing.ts";
import {
	bindInteractiveRunControl,
	createSessionMediaLibrary,
	openInteractiveRuntime,
	restoreSessionMedia,
} from "./interactive-session-options.ts";
import type { RestoredChatMedia } from "./media-attachments.ts";

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
	readonly wrapScript?: (
		request: Parameters<ProcessConfinement["wrapScript"]>[0],
	) => Promise<Awaited<ReturnType<ProcessConfinement["wrapScript"]>> | undefined>;
	readonly runtime: WorkspaceSessionRuntime;
	readonly web: WebRuntime;
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
	useLifecycleHooks(hooks: LifecycleHookHost): void;
	useProcessConfinement(confinement: { close(): Promise<void> }): void;
	close(): Promise<void>;
}

export function createWorkspaceSessionResources(): WorkspaceSessionResources {
	let mcpRegistry: CodingMcpRegistry | undefined;
	let processSessionManager: ProcessSessionManager | undefined;
	let workCoordinator: WorkspaceWorkCoordinator | undefined;
	let lifecycleHooks: LifecycleHookHost | undefined;
	let processConfinement: { close(): Promise<void> } | undefined;
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
		useLifecycleHooks: (hooks) => {
			lifecycleHooks = hooks;
		},
		useProcessConfinement: (confinement) => {
			processConfinement = confinement;
		},
		close: async () => {
			const failures: unknown[] = [];
			try {
				await workCoordinator?.close();
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
				await lifecycleHooks?.close();
			} catch (error) {
				failures.push(error);
			}
			try {
				await processConfinement?.close();
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
}

export async function openWorkspaceRuntime(input: {
	readonly createWorkCoordinator: typeof createWorkspaceWorkCoordinator;
	readonly options: WorkspaceSessionApplicationOptions;
	readonly resources: WorkspaceSessionResources;
	readonly sessions: SessionManager;
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
	readonly lifecycleHooks?: LifecycleHookHost;
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
	if (input.lifecycleHooks) input.resources.useLifecycleHooks(input.lifecycleHooks);
	input.resources.useProcessSessionManager(processSessionManager);
	const workspacePersistence = input.options.workspacePersistence?.({
		workspaceId: input.workspaceId,
		workspaceRoot: input.workspace.root,
	});
	const coordinator = input.createWorkCoordinator({
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
		lifecycleHooks: input.lifecycleHooks,
		web: input.options.web,
		...(input.options.wrapScript ? { wrapScript: input.options.wrapScript } : {}),
		resources: inputResources.adapter,
		openPrivateSession: (sessionId) =>
			input.sessions.open({
				workspace: { id: input.workspaceId, path: input.workspace.root },
				mode: input.mode,
				createId: sessionId,
				persistent: false,
			}),
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
	return { processSessionManager, inputResources, coordinator };
}

/** Owns the complete per-Session startup and shutdown sequence for every UI Session. */
export interface OpenedSessionRuntime {
	readonly session: Session;
	readonly work: SessionWorkController;
	readonly mediaLibrary: MediaLibrary;
	readonly restoredMedia: RestoredChatMedia;
	readonly runControl?: AgentRunControlBinding;
	close(): Promise<void>;
}

export async function openSessionRuntime(input: {
	readonly options: {
		readonly fileSystem: FileSystem;
		readonly models: Pick<Models, "bindSimple">;
		readonly runtime: Pick<WorkspaceSessionRuntime, "homeDirectory" | "clock" | "idGenerator" | "scheduler">;
	};
	readonly coordinator: WorkspaceWorkCoordinator;
	readonly session: Session;
	readonly model: Model<Api>;
	readonly reasoning: ThinkingLevel | "off";
	readonly authSnapshot: AuthResult;
	readonly mcpElicitation?: (request: McpAgentElicitation) => Promise<McpElicitationResult>;
	readonly runControl?: RunControlConfiguration;
	readonly workspaceDiffs: WorkspaceDiffTracker;
	readonly mode: "interactive" | "print";
}): Promise<OpenedSessionRuntime> {
	const mediaLibrary = createSessionMediaLibrary(input.session, input.options);
	let work: SessionWorkController | undefined;
	let runControl: AgentRunControlBinding | undefined;
	try {
		await input.session.record({
			type: "model_selected",
			model: { provider: input.model.provider, id: input.model.id },
			reasoning: input.reasoning,
		});
		work = await openInteractiveRuntime({
			coordinator: input.coordinator,
			session: input.session,
			selection: {
				model: input.model,
				reasoning: input.reasoning,
				authSnapshot: input.authSnapshot,
			},
			mcpElicitation: input.mcpElicitation,
		});
		runControl = bindInteractiveRunControl({
			work,
			configuration: input.runControl,
			clock: input.options.runtime.clock,
			scheduler: input.options.runtime.scheduler,
		});
		const restoredMedia = await restoreSessionMedia(input.session, input.options.fileSystem);
		trackWorkspaceDiffs({
			work,
			session: input.session,
			mode: input.mode,
			tracker: input.workspaceDiffs,
		});
		let closeOperation: Promise<void> | undefined;
		const openedWork = work;
		const openedRunControl = runControl;
		const titleGeneration = subscribeSessionTitleGeneration({
			session: input.session,
			subscribe: (observer) => openedWork.subscribe(observer),
			complete: createSessionTitleComplete(input.options.models, input.model, input.authSnapshot),
		});
		return {
			session: input.session,
			work: openedWork,
			mediaLibrary,
			restoredMedia,
			...(openedRunControl ? { runControl: openedRunControl } : {}),
			close: () => {
				if (closeOperation) return closeOperation;
				closeOperation = (async () => {
					const failures: unknown[] = [];
					try {
						titleGeneration.dispose();
						await titleGeneration.done;
					} catch (error) {
						failures.push(error);
					}
					try {
						openedRunControl?.dispose();
					} catch (error) {
						failures.push(error);
					}
					try {
						await input.workspaceDiffs.drain(input.session);
					} catch (error) {
						failures.push(error);
					}
					try {
						await openedWork.close();
					} catch (error) {
						failures.push(error);
					}
					try {
						await input.workspaceDiffs.drain(input.session);
					} catch (error) {
						failures.push(error);
					}
					try {
						await mediaLibrary.dispose();
					} catch (error) {
						failures.push(error);
					}
					if (failures.length === 1) throw failures[0];
					if (failures.length > 1) {
						throw new AggregateError(failures, "Could not close an interactive Session runtime");
					}
				})();
				return closeOperation;
			},
		};
	} catch (error) {
		try {
			runControl?.dispose();
		} catch {}
		if (work) await work.close().catch(() => undefined);
		else await input.session.close().catch(() => undefined);
		await mediaLibrary.dispose().catch(() => undefined);
		throw error;
	}
}

export async function closeSessionRuntimes(resources: Iterable<OpenedSessionRuntime>): Promise<void> {
	await Promise.all([...resources].map((resource) => resource.close()));
}
