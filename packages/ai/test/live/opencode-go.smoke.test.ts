import { beforeAll, describe, expect, test } from "vitest";

import { opencodeGoProvider } from "../../src/providers/opencode-go.ts";
import { testTimeRuntime } from "../time-runtime.ts";

const representatives = [
	["anthropic-messages", "minimax-m3"],
	["openai-completions", "hy3"],
	["openai-responses", "gpt-5.6-luna"],
] as const;

describe.sequential("OpenCode Go paid smoke tests", () => {
	let apiKey: string;

	beforeAll(() => {
		apiKey = process.env.OPENCODE_API_KEY ?? "";
		if (!apiKey) throw new Error("OPENCODE_API_KEY is required for the opt-in live smoke suite");
	});

	test.each(representatives)("invokes the first representative for %s", async (api, modelId) => {
		const runtime = testTimeRuntime(1);
		const provider = opencodeGoProvider();
		const model = provider.getModels().find((candidate) => candidate.api === api && candidate.id === modelId);
		expect(model).toBeDefined();
		if (!model) throw new Error(`Missing representative model: ${modelId}`);

		const result = await provider
			.streamSimple(
				model,
				{
					messages: [{ role: "user", content: "Reply with exactly: coda-smoke", timestamp: runtime.clock.now() }],
				},
				{ runtime, apiKey, maxTokens: 64 },
			)
			.result();

		expect(result.stopReason).not.toBe("error");
		expect(result.stopReason).not.toBe("aborted");
		expect(result.content.length).toBeGreaterThan(0);
	});
});
