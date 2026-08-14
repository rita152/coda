import type {
	AgentEvent,
	AgentMessage,
	AgentSeed,
	FollowUp,
	MessageId,
	RunFailure,
	ToolInvocation,
	ToolRejectionReason,
} from "@coda/agent";
import type { Message } from "@coda/ai";
import type { CompactionCheckpoint, ModelSelection } from "@coda/runtime";
import type { ComposerSubmission } from "../interactive/input-types.ts";
import type { RecoverableFollowUp, RestoredSessionState, SessionDescriptor, SessionToolLifecycle } from "./types.ts";

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
	"follow_up_reclaimed",
	"composer_submission_recorded",
	"composer_submission_retracted",
	"model_selected",
	"project_trust_changed",
	"mcp_trust_changed",
	"context_compacted",
] as const;

export type SessionRecordType = (typeof SESSION_RECORD_TYPES)[number];

export const SUPPORTED_SESSION_FORMAT_VERSIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
export type SessionFormatVersion = (typeof SUPPORTED_SESSION_FORMAT_VERSIONS)[number];
export const CURRENT_SESSION_FORMAT_VERSION = 9 satisfies SessionFormatVersion;

export interface SessionHeader {
	readonly type: "session";
	readonly version: SessionFormatVersion;
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
	readonly recoverableFollowUps: readonly RecoverableFollowUp[];
	readonly composerSubmissions: readonly ComposerSubmission[];
	readonly restored: RestoredSessionState;
	readonly toolInvocations: readonly SessionToolLifecycle[];
	readonly startedTools: ReadonlyMap<string, SessionRecord>;
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

export function messagePayload(message: AgentMessage): { readonly message: AgentMessage } {
	return { message: persistedMessage(message) };
}

export function compactionPayload(checkpoint: CompactionCheckpoint): { readonly checkpoint: CompactionCheckpoint } {
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
	const startedTools = new Map<string, SessionRecord>();
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
		const payload = record.payload as Record<string, unknown>;
		switch (record.type) {
			case "message_committed": {
				const message = payload.message as AgentMessage<Message>;
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
				if (payload.discarded !== true) break;
				const usage = payload.usage as Extract<Message, { role: "assistant" }>["usage"] | undefined;
				if (!usage || !usage.cost) discardedModelCost = undefined;
				else if (discardedModelCost !== undefined) discardedModelCost += usage.cost.total;
				break;
			}
			case "composer_submission_recorded": {
				firstComposerSubmissionSequence ??= record.sequence;
				const submission = payload.submission as ComposerSubmission;
				if (submission?.id) composerSubmissions.set(submission.id, structuredClone(submission));
				break;
			}
			case "composer_submission_retracted":
				if (typeof payload.id === "string") composerSubmissions.delete(payload.id);
				break;
			case "follow_up_enqueued": {
				const item = payload.item as FollowUp;
				if (item?.id) followUps.set(item.id, { item: structuredClone(item), state: "paused" });
				break;
			}
			case "follow_up_consumed": {
				const id = payload.id;
				if (typeof id === "string") {
					const followUp = followUps.get(id);
					if (followUp) followUp.state = "consumed";
				}
				break;
			}
			case "follow_up_canceled":
			case "follow_up_reclaimed":
				if (typeof payload.id === "string") followUps.delete(payload.id);
				break;
			case "model_selected":
				model = structuredClone(payload.model as ModelSelection);
				reasoning = payload.reasoning as RestoredSessionState["reasoning"];
				break;
			case "project_trust_changed":
			case "mcp_trust_changed":
				// Trust records are audit facts. Only current settings may authorize local content or processes.
				break;
			case "context_compacted": {
				const checkpoint = payload.checkpoint as CompactionCheckpoint | undefined;
				if (checkpoint) compactionCheckpoint = structuredClone(checkpoint);
				break;
			}
			case "tool_started": {
				const invocation = payload.invocation as ToolInvocation | undefined;
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
				const invocation = payload.invocation as ToolInvocation | undefined;
				if (typeof invocation?.id === "string") {
					const started = toolInvocations.get(invocation.id);
					const outcome = payload.outcome as SessionToolLifecycle["outcome"];
					const settlement = payload.settlement as SessionToolLifecycle["settlement"];
					const rejectionReason = payload.reason as ToolRejectionReason | undefined;
					toolInvocations.set(invocation.id, {
						invocation: structuredClone(invocation),
						...((record.runId ?? started?.runId) ? { runId: record.runId ?? started?.runId } : {}),
						...((record.turnId ?? started?.turnId) ? { turnId: record.turnId ?? started?.turnId } : {}),
						...(started?.startedAt !== undefined ? { startedAt: started.startedAt } : {}),
						finishedAt: record.timestamp,
						...(settlement ? { settlement } : {}),
						...(outcome ? { outcome } : {}),
						...(rejectionReason ? { rejectionReason } : {}),
						...(typeof payload.resultMessageId === "string"
							? { resultMessageId: payload.resultMessageId as MessageId }
							: {}),
					});
					startedTools.delete(invocation.id);
				}
				break;
			}
			case "run_started": {
				if (record.runId) activeRuns.add(record.runId);
				if (record.runId && payload.source === "follow_up" && typeof payload.queueItemId === "string") {
					followUpRuns.set(record.runId, payload.queueItemId);
					const followUp = followUps.get(payload.queueItemId);
					if (followUp) followUp.state = "running";
				}
				break;
			}
			case "run_finished": {
				if (record.runId) activeRuns.delete(record.runId);
				const queueItemId = record.runId ? followUpRuns.get(record.runId) : undefined;
				const followUp = queueItemId ? followUps.get(queueItemId) : undefined;
				if (followUp) {
					if (payload.outcome === "success") followUps.delete(followUp.item.id);
					else if (payload.outcome === "error") {
						followUp.state = "failed";
						followUp.failure = payload.failure as RunFailure | undefined;
					} else followUp.state = "paused";
				}
				if (record.runId) followUpRuns.delete(record.runId);
				break;
			}
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
	event: AgentEvent,
	preparedRun: { readonly promptVersion: string; readonly promptSha256: string } | undefined,
): readonly { type: SessionRecordType; payload: unknown }[] {
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
		case "run_end":
			return [{ type: "run_finished", payload: { outcome: event.outcome, failure: event.failure } }];
		default:
			return [];
	}
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
