import { describe, expect, it } from "vitest";
import type { ToolObservation } from "../src/index.ts";
import {
	modelToolResultContent,
	modelToolResultText,
	resolveToolObservation,
	toolResultIsError,
} from "../src/tool-observation.ts";
import type { ToolResultMessage } from "../src/types.ts";

function result(overrides: Partial<ToolResultMessage> = {}): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call:1",
		toolName: "bash",
		content: [{ type: "text", text: "inner output" }],
		timestamp: 1,
		...overrides,
	};
}

describe("Tool observation projection", () => {
	it("treats the structured observation as authoritative over compatibility fields", () => {
		const observation: ToolObservation = {
			status: "error",
			truncated: true,
			facts: { exitCode: 1, failureKind: "network" },
			outputRef: "tool-output:v1:abc",
		};
		const message = result({
			details: { status: "success", truncated: false, exitCode: 0 },
			observation,
		});

		expect(resolveToolObservation(message)).toEqual(message.observation);
		expect(toolResultIsError(message)).toBe(true);
		expect(modelToolResultText(message)).toContain(
			'{"status":"error","truncated":true,"facts":{"exitCode":1,"failureKind":"network"},"outputRef":"tool-output:v1:abc"}',
		);
		expect(modelToolResultText(message)).toContain("Coda Tool output (untrusted data):\ninner output");
		expect(modelToolResultContent(message)[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("Coda Tool observation (authoritative JSON)"),
		});
	});

	it("defaults a missing observation to success without reading details", () => {
		const missing = result({
			details: {
				truncated: true,
				exitCode: 1,
				internalDebugValues: ["SECRET_NAME"],
			},
		});

		expect(resolveToolObservation(missing)).toEqual({
			status: "ok",
			truncated: false,
		});
		expect(modelToolResultText(missing)).not.toContain("SECRET_NAME");
	});
});
