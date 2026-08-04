// Workspace-owned asynchronous observer channel. It routes already-committed envelopes through one
// global bounded live-order buffer and bounded per-subscriber queues; storage owns cursor replay.

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
  /** Maximum number of envelopes retained in the global cross-thread live-order buffer. */
  readonly historyLimit?: number;
}

export interface EventThreadRegistration {
  readonly highWaterSeq: number;
  readonly replayStartSeq: number;
  readonly replay: (afterSeq: number, throughSeq: number) => Promise<readonly EventEnvelope[]>;
}

interface ThreadReplayState {
  highWaterSeq: number;
  storageHighWaterSeq: number;
  storageReplayStartSeq: number;
  readonly replay: EventThreadRegistration['replay'];
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
  readonly #histories = new Map<ThreadId, ThreadReplayState>();
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

  registerThread(threadId: ThreadId, registration: EventThreadRegistration): void {
    assertStreamThreadId(threadId);
    validateRegistration(registration);
    if (this.#histories.has(threadId)) {
      throw new RuntimeEventStreamError('history_already_initialized', threadId);
    }
    this.#histories.set(threadId, {
      highWaterSeq: registration.highWaterSeq,
      storageHighWaterSeq: registration.highWaterSeq,
      storageReplayStartSeq: registration.replayStartSeq,
      replay: registration.replay,
    });
    for (const subscription of this.#subscriptions) {
      const afterSeq = subscription.cursorAfterSeq.get(threadId);
      if (afterSeq === undefined) continue;
      this.#installReplay(subscription, threadId, afterSeq, registration.highWaterSeq);
    }
    for (const subscription of this.#subscriptions) this.#wake(subscription);
  }

  /**
   * Advances the range that the registered storage loader can serve after a durable append and
   * before the corresponding live publication.
   */
  updateDurableReplayRange(
    threadId: ThreadId,
    range: Readonly<Pick<EventThreadRegistration, 'highWaterSeq' | 'replayStartSeq'>>,
  ): void {
    assertStreamThreadId(threadId);
    const history = this.#histories.get(threadId);
    if (history === undefined) throw new RuntimeEventStreamError('unknown_thread', threadId);
    if (!Number.isSafeInteger(range.highWaterSeq) || range.highWaterSeq < history.storageHighWaterSeq
      || range.highWaterSeq < history.highWaterSeq
      || !Number.isSafeInteger(range.replayStartSeq)
      || range.replayStartSeq < history.storageReplayStartSeq
      || range.replayStartSeq > range.highWaterSeq + 1) {
      throw new RuntimeEventStreamError('invalid_storage_replay_range', threadId);
    }
    history.storageHighWaterSeq = range.highWaterSeq;
    history.storageReplayStartSeq = range.replayStartSeq;
  }

  publish(envelopes: readonly EventEnvelope[]): void {
    if (this.#closed) throw new RuntimeEventStreamError('publish_after_close');
    const snapshots = envelopes.map((envelope) => validateEventEnvelope(envelope));
    const nextByThread = new Map<ThreadId, number>();
    for (const envelope of snapshots) {
      const history = this.#histories.get(envelope.threadId);
      if (history === undefined) {
        throw new RuntimeEventStreamError('unknown_thread', envelope.threadId);
      }
      const previous = nextByThread.get(envelope.threadId) ?? history.highWaterSeq;
      if (envelope.seq !== previous + 1) {
        throw new RuntimeEventStreamError('non_contiguous_sequence', envelope.threadId);
      }
      if (envelope.seq > history.storageHighWaterSeq) {
        throw new RuntimeEventStreamError('publish_before_durable_replay_range', envelope.threadId);
      }
      nextByThread.set(envelope.threadId, envelope.seq);
    }

    // A consumer continuation cannot interleave within this synchronous loop. Offering each valid
    // member before retention trimming lets every subscriber use its finite queue first. The batch
    // validation above guarantees every synchronous lookup in this loop has a registration.
    for (const envelope of snapshots) {
      const history = this.#histories.get(envelope.threadId) as ThreadReplayState;
      history.highWaterSeq = envelope.seq;
      this.#liveHistory.push({ order: this.#nextLiveOrder++, envelope });

      for (const subscription of this.#subscriptions) {
        if (matches(subscription, envelope.threadId)
          && !subscription.lastDeliveredSeq.has(envelope.threadId)) {
          subscription.lastDeliveredSeq.set(envelope.threadId, envelope.seq - 1);
        }
        this.#fill(subscription);
      }
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
        if (history === undefined && cursor.afterSeq === 0) continue;
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
      // A future cursor registration can insert a new replay while the prior loader is awaiting.
      // Prepare that replay directly because its registration wake may predate this waiter.
      if (subscription.replay[subscription.replayIndex] !== undefined) continue;
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
    const firstAvailableSeq = history?.storageReplayStartSeq ?? highWaterSeq + 1;
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
      const loaded = await history.replay(nextSeq - 1, replay.throughSeq);
      for (const envelope of loaded.map((item) => validateEventEnvelope(item))) {
        if (envelope.threadId !== replay.threadId
          || envelope.seq !== nextSeq
          || envelope.seq > replay.throughSeq) {
          this.#setGap(subscription, replay.threadId, history.storageReplayStartSeq);
          return;
        }
        prepared.push(envelope);
        nextSeq++;
      }
      if (nextSeq <= replay.throughSeq) {
        this.#setGap(subscription, replay.threadId, history.storageReplayStartSeq);
        return;
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
