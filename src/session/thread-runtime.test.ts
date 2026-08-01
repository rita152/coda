import { describe, expect, test } from 'bun:test';
import {
  PROTOCOL_VERSION,
  ProviderEventStream,
  deriveOpId,
  strictJsonSnapshot,
} from '../protocol/index.js';
import type {
  AssistantMessage,
  ExternalOpId,
  ModelConfig,
  ModelRef,
  PermissionCeilingSnapshot,
  RunId,
  RuntimeOp,
  StreamFn,
  ThreadId,
  TurnId,
  UserMessage,
  WorkspaceId,
} from '../protocol/index.js';
import {
  createCapabilityRegistry,
  createPolicyEngine,
  createPromptAssembler,
  createProviderAdapterRegistry,
} from '../capabilities/index.js';
import type {
  BasePromptProvider,
  CapabilityRegistration,
  CapabilityRegistry,
  CapabilityRegistryReader,
  EffectivePolicySnapshot,
  PolicyDecision,
  PolicyGrant,
  PolicyGrantCommitResult,
  PolicyGrantRepositoryPort,
  PolicyGrantSnapshot,
  PreparedInvocation,
  ProviderAdapterRegistry,
  ProviderAdapterRegistryReader,
  RuleFreshnessPort,
  RuleSnapshotProvider,
  RuntimeCapabilityServices,
  ThreadPolicyEngine,
} from '../capabilities/index.js';
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
  test('commits rename/archive metadata and manual compact as canonical Runtime activities', async () => {
    const fixture = runtimeFixture();
    expect(await fixture.runtime.acceptExternal({
      type: 'thread_rename',
      opId: opId(46),
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      title: '  Review target  ',
    })).toMatchObject({ accepted: true });
    expect(fixture.runtime.summary()).toMatchObject({ title: 'Review target', updatedAt: 1 });
    expect(await fixture.runtime.acceptExternal({
      type: 'thread_archive',
      opId: opId(47),
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      archived: true,
    })).toMatchObject({ accepted: true });
    expect(fixture.runtime.summary()).toMatchObject({ archivedAt: 1, updatedAt: 1 });

    const root = prompt(opId(48), 'context to compact');
    const promptReceipt = await fixture.runtime.acceptExternal(root);
    if (!promptReceipt.accepted || promptReceipt.runId === undefined) {
      throw new Error('prompt was not accepted');
    }
    const turn = await fixture.runtime.reserveTurn({ runId: promptReceipt.runId, turnOrdinal: 1 });
    await fixture.runtime.commitDriverEvent({
      event: { type: 'turn_start' },
      runId: promptReceipt.runId,
      turnId: turn.turnId,
    });
    const user: UserMessage = {
      role: 'user',
      id: 'user-compact-context',
      timestamp: 1,
      source: 'prompt',
      content: [{ type: 'text', text: root.text }],
    };
    await fixture.runtime.commitDriverEvent({
      event: { type: 'message_end', message: user },
      runId: promptReceipt.runId,
      turnId: turn.turnId,
    });
    fixture.driver.complete(promptReceipt.runId, 'completed');
    await fixture.runtime.waitForIdle();

    const compact = await fixture.runtime.acceptExternal({
      type: 'compact',
      opId: opId(49),
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
    });
    if (!compact.accepted || compact.runId === undefined) throw new Error('compact was not accepted');
    expect(fixture.driver.commands.at(-1)).toMatchObject({
      op: { type: 'compact', opId: opId(49) },
      runId: compact.runId,
    });
    fixture.driver.complete(compact.runId, 'completed');
    await fixture.runtime.waitForIdle();
    const folded = fixture.runtime.durableState();
    expect(folded.runs.get(compact.runId)).toMatchObject({
      reason: 'compact',
      state: 'terminal',
      status: 'completed',
    });
    expect(folded.envelopes.findLast((item) =>
      item.opId === opId(49) && item.event.type === 'op_completed')?.event).toMatchObject({
      opType: 'compact',
      terminalRunId: compact.runId,
      outcome: 'applied',
    });
    await fixture.runtime.close();
  });

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

  test('retries the same turn ordinal before append and reuses a reservation after append', async () => {
    const preAppend = runtimeFixture({ policy: new FailFirstTurnPolicy() });
    const preReceipt = await preAppend.runtime.acceptExternal(prompt(opId(2), 'pre-append turn failure'));
    if (!preReceipt.accepted || preReceipt.runId === undefined) throw new Error('prompt was not accepted');
    await expect(preAppend.runtime.reserveTurn({
      runId: preReceipt.runId,
      turnOrdinal: 1,
    })).rejects.toThrow('turn ceiling failed before append');
    const preRecovered = await preAppend.runtime.reserveTurn({
      runId: preReceipt.runId,
      turnOrdinal: 1,
    });
    expect(preRecovered.turnId).toBeDefined();
    expect(preAppend.journal.records.filter((record) => record.type === 'turn_prepare')).toHaveLength(1);
    preAppend.driver.complete(preReceipt.runId, 'completed');
    await preAppend.runtime.close();

    let postAppendFailure: Error | undefined;
    const postAppend = runtimeFixture({
      workspaceApprovalFailure: () => postAppendFailure,
    });
    const postReceipt = await postAppend.runtime.acceptExternal(prompt(opId(3), 'post-append turn failure'));
    if (!postReceipt.accepted || postReceipt.runId === undefined) throw new Error('prompt was not accepted');
    postAppend.journal.onNextAppend = () => {
      postAppendFailure = new Error('workspace fatal after turn append');
    };
    const postReserved = await postAppend.runtime.reserveTurn({
      runId: postReceipt.runId,
      turnOrdinal: 1,
    });
    const durableTurn = [...postAppend.runtime.durableState().turns.values()].find((turn) =>
      turn.runId === postReceipt.runId && turn.turnOrdinal === 1);
    const postRecovered = await postAppend.runtime.reserveTurn({
      runId: postReceipt.runId,
      turnOrdinal: 1,
    });
    if (durableTurn === undefined) throw new Error('turn reservation was not durable');
    expect(postReserved.turnId).toBe(durableTurn.turnId);
    expect(postRecovered.turnId).toBe(durableTurn.turnId);
    expect(postAppend.journal.records.filter((record) => record.type === 'turn_prepare')).toHaveLength(1);
    postAppend.driver.complete(postReceipt.runId, 'completed');
    await postAppend.runtime.close();
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

  test('captures every mutable registry source once per turn and freezes hot updates until the next turn', async () => {
    const executions: string[] = [];
    const firstRegistration = versionedPlanRegistration({
      version: '1.0.0',
      implementationDigit: '1',
      valueType: 'string',
      execute: async () => {
        executions.push('executor-v1');
        return { content: [{ type: 'text', text: 'v1' }] };
      },
    });
    const fixture = await registryRuntimeFixture(firstRegistration);
    const root = prompt(opId(40), 'registry snapshots');
    const receipt = await fixture.runtime.acceptExternal(root);
    if (!receipt.accepted || receipt.runId === undefined) throw new Error('prompt was not accepted');

    const firstTurn = await captureRegistryTurn(fixture, root.opId, receipt.runId, 1);
    expect(registryCaptureCounts(fixture)).toEqual({
      catalog: 1,
      providers: 1,
      grants: 1,
      rules: 1,
      basePrompt: 1,
      policy: 1,
    });

    const secondRegistration = versionedPlanRegistration({
      version: '2.0.0',
      implementationDigit: '2',
      valueType: 'number',
      execute: async () => {
        executions.push('executor-v2');
        return { content: [{ type: 'text', text: 'v2' }] };
      },
    });
    expect(fixture.registry.update('versioned-plan', secondRegistration)).toMatchObject({ ok: true, revision: 2 });
    expect(fixture.providers.update('faux', {
      api: 'faux',
      version: '2.0.0',
      implementationDigest: implementationDigest('4'),
      stream: STREAM_V2,
    })).toMatchObject({ ok: true, revision: 2 });

    const firstAssembly = firstTurn.assemble([]);
    expect(firstAssembly).toMatchObject({
      ok: true,
      context: { tools: [{ name: 'versioned-plan', parameters: STRING_VALUE_SCHEMA }] },
    });
    expect(firstTurn.streamFn).toBe(STREAM_V1);
    const firstPrepared = await firstTurn.prepareToolCall({
      type: 'tool_call',
      id: 'call-versioned-v1',
      name: 'versioned-plan',
      arguments: { value: 'old-schema' },
    }, 0, new AbortController().signal);
    if (!firstPrepared.ok) throw new Error(firstPrepared.message);
    await firstPrepared.execute({ signal: new AbortController().signal, onUpdate: () => undefined });
    expect(executions).toEqual(['executor-v1']);
    expect(registryCaptureCounts(fixture)).toEqual({
      catalog: 1,
      providers: 1,
      grants: 1,
      rules: 1,
      basePrompt: 1,
      policy: 1,
    });

    const secondTurn = await captureRegistryTurn(fixture, root.opId, receipt.runId, 2);
    expect(registryCaptureCounts(fixture)).toEqual({
      catalog: 2,
      providers: 2,
      grants: 2,
      rules: 2,
      basePrompt: 2,
      policy: 2,
    });
    expect(secondTurn.streamFn).toBe(STREAM_V2);
    expect(secondTurn.assemble([])).toMatchObject({
      ok: true,
      context: { tools: [{ name: 'versioned-plan', parameters: NUMBER_VALUE_SCHEMA }] },
    });
    expect(await secondTurn.prepareToolCall({
      type: 'tool_call',
      id: 'call-versioned-stale',
      name: 'versioned-plan',
      arguments: { value: 'old-schema' },
    }, 0, new AbortController().signal)).toMatchObject({ ok: false });
    const secondPrepared = await secondTurn.prepareToolCall({
      type: 'tool_call',
      id: 'call-versioned-v2',
      name: 'versioned-plan',
      arguments: { value: 2 },
    }, 1, new AbortController().signal);
    if (!secondPrepared.ok) throw new Error(secondPrepared.message);
    await secondPrepared.execute({ signal: new AbortController().signal, onUpdate: () => undefined });
    expect(executions).toEqual(['executor-v1', 'executor-v2']);
    expect(registryCaptureCounts(fixture)).toEqual({
      catalog: 2,
      providers: 2,
      grants: 2,
      rules: 2,
      basePrompt: 2,
      policy: 2,
    });

    fixture.driver.complete(receipt.runId, 'completed');
    await Promise.all([fixture.runtime.close(), fixture.runtime.close()]);
    expect(fixture.threadPolicyEngine.closeCalls).toBe(1);
  });

  test('single-flights serial and concurrent capture calls for one reserved turn', async () => {
    const fixture = await registryRuntimeFixture(versionedPlanRegistration({
      version: '1.0.0',
      implementationDigit: '7',
      valueType: 'string',
      execute: async () => ({ content: [{ type: 'text', text: 'unused' }] }),
    }));
    const root = prompt(opId(60), 'single flight capture');
    const receipt = await fixture.runtime.acceptExternal(root);
    if (!receipt.accepted || receipt.runId === undefined) throw new Error('prompt was not accepted');
    const reservation = await fixture.runtime.reserveTurn({ runId: receipt.runId, turnOrdinal: 1 });
    const input = {
      rootOpId: root.opId,
      runId: receipt.runId,
      turnId: reservation.turnId,
      model: MODEL,
      transcript: [],
      signal: new AbortController().signal,
    } as const;

    const firstPromise = fixture.runtime.captureRuntimeTurn(input);
    const concurrentPromise = fixture.runtime.captureRuntimeTurn(input);
    expect(concurrentPromise).toBe(firstPromise);
    const [first, concurrent] = await Promise.all([firstPromise, concurrentPromise]);
    const serial = await fixture.runtime.captureRuntimeTurn(input);
    expect(concurrent).toBe(first);
    expect(serial).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(registryCaptureCounts(fixture)).toEqual({
      catalog: 1,
      providers: 1,
      grants: 1,
      rules: 1,
      basePrompt: 1,
      policy: 1,
    });

    await fixture.runtime.commitDriverEvent({
      event: { type: 'turn_start' },
      runId: receipt.runId,
      turnId: reservation.turnId,
    });
    const terminalMessage: AssistantMessage = {
      role: 'assistant',
      id: 'assistant-cache-cleanup',
      timestamp: 1,
      content: [],
      model: MODEL.ref,
      stopReason: 'stop',
      usage: { input: 0, output: 0 },
    };
    await fixture.runtime.commitDriverEvent({
      event: { type: 'turn_end', message: terminalMessage, toolResults: [] },
      runId: receipt.runId,
      turnId: reservation.turnId,
    });
    await expect(fixture.runtime.captureRuntimeTurn(input)).rejects.toThrow('registry_turn_capture_after_start');
    expect(registryCaptureCounts(fixture)).toEqual({
      catalog: 1,
      providers: 1,
      grants: 1,
      rules: 1,
      basePrompt: 1,
      policy: 1,
    });
    fixture.driver.complete(receipt.runId, 'completed');
    await fixture.runtime.close();
  });

  test('cancellation wakes every asynchronous registry turn capture gate', async () => {
    const stages = ['grants', 'rules', 'basePrompt', 'policy'] as const;
    for (const [stageIndex, stage] of stages.entries()) {
      const fixture = await registryRuntimeFixture(versionedPlanRegistration({
        version: '1.0.0',
        implementationDigit: String(stageIndex + 1),
        valueType: 'string',
        execute: async () => ({ content: [{ type: 'text', text: 'must not execute' }] }),
      }));
      const entered = deferred<void>();
      const gate = deferred<void>();
      if (stage === 'grants') {
        fixture.grants.onSnapshot = () => entered.resolve(undefined);
        fixture.grants.snapshotBarrier = gate.promise;
      } else if (stage === 'rules') {
        fixture.ruleSnapshots.onCapture = () => entered.resolve(undefined);
        fixture.ruleSnapshots.captureBarrier = gate.promise;
      } else if (stage === 'basePrompt') {
        fixture.basePrompts.onCapture = () => entered.resolve(undefined);
        fixture.basePrompts.captureBarrier = gate.promise;
      } else {
        fixture.threadPolicyEngine.onCapture = () => entered.resolve(undefined);
        fixture.threadPolicyEngine.captureBarrier = gate.promise;
      }
      const root = prompt(opId(70 + stageIndex), `abort capture ${stage}`);
      const receipt = await fixture.runtime.acceptExternal(root);
      if (!receipt.accepted || receipt.runId === undefined) throw new Error('prompt was not accepted');
      const reservation = await fixture.runtime.reserveTurn({ runId: receipt.runId, turnOrdinal: 1 });
      const controller = new AbortController();
      const capture = fixture.runtime.captureRuntimeTurn({
        rootOpId: root.opId,
        runId: receipt.runId,
        turnId: reservation.turnId,
        model: MODEL,
        transcript: [],
        signal: controller.signal,
      });

      await entered.promise;
      controller.abort();
      await expect(capture).rejects.toThrow('Runtime turn capture was interrupted');
      expect(registryCaptureCounts(fixture)).toEqual({
        catalog: 1,
        providers: 1,
        grants: 1,
        rules: stageIndex >= 1 ? 1 : 0,
        basePrompt: stageIndex >= 2 ? 1 : 0,
        policy: stageIndex >= 3 ? 1 : 0,
      });

      await fixture.runtime.commitDriverEvent({
        event: { type: 'turn_start' },
        runId: receipt.runId,
        turnId: reservation.turnId,
      });
      const abortedMessage: AssistantMessage = {
        role: 'assistant',
        id: `assistant-capture-aborted-${stage}`,
        timestamp: 1,
        content: [],
        model: MODEL.ref,
        stopReason: 'aborted',
        errorDetails: { kind: 'aborted', retryable: false },
        usage: { input: 0, output: 0 },
      };
      await fixture.runtime.commitDriverEvent({
        event: { type: 'turn_end', message: abortedMessage, toolResults: [] },
        runId: receipt.runId,
        turnId: reservation.turnId,
      });
      fixture.driver.complete(receipt.runId, 'aborted');
      await fixture.runtime.close();
      gate.resolve(undefined);
    }
  });

  test('propagates cancellation across catalog, freshness, policy, approval, and final freshness awaits', async () => {
    const registration = (executions: string[]) => versionedPlanRegistration({
      version: '1.0.0',
      implementationDigit: '8',
      valueType: 'string',
      execute: async () => {
        executions.push('executor');
        return { content: [{ type: 'text', text: 'executed' }] };
      },
    });

    {
      const executions: string[] = [];
      const fixture = await registryRuntimeFixture(registration(executions));
      const entered = deferred<void>();
      const gate = deferred<void>();
      fixture.capabilityReader.onPrepare = () => entered.resolve(undefined);
      fixture.capabilityReader.prepareBarrier = gate.promise;
      const root = prompt(opId(61), 'abort catalog');
      const receipt = await fixture.runtime.acceptExternal(root);
      if (!receipt.accepted || receipt.runId === undefined) throw new Error('prompt was not accepted');
      const runtimeTurn = await captureRegistryTurn(fixture, root.opId, receipt.runId, 1);
      const controller = new AbortController();
      const preparation = runtimeTurn.prepareToolCall({
        type: 'tool_call', id: 'call-abort-catalog', name: 'versioned-plan', arguments: { value: 'x' },
      }, 0, controller.signal);
      await entered.promise;
      controller.abort();
      gate.resolve(undefined);
      expect(await preparation).toMatchObject({ ok: false, message: expect.stringContaining('interrupted') });
      expect(fixture.threadPolicyEngine.evaluations).toHaveLength(0);
      expect(executions).toEqual([]);
      fixture.driver.complete(receipt.runId, 'completed');
      await fixture.runtime.close();
    }

    {
      const executions: string[] = [];
      const fixture = await registryRuntimeFixture(registration(executions));
      const entered = deferred<void>();
      const gate = deferred<void>();
      fixture.freshness.onCheck = (ordinal) => { if (ordinal === 1) entered.resolve(undefined); };
      fixture.freshness.barriers[0] = gate.promise;
      const root = prompt(opId(62), 'abort freshness');
      const receipt = await fixture.runtime.acceptExternal(root);
      if (!receipt.accepted || receipt.runId === undefined) throw new Error('prompt was not accepted');
      const runtimeTurn = await captureRegistryTurn(fixture, root.opId, receipt.runId, 1);
      const controller = new AbortController();
      const preparation = runtimeTurn.prepareToolCall({
        type: 'tool_call', id: 'call-abort-freshness', name: 'versioned-plan', arguments: { value: 'x' },
      }, 0, controller.signal);
      await entered.promise;
      controller.abort();
      gate.resolve(undefined);
      expect(await preparation).toMatchObject({ ok: false, message: expect.stringContaining('interrupted') });
      expect(fixture.threadPolicyEngine.evaluations).toHaveLength(0);
      expect(executions).toEqual([]);
      fixture.driver.complete(receipt.runId, 'completed');
      await fixture.runtime.close();
    }

    {
      const executions: string[] = [];
      const fixture = await registryRuntimeFixture(scopedExecuteRegistration(executions));
      const entered = deferred<void>();
      const gate = deferred<void>();
      fixture.threadPolicyEngine.onEvaluate = () => entered.resolve(undefined);
      fixture.threadPolicyEngine.evaluateBarrier = gate.promise;
      const root = prompt(opId(63), 'abort policy');
      const receipt = await fixture.runtime.acceptExternal(root);
      if (!receipt.accepted || receipt.runId === undefined) throw new Error('prompt was not accepted');
      const runtimeTurn = await captureRegistryTurn(fixture, root.opId, receipt.runId, 1);
      const controller = new AbortController();
      const preparation = runtimeTurn.prepareToolCall({
        type: 'tool_call', id: 'call-abort-policy', name: 'scoped-execute', arguments: { command: 'bun test' },
      }, 0, controller.signal);
      await entered.promise;
      controller.abort();
      gate.resolve(undefined);
      expect(await preparation).toMatchObject({ ok: false, message: expect.stringContaining('interrupted') });
      expect(fixture.runtime.snapshot().pendingControls).toEqual([]);
      expect(executions).toEqual([]);
      fixture.driver.complete(receipt.runId, 'completed');
      await fixture.runtime.close();
    }

    {
      const executions: string[] = [];
      const fixture = await registryRuntimeFixture(scopedExecuteRegistration(executions));
      const entered = deferred<void>();
      const gate = deferred<void>();
      const root = prompt(opId(64), 'abort approval commit');
      const receipt = await fixture.runtime.acceptExternal(root);
      if (!receipt.accepted || receipt.runId === undefined) throw new Error('prompt was not accepted');
      const runtimeTurn = await captureRegistryTurn(fixture, root.opId, receipt.runId, 1);
      fixture.journal.onNextAppend = () => entered.resolve(undefined);
      fixture.journal.nextAppendBarrier = gate.promise;
      const controller = new AbortController();
      const preparation = runtimeTurn.prepareToolCall({
        type: 'tool_call', id: 'call-abort-approval', name: 'scoped-execute', arguments: { command: 'bun test' },
      }, 0, controller.signal);
      await entered.promise;
      controller.abort();
      gate.resolve(undefined);
      expect(await preparation).toMatchObject({ ok: false, message: expect.stringContaining('interrupted') });
      expect(executions).toEqual([]);
      const abort = {
        type: 'abort' as const,
        opId: opId(65),
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        expectedRunId: receipt.runId,
      };
      expect(await fixture.runtime.acceptExternal(abort)).toMatchObject({ accepted: true });
      expect(fixture.runtime.snapshot().pendingControls).toEqual([]);
      fixture.driver.complete(receipt.runId, 'aborted');
      await fixture.runtime.close();
    }

    {
      const executions: string[] = [];
      const fixture = await registryRuntimeFixture(registration(executions));
      const root = prompt(opId(66), 'abort final freshness');
      const receipt = await fixture.runtime.acceptExternal(root);
      if (!receipt.accepted || receipt.runId === undefined) throw new Error('prompt was not accepted');
      const runtimeTurn = await captureRegistryTurn(fixture, root.opId, receipt.runId, 1);
      const prepared = await runtimeTurn.prepareToolCall({
        type: 'tool_call', id: 'call-abort-final', name: 'versioned-plan', arguments: { value: 'x' },
      }, 0, new AbortController().signal);
      if (!prepared.ok) throw new Error(prepared.message);
      const entered = deferred<void>();
      const gate = deferred<void>();
      fixture.freshness.onCheck = (ordinal) => { if (ordinal === 2) entered.resolve(undefined); };
      fixture.freshness.barriers[1] = gate.promise;
      const controller = new AbortController();
      const execution = prepared.execute({ signal: controller.signal, onUpdate: () => undefined });
      await entered.promise;
      controller.abort();
      gate.resolve(undefined);
      await expect(execution).rejects.toThrow('interrupted');
      expect(executions).toEqual([]);
      fixture.driver.complete(receipt.runId, 'completed');
      await fixture.runtime.close();
    }
  });

  test('fails closed for unknown, extra-key, and malformed-grant policy decisions', async () => {
    const executions: string[] = [];
    const fixture = await registryRuntimeFixture(scopedExecuteRegistration(executions));
    const root = prompt(opId(67), 'malformed decisions');
    const receipt = await fixture.runtime.acceptExternal(root);
    if (!receipt.accepted || receipt.runId === undefined) throw new Error('prompt was not accepted');
    const runtimeTurn = await captureRegistryTurn(fixture, root.opId, receipt.runId, 1);
    const decisions: unknown[] = [
      { kind: 'future', code: 'future', reason: 'unknown' },
      { kind: 'allow', code: 'allow', reason: 'extra', extra: true },
      {
        kind: 'ask',
        code: 'ask',
        reason: 'malformed grant',
        description: 'malformed grant',
        grantProposal: { kind: 'legacy_global_approvals_v1', patterns: ['z', 'a'] },
      },
    ];
    for (const [sourceOrdinal, decision] of decisions.entries()) {
      fixture.threadPolicyEngine.nextDecision = decision;
      expect(await runtimeTurn.prepareToolCall({
        type: 'tool_call',
        id: `call-malformed-${sourceOrdinal}`,
        name: 'scoped-execute',
        arguments: { command: `command-${sourceOrdinal}` },
      }, sourceOrdinal, new AbortController().signal)).toEqual({
        ok: false,
        message: 'Policy engine returned an invalid decision.',
      });
    }
    expect(fixture.runtime.snapshot().pendingControls).toEqual([]);
    expect(executions).toEqual([]);
    fixture.driver.complete(receipt.runId, 'completed');
    await fixture.runtime.close();
  });

  test('consumes and replaces durable rule-scope windows under a fixed discovery budget', async () => {
    const fixture = await registryRuntimeFixture(versionedPlanRegistration({
      version: '1.0.0',
      implementationDigit: '9',
      valueType: 'string',
      execute: async () => ({ content: [{ type: 'text', text: 'unused' }] }),
    }));
    fixture.ruleSnapshots.maxKnownScopes = 1;
    fixture.freshness.results.push(
      { fresh: false, code: 'rule_scope_missing', missingScopes: ['/scope-a'], message: 'scope a missing' },
      { fresh: false, code: 'rule_scope_missing', missingScopes: ['/scope-b'], message: 'scope b missing' },
    );
    const root = prompt(opId(68), 'rolling scopes');
    const receipt = await fixture.runtime.acceptExternal(root);
    if (!receipt.accepted || receipt.runId === undefined) throw new Error('prompt was not accepted');

    const first = await captureRegistryTurn(fixture, root.opId, receipt.runId, 1);
    expect(await first.prepareToolCall({
      type: 'tool_call', id: 'call-scope-a', name: 'versioned-plan', arguments: { value: 'a' },
    }, 0, new AbortController().signal)).toMatchObject({ ok: false, message: 'scope a missing' });
    expect([...foldThreadJournal(fixture.journal.records).observedRuleScopes]).toEqual(['/scope-a']);

    const second = await captureRegistryTurn(fixture, root.opId, receipt.runId, 2);
    expect(await second.prepareToolCall({
      type: 'tool_call', id: 'call-scope-b', name: 'versioned-plan', arguments: { value: 'b' },
    }, 0, new AbortController().signal)).toMatchObject({ ok: false, message: 'scope b missing' });
    expect([...foldThreadJournal(fixture.journal.records).observedRuleScopes]).toEqual(['/scope-b']);

    await captureRegistryTurn(fixture, root.opId, receipt.runId, 3);
    expect(fixture.ruleSnapshots.calls.map((call) => call.knownResourceScopes)).toEqual([
      [],
      ['/scope-a'],
      ['/scope-b'],
    ]);
    expect([...foldThreadJournal(fixture.journal.records).observedRuleScopes]).toEqual([]);
    const secondTurnId = fixture.ruleSnapshots.calls[1]?.context.turnId;
    const thirdTurnId = fixture.ruleSnapshots.calls[2]?.context.turnId;
    if (secondTurnId === undefined || thirdTurnId === undefined) throw new Error('missing captured turn');
    const replacements = fixture.journal.records.flatMap((record) =>
      record.type === 'commit'
        ? (record.mutations ?? []).filter((mutation) => mutation.type === 'rule_scope_window_replaced')
        : []);
    expect(replacements).toEqual([
      {
        type: 'rule_scope_window_replaced',
        consumedScopes: ['/scope-a'],
        replacementScopes: [],
        owningTurnId: secondTurnId,
      },
      {
        type: 'rule_scope_window_replaced',
        consumedScopes: ['/scope-b'],
        replacementScopes: [],
        owningTurnId: thirdTurnId,
      },
    ]);

    fixture.driver.complete(receipt.runId, 'completed');
    await fixture.runtime.close();
  });

  test('checks freshness twice and durably commits a canonical allow-always grant before execution', async () => {
    const actions: string[] = [];
    const fixture = await registryRuntimeFixture(scopedExecuteRegistration(actions), { actions });
    const root = prompt(opId(41), 'canonical approval');
    const receipt = await fixture.runtime.acceptExternal(root);
    if (!receipt.accepted || receipt.runId === undefined) throw new Error('prompt was not accepted');
    const runtimeTurn = await captureRegistryTurn(fixture, root.opId, receipt.runId, 1);
    const iterator = fixture.events.subscribe({ threadIds: [THREAD_ID] })[Symbol.asyncIterator]();
    const commitEntered = deferred<void>();
    const commitGate = deferred<void>();
    let responseStateAtGrantCommit: string | undefined;
    fixture.grants.beforeCommit = (grant) => {
      responseStateAtGrantCommit = fixture.runtime.durableState().mailbox.get(grant.grantId)?.state;
      commitEntered.resolve(undefined);
    };
    fixture.grants.commitBarrier = commitGate.promise;

    let preparationSettled = false;
    const preparationPromise = runtimeTurn.prepareToolCall({
      type: 'tool_call',
      id: 'call-canonical-approval',
      name: 'scoped-execute',
      arguments: { command: 'bun test' },
    }, 0, new AbortController().signal).then((result) => {
      preparationSettled = true;
      return result;
    });
    const request = await nextEnvelope(iterator, (envelope) => envelope.event.type === 'control_request');
    if (request.event.type !== 'control_request' || request.event.kind !== 'approval') {
      throw new Error('missing approval control request');
    }
    const proposal = request.event.payload.grantProposal;
    expect(proposal).toMatchObject({
      capabilityId: 'scoped-execute',
      capabilityVersion: '1.0.0',
      scope: {
        kind: 'canonical_resources_v1',
        resourcePatterns: [{
          resourceType: 'command',
          access: 'execute',
          matcher: 'canonical_target_exact_v1',
          pattern: 'bun test',
        }],
      },
    });
    if (proposal === undefined) throw new Error('missing canonical grant proposal');
    expect(request.event.payload.presentation).toMatchObject({
      requestId: request.event.requestId,
      target: {
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        runId: receipt.runId,
        turnId: request.event.owningTurnId,
      },
      capability: { id: 'scoped-execute', version: '1.0.0' },
      normalizedResources: [{
        selectorId: 'command',
        resourceType: 'command',
        access: 'execute',
        canonicalTarget: 'bun test',
      }],
      risk: { description: expect.any(String) },
      allowOnce: {
        invocationId: expect.any(String),
        toolCallId: 'call-canonical-approval',
      },
      allowAlways: proposal.scope,
      revisions: {
        catalog: expect.any(Number),
        effectivePolicy: expect.any(String),
        policyBasis: expect.any(String),
        ceiling: expect.any(String),
        grants: expect.any(String),
      },
    });
    expect(preparationSettled).toBe(false);

    const response = {
      type: 'control_response',
      opId: opId(42),
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      requestId: request.event.requestId,
      decision: 'allow_always',
    } as const;
    expect(await fixture.runtime.acceptExternal(response)).toMatchObject({ accepted: true });
    await commitEntered.promise;
    expect(responseStateAtGrantCommit).toBe('started');
    expect(preparationSettled).toBe(false);
    expect(fixture.runtime.snapshot().pendingControls).toHaveLength(1);
    expect(fixture.runtime.durableState().envelopes.some((envelope) =>
      envelope.event.type === 'control_resolved' && envelope.opId === response.opId)).toBe(false);
    expect(fixture.grants.commits).toEqual([{
      grantId: response.opId,
      workspaceId: WORKSPACE_ID,
      capabilityId: proposal.capabilityId,
      capabilityVersion: proposal.capabilityVersion,
      registrationDigest: proposal.registrationDigest,
      scope: proposal.scope,
      policyBasisRevision: proposal.policyBasisRevision,
      acceptedAt: 1,
    }]);
    expect(actions).toEqual([
      'policy:capture',
      'freshness:1',
      'policy:evaluate',
      'grant:commit-enter',
    ]);

    const resolutionPromise = nextEnvelope(iterator, (envelope) =>
      envelope.event.type === 'control_resolved' && envelope.opId === response.opId);
    commitGate.resolve(undefined);
    const resolution = await resolutionPromise;
    expect(resolution.event).toMatchObject({ type: 'control_resolved', decision: 'allow_always' });
    expect(actions).toEqual([
      'policy:capture',
      'freshness:1',
      'policy:evaluate',
      'grant:commit-enter',
      'grant:commit',
    ]);
    const preparation = await preparationPromise;
    if (!preparation.ok) throw new Error(preparation.message);
    expect(fixture.runtime.snapshot().pendingControls).toEqual([]);
    expect(actions).not.toContain('executor');
    await preparation.execute({ signal: new AbortController().signal, onUpdate: () => undefined });
    expect(actions).toEqual([
      'policy:capture',
      'freshness:1',
      'policy:evaluate',
      'grant:commit-enter',
      'grant:commit',
      'freshness:2',
      'executor',
    ]);
    expect(fixture.freshness.calls).toHaveLength(2);
    const invocation = fixture.threadPolicyEngine.evaluations[0];
    if (invocation === undefined) throw new Error('policy invocation was not recorded');
    for (const call of fixture.freshness.calls) {
      expect(call.snapshot).toBe(invocation.effectivePolicy.rules);
      expect(call.context).toBe(invocation.context);
      expect(call.resources).toBe(invocation.resources);
    }

    fixture.driver.complete(receipt.runId, 'completed');
    await iterator.return?.();
    await fixture.runtime.close();
  });

  test('rejects workspace allow-always without a proposal and leaves the approval pending', async () => {
    const actions: string[] = [];
    const fixture = await registryRuntimeFixture(unscopedExecuteRegistration(actions), { actions });
    const root = prompt(opId(43), 'unscoped approval');
    const receipt = await fixture.runtime.acceptExternal(root);
    if (!receipt.accepted || receipt.runId === undefined) throw new Error('prompt was not accepted');
    const runtimeTurn = await captureRegistryTurn(fixture, root.opId, receipt.runId, 1);
    const iterator = fixture.events.subscribe({ threadIds: [THREAD_ID] })[Symbol.asyncIterator]();

    let preparationSettled = false;
    const preparationPromise = runtimeTurn.prepareToolCall({
      type: 'tool_call',
      id: 'call-unscoped-approval',
      name: 'unscoped-execute',
      arguments: { command: 'opaque-script' },
    }, 0, new AbortController().signal).then((result) => {
      preparationSettled = true;
      return result;
    });
    const request = await nextEnvelope(iterator, (envelope) => envelope.event.type === 'control_request');
    if (request.event.type !== 'control_request' || request.event.kind !== 'approval') {
      throw new Error('missing approval control request');
    }
    expect(request.event.payload.grantProposal).toBeUndefined();

    const invalidResponse = {
      type: 'control_response',
      opId: opId(44),
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      requestId: request.event.requestId,
      decision: 'allow_always',
    } as const;
    expect(await fixture.runtime.acceptExternal(invalidResponse)).toMatchObject({
      accepted: false,
      reason: 'invalid_decision',
    });
    expect(preparationSettled).toBe(false);
    expect(fixture.runtime.snapshot().pendingControls).toHaveLength(1);
    expect(fixture.grants.commits).toEqual([]);
    expect(actions).not.toContain('executor');

    const denyResponse = { ...invalidResponse, opId: opId(45), decision: 'deny' as const };
    expect(await fixture.runtime.acceptExternal(denyResponse)).toMatchObject({ accepted: true });
    expect(await preparationPromise).toMatchObject({ ok: false });
    expect(fixture.runtime.snapshot().pendingControls).toEqual([]);
    expect(fixture.grants.commits).toEqual([]);
    expect(actions).not.toContain('executor');

    fixture.driver.complete(receipt.runId, 'completed');
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
  readonly workspaceApprovalFailure?: () => Error | undefined;
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
    ...(options.workspaceApprovalFailure !== undefined && {
      workspaceApprovalFailure: options.workspaceApprovalFailure,
    }),
  });
  return { runtime, writer, journal, events, driver, policy };
}

interface RegistryRuntimeFixture extends RuntimeFixture {
  readonly registry: CapabilityRegistry;
  readonly providers: ProviderAdapterRegistry;
  readonly capabilityReader: CountingCapabilityReader;
  readonly providerReader: CountingProviderReader;
  readonly ruleSnapshots: RecordingRuleSnapshots;
  readonly basePrompts: RecordingBasePrompts;
  readonly freshness: RecordingFreshness;
  readonly grants: RecordingPolicyGrants;
  readonly threadPolicyEngine: RecordingThreadPolicyEngine;
}

async function registryRuntimeFixture(
  registration: CapabilityRegistration,
  options: { readonly actions?: string[] } = {},
): Promise<RegistryRuntimeFixture> {
  const actions = options.actions ?? [];
  const registry = createCapabilityRegistry();
  const registered = registry.register(registration);
  if (!registered.ok) throw new Error(registered.message);
  const providers = createProviderAdapterRegistry();
  const providerRegistered = providers.register({
    api: 'faux',
    version: '1.0.0',
    implementationDigest: implementationDigest('3'),
    stream: STREAM_V1,
  });
  if (!providerRegistered.ok) throw new Error(providerRegistered.message);
  const capabilityReader = new CountingCapabilityReader(registry);
  const providerReader = new CountingProviderReader(providers);
  const ruleSnapshots = new RecordingRuleSnapshots();
  const basePrompts = new RecordingBasePrompts();
  const freshness = new RecordingFreshness(actions);
  const grants = new RecordingPolicyGrants(actions);
  const policyEngine = createPolicyEngine();
  const threadPolicyEngine = new RecordingThreadPolicyEngine(
    await policyEngine.openThread({ workspaceId: WORKSPACE_ID, threadId: THREAD_ID }),
    actions,
  );
  const capabilityServices: RuntimeCapabilityServices = {
    capabilities: capabilityReader,
    providers: providerReader,
    promptAssembler: createPromptAssembler(),
    basePrompts,
    ruleSnapshots,
    ruleBudget: RULE_BUDGET,
    policyEngine,
    ruleFreshness: freshness,
    grantMode: 'workspace',
  };

  const meta = threadMeta();
  const journal = new RecordingJournal([meta]);
  const events = new EventHub();
  events.registerThread(THREAD_ID);
  const writer = writerFor(journal, events);
  const driver = new ScriptedDriver();
  const policy = new CountingPolicy();
  const runtime = new ThreadRuntime({
    workspaceId: WORKSPACE_ID,
    cwd: '/runtime/thread-runtime',
    threadId: THREAD_ID,
    writer,
    attachment: attachment(driver, MODEL.ref),
    identityFactory: new TestIdentityFactory(),
    clock: TEST_CLOCK,
    permissionPolicy: policy,
    threadCeiling: CEILING,
    capabilityServices,
    threadPolicyEngine,
    policyGrants: grants,
  });
  return {
    runtime,
    writer,
    journal,
    events,
    driver,
    policy,
    registry,
    providers,
    capabilityReader,
    providerReader,
    ruleSnapshots,
    basePrompts,
    freshness,
    grants,
    threadPolicyEngine,
  };
}

async function captureRegistryTurn(
  fixture: RegistryRuntimeFixture,
  rootOpId: ExternalOpId,
  runId: RunId,
  turnOrdinal: number,
): Promise<Awaited<ReturnType<ThreadRuntime['captureRuntimeTurn']>>> {
  const reservation = await fixture.runtime.reserveTurn({ runId, turnOrdinal });
  const runtimeTurn = await fixture.runtime.captureRuntimeTurn({
    rootOpId,
    runId,
    turnId: reservation.turnId,
    model: MODEL,
    transcript: [],
    signal: new AbortController().signal,
  });
  await fixture.runtime.commitDriverEvent({
    event: { type: 'turn_start' },
    runId,
    turnId: reservation.turnId,
  });
  return runtimeTurn;
}

function registryCaptureCounts(fixture: RegistryRuntimeFixture): {
  readonly catalog: number;
  readonly providers: number;
  readonly grants: number;
  readonly rules: number;
  readonly basePrompt: number;
  readonly policy: number;
} {
  return {
    catalog: fixture.capabilityReader.snapshotCalls,
    providers: fixture.providerReader.snapshotCalls,
    grants: fixture.grants.snapshotCalls,
    rules: fixture.ruleSnapshots.calls.length,
    basePrompt: fixture.basePrompts.calls.length,
    policy: fixture.threadPolicyEngine.captureCalls.length,
  };
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

const RULE_BUDGET = {
  maxFiles: 8,
  maxFileBytes: 16_384,
  maxBytes: 65_536,
  maxPromptTokens: 8_192,
} as const;

const STRING_VALUE_SCHEMA = {
  type: 'object',
  properties: { value: { type: 'string' } },
  required: ['value'],
  additionalProperties: false,
} as const;

const NUMBER_VALUE_SCHEMA = {
  type: 'object',
  properties: { value: { type: 'number' } },
  required: ['value'],
  additionalProperties: false,
} as const;

const STREAM_V1: StreamFn = () => new ProviderEventStream();
const STREAM_V2: StreamFn = () => new ProviderEventStream();

function versionedPlanRegistration(input: {
  readonly version: string;
  readonly implementationDigit: string;
  readonly valueType: 'string' | 'number';
  readonly execute: CapabilityRegistration['execute'];
}): CapabilityRegistration {
  const inputSchema = input.valueType === 'string' ? STRING_VALUE_SCHEMA : NUMBER_VALUE_SCHEMA;
  return {
    id: 'versioned-plan',
    version: input.version,
    implementationDigest: implementationDigest(input.implementationDigit),
    description: `versioned plan ${input.version}`,
    inputSchema,
    metadata: { version: input.version },
    policy: { kind: 'plan', resources: [] },
    validate(value) {
      return isTestRecord(value) && typeof value.value === input.valueType
        ? { ok: true, value }
        : { ok: false, message: `value must be ${input.valueType}` };
    },
    async resolveResources() {
      return { ok: true, resources: [] };
    },
    execute: input.execute,
  };
}

function scopedExecuteRegistration(actions: string[]): CapabilityRegistration {
  return {
    id: 'scoped-execute',
    version: '1.0.0',
    implementationDigest: implementationDigest('5'),
    description: 'execute a canonical command',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
      additionalProperties: false,
    },
    metadata: {},
    policy: {
      kind: 'execute',
      resources: [{
        selectorId: 'command',
        resourceType: 'command',
        argumentPointer: '/command',
        access: 'execute',
      }],
      attributes: { confirmation: 'required' },
    },
    validate(value) {
      return isTestRecord(value) && typeof value.command === 'string'
        ? { ok: true, value }
        : { ok: false, message: 'command must be a string' };
    },
    async resolveResources(args) {
      if (!isTestRecord(args) || typeof args.command !== 'string') {
        return { ok: false, code: 'resource_resolution_failed', message: 'missing command' };
      }
      return {
        ok: true,
        resources: [{
          selectorId: 'command',
          resourceType: 'command',
          access: 'execute',
          canonicalTarget: args.command,
        }],
      };
    },
    async execute() {
      actions.push('executor');
      return { content: [{ type: 'text', text: 'executed' }] };
    },
  };
}

function unscopedExecuteRegistration(actions: string[]): CapabilityRegistration {
  return {
    id: 'unscoped-execute',
    version: '1.0.0',
    implementationDigest: implementationDigest('6'),
    description: 'execute without a persistable scope',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
      additionalProperties: false,
    },
    metadata: {},
    policy: { kind: 'execute', resources: [] },
    validate(value) {
      return isTestRecord(value) && typeof value.command === 'string'
        ? { ok: true, value }
        : { ok: false, message: 'command must be a string' };
    },
    async resolveResources() {
      return { ok: true, resources: [] };
    },
    async execute() {
      actions.push('executor');
      return { content: [{ type: 'text', text: 'executed' }] };
    },
  };
}

function implementationDigest(digit: string): string {
  return `impl_sha256_${digit.repeat(64)}`;
}

function isTestRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

class CountingCapabilityReader implements CapabilityRegistryReader {
  snapshotCalls = 0;
  prepareBarrier: Promise<void> | undefined;
  onPrepare: (() => void) | undefined;

  constructor(private readonly registry: CapabilityRegistry) {}

  snapshot(): ReturnType<CapabilityRegistryReader['snapshot']> {
    this.snapshotCalls++;
    const snapshot = this.registry.snapshot();
    const barrier = this.prepareBarrier;
    const onPrepare = this.onPrepare;
    if (barrier === undefined && onPrepare === undefined) return snapshot;
    return Object.freeze({
      revision: snapshot.revision,
      entries: snapshot.entries,
      resolve: (capabilityId: string) => snapshot.resolve(capabilityId),
      prepare: async (input: Parameters<typeof snapshot.prepare>[0]) => {
        onPrepare?.();
        await barrier;
        return snapshot.prepare(input);
      },
    });
  }
}

class CountingProviderReader implements ProviderAdapterRegistryReader {
  snapshotCalls = 0;

  constructor(private readonly registry: ProviderAdapterRegistry) {}

  snapshot(): ReturnType<ProviderAdapterRegistryReader['snapshot']> {
    this.snapshotCalls++;
    return this.registry.snapshot();
  }
}

class RecordingRuleSnapshots implements RuleSnapshotProvider {
  readonly calls: Array<Parameters<RuleSnapshotProvider['capture']>[0]> = [];
  maxKnownScopes: number | undefined;
  captureBarrier: Promise<void> | undefined;
  onCapture: (() => void) | undefined;

  async capture(
    input: Parameters<RuleSnapshotProvider['capture']>[0],
  ): ReturnType<RuleSnapshotProvider['capture']> {
    this.calls.push(input);
    this.onCapture?.();
    await this.captureBarrier;
    if (this.maxKnownScopes !== undefined && input.knownResourceScopes.length > this.maxKnownScopes) {
      return Promise.resolve({
        ok: false,
        code: 'rule_discovery_failed',
        message: `fixed scope budget exceeded: ${input.knownResourceScopes.length}`,
      });
    }
    return {
      ok: true,
      snapshot: strictJsonSnapshot({
        revision: 'rules-v1',
        owner: input.context,
        discovery: {
          knownResourceScopes: input.knownResourceScopes,
          budget: input.budget,
          diagnostics: [],
        },
        files: [],
      }) as unknown as Extract<Awaited<ReturnType<RuleSnapshotProvider['capture']>>, { ok: true }>['snapshot'],
    };
  }
}

class RecordingBasePrompts implements BasePromptProvider {
  readonly calls: Array<Parameters<BasePromptProvider['capture']>[0]> = [];
  captureBarrier: Promise<void> | undefined;
  onCapture: (() => void) | undefined;

  async capture(
    input: Parameters<BasePromptProvider['capture']>[0],
  ): ReturnType<BasePromptProvider['capture']> {
    this.calls.push(input);
    this.onCapture?.();
    await this.captureBarrier;
    return strictJsonSnapshot({
      owner: input.context,
      model: input.model.ref,
      revision: 'base-prompt-v1',
      content: 'base prompt',
    }) as unknown as Awaited<ReturnType<BasePromptProvider['capture']>>;
  }
}

class RecordingFreshness implements RuleFreshnessPort {
  readonly calls: Array<Parameters<RuleFreshnessPort['check']>[0]> = [];
  readonly barriers: Array<Promise<void> | undefined> = [];
  readonly results: unknown[] = [];
  onCheck: ((ordinal: number) => void) | undefined;

  constructor(private readonly actions: string[]) {}

  async check(
    input: Parameters<RuleFreshnessPort['check']>[0],
  ): ReturnType<RuleFreshnessPort['check']> {
    this.calls.push(input);
    this.actions.push(`freshness:${this.calls.length}`);
    const ordinal = this.calls.length;
    this.onCheck?.(ordinal);
    await this.barriers[ordinal - 1];
    return (this.results[ordinal - 1] ?? { fresh: true }) as Awaited<ReturnType<RuleFreshnessPort['check']>>;
  }
}

class RecordingPolicyGrants implements PolicyGrantRepositoryPort {
  readonly workspaceId = WORKSPACE_ID;
  readonly mode = 'workspace' as const;
  readonly commits: Readonly<PolicyGrant>[] = [];
  snapshotCalls = 0;
  snapshotBarrier: Promise<void> | undefined;
  onSnapshot: (() => void) | undefined;
  beforeCommit: ((grant: Readonly<PolicyGrant>) => void) | undefined;
  commitBarrier: Promise<void> | undefined;
  #revision = 0;

  constructor(private readonly actions: string[]) {}

  async snapshot(): Promise<Readonly<PolicyGrantSnapshot>> {
    this.snapshotCalls++;
    this.onSnapshot?.();
    await this.snapshotBarrier;
    return strictJsonSnapshot({
      workspaceId: this.workspaceId,
      revision: `test-grants-${this.#revision}`,
      grants: this.commits,
    }) as unknown as Readonly<PolicyGrantSnapshot>;
  }

  async commitAllowAlways(
    grant: Readonly<PolicyGrant>,
  ): Promise<PolicyGrantCommitResult> {
    const captured = strictJsonSnapshot(grant) as unknown as Readonly<PolicyGrant>;
    this.commits.push(captured);
    this.actions.push('grant:commit-enter');
    this.beforeCommit?.(captured);
    await this.commitBarrier;
    this.actions.push('grant:commit');
    return { kind: 'applied', revision: `test-grants-${++this.#revision}` };
  }
}

class RecordingThreadPolicyEngine implements ThreadPolicyEngine {
  readonly captureCalls: Array<Parameters<ThreadPolicyEngine['capture']>[0]> = [];
  readonly captures: Readonly<EffectivePolicySnapshot>[] = [];
  readonly evaluations: Readonly<PreparedInvocation>[] = [];
  closeCalls = 0;
  captureBarrier: Promise<void> | undefined;
  onCapture: (() => void) | undefined;
  evaluateBarrier: Promise<void> | undefined;
  onEvaluate: (() => void) | undefined;
  nextDecision: unknown;

  constructor(
    private readonly delegate: ThreadPolicyEngine,
    private readonly actions: string[],
  ) {}

  async capture(
    input: Parameters<ThreadPolicyEngine['capture']>[0],
  ): Promise<Readonly<EffectivePolicySnapshot>> {
    this.captureCalls.push(input);
    this.actions.push('policy:capture');
    this.onCapture?.();
    await this.captureBarrier;
    const captured = await this.delegate.capture(input);
    this.captures.push(captured);
    return captured;
  }

  async evaluate(invocation: Readonly<PreparedInvocation>): Promise<PolicyDecision> {
    this.evaluations.push(invocation);
    this.actions.push('policy:evaluate');
    this.onEvaluate?.();
    await this.evaluateBarrier;
    if (this.nextDecision !== undefined) return this.nextDecision as PolicyDecision;
    return this.delegate.evaluate(invocation);
  }

  async close(): Promise<void> {
    this.closeCalls++;
    await this.delegate.close();
  }
}

class RecordingJournal implements ThreadJournalAppendPort {
  readonly records: RuntimeJournalRecord[];
  nextAppendFailure: Error | undefined;
  nextAppendBarrier: Promise<void> | undefined;
  onNextAppend: (() => void) | undefined;

  constructor(records: readonly RuntimeJournalRecord[]) {
    this.records = [...records];
  }

  async acquireWriteLease(): Promise<void> {}
  async load(): Promise<readonly RuntimeJournalRecord[]> { return [...this.records]; }
  async append(records: readonly RuntimeJournalRecord[]): Promise<void> {
    const failure = this.nextAppendFailure;
    this.nextAppendFailure = undefined;
    if (failure !== undefined) throw failure;
    const barrier = this.nextAppendBarrier;
    const onAppend = this.onNextAppend;
    this.nextAppendBarrier = undefined;
    this.onNextAppend = undefined;
    onAppend?.();
    await barrier;
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

class FailFirstTurnPolicy extends CountingPolicy {
  #failed = false;

  override async resolveCeiling(
    input: Parameters<PermissionPolicyPort['resolveCeiling']>[0],
  ): Promise<PermissionCeilingSnapshot> {
    if (input.kind === 'turn' && !this.#failed) {
      this.#failed = true;
      this.turnCalls++;
      throw new Error('turn ceiling failed before append');
    }
    return super.resolveCeiling(input);
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
    if ((command.op.type === 'prompt'
      || command.op.type === 'continue'
      || command.op.type === 'compact') && 'runId' in command) {
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
