// Per-thread authoritative journal IO. The repository owns append/folded state only: it never
// allocates event sequence numbers, decides runtime policy, or publishes observer notifications.

import { strictJsonSnapshot } from '../protocol/index.js';

export interface TranscriptJournalPort<TRecord> {
  append(records: readonly TRecord[], options: { readonly flush: true }): Promise<void>;
  releaseWriteLease(): Promise<void>;
}

export type TranscriptFold<TRecord, TState> = (records: readonly TRecord[]) => TState;
export type TranscriptAppendFold<TRecord, TState> = (
  current: TState,
  appended: readonly [TRecord, ...TRecord[]],
) => TState;

export interface TranscriptRepositoryOptions<TRecord, TState> {
  readonly journal: TranscriptJournalPort<TRecord>;
  /** Storage supplies the validated cold/tail/snapshot fold without transferring physical history. */
  readonly state: TState;
  readonly foldAppend: TranscriptAppendFold<TRecord, TState>;
}

/**
 * Narrow append/folded-state owner for one thread journal.
 *
 * Serialization and seq allocation belong to EventCommitter. The repository still snapshots every
 * record at its IO boundary so callers cannot mutate durable/folded state after an append starts.
 */
export class TranscriptRepository<TRecord, TState> {
  readonly #journal: TranscriptJournalPort<TRecord>;
  readonly #foldAppend: TranscriptAppendFold<TRecord, TState>;
  #state: TState;
  #closed = false;

  constructor(options: TranscriptRepositoryOptions<TRecord, TState>) {
    this.#journal = options.journal;
    this.#foldAppend = options.foldAppend;
    this.#state = options.state;
  }

  get state(): TState {
    return this.#state;
  }

  async append(records: readonly [TRecord, ...TRecord[]]): Promise<void> {
    if (this.#closed) throw new Error('TranscriptRepository is closed');
    const snapshots = records.map(snapshotRecord) as [TRecord, ...TRecord[]];
    // Fold is also the journal grammar validator. Run it before IO so malformed batches can never
    // become durable, then install the already-validated state only after the flush succeeds.
    const candidateState = this.#foldAppend(this.#state, snapshots);
    await this.#journal.append(snapshots, { flush: true });
    this.#state = candidateState;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#journal.releaseWriteLease();
  }
}

function snapshotRecord<TRecord>(record: TRecord): TRecord {
  // The strict JSON validator is the canonical persistence-boundary validation. This assertion is
  // safe because a successful snapshot preserves the record's structural shape while deep-freezing it.
  return strictJsonSnapshot(record) as TRecord;
}
