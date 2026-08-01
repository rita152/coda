// Compatibility composition gate: default headless is the RuntimeFrontend legacy projection,
// never the canonical envelope/receipt transport.

import { describe, expect, it } from 'bun:test';
import { PassThrough } from 'node:stream';
import type {
  EventEnvelope,
  ExternalOpId,
  ModelConfig,
  OpReceipt,
  RuntimeOp,
  ThreadId,
  ThreadSnapshot,
  WorkspaceId,
} from '../runtime/index.js';
import { startHeadless } from './headless.js';
import { RuntimeFrontendSession, type RuntimeFrontendPort } from './runtime-frontend.js';

const WORKSPACE_ID = 'workspace-headless' as WorkspaceId;
const THREAD_ID = 'thread-headless' as ThreadId;
const MODEL: ModelConfig = { ref: { provider: 'faux', api: 'faux', model: 'faux' } };

describe('RuntimeFrontend legacy headless compatibility', () => {
  it('maps a busy receipt to the exact legacy non-fatal frame and keeps unknown approval silent', async () => {
    const runtime = new BusyRuntime();
    const frontend = new RuntimeFrontendSession({
      runtime,
      attachment: 'create',
      threadId: THREAD_ID,
      initialModel: MODEL,
    });
    await frontend.initialize();
    const stdin = new PassThrough();
    const output = new CapturingOutput();
    const running = startHeadless(frontend, {
      stdin,
      stdout: output,
      approval: {
        broker: { resolve: (id, decision) => frontend.resolveApproval(id, decision) },
        onAbort: () => undefined,
        subscribe: () => () => undefined,
      },
    });
    await output.waitFor((event) => event.type === 'protocol');

    stdin.write(`${JSON.stringify({ type: 'prompt', text: 'conflict' })}\n`);
    const busy = await output.waitFor((event) => event.type === 'error');
    expect(busy).toEqual({
      type: 'error',
      fatal: false,
      message: 'agent is running; use steer or follow_up',
    });
    expect(output.frames.some((event) => event.type === 'op_receipt')).toBe(false);

    const opCount = runtime.ops.length;
    stdin.write(
      `${JSON.stringify({ type: 'approval', approvalId: 'already-gone', decision: 'allow_once' })}\n`,
    );
    await flushMicrotasks();
    expect(runtime.ops).toHaveLength(opCount);
    expect(output.frames).toHaveLength(2);

    stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`);
    expect(await running).toBe(0);
  });
});

class BusyRuntime implements RuntimeFrontendPort {
  readonly workspaceId = WORKSPACE_ID;
  readonly ops: RuntimeOp[] = [];
  readonly #events = new AsyncQueue<Readonly<EventEnvelope>>();
  #opOrdinal = 0;
  #seq = 0;
  #snapshot: ThreadSnapshot | undefined;

  newThreadId(): ThreadId {
    return THREAD_ID;
  }

  newOpId(): ExternalOpId {
    this.#opOrdinal++;
    return `op_e_${this.#opOrdinal.toString(16).padStart(32, '0')}` as ExternalOpId;
  }

  async submit(op: RuntimeOp): Promise<OpReceipt> {
    this.ops.push(op);
    if (op.type === 'thread_create') {
      this.#push({
        type: 'thread_created',
        thread: { threadId: THREAD_ID, createdAt: 1, state: 'idle' },
      }, op.opId);
      this.#push({ type: 'op_completed', opType: op.type, outcome: 'applied' }, op.opId);
      this.#snapshot = {
        thread: { threadId: THREAD_ID, createdAt: 1, state: 'idle' },
        model: MODEL.ref,
        transcript: [],
        usage: { cumulative: { input: 0, output: 0 }, turns: 0, contextTokens: 0 },
        queues: { steering: [], followUp: [] },
        plan: [],
        pendingControls: [],
        highWaterSeq: this.#seq,
      };
      return { accepted: true, opId: op.opId, duplicate: false, threadId: THREAD_ID };
    }
    if (op.type === 'prompt') {
      return {
        accepted: false,
        opId: op.opId,
        duplicate: false,
        reason: 'thread_busy_use_steer_or_follow_up',
        threadId: THREAD_ID,
      };
    }
    return { accepted: true, opId: op.opId, duplicate: false, threadId: THREAD_ID };
  }

  events(): AsyncIterable<Readonly<EventEnvelope>> {
    return this.#events;
  }

  async getThreadSnapshot(): Promise<ThreadSnapshot | undefined> {
    return this.#snapshot;
  }

  async close(): Promise<void> {
    this.#events.end();
  }

  #push(event: EventEnvelope['event'], opId: ExternalOpId): void {
    this.#seq++;
    this.#events.push({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      opId,
      seq: this.#seq,
      timestamp: this.#seq,
      event,
    });
  }
}

class CapturingOutput {
  readonly frames: Record<string, unknown>[] = [];
  readonly #waiters: Array<{
    readonly predicate: (frame: Record<string, unknown>) => boolean;
    readonly resolve: (frame: Record<string, unknown>) => void;
  }> = [];

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

class AsyncQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<(result: IteratorResult<T>) => void> = [];
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
