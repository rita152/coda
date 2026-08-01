import { describe, expect, test } from 'bun:test';
import {
  PROTOCOL_VERSION,
  deriveOpId,
} from '../protocol/index.js';
import type {
  ExternalOpId,
  ModelConfig,
  ModelRef,
  PermissionCeilingSnapshot,
  RunId,
  RuntimeOp,
  ThreadId,
  TurnId,
  UserMessage,
  WorkspaceId,
} from '../protocol/index.js';
import { WorkspaceEventStream } from './event-stream.js';
import type {
  PermissionPolicyPort,
  PreparedThreadDriverCommand,
  RuntimeClock,
  RuntimeIdentityFactory,
  RuntimeJournalRecord,
  ThreadDriverAttachment,
  ThreadDriverCompletion,
  ThreadDriverPort,
  ThreadJournalPort,
  ThreadMetaRecord,
} from './ports.js';
import { emptyCheckpoint, foldThreadJournal, ThreadJournalWriter } from './thread-journal.js';
import { Phase1ThreadRuntime } from './thread-runtime.js';

const WORKSPACE_ID = 'workspace-thread-runtime' as WorkspaceId;
const THREAD_ID = 'thread-runtime-under-test' as ThreadId;
const MODEL: ModelConfig = { ref: { provider: 'faux', api: 'faux', model: 'runtime' } };
const CEILING = { revision: 'thread-ceiling', constraints: [] } as const;

describe('Phase1ThreadRuntime durable admission and identity', () => {
  test('keeps successor and turn reservations stable and rejects a successor fork', async () => {
    const fixture = runtimeFixture();
    const receipt = await fixture.runtime.acceptExternal(prompt(opId(1), 'identity'));
    if (!receipt.accepted || receipt.runId === undefined) throw new Error('prompt was not accepted');
    const rootRunId = receipt.runId;

    const firstTurn = await fixture.runtime.reserveTurn({ runId: rootRunId, turnOrdinal: 1 });
    const duplicateTurn = await fixture.runtime.reserveTurn({ runId: rootRunId, turnOrdinal: 1 });
    expect(duplicateTurn).toEqual(firstTurn);
    expect(fixture.policy.turnCalls).toBe(1);
    await fixture.runtime.commitDriverEvent({
      event: { type: 'turn_start' },
      runId: rootRunId,
      turnId: firstTurn.turnId,
    });

    const successor = await fixture.runtime.reserveSuccessor({
      threadId: THREAD_ID,
      predecessorRunId: rootRunId,
      reason: 'retry',
    });
    expect(await fixture.runtime.reserveSuccessor({
      threadId: THREAD_ID,
      predecessorRunId: rootRunId,
      reason: 'retry',
    })).toEqual(successor);
    expect(fixture.policy.successorRunCalls).toBe(1);
    await expect(fixture.runtime.reserveSuccessor({
      threadId: THREAD_ID,
      predecessorRunId: rootRunId,
      reason: 'compaction',
    })).rejects.toThrow('invalid_successor_reservation');
    await fixture.runtime.commitDriverEvent({
      event: { type: 'agent_end', reason: 'completed', messages: [], willRetry: true },
      runId: rootRunId,
    });
    await fixture.runtime.commitDriverEvent({
      event: { type: 'agent_start', reason: 'continue' },
      runId: successor.runId,
    });
    expect(fixture.runtime.durableState().runs.get(successor.runId)?.state).toBe('started');
    expect(fixture.runtime.summary()).toMatchObject({
      state: 'running',
      activeRunId: successor.runId,
    });

    fixture.driver.complete(rootRunId, 'completed', successor.runId);
    await fixture.runtime.close();
    expect(foldThreadJournal(fixture.journal.records).runs.get(successor.runId)).toMatchObject({
      predecessorRunId: rootRunId,
      state: 'terminal',
      status: 'completed',
    });
  });

  test('atomically records accepted_pending and rejects an activity-shaped operation completion', async () => {
    const fixture = runtimeFixture();
    fixture.driver.nextOperationCompletion = {
      kind: 'activity',
      status: 'completed',
      terminalRunId: 'run-malicious-operation-result' as RunId,
    };
    const steer = {
      type: 'steer',
      opId: opId(2),
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      text: 'queued',
    } as const;
    expect((await fixture.runtime.acceptExternal(steer)).accepted).toBe(true);
    await fixture.runtime.close();

    const commits = fixture.journal.records.filter((record) => record.type === 'commit');
    const accepted = commits.find((record) => record.envelopes.some((envelope) =>
      envelope.opId === steer.opId && envelope.event.type === 'op_accepted'));
    expect(accepted?.mutations).toEqual(expect.arrayContaining([
      { type: 'accepted_pending', opId: steer.opId, opType: 'steer' },
      { type: 'started', opId: steer.opId },
    ]));
    const completed = commits.flatMap((record) => record.envelopes).find((envelope) =>
      envelope.opId === steer.opId && envelope.event.type === 'op_completed');
    expect(completed?.event).toMatchObject({ type: 'op_completed', outcome: 'interrupted' });
  });

  test('materializes prompt input only with the committed user message', async () => {
    const fixture = runtimeFixture();
    const promptOp = prompt(opId(3), 'materialize me');
    const receipt = await fixture.runtime.acceptExternal(promptOp);
    if (!receipt.accepted || receipt.runId === undefined) throw new Error('prompt was not accepted');
    const turn = await fixture.runtime.reserveTurn({ runId: receipt.runId, turnOrdinal: 1 });
    await fixture.runtime.commitDriverEvent({
      event: { type: 'turn_start' },
      runId: receipt.runId,
      turnId: turn.turnId,
    });
    await fixture.runtime.commitDriverEvent({
      event: { type: 'message_end', message: userMessage('message-prompt', 'materialize me') },
      runId: receipt.runId,
      turnId: turn.turnId,
    });

    const messageCommit = fixture.journal.records.findLast((record) => record.type === 'commit'
      && record.envelopes.some((envelope) => envelope.event.type === 'message_end'));
    if (messageCommit?.type !== 'commit') throw new Error('message commit was not persisted');
    expect(messageCommit.mutations).toEqual(expect.arrayContaining([
      { type: 'input_materialized', ownerOpId: promptOp.opId, messageId: 'message-prompt' },
    ]));
    fixture.driver.complete(receipt.runId, 'completed');
    await fixture.runtime.close();
  });

  test('rejects an internal duplicate OpId carrying a different canonical payload', async () => {
    const fixture = runtimeFixture();
    const derivedOpId = deriveOpId({
      purpose: 'cancel_target',
      workspaceId: WORKSPACE_ID,
      parts: [opId(4), THREAD_ID],
    });
    const first = {
      type: 'abort',
      opId: derivedOpId,
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      parentOpId: opId(4),
      resolvedTarget: { kind: 'no_current_activity' },
    } as const;
    expect((await fixture.runtime.acceptInternal(first)).accepted).toBe(true);
    const conflicting = await fixture.runtime.acceptInternal({
      ...first,
      resolvedTarget: { kind: 'run', runId: 'run-conflicting-target' as RunId },
    });
    expect(conflicting).toMatchObject({
      accepted: false,
      duplicate: false,
      reason: 'op_id_conflict',
    });
    await fixture.runtime.close();
  });

  test('rejects a driver event for a terminal historical run', async () => {
    const fixture = runtimeFixture();
    const receipt = await fixture.runtime.acceptExternal(prompt(opId(5), 'first run'));
    if (!receipt.accepted || receipt.runId === undefined) throw new Error('prompt was not accepted');
    const iterator = fixture.events.subscribe({ threadIds: [THREAD_ID] })[Symbol.asyncIterator]();
    fixture.driver.complete(receipt.runId, 'completed');
    await nextEvent(iterator, (envelope) =>
      envelope.opId === receipt.opId && envelope.event.type === 'op_completed');

    try {
      await expect(fixture.runtime.commitDriverEvent({
        event: {
          type: 'runtime_diagnostic',
          severity: 'warning',
          code: 'late_driver_event',
          message: 'late',
          scope: 'run',
        },
        runId: receipt.runId,
      })).rejects.toThrow();
    } finally {
      await iterator.return?.();
      await fixture.runtime.close();
    }
  });

  test('never accepts a historical RunId as a later activity terminalRunId', async () => {
    const fixture = runtimeFixture();
    const first = await fixture.runtime.acceptExternal(prompt(opId(6), 'first'));
    if (!first.accepted || first.runId === undefined) throw new Error('first prompt failed');
    const iterator = fixture.events.subscribe({ threadIds: [THREAD_ID] })[Symbol.asyncIterator]();
    fixture.driver.complete(first.runId, 'completed');
    await nextEvent(iterator, (envelope) =>
      envelope.opId === first.opId && envelope.event.type === 'op_completed');

    const second = await fixture.runtime.acceptExternal(prompt(opId(7), 'second'));
    if (!second.accepted || second.runId === undefined) throw new Error('second prompt failed');
    fixture.driver.complete(second.runId, 'completed', first.runId);
    await fixture.runtime.close().catch(() => undefined);
    await iterator.return?.();

    const wrongTerminal = fixture.journal.records.flatMap((record) => record.type === 'commit'
      ? record.envelopes
      : []).filter((envelope) =>
        envelope.opId === second.opId
        && envelope.event.type === 'op_completed'
        && 'terminalRunId' in envelope.event
        && envelope.event.terminalRunId === first.runId);
    expect(wrongTerminal).toEqual([]);
  });

  test('does not authorize driver events with unactivated successor or turn prepares', async () => {
    const prepared = await preparedIdentityFixture();
    const runtime = recoveredRuntime(prepared);
    try {
      await expect(runtime.commitDriverEvent({
        event: {
          type: 'runtime_diagnostic',
          severity: 'warning',
          code: 'unactivated_successor',
          message: '',
          scope: 'run',
        },
        runId: prepared.successorRunId,
      })).rejects.toThrow();
      await expect(runtime.commitDriverEvent({
        event: { type: 'message_end', message: userMessage('message-invalid-turn', 'invalid') },
        runId: prepared.rootRunId,
        turnId: prepared.turnId,
      })).rejects.toThrow();
    } finally {
      await runtime.close().catch(() => undefined);
    }
  });

  test('queues a compacting prompt with its own RunId instead of rejecting or dispatching it', async () => {
    const fixture = runtimeFixture();
    const first = await fixture.runtime.acceptExternal(prompt(opId(8), 'overflowing'));
    if (!first.accepted || first.runId === undefined) throw new Error('first prompt failed');
    fixture.driver.stateOverride = 'compacting';
    const queued = await fixture.runtime.acceptExternal(prompt(opId(9), 'after compaction'));
    try {
      expect(queued).toMatchObject({ accepted: true });
      if (!queued.accepted) throw new Error('compacting prompt was rejected');
      expect(queued.runId).not.toBe(first.runId);
      expect(fixture.driver.commands.filter((command) => command.op.type === 'prompt')).toHaveLength(1);
    } finally {
      fixture.driver.stateOverride = undefined;
      fixture.driver.complete(first.runId, 'completed');
      await fixture.runtime.close().catch(() => undefined);
    }
  });

  test('exposes a thread-close failure through the close promise without a detached rejection', async () => {
    const fixture = runtimeFixture();
    fixture.driver.closeFailure = new Error('driver close failed');
    const closeOp = {
      type: 'thread_close',
      opId: opId(11),
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
    } as const;
    expect((await fixture.runtime.acceptExternal(closeOp)).accepted).toBe(true);
    await expect(fixture.runtime.close(closeOp)).rejects.toThrow('Thread thread-runtime-under-test close failed');
  });

  test('passes the exact frozen workspace/run ceilings through turn policy and durable prepare', async () => {
    const policy = new CapturingPolicy();
    const fixture = runtimeFixture({ policy });
    const receipt = await fixture.runtime.acceptExternal(prompt(opId(12), 'turn ceiling'));
    if (!receipt.accepted || receipt.runId === undefined) throw new Error('prompt was not accepted');

    const reservation = await fixture.runtime.reserveTurn({ runId: receipt.runId, turnOrdinal: 1 });
    expect(policy.turnInput).toBeDefined();
    expect(policy.turnInput?.workspaceCeiling).toBe(reservation.workspaceCeiling);
    expect(policy.turnInput?.runCeiling).toBe(reservation.runCeiling);
    expect(reservation.turnCeiling).toEqual(TURN_CEILING);
    expect(Object.isFrozen(reservation.workspaceCeiling)).toBe(true);
    expect(Object.isFrozen(reservation.runCeiling)).toBe(true);
    expect(Object.isFrozen(reservation.turnCeiling)).toBe(true);

    const prepared = fixture.journal.records.findLast((record) =>
      record.type === 'turn_prepare' && record.turnId === reservation.turnId);
    expect(prepared).toMatchObject({
      type: 'turn_prepare',
      runId: receipt.runId,
      turnOrdinal: 1,
      workspaceCeiling: reservation.workspaceCeiling,
      runCeiling: reservation.runCeiling,
      turnCeiling: reservation.turnCeiling,
    });
    await expect(fixture.runtime.reserveTurn({
      runId: receipt.runId,
      turnOrdinal: 3,
    })).rejects.toThrow('invalid_turn_reservation');
    expect(policy.turnCalls).toBe(1);

    fixture.driver.complete(receipt.runId, 'completed');
    await fixture.runtime.close();
  });

  test('never reuses a RunId or TurnId across distinct reservation keys', async () => {
    const identityFactory = new CollisionIdentityFactory();
    const fixture = runtimeFixture({ identityFactory });
    const first = await fixture.runtime.acceptExternal(prompt(opId(13), 'first'));
    if (!first.accepted || first.runId === undefined) throw new Error('first prompt was not accepted');
    const iterator = fixture.events.subscribe({ threadIds: [THREAD_ID] })[Symbol.asyncIterator]();
    const firstTurn = await fixture.runtime.reserveTurn({ runId: first.runId, turnOrdinal: 1 });
    await fixture.runtime.commitDriverEvent({
      event: { type: 'turn_start' },
      runId: first.runId,
      turnId: firstTurn.turnId,
    });
    await expect(fixture.runtime.reserveTurn({
      runId: first.runId,
      turnOrdinal: 2,
    })).rejects.toThrow('identity_collision');

    fixture.driver.complete(first.runId, 'completed');
    await nextEvent(iterator, (envelope) =>
      envelope.opId === first.opId && envelope.event.type === 'op_completed');
    await expect(fixture.runtime.acceptExternal(prompt(opId(14), 'second')))
      .rejects.toThrow('identity_collision');
    expect(fixture.driver.commands.filter((command) => command.op.type === 'prompt')).toHaveLength(1);
    await iterator.return?.();
    await fixture.runtime.close();
  });

  test('keeps a durable control first-wins claim after control_resolved removes the request', async () => {
    const fixture = runtimeFixture();
    const receipt = await fixture.runtime.acceptExternal(prompt(opId(15), 'approval'));
    if (!receipt.accepted || receipt.runId === undefined) throw new Error('prompt was not accepted');
    const turn = await fixture.runtime.reserveTurn({ runId: receipt.runId, turnOrdinal: 1 });
    await fixture.runtime.commitDriverEvent({
      event: { type: 'turn_start' },
      runId: receipt.runId,
      turnId: turn.turnId,
    });
    await fixture.runtime.commitDriverEvent({
      event: {
        type: 'control_request',
        requestId: 'approval-first-wins',
        kind: 'approval',
        owningRunId: receipt.runId,
        owningTurnId: turn.turnId,
        policyRevision: 'policy-v1',
        payload: { toolCallId: 'call-first-wins', description: 'test' },
      },
      runId: receipt.runId,
      turnId: turn.turnId,
    });
    const firstResponse = {
      type: 'control_response',
      opId: opId(16),
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      requestId: 'approval-first-wins',
      decision: 'allow_once',
    } as const;
    expect((await fixture.runtime.acceptExternal(firstResponse)).accepted).toBe(true);
    await fixture.runtime.commitDriverEvent({
      event: {
        type: 'control_resolved',
        requestId: firstResponse.requestId,
        kind: 'approval',
        owningRunId: receipt.runId,
        owningTurnId: turn.turnId,
        policyRevision: 'policy-v1',
        decision: 'allow_once',
      },
      runId: receipt.runId,
      turnId: turn.turnId,
      opId: firstResponse.opId,
    });
    expect(fixture.runtime.snapshot().pendingControls).toEqual([]);

    expect(await fixture.runtime.acceptExternal({
      ...firstResponse,
      opId: opId(17),
      decision: 'deny',
    })).toMatchObject({
      accepted: false,
      reason: 'control_response_already_claimed',
    });
    fixture.driver.complete(receipt.runId, 'completed');
    await fixture.runtime.close();
  });
});

interface RuntimeFixture {
  readonly runtime: Phase1ThreadRuntime;
  readonly writer: ThreadJournalWriter;
  readonly journal: RecordingJournal;
  readonly events: WorkspaceEventStream;
  readonly driver: ScriptedDriver;
  readonly policy: CountingPolicy;
}

function runtimeFixture(options: {
  readonly identityFactory?: RuntimeIdentityFactory;
  readonly policy?: CountingPolicy;
} = {}): RuntimeFixture {
  const meta = threadMeta();
  const journal = new RecordingJournal([meta]);
  const events = new WorkspaceEventStream();
  events.registerThread(THREAD_ID);
  const writer = writerFor(journal, events);
  const driver = new ScriptedDriver();
  const policy = options.policy ?? new CountingPolicy();
  const runtime = new Phase1ThreadRuntime({
    workspaceId: WORKSPACE_ID,
    cwd: '/runtime/thread-runtime',
    threadId: THREAD_ID,
    writer,
    attachment: attachment(driver, MODEL.ref),
    identityFactory: options.identityFactory ?? new TestIdentityFactory(),
    clock: TEST_CLOCK,
    permissionPolicy: policy,
    threadCeiling: CEILING,
  });
  return { runtime, writer, journal, events, driver, policy };
}

interface PreparedIdentityFixture {
  readonly journal: RecordingJournal;
  readonly events: WorkspaceEventStream;
  readonly rootRunId: RunId;
  readonly successorRunId: RunId;
  readonly turnId: TurnId;
}

async function preparedIdentityFixture(): Promise<PreparedIdentityFixture> {
  const rootRunId = 'run-prepared-root' as RunId;
  const successorRunId = 'run-prepared-successor' as RunId;
  const turnId = 'turn-prepared-unactivated' as TurnId;
  const rootOpId = opId(10);
  const rootOp = prompt(rootOpId, 'prepared');
  const journal = new RecordingJournal([threadMeta()]);
  const events = new WorkspaceEventStream();
  events.registerThread(THREAD_ID);
  const writer = writerFor(journal, events);
  await writer.appendPrepare({ type: 'mailbox_prepare', opId: rootOpId, op: rootOp, timestamp: 1 });
  await writer.commit([{
    event: { type: 'op_accepted', opType: 'prompt' },
    opId: rootOpId,
    runId: rootRunId,
  }], [
    { type: 'accepted_pending', opId: rootOpId, opType: 'prompt' },
    {
      type: 'run_reserved',
      runId: rootRunId,
      ownerOpId: rootOpId,
      reason: 'prompt',
      permissionCeiling: CEILING,
    },
  ]);
  await writer.commit([{
    event: { type: 'op_started', opType: 'prompt' },
    opId: rootOpId,
    runId: rootRunId,
  }], [
    { type: 'started', opId: rootOpId },
    { type: 'run_started', runId: rootRunId },
  ]);
  await writer.appendPrepare({
    type: 'successor_run_prepare',
    runId: successorRunId,
    predecessorRunId: rootRunId,
    reason: 'retry',
    permissionCeiling: CEILING,
    timestamp: 1,
  });
  await writer.appendPrepare({
    type: 'turn_prepare',
    runId: rootRunId,
    turnId,
    turnOrdinal: 1,
    workspaceCeiling: CEILING,
    runCeiling: CEILING,
    turnCeiling: CEILING,
    timestamp: 1,
  });
  return { journal, events, rootRunId, successorRunId, turnId };
}

function recoveredRuntime(prepared: PreparedIdentityFixture): Phase1ThreadRuntime {
  const writer = writerFor(prepared.journal, prepared.events);
  return new Phase1ThreadRuntime({
    workspaceId: WORKSPACE_ID,
    cwd: '/runtime/thread-runtime',
    threadId: THREAD_ID,
    writer,
    attachment: attachment(new ScriptedDriver(), MODEL.ref),
    identityFactory: new TestIdentityFactory(),
    clock: TEST_CLOCK,
    permissionPolicy: new CountingPolicy(),
    threadCeiling: CEILING,
  });
}

function writerFor(journal: RecordingJournal, events: WorkspaceEventStream): ThreadJournalWriter {
  return new ThreadJournalWriter({
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    journal,
    events,
    clock: TEST_CLOCK,
    state: foldThreadJournal(journal.records),
    records: journal.records,
  });
}

function attachment(driver: ScriptedDriver, model: ModelRef): ThreadDriverAttachment {
  return {
    driver,
    durableRef: { kind: 'test-driver', key: THREAD_ID },
    initialCheckpoint: emptyCheckpoint(model),
  };
}

function threadMeta(): ThreadMetaRecord {
  return {
    type: 'thread_meta',
    version: 2,
    protocolVersion: PROTOCOL_VERSION,
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    permissionCeiling: CEILING,
    createdAt: 1,
    cwd: '/runtime/thread-runtime',
    model: MODEL.ref,
    driverRef: { kind: 'test-driver', key: THREAD_ID },
  };
}

function prompt(
  promptOpId: ExternalOpId,
  text: string,
): Extract<RuntimeOp, { type: 'prompt' }> {
  return { type: 'prompt', opId: promptOpId, workspaceId: WORKSPACE_ID, threadId: THREAD_ID, text };
}

function opId(index: number): ExternalOpId {
  return `op_e_${index.toString(16).padStart(32, '0')}` as ExternalOpId;
}

function userMessage(id: string, text: string): UserMessage {
  return {
    role: 'user',
    id,
    timestamp: 1,
    content: [{ type: 'text', text }],
    source: 'prompt',
  };
}

async function nextEvent(
  iterator: AsyncIterator<Readonly<import('../protocol/index.js').EventEnvelope>>,
  predicate: (event: Readonly<import('../protocol/index.js').EventEnvelope>) => boolean,
): Promise<void> {
  for (;;) {
    const item = await iterator.next();
    if (item.done) throw new Error('Event stream ended before expected event');
    if (predicate(item.value)) return;
  }
}

const TEST_CLOCK: RuntimeClock = { now: () => 1 };

class RecordingJournal implements ThreadJournalPort {
  readonly records: RuntimeJournalRecord[];

  constructor(records: readonly RuntimeJournalRecord[]) {
    this.records = [...records];
  }

  async acquireWriteLease(): Promise<void> {}
  async load(): Promise<readonly RuntimeJournalRecord[]> { return [...this.records]; }
  async append(records: readonly RuntimeJournalRecord[]): Promise<void> { this.records.push(...records); }
  async releaseWriteLease(): Promise<void> {}
}

class TestIdentityFactory implements RuntimeIdentityFactory {
  #run = 0;
  #turn = 0;

  newThreadId(): ThreadId { return 'thread-generated' as ThreadId; }
  newRunId(): RunId { return `run-generated-${++this.#run}` as RunId; }
  newTurnId(): TurnId { return `turn-generated-${++this.#turn}` as TurnId; }
  newOpId(): ExternalOpId { return opId(99); }
  newProcessEpoch(): string { return 'test-process'; }
  deriveOpId(input: Parameters<typeof deriveOpId>[0]): ReturnType<typeof deriveOpId> {
    return deriveOpId(input);
  }
}

class CountingPolicy implements PermissionPolicyPort {
  turnCalls = 0;
  successorRunCalls = 0;

  async snapshotWorkspaceCeiling(): Promise<typeof CEILING> { return CEILING; }

  async resolveCeiling(
    input: Parameters<PermissionPolicyPort['resolveCeiling']>[0],
  ): Promise<PermissionCeilingSnapshot> {
    if (input.kind === 'turn') this.turnCalls++;
    if (input.kind === 'run' && input.predecessorRunId !== undefined) this.successorRunCalls++;
    return CEILING;
  }
}

const TURN_CEILING = {
  revision: 'turn-ceiling-captured',
  constraints: [{ network: false }],
} as const;

class CapturingPolicy extends CountingPolicy {
  turnInput: Extract<Parameters<PermissionPolicyPort['resolveCeiling']>[0], { kind: 'turn' }> | undefined;

  override async resolveCeiling(
    input: Parameters<PermissionPolicyPort['resolveCeiling']>[0],
  ): Promise<PermissionCeilingSnapshot> {
    if (input.kind === 'turn') {
      this.turnCalls++;
      this.turnInput = input;
      return TURN_CEILING;
    }
    if (input.kind === 'run' && input.predecessorRunId !== undefined) this.successorRunCalls++;
    return CEILING;
  }
}

class CollisionIdentityFactory extends TestIdentityFactory {
  override newRunId(): RunId { return 'run-collision' as RunId; }
  override newTurnId(): TurnId { return 'turn-collision' as TurnId; }
}

class ScriptedDriver implements ThreadDriverPort {
  readonly commands: PreparedThreadDriverCommand[] = [];
  readonly #activities = new Map<RunId, Deferred<ThreadDriverCompletion>>();
  nextOperationCompletion: ThreadDriverCompletion | undefined;
  stateOverride: 'idle' | 'running' | 'retrying' | 'compacting' | undefined;
  closeFailure: Error | undefined;

  async recover(): Promise<void> {}
  async activate(): Promise<void> {}

  dispatch(command: PreparedThreadDriverCommand): { readonly completion: Promise<ThreadDriverCompletion> } {
    this.commands.push(command);
    if ((command.op.type === 'prompt' || command.op.type === 'continue') && 'runId' in command) {
      const completion = deferred<ThreadDriverCompletion>();
      this.#activities.set(command.runId, completion);
      return { completion: completion.promise };
    }
    const result = this.nextOperationCompletion ?? { kind: 'operation', outcome: 'applied' };
    this.nextOperationCompletion = undefined;
    return { completion: Promise.resolve(result) };
  }

  interactionState(): 'idle' | 'running' | 'retrying' | 'compacting' {
    return this.stateOverride ?? (this.#activities.size === 0 ? 'idle' : 'running');
  }

  async close(): Promise<void> {
    for (const runId of [...this.#activities.keys()]) this.complete(runId, 'aborted');
    if (this.closeFailure !== undefined) throw this.closeFailure;
  }

  complete(
    runId: RunId,
    status: 'completed' | 'aborted' | 'error',
    terminalRunId = runId,
  ): void {
    const activity = this.#activities.get(runId);
    if (activity === undefined) return;
    this.#activities.delete(runId);
    activity.resolve({ kind: 'activity', status, terminalRunId });
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  return {
    promise: new Promise<T>((resolve) => { resolvePromise = resolve; }),
    resolve(value: T): void {
      if (resolvePromise === undefined) throw new Error('Deferred is not initialized');
      resolvePromise(value);
    },
  };
}
