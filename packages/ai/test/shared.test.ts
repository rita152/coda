import { describe, expect, test } from "vitest";

import { calculateCost, createOutput } from "../src/api/shared.ts";
import type { Model } from "../src/types.ts";
import { testTimeRuntime } from "./time-runtime.ts";

const knownPriceModel: Model<"openai-completions"> = {
	id: "known-price",
	name: "Known Price",
	api: "openai-completions",
	provider: "test-provider",
	baseUrl: "https://unit.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
	contextWindow: 16_384,
	maxTokens: 4_096,
};

describe("shared adapter output accounting", () => {
	test("omits cost when the Model price is unknown", () => {
		const unknownPriceModel = { ...knownPriceModel, cost: undefined } as unknown as Model;
		const output = createOutput(unknownPriceModel, testTimeRuntime().clock);
		output.usage.input = 10;
		output.usage.output = 5;

		expect(output.usage.cost).toBeUndefined();
		expect(calculateCost(unknownPriceModel, output.usage)).toBeUndefined();
		expect(output.usage.cost).toBeUndefined();
	});

	test("continues calculating cost when the Model price is known", () => {
		const output = createOutput(knownPriceModel, testTimeRuntime().clock);
		output.usage.input = 10;
		output.usage.output = 5;

		const cost = calculateCost(knownPriceModel, output.usage);
		expect(cost?.input).toBeCloseTo(0.00001);
		expect(cost?.output).toBeCloseTo(0.00001);
		expect(cost?.cacheRead).toBe(0);
		expect(cost?.cacheWrite).toBe(0);
		expect(cost?.total).toBeCloseTo(0.00002);
	});
});
