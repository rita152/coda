import type { Api, Model, ModelThinkingLevel } from "@coda/ai";

export const REASONING_EFFORTS: readonly ModelThinkingLevel[] = Object.freeze([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

export function availableReasoningEfforts(model: Model<Api>): readonly ModelThinkingLevel[] {
	if (!model.reasoning) return Object.freeze(["off"]);
	return Object.freeze(
		REASONING_EFFORTS.filter((effort) => {
			const mapping = model.thinkingLevelMap?.[effort];
			if (mapping === null) return false;
			return effort !== "xhigh" && effort !== "max" ? true : mapping !== undefined;
		}),
	);
}

export function effectiveReasoningEffort(model: Model<Api>, requested: ModelThinkingLevel): ModelThinkingLevel {
	const available = availableReasoningEfforts(model);
	if (available.includes(requested)) return requested;
	const requestedIndex = REASONING_EFFORTS.indexOf(requested);
	return (
		available.find((candidate) => REASONING_EFFORTS.indexOf(candidate) > requestedIndex) ??
		[...available].reverse().find((candidate) => REASONING_EFFORTS.indexOf(candidate) < requestedIndex) ??
		"off"
	);
}
