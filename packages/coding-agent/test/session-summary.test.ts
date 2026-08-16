import type { Api } from "@coda/ai";
import { describe, expect, it } from "vitest";
import type { SessionRecord, SessionRecordType } from "../src/session/records.ts";
import { summarizeSessionRecords } from "../src/session/session-summary.ts";
import type { SessionDescriptor, SessionId } from "../src/session/types.ts";

describe("Session summary", () => {
	it.each([
		["openai-completions", "OpenAI Chat Completions"],
		["openai-responses", "OpenAI Responses"],
		["anthropic-messages", "Anthropic Messages"],
	] as const)("projects %s Assistant Messages without Provider-specific parsing", (api, _label) => {
		const summary = summarizeSessionRecords(descriptor(), [
			record(1, "composer_submission_recorded", {
				submission: { id: "submission:1", kind: "prompt", text: "  Improve\n the session picker  " },
			}),
			record(2, "message_committed", {
				message: {
					id: "message:user",
					message: { role: "user", content: "model-visible prompt", timestamp: 2_000 },
				},
			}),
			record(3, "message_committed", {
				message: {
					id: "message:assistant",
					message: assistant(api),
				},
			}),
		]);

		expect(summary).toMatchObject({
			title: "Improve the session picker",
			updatedAt: 3_000,
			promptCount: 1,
			model: { provider: "provider", id: "model", api },
		});
	});

	it("uses the latest selected model while retaining a matching observed protocol", () => {
		const summary = summarizeSessionRecords(descriptor(), [
			record(1, "message_committed", {
				message: { id: "message:assistant", message: assistant("openai-responses") },
			}),
			record(2, "model_selected", {
				model: { provider: "provider", id: "model" },
				reasoning: "medium",
			}),
		]);

		expect(summary.model).toEqual({ provider: "provider", id: "model", api: "openai-responses" });
	});
});

function descriptor(): SessionDescriptor {
	return {
		id: "session-test" as SessionId,
		workspace: { id: "workspace", path: "/workspace" },
		createdAt: 500,
		persistent: true,
		path: "/sessions/session-test.jsonl",
	};
}

function record<Type extends SessionRecordType>(sequence: number, type: Type, payload: unknown): SessionRecord {
	return {
		type,
		recordId: `record:${sequence}`,
		sessionId: "session-test",
		sequence,
		previousRecordId: sequence === 1 ? null : `record:${sequence - 1}`,
		timestamp: sequence * 1_000,
		payload,
	} as unknown as SessionRecord;
}

function assistant(api: Api) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "Done" }],
		api,
		provider: "provider",
		model: "model",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
		stopReason: "stop" as const,
		timestamp: 2_500,
	};
}
