// Workspace-owned asynchronous observer channel. It routes already-committed envelopes through
// bounded, per-subscriber queues and never participates in authoritative persistence or seq allocation.

import {
  isThreadId,
  validateEventEnvelope,
} from '../protocol/index.js';
import type { EventEnvelope, ThreadId } from '../protocol/index.js';
import {
  EventCursorValidationError,
  EventSubscriptionGapError,
  RuntimeEventStreamError,
} from './event-errors.js';

export interface EventSubscriptionOptions {
  readonly threadIds?: readonly ThreadId[];
  readonly cursors?: readonly { readonly threadId: ThreadId; readonly afterSeq: number }[];
  readonly signal?: AbortSignal;
}

export interface EventHubOptions {
  readonly subscriptionQueueLimit?: number;
  readonly historyLimit?: number;
}

export interface EventThreadRegistration {
  readonly highWaterSeq: number;
  readonly replayStartSeq: number;
  readonly replay: (afterSeq: number, throughSeq: number) => Promise<readonly EventEnvelope[]>;
}

interface ThreadHistory {
  readonly envelopes: Readonly<EventEnvelope>[];
  highWaterSeq: number;
  storageHighWaterSeq: number;
  storageReplayStartSeq: number;
  replay?: EventThreadRegistration['replay'];
}

interface OrderedEnvelope {
  readonly order: number;
  readonly envelope: Readonly<EventEnvelope>;
}

interface ReplayCursor {
  readonly threadId: ThreadId;
  nextSeq: number;
  readonly throughSeq: number;
  firstPreparedSeq?: number;
  prepared?: readonly Readonly<EventEnvelope>[];
  loading?: Promise<void>;
}

interface GapMarker {
  readonly threadId: ThreadId;
  readonly nextAvailableSeq?: number;
}

type SubscriptionTerminal =
  | { readonly kind: 'done'; readonly liveBoundary: number }
  | { readonly kind: 'error'; readonly liveBoundary: number; readonly error: Error }
  | { readonly kind: 'gap'; readonly liveBoundary: number; readonly gap: GapMarker };

interface Subscription {
  readonly filter?: ReadonlySet<ThreadId>;
  readonly cursorAfterSeq: ReadonlyMap<ThreadId, number>;
  readonly queue: Readonly<EventEnvelope>[];
  readonly replay: ReplayCursor[];
  replayIndex: number;
  nextLiveOrder: number;
  readonly lastDeliveredSeq: Map<ThreadId, number>;
  pendingHint?: GapMarker;
  terminal?: SubscriptionTerminal;
  terminalConsumed: boolean;
  nextPending: boolean;
  waiter?: () => void;
  cleanupSignal?: () => void;
}

const DEFAULT_SUBSCRIPTION_QUEUE_LIMIT = 256;
const DEFAULT_HISTORY_LIMIT = 4_096;

export class EventHub {
  readonly #histories = new Map<ThreadId, ThreadHistory>();
  readonly #knownThreads = new Set<ThreadId>();
  readonly #subscriptions = new Set<Subscription>();
  readonly #liveHistory: OrderedEnvelope[] = [];
  readonly #queueLimit: number;
  readonly #historyLimit: number;
  #nextLiveOrder = 1;
  #closed = false;

  constructor(options: EventHubOptions = {}) {
    this.#queueLimit = positiveLimit(
      options.subscriptionQueueLimit ?? DEFAULT_SUBSCRIPTION_QUEUE_LIMIT,
      'subscriptionQueueLimit',
    );
    this.#historyLimit = positiveLimit(options.historyLimit ?? DEFAULT_HISTORY_LIMIT, 'historyLimit');
  }

  registerThread(threadId: ThreadId, registration?: EventThreadRegistration): void {
    assertStreamThreadId(threadId);
    if (registration !== undefined) validateRegistration(registration);
    this.#knownThreads.add(threadId);
    const existing = this.#histories.get(threadId);
    if (existing === undefined) {
      this.#histories.set(threadId, {
        envelopes: [],
        highWaterSeq: registration?.highWaterSeq ?? 0,
        storageHighWaterSeq: registration?.highWaterSeq ?? 0,
        storageReplayStartSeq: registration?.replayStartSeq ?? 1,
        ...(registration !== undefined && { replay: registration.replay }),
      });
    } else if (registration !== undefined) {
      if (existing.highWaterSeq !== 0 || existing.envelopes.length > 0 || existing.replay !== undefined) {
        throw new RuntimeEventStreamError('history_already_initialized', threadId);
      }
      existing.highWaterSeq = registration.highWaterSeq;
      existing.storageHighWaterSeq = registration.highWaterSeq;
      existing.storageReplayStartSeq = registration.replayStartSeq;
      existing.replay = registration.replay;
      for (const subscription of this.#subscriptions) {
        const afterSeq = subscription.cursorAfterSeq.get(threadId);
        if (afterSeq === undefined) continue;
        this.#installReplay(subscription, threadId, afterSeq, registration.highWaterSeq);
      }
    }
    for (const subscription of this.#subscriptions) this.#wake(subscription);
  }

  /**
   * Advances the range that the registered storage loader can serve after a durable live commit.
   * The writer calls this only after publish has installed the same high-water in memory.
   */
  updateDurableReplayRange(
    threadId: ThreadId,
    range: Readonly<Pick<EventThreadRegistration, 'highWaterSeq' | 'replayStartSeq'>>,
  ): void {
    assertStreamThreadId(threadId);
    const history = this.#histories.get(threadId);
    if (history === undefined) throw new RuntimeEventStreamError('unknown_thread', threadId);
    if (history.replay === undefined) return;
    if (!Number.isSafeInteger(range.highWaterSeq) || range.highWaterSeq < history.storageHighWaterSeq
      || range.highWaterSeq > history.highWaterSeq
      || !Number.isSafeInteger(range.replayStartSeq)
      || range.replayStartSeq < history.storageReplayStartSeq
      || range.replayStartSeq > range.highWaterSeq + 1) {
      throw new RuntimeEventStreamError('invalid_storage_replay_range', threadId);
    }
    history.storageHighWaterSeq = range.highWaterSeq;
    history.storageReplayStartSeq = range.replayStartSeq;
  }

  seed(threadId: ThreadId, envelopes: readonly EventEnvelope[]): void {
    assertStreamThreadId(threadId);
    if (this.#closed) throw new RuntimeEventStreamError('seed_after_close', threadId);
    const snapshots = envelopes.map((envelope) => validateEventEnvelope(envelope));
    let previous = 0;
    for (const envelope of snapshots) {
      if (envelope.threadId !== threadId || envelope.seq !== previous + 1) {
        throw new RuntimeEventStreamError('invalid_persisted_sequence', threadId);
      }
      previous = envelope.seq;
    }
    const existing = this.#histories.get(threadId);
    if (existing !== undefined && existing.highWaterSeq > 0) {
      throw new RuntimeEventStreamError('history_already_initialized', threadId);
    }

    // Validation above is deliberately complete before either known-thread or history state mutates.
    const retained = snapshots.slice(-this.#historyLimit);
    const firstRetainedSeq = retained[0]?.seq ?? previous + 1;
    this.#knownThreads.add(threadId);
    this.#histories.set(threadId, {
      envelopes: retained,
      highWaterSeq: previous,
      storageHighWaterSeq: previous,
      storageReplayStartSeq: firstRetainedSeq,
    });
    for (const subscription of [...this.#subscriptions]) {
      const afterSeq = subscription.cursorAfterSeq.get(threadId);
      if (afterSeq === undefined) continue;
      if (afterSeq < firstRetainedSeq - 1) {
        this.#setGap(subscription, threadId, firstRetainedSeq);
        continue;
      }
      if (afterSeq < previous) {
        subscription.replay.splice(subscription.replayIndex, 0, {
          threadId,
          nextSeq: afterSeq + 1,
          throughSeq: previous,
        });
        this.#fill(subscription);
        this.#wake(subscription);
      }
    }
  }

  publish(envelopes: readonly EventEnvelope[]): void {
    if (this.#closed) throw new RuntimeEventStreamError('publish_after_close');
    const snapshots = envelopes.map((envelope) => validateEventEnvelope(envelope));
    const nextByThread = new Map<ThreadId, number>();
    for (const envelope of snapshots) {
      const previous = nextByThread.get(envelope.threadId)
        ?? this.#histories.get(envelope.threadId)?.highWaterSeq
        ?? 0;
      if (envelope.seq !== previous + 1) {
        throw new RuntimeEventStreamError('non_contiguous_sequence', envelope.threadId);
      }
      nextByThread.set(envelope.threadId, envelope.seq);
    }

    // A consumer continuation cannot interleave within this synchronous loop. Offering each valid
    // member before retention trimming lets every subscriber use its finite queue first.
    for (const envelope of snapshots) {
      this.#knownThreads.add(envelope.threadId);
      let history = this.#histories.get(envelope.threadId);
      if (history === undefined) {
        history = {
          envelopes: [],
          highWaterSeq: 0,
          storageHighWaterSeq: 0,
          storageReplayStartSeq: 1,
        };
        this.#histories.set(envelope.threadId, history);
      }
      history.envelopes.push(envelope);
      history.highWaterSeq = envelope.seq;
      this.#liveHistory.push({ order: this.#nextLiveOrder++, envelope });

      for (const subscription of this.#subscriptions) {
        if (matches(subscription, envelope.threadId)
          && !subscription.lastDeliveredSeq.has(envelope.threadId)) {
          subscription.lastDeliveredSeq.set(envelope.threadId, envelope.seq - 1);
        }
        this.#fill(subscription);
      }
      this.#trimThreadHistory(history);
      this.#trimLiveHistory();
    }
    for (const subscription of this.#subscriptions) this.#wake(subscription);
  }

  subscribe(options: EventSubscriptionOptions = {}): AsyncIterable<Readonly<EventEnvelope>> {
    if (this.#closed) throw new RuntimeEventStreamError('event_stream_closed');
    const { filter, cursors } = validateOptions(options);
    const cursorByThread = new Map(cursors.map((cursor) => [cursor.threadId, cursor.afterSeq] as const));
    const subscription: Subscription = {
      ...(filter !== undefined && { filter }),
      cursorAfterSeq: cursorByThread,
      queue: [],
      replay: [],
      replayIndex: 0,
      nextLiveOrder: this.#nextLiveOrder,
      lastDeliveredSeq: new Map(),
      terminalConsumed: false,
      nextPending: false,
    };

    // The shell is registered before any stateful cursor result becomes observable. All work remains
    // synchronous, so publish cannot enter between replay boundary capture and live registration.
    this.#subscriptions.add(subscription);
    for (const [knownThreadId, history] of this.#histories) {
      if (matches(subscription, knownThreadId) && !cursorByThread.has(knownThreadId)) {
        subscription.lastDeliveredSeq.set(knownThreadId, history.highWaterSeq);
      }
    }
    for (const cursor of cursors) {
      subscription.lastDeliveredSeq.set(cursor.threadId, cursor.afterSeq);
      const history = this.#histories.get(cursor.threadId);
      const highWaterSeq = history?.highWaterSeq ?? 0;
      if (cursor.afterSeq > highWaterSeq) {
        if (!this.#knownThreads.has(cursor.threadId) && cursor.afterSeq === 0) continue;
        this.#terminate(subscription, {
          kind: 'error',
          liveBoundary: subscription.nextLiveOrder,
          error: new EventCursorValidationError('cursor_ahead', cursor.threadId),
        });
        break;
      }
      if (!this.#installReplay(subscription, cursor.threadId, cursor.afterSeq, highWaterSeq)) break;
    }

    if (subscription.terminal === undefined) {
      if (options.signal?.aborted === true) {
        this.#terminate(subscription, { kind: 'done', liveBoundary: subscription.nextLiveOrder });
      } else if (options.signal !== undefined) {
        const stop = (): void => {
          this.#terminate(subscription, { kind: 'done', liveBoundary: this.#nextLiveOrder });
        };
        options.signal.addEventListener('abort', stop, { once: true });
        subscription.cleanupSignal = () => options.signal?.removeEventListener('abort', stop);
      }
    }
    this.#fill(subscription);

    const iterator: AsyncIterator<Readonly<EventEnvelope>> = {
      next: async (): Promise<IteratorResult<Readonly<EventEnvelope>>> => {
        if (subscription.nextPending) throw new TypeError('Concurrent next() calls are not supported');
        subscription.nextPending = true;
        try {
          return await this.#next(subscription);
        } finally {
          subscription.nextPending = false;
        }
      },
      return: async (): Promise<IteratorResult<Readonly<EventEnvelope>>> => {
        subscription.queue.length = 0;
        this.#terminate(subscription, { kind: 'done', liveBoundary: subscription.nextLiveOrder }, true);
        subscription.terminalConsumed = true;
        return { done: true, value: undefined };
      },
    };
    return { [Symbol.asyncIterator]: () => iterator };
  }

  failThread(threadId: ThreadId, causeCode: string): void {
    for (const subscription of [...this.#subscriptions]) {
      if (!matches(subscription, threadId)) continue;
      this.#terminate(subscription, {
        kind: 'error',
        liveBoundary: this.#nextLiveOrder,
        error: new RuntimeEventStreamError(causeCode, threadId),
      });
      this.#fill(subscription);
      this.#wake(subscription);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const subscription of [...this.#subscriptions]) {
      this.#terminate(subscription, { kind: 'done', liveBoundary: this.#nextLiveOrder });
      this.#fill(subscription);
      this.#wake(subscription);
    }
  }

  history(threadId: ThreadId): readonly Readonly<EventEnvelope>[] {
    return [...(this.#histories.get(threadId)?.envelopes ?? [])];
  }

  async #next(subscription: Subscription): Promise<IteratorResult<Readonly<EventEnvelope>>> {
    while (true) {
      await this.#prepareReplay(subscription);
      this.#fill(subscription);
      const envelope = subscription.queue.shift();
      if (envelope !== undefined) {
        subscription.lastDeliveredSeq.set(envelope.threadId, envelope.seq);
        this.#fill(subscription);
        return { done: false, value: envelope };
      }
      if (subscription.terminal !== undefined) {
        if (subscription.terminalConsumed) return { done: true, value: undefined };
        subscription.terminalConsumed = true;
        const terminal = subscription.terminal;
        if (terminal.kind === 'gap') {
          throw new EventSubscriptionGapError(
            terminal.gap.threadId,
            subscription.lastDeliveredSeq.get(terminal.gap.threadId) ?? 0,
            terminal.gap.nextAvailableSeq,
          );
        }
        if (terminal.kind === 'error') throw terminal.error;
        return { done: true, value: undefined };
      }
      await new Promise<void>((resolve) => {
        subscription.waiter = resolve;
      });
    }
  }

  #fill(subscription: Subscription): void {
    if (subscription.terminal?.kind === 'gap') return;
    try {
      while (subscription.queue.length < this.#queueLimit) {
        const replay = subscription.replay[subscription.replayIndex];
        if (replay !== undefined) {
          if (replay.nextSeq > replay.throughSeq) {
            delete replay.prepared;
            delete replay.firstPreparedSeq;
            delete replay.loading;
            subscription.replayIndex++;
            continue;
          }
          if (replay.prepared === undefined || replay.firstPreparedSeq === undefined) return;
          const envelope = replay.prepared[replay.nextSeq - replay.firstPreparedSeq];
          if (envelope === undefined || envelope.seq !== replay.nextSeq) {
            this.#setGap(subscription, replay.threadId, replay.firstPreparedSeq);
            return;
          }
          subscription.queue.push(envelope);
          replay.nextSeq++;
          continue;
        }

        const boundary = subscription.terminal?.liveBoundary ?? this.#nextLiveOrder;
        if (subscription.nextLiveOrder >= boundary) return;
        const firstLiveOrder = this.#liveHistory[0]?.order ?? this.#nextLiveOrder;
        if (subscription.nextLiveOrder < firstLiveOrder) {
          if (subscription.pendingHint !== undefined) {
            this.#setGap(
              subscription,
              subscription.pendingHint.threadId,
              subscription.pendingHint.nextAvailableSeq,
            );
            return;
          }
          subscription.nextLiveOrder = Math.min(firstLiveOrder, boundary);
          continue;
        }
        const item = this.#liveHistory[subscription.nextLiveOrder - firstLiveOrder];
        if (item === undefined || item.order !== subscription.nextLiveOrder) return;
        subscription.nextLiveOrder++;
        if (matches(subscription, item.envelope.threadId)) subscription.queue.push(item.envelope);
      }
    } finally {
      this.#refreshPendingHint(subscription);
    }
  }

  #trimThreadHistory(history: ThreadHistory): void {
    if (history.envelopes.length > this.#historyLimit) {
      history.envelopes.splice(0, history.envelopes.length - this.#historyLimit);
    }
  }

  #trimLiveHistory(): void {
    while (this.#liveHistory.length > this.#historyLimit) {
      const removed = this.#liveHistory.shift();
      if (removed === undefined) return;
      for (const subscription of [...this.#subscriptions]) {
        if (subscription.nextLiveOrder > removed.order) continue;
        if (matches(subscription, removed.envelope.threadId)) {
          this.#setGap(subscription, removed.envelope.threadId);
        } else {
          subscription.nextLiveOrder = removed.order + 1;
        }
      }
    }
  }

  #installReplay(
    subscription: Subscription,
    threadId: ThreadId,
    afterSeq: number,
    highWaterSeq: number,
  ): boolean {
    if (afterSeq >= highWaterSeq) return true;
    const history = this.#histories.get(threadId);
    const firstMemorySeq = history?.envelopes[0]?.seq ?? highWaterSeq + 1;
    const firstAvailableSeq = history?.replay === undefined
      ? firstMemorySeq
      : Math.min(history.storageReplayStartSeq, firstMemorySeq);
    if (afterSeq < firstAvailableSeq - 1) {
      this.#setGap(subscription, threadId, firstAvailableSeq);
      return false;
    }
    subscription.replay.splice(subscription.replayIndex, 0, {
      threadId,
      nextSeq: afterSeq + 1,
      throughSeq: highWaterSeq,
    });
    return true;
  }

  async #prepareReplay(subscription: Subscription): Promise<void> {
    const replay = subscription.replay[subscription.replayIndex];
    if (replay === undefined || replay.prepared !== undefined || subscription.terminal?.kind === 'gap') return;
    if (replay.loading !== undefined) return replay.loading;
    const load = (async (): Promise<void> => {
      const history = this.#histories.get(replay.threadId);
      if (history === undefined) {
        this.#setGap(subscription, replay.threadId);
        return;
      }
      const firstSeq = replay.nextSeq;
      const prepared: Readonly<EventEnvelope>[] = [];
      let nextSeq = firstSeq;
      if (nextSeq <= history.storageHighWaterSeq) {
        const through = Math.min(replay.throughSeq, history.storageHighWaterSeq);
        if (history.replay !== undefined) {
          const loaded = await history.replay(nextSeq - 1, through);
          for (const envelope of loaded.map((item) => validateEventEnvelope(item))) {
            if (envelope.threadId !== replay.threadId || envelope.seq !== nextSeq || envelope.seq > through) {
              this.#setGap(subscription, replay.threadId, history.storageReplayStartSeq);
              return;
            }
            prepared.push(envelope);
            nextSeq++;
          }
        }
        while (nextSeq <= through) {
          const envelope = memoryEnvelope(history, nextSeq);
          if (envelope === undefined) {
            this.#setGap(subscription, replay.threadId, history.storageReplayStartSeq);
            return;
          }
          prepared.push(envelope);
          nextSeq++;
        }
      }
      while (nextSeq <= replay.throughSeq) {
        const envelope = memoryEnvelope(history, nextSeq);
        if (envelope === undefined) {
          this.#setGap(subscription, replay.threadId, history.envelopes[0]?.seq);
          return;
        }
        prepared.push(envelope);
        nextSeq++;
      }
      replay.firstPreparedSeq = firstSeq;
      replay.prepared = prepared;
      this.#fill(subscription);
      this.#wake(subscription);
    })().catch((error: unknown) => {
      this.#terminate(subscription, {
        kind: 'error',
        liveBoundary: subscription.nextLiveOrder,
        error: error instanceof Error
          ? error
          : new RuntimeEventStreamError('storage_replay_failed', replay.threadId),
      }, true);
    });
    replay.loading = load;
    await load;
  }

  #setGap(subscription: Subscription, threadId: ThreadId, nextAvailableSeq?: number): void {
    this.#terminate(subscription, {
      kind: 'gap',
      liveBoundary: subscription.nextLiveOrder,
      gap: { threadId, ...(nextAvailableSeq !== undefined && { nextAvailableSeq }) },
    }, true);
  }

  #terminate(subscription: Subscription, terminal: SubscriptionTerminal, force = false): void {
    if (!force && subscription.terminal !== undefined) return;
    subscription.terminal = terminal;
    this.#subscriptions.delete(subscription);
    subscription.cleanupSignal?.();
    subscription.cleanupSignal = undefined;
    this.#refreshPendingHint(subscription);
    this.#wake(subscription);
  }

  #refreshPendingHint(subscription: Subscription): void {
    if (subscription.terminal === undefined || subscription.terminal.kind === 'gap') return;
    const previousHint = subscription.pendingHint;
    if (previousHint?.nextAvailableSeq !== undefined
      && subscription.queue.some((envelope) =>
        envelope.threadId === previousHint.threadId
        && envelope.seq === previousHint.nextAvailableSeq)) {
      // The hinted envelope is now safe in the bounded queue. A later loss of only filtered-out
      // live-order entries must not turn the remaining terminal drain into a gap.
      subscription.pendingHint = undefined;
    }
    const replay = subscription.replay[subscription.replayIndex];
    if (replay !== undefined && replay.nextSeq <= replay.throughSeq) {
      subscription.pendingHint = { threadId: replay.threadId, nextAvailableSeq: replay.nextSeq };
      return;
    }
    const liveBoundary = subscription.terminal.liveBoundary;
    if (subscription.nextLiveOrder >= liveBoundary) {
      subscription.pendingHint = undefined;
      return;
    }
    const pending = this.#liveHistory.find((item) =>
      item.order >= subscription.nextLiveOrder
      && item.order < liveBoundary
      && matches(subscription, item.envelope.threadId));
    if (pending !== undefined) {
      subscription.pendingHint = {
        threadId: pending.envelope.threadId,
        nextAvailableSeq: pending.envelope.seq,
      };
    }
  }

  #wake(subscription: Subscription): void {
    const replayPending = subscription.replay[subscription.replayIndex] !== undefined;
    if (subscription.queue.length === 0 && subscription.terminal === undefined && !replayPending) return;
    subscription.waiter?.();
    subscription.waiter = undefined;
  }
}

function matches(subscription: Subscription, threadId: ThreadId): boolean {
  return subscription.filter === undefined || subscription.filter.has(threadId);
}

function positiveLimit(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${field} must be a positive safe integer`);
  return value;
}

function validateRegistration(registration: Readonly<EventThreadRegistration>): void {
  if (!Number.isSafeInteger(registration.highWaterSeq) || registration.highWaterSeq < 0
    || !Number.isSafeInteger(registration.replayStartSeq) || registration.replayStartSeq < 1
    || registration.replayStartSeq > registration.highWaterSeq + 1
    || typeof registration.replay !== 'function') {
    throw new TypeError('Invalid event thread registration');
  }
}

function memoryEnvelope(
  history: Readonly<ThreadHistory>,
  seq: number,
): Readonly<EventEnvelope> | undefined {
  const firstSeq = history.envelopes[0]?.seq;
  if (firstSeq === undefined || seq < firstSeq) return undefined;
  const envelope = history.envelopes[seq - firstSeq];
  return envelope?.seq === seq ? envelope : undefined;
}

function assertStreamThreadId(threadId: ThreadId): void {
  if (!isThreadId(threadId)) throw new RuntimeEventStreamError('invalid_thread_id');
}

function validateOptions(options: EventSubscriptionOptions): {
  readonly filter?: ReadonlySet<ThreadId>;
  readonly cursors: readonly { readonly threadId: ThreadId; readonly afterSeq: number }[];
} {
  let filter: Set<ThreadId> | undefined;
  if (options.threadIds !== undefined) {
    if (options.threadIds.length === 0) throw new EventCursorValidationError('empty_thread_filter');
    filter = new Set();
    for (const threadId of options.threadIds) {
      if (!isThreadId(threadId)) throw new EventCursorValidationError('invalid_thread_id');
      if (filter.has(threadId)) throw new EventCursorValidationError('duplicate_thread_filter', threadId);
      filter.add(threadId);
    }
  }

  const seenCursors = new Set<ThreadId>();
  const cursors = options.cursors ?? [];
  for (const cursor of cursors) {
    if (!isThreadId(cursor.threadId)) throw new EventCursorValidationError('invalid_thread_id');
    if (seenCursors.has(cursor.threadId)) throw new EventCursorValidationError('duplicate_cursor', cursor.threadId);
    if (filter !== undefined && !filter.has(cursor.threadId)) {
      throw new EventCursorValidationError('cursor_outside_filter', cursor.threadId);
    }
    if (!Number.isSafeInteger(cursor.afterSeq) || cursor.afterSeq < 0) {
      throw new EventCursorValidationError('invalid_after_seq', cursor.threadId);
    }
    seenCursors.add(cursor.threadId);
  }

  return { ...(filter !== undefined && { filter }), cursors };
}
