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
import {
	type CodingAgentRuntime,
	type CodingRuntimeMcpSource,
	type CodingRuntimeSession,
	type CodingRuntimeSessionChange,
	createCodingSkillsSnapshot,
	openCodingAgentRuntime,
} from "@coda/runtime";

class EvaluationSession implements CodingRuntimeSession {
	readonly id: string;
	readonly seed?: AgentSeed;

	constructor(id: string, seed: AgentSeed | undefined) {
		this.id = id;
		this.seed = seed;
	}

	accept(_event: AgentEvent): void {}

	record(_change: CodingRuntimeSessionChange): Promise<void> {
		return Promise.resolve();
	}

	close(): Promise<void> {
		return Promise.resolve();
	}
}

function emptySkills() {
	return createCodingSkillsSnapshot({
		loader: Object.freeze({
			candidates: Object.freeze([]),
			diagnostics: Object.freeze([]),
			activate: async () => {
				throw new Error("Evaluation Runtime has no Skills");
			},
		}),
	});
}

function emptyMcp(): ReturnType<CodingRuntimeMcpSource["current"]> {
	return Object.freeze({
		revision: 0,
		servers: Object.freeze([]),
		tools: Object.freeze([]),
		callTool: async () => {
			throw new Error("Evaluation Runtime has no MCP Tools");
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

export function openEvaluationRuntime(options: {
	readonly id: string;
	readonly seed?: AgentSeed;
	readonly stream: ModelStream;
	readonly tools: readonly AgentTool[];
	readonly systemPrompt: string;
	readonly clock: Clock;
	readonly idGenerator: IdGenerator;
}): Promise<CodingAgentRuntime> {
	const model = evaluationModel(`evaluation:${options.id}`);
	const skills = emptySkills();
	const mcp = emptyMcp();
	const promptSha256 = createHash("sha256").update(options.systemPrompt, "utf8").digest("hex");
	return openCodingAgentRuntime({
		runtimeId: `eval:${options.id}`,
		session: new EvaluationSession(`eval-session:${options.id}`, options.seed),
		selection: { model, reasoning: "off", authSnapshot: { auth: {} } },
		models: evaluationModels(options.stream),
		clock: options.clock,
		idGenerator: options.idGenerator,
		autoDrainFollowUps: true,
		interactionMode: "print",
		workspaceRoot: `/evaluation/${options.id}`,
		platform: "linux",
		baseTools: options.tools,
		skills: { initial: skills, current: () => skills, refresh: async () => skills },
		mcp: { current: () => mcp },
		preparePrompt: () =>
			Object.freeze({
				version: "evaluation-system-prompt-v1",
				sha256: promptSha256,
				text: options.systemPrompt,
			}),
	});
}
