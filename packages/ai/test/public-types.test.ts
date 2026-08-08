import { describe, expect, expectTypeOf, test } from "vitest";

import {
	type Api,
	type AssistantMessage,
	type Context,
	type KnownApi,
	type Model,
	type Static,
	type Tool,
	Type,
	type Usage,
} from "../src/index.ts";

describe("selected public type closure", () => {
	test("keeps Api open while preserving the known wire protocols", () => {
		const customApi: Api = "local-wire-protocol";
		const knownApi: KnownApi = "anthropic-messages";

		expect(customApi).toBe("local-wire-protocol");
		expect(knownApi).toBe("anthropic-messages");
	});

	test("carries Model, Message, Usage, Context, and TypeBox Tool types together", () => {
		const parameters = Type.Object({ path: Type.String() });
		type Parameters = Static<typeof parameters>;
		const tool: Tool<typeof parameters> = { name: "read", description: "Read text", parameters };
		const usage: Usage = {
			input: 2,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
			reasoning: 1,
			totalTokens: 5,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const model: Model<"openai-responses"> = {
			id: "test-model",
			name: "Test Model",
			api: "openai-responses",
			provider: "opencode-go",
			baseUrl: "https://opencode.ai/zen/go/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 8_192,
			compat: { supportsStrictMode: true },
		};
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage,
			stopReason: "stop",
			timestamp: 1,
		};
		const context: Context = { messages: [assistant], tools: [tool] };

		expectTypeOf<Parameters>().toEqualTypeOf<{ path: string }>();
		expect(context.messages).toHaveLength(1);
	});
});
