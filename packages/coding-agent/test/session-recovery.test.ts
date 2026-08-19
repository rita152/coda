import type { AgentTool, ToolInvocation } from "@coda/agent";
import { Type } from "@coda/ai";
import { describe, expect, it } from "vitest";
import { reduceSession, type SessionRecord } from "../src/session/records.ts";
import { interruptedToolRecoveryChoices, SessionRecovery } from "../src/session/session-recovery.ts";
import type { SessionId, SessionWorkspace } from "../src/session/types.ts";

const workspace: SessionWorkspace = { id: "workspace-hash", path: "/canonical/workspace" };
const sessionId = "session-recovery" as SessionId;

const pathSchema = Type.Object({ path: Type.String() }, { additionalProperties: false });

function readTool(execute: AgentTool<typeof pathSchema>["execute"]): AgentTool<typeof pathSchema> {
	return {
		name: "read",
		description: "read test Tool",
		parameters: pathSchema,
		replaySafety: "safe",
		execute,
	};
}

function interruptedRecords(toolName: string, replaySafety: ToolInvocation["replaySafety"]): SessionRecord[] {
	const invocation: ToolInvocation = {
		id: "invocation:crashed" as ToolInvocation["id"],
		resultMessageId: "message:tool-result" as ToolInvocation["resultMessageId"],
		providerToolCallId: "provider:crashed",
		toolName,
		arguments: { path: "x.txt" },
		sourceIndex: 0,
		replaySafety,
	};
	const inputs = [
		{ type: "run_started" as const, runId: "run:crashed", payload: { source: "prompt" as const } },
		{
			type: "message_committed" as const,
			runId: "run:crashed",
			payload: {
				message: {
					id: "message:user",
					message: { role: "user" as const, content: "read it", timestamp: 1_270 },
				},
			},
		},
		{
			type: "message_committed" as const,
			runId: "run:crashed",
			turnId: "turn:crashed",
			payload: {
				message: {
					id: "message:assistant",
					message: {
						role: "assistant" as const,
						content: [
							{
								type: "toolCall" as const,
								id: "provider:crashed",
								name: toolName,
								arguments: { path: "x.txt" },
							},
						],
						api: "openai-responses",
						provider: "test",
						model: "test-model",
						stopReason: "toolUse" as const,
						timestamp: 1_270,
					},
				},
			},
		},
		{
			type: "tool_started" as const,
			runId: "run:crashed",
			turnId: "turn:crashed",
			payload: { invocation },
		},
	];
	let previousRecordId: string | null = null;
	return inputs.map((input, index) => {
		const record = {
			...input,
			recordId: `record:crash:${index + 1}`,
			sessionId,
			sequence: index + 1,
			previousRecordId,
			timestamp: 1_270,
		} as unknown as SessionRecord;
		previousRecordId = record.recordId;
		return record;
	});
}

async function recover(options: {
	readonly records: readonly SessionRecord[];
	readonly mode?: "interactive" | "print";
	readonly decision?: "cancel" | "skip" | "re-execute";
	readonly tools?: readonly AgentTool[];
	readonly appended?: SessionRecord[];
}) {
	let id = 0;
	const appended = options.appended ?? [];
	const recovery = new SessionRecovery({
		runtime: {
			clock: { now: () => 1_275 },
			idGenerator: { generate: (kind) => `${kind}:${++id}` },
		},
		interruptedToolRecovery: async () => options.decision ?? "skip",
		recoveryTools: options.tools ? async () => options.tools! : undefined,
	});
	return recovery.recover({
		records: options.records,
		sessionId,
		path: "/tmp/session.jsonl",
		mode: options.mode ?? "interactive",
		workspace,
		append: async (record) => {
			appended.push(record);
		},
	});
}

describe("SessionRecovery Interrupted Tool re-execute", () => {
	it("offers re-execute only for replaySafety safe", () => {
		expect(interruptedToolRecoveryChoices("never").map(({ id }) => id)).toEqual(["cancel", "skip"]);
		expect(interruptedToolRecoveryChoices(undefined).map(({ id }) => id)).toEqual(["cancel", "skip"]);
		expect(interruptedToolRecoveryChoices("safe").map(({ id }) => id)).toEqual(["cancel", "skip", "re-execute"]);
	});

	it("re-executes a safe Tool with a new invocation id after journaling start", async () => {
		const appended: SessionRecord[] = [];
		const order: string[] = [];
		const recovered = await recover({
			records: interruptedRecords("read", "safe"),
			decision: "re-execute",
			appended,
			tools: [
				readTool(({ path }) => {
					order.push("execute");
					expect(appended.map((record) => record.type)).toEqual(["tool_finished", "tool_started"]);
					expect(appended[0]).toMatchObject({
						type: "tool_finished",
						payload: {
							invocation: { id: "invocation:crashed" },
							outcome: "interrupted",
							reason: "reexecuted_by_user",
						},
					});
					expect(appended[1]).toMatchObject({
						type: "tool_started",
						payload: {
							invocation: {
								providerToolCallId: "provider:crashed",
								toolName: "read",
								arguments: { path: "x.txt" },
							},
						},
					});
					const started = appended[1]!;
					expect(started.type === "tool_started" && started.payload.invocation.id).not.toBe("invocation:crashed");
					return { content: `read:${path}` };
				}),
			],
		});

		expect(order).toEqual(["execute"]);
		const added = recovered.slice(4);
		expect(added.map((record) => record.type)).toEqual([
			"tool_finished",
			"tool_started",
			"tool_finished",
			"message_committed",
			"run_finished",
		]);
		expect(added[2]).toMatchObject({
			type: "tool_finished",
			payload: { settlement: "returned", outcome: "success" },
		});
		const newStarted = added[1]!;
		const newFinished = added[2]!;
		expect(newStarted.type === "tool_started" && newFinished.type === "tool_finished").toBe(true);
		if (newStarted.type !== "tool_started" || newFinished.type !== "tool_finished") return;
		expect(newStarted.payload.invocation.id).toBe(newFinished.payload.invocation.id);
		expect(newStarted.payload.invocation.id).not.toBe("invocation:crashed");
		expect(newStarted.payload.invocation.providerToolCallId).toBe("provider:crashed");
		expect(newStarted.payload.invocation.resultMessageId).not.toBe("message:tool-result");

		const reduced = reduceSession(recovered);
		expect(reduced.startedTools.size).toBe(0);
		expect(reduced.activeRuns.size).toBe(0);
		expect(reduced.seed.messages.map(({ message }) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(reduced.seed.messages.at(-1)?.message).toMatchObject({
			role: "toolResult",
			toolCallId: "provider:crashed",
			content: [{ type: "text", text: "read:x.txt" }],
		});
	});

	it("refuses re-execute for replaySafety never", async () => {
		await expect(
			recover({
				records: interruptedRecords("write", "never"),
				decision: "re-execute",
				tools: [readTool(() => ({ content: "should not run" }))],
			}),
		).rejects.toThrow(/safe/);
	});

	it("still skips an Interrupted Tool Invocation", async () => {
		const recovered = await recover({
			records: interruptedRecords("write", "never"),
			decision: "skip",
		});
		const reduced = reduceSession(recovered);
		expect(reduced.startedTools.size).toBe(0);
		expect(reduced.seed.messages.at(-1)?.message).toMatchObject({
			role: "toolResult",
			details: { interrupted: true, recovery: "skipped", sideEffects: "unknown" },
		});
	});

	it("settles a missing recovery Tool as a rejected result with the window closed", async () => {
		const recovered = await recover({
			records: interruptedRecords("read", "safe"),
			decision: "re-execute",
			tools: [],
		});
		const reduced = reduceSession(recovered);
		expect(reduced.startedTools.size).toBe(0);
		expect(reduced.seed.messages.at(-1)?.message).toMatchObject({
			role: "toolResult",
			toolCallId: "provider:crashed",
			observation: { facts: { reason: "missing" } },
		});
		expect(recovered.some((record) => record.type === "tool_started" && record.sequence > 4)).toBe(false);
	});

	it("fails closed in print mode", async () => {
		await expect(
			recover({
				records: interruptedRecords("read", "safe"),
				mode: "print",
				decision: "re-execute",
			}),
		).rejects.toThrow(/automatic replay is forbidden/);
	});
});
