import type { AgentMessage, ToolInvocation } from "@coda/agent";
import type { DiagnosticSink } from "@coda/tui";
import { messagePayload, reduceSession, type SessionRecord, type SessionRecordInput } from "./records.ts";
import type { SessionId, SessionRuntime } from "./types.ts";

export interface InterruptedToolRecoveryRequest {
	readonly invocation: ToolInvocation;
	readonly runId?: string;
	readonly turnId?: string;
	readonly startedAt: number;
}

export type InterruptedToolRecovery = (request: InterruptedToolRecoveryRequest) => Promise<"cancel" | "skip">;

type RecoveryRecordInput = SessionRecordInput & { readonly runId?: string; readonly turnId?: string };

/** Converts incomplete tool and Run lifecycles into explicit durable terminal facts. */
export class SessionRecovery {
	readonly #runtime: SessionRuntime;
	readonly #diagnostics?: DiagnosticSink;
	readonly #interruptedToolRecovery?: InterruptedToolRecovery;

	constructor(options: {
		readonly runtime: SessionRuntime;
		readonly diagnostics?: DiagnosticSink;
		readonly interruptedToolRecovery?: InterruptedToolRecovery;
	}) {
		this.#runtime = options.runtime;
		this.#diagnostics = options.diagnostics;
		this.#interruptedToolRecovery = options.interruptedToolRecovery;
	}

	async recover(input: {
		readonly records: readonly SessionRecord[];
		readonly sessionId: SessionId;
		readonly path: string;
		readonly mode: "interactive" | "print";
		readonly append: (record: SessionRecord) => Promise<void>;
	}): Promise<readonly SessionRecord[]> {
		const reduced = reduceSession(input.records);
		const recoveryInputs: RecoveryRecordInput[] = [];
		if (reduced.startedTools.size > 0) {
			if (input.mode === "print" || !this.#interruptedToolRecovery) {
				throw new Error(
					`Session has ${reduced.startedTools.size} Interrupted Tool Invocation(s); automatic replay is forbidden`,
				);
			}
			for (const started of reduced.startedTools.values()) {
				const invocation = started.payload.invocation;
				assertRecoverableInvocation(invocation);
				const decision = await this.#interruptedToolRecovery({
					invocation: structuredClone(invocation),
					runId: started.runId,
					turnId: started.turnId,
					startedAt: started.timestamp,
				});
				if (decision !== "skip") throw new Error("Interrupted Tool recovery was cancelled");
				const result: AgentMessage = {
					id: invocation.resultMessageId,
					message: {
						role: "toolResult",
						toolCallId: invocation.providerToolCallId,
						toolName: invocation.toolName,
						content: [
							{
								type: "text",
								text: "Interrupted Tool Invocation was skipped during Session recovery; prior side effects are unknown.",
							},
						],
						details: { interrupted: true, recovery: "skipped", sideEffects: "unknown" },
						isError: true,
						timestamp: this.#runtime.clock.now(),
					},
				};
				recoveryInputs.push(
					{
						type: "tool_finished",
						payload: {
							invocation,
							outcome: "interrupted",
							reason: "skipped_by_user",
							resultMessageId: invocation.resultMessageId,
						},
						runId: started.runId,
						turnId: started.turnId,
					},
					{
						type: "message_committed",
						payload: messagePayload(result),
						runId: started.runId,
						turnId: started.turnId,
					},
				);
			}
		}

		const recovered = [...input.records];
		let sequence = recovered.at(-1)?.sequence ?? 0;
		let previousRecordId = recovered.at(-1)?.recordId ?? null;
		for (const candidate of [
			...recoveryInputs,
			...[...reduced.activeRuns].sort().map(
				(runId): RecoveryRecordInput => ({
					type: "run_finished",
					runId,
					payload: { outcome: "interrupted", reason: "process_ended_before_run_finished" },
				}),
			),
		]) {
			const record = {
				...candidate,
				recordId: identity(this.#runtime),
				sessionId: input.sessionId,
				sequence: ++sequence,
				previousRecordId,
				timestamp: this.#runtime.clock.now(),
				payload: structuredClone(candidate.payload),
			} as unknown as SessionRecord;
			await input.append(record);
			recovered.push(record);
			previousRecordId = record.recordId;
			if (record.type === "run_finished" && "reason" in record.payload) {
				await this.#diagnostics?.({
					code: "session.run-interrupted",
					message: "Recovered an active Run as interrupted",
					details: { path: input.path, runId: record.runId },
				});
			}
		}
		return recovered;
	}
}

function assertRecoverableInvocation(invocation: ToolInvocation): void {
	if (
		typeof invocation.id !== "string" ||
		typeof invocation.resultMessageId !== "string" ||
		typeof invocation.providerToolCallId !== "string" ||
		typeof invocation.toolName !== "string"
	) {
		throw new Error("Interrupted Tool Invocation is missing required identities");
	}
}

function identity(runtime: SessionRuntime): string {
	const value = runtime.idGenerator.generate("queue_item").replace(/[^a-zA-Z0-9._-]/g, "-");
	if (!value) throw new Error("IdGenerator returned an invalid Session recovery identity");
	return `record:${value}`;
}
