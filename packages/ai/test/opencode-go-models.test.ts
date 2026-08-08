import { describe, expect, test } from "vitest";

import { OPENCODE_GO_MODELS } from "../src/providers/opencode-go.models.ts";

describe("OpenCode Go model snapshot", () => {
	test("exposes every retained model and the frozen sentinel routes", () => {
		const models = Object.values(OPENCODE_GO_MODELS);

		expect(models).toHaveLength(18);
		expect(models.filter((model) => model.api === "anthropic-messages")).toHaveLength(4);
		expect(models.filter((model) => model.api === "openai-completions")).toHaveLength(12);
		expect(models.filter((model) => model.api === "openai-responses")).toHaveLength(2);

		expect(OPENCODE_GO_MODELS["minimax-m3"]?.api).toBe("anthropic-messages");
		expect(OPENCODE_GO_MODELS.hy3?.api).toBe("openai-completions");
		expect(OPENCODE_GO_MODELS["gpt-5.6-luna"]?.api).toBe("openai-responses");
		expect(OPENCODE_GO_MODELS["minimax-m2.7"]?.api).toBe("openai-completions");
		expect(OPENCODE_GO_MODELS["qwen3.6-plus"]?.compat).toMatchObject({
			thinkingFormat: "qwen",
		});
		expect(OPENCODE_GO_MODELS["kimi-k2.6"]?.compat).toMatchObject({
			thinkingFormat: "deepseek",
			supportsReasoningEffort: false,
			supportsLongCacheRetention: false,
		});
	});
});
