import { describe, expect, it } from 'bun:test';
import { PassThrough } from 'node:stream';
import type {
  EventEnvelope,
  ExternalOpId,
  OpReceipt,
  RuntimeOp,
  ThreadId,
  WorkspaceId,
} from '../protocol/index.js';
import { PROTOCOL_VERSION } from '../protocol/index.js';
import {
  startHeadless,
  type HeadlessRuntimePort,
} from './headless.js';

const WORKSPACE_ID = 'workspace-envelope' as WorkspaceId;
const THREAD_ID = 'thread-envelope' as ThreadId;
const OP_ID = 'op_e_00000000000000000000000000000001' as ExternalOpId;
const SECOND_OP_ID = 'op_e_00000000000000000000000000000002' as ExternalOpId;

describe('canonical headless transport', () => {
  it('registers hot events, survives invalid input, emits receipt, and drains on shutdown', async () => {
    const runtime = new FakeHeadlessRuntime();
    const stdin = new PassThrough();
    const output = new CapturingOutput();
    const running = startHeadless(runtime, { stdin, stdout: output });

    const hello = await output.waitFor((frame) => frame.type === 'protocol');
    expect(hello).toEqual({
      type: 'protocol',
      protocolVersion: PROTOCOL_VERSION,
      workspaceId: WORKSPACE_ID,
    });
    expect(runtime.order).toEqual(['events']);

    stdin.write('{not-json}\n');
    await output.waitFor(
      (frame) => frame.type === 'transport_error' && frame.code === 'invalid_input',
    );
    stdin.write(`${JSON.stringify(promptOp())}\n`);
    const receipt = await output.waitFor((frame) => frame.type === 'op_receipt');
    expect(receipt).toMatchObject({ type: 'op_receipt', receipt: { accepted: true, opId: OP_ID } });
    await output.waitFor((frame) =>
      (frame.event as { type?: unknown } | undefined)?.type === 'runtime_diagnostic',
    );

    stdin.end();
    expect(await running).toBe(0);
    expect(runtime.closed).toBe(true);
    expect(runtime.order.slice(0, 2)).toEqual(['events', 'submit:prompt']);
  });

  it('maps partial scope dispatch failure without fabricating a receipt', async () => {
    const runtime = new FakeHeadlessRuntime();
    runtime.scopeFailure = true;
    const stdin = new PassThrough();
    const output = new CapturingOutput();
    const running = startHeadless(runtime, { stdin, stdout: output });
    await output.waitFor((frame) => frame.type === 'protocol');

    const scopeOp = {
      type: 'cancel_scope',
      opId: OP_ID,
      workspaceId: WORKSPACE_ID,
      scope: 'workspace',
    } satisfies RuntimeOp;
    stdin.write(`${JSON.stringify(scopeOp)}\n`);
    const error = await output.waitFor(
      (frame) => frame.type === 'transport_error' && frame.code === 'scope_dispatch_failed',
    );
    expect(error).toMatchObject({
      fatal: false,
      opId: OP_ID,
      failedThreadIds: [THREAD_ID],
    });
    expect(output.frames.some((frame) => frame.type === 'op_receipt')).toBe(false);
    stdin.end();
    expect(await running).toBe(0);
  });

  it('dispatches every complete line before an immediate EOF closes the runtime', async () => {
    const runtime = new FakeHeadlessRuntime();
    runtime.rejectSubmitAfterClose = true;
    const stdin = new PassThrough();
    const output = new CapturingOutput();
    const running = startHeadless(runtime, { stdin, stdout: output });
    await output.waitFor((frame) => frame.type === 'protocol');

    stdin.end(
      `${JSON.stringify(promptOp(OP_ID))}\n${JSON.stringify(promptOp(SECOND_OP_ID))}\n`,
    );

    expect(await running).toBe(0);
    const receiptIds = output.frames
      .filter((frame) => frame.type === 'op_receipt')
      .map((frame) => (frame.receipt as { opId?: unknown }).opId);
    expect(receiptIds).toEqual([OP_ID, SECOND_OP_ID]);
    expect(runtime.order).toEqual(['events', 'submit:prompt', 'submit:prompt', 'close']);
  });

  it('keeps a --json -p initial operation sequence alive through its terminal event', async () => {
    const runtime = new FakeHeadlessRuntime();
    const stdin = new PassThrough();
    const output = new CapturingOutput();
    const createOp = {
      type: 'thread_create',
      opId: SECOND_OP_ID,
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      model: { provider: 'openai', api: 'openai-responses', model: 'gpt-5.6' },
    } satisfies RuntimeOp;
    const running = startHeadless(runtime, {
      stdin,
      stdout: output,
      initialOps: [createOp, promptOp()],
    });

    stdin.end();
    await output.waitFor((frame) =>
      frame.type === 'op_receipt' && (frame.receipt as { opId?: unknown }).opId === OP_ID,
    );
    expect(runtime.closed).toBe(false);

    runtime.emit({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      opId: OP_ID,
      seq: 3,
      timestamp: 3,
      event: { type: 'agent_end', reason: 'completed', messages: [] },
    });

    expect(await running).toBe(0);
    expect(runtime.order).toEqual(['events', 'submit:thread_create', 'submit:prompt', 'close']);
  });

  it('rejects identity-free commands instead of translating them', async () => {
    const runtime = new FakeHeadlessRuntime();
    const stdin = new PassThrough();
    const output = new CapturingOutput();
    const running = startHeadless(runtime, { stdin, stdout: output });
    await output.waitFor((frame) => frame.type === 'protocol');

    stdin.end(`${JSON.stringify({ type: 'prompt', text: 'missing runtime identity' })}\n`);

    expect(await running).toBe(0);
    expect(runtime.order).toEqual(['events', 'submit:prompt', 'close']);
    expect(output.frames.some((frame) => frame.type === 'op_receipt')).toBe(false);
    expect(output.frames).toContainEqual(expect.objectContaining({
      type: 'transport_error',
      code: 'invalid_input',
    }));
  });

  it('drains a typed stream failure and exits 1', async () => {
    const runtime = new FakeHeadlessRuntime();
    const stdin = new PassThrough();
    const output = new CapturingOutput();
    const running = startHeadless(runtime, { stdin, stdout: output });
    await output.waitFor((frame) => frame.type === 'protocol');

    const failure = Object.assign(new Error('cursor fell behind'), {
      code: 'event_subscription_gap',
      threadId: THREAD_ID,
      lastDeliveredSeq: 4,
      nextAvailableSeq: 8,
    });
    runtime.failEvents(failure);
    const frame = await output.waitFor(
      (candidate) => candidate.type === 'transport_error' && candidate.fatal === true,
    );
    expect(frame).toMatchObject({
      code: 'event_subscription_gap',
      threadId: THREAD_ID,
      lastDeliveredSeq: 4,
      nextAvailableSeq: 8,
    });
    expect(await running).toBe(1);
    expect(runtime.closed).toBe(true);
  });
});

class FakeHeadlessRuntime implements HeadlessRuntimePort {
  readonly workspaceId = WORKSPACE_ID;
  readonly order: string[] = [];
  readonly #events = new FailableAsyncQueue<Readonly<EventEnvelope>>();
  closed = false;
  scopeFailure = false;
  rejectSubmitAfterClose = false;

  async submit(op: RuntimeOp): Promise<OpReceipt> {
    if (this.rejectSubmitAfterClose && this.closed) {
      throw Object.assign(new Error('runtime closed'), { code: 'runtime_closed' });
    }
    this.order.push(`submit:${op.type}`);
    if (op.type === 'prompt' && (op.opId === undefined || op.workspaceId === undefined || op.threadId === undefined)) {
      throw Object.assign(new Error('missing prompt identity'), { code: 'invalid_runtime_op' });
    }
    if (this.scopeFailure && op.type === 'cancel_scope') {
      throw Object.assign(new Error('one target writer failed'), {
        code: 'scope_dispatch_failed',
        opId: op.opId,
        failedThreadIds: [THREAD_ID],
      });
    }
    this.#events.push({
      workspaceId: WORKSPACE_ID,
      threadId: op.type === 'cancel_scope' ? THREAD_ID : op.threadId,
      opId: op.opId,
      seq: 1,
      timestamp: 1,
      event: {
        type: 'runtime_diagnostic',
        severity: 'warning',
        code: 'fake',
        message: 'fake event',
        scope: 'thread',
      },
    });
    return {
      accepted: true,
      opId: op.opId,
      duplicate: false,
      ...(op.type !== 'cancel_scope' && { threadId: op.threadId }),
    };
  }

  events(): AsyncIterable<Readonly<EventEnvelope>> {
    this.order.push('events');
    return this.#events;
  }

  async close(): Promise<void> {
    this.order.push('close');
    this.closed = true;
    this.#events.end();
  }

  failEvents(error: unknown): void {
    this.#events.fail(error);
  }

  emit(event: Readonly<EventEnvelope>): void {
    this.#events.push(event);
  }
}

class CapturingOutput {
  readonly frames: Record<string, unknown>[] = [];
  readonly #waiters: {
    predicate: (frame: Record<string, unknown>) => boolean;
    resolve: (frame: Record<string, unknown>) => void;
  }[] = [];

  enqueue = (chunk: string): void => {
    const frame = JSON.parse(chunk) as Record<string, unknown>;
    this.frames.push(frame);
    for (let index = this.#waiters.length - 1; index >= 0; index--) {
      const waiter = this.#waiters[index];
      if (waiter !== undefined && waiter.predicate(frame)) {
        this.#waiters.splice(index, 1);
        waiter.resolve(frame);
      }
    }
  };

  drain = async (): Promise<void> => {};

  waitFor(
    predicate: (frame: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>> {
    const existing = this.frames.find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve) => this.#waiters.push({ predicate, resolve }));
  }
}

class FailableAsyncQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  readonly #values: T[] = [];
  readonly #waiters: {
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }[] = [];
  #closed = false;
  #failure: unknown;

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.#values.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.#failure !== undefined) return Promise.reject(this.#failure);
    if (this.#closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  push(value: T): void {
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) waiter.resolve({ done: false, value });
    else this.#values.push(value);
  }

  end(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  fail(error: unknown): void {
    this.#failure = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }
}

function promptOp(opId: ExternalOpId = OP_ID): Extract<RuntimeOp, { type: 'prompt' }> {
  return {
    type: 'prompt',
    opId,
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    text: 'hello',
  };
}
