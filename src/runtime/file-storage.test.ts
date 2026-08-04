import { afterEach, describe, expect, test } from 'bun:test';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PolicyGrant } from '../capabilities/types.js';
import type {
  AssistantMessage,
  EventEnvelope,
  ExternalOpId,
  ThreadId,
  TurnId,
  WorkspaceId,
} from '../protocol/index.js';
import { PROTOCOL_VERSION, runtimeOpPayloadHash, sha256Hex } from '../protocol/index.js';
import { RuntimeStorageError, WorkspaceBindingMismatchError, WorkspaceInUseError } from './errors.js';
import { createFileRuntimeStorage } from './file-storage.js';
import type {
  RuntimeJournalRecord,
  SupervisorOpLedgerRecord,
  ThreadMetaRecord,
  ThreadSeedRecord,
} from './ports.js';
import { foldThreadJournalAppend } from '../session/thread-journal.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('FileRuntimeStorage canonical persistence', () => {
  test('claims an immutable workspace binding before initializing mutable state', async () => {
    const root = temporaryDirectory();
    const storage = createFileRuntimeStorage({ root });
    const workspaceId = 'ws_atomic_binding' as WorkspaceId;
    const cwdA = path.join(root, 'cwd-a');
    const cwdB = path.join(root, 'cwd-b');
    const first = await storage.openWorkspace({ cwd: cwdA, workspaceId });

    await expect(storage.openWorkspace({ cwd: cwdB, workspaceId }))
      .rejects.toBeInstanceOf(WorkspaceBindingMismatchError);
    const workspaceDir = workspacePath(root, workspaceId);
    expect(existsSync(path.join(workspaceDir, 'binding.json'))).toBe(true);
    expect(existsSync(path.join(workspaceDir, 'ledger.json'))).toBe(false);
    expect(existsSync(path.join(workspaceDir, 'catalog.json'))).toBe(false);
    expect(existsSync(path.join(workspaceDir, 'threads'))).toBe(false);
    await first.close();
  });

  test('uses an exclusive workspace lease and fences a stale holder', async () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, 'cwd');
    const workspaceId = 'ws_exclusive_lease' as WorkspaceId;
    const storage = createFileRuntimeStorage({ root });
    const first = await storage.openWorkspace({ cwd, workspaceId });
    const second = await storage.openWorkspace({ cwd, workspaceId });
    const firstLease = await first.acquireSupervisorLease('first-holder');

    await expect(second.acquireSupervisorLease('second-holder'))
      .rejects.toBeInstanceOf(WorkspaceInUseError);
    await first.releaseSupervisorLease(firstLease);
    const secondLease = await second.acquireSupervisorLease('second-holder');
    expect(await first.validateWriteFence(firstLease)).toEqual({ current: false, code: 'stale_fence' });
    await second.releaseSupervisorLease(secondLease);
    await first.close();
    await second.close();
  });

  test('round-trips canonical metadata and a canonical thread seed across reopen', async () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, 'cwd');
    const workspaceId = 'ws_thread_seed_roundtrip' as WorkspaceId;
    const threadId = 'thread-seed-roundtrip' as ThreadId;
    const storage = createFileRuntimeStorage({ root });
    const workspace = await storage.openWorkspace({ cwd, workspaceId });
    const lease = await workspace.acquireSupervisorLease('thread-seed-first');
    const meta = threadMeta({ workspaceId, threadId, cwd });
    const seed = threadSeed();
    const journal = await workspace.createThreadJournal(lease, {
      threadId,
      meta,
      initialRecords: [seed],
    });

    const loaded = await journal.loadState();
    expect(loaded.meta).toEqual(meta);
    expect(loaded.checkpoint.frontend.transcript).toEqual(seed.transcript);
    expect([...loaded.messageTurnIds]).toEqual(seed.turnProvenance.map((entry) => [
      entry.messageId,
      entry.turnId,
    ]));
    const [catalog] = await workspace.listThreads();
    expect(catalog).toMatchObject({
      summary: { threadId, createdAt: 1, state: 'idle' },
      format: 'runtime-v2',
      storageKey: `th-${sha256Hex(threadId)}.jsonl`,
      meta,
      journal: {
        version: 3,
        highWaterSeq: 0,
        replayStartSeq: 1,
      },
    });
    await workspace.releaseSupervisorLease(lease);
    await workspace.close();

    const locators = await storage.listStoredThreads();
    expect(locators).toHaveLength(1);
    expect(locators[0]).toMatchObject({
      ownerWorkspaceId: workspaceId,
      ownerRecordedCwd: cwd,
      threadId,
      catalog,
    });
    expectDeepFrozen(locators);

    const reopened = await storage.openWorkspace({ cwd, workspaceId });
    const reopenedLease = await reopened.acquireSupervisorLease('thread-seed-second');
    const reopenedJournal = await reopened.openThreadJournal(threadId);
    expect((await reopenedJournal?.loadState())?.checkpoint.frontend.transcript).toEqual(seed.transcript);
    await reopened.releaseSupervisorLease(reopenedLease);
    await reopened.close();
  });

  test('checks an existing create prefix without parsing its body before the single recovery load', async () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, 'cwd');
    const workspaceId = 'ws_existing_create_single_load' as WorkspaceId;
    const threadId = 'thread-existing-create-single-load' as ThreadId;
    const reads: Array<{ readonly kind: string; readonly bytes: number }> = [];
    const storage = createFileRuntimeStorage({ root, onJournalRead: (read) => reads.push(read) });
    const meta = threadMeta({ workspaceId, threadId, cwd });
    const first = await storage.openWorkspace({ cwd, workspaceId });
    const firstLease = await first.acquireSupervisorLease('existing-create-first');
    const created = await first.createThreadJournal(firstLease, { threadId, meta });
    await created.acquireWriteLease(firstLease);
    await created.loadState();
    await created.append([
      journalCommit(workspaceId, threadId, 1, diagnostic('existing-create-history')),
    ], { flush: true });
    await created.releaseWriteLease();
    await first.releaseSupervisorLease(firstLease);
    await first.close();
    unlinkSync(`${journalPath(root, workspaceId, threadId)}.recovery.json`);

    const second = await storage.openWorkspace({ cwd, workspaceId });
    const secondLease = await second.acquireSupervisorLease('existing-create-second');
    reads.length = 0;
    const existing = await second.createThreadJournal(secondLease, { threadId, meta });
    await existing.acquireWriteLease(secondLease);
    expect((await existing.loadState()).highWaterSeq).toBe(1);
    expect(reads.filter((read) => read.kind === 'body')).toHaveLength(1);
    await existing.releaseWriteLease();
    await second.releaseSupervisorLease(secondLease);
    await second.close();
  });

  test('writes only the canonical protocol version while reading compatible patch journals', async () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, 'cwd');
    const workspaceId = 'ws_protocol_patch' as WorkspaceId;
    const threadId = 'thread-protocol-patch' as ThreadId;
    const workspace = await createFileRuntimeStorage({ root }).openWorkspace({ cwd, workspaceId });
    const lease = await workspace.acquireSupervisorLease('protocol-patch');

    await expect(workspace.createThreadJournal(lease, {
      threadId,
      meta: threadMeta({ workspaceId, threadId, cwd, protocolVersion: '2.0.7' }),
    })).rejects.toMatchObject({
      name: 'RuntimeStorageError',
      code: 'protocol_version_write_mismatch',
    });
    expect(existsSync(journalPath(root, workspaceId, threadId))).toBe(false);

    const meta = threadMeta({ workspaceId, threadId, cwd });
    await workspace.createThreadJournal(lease, { threadId, meta });
    rewriteJournal(journalPath(root, workspaceId, threadId), '2.0.7');
    expect((await (await workspace.openThreadJournal(threadId))?.loadState())?.meta)
      .toEqual({ ...meta, protocolVersion: '2.0.7' });

    await workspace.releaseSupervisorLease(lease);
    await workspace.close();
  });

  test.each([
    ['not-semver', 'malformed_protocol_version'],
    ['1.9.9', 'retired_protocol_major'],
    ['3.0.0', 'unsupported_protocol_major'],
    ['2.1.0', 'unsupported_protocol_minor'],
  ] as const)('reports %s compatibility failures on the resume/open path', async (
    protocolVersion,
    code,
  ) => {
    const root = temporaryDirectory();
    const cwd = path.join(root, 'cwd');
    const workspaceId = `ws_protocol_resume_${code}` as WorkspaceId;
    const threadId = `thread-protocol-resume-${code}` as ThreadId;
    const workspace = await createFileRuntimeStorage({ root }).openWorkspace({ cwd, workspaceId });
    const lease = await workspace.acquireSupervisorLease(`protocol-resume-${protocolVersion}`);
    await workspace.createThreadJournal(lease, {
      threadId,
      meta: threadMeta({ workspaceId, threadId, cwd }),
    });
    rewriteJournal(journalPath(root, workspaceId, threadId), protocolVersion);

    await expect(workspace.openThreadJournal(threadId)).rejects.toMatchObject({
      name: 'RuntimeStorageError',
      code,
      message: expect.stringContaining(protocolVersion),
    });

    await workspace.releaseSupervisorLease(lease);
    await workspace.close();
  });

  test('checks an existing journal version before its damaged body on create', async () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, 'cwd');
    const workspaceId = 'ws_protocol_create' as WorkspaceId;
    const threadId = 'thread-protocol-create' as ThreadId;
    const workspace = await createFileRuntimeStorage({ root }).openWorkspace({ cwd, workspaceId });
    const lease = await workspace.acquireSupervisorLease('protocol-create');
    const meta = threadMeta({ workspaceId, threadId, cwd });
    await workspace.createThreadJournal(lease, { threadId, meta });
    rewriteJournal(journalPath(root, workspaceId, threadId), '2.1.0', '{damaged body}\n');

    await expect(workspace.createThreadJournal(lease, { threadId, meta })).rejects.toMatchObject({
      name: 'RuntimeStorageError',
      code: 'unsupported_protocol_minor',
      message: expect.stringContaining('2.1.0'),
    });

    await workspace.releaseSupervisorLease(lease);
    await workspace.close();
  });

  test('checks protocol compatibility before damaged-body recovery on workspace reopen', async () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, 'cwd');
    const workspaceId = 'ws_protocol_reopen' as WorkspaceId;
    const threadId = 'thread-protocol-reopen' as ThreadId;
    const storage = createFileRuntimeStorage({ root });
    const first = await storage.openWorkspace({ cwd, workspaceId });
    const firstLease = await first.acquireSupervisorLease('protocol-reopen-first');
    await first.createThreadJournal(firstLease, {
      threadId,
      meta: threadMeta({ workspaceId, threadId, cwd }),
    });
    await first.releaseSupervisorLease(firstLease);
    await first.close();
    rewriteJournal(journalPath(root, workspaceId, threadId), '3.0.0', '{damaged body}\n');

    const reopened = await storage.openWorkspace({ cwd, workspaceId });
    await expect(reopened.acquireSupervisorLease('protocol-reopen-second')).rejects.toMatchObject({
      name: 'RuntimeStorageError',
      code: 'unsupported_protocol_major',
      message: expect.stringContaining('3.0.0'),
    });
    await reopened.close();
  });

  test('keeps record schema version separate from protocol compatibility', async () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, 'cwd');
    const workspaceId = 'ws_record_schema_version' as WorkspaceId;
    const threadId = 'thread-record-schema-version' as ThreadId;
    const workspace = await createFileRuntimeStorage({ root }).openWorkspace({ cwd, workspaceId });
    const lease = await workspace.acquireSupervisorLease('record-schema-version');
    const meta = {
      ...threadMeta({ workspaceId, threadId, cwd }),
      version: 2,
    } as unknown as ThreadMetaRecord;

    await expect(workspace.createThreadJournal(lease, { threadId, meta })).rejects.toMatchObject({
      name: 'RuntimeStorageError',
      code: 'unsupported_journal_version',
      message: expect.stringContaining('clear the workspace journal'),
    });

    await workspace.releaseSupervisorLease(lease);
    await workspace.close();
  });

  test('rejects an existing v2 journal before parsing its damaged body', async () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, 'cwd');
    const workspaceId = 'ws_reject_v2_journal' as WorkspaceId;
    const threadId = 'thread-reject-v2-journal' as ThreadId;
    const bodyReads: number[] = [];
    const storage = createFileRuntimeStorage({
      root,
      onJournalRead: (observation) => {
        if (observation.kind === 'body') bodyReads.push(observation.bytes);
      },
    });
    const first = await storage.openWorkspace({ cwd, workspaceId });
    const firstLease = await first.acquireSupervisorLease('reject-v2-first');
    await first.createThreadJournal(firstLease, {
      threadId,
      meta: threadMeta({ workspaceId, threadId, cwd }),
    });
    await first.releaseSupervisorLease(firstLease);
    await first.close();
    const file = journalPath(root, workspaceId, threadId);
    const [header] = readFileSync(file, 'utf8').split('\n');
    if (header === undefined) throw new Error('journal has no header');
    const legacy = { ...JSON.parse(header) as Record<string, unknown>, version: 2 };
    writeFileSync(file, `${JSON.stringify(legacy)}\n{damaged body}\n`);
    bodyReads.length = 0;

    const reopened = await storage.openWorkspace({ cwd, workspaceId });
    await expect(reopened.acquireSupervisorLease('reject-v2-second')).rejects.toMatchObject({
      code: 'unsupported_journal_version',
      message: expect.stringContaining('clear the workspace journal'),
    });
    expect(bodyReads).toEqual([]);
    await reopened.close();
  });

  test('reports a v2 catalog index as an unsupported clean-break journal', async () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, 'cwd');
    const workspaceId = 'ws_reject_v2_catalog' as WorkspaceId;
    const threadId = 'thread-reject-v2-catalog' as ThreadId;
    const bodyReads: number[] = [];
    const storage = createFileRuntimeStorage({
      root,
      onJournalRead: (observation) => {
        if (observation.kind === 'body') bodyReads.push(observation.bytes);
      },
    });
    const first = await storage.openWorkspace({ cwd, workspaceId });
    const lease = await first.acquireSupervisorLease('reject-v2-catalog-first');
    await first.createThreadJournal(lease, {
      threadId,
      meta: threadMeta({ workspaceId, threadId, cwd }),
    });
    await first.releaseSupervisorLease(lease);
    await first.close();

    const catalogFile = path.join(workspacePath(root, workspaceId), 'catalog.json');
    const catalog = JSON.parse(readFileSync(catalogFile, 'utf8')) as {
      threads: Array<{ meta?: { version: number }; journal?: { version: number } }>;
    };
    catalog.threads[0]!.meta!.version = 2;
    catalog.threads[0]!.journal!.version = 2;
    writeFileSync(catalogFile, `${JSON.stringify(catalog)}\n`);
    bodyReads.length = 0;

    expect(() => storage.listStoredThreads()).toThrow(
      expect.objectContaining({ code: 'unsupported_journal_version' }),
    );
    expect(bodyReads).toEqual([]);
  });

  test('stores 10,000 cumulative text partials in linear journal space', async () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, 'cwd');
    const workspaceId = 'ws_linear_compact_journal' as WorkspaceId;
    const threadId = 'thread-linear-compact-journal' as ThreadId;
    const workspace = await createFileRuntimeStorage({ root }).openWorkspace({ cwd, workspaceId });
    const lease = await workspace.acquireSupervisorLease('linear-compact');
    const journal = await workspace.createThreadJournal(lease, {
      threadId,
      meta: threadMeta({ workspaceId, threadId, cwd }),
    });
    await journal.acquireWriteLease(lease);
    await journal.loadState();
    const messageId = 'assistant-linear-compact';
    let seq = 1;
    await journal.append([
      journalCommit(workspaceId, threadId, seq++, {
        type: 'message_start',
        message: assistantMessage(messageId, []),
      }),
      journalCommit(workspaceId, threadId, seq++, {
        type: 'message_update',
        messageId,
        event: {
          type: 'text_start',
          contentIndex: 0,
          partial: assistantMessage(messageId, [{ type: 'text', text: '' }]),
        },
      }),
    ], { flush: true });
    const file = journalPath(root, workspaceId, threadId);
    const baseSize = statSync(file).size;
    let text = '';
    let firstHalfSize = 0;
    for (let offset = 0; offset < 10_000; offset += 250) {
      const records: RuntimeJournalRecord[] = [];
      for (let index = 0; index < 250; index++) {
        text += 'x';
        records.push(journalCommit(workspaceId, threadId, seq++, {
          type: 'message_update',
          messageId,
          event: {
            type: 'text_delta',
            contentIndex: 0,
            delta: 'x',
            partial: assistantMessage(messageId, [{ type: 'text', text }]),
          },
        }));
      }
      await journal.append(records, { flush: true });
      if (offset === 4_750) {
        firstHalfSize = statSync(file).size - baseSize;
        expect(firstHalfSize).toBeGreaterThan(0);
      }
    }
    const tenThousandSize = statSync(file).size;
    const secondHalfBytes = tenThousandSize - baseSize - firstHalfSize;
    expect(secondHalfBytes / firstHalfSize).toBeLessThan(1.1);

    const terminal = assistantMessage(messageId, [{ type: 'text', text }]);
    await journal.append([
      journalCommit(workspaceId, threadId, seq++, {
        type: 'message_update',
        messageId,
        event: {
          type: 'text_end',
          contentIndex: 0,
          content: text,
          partial: terminal,
        },
      }),
      {
        ...journalCommit(workspaceId, threadId, seq++, {
          type: 'message_end',
          message: terminal,
        }),
        mutations: [{ type: 'message_appended', message: terminal }],
      },
    ], { flush: true });
    const physical = readFileSync(file, 'utf8');
    expect(physical).not.toContain('"partial"');
    expect(Buffer.byteLength(physical)).toBeLessThan(8_000_000);

    await journal.releaseWriteLease();
    await workspace.releaseSupervisorLease(lease);
    await workspace.close();
  }, 30_000);

  test('keeps at most one snapshot seed partial while preserving its retained replay range', async () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, 'cwd');
    const workspaceId = 'ws_compact_snapshot_replay' as WorkspaceId;
    const threadId = 'thread-compact-snapshot-replay' as ThreadId;
    const reads: Array<{ readonly kind: string; readonly bytes: number }> = [];
    const storage = createFileRuntimeStorage({ root, onJournalRead: (read) => reads.push(read) });
    const workspace = await storage.openWorkspace({ cwd, workspaceId });
    const lease = await workspace.acquireSupervisorLease('compact-snapshot-replay');
    const journal = await workspace.createThreadJournal(lease, {
      threadId,
      meta: threadMeta({ workspaceId, threadId, cwd }),
    });
    await journal.acquireWriteLease(lease);
    const initial = await journal.loadState();
    const messageId = 'assistant-compact-snapshot-replay';
    const terminal = assistantMessage(messageId, [{ type: 'text', text: 'ab' }]);
    const records: RuntimeJournalRecord[] = [
      journalCommit(workspaceId, threadId, 1, {
        type: 'message_start',
        message: assistantMessage(messageId, []),
      }),
      journalCommit(workspaceId, threadId, 2, {
        type: 'message_update',
        messageId,
        event: {
          type: 'text_start',
          contentIndex: 0,
          partial: assistantMessage(messageId, [{ type: 'text', text: '' }]),
        },
      }),
      journalCommit(workspaceId, threadId, 3, {
        type: 'message_update',
        messageId,
        event: {
          type: 'text_delta', contentIndex: 0, delta: 'a',
          partial: assistantMessage(messageId, [{ type: 'text', text: 'a' }]),
        },
      }),
      journalCommit(workspaceId, threadId, 4, {
        type: 'message_update',
        messageId,
        event: {
          type: 'text_delta', contentIndex: 0, delta: 'b', partial: terminal,
        },
      }),
      journalCommit(workspaceId, threadId, 5, {
        type: 'message_update',
        messageId,
        event: {
          type: 'text_end', contentIndex: 0, content: 'ab', partial: terminal,
        },
      }),
      {
        ...journalCommit(workspaceId, threadId, 6, { type: 'message_end', message: terminal }),
        mutations: [{ type: 'message_appended', message: terminal }],
      },
    ];
    await journal.append(records, { flush: true });
    await journal.saveRecoveryState(foldThreadJournalAppend(
      initial,
      records as [RuntimeJournalRecord, ...RuntimeJournalRecord[]],
    ));
    await journal.releaseWriteLease();

    const file = journalPath(root, workspaceId, threadId);
    const snapshotText = readFileSync(`${file}.recovery.json`, 'utf8');
    expect(snapshotText.match(/"partial"/gu) ?? []).toHaveLength(0);

    reads.length = 0;
    const replay = await workspace.openThreadJournal(threadId);
    if (replay === undefined) throw new Error('compact snapshot replay journal missing');
    expect((await replay.replayEvents(0, 6)).map((envelope) => envelope.seq))
      .toEqual([1, 2, 3, 4, 5, 6]);
    expect(reads.some((read) => read.kind === 'body' || read.kind === 'tail')).toBe(false);

    reads.length = 0;
    expect((await replay.replayEvents(4, 6)).map((envelope) => envelope.seq)).toEqual([5, 6]);
    expect(reads.some((read) => read.kind === 'body' || read.kind === 'tail')).toBe(false);

    await workspace.releaseSupervisorLease(lease);
    await workspace.close();
  });

  test('recovers exact, tail, missing, corrupt, replaced, torn, and truncated boundaries safely', async () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, 'cwd');
    const workspaceId = 'ws_recovery_snapshot_windows' as WorkspaceId;
    const threadId = 'thread-recovery-snapshot-windows' as ThreadId;
    const reads: Array<{ readonly kind: string; readonly bytes: number }> = [];
    const storage = createFileRuntimeStorage({
      root,
      onJournalRead: (observation) => {
        if (observation.threadId === threadId) reads.push(observation);
      },
    });
    const workspace = await storage.openWorkspace({ cwd, workspaceId });
    const lease = await workspace.acquireSupervisorLease('snapshot-windows');
    const created = await workspace.createThreadJournal(lease, {
      threadId,
      meta: threadMeta({ workspaceId, threadId, cwd }),
    });
    await created.acquireWriteLease(lease);
    const initial = await created.loadState();
    const first = journalCommit(workspaceId, threadId, 1, diagnostic('diag-1'));
    await created.append([first], { flush: true });
    const firstState = foldThreadJournalAppend(initial, [first]);
    await created.saveRecoveryState(firstState);
    await created.releaseWriteLease();
    const file = journalPath(root, workspaceId, threadId);
    const snapshotFile = `${file}.recovery.json`;

    reads.length = 0;
    const exact = await workspace.openThreadJournal(threadId);
    if (exact === undefined) throw new Error('exact journal missing');
    await exact.acquireWriteLease(lease);
    expect((await exact.loadState()).highWaterSeq).toBe(1);
    expect(reads.some((read) => read.kind === 'body' || read.kind === 'tail')).toBe(false);
    expect(reads.some((read) => read.kind === 'snapshot')).toBe(true);
    const second = journalCommit(workspaceId, threadId, 2, diagnostic('diag-2'));
    await exact.append([second], { flush: true });
    await exact.releaseWriteLease();

    reads.length = 0;
    const replay = await workspace.openThreadJournal(threadId);
    if (replay === undefined) throw new Error('tail-replay journal missing');
    expect((await replay.replayEvents(0, 2)).map((envelope) => envelope.seq)).toEqual([1, 2]);
    expect(reads.some((read) => read.kind === 'tail' && read.bytes > 0)).toBe(true);
    expect(reads.some((read) => read.kind === 'body')).toBe(false);

    reads.length = 0;
    const tail = await workspace.openThreadJournal(threadId);
    if (tail === undefined) throw new Error('tail journal missing');
    await tail.acquireWriteLease(lease);
    expect((await tail.loadState()).highWaterSeq).toBe(2);
    expect(reads.some((read) => read.kind === 'tail' && read.bytes > 0)).toBe(true);
    expect(reads.some((read) => read.kind === 'body')).toBe(false);
    await tail.releaseWriteLease();

    unlinkSync(snapshotFile);
    reads.length = 0;
    const missing = await workspace.openThreadJournal(threadId);
    if (missing === undefined) throw new Error('missing-snapshot journal missing');
    await missing.acquireWriteLease(lease);
    expect((await missing.loadState()).highWaterSeq).toBe(2);
    expect(reads.some((read) => read.kind === 'body' && read.bytes > 0)).toBe(true);
    await missing.releaseWriteLease();

    writeFileSync(snapshotFile, '{corrupt snapshot}\n');
    reads.length = 0;
    const corrupt = await workspace.openThreadJournal(threadId);
    if (corrupt === undefined) throw new Error('corrupt-snapshot journal missing');
    await corrupt.acquireWriteLease(lease);
    expect((await corrupt.loadState()).highWaterSeq).toBe(2);
    expect(reads.some((read) => read.kind === 'body' && read.bytes > 0)).toBe(true);
    await corrupt.releaseWriteLease();

    const temporarySnapshot = path.join(
      path.dirname(snapshotFile),
      `.tmp-${path.basename(snapshotFile)}-not-renamed`,
    );
    writeFileSync(temporarySnapshot, '{unfinished snapshot}\n');
    reads.length = 0;
    const ignoredTemporary = await workspace.openThreadJournal(threadId);
    if (ignoredTemporary === undefined) throw new Error('temporary-snapshot journal missing');
    await ignoredTemporary.acquireWriteLease(lease);
    expect((await ignoredTemporary.loadState()).highWaterSeq).toBe(2);
    expect(reads.some((read) => read.kind === 'body' || read.kind === 'tail')).toBe(false);
    await ignoredTemporary.releaseWriteLease();

    const original = readFileSync(file, 'utf8');
    const replacement = path.join(path.dirname(file), '.replacement-journal');
    writeFileSync(replacement, original.replace('diag-1', 'diag-X'));
    renameSync(replacement, file);
    reads.length = 0;
    const replaced = await workspace.openThreadJournal(threadId);
    if (replaced === undefined) throw new Error('replaced journal missing');
    await replaced.acquireWriteLease(lease);
    const replacedState = await replaced.loadState();
    expect(reads.some((read) => read.kind === 'body' && read.bytes > 0)).toBe(true);
    expect(replacedState.envelopes.some((envelope) =>
      envelope.event.type === 'runtime_diagnostic' && envelope.event.code === 'diag-X')).toBe(true);
    await replaced.releaseWriteLease();

    appendFileSync(file, '{"type":"commit"');
    reads.length = 0;
    const torn = await workspace.openThreadJournal(threadId);
    if (torn === undefined) throw new Error('torn journal missing');
    await torn.acquireWriteLease(lease);
    expect((await torn.loadState()).highWaterSeq).toBe(2);
    expect(reads.some((read) => read.kind === 'tail' && read.bytes > 0)).toBe(true);
    expect(readFileSync(file, 'utf8').endsWith('\n')).toBe(true);
    await torn.releaseWriteLease();

    const header = readFileSync(file, 'utf8').split('\n')[0];
    if (header === undefined || header.length === 0) throw new Error('journal header missing');
    writeFileSync(file, `${header}\n`);
    reads.length = 0;
    const truncated = await workspace.openThreadJournal(threadId);
    if (truncated === undefined) throw new Error('truncated journal missing');
    await truncated.acquireWriteLease(lease);
    expect((await truncated.loadState()).highWaterSeq).toBe(0);
    expect(reads.some((read) => read.kind === 'body')).toBe(true);
    await truncated.releaseWriteLease();

    await workspace.releaseSupervisorLease(lease);
    await workspace.close();
  });

  test('listing and clean startup read zero journal body bytes for large history and many threads', async () => {
    const root = temporaryDirectory();
    const reads: Array<{ readonly kind: string; readonly bytes: number }> = [];
    const storage = createFileRuntimeStorage({ root, onJournalRead: (read) => reads.push(read) });
    const cwd = path.join(root, 'cwd');
    const workspaceId = 'ws_many_clean_threads' as WorkspaceId;
    const first = await storage.openWorkspace({ cwd, workspaceId });
    const lease = await first.acquireSupervisorLease('many-clean-first');
    for (let index = 0; index < 24; index++) {
      const threadId = `thread-clean-${index}` as ThreadId;
      const journal = await first.createThreadJournal(lease, {
        threadId,
        meta: threadMeta({ workspaceId, threadId, cwd }),
      });
      await journal.acquireWriteLease(lease);
      const initial = await journal.loadState();
      const closed = journalCommit(workspaceId, threadId, 1, { type: 'thread_closed', threadId });
      await journal.append([closed], { flush: true });
      await journal.saveRecoveryState(foldThreadJournalAppend(initial, [closed]));
      await journal.releaseWriteLease();
    }
    await first.releaseSupervisorLease(lease);
    await first.close();
    reads.length = 0;

    const reopened = await storage.openWorkspace({ cwd, workspaceId });
    const reopenedLease = await reopened.acquireSupervisorLease('many-clean-second');
    expect(await reopened.listThreads()).toHaveLength(24);
    expect(reads.filter((read) => read.kind === 'body')).toEqual([]);
    await reopened.releaseSupervisorLease(reopenedLease);
    await reopened.close();
    expect(await storage.listStoredThreads()).toHaveLength(24);
    expect(reads.filter((read) => read.kind === 'body')).toEqual([]);

    const hugeWorkspaceId = 'ws_sparse_unrelated_history' as WorkspaceId;
    const hugeThreadId = 'thread-sparse-unrelated-history' as ThreadId;
    const hugeCwd = path.join(root, 'huge-cwd');
    const huge = await storage.openWorkspace({ cwd: hugeCwd, workspaceId: hugeWorkspaceId });
    const hugeLease = await huge.acquireSupervisorLease('sparse-unrelated');
    await huge.createThreadJournal(hugeLease, {
      threadId: hugeThreadId,
      meta: threadMeta({ workspaceId: hugeWorkspaceId, threadId: hugeThreadId, cwd: hugeCwd }),
    });
    await huge.releaseSupervisorLease(hugeLease);
    await huge.close();
    const hugeFile = journalPath(root, hugeWorkspaceId, hugeThreadId);
    truncateSync(hugeFile, 1024 ** 3);
    expect(statSync(hugeFile).size).toBe(1024 ** 3);
    reads.length = 0;
    expect(await storage.listStoredThreads()).toHaveLength(25);
    expect(reads.filter((read) => read.kind === 'body')).toEqual([]);
  }, 30_000);

  test('rebuilds a missing listing catalog from journal headers without reading bodies', async () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, 'cwd');
    const workspaceId = 'ws_missing_listing_catalog' as WorkspaceId;
    const threadId = 'thread-missing-listing-catalog' as ThreadId;
    const reads: Array<{ readonly kind: string; readonly bytes: number }> = [];
    const storage = createFileRuntimeStorage({ root, onJournalRead: (read) => reads.push(read) });
    const workspace = await storage.openWorkspace({ cwd, workspaceId });
    const lease = await workspace.acquireSupervisorLease('missing-listing-catalog-first');
    const journal = await workspace.createThreadJournal(lease, {
      threadId,
      meta: threadMeta({ workspaceId, threadId, cwd }),
    });
    await journal.acquireWriteLease(lease);
    await journal.loadState();
    await journal.append([journalCommit(workspaceId, threadId, 1, diagnostic('catalog-history'))], {
      flush: true,
    });
    await journal.releaseWriteLease();
    await workspace.releaseSupervisorLease(lease);
    await workspace.close();
    unlinkSync(path.join(workspacePath(root, workspaceId), 'catalog.json'));
    reads.length = 0;

    expect((await storage.listStoredThreads()).map((item) => item.threadId)).toEqual([threadId]);
    expect(reads.filter((read) => read.kind === 'body')).toEqual([]);

    const catalogFile = path.join(workspacePath(root, workspaceId), 'catalog.json');
    writeFileSync(catalogFile, '{corrupt catalog}\n');
    reads.length = 0;
    expect((await storage.listStoredThreads()).map((item) => item.threadId)).toEqual([threadId]);
    expect(reads.filter((read) => read.kind === 'body')).toEqual([]);
    const reopened = await storage.openWorkspace({ cwd, workspaceId });
    const reopenedLease = await reopened.acquireSupervisorLease('corrupt-listing-catalog');
    expect((await reopened.listThreads()).map((item) => item.summary.threadId)).toEqual([threadId]);
    expect(reads.filter((read) => read.kind === 'body')).toEqual([]);
    await reopened.releaseSupervisorLease(reopenedLease);
    await reopened.close();
  });

  test('rejects malformed seed provenance before creating a journal', async () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, 'cwd');
    const workspaceId = 'ws_invalid_thread_seed' as WorkspaceId;
    const threadId = 'thread-invalid-seed' as ThreadId;
    const workspace = await createFileRuntimeStorage({ root }).openWorkspace({ cwd, workspaceId });
    const lease = await workspace.acquireSupervisorLease('invalid-thread-seed');
    const invalid = {
      ...threadSeed(),
      turnProvenance: [{ messageId: 'different-message', turnId: 'turn-seed' as TurnId }],
    };

    await expect(workspace.createThreadJournal(lease, {
      threadId,
      meta: threadMeta({ workspaceId, threadId, cwd }),
      initialRecords: [invalid],
    })).rejects.toMatchObject({ code: 'invalid_thread_seed' });
    expect(existsSync(journalPath(root, workspaceId, threadId))).toBe(false);

    await workspace.releaseSupervisorLease(lease);
    await workspace.close();
  });

  test('repairs a torn journal tail when a writer loads it', async () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, 'cwd');
    const workspaceId = 'ws_torn_tail_repair' as WorkspaceId;
    const threadId = 'thread-torn-tail' as ThreadId;
    const storage = createFileRuntimeStorage({ root });
    const first = await storage.openWorkspace({ cwd, workspaceId });
    const firstLease = await first.acquireSupervisorLease('torn-tail-first');
    await first.createThreadJournal(firstLease, {
      threadId,
      meta: threadMeta({ workspaceId, threadId, cwd }),
      initialRecords: [threadSeed()],
    });
    await first.releaseSupervisorLease(firstLease);
    await first.close();
    const file = journalPath(root, workspaceId, threadId);
    appendFileSync(file, '{"type":"thread_seed"');

    const second = await storage.openWorkspace({ cwd, workspaceId });
    const secondLease = await second.acquireSupervisorLease('torn-tail-second');
    const journal = await second.openThreadJournal(threadId);
    if (journal === undefined) throw new Error('journal missing');
    await journal.acquireWriteLease(secondLease);
    const repaired = await journal.loadState();
    expect(repaired.meta).toEqual(threadMeta({ workspaceId, threadId, cwd }));
    expect(repaired.checkpoint.frontend.transcript).toEqual(threadSeed().transcript);
    expect(readFileSync(file, 'utf8')).not.toContain('{"type":"thread_seed"');
    await journal.releaseWriteLease();
    await second.releaseSupervisorLease(secondLease);
    await second.close();
  });

  test('persists canonical policy grants with exact receipt idempotency', async () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, 'cwd');
    const workspaceId = 'ws_file_policy_grants' as WorkspaceId;
    const storage = createFileRuntimeStorage({ root });
    const first = await storage.openWorkspace({ cwd, workspaceId });
    const firstLease = await first.acquireSupervisorLease('policy-first');
    const repository = await first.openPolicyGrantRepository(firstLease);
    const initialRevision = (await repository.snapshot()).revision;
    const grant = policyGrant(workspaceId, 'op_e_c1000000000000000000000000000001');

    const applied = await repository.commitAllowAlways(grant);
    expect(applied).toMatchObject({ kind: 'applied' });
    expect(applied.kind === 'applied' && applied.revision).not.toBe(initialRevision);
    expect(await repository.commitAllowAlways(grant)).toMatchObject({ kind: 'duplicate' });
    expect(await repository.commitAllowAlways({ ...grant, policyBasisRevision: 'changed' }))
      .toMatchObject({ kind: 'conflict' });
    expect(await repository.commitAllowAlways(policyGrant(
      'ws_file_policy_other' as WorkspaceId,
      'op_e_c2000000000000000000000000000002',
    ))).toMatchObject({ kind: 'fenced', code: 'wrong_workspace' });
    await expect(repository.commitAllowAlways({
      ...grant,
      grantId: 'op_e_c3000000000000000000000000000003' as ExternalOpId,
      scope: { kind: 'removed_scope' },
    } as unknown as PolicyGrant)).rejects.toMatchObject({ code: 'invalid_policy_grant' });
    await repository.close();
    await first.releaseSupervisorLease(firstLease);
    await first.close();

    const second = await storage.openWorkspace({ cwd, workspaceId });
    const secondLease = await second.acquireSupervisorLease('policy-second');
    const recoveredRepository = await second.openPolicyGrantRepository(secondLease);
    expect(await recoveredRepository.snapshot()).toMatchObject({ workspaceId, grants: [grant] });
    await recoveredRepository.close();
    await second.releaseSupervisorLease(secondLease);
    await second.close();
  });

  test('validates canonical resource patterns using UTF-8 byte order', async () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, 'cwd');
    const workspaceId = 'ws_file_utf8_patterns' as WorkspaceId;
    const workspace = await createFileRuntimeStorage({ root }).openWorkspace({ cwd, workspaceId });
    const lease = await workspace.acquireSupervisorLease('utf8-patterns');
    const repository = await workspace.openPolicyGrantRepository(lease);
    const first = resourcePattern('\uE000');
    const second = resourcePattern('𐀀');
    const base = policyGrant(workspaceId, 'op_e_c4000000000000000000000000000004');

    await expect(repository.commitAllowAlways({
      ...base,
      scope: {
        kind: 'canonical_resources_v1',
        resourcePatterns: [second, first],
        attributes: {},
      },
    })).rejects.toMatchObject({ code: 'invalid_policy_grant' });
    expect(await repository.commitAllowAlways({
      ...base,
      scope: {
        kind: 'canonical_resources_v1',
        resourcePatterns: [first, second],
        attributes: {},
      },
    })).toMatchObject({ kind: 'applied' });

    await repository.close();
    await workspace.releaseSupervisorLease(lease);
    await workspace.close();
  });

  test('persists the canonical retry freeze and rejects post-reservation changes', async () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, 'cwd');
    const workspaceId = 'ws_retry_prompt_freeze' as WorkspaceId;
    const opId = 'op_e_d1000000000000000000000000000001' as ExternalOpId;
    const retryPromptOpId = 'op_e_d2000000000000000000000000000002' as ExternalOpId;
    const text = 'frozen retry prompt';
    const op = {
      type: 'conversation_retry' as const,
      opId,
      workspaceId,
      sourceThreadId: 'thread-retry-source' as ThreadId,
      threadId: 'thread-retry-target' as ThreadId,
      model: { provider: 'faux', api: 'faux', model: 'test' },
    };
    const reserved: SupervisorOpLedgerRecord = {
      opId,
      op,
      payloadHash: runtimeOpPayloadHash(op),
      retryPromptOpId,
      retryPrompt: {
        messageId: 'message-retry-source',
        turnId: 'turn-retry-source' as TurnId,
        text,
        digest: sha256Hex(text),
      },
      state: 'reserved',
    };
    const storage = createFileRuntimeStorage({ root });
    const workspace = await storage.openWorkspace({ cwd, workspaceId });
    const lease = await workspace.acquireSupervisorLease('retry-freeze');
    expect(await workspace.reserveSupervisorOp(lease, reserved)).toMatchObject({ kind: 'reserved' });
    await workspace.releaseSupervisorLease(lease);
    await workspace.close();

    const reopened = await storage.openWorkspace({ cwd, workspaceId });
    const reopenedLease = await reopened.acquireSupervisorLease('retry-freeze-reopen');
    expect((await reopened.loadSupervisorOps())[0]).toEqual(reserved);
    await reopened.releaseSupervisorLease(reopenedLease);
    await reopened.close();

    const ledgerPath = path.join(workspacePath(root, workspaceId), 'ledger.json');
    const corrupted = JSON.parse(readFileSync(ledgerPath, 'utf8')) as {
      ops: Array<{ retryPrompt: { text: string } }>;
    };
    corrupted.ops[0]!.retryPrompt.text = 'changed after reservation';
    writeFileSync(ledgerPath, `${JSON.stringify(corrupted)}\n`);
    const invalid = await storage.openWorkspace({ cwd, workspaceId });
    await expect(invalid.acquireSupervisorLease('retry-freeze-invalid'))
      .rejects.toMatchObject({ code: 'invalid_supervisor_op' });
    await invalid.close();
  });

  test('rejects catalog entries and metadata with unknown protocol fields', async () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, 'cwd');
    const workspaceId = 'ws_schema_validation' as WorkspaceId;
    const threadId = 'thread-schema-validation' as ThreadId;
    const storage = createFileRuntimeStorage({ root });
    const first = await storage.openWorkspace({ cwd, workspaceId });
    const lease = await first.acquireSupervisorLease('schema-first');
    await first.createThreadJournal(lease, {
      threadId,
      meta: threadMeta({ workspaceId, threadId, cwd }),
    });
    await first.releaseSupervisorLease(lease);
    await first.close();

    const catalogFile = path.join(workspacePath(root, workspaceId), 'catalog.json');
    const catalog = JSON.parse(readFileSync(catalogFile, 'utf8')) as {
      threads: Array<Record<string, unknown>>;
    };
    catalog.threads[0]!.removedBinding = { kind: 'removed', key: 'value' };
    writeFileSync(catalogFile, `${JSON.stringify(catalog)}\n`);
    const invalid = await storage.openWorkspace({ cwd, workspaceId });
    await expect(invalid.acquireSupervisorLease('schema-second'))
      .rejects.toBeInstanceOf(RuntimeStorageError);
    await invalid.close();
  });

  test('rejects pre-positioned symlinks and unsafe root paths', async () => {
    const parent = temporaryDirectory();
    const target = path.join(parent, 'target');
    const root = path.join(parent, 'runtime');
    writeFileSync(target, '{}');
    symlinkSync(target, root);
    const storage = createFileRuntimeStorage({ root });

    await expect(storage.openWorkspace({
      cwd: path.join(parent, 'cwd'),
      workspaceId: 'ws_symlink_root' as WorkspaceId,
    })).rejects.toMatchObject({ code: 'unsafe_storage_key' });
    expect(() => createFileRuntimeStorage({ root: 'relative/path' })).toThrow(TypeError);
    expect(() => createFileRuntimeStorage({ root: `${parent}\ud800` })).toThrow(TypeError);
  });
});

function journalCommit(
  workspaceId: WorkspaceId,
  threadId: ThreadId,
  seq: number,
  event: EventEnvelope['event'],
): Extract<RuntimeJournalRecord, { type: 'commit' }> {
  const isMessage = event.type === 'message_start'
    || event.type === 'message_update'
    || event.type === 'message_end';
  return {
    type: 'commit',
    firstSeq: seq,
    envelopes: [{
      workspaceId,
      threadId,
      ...(isMessage && {
        runId: 'run-file-storage' as import('../protocol/index.js').RunId,
        turnId: 'turn-file-storage' as TurnId,
      }),
      ...(event.type === 'thread_closed' && {
        opId: 'op_e_b5000000000000000000000000000005' as ExternalOpId,
      }),
      seq,
      timestamp: seq,
      event,
    }],
  };
}

function assistantMessage(
  id: string,
  content: AssistantMessage['content'],
): AssistantMessage {
  return {
    role: 'assistant',
    id,
    timestamp: 1,
    content,
    model: { provider: 'faux', api: 'faux', model: 'test' },
    stopReason: 'stop',
    usage: { input: 0, output: 0 },
  };
}

function diagnostic(code: string): EventEnvelope['event'] {
  return {
    type: 'runtime_diagnostic',
    severity: 'warning',
    code,
    message: code,
    scope: 'thread',
  };
}

function threadMeta(input: {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  cwd: string;
  protocolVersion?: string;
}): ThreadMetaRecord {
  return {
    type: 'thread_meta',
    version: 3,
    protocolVersion: input.protocolVersion ?? PROTOCOL_VERSION,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    permissionCeiling: { revision: 'test', constraints: [] },
    createdAt: 1,
    cwd: input.cwd,
    model: { provider: 'faux', api: 'faux', model: 'test' },
  };
}

function threadSeed(): ThreadSeedRecord {
  return {
    type: 'thread_seed',
    transcript: [{
      role: 'user',
      id: 'message-seed',
      timestamp: 1,
      source: 'prompt',
      content: [{ type: 'text', text: 'seed' }],
    }],
    turnProvenance: [{ messageId: 'message-seed', turnId: 'turn-seed' as TurnId }],
    usage: { cumulative: { input: 0, output: 0 }, turns: 0, contextTokens: 0 },
  };
}

function policyGrant(workspaceId: WorkspaceId, grantId: string): PolicyGrant {
  return {
    grantId: grantId as ExternalOpId,
    workspaceId,
    capabilityId: 'bash',
    capabilityVersion: '1.0.0',
    registrationDigest: `capreg_v1_${'2'.repeat(64)}`,
    scope: {
      kind: 'canonical_resources_v1',
      resourcePatterns: [resourcePattern('bun test')],
      attributes: { confirmation: 'required' },
    },
    policyBasisRevision: 'policy-basis-v1',
    acceptedAt: 20,
  };
}

function resourcePattern(pattern: string) {
  return {
    resourceType: 'command' as const,
    access: 'execute' as const,
    matcher: 'canonical_target_exact_v1' as const,
    pattern,
  };
}

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'coda-runtime-storage-'));
  temporaryRoots.push(directory);
  return directory;
}

function workspacePath(root: string, workspaceId: WorkspaceId): string {
  return path.join(root, `ws-${sha256Hex(workspaceId)}`);
}

function journalPath(root: string, workspaceId: WorkspaceId, threadId: ThreadId): string {
  return path.join(workspacePath(root, workspaceId), 'threads', `th-${sha256Hex(threadId)}.jsonl`);
}

function rewriteJournal(
  file: string,
  protocolVersion: string,
  body?: string,
): void {
  const [header, ...existingBody] = readFileSync(file, 'utf8').split('\n');
  if (header === undefined) throw new Error('journal has no header');
  const meta = JSON.parse(header) as Record<string, unknown>;
  meta.protocolVersion = protocolVersion;
  writeFileSync(file, `${JSON.stringify(meta)}\n${body ?? existingBody.join('\n')}`);
}
