import { fauxProvider } from "@coda/ai";
import { describe, expect, it } from "vitest";
import { assertContextFits, assertModelContextFits } from "../src/prompt/context-budget.ts";
import { testTimeRuntime } from "./time-runtime.ts";

describe("multimodal context budgeting", () => {
	it("honors an explicit output-token reservation instead of the legacy 16k default", () => {
		const faux = fauxProvider({
			runtime: testTimeRuntime(),
			models: [{ id: "reasoner", contextWindow: 1_000_000, maxTokens: 384_000 }],
		});
		const model = faux.getModel();

		expect(assertModelContextFits(model, { messages: [] }).reservedOutputTokens).toBe(16_384);
		expect(assertModelContextFits(model, { messages: [] }, 32_768).reservedOutputTokens).toBe(32_768);
		expect(assertModelContextFits(model, { messages: [] }, 384_000).reservedOutputTokens).toBe(384_000);
		expect(assertModelContextFits(model, { messages: [] }, 500_000).reservedOutputTokens).toBe(384_000);
	});

	it("budgets image content by a conservative image allowance rather than base64 text length", () => {
		const faux = fauxProvider({
			runtime: testTimeRuntime(),
			models: [{ id: "vision", contextWindow: 20_000, maxTokens: 1_000 }],
		});
		const model = faux.getModel();
		const hugeBase64 = "a".repeat(1_000_000);

		expect(() =>
			assertContextFits(
				model,
				"system",
				[
					{ type: "text", text: "describe" },
					{ type: "image", data: hugeBase64, mimeType: "image/jpeg" },
				],
				[],
			),
		).not.toThrow();

		expect(() =>
			assertContextFits(
				model,
				"system",
				Array.from({ length: 3 }, () => ({ type: "image" as const, data: hugeBase64, mimeType: "image/jpeg" })),
				[],
			),
		).toThrow("Context Overflow");
	});
});
