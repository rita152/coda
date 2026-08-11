import type { AgentEvent, AgentMessage, AgentSeed, MessageId, ToolInvocationId } from "@coda/agent";
import type { AssistantMessage } from "@coda/ai";
import { describe, expect, it } from "vitest";
import { SemanticTimeline } from "../src/interactive/semantic-timeline.ts";
import type { SessionToolLifecycle } from "../src/session/types.ts";

describe("SemanticTimeline", () => {
	it("updates concurrent Tool Invocations in source order instead of completion order", () => {
		const timeline = new SemanticTimeline();
		timeline.accept(
			event({
				type: "message_end",
				turnId: "turn-1",
				attemptId: "attempt-1",
				message: assistant("assistant-1", [
					{ type: "toolCall", id: "provider-a", name: "read", arguments: { path: "a.ts" } },
					{ type: "toolCall", id: "provider-b", name: "read", arguments: { path: "b.ts" } },
				]),
			}),
		);

		timeline.accept(toolStart("tool-b", "provider-b", 1, "b.ts", 20));
		timeline.accept(toolStart("tool-a", "provider-a", 0, "a.ts", 21));
		expect(toolEntries(timeline).map((entry) => entry.invocation.id)).toEqual(["tool-a", "tool-b"]);

		timeline.accept(toolEnd("tool-b", "provider-b", 1, "b.ts", "success", 30));
		timeline.accept(toolEnd("tool-a", "provider-a", 0, "a.ts", "error", 40));
		const tools = toolEntries(timeline);
		expect(tools).toHaveLength(2);
		expect(tools.map((entry) => [entry.invocation.id, entry.state])).toEqual([
			["tool-a", "failed"],
			["tool-b", "success"],
		]);
	});

	it("projects live Tool progress and clears it when execution finishes", () => {
		const timeline = new SemanticTimeline();
		timeline.accept(
			event({
				type: "message_end",
				turnId: "turn-1",
				attemptId: "attempt-1",
				message: assistant("assistant-1", [{ type: "toolCall", id: "provider-a", name: "custom", arguments: {} }]),
			}),
		);
		const start = toolStart("tool-a", "provider-a", 0, "", 20);
		timeline.accept(start);
		timeline.accept(
			event({
				type: "tool_execution_progress",
				turnId: "turn-1",
				sequence: 21,
				invocation: start.invocation,
				progress: { progress: 3, total: 10, message: "Indexing" },
			}),
		);

		expect(toolEntries(timeline)[0]?.progress).toEqual({ progress: 3, total: 10, message: "Indexing" });

		timeline.accept(toolEnd("tool-a", "provider-a", 0, "", "success", 30));
		expect(toolEntries(timeline)[0]?.progress).toBeUndefined();
	});

	it("shows ordered streaming Thinking and Assistant blocks, then removes a discarded attempt", () => {
		const timeline = new SemanticTimeline();
		timeline.accept(
			event({
				type: "attempt_start",
				turnId: "turn-1",
				attemptId: "attempt-1",
				messageId: "message-1",
				attempt: 1,
			}),
		);
		timeline.accept(delta("thinking_delta", 0, "considering", 2));
		timeline.accept(delta("text_delta", 1, "draft answer", 3));

		expect(
			timeline.entries.map((entry) => [
				entry.kind,
				entry.kind === "tool" ? entry.state : entry.kind === "user_shell" ? entry.status : entry.text,
			]),
		).toEqual([
			["thinking", "considering"],
			["assistant", "draft answer"],
		]);

		timeline.accept(
			event({
				type: "attempt_end",
				turnId: "turn-1",
				attemptId: "attempt-1",
				messageId: "message-1",
				attempt: 1,
				outcome: "error",
				discarded: true,
				candidate: assistant("message-1", []),
			}),
		);
		expect(timeline.entries).toEqual([]);

		timeline.accept(
			event({
				type: "message_end",
				turnId: "turn-1",
				attemptId: "attempt-2",
				message: assistant("message-2", [
					{ type: "thinking", thinking: "final thought" },
					{ type: "text", text: "final answer" },
				]),
			}),
		);
		expect(timeline.entries.map((entry) => entry.kind)).toEqual(["thinking", "assistant"]);
	});

	it("hydrates committed history without exposing Tool Result messages as duplicate cards", () => {
		const seed: AgentSeed = {
			version: 1,
			pendingFollowUps: [],
			messages: [
				{
					id: "user-1" as MessageId,
					message: { role: "user", content: "inspect", timestamp: 1 },
				},
				assistant("assistant-1", [
					{ type: "thinking", thinking: "checking" },
					{ type: "toolCall", id: "provider-a", name: "read", arguments: { path: "a.ts" } },
				]),
				{
					id: "result-1" as MessageId,
					message: {
						role: "toolResult",
						toolCallId: "provider-a",
						toolName: "read",
						content: [{ type: "text", text: "contents" }],
						isError: false,
						timestamp: 3,
					},
				},
			],
		};
		const timeline = new SemanticTimeline(seed, [restoredTool("invocation-1", "provider-a", 1, "read", "success")]);

		expect(timeline.entries.map((entry) => entry.kind)).toEqual(["user", "thinking", "tool"]);
		const tool = toolEntries(timeline)[0];
		expect(tool?.state).toBe("success");
		expect(tool?.result?.message.content).toEqual([{ type: "text", text: "contents" }]);
	});

	it("hides explicit Skill context from the user-facing text while retaining the Agent message", () => {
		const content = [
			"BEGIN USER-SELECTED SKILL CONTEXT",
			'{"name":"code-review"}',
			"private Skill guidance",
			"END USER-SELECTED SKILL CONTEXT",
			"review this project",
		].join("\n");
		const timeline = new SemanticTimeline({
			version: 1,
			pendingFollowUps: [],
			messages: [
				{
					id: "user-skill" as MessageId,
					message: { role: "user", content, timestamp: 1 },
				},
			],
		});

		const [entry] = timeline.entries;
		expect(entry).toMatchObject({ kind: "user", text: "review this project" });
		if (entry?.kind !== "user") throw new Error("Expected a user timeline entry");
		expect(entry.message.content).toBe(content);
	});

	it("keeps a directly referenced Skill visible while hiding its injected body", () => {
		const context = [
			"BEGIN USER-SELECTED SKILL CONTEXT",
			'{"name":"grillme","path":"/workspace/.agents/skills/grillme/SKILL.md"}',
			"private Skill guidance",
			"END USER-SELECTED SKILL CONTEXT",
		].join("\n");
		const content = [
			{ type: "skill" as const, name: "grillme", path: "/workspace/.agents/skills/grillme/SKILL.md" },
			{ type: "text" as const, text: context },
			{ type: "text" as const, text: "review this project" },
		];
		const timeline = new SemanticTimeline({
			version: 1,
			pendingFollowUps: [],
			messages: [
				{
					id: "user-grillme" as MessageId,
					message: { role: "user", content, timestamp: 1 },
				},
			],
		});

		const [entry] = timeline.entries;
		expect(entry).toMatchObject({ kind: "user", text: "$grillme review this project" });
		if (entry?.kind !== "user") throw new Error("Expected a user timeline entry");
		expect(entry.message.content).toEqual(content);
	});

	it("does not fabricate a Coda Tool Invocation identity for provider-only restored calls", () => {
		const timeline = new SemanticTimeline({
			version: 1,
			pendingFollowUps: [],
			messages: [
				assistant("assistant-1", [
					{ type: "toolCall", id: "provider-only", name: "read", arguments: { path: "a.ts" } },
				]),
			],
		});

		expect(toolEntries(timeline)).toEqual([]);
	});

	it("restores Agent-owned Tool identities and terminal lifecycle states exactly", () => {
		const seed: AgentSeed = {
			version: 1,
			pendingFollowUps: [],
			messages: [
				assistant("assistant-restored", [
					{ type: "toolCall", id: "provider-denied", name: "write", arguments: { path: "a" } },
					{ type: "toolCall", id: "provider-aborted", name: "bash", arguments: { command: "x" } },
					{ type: "toolCall", id: "provider-skipped", name: "edit", arguments: { path: "b" } },
					{ type: "toolCall", id: "provider-interrupted", name: "write", arguments: { path: "c" } },
				]),
			],
		};
		const lifecycle = [
			restoredTool("invocation-denied", "provider-denied", 0, "write", "rejected", "policy"),
			restoredTool("invocation-aborted", "provider-aborted", 1, "bash", "aborted"),
			restoredTool("invocation-skipped", "provider-skipped", 2, "edit", "rejected", "not_started"),
			restoredTool("invocation-interrupted", "provider-interrupted", 3, "write", "interrupted"),
		];

		const timeline = new SemanticTimeline(seed, lifecycle);

		expect(toolEntries(timeline).map(({ invocation, state }) => [invocation.id, state])).toEqual([
			["invocation-denied", "denied"],
			["invocation-aborted", "aborted"],
			["invocation-skipped", "skipped"],
			["invocation-interrupted", "interrupted"],
		]);
	});

	it("restores process-only approval history as expired without restoring authority", () => {
		const seed: AgentSeed = {
			version: 1,
			pendingFollowUps: [],
			messages: [
				assistant("assistant-restored", [
					{ type: "toolCall", id: "provider-approved", name: "bash", arguments: { command: "npm test" } },
				]),
			],
		};
		const lifecycle: SessionToolLifecycle = {
			...restoredTool("invocation-approved", "provider-approved", 0, "bash", "success"),
			approval: {
				type: "approval_decision",
				invocationId: "invocation-approved",
				kind: "command",
				outcome: "approved-for-process",
				commandPrefix: ["npm", "test"],
			},
		};

		const timeline = new SemanticTimeline(seed, [lifecycle]);

		expect(toolEntries(timeline)[0]?.approval).toEqual({
			outcome: "approved-for-process",
			commandPrefix: ["npm", "test"],
			expired: true,
		});
	});

	it("preserves unchanged entry identities when a streaming tail advances", () => {
		const timeline = new SemanticTimeline({
			version: 1,
			pendingFollowUps: [],
			messages: [assistant("history", [{ type: "text", text: "stable history" }])],
		});
		timeline.accept(delta("text_delta", 0, "first", 2));
		const before = timeline.entries;

		timeline.accept(delta("text_delta", 0, " second", 3));
		const after = timeline.entries;

		expect(after[0]).toBe(before[0]);
		expect(after[1]).not.toBe(before[1]);
		expect(after[1]).toMatchObject({ kind: "assistant", text: "first second" });
	});
});

function restoredTool(
	id: string,
	providerToolCallId: string,
	sourceIndex: number,
	toolName: string,
	outcome: "success" | "error" | "aborted" | "interrupted" | "rejected",
	reason?: "policy" | "not_started",
): SessionToolLifecycle {
	return {
		invocation: {
			id: id as ToolInvocationId,
			resultMessageId: `result-${id}` as MessageId,
			providerToolCallId,
			toolName,
			arguments: {},
			sourceIndex,
		},
		turnId: "turn-restored",
		startedAt: 10 + sourceIndex,
		finishedAt: 20 + sourceIndex,
		outcome,
		...(reason ? { rejectionReason: reason } : {}),
	} as const;
}

function event(payload: Record<string, unknown>): AgentEvent {
	return {
		runId: "run-1",
		sequence: 1,
		timestamp: 1,
		...payload,
	} as unknown as AgentEvent;
}

function assistant(id: string, content: AssistantMessage["content"]): AgentMessage<AssistantMessage> {
	return {
		id: id as MessageId,
		message: {
			role: "assistant",
			content,
			api: "faux",
			provider: "faux",
			model: "faux",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		},
	};
}

function delta(
	type: "thinking_delta" | "text_delta",
	contentIndex: number,
	value: string,
	sequence: number,
): AgentEvent {
	return event({
		type: "message_update",
		turnId: "turn-1",
		attemptId: "attempt-1",
		messageId: "message-1",
		delta: { type, contentIndex, delta: value },
		sequence,
	});
}

function toolStart(
	id: string,
	providerId: string,
	sourceIndex: number,
	path: string,
	sequence: number,
): Extract<AgentEvent, { type: "tool_execution_start" }> {
	return event({
		type: "tool_execution_start",
		turnId: "turn-1",
		sequence,
		invocation: {
			id,
			resultMessageId: `result-${id}`,
			providerToolCallId: providerId,
			toolName: "read",
			arguments: { path },
			sourceIndex,
		},
	}) as Extract<AgentEvent, { type: "tool_execution_start" }>;
}

function toolEnd(
	id: string,
	providerId: string,
	sourceIndex: number,
	path: string,
	outcome: "success" | "error",
	sequence: number,
): AgentEvent {
	return event({
		type: "tool_execution_end",
		turnId: "turn-1",
		sequence,
		invocation: {
			id,
			resultMessageId: `result-${id}`,
			providerToolCallId: providerId,
			toolName: "read",
			arguments: { path },
			sourceIndex,
		},
		outcome,
		result: {
			id: `result-${id}`,
			message: {
				role: "toolResult",
				toolCallId: providerId,
				toolName: "read",
				content: [{ type: "text", text: `${path} output` }],
				isError: outcome === "error",
				timestamp: sequence,
			},
		},
	});
}

function toolEntries(timeline: SemanticTimeline) {
	return timeline.entries.filter((entry) => entry.kind === "tool");
}
