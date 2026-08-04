import { describe, expect, test } from 'bun:test';
import {
  PROTOCOL_VERSION,
  assertDerivedOpId,
  assertExternalOpId,
  assertRunId,
  assertThreadId,
  assertTurnId,
  assertWorkspaceId,
  canonicalJson,
} from '../protocol/index.js';
import type {
  AssistantMessage,
  RunId,
  ThreadId,
  TurnId,
  UserMessage,
  WorkspaceId,
} from '../protocol/index.js';
import { EventHub } from './event-hub.js';
import type {
  RuntimeJournalRecord,
  ThreadJournalAppendPort,
  ThreadMetaRecord,
} from './thread-journal-records.js';
import {
  ThreadJournalWriter,
  THREAD_REPLAY_BYTE_LIMIT,
  THREAD_REPLAY_LIMIT,
  foldThreadJournal,
  foldThreadJournalAppend,
  threadJournalRequiresRecovery,
} from './thread-journal.js';
import {
  deserializeThreadRecoveryState,
  serializeThreadRecoveryState,
} from './thread-recovery-snapshot.js';

describe('ThreadJournalWriter', () => {
  test('keeps the full replay window with at most one cumulative seed partial', async () => {
    const fixture = writerFixture();
    const meta = fixture.journal.records[0];
    if (meta === undefined || meta.type !== 'thread_meta') throw new Error('missing fixture meta');
    const lifecycleOpId = assertExternalOpId('op_e_99999999999999999999999999999999');
    await fixture.writer.commit([{
      event: { type: 'op_completed', opType: 'thread_resume', outcome: 'applied' },
      opId: lifecycleOpId,
    }]);
    const messageId = 'assistant-snapshot-tail';
    const emptyText = {
      ...assistantMessage(meta, messageId, ''),
      content: [{ type: 'text' as const, text: '' }],
    };
    await fixture.writer.commitDriverEvent({
      runId: fixture.runId,
      turnId: fixture.turnId,
      event: { type: 'message_start', message: assistantMessage(meta, messageId, '') },
    });
    await fixture.writer.commitDriverEvent({
      runId: fixture.runId,
      turnId: fixture.turnId,
      event: {
        type: 'message_update',
        messageId,
        event: { type: 'text_start', contentIndex: 0, partial: emptyText },
      },
    });
    for (const text of ['a', 'ab', 'abc']) {
      await fixture.writer.commitDriverEvent({
        runId: fixture.runId,
        turnId: fixture.turnId,
        event: {
          type: 'message_update',
          messageId,
          event: {
            type: 'text_delta',
            contentIndex: 0,
            delta: text.at(-1) as string,
            partial: assistantMessage(meta, messageId, text),
          },
        },
      });
    }
    const terminal = assistantMessage(meta, messageId, 'abc');
    await fixture.writer.commitDriverEvent({
      runId: fixture.runId,
      turnId: fixture.turnId,
      event: {
        type: 'message_update',
        messageId,
        event: { type: 'text_end', contentIndex: 0, content: 'abc', partial: terminal },
      },
    });
    await fixture.writer.commitDriverEvent({
      runId: fixture.runId,
      turnId: fixture.turnId,
      event: { type: 'message_end', message: terminal },
    });

    const serialized = serializeThreadRecoveryState(fixture.writer.state);
    expect(serialized.envelopes.filter((envelope) =>
      envelope.event.type === 'message_update')).toHaveLength(5);
    expect(serialized.envelopes.map((envelope) => envelope.seq))
      .toEqual(fixture.writer.state.envelopes.map((envelope) => envelope.seq));
    expect(JSON.stringify(serialized).match(/"partial"/gu) ?? []).toHaveLength(0);
    const recovered = deserializeThreadRecoveryState(serialized, meta);
    expect(recovered.envelopes).toEqual(fixture.writer.state.envelopes);
    expect(recovered.opTerminals.get(lifecycleOpId)).toMatchObject({
      seq: 1,
      event: { type: 'op_completed', opType: 'thread_resume', outcome: 'applied' },
    });

    const cutEnvelopes = fixture.writer.state.envelopes.filter((envelope) => envelope.seq >= 4);
    const cut = {
      ...fixture.writer.state,
      envelopes: cutEnvelopes,
      replayBytes: cutEnvelopes.reduce(
        (total, envelope) => total + new TextEncoder().encode(canonicalJson(envelope)).byteLength,
        0,
      ),
    };
    const seeded = serializeThreadRecoveryState(cut);
    expect(JSON.stringify(seeded).match(/"partial"/gu) ?? []).toHaveLength(1);
    expect(deserializeThreadRecoveryState(seeded, meta).envelopes).toEqual(cutEnvelopes);
  });

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

  test('does not revalidate historical envelopes while appending new commits', async () => {
    const fixture = writerFixture();
    await fixture.writer.commitDriverEvent({
      runId: fixture.runId,
      turnId: fixture.turnId,
      event: { type: 'message_end', message: userMessage('message-1', 'first') },
    });
    const firstEnvelope = fixture.writer.state.envelopes[0];

    await fixture.writer.commitDriverEvent({
      runId: fixture.runId,
      turnId: fixture.turnId,
      event: { type: 'message_end', message: userMessage('message-2', 'second') },
    });

    expect(fixture.writer.state.envelopes[0]).toBe(firstEnvelope);
    expect(normalizeFold(fixture.writer.state))
      .toEqual(normalizeFold(foldThreadJournal(fixture.journal.records)));
  });

  test('does not resnapshot unchanged transcript history for streaming updates', async () => {
    const fixture = writerFixture();
    const meta = fixture.journal.records[0];
    if (meta === undefined || meta.type !== 'thread_meta') throw new Error('missing fixture meta');
    await fixture.writer.commitDriverEvent({
      runId: fixture.runId,
      turnId: fixture.turnId,
      event: { type: 'message_end', message: userMessage('historical-message', 'history') },
    });
    const streaming = assistantMessage(meta, 'streaming-message', 'x');
    await fixture.writer.commitDriverEvent({
      runId: fixture.runId,
      turnId: fixture.turnId,
      event: { type: 'message_start', message: assistantMessage(meta, streaming.id, '') },
    });
    const historicalTranscript = fixture.writer.state.checkpoint.frontend.transcript;
    const historicalMessage = historicalTranscript[0];

    await fixture.writer.commitDriverEvent({
      runId: fixture.runId,
      turnId: fixture.turnId,
      event: {
        type: 'message_update',
        messageId: streaming.id,
        event: {
          type: 'text_delta',
          contentIndex: 0,
          delta: 'x',
          partial: streaming,
        },
      },
    });

    expect(fixture.writer.state.checkpoint.frontend.transcript).toBe(historicalTranscript);
    expect(fixture.writer.state.checkpoint.frontend.transcript[0]).toBe(historicalMessage);
    expect(normalizeFold(fixture.writer.state))
      .toEqual(normalizeFold(foldThreadJournal(fixture.journal.records)));
  });
});

describe('foldThreadJournal cold fold', () => {
  test('marks pending control, input ownership, and response claims as startup obligations', () => {
    const fixture = writerFixture();
    const meta = fixture.journal.records[0];
    if (meta === undefined || meta.type !== 'thread_meta') throw new Error('missing fixture meta');
    const clean = foldThreadJournal([meta]);
    expect(threadJournalRequiresRecovery(clean)).toBe(false);

    const request = {
      type: 'control_request' as const,
      requestId: 'approval-recovery-hint',
      kind: 'approval' as const,
      owningRunId: fixture.runId,
      owningTurnId: fixture.turnId,
      policyRevision: 'policy-v1',
      payload: approvalPayload(
        'approval-recovery-hint',
        fixture.workspaceId,
        fixture.threadId,
        fixture.runId,
        fixture.turnId,
        'call-recovery-hint',
        'recover pending approval',
      ),
    };
    expect(threadJournalRequiresRecovery({
      ...clean,
      checkpoint: {
        ...clean.checkpoint,
        frontend: { ...clean.checkpoint.frontend, pendingControls: [request] },
      },
    })).toBe(true);

    const ownerOpId = assertExternalOpId('op_e_b1000000000000000000000000000001');
    expect(threadJournalRequiresRecovery({
      ...clean,
      inputOwners: new Map([[ownerOpId, { sourceOpId: ownerOpId }]]),
    })).toBe(true);
    expect(threadJournalRequiresRecovery({
      ...clean,
      controlClaims: new Map([[request.requestId, {
        responseOpId: ownerOpId,
        decision: 'allow_once',
        acceptedAt: 2,
      }]]),
    })).toBe(true);
  });

  test('retains only a fixed replay tail while high-water continues with total history', () => {
    const fixture = writerFixture();
    const meta = fixture.journal.records[0];
    if (meta === undefined || meta.type !== 'thread_meta') throw new Error('missing fixture meta');
    const total = THREAD_REPLAY_LIMIT + 1_000;
    const records: RuntimeJournalRecord[] = [meta];
    for (let seq = 1; seq <= total; seq++) {
      records.push({
        type: 'commit',
        firstSeq: seq,
        envelopes: [{
          workspaceId: meta.workspaceId,
          threadId: meta.threadId,
          seq,
          timestamp: seq,
          event: {
            type: 'runtime_diagnostic',
            severity: 'warning',
            code: `retained-${seq}`,
            message: '',
            scope: 'thread',
          },
        }],
      });
    }

    const state = foldThreadJournal(records);
    expect(state.highWaterSeq).toBe(total);
    expect(state.envelopes).toHaveLength(THREAD_REPLAY_LIMIT);
    expect(state.envelopes[0]?.seq).toBe(total - THREAD_REPLAY_LIMIT + 1);
    expect(state.envelopes.at(-1)?.seq).toBe(total);
  });

  test('bounds replay retention by serialized bytes when individual envelopes are large', () => {
    const fixture = writerFixture();
    const meta = fixture.journal.records[0];
    if (meta === undefined || meta.type !== 'thread_meta') throw new Error('missing fixture meta');
    const payload = 'x'.repeat(256 * 1_024);
    const records: RuntimeJournalRecord[] = [meta];
    for (let seq = 1; seq <= 24; seq++) {
      records.push({
        type: 'commit',
        firstSeq: seq,
        envelopes: [{
          workspaceId: meta.workspaceId,
          threadId: meta.threadId,
          seq,
          timestamp: seq,
          event: {
            type: 'runtime_diagnostic',
            severity: 'warning',
            code: `large-retained-${seq}`,
            message: payload,
            scope: 'thread',
          },
        }],
      });
    }

    const state = foldThreadJournal(records);
    expect(state.highWaterSeq).toBe(24);
    expect(state.envelopes.length).toBeLessThan(24);
    expect(state.replayBytes).toBeLessThanOrEqual(THREAD_REPLAY_BYTE_LIMIT);
    expect(state.envelopes.at(-1)?.seq).toBe(24);
  });

  test.serial('does not revisit frozen historical transcript for every message update', async () => {
    const fixture = writerFixture();
    const meta = fixture.journal.records[0];
    if (meta === undefined || meta.type !== 'thread_meta') throw new Error('missing fixture meta');
    const sentinel = `cold-fold-sentinel-${'历史'.repeat(2_048)}`;
    await fixture.writer.commitDriverEvent({
      runId: fixture.runId,
      turnId: fixture.turnId,
      event: { type: 'message_end', message: userMessage('historical-message', sentinel) },
    });
    const streamingId = 'cold-streaming-message';
    await fixture.writer.commitDriverEvent({
      runId: fixture.runId,
      turnId: fixture.turnId,
      event: { type: 'message_start', message: assistantMessage(meta, streamingId, '') },
    });
    for (let index = 0; index < 64; index++) {
      const text = `partial-${index}`;
      await fixture.writer.commitDriverEvent({
        runId: fixture.runId,
        turnId: fixture.turnId,
        event: {
          type: 'message_update',
          messageId: streamingId,
          event: {
            type: 'text_delta',
            contentIndex: 0,
            delta: text,
            partial: assistantMessage(meta, streamingId, text),
          },
        },
      });
    }

    const originalDescriptor = Object.getOwnPropertyDescriptor(String.prototype, 'charCodeAt');
    if (originalDescriptor === undefined || typeof originalDescriptor.value !== 'function') {
      throw new Error('String.prototype.charCodeAt descriptor is unavailable');
    }
    const originalCharCodeAt = originalDescriptor.value as (index: number) => number;
    let sentinelCodeUnitVisits = 0;
    Object.defineProperty(String.prototype, 'charCodeAt', {
      ...originalDescriptor,
      value: function instrumentedCharCodeAt(this: string, index: number): number {
        if (String(this) === sentinel) sentinelCodeUnitVisits++;
        return originalCharCodeAt.call(this, index);
      },
    });
    try {
      foldThreadJournal(fixture.journal.records);
    } finally {
      Object.defineProperty(String.prototype, 'charCodeAt', originalDescriptor);
    }

    // The record containing the historical message and the final checkpoint may each validate it
    // a small constant number of times. Revalidating the whole checkpoint for all 64 streaming
    // updates would exceed this bound by a wide margin.
    expect(sentinelCodeUnitVisits).toBeLessThan(sentinel.length * 12);
  });

  test('rejects invalid strict JSON in an overwritten intermediate update', async () => {
    const fixture = writerFixture();
    const meta = fixture.journal.records[0];
    if (meta === undefined || meta.type !== 'thread_meta') throw new Error('missing fixture meta');
    const streamingId = 'invalid-intermediate-message';
    await fixture.writer.commitDriverEvent({
      runId: fixture.runId,
      turnId: fixture.turnId,
      event: { type: 'message_start', message: assistantMessage(meta, streamingId, '') },
    });
    for (const text of ['first', 'second']) {
      await fixture.writer.commitDriverEvent({
        runId: fixture.runId,
        turnId: fixture.turnId,
        event: {
          type: 'message_update',
          messageId: streamingId,
          event: {
            type: 'text_delta',
            contentIndex: 0,
            delta: text,
            partial: assistantMessage(meta, streamingId, text),
          },
        },
      });
    }
    const records = structuredClone(fixture.journal.records) as RuntimeJournalRecord[];
    const firstUpdate = records
      .filter((record) => record.type === 'commit')
      .flatMap((record) => record.envelopes)
      .find((envelope) => envelope.event.type === 'message_update');
    if (firstUpdate?.event.type !== 'message_update' || !('partial' in firstUpdate.event.event)) {
      throw new Error('missing message update fixture');
    }
    const partial = firstUpdate.event.event.partial as AssistantMessage & {
      content: { type: 'text'; text: string }[];
    };
    partial.content[0]!.text = '\ud800';

    expect(() => foldThreadJournal(records)).toThrow(/ill_formed_unicode/);
  });

  test('returns one detached deeply frozen final checkpoint', async () => {
    const fixture = writerFixture();
    await fixture.writer.commitDriverEvent({
      runId: fixture.runId,
      turnId: fixture.turnId,
      event: { type: 'message_end', message: userMessage('detached-message', 'original') },
    });
    const records = structuredClone(fixture.journal.records) as RuntimeJournalRecord[];
    const state = foldThreadJournal(records);
    const commit = records[1];
    if (commit === undefined || commit.type !== 'commit') throw new Error('missing commit fixture');
    const messageEnd = commit.envelopes.find((envelope) => envelope.event.type === 'message_end');
    if (messageEnd?.event.type !== 'message_end') throw new Error('missing message end fixture');
    const sourcePart = messageEnd.event.message.content[0];
    if (sourcePart?.type !== 'text') throw new Error('missing source text fixture');
    (sourcePart as { text: string }).text = 'mutated';

    const transcriptMessage = state.checkpoint.frontend.transcript[0];
    expect(transcriptMessage?.content[0]).toEqual({ type: 'text', text: 'original' });
    expect(Object.isFrozen(state.checkpoint)).toBe(true);
    expect(Object.isFrozen(state.checkpoint.frontend)).toBe(true);
    expect(Object.isFrozen(state.checkpoint.frontend.transcript)).toBe(true);
    expect(Object.isFrozen(transcriptMessage)).toBe(true);
    expect(Object.isFrozen(transcriptMessage?.content)).toBe(true);
    expect(Object.isFrozen(transcriptMessage?.content[0])).toBe(true);
  });
});

describe('foldThreadJournalAppend', () => {
  test('matches the cold fold for every prefix and different batch partitions', async () => {
    const fixture = writerFixture();
    await appendRepresentativeJournal(fixture);
    const [meta, ...suffix] = fixture.journal.records;
    if (meta === undefined || meta.type !== 'thread_meta') throw new Error('missing fixture meta');

    let incremental = foldThreadJournal([meta]);
    for (let index = 0; index < suffix.length; index++) {
      const previous = incremental;
      const previousSnapshot = normalizeFold(previous);
      const record = suffix[index];
      if (record === undefined) throw new Error('missing fixture record');
      incremental = foldThreadJournalAppend(incremental, [record]);
      expect(normalizeFold(previous)).toEqual(previousSnapshot);
      expect(incremental.envelopes.slice(0, previous.envelopes.length).every(
        (envelope, envelopeIndex) => envelope === previous.envelopes[envelopeIndex],
      )).toBe(true);
      expect(normalizeFold(incremental))
        .toEqual(normalizeFold(foldThreadJournal([meta, ...suffix.slice(0, index + 1)])));
    }

    let partitioned = foldThreadJournal([meta]);
    for (let index = 0; index < suffix.length; index += 3) {
      const batch = suffix.slice(index, index + 3);
      if (batch.length === 0) continue;
      partitioned = foldThreadJournalAppend(
        partitioned,
        batch as [RuntimeJournalRecord, ...RuntimeJournalRecord[]],
      );
    }
    expect(normalizeFold(partitioned))
      .toEqual(normalizeFold(foldThreadJournal(fixture.journal.records)));
  });

  test('keeps the current projection untouched when an appended suffix is invalid', () => {
    const fixture = writerFixture();
    const current = foldThreadJournal(fixture.journal.records);
    const before = normalizeFold(current);
    const invalid = {
      type: 'commit',
      firstSeq: 2,
      envelopes: [{
        workspaceId: current.meta.workspaceId,
        threadId: current.meta.threadId,
        seq: 2,
        timestamp: 2,
        event: {
          type: 'runtime_diagnostic',
          severity: 'warning',
          code: 'invalid-sequence',
          message: '',
          scope: 'thread',
        },
      }],
    } as const satisfies RuntimeJournalRecord;

    expect(() => foldThreadJournalAppend(current, [invalid]))
      .toThrow(/invalid_persisted_sequence/);
    expect(normalizeFold(current)).toEqual(before);
  });
});

describe('foldThreadJournal commit correspondence', () => {
  test('requires exact message-turn provenance for canonical thread seeds', () => {
    const fixture = writerFixture();
    const meta = fixture.journal.records[0] as ThreadMetaRecord;
    const prompt = userMessage('seed-prompt', 'seed prompt');
    const assistant = {
      role: 'assistant' as const,
      id: 'seed-answer',
      timestamp: 2,
      content: [{ type: 'text' as const, text: 'seed answer' }],
      model: meta.model,
      stopReason: 'stop' as const,
      usage: { input: 1, output: 1 },
    };
    const state = foldThreadJournal([meta, {
      type: 'thread_seed',
      transcript: [prompt, assistant],
      turnProvenance: [
        { messageId: prompt.id, turnId: fixture.turnId },
        { messageId: assistant.id, turnId: fixture.turnId },
      ],
      usage: { cumulative: { input: 1, output: 1 }, turns: 1, contextTokens: 2 },
    }]);
    const promptTurn = state.messageTurnIds.get(prompt.id);
    expect(promptTurn).toBe(fixture.turnId);
    expect(state.messageTurnIds.get(assistant.id)).toBe(promptTurn);
    expect(() => foldThreadJournal([meta, {
      type: 'thread_seed',
      transcript: [prompt, assistant],
      turnProvenance: [],
      usage: { cumulative: { input: 1, output: 1 }, turns: 1, contextTokens: 2 },
    }])).toThrow(/must cover the transcript in order/);
  });

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
      payload: approvalPayload(
        'approval-request-envelope',
        fixture.workspaceId,
        fixture.threadId,
        fixture.runId,
        fixture.turnId,
        'call-1',
        'approve fixture',
      ),
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

  test('recovers a consumed rule-scope window and rejects a mismatched replacement witness', () => {
    const fixture = writerFixture();
    const meta = fixture.journal.records[0] as ThreadMetaRecord;
    const observed = {
      type: 'commit' as const,
      firstSeq: 1,
      envelopes: [{
        workspaceId: meta.workspaceId,
        threadId: meta.threadId,
        seq: 1,
        timestamp: 1,
        event: {
          type: 'runtime_diagnostic' as const,
          severity: 'warning' as const,
          code: 'rule_scope_observed',
          message: 'observed two scopes',
          scope: 'thread' as const,
        },
      }] as const,
      mutations: [
        { type: 'rule_scope_observed' as const, scope: '/scope-a', owningTurnId: fixture.turnId,
          invocationId: 'invocation-a' },
        { type: 'rule_scope_observed' as const, scope: '/scope-b', owningTurnId: fixture.turnId,
          invocationId: 'invocation-b' },
      ] as const,
    } satisfies RuntimeJournalRecord;
    const replacement = {
      type: 'commit' as const,
      firstSeq: 2,
      envelopes: [{
        workspaceId: meta.workspaceId,
        threadId: meta.threadId,
        runId: fixture.runId,
        turnId: fixture.turnId,
        seq: 2,
        timestamp: 2,
        event: { type: 'turn_start' as const },
      }] as const,
      mutations: [{
        type: 'rule_scope_window_replaced' as const,
        consumedScopes: ['/scope-a', '/scope-b'],
        replacementScopes: ['/scope-c'],
        owningTurnId: fixture.turnId,
      }] as const,
    } satisfies RuntimeJournalRecord;

    expect([...foldThreadJournal([meta, observed, replacement]).observedRuleScopes])
      .toEqual(['/scope-c']);
    expect(() => foldThreadJournal([meta, observed, {
      ...replacement,
      mutations: [{
        type: 'rule_scope_window_replaced',
        consumedScopes: ['/scope-a'],
        replacementScopes: ['/scope-c'],
        owningTurnId: fixture.turnId,
      }],
    } satisfies RuntimeJournalRecord])).toThrow(/does not match its durable witness/);
  });
});

async function appendRepresentativeJournal(fixture: ReturnType<typeof writerFixture>): Promise<void> {
  const opId = assertExternalOpId('op_e_11111111111111111111111111111111');
  const responseOpId = assertExternalOpId('op_e_22222222222222222222222222222222');
  const resultOpId = assertDerivedOpId(`op_d_${'3'.repeat(64)}`);
  const parentThreadId = assertThreadId('thread-thread-journal-parent');
  const ceiling = { revision: 'ceiling-v1', constraints: [] } as const;
  const meta = fixture.journal.records[0];
  if (meta === undefined || meta.type !== 'thread_meta') throw new Error('missing fixture meta');
  const prompt = {
    type: 'prompt',
    opId,
    workspaceId: meta.workspaceId,
    threadId: meta.threadId,
    text: 'representative prompt',
  } as const;

  await fixture.writer.appendPrepare({
    type: 'mailbox_prepare',
    opId,
    op: prompt,
    timestamp: 1,
  });
  await fixture.writer.commit([{
    event: { type: 'op_accepted', opType: 'prompt' },
    opId,
    runId: fixture.runId,
  }], [
    { type: 'accepted_pending', opId, opType: 'prompt' },
    {
      type: 'run_reserved',
      runId: fixture.runId,
      ownerOpId: opId,
      reason: 'prompt',
      permissionCeiling: ceiling,
    },
  ]);
  await fixture.writer.commit([{
    event: { type: 'op_started', opType: 'prompt' },
    opId,
    runId: fixture.runId,
  }], [
    { type: 'started', opId },
    { type: 'run_started', runId: fixture.runId },
  ]);
  await fixture.writer.appendPrepare({
    type: 'turn_prepare',
    runId: fixture.runId,
    turnId: fixture.turnId,
    turnOrdinal: 1,
    workspaceCeiling: ceiling,
    runCeiling: ceiling,
    turnCeiling: ceiling,
    timestamp: 2,
  });
  await fixture.writer.commit([{
    event: { type: 'turn_start' },
    runId: fixture.runId,
    turnId: fixture.turnId,
  }], [{
    type: 'turn_activated',
    runId: fixture.runId,
    turnId: fixture.turnId,
    turnOrdinal: 1,
  }]);
  await fixture.writer.commitDriverEvent({
    event: { type: 'message_end', message: userMessage('prompt-message', prompt.text) },
    runId: fixture.runId,
    turnId: fixture.turnId,
  }, undefined, [{ type: 'input_materialized', ownerOpId: opId, messageId: 'prompt-message' }]);

  const partial = assistantMessage(meta, 'assistant-message', 'streaming output');
  await fixture.writer.commitDriverEvent({
    event: { type: 'message_start', message: assistantMessage(meta, partial.id, '') },
    runId: fixture.runId,
    turnId: fixture.turnId,
  });
  await fixture.writer.commitDriverEvent({
    event: {
      type: 'message_update',
      messageId: partial.id,
      event: {
        type: 'text_end',
        contentIndex: 0,
        content: 'streaming output',
        partial,
      },
    },
    runId: fixture.runId,
    turnId: fixture.turnId,
  });
  await fixture.writer.commitDriverEvent({
    event: { type: 'message_end', message: partial },
    runId: fixture.runId,
    turnId: fixture.turnId,
  });
  await fixture.writer.commitDriverEvent({
    event: { type: 'plan_update', steps: [{ step: 'inspect', status: 'completed' }] },
    runId: fixture.runId,
    turnId: fixture.turnId,
  });
  await fixture.writer.commitDriverEvent({
    event: {
      type: 'usage_update',
      usage: {
        lastTurn: { input: 10, output: 4 },
        cumulative: { input: 10, output: 4 },
        turns: 1,
        contextTokens: 14,
      },
    },
    runId: fixture.runId,
    turnId: fixture.turnId,
  });

  const request = {
    type: 'control_request',
    requestId: 'approval-representative',
    kind: 'approval',
    owningRunId: fixture.runId,
    owningTurnId: fixture.turnId,
    policyRevision: 'policy-v1',
    payload: approvalPayload(
      'approval-representative',
      fixture.workspaceId,
      fixture.threadId,
      fixture.runId,
      fixture.turnId,
      'call-1',
      'approve representative fixture',
    ),
  } as const;
  await fixture.writer.commitDriverEvent({
    event: request,
    runId: fixture.runId,
    turnId: fixture.turnId,
  });
  await fixture.writer.commit([{
    event: {
      type: 'runtime_diagnostic',
      severity: 'warning',
      code: 'control-claimed',
      message: '',
      scope: 'thread',
    },
  }], [{
    type: 'control_response_claimed',
    requestId: request.requestId,
    responseOpId,
    decision: 'allow_once',
    acceptedAt: 3,
  }]);
  await fixture.writer.commitDriverEvent({
    event: {
      type: 'control_resolved',
      requestId: request.requestId,
      kind: request.kind,
      owningRunId: fixture.runId,
      owningTurnId: fixture.turnId,
      policyRevision: request.policyRevision,
      decision: 'allow_once',
    },
    runId: fixture.runId,
    turnId: fixture.turnId,
    opId: responseOpId,
  });

  await fixture.writer.commit([{
    event: {
      type: 'runtime_diagnostic',
      severity: 'warning',
      code: 'thread-result-pending',
      message: '',
      scope: 'thread',
    },
  }], [{
    type: 'thread_result_pending',
    resultOpId,
    parentThreadId,
    childThreadId: fixture.threadId,
    terminalRunId: fixture.runId,
    status: 'completed',
    summary: 'done',
  }]);
  await fixture.writer.appendPrepare({
    type: 'thread_result_delivered',
    resultOpId,
    parentThreadId,
    parentCommitSeq: 1,
  });
  await fixture.writer.commit([{
    event: {
      type: 'runtime_diagnostic',
      severity: 'warning',
      code: 'rule-scope-observed',
      message: '',
      scope: 'thread',
    },
  }], [{
    type: 'rule_scope_observed',
    scope: '/workspace/scope-a',
    owningTurnId: fixture.turnId,
    invocationId: 'invocation-a',
  }]);
  await fixture.writer.commit([{
    event: { type: 'turn_start' },
    runId: fixture.runId,
    turnId: fixture.turnId,
  }], [{
    type: 'rule_scope_window_replaced',
    consumedScopes: ['/workspace/scope-a'],
    replacementScopes: ['/workspace/scope-b'],
    owningTurnId: fixture.turnId,
  }]);
  await fixture.writer.commitDriverEvent({
    event: {
      type: 'compaction_end',
      activityRunId: fixture.runId,
      ok: true,
      droppedMessages: 1,
    },
    runId: fixture.runId,
  }, {
    type: 'compaction_committed',
    compaction: {
      id: 'compaction-1',
      timestamp: 4,
      tailStartId: partial.id,
      summary: 'representative summary',
    },
  });
  await fixture.writer.commitDriverEvent({
    event: { type: 'agent_end', reason: 'completed', messages: [partial] },
    runId: fixture.runId,
  });
  await fixture.writer.commit([{
    event: {
      type: 'op_completed',
      opType: 'prompt',
      terminalRunId: fixture.runId,
      outcome: 'applied',
    },
    opId,
    runId: fixture.runId,
  }], [
    { type: 'completed', opId, outcome: 'applied' },
    { type: 'run_terminal', runId: fixture.runId, status: 'completed' },
  ]);
}

function assistantMessage(
  meta: ThreadMetaRecord,
  id: string,
  text: string,
): AssistantMessage {
  return {
    role: 'assistant',
    id,
    timestamp: 2,
    content: text === '' ? [] : [{ type: 'text', text }],
    model: meta.model,
    stopReason: 'stop',
    usage: { input: 10, output: 4 },
  };
}

function normalizeFold(state: ReturnType<typeof foldThreadJournal>): unknown {
  return {
    meta: state.meta,
    highWaterSeq: state.highWaterSeq,
    envelopes: state.envelopes,
    replayBytes: state.replayBytes,
    checkpoint: state.checkpoint,
    summary: state.summary,
    mailbox: [...state.mailbox],
    runs: [...state.runs],
    turns: [...state.turns],
    messageTurnIds: [...state.messageTurnIds],
    inputOwners: [...state.inputOwners],
    pendingThreadResults: [...state.pendingThreadResults],
    deliveredThreadResults: [...state.deliveredThreadResults],
    usedRequestIds: [...state.usedRequestIds],
    controlClaims: [...state.controlClaims],
    opTerminals: [...state.opTerminals],
    threadResults: [...state.threadResults],
    controlRequests: [...state.controlRequests],
    controlResolutions: [...state.controlResolutions],
    observedRuleScopes: [...state.observedRuleScopes],
  };
}

function writerFixture(): {
  readonly writer: ThreadJournalWriter;
  readonly journal: RecordingJournal;
  readonly events: EventHub;
  readonly workspaceId: ReturnType<typeof assertWorkspaceId>;
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
    version: 3,
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
  return { writer, journal, events, workspaceId, threadId, runId, turnId };
}

function approvalPayload(
  requestId: string,
  workspaceId: WorkspaceId,
  threadId: ThreadId,
  runId: RunId,
  turnId: TurnId,
  toolCallId: string,
  description: string,
) {
  return {
    toolCallId,
    description,
    presentation: {
      requestId,
      target: { workspaceId, threadId, runId, turnId },
      capability: { id: 'test.capability', version: '1', registrationDigest: 'registration-v1' },
      normalizedResources: [],
      risk: { code: 'test_approval', reason: description, description },
      allowOnce: { invocationId: `invocation-${requestId}`, toolCallId },
      revisions: {
        catalog: 1,
        effectivePolicy: 'policy-v1',
        policyBasis: 'basis-v1',
        ceiling: 'ceiling-v1',
        grants: 'grants-v1',
      },
    },
  } as const;
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
