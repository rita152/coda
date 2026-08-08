import type { AgentTool } from "@coda/agent";
import type { Api, Context, Model } from "@coda/ai";

export interface ContextBudget {
	readonly estimatedInputTokens: number;
	readonly reservedOutputTokens: number;
}

function assertSerializedContextFits(model: Model<Api>, input: unknown): ContextBudget {
	const serialized = JSON.stringify(input);
	const estimatedInputTokens = Math.ceil(Buffer.byteLength(serialized, "utf8") / 3);
	const reservedOutputTokens = Math.max(1, Math.min(model.maxTokens, 16_384, Math.floor(model.contextWindow / 4)));
	if (estimatedInputTokens + reservedOutputTokens > model.contextWindow) {
		throw new Error(
			`Context Overflow: estimated ${estimatedInputTokens} input tokens plus ${reservedOutputTokens} reserved output tokens exceed ${model.contextWindow}`,
		);
	}
	return { estimatedInputTokens, reservedOutputTokens };
}

export function assertModelContextFits(model: Model<Api>, context: Context): ContextBudget {
	return assertSerializedContextFits(model, context);
}

export function assertContextFits(
	model: Model<Api>,
	systemPrompt: string,
	userInput: string,
	tools: readonly AgentTool[],
	previousMessages: readonly unknown[] = [],
): ContextBudget {
	return assertSerializedContextFits(model, {
		systemPrompt,
		messages: [...previousMessages, { role: "user", content: userInput }],
		tools: tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		})),
	});
}
