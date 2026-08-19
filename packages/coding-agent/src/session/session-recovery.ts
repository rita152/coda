import { type AgentMessage, type AgentTool, settleToolInvocation, type ToolInvocation } from "@coda/agent";
import type { DiagnosticSink } from "@coda/tui";
import { messagePayload, reduceSession, type SessionRecord, type SessionRecordInput } from "./records.ts";
import type { SessionId, SessionRuntime, SessionWorkspace } from "./types.ts";

export interface InterruptedToolRecoveryRequest {
	readonly invocation: ToolInvocation;
	readonly runId?: string;
	readonly turnId?: string;
	readonly startedAt: number;
}

export type InterruptedToolRecoveryDecision = "cancel" | "skip" | "re-execute";

export type InterruptedToolRecovery = (
	request: InterruptedToolRecoveryRequest,
) => Promise<InterruptedToolRecoveryDecision>;

export type InterruptedToolRecoveryCatalog = (request: {
	readonly workspace: SessionWorkspace;
	readonly sessionId: SessionId;
}) => readonly AgentTool[] | Promise<readonly AgentTool[]>;

export interface InterruptedToolRecoveryChoice {
	readonly id: InterruptedToolRecoveryDecision;
	readonly label: string;
	readonly description?: string;
}

export function interruptedToolRecoveryChoices(
	replaySafety: ToolInvocation["replaySafety"],
): readonly InterruptedToolRecoveryChoice[] {
	const choices: InterruptedToolRecoveryChoice[] = [
		{ id: "cancel", label: "Cancel resume" },
		{
			id: "skip",
			label: "Skip this invocation",
			description: "Resume with an explicit error result; request a new invocation later to re-execute.",
		},
	];
	if (replaySafety === "safe") {
		choices.push({
			id: "re-execute",
			label: "Re-execute this invocation",
			description:
				"Run it again now with a new Tool Invocation identity. Coda still will not replay it automatically.",
		});
	}
	return choices;
}

type RecoveryRecordInput = SessionRecordInput & { readonly runId?: string; readonly turnId?: string };

/** Converts incomplete tool and Run lifecycles into explicit durable terminal facts. */
export class SessionRecovery {
	readonly #runtime: SessionRuntime;
	readonly #diagnostics?: DiagnosticSink;
	readonly #interruptedToolRecovery?: InterruptedToolRecovery;
	readonly #recoveryTools?: InterruptedToolRecoveryCatalog;

	constructor(options: {
		readonly runtime: SessionRuntime;
		readonly diagnostics?: DiagnosticSink;
		readonly interruptedToolRecovery?: InterruptedToolRecovery;
		readonly recoveryTools?: InterruptedToolRecoveryCatalog;
	}) {
		this.#runtime = options.runtime;
		this.#diagnostics = options.diagnostics;
		this.#interruptedToolRecovery = options.interruptedToolRecovery;
		this.#recoveryTools = options.recoveryTools;
	}

	async recover(input: {
		readonly records: readonly SessionRecord[];
		readonly sessionId: SessionId;
		readonly path: string;
		readonly mode: "interactive" | "print";
		readonly workspace: SessionWorkspace;
		readonly append: (record: SessionRecord) => Promise<void>;
	}): Promise<readonly SessionRecord[]> {
		const reduced = reduceSession(input.records);
		const recovered = [...input.records];
		let sequence = recovered.at(-1)?.sequence ?? 0;
		let previousRecordId = recovered.at(-1)?.recordId ?? null;
		const appendRecovery = async (candidate: RecoveryRecordInput): Promise<SessionRecord> => {
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
			return record;
		};

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
				if (decision === "skip") {
					await this.#skipInvocation(appendRecovery, invocation, started.runId, started.turnId);
					continue;
				}
				if (decision === "re-execute") {
					await this.#reexecuteInvocation(appendRecovery, input, invocation, started.runId, started.turnId);
					continue;
				}
				throw new Error("Interrupted Tool recovery was cancelled");
			}
		}

		for (const runId of [...reduced.activeRuns].sort()) {
			await appendRecovery({
				type: "run_finished",
				runId,
				payload: { outcome: "interrupted", reason: "process_ended_before_run_finished" },
			});
		}
		return recovered;
	}

	async #skipInvocation(
		appendRecovery: (candidate: RecoveryRecordInput) => Promise<SessionRecord>,
		invocation: ToolInvocation,
		runId?: string,
		turnId?: string,
	): Promise<void> {
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
				observation: { status: "error", truncated: false, facts: { recovery: "skipped" } },
				details: { interrupted: true, recovery: "skipped", sideEffects: "unknown" },
				timestamp: this.#runtime.clock.now(),
			},
		};
		await appendRecovery({
			type: "tool_finished",
			payload: {
				invocation,
				outcome: "interrupted",
				reason: "skipped_by_user",
				resultMessageId: invocation.resultMessageId,
			},
			runId,
			turnId,
		});
		await appendRecovery({
			type: "message_committed",
			payload: messagePayload(result),
			runId,
			turnId,
		});
	}

	async #reexecuteInvocation(
		appendRecovery: (candidate: RecoveryRecordInput) => Promise<SessionRecord>,
		input: {
			readonly workspace: SessionWorkspace;
			readonly sessionId: SessionId;
		},
		invocation: ToolInvocation,
		runId?: string,
		turnId?: string,
	): Promise<void> {
		if (invocation.replaySafety !== "safe") {
			throw new Error('Interrupted Tool re-execute is only available for replaySafety "safe"');
		}
		if (!this.#recoveryTools) {
			throw new Error("Interrupted Tool re-execute requires a recovery Tool catalog");
		}
		const next = allocateInvocation(this.#runtime, invocation);
		await appendRecovery({
			type: "tool_finished",
			payload: {
				invocation,
				outcome: "interrupted",
				reason: "reexecuted_by_user",
				resultMessageId: invocation.resultMessageId,
			},
			runId,
			turnId,
		});
		const tools = await this.#recoveryTools({ workspace: input.workspace, sessionId: input.sessionId });
		const settled = await settleToolInvocation({
			tools,
			invocation: next,
			context: {
				signal: new AbortController().signal,
				runId: runId ?? "run:recovery",
				turnId: turnId ?? "turn:recovery",
				clock: this.#runtime.clock,
			},
			beforeExecute: async () => {
				await appendRecovery({
					type: "tool_started",
					payload: { invocation: next },
					runId,
					turnId,
				});
			},
		});
		if (settled.kind === "executed") {
			await appendRecovery({
				type: "tool_finished",
				payload: {
					invocation: next,
					settlement: settled.settlement,
					outcome: settled.outcome,
					resultMessageId: settled.result.id,
				},
				runId,
				turnId,
			});
		} else {
			await appendRecovery({
				type: "tool_finished",
				payload: {
					invocation: next,
					outcome: "rejected",
					reason: settled.reason,
					resultMessageId: settled.result.id,
				},
				runId,
				turnId,
			});
		}
		await appendRecovery({
			type: "message_committed",
			payload: messagePayload(settled.result),
			runId,
			turnId,
		});
	}
}

function allocateInvocation(runtime: SessionRuntime, previous: ToolInvocation): ToolInvocation {
	const id = runtime.idGenerator.generate("tool_invocation");
	const resultMessageId = runtime.idGenerator.generate("message");
	if (!id || !resultMessageId) throw new Error("IdGenerator returned an invalid Tool Invocation identity");
	return {
		...structuredClone(previous),
		id: id as ToolInvocation["id"],
		resultMessageId: resultMessageId as ToolInvocation["resultMessageId"],
	};
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
