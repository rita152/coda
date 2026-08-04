import { describe, expect, spyOn, test } from 'bun:test';

import {
  assertThreadId,
  assertWorkspaceId,
} from '../protocol/identity.js';
import type { EventEnvelope, ThreadId } from '../protocol/index.js';
import {
  EventCursorValidationError,
  EventSubscriptionGapError,
  RuntimeEventStreamError,
} from './event-errors.js';
import { EventHub } from './event-hub.js';

const WORKSPACE = assertWorkspaceId('workspace');
const THREAD_A = assertThreadId('thread-A');
const THREAD_B = assertThreadId('thread-B');

interface DurableThread {
  readonly envelopes: EventEnvelope[];
  replayStartSeq: number;
}

interface RegisterOptions {
  readonly replayStartSeq?: number;
  readonly beforeReplay?: () => Promise<void>;
  readonly onReplay?: (afterSeq: number, throughSeq: number) => void;
}

function envelope(threadId: ThreadId, seq: number): EventEnvelope {
  return {
    workspaceId: WORKSPACE,
    threadId,
    seq,
    timestamp: seq,
    event: {
      type: 'runtime_diagnostic',
      severity: 'warning',
      code: `event-${seq}`,
      message: '',
      scope: 'thread',
    },
  };
}

function registerThread(
  stream: EventHub,
  threadId: ThreadId,
  initial: readonly EventEnvelope[] = [],
  options: RegisterOptions = {},
): DurableThread {
  const highWaterSeq = initial.at(-1)?.seq ?? 0;
  const durable: DurableThread = {
    envelopes: [...initial],
    replayStartSeq: options.replayStartSeq ?? initial[0]?.seq ?? highWaterSeq + 1,
  };
  stream.registerThread(threadId, {
    highWaterSeq,
    replayStartSeq: durable.replayStartSeq,
    replay: async (afterSeq, throughSeq) => {
      options.onReplay?.(afterSeq, throughSeq);
      await options.beforeReplay?.();
      return durable.envelopes.filter((item) =>
        item.seq >= durable.replayStartSeq && item.seq > afterSeq && item.seq <= throughSeq);
    },
  });
  return durable;
}

function publishDurable(
  stream: EventHub,
  durable: ReadonlyMap<ThreadId, DurableThread>,
  envelopes: readonly EventEnvelope[],
): void {
  const changed = new Set<ThreadId>();
  for (const item of envelopes) {
    const thread = durable.get(item.threadId);
    if (thread === undefined) throw new Error(`Missing durable test thread ${item.threadId}`);
    thread.envelopes.push(item);
    changed.add(item.threadId);
  }
  for (const threadId of changed) {
    const thread = durable.get(threadId) as DurableThread;
    stream.updateDurableReplayRange(threadId, {
      highWaterSeq: thread.envelopes.at(-1)?.seq ?? 0,
      replayStartSeq: thread.replayStartSeq,
    });
  }
  stream.publish(envelopes);
}

async function nextSeq(iterator: AsyncIterator<Readonly<EventEnvelope>>): Promise<number> {
  const result = await iterator.next();
  expect(result.done).toBe(false);
  return result.value?.seq as number;
}

function expectCursorError(operation: () => unknown, code: EventCursorValidationError['code']): void {
  try {
    operation();
    throw new Error('Expected EventCursorValidationError');
  } catch (error) {
    expect(error).toBeInstanceOf(EventCursorValidationError);
    if (!(error instanceof EventCursorValidationError)) throw error;
    expect(error.code).toBe(code);
  }
}

describe('EventHub', () => {
  test('validates the complete option syntax synchronously', () => {
    const stream = new EventHub();
    const invalidThread = '' as ThreadId;

    expectCursorError(() => stream.subscribe({ threadIds: [] }), 'empty_thread_filter');
    expectCursorError(() => stream.subscribe({ threadIds: [invalidThread] }), 'invalid_thread_id');
    expectCursorError(
      () => stream.subscribe({ threadIds: [THREAD_A, THREAD_A] }),
      'duplicate_thread_filter',
    );
    expectCursorError(
      () => stream.subscribe({ cursors: [
        { threadId: THREAD_A, afterSeq: 0 },
        { threadId: THREAD_A, afterSeq: 0 },
      ] }),
      'duplicate_cursor',
    );
    expectCursorError(
      () => stream.subscribe({ threadIds: [THREAD_A], cursors: [{ threadId: THREAD_B, afterSeq: 0 }] }),
      'cursor_outside_filter',
    );
    for (const afterSeq of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expectCursorError(
        () => stream.subscribe({ cursors: [{ threadId: THREAD_A, afterSeq }] }),
        'invalid_after_seq',
      );
    }
  });

  test('requires complete registration and a durable range before publication', async () => {
    const stream = new EventHub();
    const invalidThread = '' as ThreadId;
    const emptyRegistration = { highWaterSeq: 0, replayStartSeq: 1, replay: async () => [] };
    expect(() => stream.registerThread(invalidThread, emptyRegistration)).toThrow(RuntimeEventStreamError);
    expect(() => stream.registerThread(THREAD_A, undefined as never)).toThrow(TypeError);
    expect(() => stream.publish([envelope(THREAD_A, 1)])).toThrow(RuntimeEventStreamError);

    const durable = registerThread(stream, THREAD_A);
    expect(() => stream.publish([envelope(THREAD_A, 1)])).toThrow(
      expect.objectContaining({ causeCode: 'publish_before_durable_replay_range' }),
    );
    const iterator = stream.subscribe({ threadIds: [THREAD_A] })[Symbol.asyncIterator]();
    publishDurable(stream, new Map([[THREAD_A, durable]]), [envelope(THREAD_A, 1)]);
    expect(await nextSeq(iterator)).toBe(1);
    expect(() => stream.registerThread(THREAD_A, emptyRegistration)).toThrow(RuntimeEventStreamError);
    await iterator.return?.();
  });

  test('is hot for current and future threads and does not replay without a cursor', async () => {
    const stream = new EventHub();
    const a = registerThread(stream, THREAD_A, [envelope(THREAD_A, 1)]);
    const current = stream.subscribe({ threadIds: [THREAD_A] })[Symbol.asyncIterator]();
    const future = stream.subscribe({ threadIds: [THREAD_B], cursors: [{ threadId: THREAD_B, afterSeq: 0 }] })
      [Symbol.asyncIterator]();
    const b = registerThread(stream, THREAD_B);

    publishDurable(stream, new Map([[THREAD_A, a], [THREAD_B, b]]), [
      envelope(THREAD_A, 2),
      envelope(THREAD_B, 1),
    ]);
    expect(await nextSeq(current)).toBe(2);
    expect(await nextSeq(future)).toBe(1);
    await current.return?.();
    await future.return?.();
  });

  test('installs storage replay for an existing future cursor but not a live-only subscriber', async () => {
    const stream = new EventHub({ subscriptionQueueLimit: 1 });
    const cursor = stream.subscribe({
      threadIds: [THREAD_B],
      cursors: [{ threadId: THREAD_B, afterSeq: 0 }],
    })[Symbol.asyncIterator]();
    const liveOnly = stream.subscribe({ threadIds: [THREAD_B] })[Symbol.asyncIterator]();
    const durable = registerThread(stream, THREAD_B, [envelope(THREAD_B, 1), envelope(THREAD_B, 2)]);

    publishDurable(stream, new Map([[THREAD_B, durable]]), [envelope(THREAD_B, 3)]);
    expect(await nextSeq(cursor)).toBe(1);
    expect(await nextSeq(cursor)).toBe(2);
    expect(await nextSeq(cursor)).toBe(3);
    expect(await nextSeq(liveOnly)).toBe(3);
    await cursor.return?.();
    await liveOnly.return?.();
  });

  test('continues into a future cursor replay installed while another replay is loading', async () => {
    const stream = new EventHub();
    let markAEntered!: () => void;
    let releaseA!: () => void;
    let markBEntered!: () => void;
    let releaseB!: () => void;
    const aEntered = new Promise<void>((resolve) => { markAEntered = resolve; });
    const aGate = new Promise<void>((resolve) => { releaseA = resolve; });
    const bEntered = new Promise<void>((resolve) => { markBEntered = resolve; });
    const bGate = new Promise<void>((resolve) => { releaseB = resolve; });
    registerThread(stream, THREAD_A, [envelope(THREAD_A, 1)], {
      beforeReplay: async () => {
        markAEntered();
        await aGate;
      },
    });
    const iterator = stream.subscribe({
      cursors: [
        { threadId: THREAD_A, afterSeq: 0 },
        { threadId: THREAD_B, afterSeq: 0 },
      ],
    })[Symbol.asyncIterator]();
    const first = iterator.next();
    await aEntered;

    registerThread(stream, THREAD_B, [envelope(THREAD_B, 1)], {
      beforeReplay: async () => {
        markBEntered();
        await bGate;
      },
    });
    releaseA();
    await bEntered;
    releaseB();

    expect((await first).value).toEqual(envelope(THREAD_B, 1));
    expect((await iterator.next()).value).toEqual(envelope(THREAD_A, 1));
    await iterator.return?.();
  });

  test('hands storage replay off exactly once to concurrent live events', async () => {
    const stream = new EventHub({ subscriptionQueueLimit: 1, historyLimit: 2 });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const replayCalls: Array<readonly [number, number]> = [];
    const durable = registerThread(
      stream,
      THREAD_A,
      [envelope(THREAD_A, 1), envelope(THREAD_A, 2), envelope(THREAD_A, 3)],
      {
        replayStartSeq: 2,
        beforeReplay: () => gate,
        onReplay: (afterSeq, throughSeq) => replayCalls.push([afterSeq, throughSeq]),
      },
    );
    const iterator = stream.subscribe({
      threadIds: [THREAD_A],
      cursors: [{ threadId: THREAD_A, afterSeq: 1 }],
    })[Symbol.asyncIterator]();
    const first = iterator.next();

    publishDurable(stream, new Map([[THREAD_A, durable]]), [envelope(THREAD_A, 4)]);
    release?.();
    expect((await first).value?.seq).toBe(2);
    expect(await nextSeq(iterator)).toBe(3);
    expect(await nextSeq(iterator)).toBe(4);
    expect(replayCalls).toEqual([[1, 3]]);
    await iterator.return?.();
  });

  test('replays durable live growth after it leaves the global live window', async () => {
    const stream = new EventHub({ historyLimit: 2 });
    const replayCalls: Array<readonly [number, number]> = [];
    const durable = registerThread(stream, THREAD_A, [envelope(THREAD_A, 1)], {
      onReplay: (afterSeq, throughSeq) => replayCalls.push([afterSeq, throughSeq]),
    });
    const threads = new Map([[THREAD_A, durable]]);
    for (let seq = 2; seq <= 6; seq++) publishDurable(stream, threads, [envelope(THREAD_A, seq)]);

    const iterator = stream.subscribe({
      threadIds: [THREAD_A],
      cursors: [{ threadId: THREAD_A, afterSeq: 1 }],
    })[Symbol.asyncIterator]();
    for (let seq = 2; seq <= 6; seq++) expect(await nextSeq(iterator)).toBe(seq);
    expect(replayCalls).toEqual([[1, 6]]);
    await iterator.return?.();
  });

  test('preserves subscription FIFO across interleaved thread publications', async () => {
    const stream = new EventHub({ subscriptionQueueLimit: 1, historyLimit: 6 });
    const a = registerThread(stream, THREAD_A);
    const b = registerThread(stream, THREAD_B);
    const iterator = stream.subscribe()[Symbol.asyncIterator]();
    publishDurable(stream, new Map([[THREAD_A, a], [THREAD_B, b]]), [
      envelope(THREAD_A, 1),
      envelope(THREAD_B, 1),
      envelope(THREAD_A, 2),
      envelope(THREAD_B, 2),
    ]);

    const delivered: string[] = [];
    for (let index = 0; index < 4; index++) {
      const result = await iterator.next();
      if (!result.done) delivered.push(`${result.value.threadId}:${result.value.seq}`);
    }
    expect(delivered).toEqual([
      `${THREAD_A}:1`,
      `${THREAD_B}:1`,
      `${THREAD_A}:2`,
      `${THREAD_B}:2`,
    ]);
    await iterator.return?.();
  });

  test('delivers cursor_ahead on first next while an unknown future cursor at zero remains valid', async () => {
    const stream = new EventHub();
    registerThread(stream, THREAD_A, [envelope(THREAD_A, 1)]);
    const iterator = stream.subscribe({ cursors: [{ threadId: THREAD_A, afterSeq: 2 }] })
      [Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({
      name: 'EventCursorValidationError',
      code: 'cursor_ahead',
      threadId: THREAD_A,
    });

    const future = stream.subscribe({ cursors: [{ threadId: THREAD_B, afterSeq: 0 }] })
      [Symbol.asyncIterator]();
    const b = registerThread(stream, THREAD_B);
    publishDurable(stream, new Map([[THREAD_B, b]]), [envelope(THREAD_B, 1)]);
    expect(await nextSeq(future)).toBe(1);
    await future.return?.();
  });

  test('drains buffered events before close completes the iterator', async () => {
    const stream = new EventHub();
    const a = registerThread(stream, THREAD_A);
    const iterator = stream.subscribe({ threadIds: [THREAD_A] })[Symbol.asyncIterator]();
    publishDurable(stream, new Map([[THREAD_A, a]]), [envelope(THREAD_A, 1), envelope(THREAD_A, 2)]);
    stream.close();

    expect(await nextSeq(iterator)).toBe(1);
    expect(await nextSeq(iterator)).toBe(2);
    expect((await iterator.next()).done).toBe(true);
  });

  test('drains before a thread fatal and isolates filtered subscriptions', async () => {
    const stream = new EventHub();
    const a = registerThread(stream, THREAD_A);
    const b = registerThread(stream, THREAD_B);
    const failed = stream.subscribe({ threadIds: [THREAD_A] })[Symbol.asyncIterator]();
    const healthy = stream.subscribe({ threadIds: [THREAD_B] })[Symbol.asyncIterator]();
    const threads = new Map([[THREAD_A, a], [THREAD_B, b]]);
    publishDurable(stream, threads, [envelope(THREAD_A, 1), envelope(THREAD_B, 1)]);
    stream.failThread(THREAD_A, 'writer_failed');

    expect(await nextSeq(failed)).toBe(1);
    await expect(failed.next()).rejects.toBeInstanceOf(RuntimeEventStreamError);
    expect(await nextSeq(healthy)).toBe(1);
    publishDurable(stream, threads, [envelope(THREAD_B, 2)]);
    expect(await nextSeq(healthy)).toBe(2);
    await healthy.return?.();
  });

  test('signal abort drains, ends normally, and removes its listener', async () => {
    const stream = new EventHub();
    const a = registerThread(stream, THREAD_A);
    const controller = new AbortController();
    const add = spyOn(controller.signal, 'addEventListener');
    const remove = spyOn(controller.signal, 'removeEventListener');
    const iterator = stream.subscribe({ threadIds: [THREAD_A], signal: controller.signal })
      [Symbol.asyncIterator]();
    publishDurable(stream, new Map([[THREAD_A, a]]), [envelope(THREAD_A, 1)]);

    controller.abort();
    expect(await nextSeq(iterator)).toBe(1);
    expect((await iterator.next()).done).toBe(true);
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  test('reports a terminal gap when later traffic evicts a matching backlog', async () => {
    const stream = new EventHub({ subscriptionQueueLimit: 1, historyLimit: 2 });
    const a = registerThread(stream, THREAD_A);
    const b = registerThread(stream, THREAD_B);
    const threads = new Map([[THREAD_A, a], [THREAD_B, b]]);
    const controller = new AbortController();
    const iterator = stream.subscribe({ threadIds: [THREAD_A], signal: controller.signal })
      [Symbol.asyncIterator]();
    publishDurable(stream, threads, [envelope(THREAD_A, 1), envelope(THREAD_A, 2)]);
    controller.abort();

    publishDurable(stream, threads, [
      envelope(THREAD_B, 1),
      envelope(THREAD_B, 2),
      envelope(THREAD_B, 3),
    ]);
    expect(await nextSeq(iterator)).toBe(1);
    await expect(iterator.next()).rejects.toMatchObject({
      name: 'EventSubscriptionGapError',
      threadId: THREAD_A,
      lastDeliveredSeq: 1,
    });
  });

  test('does not report a terminal gap when only filtered-out live order is evicted', async () => {
    const stream = new EventHub({ subscriptionQueueLimit: 1, historyLimit: 4 });
    const a = registerThread(stream, THREAD_A);
    const b = registerThread(stream, THREAD_B);
    const threads = new Map([[THREAD_A, a], [THREAD_B, b]]);
    const controller = new AbortController();
    const iterator = stream.subscribe({ threadIds: [THREAD_A], signal: controller.signal })
      [Symbol.asyncIterator]();
    publishDurable(stream, threads, [
      envelope(THREAD_A, 1),
      envelope(THREAD_A, 2),
      envelope(THREAD_B, 1),
      envelope(THREAD_B, 2),
    ]);
    controller.abort();

    expect(await nextSeq(iterator)).toBe(1);
    publishDurable(stream, threads, [
      envelope(THREAD_B, 3),
      envelope(THREAD_B, 4),
      envelope(THREAD_B, 5),
      envelope(THREAD_B, 6),
    ]);

    expect(await nextSeq(iterator)).toBe(2);
    expect((await iterator.next()).done).toBe(true);
  });

  test('uses the global live queue without backpressuring a slow observer', async () => {
    const stream = new EventHub({ subscriptionQueueLimit: 2, historyLimit: 5 });
    const a = registerThread(stream, THREAD_A);
    const iterator = stream.subscribe({ threadIds: [THREAD_A] })[Symbol.asyncIterator]();
    publishDurable(
      stream,
      new Map([[THREAD_A, a]]),
      Array.from({ length: 5 }, (_, index) => envelope(THREAD_A, index + 1)),
    );
    stream.close();

    const delivered: number[] = [];
    while (true) {
      const result = await iterator.next();
      if (result.done) break;
      delivered.push(result.value.seq);
    }
    expect(delivered).toEqual([1, 2, 3, 4, 5]);
  });

  test('drains the finite queue then throws a structured gap when live order is lost', async () => {
    const stream = new EventHub({ subscriptionQueueLimit: 2, historyLimit: 3 });
    const a = registerThread(stream, THREAD_A);
    const iterator = stream.subscribe({ threadIds: [THREAD_A] })[Symbol.asyncIterator]();
    publishDurable(
      stream,
      new Map([[THREAD_A, a]]),
      Array.from({ length: 6 }, (_, index) => envelope(THREAD_A, index + 1)),
    );

    expect(await nextSeq(iterator)).toBe(1);
    expect(await nextSeq(iterator)).toBe(2);
    await expect(iterator.next()).rejects.toMatchObject({
      name: 'EventSubscriptionGapError',
      code: 'event_subscription_gap',
      threadId: THREAD_A,
      lastDeliveredSeq: 2,
    });
  });

  test('reports a cursor older than the storage replay window', async () => {
    const stream = new EventHub({ historyLimit: 2 });
    registerThread(
      stream,
      THREAD_A,
      Array.from({ length: 5 }, (_, index) => envelope(THREAD_A, index + 1)),
      { replayStartSeq: 4 },
    );
    const iterator = stream.subscribe({ cursors: [{ threadId: THREAD_A, afterSeq: 1 }] })
      [Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toEqual(expect.objectContaining({
      name: 'EventSubscriptionGapError',
      threadId: THREAD_A,
      lastDeliveredSeq: 1,
      nextAvailableSeq: 4,
    }));
  });

  test('rejects concurrent next without consuming the pending read', async () => {
    const stream = new EventHub();
    const a = registerThread(stream, THREAD_A);
    const iterator = stream.subscribe({ threadIds: [THREAD_A] })[Symbol.asyncIterator]();
    const first = iterator.next();
    await expect(iterator.next()).rejects.toThrow('Concurrent next() calls are not supported');
    publishDurable(stream, new Map([[THREAD_A, a]]), [envelope(THREAD_A, 1)]);
    expect((await first).value?.seq).toBe(1);
    await iterator.return?.();
  });

  test('validates a complete publish batch before mutating live state', async () => {
    const stream = new EventHub();
    const a = registerThread(stream, THREAD_A);
    a.envelopes.push(envelope(THREAD_A, 1), envelope(THREAD_A, 3));
    stream.updateDurableReplayRange(THREAD_A, { highWaterSeq: 3, replayStartSeq: 1 });
    const iterator = stream.subscribe({ threadIds: [THREAD_A] })[Symbol.asyncIterator]();
    expect(() => stream.publish([envelope(THREAD_A, 1), envelope(THREAD_A, 3)]))
      .toThrow(RuntimeEventStreamError);

    stream.publish([envelope(THREAD_A, 1)]);
    expect(await nextSeq(iterator)).toBe(1);
    await iterator.return?.();
  });

  test('exposes the documented typed gap class', () => {
    expect(new EventSubscriptionGapError(THREAD_A, 1)).toMatchObject({
      code: 'event_subscription_gap',
      threadId: THREAD_A,
      lastDeliveredSeq: 1,
    });
  });
});
