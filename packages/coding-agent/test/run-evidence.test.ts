import type { AgentEvent, IdGenerator, IdKind } from "@coda/agent";
import { createFauxCore, fauxAssistantMessage, type ToolObservation, type Usage } from "@coda/ai";
import { describe, expect, it } from "vitest";
import {
	projectRunEvidenceV1,
	projectSessionRunEvidence,
	RunEvidenceProjection,
	supplementRunEvidenceWorkspaceDiff,
} from "../src/run-evidence/run-evidence.ts";
import { InMemorySessionManager } from "../src/session/memory-session-manager.ts";
import { createTestAgent } from "./agent-runtime-adapter.ts";
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
			schemaVersion: 3,
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
			terminalFailures: [expect.objectContaining({ id: "attempt:1", kind: "attempt" })],
			recoveredFailures: [expect.objectContaining({ id: "attempt:1", recoveredById: "attempt:2" })],
			openFailures: [],
			unresolvedFailures: [],
		});
		const legacy = projectRunEvidenceV1(evidence!);
		expect(legacy).toMatchObject({ schemaVersion: 1, unresolvedFailures: [] });
		expect(legacy).not.toHaveProperty("terminalFailures");
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
			changedWithProvenance: [{ path: "src/changed.ts", provenance: ["native"] }],
			workspaceDiff: { status: "unavailable", omitted: 0 },
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

	it("separates windowed observations from recoverable and lossy overflow", () => {
		const projection = new RunEvidenceProjection();
		projection.accept(event({ type: "run_start", source: "prompt", inputMessage: userMessage(), timestamp: 270 }));
		const read = invocation("invocation:windowed-read", "read", { path: "src/page.ts", offset: 2, limit: 1 }, 0);
		const preview = invocation(
			"invocation:preview",
			"bash",
			{ command: "npm test", preview: { mode: "tail", lines: 20 } },
			1,
		);
		const recoverable = invocation("invocation:recoverable", "bash", { command: "npm run check" }, 2);
		const lossy = invocation("invocation:lossy", "find", { path: "src" }, 3);
		const patch = invocation("invocation:patch", "patch", { patch: "ignored" }, 4);
		for (const [tool, result, timestamp] of [
			[
				read,
				observation("ok", {
					truncated: true,
					facts: {
						runEvidence: {
							schemaVersion: 1,
							completeness: "windowed",
							limitationReason: "pagination",
							paths: [{ path: "src/page.ts", effect: "inspected" }],
							resolutionTarget: { kind: "path", value: "src/page.ts" },
						},
					},
				}),
				271,
			],
			[
				preview,
				observation("ok", {
					truncated: true,
					outputRef: "opaque:preview",
					facts: { previewMode: "tail", previewComplete: true, exitCode: 0 },
				}),
				272,
			],
			[
				recoverable,
				observation("ok", { truncated: true, outputRef: "opaque:overflow", facts: { exitCode: 0 } }),
				273,
			],
			[
				lossy,
				observation("ok", {
					truncated: true,
					outputRef: "opaque:partial-overflow",
					facts: { outputRefComplete: false },
				}),
				274,
			],
			[
				patch,
				observation("ok", {
					facts: {
						runEvidence: {
							schemaVersion: 1,
							completeness: "complete",
							paths: [{ path: "src/changed.ts", effect: "changed" }],
							omittedPaths: { inspected: 0, changed: 2 },
						},
					},
				}),
				275,
			],
		] as const) {
			projection.accept(toolStart(tool, timestamp));
			projection.accept(toolEnd(tool, result, timestamp + 10));
		}
		const evidence = projection.accept(event({ type: "run_end", outcome: "success", timestamp: 300 }))!;

		expect(evidence.observations.counts).toEqual({
			complete: 1,
			windowed: 2,
			"recoverable-overflow": 1,
			"lossy-overflow": 1,
		});
		expect(evidence.observations.limitations).toEqual([
			expect.objectContaining({ invocationId: read.id, completeness: "windowed", reason: "pagination" }),
			expect.objectContaining({ invocationId: preview.id, completeness: "windowed", reason: "user-preview" }),
			expect.objectContaining({
				invocationId: recoverable.id,
				completeness: "recoverable-overflow",
			}),
			expect.objectContaining({ invocationId: lossy.id, completeness: "lossy-overflow" }),
		]);
		expect(evidence.toolIssues.map(({ invocationId }) => invocationId)).toEqual([recoverable.id, lossy.id]);
		expect(evidence.paths).toMatchObject({
			inspected: ["src/page.ts", "src"],
			changed: ["src/changed.ts"],
			omitted: { inspected: 0, changed: 2 },
		});
		expect(evidence.operations.find(({ invocationId }) => invocationId === patch.id)).toMatchObject({
			status: "ok",
			paths: [{ path: "src/changed.ts", effect: "changed", provenance: "tool-observation" }],
			omittedPaths: 2,
		});
	});

	it("recovers failures only through stable Tool targets or normalized commands", () => {
		const projection = new RunEvidenceProjection();
		projection.accept(event({ type: "run_start", source: "prompt", inputMessage: userMessage(), timestamp: 310 }));
		const failedEdit = invocation("edit:failed", "edit", { path: "src/edit.ts" }, 0);
		const unrelatedRead = invocation("read:unrelated", "read", { path: "src/edit.ts" }, 1);
		const failedRecoveredEdit = invocation("edit:recovered-failure", "edit", { path: "src/fixed.ts" }, 2);
		const recoveredEdit = invocation("edit:recovered", "edit", { path: "src/fixed.ts" }, 3);
		const failedRead = invocation("read:failed", "read", { path: "src/read.ts" }, 4);
		const recoveredRead = invocation("read:recovered", "read", { path: "src/read.ts" }, 5);
		const failedCommand = invocation("bash:open", "bash", { command: "npm test" }, 6);
		const unrelatedCommand = invocation("bash:unrelated", "bash", { command: "npm test -- --run" }, 7);
		const normalizedFailure = invocation("bash:normalized-failure", "bash", { command: "  npm run lint\r\n" }, 8);
		const normalizedSuccess = invocation("bash:normalized-success", "bash", { command: "npm run lint\n" }, 9);
		const cases = [
			[failedEdit, observation("error", { facts: { code: "no_match" } })],
			[unrelatedRead, observation("ok")],
			[failedRecoveredEdit, observation("error", { facts: { code: "no_match" } })],
			[recoveredEdit, observation("ok")],
			[failedRead, observation("error", { facts: { code: "not_found" } })],
			[recoveredRead, observation("ok")],
			[failedCommand, observation("error", { facts: { exitCode: 1 } })],
			[unrelatedCommand, observation("ok", { facts: { exitCode: 0 } })],
			[normalizedFailure, observation("error", { facts: { exitCode: 2 } })],
			[normalizedSuccess, observation("ok", { facts: { exitCode: 0 } })],
		] as const;
		for (const [index, [tool, result]] of cases.entries()) {
			projection.accept(toolStart(tool, 311 + index * 2));
			projection.accept(toolEnd(tool, result, 312 + index * 2));
		}
		const evidence = projection.accept(event({ type: "run_end", outcome: "success", timestamp: 340 }))!;

		expect(evidence.terminalFailures.map(({ id }) => id)).toEqual([
			failedEdit.id,
			failedRecoveredEdit.id,
			failedRead.id,
			failedCommand.id,
			normalizedFailure.id,
		]);
		expect(evidence.recoveredFailures).toEqual([
			expect.objectContaining({ id: failedRecoveredEdit.id, recoveredById: recoveredEdit.id }),
			expect.objectContaining({ id: failedRead.id, recoveredById: recoveredRead.id }),
			expect.objectContaining({ id: normalizedFailure.id, recoveredById: normalizedSuccess.id }),
		]);
		expect(evidence.openFailures).toEqual([
			expect.objectContaining({ id: failedEdit.id, resolutionKey: expect.any(String) }),
			expect.objectContaining({ id: failedCommand.id, resolutionKey: expect.any(String) }),
		]);
		expect(evidence.unresolvedFailures).toEqual(evidence.openFailures);
		expect(evidence.commands.find(({ invocationId }) => invocationId === normalizedFailure.id)?.commandKey).toBe(
			evidence.commands.find(({ invocationId }) => invocationId === normalizedSuccess.id)?.commandKey,
		);
	});

	it("keeps start-only Tool Invocations pending instead of fabricating failures", () => {
		const projection = new RunEvidenceProjection();
		projection.accept(event({ type: "run_start", source: "prompt", inputMessage: userMessage(), timestamp: 350 }));
		const pending = invocation("read:pending", "read", { path: "src/pending.ts" }, 0);
		projection.accept(toolStart(pending, 351));
		const evidence = projection.accept(event({ type: "run_end", outcome: "success", timestamp: 360 }))!;

		expect(evidence.pendingOperations).toEqual([
			{
				invocationId: pending.id,
				toolName: "read",
				startedSequence: expect.any(Number),
				target: { kind: "path", value: "src/pending.ts" },
			},
		]);
		expect(evidence.terminalFailures).toEqual([]);
		expect(evidence.openFailures).toEqual([]);
		expect(evidence.toolIssues).toEqual([]);
		expect(evidence.observations.counts).toEqual({
			complete: 0,
			windowed: 0,
			"recoverable-overflow": 0,
			"lossy-overflow": 0,
		});
	});

	it("bounds historical, recovered, and open failures with independent omission counts", () => {
		const projection = new RunEvidenceProjection();
		projection.accept(event({ type: "run_start", source: "prompt", inputMessage: userMessage(), timestamp: 370 }));
		const failures = Array.from({ length: 140 }, (_, index) =>
			invocation(`read:failure:${index}`, "read", { path: `src/failure-${index}.ts` }, index),
		);
		for (const [index, tool] of failures.entries()) {
			projection.accept(toolStart(tool, 371 + index * 2));
			projection.accept(toolEnd(tool, observation("error", { facts: { code: "not_found" } }), 372 + index * 2));
		}
		for (const [index, failed] of failures.slice(0, 70).entries()) {
			const recovered = invocation(`read:success:${index}`, "read", { path: failed.arguments.path }, 140 + index);
			projection.accept(toolStart(recovered, 700 + index * 2));
			projection.accept(toolEnd(recovered, observation("ok"), 701 + index * 2));
		}
		const evidence = projection.accept(event({ type: "run_end", outcome: "success", timestamp: 900 }))!;

		expect(evidence.terminalFailures).toHaveLength(64);
		expect(evidence.omitted.terminalFailures).toBe(76);
		expect(evidence.recoveredFailures).toHaveLength(64);
		expect(evidence.omitted.recoveredFailures).toBe(6);
		expect(evidence.openFailures).toHaveLength(64);
		expect(evidence.omitted.openFailures).toBe(6);
		expect(evidence.unresolvedFailures).toHaveLength(64);
		expect(evidence.omitted.unresolvedFailures).toBe(6);
	});

	it("unions generic partial mutation facts with final Workspace provenance", () => {
		const projection = new RunEvidenceProjection();
		projection.accept(event({ type: "run_start", source: "prompt", inputMessage: userMessage(), timestamp: 910 }));
		const mutation = invocation("invocation:future-mutation", "future_mutation", {}, 0);
		projection.accept(toolStart(mutation, 911));
		projection.accept(
			toolEnd(
				mutation,
				observation("error", {
					facts: {
						code: "partial_application",
						mutation: {
							schemaVersion: 1,
							atomicity: "per-file",
							attemptedPaths: ["native.txt", "not-applied.txt"],
							committedPaths: ["native.txt"],
							committedDelta: [
								{
									path: "native.txt",
									operation: "update",
									beforeSha256: "a".repeat(64),
									afterSha256: "b".repeat(64),
									previousBytes: 4,
									bytes: 5,
								},
							],
						},
					},
				}),
				912,
			),
		);
		const native = projection.accept(event({ type: "run_end", outcome: "success", timestamp: 913 }))!;
		const supplemented = supplementRunEvidenceWorkspaceDiff(native, {
			status: "complete",
			paths: ["native.txt", "shell.txt"],
		});

		expect(supplemented.schemaVersion).toBe(3);
		expect(supplemented.operations[0]?.paths).toEqual([
			{ path: "native.txt", effect: "changed", provenance: "tool-observation" },
		]);
		expect(supplemented.operations[0]?.mutation).toEqual({
			attemptedPaths: ["native.txt", "not-applied.txt"],
			committedPaths: ["native.txt"],
		});
		expect(supplemented.paths).toMatchObject({
			changed: ["native.txt", "shell.txt"],
			changedWithProvenance: [
				{ path: "native.txt", provenance: ["native", "workspace-diff"] },
				{ path: "shell.txt", provenance: ["workspace-diff"] },
			],
			workspaceDiff: { status: "complete", omitted: 0 },
		});
		expect(supplemented.paths.changed).not.toContain("not-applied.txt");
		expect(supplemented.openFailures).toEqual([
			expect.objectContaining({ kind: "tool", id: mutation.id, status: "error" }),
		]);
		expect(projectRunEvidenceV1(supplemented).paths).toEqual({
			inspected: [],
			changed: ["native.txt", "shell.txt"],
			omitted: { inspected: 0, changed: 0 },
		});
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

	it("projects a non-destructive live snapshot for application-owned completion gates", () => {
		const projection = new RunEvidenceProjection();
		projection.accept(event({ type: "run_start", source: "prompt", inputMessage: userMessage(), timestamp: 810 }));
		const write = invocation("write:live", "write", { path: "src/live.ts", content: "value" }, 0);
		projection.accept(toolStart(write, 820));
		projection.accept(toolEnd(write, observation("ok"), 830));

		const live = projection.snapshot("run:test", 840);
		expect(live).toMatchObject({
			type: "run_evidence",
			outcome: "success",
			completedAt: 840,
			paths: { changed: ["src/live.ts"] },
		});

		const command = invocation("bash:after-snapshot", "bash", { command: "git diff --check" }, 1);
		projection.accept(toolStart(command, 850));
		projection.accept(toolEnd(command, observation("ok", { facts: { exitCode: 0 } }), 860));
		const completed = projection.accept(event({ type: "run_end", outcome: "success", timestamp: 870 }))!;
		expect(completed.paths.changed).toEqual(["src/live.ts"]);
		expect(completed.commands).toEqual([expect.objectContaining({ command: "git diff --check", status: "ok" })]);
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
		const agent = createTestAgent({
			clock: { now: () => 1_000 },
			idGenerator,
			tools: [],
			stream: async () => {
				const faux = createFauxCore({ runtime });
				faux.setResponses(responses.splice(0));
				return faux.streamSimple(faux.getModel(), { messages: [] }, { runtime });
			},
		});
		agent.onSemanticEvent((event) => session.accept(event));
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
