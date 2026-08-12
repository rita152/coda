import { Agent, type AgentEvent, type IdGenerator, type IdKind } from "@coda/agent";
import { createFauxCore, fauxAssistantMessage, type ToolObservation, type Usage } from "@coda/ai";
import { describe, expect, it } from "vitest";
import { projectSessionRunEvidence, RunEvidenceProjection } from "../src/run-evidence/run-evidence.ts";
import { InMemorySessionManager } from "../src/session/memory-session-manager.ts";
import { testTimeRuntime } from "./time-runtime.ts";

describe("RunEvidence projection", () => {
	it("totals retried Attempts without treating an explicitly retried failure as unresolved", () => {
		const projection = new RunEvidenceProjection();
		projection.accept(event({ type: "run_start", source: "prompt", inputMessage: userMessage(), timestamp: 100 }));
		projection.accept(
			event({
				type: "attempt_end",
				turnId: "turn:1",
				attemptId: "attempt:1",
				messageId: "message:1",
				attempt: 1,
				outcome: "error",
				discarded: true,
				candidate: assistantMessage(
					usage({ input: 10, output: 2, totalTokens: 12, cost: 0.03 }),
					"transient sk-super-secret-token",
					"malicious Assistant prose must not become evidence",
				),
				timestamp: 110,
			}),
		);
		projection.accept(
			event({
				type: "retry_scheduled",
				turnId: "turn:1",
				attemptId: "attempt:1",
				attempt: 1,
				delayMs: 2_000,
				reason: "transient",
				timestamp: 115,
			}),
		);
		projection.accept(
			event({
				type: "attempt_end",
				turnId: "turn:1",
				attemptId: "attempt:2",
				messageId: "message:2",
				attempt: 2,
				outcome: "success",
				discarded: false,
				candidate: assistantMessage(usage({ input: 20, output: 5, totalTokens: 0 })),
				timestamp: 140,
			}),
		);
		const evidence = projection.accept(event({ type: "run_end", outcome: "success", timestamp: 160 }));

		expect(evidence).toMatchObject({
			type: "run_evidence",
			outcome: "success",
			startedAt: 100,
			completedAt: 160,
			elapsedMs: 60,
			usage: {
				attempts: 2,
				retries: 1,
				discardedAttempts: 1,
				inputTokens: 30,
				outputTokens: 7,
				totalTokens: 37,
				cost: {
					status: "partial",
					totalUsd: null,
					knownTotalUsd: 0.03,
					pricedAttempts: 1,
					unpricedAttempts: 1,
				},
			},
			unresolvedFailures: [],
		});
		const json = JSON.stringify(evidence);
		expect(json).not.toContain("malicious Assistant prose");
		expect(json).not.toContain("super-secret");
	});

	it("uses source order for parallel Tools and authoritative observations for paths and issues", () => {
		const projection = new RunEvidenceProjection();
		projection.accept(event({ type: "run_start", source: "prompt", inputMessage: userMessage(), timestamp: 200 }));
		const read = invocation("invocation:read", "read", { path: "src/first.ts" }, 0);
		const grep = invocation("invocation:grep", "grep", { path: "src/second" }, 1);
		const write = invocation("invocation:write", "write", { path: "src/changed.ts", content: "ignored" }, 2);
		const bash = invocation(
			"invocation:bash",
			"bash",
			{
				command:
					"curl -H 'Authorization: Bearer sk-command-secret' --token ghp_abcdefghijk https://user:pass@example.test\u001b]0;owned\u0007",
			},
			3,
		);
		projection.accept(toolStart(read, 210));
		projection.accept(toolStart(grep, 211));
		projection.accept(toolEnd(grep, observation("ok"), 220));
		projection.accept(toolEnd(read, observation("ok", { truncated: true, outputRef: "opaque:ref" }), 230));
		projection.accept(toolStart(write, 231));
		projection.accept(toolEnd(write, observation("ok"), 235));
		projection.accept(toolStart(bash, 240));
		projection.accept(
			toolEnd(
				bash,
				observation("error", { facts: { exitCode: 7, timedOut: false }, output: "untrusted secret output" }),
				250,
			),
		);
		const evidence = projection.accept(event({ type: "run_end", outcome: "success", timestamp: 260 }))!;

		expect(evidence.paths).toEqual({
			inspected: ["src/first.ts", "src/second"],
			changed: ["src/changed.ts"],
			omitted: { inspected: 0, changed: 0 },
		});
		expect(evidence.commands).toEqual([expect.objectContaining({ status: "error", exitCode: 7, truncated: false })]);
		expect(evidence.commands[0]?.command).toContain("Authorization: [REDACTED]");
		expect(evidence.commands[0]?.command).toContain("--token [REDACTED]");
		expect(evidence.commands[0]?.command).toContain("https://[REDACTED]@example.test");
		expect(evidence.toolIssues).toEqual([
			expect.objectContaining({
				invocationId: "invocation:read",
				status: "ok",
				truncated: true,
				outputRecoverable: true,
			}),
			expect.objectContaining({
				invocationId: "invocation:bash",
				status: "error",
				reason: "exit_7",
			}),
		]);
		expect(evidence.unresolvedFailures).toEqual([
			expect.objectContaining({ kind: "tool", id: "invocation:bash", status: "error" }),
		]);
		const json = JSON.stringify(evidence);
		expect(json).not.toContain("untrusted secret output");
		expect(json).not.toContain("command-secret");
		expect(json).not.toContain("abcdefghijk");
		expect(json).not.toContain("\u001b");
		expect(json).not.toContain("owned");
	});

	it("keeps an aborted Run objective without treating cancellation as a Model failure", () => {
		const projection = new RunEvidenceProjection();
		projection.accept(event({ type: "run_start", source: "prompt", inputMessage: userMessage(), timestamp: 300 }));
		const read = invocation("invocation:aborted", "read", { path: "never-read.ts" }, 0);
		projection.accept(
			event({
				type: "tool_execution_rejected",
				turnId: "turn:abort",
				invocation: read,
				reason: "aborted",
				message: "ignored output",
				result: toolResult(read, { status: "aborted", truncated: false }, "ignored output"),
				timestamp: 310,
			}),
		);
		const evidence = projection.accept(event({ type: "run_end", outcome: "aborted", timestamp: 325 }))!;

		expect(evidence).toMatchObject({ outcome: "aborted", elapsedMs: 25, paths: { inspected: [] } });
		expect(evidence.toolIssues).toEqual([expect.objectContaining({ status: "aborted", reason: "aborted" })]);
		expect(evidence.unresolvedFailures).toEqual([expect.objectContaining({ kind: "tool", status: "aborted" })]);
	});

	it("bounds paths and commands and reports exact omission counts", () => {
		const projection = new RunEvidenceProjection();
		projection.accept(event({ type: "run_start", source: "prompt", inputMessage: userMessage(), timestamp: 400 }));
		for (let index = 0; index < 55; index++) {
			const tool = invocation(`read:${index}`, "read", { path: `src/path-${index}.ts` }, index);
			projection.accept(toolStart(tool, 401 + index * 2));
			projection.accept(toolEnd(tool, observation("ok"), 402 + index * 2));
		}
		for (let index = 0; index < 35; index++) {
			const tool = invocation(`bash:${index}`, "bash", { command: `printf ${index}` }, index);
			projection.accept(toolStart(tool, 600 + index * 2));
			projection.accept(toolEnd(tool, observation("ok", { facts: { exitCode: 0 } }), 601 + index * 2));
		}
		const evidence = projection.accept(event({ type: "run_end", outcome: "success", timestamp: 800 }))!;

		expect(evidence.paths.inspected).toHaveLength(50);
		expect(evidence.paths.omitted.inspected).toBe(5);
		expect(evidence.commands).toHaveLength(32);
		expect(evidence.omitted.commands).toBe(3);
	});

	it("reconstructs completed evidence after a Session resumes", async () => {
		let id = 0;
		const idGenerator: IdGenerator = { generate: (kind: IdKind) => `${kind}:${++id}` };
		const manager = new InMemorySessionManager({ clock: { now: () => 1_000 }, idGenerator });
		const session = await manager.open({
			workspace: { id: "workspace-id", path: "/workspace" },
			mode: "interactive",
		});
		const runtime = testTimeRuntime(1_000);
		const responses = [fauxAssistantMessage("persisted answer", { timestamp: 1_000 })];
		const agent = new Agent({
			clock: { now: () => 1_000 },
			idGenerator,
			tools: [],
			policyGate: { check: async () => ({ decision: "allow" }) },
			stream: async () => {
				const faux = createFauxCore({ runtime });
				faux.setResponses(responses.splice(0));
				return faux.streamSimple(faux.getModel(), { messages: [] }, { runtime });
			},
		});
		session.attach(agent);
		await agent.prompt("persist evidence");
		expect(session.runEvidence).toHaveLength(1);
		const sessionId = session.descriptor.id;
		await session.close();

		const restored = await manager.open({
			workspace: { id: "workspace-id", path: "/workspace" },
			mode: "interactive",
			resumeId: sessionId,
		});

		expect(restored.runEvidence).toEqual(session.runEvidence);
		expect(restored.runEvidence[0]).toMatchObject({ type: "run_evidence", outcome: "success" });
		await restored.close();
	});

	it("reconstructs interrupted historical Runs from Session lifecycle facts", () => {
		const evidence = projectSessionRunEvidence([
			{
				type: "run_started",
				sequence: 1,
				timestamp: 10,
				runId: "run:historical",
				payload: { source: "prompt" },
			},
			{
				type: "run_finished",
				sequence: 2,
				timestamp: 25,
				runId: "run:historical",
				payload: { outcome: "interrupted", reason: "process_ended_before_run_finished" },
			},
		]);

		expect(evidence).toEqual([
			expect.objectContaining({
				runId: "run:historical",
				outcome: "interrupted",
				elapsedMs: 15,
				unresolvedFailures: [
					expect.objectContaining({ status: "interrupted", summary: "Process ended before Run finished" }),
				],
			}),
		]);
	});
});

let sequence = 0;

function event(payload: Record<string, unknown>): AgentEvent {
	return {
		runId: "run:test",
		sequence: ++sequence,
		timestamp: 0,
		...payload,
	} as unknown as AgentEvent;
}

function userMessage() {
	return { id: "message:user", message: { role: "user", content: "prompt", timestamp: 0 } };
}

function assistantMessage(value: Usage, errorMessage?: string, text = "answer") {
	return {
		id: "message:assistant",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "test",
			provider: "test",
			model: "test",
			usage: value,
			stopReason: errorMessage ? "error" : "stop",
			...(errorMessage ? { errorMessage } : {}),
			timestamp: 0,
		},
	};
}

function usage(options: {
	readonly input: number;
	readonly output: number;
	readonly totalTokens: number;
	readonly cost?: number;
}): Usage {
	return {
		input: options.input,
		output: options.output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: options.totalTokens,
		...(options.cost === undefined
			? {}
			: {
					cost: {
						input: options.cost,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						total: options.cost,
					},
				}),
	};
}

function invocation(id: string, toolName: string, arguments_: Record<string, unknown>, sourceIndex: number) {
	return {
		id,
		resultMessageId: `result:${id}`,
		providerToolCallId: `provider:${id}`,
		toolName,
		arguments: arguments_,
		sourceIndex,
	};
}

function toolStart(tool: ReturnType<typeof invocation>, timestamp: number): AgentEvent {
	return event({ type: "tool_execution_start", turnId: "turn:tools", invocation: tool, timestamp });
}

function toolEnd(
	tool: ReturnType<typeof invocation>,
	result: ReturnType<typeof toolResult>,
	timestamp: number,
): AgentEvent {
	return event({
		type: "tool_execution_end",
		turnId: "turn:tools",
		invocation: tool,
		settlement: "returned",
		outcome: result.message.observation.status === "aborted" ? "aborted" : "success",
		result,
		timestamp,
	});
}

function observation(
	status: ToolObservation["status"],
	options: {
		readonly truncated?: boolean;
		readonly outputRef?: string;
		readonly facts?: ToolObservation["facts"];
		readonly output?: string;
	} = {},
) {
	return toolResult(
		invocation("placeholder", "placeholder", {}, 0),
		{
			status,
			truncated: options.truncated ?? false,
			...(options.outputRef ? { outputRef: options.outputRef } : {}),
			...(options.facts ? { facts: options.facts } : {}),
		},
		options.output ?? "Tool output must not be projected",
	);
}

function toolResult(tool: ReturnType<typeof invocation>, value: ToolObservation, output = "ignored") {
	return {
		id: tool.resultMessageId,
		message: {
			role: "toolResult" as const,
			toolCallId: tool.providerToolCallId,
			toolName: tool.toolName,
			content: [{ type: "text" as const, text: output }],
			observation: value,
			isError: value.status !== "ok",
			timestamp: 0,
		},
	};
}
