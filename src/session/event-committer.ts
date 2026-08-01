// The sole authoritative event gate for one thread. It serializes all journal writes, assigns the
// per-thread seq range, atomically appends batches, then synchronously hands immutable envelopes to
// EventHub's non-blocking queue ingress.

import {
  strictJsonSnapshot,
  validateEventEnvelope,
} from '../protocol/index.js';
import type {
  EventEnvelope,
  OpId,
  RunId,
  RuntimeEvent,
  ThreadId,
  TurnId,
  WorkspaceId,
} from '../protocol/index.js';
import { RuntimeEventStreamError } from './event-errors.js';

export interface CommitEnvelopeInput {
  readonly event: RuntimeEvent;
  readonly runId?: RunId;
  readonly turnId?: TurnId;
  readonly opId?: OpId;
}

export interface EventCommitterRepository<TRecord, TState> {
  readonly state: TState;
  append(records: readonly [TRecord, ...TRecord[]]): Promise<void>;
  close(): Promise<void>;
}

export interface EventCommitterOptions<TRecord, TState, TMutation> {
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly repository: EventCommitterRepository<TRecord, TState>;
  readonly clock: { now(): number };
  readonly highWaterSeq: (state: TState) => number;
  readonly createCommitRecord: (input: {
    readonly firstSeq: number;
    readonly envelopes: readonly [Readonly<EventEnvelope>, ...Readonly<EventEnvelope>[]];
    readonly mutations: readonly TMutation[];
  }) => TRecord;
  /** Must only enqueue into an EventHub; it may not await or invoke observers inline. */
  readonly publish: (envelopes: readonly Readonly<EventEnvelope>[]) => void;
  readonly onWriterFatal?: (error: Error) => void;
}

/** A per-thread awaited authoritative sink; public observers never enter this promise chain. */
export class EventCommitter<TRecord, TState, TMutation> {
  readonly #workspaceId: WorkspaceId;
  readonly #threadId: ThreadId;
  readonly #repository: EventCommitterRepository<TRecord, TState>;
  readonly #clock: { now(): number };
  readonly #highWaterSeq: (state: TState) => number;
  readonly #createCommitRecord: EventCommitterOptions<TRecord, TState, TMutation>['createCommitRecord'];
  readonly #publish: (envelopes: readonly Readonly<EventEnvelope>[]) => void;
  readonly #onWriterFatal?: (error: Error) => void;
  #chain: Promise<void> = Promise.resolve();
  #fatal: Error | undefined;
  #closing = false;
  #closePromise: Promise<void> | undefined;

  constructor(options: EventCommitterOptions<TRecord, TState, TMutation>) {
    this.#workspaceId = options.workspaceId;
    this.#threadId = options.threadId;
    this.#repository = options.repository;
    this.#clock = options.clock;
    this.#highWaterSeq = options.highWaterSeq;
    this.#createCommitRecord = options.createCommitRecord;
    this.#publish = options.publish;
    this.#onWriterFatal = options.onWriterFatal;
  }

  get state(): TState {
    return this.#repository.state;
  }

  /** Serializes a non-event authoritative record through the same writer gate. */
  async append(records: readonly [TRecord, ...TRecord[]]): Promise<void> {
    await this.#serialize(async () => {
      const snapshots = records.map((record) => strictJsonSnapshot(record) as TRecord);
      await this.#repository.append(snapshots as [TRecord, ...TRecord[]]);
    });
  }

  async commit(
    inputs: readonly [CommitEnvelopeInput, ...CommitEnvelopeInput[]],
    mutations: readonly TMutation[] = [],
    acceptedTimestamp?: number,
  ): Promise<readonly Readonly<EventEnvelope>[]> {
    return this.#serialize(async () => {
      const firstSeq = this.#highWaterSeq(this.#repository.state) + 1;
      if (firstSeq > Number.MAX_SAFE_INTEGER - inputs.length + 1) {
        throw new RuntimeEventStreamError('sequence_exhausted', this.#threadId);
      }
      const timestamp = acceptedTimestamp ?? this.#clock.now();
      const envelopes = inputs.map((input, index) => validateEventEnvelope({
        workspaceId: this.#workspaceId,
        threadId: this.#threadId,
        ...(input.runId !== undefined && { runId: input.runId }),
        ...(input.turnId !== undefined && { turnId: input.turnId }),
        ...(input.opId !== undefined && { opId: input.opId }),
        seq: firstSeq + index,
        timestamp,
        event: input.event,
      })) as [Readonly<EventEnvelope>, ...Readonly<EventEnvelope>[]];
      // Snapshot the complete record before the first await. Producer-owned events/mutations can no
      // longer change either durable state or the published envelope batch.
      const record = strictJsonSnapshot(this.#createCommitRecord({
        firstSeq,
        envelopes,
        mutations,
      })) as TRecord;
      await this.#repository.append([record]);
      this.#publish(envelopes);
      return envelopes;
    });
  }

  async drain(): Promise<void> {
    await this.#chain;
    if (this.#fatal !== undefined) throw this.#fatal;
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    // Seal admission synchronously. Every operation admitted before this assignment is already in
    // #chain, so drain is a complete close barrier and no append can race repository lease release.
    this.#closing = true;
    this.#closePromise = (async () => {
      const failures: unknown[] = [];
      try {
        await this.drain();
      } catch (error) {
        failures.push(error);
      }
      try {
        await this.#repository.close();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, `Event committer ${this.#threadId} close failed`);
      }
    })();
    return this.#closePromise;
  }

  async #serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closing) throw new Error(`Event committer ${this.#threadId} is closed`);
    const run = this.#chain.then(async () => {
      if (this.#fatal !== undefined) throw this.#fatal;
      try {
        return await operation();
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        this.#fatal = failure;
        try {
          this.#onWriterFatal?.(failure);
        } catch {
          // Fatal notification is best-effort and must never replace the authoritative failure.
        }
        throw failure;
      }
    });
    this.#chain = run.then(() => undefined, () => undefined);
    return run;
  }
}
