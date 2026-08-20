import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Clock, IdGenerator, RunBudget } from "@coda/agent";
import type { AuthResult, Models, ThinkingLevel } from "@coda/ai";
import type { McpElicitationResult, McpToolLease } from "@coda/mcp";
import {
	type CodingAgent,
	type LifecycleHookHost,
	type ModelDriverLease,
	type OpenCodingAgentOptions,
	openCodingAgent,
	type RunCapabilitySource,
	type RunModelSelection,
	type RuntimeScheduler,
	type RuntimeTime,
	type WorkCapacityPolicy,
	type WorkspaceExecution,
} from "@coda/runtime";
import type { ProcessConfinement } from "@coda/sandbox";
import type { FileSystem } from "../host/file-system.ts";
import type { ProcessRunner } from "../host/process-runner.ts";
import type { HostProcessRuntime } from "../host/runtime.ts";
import { createWorkspace, type Workspace } from "../host/workspace.ts";
import type { CodingMcpRegistry } from "../mcp/registry.ts";
import {
	createMcpCapabilitySource,
	type McpAgentElicitation,
	type McpRunExposureDiagnostic,
} from "../mcp/run-capability.ts";
import type { ProcessSessionManager } from "../process/process-session-manager.ts";
import type { Session } from "../session/types.ts";
import type { SessionHistoryReadPort } from "../session-history/reader.ts";
import type { TrustedProjectInstructions } from "../settings/project-context.ts";
import type { CodingSkillsManager } from "../skills/manager.ts";
import { createSkillsCapabilitySource } from "../skills/run-capability.ts";
import { createCodingToolContributions } from "../tools/index.ts";
import { TargetMutationCoordinator } from "../tools/mutation.ts";
import { unavailableWebRuntime, type WebRuntime } from "../tools/web/runtime.ts";
import { createDirectWorkspaceExecution } from "./direct-workspace-execution.ts";
import { createGitWorktreeWorkspaceExecution } from "./git-worktree-workspace-execution.ts";
import type { AcquireProjectRunCapabilityBundle } from "./project-capability-bundle.ts";
import { SessionWorkController, type SessionWorkHost, type SessionWorkSelection } from "./session-work-controller.ts";

type WorkSession = Awaited<ReturnType<OpenCodingAgentOptions["sessions"]["reserve"]>>["session"];
type WorkSessionStore = OpenCodingAgentOptions["sessions"];
type WorkSessionReserveRequest = Parameters<WorkSessionStore["reserve"]>[0];
type WorkspaceToolContribution = Awaited<ReturnType<WorkspaceExecution["tooling"]["tools"]>>[number];

const DEFAULT_WORK_CONCURRENCY = 8;
const DEFAULT_WORK_CAPACITY_POLICY: WorkCapacityPolicy = Object.freeze({
	processMaximumConcurrency: DEFAULT_WORK_CONCURRENCY,
	graphMaximumConcurrency: DEFAULT_WORK_CONCURRENCY,
});

interface RegisteredSession {
	readonly session: Session;
	readonly ownership: "application" | "store";
	controller?: SessionWorkController;
}

function emptyMcpLease(): McpToolLease {
	return Object.freeze({
		revision: 0,
		servers: Object.freeze([]),
		tools: Object.freeze([]),
		callTool: async () => {
			throw new Error("No MCP Tools are available");
		},
		dispose: () => Promise.resolve(),
	});
}

/** Owns exclusive runtime leases over the application's canonical Session objects. */
export class WorkspaceWorkSessions {
	readonly #bindings = new Map<string, RegisteredSession>();
	readonly #leases = new Set<string>();
	readonly #loads = new Map<string, Promise<RegisteredSession>>();
	readonly #openPrivateSession: (sessionId: string) => Promise<Session>;
	readonly #resumeDurableRoot?: (sessionId: string) => Promise<Session>;

	constructor(options: {
		readonly openPrivateSession: (sessionId: string) => Promise<Session>;
		readonly resumeDurableRoot?: (sessionId: string) => Promise<Session>;
	}) {
		this.#openPrivateSession = options.openPrivateSession;
		this.#resumeDurableRoot = options.resumeDurableRoot;
	}

	readonly adapter: WorkSessionStore = Object.freeze({
		reserve: async (request: WorkSessionReserveRequest) => {
			const requestedId = request.target.sessionId;
			let binding = requestedId ? this.#bindings.get(requestedId) : undefined;
			let created = false;
			if (request.target.type === "create") {
				const id = requestedId ?? `session:${request.graphId}:${request.itemId}`;
				if (binding) throw new Error(`Work Session identity is already registered: ${id}`);
				binding = await this.#openPrivate(id);
				this.#bindings.set(id, binding);
				created = true;
			}
			// A pending/ready child has never started a Run, so its private Session
			// transcript is necessarily empty and can be recreated from Journal
			// ownership. Root Sessions remain durable application-owned records.
			if (!binding && request.target.type === "resume" && requestedId && request.parentItemId) {
				binding = await this.#openPrivate(requestedId);
				this.#bindings.set(requestedId, binding);
				created = true;
			}
			if (!binding && request.target.type === "resume" && requestedId && !request.parentItemId) {
				binding = await this.#loadDurableRoot(requestedId);
			}
			if (!binding) throw new Error(`Durable Session is not open: ${String(requestedId)}`);
			const id = binding.session.id;
			if (this.#leases.has(id)) throw new Error(`Work Session is already leased: ${id}`);
			this.#leases.add(id);
			let released = false;
			const release = async () => {
				if (released) return;
				released = true;
				this.#leases.delete(id);
				if (created || binding!.ownership !== "application") {
					if (this.#bindings.get(id) === binding) this.#bindings.delete(id);
					await binding!.session.close();
				}
			};
			return Object.freeze({
				session: binding.session as WorkSession,
				commit: () => Promise.resolve(),
				rollback: release,
				release,
				evidence: (runId: string) => {
					const result = [...binding!.session.runEvidence]
						.reverse()
						.find((candidate) => candidate.runId === runId);
					return result ? { version: 1, facts: result } : undefined;
				},
			});
		},
	});

	register(session: Session): RegisteredSession {
		const id = session.id;
		if (this.#bindings.has(id)) throw new Error(`Session is already open in this Workspace: ${id}`);
		const binding: RegisteredSession = { session, ownership: "application" };
		this.#bindings.set(id, binding);
		return binding;
	}

	async #openPrivate(sessionId: string): Promise<RegisteredSession> {
		const session = await this.#openPrivateSession(sessionId);
		if (session.id !== sessionId) {
			await session.close().catch(() => undefined);
			throw new Error(`Private Session identity changed from ${sessionId} to ${session.id}`);
		}
		return { session, ownership: "store" };
	}

	async #loadDurableRoot(sessionId: string): Promise<RegisteredSession | undefined> {
		if (!this.#resumeDurableRoot) return undefined;
		let operation = this.#loads.get(sessionId);
		if (!operation) {
			operation = this.#resumeDurableRoot(sessionId)
				.then(async (session) => {
					if (String(session.descriptor.id) !== sessionId) {
						await session.close();
						throw new Error(`Resumed Session identity changed from ${sessionId} to ${session.descriptor.id}`);
					}
					const existing = this.#bindings.get(sessionId);
					if (existing) {
						await session.close();
						return existing;
					}
					const binding: RegisteredSession = { session, ownership: "store" };
					this.#bindings.set(sessionId, binding);
					return binding;
				})
				.finally(() => this.#loads.delete(sessionId));
			this.#loads.set(sessionId, operation);
		}
		return operation;
	}

	history(sessionId: string): SessionHistoryReadPort {
		const binding = this.#bindings.get(sessionId);
		if (!binding) throw new Error(`Session history is unavailable: ${sessionId}`);
		return binding.session.history;
	}

	release(sessionId: string): void {
		if (this.#leases.has(sessionId)) throw new Error(`Cannot release leased Session: ${sessionId}`);
		const binding = this.#bindings.get(sessionId);
		if (binding?.ownership === "application") this.#bindings.delete(sessionId);
	}
}

export interface OpenWorkspaceSessionWorkRequest {
	readonly session: Session;
	readonly selection: SessionWorkSelection;
	readonly mcpElicitation?: (request: McpAgentElicitation) => Promise<McpElicitationResult>;
}

export interface WorkspaceWorkCoordinator {
	open(request: OpenWorkspaceSessionWorkRequest): Promise<SessionWorkController>;
	close(): Promise<void>;
}

export interface WorkspaceExecutionFactoryContext {
	readonly root: string;
	readonly createTools: (request: {
		readonly graphId: string;
		readonly itemId: string;
		readonly sessionId: string;
		readonly placement: Awaited<ReturnType<WorkspaceExecution["placement"]["reserve"]>>["placement"];
	}) => readonly WorkspaceToolContribution[] | Promise<readonly WorkspaceToolContribution[]>;
	readonly quiesceSession: (sessionId: string) => Promise<void>;
	readonly direct: () => WorkspaceExecution;
}

/** Creates one Workspace-scoped Work Coordinator shared by primary and secondary Sessions. */
export function createWorkspaceWorkCoordinator(options: {
	readonly workspace: Workspace;
	readonly fileSystem: FileSystem;
	readonly processRunner: ProcessRunner;
	readonly processSessionManager: ProcessSessionManager;
	readonly shellExecutable: string;
	readonly hostRuntime: HostProcessRuntime;
	readonly skillsManager: CodingSkillsManager;
	readonly projectCapabilities?: AcquireProjectRunCapabilityBundle;
	readonly pluginCapabilitySource?: RunCapabilitySource;
	readonly mcpRegistry?: CodingMcpRegistry;
	readonly mcpDiagnostic?: (diagnostic: McpRunExposureDiagnostic) => void | Promise<void>;
	readonly models: Models;
	readonly clock: Clock;
	readonly idGenerator: IdGenerator;
	readonly capacity?: WorkCapacityPolicy;
	readonly scheduler?: RuntimeScheduler;
	readonly runBudget?: RunBudget;
	readonly maxOutputTokens?: number;
	readonly platform: NodeJS.Platform;
	readonly interactionMode: "interactive" | "print";
	readonly projectInstructions?: TrustedProjectInstructions;
	readonly persistence?: OpenCodingAgentOptions["persistence"];
	readonly resources?: OpenCodingAgentOptions["resources"];
	readonly openPrivateSession: (sessionId: string) => Promise<Session>;
	readonly resumeDurableRoot?: (sessionId: string) => Promise<Session>;
	readonly createWorkspaceExecution?: (
		context: WorkspaceExecutionFactoryContext,
	) => WorkspaceExecution | Promise<WorkspaceExecution>;
	readonly lifecycleHooks?: LifecycleHookHost;
	readonly wrapScript?: (
		request: Parameters<ProcessConfinement["wrapScript"]>[0],
	) => Promise<Awaited<ReturnType<ProcessConfinement["wrapScript"]>> | undefined>;
	readonly web?: WebRuntime;
}): WorkspaceWorkCoordinator {
	const capacity = options.capacity ?? DEFAULT_WORK_CAPACITY_POLICY;
	const sessions = new WorkspaceWorkSessions({
		openPrivateSession: options.openPrivateSession,
		...(options.resumeDurableRoot ? { resumeDurableRoot: options.resumeDurableRoot } : {}),
	});
	const mutationCoordinator = new TargetMutationCoordinator();
	const controllers = new Map<string, SessionWorkController>();
	const drivers = new Map<string, SessionWorkSelection>();
	const elicitationBySession = new Map<string, (request: McpAgentElicitation) => Promise<McpElicitationResult>>();
	const sessionByRun = new Map<string, string>();
	const parentSessionByChild = new Map<string, string>();

	const controllerForGraph = (graphId: string): SessionWorkController | undefined => {
		for (const controller of controllers.values()) {
			if (controller.state().activeGraphId === graphId) return controller;
		}
		return undefined;
	};

	const elicitationHandlerFor = (sessionId: string | undefined) => {
		if (!sessionId) return undefined;
		return elicitationBySession.get(sessionId) ?? elicitationBySession.get(parentSessionByChild.get(sessionId) ?? "");
	};
	const placementWorkspaces = new Map<string, Promise<Workspace>>([
		[options.workspace.root, Promise.resolve(options.workspace)],
	]);
	const workspaceFor = (root: string): Promise<Workspace> => {
		let workspace = placementWorkspaces.get(root);
		if (!workspace) {
			workspace = createWorkspace(root, options.fileSystem);
			placementWorkspaces.set(root, workspace);
		}
		return workspace;
	};
	const createTools: WorkspaceExecutionFactoryContext["createTools"] = async (request) =>
		createCodingToolContributions({
			workspace: await workspaceFor(request.placement.root),
			fileSystem: options.fileSystem,
			processRunner: options.processRunner,
			processSessionManager: options.processSessionManager,
			shellExecutable: options.shellExecutable,
			runtime: options.hostRuntime,
			sessionHistory: sessions.history(request.sessionId),
			sessionId: request.sessionId,
			mutationCoordinator,
			web: options.web ?? unavailableWebRuntime,
			...(options.wrapScript ? { wrapScript: options.wrapScript } : {}),
		});
	const quiesceSession = (sessionId: string) => options.processSessionManager.retireSession(sessionId);
	const direct = () =>
		createDirectWorkspaceExecution({
			root: options.workspace.root,
			createTools,
			quiesceSession,
		});
	const environment = Object.fromEntries(
		Object.entries(options.hostRuntime.environment).filter(
			(entry): entry is [string, string] => entry[1] !== undefined,
		),
	);
	const defaultWorkspaceExecution = async (): Promise<WorkspaceExecution> => {
		let gitWorkspace = false;
		try {
			const probe = await options.processRunner.run({
				executable: "git",
				args: ["rev-parse", "--show-toplevel"],
				cwd: options.workspace.root,
				environment,
				signal: new AbortController().signal,
				timeoutMs: 10_000,
				maxOutputBytes: 64 * 1_024,
				maxOutputLines: 256,
			});
			gitWorkspace = probe.exitCode === 0 && !probe.timedOut && probe.stdout.trim().length > 0;
		} catch {}
		if (!gitWorkspace) return direct();
		const workspaceKey = createHash("sha256").update(options.workspace.root).digest("hex").slice(0, 24);
		try {
			return await createGitWorktreeWorkspaceExecution({
				sourceRoot: options.workspace.root,
				stateRoot: join(options.hostRuntime.homeDirectory, ".coda", "worktrees", workspaceKey),
				processRunner: options.processRunner,
				environment,
				createTools,
				quiesceSession,
			});
		} catch {
			return direct();
		}
	};
	let workspaceExecution: Promise<WorkspaceExecution> | undefined;
	const ensureWorkspaceExecution = (): Promise<WorkspaceExecution> => {
		if (!workspaceExecution) {
			const context: WorkspaceExecutionFactoryContext = {
				root: options.workspace.root,
				createTools,
				quiesceSession,
				direct,
			};
			workspaceExecution = Promise.resolve(
				options.createWorkspaceExecution ? options.createWorkspaceExecution(context) : defaultWorkspaceExecution(),
			);
		}
		return workspaceExecution;
	};
	let agent: CodingAgent | undefined;
	let opening: Promise<CodingAgent> | undefined;
	let observationPump: Promise<void> | undefined;
	let closeOperation: Promise<void> | undefined;
	const driverKey = (provider: string, id: string) => `${provider}\0${id}`;
	const registerSelection = (selection: SessionWorkSelection): void => {
		drivers.set(driverKey(selection.model.provider, selection.model.id), Object.freeze({ ...selection }));
	};
	const modelProvider: OpenCodingAgentOptions["modelProvider"] = {
		resolve: async (configuration) => {
			const cached = drivers.get(driverKey(configuration.model.provider, configuration.model.id));
			const model = cached?.model ?? options.models.getModel(configuration.model.provider, configuration.model.id);
			if (!model) {
				throw new Error(`Model is unavailable: ${configuration.model.provider}/${configuration.model.id}`);
			}
			const authSnapshot: AuthResult | undefined =
				cached?.authSnapshot ?? (await options.models.getAuth(model, { clock: options.clock }));
			return {
				model,
				reasoning: configuration.reasoning as ThinkingLevel | "off",
				...(authSnapshot ? { authSnapshot } : {}),
			};
		},
		lease: (selection: RunModelSelection) => {
			if (!selection.authSnapshot) {
				throw new Error(`Model is not authenticated: ${selection.model.provider}/${selection.model.id}`);
			}
			const driver = options.models.bindSimple(selection.model, selection.authSnapshot);
			const reasoning = selection.reasoning === "off" ? undefined : selection.reasoning;
			return Object.freeze({
				model: driver.model,
				revision: `${driver.model.provider}:${driver.providerGeneration}`,
				stream: (...[context, streamOptions]: Parameters<ModelDriverLease["stream"]>) =>
					driver.stream(context, { ...streamOptions, reasoning }),
				complete: (...[context, streamOptions]: Parameters<ModelDriverLease["complete"]>) =>
					driver.complete(context, { ...streamOptions, reasoning }),
				dispose: () => undefined,
			});
		},
	};
	const projectCapabilitySources = options.projectCapabilities
		? [createSkillsCapabilitySource({ acquireProjectBundle: options.projectCapabilities })]
		: [createSkillsCapabilitySource(options.skillsManager)];
	const capabilitySources = [
		...projectCapabilitySources,
		...(options.pluginCapabilitySource ? [options.pluginCapabilitySource] : []),
		createMcpCapabilitySource({
			...(options.projectCapabilities
				? { acquireProjectBundle: options.projectCapabilities }
				: {
						acquire: async (signal: AbortSignal) => {
							if (!options.mcpRegistry) return emptyMcpLease();
							await options.mcpRegistry.refresh({ signal });
							if (signal.aborted)
								throw signal.reason ?? new DOMException("MCP acquisition aborted", "AbortError");
							return options.mcpRegistry.acquireTools();
						},
					}),
			elicit: async (request) => {
				const owner = sessionByRun.get(String(request.execution.runId));
				return elicitationHandlerFor(owner)?.(request) ?? { action: "decline" };
			},
			...(options.mcpDiagnostic ? { diagnostic: options.mcpDiagnostic } : {}),
		}),
	];
	const systemTime = createWorkspaceRuntimeTime(options.clock, options.scheduler);
	const startObservationPump = (openedAgent: CodingAgent): void => {
		if (observationPump) return;
		observationPump = (async () => {
			let resynchronize = true;
			while (resynchronize) {
				resynchronize = false;
				for await (const observation of openedAgent.observe({ capacity: 4_096 })) {
					if (observation.type === "resync_required") {
						resynchronize = true;
						break;
					}
					if (observation.type === "closed") return;
					if (observation.type === "snapshot") {
						for (const controller of controllers.values()) controller.resynchronize(observation.snapshot);
						continue;
					}
					const graphId =
						observation.type === "work_graph_settled"
							? observation.result.graphId
							: "graphId" in observation
								? observation.graphId
								: undefined;
					const owner = graphId ? controllerForGraph(graphId) : undefined;
					if (
						owner &&
						"sessionId" in observation &&
						typeof observation.sessionId === "string" &&
						observation.sessionId !== owner.sessionId
					) {
						parentSessionByChild.set(observation.sessionId, owner.sessionId);
					}
					if (observation.type === "work_item_event") {
						const event = observation.event;
						if (event.type === "preparation_settled" && event.outcome === "prepared") {
							if (!owner || observation.itemId === owner.state().activeItemId) {
								(owner ?? controllers.get(observation.sessionId))?.notePreparation({
									version: event.promptVersion,
									sha256: event.promptSha256,
								});
							}
						} else if ("runId" in event && owner && observation.itemId === owner.state().activeItemId) {
							owner.acceptWorkerEvent(event, {
								graphId: observation.graphId,
								itemId: observation.itemId,
								runtimeId: observation.runtimeId,
							});
						} else if ("runId" in event && !owner) {
							controllers.get(observation.sessionId)?.acceptWorkerEvent(event, {
								graphId: observation.graphId,
								itemId: observation.itemId,
								runtimeId: observation.runtimeId,
							});
						}
					}
					try {
						owner?.acceptObservation(observation);
					} catch {
						// Observation projection must not become a Work Graph barrier.
					}
				}
			}
		})().catch(() => undefined);
	};
	const ensureAgent = (): Promise<CodingAgent> => {
		if (agent) return Promise.resolve(agent);
		if (opening) return opening;
		opening = ensureWorkspaceExecution()
			.then((activeWorkspaceExecution) =>
				openCodingAgent({
					placement: activeWorkspaceExecution.placement,
					tooling: activeWorkspaceExecution.tooling,
					publication: activeWorkspaceExecution.publication,
					sessions: sessions.adapter,
					...(options.resources ? { resources: options.resources } : {}),
					...(options.persistence ? { persistence: options.persistence } : {}),
					modelProvider,
					capabilitySources,
					time: systemTime,
					identity: options.idGenerator,
					capacity,
					...(options.runBudget ? { runBudget: options.runBudget } : {}),
					...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens }),
					platform: options.platform,
					interactionMode: options.interactionMode,
					...(options.lifecycleHooks ? { lifecycleHooks: options.lifecycleHooks } : {}),
					...(options.projectInstructions ? { projectInstructions: () => options.projectInstructions } : {}),
					workerControl: {
						accept: ({ sessionId, placement, event }) => {
							if (!("runId" in event)) return;
							const runId = String(event.runId);
							if (event.type === "run_start") {
								sessionByRun.set(runId, sessionId);
								controllers.get(sessionId)?.notePlacement(placement);
							}
							const operation = controllers.get(sessionId)?.acceptWorkerControlEvent(event);
							if (event.type === "run_end") {
								return Promise.resolve(operation).finally(() => sessionByRun.delete(runId));
							}
							return operation;
						},
					},
				}),
			)
			.then((opened) => {
				agent = opened;
				startObservationPump(opened);
				return opened;
			});
		return opening;
	};

	return Object.freeze({
		open: async (request: OpenWorkspaceSessionWorkRequest) => {
			if (closeOperation) throw new Error("Workspace Work Coordinator is closing");
			registerSelection(request.selection);
			const binding = sessions.register(request.session);
			let hookSessionStarted = false;
			if (request.mcpElicitation) elicitationBySession.set(binding.session.id, request.mcpElicitation);
			try {
				if (options.lifecycleHooks) {
					await options.lifecycleHooks.sessionStart({
						sessionId: binding.session.id,
						...(binding.session.descriptor.path ? { transcriptPath: binding.session.descriptor.path } : {}),
						cwd: binding.session.descriptor.workspace.path,
						model: request.selection.model.id,
						source:
							binding.session.seed.messages.length > 0 || binding.session.recoverableFollowUps.length > 0
								? "resume"
								: "startup",
					});
					hookSessionStarted = true;
				}
				const openedAgent = await ensureAgent();
				const host: SessionWorkHost = {
					agent: openedAgent,
					clock: options.clock,
					idGenerator: options.idGenerator,
					capacity,
					registerSelection,
					release: async (controller) => {
						if (controllers.get(controller.sessionId) !== controller) return;
						controllers.delete(controller.sessionId);
						elicitationBySession.delete(controller.sessionId);
						const failures: unknown[] = [];
						try {
							await options.lifecycleHooks?.sessionEnd({
								sessionId: binding.session.id,
								...(binding.session.descriptor.path ? { transcriptPath: binding.session.descriptor.path } : {}),
								cwd: binding.session.descriptor.workspace.path,
								reason: "other",
							});
						} catch (error) {
							failures.push(error);
						}
						try {
							sessions.release(controller.sessionId);
						} catch (error) {
							failures.push(error);
						}
						try {
							await controller.session.close();
						} catch (error) {
							failures.push(error);
						}
						if (failures.length === 1) throw failures[0];
						if (failures.length > 1) throw new AggregateError(failures, "Session close failed");
					},
				};
				const controller = new SessionWorkController({
					host,
					session: request.session,
					selection: request.selection,
				});
				binding.controller = controller;
				controllers.set(binding.session.id, controller);
				return controller;
			} catch (error) {
				elicitationBySession.delete(binding.session.id);
				if (hookSessionStarted) {
					await options.lifecycleHooks
						?.sessionEnd({
							sessionId: binding.session.id,
							...(binding.session.descriptor.path ? { transcriptPath: binding.session.descriptor.path } : {}),
							cwd: binding.session.descriptor.workspace.path,
							reason: "other",
						})
						.catch(() => undefined);
				}
				sessions.release(binding.session.id);
				throw error;
			}
		},
		close: () => {
			if (closeOperation) return closeOperation;
			closeOperation = (async () => {
				const failures: unknown[] = [];
				for (const controller of [...controllers.values()]) {
					try {
						await controller.close();
					} catch (error) {
						failures.push(error);
					}
				}
				try {
					await (agent ?? (opening ? await opening : undefined))?.close();
					await observationPump;
				} catch (error) {
					failures.push(error);
				}
				if (failures.length === 1) throw failures[0];
				if (failures.length > 1) throw new AggregateError(failures, "Workspace Work Coordinator close failed");
			})();
			return closeOperation;
		},
	});
}

function createWorkspaceRuntimeTime(clock: Clock, scheduler?: RuntimeScheduler): RuntimeTime {
	const resolvedScheduler =
		scheduler ??
		({
			schedule(delayMs, run) {
				const timer = setTimeout(
					() => {
						void run();
					},
					Math.max(0, delayMs),
				);
				return { cancel: () => clearTimeout(timer) };
			},
		} satisfies RuntimeScheduler);
	return {
		clock,
		scheduler: resolvedScheduler,
		random: { next: () => Math.random() },
		sleep: {
			wait: (delayMs, signal) =>
				new Promise<void>((resolve, reject) => {
					if (signal?.aborted) {
						reject(abortError());
						return;
					}
					let settled = false;
					let task: ReturnType<RuntimeScheduler["schedule"]> | undefined;
					const onAbort = (): void => {
						task?.cancel();
						finish(abortError());
					};
					const finish = (error?: Error): void => {
						if (settled) return;
						settled = true;
						signal?.removeEventListener("abort", onAbort);
						if (error) reject(error);
						else resolve();
					};
					task = resolvedScheduler.schedule(delayMs, () => finish());
					signal?.addEventListener("abort", onAbort, { once: true });
					if (signal?.aborted) onAbort();
				}),
		},
	};
}

function abortError(): Error {
	const error = new Error("Request aborted");
	error.name = "AbortError";
	return error;
}
