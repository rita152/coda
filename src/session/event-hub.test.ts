import { describe, expect, test } from 'bun:test';

import { assertThreadId, assertWorkspaceId } from '../protocol/index.js';
import type { EventEnvelope, ThreadId } from '../protocol/index.js';
import { EventSubscriptionGapError, RuntimeEventStreamError } from './event-errors.js';
import { EventHub } from './event-hub.js';

const WORKSPACE = assertWorkspaceId('workspace-event-hub');
const THREAD_A = assertThreadId('thread-event-hub-A');
const THREAD_B = assertThreadId('thread-event-hub-B');

describe('EventHub', () => {
  test('a cursor registered before a future thread receives seed replay then live events', async () => {
    const hub = new EventHub();
    const observer = hub.subscribe({
      threadIds: [THREAD_B],
      cursors: [{ threadId: THREAD_B, afterSeq: 0 }],
    })[Symbol.asyncIterator]();

    hub.seed(THREAD_B, [envelope(THREAD_B, 1), envelope(THREAD_B, 2)]);
    hub.publish([envelope(THREAD_B, 3)]);

    expect(await nextSeq(observer)).toBe(1);
    expect(await nextSeq(observer)).toBe(2);
    expect(await nextSeq(observer)).toBe(3);
    await observer.return?.();
  });

  test('cursor retention loss is explicit and never silently skips an envelope', async () => {
    const hub = new EventHub({ historyLimit: 2 });
    hub.seed(THREAD_A, [
      envelope(THREAD_A, 1),
      envelope(THREAD_A, 2),
      envelope(THREAD_A, 3),
    ]);
    const observer = hub.subscribe({ cursors: [{ threadId: THREAD_A, afterSeq: 0 }] })
      [Symbol.asyncIterator]();

    await expect(observer.next()).rejects.toBeInstanceOf(EventSubscriptionGapError);
  });

  test('thread-fatal drains that thread and leaves excluded/future threads live', async () => {
    const hub = new EventHub();
    const failed = hub.subscribe({ threadIds: [THREAD_A] })[Symbol.asyncIterator]();
    const healthy = hub.subscribe({ threadIds: [THREAD_B] })[Symbol.asyncIterator]();
    hub.publish([envelope(THREAD_A, 1)]);
    hub.failThread(THREAD_A, 'writer_failed');

    expect(await nextSeq(failed)).toBe(1);
    await expect(failed.next()).rejects.toBeInstanceOf(RuntimeEventStreamError);
    hub.publish([envelope(THREAD_B, 1)]);
    expect(await nextSeq(healthy)).toBe(1);
    await healthy.return?.();
  });
});

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
