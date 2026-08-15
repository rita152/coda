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
import { type Api, createSystemScheduler, type Model } from "@coda/ai";
import type { ModelDriverLease, WorkGraphResult } from "@coda/runtime";
import { createHeadlessCodingAgent, createMemoryWorkSessionStore, waitForGraph } from "@coda/runtime/headless";

const EVALUATION_EVENT_TYPES = new Set<AgentEvent["type"]>([
	"run_start",
	"turn_start",
	"attempt_end",
	"message_end",
	"tool_execution_rejected",
	"tool_execution_end",
	"run_end",
]);

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
	const sessionId = `eval-session:${options.id}`;
	const sessions = createMemoryWorkSessionStore([{ id: sessionId, ...(options.seed ? { seed: options.seed } : {}) }]);
	const promptSha256 = createHash("sha256").update(options.systemPrompt, "utf8").digest("hex");
	let modelCall = 0;
	const modelProvider = {
		resolve: () => ({ model, reasoning: "off" as const, authSnapshot: { auth: {} } }),
		lease: (selection: { readonly model: Model<Api> }) => {
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
	};
	const agent = await createHeadlessCodingAgent({
		sessions,
		workspace: {
			root: `/evaluation/${options.id}`,
			baseIdentity: `evaluation:${options.id}`,
			tools: options.tools,
		},
		modelProvider,
		capabilitySources: [],
		time: {
			clock: options.clock,
			random: { next: Math.random },
			scheduler: createSystemScheduler(),
			sleep: {
				wait: (delayMs, signal) =>
					new Promise<void>((resolve, reject) => {
						const timer = setTimeout(resolve, delayMs);
						signal?.addEventListener(
							"abort",
							() => {
								clearTimeout(timer);
								reject(signal.reason);
							},
							{ once: true },
						);
					}),
			},
		},
		identity: options.idGenerator,
		capacity: { processMaximumConcurrency: 1, graphMaximumConcurrency: 1 },
		platform: "linux",
		interactionMode: "evaluation",
		systemPrompt: {
			version: "evaluation-system-prompt-v1",
			sha256: promptSha256,
			text: options.systemPrompt,
		},
	});
	let used = false;
	return Object.freeze({
		get events() {
			return Object.freeze(
				(sessions.sessions.get(sessionId)?.events ?? []).filter((event) => EVALUATION_EVENT_TYPES.has(event.type)),
			);
		},
		run: async (input: string) => {
			if (used) throw new Error("Evaluation Work Graph can run only once");
			used = true;
			const graphId = `evaluation:${options.id}`;
			const result = waitForGraph(agent, graphId as Parameters<typeof waitForGraph>[1], {
				capacity: 64,
				closedMessage: () => `Evaluation Work Graph closed before ${graphId} settled`,
			});
			const receipt = await agent.submit({
				commands: [
					{
						type: "start_work_graph",
						graphId,
						objective: input,
						root: { itemId: "root", executionMode: "write" },
						maximumConcurrency: 1,
						configuration: { model: { provider: "evaluation", id: model.id }, reasoning: "off" },
						session: { type: "resume", sessionId },
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
