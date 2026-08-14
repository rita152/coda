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
import type { Api, Model } from "@coda/ai";
import {
	type CodingAgent,
	createRunCapabilityHost,
	type ModelDriverLease,
	type OpenCodingAgentOptions,
	openCodingAgent,
	type WorkGraphResult,
} from "@coda/runtime";

type WorkerSession = Awaited<ReturnType<OpenCodingAgentOptions["sessions"]["reserve"]>>["session"];

class EvaluationSession implements WorkerSession {
	readonly id: string;
	readonly seed?: AgentSeed;
	readonly #events: AgentEvent[] = [];

	constructor(id: string, seed: AgentSeed | undefined) {
		this.id = id;
		this.seed = seed;
	}

	accept(event: AgentEvent): void {
		switch (event.type) {
			case "run_start":
			case "turn_start":
			case "attempt_end":
			case "message_end":
			case "tool_execution_rejected":
			case "tool_execution_end":
			case "run_end":
				this.#events.push(structuredClone(event));
				return;
			case "attempt_start":
			case "retry_scheduled":
			case "tool_execution_start":
			case "turn_end":
				return;
			case "message_start":
			case "message_update":
			case "tool_execution_progress":
			case "run_budget_exhausted":
				return;
		}
	}

	get events(): readonly AgentEvent[] {
		return Object.freeze(structuredClone(this.#events));
	}

	record(_change: Parameters<WorkerSession["record"]>[0]): Promise<void> {
		return Promise.resolve();
	}

	close(): Promise<void> {
		return Promise.resolve();
	}
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

async function waitForGraph(agent: CodingAgent, graphId: string): Promise<WorkGraphResult> {
	for (;;) {
		let resynchronize = false;
		for await (const observation of agent.observe({ capacity: 64 })) {
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
				throw new Error(`Evaluation Work Graph closed before ${graphId} settled`);
			}
		}
		if (!resynchronize) throw new Error(`Evaluation Work Graph closed before ${graphId} settled`);
	}
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
	const session = new EvaluationSession(`eval-session:${options.id}`, options.seed);
	const promptSha256 = createHash("sha256").update(options.systemPrompt, "utf8").digest("hex");
	let modelCall = 0;
	const runCapabilities = createRunCapabilityHost({
		model: {
			acquire: (selection) => {
				const stream: ModelDriverLease["stream"] = (context, streamOptions = {}) => {
					modelCall++;
					const result = options.stream({
						context,
						signal: streamOptions.signal ?? new AbortController().signal,
						runId: `evaluation:model-run:${modelCall}` as RunId,
						turnId: `evaluation:model-turn:${modelCall}` as TurnId,
						attemptId: `evaluation:model-attempt:${modelCall}` as AttemptId,
					});
					if (result instanceof Promise) {
						throw new Error("Evaluation ModelStream must return its event stream synchronously");
					}
					return result;
				};
				const driver: ModelDriverLease = {
					model: selection.model,
					revision: `evaluation:${options.id}`,
					stream,
					complete: (context, streamOptions) => stream(context, streamOptions).result(),
					dispose: () => undefined,
				};
				return Object.freeze(driver);
			},
		},
		contributors: [],
		now: options.clock.now,
		platform: "linux",
		interactionMode: "evaluation",
		systemPrompt: {
			version: "evaluation-system-prompt-v1",
			sha256: promptSha256,
			text: options.systemPrompt,
		},
	});
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
		runCapabilities,
		resolveConfiguration: () => ({ model, reasoning: "off", authSnapshot: { auth: {} } }),
		clock: options.clock,
		idGenerator: options.idGenerator,
		processMaximumConcurrency: 1,
		platform: "linux",
		interactionMode: "evaluation",
	});
	let used = false;
	return Object.freeze({
		get events() {
			return session.events;
		},
		run: async (input: string) => {
			if (used) throw new Error("Evaluation Work Graph can run only once");
			used = true;
			const graphId = `evaluation:${options.id}`;
			const result = waitForGraph(agent, graphId);
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
