// Portions derived from Pi:
// /packages/ai/test/models-runtime.test.ts @ 958c13f25080b59d4b736193f972a8502a7a2f8b
// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
// See THIRD_PARTY_NOTICES.md.

import { describe, expect, test } from "vitest";
import type { Api, AssistantMessage, Model, ProviderStreams } from "../src/index.ts";
import { AssistantMessageEventStream, createProvider } from "../src/index.ts";
import { testTimeRuntime } from "./time-runtime.ts";

function model(api: Api): Model<Api> {
	return {
		id: `${api}-model`,
		name: `${api} model`,
		api,
		provider: "mixed",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10_000,
		maxTokens: 1_000,
	};
}

function streams(label: string): ProviderStreams {
	const respond = (requestModel: Model<Api>) => {
		const stream = new AssistantMessageEventStream();
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: label }],
			api: requestModel.api,
			provider: requestModel.provider,
			model: requestModel.id,
			usage: {
				input: 0,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		};
		stream.push({ type: "done", reason: "stop", message });
		return stream;
	};
	return { stream: respond, streamSimple: respond };
}

describe("createProvider (upstream: /packages/ai/test/models-runtime.test.ts)", () => {
	test("dispatches a mixed catalog by each Model's Api", async () => {
		const runtime = testTimeRuntime(1);
		const anthropic = model("anthropic-messages");
		const responses = model("openai-responses");
		const provider = createProvider({
			id: "mixed",
			auth: { apiKey: { name: "Ambient", resolve: async () => ({ auth: {} }) } },
			models: [anthropic, responses],
			api: {
				"anthropic-messages": streams("anthropic"),
				"openai-responses": streams("responses"),
			},
		});

		await expect(provider.streamSimple(anthropic, { messages: [] }, { runtime }).result()).resolves.toMatchObject({
			content: [{ type: "text", text: "anthropic" }],
		});
		await expect(provider.streamSimple(responses, { messages: [] }, { runtime }).result()).resolves.toMatchObject({
			content: [{ type: "text", text: "responses" }],
		});

		const unknown = model("unknown-wire-api");
		await expect(provider.streamSimple(unknown, { messages: [] }, { runtime }).result()).resolves.toMatchObject({
			stopReason: "error",
			diagnostics: [
				{
					error: { code: "stream" },
					details: { phase: "setup", provider: "mixed", api: "unknown-wire-api", retryable: false },
				},
			],
		});
	});
});
