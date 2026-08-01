// Reusable bridge from the legacy Session execution/event surface to a thread-scoped runtime
// driver. This module owns no workspace storage, mirror claim, provider, tool, or CLI policy.

import type {
  ExternalOpId,
  RunId,
  RuntimeEvent,
  ThreadId,
  ToolCallPart,
  TurnId,
} from '../protocol/index.js';
import { strictJsonSnapshot } from '../protocol/index.js';
import type {
  LegacyApprovalAdapter,
  PreparedThreadDriverCommand,
  RecoveryQueueCommand,
  ThreadDriverCheckpoint,
  ThreadDriverCheckpointMutation,
  ThreadDriverEvent,
  ThreadDriverHostServices,
  ThreadDriverPort,
} from './thread-runtime-ports.js';
import type {
  LegacyThreadExecutionPort,
  SessionEvent,
} from './legacy-thread-execution.js';
import type { RuntimeTurnProvider } from '../agent/index.js';

type ActivityCommand = Extract<
  PreparedThreadDriverCommand,
  { readonly op: { readonly type: 'prompt' | 'continue' | 'compact' } }
>;
type SetModelCommand = Extract<
  PreparedThreadDriverCommand,
  { readonly op: { readonly type: 'set_model' } }
>;
type AbortCommand = Extract<
  PreparedThreadDriverCommand,
  { readonly op: { readonly type: 'abort' } }
>;

interface ActivityContext {
  readonly rootOpId: ExternalOpId;
  readonly rootRunId: RunId;
  currentRunId: RunId;
  currentTurnId?: TurnId;
  turnOrdinal: number;
  terminalStatus?: 'completed' | 'aborted' | 'error';
  retry?: { readonly predecessorRunId: RunId; readonly successorRunId: RunId };
  compaction?: { readonly predecessorRunId: RunId; readonly successorRunId: RunId };
  successorCommitPending?: RunId;
}

interface PendingQueueCommit {
  readonly opId: ExternalOpId;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

export interface LegacySessionThreadDriverOptions {
  readonly threadId: ThreadId;
  readonly host: ThreadDriverHostServices;
  readonly session: LegacyThreadExecutionPort;
  readonly approvalAdapter?: LegacyApprovalAdapter;
  readonly cwd: string;
  /** A workspace-owned mirror claim may request one canonical diagnostic before activation. */
  readonly pendingMirrorDiagnostic?: boolean;
  /** Keeps mirror error ownership outside session while preserving the driver's fatal lane. */
  readonly isMirrorConcurrencyError?: (error: unknown) => boolean;
}

/** Pure projection used by both canonical attachments and the standalone composition root. */
export function checkpointFromLegacySession(
  session: LegacyThreadExecutionPort,
): ThreadDriverCheckpoint {
  const compaction = session.compactionCheckpoint();
  return strictJsonSnapshot({
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
  }) as unknown as ThreadDriverCheckpoint;
}

export class LegacySessionThreadDriver implements ThreadDriverPort {
  readonly #threadId: ThreadId;
  readonly #host: ThreadDriverHostServices;
  readonly #session: LegacyThreadExecutionPort;
  readonly #approvalAdapter: LegacyApprovalAdapter | undefined;
  readonly #cwd: string;
  readonly #isMirrorConcurrencyError: (error: unknown) => boolean;
  readonly #pendingQueueCommits: PendingQueueCommit[] = [];
  #activity: ActivityContext | undefined;
  #activated = false;
  #recovering = false;
  #recovered = false;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #fatalError: unknown;
  #pendingMirrorDiagnostic: boolean;
  #mirrorDiagnosticCommitted = false;

  constructor(options: LegacySessionThreadDriverOptions) {
    this.#threadId = options.threadId;
    this.#host = options.host;
    this.#session = options.session;
    this.#approvalAdapter = options.approvalAdapter;
    this.#cwd = options.cwd;
    this.#pendingMirrorDiagnostic = options.pendingMirrorDiagnostic ?? false;
    this.#isMirrorConcurrencyError = options.isMirrorConcurrencyError ?? (() => false);
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
      for (const command of commands) await this.#dispatchQueueOperation({ op: command.op });
      this.#throwFatal();
      this.#recovered = true;
    } catch (error) {
      if (this.#isMirrorConcurrencyError(error)) {
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

  activityQueuedDuringCompaction(): void {
    this.#session.deferCompactionResumeToMailbox?.();
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = (async () => {
      this.#session.abort();
      for (const pending of this.#pendingQueueCommits.splice(0)) {
        pending.reject(new Error('Legacy Session driver closed'));
      }
      const failures: unknown[] = [];
      try {
        await this.#session.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await this.#approvalAdapter?.close();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) throw new AggregateError(failures, 'Legacy Session driver close failed');
    })();
    return this.#closePromise;
  }

  requestLegacyApproval(call: ToolCallPart) {
    this.#assertReady();
    if (this.#approvalAdapter === undefined || this.#host.requestLegacyApproval === undefined) {
      return Promise.reject(new Error('Legacy approval bridge is unavailable'));
    }
    return this.#host.requestLegacyApproval({
      toolCallId: call.id,
      toolName: call.name,
      cwd: this.#cwd,
      args: strictJsonSnapshot(call.arguments),
    });
  }

  readonly runtimeTurnProvider: RuntimeTurnProvider = {
    capture: async (input) => {
      this.#assertReady();
      const activity = this.#requireActivity();
      if (this.#host.captureRuntimeTurn === undefined) {
        throw new Error('Registry turn capture is unavailable');
      }
      if (activity.currentTurnId === undefined) {
        const turnOrdinal = activity.turnOrdinal + 1;
        const reservation = await this.#host.reserveTurn({
          runId: activity.currentRunId,
          turnOrdinal,
        });
        activity.turnOrdinal = turnOrdinal;
        activity.currentTurnId = reservation.turnId;
      }
      return this.#host.captureRuntimeTurn({
        rootOpId: activity.rootOpId,
        runId: activity.currentRunId,
        turnId: activity.currentTurnId,
        model: input.model,
        transcript: input.transcript,
        signal: input.signal,
      });
    },
  };

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
        let turnId = activity.currentTurnId;
        if (turnId === undefined) {
          const turnOrdinal = activity.turnOrdinal + 1;
          const reservation = await this.#host.reserveTurn({
            runId: activity.currentRunId,
            turnOrdinal,
          });
          activity.turnOrdinal = turnOrdinal;
          turnId = reservation.turnId;
          activity.currentTurnId = turnId;
        }
        await this.#host.commitEvent({
          event,
          runId: activity.currentRunId,
          turnId,
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
          // CAS target to abort dispatch before awaiting predecessor agent_end commit.
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
          if (event.reason !== 'manual') {
            throw new Error('compaction_start has no predecessor agent_end reservation');
          }
          await this.#host.commitEvent({
            event: {
              ...event,
              predecessorRunId: activity.currentRunId,
              activityRunId: activity.currentRunId,
            },
            runId: activity.currentRunId,
          });
          return;
        }
        activity.currentRunId = compaction.successorRunId;
        activity.currentTurnId = undefined;
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
        await this.#commitTurnEvent(event);
        activity.currentTurnId = undefined;
        return;
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
        case 'compact':
          return await this.#dispatchActivity(command as ActivityCommand);
        case 'set_model':
          this.#session.setModel((command as SetModelCommand).resolvedModel);
          return { kind: 'operation', outcome: 'applied' } as const;
        case 'steer':
        case 'follow_up':
          return await this.#dispatchQueueOperation(command as Extract<PreparedThreadDriverCommand, {
            op: { type: 'steer' | 'follow_up' };
          }>);
        case 'control_response':
          throw new Error('control_response is owned by ThreadRuntime');
        case 'abort':
          return await this.#dispatchAbort(command as AbortCommand);
      }
    } catch (error) {
      if (this.#isMirrorConcurrencyError(error)) {
        this.#markFatal(error);
        await this.#commitMirrorDiagnostic();
      }
      throw error;
    }
  }

  async #dispatchActivity(command: ActivityCommand) {
    if (this.#activity !== undefined) throw new Error('Legacy Session driver already has an active activity');
    const activity: ActivityContext = {
      rootOpId: command.op.opId,
      rootRunId: command.runId,
      currentRunId: command.runId,
      turnOrdinal: 0,
    };
    this.#activity = activity;
    try {
      if (command.op.type === 'compact') {
        const result = await this.#session.compact();
        this.#throwFatal();
        activity.terminalStatus = result.aborted ? 'aborted' : 'completed';
      } else if ('resolvedInput' in command && command.resolvedInput.kind === 'prompt_input') {
        await this.#session.prompt(command.resolvedInput.text);
      } else {
        await this.#session.continue();
      }
      if (command.op.type !== 'compact') await this.#session.waitForIdle();
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
    command: Extract<PreparedThreadDriverCommand, { op: { type: 'steer' | 'follow_up' } }>,
  ) {
    const { op } = command;
    const input = command.legacyQueuedMessage ?? op.text;
    if (typeof input === 'string' && input.trim().length === 0) {
      return { kind: 'operation', outcome: 'no_op' } as const;
    }
    const completion = new Promise<void>((resolve, reject) => {
      this.#pendingQueueCommits.push({ opId: op.opId, resolve, reject });
    });
    try {
      if (op.type === 'steer') this.#session.steer(input);
      else this.#session.followUp(input);
    } catch (error) {
      const pending = this.#pendingQueueCommits.findIndex((candidate) => candidate.opId === op.opId);
      if (pending >= 0) this.#pendingQueueCommits.splice(pending, 1);
      throw error;
    }
    await completion;
    this.#throwFatal();
    return { kind: 'operation', outcome: 'applied' } as const;
  }

  async #dispatchAbort(command: AbortCommand) {
    const target = command.resolvedTarget;
    if (target.kind !== 'run' || this.#activity?.currentRunId !== target.runId) {
      return { kind: 'operation', outcome: 'no_op' } as const;
    }
    const reservedSuccessorWindow = this.#activity.successorCommitPending === target.runId;
    this.#session.abort();
    // A sleeping retry successor has no agent_end of its own yet. Marking the accepted abort here
    // prevents causal completion from reusing the predecessor's terminal error.
    this.#activity.terminalStatus = 'aborted';
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

  #markFatal(error: unknown): void {
    if (this.#fatalError !== undefined) return;
    this.#fatalError = error;
    this.#session.abort();
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
