// Portions derived from Pi:
// /packages/ai/test/faux-provider.test.ts @ 958c13f25080b59d4b736193f972a8502a7a2f8b
// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
// See THIRD_PARTY_NOTICES.md.

import { describe, expect, test } from "vitest";

import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxThinking,
	fauxToolCall,
} from "../src/index.ts";
import { testTimeRuntime } from "./time-runtime.ts";

describe("Faux Provider (upstream: /packages/ai/test/faux-provider.test.ts)", () => {
	test("streams deterministic thinking, text, and Tool-call events", async () => {
		const runtime = testTimeRuntime(42);
		const faux = fauxProvider({ chunkCharacters: 4, runtime });
		const models = createModels({ runtime });
		models.setProvider(faux.provider);
		faux.setResponses([
			fauxAssistantMessage([fauxThinking("go"), fauxText("ok"), fauxToolCall("echo", {}, { id: "tool-1" })], {
				stopReason: "toolUse",
				timestamp: 42,
			}),
		]);

		const stream = models.streamSimple(faux.getModel(), { messages: [] });
		const eventTypes: string[] = [];
		for await (const event of stream) eventTypes.push(event.type);

		expect(eventTypes).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_end",
			"text_start",
			"text_delta",
			"text_end",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
			"done",
		]);
		await expect(stream.result()).resolves.toMatchObject({
			stopReason: "toolUse",
			content: [
				{ type: "thinking", thinking: "go" },
				{ type: "text", text: "ok" },
				{ type: "toolCall", id: "tool-1", name: "echo", arguments: {} },
			],
		});
		expect(faux.state.callCount).toBe(1);
	});

	test("attaches a structured Diagnostic to scripted errors", async () => {
		const runtime = testTimeRuntime(77);
		const faux = fauxProvider({ runtime });
		faux.setResponses([
			fauxAssistantMessage([], { stopReason: "error", errorMessage: "scripted failure", timestamp: 77 }),
		]);

		const result = await faux.provider.streamSimple(faux.getModel(), { messages: [] }, { runtime }).result();

		expect(result).toMatchObject({
			stopReason: "error",
			errorMessage: "scripted failure",
			diagnostics: [
				{
					timestamp: 77,
					details: { phase: "stream", provider: "faux", api: "faux", status: null, retryable: false },
				},
			],
		});
	});

	test("settles caller cancellation as aborted without an error Diagnostic", async () => {
		const runtime = testTimeRuntime(88);
		const faux = fauxProvider({ chunkCharacters: 2, runtime });
		faux.setResponses([fauxAssistantMessage("abcdefgh", { timestamp: 88 })]);
		const controller = new AbortController();
		const stream = faux.provider.streamSimple(
			faux.getModel(),
			{ messages: [] },
			{ runtime, signal: controller.signal },
		);

		for await (const event of stream) {
			if (event.type === "text_delta") controller.abort("user cancelled");
		}
		const result = await stream.result();

		expect(result.stopReason).toBe("aborted");
		expect(result.diagnostics).toBeUndefined();
		expect(result.errorMessage).toBeUndefined();
	});
});
