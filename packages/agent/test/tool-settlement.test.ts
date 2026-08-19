import { Type } from "@coda/ai";
import { describe, expect, it } from "vitest";
import { type AgentTool, settleToolInvocation, type ToolInvocation } from "../src/index.ts";
import { TestClock } from "./helpers.ts";

const pathSchema = Type.Object({ path: Type.String() }, { additionalProperties: false });

function invocation(overrides: Partial<ToolInvocation> = {}): ToolInvocation {
	return {
		id: "invocation:new" as ToolInvocation["id"],
		resultMessageId: "message:result" as ToolInvocation["resultMessageId"],
		providerToolCallId: "provider:call",
		toolName: "read",
		arguments: { path: "/workspace/a.txt" },
		sourceIndex: 0,
		replaySafety: "safe",
		...overrides,
	};
}

function readTool(execute: AgentTool<typeof pathSchema>["execute"]): AgentTool<typeof pathSchema> {
	return {
		name: "read",
		description: "read test Tool",
		parameters: pathSchema,
		replaySafety: "safe",
		execute,
	};
}

describe("settleToolInvocation", () => {
	it("looks up, validates, journals via beforeExecute, then executes", async () => {
		const clock = new TestClock();
		const order: string[] = [];
		const tool = readTool(({ path }, context) => {
			order.push(`execute:${path}`);
			expect(context.invocationId).toBe("invocation:new");
			expect(context.providerToolCallId).toBe("provider:call");
			return { content: path };
		});

		const settled = await settleToolInvocation({
			tools: [tool],
			invocation: invocation(),
			context: {
				signal: new AbortController().signal,
				runId: "run:recovery",
				turnId: "turn:recovery",
				clock,
			},
			beforeExecute: async () => {
				order.push("beforeExecute");
			},
		});

		expect(order).toEqual(["beforeExecute", "execute:/workspace/a.txt"]);
		expect(settled).toMatchObject({
			kind: "executed",
			settlement: "returned",
			outcome: "success",
			result: {
				id: "message:result",
				message: {
					role: "toolResult",
					toolCallId: "provider:call",
					toolName: "read",
					content: [{ type: "text", text: "/workspace/a.txt" }],
				},
			},
		});
	});

	it("rejects a missing Tool without calling beforeExecute or execute", async () => {
		let executed = false;
		const settled = await settleToolInvocation({
			tools: [],
			invocation: invocation({ toolName: "missing" }),
			context: {
				signal: new AbortController().signal,
				runId: "run:recovery",
				turnId: "turn:recovery",
				clock: new TestClock(),
			},
			beforeExecute: async () => {
				executed = true;
			},
		});

		expect(executed).toBe(false);
		expect(settled).toMatchObject({
			kind: "rejected",
			reason: "missing",
			result: {
				message: {
					role: "toolResult",
					toolCallId: "provider:call",
					toolName: "missing",
					observation: { status: "error", facts: { reason: "missing" } },
				},
			},
		});
	});

	it("rejects invalid arguments without executing", async () => {
		let executed = false;
		const tool = readTool(() => {
			executed = true;
			return { content: "nope" };
		});
		const settled = await settleToolInvocation({
			tools: [tool],
			invocation: invocation({ arguments: {} }),
			context: {
				signal: new AbortController().signal,
				runId: "run:recovery",
				turnId: "turn:recovery",
				clock: new TestClock(),
			},
		});

		expect(executed).toBe(false);
		expect(settled).toMatchObject({ kind: "rejected", reason: "invalid" });
	});

	it("settles abort after start as an executed aborted Tool", async () => {
		const controller = new AbortController();
		const tool = readTool((_arguments, context) => {
			controller.abort();
			context.signal.throwIfAborted();
			return { content: "should not return" };
		});
		const settled = await settleToolInvocation({
			tools: [tool],
			invocation: invocation(),
			context: {
				signal: controller.signal,
				runId: "run:recovery",
				turnId: "turn:recovery",
				clock: new TestClock(),
			},
		});

		expect(settled).toMatchObject({
			kind: "executed",
			settlement: "aborted",
			outcome: "aborted",
		});
	});

	it("maps a thrown Tool into a threw settlement without failing the caller", async () => {
		const tool = readTool(() => {
			throw new Error("disk failed");
		});
		const settled = await settleToolInvocation({
			tools: [tool],
			invocation: invocation(),
			context: {
				signal: new AbortController().signal,
				runId: "run:recovery",
				turnId: "turn:recovery",
				clock: new TestClock(),
			},
		});

		expect(settled.kind).toBe("executed");
		if (settled.kind !== "executed") return;
		expect(settled.settlement).toBe("threw");
		expect(settled.outcome).toBe("error");
		expect(settled.result.message.content).toEqual([{ type: "text", text: 'Tool "read" failed: disk failed' }]);
	});
});
