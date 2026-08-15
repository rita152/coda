import type { Model } from "@coda/ai";
import { describe, expect, it } from "vitest";
import { availableReasoningEfforts, effectiveReasoningEffort } from "../src/models/reasoning-effort.ts";

describe("reasoning effort capabilities", () => {
	it("exposes canonical defaults and explicit extended efforts", () => {
		const model = reasoningModel({ off: null, minimal: null, low: "low", high: "high", max: "max" });

		expect(availableReasoningEfforts(model)).toEqual(["low", "medium", "high", "max"]);
		expect(effectiveReasoningEffort(model, "off")).toBe("low");
		expect(effectiveReasoningEffort(model, "xhigh")).toBe("max");
	});

	it("offers only off for a model without reasoning", () => {
		const model = { ...reasoningModel(), reasoning: false };

		expect(availableReasoningEfforts(model)).toEqual(["off"]);
		expect(effectiveReasoningEffort(model, "high")).toBe("off");
	});
});

function reasoningModel(thinkingLevelMap?: Model["thinkingLevelMap"]): Model {
	return {
		id: "reasoning-model",
		name: "Reasoning Model",
		api: "openai-responses",
		provider: "test",
		baseUrl: "https://example.test/v1",
		reasoning: true,
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
}
