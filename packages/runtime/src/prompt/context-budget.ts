import type { AgentInput, AgentTool, Immutable } from "@coda/agent";
import type { Api, Context, Model } from "@coda/ai";

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

function assertSerializedContextFits(model: Model<Api>, input: unknown, maxOutputTokens?: number): ContextBudget {
	let imageCount = 0;
	const serialized = JSON.stringify(input, (_key, value: unknown) => {
		if (
			typeof value === "object" &&
			value !== null &&
			(value as { type?: unknown }).type === "image" &&
			typeof (value as { data?: unknown }).data === "string"
		) {
			imageCount++;
			const image = value as { data: string; mimeType?: unknown };
			return {
				type: "image",
				mimeType: image.mimeType,
				bytes: decodedBase64Bytes(image.data),
			};
		}
		return value;
	});
	const estimatedInputTokens = Math.ceil(Buffer.byteLength(serialized, "utf8") / 3) + imageCount * 8_192;
	const reservedOutputTokens = reserveModelOutputTokens(model, maxOutputTokens);
	if (estimatedInputTokens + reservedOutputTokens > model.contextWindow) {
		throw new Error(
			`Context Overflow: estimated ${estimatedInputTokens} input tokens plus ${reservedOutputTokens} reserved output tokens exceed ${model.contextWindow}`,
		);
	}
	return { estimatedInputTokens, reservedOutputTokens };
}

function decodedBase64Bytes(value: string): number {
	const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
}

export function assertModelContextFits(model: Model<Api>, context: Context, maxOutputTokens?: number): ContextBudget {
	return assertSerializedContextFits(model, context, maxOutputTokens);
}

export function assertContextFits(
	model: Model<Api>,
	systemPrompt: string,
	userInput: Immutable<AgentInput>,
	tools: readonly AgentTool[],
	previousMessages: readonly unknown[] = [],
	maxOutputTokens?: number,
): ContextBudget {
	return assertSerializedContextFits(
		model,
		{
			systemPrompt,
			messages: [...previousMessages, { role: "user", content: userInput }],
			tools: tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			})),
		},
		maxOutputTokens,
	);
}
