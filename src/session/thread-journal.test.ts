import { describe, expect, test } from 'bun:test';
import {
  PROTOCOL_VERSION,
  assertRunId,
  assertThreadId,
  assertTurnId,
  assertWorkspaceId,
} from '../protocol/index.js';
import type { UserMessage } from '../protocol/index.js';
import { EventHub } from './event-hub.js';
import type {
  RuntimeJournalRecord,
  ThreadJournalAppendPort,
  ThreadMetaRecord,
} from './thread-journal-records.js';
import {
  ThreadJournalWriter,
  foldThreadJournal,
} from './thread-journal.js';

describe('ThreadJournalWriter', () => {
  test('serializes concurrent driver events and persists canonical transcript mutations', async () => {
    const fixture = writerFixture();
    const firstAppendEntered = deferred<void>();
    const releaseFirstAppend = deferred<void>();
    fixture.journal.beforeFirstCommit = async () => {
      firstAppendEntered.resolve(undefined);
      await releaseFirstAppend.promise;
    };

    const first = fixture.writer.commitDriverEvent({
      runId: fixture.runId,
      turnId: fixture.turnId,
      event: { type: 'message_end', message: userMessage('message-1', 'first') },
    });
    await firstAppendEntered.promise;
    const second = fixture.writer.commitDriverEvent({
      runId: fixture.runId,
      turnId: fixture.turnId,
      event: { type: 'message_end', message: userMessage('message-2', 'second') },
    });
    releaseFirstAppend.resolve(undefined);
    await Promise.all([first, second]);

    expect(fixture.writer.state.highWaterSeq).toBe(2);
    expect(fixture.writer.state.checkpoint.frontend.transcript.map((message) => message.id))
      .toEqual(['message-1', 'message-2']);
    const commits = fixture.journal.records.filter((record) => record.type === 'commit');
    expect(commits.map((record) => record.firstSeq)).toEqual([1, 2]);
    expect(commits.map((record) => record.mutations)).toEqual([
      [{ type: 'message_appended', message: userMessage('message-1', 'first') }],
      [{ type: 'message_appended', message: userMessage('message-2', 'second') }],
    ]);
    expect(JSON.stringify(commits)).not.toContain('driver_checkpoint');
  });

  test('publishes only after the canonical commit has flushed', async () => {
    const fixture = writerFixture();
    const appendEntered = deferred<void>();
    const releaseAppend = deferred<void>();
    fixture.journal.beforeFirstCommit = async () => {
      appendEntered.resolve(undefined);
      await releaseAppend.promise;
    };
    const iterator = fixture.events.subscribe({
      threadIds: [fixture.threadId],
    })[Symbol.asyncIterator]();

    const commit = fixture.writer.commitDriverEvent({
      runId: fixture.runId,
      turnId: fixture.turnId,
      event: { type: 'message_end', message: userMessage('message-1', 'durable') },
    });
    await appendEntered.promise;
    const pendingNext = iterator.next();
    expect(await remainsPending(pendingNext)).toBe(true);
    releaseAppend.resolve(undefined);
    await commit;

    const delivered = await pendingNext;
    expect(delivered.done).toBe(false);
    expect(delivered.value?.seq).toBe(1);
    expect(fixture.journal.records.at(-1)?.type).toBe('commit');
    await iterator.return?.();
  });
});

describe('foldThreadJournal commit correspondence', () => {
  test('rejects control mutation identity that differs from its same-record envelope', () => {
    const fixture = writerFixture();
    const meta = fixture.journal.records[0] as ThreadMetaRecord;
    const request = {
      type: 'control_request' as const,
      requestId: 'approval-request-envelope',
      kind: 'approval' as const,
      owningRunId: fixture.runId,
      owningTurnId: fixture.turnId,
      policyRevision: 'policy-v1',
      payload: { toolCallId: 'call-1', description: 'approve fixture' },
    };
    expect(() => foldThreadJournal([meta, {
      type: 'commit',
      firstSeq: 1,
      envelopes: [{
        workspaceId: meta.workspaceId,
        threadId: meta.threadId,
        runId: fixture.runId,
        turnId: fixture.turnId,
        seq: 1,
        timestamp: 1,
        event: request,
      }],
      mutations: [{
        type: 'control_requested',
        request: { ...request, requestId: 'approval-request-mutation' },
      }],
    }])).toThrow(/control_request envelopes and mutations differ/);
  });

  test('rejects a successful compaction event without its checkpoint mutation', () => {
    const fixture = writerFixture();
    const meta = fixture.journal.records[0] as ThreadMetaRecord;
    expect(() => foldThreadJournal([meta, {
      type: 'commit',
      firstSeq: 1,
      envelopes: [{
        workspaceId: meta.workspaceId,
        threadId: meta.threadId,
        runId: fixture.runId,
        seq: 1,
        timestamp: 1,
        event: {
          type: 'compaction_end',
          activityRunId: fixture.runId,
          ok: true,
          droppedMessages: 1,
        },
      }],
    }])).toThrow(/compaction_end envelopes and mutations differ/);
  });
});

function writerFixture(): {
  readonly writer: ThreadJournalWriter;
  readonly journal: RecordingJournal;
  readonly events: EventHub;
  readonly threadId: ReturnType<typeof assertThreadId>;
  readonly runId: ReturnType<typeof assertRunId>;
  readonly turnId: ReturnType<typeof assertTurnId>;
} {
  const workspaceId = assertWorkspaceId('workspace-thread-journal-test');
  const threadId = assertThreadId('thread-thread-journal-test');
  const runId = assertRunId('run-thread-journal-test');
  const turnId = assertTurnId('turn-thread-journal-test');
  const meta: ThreadMetaRecord = {
    type: 'thread_meta',
    version: 2,
    protocolVersion: PROTOCOL_VERSION,
    workspaceId,
    threadId,
    permissionCeiling: { revision: 'ceiling-v1', constraints: [] },
    createdAt: 1,
    cwd: '/workspace',
    model: { provider: 'test', api: 'faux', model: 'model' },
  };
  const records: RuntimeJournalRecord[] = [meta];
  const journal = new RecordingJournal(records);
  const events = new EventHub();
  events.registerThread(threadId);
  const writer = new ThreadJournalWriter({
    workspaceId,
    threadId,
    journal,
    events,
    clock: { now: () => 10 },
    state: foldThreadJournal(records),
    records,
  });
  return { writer, journal, events, threadId, runId, turnId };
}

class RecordingJournal implements ThreadJournalAppendPort {
  beforeFirstCommit?: () => Promise<void>;
  #commitCount = 0;

  constructor(readonly records: RuntimeJournalRecord[]) {}

  async acquireWriteLease(): Promise<void> {}

  async load(): Promise<readonly RuntimeJournalRecord[]> {
    return this.records;
  }

  async append(records: readonly RuntimeJournalRecord[]): Promise<void> {
    if (records.some((record) => record.type === 'commit')) {
      this.#commitCount += 1;
      if (this.#commitCount === 1) await this.beforeFirstCommit?.();
    }
    this.records.push(...records);
  }

  async releaseWriteLease(): Promise<void> {}
}

function userMessage(id: string, text: string): UserMessage {
  return {
    role: 'user',
    id,
    timestamp: 1,
    content: [{ type: 'text', text }],
    source: 'prompt',
  };
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
