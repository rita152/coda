// One thread's phase-1 FIFO admission/mailbox and active-run gate. Driver dispatch is deliberately
// not awaited by the mailbox so steer/follow-up/abort can reach an active run.

import {
  canonicalJson,
  isDerivedOpId,
  isRunId,
  isTurnId,
} from '../protocol/index.js';
import type {
  ExternalThreadRuntimeOp,
  InternalOpReceipt,
  InternalThreadRuntimeOp,
  MailboxRuntimeOp,
  ModelConfig,
  OpId,
  OpReceipt,
  PermissionCeilingSnapshot,
  ResolvedAbortTarget,
  RunId,
  RuntimeOp,
  ThreadId,
  ThreadSnapshot,
  TurnId,
  WorkspaceId,
} from '../protocol/index.js';
import type {
  PermissionPolicyPort,
  PreparedThreadDriverCommand,
  RuntimeClock,
  RuntimeIdentityFactory,
  RuntimeThreadMutation,
  ThreadResultDeliveryRecord,
  ThreadResultOutboxMutation,
  ThreadDriverAttachment,
  ThreadDriverCheckpointMutation,
  ThreadDriverEvent,
  ThreadDriverHostServices,
} from './ports.js';
import { RuntimeStorageError } from './errors.js';
import { validatePermissionCeilingSnapshot } from './permission-ceiling.js';
import { snapshotFromFold, ThreadJournalWriter } from './thread-journal.js';
import type { FoldedThreadJournal } from './thread-journal.js';

interface ActiveRun {
  readonly rootOpId: OpId;
  readonly rootRunId: RunId;
  currentRunId: RunId;
  currentCeiling: PermissionCeilingSnapshot;
}

interface QueuedActivity {
  readonly op: Extract<RuntimeOp, { type: 'prompt' }>;
  readonly runId: RunId;
  readonly permissionCeiling: PermissionCeilingSnapshot;
  readonly command: Extract<PreparedThreadDriverCommand, { op: { type: 'prompt' } }>;
}

export interface ThreadRuntimeOptions {
  readonly workspaceId: WorkspaceId;
  readonly cwd: string;
  readonly threadId: ThreadId;
  readonly writer: ThreadJournalWriter;
  readonly attachment: ThreadDriverAttachment;
  readonly identityFactory: RuntimeIdentityFactory;
  readonly clock: RuntimeClock;
  readonly permissionPolicy: PermissionPolicyPort;
  readonly threadCeiling: PermissionCeilingSnapshot;
  readonly onThreadResultPending?: (result: ThreadResultOutboxMutation) => Promise<void>;
}

export class ThreadDriverHostController implements ThreadDriverHostServices {
  #runtime: Phase1ThreadRuntime | undefined;

  bind(runtime: Phase1ThreadRuntime): void {
    if (this.#runtime !== undefined) throw new Error('Thread driver host is already bound');
    this.#runtime = runtime;
  }

  commitEvent(
    event: ThreadDriverEvent,
    checkpointMutation?: ThreadDriverCheckpointMutation,
  ): Promise<void> {
    return this.#get().commitDriverEvent(event, checkpointMutation);
  }

  commitEventBatch(
    events: readonly [ThreadDriverEvent, ...ThreadDriverEvent[]],
    checkpointMutation?: ThreadDriverCheckpointMutation,
  ): Promise<void> {
    return this.#get().commitDriverEventBatch(events, checkpointMutation);
  }

  reserveSuccessor(input: {
    readonly threadId: ThreadId;
    readonly predecessorRunId: RunId;
    readonly reason: 'retry' | 'compaction';
  }): Promise<{ readonly runId: RunId; readonly permissionCeiling: PermissionCeilingSnapshot }> {
    return this.#get().reserveSuccessor(input);
  }

  reserveTurn(input: {
    readonly runId: RunId;
    readonly turnOrdinal: number;
  }): Promise<{
    readonly turnId: TurnId;
    readonly workspaceCeiling: PermissionCeilingSnapshot;
    readonly runCeiling: PermissionCeilingSnapshot;
    readonly turnCeiling: PermissionCeilingSnapshot;
  }> {
    return this.#get().reserveTurn(input);
  }

  #get(): Phase1ThreadRuntime {
    if (this.#runtime === undefined) throw new Error('Thread driver emitted before attachment activation');
    return this.#runtime;
  }
}

export class Phase1ThreadRuntime {
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly #cwd: string;
  readonly #writer: ThreadJournalWriter;
  readonly #attachment: ThreadDriverAttachment;
  readonly #identityFactory: RuntimeIdentityFactory;
  readonly #clock: RuntimeClock;
  readonly #permissionPolicy: PermissionPolicyPort;
  readonly #threadCeiling: PermissionCeilingSnapshot;
  readonly #onThreadResultPending: ((result: ThreadResultOutboxMutation) => Promise<void>) | undefined;
  #admission: Promise<void> = Promise.resolve();
  #active: ActiveRun | undefined;
  readonly #queuedActivities: QueuedActivity[] = [];
  #closing = false;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #effectBarrier: Promise<void> = Promise.resolve();
  readonly #background = new Set<Promise<void>>();
  readonly #bestEffort = new Set<Promise<void>>();
  readonly #backgroundFailures: unknown[] = [];
  readonly #turnReservations = new Map<string, {
    readonly turnId: TurnId;
    readonly workspaceCeiling: PermissionCeilingSnapshot;
    readonly runCeiling: PermissionCeilingSnapshot;
    readonly turnCeiling: PermissionCeilingSnapshot;
    readonly turnOrdinal: number;
    activated: boolean;
  }>();
  readonly #successors = new Map<string, {
    readonly runId: RunId;
    readonly permissionCeiling: PermissionCeilingSnapshot;
    readonly predecessorRunId: RunId;
    readonly reason: 'retry' | 'compaction';
  }>();
  #pendingSuccessor: {
    readonly runId: RunId;
    readonly permissionCeiling: PermissionCeilingSnapshot;
    readonly predecessorRunId: RunId;
    readonly reason: 'retry' | 'compaction';
  } | undefined;

  constructor(options: ThreadRuntimeOptions) {
    this.workspaceId = options.workspaceId;
    this.threadId = options.threadId;
    this.#cwd = options.cwd;
    this.#writer = options.writer;
    this.#attachment = options.attachment;
    this.#identityFactory = options.identityFactory;
    this.#clock = options.clock;
    this.#permissionPolicy = options.permissionPolicy;
    this.#threadCeiling = options.threadCeiling;
    this.#onThreadResultPending = options.onThreadResultPending;
    for (const run of this.#writer.state.runs.values()) {
      if (run.predecessorRunId === undefined || (run.reason !== 'retry' && run.reason !== 'compaction')) continue;
      this.#successors.set(successorKey(run.predecessorRunId, run.reason), {
        runId: run.runId,
        permissionCeiling: run.permissionCeiling,
        predecessorRunId: run.predecessorRunId,
        reason: run.reason,
      });
    }
    for (const turn of this.#writer.state.turns.values()) {
      if (
        turn.workspaceCeiling === undefined ||
        turn.runCeiling === undefined ||
        turn.turnCeiling === undefined
      ) continue;
      const reservation = {
        turnId: turn.turnId,
        workspaceCeiling: turn.workspaceCeiling,
        runCeiling: turn.runCeiling,
        turnCeiling: turn.turnCeiling,
        turnOrdinal: turn.turnOrdinal,
        activated: turn.activated,
      };
      this.#turnReservations.set(turnOrdinalKey(turn.runId, turn.turnOrdinal), reservation);
      this.#turnReservations.set(turnIdentityKey(turn.runId, turn.turnId), reservation);
    }
  }

  snapshot(): Readonly<ThreadSnapshot> {
    return snapshotFromFold(this.#writer.state);
  }

  durableState(): FoldedThreadJournal {
    return this.#writer.state;
  }

  summary(): import('../protocol/index.js').ThreadSummary {
    return this.#writer.state.summary;
  }

  activeRunId(): RunId | undefined {
    return this.#active?.currentRunId;
  }

  currentAbortTarget(): ResolvedAbortTarget {
    return this.#resolveAbortTarget();
  }

  activeRunCeiling(runId: RunId): PermissionCeilingSnapshot | undefined {
    if (this.#active?.currentRunId === runId) return this.#active.currentCeiling;
    return this.#writer.state.runs.get(runId)?.permissionCeiling;
  }

  async commitThreadResult(result: ThreadResultOutboxMutation): Promise<number> {
    if (result.parentThreadId !== this.threadId) throw new Error('thread_result_parent_mismatch');
    const existing = this.#writer.state.envelopes.find((envelope) => envelope.opId === result.resultOpId);
    if (existing !== undefined) {
      if (existing.event.type !== 'thread_result' || canonicalJson(existing.event) !== canonicalJson({
        type: 'thread_result',
        resultOpId: result.resultOpId,
        childThreadId: result.childThreadId,
        terminalRunId: result.terminalRunId,
        status: result.status,
        ...(result.summary !== undefined && { summary: result.summary }),
      })) {
        throw new RuntimeStorageError('thread_result_conflict', result.resultOpId);
      }
      return existing.seq;
    }
    const [envelope] = await this.#writer.commit([{
      event: {
        type: 'thread_result',
        resultOpId: result.resultOpId,
        childThreadId: result.childThreadId,
        terminalRunId: result.terminalRunId,
        status: result.status,
        ...(result.summary !== undefined && { summary: result.summary }),
      },
      opId: result.resultOpId,
    }]);
    if (envelope === undefined) throw new Error('thread_result_commit_missing');
    return envelope.seq;
  }

  async acknowledgeThreadResult(record: ThreadResultDeliveryRecord): Promise<void> {
    if (this.#writer.state.deliveredThreadResults.has(record.resultOpId)) return;
    await this.#writer.appendPrepare(record);
  }

  acceptExternal(
    op: ExternalThreadRuntimeOp,
    prepared?: { readonly resolvedModel: ModelConfig },
  ): Promise<OpReceipt> {
    return this.#withAdmission(() => this.#acceptExternal(op, prepared));
  }

  acceptInternal(op: InternalThreadRuntimeOp): Promise<InternalOpReceipt> {
    return this.#withAdmission(() => this.#acceptInternal(op));
  }

  async commitDriverEvent(
    input: ThreadDriverEvent,
    checkpointMutation?: ThreadDriverCheckpointMutation,
  ): Promise<void> {
    await this.commitDriverEventBatch([input], checkpointMutation);
  }

  async commitDriverEventBatch(
    inputs: readonly [ThreadDriverEvent, ...ThreadDriverEvent[]],
    checkpointMutation?: ThreadDriverCheckpointMutation,
  ): Promise<void> {
    if (this.#closed) throw new Error(`Thread ${this.threadId} is closed`);
    const extra: RuntimeThreadMutation[] = [];
    let activatesSuccessor = false;
    const pendingSuccessor = this.#pendingSuccessor;
    const virtuallyActivatedRuns = new Set<RunId>();
    const virtuallyActivatedTurns = new Set<string>();
    const turnsToActivate: Array<{
      readonly key: string;
      readonly reservation: {
        activated: boolean;
        readonly turnOrdinal: number;
      };
    }> = [];
    let inputMaterialized = false;
    for (const input of inputs) {
      this.#assertDriverEventIdentity(input, virtuallyActivatedRuns, virtuallyActivatedTurns);
      const activatesAtAgentEnd =
        !activatesSuccessor &&
        pendingSuccessor !== undefined &&
        input.event.type === 'agent_end' &&
        input.runId === pendingSuccessor.predecessorRunId;
      const activatesAtCompactionStart =
        !activatesSuccessor &&
        pendingSuccessor !== undefined &&
        pendingSuccessor.reason === 'compaction' &&
        input.event.type === 'compaction_start' &&
        input.runId === pendingSuccessor.runId &&
        input.event.predecessorRunId === pendingSuccessor.predecessorRunId;
      if (pendingSuccessor !== undefined && this.#active !== undefined
        && (activatesAtAgentEnd || activatesAtCompactionStart)) {
        const predecessor = this.#writer.state.runs.get(pendingSuccessor.predecessorRunId);
        if (predecessor === undefined) throw new Error('successor predecessor is not durable');
        extra.push(
          {
            type: 'run_terminal',
            runId: pendingSuccessor.predecessorRunId,
            status: input.event.type === 'agent_end'
              ? input.event.reason === 'aborted'
                ? 'aborted'
                : input.event.reason === 'error' ? 'error' : 'completed'
              : input.event.reason === 'overflow' ? 'error' : 'completed',
          },
          {
            type: 'run_reserved',
            runId: pendingSuccessor.runId,
            reason: pendingSuccessor.reason,
            predecessorRunId: pendingSuccessor.predecessorRunId,
            permissionCeiling: pendingSuccessor.permissionCeiling,
          },
        );
        virtuallyActivatedRuns.add(pendingSuccessor.runId);
        if (activatesAtCompactionStart) {
          extra.push({ type: 'run_started', runId: pendingSuccessor.runId });
        }
        activatesSuccessor = true;
      }
      if (input.event.type === 'turn_start') {
        if (input.runId === undefined || input.turnId === undefined) {
          throw new Error('turn_start requires a reserved runId/turnId');
        }
        const key = turnIdentityKey(input.runId, input.turnId);
        const reservation = this.#turnReservations.get(key);
        if (reservation === undefined || reservation.activated || virtuallyActivatedTurns.has(key)) {
          throw new Error('turn_start does not match a fresh turn reservation');
        }
        virtuallyActivatedTurns.add(key);
        turnsToActivate.push({ key, reservation });
        extra.push({
          type: 'turn_activated',
          runId: input.runId,
          turnId: input.turnId,
          turnOrdinal: reservation.turnOrdinal,
        });
      }
      if (input.event.type === 'agent_start' && input.runId !== undefined) {
        const run = this.#writer.state.runs.get(input.runId);
        if (run?.state === 'reserved' || virtuallyActivatedRuns.has(input.runId)) {
          extra.push({ type: 'run_started', runId: input.runId });
        }
      }
      if (!inputMaterialized
        && input.event.type === 'message_end'
        && input.event.message.role === 'user'
        && input.event.message.source === 'prompt'
        && this.#active !== undefined
        && this.#writer.state.inputOwners.has(this.#active.rootOpId)) {
        extra.push({
          type: 'input_materialized',
          ownerOpId: this.#active.rootOpId,
          messageId: input.event.message.id,
        });
        inputMaterialized = true;
      }
    }
    await this.#writer.commitDriverEvents(inputs, checkpointMutation, extra);
    for (const { reservation } of turnsToActivate) reservation.activated = true;
    if (activatesSuccessor) this.#pendingSuccessor = undefined;
  }

  reserveSuccessor(input: {
    readonly threadId: ThreadId;
    readonly predecessorRunId: RunId;
    readonly reason: 'retry' | 'compaction';
  }): Promise<{ readonly runId: RunId; readonly permissionCeiling: PermissionCeilingSnapshot }> {
    return this.#withAdmission(async () => {
      if (input.threadId !== this.threadId) throw new Error('invalid_successor_reservation');
      const key = successorKey(input.predecessorRunId, input.reason);
      const existing = this.#successors.get(key);
      if (existing !== undefined) return existing;
      if (this.#active?.currentRunId !== input.predecessorRunId) {
        throw new Error('invalid_successor_reservation');
      }
      if ([...this.#successors.values()].some((candidate) => candidate.predecessorRunId === input.predecessorRunId)) {
        throw new Error('invalid_successor_reservation');
      }
      const runId = this.#newRunId();
      const workspaceCeiling = await this.#workspaceCeiling();
      const permissionCeiling = validatePermissionCeilingSnapshot(await this.#permissionPolicy.resolveCeiling({
        kind: 'run',
        workspaceId: this.workspaceId,
        threadId: this.threadId,
        runId,
        workspaceCeiling,
        threadCeiling: this.#threadCeiling,
        predecessorRunId: input.predecessorRunId,
        predecessorCeiling: this.#active.currentCeiling,
      }));
      await this.#writer.appendPrepare({
        type: 'successor_run_prepare',
        runId,
        predecessorRunId: input.predecessorRunId,
        reason: input.reason,
        permissionCeiling,
        timestamp: this.#clock.now(),
      });
      const reservation = {
        runId,
        permissionCeiling,
        predecessorRunId: input.predecessorRunId,
        reason: input.reason,
      };
      this.#successors.set(key, reservation);
      this.#pendingSuccessor = reservation;
      this.#active.currentRunId = runId;
      this.#active.currentCeiling = permissionCeiling;
      return reservation;
    });
  }

  reserveTurn(input: {
    readonly runId: RunId;
    readonly turnOrdinal: number;
  }): Promise<{
    readonly turnId: TurnId;
    readonly workspaceCeiling: PermissionCeilingSnapshot;
    readonly runCeiling: PermissionCeilingSnapshot;
    readonly turnCeiling: PermissionCeilingSnapshot;
  }> {
    return this.#withAdmission(async () => {
      if (
        this.#active?.currentRunId !== input.runId ||
        !Number.isSafeInteger(input.turnOrdinal) ||
        input.turnOrdinal < 1
      ) {
        throw new Error('invalid_turn_reservation');
      }
      const ordinalKey = turnOrdinalKey(input.runId, input.turnOrdinal);
      const prior = this.#turnReservations.get(ordinalKey);
      if (prior !== undefined) return prior;
      const previousOrdinals = [...this.#writer.state.turns.values()]
        .filter((turn) => turn.runId === input.runId)
        .map((turn) => turn.turnOrdinal);
      const expected = (previousOrdinals.length === 0 ? 0 : Math.max(...previousOrdinals)) + 1;
      if (input.turnOrdinal !== expected) throw new Error('invalid_turn_reservation');
      const turnId = this.#newTurnId();
      const workspaceCeiling = await this.#workspaceCeiling();
      const runCeiling = this.#active.currentCeiling;
      const turnCeiling = validatePermissionCeilingSnapshot(await this.#permissionPolicy.resolveCeiling({
        kind: 'turn',
        workspaceId: this.workspaceId,
        threadId: this.threadId,
        runId: input.runId,
        turnId,
        workspaceCeiling,
        runCeiling,
      }));
      await this.#writer.appendPrepare({
        type: 'turn_prepare',
        runId: input.runId,
        turnId,
        turnOrdinal: input.turnOrdinal,
        workspaceCeiling,
        runCeiling,
        turnCeiling,
        timestamp: this.#clock.now(),
      });
      const reservation = {
        turnId,
        workspaceCeiling,
        runCeiling,
        turnCeiling,
        turnOrdinal: input.turnOrdinal,
        activated: false,
      };
      this.#turnReservations.set(ordinalKey, reservation);
      this.#turnReservations.set(turnIdentityKey(input.runId, turnId), reservation);
      return reservation;
    });
  }

  close(op?: InternalThreadRuntimeOp | Extract<RuntimeOp, { type: 'thread_close' }>): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closing = true;
    this.#closePromise = (async () => {
      await this.#admission;
      const failures: unknown[] = [];
      if (this.#active !== undefined) {
        const abortCommand: PreparedThreadDriverCommand = {
          op: {
            type: 'abort',
            opId: op?.opId ?? this.#active.rootOpId,
            workspaceId: this.workspaceId,
            threadId: this.threadId,
            ...(op !== undefined && 'parentOpId' in op && op.parentOpId !== undefined
              ? { parentOpId: op.parentOpId }
              : {}),
            resolvedTarget: { kind: 'run', runId: this.#active.currentRunId },
          } as Extract<MailboxRuntimeOp, { type: 'abort' }>,
          resolvedTarget: { kind: 'run', runId: this.#active.currentRunId },
        };
        await this.#attachment.driver.dispatch(abortCommand).completion.catch((error) => failures.push(error));
      }
      while (this.#background.size > 0) {
        await Promise.all([...this.#background]);
      }
      failures.push(...this.#backgroundFailures);
      try {
        await this.#attachment.driver.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        if (op !== undefined) {
          const parentOpId = 'parentOpId' in op ? op.parentOpId : undefined;
          const outcome = failures.length === 0 ? 'applied' : 'interrupted';
          await this.#writer.commit([
            {
              event: {
                type: 'op_completed',
                opType: 'thread_close',
                outcome,
                ...(parentOpId !== undefined && { parentOpId }),
              },
              opId: op.opId,
            },
            {
              event: { type: 'thread_closed', threadId: this.threadId },
              opId: op.opId,
            },
          ], [{ type: 'completed', opId: op.opId, outcome }]);
        }
      } catch (error) {
        failures.push(error);
      } finally {
        this.#closed = true;
        try {
          await this.#writer.close();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, `Thread ${this.threadId} close failed`);
    })();
    return this.#closePromise;
  }

  async #acceptExternal(
    op: ExternalThreadRuntimeOp,
    prepared?: { readonly resolvedModel: ModelConfig },
  ): Promise<OpReceipt> {
    await this.#effectBarrier;
    if (this.#closing || this.#closed) return rejectedExternal(op, 'thread_closed');
    const prior = this.#writer.state.mailbox.get(op.opId);
    if (prior !== undefined) {
      if (canonicalJson(prior.op) !== canonicalJson(op)) {
        return rejectedExternal(op, 'op_id_conflict');
      }
      if (prior.state === 'prepared') {
        const receipt = await this.#rejectExternal(op, 'interrupted_before_accept');
        return { ...receipt, duplicate: true };
      }
      if (prior.state === 'rejected') {
        return {
          accepted: false,
          opId: op.opId,
          duplicate: true,
          reason: prior.reason ?? 'rejected',
          threadId: this.threadId,
        };
      }
      const run = [...this.#writer.state.runs.values()].find((entry) => entry.ownerOpId === op.opId);
      return {
        accepted: true,
        opId: op.opId,
        duplicate: true,
        threadId: this.threadId,
        ...(run !== undefined && { runId: run.runId }),
      };
    }
    await this.#writer.appendPrepare({
      type: 'mailbox_prepare',
      opId: op.opId,
      op,
      timestamp: this.#clock.now(),
    });

    switch (op.type) {
      case 'prompt':
      case 'continue':
        return this.#acceptActivity(op);
      case 'set_model':
        if (this.#active !== undefined || this.#attachment.driver.interactionState() !== 'idle') {
          return this.#rejectExternal(op, 'thread_busy');
        }
        if (prepared === undefined) return this.#rejectExternal(op, 'model_resolution_missing');
        await this.#acceptOperation(op, { op, resolvedModel: prepared.resolvedModel });
        return { accepted: true, opId: op.opId, duplicate: false, threadId: this.threadId };
      case 'steer':
      case 'follow_up':
      case 'control_response': {
        if (op.type === 'control_response') {
          if (this.#writer.state.controlClaims.has(op.requestId)) {
            return this.#rejectExternal(op, 'control_response_already_claimed');
          }
          const pending = this.#writer.state.checkpoint.frontend.pendingControls
            .find((request) => request.requestId === op.requestId);
          if (pending === undefined) return this.#rejectExternal(op, 'control_request_not_found');
          const valid = pending.kind === 'approval'
            ? op.decision === 'allow_once' || op.decision === 'allow_always' || op.decision === 'deny'
            : op.decision === 'confirm' || op.decision === 'deny';
          if (!valid) return this.#rejectExternal(op, 'invalid_decision');
        }
        await this.#acceptOperation(op, { op });
        return { accepted: true, opId: op.opId, duplicate: false, threadId: this.threadId };
      }
      case 'abort': {
        const target = this.#resolveAbortTarget(op.expectedRunId);
        if (op.expectedRunId !== undefined && target.kind === 'no_current_activity') {
          return this.#rejectExternal(op, 'stale_run');
        }
        await this.#acceptAbort(op, target);
        return { accepted: true, opId: op.opId, duplicate: false, threadId: this.threadId };
      }
      case 'thread_close':
        await this.#writer.commit([
          { event: { type: 'op_accepted', opType: op.type }, opId: op.opId },
          { event: { type: 'op_started', opType: op.type }, opId: op.opId },
        ], [
          { type: 'accepted_pending', opId: op.opId, opType: op.type },
          { type: 'started', opId: op.opId },
        ]);
        this.#closing = true;
        return { accepted: true, opId: op.opId, duplicate: false, threadId: this.threadId };
    }
  }

  async #acceptInternal(op: InternalThreadRuntimeOp): Promise<InternalOpReceipt> {
    await this.#effectBarrier;
    if (this.#closed) return { accepted: false, opId: op.opId, duplicate: false, reason: 'thread_closed', threadId: this.threadId };
    const existing = this.#writer.state.mailbox.get(op.opId);
    if (existing !== undefined) {
      if (canonicalJson(existing.op) !== canonicalJson(op)) {
        return {
          accepted: false,
          opId: op.opId,
          duplicate: false,
          reason: 'op_id_conflict',
          threadId: this.threadId,
        };
      }
      if (existing.state === 'rejected') {
        return {
          accepted: false,
          opId: op.opId,
          duplicate: true,
          reason: existing.reason ?? 'rejected',
          threadId: this.threadId,
        };
      }
      return { accepted: true, opId: op.opId, duplicate: true, threadId: this.threadId };
    }
    await this.#writer.appendPrepare({
      type: 'mailbox_prepare',
      opId: op.opId,
      op,
      timestamp: this.#clock.now(),
    });
    if (op.type === 'abort') {
      await this.#acceptAbort(op, op.resolvedTarget);
    } else {
      await this.#writer.commit([
        { event: { type: 'op_accepted', opType: 'thread_close', ...(op.parentOpId !== undefined && { parentOpId: op.parentOpId }) }, opId: op.opId },
        { event: { type: 'op_started', opType: 'thread_close', ...(op.parentOpId !== undefined && { parentOpId: op.parentOpId }) }, opId: op.opId },
      ], [
        { type: 'accepted_pending', opId: op.opId, opType: 'thread_close' },
        { type: 'started', opId: op.opId },
      ]);
      this.#closing = true;
    }
    return { accepted: true, opId: op.opId, duplicate: false, threadId: this.threadId };
  }

  async #acceptActivity(
    op: Extract<RuntimeOp, { type: 'prompt' | 'continue' }>,
  ): Promise<OpReceipt> {
    const interactionState = this.#attachment.driver.interactionState();
    const queueDuringCompaction = op.type === 'prompt'
      && this.#active !== undefined
      && interactionState === 'compacting';
    if (!queueDuringCompaction && (this.#active !== undefined || interactionState !== 'idle')) {
      return this.#rejectExternal(op, 'thread_busy_use_steer_or_follow_up');
    }
    const suspended = this.#writer.state.summary.suspendedWork?.[0];
    if (op.type === 'prompt' && suspended !== undefined) {
      return this.#rejectExternal(op, 'suspended_work_pending');
    }
    const suspendedInputOwner = suspended === undefined
      ? undefined
      : suspended.kind === 'reserved_op' ? suspended.ownerOpId
        : suspended.inputOwnerOpId;
    const suspendedInput = suspendedInputOwner === undefined
      ? undefined
      : this.#writer.state.inputOwners.get(suspendedInputOwner);
    const sourcePrompt = suspendedInput === undefined
      ? undefined
      : this.#writer.state.mailbox.get(suspendedInput.sourceOpId)?.op;
    if (suspendedInput !== undefined && sourcePrompt?.type !== 'prompt') {
      throw new RuntimeStorageError('invalid_suspended_input', 'Suspended input source is not a prompt');
    }
    if (op.type === 'continue' && suspended === undefined
      && !hasContinuableState(this.#writer.state.checkpoint.frontend)) {
      return this.#rejectExternal(op, 'nothing_to_continue');
    }
    const runId = this.#newRunId();
    const workspaceCeiling = await this.#workspaceCeiling();
    const permissionCeiling = validatePermissionCeilingSnapshot(await this.#permissionPolicy.resolveCeiling({
      kind: 'run',
      workspaceId: this.workspaceId,
      threadId: this.threadId,
      runId,
      workspaceCeiling,
      threadCeiling: this.#threadCeiling,
      ...(op.permissionNarrowing !== undefined && { requestedNarrowing: op.permissionNarrowing }),
    }));
    if (!queueDuringCompaction) {
      this.#active = {
        rootOpId: op.opId,
        rootRunId: runId,
        currentRunId: runId,
        currentCeiling: permissionCeiling,
      };
    }
    const acceptanceMutations: RuntimeThreadMutation[] = [
      { type: 'accepted_pending', opId: op.opId, opType: op.type },
      {
        type: 'run_reserved',
        runId,
        ownerOpId: op.opId,
        reason: op.type,
        permissionCeiling,
      },
    ];
    if (op.type === 'continue' && suspendedInputOwner !== undefined && suspendedInput !== undefined) {
      acceptanceMutations.push({
        type: 'input_transferred',
        fromOpId: suspendedInputOwner,
        toOpId: op.opId,
      });
    }
    await this.#writer.commit([{
      event: { type: 'op_accepted', opType: op.type },
      opId: op.opId,
      runId,
    }], acceptanceMutations);
    const command: PreparedThreadDriverCommand = op.type === 'prompt'
      ? {
          op,
          runId,
          permissionCeiling,
          resolvedInput: { kind: 'prompt_input', sourceOpId: op.opId, text: op.text },
        }
      : {
          op,
          runId,
          permissionCeiling,
          resolvedInput: sourcePrompt?.type === 'prompt'
            ? {
                kind: 'prompt_input',
                sourceOpId: suspendedInput?.sourceOpId as OpId,
                text: sourcePrompt.text,
              }
            : { kind: 'existing_residue' },
        };
    if (queueDuringCompaction) {
      this.#queuedActivities.push({
        op,
        runId,
        permissionCeiling,
        command: command as Extract<PreparedThreadDriverCommand, { op: { type: 'prompt' } }>,
      });
      return { accepted: true, opId: op.opId, duplicate: false, threadId: this.threadId, runId };
    }
    await this.#startActivity(op, runId, permissionCeiling, command);
    return { accepted: true, opId: op.opId, duplicate: false, threadId: this.threadId, runId };
  }

  async #startActivity(
    op: Extract<RuntimeOp, { type: 'prompt' | 'continue' }>,
    runId: RunId,
    permissionCeiling: PermissionCeilingSnapshot,
    command: Extract<PreparedThreadDriverCommand, { op: { type: 'prompt' | 'continue' } }>,
  ): Promise<void> {
    await this.#writer.commit([{
      event: { type: 'op_started', opType: op.type },
      opId: op.opId,
      runId,
    }], [
      { type: 'started', opId: op.opId },
      { type: 'run_started', runId },
    ]);
    let dispatch: ReturnType<ThreadDriverAttachment['driver']['dispatch']>;
    try {
      dispatch = this.#attachment.driver.dispatch(command);
    } catch (error) {
      dispatch = { completion: Promise.reject(error) };
    }
    this.#track(this.#finishActivity(op, runId, permissionCeiling, dispatch.completion));
  }

  async #acceptOperation(
    op: Extract<ExternalThreadRuntimeOp, { type: 'steer' | 'follow_up' | 'control_response' | 'set_model' }>,
    command: PreparedThreadDriverCommand,
  ): Promise<void> {
    const acceptedAt = this.#clock.now();
    const mutations: RuntimeThreadMutation[] = [
      { type: 'accepted_pending', opId: op.opId, opType: op.type },
      { type: 'started', opId: op.opId },
    ];
    if (op.type === 'control_response') {
      mutations.push({
        type: 'control_response_claimed',
        requestId: op.requestId,
        responseOpId: op.opId,
        decision: op.decision,
        acceptedAt,
      });
    }
    await this.#writer.commit([
      { event: { type: 'op_accepted', opType: op.type }, opId: op.opId },
      { event: { type: 'op_started', opType: op.type }, opId: op.opId },
    ], mutations, acceptedAt);
    let completion: ReturnType<ThreadDriverAttachment['driver']['dispatch']>['completion'];
    try {
      completion = this.#attachment.driver.dispatch(command).completion;
    } catch (error) {
      completion = Promise.reject(error);
    }
    const effect = completion.then(
      async (result) => {
        const outcome = result.kind === 'operation' ? result.outcome : 'interrupted';
        const mutations: RuntimeThreadMutation[] = [
          { type: 'completed', opId: op.opId, outcome },
        ];
        if (op.type === 'set_model' && outcome === 'applied' && 'resolvedModel' in command) {
          mutations.push({ type: 'model_selected', ownerOpId: op.opId, model: command.resolvedModel.ref });
        }
        await this.#writer.commit([{
          event: { type: 'op_completed', opType: op.type, outcome },
          opId: op.opId,
        }], mutations);
      },
      async () => {
        await this.#writer.commit([{
          event: { type: 'op_completed', opType: op.type, outcome: 'interrupted' },
          opId: op.opId,
        }], [{ type: 'completed', opId: op.opId, outcome: 'interrupted' }]);
      },
    );
    this.#effectBarrier = this.#track(effect);
  }

  async #acceptAbort(
    op: Extract<MailboxRuntimeOp, { type: 'abort' }>,
    target: ResolvedAbortTarget,
  ): Promise<void> {
    const parentOpId = 'parentOpId' in op ? op.parentOpId : undefined;
    await this.#writer.commit([
      {
        event: { type: 'op_accepted', opType: 'abort', ...(parentOpId !== undefined && { parentOpId }) },
        opId: op.opId,
      },
      {
        event: { type: 'op_started', opType: 'abort', ...(parentOpId !== undefined && { parentOpId }) },
        opId: op.opId,
      },
    ], [{
      type: 'accepted_pending',
      opId: op.opId,
      opType: 'abort',
      resolvedTarget: target,
      ...(parentOpId !== undefined && { parentOpId }),
    }, { type: 'started', opId: op.opId }]);
    if (target.kind === 'suspended') {
      await this.#completeSuspendedAbort(op, target, parentOpId);
      return;
    }
    if (target.kind === 'no_current_activity') {
      await this.#completeAbort(op, 'no_op', parentOpId);
      return;
    }
    if ('resolvedTarget' in op && (
      this.#active?.currentRunId !== target.runId
      || this.#writer.state.runs.get(target.runId)?.state === 'terminal'
    )) {
      await this.#completeAbort(op, 'no_op', parentOpId);
      return;
    }
    let completion: ReturnType<ThreadDriverAttachment['driver']['dispatch']>['completion'];
    try {
      completion = this.#attachment.driver.dispatch({ op, resolvedTarget: target }).completion;
    } catch (error) {
      completion = Promise.reject(error);
    }
    const effect = completion.then(
      () => this.#completeAbort(op, 'applied', parentOpId),
      () => this.#completeAbort(op, 'interrupted', parentOpId),
    );
    this.#effectBarrier = this.#track(effect);
  }

  async #completeAbort(
    op: Extract<MailboxRuntimeOp, { type: 'abort' }>,
    outcome: 'applied' | 'no_op' | 'interrupted',
    parentOpId?: OpId,
  ): Promise<void> {
    await this.#writer.commit([{
      event: { type: 'op_completed', opType: 'abort', outcome, ...(parentOpId !== undefined && { parentOpId }) },
      opId: op.opId,
    }], [{ type: 'completed', opId: op.opId, outcome }]);
  }

  async #completeSuspendedAbort(
    op: Extract<MailboxRuntimeOp, { type: 'abort' }>,
    target: Extract<ResolvedAbortTarget, { kind: 'suspended' }>,
    parentOpId?: OpId,
  ): Promise<void> {
    const owner = this.#writer.state.mailbox.get(target.ownerOpId);
    const terminal = this.#writer.state.runs.get(target.terminalRunId);
    const root = [...this.#writer.state.runs.values()].find((run) => run.ownerOpId === target.ownerOpId);
    const finishOwner = owner !== undefined
      && owner.state !== 'completed' && owner.state !== 'rejected'
      && (owner.op.type === 'prompt' || owner.op.type === 'continue')
      && root !== undefined;
    const stateMutations: RuntimeThreadMutation[] = [];
    if (finishOwner) {
      stateMutations.push({ type: 'completed', opId: target.ownerOpId, outcome: 'interrupted' });
      if (terminal !== undefined && terminal.state !== 'terminal' && terminal.state !== 'prepared') {
        stateMutations.push({ type: 'run_terminal', runId: terminal.runId, status: 'aborted' });
      }
    }
    if (target.inputOwnerOpId !== undefined
      && this.#writer.state.inputOwners.has(target.inputOwnerOpId)) {
      stateMutations.push({
        type: 'input_cancelled',
        ownerOpId: target.inputOwnerOpId,
        byAbortOpId: op.opId,
      });
    }
    stateMutations.push({ type: 'completed', opId: op.opId, outcome: 'applied' });
    const abortEnvelope = {
      event: {
        type: 'op_completed' as const,
        opType: 'abort' as const,
        outcome: 'applied' as const,
        ...(parentOpId !== undefined && { parentOpId }),
      },
      opId: op.opId,
    };
    if (finishOwner && root !== undefined && (owner.op.type === 'prompt' || owner.op.type === 'continue')) {
      await this.#writer.commit([
        {
          event: {
            type: 'op_completed',
            opType: owner.op.type,
            terminalRunId: target.terminalRunId,
            outcome: 'interrupted',
          },
          opId: target.ownerOpId,
          runId: root.runId,
        },
        abortEnvelope,
      ], stateMutations);
      return;
    }
    await this.#writer.commit([abortEnvelope], stateMutations);
  }

  async #finishActivity(
    op: Extract<RuntimeOp, { type: 'prompt' | 'continue' }>,
    rootRunId: RunId,
    rootCeiling: PermissionCeilingSnapshot,
    completion: ReturnType<ThreadDriverAttachment['driver']['dispatch']>['completion'],
  ): Promise<void> {
    let status: 'completed' | 'aborted' | 'error' = 'error';
    let reportedTerminalRunId: RunId | undefined;
    try {
      const result = await completion;
      if (result.kind !== 'activity') throw new Error('Activity driver returned an operation completion');
      if (result.status !== 'completed' && result.status !== 'aborted' && result.status !== 'error') {
        throw new Error('Activity driver returned an invalid status');
      }
      status = result.status;
      reportedTerminalRunId = result.terminalRunId;
    } catch {
      status = 'error';
    }
    let pendingToDeliver: ThreadResultOutboxMutation | undefined;
    await this.#withAdmission(async () => {
      const active = this.#active;
      let terminalRunId = active?.rootOpId === op.opId ? active.currentRunId : rootRunId;
      if (reportedTerminalRunId !== undefined) {
        const reported = this.#writer.state.runs.get(reportedTerminalRunId);
        const isCurrentCausalTerminal = active?.rootOpId === op.opId
          && active.rootRunId === rootRunId
          && active.currentRunId === reportedTerminalRunId
          && reported !== undefined
          && reported.state !== 'prepared';
        if (isCurrentCausalTerminal) {
          terminalRunId = reportedTerminalRunId;
        } else {
          status = 'error';
        }
      }
      const outcome = status === 'completed' ? 'applied' : 'interrupted';
      void rootCeiling;
      const mutations: RuntimeThreadMutation[] = [
        { type: 'completed', opId: op.opId, outcome },
        { type: 'run_terminal', runId: terminalRunId, status },
      ];
      const parentThreadId = this.#writer.state.meta.parentThreadId;
      if (parentThreadId !== undefined) {
        const resultOpId = this.#identityFactory.deriveOpId({
          purpose: 'thread_result',
          workspaceId: this.workspaceId,
          parts: [parentThreadId, this.threadId, terminalRunId],
        });
        if (!isDerivedOpId(resultOpId)) throw new Error('identity_factory_invalid_derived_op');
        pendingToDeliver = {
          type: 'thread_result_pending',
          resultOpId,
          parentThreadId,
          childThreadId: this.threadId,
          terminalRunId,
          status,
        };
        mutations.push(pendingToDeliver);
      }
      await this.#writer.commit([{
        event: { type: 'op_completed', opType: op.type, terminalRunId, outcome },
        opId: op.opId,
        runId: rootRunId,
      }], mutations);
      if (this.#active?.rootOpId === op.opId) this.#active = undefined;
      if (this.#closing) {
        await this.#cancelQueuedActivities();
      } else {
        await this.#startNextQueuedActivity();
      }
    });
    if (pendingToDeliver !== undefined && this.#onThreadResultPending !== undefined) {
      this.#trackBestEffort(this.#onThreadResultPending(pendingToDeliver));
    }
  }

  async #startNextQueuedActivity(): Promise<void> {
    const next = this.#queuedActivities.shift();
    if (next === undefined) return;
    this.#active = {
      rootOpId: next.op.opId,
      rootRunId: next.runId,
      currentRunId: next.runId,
      currentCeiling: next.permissionCeiling,
    };
    await this.#startActivity(next.op, next.runId, next.permissionCeiling, next.command);
  }

  async #cancelQueuedActivities(): Promise<void> {
    const queued = this.#queuedActivities.splice(0);
    for (const item of queued) {
      await this.#writer.commit([{
        event: {
          type: 'op_completed',
          opType: 'prompt',
          terminalRunId: item.runId,
          outcome: 'interrupted',
        },
        opId: item.op.opId,
        runId: item.runId,
      }], [
        { type: 'completed', opId: item.op.opId, outcome: 'interrupted' },
        { type: 'run_terminal', runId: item.runId, status: 'aborted' },
        { type: 'input_cancelled', ownerOpId: item.op.opId, byAbortOpId: item.op.opId },
      ]);
    }
  }

  async #rejectExternal(op: ExternalThreadRuntimeOp, reason: string): Promise<OpReceipt> {
    await this.#writer.commit([{
      event: { type: 'op_rejected', opType: op.type, reason },
      opId: op.opId,
    }], [{ type: 'rejected', opId: op.opId, reason }]);
    return rejectedExternal(op, reason);
  }

  #resolveAbortTarget(expectedRunId?: RunId): ResolvedAbortTarget {
    const current = this.#active?.currentRunId;
    if (current !== undefined && (expectedRunId === undefined || expectedRunId === current)) {
      return { kind: 'run', runId: current };
    }
    const suspended = this.#writer.state.summary.suspendedWork?.[0];
    if (suspended !== undefined) {
      if (suspended.kind === 'reserved_op' && (expectedRunId === undefined || expectedRunId === suspended.runId)) {
        return {
          kind: 'suspended',
          ownerOpId: suspended.ownerOpId,
          terminalRunId: suspended.runId,
          ...(this.#writer.state.inputOwners.has(suspended.ownerOpId)
            && { inputOwnerOpId: suspended.ownerOpId }),
        };
      }
      if (
        suspended.kind === 'interrupted' &&
        (expectedRunId === undefined || expectedRunId === suspended.terminalRunId)
      ) {
        return {
          kind: 'suspended',
          ownerOpId: suspended.ownerOpId,
          terminalRunId: suspended.terminalRunId,
          ...(suspended.inputOwnerOpId !== undefined && { inputOwnerOpId: suspended.inputOwnerOpId }),
        };
      }
    }
    return { kind: 'no_current_activity' };
  }

  async #workspaceCeiling(): Promise<PermissionCeilingSnapshot> {
    return validatePermissionCeilingSnapshot(await this.#permissionPolicy.snapshotWorkspaceCeiling({
      workspaceId: this.workspaceId,
      cwd: this.#cwd,
    }));
  }

  #newRunId(): RunId {
    const runId = this.#identityFactory.newRunId();
    if (!isRunId(runId) || this.#writer.state.runs.has(runId)) throw new Error('identity_collision');
    return runId;
  }

  #newTurnId(): TurnId {
    const turnId = this.#identityFactory.newTurnId();
    if (!isTurnId(turnId) || [...this.#writer.state.turns.values()].some((turn) => turn.turnId === turnId)) {
      throw new Error('identity_collision');
    }
    return turnId;
  }

  #withAdmission<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#admission.then(operation);
    this.#admission = result.then(() => undefined, () => undefined);
    return result;
  }

  #track(task: Promise<void>): Promise<void> {
    const guarded: Promise<void> = task.catch((error) => {
      this.#backgroundFailures.push(error);
    }).finally(() => {
      this.#background.delete(guarded);
    });
    this.#background.add(guarded);
    return guarded;
  }

  #trackBestEffort(task: Promise<void>): void {
    const guarded = task.catch(() => undefined).finally(() => {
      this.#bestEffort.delete(guarded);
    });
    this.#bestEffort.add(guarded);
  }

  #assertDriverEventIdentity(
    input: ThreadDriverEvent,
    virtuallyActivatedRuns: ReadonlySet<RunId> = new Set(),
    virtuallyActivatedTurns: ReadonlySet<string> = new Set(),
  ): void {
    if (input.runId !== undefined) {
      const run = this.#writer.state.runs.get(input.runId);
      if (run === undefined) throw new Error('driver_event_unknown_run');
      if (run.state === 'terminal') throw new Error('driver_event_terminal_run');
      if (run.state === 'prepared' && !virtuallyActivatedRuns.has(input.runId)) {
        const reservation = [...this.#successors.values()].find((candidate) => candidate.runId === input.runId);
        const isReservationNotice = reservation !== undefined
          && input.event.type === 'retry_scheduled'
          && input.event.successorRunId === input.runId
          && input.event.predecessorRunId === reservation.predecessorRunId;
        const isCompactionActivation = reservation !== undefined
          && reservation.reason === 'compaction'
          && input.event.type === 'compaction_start'
          && input.event.activityRunId === input.runId
          && input.event.predecessorRunId === reservation.predecessorRunId;
        if (!isReservationNotice && !isCompactionActivation) {
          throw new Error('driver_event_unactivated_run');
        }
      }
    }
    if (input.turnId !== undefined) {
      if (input.runId === undefined) throw new Error('driver_event_turn_without_run');
      const reservation = this.#turnReservations.get(turnIdentityKey(input.runId, input.turnId));
      if (reservation === undefined) throw new Error('driver_event_unknown_turn');
      const turnKey = turnIdentityKey(input.runId, input.turnId);
      if (!reservation.activated && !virtuallyActivatedTurns.has(turnKey) && input.event.type !== 'turn_start') {
        throw new Error('driver_event_unactivated_turn');
      }
    }
    if (input.opId !== undefined && !this.#writer.state.mailbox.has(input.opId)) {
      throw new Error('driver_event_unknown_op');
    }
  }
}

function rejectedExternal(op: ExternalThreadRuntimeOp, reason: string): OpReceipt {
  return { accepted: false, opId: op.opId, duplicate: false, reason, threadId: op.threadId };
}

function hasContinuableState(frontend: ThreadDriverAttachment['initialCheckpoint']['frontend']): boolean {
  if (frontend.queues.steering.length > 0 || frontend.queues.followUp.length > 0) return true;
  const tail = frontend.transcript.at(-1);
  if (tail === undefined) return false;
  if (tail.role !== 'assistant') return true;
  return tail.stopReason === 'aborted' || tail.stopReason === 'error' || tail.stopReason === 'tool_calls';
}

function successorKey(runId: RunId, reason: 'retry' | 'compaction'): string {
  return canonicalJson(['successor', runId, reason]);
}

function turnOrdinalKey(runId: RunId, ordinal: number): string {
  return canonicalJson(['turn_ordinal', runId, ordinal]);
}

function turnIdentityKey(runId: RunId, turnId: TurnId): string {
  return canonicalJson(['turn_identity', runId, turnId]);
}
