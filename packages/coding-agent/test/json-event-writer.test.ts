import type { AgentEvent } from "@coda/agent";
import { describe, expect, it } from "vitest";
import {
	JSON_AGENT_EVENT_SCHEMA_VERSION,
	JsonEventWriter,
	type JsonRunStartMetadata,
	SEMANTIC_JSON_EVENT_STREAM_SCHEMA_VERSION,
} from "../src/app/json-event-writer.ts";

const RUN_START_METADATA: JsonRunStartMetadata = {
	model: { provider: "fixture", id: "model" },
	reasoning: "high",
	prompt: { version: "fixture-prompt-v1", sha256: "prompt-sha256" },
};

const TOOL_CALL = {
	type: "toolCall",
	id: "provider-call-1",
	name: "read",
	arguments: { path: "src/index.ts" },
} as const;

function event(value: Record<string, unknown>): AgentEvent {
	return value as unknown as AgentEvent;
}

function candidate(id: string, content: readonly unknown[], stopReason: string) {
	return {
		id,
		message: {
			role: "assistant",
			content,
			api: "fixture",
			provider: "fixture",
			model: "model",
			usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11 },
			stopReason,
			timestamp: 5,
		},
	};
}

class BufferOutput {
	readonly chunks: string[] = [];
	bytes = 0;

	write(chunk: string): void {
		this.chunks.push(chunk);
		this.bytes += Buffer.byteLength(chunk);
	}
}

describe("JsonEventWriter", () => {
	it("preserves the raw v2 event bytes and emits transient diagnostics", async () => {
		const output = new BufferOutput();
		const writer = new JsonEventWriter({ mode: "raw", output });
		const delta = event({
			type: "message_update",
			runId: "run-1",
			sequence: 4,
			timestamp: 14,
			turnId: "turn-1",
			attemptId: "attempt-1",
			messageId: "message-1",
			delta: { type: "text_delta", contentIndex: 0, delta: "token" },
		});

		await expect(writer.writeAgentEvent(delta)).resolves.toBe(true);
		expect(output.chunks).toEqual([
			'{"schemaVersion":2,"type":"message_update","runId":"run-1","sequence":4,"timestamp":14,"turnId":"turn-1","attemptId":"attempt-1","messageId":"message-1","delta":{"type":"text_delta","contentIndex":0,"delta":"token"}}\n',
		]);
	});

	it("keeps semantic output proportional to Attempts and Tool Invocations across 100,000 deltas", async () => {
		const baseline = await semanticFixture(0);
		const stressed = await semanticFixture(100_000);

		expect(SEMANTIC_JSON_EVENT_STREAM_SCHEMA_VERSION).toBe(1);
		expect(stressed.types).toEqual([
			"run_start",
			"turn_start",
			"attempt_start",
			"message_start",
			"attempt_end",
			"message_end",
			"tool_execution_start",
			"tool_execution_end",
			"tool_execution_rejected",
			"turn_end",
			"turn_start",
			"attempt_start",
			"message_start",
			"attempt_end",
			"message_end",
			"turn_end",
			"run_end",
			"run_evidence",
		]);
		expect(stressed.types).not.toContain("message_update");
		expect(stressed.types).not.toContain("tool_execution_progress");
		expect(stressed.lines).toHaveLength(baseline.lines.length);
		expect(stressed.projectedRecords).toBe(baseline.projectedRecords);
		expect(stressed.projectedRecords).toBe(stressed.lines.length - 1);
		expect(stressed.bytes - baseline.bytes).toBeLessThan(256);
		expect(stressed.bytes).toBeLessThan(16_384);
		expect(stressed.agentSchemaVersions).toEqual([JSON_AGENT_EVENT_SCHEMA_VERSION]);
		expect(stressed.evidenceSchemaVersions).toEqual([1]);
		expect(stressed.finalText).toBe("final answer");
		expect(stressed.toolCalls).toEqual([TOOL_CALL]);
		expect(stressed.lines.find((line) => line.type === "tool_execution_end")).toMatchObject({
			settlement: "returned",
			outcome: "success",
		});
		expect(stressed.lines.find((line) => line.type === "tool_execution_rejected")).toMatchObject({
			reason: "invalid",
			invocation: { id: "invocation-2", toolName: "write" },
		});
		expect(stressed.lines.at(-2)).toMatchObject({ type: "run_end", outcome: "success" });
		expect(stressed.lines.at(-1)).toMatchObject({ type: "run_evidence", outcome: "success" });
	});
});

async function semanticFixture(deltaCount: number) {
	const output = new BufferOutput();
	let projectedRecords = 0;
	const writer = new JsonEventWriter({
		mode: "semantic",
		output,
		project: (value) => {
			projectedRecords++;
			return value;
		},
	});
	let sequence = 0;
	const write = async (type: AgentEvent["type"], payload: Record<string, unknown> = {}) => {
		sequence++;
		await writer.writeAgentEvent(
			event({ type, runId: "run-1", sequence, timestamp: sequence, ...payload }),
			type === "run_start" ? RUN_START_METADATA : undefined,
		);
	};

	await write("run_start", {
		source: "prompt",
		inputMessage: {
			id: "message-user",
			message: { role: "user", content: [{ type: "text", text: "task" }], timestamp: 1 },
		},
	});
	await write("turn_start", { turnId: "turn-1", steeringMessages: [] });
	await write("attempt_start", {
		turnId: "turn-1",
		attemptId: "attempt-1",
		messageId: "message-tool",
		attempt: 1,
	});
	await write("message_start", {
		turnId: "turn-1",
		attemptId: "attempt-1",
		messageId: "message-tool",
	});
	for (let index = 0; index < deltaCount; index++) {
		await write("message_update", {
			turnId: "turn-1",
			attemptId: "attempt-1",
			messageId: "message-tool",
			delta: { type: "text_delta", contentIndex: 0, delta: "x" },
		});
	}
	const toolCandidate = candidate("message-tool", [TOOL_CALL], "toolUse");
	await write("attempt_end", {
		turnId: "turn-1",
		attemptId: "attempt-1",
		messageId: "message-tool",
		attempt: 1,
		outcome: "success",
		discarded: false,
		candidate: toolCandidate,
	});
	await write("message_end", { turnId: "turn-1", attemptId: "attempt-1", message: toolCandidate });
	const invocation = {
		id: "invocation-1",
		resultMessageId: "message-result-1",
		providerToolCallId: "provider-call-1",
		toolName: "read",
		arguments: { path: "src/index.ts" },
		sourceIndex: 0,
	};
	await write("tool_execution_start", { turnId: "turn-1", invocation });
	await write("tool_execution_progress", {
		turnId: "turn-1",
		invocation,
		progress: { progress: 1, total: 1, message: "done" },
	});
	await write("tool_execution_end", {
		turnId: "turn-1",
		invocation,
		settlement: "returned",
		outcome: "success",
		result: {
			id: "message-result-1",
			message: { role: "toolResult", toolCallId: "provider-call-1", toolName: "read", content: "file" },
		},
	});
	await write("tool_execution_rejected", {
		turnId: "turn-1",
		invocation: {
			...invocation,
			id: "invocation-2",
			providerToolCallId: "provider-call-2",
			toolName: "write",
			arguments: { path: "invalid.txt", content: "invalid" },
			sourceIndex: 1,
		},
		reason: "invalid",
		message: "invalid arguments",
		result: {
			id: "message-result-2",
			message: {
				role: "toolResult",
				toolCallId: "provider-call-2",
				toolName: "write",
				content: "invalid arguments",
			},
		},
	});
	await write("turn_end", { turnId: "turn-1", outcome: "success" });
	await write("turn_start", { turnId: "turn-2", steeringMessages: [] });
	await write("attempt_start", {
		turnId: "turn-2",
		attemptId: "attempt-2",
		messageId: "message-final",
		attempt: 1,
	});
	await write("message_start", {
		turnId: "turn-2",
		attemptId: "attempt-2",
		messageId: "message-final",
	});
	const finalCandidate = candidate("message-final", [{ type: "text", text: "final answer" }], "stop");
	await write("attempt_end", {
		turnId: "turn-2",
		attemptId: "attempt-2",
		messageId: "message-final",
		attempt: 1,
		outcome: "success",
		discarded: false,
		candidate: finalCandidate,
	});
	await write("message_end", { turnId: "turn-2", attemptId: "attempt-2", message: finalCandidate });
	await write("turn_end", { turnId: "turn-2", outcome: "success" });
	await write("run_end", { outcome: "success" });
	await writer.writeRecord({
		schemaVersion: 1,
		type: "run_evidence",
		runId: "run-1",
		outcome: "success",
		startedAt: 1,
		completedAt: sequence,
		elapsedMs: sequence - 1,
		paths: { inspected: ["src/index.ts"], changed: [], omitted: { inspected: 0, changed: 0 } },
		commands: [],
		toolIssues: [],
		unresolvedFailures: [],
		usage: {
			attempts: 2,
			retries: 0,
			discardedAttempts: 0,
			inputTokens: 20,
			outputTokens: 2,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			cacheWrite1hTokens: 0,
			reasoningTokens: 0,
			totalTokens: 22,
			cost: {
				currency: "USD",
				status: "unavailable",
				totalUsd: null,
				knownTotalUsd: 0,
				pricedAttempts: 0,
				unpricedAttempts: 2,
			},
		},
		omitted: { commands: 0, toolIssues: 0, unresolvedFailures: 0 },
	});

	const lines = output.chunks.map((chunk) => JSON.parse(chunk) as Record<string, unknown>);
	const contents = lines
		.filter((line) => line.type === "attempt_end")
		.flatMap((line) => {
			const terminal = line.candidate as { message?: { content?: readonly unknown[] } } | undefined;
			return terminal?.message?.content ?? [];
		});
	const finalText = contents
		.flatMap((content) => {
			if (!content || typeof content !== "object") return [];
			const block = content as Record<string, unknown>;
			return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
		})
		.at(-1);
	const toolCalls = contents.filter(
		(content) => content && typeof content === "object" && (content as Record<string, unknown>).type === "toolCall",
	);
	return {
		lines,
		types: lines.map((line) => line.type),
		bytes: output.bytes,
		projectedRecords,
		agentSchemaVersions: [
			...new Set(lines.filter((line) => line.type !== "run_evidence").map((line) => line.schemaVersion)),
		],
		evidenceSchemaVersions: [
			...new Set(lines.filter((line) => line.type === "run_evidence").map((line) => line.schemaVersion)),
		],
		finalText: finalText ?? "",
		toolCalls,
	};
}
