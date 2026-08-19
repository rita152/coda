import { describe, expect, it } from "vitest";
import { isSessionRecordPayload } from "../src/session/session-schema.ts";

describe("Session message schema", () => {
	it("admits Session Titles only in the format that introduced them", () => {
		const payload = { title: "Readable session picker" };
		expect(isSessionRecordPayload("session_title_set", payload, 11)).toBe(true);
		expect(isSessionRecordPayload("session_title_set", payload, 10)).toBe(false);
		expect(isSessionRecordPayload("session_title_set", { title: "   " }, 11)).toBe(false);
	});

	it("admits Run Budget exhaustion only in the format that introduced it", () => {
		const payload = { exhaustion: { limit: "model_attempts", maximum: 3, observed: 4 } };
		expect(isSessionRecordPayload("run_budget_exhausted", payload, 10)).toBe(true);
		expect(isSessionRecordPayload("run_budget_exhausted", payload, 9)).toBe(false);
	});

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

	it("persists authoritative Tool observations in v8 while keeping v7 messages readable", () => {
		const toolResult = {
			message: {
				id: "message:tool-result",
				message: {
					role: "toolResult",
					toolCallId: "call:1",
					toolName: "bash",
					content: [{ type: "text", text: "denied" }],
					isError: true,
					timestamp: 1,
				},
			},
		};

		expect(isSessionRecordPayload("message_committed", toolResult, 7)).toBe(true);
		const observed = structuredClone(toolResult);
		Object.assign(observed.message.message, {
			observation: { status: "error", truncated: false, facts: { exitCode: 1 } },
		});
		expect(isSessionRecordPayload("message_committed", observed, 8)).toBe(true);
		expect(isSessionRecordPayload("message_committed", observed, 7)).toBe(false);

		observed.message.message.isError = false;
		expect(isSessionRecordPayload("message_committed", observed, 8)).toBe(false);
	});

	it("persists discarded attempt usage only in v9", () => {
		const payload = {
			messageId: "message:attempt",
			attempt: 1,
			outcome: "error",
			discarded: true,
			usage: {
				input: 100,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 100,
				cost: { input: 0.2, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.2 },
			},
		};

		expect(isSessionRecordPayload("attempt_finished", payload, 9)).toBe(true);
		expect(isSessionRecordPayload("attempt_finished", payload, 8)).toBe(false);
	});

	it("persists budget failures and budget-rejected Tool Invocations", () => {
		const failure = {
			kind: "budget",
			message: "Run budget exhausted: turns (maximum 64, observed 64)",
			exhaustion: { limit: "turns", maximum: 64, observed: 64 },
		};
		expect(isSessionRecordPayload("run_finished", { outcome: "error", failure }, 9)).toBe(true);
		expect(
			isSessionRecordPayload(
				"run_finished",
				{ outcome: "error", failure: { ...failure, exhaustion: { ...failure.exhaustion, limit: "unknown" } } },
				9,
			),
		).toBe(false);

		expect(
			isSessionRecordPayload(
				"tool_finished",
				{
					invocation: {
						id: "invocation:budget",
						resultMessageId: "message:budget",
						providerToolCallId: "call:budget",
						toolName: "bash",
						arguments: {},
						sourceIndex: 0,
						replaySafety: "never",
					},
					outcome: "rejected",
					reason: "budget",
					resultMessageId: "message:budget",
				},
				9,
			),
		).toBe(true);

		expect(
			isSessionRecordPayload(
				"tool_finished",
				{
					invocation: {
						id: "invocation:reexecute",
						resultMessageId: "message:old",
						providerToolCallId: "call:reexecute",
						toolName: "read",
						arguments: { path: "a.txt" },
						sourceIndex: 0,
						replaySafety: "safe",
					},
					outcome: "interrupted",
					reason: "reexecuted_by_user",
					resultMessageId: "message:old",
				},
				11,
			),
		).toBe(true);
	});
});
