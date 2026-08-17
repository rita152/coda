import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage, type UserMessage } from "@coda/ai";
import { describe, expect, it } from "vitest";
import {
	Agent,
	AgentError,
	type AgentMessage,
	type AgentSeed,
	type MessageId,
	type QueueItemId,
} from "../src/index.ts";
import { baseOptions, response, TestClock } from "./helpers.ts";

function user(id: string, content: string): AgentMessage<UserMessage> {
	return {
		id: id as MessageId,
		message: { role: "user", content, timestamp: 1 },
	};
}

describe("Agent Seed", () => {
	it("loads a validated immutable idle transcript and pending Follow-up queue", async () => {
		const clock = new TestClock();
		const seed: AgentSeed = {
			version: 1,
			messages: [
				user("seed:message:1", "earlier prompt"),
				{
					id: "seed:message:2" as MessageId,
					message: fauxAssistantMessage("earlier answer", { timestamp: 2 }),
				},
			],
			pendingFollowUps: [{ id: "seed:queue:1" as QueueItemId, content: "restored follow-up" }],
		};
		const contexts: import("@coda/ai").Context[] = [];
		const agent = new Agent({
			...baseOptions([response("follow answer", clock)], { clock, contexts }),
			seed,
		});

		expect(agent.state.status).toBe("idle");
		expect(agent.state.messages).not.toBe(seed.messages);
		expect(agent.state.pendingFollowUps).not.toBe(seed.pendingFollowUps);
		expect(Object.isFrozen(agent.state.messages[0])).toBe(true);

		await expect(agent.prompt("new prompt")).rejects.toMatchObject({ code: "invalid_lifecycle" });
		await agent.resumeFollowUps();

		expect(contexts).toHaveLength(1);
		expect(contexts[0]?.messages.map(({ role }) => role)).toEqual(["user", "assistant", "user"]);
		expect(agent.state.pendingFollowUps).toEqual([]);
	});

	it("returns to automatic Follow-up draining after a restored queue is canceled", async () => {
		const clock = new TestClock();
		const restoredId = "seed:queue:canceled" as QueueItemId;
		const agent = new Agent({
			...baseOptions([response("fresh answer", clock), response("queued answer", clock)], { clock }),
			seed: { version: 1, messages: [], pendingFollowUps: [{ id: restoredId, content: "old" }] },
		});
		agent.cancelQueueItem(restoredId);
		agent.onSemanticEvent((event) => {
			if (event.type === "run_start" && event.source === "prompt") agent.followUp("queued during fresh run");
		});

		await agent.prompt("fresh");

		expect(agent.state.pendingFollowUps).toEqual([]);
		expect(
			agent.state.messages.some(
				({ message }) => message.role === "user" && message.content === "queued during fresh run",
			),
		).toBe(true);
	});

	it.each([
		["unknown version", { version: 2, messages: [], pendingFollowUps: [] }],
		[
			"persistence-unsafe identity",
			{
				version: 1,
				messages: [user("message\nforged", "unsafe")],
				pendingFollowUps: [],
			},
		],
		[
			"duplicate identity",
			{
				version: 1,
				messages: [user("duplicate", "one"), user("duplicate", "two")],
				pendingFollowUps: [],
			},
		],
		[
			"orphan Tool result",
			{
				version: 1,
				messages: [
					{
						id: "tool-result" as MessageId,
						message: {
							role: "toolResult",
							toolCallId: "missing-call",
							toolName: "read",
							content: [{ type: "text", text: "no source" }],
							timestamp: 1,
						} satisfies ToolResultMessage,
					},
				],
				pendingFollowUps: [],
			},
		],
		[
			"unresolved Tool invocation",
			{
				version: 1,
				messages: [
					user("prompt", "run"),
					{
						id: "assistant" as MessageId,
						message: fauxAssistantMessage([fauxToolCall("read", { path: "x" }, { id: "unresolved" })], {
							stopReason: "toolUse",
							timestamp: 3,
						}),
					},
				],
				pendingFollowUps: [],
			},
		],
	] as const)("rejects an invalid Seed with %s", (_name, invalidSeed) => {
		expect(() => new Agent({ ...baseOptions([]), seed: invalidSeed as unknown as AgentSeed })).toThrowError(
			AgentError,
		);
		try {
			new Agent({ ...baseOptions([]), seed: invalidSeed as unknown as AgentSeed });
		} catch (error) {
			expect(error).toMatchObject({ code: "invalid_seed" });
		}
	});
});
