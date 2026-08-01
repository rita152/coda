// session 层出口:JSONL 会话存储、恢复、usage 聚合、auto-retry(M7)、compaction(M7)。
// 规格见 docs/08-session-persistence.md。只依赖 protocol/shared/agent(ESLint zone)。
export { Session } from './session.js';
export type {
  CompactionOptions,
  RetryOptions,
  SessionEvent,
  SessionAuthoritativeEventBatch,
  SessionInteractionState,
  SessionListener,
  SessionOptions,
  SessionRuntimeMirrorGuard,
} from './session.js';
export { decideRetry, sleepWithAbort } from './retry.js';
export type { ResolvedRetryPolicyOptions, RetryDecision, RetrySleep } from './retry.js';
export { selectTailStart, summarize, SUMMARIZE_PROMPT, HARD_TRUNCATION_SUMMARY } from './compactor.js';
export {
  defaultSessionDir,
  listSessions,
  loadSession,
  newSessionId,
  PROTOCOL_VERSION,
  SessionStore,
  STORE_VERSION,
  syntheticSummaryMessage,
} from './store.js';
export type {
  CompactionRecord,
  LoadedSession,
  MessageRecord,
  MetaRecord,
  SessionListItem,
  SessionRecord,
} from './store.js';
export { UsageTracker } from './usage.js';
export type { ModelPricing, SessionUsage } from './usage.js';
export { EventCommitter } from './event-committer.js';
export type {
  CommitEnvelopeInput,
  EventCommitterOptions,
  EventCommitterRepository,
} from './event-committer.js';
export {
  EventCursorValidationError,
  EventSubscriptionGapError,
  RuntimeEventStreamError,
} from './event-errors.js';
export type { EventCursorValidationCode } from './event-errors.js';
export { EventHub } from './event-hub.js';
export type { EventHubOptions, EventSubscriptionOptions } from './event-hub.js';
export { TranscriptRepository } from './transcript-repository.js';
export type {
  TranscriptFold,
  TranscriptJournalPort,
  TranscriptRepositoryOptions,
} from './transcript-repository.js';
export { RetryCoordinator } from './retry-coordinator.js';
export type { RetryCoordinatorDecision } from './retry-coordinator.js';
export { CompactionCoordinator } from './compaction-coordinator.js';
export type {
  CompactionCoordinatorDecision,
  CompactionPlan,
} from './compaction-coordinator.js';
export { StandaloneSessionInUseError } from './standalone-session-lease.js';
export { validatePermissionCeilingSnapshot } from './permission-ceiling.js';
export type { ExpectedPermissionInheritance } from './permission-ceiling.js';
export {
  emptyCheckpoint,
  foldThreadJournal,
  snapshotFromFold,
  ThreadJournalWriter,
} from './thread-journal.js';
export type {
  FoldedMailboxEntry,
  FoldedRunEntry,
  FoldedThreadJournal,
  FoldedTurnEntry,
} from './thread-journal.js';
export {
  ThreadDriverHostController,
  ThreadRuntime,
} from './thread-runtime.js';
export type { ThreadRuntimeOptions } from './thread-runtime.js';
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
} from './thread-journal-records.js';
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
} from './thread-runtime-ports.js';
/** @internal Legacy Runtime adapter execution port; bypasses direct Session host/lease/hub. */
export { LegacyThreadExecution } from './legacy-thread-execution.js';
export type { LegacyThreadExecutionPort } from './legacy-thread-execution.js';
