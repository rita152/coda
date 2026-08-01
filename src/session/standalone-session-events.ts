// Private legacy Session observer channel. Each listener keeps only a durable per-thread seq
// cursor and reads immutable envelopes from the canonical sidecar fold, so slow observers neither
// backpressure execution nor accumulate an unbounded private event queue.

import { projectLegacySessionEvent } from '../protocol/index.js';
import type { EventEnvelope, ThreadId } from '../protocol/index.js';
import type {
  SessionAuthoritativeEventBatch,
  SessionEvent,
  SessionListener,
} from './legacy-thread-execution.js';

interface ObserverCursor {
  readonly listener: SessionListener;
  lastDeliveredSeq: number;
  active: boolean;
  pumping: boolean;
}

export interface StandaloneSessionEventSource {
  readonly threadId: ThreadId;
  /** Complete, contiguous canonical envelope history folded from the durable sidecar. */
  readEnvelopes(): readonly Readonly<EventEnvelope>[];
}

/** Internal observer port; publish is deliberately synchronous and non-awaitable. */
export interface SessionObserverPort {
  subscribe(listener: SessionListener): () => void;
  publish(events: SessionAuthoritativeEventBatch): void;
  close(): void;
}

/**
 * Post-commit observer pump for the callback-based Session API.
 *
 * A subscription is hot: its cursor starts at the post-mirror publication boundary. The pump
 * advances through the durable source by seq and projects only legacy events, but never observes a
 * later canonical commit whose mirror step has not completed. Listener rejection consumes that
 * envelope, matching the historical Emitter behavior.
 */
export class StandaloneSessionEventHub implements SessionObserverPort {
  readonly #source: StandaloneSessionEventSource;
  readonly #cursors = new Set<ObserverCursor>();
  #publishedThroughSeq: number;
  #closed = false;

  constructor(source: StandaloneSessionEventSource) {
    this.#source = source;
    // Persisted history is the hot-subscription baseline. New commits become public only through
    // publish(), which LegacyThreadExecution invokes after the corresponding v1 mirror step.
    this.#publishedThroughSeq = source.readEnvelopes().at(-1)?.seq ?? 0;
  }

  subscribe(listener: SessionListener): () => void {
    if (this.#closed) throw new Error('Standalone Session event hub is closed');
    const cursor: ObserverCursor = {
      listener,
      lastDeliveredSeq: this.#publishedThroughSeq,
      active: true,
      pumping: false,
    };
    this.#cursors.add(cursor);
    return () => this.#release(cursor);
  }

  /** Advance only through the exact legacy batch whose mirror step has completed. */
  publish(events: SessionAuthoritativeEventBatch): void {
    if (this.#closed) return;
    if (!this.#advancePublishedBoundary(events)) return;
    for (const cursor of this.#cursors) this.#startPump(cursor);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const cursor of this.#cursors) this.#release(cursor);
    this.#cursors.clear();
  }

  #release(cursor: ObserverCursor): void {
    if (!cursor.active) return;
    cursor.active = false;
    this.#cursors.delete(cursor);
  }

  #startPump(cursor: ObserverCursor): void {
    if (!cursor.active || cursor.pumping) return;
    if (cursor.lastDeliveredSeq >= this.#publishedThroughSeq) return;
    cursor.pumping = true;
    // Defer listener invocation itself: even a synchronous listener cannot run inside commit.
    queueMicrotask(() => { void this.#pump(cursor); });
  }

  async #pump(cursor: ObserverCursor): Promise<void> {
    try {
      while (cursor.active) {
        if (cursor.lastDeliveredSeq >= this.#publishedThroughSeq) return;
        const envelopes = this.#source.readEnvelopes();
        const envelope = envelopes[cursor.lastDeliveredSeq];
        if (
          envelope === undefined
          || envelope.threadId !== this.#source.threadId
          || envelope.seq !== cursor.lastDeliveredSeq + 1
        ) {
          console.error('[session] observer cursor lost canonical sequence (subscription closed)');
          this.#release(cursor);
          return;
        }
        const projected = projectLegacySessionEvent(envelope, {
          targetThreadId: this.#source.threadId,
        }) as Readonly<SessionEvent> | undefined;
        if (projected !== undefined) {
          try {
            await cursor.listener(projected);
          } catch (error) {
            console.error('[session] listener threw (ignored):', error);
          }
        }
        if (cursor.active) cursor.lastDeliveredSeq = envelope.seq;
      }
    } finally {
      cursor.pumping = false;
      if (cursor.active) this.#startPump(cursor);
    }
  }

  #advancePublishedBoundary(events: SessionAuthoritativeEventBatch): boolean {
    const envelopes = this.#source.readEnvelopes();
    let nextSeq = this.#publishedThroughSeq + 1;
    let throughSeq = this.#publishedThroughSeq;

    for (const expected of events) {
      for (;;) {
        const envelope = envelopes[nextSeq - 1];
        if (
          envelope === undefined
          || envelope.threadId !== this.#source.threadId
          || envelope.seq !== nextSeq
        ) {
          this.#failPublicationBoundary('canonical sequence is unavailable');
          return false;
        }
        nextSeq++;
        const projected = projectLegacySessionEvent(envelope, {
          targetThreadId: this.#source.threadId,
        }) as Readonly<SessionEvent> | undefined;
        if (projected === undefined) continue;
        // The immutable canonical projection remains the delivered payload. The post-mirror batch
        // is only a release token, so compare its ordered discriminators rather than producer-owned
        // objects that may intentionally differ from their persistence-safe snapshots.
        if (projected.type !== expected.type) {
          this.#failPublicationBoundary(
            `legacy ${expected.type} batch does not match canonical ${projected.type} sequence`,
          );
          return false;
        }
        throughSeq = envelope.seq;
        break;
      }
    }

    this.#publishedThroughSeq = throughSeq;
    return true;
  }

  #failPublicationBoundary(reason: string): void {
    console.error(`[session] observer publication boundary failed: ${reason} (subscriptions closed)`);
    for (const cursor of [...this.#cursors]) this.#release(cursor);
  }
}
