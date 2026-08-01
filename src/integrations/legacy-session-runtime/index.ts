// Phase-1 compatibility driver: adapt the existing single-Agent Session implementation to the
// identity-bearing RuntimePort without letting Runtime core import Session, tools, providers, or
// CLI policy code.

import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { ApprovalBroker } from '../../agent/index.js';
import type {
  AgentEvent,
  ExternalOpId,
  ModelConfig,
  PermissionCeilingSnapshot,
  RunId,
  RuntimeEvent,
  ThreadId,
  TurnId,
  WorkspaceId,
} from '../../protocol/index.js';
import { canonicalJson, canonicalJsonSha256, strictJsonSnapshot } from '../../protocol/index.js';
import type {
  PreparedThreadDriverCommand,
  RecoveryQueueCommand,
  ThreadDriverAttachment,
  ThreadDriverCheckpoint,
  ThreadDriverCheckpointMutation,
  ThreadDriverEvent,
  ThreadDriverFactory,
  ThreadDriverHostServices,
  ThreadDriverPort,
} from '../../runtime/ports.js';
import {
  defaultSessionDir,
  loadSession,
  Session,
  SessionStore,
  STORE_VERSION,
  PROTOCOL_VERSION,
  UsageTracker,
} from '../../session/index.js';
import type {
  MetaRecord,
  ModelPricing,
  SessionEvent,
  SessionOptions,
  SessionRecord,
  SessionRuntimeMirrorGuard,
} from '../../session/index.js';

type ApprovalRequestEvent = Extract<AgentEvent, { type: 'approval_request' }>;
type ActivityCommand = Extract<
  PreparedThreadDriverCommand,
  { readonly op: { readonly type: 'prompt' | 'continue' } }
>;
type SetModelCommand = Extract<
  PreparedThreadDriverCommand,
  { readonly op: { readonly type: 'set_model' } }
>;
type AbortCommand = Extract<
  PreparedThreadDriverCommand,
  { readonly op: { readonly type: 'abort' } }
>;

export interface LegacySessionAttachmentContext {
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly model: ModelConfig;
  readonly permissionCeiling: PermissionCeilingSnapshot;
  /** Pass this callback to the attachment-local ApprovalBroker constructor. */
  readonly emitApproval: (event: ApprovalRequestEvent) => void;
  /** Pass this callback to legacy approval policy requestAbort. */
  readonly requestAbort: () => void;
}

export interface LegacySessionAttachmentConfiguration {
  readonly sessionOptions: Omit<
    SessionOptions,
    'dir' | 'authoritativeEventSink' | 'runtimeMirrorGuard' | 'runtimeQueueSeed'
  >;
  readonly approval?: {
    readonly broker: ApprovalBroker;
    readonly onAbort: () => void;
  };
  /** Revision of attachment-local legacy project/policy rules. */
  readonly policyRevision?: string;
}

export interface LegacySessionThreadDriverFactoryOptions {
  readonly sessionDir?: string;
  /** Called once per create/resume attachment; do not return shared mutable policy state. */
  readonly configure: (
    context: LegacySessionAttachmentContext,
  ) => LegacySessionAttachmentConfiguration;
}

interface DriverConstructionInput {
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly model: ModelConfig;
  readonly permissionCeiling: PermissionCeilingSnapshot;
  readonly initialCheckpoint?: ThreadDriverCheckpoint;
  readonly sessionId: string;
  readonly create: boolean;
  readonly creationKey?: string;
  readonly usedRequestIds: readonly string[];
}

interface ActivityContext {
  readonly rootOpId: ExternalOpId;
  readonly rootRunId: RunId;
  currentRunId: RunId;
  currentTurnId?: TurnId;
  currentTurnCeilingRevision?: string;
  turnOrdinal: number;
  terminalStatus?: 'completed' | 'aborted' | 'error';
  retry?: { readonly predecessorRunId: RunId; readonly successorRunId: RunId };
  compaction?: { readonly predecessorRunId: RunId; readonly successorRunId: RunId };
  successorCommitPending?: RunId;
}

interface PendingApproval {
  readonly requestId: string;
  readonly rawApprovalId: string;
  readonly owningRunId: RunId;
  readonly owningTurnId: TurnId;
  readonly policyRevision: string;
}

interface PendingQueueCommit {
  readonly opId: ExternalOpId;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

const DRIVER_REF_KIND = 'session-v1';
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class LegacySessionCheckpointMismatchError extends Error {
  override readonly name = 'LegacySessionCheckpointMismatchError';
  readonly code = 'legacy_session_checkpoint_mismatch' as const;

  constructor(readonly reason: string) {
    super(`Legacy Session checkpoint mismatch: ${reason}`);
  }
}

export class LegacySessionConcurrentWriterError extends Error {
  override readonly name = 'LegacySessionConcurrentWriterError';
  readonly code = 'legacy_backend_concurrent_writer' as const;

  constructor(readonly reason: string) {
    super(`Legacy Session mirror fingerprint mismatch; attachment quarantined: ${reason}`);
  }
}

export function createLegacySessionThreadDriverFactory(
  options: LegacySessionThreadDriverFactoryOptions,
): ThreadDriverFactory {
  const sessionDir = options.sessionDir ?? defaultSessionDir();
  return {
    requirements: { approvalMode: 'legacy_session_edge' },
    create: async (input, host) => constructDriver(
      options,
      sessionDir,
      {
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        model: input.model,
        permissionCeiling: input.permissionCeiling,
        sessionId: deterministicSessionId(input.creationKey),
        create: true,
        creationKey: input.creationKey,
        usedRequestIds: [],
      },
      host,
    ),
    resume: async (input, host) => {
      assertDriverRef(input.durableRef);
      return constructDriver(
        options,
        sessionDir,
        {
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          model: input.model,
          permissionCeiling: input.permissionCeiling,
          ...(input.committedCheckpoint !== undefined && {
            initialCheckpoint: snapshotCheckpoint(input.committedCheckpoint),
          }),
          sessionId: input.durableRef.key,
          create: false,
          usedRequestIds: input.usedRequestIds,
        },
        host,
      );
    },
  };
}

async function constructDriver(
  options: LegacySessionThreadDriverFactoryOptions,
  sessionDir: string,
  input: DriverConstructionInput,
  host: ThreadDriverHostServices,
): Promise<ThreadDriverAttachment> {
  const driverRef: { current?: LegacySessionThreadDriver } = {};
  const configured = options.configure({
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    model: input.model,
    permissionCeiling: input.permissionCeiling,
    emitApproval: (event) => {
      if (driverRef.current === undefined) throw new Error('Legacy approval emitted before driver construction');
      driverRef.current.emitApproval(event);
    },
    requestAbort: () => driverRef.current?.requestAbortFromPolicy(),
  });
  const sessionOptions: SessionOptions = {
    ...configured.sessionOptions,
    dir: sessionDir,
    agentConfig: {
      ...configured.sessionOptions.agentConfig,
      model: input.model,
    },
    authoritativeEventSink: (events) => {
      if (driverRef.current === undefined) {
        return Promise.reject(new Error('Legacy Session emitted before driver construction'));
      }
      return driverRef.current.commitSessionEvents(events);
    },
  };
  const mirror = new LegacySessionMirrorClaim({
    dir: sessionDir,
    sourceSessionId: input.sessionId,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    recordedCwd: sessionOptions.agentConfig.cwd ?? process.cwd(),
    model: input.model,
    ...(input.creationKey !== undefined && { creationKey: input.creationKey }),
  });
  let activeSessionId = input.sessionId;
  let createMeta: MetaRecord | undefined;
  if (!input.create && input.initialCheckpoint !== undefined) {
    activeSessionId = mirror.prepareResume(
      input.initialCheckpoint,
      configured.sessionOptions.pricing,
    );
  } else if (input.create) {
    const preparation = mirror.prepareCreate();
    activeSessionId = preparation.activeSessionId;
    createMeta = preparation.meta;
  }
  sessionOptions.runtimeMirrorGuard = mirror;
  if (input.initialCheckpoint !== undefined) {
    sessionOptions.runtimeQueueSeed = input.initialCheckpoint.frontend.queues;
  }
  const session = input.create
    ? await Session.createWithId(activeSessionId, sessionOptions, createMeta)
    : await Session.resume(activeSessionId, sessionOptions);
  if (input.create) mirror.finishCreate(activeSessionId);
  const driver = new LegacySessionThreadDriver({
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    permissionCeiling: input.permissionCeiling,
    host,
    session,
    configured,
    pendingMirrorDiagnostic: mirror.rebuiltAfterConcurrentWriter,
    usedRequestIds: input.usedRequestIds,
  });
  driverRef.current = driver;
  return {
    driver,
    durableRef: { kind: DRIVER_REF_KIND, key: input.sessionId },
    initialCheckpoint: input.initialCheckpoint ?? checkpointFromSession(session),
  };
}

class LegacySessionThreadDriver implements ThreadDriverPort {
  readonly #workspaceId: WorkspaceId;
  readonly #threadId: ThreadId;
  readonly #permissionCeiling: PermissionCeilingSnapshot;
  readonly #host: ThreadDriverHostServices;
  readonly #session: Session;
  readonly #approval: LegacySessionAttachmentConfiguration['approval'];
  readonly #policyRevision: string;
  readonly #pendingApprovals = new Map<string, PendingApproval>();
  readonly #usedApprovalIds = new Set<string>();
  readonly #pendingQueueCommits: PendingQueueCommit[] = [];
  readonly #sideTasks = new Set<Promise<void>>();
  #activity: ActivityContext | undefined;
  #activated = false;
  #recovering = false;
  #recovered = false;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #fatalError: unknown;
  #pendingMirrorDiagnostic: boolean;
  #mirrorDiagnosticCommitted = false;

  constructor(input: {
    readonly workspaceId: WorkspaceId;
    readonly threadId: ThreadId;
    readonly permissionCeiling: PermissionCeilingSnapshot;
    readonly host: ThreadDriverHostServices;
    readonly session: Session;
    readonly configured: LegacySessionAttachmentConfiguration;
    readonly pendingMirrorDiagnostic: boolean;
    readonly usedRequestIds: readonly string[];
  }) {
    this.#workspaceId = input.workspaceId;
    this.#threadId = input.threadId;
    this.#permissionCeiling = input.permissionCeiling;
    this.#host = input.host;
    this.#session = input.session;
    this.#approval = input.configured.approval;
    this.#policyRevision = input.configured.policyRevision ?? 'legacy-session-policy-v1';
    this.#pendingMirrorDiagnostic = input.pendingMirrorDiagnostic;
    for (const requestId of input.usedRequestIds) this.#usedApprovalIds.add(requestId);
  }

  async recover(commands: readonly RecoveryQueueCommand[]): Promise<void> {
    this.#assertNotClosed();
    if (this.#activated || this.#recovering || this.#recovered) {
      throw new Error('Legacy Session recovery must run exactly once before activation');
    }
    this.#recovering = true;
    try {
      // Recovery diagnostics are canonical facts and must become durable before any recovered
      // queue effect or resumed-thread visibility is published by the Supervisor.
      if (this.#pendingMirrorDiagnostic) await this.#commitMirrorDiagnostic();
      for (const command of commands) await this.#dispatchQueueOperation(command.op);
      this.#throwFatal();
      this.#recovered = true;
    } catch (error) {
      if (error instanceof LegacySessionConcurrentWriterError) {
        this.#markFatal(error);
        await this.#commitMirrorDiagnostic();
      }
      throw error;
    } finally {
      this.#recovering = false;
    }
  }

  async activate(): Promise<void> {
    this.#assertNotClosed();
    if (!this.#recovered || this.#recovering) {
      throw new Error('Legacy Session driver must finish recovery before activation');
    }
    this.#activated = true;
  }

  dispatch(command: PreparedThreadDriverCommand): ReturnType<ThreadDriverPort['dispatch']> {
    this.#assertReady();
    return { completion: this.#dispatch(command) };
  }

  interactionState(): ReturnType<ThreadDriverPort['interactionState']> {
    return this.#session.interactionState();
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = (async () => {
      this.#session.abort();
      this.#approval?.onAbort();
      await Promise.allSettled([...this.#sideTasks]);
      for (const pending of this.#pendingQueueCommits.splice(0)) {
        pending.reject(new Error('Legacy Session driver closed'));
      }
      await this.#session.close();
    })();
    return this.#closePromise;
  }

  requestAbortFromPolicy(): void {
    this.#session.abort();
  }

  emitApproval(event: ApprovalRequestEvent): void {
    try {
      this.#assertReady();
      const activity = this.#requireActivity();
      const owningTurnId = activity.currentTurnId;
      if (owningTurnId === undefined) throw new Error('Approval request has no active turn');
      const requestId = this.#allocateApprovalRequestId(event.approvalId);
      const pending: PendingApproval = {
        requestId,
        rawApprovalId: event.approvalId,
        owningRunId: activity.currentRunId,
        owningTurnId,
        policyRevision: this.#currentPolicyRevision(activity),
      };
      this.#pendingApprovals.set(requestId, pending);
      const task = this.#host.commitEvent({
        event: {
          type: 'control_request',
          requestId,
          kind: 'approval',
          owningRunId: pending.owningRunId,
          owningTurnId: pending.owningTurnId,
          policyRevision: pending.policyRevision,
          payload: {
            toolCallId: event.toolCallId,
            description: event.description,
          },
        },
        runId: pending.owningRunId,
        turnId: pending.owningTurnId,
      }).then(
        () => {
          this.#usedApprovalIds.add(requestId);
        },
        (error) => {
          if (this.#pendingApprovals.get(requestId) === pending) {
            this.#pendingApprovals.delete(requestId);
          }
          throw error;
        },
      );
      this.#trackSideTask(task);
    } catch (error) {
      this.#markFatal(error);
    }
  }

  async commitSessionEvent(event: SessionEvent): Promise<void> {
    this.#assertEventSinkReady();
    this.#throwFatal();
    if (event.type === 'queue_update') {
      const pending = this.#pendingQueueCommits.shift();
      if (pending !== undefined) {
        try {
          await this.#host.commitEvent({ event, opId: pending.opId });
          pending.resolve();
        } catch (error) {
          pending.reject(error);
          throw error;
        }
        return;
      }
    }
    const activity = this.#requireActivity();
    switch (event.type) {
      case 'turn_start': {
        const reservation = await this.#host.reserveTurn({
          runId: activity.currentRunId,
          turnOrdinal: ++activity.turnOrdinal,
        });
        activity.currentTurnId = reservation.turnId;
        activity.currentTurnCeilingRevision = reservation.turnCeiling.revision;
        await this.#host.commitEvent({
          event,
          runId: activity.currentRunId,
          turnId: reservation.turnId,
        });
        return;
      }
      case 'agent_end': {
        const predecessorRunId = activity.currentRunId;
        const successorReason = event.willRetry === true
          ? 'retry'
          : this.#session.runtimeFollowUpState() === 'compacting'
            ? 'compaction'
            : undefined;
        const successor = successorReason === undefined
          ? undefined
          : await this.#host.reserveSuccessor({
              threadId: this.#threadId,
              predecessorRunId,
              reason: successorReason,
            });
        if (successor !== undefined) {
          if (successorReason === 'retry') {
            activity.retry = { predecessorRunId, successorRunId: successor.runId };
          } else {
            activity.compaction = { predecessorRunId, successorRunId: successor.runId };
          }
          // reserveSuccessor has already made this the canonical current RunId. Publish that
          // CAS target to abort dispatch before awaiting predecessor agent_end commit, otherwise
          // an abort accepted in this window would incorrectly compare against the predecessor.
          activity.currentRunId = successor.runId;
          activity.turnOrdinal = 0;
          activity.successorCommitPending = successor.runId;
        }
        await this.#host.commitEvent({
          event,
          runId: predecessorRunId,
          ...(predecessorRunId === activity.rootRunId && { opId: activity.rootOpId }),
        });
        activity.terminalStatus = event.reason;
        activity.currentTurnId = undefined;
        activity.currentTurnCeilingRevision = undefined;
        activity.successorCommitPending = undefined;
        return;
      }
      case 'retry_scheduled': {
        const retry = activity.retry;
        if (retry === undefined) throw new Error('retry_scheduled has no reserved successor');
        await this.#host.commitEvent({
          event: {
            ...event,
            predecessorRunId: retry.predecessorRunId,
            successorRunId: retry.successorRunId,
          },
          runId: retry.successorRunId,
        });
        activity.retry = undefined;
        return;
      }
      case 'compaction_start': {
        const compaction = activity.compaction;
        if (compaction === undefined) {
          throw new Error('compaction_start has no predecessor agent_end reservation');
        }
        activity.currentRunId = compaction.successorRunId;
        activity.currentTurnId = undefined;
        activity.currentTurnCeilingRevision = undefined;
        activity.turnOrdinal = 0;
        await this.#host.commitEvent({
          event: {
            ...event,
            predecessorRunId: compaction.predecessorRunId,
            activityRunId: compaction.successorRunId,
          },
          runId: compaction.successorRunId,
        });
        return;
      }
      case 'compaction_end': {
        const checkpoint = event.ok ? this.#session.compactionCheckpoint() : undefined;
        const mutation: ThreadDriverCheckpointMutation | undefined = checkpoint === undefined
          ? undefined
          : {
              type: 'compaction_committed',
              compaction: {
                id: checkpoint.id,
                timestamp: checkpoint.timestamp,
                tailStartId: checkpoint.tailStartId,
                summary: checkpoint.summary,
                ...(checkpoint.contextTokensBefore !== undefined && {
                  contextTokensBefore: checkpoint.contextTokensBefore,
                }),
              },
            };
        await this.#host.commitEvent({
          event: { ...event, activityRunId: activity.currentRunId },
          runId: activity.currentRunId,
        }, mutation);
        activity.compaction = undefined;
        return;
      }
      case 'usage_update':
        await this.#commitTurnEvent({ type: event.type, usage: event.usage });
        return;
      case 'queue_update': {
        if (activity.currentTurnId !== undefined) {
          await this.#commitTurnEvent(event);
        } else {
          await this.#host.commitEvent({ event, opId: activity.rootOpId });
        }
        return;
      }
      case 'agent_start':
        await this.#host.commitEvent({
          event,
          runId: activity.currentRunId,
          ...(activity.currentRunId === activity.rootRunId && { opId: activity.rootOpId }),
        });
        return;
      case 'error':
        await this.#host.commitEvent({
          event,
          runId: activity.currentRunId,
          ...(activity.currentTurnId !== undefined && { turnId: activity.currentTurnId }),
        });
        return;
      case 'approval_request':
        throw new Error('Approval requests must use the legacy approval side channel');
      case 'turn_end':
      case 'message_start':
      case 'message_update':
      case 'message_end':
      case 'tool_execution_start':
      case 'tool_execution_update':
      case 'tool_execution_end':
      case 'plan_update':
        await this.#commitTurnEvent(event);
        return;
    }
  }

  async commitSessionEvents(events: readonly [SessionEvent, ...SessionEvent[]]): Promise<void> {
    if (events.length === 1) {
      await this.commitSessionEvent(events[0]);
      return;
    }
    this.#assertEventSinkReady();
    this.#throwFatal();
    const [messageEvent, usageEvent, ...unexpected] = events;
    if (
      unexpected.length !== 0 ||
      messageEvent.type !== 'message_end' ||
      usageEvent?.type !== 'usage_update'
    ) {
      throw new Error('Legacy Session emitted an unsupported authoritative event batch');
    }
    const activity = this.#requireActivity();
    const turnId = activity.currentTurnId;
    if (turnId === undefined) throw new Error('message_end batch has no active turn');
    const inputs: [ThreadDriverEvent, ThreadDriverEvent] = [
      { event: messageEvent, runId: activity.currentRunId, turnId },
      {
        event: { type: 'usage_update', usage: usageEvent.usage },
        runId: activity.currentRunId,
        turnId,
      },
    ];
    await this.#host.commitEventBatch(inputs);
  }

  async #dispatch(command: PreparedThreadDriverCommand) {
    try {
      this.#throwFatal();
      switch (command.op.type) {
        case 'prompt':
        case 'continue':
          return await this.#dispatchActivity(command as ActivityCommand);
        case 'set_model':
          this.#session.setModel((command as SetModelCommand).resolvedModel);
          return { kind: 'operation', outcome: 'applied' } as const;
        case 'steer':
        case 'follow_up':
          return await this.#dispatchQueueOperation(command.op);
        case 'control_response':
          return await this.#dispatchControlResponse(command.op);
        case 'abort':
          return await this.#dispatchAbort(command as AbortCommand);
      }
    } catch (error) {
      if (error instanceof LegacySessionConcurrentWriterError) {
        this.#markFatal(error);
        await this.#commitMirrorDiagnostic();
      }
      throw error;
    }
  }

  async #dispatchActivity(
    command: ActivityCommand,
  ) {
    if (this.#activity !== undefined) throw new Error('Legacy Session driver already has an active activity');
    const activity: ActivityContext = {
      rootOpId: command.op.opId,
      rootRunId: command.runId,
      currentRunId: command.runId,
      turnOrdinal: 0,
    };
    this.#activity = activity;
    try {
      if (command.resolvedInput.kind === 'prompt_input') {
        await this.#session.prompt(command.resolvedInput.text);
      } else {
        await this.#session.continue();
      }
      await this.#session.waitForIdle();
      await Promise.all([...this.#sideTasks]);
      this.#throwFatal();
      if (activity.terminalStatus === undefined) {
        throw new Error('Legacy Session activity completed without agent_end');
      }
      return {
        kind: 'activity',
        status: activity.terminalStatus,
        terminalRunId: activity.currentRunId,
      } as const;
    } finally {
      if (this.#activity === activity) this.#activity = undefined;
    }
  }

  async #dispatchQueueOperation(
    op: Extract<PreparedThreadDriverCommand['op'], { type: 'steer' | 'follow_up' }>,
  ) {
    if (op.text.trim().length === 0) return { kind: 'operation', outcome: 'no_op' } as const;
    const completion = new Promise<void>((resolve, reject) => {
      this.#pendingQueueCommits.push({ opId: op.opId, resolve, reject });
    });
    try {
      if (op.type === 'steer') this.#session.steer(op.text);
      else this.#session.followUp(op.text);
    } catch (error) {
      const pending = this.#pendingQueueCommits.findIndex((candidate) => candidate.opId === op.opId);
      if (pending >= 0) this.#pendingQueueCommits.splice(pending, 1);
      throw error;
    }
    await completion;
    this.#throwFatal();
    return { kind: 'operation', outcome: 'applied' } as const;
  }

  async #dispatchControlResponse(
    op: Extract<PreparedThreadDriverCommand['op'], { type: 'control_response' }>,
  ) {
    const pending = this.#pendingApprovals.get(op.requestId);
    if (pending === undefined) return { kind: 'operation', outcome: 'no_op' } as const;
    if (op.decision === 'confirm') throw new Error('Approval request cannot accept resource confirmation');
    await this.#host.commitEvent({
      event: {
        type: 'control_resolved',
        requestId: pending.requestId,
        kind: 'approval',
        owningRunId: pending.owningRunId,
        owningTurnId: pending.owningTurnId,
        policyRevision: pending.policyRevision,
        decision: op.decision,
      },
      runId: pending.owningRunId,
      turnId: pending.owningTurnId,
      opId: op.opId,
    });
    this.#pendingApprovals.delete(op.requestId);
    this.#approval?.broker.resolve(pending.rawApprovalId, op.decision);
    return { kind: 'operation', outcome: 'applied' } as const;
  }

  async #dispatchAbort(command: AbortCommand) {
    const target = command.resolvedTarget;
    if (target.kind !== 'run' || this.#activity?.currentRunId !== target.runId) {
      return { kind: 'operation', outcome: 'no_op' } as const;
    }
    const op = command.op;
    const reservedSuccessorWindow = this.#activity.successorCommitPending === target.runId;
    this.#session.abort();
    // A retry successor can be cancelled while it is sleeping, before that successor ever emits
    // its own agent_end. Record the accepted abort immediately so activity completion cannot reuse
    // the predecessor's terminal error if its waitForIdle continuation wins the wake-up race.
    this.#activity.terminalStatus = 'aborted';
    for (const pending of [...this.#pendingApprovals.values()]) {
      await this.#host.commitEvent({
        event: {
          type: 'control_resolved',
          requestId: pending.requestId,
          kind: 'approval',
          owningRunId: pending.owningRunId,
          owningTurnId: pending.owningTurnId,
          policyRevision: pending.policyRevision,
          decision: 'aborted',
        },
        runId: pending.owningRunId,
        turnId: pending.owningTurnId,
        opId: op.opId,
      });
      this.#pendingApprovals.delete(pending.requestId);
    }
    this.#approval?.onAbort();
    // The predecessor agent_end commit can itself be held by the authoritative host. The
    // successor is only a detached retry/compaction at this point, so signalling its controller
    // is the complete effect and must not deadlock the abort receipt on that predecessor gate.
    if (!reservedSuccessorWindow) await this.#session.waitForIdle();
    this.#throwFatal();
    return { kind: 'operation', outcome: 'applied' } as const;
  }

  #commitTurnEvent(event: RuntimeEvent): Promise<void> {
    const activity = this.#requireActivity();
    if (activity.currentTurnId === undefined) {
      return Promise.reject(new Error(`${event.type} has no active turn`));
    }
    return this.#host.commitEvent({
      event,
      runId: activity.currentRunId,
      turnId: activity.currentTurnId,
    });
  }

  #currentPolicyRevision(activity: ActivityContext): string {
    return canonicalJsonSha256({
      adapter: 'legacy-session-v1',
      policyRevision: this.#policyRevision,
      threadCeilingRevision: this.#permissionCeiling.revision,
      turnCeilingRevision: activity.currentTurnCeilingRevision ?? this.#permissionCeiling.revision,
    });
  }

  #allocateApprovalRequestId(rawId: string): string {
    if (!this.#usedApprovalIds.has(rawId) && !this.#pendingApprovals.has(rawId)) return rawId;
    for (let suffix = 1; suffix < Number.MAX_SAFE_INTEGER; suffix++) {
      const candidate = `${rawId}~${suffix}`;
      if (!this.#usedApprovalIds.has(candidate) && !this.#pendingApprovals.has(candidate)) {
        return candidate;
      }
    }
    throw new Error(`Unable to allocate canonical approval id for ${rawId}`);
  }

  async #commitMirrorDiagnostic(): Promise<void> {
    if (this.#mirrorDiagnosticCommitted) return;
    await this.#host.commitEvent({
      event: {
        type: 'runtime_diagnostic',
        severity: 'error',
        code: 'legacy_backend_concurrent_writer',
        message: 'Legacy Session mirror changed outside Runtime; the attachment was quarantined.',
        scope: 'thread',
      },
    });
    this.#mirrorDiagnosticCommitted = true;
    this.#pendingMirrorDiagnostic = false;
  }

  #trackSideTask(task: Promise<void>): void {
    this.#sideTasks.add(task);
    void task.then(
      () => this.#sideTasks.delete(task),
      (error) => {
        this.#sideTasks.delete(task);
        this.#markFatal(error);
      },
    );
  }

  #markFatal(error: unknown): void {
    if (this.#fatalError !== undefined) return;
    this.#fatalError = error;
    this.#session.abort();
    this.#approval?.onAbort();
    for (const pending of this.#pendingQueueCommits.splice(0)) pending.reject(error);
  }

  #throwFatal(): void {
    if (this.#fatalError !== undefined) throw this.#fatalError;
  }

  #requireActivity(): ActivityContext {
    if (this.#activity === undefined) throw new Error('Legacy Session event has no active Runtime activity');
    return this.#activity;
  }

  #assertReady(): void {
    this.#assertNotClosed();
    if (!this.#activated) throw new Error('Legacy Session driver is quarantined');
    this.#throwFatal();
  }

  #assertEventSinkReady(): void {
    this.#assertNotClosed();
    if (!this.#activated && !this.#recovering) {
      throw new Error('Legacy Session driver is quarantined');
    }
    this.#throwFatal();
  }

  #assertNotClosed(): void {
    if (this.#closed) throw new Error('Legacy Session driver is closed');
  }
}

function deterministicSessionId(creationKey: string): string {
  const digest = createHash('sha256').update(creationKey, 'utf8').digest('hex');
  return `runtime-${digest.slice(0, 40)}`;
}

function assertDriverRef(ref: { readonly kind: string; readonly key: string }): void {
  if (ref.kind !== DRIVER_REF_KIND || !SAFE_SESSION_ID.test(ref.key)) {
    throw new Error('Invalid legacy Session driver ref');
  }
}

interface MirrorTailFingerprint {
  readonly byteLength: number;
  readonly sha256: string;
}

interface PersistedLegacyMirrorClaim {
  readonly type: 'coda_runtime_legacy_mirror_claim';
  readonly version: 1;
  readonly sourceSessionId: string;
  readonly activeSessionId: string;
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly recordedCwd: string;
  readonly backendMeta: MetaRecord;
  readonly creationKey?: string;
  readonly generation: number;
  readonly expectedTail: MirrorTailFingerprint;
  readonly status: 'creating' | 'active' | 'quarantined';
}

class LegacySessionMirrorClaim implements SessionRuntimeMirrorGuard {
  readonly #dir: string;
  readonly #sourceSessionId: string;
  readonly #workspaceId: WorkspaceId;
  readonly #threadId: ThreadId;
  readonly #recordedCwd: string;
  readonly #model: ModelConfig;
  readonly #creationKey?: string;
  readonly #claimFile: string;
  #claim: PersistedLegacyMirrorClaim | undefined;
  #expectedAppend: Uint8Array | undefined;
  rebuiltAfterConcurrentWriter = false;

  constructor(input: {
    readonly dir: string;
    readonly sourceSessionId: string;
    readonly workspaceId: WorkspaceId;
    readonly threadId: ThreadId;
    readonly recordedCwd: string;
    readonly model: ModelConfig;
    readonly creationKey?: string;
  }) {
    this.#dir = input.dir;
    this.#sourceSessionId = input.sourceSessionId;
    this.#workspaceId = input.workspaceId;
    this.#threadId = input.threadId;
    this.#recordedCwd = input.recordedCwd;
    this.#model = input.model;
    this.#creationKey = input.creationKey;
    this.#claimFile = path.join(this.#dir, `${this.#sourceSessionId}.runtime-claim.json`);
    this.#claim = this.#loadClaim();
    if (this.#claim !== undefined) this.#validateContext(this.#claim);
  }

  prepareCreate(): { readonly activeSessionId: string; readonly meta: MetaRecord } {
    const claim = this.#claim;
    if (claim === undefined) {
      const mirrorFile = this.#mirrorFile(this.#sourceSessionId);
      if (existsSync(mirrorFile)) {
        throw new LegacySessionCheckpointMismatchError(
          'deterministic create backend exists without a matching persistent claim',
        );
      }
      const meta = this.#metaForPrivateMirror(this.#sourceSessionId);
      const expectedMeta = new TextEncoder().encode(`${JSON.stringify(meta)}\n`);
      this.#claim = {
        type: 'coda_runtime_legacy_mirror_claim',
        version: 1,
        sourceSessionId: this.#sourceSessionId,
        activeSessionId: this.#sourceSessionId,
        workspaceId: this.#workspaceId,
        threadId: this.#threadId,
        recordedCwd: this.#recordedCwd,
        backendMeta: meta,
        ...(this.#creationKey !== undefined && { creationKey: this.#creationKey }),
        generation: 0,
        expectedTail: fingerprintBytes(expectedMeta),
        status: 'creating',
      };
      // Persist the complete creation intent before the backend path can be created. A retry can
      // now prove an exact meta-only crash artifact; an unclaimed pre-existing file is never blessed.
      this.#persistClaim();
      return { activeSessionId: this.#sourceSessionId, meta };
    }
    if (claim.status === 'quarantined') {
      throw new LegacySessionConcurrentWriterError('existing create backend requires explicit resume recovery');
    }
    if (claim.status === 'active') this.assertCurrent();
    if (claim.status === 'creating') {
      const actual = fingerprintFileOrUndefined(this.#mirrorFile(claim.activeSessionId));
      if (actual !== undefined && !sameFingerprint(actual, claim.expectedTail)) {
        this.#quarantine('create backend does not match its persisted meta intent');
      }
    }
    return { activeSessionId: claim.activeSessionId, meta: normalizeMeta(claim.backendMeta) };
  }

  finishCreate(activeSessionId: string): void {
    const claim = this.#requireClaim();
    if (claim.activeSessionId !== activeSessionId) {
      throw new LegacySessionCheckpointMismatchError('create backend id diverges from persistent intent');
    }
    const actual = fingerprintFileOrUndefined(this.#mirrorFile(activeSessionId));
    if (actual === undefined || !sameFingerprint(actual, claim.expectedTail)) {
      this.#quarantine('created backend does not match its persisted meta intent');
    }
    this.#claim = { ...claim, status: 'active' };
    this.#persistClaim();
  }

  prepareResume(checkpoint: ThreadDriverCheckpoint, pricing?: ModelPricing): string {
    const canonical = snapshotCheckpoint(checkpoint);
    const claim = this.#claim;
    if (claim === undefined) {
      reconcileSessionMirror(this.#dir, this.#sourceSessionId, canonical, pricing);
      this.#claim = this.#newClaim(this.#sourceSessionId, 0);
      this.#persistClaim();
      return this.#sourceSessionId;
    }

    const actual = fingerprintFileOrUndefined(this.#mirrorFile(claim.activeSessionId));
    const expectedMatches = actual !== undefined && sameFingerprint(actual, claim.expectedTail);
    if (claim.status === 'creating' && (actual === undefined || expectedMatches)) {
      if (actual === undefined) {
        const initialized = SessionStore.initializeNamed(
          this.#dir,
          claim.activeSessionId,
          normalizeMeta(claim.backendMeta),
        );
        if (!initialized.created) {
          const raced = fingerprintFileOrUndefined(this.#mirrorFile(claim.activeSessionId));
          if (raced === undefined || !sameFingerprint(raced, claim.expectedTail)) {
            return this.#recoverIntoPrivateMirror(canonical, pricing);
          }
        }
      }
      try {
        reconcileSessionMirror(this.#dir, claim.activeSessionId, canonical, pricing);
        this.#refreshExpectedTail('active');
        return claim.activeSessionId;
      } catch (error) {
        if (!(error instanceof LegacySessionCheckpointMismatchError)) throw error;
        return this.#recoverIntoPrivateMirror(canonical, pricing);
      }
    }
    if (claim.status === 'active' && expectedMatches) {
      reconcileSessionMirror(this.#dir, claim.activeSessionId, canonical, pricing);
      this.#refreshExpectedTail('active');
      return claim.activeSessionId;
    }

    // A stale expected fingerprint can be our own canonical-before-claim crash. If the mirror is
    // still a canonical prefix, deterministic repair proves there was no foreign fact to absorb.
    if (claim.status === 'active') {
      try {
        reconcileSessionMirror(this.#dir, claim.activeSessionId, canonical, pricing);
        this.#refreshExpectedTail('active');
        return claim.activeSessionId;
      } catch (error) {
        if (!(error instanceof LegacySessionCheckpointMismatchError)) throw error;
      }
    }

    return this.#recoverIntoPrivateMirror(canonical, pricing);
  }

  assertCurrent(): void {
    const claim = this.#requireClaim();
    if (claim.status !== 'active') {
      throw new LegacySessionConcurrentWriterError('mirror claim is quarantined');
    }
    const actual = fingerprintFileOrUndefined(this.#mirrorFile(claim.activeSessionId));
    if (actual === undefined || !sameFingerprint(actual, claim.expectedTail)) {
      this.#quarantine('unexpected legacy mirror tail');
    }
  }

  beforeAppend(record: SessionRecord): void {
    this.assertCurrent();
    const claim = this.#requireClaim();
    const current = readFileSync(this.#mirrorFile(claim.activeSessionId));
    const suffix = new TextEncoder().encode(`${JSON.stringify(record)}\n`);
    const expected = new Uint8Array(current.byteLength + suffix.byteLength);
    expected.set(current, 0);
    expected.set(suffix, current.byteLength);
    this.#expectedAppend = expected;
  }

  afterAppend(record: SessionRecord): void {
    void record;
    const claim = this.#requireClaim();
    const expected = this.#expectedAppend;
    this.#expectedAppend = undefined;
    if (expected === undefined) this.#quarantine('mirror append completed without a guard snapshot');
    const actual = readFileSync(this.#mirrorFile(claim.activeSessionId));
    if (!bytesEqual(actual, expected)) this.#quarantine('concurrent write raced with mirror append');
    this.#claim = {
      ...claim,
      expectedTail: fingerprintBytes(actual),
      status: 'active',
    };
    this.#persistClaim();
  }

  #rebuildPrivateMirror(checkpoint: ThreadDriverCheckpoint, pricing?: ModelPricing): string {
    const prior = this.#requireClaim();
    for (let generation = prior.generation + 1; generation < Number.MAX_SAFE_INTEGER; generation++) {
      const sessionId = privateMirrorSessionId(
        this.#sourceSessionId,
        this.#workspaceId,
        this.#threadId,
        generation,
      );
      const store = new SessionStore(this.#dir, sessionId);
      if (existsSync(store.file)) {
        try {
          reconcileSessionMirror(this.#dir, sessionId, checkpoint, pricing);
          this.#claim = this.#newClaim(sessionId, generation);
          this.#persistClaim();
          return sessionId;
        } catch (error) {
          if (error instanceof LegacySessionCheckpointMismatchError) continue;
          throw error;
        }
      }
      const initialized = SessionStore.initializeNamed(
        this.#dir,
        sessionId,
        this.#metaForPrivateMirror(sessionId),
      );
      if (!initialized.created) continue;
      for (const message of checkpoint.frontend.transcript) {
        initialized.store.append({ type: 'message', message });
      }
      if (checkpoint.execution.compaction !== undefined) {
        initialized.store.append({
          type: 'compaction',
          ...checkpoint.execution.compaction,
        });
      }
      initialized.store.fsync();
      reconcileSessionMirror(this.#dir, sessionId, checkpoint, pricing);
      this.#claim = this.#newClaim(sessionId, generation);
      this.#persistClaim();
      return sessionId;
    }
    throw new LegacySessionConcurrentWriterError('unable to allocate a private mirror backend');
  }

  #recoverIntoPrivateMirror(checkpoint: ThreadDriverCheckpoint, pricing?: ModelPricing): string {
    const privateSessionId = this.#rebuildPrivateMirror(checkpoint, pricing);
    this.rebuiltAfterConcurrentWriter = true;
    return privateSessionId;
  }

  #metaForPrivateMirror(id: string): MetaRecord {
    return {
      type: 'meta',
      version: STORE_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      id,
      createdAt: Date.now(),
      cwd: this.#recordedCwd,
      model: this.#model.ref,
    };
  }

  #newClaim(activeSessionId: string, generation: number): PersistedLegacyMirrorClaim {
    return {
      type: 'coda_runtime_legacy_mirror_claim',
      version: 1,
      sourceSessionId: this.#sourceSessionId,
      activeSessionId,
      workspaceId: this.#workspaceId,
      threadId: this.#threadId,
      recordedCwd: this.#recordedCwd,
      backendMeta: loadSession(this.#dir, activeSessionId).meta,
      ...(this.#creationKey !== undefined && { creationKey: this.#creationKey }),
      generation,
      expectedTail: fingerprintFile(this.#mirrorFile(activeSessionId)),
      status: 'active',
    };
  }

  #refreshExpectedTail(status: PersistedLegacyMirrorClaim['status']): void {
    const claim = this.#requireClaim();
    this.#claim = {
      ...claim,
      expectedTail: fingerprintFile(this.#mirrorFile(claim.activeSessionId)),
      status,
    };
    this.#persistClaim();
  }

  #quarantine(reason: string): never {
    const claim = this.#requireClaim();
    this.#claim = { ...claim, status: 'quarantined' };
    this.#persistClaim();
    throw new LegacySessionConcurrentWriterError(reason);
  }

  #validateContext(claim: PersistedLegacyMirrorClaim): void {
    if (
      claim.sourceSessionId !== this.#sourceSessionId ||
      claim.workspaceId !== this.#workspaceId ||
      claim.threadId !== this.#threadId ||
      claim.recordedCwd !== this.#recordedCwd ||
      claim.backendMeta.cwd !== claim.recordedCwd ||
      (this.#creationKey !== undefined && claim.creationKey !== this.#creationKey)
    ) {
      throw new LegacySessionCheckpointMismatchError('persistent mirror claim context diverges');
    }
  }

  #loadClaim(): PersistedLegacyMirrorClaim | undefined {
    if (!existsSync(this.#claimFile)) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.#claimFile, 'utf8'));
    } catch (error) {
      throw new LegacySessionCheckpointMismatchError(`invalid persistent mirror claim: ${String(error)}`);
    }
    const detached = strictJsonSnapshot(parsed);
    if (detached === null || typeof detached !== 'object' || Array.isArray(detached)) {
      throw new LegacySessionCheckpointMismatchError('invalid persistent mirror claim fields');
    }
    const snapshot = detached as unknown as PersistedLegacyMirrorClaim;
    const validMeta = isValidMetaRecord(snapshot.backendMeta);
    if (
      snapshot.type !== 'coda_runtime_legacy_mirror_claim' ||
      snapshot.version !== 1 ||
      !SAFE_SESSION_ID.test(snapshot.sourceSessionId) ||
      !SAFE_SESSION_ID.test(snapshot.activeSessionId) ||
      typeof snapshot.workspaceId !== 'string' ||
      snapshot.workspaceId.length === 0 ||
      typeof snapshot.threadId !== 'string' ||
      snapshot.threadId.length === 0 ||
      typeof snapshot.recordedCwd !== 'string' ||
      (snapshot.creationKey !== undefined && typeof snapshot.creationKey !== 'string') ||
      !Number.isSafeInteger(snapshot.generation) ||
      snapshot.generation < 0 ||
      (snapshot.status !== 'creating' && snapshot.status !== 'active' && snapshot.status !== 'quarantined') ||
      !validMeta ||
      snapshot.backendMeta.id !== snapshot.activeSessionId ||
      snapshot.backendMeta.cwd !== snapshot.recordedCwd ||
      !Number.isSafeInteger(snapshot.expectedTail?.byteLength) ||
      snapshot.expectedTail.byteLength < 0 ||
      !/^[0-9a-f]{64}$/.test(snapshot.expectedTail.sha256)
    ) {
      throw new LegacySessionCheckpointMismatchError('invalid persistent mirror claim fields');
    }
    if (snapshot.status === 'creating') {
      const expectedMeta = fingerprintBytes(
        new TextEncoder().encode(`${JSON.stringify(normalizeMeta(snapshot.backendMeta))}\n`),
      );
      if (
        snapshot.activeSessionId !== snapshot.sourceSessionId ||
        snapshot.generation !== 0 ||
        snapshot.creationKey === undefined ||
        !sameFingerprint(snapshot.expectedTail, expectedMeta)
      ) {
        throw new LegacySessionCheckpointMismatchError('invalid persistent create intent');
      }
    }
    return snapshot;
  }

  #persistClaim(): void {
    const claim = strictJsonSnapshot(this.#requireClaim()) as unknown as PersistedLegacyMirrorClaim;
    mkdirSync(this.#dir, { recursive: true });
    const temporary = path.join(
      this.#dir,
      `.${this.#sourceSessionId}.${crypto.randomUUID()}.claim.tmp`,
    );
    try {
      writeFileSync(temporary, `${canonicalJson(claim)}\n`, { encoding: 'utf8', flag: 'wx' });
      const temporaryFd = openSync(temporary, 'r');
      try {
        fsyncSync(temporaryFd);
      } finally {
        closeSync(temporaryFd);
      }
      renameSync(temporary, this.#claimFile);
      const directoryFd = openSync(this.#dir, 'r');
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
    } finally {
      try {
        unlinkSync(temporary);
      } catch {
        // rename removes the temporary; failed creation may leave nothing to clean.
      }
    }
  }

  #requireClaim(): PersistedLegacyMirrorClaim {
    if (this.#claim === undefined) {
      throw new LegacySessionCheckpointMismatchError('persistent mirror claim is not initialized');
    }
    return this.#claim;
  }

  #mirrorFile(sessionId: string): string {
    return path.join(this.#dir, `${sessionId}.jsonl`);
  }
}

function isValidMetaRecord(value: unknown): value is MetaRecord {
  if (value === null || typeof value !== 'object') return false;
  const meta = value as Partial<MetaRecord>;
  const model = meta.model;
  return meta.type === 'meta'
    && meta.version === STORE_VERSION
    && typeof meta.protocolVersion === 'string'
    && meta.protocolVersion.length > 0
    && typeof meta.id === 'string'
    && SAFE_SESSION_ID.test(meta.id)
    && Number.isSafeInteger(meta.createdAt)
    && (meta.createdAt ?? -1) >= 0
    && typeof meta.cwd === 'string'
    && model !== null
    && typeof model === 'object'
    && typeof model.provider === 'string'
    && typeof model.api === 'string'
    && typeof model.model === 'string';
}

/** Restore SessionStore's frozen JSON field order after canonical claim JSON sorting. */
function normalizeMeta(meta: MetaRecord): MetaRecord {
  return {
    type: 'meta',
    version: STORE_VERSION,
    protocolVersion: meta.protocolVersion,
    id: meta.id,
    createdAt: meta.createdAt,
    cwd: meta.cwd,
    model: {
      provider: meta.model.provider,
      api: meta.model.api,
      model: meta.model.model,
    },
  };
}

function privateMirrorSessionId(
  sourceSessionId: string,
  workspaceId: WorkspaceId,
  threadId: ThreadId,
  generation: number,
): string {
  const hash = createHash('sha256')
    .update(canonicalJson([sourceSessionId, workspaceId, threadId]), 'utf8')
    .digest('hex')
    .slice(0, 32);
  return `runtime-private-${hash}-${generation.toString(36)}`;
}

function fingerprintFile(file: string): MirrorTailFingerprint {
  return fingerprintBytes(readFileSync(file));
}

function fingerprintFileOrUndefined(file: string): MirrorTailFingerprint | undefined {
  return existsSync(file) ? fingerprintFile(file) : undefined;
}

function fingerprintBytes(bytes: Uint8Array): MirrorTailFingerprint {
  return {
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function sameFingerprint(left: MirrorTailFingerprint, right: MirrorTailFingerprint): boolean {
  return left.byteLength === right.byteLength && left.sha256 === right.sha256;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * Canonical journal wins recovery. A legacy mirror may be a strict prefix when the process died
 * after host.commitEvent but before Session.append; append only that missing suffix. Any divergent
 * or unrepresentable executor state is quarantined instead of being disguised as a match.
 */
function reconcileSessionMirror(
  dir: string,
  id: string,
  checkpoint: ThreadDriverCheckpoint,
  pricing?: ModelPricing,
): void {
  if (
    checkpoint.frontend.pendingControls.length > 0
  ) {
    throw new LegacySessionCheckpointMismatchError(
      'legacy Session cannot hydrate pending controls',
    );
  }
  const store = new SessionStore(dir, id);
  store.repairTail();
  const loaded = loadSession(dir, id);
  const canonicalTranscript = checkpoint.frontend.transcript;
  if (loaded.messages.length > canonicalTranscript.length) {
    throw new LegacySessionCheckpointMismatchError('legacy transcript is ahead of canonical transcript');
  }
  for (let index = 0; index < loaded.messages.length; index++) {
    if (canonicalJson(loaded.messages[index]) !== canonicalJson(canonicalTranscript[index])) {
      throw new LegacySessionCheckpointMismatchError(`legacy transcript diverges at message ${index}`);
    }
  }
  for (const message of canonicalTranscript.slice(loaded.messages.length)) {
    store.append({ type: 'message', message });
  }

  const expectedCompaction = checkpoint.execution.compaction;
  if (expectedCompaction === undefined) {
    if (loaded.lastCompaction !== undefined) {
      throw new LegacySessionCheckpointMismatchError('legacy compaction is ahead of canonical checkpoint');
    }
  } else {
    const record = {
      type: 'compaction',
      id: expectedCompaction.id,
      timestamp: expectedCompaction.timestamp,
      tailStartId: expectedCompaction.tailStartId,
      summary: expectedCompaction.summary,
      ...(expectedCompaction.contextTokensBefore !== undefined && {
        contextTokensBefore: expectedCompaction.contextTokensBefore,
      }),
    } as const;
    if (loaded.lastCompaction === undefined) {
      store.append(record);
    } else if (canonicalJson(loaded.lastCompaction) !== canonicalJson(record)) {
      throw new LegacySessionCheckpointMismatchError('legacy compaction diverges from canonical checkpoint');
    }
  }
  store.fsync();

  const repaired = loadSession(dir, id);
  if (canonicalJson(repaired.messages) !== canonicalJson(canonicalTranscript)) {
    throw new LegacySessionCheckpointMismatchError('legacy transcript repair did not converge');
  }
  const usage = new UsageTracker(pricing);
  usage.seed(repaired.messages);
  if (canonicalJson(usage.snapshot()) !== canonicalJson(checkpoint.frontend.usage)) {
    throw new LegacySessionCheckpointMismatchError('legacy usage diverges from canonical checkpoint');
  }
  const repairedCompaction = repaired.lastCompaction;
  if (
    expectedCompaction === undefined
      ? repairedCompaction !== undefined
      : repairedCompaction === undefined ||
        canonicalJson({
          id: repairedCompaction.id,
          timestamp: repairedCompaction.timestamp,
          tailStartId: repairedCompaction.tailStartId,
          summary: repairedCompaction.summary,
          ...(repairedCompaction.contextTokensBefore !== undefined && {
            contextTokensBefore: repairedCompaction.contextTokensBefore,
          }),
        }) !== canonicalJson(expectedCompaction)
  ) {
    throw new LegacySessionCheckpointMismatchError('legacy compaction repair did not converge');
  }
}

function checkpointFromSession(session: Session): ThreadDriverCheckpoint {
  const compaction = session.compactionCheckpoint();
  return snapshotCheckpoint({
    frontend: {
      model: session.currentModel(),
      transcript: [...session.messages],
      usage: session.usage(),
      queues: { steering: [], followUp: [] },
      plan: [],
      pendingControls: [],
    },
    execution: {
      ...(compaction !== undefined && {
        compaction: {
          id: compaction.id,
          timestamp: compaction.timestamp,
          tailStartId: compaction.tailStartId,
          summary: compaction.summary,
          ...(compaction.contextTokensBefore !== undefined && {
            contextTokensBefore: compaction.contextTokensBefore,
          }),
        },
      }),
    },
  });
}

function snapshotCheckpoint(checkpoint: ThreadDriverCheckpoint): ThreadDriverCheckpoint {
  return strictJsonSnapshot(checkpoint) as unknown as ThreadDriverCheckpoint;
}
