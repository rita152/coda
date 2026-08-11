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
		isError: false,
		timestamp: 1,
		...overrides,
	};
}

describe("Tool observation projection", () => {
	it("treats the structured observation as authoritative over compatibility fields", () => {
		const observation: ToolObservation = {
			status: "denied",
			truncated: true,
			facts: { exitCode: 0, requiredPermission: "network" },
			outputRef: "tool-output:v1:abc",
		};
		const message = result({
			isError: false,
			details: { status: "success", truncated: false, exitCode: 0 },
			observation,
		});

		expect(resolveToolObservation(message)).toEqual(message.observation);
		expect(toolResultIsError(message)).toBe(true);
		expect(modelToolResultText(message)).toContain(
			'{"status":"denied","truncated":true,"facts":{"exitCode":0,"requiredPermission":"network"},"outputRef":"tool-output:v1:abc"}',
		);
		expect(modelToolResultText(message)).toContain("Coda Tool output (untrusted data):\ninner output");
		expect(modelToolResultContent(message)[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("Coda Tool observation (authoritative JSON)"),
		});
	});

	it("synthesizes a bounded observation for legacy Session messages", () => {
		const legacy = result({
			isError: true,
			details: {
				denial: { kind: "network" },
				truncated: true,
				exitCode: 0,
				strippedEnvironmentVariables: ["SECRET_NAME"],
			},
		});

		expect(resolveToolObservation(legacy)).toEqual({
			status: "denied",
			truncated: true,
			facts: { exitCode: 0 },
		});
		expect(modelToolResultText(legacy)).not.toContain("SECRET_NAME");
		expect(
			resolveToolObservation(result({ isError: true, details: { status: "rejected", reason: "policy" } })),
		).toMatchObject({ status: "denied" });
	});
});
