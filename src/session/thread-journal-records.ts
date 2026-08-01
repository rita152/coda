// Durable per-thread journal grammar. It is independent of Supervisor ownership/fencing.

import type {
  AgentMessage,
  ControlResponseDecision,
  DerivedOpId,
  EventEnvelope,
  ExternalOpId,
  MailboxRuntimeOp,
  ModelRef,
  OpId,
  PermissionCeilingSnapshot,
  ResolvedAbortTarget,
  RunId,
  RuntimeEvent,
  ThreadDriverRef,
  ThreadId,
  ThreadUsage,
  TurnId,
  WorkspaceId,
} from '../protocol/index.js';
import type { TranscriptJournalPort } from './transcript-repository.js';
import type { ThreadCompactionCheckpoint } from './thread-runtime-ports.js';

export interface ThreadMetaRecord {
  readonly type: 'thread_meta';
  readonly version: 2;
  readonly protocolVersion: string;
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly parentThreadId?: ThreadId;
  readonly createdByRunId?: RunId;
  readonly createdByOpId?: ExternalOpId;
  readonly permissionCeiling: PermissionCeilingSnapshot;
  readonly createdAt: number;
  readonly cwd: string;
  readonly model: ModelRef;
  readonly driverRef?: ThreadDriverRef;
}

export interface LegacyThreadSeedRecord {
  readonly type: 'legacy_seed';
  readonly sourceSessionId: string;
  readonly transcript: readonly AgentMessage[];
  /**
   * Direct-Session sidecars keep the active (possibly compacted) transcript above for compatibility,
   * but recovery also needs the exact raw v1 mirror prefix that existed when the sidecar was born.
   * Canonical Runtime imports omit this standalone-only field because their transcript is already
   * the complete audit transcript.
   */
  readonly mirrorRecords?: readonly LegacyMirrorRecord[];
  readonly usage: ThreadUsage;
  readonly compaction?: ThreadCompactionCheckpoint;
}

export type LegacyMirrorRecord =
  | { readonly type: 'message'; readonly message: AgentMessage }
  | ({ readonly type: 'compaction' } & ThreadCompactionCheckpoint);

export interface MailboxPrepareRecord {
  readonly type: 'mailbox_prepare';
  readonly opId: OpId;
  readonly op: MailboxRuntimeOp;
  readonly timestamp: number;
}

export type IdentityPrepareRecord =
  | {
      readonly type: 'successor_run_prepare';
      readonly runId: RunId;
      readonly predecessorRunId: RunId;
      readonly reason: 'retry' | 'compaction';
      readonly permissionCeiling: PermissionCeilingSnapshot;
      readonly timestamp: number;
    }
  | {
      readonly type: 'turn_prepare';
      readonly runId: RunId;
      readonly turnId: TurnId;
      readonly turnOrdinal: number;
      readonly workspaceCeiling: PermissionCeilingSnapshot;
      readonly runCeiling: PermissionCeilingSnapshot;
      readonly turnCeiling: PermissionCeilingSnapshot;
      readonly timestamp: number;
    };

export type MailboxMutation =
  | {
      readonly type: 'accepted_pending';
      readonly opId: OpId;
      readonly opType: Exclude<MailboxRuntimeOp['type'], 'abort'>;
    }
  | {
      readonly type: 'accepted_pending';
      readonly opId: OpId;
      readonly opType: 'abort';
      readonly resolvedTarget: ResolvedAbortTarget;
      readonly parentOpId?: ExternalOpId;
    }
  | { readonly type: 'started'; readonly opId: OpId }
  | {
      readonly type: 'completed';
      readonly opId: OpId;
      readonly outcome: 'applied' | 'no_op' | 'interrupted' | 'superseded';
    }
  | { readonly type: 'rejected'; readonly opId: OpId; readonly reason: string };

export type InputOwnershipMutation =
  | { readonly type: 'input_materialized'; readonly ownerOpId: OpId; readonly messageId: string }
  | { readonly type: 'input_transferred'; readonly fromOpId: OpId; readonly toOpId: OpId }
  | { readonly type: 'input_cancelled'; readonly ownerOpId: OpId; readonly byAbortOpId: OpId };

export type TranscriptMutation =
  | { readonly type: 'message_appended'; readonly message: AgentMessage }
  | { readonly type: 'compaction_committed'; readonly compaction: ThreadCompactionCheckpoint };

export type ControlMutation =
  | {
      readonly type: 'control_requested';
      readonly request: Extract<RuntimeEvent, { type: 'control_request' }>;
    }
  | {
      readonly type: 'control_response_claimed';
      readonly requestId: string;
      readonly responseOpId: ExternalOpId;
      readonly decision: ControlResponseDecision;
      readonly acceptedAt: number;
    }
  | {
      readonly type: 'control_response_claim_released';
      readonly requestId: string;
      readonly responseOpId: ExternalOpId;
      readonly reason: 'effect_definitely_not_applied';
    }
  | {
      readonly type: 'control_resolved';
      readonly resolution: Extract<RuntimeEvent, { type: 'control_resolved' }>;
    };

export type RunMutation =
  | {
      readonly type: 'run_reserved';
      readonly runId: RunId;
      readonly ownerOpId: OpId;
      readonly reason: 'prompt';
      readonly permissionCeiling: PermissionCeilingSnapshot;
    }
  | {
      readonly type: 'run_reserved';
      readonly runId: RunId;
      readonly ownerOpId: OpId;
      readonly reason: 'continue';
      readonly predecessorRunId?: RunId;
      readonly permissionCeiling: PermissionCeilingSnapshot;
    }
  | {
      readonly type: 'run_reserved';
      readonly runId: RunId;
      readonly predecessorRunId: RunId;
      readonly reason: 'retry' | 'compaction';
      readonly permissionCeiling: PermissionCeilingSnapshot;
    }
  | { readonly type: 'run_started'; readonly runId: RunId }
  | {
      readonly type: 'run_terminal';
      readonly runId: RunId;
      readonly status: 'completed' | 'aborted' | 'error' | 'interrupted';
    };

export interface TurnMutation {
  readonly type: 'turn_activated';
  readonly runId: RunId;
  readonly turnId: TurnId;
  readonly turnOrdinal: number;
}

export interface ActivityRecoveryMutation {
  readonly type: 'activity_interrupted';
  readonly rootOpId: OpId;
  readonly rootRunId: RunId;
  readonly terminalRunId: RunId;
  readonly terminalTurnId?: TurnId;
  readonly discardedPartialAssistantId?: string;
  readonly discardedStartedToolCallIds: readonly string[];
}

export interface ModelSelectionMutation {
  readonly type: 'model_selected';
  readonly ownerOpId: OpId;
  readonly model: ModelRef;
}

export interface RuleScopeMutation {
  readonly type: 'rule_scope_observed';
  readonly scope: string;
  readonly owningTurnId: TurnId;
  readonly invocationId: string;
}

/**
 * Consumes one durable hint window and installs its successor atomically with the next turn.
 * `consumedScopes` is an optimistic witness: recovery rejects a replacement that does not match
 * the window produced by all preceding `rule_scope_observed` mutations.
 */
export interface RuleScopeWindowMutation {
  readonly type: 'rule_scope_window_replaced';
  readonly consumedScopes: readonly string[];
  readonly replacementScopes: readonly string[];
  readonly owningTurnId: TurnId;
}

export interface ThreadResultOutboxMutation {
  readonly type: 'thread_result_pending';
  readonly resultOpId: DerivedOpId;
  readonly parentThreadId: ThreadId;
  readonly childThreadId: ThreadId;
  readonly terminalRunId: RunId;
  readonly status: 'completed' | 'aborted' | 'error';
  readonly summary?: string;
}

export type RuntimeThreadMutation =
  | TranscriptMutation
  | MailboxMutation
  | InputOwnershipMutation
  | ThreadResultOutboxMutation
  | ControlMutation
  | RunMutation
  | TurnMutation
  | ActivityRecoveryMutation
  | RuleScopeMutation
  | RuleScopeWindowMutation
  | ModelSelectionMutation;

export interface ThreadResultDeliveryRecord {
  readonly type: 'thread_result_delivered';
  readonly resultOpId: DerivedOpId;
  readonly parentThreadId: ThreadId;
  readonly parentCommitSeq: number;
}

export interface ThreadCommitRecord {
  readonly type: 'commit';
  readonly firstSeq: number;
  readonly envelopes: readonly [EventEnvelope, ...EventEnvelope[]];
  readonly mutations?: readonly RuntimeThreadMutation[];
}

export type RuntimeJournalRecord =
  | ThreadMetaRecord
  | LegacyThreadSeedRecord
  | MailboxPrepareRecord
  | IdentityPrepareRecord
  | ThreadResultDeliveryRecord
  | ThreadCommitRecord;

export type ThreadJournalAppendPort = TranscriptJournalPort<RuntimeJournalRecord>;
