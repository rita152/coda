// Standalone canonical sidecar: stable legacy identity, lease fencing and fail-closed JSONL IO.

import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { PROTOCOL_VERSION } from '../protocol/index.js';
import type { ExternalOpId } from '../protocol/index.js';
import type { LegacyThreadSeedRecord, ThreadMetaRecord } from './thread-journal-records.js';
import type { RuntimeJournalRecord } from './thread-journal-records.js';
import { StandaloneSessionInUseError, StandaloneSessionLease } from './standalone-session-lease.js';
import {
  StandaloneThreadJournalPort,
  standaloneThreadIdentity,
} from './standalone-thread-journal.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'coda-standalone-journal-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('StandaloneThreadJournalPort', () => {
  test('bootstraps meta plus legacy seed atomically and resumes the same sidecar', async () => {
    const sessionId = 'session-a';
    const cwd = '/workspace/a';
    const lease = await StandaloneSessionLease.acquire(root, sessionId);
    const bootstrap = records(sessionId, cwd);
    const created = await StandaloneThreadJournalPort.open({
      dir: root,
      sessionId,
      recordedCwd: cwd,
      lease,
      bootstrap,
    });

    expect(created.created).toBe(true);
    expect(await created.load()).toEqual([bootstrap.meta, bootstrap.legacySeed]);
    expect(readFileSync(created.file, 'utf8').endsWith('\n')).toBe(true);
    await created.releaseWriteLease();
    lease.release();

    const resumedLease = await StandaloneSessionLease.acquire(root, sessionId);
    const resumed = await StandaloneThreadJournalPort.open({
      dir: root,
      sessionId,
      recordedCwd: cwd,
      lease: resumedLease,
    });
    expect(resumed.created).toBe(false);
    expect(resumed.workspaceId).toBe(created.workspaceId);
    expect(resumed.threadId).toBe(created.threadId);
    expect(await resumed.load()).toEqual([bootstrap.meta, bootstrap.legacySeed]);
    await resumed.releaseWriteLease();
    resumedLease.release();
  });

  test('derives stable isolated identities without a Supervisor lease', () => {
    const first = standaloneThreadIdentity('/workspace/a', 'session-a');
    expect(standaloneThreadIdentity('/workspace/a', 'session-a')).toEqual(first);
    expect(standaloneThreadIdentity('/workspace/a', 'session-b').threadId).not.toBe(first.threadId);
    expect(standaloneThreadIdentity('/workspace/b', 'session-a').workspaceId).not.toBe(first.workspaceId);
  });

  test('isolates sidecars by session id and keeps the backend lease as the sole writer gate', async () => {
    const firstLease = await StandaloneSessionLease.acquire(root, 'session-a');
    const first = await StandaloneThreadJournalPort.open({
      dir: root,
      sessionId: 'session-a',
      recordedCwd: '/workspace',
      lease: firstLease,
      bootstrap: records('session-a', '/workspace'),
    });
    await expect(StandaloneSessionLease.acquire(root, 'session-a')).rejects.toBeInstanceOf(
      StandaloneSessionInUseError,
    );

    const secondLease = await StandaloneSessionLease.acquire(root, 'session-b');
    const second = await StandaloneThreadJournalPort.open({
      dir: root,
      sessionId: 'session-b',
      recordedCwd: '/workspace',
      lease: secondLease,
      bootstrap: records('session-b', '/workspace'),
    });
    expect(second.file).not.toBe(first.file);
    expect(second.threadId).not.toBe(first.threadId);

    await first.releaseWriteLease();
    await second.releaseWriteLease();
    firstLease.release();
    secondLease.release();
  });

  test('flushes appended records and rejects use after the port closes', async () => {
    const sessionId = 'session-a';
    const cwd = '/workspace';
    const lease = await StandaloneSessionLease.acquire(root, sessionId);
    const journal = await StandaloneThreadJournalPort.open({
      dir: root,
      sessionId,
      recordedCwd: cwd,
      lease,
      bootstrap: records(sessionId, cwd),
    });
    const op = {
      type: 'prompt' as const,
      opId: 'op_e_1234567890abcdef1234567890abcdef' as ExternalOpId,
      workspaceId: journal.workspaceId,
      threadId: journal.threadId,
      text: 'hello',
    };
    await journal.append([{
      type: 'mailbox_prepare',
      opId: op.opId,
      op,
      timestamp: 1,
    }], { flush: true });
    expect((await journal.load()).at(-1)).toEqual({
      type: 'mailbox_prepare',
      opId: op.opId,
      op,
      timestamp: 1,
    });
    await journal.releaseWriteLease();
    await expect(journal.load()).rejects.toMatchObject({ code: 'standalone_journal_closed' });
    lease.release();
  });

  test('rejects a mailbox operation with fields outside the canonical protocol schema', async () => {
    const sessionId = 'session-malformed-op';
    const cwd = '/workspace';
    const lease = await StandaloneSessionLease.acquire(root, sessionId);
    const journal = await StandaloneThreadJournalPort.open({
      dir: root,
      sessionId,
      recordedCwd: cwd,
      lease,
      bootstrap: records(sessionId, cwd),
    });
    const opId = 'op_e_1234567890abcdef1234567890abcdee' as ExternalOpId;
    await expect(journal.append([{
      type: 'mailbox_prepare',
      opId,
      op: {
        type: 'prompt',
        opId,
        workspaceId: journal.workspaceId,
        threadId: journal.threadId,
        text: 'hello',
        unexpected: true,
      },
      timestamp: 1,
    } as unknown as RuntimeJournalRecord], { flush: true })).rejects.toMatchObject({
      code: 'invalid_thread_journal',
    });
    await journal.releaseWriteLease();
    lease.release();
  });

  test('fails closed when a persisted commit contains a malformed mutation', async () => {
    const sessionId = 'session-malformed-mutation';
    const cwd = '/workspace';
    const lease = await StandaloneSessionLease.acquire(root, sessionId);
    const journal = await StandaloneThreadJournalPort.open({
      dir: root,
      sessionId,
      recordedCwd: cwd,
      lease,
      bootstrap: records(sessionId, cwd),
    });
    const file = journal.file;
    const identity = { workspaceId: journal.workspaceId, threadId: journal.threadId };
    await journal.releaseWriteLease();
    lease.release();
    appendFileSync(file, `${JSON.stringify({
      type: 'commit',
      firstSeq: 1,
      envelopes: [{
        ...identity,
        seq: 1,
        timestamp: 1,
        event: {
          type: 'runtime_diagnostic',
          severity: 'warning',
          code: 'fixture',
          message: 'fixture',
          scope: 'thread',
        },
      }],
      mutations: [{ type: 'message_appended', message: { role: 'user' } }],
    })}\n`, 'utf8');

    const resumedLease = await StandaloneSessionLease.acquire(root, sessionId);
    await expect(StandaloneThreadJournalPort.open({
      dir: root,
      sessionId,
      recordedCwd: cwd,
      lease: resumedLease,
    })).rejects.toMatchObject({ code: 'invalid_thread_journal' });
    resumedLease.release();
  });

  test('repairs a complete final JSON record that is missing its LF', async () => {
    const sessionId = 'session-a';
    const cwd = '/workspace';
    const lease = await StandaloneSessionLease.acquire(root, sessionId);
    const bootstrap = records(sessionId, cwd);
    const journal = await StandaloneThreadJournalPort.open({
      dir: root,
      sessionId,
      recordedCwd: cwd,
      lease,
      bootstrap,
    });
    const durable = readFileSync(journal.file, 'utf8');
    await journal.releaseWriteLease();
    lease.release();
    writeFileSync(journal.file, durable.slice(0, -1), 'utf8');

    const resumedLease = await StandaloneSessionLease.acquire(root, sessionId);
    const resumed = await StandaloneThreadJournalPort.open({
      dir: root,
      sessionId,
      recordedCwd: cwd,
      lease: resumedLease,
    });
    expect(await resumed.load()).toEqual([bootstrap.meta, bootstrap.legacySeed]);
    expect(readFileSync(journal.file, 'utf8')).toBe(durable);
    await resumed.releaseWriteLease();
    resumedLease.release();
  });

  test('discards an incomplete final JSON record before resuming', async () => {
    const sessionId = 'session-a';
    const cwd = '/workspace';
    const lease = await StandaloneSessionLease.acquire(root, sessionId);
    const bootstrap = records(sessionId, cwd);
    const journal = await StandaloneThreadJournalPort.open({
      dir: root,
      sessionId,
      recordedCwd: cwd,
      lease,
      bootstrap,
    });
    const durable = readFileSync(journal.file, 'utf8');
    await journal.releaseWriteLease();
    lease.release();
    appendFileSync(journal.file, '{"type":', 'utf8');

    const resumedLease = await StandaloneSessionLease.acquire(root, sessionId);
    const resumed = await StandaloneThreadJournalPort.open({
      dir: root,
      sessionId,
      recordedCwd: cwd,
      lease: resumedLease,
    });
    expect(await resumed.load()).toEqual([bootstrap.meta, bootstrap.legacySeed]);
    expect(readFileSync(journal.file, 'utf8')).toBe(durable);
    await resumed.releaseWriteLease();
    resumedLease.release();
  });

  test('fails closed on a corrupt newline-terminated middle record', async () => {
    const sessionId = 'session-a';
    const cwd = '/workspace';
    const lease = await StandaloneSessionLease.acquire(root, sessionId);
    const journal = await StandaloneThreadJournalPort.open({
      dir: root,
      sessionId,
      recordedCwd: cwd,
      lease,
      bootstrap: records(sessionId, cwd),
    });
    await journal.releaseWriteLease();
    lease.release();
    appendFileSync(journal.file, '{"type":\n{}\n', 'utf8');

    const resumedLease = await StandaloneSessionLease.acquire(root, sessionId);
    await expect(StandaloneThreadJournalPort.open({
      dir: root,
      sessionId,
      recordedCwd: cwd,
      lease: resumedLease,
    })).rejects.toMatchObject({ code: 'corrupt_thread_journal' });
    resumedLease.release();
  });

  test('fails closed when persisted ownership differs from the stable legacy identity', async () => {
    const sessionId = 'session-a';
    const cwd = '/workspace';
    const lease = await StandaloneSessionLease.acquire(root, sessionId);
    const journal = await StandaloneThreadJournalPort.open({
      dir: root,
      sessionId,
      recordedCwd: cwd,
      lease,
      bootstrap: records(sessionId, cwd),
    });
    await journal.releaseWriteLease();
    lease.release();

    const lines = readFileSync(journal.file, 'utf8').trimEnd().split('\n');
    const meta = JSON.parse(lines[0] as string) as Record<string, unknown>;
    meta.threadId = standaloneThreadIdentity(cwd, 'another-session').threadId;
    lines[0] = JSON.stringify(meta);
    writeFileSync(journal.file, `${lines.join('\n')}\n`, 'utf8');

    const resumedLease = await StandaloneSessionLease.acquire(root, sessionId);
    await expect(StandaloneThreadJournalPort.open({
      dir: root,
      sessionId,
      recordedCwd: cwd,
      lease: resumedLease,
    })).rejects.toMatchObject({ code: 'standalone_identity_mismatch' });
    resumedLease.release();
  });
});

function records(sessionId: string, cwd: string): {
  readonly meta: ThreadMetaRecord;
  readonly legacySeed: LegacyThreadSeedRecord;
} {
  const identity = standaloneThreadIdentity(cwd, sessionId);
  return {
    meta: {
      type: 'thread_meta',
      version: 2,
      protocolVersion: PROTOCOL_VERSION,
      workspaceId: identity.workspaceId,
      threadId: identity.threadId,
      permissionCeiling: { revision: 'standalone-test-v1', constraints: [] },
      createdAt: 1,
      cwd,
      model: { provider: 'faux', api: 'faux', model: 'test' },
      driverRef: { kind: 'session-v1', key: sessionId },
    },
    legacySeed: {
      type: 'legacy_seed',
      sourceSessionId: sessionId,
      transcript: [],
      usage: {
        cumulative: { input: 0, output: 0 },
        turns: 0,
        contextTokens: 0,
      },
    },
  };
}
