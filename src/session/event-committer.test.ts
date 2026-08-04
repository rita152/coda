import { describe, expect, test } from 'bun:test';

import {
  assertThreadId,
  assertWorkspaceId,
} from '../protocol/index.js';
import type { EventEnvelope, ThreadId } from '../protocol/index.js';
import { EventCommitter } from './event-committer.js';
import { RuntimeEventStreamError } from './event-errors.js';
import { EventHub } from './event-hub.js';
import {
  TranscriptRepository,
} from './transcript-repository.js';
import type { TranscriptJournalPort } from './transcript-repository.js';

const WORKSPACE = assertWorkspaceId('workspace-event-committer');
const THREAD_A = assertThreadId('thread-event-committer-A');
const THREAD_B = assertThreadId('thread-event-committer-B');

type TestRecord =
  | { readonly type: 'seed' }
  | {
      readonly type: 'commit';
      readonly firstSeq: number;
      readonly envelopes: readonly [Readonly<EventEnvelope>, ...Readonly<EventEnvelope>[]];
      readonly mutations?: readonly TestMutation[];
    };

interface TestMutation {
  readonly type: 'marker';
  readonly value: string;
}

interface TestState {
  readonly highWaterSeq: number;
}

describe('EventCommitter + TranscriptRepository', () => {
  test('repository starts from a storage-validated fold without loading physical history', () => {
    const persisted = [
      { type: 'seed' as const },
      {
        type: 'commit' as const,
        firstSeq: 1,
        envelopes: [persistedEnvelope(THREAD_A, 1)] as const,
      },
    ];
    const journal = new RecordingJournal(persisted);
    const repository = new TranscriptRepository({
      journal,
      state: fold(persisted),
      foldAppend,
    });

    expect(repository.state.highWaterSeq).toBe(1);
  });

  test('repository validates the candidate fold before writing an invalid batch', async () => {
    const journal = new RecordingJournal([{ type: 'seed' }]);
    const repository = new TranscriptRepository<TestRecord, TestState>({
      journal,
      state: fold(journal.records),
      foldAppend: (current, records) => {
        if (records.some((record) => record.type === 'commit' && record.firstSeq !== 1)) {
          throw new Error('invalid candidate sequence');
        }
        return foldAppend(current, records);
      },
    });

    await expect(repository.append([{
      type: 'commit',
      firstSeq: 2,
      envelopes: [persistedEnvelope(THREAD_A, 2)],
    }])).rejects.toThrow('invalid candidate sequence');

    expect(journal.appendCalls).toBe(0);
    expect(journal.records).toEqual([{ type: 'seed' }]);
    expect(repository.state.highWaterSeq).toBe(0);
  });

  test('repository incremental fold visits only the newly appended records', async () => {
    const journal = new RecordingJournal([{ type: 'seed' }]);
    let appendFoldVisits = 0;
    const repository = new TranscriptRepository<TestRecord, TestState>({
      journal,
      state: fold(journal.records),
      foldAppend: (current, records) => {
        appendFoldVisits += records.length;
        return {
          highWaterSeq: records.reduce((last, record) =>
            record.type === 'commit' ? record.envelopes.at(-1)?.seq ?? last : last,
          current.highWaterSeq),
        };
      },
    });

    for (let seq = 1; seq <= 8; seq++) {
      await repository.append([{
        type: 'commit',
        firstSeq: seq,
        envelopes: [persistedEnvelope(THREAD_A, seq)],
      }]);
    }

    expect(appendFoldVisits).toBe(8);
    expect(repository.state.highWaterSeq).toBe(8);
  });

  test('repository validates an incremental candidate before IO and installs it only after flush', async () => {
    const journal = new RecordingJournal([{ type: 'seed' }]);
    const repository = new TranscriptRepository<TestRecord, TestState>({
      journal,
      state: fold(journal.records),
      foldAppend: (current, records) => {
        const next = records[0];
        if (next.type === 'commit' && next.firstSeq !== current.highWaterSeq + 1) {
          throw new Error('invalid incremental sequence');
        }
        return {
          highWaterSeq: next.type === 'commit'
            ? next.envelopes.at(-1)?.seq ?? current.highWaterSeq
            : current.highWaterSeq,
        };
      },
    });

    await expect(repository.append([{
      type: 'commit',
      firstSeq: 2,
      envelopes: [persistedEnvelope(THREAD_A, 2)],
    }])).rejects.toThrow('invalid incremental sequence');
    expect(journal.appendCalls).toBe(0);
    expect(repository.state.highWaterSeq).toBe(0);

    journal.failure = new Error('flush failed');
    await expect(repository.append([{
      type: 'commit',
      firstSeq: 1,
      envelopes: [persistedEnvelope(THREAD_A, 1)],
    }])).rejects.toThrow('flush failed');
    expect(journal.records).toEqual([{ type: 'seed' }]);
    expect(repository.state.highWaterSeq).toBe(0);
  });

  test('the authoritative append gate backpressures commit and publishes only after flush', async () => {
    const fixture = createFixture(THREAD_A);
    const appendEntered = deferred<void>();
    const releaseAppend = deferred<void>();
    fixture.journal.beforeCommit = async () => {
      appendEntered.resolve(undefined);
      await releaseAppend.promise;
    };
    const observer = fixture.hub.subscribe({ threadIds: [THREAD_A] })[Symbol.asyncIterator]();

    const commit = fixture.committer.commit([event('one')]);
    await appendEntered.promise;
    expect(await remainsPending(commit)).toBe(true);
    const delivery = observer.next();
    expect(await remainsPending(delivery)).toBe(true);

    releaseAppend.resolve(undefined);
    const committed = await commit;
    expect(committed.map((envelope) => envelope.seq)).toEqual([1]);
    expect((await delivery).value?.seq).toBe(1);
    await observer.return?.();
  });

  test('commits a multi-envelope batch in one append with consecutive seq and one fold', async () => {
    const fixture = createFixture(THREAD_A);
    const observer = fixture.hub.subscribe({ threadIds: [THREAD_A] })[Symbol.asyncIterator]();

    const envelopes = await fixture.committer.commit(
      [event('one'), event('two')],
      [{ type: 'marker', value: 'atomic' }],
    );

    expect(envelopes.map((envelope) => envelope.seq)).toEqual([1, 2]);
    expect(fixture.journal.appendCalls).toBe(1);
    expect(fixture.journal.records).toHaveLength(2);
    expect(fixture.journal.records[1]).toMatchObject({
      type: 'commit',
      firstSeq: 1,
      mutations: [{ type: 'marker', value: 'atomic' }],
    });
    expect(await nextSeq(observer)).toBe(1);
    expect(await nextSeq(observer)).toBe(2);
    await observer.return?.();
  });

  test('slow and throwing observers never enter the authoritative promise chain', async () => {
    const fixture = createFixture(THREAD_A, new EventHub({ subscriptionQueueLimit: 1, historyLimit: 8 }));
    const slow = fixture.hub.subscribe({ threadIds: [THREAD_A] })[Symbol.asyncIterator]();
    const throwing = fixture.hub.subscribe({ threadIds: [THREAD_A] })[Symbol.asyncIterator]();
    const observerFailure = (async () => {
      const item = await throwing.next();
      if (!item.done) throw new Error('observer failed');
    })();

    await fixture.committer.commit([event('one')]);
    await expect(observerFailure).rejects.toThrow('observer failed');
    // The slow observer has not consumed seq 1. Its bounded queue and replay cursor remain entirely
    // hub-local, so a second authoritative commit still settles immediately.
    await fixture.committer.commit([event('two')]);
    expect(fixture.committer.state.highWaterSeq).toBe(2);
    expect(await nextSeq(slow)).toBe(1);
    expect(await nextSeq(slow)).toBe(2);
    await slow.return?.();
    await throwing.return?.();
  });

  test('writer fatal terminates matching subscriptions only and latches the committer', async () => {
    const hub = new EventHub();
    const broken = createFixture(THREAD_A, hub);
    const healthy = createFixture(THREAD_B, hub);
    const failedObserver = hub.subscribe({ threadIds: [THREAD_A] })[Symbol.asyncIterator]();
    const healthyObserver = hub.subscribe({ threadIds: [THREAD_B] })[Symbol.asyncIterator]();
    broken.journal.failure = new Error('disk unavailable');

    await expect(broken.committer.commit([event('broken')])).rejects.toThrow('disk unavailable');
    await expect(failedObserver.next()).rejects.toBeInstanceOf(RuntimeEventStreamError);
    expect(broken.committer.state.highWaterSeq).toBe(0);
    expect(broken.journal.records).toEqual([{ type: 'seed' }]);
    await expect(broken.committer.commit([event('again')])).rejects.toThrow('disk unavailable');
    expect(broken.journal.appendCalls).toBe(1);

    await healthy.committer.commit([event('healthy')]);
    expect(await nextSeq(healthyObserver)).toBe(1);
    await healthyObserver.return?.();
  });

  test('close atomically seals admission, drains admitted commits, and is idempotent', async () => {
    const fixture = createFixture(THREAD_A);
    const appendEntered = deferred<void>();
    const releaseAppend = deferred<void>();
    fixture.journal.beforeCommit = async () => {
      appendEntered.resolve(undefined);
      await releaseAppend.promise;
    };

    const admitted = fixture.committer.commit([event('admitted')]);
    await appendEntered.promise;
    const firstClose = fixture.committer.close();
    const secondClose = fixture.committer.close();
    const lateCommit = fixture.committer.commit([event('late')]);

    expect(secondClose).toBe(firstClose);
    await expect(lateCommit).rejects.toThrow('Event committer thread-event-committer-A is closed');
    expect(await remainsPending(firstClose)).toBe(true);

    releaseAppend.resolve(undefined);
    await admitted;
    await firstClose;
    expect(fixture.journal.appendCalls).toBe(1);
    expect(fixture.journal.releaseWriteLeaseCalls).toBe(1);
    expect(fixture.committer.state.highWaterSeq).toBe(1);
  });

  test('close preserves both a latched writer fatal and a repository close failure', async () => {
    const fixture = createFixture(THREAD_A);
    const writerFailure = new Error('disk unavailable');
    const closeFailure = new Error('lease release failed');
    fixture.journal.failure = writerFailure;
    fixture.journal.releaseFailure = closeFailure;

    await expect(fixture.committer.commit([event('broken')])).rejects.toBe(writerFailure);
    const close = fixture.committer.close();
    await expect(close).rejects.toMatchObject({
      errors: [writerFailure, closeFailure],
    });
    expect(fixture.committer.close()).toBe(close);
    expect(fixture.journal.releaseWriteLeaseCalls).toBe(1);
  });
});

function createFixture(threadId: ThreadId, hub = new EventHub()): {
  readonly hub: EventHub;
  readonly journal: RecordingJournal;
  readonly committer: EventCommitter<TestRecord, TestState, TestMutation>;
} {
  const journal = new RecordingJournal([{ type: 'seed' }]);
  const repository = new TranscriptRepository({
    journal,
    state: fold(journal.records),
    foldAppend,
  });
  hub.registerThread(threadId);
  const committer = new EventCommitter<TestRecord, TestState, TestMutation>({
    workspaceId: WORKSPACE,
    threadId,
    repository,
    clock: { now: () => 10 },
    highWaterSeq: (state) => state.highWaterSeq,
    createCommitRecord: ({ firstSeq, envelopes, mutations }) => ({
      type: 'commit',
      firstSeq,
      envelopes,
      ...(mutations.length > 0 && { mutations }),
    }),
    publish: (envelopes) => hub.publish(envelopes),
    onWriterFatal: () => hub.failThread(threadId, 'writer_failed'),
  });
  return { hub, journal, committer };
}

class RecordingJournal implements TranscriptJournalPort<TestRecord> {
  beforeCommit?: () => Promise<void>;
  failure?: Error;
  releaseFailure?: Error;
  appendCalls = 0;
  releaseWriteLeaseCalls = 0;

  constructor(readonly records: TestRecord[]) {}

  async append(records: readonly TestRecord[]): Promise<void> {
    this.appendCalls += 1;
    await this.beforeCommit?.();
    if (this.failure !== undefined) throw this.failure;
    this.records.push(...records);
  }

  async releaseWriteLease(): Promise<void> {
    this.releaseWriteLeaseCalls += 1;
    if (this.releaseFailure !== undefined) throw this.releaseFailure;
  }
}

function persistedEnvelope(threadId: ThreadId, seq: number): EventEnvelope {
  return {
    workspaceId: WORKSPACE,
    threadId,
    seq,
    timestamp: seq,
    event: {
      type: 'runtime_diagnostic',
      severity: 'warning',
      code: `persisted-${seq}`,
      message: '',
      scope: 'thread',
    },
  };
}

function fold(records: readonly TestRecord[]): TestState {
  return {
    highWaterSeq: records.reduce((last, record) =>
      record.type === 'commit' ? record.envelopes.at(-1)?.seq ?? last : last, 0),
  };
}

function foldAppend(
  current: TestState,
  records: readonly [TestRecord, ...TestRecord[]],
): TestState {
  return {
    highWaterSeq: records.reduce((last, record) =>
      record.type === 'commit' ? record.envelopes.at(-1)?.seq ?? last : last,
    current.highWaterSeq),
  };
}

function event(code: string): {
  readonly event: {
    readonly type: 'runtime_diagnostic';
    readonly severity: 'warning';
    readonly code: string;
    readonly message: string;
    readonly scope: 'thread';
  };
} {
  return {
    event: {
      type: 'runtime_diagnostic',
      severity: 'warning',
      code,
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

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function remainsPending<T>(promise: Promise<T>): Promise<boolean> {
  const marker = Symbol('pending');
  return Promise.race([promise, Promise.resolve(marker)]).then((value) => value === marker);
}
