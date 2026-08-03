// Canonical RuntimeThreadExecution to ThreadRuntime driver. This module owns run/turn causality
// and authoritative commit ordering; it has no secondary persistence or approval side channel.

import type {
  ExternalOpId,
  RunId,
  RuntimeEvent,
  ThreadId,
  TurnId,
} from '../protocol/index.js';
import type { RuntimeTurnProvider } from '../agent/index.js';
import type {
  PreparedThreadDriverCommand,
  RecoveryQueueCommand,
  ThreadDriverCheckpointMutation,
  ThreadDriverEvent,
  ThreadDriverHostServices,
  ThreadDriverPort,
} from './thread-runtime-ports.js';
import type {
  RuntimeThreadExecutionEvent,
  RuntimeThreadExecutionEventBatch,
  RuntimeThreadExecutionPort,
} from './runtime-thread-execution.js';

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

export interface RuntimeThreadDriverOptions {
  readonly threadId: ThreadId;
  readonly host: ThreadDriverHostServices;
  readonly execution: RuntimeThreadExecutionPort;
}

export class RuntimeThreadDriver implements ThreadDriverPort {
  readonly #threadId: ThreadId;
  readonly #host: ThreadDriverHostServices;
  readonly #execution: RuntimeThreadExecutionPort;
  readonly #pendingQueueCommits: PendingQueueCommit[] = [];
  #activity: ActivityContext | undefined;
  #activated = false;
  #recovering = false;
  #recovered = false;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #fatalError: unknown;

  constructor(options: RuntimeThreadDriverOptions) {
    this.#threadId = options.threadId;
    this.#host = options.host;
    this.#execution = options.execution;
  }

  async recover(commands: readonly RecoveryQueueCommand[]): Promise<void> {
    this.#assertNotClosed();
    if (this.#activated || this.#recovering || this.#recovered) {
      throw new Error('Runtime thread recovery must run exactly once before activation');
    }
    this.#recovering = true;
    try {
      for (const command of commands) await this.#dispatchQueueOperation({ op: command.op });
      this.#throwFatal();
      this.#recovered = true;
    } finally {
      this.#recovering = false;
    }
  }

  async activate(): Promise<void> {
    this.#assertNotClosed();
    if (!this.#recovered || this.#recovering) {
      throw new Error('Runtime thread driver must finish recovery before activation');
    }
    this.#activated = true;
  }

  dispatch(command: PreparedThreadDriverCommand): ReturnType<ThreadDriverPort['dispatch']> {
    this.#assertReady();
    return { completion: this.#dispatch(command) };
  }

  interactionState(): ReturnType<ThreadDriverPort['interactionState']> {
    return this.#execution.interactionState();
  }

  activityQueuedDuringCompaction(): void {
    this.#execution.deferCompactionResumeToMailbox();
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    this.#execution.abort();
    for (const pending of this.#pendingQueueCommits.splice(0)) {
      pending.reject(new Error('Runtime thread driver closed'));
    }
    this.#closePromise = this.#execution.close();
    return this.#closePromise;
  }

  readonly runtimeTurnProvider: RuntimeTurnProvider = {
    capture: async (input) => {
      this.#assertReady();
      const activity = this.#requireActivity();
      if (this.#host.captureRuntimeTurn === undefined) {
        throw new Error('Runtime turn capture is unavailable');
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

  async commitExecutionEvent(event: RuntimeThreadExecutionEvent): Promise<void> {
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
          this.#markFatal(error);
          throw error;
        }
        return;
      }
    }
    const activity = this.#requireActivity();
    try {
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
          await this.#host.commitEvent({ event, runId: activity.currentRunId, turnId });
          return;
        }
        case 'agent_end': {
          const predecessorRunId = activity.currentRunId;
          const successorReason = event.willRetry === true
            ? 'retry'
            : this.#execution.runtimeFollowUpState() === 'compacting'
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
            activity.currentRunId = successor.runId;
            activity.turnOrdinal = 0;
            activity.successorCommitPending = successor.runId;
          }
          await this.#host.commitEvent({
            event,
            runId: predecessorRunId,
            ...(predecessorRunId === activity.rootRunId && { opId: activity.rootOpId }),
          });
          // Only an abort of the already-reserved successor may supersede this predecessor event.
          // Without a successor, the durable agent_end remains the root activity's terminal fact.
          if (successor === undefined || activity.terminalStatus !== 'aborted') {
            activity.terminalStatus = event.reason;
          }
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
          const checkpoint = event.ok ? this.#execution.compactionCheckpoint() : undefined;
          const mutation: ThreadDriverCheckpointMutation | undefined = checkpoint === undefined
            ? undefined
            : { type: 'compaction_committed', compaction: checkpoint };
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
        case 'queue_update':
          if (activity.currentTurnId !== undefined) await this.#commitTurnEvent(event);
          else await this.#host.commitEvent({ event, opId: activity.rootOpId });
          return;
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
    } catch (error) {
      this.#markFatal(error);
      throw error;
    }
  }

  async commitExecutionEvents(events: RuntimeThreadExecutionEventBatch): Promise<void> {
    if (events.length === 1) {
      await this.commitExecutionEvent(events[0]);
      return;
    }
    this.#assertEventSinkReady();
    this.#throwFatal();
    const [messageEvent, usageEvent, ...unexpected] = events;
    if (unexpected.length !== 0
      || messageEvent.type !== 'message_end'
      || usageEvent?.type !== 'usage_update') {
      // Coordinator batches have causal transitions between individual events and must pass
      // through the normal state machine one by one. Only transcript+usage is one atomic commit.
      for (const event of events) await this.commitExecutionEvent(event);
      return;
    }
    const activity = this.#requireActivity();
    const turnId = activity.currentTurnId;
    if (turnId === undefined) throw new Error('message_end batch has no active turn');
    const inputs: [ThreadDriverEvent, ThreadDriverEvent] = [
      { event: messageEvent, runId: activity.currentRunId, turnId },
      { event: usageEvent, runId: activity.currentRunId, turnId },
    ];
    try {
      await this.#host.commitEventBatch(inputs);
    } catch (error) {
      this.#markFatal(error);
      throw error;
    }
  }

  async #dispatch(command: PreparedThreadDriverCommand) {
    this.#throwFatal();
    switch (command.op.type) {
      case 'prompt':
      case 'continue':
      case 'compact':
        return this.#dispatchActivity(command as ActivityCommand);
      case 'set_model':
        this.#execution.setModel((command as SetModelCommand).resolvedModel);
        return { kind: 'operation', outcome: 'applied' } as const;
      case 'steer':
      case 'follow_up':
        return this.#dispatchQueueOperation(command as Extract<PreparedThreadDriverCommand, {
          readonly op: { readonly type: 'steer' | 'follow_up' };
        }>);
      case 'control_response':
        throw new Error('control_response is owned by ThreadRuntime');
      case 'abort':
        return this.#dispatchAbort(command as AbortCommand);
    }
  }

  async #dispatchActivity(command: ActivityCommand) {
    if (this.#activity !== undefined) throw new Error('Runtime thread already has an active activity');
    const activity: ActivityContext = {
      rootOpId: command.op.opId,
      rootRunId: command.runId,
      currentRunId: command.runId,
      turnOrdinal: 0,
    };
    this.#activity = activity;
    try {
      if (command.op.type === 'compact') {
        const result = await this.#execution.compact();
        this.#throwFatal();
        activity.terminalStatus = result.aborted ? 'aborted' : 'completed';
      } else if ('resolvedInput' in command && command.resolvedInput.kind === 'prompt_input') {
        await this.#execution.prompt(command.resolvedInput.text);
      } else {
        await this.#execution.continue();
      }
      if (command.op.type !== 'compact') await this.#execution.waitForIdle();
      this.#throwFatal();
      if (activity.terminalStatus === undefined) {
        throw new Error('Runtime thread activity completed without agent_end');
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
    command: Extract<PreparedThreadDriverCommand, {
      readonly op: { readonly type: 'steer' | 'follow_up' };
    }>,
  ) {
    const { op } = command;
    if (op.text.trim().length === 0) return { kind: 'operation', outcome: 'no_op' } as const;
    const completion = new Promise<void>((resolve, reject) => {
      this.#pendingQueueCommits.push({ opId: op.opId, resolve, reject });
    });
    try {
      if (op.type === 'steer') this.#execution.steer(op.text);
      else this.#execution.followUp(op.text);
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
    this.#execution.abort();
    this.#activity.terminalStatus = 'aborted';
    if (!reservedSuccessorWindow) await this.#execution.waitForIdle();
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

  #markFatal(error: unknown): void {
    if (this.#fatalError !== undefined) return;
    this.#fatalError = error;
    this.#execution.abort();
    for (const pending of this.#pendingQueueCommits.splice(0)) pending.reject(error);
  }

  #throwFatal(): void {
    if (this.#fatalError !== undefined) throw this.#fatalError;
  }

  #requireActivity(): ActivityContext {
    if (this.#activity === undefined) throw new Error('Runtime thread event has no active activity');
    return this.#activity;
  }

  #assertReady(): void {
    this.#assertNotClosed();
    if (!this.#activated) throw new Error('Runtime thread driver is quarantined');
    this.#throwFatal();
  }

  #assertEventSinkReady(): void {
    this.#assertNotClosed();
    if (!this.#activated && !this.#recovering) {
      throw new Error('Runtime thread driver is quarantined');
    }
    this.#throwFatal();
  }

  #assertNotClosed(): void {
    if (this.#closed) throw new Error('Runtime thread driver is closed');
  }
}
