// Portions derived from Pi:
// /packages/ai/test/stream.test.ts @ 958c13f25080b59d4b736193f972a8502a7a2f8b
// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
// See THIRD_PARTY_NOTICES.md.

import { Type } from "typebox";
import { describe, expect, test } from "vitest";

import { convertMessages, stream, streamSimple } from "../src/api/openai-completions.ts";
import type { AssistantMessageEvent, Context, FetchFunction, Model } from "../src/types.ts";
import { testTimeRuntime } from "./time-runtime.ts";

const model: Model<"openai-completions"> = {
	id: "hy3",
	name: "HY 3",
	api: "openai-completions",
	provider: "opencode-go",
	baseUrl: "https://unit.test/openai/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
	contextWindow: 100_000,
	maxTokens: 8_192,
	thinkingLevelMap: { off: "none", low: "low", high: "high" },
	headers: { "X-Model": "model" },
	compat: {
		maxTokensField: "max_tokens",
		sendSessionAffinityHeaders: true,
		sessionAffinityFormat: "openai-nosession",
	},
};

const context: Context = {
	systemPrompt: "You are Coda.",
	messages: [{ role: "user", content: "Inspect the file", timestamp: 1 }],
	tools: [{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) }],
};

function completionsSse(): string {
	const chunks = [
		{
			id: "chatcmpl_1",
			object: "chat.completion.chunk",
			created: 1,
			model: "hy3",
			choices: [{ index: 0, delta: { role: "assistant", content: "Checking" }, finish_reason: null }],
		},
		{
			id: "chatcmpl_1",
			object: "chat.completion.chunk",
			created: 1,
			model: "hy3",
			choices: [
				{
					index: 0,
					delta: {
						tool_calls: [
							{
								index: 0,
								id: "provider_call_1",
								type: "function",
								function: { name: "read", arguments: '{"path":"README.md"}' },
							},
						],
					},
					finish_reason: null,
				},
			],
		},
		{
			id: "chatcmpl_1",
			object: "chat.completion.chunk",
			created: 1,
			model: "hy3",
			choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
		},
		{
			id: "chatcmpl_1",
			object: "chat.completion.chunk",
			created: 1,
			model: "hy3",
			choices: [],
			usage: {
				prompt_tokens: 3,
				completion_tokens: 5,
				total_tokens: 8,
				prompt_tokens_details: { cached_tokens: 1 },
			},
		},
	];
	return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}

function reasoningSse(): string {
	const chunks = [
		{
			id: "chatcmpl_reasoning",
			object: "chat.completion.chunk",
			created: 1,
			model: "kimi-k2.6",
			choices: [{ index: 0, delta: { reasoning_content: "plan" }, finish_reason: null }],
		},
		{
			id: "chatcmpl_reasoning",
			object: "chat.completion.chunk",
			created: 1,
			model: "kimi-k2.6",
			choices: [{ index: 0, delta: { content: "answer" }, finish_reason: null }],
		},
		{
			id: "chatcmpl_reasoning",
			object: "chat.completion.chunk",
			created: 1,
			model: "kimi-k2.6",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		},
	];
	return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}

// Additional upstream cases:
// /packages/ai/test/openai-completions-reasoning-details.test.ts
// /packages/ai/test/openai-completions-response-model.test.ts
describe("openai-completions adapter (upstream: packages/ai/test/stream.test.ts)", () => {
	test("keeps injected Skill context but omits the structured Skill reference from provider input", () => {
		const messages = convertMessages(model, {
			messages: [
				{
					role: "user",
					content: [
						{ type: "skill", name: "grillme", path: "/workspace/.agents/skills/grillme/SKILL.md" },
						{ type: "text", text: "<skill>private guidance</skill>" },
						{ type: "text", text: "review this project" },
					],
					timestamp: 1,
				},
			],
		});

		expect(messages).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: "<skill>private guidance</skill>" },
					{ type: "text", text: "review this project" },
				],
			},
		]);
	});

	test("streams text and tool calls through the pinned SDK using corrected compatibility fields", async () => {
		let requestBody: Record<string, unknown> | undefined;
		const mockFetch: FetchFunction = async (input, init) => {
			const request = new Request(input, init);
			requestBody = (await request.clone().json()) as Record<string, unknown>;
			expect(request.url).toBe("https://unit.test/openai/v1/chat/completions");
			expect(request.headers.get("authorization")).toBe("Bearer test-key");
			expect(request.headers.get("x-model")).toBe("model");
			expect(request.headers.get("x-stainless-retry-count")).toBe("0");
			expect(request.headers.get("x-client-request-id")).toBe("session-1");
			expect(request.headers.get("x-session-affinity")).toBe("session-1");
			expect(request.headers.get("session_id")).toBeNull();
			return new Response(completionsSse(), {
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
			sessionId: "session-1",
		});
		const events: AssistantMessageEvent[] = [];
		for await (const event of output) events.push(event);
		const result = await output.result();

		expect(requestBody).toMatchObject({
			model: "hy3",
			stream: true,
			max_tokens: 2_048,
			messages: [
				{ role: "system", content: "You are Coda." },
				{ role: "user", content: "Inspect the file" },
			],
			tools: [{ type: "function", function: { name: "read", description: "Read a file" } }],
			reasoning_effort: "none",
		});
		expect(requestBody).not.toHaveProperty("max_completion_tokens");
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
			responseId: "chatcmpl_1",
			stopReason: "toolUse",
			timestamp: 123,
			content: [
				{ type: "text", text: "Checking" },
				{ type: "toolCall", id: "provider_call_1", name: "read", arguments: { path: "README.md" } },
			],
			usage: { input: 2, cacheRead: 1, output: 5, totalTokens: 8 },
		});
		expect(result.responseModel).toBeUndefined();
	});

	test("records SDK error code, HTTP status, phase, and retryability without persisting a stack", async () => {
		const output = stream(
			model,
			{ messages: [] },
			{
				runtime: testTimeRuntime(456),
				apiKey: "test-key",
				fetch: async () =>
					new Response(
						JSON.stringify({
							error: { message: "Slow down", type: "rate_limit_error", code: "rate_limit_exceeded" },
						}),
						{ status: 429, headers: { "content-type": "application/json" } },
					),
			},
		);
		const result = await output.result();

		expect(result).toMatchObject({
			stopReason: "error",
			errorMessage: expect.stringContaining("Slow down"),
			diagnostics: [
				{
					timestamp: 456,
					error: { code: "rate_limit_exceeded" },
					details: {
						phase: "request",
						provider: "opencode-go",
						api: "openai-completions",
						status: 429,
						retryable: true,
					},
				},
			],
		});
		expect(result.diagnostics?.[0]?.error).not.toHaveProperty("stack");
	});

	test("normalizes provider context-limit failures to non-retryable context_overflow", async () => {
		const output = stream(
			model,
			{ messages: [] },
			{
				runtime: testTimeRuntime(457),
				apiKey: "test-key",
				fetch: async () =>
					new Response(
						JSON.stringify({
							error: {
								message: "Maximum context length exceeded",
								type: "invalid_request_error",
								code: "context_length_exceeded",
							},
						}),
						{ status: 400, headers: { "content-type": "application/json" } },
					),
			},
		);

		await expect(output.result()).resolves.toMatchObject({
			stopReason: "error",
			diagnostics: [
				{
					error: { code: "context_overflow" },
					details: { status: 400, retryable: false, providerCode: "context_length_exceeded" },
				},
			],
		});
	});

	test("applies Kimi and Qwen thinking controls and preserves reasoning for replay", async () => {
		const kimi: Model<"openai-completions"> = {
			...model,
			id: "kimi-k2.6",
			samplingParams: { top_p: 0.8, repetition_penalty: 1.1 },
			compat: {
				maxTokensField: "max_tokens",
				thinkingFormat: "deepseek",
				supportsReasoningEffort: false,
				supportsLongCacheRetention: false,
			},
		};
		let kimiPayload: Record<string, unknown> | undefined;
		const kimiOutput = streamSimple(
			kimi,
			{ messages: [] },
			{
				runtime: testTimeRuntime(),
				apiKey: "test-key",
				reasoning: "high",
				samplingParams: { top_p: 0.9 },
				onPayload: (payload) => {
					kimiPayload = payload as Record<string, unknown>;
				},
				fetch: async () =>
					new Response(reasoningSse(), { status: 200, headers: { "content-type": "text/event-stream" } }),
			},
		);
		const kimiResult = await kimiOutput.result();

		expect(kimiPayload).toMatchObject({
			thinking: { type: "enabled" },
			max_tokens: 8_192,
			top_p: 0.9,
			repetition_penalty: 1.1,
		});
		expect(kimiPayload).not.toHaveProperty("reasoning_effort");
		expect(kimiResult).toMatchObject({
			stopReason: "stop",
			content: [
				{ type: "thinking", thinking: "plan", thinkingSignature: "reasoning_content" },
				{ type: "text", text: "answer" },
			],
		});
		const replay = convertMessages(kimi, { messages: [kimiResult] }, kimi.compat);
		expect(replay[0]).toMatchObject({ role: "assistant", content: "answer", reasoning_content: "plan" });

		const qwen: Model<"openai-completions"> = {
			...model,
			id: "qwen3.6-plus",
			compat: { maxTokensField: "max_tokens", thinkingFormat: "qwen" },
		};
		let qwenPayload: Record<string, unknown> | undefined;
		const qwenOutput = streamSimple(
			qwen,
			{ messages: [] },
			{
				runtime: testTimeRuntime(),
				apiKey: "test-key",
				onPayload: (payload) => {
					qwenPayload = payload as Record<string, unknown>;
				},
				fetch: async () =>
					new Response(reasoningSse(), { status: 200, headers: { "content-type": "text/event-stream" } }),
			},
		);
		await qwenOutput.result();
		expect(qwenPayload).toMatchObject({ enable_thinking: false });
	});
});
