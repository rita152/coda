import { describe, expect, it } from 'bun:test';
import type {
  AgentMessage,
  ApprovalPresentation,
  EventEnvelope,
  ExternalOpId,
  ModelConfig,
  ModelRef,
  OpReceipt,
  RunId,
  RuntimeEvent,
  RuntimeOp,
  RuntimeThreadListItem,
  ThreadId,
  ThreadSnapshot,
  TurnId,
  WorkspaceId,
} from '../protocol/index.js';
import {
  RuntimeFrontendSession,
  type RuntimeFrontendPort,
} from './runtime-frontend.js';

const WORKSPACE_ID = 'workspace-test' as WorkspaceId;
const THREAD_ID = 'thread-test' as ThreadId;
const THREAD_B = 'thread-background' as ThreadId;
const RUN_ID = 'run-test' as RunId;
const RETRY_RUN_ID = 'run-retry-test' as RunId;
const COMPACTION_RUN_ID = 'run-compaction-test' as RunId;
const TURN_ID = 'turn-test' as TurnId;
const MODEL: ModelConfig = {
  ref: { provider: 'faux', api: 'faux', model: 'faux' },
};
const RECOVERED_MODEL: ModelConfig = {
  ref: { provider: 'faux', api: 'faux', model: 'recovered-before-cli-resume' },
};

function approvalPresentation(requestId: string): ApprovalPresentation {
  return {
    requestId,
    target: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, runId: RUN_ID, turnId: TURN_ID },
    capability: { id: 'bash', version: '1', registrationDigest: 'digest-1' },
    normalizedResources: [{
      resourceType: 'command', access: 'execute', matcher: 'canonical_target_exact_v1', pattern: 'echo approved',
    }],
    risk: { code: 'command', reason: 'execute', description: 'run command' },
    allowOnce: { invocationId: 'invocation-1', toolCallId: 'tool-1' },
    revisions: {
      catalog: 1,
      effectivePolicy: 'policy-1',
      policyBasis: 'basis-1',
      ceiling: 'ceiling-1',
      grants: 'grants-1',
    },
  };
}

function approvalPayload(requestId: string) {
  return {
    toolCallId: 'tool-1',
    description: 'run command',
    presentation: approvalPresentation(requestId),
  };
}

describe('RuntimeFrontendSession', () => {
  it('hot-subscribes before create and settles prompt only at canonical op completion', async () => {
    const runtime = new FakeRuntime();
    const session = new RuntimeFrontendSession({
      runtime,
      attachment: 'create',
      threadId: THREAD_ID,
      initialModel: MODEL,
    });
    await session.initialize();
    expect(runtime.order.slice(0, 2)).toEqual(['events', 'submit:thread_create']);

    const events: string[] = [];
    session.subscribe((event) => {
      events.push(event.type);
    });
    let settled = false;
    const prompt = session.prompt('hello runtime').then(() => {
      settled = true;
    });
    await flushMicrotasks();
    expect(settled).toBe(false);
    expect(session.interactionState()).toBe('running');

    runtime.completePrompt();
    await prompt;
    await flushMicrotasks();
    expect(settled).toBe(true);
    expect(session.interactionState()).toBe('idle');
    expect(events).toEqual(['agent_start', 'message_start', 'message_end', 'agent_end', 'op_completed']);
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]?.role).toBe('user');
    await session.close();
  });

  it('uses canonical prompt completion as a terminal fallback and silences abort races', async () => {
    const runtime = new FakeRuntime();
    runtime.abortCompletesPromptAsStale = true;
    const session = new RuntimeFrontendSession({
      runtime,
      attachment: 'create',
      threadId: THREAD_ID,
      initialModel: MODEL,
    });
    await session.initialize();
    const events: string[] = [];
    const envelopes: Readonly<EventEnvelope>[] = [];
    session.subscribe((event) => {
      events.push(event.type === 'agent_end' ? `agent_end:${event.reason}` : event.type);
    });
    session.subscribeEnvelopes((envelope) => {
      envelopes.push(envelope);
    });

    const prompt = session.prompt('abort race');
    await flushMicrotasks();
    expect(session.interactionState()).toBe('running');
    session.abort();
    await prompt;
    await flushMicrotasks();

    expect(session.interactionState()).toBe('idle');
    expect(events).toEqual(['agent_start', 'agent_end:aborted']);
    expect(envelopes.map((envelope) => envelope.event.type)).toEqual([
      'agent_start',
      'op_completed',
    ]);
    expect(envelopes.at(-1)).toMatchObject({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      runId: RUN_ID,
      opId: runtime.ops[1]?.opId,
      seq: 4,
      timestamp: 4,
      event: {
        type: 'op_completed',
        opType: 'prompt',
        terminalRunId: RUN_ID,
        outcome: 'interrupted',
      },
    });
    expect(envelopes.some((envelope) => envelope.event.type === 'agent_end')).toBe(false);
    expect(runtime.ops.at(-1)).toMatchObject({
      type: 'abort',
      expectedRunId: RUN_ID,
    });
    await session.close();
  });

  it('owns retry, abort, and prompt op lifecycle in one canonical projection', async () => {
    const runtime = new FakeRuntime();
    const session = new RuntimeFrontendSession({
      runtime,
      attachment: 'create',
      threadId: THREAD_ID,
      initialModel: MODEL,
    });
    await session.initialize();
    const events: string[] = [];
    session.subscribe((event) => {
      events.push(event.type);
    });

    const prompt = session.prompt('retry lifecycle');
    await flushMicrotasks();
    expect(session.interactionState()).toBe('running');

    runtime.endPromptForRetry();
    await flushMicrotasks();
    expect(session.interactionState()).toBe('retrying');

    runtime.scheduleRetry();
    await flushMicrotasks();
    expect(session.interactionState()).toBe('retrying');
    session.abort();
    expect(runtime.ops.at(-1)).toMatchObject({
      type: 'abort',
      expectedRunId: RETRY_RUN_ID,
    });

    runtime.failRetryAndCompletePrompt();
    await prompt;
    await flushMicrotasks();
    expect(session.interactionState()).toBe('idle');
    expect(events).toEqual([
      'agent_start',
      'agent_end',
      'retry_scheduled',
      'op_completed',
      'error',
      'op_completed',
    ]);
    await session.close();
  });

  it('projects compaction activity and clears its abort target at completion', async () => {
    const runtime = new FakeRuntime();
    const session = new RuntimeFrontendSession({
      runtime,
      attachment: 'create',
      threadId: THREAD_ID,
      initialModel: MODEL,
    });
    await session.initialize();

    runtime.startCompaction();
    await flushMicrotasks();
    expect(session.interactionState()).toBe('compacting');
    session.abort();
    expect(runtime.ops.at(-1)).toMatchObject({
      type: 'abort',
      expectedRunId: COMPACTION_RUN_ID,
    });

    runtime.endCompaction();
    await flushMicrotasks();
    expect(session.interactionState()).toBe('idle');
    session.abort();
    expect(runtime.ops.at(-1)).toEqual(expect.objectContaining({ type: 'abort' }));
    expect(runtime.ops.at(-1)).not.toHaveProperty('expectedRunId');
    await session.close();
  });

  it('projects canonical control requests and maps decisions back to identity-bearing ops', async () => {
    const runtime = new FakeRuntime();
    const session = new RuntimeFrontendSession({
      runtime,
      attachment: 'create',
      threadId: THREAD_ID,
      initialModel: MODEL,
    });
    await session.initialize();
    const events: string[] = [];
    session.subscribe((event) => {
      events.push(event.type);
    });

    runtime.requestApproval('approval-1');
    await flushMicrotasks();
    expect(events).toEqual(['control_request']);
    expect(session.pendingApprovals()).toEqual([{
      requestId: 'approval-1',
      toolCallId: 'tool-1',
      description: 'run command',
      presentation: approvalPresentation('approval-1'),
    }]);

    expect(() => session.resolveApproval('missing', 'allow_once')).toThrow(/not pending/);

    session.resolveApproval('approval-1', 'allow_always');
    await flushMicrotasks();
    expect(session.pendingApprovals()).toEqual([]);
    expect(runtime.ops.at(-1)).toMatchObject({
      type: 'control_response',
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      requestId: 'approval-1',
      decision: 'allow_always',
    });

    runtime.requestApproval('approval-2');
    await flushMicrotasks();
    session.resolveApproval('approval-2', 'abort');
    await flushMicrotasks();
    expect(runtime.ops.at(-1)).toMatchObject({
      type: 'abort',
      expectedRunId: RUN_ID,
    });
    await session.close();
  });

  it('publishes recovered and live approval snapshots in canonical event order', async () => {
    const runtime = new FakeRuntime();
    runtime.requestApproval('approval-recovered');
    const session = new RuntimeFrontendSession({
      runtime,
      attachment: 'create',
      threadId: THREAD_ID,
      initialModel: MODEL,
    });
    await session.initialize();

    const order: string[] = [];
    session.subscribe((event) => {
      order.push(event.type);
    });
    const unsubscribe = session.subscribePendingApprovals((snapshot) => {
      order.push(`pending:${snapshot.approvals.map((item) => item.requestId).join(',')}`);
    });
    await flushMicrotasks();
    expect(order).toEqual(['pending:approval-recovered']);

    order.length = 0;
    runtime.requestApproval('approval-live');
    runtime.resolveApprovalExternally('approval-live');
    await flushMicrotasks();
    expect(order).toEqual([
      'control_request',
      'pending:approval-recovered,approval-live',
      'control_resolved',
      'pending:approval-recovered',
    ]);

    runtime.resolveApprovalExternally('approval-recovered');
    await flushMicrotasks();
    expect(order.at(-1)).toBe('pending:');
    unsubscribe();
    await session.close();
  });

  it('does not let a delayed initial approval snapshot overtake its canonical event', async () => {
    const runtime = new FakeRuntime();
    const session = new RuntimeFrontendSession({
      runtime,
      attachment: 'create',
      threadId: THREAD_ID,
      initialModel: MODEL,
    });
    await session.initialize();
    let releaseFanout = (): void => undefined;
    const fanoutGate = new Promise<void>((resolve) => {
      releaseFanout = resolve;
    });
    let markBlocked = (): void => undefined;
    const blocked = new Promise<void>((resolve) => {
      markBlocked = resolve;
    });
    const order: string[] = [];
    session.subscribe(async (event) => {
      if (event.type === 'agent_start') {
        markBlocked();
        await fanoutGate;
      } else if (event.type === 'control_request' && event.kind === 'approval') {
        order.push('control_request');
      }
    });
    const prompt = session.prompt('block frontend fanout');
    await blocked;

    session.subscribePendingApprovals((snapshot) => {
      order.push(`pending:${snapshot.approvals.map((item) => item.requestId).join(',')}`);
    });
    runtime.requestApproval('approval-after-subscribe');
    await flushMicrotasks();
    releaseFanout();
    await flushMicrotasks();

    expect(order).toEqual([
      'control_request',
      'pending:approval-after-subscribe',
    ]);
    runtime.completePrompt();
    await prompt;
    await session.close();
  });

  it('does not coalesce an approval removal across an intervening canonical event', async () => {
    const runtime = new FakeRuntime();
    const session = new RuntimeFrontendSession({
      runtime,
      attachment: 'create',
      threadId: THREAD_ID,
      initialModel: MODEL,
    });
    await session.initialize();
    runtime.requestApproval('approval-before-boundary');
    await flushMicrotasks();
    let presented: readonly string[] = [];
    session.subscribePendingApprovals((snapshot) => {
      presented = snapshot.approvals.map((item) => item.requestId);
    });
    await flushMicrotasks();
    expect(presented).toEqual(['approval-before-boundary']);

    let releaseFanout = (): void => undefined;
    const fanoutGate = new Promise<void>((resolve) => {
      releaseFanout = resolve;
    });
    let markBlocked = (): void => undefined;
    const blocked = new Promise<void>((resolve) => {
      markBlocked = resolve;
    });
    let presentedAtBoundary: readonly string[] | undefined;
    session.subscribe(async (event) => {
      if (event.type !== 'tool_execution_start') return;
      if (event.toolCallId === 'tool-block-fanout') {
        markBlocked();
        await fanoutGate;
      } else if (event.toolCallId === 'tool-observe-boundary') {
        presentedAtBoundary = presented;
      }
    });
    runtime.emitToolStart('tool-block-fanout');
    await blocked;

    runtime.resolveApprovalExternally('approval-before-boundary');
    runtime.emitToolStart('tool-observe-boundary');
    runtime.requestApproval('approval-after-boundary');
    await flushMicrotasks();
    releaseFanout();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(presentedAtBoundary).toEqual([]);
    expect(presented).toEqual(['approval-after-boundary']);
    runtime.resolveApprovalExternally('approval-after-boundary');
    await flushMicrotasks();
    await session.close();
  });

  it('reports rejected control responses and leaves the canonical request pending', async () => {
    for (const reason of [
      'control_request_not_found',
      'control_response_already_claimed',
    ] as const) {
      const runtime = new FakeRuntime();
      const session = new RuntimeFrontendSession({
        runtime,
        attachment: 'create',
        threadId: THREAD_ID,
        initialModel: MODEL,
      });
      await session.initialize();
      const errors: string[] = [];
      session.subscribe((event) => {
        if (event.type === 'error') errors.push(event.message);
      });
      runtime.requestApproval(`approval-${reason}`);
      await flushMicrotasks();
      runtime.controlRejectionReason = reason;

      session.resolveApproval(`approval-${reason}`, 'allow_once');
      await flushMicrotasks();
      expect(session.pendingApprovals()).toMatchObject([{ requestId: `approval-${reason}` }]);
      const afterFirstResponse = runtime.ops.length;
      session.resolveApproval(`approval-${reason}`, 'allow_once');
      await flushMicrotasks();

      expect(errors).toEqual([reason, reason]);
      expect(runtime.ops).toHaveLength(afterFirstResponse + 1);
      await session.close();
    }
  });

  it('does not revive an already-claimed approval when op_rejected precedes its receipt', async () => {
    const runtime = new FakeRuntime();
    const session = new RuntimeFrontendSession({
      runtime,
      attachment: 'create',
      threadId: THREAD_ID,
      initialModel: MODEL,
    });
    await session.initialize();
    runtime.requestApproval('approval-envelope-first');
    await flushMicrotasks();
    const snapshots: string[][] = [];
    session.subscribePendingApprovals((snapshot) => {
    snapshots.push(snapshot.approvals.map((item) => item.requestId));
    });
    await flushMicrotasks();
    snapshots.length = 0;
    runtime.controlRejectionReason = 'control_response_already_claimed';
    runtime.emitControlRejectionBeforeReceipt = true;

    session.resolveApproval('approval-envelope-first', 'allow_once');
    await flushMicrotasks();

    expect(session.pendingApprovals()).toMatchObject([{ requestId: 'approval-envelope-first' }]);
    expect(snapshots.some((snapshot) => snapshot.includes('approval-envelope-first'))).toBe(true);
    await session.close();
  });

  it('hides an in-flight approval response and restores it after a non-silent rejection', async () => {
    const runtime = new FakeRuntime();
    const session = new RuntimeFrontendSession({
      runtime,
      attachment: 'create',
      threadId: THREAD_ID,
      initialModel: MODEL,
    });
    await session.initialize();
    const errors: string[] = [];
    session.subscribe((event) => {
      if (event.type === 'error') errors.push(event.message);
    });
    runtime.requestApproval('approval-retryable');
    await flushMicrotasks();
    runtime.controlRejectionReason = 'policy_changed';

    session.resolveApproval('approval-retryable', 'allow_once');
    session.resolveApproval('approval-retryable', 'deny');
    expect(session.pendingApprovals()).toEqual([]);
    expect(runtime.ops.filter((op) => op.type === 'control_response')).toHaveLength(1);
    await flushMicrotasks();

    expect(errors).toEqual(['policy_changed']);
    expect(session.pendingApprovals()).toEqual([{
      requestId: 'approval-retryable',
      toolCallId: 'tool-1',
      description: 'run command',
      presentation: approvalPresentation('approval-retryable'),
    }]);

    runtime.controlRejectionReason = undefined;
    session.resolveApproval('approval-retryable', 'deny');
    await flushMicrotasks();
    expect(session.pendingApprovals()).toEqual([]);
    await session.close();
  });

  it('keeps a zero-thread cold start until an explicit model selection', async () => {
    const runtime = new FakeRuntime();
    const registered: ModelConfig[] = [];
    const session = new RuntimeFrontendSession({
      runtime,
      attachment: 'create',
      threadId: THREAD_ID,
      registerModel: (model) => registered.push(model),
    });
    await session.initialize();
    expect(session.isAttached()).toBe(false);
    expect(runtime.ops).toEqual([]);
    await expect(session.prompt('not yet')).rejects.toThrow(/尚未选择模型/);

    await session.setModel(MODEL);
    expect(session.isAttached()).toBe(true);
    expect(registered).toEqual([MODEL]);
    expect(runtime.ops[0]?.type).toBe('thread_create');
    session.clearModel();
    await expect(session.prompt('not after logout')).rejects.toThrow(/尚未选择模型/);
    await session.close();
  });

  it('adopts an auto-attached resume and canonically updates a different requested model', async () => {
    const runtime = new FakeRuntime();
    runtime.simulateAutoAttached(RECOVERED_MODEL.ref);
    const registered: ModelConfig[] = [];
    const session = new RuntimeFrontendSession({
      runtime,
      attachment: 'resume',
      threadId: THREAD_ID,
      initialModel: MODEL,
      registerModel: (model) => registered.push(model),
    });

    await session.initialize();

    expect(runtime.ops.map((op) => op.type)).toEqual(['thread_resume', 'set_model']);
    expect(runtime.ops[0]).toMatchObject({
      type: 'thread_resume',
      model: MODEL.ref,
    });
    expect(runtime.ops[1]).toMatchObject({
      type: 'set_model',
      model: MODEL.ref,
    });
    expect(session.currentModel()).toEqual(MODEL.ref);
    expect(registered).toEqual([MODEL]);
    await session.close();
  });

  it('adopts an auto-attached resume without rewriting an identical model', async () => {
    const runtime = new FakeRuntime();
    runtime.simulateAutoAttached(MODEL.ref);
    const session = new RuntimeFrontendSession({
      runtime,
      attachment: 'resume',
      threadId: THREAD_ID,
      initialModel: MODEL,
    });

    await session.initialize();

    expect(runtime.ops.map((op) => op.type)).toEqual(['thread_resume']);
    expect(session.currentModel()).toEqual(MODEL.ref);
    await session.close();
  });

  it('stops projection and reports fatal when snapshot-to-live sequence has a gap', async () => {
    const runtime = new FakeRuntime();
    const session = new RuntimeFrontendSession({
      runtime,
      attachment: 'create',
      threadId: THREAD_ID,
      initialModel: MODEL,
    });
    await session.initialize();
    const events: string[] = [];
    session.subscribe((event) => {
      events.push(event.type === 'error' ? `${event.type}:${event.fatal}` : event.type);
    });

    runtime.emitAfterGap();
    await flushMicrotasks();

    expect(events).toEqual(['error:true']);
    await expect(session.prompt('must not submit after a gap')).rejects.toThrow(
      /expected 3, received 4/,
    );
    await session.close();
  });

  it('rejects a gap already buffered across the hot-subscription snapshot splice', async () => {
    const runtime = new FakeRuntime();
    runtime.gapDuringAttach = true;
    const session = new RuntimeFrontendSession({
      runtime,
      attachment: 'create',
      threadId: THREAD_ID,
      initialModel: MODEL,
    });
    const events: string[] = [];
    session.subscribe((event) => {
      events.push(event.type);
    });

    await expect(session.initialize()).rejects.toThrow(/expected 3, received 4/);
    await flushMicrotasks();
    expect(events).toEqual(['error']);
    expect(runtime.closed).toBe(true);
  });

  it('returns detached deeply-readonly message snapshots', async () => {
    const runtime = new FakeRuntime();
    const session = new RuntimeFrontendSession({
      runtime,
      attachment: 'create',
      threadId: THREAD_ID,
      initialModel: MODEL,
    });
    await session.initialize();
    const prompt = session.prompt('immutable');
    await flushMicrotasks();
    runtime.completePrompt();
    await prompt;

    const exposed = session.messages as AgentMessage[];
    expect(() => exposed.splice(0)).toThrow();
    const part = exposed[0]?.content[0];
    if (part?.type === 'text') {
      expect(() => {
        (part as { text: string }).text = 'mutated';
      }).toThrow();
    }
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]?.content[0]).toMatchObject({ text: 'immutable' });
    await session.close();
  });

  it('starts live without preloading workspace snapshots and keeps a background run alive', async () => {
    const runtime = new WorkspaceFakeRuntime();
    const session = new RuntimeFrontendSession({
      runtime,
      attachment: 'resume',
      threadId: THREAD_ID,
      initialModel: MODEL,
    });
    await session.initialize();
    expect(runtime.eventOptions).toBeUndefined();
    expect(runtime.snapshotReads).toEqual([THREAD_ID]);

    const prompt = session.prompt('keep running in the background');
    await flushMicrotasks();
    expect(session.interactionState()).toBe('running');
    await session.switchSession(THREAD_B);
    expect(session.currentThreadId).toBe(THREAD_B);
    expect(session.messages[0]?.content[0]).toMatchObject({ text: 'thread B' });
    expect(runtime.ops.some((op) => op.type === 'abort')).toBe(false);

    runtime.completeBackgroundPrompt();
    await prompt;
    expect(session.currentThreadId).toBe(THREAD_B);
    expect(session.messages[0]?.content[0]).toMatchObject({ text: 'thread B' });
    await session.switchSession(THREAD_ID);
    expect(session.messages.at(-1)?.content[0]).toMatchObject({
      text: 'keep running in the background',
    });
    expect(session.eventHighWaterSeq()).toBe(9);
    await session.close();
  });

  it('keeps an in-flight approval response attached to its source thread across switches', async () => {
    const runtime = new WorkspaceFakeRuntime();
    const session = new RuntimeFrontendSession({
      runtime,
      attachment: 'resume',
      threadId: THREAD_ID,
      initialModel: MODEL,
    });
    await session.initialize();
    const errors: string[] = [];
    session.subscribe((event) => {
      if (event.type === 'error') errors.push(event.message);
    });

    runtime.requestApproval(THREAD_ID, 'approval-thread-a');
    await flushMicrotasks();
    const release = runtime.deferNextControlResponse('policy_changed');
    session.resolveApproval('approval-thread-a', 'allow_once');
    expect(session.pendingApprovals()).toEqual([]);

    await session.switchSession(THREAD_B);
    runtime.requestApproval(THREAD_B, 'approval-thread-a');
    await flushMicrotasks();
    expect(session.pendingApprovals()).toEqual([{
      requestId: 'approval-thread-a',
      toolCallId: 'tool-1',
      description: 'run command',
      presentation: approvalPresentation('approval-thread-a'),
    }]);
    await session.switchSession(THREAD_ID);
    expect(session.pendingApprovals()).toEqual([]);
    session.resolveApproval('approval-thread-a', 'deny');
    expect(runtime.ops.filter((op) => op.type === 'control_response')).toHaveLength(1);

    await session.switchSession(THREAD_B);
    release();
    await flushMicrotasks();
    expect(errors).toEqual([]);
    expect(session.pendingApprovals()).toEqual([{
      requestId: 'approval-thread-a',
      toolCallId: 'tool-1',
      description: 'run command',
      presentation: approvalPresentation('approval-thread-a'),
    }]);
    await session.switchSession(THREAD_ID);
    expect(session.pendingApprovals()).toEqual([{
      requestId: 'approval-thread-a',
      toolCallId: 'tool-1',
      description: 'run command',
      presentation: approvalPresentation('approval-thread-a'),
    }]);

    session.resolveApproval('approval-thread-a', 'deny');
    await flushMicrotasks();
    expect(session.pendingApprovals()).toEqual([]);
    await session.switchSession(THREAD_B);
    session.resolveApproval('approval-thread-a', 'deny');
    await flushMicrotasks();
    expect(session.pendingApprovals()).toEqual([]);
    await session.close();
  });

  it('restores an approval after an accepted response ends without resolving it', async () => {
    const runtime = new WorkspaceFakeRuntime();
    const session = new RuntimeFrontendSession({
      runtime,
      attachment: 'resume',
      threadId: THREAD_ID,
      initialModel: MODEL,
    });
    await session.initialize();
    runtime.requestApproval(THREAD_ID, 'approval-interrupted');
    await flushMicrotasks();
    runtime.deferNextControlResolution();

    session.resolveApproval('approval-interrupted', 'allow_always');
    await flushMicrotasks();
    expect(session.pendingApprovals()).toEqual([]);
    runtime.interruptDeferredControlResponse();
    await flushMicrotasks();
    expect(session.pendingApprovals()).toEqual([{
      requestId: 'approval-interrupted',
      toolCallId: 'tool-1',
      description: 'run command',
      presentation: approvalPresentation('approval-interrupted'),
    }]);

    session.resolveApproval('approval-interrupted', 'allow_once');
    await flushMicrotasks();
    expect(runtime.ops.filter((op) => op.type === 'control_response')).toHaveLength(2);
    expect(session.pendingApprovals()).toEqual([]);
    await session.close();
  });

  it('restores the current attached session when creating a new session fails', async () => {
    const runtime = new FakeRuntime();
    const session = new RuntimeFrontendSession({
      runtime,
      attachment: 'create',
      threadId: THREAD_ID,
      initialModel: MODEL,
    });
    await session.initialize();
    const prompt = session.prompt('preserve this transcript');
    await flushMicrotasks();
    runtime.completePrompt();
    await prompt;

    runtime.nextThreadId = 'thread-create-failure' as ThreadId;
    runtime.rejectNextCreate = 'provider unavailable';
    await expect(session.newSession()).rejects.toThrow('provider unavailable');

    expect(session.currentThreadId).toBe(THREAD_ID);
    expect(session.isAttached()).toBe(true);
    expect(session.currentModel()).toEqual(MODEL.ref);
    expect(session.messages.at(-1)?.content[0]).toMatchObject({
      text: 'preserve this transcript',
    });
    await session.close();
  });

  it('does not publish cached approvals while a failed new session rehydrates its source', async () => {
    const runtime = new FakeRuntime();
    const session = new RuntimeFrontendSession({
      runtime,
      attachment: 'create',
      threadId: THREAD_ID,
      initialModel: MODEL,
    });
    await session.initialize();
    runtime.requestApproval('approval-resolved-during-new');
    await flushMicrotasks();
    const snapshots: string[][] = [];
    session.subscribePendingApprovals((snapshot) => {
      snapshots.push(snapshot.approvals.map((item) => item.requestId));
    });
    await flushMicrotasks();
    snapshots.length = 0;

    runtime.nextThreadId = 'thread-create-failure' as ThreadId;
    runtime.rejectNextCreate = 'provider unavailable';
    const sourceSnapshot = runtime.deferNextSnapshot();
    const creation = session.newSession();
    await sourceSnapshot.requested;
    await flushMicrotasks();
    expect(snapshots.some((snapshot) => snapshot.includes('approval-resolved-during-new'))).toBe(false);

    runtime.resolveApprovalExternally('approval-resolved-during-new');
    sourceSnapshot.release();
    await expect(creation).rejects.toThrow('provider unavailable');
    await flushMicrotasks();
    expect(session.pendingApprovals()).toEqual([]);
    expect(snapshots.at(-1)).toEqual([]);
    await session.close();
  });

  it('closes runtime resources when hot subscription setup throws', async () => {
    const runtime = new FakeRuntime();
    runtime.eventsFailure = new Error('subscription failed');
    const session = new RuntimeFrontendSession({
      runtime,
      attachment: 'create',
      threadId: THREAD_ID,
      initialModel: MODEL,
    });

    await expect(session.initialize()).rejects.toThrow('subscription failed');
    expect(runtime.closed).toBe(true);
    expect(runtime.ops).toEqual([]);
    await expect(session.initialize()).rejects.toThrow('runtime frontend is closed');
  });
});

class FakeRuntime implements RuntimeFrontendPort {
  readonly workspaceId = WORKSPACE_ID;
  readonly order: string[] = [];
  readonly ops: RuntimeOp[] = [];
  readonly #events = new AsyncQueue<Readonly<EventEnvelope>>();
  #opOrdinal = 0;
  #seq = 0;
  #model: ModelRef = MODEL.ref;
  readonly #transcript: AgentMessage[] = [];
  #pendingPrompt: Extract<RuntimeOp, { type: 'prompt' }> | undefined;
  #pendingApprovals = new Map<string, { runId: RunId; turnId: TurnId }>();
  #deferredSnapshot: {
    readonly promise: Promise<void>;
    readonly markRequested: () => void;
  } | undefined;
  eventsFailure: Error | undefined;
  controlRejectionReason: string | undefined;
  emitControlRejectionBeforeReceipt = false;
  abortCompletesPromptAsStale = false;
  gapDuringAttach = false;
  autoAttached = false;
  closed = false;
  nextThreadId = THREAD_ID;
  rejectNextCreate: string | undefined;

  simulateAutoAttached(model: ModelRef): void {
    this.autoAttached = true;
    this.#model = model;
  }

  newThreadId(): ThreadId {
    return this.nextThreadId;
  }

  newOpId(): ExternalOpId {
    this.#opOrdinal++;
    return `op_e_${this.#opOrdinal.toString(16).padStart(32, '0')}` as ExternalOpId;
  }

  async submit(op: RuntimeOp): Promise<OpReceipt> {
    this.order.push(`submit:${op.type}`);
    this.ops.push(op);
    switch (op.type) {
      case 'thread_create':
      case 'thread_resume':
      case 'conversation_fork':
      case 'conversation_retry':
        if (op.type === 'thread_create' && this.rejectNextCreate !== undefined) {
          const reason = this.rejectNextCreate;
          this.rejectNextCreate = undefined;
          return {
            accepted: false,
            opId: op.opId,
            duplicate: false,
            reason,
            threadId: op.threadId,
          };
        }
        if (op.type === 'thread_resume' && this.autoAttached) {
          return {
            accepted: false,
            opId: op.opId,
            duplicate: false,
            reason: 'thread_already_attached',
            threadId: THREAD_ID,
          };
        }
        this.#model = op.model;
        this.#push(
          op.type === 'thread_create'
            ? { type: 'thread_created', thread: this.#thread('idle') }
            : { type: 'thread_resumed', thread: this.#thread('idle') },
          { opId: op.opId },
        );
        this.#push({ type: 'op_completed', opType: op.type, outcome: 'applied' }, { opId: op.opId });
        if (this.gapDuringAttach) this.emitAfterGap();
        return { accepted: true, opId: op.opId, duplicate: false, threadId: THREAD_ID };
      case 'prompt':
        this.#pendingPrompt = op;
        this.#push({ type: 'agent_start', reason: 'prompt' }, { opId: op.opId, runId: RUN_ID });
        return {
          accepted: true,
          opId: op.opId,
          duplicate: false,
          threadId: THREAD_ID,
          runId: RUN_ID,
        };
      case 'set_model':
        this.#model = op.model;
        this.#push({ type: 'op_completed', opType: op.type, outcome: 'applied' }, { opId: op.opId });
        return { accepted: true, opId: op.opId, duplicate: false, threadId: THREAD_ID };
      case 'control_response': {
        if (this.controlRejectionReason !== undefined) {
          if (this.emitControlRejectionBeforeReceipt) {
            this.#push({
              type: 'op_rejected',
              opType: op.type,
              reason: this.controlRejectionReason,
            }, { opId: op.opId });
          }
          return {
            accepted: false,
            opId: op.opId,
            duplicate: false,
            reason: this.controlRejectionReason,
            threadId: THREAD_ID,
          };
        }
        const pending = this.#pendingApprovals.get(op.requestId);
        if (pending !== undefined) {
          this.#pendingApprovals.delete(op.requestId);
          this.#push({
            type: 'control_resolved',
            requestId: op.requestId,
            kind: 'approval',
            owningRunId: pending.runId,
            owningTurnId: pending.turnId,
            policyRevision: 'policy-1',
            decision: op.decision === 'confirm' ? 'deny' : op.decision,
          }, { opId: op.opId, runId: pending.runId, turnId: pending.turnId });
        }
        this.#push({ type: 'op_completed', opType: op.type, outcome: 'applied' }, { opId: op.opId });
        return { accepted: true, opId: op.opId, duplicate: false, threadId: THREAD_ID };
      }
      case 'abort':
        if (this.abortCompletesPromptAsStale) {
          this.interruptPromptWithoutAgentEnd();
          return {
            accepted: false,
            opId: op.opId,
            duplicate: false,
            reason: 'stale_run',
            threadId: THREAD_ID,
          };
        }
        this.#push({ type: 'op_completed', opType: op.type, outcome: 'applied' }, { opId: op.opId });
        return { accepted: true, opId: op.opId, duplicate: false, threadId: THREAD_ID };
      case 'steer':
      case 'follow_up':
      case 'thread_rename':
      case 'thread_archive':
      case 'thread_close':
      case 'cancel_scope':
        this.#push({ type: 'op_completed', opType: op.type, outcome: 'applied' }, { opId: op.opId });
        return { accepted: true, opId: op.opId, duplicate: false, threadId: THREAD_ID };
      case 'compact':
        this.#push({
          type: 'op_completed',
          opType: op.type,
          terminalRunId: RUN_ID,
          outcome: 'applied',
        }, { opId: op.opId, runId: RUN_ID });
        return {
          accepted: true,
          opId: op.opId,
          duplicate: false,
          threadId: THREAD_ID,
          runId: RUN_ID,
        };
      case 'continue':
        this.#push({
          type: 'op_completed',
          opType: op.type,
          terminalRunId: RUN_ID,
          outcome: 'applied',
        }, { opId: op.opId, runId: RUN_ID });
        return { accepted: true, opId: op.opId, duplicate: false, threadId: THREAD_ID };
    }
  }

  events(): AsyncIterable<Readonly<EventEnvelope>> {
    if (this.eventsFailure !== undefined) throw this.eventsFailure;
    this.order.push('events');
    return this.#events;
  }

  async getThreadSnapshot(): Promise<ThreadSnapshot> {
    const deferredSnapshot = this.#deferredSnapshot;
    if (deferredSnapshot !== undefined) {
      this.#deferredSnapshot = undefined;
      deferredSnapshot.markRequested();
      await deferredSnapshot.promise;
    }
    if (this.gapDuringAttach) await flushMicrotasks();
    return {
      thread: this.#thread('idle'),
      model: this.#model,
      transcript: [...this.#transcript],
      usage: { cumulative: { input: 0, output: 0 }, turns: 0, contextTokens: 0 },
      queues: { steering: [], followUp: [] },
      plan: [],
      pendingControls: [...this.#pendingApprovals].map(([requestId, pending]) => ({
        type: 'control_request' as const,
        requestId,
        kind: 'approval' as const,
        owningRunId: pending.runId,
        owningTurnId: pending.turnId,
        policyRevision: 'policy-1',
        payload: approvalPayload(requestId),
      })),
      highWaterSeq: this.gapDuringAttach ? 2 : this.#seq,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.#events.end();
  }

  deferNextSnapshot(): { readonly requested: Promise<void>; readonly release: () => void } {
    let release = (): void => undefined;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markRequested = (): void => undefined;
    const requested = new Promise<void>((resolve) => {
      markRequested = resolve;
    });
    this.#deferredSnapshot = { promise, markRequested };
    return { requested, release };
  }

  emitAfterGap(): void {
    this.#seq += 2;
    this.#events.push({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      seq: this.#seq,
      timestamp: this.#seq,
      event: {
        type: 'runtime_diagnostic',
        severity: 'warning',
        code: 'after-gap',
        message: 'must not project',
        scope: 'thread',
      },
    });
  }

  completePrompt(): void {
    const op = this.#pendingPrompt;
    if (op === undefined) throw new Error('no pending prompt');
    this.#pendingPrompt = undefined;
    const message = {
      role: 'user' as const,
      id: 'user-1',
      timestamp: 1,
      content: [{ type: 'text' as const, text: op.text }],
      source: 'prompt' as const,
    };
    this.#transcript.push(message);
    this.#push({ type: 'message_start', message }, { opId: op.opId, runId: RUN_ID, turnId: TURN_ID });
    this.#push({ type: 'message_end', message }, { opId: op.opId, runId: RUN_ID, turnId: TURN_ID });
    this.#push({ type: 'agent_end', reason: 'completed', messages: [message] }, {
      opId: op.opId,
      runId: RUN_ID,
    });
    this.#push({
      type: 'op_completed',
      opType: 'prompt',
      terminalRunId: RUN_ID,
      outcome: 'applied',
    }, { opId: op.opId, runId: RUN_ID });
  }

  interruptPromptWithoutAgentEnd(): void {
    const op = this.#pendingPrompt;
    if (op === undefined) throw new Error('no pending prompt');
    this.#pendingPrompt = undefined;
    this.#push({
      type: 'op_completed',
      opType: 'prompt',
      terminalRunId: RUN_ID,
      outcome: 'interrupted',
    }, { opId: op.opId, runId: RUN_ID });
  }

  endPromptForRetry(): void {
    const op = this.#pendingPrompt;
    if (op === undefined) throw new Error('no pending prompt');
    this.#push({
      type: 'agent_end',
      reason: 'error',
      messages: [],
      willRetry: true,
    }, { opId: op.opId, runId: RUN_ID });
  }

  scheduleRetry(): void {
    const op = this.#pendingPrompt;
    if (op === undefined) throw new Error('no pending prompt');
    this.#push({
      type: 'retry_scheduled',
      attempt: 1,
      maxAttempts: 3,
      delayMs: 10,
      errorMessage: 'retry requested',
      predecessorRunId: RUN_ID,
      successorRunId: RETRY_RUN_ID,
    }, { opId: op.opId, runId: RETRY_RUN_ID });
  }

  failRetryAndCompletePrompt(): void {
    const op = this.#pendingPrompt;
    if (op === undefined) throw new Error('no pending prompt');
    this.#pendingPrompt = undefined;
    this.#push({ type: 'error', fatal: false, message: 'retry cancelled by abort' }, {
      opId: op.opId,
      runId: RETRY_RUN_ID,
    });
    this.#push({
      type: 'op_completed',
      opType: 'prompt',
      terminalRunId: RETRY_RUN_ID,
      outcome: 'interrupted',
    }, { opId: op.opId, runId: RETRY_RUN_ID });
  }

  startCompaction(): void {
    this.#push({
      type: 'compaction_start',
      reason: 'threshold',
      predecessorRunId: RUN_ID,
      activityRunId: COMPACTION_RUN_ID,
    }, { runId: COMPACTION_RUN_ID });
  }

  endCompaction(): void {
    this.#push({
      type: 'compaction_end',
      activityRunId: COMPACTION_RUN_ID,
      ok: true,
      droppedMessages: 2,
    }, { runId: COMPACTION_RUN_ID });
  }

  requestApproval(requestId: string): void {
    this.#pendingApprovals.set(requestId, { runId: RUN_ID, turnId: TURN_ID });
    this.#push({
      type: 'control_request',
      requestId,
      kind: 'approval',
      owningRunId: RUN_ID,
      owningTurnId: TURN_ID,
      policyRevision: 'policy-1',
      payload: approvalPayload(requestId),
    }, { runId: RUN_ID, turnId: TURN_ID });
  }

  emitToolStart(toolCallId: string): void {
    this.#push({
      type: 'tool_execution_start',
      toolCallId,
      toolName: 'bash',
      args: { command: 'true' },
    }, { runId: RUN_ID, turnId: TURN_ID });
  }

  resolveApprovalExternally(requestId: string): void {
    const pending = this.#pendingApprovals.get(requestId);
    if (pending === undefined) throw new Error(`no pending approval ${requestId}`);
    this.#pendingApprovals.delete(requestId);
    this.#push({
      type: 'control_resolved',
      requestId,
      kind: 'approval',
      owningRunId: pending.runId,
      owningTurnId: pending.turnId,
      policyRevision: 'policy-1',
      decision: 'deny',
    }, { runId: pending.runId, turnId: pending.turnId });
  }

  #thread(state: ThreadSnapshot['thread']['state']): ThreadSnapshot['thread'] {
    return {
      threadId: THREAD_ID,
      createdAt: 1,
      state,
      ...(state === 'running' && { activeRunId: RUN_ID }),
    };
  }

  #push(
    event: RuntimeEvent,
    identity: { opId?: ExternalOpId; runId?: RunId; turnId?: TurnId } = {},
  ): void {
    this.#seq++;
    this.#events.push({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      ...identity,
      seq: this.#seq,
      timestamp: this.#seq,
      event,
    });
  }
}

class WorkspaceFakeRuntime implements RuntimeFrontendPort {
  readonly workspaceId = WORKSPACE_ID;
  readonly ops: RuntimeOp[] = [];
  readonly #events = new AsyncQueue<Readonly<EventEnvelope>>();
  readonly #seq = new Map<ThreadId, number>([[THREAD_ID, 5], [THREAD_B, 3]]);
  readonly #messages = new Map<ThreadId, AgentMessage[]>([
    [THREAD_ID, [{
      role: 'user',
      id: 'thread-a-existing',
      timestamp: 1,
      source: 'prompt',
      content: [{ type: 'text', text: 'thread A' }],
    }]],
    [THREAD_B, [{
      role: 'user',
      id: 'thread-b-existing',
      timestamp: 1,
      source: 'prompt',
      content: [{ type: 'text', text: 'thread B' }],
    }]],
  ]);
  readonly #pendingApprovals = new Map<ThreadId, Map<string, {
    runId: RunId;
    turnId: TurnId;
  }>>([
    [THREAD_ID, new Map()],
    [THREAD_B, new Map()],
  ]);
  #opOrdinal = 0;
  #pendingPrompt: Extract<RuntimeOp, { type: 'prompt' }> | undefined;
  #deferredControlReceipt: {
    readonly promise: Promise<void>;
    readonly reason: string;
  } | undefined;
  #deferControlResolution = false;
  #deferredControlResponse: Extract<RuntimeOp, { type: 'control_response' }> | undefined;
  eventOptions: Parameters<RuntimeFrontendPort['events']>[0];
  readonly snapshotReads: ThreadId[] = [];

  newThreadId(): ThreadId { return 'thread-new' as ThreadId; }

  newOpId(): ExternalOpId {
    this.#opOrdinal++;
    return `op_e_${this.#opOrdinal.toString(16).padStart(32, '0')}` as ExternalOpId;
  }

  async submit(op: RuntimeOp): Promise<OpReceipt> {
    this.ops.push(op);
    if (op.type === 'thread_resume') {
      return {
        accepted: false,
        opId: op.opId,
        duplicate: false,
        reason: 'thread_already_attached',
        threadId: op.threadId,
      };
    }
    if (op.type === 'prompt') {
      this.#pendingPrompt = op;
      this.#push(op.threadId, { type: 'agent_start', reason: 'prompt' }, {
        opId: op.opId,
        runId: RUN_ID,
      });
      return {
        accepted: true,
        opId: op.opId,
        duplicate: false,
        threadId: op.threadId,
        runId: RUN_ID,
      };
    }
    if (op.type === 'control_response') {
      const deferredReceipt = this.#deferredControlReceipt;
      if (deferredReceipt !== undefined) {
        this.#deferredControlReceipt = undefined;
        await deferredReceipt.promise;
        return {
          accepted: false,
          opId: op.opId,
          duplicate: false,
          reason: deferredReceipt.reason,
          threadId: op.threadId,
        };
      }
      if (this.#deferControlResolution) {
        this.#deferControlResolution = false;
        this.#deferredControlResponse = op;
        return {
          accepted: true,
          opId: op.opId,
          duplicate: false,
          threadId: op.threadId,
        };
      }
      const pending = this.#pendingApprovals.get(op.threadId)?.get(op.requestId);
      if (pending !== undefined) {
        this.#pendingApprovals.get(op.threadId)?.delete(op.requestId);
        this.#push(op.threadId, {
          type: 'control_resolved',
          requestId: op.requestId,
          kind: 'approval',
          owningRunId: pending.runId,
          owningTurnId: pending.turnId,
          policyRevision: 'policy-1',
          decision: op.decision === 'confirm' ? 'deny' : op.decision,
        }, { opId: op.opId, runId: pending.runId, turnId: pending.turnId });
      }
      this.#push(op.threadId, {
        type: 'op_completed',
        opType: op.type,
        outcome: 'applied',
      }, { opId: op.opId });
      return {
        accepted: true,
        opId: op.opId,
        duplicate: false,
        threadId: op.threadId,
      };
    }
    return {
      accepted: true,
      opId: op.opId,
      duplicate: false,
      ...('threadId' in op && { threadId: op.threadId }),
    };
  }

  events(options?: Parameters<RuntimeFrontendPort['events']>[0]): AsyncIterable<Readonly<EventEnvelope>> {
    this.eventOptions = options;
    return this.#events;
  }

  async listThreadDetails(): Promise<readonly RuntimeThreadListItem[]> {
    return [THREAD_ID, THREAD_B].map((threadId) => ({
      workspaceId: WORKSPACE_ID,
      cwd: '/workspace',
      thread: this.#thread(threadId, 'idle'),
      updatedAt: 1,
    }));
  }

  async getThreadSnapshot(threadId: ThreadId): Promise<ThreadSnapshot | undefined> {
    this.snapshotReads.push(threadId);
    if (!this.#seq.has(threadId)) return undefined;
    return {
      thread: this.#thread(threadId, this.#pendingPrompt?.threadId === threadId ? 'running' : 'idle'),
      model: MODEL.ref,
      transcript: [...(this.#messages.get(threadId) ?? [])],
      usage: { cumulative: { input: 0, output: 0 }, turns: 0, contextTokens: 0 },
      queues: { steering: [], followUp: [] },
      plan: [],
      pendingControls: [...(this.#pendingApprovals.get(threadId) ?? [])].map(
        ([requestId, pending]) => ({
          type: 'control_request' as const,
          requestId,
          kind: 'approval' as const,
          owningRunId: pending.runId,
          owningTurnId: pending.turnId,
          policyRevision: 'policy-1',
          payload: approvalPayload(requestId),
        }),
      ),
      highWaterSeq: this.#seq.get(threadId) ?? 0,
    };
  }

  requestApproval(threadId: ThreadId, requestId: string): void {
    this.#pendingApprovals.get(threadId)?.set(requestId, { runId: RUN_ID, turnId: TURN_ID });
    this.#push(threadId, {
      type: 'control_request',
      requestId,
      kind: 'approval',
      owningRunId: RUN_ID,
      owningTurnId: TURN_ID,
      policyRevision: 'policy-1',
      payload: approvalPayload(requestId),
    }, { runId: RUN_ID, turnId: TURN_ID });
  }

  deferNextControlResponse(reason: string): () => void {
    let release = (): void => undefined;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#deferredControlReceipt = { promise, reason };
    return release;
  }

  deferNextControlResolution(): void {
    this.#deferControlResolution = true;
  }

  interruptDeferredControlResponse(): void {
    const op = this.#deferredControlResponse;
    if (op === undefined) throw new Error('no deferred control response');
    this.#deferredControlResponse = undefined;
    this.#push(op.threadId, {
      type: 'op_completed',
      opType: 'control_response',
      outcome: 'interrupted',
    }, { opId: op.opId });
  }

  completeBackgroundPrompt(): void {
    const op = this.#pendingPrompt;
    if (op === undefined) throw new Error('no background prompt');
    this.#pendingPrompt = undefined;
    const message: AgentMessage = {
      role: 'user',
      id: 'thread-a-background',
      timestamp: 2,
      source: 'prompt',
      content: [{ type: 'text', text: op.text }],
    };
    this.#messages.get(op.threadId)?.push(message);
    this.#push(op.threadId, { type: 'message_start', message }, {
      opId: op.opId,
      runId: RUN_ID,
      turnId: TURN_ID,
    });
    this.#push(op.threadId, { type: 'message_end', message }, {
      opId: op.opId,
      runId: RUN_ID,
      turnId: TURN_ID,
    });
    this.#push(op.threadId, {
      type: 'op_completed',
      opType: 'prompt',
      terminalRunId: RUN_ID,
      outcome: 'applied',
    }, { opId: op.opId, runId: RUN_ID });
  }

  async close(): Promise<void> { this.#events.end(); }

  #thread(
    threadId: ThreadId,
    state: ThreadSnapshot['thread']['state'],
  ): ThreadSnapshot['thread'] {
    return {
      threadId,
      createdAt: 1,
      state,
      ...(state === 'running' && { activeRunId: RUN_ID }),
    };
  }

  #push(
    threadId: ThreadId,
    event: RuntimeEvent,
    identity: { opId?: ExternalOpId; runId?: RunId; turnId?: TurnId } = {},
  ): void {
    const seq = (this.#seq.get(threadId) ?? 0) + 1;
    this.#seq.set(threadId, seq);
    this.#events.push({
      workspaceId: WORKSPACE_ID,
      threadId,
      ...identity,
      seq,
      timestamp: seq,
      event,
    });
  }
}

class AsyncQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  readonly #values: T[] = [];
  readonly #waiters: ((result: IteratorResult<T>) => void)[] = [];
  #closed = false;

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.#values.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.#closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  push(value: T): void {
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) waiter({ done: false, value });
    else this.#values.push(value);
  }

  end(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}
