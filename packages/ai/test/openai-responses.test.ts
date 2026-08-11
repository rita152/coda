// Portions derived from Pi:
// /packages/ai/test/openai-responses-terminal-event.test.ts @ 958c13f25080b59d4b736193f972a8502a7a2f8b
// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
// See THIRD_PARTY_NOTICES.md.

import { Type } from "typebox";
import { describe, expect, test } from "vitest";

import { stream, streamSimple } from "../src/api/openai-responses.ts";
import type { AssistantMessageEvent, Context, FetchFunction, Model } from "../src/types.ts";
import { testTimeRuntime } from "./time-runtime.ts";

const model: Model<"openai-responses"> = {
	id: "gpt-5.6-luna",
	name: "GPT 5.6 Luna",
	api: "openai-responses",
	provider: "opencode-go",
	baseUrl: "https://unit.test/openai/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
	contextWindow: 100_000,
	maxTokens: 8_192,
	thinkingLevelMap: { off: "none", low: "low", high: "high" },
	headers: { "X-Model": "model" },
	compat: { sessionAffinityFormat: "openai-nosession" },
};

const context: Context = {
	systemPrompt: "You are Coda.",
	messages: [{ role: "user", content: "Inspect the file", timestamp: 1 }],
	tools: [{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) }],
};

function event(type: string, value: Record<string, unknown>): string {
	return `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
}

function responsesSse(): string {
	const response = {
		id: "resp_1",
		object: "response",
		created_at: 1,
		status: "completed",
		error: null,
		incomplete_details: null,
		instructions: null,
		max_output_tokens: 2_048,
		model: "gpt-5.6-luna",
		output: [],
		parallel_tool_calls: true,
		previous_response_id: null,
		reasoning: null,
		store: false,
		text: { format: { type: "text" } },
		tool_choice: "auto",
		tools: [],
		top_p: 1,
		truncation: "disabled",
		usage: {
			input_tokens: 3,
			input_tokens_details: { cached_tokens: 1 },
			output_tokens: 5,
			output_tokens_details: { reasoning_tokens: 0 },
			total_tokens: 8,
		},
	};
	const messageItem = {
		id: "message_1",
		type: "message",
		status: "completed",
		role: "assistant",
		content: [{ type: "output_text", text: "Checking", annotations: [], logprobs: [] }],
	};
	const toolItem = {
		id: "fc_1",
		type: "function_call",
		status: "completed",
		call_id: "provider_call_1",
		name: "read",
		arguments: '{"path":"README.md"}',
	};
	return [
		event("response.created", { sequence_number: 0, response: { ...response, status: "in_progress", usage: null } }),
		event("response.output_item.added", {
			sequence_number: 1,
			output_index: 0,
			item: { ...messageItem, status: "in_progress", content: [] },
		}),
		event("response.output_text.delta", {
			sequence_number: 2,
			output_index: 0,
			content_index: 0,
			item_id: "message_1",
			delta: "Checking",
			logprobs: [],
		}),
		event("response.output_item.done", { sequence_number: 3, output_index: 0, item: messageItem }),
		event("response.output_item.added", {
			sequence_number: 4,
			output_index: 1,
			item: { ...toolItem, status: "in_progress", arguments: "" },
		}),
		event("response.function_call_arguments.delta", {
			sequence_number: 5,
			output_index: 1,
			item_id: "fc_1",
			delta: '{"path":"README.md"}',
		}),
		event("response.function_call_arguments.done", {
			sequence_number: 6,
			output_index: 1,
			item_id: "fc_1",
			arguments: '{"path":"README.md"}',
		}),
		event("response.output_item.done", { sequence_number: 7, output_index: 1, item: toolItem }),
		event("response.completed", { sequence_number: 8, response }),
		"data: [DONE]\n\n",
	].join("");
}

// Additional upstream cases:
// /packages/ai/test/openai-responses-message-id.test.ts
// /packages/ai/test/openai-responses-reasoning-replay-e2e.test.ts
describe("openai-responses adapter (upstream: packages/ai/test/openai-responses-terminal-event.test.ts)", () => {
	test("projects authoritative Tool observations into function_call_output", async () => {
		let requestBody: Record<string, unknown> | undefined;
		const output = stream(
			model,
			{
				messages: [
					{
						role: "toolResult",
						toolCallId: "call:denied",
						toolName: "bash",
						content: [{ type: "text", text: "command returned zero" }],
						observation: { status: "denied", truncated: false, facts: { exitCode: 0 } },
						isError: false,
						timestamp: 1,
					},
				],
			},
			{
				runtime: testTimeRuntime(123),
				apiKey: "test-key",
				maxRetries: 0,
				fetch: async (input, init) => {
					requestBody = (await new Request(input, init).clone().json()) as Record<string, unknown>;
					return new Response(responsesSse(), { status: 200, headers: { "content-type": "text/event-stream" } });
				},
			},
		);
		await output.result();

		expect(requestBody).toMatchObject({
			input: [
				{
					type: "function_call_output",
					call_id: "call:denied",
					output: expect.stringContaining('{"status":"denied","truncated":false,"facts":{"exitCode":0}}'),
				},
			],
		});
	});

	test("streams output items and preserves the Pi provider tool-call identifier", async () => {
		let requestBody: Record<string, unknown> | undefined;
		const mockFetch: FetchFunction = async (input, init) => {
			const request = new Request(input, init);
			requestBody = (await request.clone().json()) as Record<string, unknown>;
			expect(request.url).toBe("https://unit.test/openai/v1/responses");
			expect(request.headers.get("authorization")).toBe("Bearer test-key");
			expect(request.headers.get("x-model")).toBe("model");
			expect(request.headers.get("x-stainless-retry-count")).toBe("0");
			expect(request.headers.get("x-client-request-id")).toBe("session-1");
			expect(request.headers.get("session_id")).toBeNull();
			return new Response(responsesSse(), {
				status: 200,
				headers: { "content-type": "text/event-stream", "x-request-id": "request_1" },
			});
		};

		const output = stream(model, context, {
			runtime: testTimeRuntime(123),
			apiKey: "test-key",
			fetch: mockFetch,
			maxRetries: 0,
			maxTokens: 2_048,
			reasoningEffort: "high",
			sessionId: "session-1",
		});
		const events: AssistantMessageEvent[] = [];
		for await (const streamEvent of output) events.push(streamEvent);
		const result = await output.result();

		expect(requestBody).toMatchObject({
			model: "gpt-5.6-luna",
			stream: true,
			instructions: "You are Coda.",
			max_output_tokens: 2_048,
			reasoning: { effort: "high", summary: "auto" },
			include: ["reasoning.encrypted_content"],
			input: [{ role: "user", content: [{ type: "input_text", text: "Inspect the file" }] }],
			tools: [{ type: "function", name: "read", description: "Read a file" }],
		});
		expect(events.map((streamEvent) => streamEvent.type)).toEqual([
			"start",
			"text_start",
			"text_delta",
			"text_end",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
			"done",
		]);
		expect(result).toMatchObject({
			responseId: "resp_1",
			stopReason: "toolUse",
			timestamp: 123,
			content: [
				{ type: "text", text: "Checking", textSignature: '{"v":1,"id":"message_1"}' },
				{
					type: "toolCall",
					id: "provider_call_1|fc_1",
					name: "read",
					arguments: { path: "README.md" },
				},
			],
			usage: { input: 2, cacheRead: 1, output: 5, totalTokens: 8 },
		});
		expect(result.responseModel).toBeUndefined();

		let replayPayload: Record<string, unknown> | undefined;
		const replayOutput = stream(
			model,
			{ messages: [result] },
			{
				runtime: testTimeRuntime(),
				apiKey: "test-key",
				onPayload: (payload) => {
					replayPayload = payload as Record<string, unknown>;
				},
				fetch: mockFetch,
			},
		);
		await replayOutput.result();
		expect(replayPayload?.input).toEqual([
			{
				type: "message",
				role: "assistant",
				status: "completed",
				id: "message_1",
				content: [{ type: "output_text", text: "Checking", annotations: [] }],
			},
			{
				type: "function_call",
				call_id: "provider_call_1",
				id: "fc_1",
				name: "read",
				arguments: '{"path":"README.md"}',
				status: "completed",
			},
		]);
	});

	test("maps incomplete, failed, and missing-terminal streams explicitly", async () => {
		const response = {
			id: "resp_terminal",
			model: "gpt-5.6-luna",
			status: "incomplete",
			incomplete_details: { reason: "max_output_tokens" },
			usage: null,
			output: [],
		};
		const incomplete = stream(
			model,
			{ messages: [] },
			{
				runtime: testTimeRuntime(),
				apiKey: "test-key",
				fetch: async () =>
					new Response(`${event("response.incomplete", { sequence_number: 1, response })}data: [DONE]\n\n`, {
						headers: { "content-type": "text/event-stream" },
					}),
			},
		);
		await expect(incomplete.result()).resolves.toMatchObject({ stopReason: "length" });

		const failed = stream(
			model,
			{ messages: [] },
			{
				runtime: testTimeRuntime(),
				apiKey: "test-key",
				fetch: async () =>
					new Response(
						`${event("response.failed", {
							sequence_number: 1,
							response: {
								...response,
								status: "failed",
								error: { code: "server_error", message: "Provider failed" },
							},
						})}data: [DONE]\n\n`,
						{ headers: { "content-type": "text/event-stream" } },
					),
			},
		);
		await expect(failed.result()).resolves.toMatchObject({
			stopReason: "error",
			errorMessage: "Provider failed",
			diagnostics: [{ error: { code: "server_error" }, details: { phase: "stream" } }],
		});

		const missingTerminal = stream(
			model,
			{ messages: [] },
			{
				runtime: testTimeRuntime(),
				apiKey: "test-key",
				fetch: async () => new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }),
			},
		);
		await expect(missingTerminal.result()).resolves.toMatchObject({
			stopReason: "error",
			errorMessage: "OpenAI Responses stream ended before a terminal response event",
		});
	});

	test("persists encrypted reasoning items and replays them without reinterpretation", async () => {
		const reasoningItem = {
			id: "rs_1",
			type: "reasoning",
			summary: [{ type: "summary_text", text: "plan" }],
			content: null,
			encrypted_content: "encrypted",
			status: null,
		};
		const response = {
			id: "resp_reasoning",
			model: "gpt-5.6-luna",
			status: "completed",
			incomplete_details: null,
			usage: null,
			output: [reasoningItem],
		};
		const sse = [
			event("response.created", { sequence_number: 0, response: { ...response, status: "in_progress" } }),
			event("response.output_item.added", {
				sequence_number: 1,
				output_index: 0,
				item: { ...reasoningItem, summary: [], encrypted_content: null },
			}),
			event("response.reasoning_summary_text.delta", {
				sequence_number: 2,
				output_index: 0,
				summary_index: 0,
				item_id: "rs_1",
				delta: "plan",
			}),
			event("response.output_item.done", { sequence_number: 3, output_index: 0, item: reasoningItem }),
			event("response.completed", { sequence_number: 4, response }),
			"data: [DONE]\n\n",
		].join("");
		const output = stream(
			model,
			{ messages: [] },
			{
				runtime: testTimeRuntime(),
				apiKey: "test-key",
				fetch: async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }),
			},
		);
		const result = await output.result();

		expect(result).toMatchObject({
			stopReason: "stop",
			content: [{ type: "thinking", thinking: "plan", thinkingSignature: JSON.stringify(reasoningItem) }],
		});
		let replayPayload: Record<string, unknown> | undefined;
		const replay = stream(
			model,
			{ messages: [result] },
			{
				runtime: testTimeRuntime(),
				apiKey: "test-key",
				onPayload: (payload) => {
					replayPayload = payload as Record<string, unknown>;
				},
				fetch: async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }),
			},
		);
		await replay.result();
		expect(replayPayload?.input).toEqual([reasoningItem]);
	});

	test("normalizes simple options and enforces the Responses minimum output budget", async () => {
		let simplePayload: Record<string, unknown> | undefined;
		const configuredModel: Model<"openai-responses"> = {
			...model,
			samplingParams: { top_p: 0.8, repetition_penalty: 1.1 },
		};
		const simpleOutput = streamSimple(
			configuredModel,
			{ messages: [] },
			{
				runtime: testTimeRuntime(),
				apiKey: "test-key",
				maxTokens: 1,
				samplingParams: { top_p: 0.9 },
				onPayload: (payload) => {
					simplePayload = payload as Record<string, unknown>;
				},
				fetch: async () => new Response(responsesSse(), { headers: { "content-type": "text/event-stream" } }),
			},
		);
		await simpleOutput.result();

		expect(simplePayload).toMatchObject({
			max_output_tokens: 16,
			reasoning: { effort: "none" },
			top_p: 0.9,
			repetition_penalty: 1.1,
		});
	});
});
