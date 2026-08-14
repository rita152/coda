import type { AgentMessage, IdGenerator, IdKind, MessageId, ToolExecutionContext } from "@coda/agent";
import { createFauxCore, fauxAssistantMessage } from "@coda/ai";
import { describe, expect, it } from "vitest";
import { InMemorySessionManager } from "../src/session/memory-session-manager.ts";
import {
	SESSION_HISTORY_OUTPUT_LIMIT_BYTES,
	type SessionHistoryCursorError,
	SessionHistoryReader,
} from "../src/session/session-history-reader.ts";
import { createReadSessionHistoryTool } from "../src/tools/read-session-history.ts";
import { createTestAgent } from "./agent-runtime-adapter.ts";
import { testTimeRuntime } from "./time-runtime.ts";

describe("SessionHistoryReader", () => {
	it("keeps repeated backward pagination stable across later appends", () => {
		const messages = Array.from({ length: 6 }, (_, index) => user(index + 1));
		const reader = new SessionHistoryReader({ sessionId: "session:stable", messages: () => messages });

		const newest = reader.read({ limit: 2 });
		expect(newest.messages.map(({ id }) => id)).toEqual(["message:5", "message:6"]);
		expect(newest.hasMoreBefore).toBe(true);
		expect(reader.read({ limit: 2 })).toEqual(newest);

		messages.push(user(7));
		const older = reader.read({ cursor: newest.nextCursor, limit: 2 });
		expect(older.messages.map(({ id }) => id)).toEqual(["message:3", "message:4"]);
		expect(reader.read({ cursor: newest.nextCursor, limit: 2 })).toEqual(older);
		expect(reader.read({ limit: 2 }).messages.map(({ id }) => id)).toEqual(["message:6", "message:7"]);
		expect(reader.read({ cursor: older.nextCursor, limit: 2 })).toMatchObject({
			hasMoreBefore: false,
			messages: [{ id: "message:1" }, { id: "message:2" }],
		});
	});

	it("returns a bounded Message-only projection with authoritative Tool Observations", () => {
		const imageData = "image-secret:".repeat(20_000);
		const toolOutput = "tool-output:".repeat(20_000);
		const messages: AgentMessage[] = [
			{
				id: "message:user" as MessageId,
				message: {
					role: "user",
					content: [
						{ type: "text", text: "Keep the release branch read-only." },
						{ type: "skill", name: "private-skill", path: "/journal/private/SKILL.md" },
						{ type: "image", mimeType: "image/png", data: imageData },
					],
					timestamp: 10,
				},
			},
			{
				id: "message:assistant" as MessageId,
				message: {
					...fauxAssistantMessage(
						[
							{ type: "thinking", thinking: "private-reasoning", redacted: false },
							{
								type: "toolCall",
								id: "provider:call",
								name: "private_tool",
								arguments: { credential: "credential-secret", journalPath: "/journal/private/session.jsonl" },
							},
							{ type: "text", text: "I inspected the state." },
						],
						{ stopReason: "toolUse", timestamp: 11 },
					),
				},
			},
			{
				id: "message:tool" as MessageId,
				message: {
					role: "toolResult",
					toolCallId: "provider:call",
					toolName: "private_tool",
					content: [{ type: "text", text: toolOutput }],
					observation: {
						status: "error",
						truncated: true,
						facts: { code: "partial_read", totalLines: 80_000 },
						outputRef: "tool-output:v1:opaque",
					},
					details: {
						journalPath: "/journal/private/session.jsonl",
						unsupportedLegacyFact: "discarded",
						credential: "credential-secret",
					},
					isError: true,
					timestamp: 12,
				},
			},
		];
		const reader = new SessionHistoryReader({ sessionId: "session:private", messages: () => messages });

		const page = reader.read({ limit: 20 });
		const serialized = JSON.stringify(page);

		expect(page.messages.map(({ role }) => role)).toEqual(["user", "assistant", "toolResult"]);
		expect(page.messages[2]).toMatchObject({
			role: "toolResult",
			contentTruncated: true,
			observation: {
				status: "error",
				truncated: true,
				facts: { code: "partial_read", totalLines: 80_000 },
				outputRef: "tool-output:v1:opaque",
			},
		});
		expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(SESSION_HISTORY_OUTPUT_LIMIT_BYTES);
		expect(serialized).toContain("Keep the release branch read-only.");
		expect(serialized).not.toContain("/journal/private");
		expect(serialized).not.toContain("private-reasoning");
		expect(serialized).not.toContain("credential-secret");
		expect(serialized).not.toContain(imageData.slice(0, 100));
		expect(serialized).not.toContain("unsupportedLegacyFact");
	});

	it("returns the same committed history after Session resume", async () => {
		let id = 0;
		const idGenerator: IdGenerator = { generate: (kind: IdKind) => `${kind}:${++id}` };
		const manager = new InMemorySessionManager({ clock: { now: () => 1_000 }, idGenerator });
		const session = await manager.open({
			workspace: { id: "workspace", path: "/workspace" },
			mode: "interactive",
		});
		const runtime = testTimeRuntime(1_000);
		const faux = createFauxCore({ runtime });
		faux.setResponses([fauxAssistantMessage("constraint acknowledged", { timestamp: 1_000 })]);
		const agent = createTestAgent({
			clock: runtime.clock,
			idGenerator,
			tools: [],
			stream: ({ context, signal }) => faux.streamSimple(faux.getModel(), context, { runtime, signal }),
		});
		agent.onEvent((event) => session.accept(event));
		await agent.prompt("Never modify the generated lockfile.");
		const beforeResume = session.history.read({ limit: 20 });
		const sessionId = session.descriptor.id;
		await session.close();

		const resumed = await manager.open({
			workspace: { id: "workspace", path: "/workspace" },
			mode: "interactive",
			resumeId: sessionId,
		});
		expect(resumed.history.read({ limit: 20 })).toEqual(beforeResume);
		await resumed.close();
	});

	it("synthesizes bounded authoritative observations for legacy Tool Results", () => {
		const legacy: AgentMessage = {
			id: "message:legacy-tool" as MessageId,
			message: {
				role: "toolResult",
				toolCallId: "provider:legacy",
				toolName: "read",
				content: [{ type: "text", text: "partial legacy output" }],
				details: {
					code: "legacy_partial",
					truncated: true,
					outputRef: "tool-output:v1:legacy",
					internal: "not-an-observation-fact",
				},
				isError: true,
				timestamp: 13,
			},
		};
		const reader = new SessionHistoryReader({ sessionId: "session:legacy", messages: () => [legacy] });

		expect(reader.read().messages[0]).toMatchObject({
			role: "toolResult",
			observation: {
				status: "error",
				truncated: true,
				facts: { code: "legacy_partial" },
				outputRef: "tool-output:v1:legacy",
			},
		});
		expect(JSON.stringify(reader.read())).not.toContain("not-an-observation-fact");
	});

	it("fails malformed and stale cursors without returning transcript content", async () => {
		const first = new SessionHistoryReader({
			sessionId: "session:first",
			messages: () => [user(1), user(2), user(3)],
		});
		const cursor = first.read({ limit: 1 }).nextCursor!;
		const second = new SessionHistoryReader({
			sessionId: "session:second",
			messages: () => [user(1, "must-not-leak"), user(2), user(3)],
		});

		expect(() => first.read({ cursor: "not+an+opaque+cursor" })).toThrowError(
			expect.objectContaining<Partial<SessionHistoryCursorError>>({ code: "malformed_cursor" }),
		);
		expect(() => second.read({ cursor })).toThrowError(
			expect.objectContaining<Partial<SessionHistoryCursorError>>({ code: "stale_cursor" }),
		);

		const tool = createReadSessionHistoryTool(second);
		const malformed = await tool.execute({ cursor: "not+an+opaque+cursor" }, toolContext());
		const stale = await tool.execute({ cursor }, toolContext());
		expect(malformed).toMatchObject({
			content: "Session history cursor is malformed",
			observation: { status: "error", truncated: false, facts: { code: "malformed_cursor" } },
		});
		expect(stale).toMatchObject({
			content: "Session history cursor is stale or belongs to another Session",
			observation: { status: "error", truncated: false, facts: { code: "stale_cursor" } },
		});
		expect(JSON.stringify([malformed, stale])).not.toContain("must-not-leak");
	});
});

function user(index: number, content = `message ${index}`): AgentMessage {
	return {
		id: `message:${index}` as MessageId,
		message: { role: "user", content, timestamp: index },
	};
}

function toolContext(): ToolExecutionContext {
	return {
		signal: new AbortController().signal,
		runId: "run:history",
		turnId: "turn:history",
		invocationId: "invocation:history",
		resultMessageId: "message:history-result",
		providerToolCallId: "provider:history",
	} as unknown as ToolExecutionContext;
}
