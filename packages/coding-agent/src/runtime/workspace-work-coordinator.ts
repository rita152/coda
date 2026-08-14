import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AgentEvent, AgentMessage, AgentSeed, Clock, IdGenerator, RunBudget } from "@coda/agent";
import type { AuthResult, JsonValue, Models, ThinkingLevel } from "@coda/ai";
import type { McpElicitationResult, McpToolSnapshot } from "@coda/mcp";
import { type CodingAgent, type OpenCodingAgentOptions, openCodingAgent, type WorkRunEvidence } from "@coda/runtime";
import type { FileSystem } from "../host/file-system.ts";
import type { ProcessRunner } from "../host/process-runner.ts";
import type { HostProcessRuntime } from "../host/runtime.ts";
import type { CodingMcpRegistry } from "../mcp/registry.ts";
import type { ProcessSessionManager } from "../process/process-session-manager.ts";
import type { TrustedProjectInstructions } from "../project/project-context.ts";
import { RunEvidenceProjection } from "../run-evidence/run-evidence.ts";
import { SessionHistoryReader, type SessionHistoryReadPort } from "../session/session-history-reader.ts";
import type { Session } from "../session/types.ts";
import type { CodingSkillsManager, SkillCommandRegistryBinding } from "../skills/manager.ts";
import type { CodingSkillsSnapshot } from "../skills/types.ts";
import { createCodingToolContributions } from "../tools/index.ts";
import { TargetMutationCoordinator } from "../tools/mutation.ts";
import type { Workspace } from "../workspace.ts";
import { createWorkspace } from "../workspace.ts";
import { createDirectWorkspaceExecution } from "./direct-workspace-execution.ts";
import { createGitWorktreeWorkspaceExecution } from "./git-worktree-workspace-execution.ts";
import { SessionWorkController, type SessionWorkHost, type SessionWorkSelection } from "./session-work-controller.ts";

type McpAgentElicitation = Parameters<NonNullable<OpenCodingAgentOptions["mcpElicitation"]>>[0];
type WorkSession = Awaited<ReturnType<OpenCodingAgentOptions["sessions"]["reserve"]>>["session"];
type WorkSessionChange = Parameters<WorkSession["record"]>[0];
type WorkSessionStore = OpenCodingAgentOptions["sessions"];
type WorkSessionReserveRequest = Parameters<WorkSessionStore["reserve"]>[0];
type WorkspaceExecution = OpenCodingAgentOptions["workspaceExecution"];
type WorkspaceToolContribution = Awaited<ReturnType<WorkspaceExecution["tools"]>>[number];

interface SessionBinding {
	readonly id: string;
	readonly seed: () => AgentSeed;
	readonly compactionCheckpoint: () => WorkSession["compactionCheckpoint"];
	readonly history: SessionHistoryReadPort;
	readonly accept: (event: AgentEvent) => Promise<void> | void;
	readonly record: (change: WorkSessionChange) => Promise<void>;
	readonly evidence: (runId: string) => WorkRunEvidence | undefined;
	readonly durable: boolean;
	readonly ownership: "application" | "store" | "ephemeral";
	readonly closeUnderlying?: () => Promise<void>;
	controller?: SessionWorkController;
}

function json(value: unknown): JsonValue {
	return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function agentEvent(value: JsonValue): AgentEvent | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value) || !("runId" in value)) return undefined;
	return value as unknown as AgentEvent;
}

class EphemeralWorkSession {
	readonly id: string;
	readonly #messages: AgentMessage[] = [];
	readonly #history: SessionHistoryReader;
	readonly #evidence = new RunEvidenceProjection();
	readonly #completedEvidence = new Map<string, ReturnType<RunEvidenceProjection["accept"]>>();

	constructor(id: string) {
		this.id = id;
		this.#history = new SessionHistoryReader({ sessionId: id, messages: () => this.#messages });
	}

	binding(): SessionBinding {
		return {
			id: this.id,
			seed: () => ({ version: 1, messages: structuredClone(this.#messages), pendingFollowUps: [] }),
			compactionCheckpoint: () => undefined,
			history: this.#history,
			accept: (event) => {
				this.#acceptMessage(event);
				const evidence = this.#evidence.accept(event);
				if (evidence) this.#completedEvidence.set(String(event.runId), evidence);
			},
			record: () => Promise.resolve(),
			evidence: (runId) => {
				const result = this.#completedEvidence.get(runId);
				return result ? { version: 1, facts: json(result) } : undefined;
			},
			durable: false,
			ownership: "ephemeral",
		};
	}

	#acceptMessage(event: AgentEvent): void {
		switch (event.type) {
			case "run_start":
				this.#messages.push(structuredClone(event.inputMessage));
				break;
			case "turn_start":
				this.#messages.push(...structuredClone(event.steeringMessages));
				break;
			case "message_end":
				this.#messages.push(structuredClone(event.message));
				break;
			case "tool_execution_end":
			case "tool_execution_rejected":
				this.#messages.push(structuredClone(event.result));
				break;
		}
	}
}

export class WorkspaceWorkSessions {
	readonly #bindings = new Map<string, SessionBinding>();
	readonly #leases = new Set<string>();
	readonly #loads = new Map<string, Promise<SessionBinding>>();
	readonly #resumeDurableRoot?: (sessionId: string) => Promise<Session>;

	constructor(options: { readonly resumeDurableRoot?: (sessionId: string) => Promise<Session> } = {}) {
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
				binding = new EphemeralWorkSession(id).binding();
				this.#bindings.set(id, binding);
				created = true;
			}
			// A pending/ready child has never started a Run, so its private Session
			// transcript is necessarily empty and can be recreated from Journal
			// ownership. Root Sessions remain durable application-owned records.
			if (!binding && request.target.type === "resume" && requestedId && request.parentItemId) {
				binding = new EphemeralWorkSession(requestedId).binding();
				this.#bindings.set(requestedId, binding);
				created = true;
			}
			if (!binding && request.target.type === "resume" && requestedId && !request.parentItemId) {
				binding = await this.#loadDurableRoot(requestedId);
			}
			if (!binding) throw new Error(`Durable Session is not open: ${String(requestedId)}`);
			if (this.#leases.has(binding.id)) throw new Error(`Work Session is already leased: ${binding.id}`);
			this.#leases.add(binding.id);
			let released = false;
			const release = async () => {
				if (released) return;
				released = true;
				this.#leases.delete(binding!.id);
				if (created || binding!.ownership !== "application") {
					if (this.#bindings.get(binding!.id) === binding) this.#bindings.delete(binding!.id);
					await binding!.closeUnderlying?.();
				}
			};
			const session: WorkSession = Object.freeze({
				id: binding.id,
				get seed() {
					return binding!.seed();
				},
				get compactionCheckpoint() {
					return binding!.compactionCheckpoint();
				},
				accept: (event: AgentEvent) => binding!.accept(event),
				record: async (change: WorkSessionChange) => {
					await binding!.record(change);
					if (change.type === "prepare_run") {
						binding!.controller?.notePreparation({
							version: change.promptVersion,
							sha256: change.promptSha256,
						});
					}
				},
				close: release,
			});
			return Object.freeze({
				session,
				commit: () => Promise.resolve(),
				rollback: release,
				evidence: (runId: string) => binding!.evidence(runId),
			});
		},
	});

	register(session: Session): SessionBinding {
		const id = String(session.descriptor.id);
		if (this.#bindings.has(id)) throw new Error(`Session is already open in this Workspace: ${id}`);
		const binding = this.#durableBinding(session, "application");
		this.#bindings.set(id, binding);
		return binding;
	}

	#durableBinding(session: Session, ownership: "application" | "store"): SessionBinding {
		return {
			id: String(session.descriptor.id),
			seed: () => ({ ...session.seed, pendingFollowUps: [] }),
			compactionCheckpoint: () => session.compactionCheckpoint,
			history: session.history,
			accept: (event) => session.accept(event),
			record: (change) => session.record(change),
			evidence: (runId) => {
				const result = [...session.runEvidence].reverse().find((candidate) => candidate.runId === runId);
				return result ? { version: 1, facts: json(result) } : undefined;
			},
			durable: true,
			ownership,
			...(ownership === "store" ? { closeUnderlying: () => session.close() } : {}),
		};
	}

	async #loadDurableRoot(sessionId: string): Promise<SessionBinding | undefined> {
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
					const binding = this.#durableBinding(session, "store");
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
		return binding.history;
	}

	release(sessionId: string): void {
		if (this.#leases.has(sessionId)) throw new Error(`Cannot release leased Session: ${sessionId}`);
		const binding = this.#bindings.get(sessionId);
		if (binding?.durable) this.#bindings.delete(sessionId);
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
		readonly placement: Awaited<ReturnType<WorkspaceExecution["reserve"]>>["placement"];
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
	readonly initialSkills: CodingSkillsSnapshot;
	readonly skillRegistryBinding: SkillCommandRegistryBinding;
	readonly mcpRegistry?: CodingMcpRegistry;
	readonly initialMcp: McpToolSnapshot;
	readonly models: Models;
	readonly clock: Clock;
	readonly idGenerator: IdGenerator;
	readonly scheduler?: OpenCodingAgentOptions["scheduler"];
	readonly runBudget?: RunBudget;
	readonly maxOutputTokens?: number;
	readonly platform: NodeJS.Platform;
	readonly interactionMode: "interactive" | "print";
	readonly projectInstructions?: TrustedProjectInstructions;
	readonly journal?: OpenCodingAgentOptions["journal"];
	readonly resources?: OpenCodingAgentOptions["resources"];
	readonly resumeDurableRoot?: (sessionId: string) => Promise<Session>;
	readonly createWorkspaceExecution?: (
		context: WorkspaceExecutionFactoryContext,
	) => WorkspaceExecution | Promise<WorkspaceExecution>;
}): WorkspaceWorkCoordinator {
	const sessions = new WorkspaceWorkSessions({
		...(options.resumeDurableRoot ? { resumeDurableRoot: options.resumeDurableRoot } : {}),
	});
	const mutationCoordinator = new TargetMutationCoordinator();
	const controllers = new Map<string, SessionWorkController>();
	const drivers = new Map<string, SessionWorkSelection>();
	const elicitationBySession = new Map<string, (request: McpAgentElicitation) => Promise<McpElicitationResult>>();
	const sessionByRun = new Map<string, string>();
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
					if (observation.type !== "work_item_event") continue;
					const event = agentEvent(observation.event);
					if (!event) continue;
					void controllers
						.get(observation.sessionId)
						?.acceptWorkerEvent(event)
						.catch(() => undefined);
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
					workspaceExecution: activeWorkspaceExecution,
					sessions: sessions.adapter,
					...(options.resources ? { resources: options.resources } : {}),
					...(options.journal ? { journal: options.journal } : {}),
					models: options.models,
					resolveConfiguration: async (configuration) => {
						const cached = drivers.get(driverKey(configuration.model.provider, configuration.model.id));
						const model =
							cached?.model ?? options.models.getModel(configuration.model.provider, configuration.model.id);
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
					clock: options.clock,
					idGenerator: options.idGenerator,
					processMaximumConcurrency: 8,
					...(options.scheduler ? { scheduler: options.scheduler } : {}),
					...(options.runBudget ? { runBudget: options.runBudget } : {}),
					...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens }),
					platform: options.platform,
					interactionMode: options.interactionMode,
					...(options.projectInstructions ? { projectInstructions: () => options.projectInstructions } : {}),
					skills: {
						initial: options.initialSkills,
						current: () => options.skillsManager.current,
						refresh: () => options.skillsManager.refresh(),
						synchronize: (snapshot) => options.skillRegistryBinding.sync(snapshot),
					},
					mcp: {
						current: () => options.mcpRegistry?.freezeTools() ?? options.initialMcp,
						...(options.mcpRegistry ? { refresh: async () => void (await options.mcpRegistry!.refresh()) } : {}),
					},
					mcpElicitation: async (request) => {
						const owner = sessionByRun.get(String(request.execution.runId));
						return (owner ? elicitationBySession.get(owner) : undefined)?.(request) ?? { action: "decline" };
					},
					controlWorkerEvent: ({ sessionId, placement, event }) => {
						if (!("runId" in event)) return;
						const runId = String(event.runId);
						if (event.type === "run_start") {
							sessionByRun.set(runId, sessionId);
							controllers.get(sessionId)?.notePlacement(placement);
						}
						const operation = controllers.get(sessionId)?.acceptWorkerControlEvent(event as AgentEvent);
						if (event.type === "run_end") {
							return Promise.resolve(operation).finally(() => sessionByRun.delete(runId));
						}
						return operation;
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
			if (request.mcpElicitation) elicitationBySession.set(binding.id, request.mcpElicitation);
			try {
				const openedAgent = await ensureAgent();
				const host: SessionWorkHost = {
					agent: openedAgent,
					clock: options.clock,
					idGenerator: options.idGenerator,
					registerSelection,
					release: async (controller) => {
						if (controllers.get(controller.sessionId) !== controller) return;
						controllers.delete(controller.sessionId);
						elicitationBySession.delete(controller.sessionId);
						sessions.release(controller.sessionId);
						await controller.session.close();
					},
				};
				const controller = new SessionWorkController({
					host,
					session: request.session,
					selection: request.selection,
				});
				binding.controller = controller;
				controllers.set(binding.id, controller);
				return controller;
			} catch (error) {
				elicitationBySession.delete(binding.id);
				sessions.release(binding.id);
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
