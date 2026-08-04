// Supervisor-owned Runtime ports. Thread execution contracts are canonically owned by
// `session` and re-exported here for the public Runtime composition surface.

import type {
  DerivedOpId,
  DerivedOpPurpose,
  ExternalOpId,
  ModelConfig,
  ModelRef,
  OpId,
  OpReceipt,
  ResolvedAbortTarget,
  RunId,
  RuntimeOp,
  RuntimeDiffFile,
  ThreadId,
  ThreadSummary,
  TurnId,
  WorkspaceId,
  WorkspaceWriteFence,
  WorkspaceWriteFenceValidation,
} from '../protocol/index.js';
import type {
  ThreadIdentityPort,
} from '../session/thread-runtime-ports.js';
import type {
  ThreadSeedRecord,
  ThreadJournalAppendPort,
  ThreadMetaRecord,
} from '../session/thread-journal-records.js';
import type { PolicyGrantRepository } from '../capabilities/types.js';

export type {
  PermissionPolicyPort,
  PreparedThreadDriverCommand,
  RecoveryQueueCommand,
  RuntimeClock,
  ThreadDriverHostServices,
  ThreadCompactionCheckpoint,
  RuntimeThreadDriverAttachment,
  RuntimeThreadDriverFactory,
  ThreadDriverCheckpoint,
  ThreadDriverCheckpointMutation,
  ThreadDriverCompletion,
  ThreadDriverDispatch,
  ThreadDriverEvent,
  ThreadDriverPort,
  ThreadIdentityPort,
} from '../session/thread-runtime-ports.js';
export type {
  ActivityRecoveryMutation,
  ControlMutation,
  IdentityPrepareRecord,
  InputOwnershipMutation,
  MailboxMutation,
  MailboxPrepareRecord,
  ModelSelectionMutation,
  RuleScopeMutation,
  RunMutation,
  RuntimeJournalRecord,
  RuntimeThreadMutation,
  ThreadCommitRecord,
  ThreadJournalAppendPort,
  ThreadMetaRecord,
  ThreadResultDeliveryRecord,
  ThreadResultOutboxMutation,
  ThreadSeedRecord,
  TranscriptMutation,
  TurnMutation,
} from '../session/thread-journal-records.js';

export interface RuntimeIdentityFactory extends ThreadIdentityPort {
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

/**
 * Optional workspace inspection owned by the composition root. Runtime snapshots and validates
 * the result before exposing it; terminal frontends never invoke Git or repositories directly.
 */
export interface RuntimeWorkspaceReviewPort {
  snapshotGit(input: {
    readonly workspaceId: WorkspaceId;
    readonly cwd: string;
  }): Promise<{ readonly branch?: string; readonly dirty: boolean }>;
  snapshotDiff(input: {
    readonly workspaceId: WorkspaceId;
    readonly cwd: string;
  }): Promise<readonly Readonly<RuntimeDiffFile>[]>;
}

export interface SupervisorLease extends WorkspaceWriteFence {
  readonly processEpoch: string;
}

export interface ThreadCatalogRecord {
  readonly summary: ThreadSummary;
  readonly format: 'runtime-v2';
  readonly storageKey: string;
}

export interface StoredThreadLocator {
  readonly ownerWorkspaceId: WorkspaceId;
  readonly ownerRecordedCwd: string;
  readonly threadId: ThreadId;
  readonly catalog: ThreadCatalogRecord;
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
  /** Stable nested prompt operation used to finish conversation_retry after recovery. */
  readonly retryPromptOpId?: ExternalOpId;
  /** Immutable source message selected when conversation_retry first reserves its root op. */
  readonly retryPrompt?: {
    readonly messageId: string;
    readonly turnId: TurnId;
    readonly text: string;
    readonly digest: string;
  };
  /** A source-dependent rejection is frozen with the reservation for deterministic replay. */
  readonly retryRejectionReason?:
    | 'source_thread_not_found'
    | 'source_thread_busy'
    | 'retry_turn_not_found'
    | 'retry_requires_text_prompt';
  readonly state: 'reserved' | 'final';
  readonly receipt?: OpReceipt;
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

export interface ThreadJournalPort extends ThreadJournalAppendPort {
  acquireWriteLease(lease: Readonly<SupervisorLease>): Promise<void>;
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
      readonly initialRecords?: readonly ThreadSeedRecord[];
    },
  ): Promise<ThreadJournalPort>;
  openThreadJournal(threadId: ThreadId): Promise<ThreadJournalPort | undefined>;
  openPolicyGrantRepository?(
    lease: Readonly<SupervisorLease>,
  ): Promise<PolicyGrantRepository>;
  close(): Promise<void>;
}

export interface RuntimeStoragePort {
  listStoredThreads(): Promise<readonly StoredThreadLocator[]>;
  openWorkspace(input: {
    readonly cwd: string;
    readonly workspaceId?: WorkspaceId;
  }): Promise<RuntimeWorkspaceStoragePort>;
}
