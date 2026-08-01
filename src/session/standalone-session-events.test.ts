import { describe, expect, test, vi } from 'bun:test';

import { strictJsonSnapshot } from '../protocol/index.js';
import type {
  EventEnvelope,
  RunId,
  ThreadId,
  WorkspaceId,
} from '../protocol/index.js';
import type { SessionEvent } from './legacy-thread-execution.js';
import { StandaloneSessionEventHub } from './standalone-session-events.js';

describe('StandaloneSessionEventHub', () => {
  test('reads immutable canonical envelopes instead of producer-owned event objects', async () => {
    const harness = observerHarness();
    const observed: SessionEvent[] = [];
    const delivered = deferred<void>();
    harness.hub.subscribe((event) => {
      observed.push(event);
      delivered.resolve(undefined);
    });
    const event = retryEvent('original');

    harness.commit(event);
    event.errorMessage = 'mutated after commit';
    await delivered.promise;

    expect(observed).toEqual([retryEvent('original')]);
    expect(Object.isFrozen(observed[0])).toBe(true);
    harness.hub.close();
  });

  test('gives slow and rejecting listeners independent durable cursor delivery', async () => {
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const harness = observerHarness();
    const slowGate = deferred<void>();
    const slowEntered = deferred<void>();
    const slowDone = deferred<void>();
    const fastDone = deferred<void>();
    const slow: string[] = [];
    const fast: string[] = [];
    let first = true;
    harness.hub.subscribe(async (event) => {
      if (event.type !== 'retry_scheduled') return;
      slow.push(event.errorMessage);
      if (first) {
        first = false;
        slowEntered.resolve(undefined);
        await slowGate.promise;
        throw new Error('slow listener rejected');
      }
      if (slow.length === 4) slowDone.resolve(undefined);
    });
    harness.hub.subscribe((event) => {
      if (event.type !== 'retry_scheduled') return;
      fast.push(event.errorMessage);
      if (fast.length === 4) fastDone.resolve(undefined);
    });

    harness.commit(retryEvent('one'));
    harness.commit(retryEvent('two'));
    harness.commit(retryEvent('three'));
    harness.commit(retryEvent('four'));
    await slowEntered.promise;
    await fastDone.promise;
    expect(slow).toEqual(['one']);
    expect(fast).toEqual(['one', 'two', 'three', 'four']);

    slowGate.resolve(undefined);
    await slowDone.promise;
    expect(slow).toEqual(['one', 'two', 'three', 'four']);
    expect(diagnostic).toHaveBeenCalledTimes(1);
    harness.hub.close();
  });

  test('keeps only a seq cursor while a blocked listener catches up from canonical history', async () => {
    const harness = observerHarness();
    const gate = deferred<void>();
    const entered = deferred<void>();
    const done = deferred<void>();
    let delivered = 0;
    harness.hub.subscribe(async (event) => {
      if (event.type !== 'retry_scheduled') return;
      delivered++;
      if (delivered === 1) {
        entered.resolve(undefined);
        await gate.promise;
      }
      if (delivered === 1_000) done.resolve(undefined);
    });

    harness.commit(retryEvent('0'));
    await entered.promise;
    for (let index = 1; index < 1_000; index++) harness.commit(retryEvent(String(index)));
    expect(delivered).toBe(1);

    gate.resolve(undefined);
    await done.promise;
    expect(delivered).toBe(1_000);
    harness.hub.close();
  });

  test('does not deliver canonical events beyond the post-mirror publication boundary', async () => {
    const harness = observerHarness();
    const observed: string[] = [];
    const firstDelivered = deferred<void>();
    const secondDelivered = deferred<void>();
    const first = retryEvent('mirrored');
    const second = retryEvent('canonical-only');

    harness.commitCanonical(first);
    harness.hub.subscribe((event) => {
      if (event.type !== 'retry_scheduled') return;
      observed.push(event.errorMessage);
      if (observed.length === 1) firstDelivered.resolve(undefined);
      if (observed.length === 2) secondDelivered.resolve(undefined);
    });
    harness.commitCanonical(second);

    harness.publish(first);
    await firstDelivered.promise;
    await nextTask();
    expect(observed).toEqual(['mirrored']);

    harness.publish(second);
    await secondDelivered.promise;
    expect(observed).toEqual(['mirrored', 'canonical-only']);
    harness.hub.close();
  });

  test('unsubscribe and close discard pending delivery without waiting for an active callback', async () => {
    const unsubscribeHarness = observerHarness();
    const unsubscribeGate = deferred<void>();
    const unsubscribeEntered = deferred<void>();
    const unsubscribed: string[] = [];
    const unsubscribe = unsubscribeHarness.hub.subscribe(async (event) => {
      if (event.type !== 'retry_scheduled') return;
      unsubscribed.push(event.errorMessage);
      unsubscribeEntered.resolve(undefined);
      await unsubscribeGate.promise;
    });
    unsubscribeHarness.commit(retryEvent('active'));
    await unsubscribeEntered.promise;
    unsubscribeHarness.commit(retryEvent('pending'));
    unsubscribe();
    unsubscribeGate.resolve(undefined);
    await nextTask();
    expect(unsubscribed).toEqual(['active']);

    const closeHarness = observerHarness();
    const closeGate = deferred<void>();
    const closeEntered = deferred<void>();
    const closed: string[] = [];
    closeHarness.hub.subscribe(async (event) => {
      if (event.type !== 'retry_scheduled') return;
      closed.push(event.errorMessage);
      closeEntered.resolve(undefined);
      await closeGate.promise;
    });
    closeHarness.commit(retryEvent('active'));
    await closeEntered.promise;
    closeHarness.commit(retryEvent('pending'));
    closeHarness.hub.close();
    closeHarness.commit(retryEvent('after close'));
    closeGate.resolve(undefined);
    await nextTask();
    expect(closed).toEqual(['active']);
    expect(() => closeHarness.hub.subscribe(() => undefined)).toThrow('closed');
  });
});

function observerHarness(): {
  readonly hub: StandaloneSessionEventHub;
  readonly commit: (event: ReturnType<typeof retryEvent>) => void;
  readonly commitCanonical: (event: ReturnType<typeof retryEvent>) => void;
  readonly publish: (event: ReturnType<typeof retryEvent>) => void;
} {
  const workspaceId = 'ws_01k1observer0000000000000000' as WorkspaceId;
  const threadId = 'thread_01k1observer00000000000000' as ThreadId;
  const successorRunId = 'run_01k1observer000000000000000' as RunId;
  const predecessorRunId = 'run_01k1observerpredecessor00000' as RunId;
  const envelopes: Readonly<EventEnvelope>[] = [];
  const hub = new StandaloneSessionEventHub({ threadId, readEnvelopes: () => envelopes });
  const commitCanonical = (event: ReturnType<typeof retryEvent>): void => {
    envelopes.push(strictJsonSnapshot({
      workspaceId,
      threadId,
      runId: successorRunId,
      seq: envelopes.length + 1,
      timestamp: envelopes.length + 1,
      event: {
        ...event,
        predecessorRunId,
        successorRunId,
      },
    }) as unknown as Readonly<EventEnvelope>);
  };
  const publish = (event: ReturnType<typeof retryEvent>): void => {
    hub.publish([event]);
  };
  return {
    hub,
    commit: (event) => {
      commitCanonical(event);
      publish(event);
    },
    commitCanonical,
    publish,
  };
}

function retryEvent(errorMessage: string): {
  type: 'retry_scheduled';
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  errorMessage: string;
} {
  return {
    type: 'retry_scheduled',
    attempt: 1,
    maxAttempts: 3,
    delayMs: 0,
    errorMessage,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function nextTask(): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
}
