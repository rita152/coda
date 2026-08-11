import { describe, expect, it } from "vitest";
import { isSessionRecordPayload } from "../src/session/v1-schema.ts";

describe("Session message schema", () => {
	it("accepts structured Skill references alongside injected context", () => {
		expect(
			isSessionRecordPayload(
				"message_committed",
				{
					message: {
						id: "message:user-skill",
						message: {
							role: "user",
							content: [
								{ type: "skill", name: "grillme", path: "/workspace/.agents/skills/grillme/SKILL.md" },
								{ type: "text", text: "BEGIN USER-SELECTED SKILL CONTEXT\nprivate guidance" },
								{ type: "text", text: "review this project" },
							],
							timestamp: 1,
						},
					},
				},
				6,
			),
		).toBe(true);
	});

	it("accepts assistant usage without fabricated cost data", () => {
		expect(
			isSessionRecordPayload(
				"message_committed",
				{
					message: {
						id: "message:unknown-price",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "done" }],
							api: "openai-responses",
							provider: "custom-acme",
							model: "model-a",
							usage: {
								input: 10,
								output: 5,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 15,
							},
							stopReason: "stop",
							timestamp: 1,
						},
					},
				},
				6,
			),
		).toBe(true);
	});
});
