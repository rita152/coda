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

  test('is hot for current and future threads and does not replay a thread without a cursor', async () => {
    const stream = new EventHub();
    stream.seed(THREAD_A, [envelope(THREAD_A, 1)]);
    const current = stream.subscribe({ threadIds: [THREAD_A] })[Symbol.asyncIterator]();
    const future = stream.subscribe({ threadIds: [THREAD_B], cursors: [{ threadId: THREAD_B, afterSeq: 0 }] })
      [Symbol.asyncIterator]();

    stream.publish([envelope(THREAD_A, 2), envelope(THREAD_B, 1)]);
    expect(await nextSeq(current)).toBe(2);
    expect(await nextSeq(future)).toBe(1);
    await current.return?.();
    await future.return?.();
  });

  test('installs seed replay for an existing future cursor but not for a no-cursor subscriber', async () => {
    const stream = new EventHub({ subscriptionQueueLimit: 1 });
    const cursor = stream.subscribe({
      threadIds: [THREAD_B],
      cursors: [{ threadId: THREAD_B, afterSeq: 0 }],
    })[Symbol.asyncIterator]();
    const liveOnly = stream.subscribe({ threadIds: [THREAD_B] })[Symbol.asyncIterator]();

    stream.seed(THREAD_B, [envelope(THREAD_B, 1), envelope(THREAD_B, 2)]);
    stream.publish([envelope(THREAD_B, 3)]);
    expect(await nextSeq(cursor)).toBe(1);
    expect(await nextSeq(cursor)).toBe(2);
    expect(await nextSeq(cursor)).toBe(3);
    expect(await nextSeq(liveOnly)).toBe(3);
    await cursor.return?.();
    await liveOnly.return?.();
  });

  test('replays each cursor through its captured high-water before seamless live delivery', async () => {
    const stream = new EventHub();
    stream.seed(THREAD_A, [envelope(THREAD_A, 1), envelope(THREAD_A, 2)]);
    const iterator = stream.subscribe({
      threadIds: [THREAD_A],
      cursors: [{ threadId: THREAD_A, afterSeq: 1 }],
    })[Symbol.asyncIterator]();

    stream.publish([envelope(THREAD_A, 3)]);
    expect(await nextSeq(iterator)).toBe(2);
    expect(await nextSeq(iterator)).toBe(3);
    await iterator.return?.();
  });

  test('preserves one subscription FIFO across interleaved thread publications', async () => {
    const stream = new EventHub({ subscriptionQueueLimit: 1, historyLimit: 6 });
    const iterator = stream.subscribe()[Symbol.asyncIterator]();
    stream.publish([
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

  test('delivers cursor_ahead only from first next while unknown future afterSeq=0 remains valid', async () => {
    const stream = new EventHub();
    stream.seed(THREAD_A, [envelope(THREAD_A, 1)]);
    const iterable = stream.subscribe({ cursors: [{ threadId: THREAD_A, afterSeq: 2 }] });
    const iterator = iterable[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({
      name: 'EventCursorValidationError',
      code: 'cursor_ahead',
      threadId: THREAD_A,
    });

    const future = stream.subscribe({ cursors: [{ threadId: THREAD_B, afterSeq: 0 }] })
      [Symbol.asyncIterator]();
    stream.publish([envelope(THREAD_B, 1)]);
    expect(await nextSeq(future)).toBe(1);
    await future.return?.();
  });

  test('drains buffered events before close completes the iterator', async () => {
    const stream = new EventHub();
    const iterator = stream.subscribe({ threadIds: [THREAD_A] })[Symbol.asyncIterator]();
    stream.publish([envelope(THREAD_A, 1), envelope(THREAD_A, 2)]);
    stream.close();

    expect(await nextSeq(iterator)).toBe(1);
    expect(await nextSeq(iterator)).toBe(2);
    expect((await iterator.next()).done).toBe(true);
  });

  test('drains before a thread fatal and isolates filtered subscriptions', async () => {
    const stream = new EventHub();
    const failed = stream.subscribe({ threadIds: [THREAD_A] })[Symbol.asyncIterator]();
    const healthy = stream.subscribe({ threadIds: [THREAD_B] })[Symbol.asyncIterator]();
    stream.publish([envelope(THREAD_A, 1), envelope(THREAD_B, 1)]);
    stream.failThread(THREAD_A, 'writer_failed');

    expect(await nextSeq(failed)).toBe(1);
    await expect(failed.next()).rejects.toBeInstanceOf(RuntimeEventStreamError);
    expect(await nextSeq(healthy)).toBe(1);
    stream.publish([envelope(THREAD_B, 2)]);
    expect(await nextSeq(healthy)).toBe(2);
    await healthy.return?.();
  });

  test('signal abort drains, ends normally, and removes its listener', async () => {
    const stream = new EventHub();
    const controller = new AbortController();
    const add = spyOn(controller.signal, 'addEventListener');
    const remove = spyOn(controller.signal, 'removeEventListener');
    const iterator = stream.subscribe({ threadIds: [THREAD_A], signal: controller.signal })
      [Symbol.asyncIterator]();
    stream.publish([envelope(THREAD_A, 1)]);

    controller.abort();
    expect(await nextSeq(iterator)).toBe(1);
    expect((await iterator.next()).done).toBe(true);
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  test('a terminal subscriber reports a gap if later traffic evicts its recoverable backlog', async () => {
    const stream = new EventHub({ subscriptionQueueLimit: 1, historyLimit: 2 });
    const controller = new AbortController();
    const iterator = stream.subscribe({ threadIds: [THREAD_A], signal: controller.signal })
      [Symbol.asyncIterator]();
    stream.publish([envelope(THREAD_A, 1), envelope(THREAD_A, 2)]);
    controller.abort();

    stream.publish([
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
    const controller = new AbortController();
    const iterator = stream.subscribe({ threadIds: [THREAD_A], signal: controller.signal })
      [Symbol.asyncIterator]();
    stream.publish([
      envelope(THREAD_A, 1),
      envelope(THREAD_A, 2),
      envelope(THREAD_B, 1),
      envelope(THREAD_B, 2),
    ]);
    controller.abort();

    // Consuming seq 1 refills the finite queue with the last matching terminal envelope.
    expect(await nextSeq(iterator)).toBe(1);
    stream.publish([
      envelope(THREAD_B, 3),
      envelope(THREAD_B, 4),
      envelope(THREAD_B, 5),
      envelope(THREAD_B, 6),
    ]);

    expect(await nextSeq(iterator)).toBe(2);
    expect((await iterator.next()).done).toBe(true);
  });

  test('uses retained history to refill a finite subscriber queue without writer backpressure', async () => {
    const stream = new EventHub({ subscriptionQueueLimit: 2, historyLimit: 5 });
    const iterator = stream.subscribe({ threadIds: [THREAD_A] })[Symbol.asyncIterator]();
    stream.publish(Array.from({ length: 5 }, (_, index) => envelope(THREAD_A, index + 1)));
    stream.close();

    const delivered: number[] = [];
    while (true) {
      const result = await iterator.next();
      if (result.done) break;
      delivered.push(result.value.seq);
    }
    expect(delivered).toEqual([1, 2, 3, 4, 5]);
  });

  test('drains the finite queue then throws a typed gap when retained live order is lost', async () => {
    const stream = new EventHub({ subscriptionQueueLimit: 2, historyLimit: 3 });
    const iterator = stream.subscribe({ threadIds: [THREAD_A] })[Symbol.asyncIterator]();
    stream.publish(Array.from({ length: 6 }, (_, index) => envelope(THREAD_A, index + 1)));

    expect(await nextSeq(iterator)).toBe(1);
    expect(await nextSeq(iterator)).toBe(2);
    await expect(iterator.next()).rejects.toMatchObject({
      name: 'EventSubscriptionGapError',
      code: 'event_subscription_gap',
      threadId: THREAD_A,
      lastDeliveredSeq: 2,
    });
  });

  test('reports a cursor older than retained history before emitting replay', async () => {
    const stream = new EventHub({ historyLimit: 2 });
    stream.seed(THREAD_A, Array.from({ length: 5 }, (_, index) => envelope(THREAD_A, index + 1)));
    const iterator = stream.subscribe({ cursors: [{ threadId: THREAD_A, afterSeq: 1 }] })
      [Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toEqual(expect.objectContaining({
      name: 'EventSubscriptionGapError',
      threadId: THREAD_A,
      lastDeliveredSeq: 1,
      nextAvailableSeq: 4,
    }));
  });

  test('rejects concurrent next explicitly without consuming the pending read', async () => {
    const stream = new EventHub();
    const iterator = stream.subscribe({ threadIds: [THREAD_A] })[Symbol.asyncIterator]();
    const first = iterator.next();
    await expect(iterator.next()).rejects.toThrow('Concurrent next() calls are not supported');
    stream.publish([envelope(THREAD_A, 1)]);
    expect((await first).value?.seq).toBe(1);
    await iterator.return?.();
  });

  test('validates an entire seed or publish batch before mutating history or subscriptions', async () => {
    const stream = new EventHub();
    stream.seed(THREAD_A, [envelope(THREAD_A, 1)]);
    expect(() => stream.seed(THREAD_A, [envelope(THREAD_A, 1), envelope(THREAD_A, 3)]))
      .toThrow(RuntimeEventStreamError);
    expect(stream.history(THREAD_A).map((item) => item.seq)).toEqual([1]);

    const iterator = stream.subscribe({ threadIds: [THREAD_B] })[Symbol.asyncIterator]();
    expect(() => stream.publish([envelope(THREAD_B, 1), envelope(THREAD_B, 3)]))
      .toThrow(RuntimeEventStreamError);
    expect(stream.history(THREAD_B)).toEqual([]);
    stream.publish([envelope(THREAD_B, 1)]);
    expect(await nextSeq(iterator)).toBe(1);
    await iterator.return?.();
  });

  test('validates register/empty-seed thread identity and rejects destructive reseed', () => {
    const stream = new EventHub();
    const invalidThread = '' as ThreadId;
    expect(() => stream.registerThread(invalidThread)).toThrow(RuntimeEventStreamError);
    expect(() => stream.seed(invalidThread, [])).toThrow(RuntimeEventStreamError);

    stream.seed(THREAD_A, [envelope(THREAD_A, 1)]);
    expect(() => stream.seed(THREAD_A, [envelope(THREAD_A, 1), envelope(THREAD_A, 2)]))
      .toThrow(RuntimeEventStreamError);
    expect(stream.history(THREAD_A).map((item) => item.seq)).toEqual([1]);
  });

  test('exposes the documented typed gap class', () => {
    expect(new EventSubscriptionGapError(THREAD_A, 1)).toMatchObject({
      code: 'event_subscription_gap',
      threadId: THREAD_A,
      lastDeliveredSeq: 1,
    });
  });
});
