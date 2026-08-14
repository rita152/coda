import { createHash } from "node:crypto";
import type {
	AgentEvent,
	AgentSeed,
	AgentTool,
	AttemptId,
	Clock,
	IdGenerator,
	ModelStream,
	RunId,
	TurnId,
} from "@coda/agent";
import type { Api, Context, Model, Models, ModelsSimpleStreamOptions } from "@coda/ai";
import { type CodingAgent, type OpenCodingAgentOptions, openCodingAgent, type WorkGraphResult } from "@coda/runtime";

type WorkerSession = Awaited<ReturnType<OpenCodingAgentOptions["sessions"]["reserve"]>>["session"];

class EvaluationSession implements WorkerSession {
	readonly id: string;
	readonly seed?: AgentSeed;

	constructor(id: string, seed: AgentSeed | undefined) {
		this.id = id;
		this.seed = seed;
	}

	accept(_event: AgentEvent): void {}

	record(_change: Parameters<WorkerSession["record"]>[0]): Promise<void> {
		return Promise.resolve();
	}

	close(): Promise<void> {
		return Promise.resolve();
	}
}

function emptySkills(): OpenCodingAgentOptions["skills"]["initial"] {
	return Object.freeze({
		loader: Object.freeze({
			candidates: Object.freeze([]),
			diagnostics: Object.freeze([]),
			activate: async () => {
				throw new Error("Evaluation Work Graph has no Skills");
			},
		}),
		candidates: Object.freeze([]),
		resolved: Object.freeze([]),
		byId: new Map(),
		diagnostics: Object.freeze([]),
		activate: async () => {
			throw new Error("Evaluation Work Graph has no Skills");
		},
	});
}

function emptyMcp(): ReturnType<OpenCodingAgentOptions["mcp"]["current"]> {
	return Object.freeze({
		revision: 0,
		servers: Object.freeze([]),
		tools: Object.freeze([]),
		callTool: async () => {
			throw new Error("Evaluation Work Graph has no MCP Tools");
		},
	});
}

function evaluationModel(id: string): Model<Api> {
	return Object.freeze({
		id,
		name: id,
		api: "evaluation",
		provider: "evaluation",
		baseUrl: "http://localhost.invalid",
		reasoning: false,
		input: ["text"] as ("image" | "text")[],
		contextWindow: 1_000_000_000,
		maxTokens: 128_000,
	});
}

function evaluationModels(stream: ModelStream): Pick<Models, "completeSimple" | "streamSimple"> {
	let call = 0;
	const streamSimple = (_model: Model<Api>, context: Context, options: ModelsSimpleStreamOptions = {}) => {
		call++;
		const result = stream({
			context,
			signal: options.signal ?? new AbortController().signal,
			runId: `evaluation:model-run:${call}` as RunId,
			turnId: `evaluation:model-turn:${call}` as TurnId,
			attemptId: `evaluation:model-attempt:${call}` as AttemptId,
		});
		if (result instanceof Promise) {
			throw new Error("Evaluation ModelStream must return its event stream synchronously");
		}
		return result;
	};
	return Object.freeze({
		streamSimple,
		completeSimple: (model, context, options) => streamSimple(model, context, options).result(),
	});
}

function agentEvent(value: unknown): AgentEvent | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value) || !("runId" in value)) return undefined;
	return value as AgentEvent;
}

async function waitForGraph(agent: CodingAgent, graphId: string, events: AgentEvent[]): Promise<WorkGraphResult> {
	for await (const observation of agent.observe({ capacity: 4_096 })) {
		if (observation.type === "work_item_event" && observation.graphId === graphId) {
			const event = agentEvent(observation.event);
			if (event) events.push(event);
		}
		if (observation.type === "work_graph_settled" && observation.result.graphId === graphId) {
			return observation.result;
		}
	}
	throw new Error(`Evaluation Work Graph closed before ${graphId} settled`);
}

export interface EvaluationWorkGraph {
	readonly events: readonly AgentEvent[];
	run(input: string): Promise<WorkGraphResult>;
	close(): Promise<void>;
}

export async function openEvaluationWorkGraph(options: {
	readonly id: string;
	readonly seed?: AgentSeed;
	readonly stream: ModelStream;
	readonly tools: readonly AgentTool[];
	readonly systemPrompt: string;
	readonly clock: Clock;
	readonly idGenerator: IdGenerator;
}): Promise<EvaluationWorkGraph> {
	const model = evaluationModel(`evaluation:${options.id}`);
	const skills = emptySkills();
	const mcp = emptyMcp();
	const session = new EvaluationSession(`eval-session:${options.id}`, options.seed);
	const events: AgentEvent[] = [];
	const promptSha256 = createHash("sha256").update(options.systemPrompt, "utf8").digest("hex");
	const workspaceExecution: OpenCodingAgentOptions["workspaceExecution"] = {
		reserve: async (request) => ({
			placement: {
				placementId: `evaluation:${request.graphId}:${request.itemId}`,
				root: `/evaluation/${options.id}`,
				baseIdentity: `evaluation:${options.id}`,
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
		tools: () => options.tools.map((tool) => ({ tool, effect: "unknown" as const })),
		bindTools: ({ contributions }) => contributions.map(({ tool }) => tool),
		quiesce: async () => undefined,
		capture: async () => undefined,
		publish: async () => ({ state: "not_required" }),
		release: async () => undefined,
		close: async () => undefined,
	};
	const agent = await openCodingAgent({
		workspaceExecution,
		sessions: {
			reserve: async () => ({
				session,
				commit: async () => undefined,
				rollback: () => session.close(),
				evidence: () => undefined,
			}),
		},
		models: evaluationModels(options.stream),
		resolveConfiguration: () => ({ model, reasoning: "off", authSnapshot: { auth: {} } }),
		clock: options.clock,
		idGenerator: options.idGenerator,
		processMaximumConcurrency: 1,
		platform: "linux",
		interactionMode: "evaluation",
		skills: { initial: skills, current: () => skills, refresh: async () => skills },
		mcp: { current: () => mcp },
		systemPrompt: {
			version: "evaluation-system-prompt-v1",
			sha256: promptSha256,
			text: options.systemPrompt,
		},
	});
	let used = false;
	return Object.freeze({
		get events() {
			return Object.freeze([...events]);
		},
		run: async (input: string) => {
			if (used) throw new Error("Evaluation Work Graph can run only once");
			used = true;
			const graphId = `evaluation:${options.id}`;
			const result = waitForGraph(agent, graphId, events);
			const receipt = await agent.submit({
				commands: [
					{
						type: "start_work_graph",
						graphId,
						objective: input,
						root: { itemId: "root", executionMode: "write" },
						maximumConcurrency: 1,
						configuration: { model: { provider: "evaluation", id: model.id }, reasoning: "off" },
						session: { type: "resume", sessionId: session.id },
					},
				],
			});
			if (receipt.status === "rejected") throw new Error(receipt.rejection.message);
			return result;
		},
		close: async () => {
			await agent.close();
		},
	});
}
