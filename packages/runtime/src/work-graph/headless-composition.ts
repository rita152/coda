import type { AgentEvent, AgentSeed, AgentTool } from "@coda/agent";
import { openCodingAgent } from "./open-coding-agent.ts";
import type {
	OpenCodingAgentOptions,
	WorkerSession,
	WorkerSessionChange,
	WorkSessionStore,
	WorkspaceExecution,
} from "./ports.ts";
import type { CodingAgent, WorkGraphId, WorkGraphResult } from "./types.ts";
import type { WorkerSessionEvent } from "./worker-protocol.ts";

export interface WaitForGraphOptions {
	readonly capacity?: number;
	readonly closedMessage?: (graphId: WorkGraphId) => string;
}

export async function waitForGraph(
	agent: CodingAgent,
	graphId: WorkGraphId,
	options: WaitForGraphOptions = {},
): Promise<WorkGraphResult> {
	for (;;) {
		let resynchronize = false;
		for await (const observation of agent.observe({ capacity: options.capacity ?? 256 })) {
			if (observation.type === "snapshot") {
				const result = observation.snapshot.graphs.find((graph) => graph.graphId === graphId)?.result;
				if (result) return result;
			}
			if (observation.type === "work_graph_settled" && observation.result.graphId === graphId) {
				return observation.result;
			}
			if (observation.type === "resync_required") {
				resynchronize = true;
				break;
			}
			if (observation.type === "closed") {
				throw new Error(
					options.closedMessage?.(graphId) ?? `Coding Agent closed before Work Graph ${graphId} settled`,
				);
			}
		}
		if (!resynchronize) {
			throw new Error(
				options.closedMessage?.(graphId) ?? `Coding Agent closed before Work Graph ${graphId} settled`,
			);
		}
	}
}

export interface MemoryWorkspaceExecutionOptions {
	readonly root?: string;
	readonly baseIdentity?: string;
	readonly tools?: readonly AgentTool[];
}

export function createMemoryWorkspaceExecution(options: MemoryWorkspaceExecutionOptions = {}): WorkspaceExecution {
	const root = options.root ?? "/memory";
	const baseIdentity = options.baseIdentity ?? "memory:root";
	const placement: WorkspaceExecution["placement"] = {
		reserve: async (request) => ({
			placement: {
				placementId: `memory:${request.graphId}:${request.itemId}`,
				root,
				baseIdentity,
				kind: "memory",
			},
			commit: async () => undefined,
			rollback: async () => undefined,
		}),
		recover: async (request) => ({
			placement: request.placement,
			commit: async () => undefined,
			rollback: async () => undefined,
		}),
		release: async () => undefined,
		close: async () => undefined,
	};
	const tooling: WorkspaceExecution["tooling"] = {
		tools: () => (options.tools ?? []).map((tool) => Object.freeze({ tool, effect: "unknown" as const })),
		bindTools: ({ contributions }) => contributions.map(({ tool }) => tool),
		quiesce: async () => undefined,
		capture: async () => undefined,
	};
	const publication: WorkspaceExecution["publication"] = {
		publish: async () => ({ state: "not_required" }),
	};
	return Object.freeze({ placement: Object.freeze(placement), tooling: Object.freeze(tooling), publication });
}

/** Safe no-host Workspace capabilities for tests and headless consumers. */
export function createNullWorkspaceExecution(): WorkspaceExecution {
	return createMemoryWorkspaceExecution({ root: "/workspace", baseIdentity: "workspace:null" });
}

export interface MemoryWorkSession extends WorkerSession {
	readonly events: readonly AgentEvent[];
	readonly changes: readonly WorkerSessionChange[];
}

export interface MemoryWorkSessionStore extends WorkSessionStore {
	readonly sessions: ReadonlyMap<string, MemoryWorkSession>;
}

export interface MemoryWorkSessionSeed {
	readonly id: string;
	readonly seed?: AgentSeed;
}

export function createMemoryWorkSessionStore(seeds: readonly MemoryWorkSessionSeed[] = []): MemoryWorkSessionStore {
	const sessions = new Map<string, MemoryWorkSession>();
	const createSession = (id: string, seed?: AgentSeed): MemoryWorkSession => {
		const events: AgentEvent[] = [];
		const changes: WorkerSessionChange[] = [];
		const session: MemoryWorkSession = {
			id,
			...(seed ? { seed } : {}),
			accept: (event: WorkerSessionEvent) => {
				events.push(structuredClone(event));
			},
			record: async (change: WorkerSessionChange) => {
				changes.push(structuredClone(change));
			},
			close: async () => undefined,
			get events() {
				return Object.freeze(structuredClone(events));
			},
			get changes() {
				return Object.freeze(structuredClone(changes));
			},
		};
		return Object.freeze(session);
	};
	for (const seed of seeds) sessions.set(seed.id, createSession(seed.id, seed.seed));
	const store: MemoryWorkSessionStore = {
		get sessions() {
			return sessions;
		},
		reserve: async (request) => {
			const id =
				request.target.type === "resume"
					? request.target.sessionId
					: (request.target.sessionId ?? `memory-session:${request.graphId}:${request.itemId}`);
			const existing = sessions.get(id);
			const session = existing ?? createSession(id);
			let committed = existing !== undefined;
			return {
				session,
				commit: async () => {
					if (committed) return;
					committed = true;
					sessions.set(id, session);
				},
				rollback: async () => {
					if (!committed) await session.close();
				},
				evidence: () => undefined,
			};
		},
	};
	return Object.freeze(store);
}

export interface CreateHeadlessCodingAgentOptions
	extends Omit<OpenCodingAgentOptions, "sessions" | "placement" | "tooling" | "publication"> {
	readonly sessions?: WorkSessionStore;
	readonly workspaceExecution?: WorkspaceExecution;
	readonly workspace?: MemoryWorkspaceExecutionOptions;
	readonly sessionSeeds?: readonly MemoryWorkSessionSeed[];
}

export function createHeadlessCodingAgent(options: CreateHeadlessCodingAgentOptions): Promise<CodingAgent> {
	const workspace = options.workspaceExecution ?? createMemoryWorkspaceExecution(options.workspace);
	return openCodingAgent({
		...options,
		placement: workspace.placement,
		tooling: workspace.tooling,
		publication: workspace.publication,
		sessions: options.sessions ?? createMemoryWorkSessionStore(options.sessionSeeds),
	});
}
