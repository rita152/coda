// Portions derived from Pi:
// /packages/ai/test/anthropic-sse-parsing.test.ts @ 958c13f25080b59d4b736193f972a8502a7a2f8b
// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
// See THIRD_PARTY_NOTICES.md.

import { Type } from "typebox";
import { describe, expect, test } from "vitest";

import { stream, streamSimple } from "../src/api/anthropic-messages.ts";
import type { AssistantMessageEvent, Context, FetchFunction, Model } from "../src/types.ts";
import { testTimeRuntime } from "./time-runtime.ts";

const model: Model<"anthropic-messages"> = {
	id: "minimax-m3",
	name: "MiniMax M3",
	api: "anthropic-messages",
	provider: "opencode-go",
	baseUrl: "https://unit.test/anthropic",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
	contextWindow: 100_000,
	maxTokens: 8_192,
	headers: { "X-Model": "model" },
};

const context: Context = {
	systemPrompt: "You are Coda.",
	messages: [{ role: "user", content: "Inspect the file", timestamp: 1 }],
	tools: [{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) }],
};

function anthropicSse(): string {
	const events = [
		[
			"message_start",
			{
				type: "message_start",
				message: {
					id: "msg_1",
					type: "message",
					role: "assistant",
					content: [],
					model: "minimax-m3",
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 3, output_tokens: 0 },
				},
			},
		],
		["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
		[
			"content_block_delta",
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Checking" } },
		],
		["content_block_stop", { type: "content_block_stop", index: 0 }],
		[
			"content_block_start",
			{
				type: "content_block_start",
				index: 1,
				content_block: { type: "tool_use", id: "provider_call_1", name: "read", input: {} },
			},
		],
		[
			"content_block_delta",
			{
				type: "content_block_delta",
				index: 1,
				delta: { type: "input_json_delta", partial_json: '{"path":"README.md"}' },
			},
		],
		["content_block_stop", { type: "content_block_stop", index: 1 }],
		["ping", { type: "ping" }],
		[
			"message_delta",
			{
				type: "message_delta",
				delta: { stop_reason: "tool_use", stop_sequence: null },
				usage: { output_tokens: 5 },
			},
		],
		["message_stop", { type: "message_stop" }],
	] as const;
	return `${events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n`).join("\n")}\n`;
}

describe("anthropic-messages adapter (upstream: packages/ai/test/anthropic-sse-parsing.test.ts)", () => {
	test("projects authoritative Tool observations into Tool Result blocks", async () => {
		let requestBody: Record<string, unknown> | undefined;
		const output = stream(
			model,
			{
				messages: [
					{
						role: "toolResult",
						toolCallId: "call:error",
						toolName: "bash",
						content: [{ type: "text", text: "command returned zero" }],
						observation: { status: "error", truncated: false, facts: { exitCode: 0 } },
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
					return new Response(anthropicSse(), { status: 200, headers: { "content-type": "text/event-stream" } });
				},
			},
		);
		await output.result();

		expect(requestBody).toMatchObject({
			messages: [
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "call:error",
							is_error: true,
							content: [
								{
									type: "text",
									text: expect.stringContaining('{"status":"error","truncated":false,"facts":{"exitCode":0}}'),
								},
								{ type: "text", text: "command returned zero" },
							],
						},
					],
				},
			],
		});
	});

	test("streams text and tool calls through the pinned SDK with a Pi-compatible payload", async () => {
		let requestBody: Record<string, unknown> | undefined;
		const mockFetch: FetchFunction = async (input, init) => {
			const request = new Request(input, init);
			requestBody = (await request.clone().json()) as Record<string, unknown>;
			expect(request.url).toBe("https://unit.test/anthropic/v1/messages");
			expect(request.headers.get("x-api-key")).toBe("test-key");
			expect(request.headers.get("x-model")).toBe("model");
			return new Response(anthropicSse(), {
				status: 200,
				headers: { "content-type": "text/event-stream", "request-id": "request_1" },
			});
		};

		const output = stream(model, context, {
			runtime: testTimeRuntime(123),
			apiKey: "test-key",
			fetch: mockFetch,
			maxRetries: 0,
			samplingParams: { top_p: 0.25 },
		});
		const events: AssistantMessageEvent[] = [];
		for await (const event of output) events.push(event);
		const result = await output.result();

		expect(result.stopReason).toBe("toolUse");
		expect(requestBody).toMatchObject({
			model: "minimax-m3",
			stream: true,
			system: "You are Coda.",
			messages: [{ role: "user", content: "Inspect the file" }],
			tools: [{ name: "read", description: "Read a file" }],
		});
		expect(requestBody).not.toHaveProperty("top_p");
		expect(events.map((event) => event.type)).toEqual([
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
			responseId: "msg_1",
			stopReason: "toolUse",
			timestamp: 123,
			content: [
				{ type: "text", text: "Checking" },
				{ type: "toolCall", id: "provider_call_1", name: "read", arguments: { path: "README.md" } },
			],
			usage: { input: 3, output: 5, totalTokens: 8 },
		});
	});

	test("surfaces refusal stop details and ignores non-content protocol events", async () => {
		const sse = [
			`event: message_start\ndata: ${JSON.stringify({
				type: "message_start",
				message: {
					id: "msg_refusal",
					type: "message",
					role: "assistant",
					content: [],
					model: "minimax-m3",
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 1, output_tokens: 0 },
				},
			})}\n\n`,
			`event: ping\ndata: ${JSON.stringify({ type: "ping" })}\n\n`,
			`event: message_delta\ndata: ${JSON.stringify({
				type: "message_delta",
				delta: {
					stop_reason: "refusal",
					stop_sequence: null,
					stop_details: { type: "refusal", explanation: "Request is outside policy" },
				},
				usage: { output_tokens: 1 },
			})}\n\n`,
			`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
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

		await expect(output.result()).resolves.toMatchObject({
			stopReason: "error",
			errorMessage: "Request is outside policy",
			diagnostics: [{ details: { phase: "stream" } }],
		});
	});

	test("normalizes disabled and budget thinking without leaking incompatible temperature", async () => {
		let disabledPayload: Record<string, unknown> | undefined;
		let affinityHeader: string | null = null;
		const disabled = streamSimple(
			{ ...model, compat: { sendSessionAffinityHeaders: true } },
			{ messages: [] },
			{
				runtime: testTimeRuntime(),
				apiKey: "test-key",
				sessionId: "session-1",
				temperature: 0.25,
				onPayload: (payload) => {
					disabledPayload = payload as Record<string, unknown>;
				},
				fetch: async (input, init) => {
					const request = new Request(input, init);
					affinityHeader = request.headers.get("x-session-affinity");
					return new Response(anthropicSse(), { headers: { "content-type": "text/event-stream" } });
				},
			},
		);
		await disabled.result();
		expect(affinityHeader).toBe("session-1");
		expect(disabledPayload).toMatchObject({ thinking: { type: "disabled" }, temperature: 0.25 });

		let thinkingPayload: Record<string, unknown> | undefined;
		const thinking = stream(
			model,
			{ messages: [] },
			{
				runtime: testTimeRuntime(),
				apiKey: "test-key",
				thinkingEnabled: true,
				thinkingBudgetTokens: 2_048,
				temperature: 0.25,
				onPayload: (payload) => {
					thinkingPayload = payload as Record<string, unknown>;
				},
				fetch: async () => new Response(anthropicSse(), { headers: { "content-type": "text/event-stream" } }),
			},
		);
		await thinking.result();
		expect(thinkingPayload).toMatchObject({
			thinking: { type: "enabled", budget_tokens: 2_048, display: "summarized" },
		});
		expect(thinkingPayload).not.toHaveProperty("temperature");
	});

	test("maps simple reasoning selection to Messages thinking controls", async () => {
		let budgetPayload: Record<string, unknown> | undefined;
		const budgetOutput = streamSimple(
			model,
			{ messages: [] },
			{
				runtime: testTimeRuntime(),
				apiKey: "test-key",
				reasoning: "low",
				onPayload: (payload) => {
					budgetPayload = payload as Record<string, unknown>;
				},
				fetch: async () => new Response(anthropicSse(), { headers: { "content-type": "text/event-stream" } }),
			},
		);
		await budgetOutput.result();
		expect(budgetPayload).toMatchObject({ thinking: { type: "enabled", budget_tokens: 2_048 } });

		let adaptivePayload: Record<string, unknown> | undefined;
		const adaptiveOutput = streamSimple(
			{ ...model, compat: { forceAdaptiveThinking: true }, thinkingLevelMap: { high: "high" } },
			{ messages: [] },
			{
				runtime: testTimeRuntime(),
				apiKey: "test-key",
				reasoning: "high",
				onPayload: (payload) => {
					adaptivePayload = payload as Record<string, unknown>;
				},
				fetch: async () => new Response(anthropicSse(), { headers: { "content-type": "text/event-stream" } }),
			},
		);
		await adaptiveOutput.result();
		expect(adaptivePayload).toMatchObject({
			thinking: { type: "adaptive" },
			output_config: { effort: "high" },
		});
	});
});
