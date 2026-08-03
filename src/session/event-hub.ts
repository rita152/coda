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

interface ThreadHistory {
  readonly envelopes: Readonly<EventEnvelope>[];
  highWaterSeq: number;
}

interface OrderedEnvelope {
  readonly order: number;
  readonly envelope: Readonly<EventEnvelope>;
}

interface ReplayCursor {
  readonly threadId: ThreadId;
  nextSeq: number;
  readonly throughSeq: number;
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

  registerThread(threadId: ThreadId): void {
    assertStreamThreadId(threadId);
    this.#knownThreads.add(threadId);
    if (!this.#histories.has(threadId)) {
      this.#histories.set(threadId, { envelopes: [], highWaterSeq: 0 });
    }
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
    this.#knownThreads.add(threadId);
    this.#histories.set(threadId, {
      envelopes: retained,
      highWaterSeq: previous,
    });
    const firstRetainedSeq = retained[0]?.seq ?? previous + 1;
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
        history = { envelopes: [], highWaterSeq: 0 };
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
      const firstRetainedSeq = history?.envelopes[0]?.seq ?? highWaterSeq + 1;
      if (cursor.afterSeq < firstRetainedSeq - 1) {
        this.#setGap(subscription, cursor.threadId, firstRetainedSeq);
        break;
      }
      if (cursor.afterSeq < highWaterSeq) {
        subscription.replay.push({
          threadId: cursor.threadId,
          nextSeq: cursor.afterSeq + 1,
          throughSeq: highWaterSeq,
        });
      }
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
            subscription.replayIndex++;
            continue;
          }
          const history = this.#histories.get(replay.threadId);
          const firstRetainedSeq = history?.envelopes[0]?.seq ?? (history?.highWaterSeq ?? 0) + 1;
          if (replay.nextSeq < firstRetainedSeq) {
            this.#setGap(subscription, replay.threadId, firstRetainedSeq);
            return;
          }
          const envelope = history?.envelopes[replay.nextSeq - firstRetainedSeq];
          if (envelope === undefined || envelope.seq !== replay.nextSeq) {
            this.#setGap(subscription, replay.threadId, firstRetainedSeq);
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
    if (subscription.queue.length === 0 && subscription.terminal === undefined) return;
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
