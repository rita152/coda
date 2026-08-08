// Portions derived from Pi:
// /packages/ai/test/context-estimate.test.ts @ 958c13f25080b59d4b736193f972a8502a7a2f8b
// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
// See THIRD_PARTY_NOTICES.md.

import { describe, expect, test } from "vitest";

import { buildBaseOptions } from "../src/api/simple-options.ts";
import type { AssistantMessage, Context, Model, Usage } from "../src/types.ts";
import { testTimeRuntime } from "./time-runtime.ts";

function usage(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(timestamp: number, totalTokens: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "kept" }],
		api: "openai-responses",
		provider: "opencode-go",
		model: "test-model",
		usage: usage(totalTokens),
		stopReason: "stop",
		timestamp,
	};
}

const model: Model<"openai-responses"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-responses",
	provider: "opencode-go",
	baseUrl: "https://unit.test/openai/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 8_000,
	samplingParams: { top_p: 0.8, repetition_penalty: 1.1 },
};

describe("simple stream option normalization (upstream: packages/ai/test/context-estimate.test.ts)", () => {
	test("clamps the output budget against context and merges model sampling defaults per key", () => {
		const context: Context = {
			systemPrompt: "system",
			messages: [
				{ role: "user", content: "summary", timestamp: 200 },
				assistant(100, 9_500),
				{ role: "user", content: "x".repeat(4_000), timestamp: 300 },
			],
		};

		expect(
			buildBaseOptions(model, context, { runtime: testTimeRuntime(), samplingParams: { top_p: 0.9 } }),
		).toMatchObject({
			maxTokens: 4_899,
			samplingParams: { top_p: 0.9, repetition_penalty: 1.1 },
		});
	});
});
