import { describe, expect, it } from 'bun:test';
import type {
  AgentMessage,
  EventEnvelope,
  ExternalOpId,
  ModelConfig,
  ModelRef,
  OpReceipt,
  RunId,
  RuntimeEvent,
  RuntimeOp,
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
const RUN_ID = 'run-test' as RunId;
const TURN_ID = 'turn-test' as TurnId;
const MODEL: ModelConfig = {
  ref: { provider: 'faux', api: 'faux', model: 'faux' },
};
const RECOVERED_MODEL: ModelConfig = {
  ref: { provider: 'faux', api: 'faux', model: 'recovered-before-cli-resume' },
};

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
    expect(events).toEqual(['agent_start', 'message_start', 'message_end', 'agent_end']);
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]?.role).toBe('user');
    await session.close();
  });

  it('projects approval requests and maps decisions back to identity-bearing ops', async () => {
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
    expect(events).toEqual(['approval_request']);

    const beforeUnknown = runtime.ops.length;
    session.resolveApproval('missing', 'allow_once');
    expect(runtime.ops).toHaveLength(beforeUnknown);

    session.resolveApproval('approval-1', 'allow_always');
    await flushMicrotasks();
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

  it('keeps late or already-claimed approval response races silent', async () => {
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
      const afterFirstResponse = runtime.ops.length;
      session.resolveApproval(`approval-${reason}`, 'allow_once');
      await flushMicrotasks();

      expect(errors).toEqual([]);
      expect(runtime.ops).toHaveLength(afterFirstResponse);
      await session.close();
    }
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
    expect(runtime.ops).toEqual([]);
    await expect(session.prompt('not yet')).rejects.toThrow(/尚未选择模型/);

    await session.setModel(MODEL);
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
  #pendingPrompt: Extract<RuntimeOp, { type: 'prompt' }> | undefined;
  #pendingApprovals = new Map<string, { runId: RunId; turnId: TurnId }>();
  eventsFailure: Error | undefined;
  controlRejectionReason: string | undefined;
  gapDuringAttach = false;
  autoAttached = false;
  closed = false;

  simulateAutoAttached(model: ModelRef): void {
    this.autoAttached = true;
    this.#model = model;
  }

  newThreadId(): ThreadId {
    return THREAD_ID;
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
      case 'steer':
      case 'follow_up':
      case 'thread_close':
      case 'cancel_scope':
        this.#push({ type: 'op_completed', opType: op.type, outcome: 'applied' }, { opId: op.opId });
        return { accepted: true, opId: op.opId, duplicate: false, threadId: THREAD_ID };
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
    if (this.gapDuringAttach) await flushMicrotasks();
    return {
      thread: this.#thread('idle'),
      model: this.#model,
      transcript: [],
      usage: { cumulative: { input: 0, output: 0 }, turns: 0, contextTokens: 0 },
      queues: { steering: [], followUp: [] },
      plan: [],
      pendingControls: [],
      highWaterSeq: this.gapDuringAttach ? 2 : this.#seq,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.#events.end();
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

  requestApproval(requestId: string): void {
    this.#pendingApprovals.set(requestId, { runId: RUN_ID, turnId: TURN_ID });
    this.#push({
      type: 'control_request',
      requestId,
      kind: 'approval',
      owningRunId: RUN_ID,
      owningTurnId: TURN_ID,
      policyRevision: 'policy-1',
      payload: { toolCallId: 'tool-1', description: 'run command' },
    }, { runId: RUN_ID, turnId: TURN_ID });
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
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
