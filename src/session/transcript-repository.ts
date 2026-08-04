// Per-thread authoritative journal IO. The repository owns append/load/fold state only: it never
// allocates event sequence numbers, decides runtime policy, or publishes observer notifications.

import { strictJsonSnapshot } from '../protocol/index.js';

export interface TranscriptJournalPort<TRecord> {
  load(): Promise<readonly TRecord[]>;
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
  readonly records: readonly TRecord[];
  readonly fold: TranscriptFold<TRecord, TState>;
  readonly foldAppend?: TranscriptAppendFold<TRecord, TState>;
  /** A storage-validated materialization avoids folding the same journal a second time. */
  readonly state?: TState;
}

/**
 * Narrow append/load/fold owner for one thread journal.
 *
 * Serialization and seq allocation belong to EventCommitter. The repository still snapshots every
 * record at its IO boundary so callers cannot mutate durable/folded state after an append starts.
 */
export class TranscriptRepository<TRecord, TState> {
  readonly #journal: TranscriptJournalPort<TRecord>;
  readonly #fold: TranscriptFold<TRecord, TState>;
  readonly #foldAppend?: TranscriptAppendFold<TRecord, TState>;
  readonly #records: TRecord[];
  #state: TState;
  #closed = false;

  constructor(options: TranscriptRepositoryOptions<TRecord, TState>) {
    this.#journal = options.journal;
    this.#fold = options.fold;
    this.#foldAppend = options.foldAppend;
    this.#records = options.records.map(snapshotRecord);
    this.#state = options.state ?? options.fold(this.#records);
  }

  static async load<TRecord, TState>(options: {
    readonly journal: TranscriptJournalPort<TRecord>;
    readonly fold: TranscriptFold<TRecord, TState>;
    readonly foldAppend?: TranscriptAppendFold<TRecord, TState>;
  }): Promise<TranscriptRepository<TRecord, TState>> {
    const records = await options.journal.load();
    return new TranscriptRepository({
      journal: options.journal,
      records,
      fold: options.fold,
      ...(options.foldAppend !== undefined && { foldAppend: options.foldAppend }),
    });
  }

  get state(): TState {
    return this.#state;
  }

  records(): readonly TRecord[] {
    return [...this.#records];
  }

  async append(records: readonly [TRecord, ...TRecord[]]): Promise<void> {
    if (this.#closed) throw new Error('TranscriptRepository is closed');
    const snapshots = records.map(snapshotRecord) as [TRecord, ...TRecord[]];
    // Fold is also the journal grammar validator. Run it before IO so malformed batches can never
    // become durable, then install the already-validated state only after the flush succeeds.
    const candidateState = this.#foldAppend === undefined
      ? this.#fold([...this.#records, ...snapshots])
      : this.#foldAppend(this.#state, snapshots);
    await this.#journal.append(snapshots, { flush: true });
    this.#records.push(...snapshots);
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
