import type {
	AgentMessage,
	AgentSeed,
	CompactionCheckpoint,
	FollowUp,
	MessageId,
	RunBudgetExhaustion,
	RunFailure,
	RunOutcome,
	RunSource,
	SessionEvent,
	ToolExecutionOutcome,
	ToolExecutionSettlement,
	ToolInvocation,
	ToolRejectionReason,
} from "@coda/agent";
import type { AssistantMessage, Message, ThinkingLevel } from "@coda/ai";
import type { WorkspaceMcpTrustRecord } from "../mcp/config.ts";
import type { ModelSelection } from "../models/model-selection.ts";
import type { ProjectTrustRecord } from "../settings/types.ts";
import type { ComposerSubmission } from "./composer-submission.ts";
import type { RecoverableFollowUp, RestoredSessionState, SessionDescriptor, SessionToolLifecycle } from "./types.ts";

export interface SessionRecordPayloadMap {
	readonly run_started: {
		readonly source: RunSource;
		readonly queueItemId?: string;
		readonly promptVersion?: string;
		readonly promptSha256?: string;
	};
	readonly run_budget_exhausted: { readonly exhaustion: RunBudgetExhaustion };
	readonly attempt_started: { readonly messageId: string; readonly attempt: number };
	readonly attempt_finished: {
		readonly messageId: string;
		readonly attempt: number;
		readonly outcome: "success" | "error" | "aborted";
		readonly discarded: boolean;
		readonly errorMessage?: string;
		readonly usage?: AssistantMessage["usage"];
	};
	readonly retry_scheduled: { readonly attempt: number; readonly delayMs: number; readonly reason: string };
	readonly message_committed: { readonly message: AgentMessage };
	readonly tool_started: { readonly invocation: ToolInvocation };
	readonly tool_finished:
		| {
				readonly invocation: ToolInvocation;
				readonly settlement: ToolExecutionSettlement;
				readonly outcome: ToolExecutionOutcome;
				readonly resultMessageId: string;
		  }
		| {
				readonly invocation: ToolInvocation;
				readonly outcome: "rejected";
				readonly reason: ToolRejectionReason;
				readonly resultMessageId: string;
		  }
		| {
				readonly invocation: ToolInvocation;
				readonly outcome: "interrupted";
				readonly reason: "skipped_by_user";
				readonly resultMessageId: string;
		  };
	readonly turn_finished: { readonly outcome: RunOutcome };
	readonly run_finished:
		| { readonly outcome: RunOutcome; readonly failure?: RunFailure }
		| { readonly outcome: "interrupted"; readonly reason: "process_ended_before_run_finished" };
	readonly follow_up_enqueued: { readonly item: FollowUp };
	readonly follow_up_consumed: { readonly id: string };
	readonly follow_up_canceled: { readonly id: string };
	readonly follow_up_reclaimed: { readonly id: string };
	readonly composer_submission_recorded: { readonly submission: ComposerSubmission };
	readonly composer_submission_retracted: { readonly id: string };
	readonly model_selected: { readonly model: ModelSelection; readonly reasoning: ThinkingLevel | "off" };
	readonly project_trust_changed: { readonly trust: ProjectTrustRecord };
	readonly mcp_trust_changed: { readonly trust: WorkspaceMcpTrustRecord };
	readonly context_compacted: { readonly checkpoint: CompactionCheckpoint };
}

export type SessionRecordType = keyof SessionRecordPayloadMap;

export const SUPPORTED_SESSION_FORMAT_VERSIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
export type SessionFormatVersion = (typeof SUPPORTED_SESSION_FORMAT_VERSIONS)[number];
export const CURRENT_SESSION_FORMAT_VERSION = 10 satisfies SessionFormatVersion;

/** Runtime metadata is compile-time checked against the complete payload algebra. */
export const SESSION_RECORD_INTRODUCED_VERSIONS = Object.freeze({
	run_started: 1,
	run_budget_exhausted: 10,
	attempt_started: 1,
	attempt_finished: 1,
	retry_scheduled: 1,
	message_committed: 1,
	tool_started: 1,
	tool_finished: 1,
	turn_finished: 1,
	run_finished: 1,
	follow_up_enqueued: 1,
	follow_up_consumed: 1,
	follow_up_canceled: 1,
	follow_up_reclaimed: 3,
	composer_submission_recorded: 4,
	composer_submission_retracted: 4,
	model_selected: 1,
	project_trust_changed: 1,
	mcp_trust_changed: 6,
	context_compacted: 7,
} satisfies Readonly<Record<SessionRecordType, SessionFormatVersion>>);

export const SESSION_RECORD_TYPES = Object.freeze(
	Object.keys(SESSION_RECORD_INTRODUCED_VERSIONS) as SessionRecordType[],
);

export interface SessionHeader {
	readonly type: "session";
	readonly version: SessionFormatVersion;
	readonly sessionId: string;
	readonly workspaceId: string;
	readonly workspacePath: string;
	readonly createdAt: number;
}

interface SessionRecordEnvelope {
	readonly recordId: string;
	readonly sessionId: string;
	readonly sequence: number;
	readonly previousRecordId: string | null;
	readonly timestamp: number;
	readonly runId?: string;
	readonly turnId?: string;
	readonly attemptId?: string;
}

export type SessionRecordOf<Type extends SessionRecordType> = Type extends SessionRecordType
	? SessionRecordEnvelope & { readonly type: Type; readonly payload: SessionRecordPayloadMap[Type] }
	: never;

export type SessionRecord = SessionRecordOf<SessionRecordType>;

export type SessionRecordInputOf<Type extends SessionRecordType> = Type extends SessionRecordType
	? { readonly type: Type; readonly payload: SessionRecordPayloadMap[Type] }
	: never;

export type SessionRecordInput = SessionRecordInputOf<SessionRecordType>;

export interface ReducedSession {
	readonly seed: AgentSeed;
	readonly recoverableFollowUps: readonly RecoverableFollowUp[];
	readonly composerSubmissions: readonly ComposerSubmission[];
	readonly restored: RestoredSessionState;
	readonly toolInvocations: readonly SessionToolLifecycle[];
	readonly startedTools: ReadonlyMap<string, SessionRecordOf<"tool_started">>;
	readonly activeRuns: ReadonlySet<string>;
	readonly compactionCheckpoint?: CompactionCheckpoint;
	readonly discardedModelCost?: number;
}

function persistedMessage(message: AgentMessage): AgentMessage {
	const snapshot = structuredClone(message) as AgentMessage;
	if (snapshot.message.role === "assistant") {
		const mutableDiagnostics = snapshot.message.diagnostics as Array<{ error?: { stack?: string } }> | undefined;
		for (const diagnostic of mutableDiagnostics ?? []) {
			if (diagnostic.error) delete diagnostic.error.stack;
		}
	}
	if (snapshot.message.role === "toolResult" && isMcpToolName(snapshot.message.toolName)) {
		const mutable = snapshot.message as typeof snapshot.message & { details?: unknown };
		mutable.details = persistedMcpDetails(mutable.details);
	}
	return snapshot;
}

function isMcpToolName(toolName: string): boolean {
	return toolName.startsWith("mcp__");
}

function persistedMcpInvocation(invocation: ToolInvocation): ToolInvocation {
	if (!isMcpToolName(invocation.toolName)) return invocation;
	const keys = Object.keys(invocation.arguments).sort();
	return {
		...invocation,
		arguments: {
			_codaMcpRedacted: true,
			keys: keys.slice(0, 64),
			keyCount: keys.length,
		},
	};
}

function persistedMcpDetails(value: unknown): unknown {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const details = value as Record<string, unknown>;
	return {
		...(details.kind === "mcp" ? { kind: "mcp" } : {}),
		...(typeof details.catalogRevision === "number" ? { catalogRevision: details.catalogRevision } : {}),
		...(typeof details.serverId === "string" ? { serverId: details.serverId.slice(0, 64) } : {}),
		...(typeof details.remoteToolName === "string" ? { remoteToolName: details.remoteToolName.slice(0, 256) } : {}),
		...(Array.isArray(details.contentTypes)
			? {
					contentTypes: details.contentTypes
						.filter((item): item is string => typeof item === "string")
						.slice(0, 16),
				}
			: {}),
		...(typeof details.hasStructuredContent === "boolean"
			? { hasStructuredContent: details.hasStructuredContent }
			: {}),
		...(typeof details.truncated === "boolean" ? { truncated: details.truncated } : {}),
	};
}

export function messagePayload(message: AgentMessage): SessionRecordPayloadMap["message_committed"] {
	return { message: persistedMessage(message) };
}

export function compactionPayload(checkpoint: CompactionCheckpoint): SessionRecordPayloadMap["context_compacted"] {
	return {
		checkpoint: {
			...structuredClone(checkpoint),
			replacementHistory: checkpoint.replacementHistory.map((message) => persistedMessage(message)),
		},
	};
}

export function reduceSession(records: readonly SessionRecord[]): ReducedSession {
	const messages = new Map<string, AgentMessage>();
	const followUps = new Map<
		string,
		{
			item: FollowUp;
			state: "paused" | "consumed" | "running" | "failed";
			failure?: RunFailure;
			messageId?: MessageId;
		}
	>();
	const followUpRuns = new Map<string, string>();
	const startedTools = new Map<string, SessionRecordOf<"tool_started">>();
	const toolInvocations = new Map<string, SessionToolLifecycle>();
	const activeRuns = new Set<string>();
	const composerSubmissions = new Map<string, ComposerSubmission>();
	const legacyComposerSubmissions: Array<{ readonly sequence: number; readonly submission: ComposerSubmission }> = [];
	let firstComposerSubmissionSequence: number | undefined;
	let model: ModelSelection | undefined;
	let reasoning: RestoredSessionState["reasoning"];
	let compactionCheckpoint: CompactionCheckpoint | undefined;
	let discardedModelCost: number | undefined = 0;

	for (const record of records) {
		switch (record.type) {
			case "message_committed": {
				const message = record.payload.message as AgentMessage<Message>;
				if (message?.id) {
					messages.set(message.id, structuredClone(message));
					const queueItemId = record.runId ? followUpRuns.get(record.runId) : undefined;
					const followUp = queueItemId ? followUps.get(queueItemId) : undefined;
					if (followUp && followUp.messageId === undefined && message.message.role === "user") {
						followUp.messageId = message.id;
					}
					const text = legacyComposerText(message);
					if (text !== undefined) {
						legacyComposerSubmissions.push({
							sequence: record.sequence,
							submission: {
								id: `legacy:${message.id}`,
								kind: "prompt",
								text,
							},
						});
					}
				}
				break;
			}
			case "attempt_finished": {
				if (record.payload.discarded !== true) break;
				const usage = record.payload.usage;
				if (!usage || !usage.cost) discardedModelCost = undefined;
				else if (discardedModelCost !== undefined) discardedModelCost += usage.cost.total;
				break;
			}
			case "composer_submission_recorded": {
				firstComposerSubmissionSequence ??= record.sequence;
				const submission = record.payload.submission;
				if (submission?.id) composerSubmissions.set(submission.id, structuredClone(submission));
				break;
			}
			case "composer_submission_retracted":
				composerSubmissions.delete(record.payload.id);
				break;
			case "follow_up_enqueued": {
				const item = record.payload.item;
				if (item?.id) followUps.set(item.id, { item: structuredClone(item), state: "paused" });
				break;
			}
			case "follow_up_consumed": {
				const id = record.payload.id;
				if (typeof id === "string") {
					const followUp = followUps.get(id);
					if (followUp) followUp.state = "consumed";
				}
				break;
			}
			case "follow_up_canceled":
			case "follow_up_reclaimed":
				followUps.delete(record.payload.id);
				break;
			case "model_selected":
				model = structuredClone(record.payload.model);
				reasoning = record.payload.reasoning;
				break;
			case "project_trust_changed":
			case "mcp_trust_changed":
				// Trust records are audit facts. Only current settings may authorize local content or processes.
				break;
			case "context_compacted": {
				compactionCheckpoint = structuredClone(record.payload.checkpoint);
				break;
			}
			case "tool_started": {
				const invocation = record.payload.invocation;
				if (typeof invocation?.id === "string") {
					startedTools.set(invocation.id, record);
					toolInvocations.set(invocation.id, {
						invocation: structuredClone(invocation),
						...(record.runId ? { runId: record.runId } : {}),
						...(record.turnId ? { turnId: record.turnId } : {}),
						startedAt: record.timestamp,
					});
				}
				break;
			}
			case "tool_finished": {
				const invocation = record.payload.invocation;
				if (typeof invocation?.id === "string") {
					const started = toolInvocations.get(invocation.id);
					const outcome = record.payload.outcome;
					const settlement = "settlement" in record.payload ? record.payload.settlement : undefined;
					const rejectionReason = record.payload.outcome === "rejected" ? record.payload.reason : undefined;
					toolInvocations.set(invocation.id, {
						invocation: structuredClone(invocation),
						...((record.runId ?? started?.runId) ? { runId: record.runId ?? started?.runId } : {}),
						...((record.turnId ?? started?.turnId) ? { turnId: record.turnId ?? started?.turnId } : {}),
						...(started?.startedAt !== undefined ? { startedAt: started.startedAt } : {}),
						finishedAt: record.timestamp,
						...(settlement ? { settlement } : {}),
						...(outcome ? { outcome } : {}),
						...(rejectionReason ? { rejectionReason } : {}),
						resultMessageId: record.payload.resultMessageId as MessageId,
					});
					startedTools.delete(invocation.id);
				}
				break;
			}
			case "run_started": {
				if (record.runId) activeRuns.add(record.runId);
				if (record.runId && record.payload.source === "follow_up" && record.payload.queueItemId) {
					followUpRuns.set(record.runId, record.payload.queueItemId);
					const followUp = followUps.get(record.payload.queueItemId);
					if (followUp) followUp.state = "running";
				}
				break;
			}
			case "run_finished": {
				if (record.runId) activeRuns.delete(record.runId);
				const queueItemId = record.runId ? followUpRuns.get(record.runId) : undefined;
				const followUp = queueItemId ? followUps.get(queueItemId) : undefined;
				if (followUp) {
					if (record.payload.outcome === "success") followUps.delete(followUp.item.id);
					else if (record.payload.outcome === "error") {
						followUp.state = "failed";
						followUp.failure = "failure" in record.payload ? record.payload.failure : undefined;
					} else followUp.state = "paused";
				}
				if (record.runId) followUpRuns.delete(record.runId);
				break;
			}
			case "run_budget_exhausted":
			case "attempt_started":
			case "retry_scheduled":
			case "turn_finished":
				break;
		}
	}
	return {
		seed: {
			version: 1,
			messages: [...messages.values()],
			pendingFollowUps: [...followUps.values()]
				.filter(({ state }) => state !== "failed")
				.map(({ item }) => structuredClone(item)),
		},
		recoverableFollowUps: [...followUps.values()].map(({ item, state, failure, messageId }) => ({
			item: structuredClone(item),
			state: state === "failed" ? "failed" : "paused",
			...(failure ? { failure: structuredClone(failure) } : {}),
			...(messageId ? { messageId } : {}),
		})),
		composerSubmissions: [
			...legacyComposerSubmissions
				.filter(
					({ sequence }) =>
						firstComposerSubmissionSequence === undefined || sequence < firstComposerSubmissionSequence,
				)
				.map(({ submission }) => submission),
			...composerSubmissions.values(),
		].map((submission) => structuredClone(submission)),
		restored: { model, reasoning },
		toolInvocations: [...toolInvocations.values()].map((lifecycle) => structuredClone(lifecycle)),
		startedTools,
		activeRuns,
		...(discardedModelCost !== undefined ? { discardedModelCost } : {}),
		...(compactionCheckpoint ? { compactionCheckpoint: structuredClone(compactionCheckpoint) } : {}),
	};
}

export function eventRecordInputs(
	event: SessionEvent,
	preparedRun: { readonly promptVersion: string; readonly promptSha256: string } | undefined,
): readonly SessionRecordInput[] {
	switch (event.type) {
		case "run_start": {
			const lifecycle = event.queueItemId
				? [{ type: "follow_up_consumed" as const, payload: { id: event.queueItemId } }]
				: [];
			return [
				...lifecycle,
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
		}
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
						usage: event.candidate.message.usage,
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
			return [{ type: "tool_started", payload: { invocation: persistedMcpInvocation(event.invocation) } }];
		case "tool_execution_end":
			return [
				{
					type: "tool_finished",
					payload: {
						invocation: persistedMcpInvocation(event.invocation),
						settlement: event.settlement,
						outcome: event.outcome,
						resultMessageId: event.result.id,
					},
				},
				{ type: "message_committed", payload: messagePayload(event.result) },
			];
		case "tool_execution_rejected":
			return [
				{
					type: "tool_finished",
					payload: {
						invocation: persistedMcpInvocation(event.invocation),
						outcome: "rejected",
						reason: event.reason,
						resultMessageId: event.result.id,
					},
				},
				{ type: "message_committed", payload: messagePayload(event.result) },
			];
		case "turn_end":
			return [{ type: "turn_finished", payload: { outcome: event.outcome } }];
		case "run_budget_exhausted":
			return [{ type: "run_budget_exhausted", payload: { exhaustion: event.exhaustion } }];
		case "run_end":
			return [{ type: "run_finished", payload: { outcome: event.outcome, failure: event.failure } }];
	}
	const exhaustive: never = event;
	return exhaustive;
}

export function descriptorHeader(descriptor: SessionDescriptor): SessionHeader {
	return {
		type: "session",
		version: CURRENT_SESSION_FORMAT_VERSION,
		sessionId: descriptor.id,
		workspaceId: descriptor.workspace.id,
		workspacePath: descriptor.workspace.path,
		createdAt: descriptor.createdAt,
	};
}

function legacyComposerText(message: AgentMessage<Message>): string | undefined {
	if (message.message.role !== "user") return undefined;
	const content = message.message.content;
	const text =
		typeof content === "string"
			? content
			: content
					.filter((entry) => entry.type === "text")
					.map((entry) => entry.text)
					.join("");
	if (text.trim().length === 0) return undefined;
	return text.startsWith("!") ? `\\${text}` : text;
}
