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
import { EventHub } from './event-hub.js';
import type {
  PermissionPolicyPort,
  LegacyApprovalAdapter,
  LegacyApprovalApplyResult,
  LegacyApprovalPreflightResult,
  PreparedThreadDriverCommand,
  RuntimeClock,
  ThreadDriverAttachment,
  ThreadDriverCompletion,
  ThreadDriverPort,
  ThreadIdentityPort,
} from './thread-runtime-ports.js';
import type {
  RuntimeJournalRecord,
  ThreadJournalAppendPort,
  ThreadMetaRecord,
} from './thread-journal-records.js';
import { emptyCheckpoint, foldThreadJournal, ThreadJournalWriter } from './thread-journal.js';
import { ThreadRuntime } from './thread-runtime.js';

const WORKSPACE_ID = 'workspace-thread-runtime' as WorkspaceId;
const THREAD_ID = 'thread-runtime-under-test' as ThreadId;
const MODEL: ModelConfig = { ref: { provider: 'faux', api: 'faux', model: 'runtime' } };
const CEILING = { revision: 'thread-ceiling', constraints: [] } as const;

describe('ThreadRuntime durable admission and identity', () => {
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

  test('waitForIdle surfaces a final background commit failure even when the active run cannot clear', async () => {
    const fixture = runtimeFixture();
    const receipt = await fixture.runtime.acceptExternal(prompt(opId(27), 'fail final commit'));
    if (!receipt.accepted || receipt.runId === undefined) throw new Error('prompt was not accepted');
    fixture.journal.nextAppendFailure = new Error('final activity commit failed');
    fixture.driver.complete(receipt.runId, 'completed');

    await expect(fixture.runtime.waitForIdle()).rejects.toThrow(
      `Thread ${THREAD_ID} background execution failed`,
    );
    await fixture.runtime.close().catch(() => undefined);
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
      expect(fixture.driver.compactionQueueNotifications).toBe(1);
    } finally {
      fixture.driver.stateOverride = undefined;
      fixture.driver.complete(first.runId, 'completed');
      await fixture.runtime.close().catch(() => undefined);
    }
  });

  test('keeps a prompt in FIFO while an idle driver finalizes the active compaction successor', async () => {
    const fixture = runtimeFixture();
    const first = await fixture.runtime.acceptExternal(prompt(opId(27), 'trigger compaction'));
    if (!first.accepted || first.runId === undefined) throw new Error('first prompt failed');
    const successor = await fixture.runtime.reserveSuccessor({
      threadId: THREAD_ID,
      predecessorRunId: first.runId,
      reason: 'compaction',
    });
    await fixture.runtime.commitDriverEvent({
      event: {
        type: 'compaction_start',
        reason: 'threshold',
        predecessorRunId: first.runId,
        activityRunId: successor.runId,
      },
      runId: successor.runId,
    });
    await fixture.runtime.commitDriverEvent({
      event: {
        type: 'compaction_end',
        activityRunId: successor.runId,
        ok: true,
        droppedMessages: 1,
      },
      runId: successor.runId,
    }, {
      type: 'compaction_committed',
      compaction: {
        id: 'compaction-id',
        timestamp: 1,
        tailStartId: 'tail-message-id',
        summary: 'compacted summary',
      },
    });

    // The legacy execution can already project idle after compaction_end while ThreadRuntime is
    // still closing the root activity around its canonical compaction successor.
    fixture.driver.stateOverride = 'idle';
    const queued = await fixture.runtime.acceptExternal(prompt(opId(28), 'after committed compaction'));
    try {
      expect(queued).toMatchObject({ accepted: true });
      if (!queued.accepted || queued.runId === undefined) throw new Error('queued prompt failed');
      expect(queued.runId).not.toBe(first.runId);
      expect(queued.runId).not.toBe(successor.runId);
      expect(fixture.driver.commands.filter((command) => command.op.type === 'prompt')).toHaveLength(1);
      expect(fixture.driver.compactionQueueNotifications).toBe(1);
    } finally {
      fixture.driver.stateOverride = undefined;
      fixture.driver.complete(first.runId, 'completed', successor.runId);
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

  test('commits an approval request before waiting and resolves only after the durable response effect', async () => {
    const applyEntered = deferred<void>();
    const applyGate = deferred<void>();
    const adapter = new RecordingApprovalAdapter({
      apply: async () => {
        applyEntered.resolve(undefined);
        await applyGate.promise;
        return { ok: true, effectiveDecision: 'allow_always', persistedPatterns: ['one', 'two'] };
      },
    });
    const fixture = runtimeFixture({ approvalAdapter: adapter });
    const receipt = await fixture.runtime.acceptExternal(prompt(opId(18), 'approval chain'));
    if (!receipt.accepted || receipt.runId === undefined) throw new Error('prompt was not accepted');
    const turn = await fixture.runtime.reserveTurn({ runId: receipt.runId, turnOrdinal: 1 });
    await fixture.runtime.commitDriverEvent({
      event: { type: 'turn_start' },
      runId: receipt.runId,
      turnId: turn.turnId,
    });
    const iterator = fixture.events.subscribe({ threadIds: [THREAD_ID] })[Symbol.asyncIterator]();
    let invocationSettled = false;
    const invocation = fixture.runtime.requestLegacyApproval({
      toolCallId: 'call-durable-order',
      toolName: 'edit',
      cwd: '/runtime/thread-runtime',
      args: { path: 'a.ts' },
    }).then((result) => {
      invocationSettled = true;
      return result;
    });
    const request = await nextEnvelope(iterator, (envelope) => envelope.event.type === 'control_request');
    if (request.event.type !== 'control_request') throw new Error('missing control request');
    const requestId = request.event.requestId;
    expect(invocationSettled).toBe(false);
    expect(fixture.runtime.snapshot().pendingControls).toHaveLength(1);
    const response = {
      type: 'control_response',
      opId: opId(19),
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      requestId,
      decision: 'allow_always',
    } as const;
    expect((await fixture.runtime.acceptExternal(response)).accepted).toBe(true);
    await applyEntered.promise;
    expect(invocationSettled).toBe(false);
    expect(fixture.runtime.snapshot().pendingControls).toHaveLength(1);
    const resolved = nextEnvelope(iterator, (envelope) =>
      envelope.event.type === 'control_resolved' && envelope.opId === response.opId);
    applyGate.resolve(undefined);
    expect((await resolved).event).toMatchObject({
      type: 'control_resolved',
      decision: 'allow_always',
    });
    await expect(invocation).resolves.toEqual({ kind: 'allow' });
    expect(fixture.driver.commands.some((command) => command.op.type === 'control_response')).toBe(false);
    fixture.driver.complete(receipt.runId, 'completed');
    await iterator.return?.();
    await fixture.runtime.close();
  });

  test('definitely-not-applied releases only the response claim and a new OpId can retry', async () => {
    const adapter = new RecordingApprovalAdapter({
      results: [
        {
          ok: false,
          code: 'legacy_approval_definitely_not_applied',
          message: 'no outbox or Set mutation',
        },
        { ok: true, effectiveDecision: 'allow_once', persistedPatterns: [] },
      ],
    });
    const fixture = runtimeFixture({ approvalAdapter: adapter });
    const receipt = await fixture.runtime.acceptExternal(prompt(opId(20), 'retry approval'));
    if (!receipt.accepted || receipt.runId === undefined) throw new Error('prompt was not accepted');
    const turn = await fixture.runtime.reserveTurn({ runId: receipt.runId, turnOrdinal: 1 });
    await fixture.runtime.commitDriverEvent({ event: { type: 'turn_start' }, runId: receipt.runId, turnId: turn.turnId });
    const iterator = fixture.events.subscribe({ threadIds: [THREAD_ID] })[Symbol.asyncIterator]();
    const invocation = fixture.runtime.requestLegacyApproval({
      toolCallId: 'call-retry',
      toolName: 'edit',
      cwd: '/runtime/thread-runtime',
      args: { path: 'retry.ts' },
    });
    const request = await nextEnvelope(iterator, (envelope) => envelope.event.type === 'control_request');
    if (request.event.type !== 'control_request') throw new Error('missing control request');
    const first = { type: 'control_response' as const, opId: opId(21), workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID, requestId: request.event.requestId, decision: 'allow_always' as const };
    expect((await fixture.runtime.acceptExternal(first)).accepted).toBe(true);
    await nextEnvelope(iterator, (envelope) =>
      envelope.opId === first.opId && envelope.event.type === 'op_completed');
    expect(fixture.runtime.durableState().controlClaims.has(first.requestId)).toBe(false);
    expect(fixture.runtime.snapshot().pendingControls).toHaveLength(1);
    expect(await fixture.runtime.acceptExternal(first)).toMatchObject({ accepted: true, duplicate: true });
    expect(adapter.applyCalls).toHaveLength(1);
    const second = { ...first, opId: opId(22), decision: 'allow_once' as const };
    expect((await fixture.runtime.acceptExternal(second)).accepted).toBe(true);
    await expect(invocation).resolves.toEqual({ kind: 'allow' });
    expect(adapter.applyCalls).toHaveLength(2);
    fixture.driver.complete(receipt.runId, 'completed');
    await iterator.return?.();
    await fixture.runtime.close();
  });

  test('approval fatal retains the claim, latches workspace, and releases the cancelled execution waiter', async () => {
    const fatal: Error[] = [];
    const adapter = new RecordingApprovalAdapter({
      results: [{
        ok: false,
        code: 'legacy_approval_conflict',
        message: 'receipt payload changed',
      }],
    });
    const fixture = runtimeFixture({
      approvalAdapter: adapter,
      onWorkspaceApprovalFatal: (error) => fatal.push(error),
    });
    const receipt = await fixture.runtime.acceptExternal(prompt(opId(23), 'fatal approval'));
    if (!receipt.accepted || receipt.runId === undefined) throw new Error('prompt was not accepted');
    const turn = await fixture.runtime.reserveTurn({ runId: receipt.runId, turnOrdinal: 1 });
    await fixture.runtime.commitDriverEvent({ event: { type: 'turn_start' }, runId: receipt.runId, turnId: turn.turnId });
    const iterator = fixture.events.subscribe({ threadIds: [THREAD_ID] })[Symbol.asyncIterator]();
    const invocation = fixture.runtime.requestLegacyApproval({
      toolCallId: 'call-fatal',
      toolName: 'edit',
      cwd: '/runtime/thread-runtime',
      args: { path: 'fatal.ts' },
    });
    const request = await nextEnvelope(iterator, (envelope) => envelope.event.type === 'control_request');
    if (request.event.type !== 'control_request') throw new Error('missing control request');
    const response = { type: 'control_response' as const, opId: opId(24), workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID, requestId: request.event.requestId, decision: 'allow_always' as const };
    expect((await fixture.runtime.acceptExternal(response)).accepted).toBe(true);
    await expect(invocation).resolves.toEqual({ kind: 'aborted' });
    expect(fatal).toHaveLength(1);
    expect(fixture.runtime.durableState().controlClaims.get(response.requestId)?.responseOpId).toBe(response.opId);
    expect(fixture.runtime.snapshot().pendingControls).toHaveLength(1);
    expect(fixture.driver.commands.at(-1)?.op.type).toBe('abort');
    fixture.driver.complete(receipt.runId, 'aborted');
    await iterator.return?.();
    await fixture.runtime.close().catch(() => undefined);
  });

  test('latches workspace fatal when an applied approval effect cannot commit its resolution', async () => {
    const fatal: Error[] = [];
    const fixtureRef: { current?: ReturnType<typeof runtimeFixture> } = {};
    const adapter = new RecordingApprovalAdapter({
      apply: async () => {
        const fixture = fixtureRef.current;
        if (fixture === undefined) throw new Error('fixture is not initialized');
        fixture.journal.nextAppendFailure = new Error('resolution commit failed after pattern effect');
        return {
          ok: true,
          effectiveDecision: 'allow_always',
          persistedPatterns: ['Edit(*)'],
        };
      },
    });
    const fixture = runtimeFixture({
      approvalAdapter: adapter,
      onWorkspaceApprovalFatal: (error) => fatal.push(error),
    });
    fixtureRef.current = fixture;
    const receipt = await fixture.runtime.acceptExternal(prompt(opId(29), 'post-effect commit failure'));
    if (!receipt.accepted || receipt.runId === undefined) throw new Error('prompt was not accepted');
    const turn = await fixture.runtime.reserveTurn({ runId: receipt.runId, turnOrdinal: 1 });
    await fixture.runtime.commitDriverEvent({
      event: { type: 'turn_start' },
      runId: receipt.runId,
      turnId: turn.turnId,
    });
    const iterator = fixture.events.subscribe({ threadIds: [THREAD_ID] })[Symbol.asyncIterator]();
    const invocation = fixture.runtime.requestLegacyApproval({
      toolCallId: 'call-post-effect-failure',
      toolName: 'edit',
      cwd: '/runtime/thread-runtime',
      args: { path: 'fatal-after-effect.ts' },
    });
    const request = await nextEnvelope(iterator, (envelope) => envelope.event.type === 'control_request');
    if (request.event.type !== 'control_request') throw new Error('missing control request');
    const response = {
      type: 'control_response',
      opId: opId(30),
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      requestId: request.event.requestId,
      decision: 'allow_always',
    } as const;
    expect((await fixture.runtime.acceptExternal(response)).accepted).toBe(true);

    await expect(invocation).resolves.toEqual({ kind: 'aborted' });
    expect(fatal).toHaveLength(1);
    expect(fatal[0]).toMatchObject({ code: 'legacy_approval_unknown_outcome' });
    expect(fixture.runtime.snapshot().pendingControls).toHaveLength(1);
    expect(fixture.runtime.durableState().controlClaims.get(request.event.requestId)).toMatchObject({
      responseOpId: response.opId,
    });
    expect(fixture.driver.commands.at(-1)?.op.type).toBe('abort');
    fixture.driver.complete(receipt.runId, 'aborted');
    await iterator.return?.();
    await fixture.runtime.close().catch(() => undefined);
  });

  test('abort dispatches cancellation before it durably resolves the waiter as aborted', async () => {
    const adapter = new RecordingApprovalAdapter();
    const fixture = runtimeFixture({ approvalAdapter: adapter });
    const receipt = await fixture.runtime.acceptExternal(prompt(opId(25), 'abort approval'));
    if (!receipt.accepted || receipt.runId === undefined) throw new Error('prompt was not accepted');
    const turn = await fixture.runtime.reserveTurn({ runId: receipt.runId, turnOrdinal: 1 });
    await fixture.runtime.commitDriverEvent({ event: { type: 'turn_start' }, runId: receipt.runId, turnId: turn.turnId });
    const iterator = fixture.events.subscribe({ threadIds: [THREAD_ID] })[Symbol.asyncIterator]();
    const invocation = fixture.runtime.requestLegacyApproval({
      toolCallId: 'call-abort',
      toolName: 'edit',
      cwd: '/runtime/thread-runtime',
      args: { path: 'abort.ts' },
    });
    const request = await nextEnvelope(iterator, (envelope) => envelope.event.type === 'control_request');
    if (request.event.type !== 'control_request') throw new Error('missing control request');
    const requestId = request.event.requestId;
    let pendingAtCancellation = false;
    fixture.driver.onAbortDispatch = () => {
      pendingAtCancellation = fixture.runtime.snapshot().pendingControls.some((pending) =>
        pending.requestId === requestId);
    };
    const abort = { type: 'abort' as const, opId: opId(26), workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID, expectedRunId: receipt.runId };
    expect((await fixture.runtime.acceptExternal(abort)).accepted).toBe(true);
    await expect(invocation).resolves.toEqual({ kind: 'aborted' });
    expect(pendingAtCancellation).toBe(true);
    const resolution = fixture.runtime.durableState().envelopes.findLast((envelope) =>
      envelope.event.type === 'control_resolved' && envelope.event.requestId === requestId);
    expect(resolution?.event).toMatchObject({ type: 'control_resolved', decision: 'aborted' });
    fixture.driver.complete(receipt.runId, 'aborted');
    await iterator.return?.();
    await fixture.runtime.close();
  });
});

interface RuntimeFixture {
  readonly runtime: ThreadRuntime;
  readonly writer: ThreadJournalWriter;
  readonly journal: RecordingJournal;
  readonly events: EventHub;
  readonly driver: ScriptedDriver;
  readonly policy: CountingPolicy;
}

function runtimeFixture(options: {
  readonly identityFactory?: ThreadIdentityPort;
  readonly policy?: CountingPolicy;
  readonly approvalAdapter?: LegacyApprovalAdapter;
  readonly onWorkspaceApprovalFatal?: (error: Error) => void;
} = {}): RuntimeFixture {
  const meta = threadMeta();
  const journal = new RecordingJournal([meta]);
  const events = new EventHub();
  events.registerThread(THREAD_ID);
  const writer = writerFor(journal, events);
  const driver = new ScriptedDriver();
  const policy = options.policy ?? new CountingPolicy();
  const runtime = new ThreadRuntime({
    workspaceId: WORKSPACE_ID,
    cwd: '/runtime/thread-runtime',
    threadId: THREAD_ID,
    writer,
    attachment: attachment(driver, MODEL.ref, options.approvalAdapter),
    identityFactory: options.identityFactory ?? new TestIdentityFactory(),
    clock: TEST_CLOCK,
    permissionPolicy: policy,
    threadCeiling: CEILING,
    ...(options.onWorkspaceApprovalFatal !== undefined && {
      onWorkspaceApprovalFatal: options.onWorkspaceApprovalFatal,
    }),
  });
  return { runtime, writer, journal, events, driver, policy };
}

interface PreparedIdentityFixture {
  readonly journal: RecordingJournal;
  readonly events: EventHub;
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
  const events = new EventHub();
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

function recoveredRuntime(prepared: PreparedIdentityFixture): ThreadRuntime {
  const writer = writerFor(prepared.journal, prepared.events);
  return new ThreadRuntime({
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

function writerFor(journal: RecordingJournal, events: EventHub): ThreadJournalWriter {
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

function attachment(
  driver: ScriptedDriver,
  model: ModelRef,
  approvalAdapter?: LegacyApprovalAdapter,
): ThreadDriverAttachment {
  return {
    driver,
    durableRef: { kind: 'test-driver', key: THREAD_ID },
    initialCheckpoint: emptyCheckpoint(model),
    ...(approvalAdapter !== undefined && {
      legacyApprovalAdapter: approvalAdapter,
      legacyApprovalPolicyRevision: 'test-policy-v2',
    }),
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

async function nextEnvelope(
  iterator: AsyncIterator<Readonly<import('../protocol/index.js').EventEnvelope>>,
  predicate: (event: Readonly<import('../protocol/index.js').EventEnvelope>) => boolean,
): Promise<Readonly<import('../protocol/index.js').EventEnvelope>> {
  for (;;) {
    const item = await iterator.next();
    if (item.done) throw new Error('Event stream ended before expected envelope');
    if (predicate(item.value)) return item.value;
  }
}

const TEST_CLOCK: RuntimeClock = { now: () => 1 };

class RecordingJournal implements ThreadJournalAppendPort {
  readonly records: RuntimeJournalRecord[];
  nextAppendFailure: Error | undefined;

  constructor(records: readonly RuntimeJournalRecord[]) {
    this.records = [...records];
  }

  async acquireWriteLease(): Promise<void> {}
  async load(): Promise<readonly RuntimeJournalRecord[]> { return [...this.records]; }
  async append(records: readonly RuntimeJournalRecord[]): Promise<void> {
    const failure = this.nextAppendFailure;
    this.nextAppendFailure = undefined;
    if (failure !== undefined) throw failure;
    this.records.push(...records);
  }
  async releaseWriteLease(): Promise<void> {}
}

class TestIdentityFactory implements ThreadIdentityPort {
  #run = 0;
  #turn = 0;

  newRunId(): RunId { return `run-generated-${++this.#run}` as RunId; }
  newTurnId(): TurnId { return `turn-generated-${++this.#turn}` as TurnId; }
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
  onAbortDispatch: (() => void) | undefined;
  compactionQueueNotifications = 0;

  async recover(): Promise<void> {}
  async activate(): Promise<void> {}

  dispatch(command: PreparedThreadDriverCommand): { readonly completion: Promise<ThreadDriverCompletion> } {
    this.commands.push(command);
    if (command.op.type === 'abort') this.onAbortDispatch?.();
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

  activityQueuedDuringCompaction(): void {
    this.compactionQueueNotifications++;
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

class RecordingApprovalAdapter implements LegacyApprovalAdapter {
  readonly applyCalls: Array<Parameters<LegacyApprovalAdapter['applyResponse']>[0]> = [];
  readonly #results: LegacyApprovalApplyResult[];
  readonly #apply: (() => Promise<LegacyApprovalApplyResult>) | undefined;

  constructor(input: {
    readonly results?: readonly LegacyApprovalApplyResult[];
    readonly apply?: () => Promise<LegacyApprovalApplyResult>;
  } = {}) {
    this.#results = [...(input.results ?? [])];
    this.#apply = input.apply;
  }

  async preflight(): Promise<LegacyApprovalPreflightResult> {
    return {
      kind: 'ask',
      description: 'approve test invocation',
      proposal: { patterns: ['one', 'two'], forceConfirm: false },
    };
  }

  async applyResponse(
    input: Parameters<LegacyApprovalAdapter['applyResponse']>[0],
  ): Promise<LegacyApprovalApplyResult> {
    this.applyCalls.push(input);
    if (this.#apply !== undefined) return this.#apply();
    return this.#results.shift()
      ?? { ok: true, effectiveDecision: input.decision, persistedPatterns: [] };
  }

  async close(): Promise<void> {}
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
