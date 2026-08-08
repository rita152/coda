import type { AgentEvent, AgentMessage, AgentSeed, FollowUp } from "@coda/agent";
import type { Message } from "@coda/ai";
import type { ModelSelection, ProjectTrustRecord } from "../application.ts";
import type { RestoredSessionState, SessionDescriptor } from "./types.ts";

export const SESSION_RECORD_TYPES = [
	"run_started",
	"attempt_started",
	"attempt_finished",
	"retry_scheduled",
	"message_committed",
	"tool_started",
	"tool_finished",
	"turn_finished",
	"run_finished",
	"follow_up_enqueued",
	"follow_up_consumed",
	"follow_up_canceled",
	"model_selected",
	"project_trust_changed",
] as const;

export type SessionRecordType = (typeof SESSION_RECORD_TYPES)[number];

export interface SessionHeader {
	readonly type: "session";
	readonly version: 1;
	readonly sessionId: string;
	readonly workspaceId: string;
	readonly workspacePath: string;
	readonly createdAt: number;
}

export interface SessionRecord {
	readonly type: SessionRecordType;
	readonly recordId: string;
	readonly sessionId: string;
	readonly sequence: number;
	readonly previousRecordId: string | null;
	readonly timestamp: number;
	readonly runId?: string;
	readonly turnId?: string;
	readonly attemptId?: string;
	readonly payload: unknown;
}

export interface ReducedSession {
	readonly seed: AgentSeed;
	readonly restored: RestoredSessionState;
	readonly startedTools: ReadonlyMap<string, SessionRecord>;
	readonly activeRuns: ReadonlySet<string>;
}

function persistedMessage(message: AgentMessage): AgentMessage {
	const snapshot = structuredClone(message) as AgentMessage;
	if (snapshot.message.role === "assistant") {
		const mutableDiagnostics = snapshot.message.diagnostics as Array<{ error?: { stack?: string } }> | undefined;
		for (const diagnostic of mutableDiagnostics ?? []) {
			if (diagnostic.error) delete diagnostic.error.stack;
		}
	}
	return snapshot;
}

export function messagePayload(message: AgentMessage): { readonly message: AgentMessage } {
	return { message: persistedMessage(message) };
}

export function reduceSession(records: readonly SessionRecord[]): ReducedSession {
	const messages = new Map<string, AgentMessage>();
	const followUps = new Map<string, FollowUp>();
	const startedTools = new Map<string, SessionRecord>();
	const activeRuns = new Set<string>();
	let model: ModelSelection | undefined;
	let reasoning: RestoredSessionState["reasoning"];
	let projectTrust: ProjectTrustRecord | undefined;

	for (const record of records) {
		const payload = record.payload as Record<string, unknown>;
		switch (record.type) {
			case "message_committed": {
				const message = payload.message as AgentMessage<Message>;
				if (message?.id) messages.set(message.id, structuredClone(message));
				break;
			}
			case "follow_up_enqueued": {
				const item = payload.item as FollowUp;
				if (item?.id) followUps.set(item.id, structuredClone(item));
				break;
			}
			case "follow_up_consumed":
			case "follow_up_canceled":
				if (typeof payload.id === "string") followUps.delete(payload.id);
				break;
			case "model_selected":
				model = structuredClone(payload.model as ModelSelection);
				reasoning = payload.reasoning as RestoredSessionState["reasoning"];
				break;
			case "project_trust_changed":
				projectTrust = structuredClone(payload.trust as ProjectTrustRecord);
				break;
			case "tool_started": {
				const invocationId = (payload.invocation as { id?: unknown } | undefined)?.id;
				if (typeof invocationId === "string") startedTools.set(invocationId, record);
				break;
			}
			case "tool_finished": {
				const invocationId = (payload.invocation as { id?: unknown } | undefined)?.id;
				if (typeof invocationId === "string") startedTools.delete(invocationId);
				break;
			}
			case "run_started":
				if (record.runId) activeRuns.add(record.runId);
				break;
			case "run_finished":
				if (record.runId) activeRuns.delete(record.runId);
				break;
		}
	}
	return {
		seed: {
			version: 1,
			messages: [...messages.values()],
			pendingFollowUps: [...followUps.values()],
		},
		restored: { model, reasoning, projectTrust },
		startedTools,
		activeRuns,
	};
}

export function eventRecordInputs(
	event: AgentEvent,
	preparedRun: { readonly promptVersion: string; readonly promptSha256: string } | undefined,
): readonly { type: SessionRecordType; payload: unknown }[] {
	switch (event.type) {
		case "run_start":
			return [
				{
					type: "run_started",
					payload: {
						source: event.source,
						queueItemId: event.queueItemId,
						promptVersion: preparedRun?.promptVersion,
						promptSha256: preparedRun?.promptSha256,
					},
				},
				{ type: "message_committed", payload: messagePayload(event.inputMessage) },
			];
		case "turn_start":
			return event.steeringMessages.map((message) => ({
				type: "message_committed" as const,
				payload: messagePayload(message),
			}));
		case "attempt_start":
			return [{ type: "attempt_started", payload: { messageId: event.messageId, attempt: event.attempt } }];
		case "attempt_end":
			return [
				{
					type: "attempt_finished",
					payload: {
						messageId: event.messageId,
						attempt: event.attempt,
						outcome: event.outcome,
						discarded: event.discarded,
						errorMessage: event.candidate.message.errorMessage,
					},
				},
			];
		case "retry_scheduled":
			return [
				{
					type: "retry_scheduled",
					payload: { attempt: event.attempt, delayMs: event.delayMs, reason: event.reason },
				},
			];
		case "message_end":
			return [{ type: "message_committed", payload: messagePayload(event.message) }];
		case "tool_execution_start":
			return [{ type: "tool_started", payload: { invocation: event.invocation } }];
		case "tool_execution_end":
			return [
				{
					type: "tool_finished",
					payload: { invocation: event.invocation, outcome: event.outcome, resultMessageId: event.result.id },
				},
				{ type: "message_committed", payload: messagePayload(event.result) },
			];
		case "tool_execution_rejected":
			return [
				{
					type: "tool_finished",
					payload: {
						invocation: event.invocation,
						outcome: "rejected",
						reason: event.reason,
						resultMessageId: event.result.id,
					},
				},
				{ type: "message_committed", payload: messagePayload(event.result) },
			];
		case "turn_end":
			return [{ type: "turn_finished", payload: { outcome: event.outcome } }];
		case "run_end":
			return [{ type: "run_finished", payload: { outcome: event.outcome, failure: event.failure } }];
		default:
			return [];
	}
}

export function descriptorHeader(descriptor: SessionDescriptor): SessionHeader {
	return {
		type: "session",
		version: 1,
		sessionId: descriptor.id,
		workspaceId: descriptor.workspace.id,
		workspacePath: descriptor.workspace.path,
		createdAt: descriptor.createdAt,
	};
}
