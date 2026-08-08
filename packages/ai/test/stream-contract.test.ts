import { describe, expect, test } from "vitest";
import { anthropicMessagesApi } from "../src/api/anthropic-messages.lazy.ts";
import * as anthropic from "../src/api/anthropic-messages.ts";
import { openAICompletionsApi } from "../src/api/openai-completions.lazy.ts";
import * as completions from "../src/api/openai-completions.ts";
import { openAIResponsesApi } from "../src/api/openai-responses.lazy.ts";
import * as responses from "../src/api/openai-responses.ts";
import type { Api, Model, ProviderStreams } from "../src/types.ts";
import { testTimeRuntime } from "./time-runtime.ts";

interface AdapterCase {
	api: "anthropic-messages" | "openai-completions" | "openai-responses";
	direct: ProviderStreams;
	lazy(): ProviderStreams;
}

const adapters: AdapterCase[] = [
	{
		api: "anthropic-messages",
		direct: anthropic as unknown as ProviderStreams,
		lazy: anthropicMessagesApi,
	},
	{
		api: "openai-completions",
		direct: completions as unknown as ProviderStreams,
		lazy: openAICompletionsApi,
	},
	{
		api: "openai-responses",
		direct: responses as unknown as ProviderStreams,
		lazy: openAIResponsesApi,
	},
];

function model(api: Api): Model<Api> {
	return {
		id: "contract-model",
		name: "Contract Model",
		api,
		provider: "opencode-go",
		baseUrl: "https://never-called.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000,
		maxTokens: 100,
	};
}

describe("public streaming invariants", () => {
	for (const adapter of adapters) {
		for (const [loading, streams] of [
			["direct", adapter.direct],
			["lazy", adapter.lazy()],
		] as const) {
			for (const method of ["stream", "streamSimple"] as const) {
				test(`${adapter.api} ${loading} ${method} turns missing auth into a terminal structured error`, async () => {
					const output = streams[method](model(adapter.api), { messages: [] }, { runtime: testTimeRuntime(321) });
					const events = [];
					for await (const event of output) events.push(event);
					const result = await output.result();

					expect(events.at(-1)?.type).toBe("error");
					expect(result).toMatchObject({
						stopReason: "error",
						timestamp: 321,
						diagnostics: [
							{
								error: { code: "auth" },
								details: {
									phase: "request",
									provider: "opencode-go",
									api: adapter.api,
									status: null,
									retryable: false,
								},
							},
						],
					});
				});

				test(`${adapter.api} ${loading} ${method} gives cancellation precedence before setup`, async () => {
					const controller = new AbortController();
					controller.abort("caller cancelled");
					let fetchCalls = 0;
					const output = streams[method](
						model(adapter.api),
						{ messages: [] },
						{
							apiKey: "unused",
							signal: controller.signal,
							runtime: testTimeRuntime(654),
							fetch: async () => {
								fetchCalls++;
								throw new Error("must not fetch");
							},
						},
					);
					const result = await output.result();

					expect(fetchCalls).toBe(0);
					expect(result).toMatchObject({ stopReason: "aborted", timestamp: 654 });
					expect(result.diagnostics).toBeUndefined();
					expect(result.errorMessage).toBeUndefined();
				});
			}
		}

		test(`${adapter.api} classifies cancellation after request establishment as aborted`, async () => {
			const controller = new AbortController();
			const output = adapter.direct.stream(
				model(adapter.api),
				{ messages: [] },
				{
					apiKey: "test-key",
					signal: controller.signal,
					runtime: testTimeRuntime(987),
					fetch: async () =>
						new Response("data: [DONE]\n\n", {
							status: 200,
							headers: { "content-type": "text/event-stream" },
						}),
					onResponse: () => controller.abort("caller cancelled"),
				},
			);
			const result = await output.result();

			expect(result).toMatchObject({ stopReason: "aborted", timestamp: 987 });
			expect(result.diagnostics).toBeUndefined();
			expect(result.errorMessage).toBeUndefined();
		});

		test(`${adapter.api} treats an SDK timeout as error when the caller signal remains active`, async () => {
			const output = adapter.direct.stream(
				model(adapter.api),
				{ messages: [] },
				{
					apiKey: "test-key",
					runtime: testTimeRuntime(741),
					fetch: async () => {
						throw new DOMException("Request timed out", "TimeoutError");
					},
				},
			);
			const result = await output.result();

			expect(result).toMatchObject({
				stopReason: "error",
				timestamp: 741,
				diagnostics: [{ details: { phase: "request" } }],
			});
		});
	}
});
