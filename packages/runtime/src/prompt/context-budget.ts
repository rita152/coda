import type { AgentInput, AgentTool, Immutable } from "@coda/agent";
import { type Api, type Context, estimateContextTokens, type Model } from "@coda/ai";

export interface ContextBudget {
	readonly estimatedInputTokens: number;
	readonly reservedOutputTokens: number;
}

const DEFAULT_OUTPUT_TOKEN_RESERVATION = 16_384;

export function reserveModelOutputTokens(model: Model<Api>, requested?: number): number {
	const limit = requested ?? DEFAULT_OUTPUT_TOKEN_RESERVATION;
	if (!Number.isSafeInteger(limit) || limit < 1) {
		throw new Error("maxOutputTokens must be a positive safe integer");
	}
	const contextReservationLimit = requested === undefined ? Math.floor(model.contextWindow / 4) : model.contextWindow;
	return Math.max(1, Math.min(model.maxTokens, limit, contextReservationLimit));
}

export function assertModelContextFits(model: Model<Api>, context: Context, maxOutputTokens?: number): ContextBudget {
	const estimatedInputTokens = estimateContextTokens(context).tokens;
	const reservedOutputTokens = reserveModelOutputTokens(model, maxOutputTokens);
	if (estimatedInputTokens + reservedOutputTokens > model.contextWindow) {
		throw new Error(
			`Context Overflow: estimated ${estimatedInputTokens} input tokens plus ${reservedOutputTokens} reserved output tokens exceed ${model.contextWindow}`,
		);
	}
	return { estimatedInputTokens, reservedOutputTokens };
}

export function assertContextFits(
	model: Model<Api>,
	systemPrompt: string,
	userInput: Immutable<AgentInput>,
	tools: readonly AgentTool[],
	previousMessages: Context["messages"] = [],
	maxOutputTokens?: number,
): ContextBudget {
	return assertModelContextFits(
		model,
		{
			systemPrompt,
			messages: [
				...previousMessages,
				{ role: "user", content: structuredClone(userInput) as AgentInput, timestamp: 0 },
			],
			tools: [...tools],
		},
		maxOutputTokens,
	);
}
