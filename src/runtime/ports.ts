// Supervisor-owned Runtime ports. Thread execution contracts are canonically owned by
// `session` and re-exported here so Phase-1 imports remain source-compatible.

import type {
  DerivedOpId,
  DerivedOpPurpose,
  ExternalOpId,
  ModelConfig,
  ModelRef,
  OpId,
  OpReceipt,
  PermissionCeilingSnapshot,
  ResolvedAbortTarget,
  RunId,
  RuntimeOp,
  ThreadDriverRef,
  ThreadId,
  ThreadSummary,
  TurnId,
  WorkspaceId,
  WorkspaceWriteFence,
  WorkspaceWriteFenceValidation,
} from '../protocol/index.js';
import type {
  LegacyApprovalAdapter,
  LegacyApprovalPatternRepositoryPort,
  ThreadDriverAttachment,
  ThreadDriverCheckpoint,
  ThreadDriverHostServices,
  ThreadIdentityPort,
} from '../session/thread-runtime-ports.js';
import type {
  LegacyThreadSeedRecord,
  ThreadJournalAppendPort,
  ThreadMetaRecord,
} from '../session/thread-journal-records.js';

export type {
  LegacyApprovalAdapter,
  LegacyApprovalAdapterFactory,
  LegacyApprovalApplyResult,
  LegacyApprovalContext,
  LegacyApprovalInvocationResult,
  LegacyApprovalPatternCommitResult,
  LegacyApprovalPatternRepositoryPort,
  LegacyApprovalPreflightResult,
  LegacyApprovalRequestSnapshot,
  PermissionPolicyPort,
  PreparedThreadDriverCommand,
  RecoveryQueueCommand,
  RuntimeClock,
  ThreadCompactionCheckpoint,
  ThreadDriverAttachment,
  ThreadDriverCheckpoint,
  ThreadDriverCheckpointMutation,
  ThreadDriverCompletion,
  ThreadDriverDispatch,
  ThreadDriverEvent,
  ThreadDriverHostServices,
  ThreadDriverPort,
  ThreadIdentityPort,
} from '../session/thread-runtime-ports.js';
export type {
  ActivityRecoveryMutation,
  ControlMutation,
  IdentityPrepareRecord,
  InputOwnershipMutation,
  LegacyMirrorRecord,
  LegacyThreadSeedRecord,
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

export interface LegacyApprovalPatternRepository extends LegacyApprovalPatternRepositoryPort {
  /** Stable tolerant-load warnings that Runtime must commit as canonical diagnostics. */
  startupDiagnostics?(): readonly {
    readonly code: string;
    readonly message: string;
  }[];
  close(): Promise<void>;
}

export interface ThreadDriverFactory {
  readonly requirements:
    | { readonly approvalMode: 'legacy_session_edge' }
    | { readonly approvalMode: 'durable_legacy_bridge' };
  openLegacyApprovalAdapter?(input: {
    readonly workspaceId: WorkspaceId;
    readonly threadId: ThreadId;
    readonly patterns: LegacyApprovalPatternRepositoryPort;
  }): Promise<LegacyApprovalAdapter>;
  create(input: {
    readonly workspaceId: WorkspaceId;
    readonly threadId: ThreadId;
    readonly model: ModelConfig;
    readonly permissionCeiling: PermissionCeilingSnapshot;
    readonly parentThreadId?: ThreadId;
    readonly creationKey: string;
    readonly legacyApprovalPatterns?: LegacyApprovalPatternRepositoryPort;
  }, host: ThreadDriverHostServices): Promise<ThreadDriverAttachment>;
  resume(input: {
    readonly workspaceId: WorkspaceId;
    readonly threadId: ThreadId;
    readonly model: ModelConfig;
    readonly durableRef: ThreadDriverRef;
    readonly permissionCeiling: PermissionCeilingSnapshot;
    readonly committedCheckpoint?: ThreadDriverCheckpoint;
    readonly usedRequestIds: readonly string[];
    readonly legacyApprovalPatterns?: LegacyApprovalPatternRepositoryPort;
  }, host: ThreadDriverHostServices): Promise<ThreadDriverAttachment>;
}

export interface SupervisorLease extends WorkspaceWriteFence {
  readonly processEpoch: string;
}

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
      readonly initialRecords?: readonly LegacyThreadSeedRecord[];
    },
  ): Promise<ThreadJournalPort>;
  openThreadJournal(threadId: ThreadId): Promise<ThreadJournalPort | undefined>;
  importLegacyThread(
    lease: Readonly<SupervisorLease>,
    threadId: ThreadId,
  ): Promise<LegacyThreadImport | undefined>;
  openLegacyApprovalPatternRepository?(
    lease: Readonly<SupervisorLease>,
  ): Promise<LegacyApprovalPatternRepository>;
  close(): Promise<void>;
}

export interface RuntimeStoragePort {
  listStoredThreads(): Promise<readonly StoredThreadLocator[]>;
  openWorkspace(input: {
    readonly cwd: string;
    readonly workspaceId?: WorkspaceId;
  }): Promise<RuntimeWorkspaceStoragePort>;
}
