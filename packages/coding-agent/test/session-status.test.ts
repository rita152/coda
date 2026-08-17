import type { AgentMessage, MessageId } from "@coda/agent";
import { fauxAssistantMessage } from "@coda/ai";
import { describe, expect, it } from "vitest";
import { reduceSession, type SessionRecordOf } from "../src/session/records.ts";
import { sessionCostSnapshot } from "../src/ui/session-status.ts";

describe("session status aggregation", () => {
	it("includes committed Messages, discarded attempts, and compaction calls", () => {
		const messages: AgentMessage[] = [
			assistant("assistant", 0.4),
			{
				id: "tool" as MessageId,
				message: {
					role: "toolResult",
					toolCallId: "call",
					toolName: "deferred",
					content: [{ type: "text", text: "done" }],
					usage: usage(0.1),
					timestamp: 0,
				},
			},
		];

		expect(sessionCostSnapshot(messages, 0.2, 0.3, true)).toEqual({ usd: 1 });
	});

	it("omits cost when any material price is unreported", () => {
		const missing = assistant("assistant", undefined);

		expect(sessionCostSnapshot([missing], 0, 0, true)).toBeUndefined();
		expect(sessionCostSnapshot([], undefined, 0, true)).toBeUndefined();
		expect(sessionCostSnapshot([], 0, undefined, true)).toBeUndefined();
		expect(sessionCostSnapshot([], 0, 0, false)).toBeUndefined();
	});

	it("restores discarded attempt cost from durable records", () => {
		const record: SessionRecordOf<"attempt_finished"> = {
			type: "attempt_finished",
			recordId: "record:1",
			sessionId: "session:1",
			sequence: 1,
			previousRecordId: null,
			timestamp: 0,
			payload: {
				messageId: "message:attempt",
				attempt: 1,
				outcome: "error",
				discarded: true,
				usage: usage(0.2),
			},
		};

		expect(reduceSession([record]).discardedModelCost).toBe(0.2);
		const withoutUsage: SessionRecordOf<"attempt_finished"> = {
			...record,
			payload: { ...record.payload, usage: undefined },
		};
		expect(reduceSession([withoutUsage]).discardedModelCost).toBeUndefined();
	});
});

function assistant(id: string, cost: number | undefined): AgentMessage<ReturnType<typeof fauxAssistantMessage>> {
	const message = fauxAssistantMessage("answer", { timestamp: 0 });
	message.usage = usage(cost);
	return { id: id as MessageId, message };
}

function usage(cost: number | undefined) {
	return {
		input: 100,
		output: 20,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 120,
		...(cost === undefined ? {} : { cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } }),
	};
}
