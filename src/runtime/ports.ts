// Phase-1 embeddable Runtime ports. Core depends only on protocol values and these injected
// storage/model/policy/driver boundaries; it never imports Session, a provider, a tool, or CLI.

import type {
  AgentMessage,
  DerivedOpId,
  DerivedOpPurpose,
  EventEnvelope,
  ExternalOpId,
  MailboxRuntimeOp,
  ModelConfig,
  ModelRef,
  OpId,
  PermissionCeilingSnapshot,
  PermissionNarrowing,
  PlanStep,
  QueuedMessage,
  ResolvedAbortTarget,
  ResolvedRunInput,
  RunId,
  RuntimeEvent,
  RuntimeOp,
  ThreadDriverRef,
  ThreadId,
  ThreadSnapshot,
  ThreadSummary,
  ThreadUsage,
  TurnId,
  WorkspaceId,
  WorkspaceWriteFence,
  WorkspaceWriteFenceValidation,
} from '../protocol/index.js';

export interface RuntimeClock {
  now(): number;
}

export interface RuntimeIdentityFactory {
  newThreadId(): ThreadId;
  newRunId(): RunId;
  newTurnId(): TurnId;
  newOpId(): ExternalOpId;
  newProcessEpoch(): string;
  deriveOpId(input: {
    readonly purpose: DerivedOpPurpose;
    readonly workspaceId: WorkspaceId;
    readonly parts: readonly string[];
  }): DerivedOpId;
}

export type ModelResolution =
  | { readonly ok: true; readonly model: ModelConfig }
  | {
      readonly ok: false;
      readonly code: 'model_not_found' | 'credentials_unavailable' | 'invalid_model';
      readonly message: string;
    };

export interface RuntimeModelResolver {
  resolve(ref: ModelRef, context: {
    readonly workspaceId: WorkspaceId;
    readonly threadId: ThreadId;
    readonly opId: OpId;
    readonly signal: AbortSignal;
  }): Promise<ModelResolution>;
}

export interface PermissionPolicyPort {
  snapshotWorkspaceCeiling(input: {
    readonly workspaceId: WorkspaceId;
    readonly cwd: string;
  }): Promise<PermissionCeilingSnapshot>;
  resolveCeiling(input:
    | {
        readonly kind: 'root_thread';
        readonly workspaceId: WorkspaceId;
        readonly threadId: ThreadId;
        readonly workspaceCeiling: PermissionCeilingSnapshot;
        readonly requestedNarrowing?: PermissionNarrowing;
      }
    | {
        readonly kind: 'child_thread';
        readonly workspaceId: WorkspaceId;
        readonly threadId: ThreadId;
        readonly parentThreadId: ThreadId;
        readonly parentRunId?: RunId;
        readonly workspaceCeiling: PermissionCeilingSnapshot;
        readonly parentCeiling: PermissionCeilingSnapshot;
        readonly requestedNarrowing?: PermissionNarrowing;
      }
    | {
        readonly kind: 'run';
        readonly workspaceId: WorkspaceId;
        readonly threadId: ThreadId;
        readonly runId: RunId;
        readonly workspaceCeiling: PermissionCeilingSnapshot;
        readonly threadCeiling: PermissionCeilingSnapshot;
        readonly requestedNarrowing?: PermissionNarrowing;
        readonly predecessorRunId?: RunId;
        readonly predecessorCeiling?: PermissionCeilingSnapshot;
      }
    | {
        readonly kind: 'turn';
        readonly workspaceId: WorkspaceId;
        readonly threadId: ThreadId;
        readonly runId: RunId;
        readonly turnId: TurnId;
        readonly workspaceCeiling: PermissionCeilingSnapshot;
        readonly runCeiling: PermissionCeilingSnapshot;
      }): Promise<PermissionCeilingSnapshot>;
}

export type PreparedThreadDriverCommand =
  | {
      readonly op: Extract<RuntimeOp, { type: 'prompt' }>;
      readonly runId: RunId;
      readonly permissionCeiling: PermissionCeilingSnapshot;
      readonly resolvedInput: Extract<ResolvedRunInput, { kind: 'prompt_input' }>;
    }
  | {
      readonly op: Extract<RuntimeOp, { type: 'continue' }>;
      readonly runId: RunId;
      readonly permissionCeiling: PermissionCeilingSnapshot;
      readonly resolvedInput: ResolvedRunInput;
    }
  | {
      readonly op: Extract<RuntimeOp, { type: 'set_model' }>;
      readonly resolvedModel: ModelConfig;
    }
  | {
      readonly op: Extract<MailboxRuntimeOp, { type: 'abort' }>;
      readonly resolvedTarget: ResolvedAbortTarget;
    }
  | {
      readonly op: Extract<RuntimeOp, { type: 'steer' | 'follow_up' | 'control_response' }>;
    };

export interface RecoveryQueueCommand {
  readonly op: Extract<RuntimeOp, { type: 'steer' | 'follow_up' }>;
}

export interface ThreadDriverEvent {
  readonly event: RuntimeEvent;
  readonly runId?: RunId;
  readonly turnId?: TurnId;
  readonly opId?: OpId;
}

export interface ThreadCompactionCheckpoint {
  readonly id: string;
  readonly timestamp: number;
  readonly tailStartId: string;
  readonly summary: string;
  readonly contextTokensBefore?: number;
}

export interface ThreadDriverCheckpoint {
  readonly frontend: {
    readonly model: Readonly<ModelRef>;
    readonly transcript: readonly AgentMessage[];
    readonly usage: Readonly<ThreadUsage>;
    readonly queues: {
      readonly steering: readonly QueuedMessage[];
      readonly followUp: readonly QueuedMessage[];
    };
    readonly plan: readonly PlanStep[];
    readonly pendingControls: ThreadSnapshot['pendingControls'];
    readonly activity?: ThreadSnapshot['activity'];
  };
  readonly execution: {
    readonly compaction?: ThreadCompactionCheckpoint;
  };
}

export type ThreadDriverCheckpointMutation =
  | { readonly type: 'compaction_committed'; readonly compaction: ThreadCompactionCheckpoint }
  | {
      readonly type: 'activity_interrupted';
      readonly rootOpId: OpId;
      readonly rootRunId: RunId;
      readonly terminalRunId: RunId;
      readonly terminalTurnId?: TurnId;
      readonly discardedPartialAssistantId?: string;
      readonly discardedStartedToolCallIds: readonly string[];
    }
  | { readonly type: 'model_selected'; readonly ownerOpId: OpId; readonly model: ModelRef };

export type ThreadDriverCompletion =
  | { readonly kind: 'operation'; readonly outcome: 'applied' | 'no_op' }
  | {
      readonly kind: 'activity';
      readonly status: 'completed' | 'aborted' | 'error';
      readonly terminalRunId: RunId;
    };

export interface ThreadDriverDispatch {
  readonly completion: Promise<ThreadDriverCompletion>;
}

export interface ThreadDriverHostServices {
  commitEvent(
    event: ThreadDriverEvent,
    checkpointMutation?: ThreadDriverCheckpointMutation,
  ): Promise<void>;
  commitEventBatch(
    events: readonly [ThreadDriverEvent, ...ThreadDriverEvent[]],
    checkpointMutation?: ThreadDriverCheckpointMutation,
  ): Promise<void>;
  reserveSuccessor(input: {
    readonly threadId: ThreadId;
    readonly predecessorRunId: RunId;
    readonly reason: 'retry' | 'compaction';
  }): Promise<{
    readonly runId: RunId;
    readonly permissionCeiling: PermissionCeilingSnapshot;
  }>;
  reserveTurn(input: {
    readonly runId: RunId;
    readonly turnOrdinal: number;
  }): Promise<{
    readonly turnId: TurnId;
    readonly workspaceCeiling: PermissionCeilingSnapshot;
    readonly runCeiling: PermissionCeilingSnapshot;
    readonly turnCeiling: PermissionCeilingSnapshot;
  }>;
}

export interface ThreadDriverAttachment {
  readonly driver: ThreadDriverPort;
  readonly durableRef: ThreadDriverRef;
  readonly initialCheckpoint: ThreadDriverCheckpoint;
}

export interface ThreadDriverPort {
  /** Replays durable queue effects while the attachment is still quarantined. */
  recover(commands: readonly RecoveryQueueCommand[]): Promise<void>;
  activate(): Promise<void>;
  dispatch(command: PreparedThreadDriverCommand): ThreadDriverDispatch;
  interactionState(): 'idle' | 'running' | 'retrying' | 'compacting';
  close(): Promise<void>;
}

export interface ThreadDriverFactory {
  readonly requirements: { readonly approvalMode: 'legacy_session_edge' };
  create(input: {
    readonly workspaceId: WorkspaceId;
    readonly threadId: ThreadId;
    readonly model: ModelConfig;
    readonly permissionCeiling: PermissionCeilingSnapshot;
    readonly parentThreadId?: ThreadId;
    readonly creationKey: string;
  }, host: ThreadDriverHostServices): Promise<ThreadDriverAttachment>;
  resume(input: {
    readonly workspaceId: WorkspaceId;
    readonly threadId: ThreadId;
    readonly model: ModelConfig;
    readonly durableRef: ThreadDriverRef;
    readonly permissionCeiling: PermissionCeilingSnapshot;
    readonly committedCheckpoint?: ThreadDriverCheckpoint;
    readonly usedRequestIds: readonly string[];
  }, host: ThreadDriverHostServices): Promise<ThreadDriverAttachment>;
}

export interface SupervisorLease extends WorkspaceWriteFence {
  readonly processEpoch: string;
}

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
  readonly usage: ThreadUsage;
  readonly compaction?: ThreadCompactionCheckpoint;
}

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
  | { readonly type: 'accepted_pending'; readonly opId: OpId;
      readonly opType: Exclude<MailboxRuntimeOp['type'], 'abort'> }
  | { readonly type: 'accepted_pending'; readonly opId: OpId; readonly opType: 'abort';
      readonly resolvedTarget: ResolvedAbortTarget; readonly parentOpId?: ExternalOpId }
  | { readonly type: 'started'; readonly opId: OpId }
  | { readonly type: 'completed'; readonly opId: OpId;
      readonly outcome: 'applied' | 'no_op' | 'interrupted' | 'superseded' }
  | { readonly type: 'rejected'; readonly opId: OpId; readonly reason: string };

export type InputOwnershipMutation =
  | { readonly type: 'input_materialized'; readonly ownerOpId: OpId; readonly messageId: string }
  | { readonly type: 'input_transferred'; readonly fromOpId: OpId; readonly toOpId: OpId }
  | { readonly type: 'input_cancelled'; readonly ownerOpId: OpId; readonly byAbortOpId: OpId };

export type TranscriptMutation =
  | { readonly type: 'message_appended'; readonly message: AgentMessage }
  | { readonly type: 'compaction_committed'; readonly compaction: ThreadCompactionCheckpoint };

export type ControlMutation =
  | { readonly type: 'control_requested';
      readonly request: Extract<RuntimeEvent, { type: 'control_request' }> }
  | {
      readonly type: 'control_response_claimed';
      readonly requestId: string;
      readonly responseOpId: ExternalOpId;
      readonly decision: import('../protocol/index.js').ControlResponseDecision;
      readonly acceptedAt: number;
    }
  | { readonly type: 'control_response_claim_released'; readonly requestId: string;
      readonly responseOpId: ExternalOpId; readonly reason: 'effect_definitely_not_applied' }
  | { readonly type: 'control_resolved';
      readonly resolution: Extract<RuntimeEvent, { type: 'control_resolved' }> };

export type RunMutation =
  | { readonly type: 'run_reserved'; readonly runId: RunId; readonly ownerOpId: OpId;
      readonly reason: 'prompt'; readonly permissionCeiling: PermissionCeilingSnapshot }
  | { readonly type: 'run_reserved'; readonly runId: RunId; readonly ownerOpId: OpId;
      readonly reason: 'continue'; readonly predecessorRunId?: RunId;
      readonly permissionCeiling: PermissionCeilingSnapshot }
  | { readonly type: 'run_reserved'; readonly runId: RunId; readonly predecessorRunId: RunId;
      readonly reason: 'retry' | 'compaction'; readonly permissionCeiling: PermissionCeilingSnapshot }
  | { readonly type: 'run_started'; readonly runId: RunId }
  | { readonly type: 'run_terminal'; readonly runId: RunId;
      readonly status: 'completed' | 'aborted' | 'error' | 'interrupted' };

export type TurnMutation = {
  readonly type: 'turn_activated'; readonly runId: RunId; readonly turnId: TurnId;
  readonly turnOrdinal: number;
};

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
  readonly type: 'model_selected'; readonly ownerOpId: OpId; readonly model: ModelRef;
}

export interface RuleScopeMutation {
  readonly type: 'rule_scope_observed'; readonly scope: string; readonly owningTurnId: TurnId;
  readonly invocationId: string;
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

export interface ThreadCatalogRecord {
  readonly summary: ThreadSummary;
  readonly format: 'runtime-v2' | 'session-v1';
  readonly storageKey: string;
  readonly driverRef?: ThreadDriverRef;
}

export interface StoredThreadLocator {
  readonly sourceSessionId?: string;
  readonly ownerWorkspaceId: WorkspaceId;
  readonly ownerRecordedCwd: string;
  readonly threadId: ThreadId;
  readonly catalog: ThreadCatalogRecord;
  readonly executionEligibility:
    | { readonly kind: 'mutable' }
    | { readonly kind: 'read_only'; readonly code: 'invalid_legacy_workspace_cwd' };
}

export interface LegacyThreadImport {
  readonly catalog: ThreadCatalogRecord;
  readonly seed: LegacyThreadSeedRecord;
  readonly driverRef: ThreadDriverRef;
}

export interface SupervisorOpLedgerRecord {
  readonly opId: ExternalOpId;
  readonly op: RuntimeOp;
  readonly payloadHash: string;
  readonly targetThreadIds?: readonly ThreadId[];
  readonly resolvedTargets?: readonly {
    readonly threadId: ThreadId;
    readonly target: ResolvedAbortTarget;
    readonly derivedOpId: DerivedOpId;
  }[];
  readonly driverCreation?: {
    readonly creationKey: string;
    readonly driverRef?: ThreadDriverRef;
  };
  readonly state: 'reserved' | 'final';
  readonly receipt?: import('../protocol/index.js').OpReceipt;
}

export type SupervisorOpReservation =
  | { readonly kind: 'reserved'; readonly record: SupervisorOpLedgerRecord }
  | { readonly kind: 'duplicate'; readonly record: SupervisorOpLedgerRecord }
  | { readonly kind: 'conflict'; readonly record: SupervisorOpLedgerRecord };

export interface DerivedOpIdentityClaim {
  readonly opId: DerivedOpId;
  readonly purpose: DerivedOpPurpose;
  readonly workspaceId: WorkspaceId;
  readonly parts: readonly string[];
}

export type DerivedOpIdentityReservation =
  | { readonly kind: 'claimed'; readonly claim: DerivedOpIdentityClaim }
  | { readonly kind: 'duplicate'; readonly claim: DerivedOpIdentityClaim }
  | { readonly kind: 'conflict'; readonly claim: DerivedOpIdentityClaim };

export interface ThreadJournalPort {
  acquireWriteLease(lease: Readonly<SupervisorLease>): Promise<void>;
  load(): Promise<readonly RuntimeJournalRecord[]>;
  append(records: readonly RuntimeJournalRecord[], options: { readonly flush: true }): Promise<void>;
  releaseWriteLease(): Promise<void>;
}

export interface RuntimeWorkspaceStoragePort {
  readonly workspaceId: WorkspaceId;
  readonly recordedCwd: string;
  acquireSupervisorLease(processEpoch: string): Promise<SupervisorLease>;
  releaseSupervisorLease(lease: Readonly<SupervisorLease>): Promise<void>;
  validateWriteFence(fence: Readonly<WorkspaceWriteFence>): Promise<WorkspaceWriteFenceValidation>;
  listThreads(): Promise<readonly ThreadCatalogRecord[]>;
  loadSupervisorOps(): Promise<readonly SupervisorOpLedgerRecord[]>;
  reserveDerivedOpIdentity(
    lease: Readonly<SupervisorLease>,
    claim: DerivedOpIdentityClaim,
  ): Promise<DerivedOpIdentityReservation>;
  reserveSupervisorOp(
    lease: Readonly<SupervisorLease>,
    record: SupervisorOpLedgerRecord,
  ): Promise<SupervisorOpReservation>;
  finalizeSupervisorOp(
    lease: Readonly<SupervisorLease>,
    record: SupervisorOpLedgerRecord,
  ): Promise<void>;
  createThreadJournal(
    lease: Readonly<SupervisorLease>,
    input: {
      readonly threadId: ThreadId;
      readonly meta: ThreadMetaRecord;
      readonly initialRecords?: readonly LegacyThreadSeedRecord[];
    },
  ): Promise<ThreadJournalPort>;
  openThreadJournal(threadId: ThreadId): Promise<ThreadJournalPort | undefined>;
  importLegacyThread(
    lease: Readonly<SupervisorLease>,
    threadId: ThreadId,
  ): Promise<LegacyThreadImport | undefined>;
  close(): Promise<void>;
}

export interface RuntimeStoragePort {
  listStoredThreads(): Promise<readonly StoredThreadLocator[]>;
  openWorkspace(input: {
    readonly cwd: string;
    readonly workspaceId?: WorkspaceId;
  }): Promise<RuntimeWorkspaceStoragePort>;
}
