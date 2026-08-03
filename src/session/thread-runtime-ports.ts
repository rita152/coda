// Narrow, thread-scoped ports owned by the embeddable session runtime.

import type {
  AgentMessage,
  DerivedOpId,
  DerivedOpPurpose,
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
  RuntimePermissionMode,
  RuntimeOp,
  ThreadId,
  ThreadSnapshot,
  ThreadUsage,
  TurnId,
  WorkspaceId,
} from '../protocol/index.js';
import type { RuntimeTurnPort } from '../agent/index.js';

export interface RuntimeClock {
  now(): number;
}

export interface ThreadIdentityPort {
  newRunId(): RunId;
  newTurnId(): TurnId;
  deriveOpId(input: {
    readonly purpose: DerivedOpPurpose;
    readonly workspaceId: WorkspaceId;
    readonly parts: readonly string[];
  }): DerivedOpId;
}

export interface PermissionPolicyPort {
  snapshotWorkspaceCeiling(input: {
    readonly workspaceId: WorkspaceId;
    readonly cwd: string;
  }): Promise<PermissionCeilingSnapshot>;
  /** Optional additive status projection for user-facing Runtime snapshots. */
  snapshotWorkspacePermissionStatus?(input: {
    readonly workspaceId: WorkspaceId;
    readonly cwd: string;
    readonly workspaceCeiling: PermissionCeilingSnapshot;
  }): Promise<{
    readonly mode: RuntimePermissionMode;
    readonly policyRevision: string;
  }>;
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
      readonly op: Extract<RuntimeOp, { type: 'compact' }>;
      readonly runId: RunId;
      readonly permissionCeiling: PermissionCeilingSnapshot;
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
      readonly op: Extract<RuntimeOp, { type: 'steer' | 'follow_up' }>;
    }
  | {
      readonly op: Extract<RuntimeOp, { type: 'control_response' }>;
    };

export interface ThreadRuntimePreparedInput {
  readonly resolvedModel?: ModelConfig;
}

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
  /** Canonical registry execution captures all mutable services once for the already-reserved turn. */
  captureRuntimeTurn?(input: {
    readonly rootOpId: ExternalOpId;
    readonly runId: RunId;
    readonly turnId: TurnId;
    readonly model: Readonly<ModelConfig>;
    readonly transcript: readonly Readonly<AgentMessage>[];
    readonly signal: AbortSignal;
  }): Promise<RuntimeTurnPort>;
}

/** Canonical attachment result: the Runtime journal is the only durable backend. */
export interface RuntimeThreadDriverAttachment {
  readonly driver: ThreadDriverPort;
  readonly initialCheckpoint: ThreadDriverCheckpoint;
}

/** Canonical driver factory consumed by the runtime-v2-only Supervisor composition. */
export interface RuntimeThreadDriverFactory {
  readonly requirements: { readonly capabilityMode: 'registry' };
  create(input: {
    readonly workspaceId: WorkspaceId;
    readonly threadId: ThreadId;
    readonly model: ModelConfig;
    readonly permissionCeiling: PermissionCeilingSnapshot;
    readonly parentThreadId?: ThreadId;
    readonly initialCheckpoint?: ThreadDriverCheckpoint;
  }, host: RuntimeThreadDriverHostServices): Promise<RuntimeThreadDriverAttachment>;
  resume(input: {
    readonly workspaceId: WorkspaceId;
    readonly threadId: ThreadId;
    readonly model: ModelConfig;
    readonly permissionCeiling: PermissionCeilingSnapshot;
    readonly committedCheckpoint: ThreadDriverCheckpoint;
    readonly usedRequestIds: readonly string[];
  }, host: RuntimeThreadDriverHostServices): Promise<RuntimeThreadDriverAttachment>;
}

export type RuntimeThreadDriverHostServices = ThreadDriverHostServices;

export interface ThreadDriverPort {
  /** Replays durable queue effects while the attachment is still quarantined. */
  recover(commands: readonly RecoveryQueueCommand[]): Promise<void>;
  activate(): Promise<void>;
  dispatch(command: PreparedThreadDriverCommand): ThreadDriverDispatch;
  interactionState(): 'idle' | 'running' | 'retrying' | 'compacting';
  /**
   * Called synchronously after a compacting prompt is durably accepted into ThreadRuntime's own
   * activity queue. A driver with an internal compaction auto-continue must yield that continuation
   * to the mailbox so the accepted prompt runs exactly once under its reserved RunId.
   */
  activityQueuedDuringCompaction?(): void;
  close(): Promise<void>;
}
