import { describe, expect, it } from "vitest";
import { modelToolObservationPreamble } from "../src/tool-observation.ts";
import type { ToolResultMessage } from "../src/types.ts";
import { estimateContextTokens } from "../src/utils/estimate.ts";

describe("Context token estimation", () => {
	it("accounts for the model-visible Tool observation preamble", () => {
		const message: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call:1",
			toolName: "bash",
			content: [{ type: "text", text: "output" }],
			observation: { status: "error", truncated: false, facts: { exitCode: 7 } },
			timestamp: 1,
		};

		const estimate = estimateContextTokens({ messages: [message] });
		expect(estimate.tokens).toBe(
			Math.ceil("output".length / 4) + Math.ceil(modelToolObservationPreamble(message).length / 4),
		);
	});
});
