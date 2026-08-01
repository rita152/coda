import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';

import type {
  AgentMessage,
  PermissionCeilingSnapshot,
  ThreadId,
  UserMessage,
  WorkspaceId,
} from '../protocol/index.js';
import { RuntimeStorageError } from '../shared/runtime-storage-error.js';
import { reconcileStandaloneSessionMirror } from './standalone-session-recovery.js';
import type { LegacyMirrorRecord, RuntimeJournalRecord } from './thread-journal-records.js';
import {
  loadSession,
  loadSessionRecordHistory,
  PROTOCOL_VERSION,
  SessionStore,
  STORE_VERSION,
} from './store.js';

const MODEL = { provider: 'faux', api: 'faux', model: 'test' } as const;
const CEILING = { revision: 'test', constraints: [] } as unknown as PermissionCeilingSnapshot;
let dir: string;

beforeEach(() => { dir = mkdtempSync('/tmp/coda-standalone-recovery-'); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('reconcileStandaloneSessionMirror', () => {
  test('repairs the canonical message suffix after a canonical-before-v1 crash', () => {
    const id = 'mirror-message-gap';
    const baseline = [user('u1', 'before sidecar')];
    initializeMirror(id, baseline);
    const missing = user('u2', 'canonical only');

    reconcileStandaloneSessionMirror({
      dir,
      sessionId: id,
      records: records(id, baseline, [{ type: 'message_appended', message: missing }]),
    });

    expect(loadSession(dir, id).messages).toEqual([...baseline, missing]);
  });

  test('repairs a missing canonical compaction while retaining a compacted seed baseline', () => {
    const id = 'mirror-compaction-gap';
    const baseline = [user('u1', 'old'), user('u2', 'tail')];
    const initialCompaction = {
      id: 'cmp_initial', timestamp: 1, tailStartId: 'u2', summary: 'initial',
    } as const;
    initializeMirror(id, baseline, initialCompaction);
    const nextCompaction = {
      id: 'cmp_next', timestamp: 2, tailStartId: 'u2', summary: 'next',
    } as const;

    reconcileStandaloneSessionMirror({
      dir,
      sessionId: id,
      records: records(id, baseline, [{ type: 'compaction_committed', compaction: nextCompaction }], {
        transcript: loadSession(dir, id).active,
        compaction: initialCompaction,
      }),
    });

    expect(loadSession(dir, id).lastCompaction).toMatchObject(nextCompaction);
  });

  test('fails closed when the v1 mirror is not a canonical prefix', () => {
    const id = 'mirror-diverged';
    const baseline = [user('u1', 'canonical')];
    initializeMirror(id, [user('u1', 'different')]);

    expect(() => reconcileStandaloneSessionMirror({
      dir,
      sessionId: id,
      records: records(id, baseline, []),
    })).toThrow(RuntimeStorageError);
  });

  test('tracks raw append history when legacy message ids are reused', () => {
    const id = 'mirror-duplicate-id';
    const original = user('u1', 'old');
    const baseline = [original];
    initializeMirror(id, baseline);
    const replacement = user('u1', 'new');

    reconcileStandaloneSessionMirror({
      dir,
      sessionId: id,
      records: records(id, baseline, [{ type: 'message_appended', message: replacement }]),
    });

    expect(loadSessionRecordHistory(dir, id)
      .filter((record) => record.type === 'message')
      .map((record) => record.message)).toEqual([original, replacement]);
    expect(loadSession(dir, id).messages).toEqual([replacement]);
  });

  test('replays missing message and compaction records in their canonical interleaving', () => {
    const id = 'mirror-interleaved-gap';
    const first = user('u1', 'first');
    const second = user('u2', 'second');
    const compaction = {
      id: 'cmp_between', timestamp: 2, tailStartId: 'u1', summary: 'between',
    } as const;
    initializeMirror(id, [first]);

    reconcileStandaloneSessionMirror({
      dir,
      sessionId: id,
      records: records(id, [first], [
        { type: 'compaction_committed', compaction },
        { type: 'message_appended', message: second },
      ]),
    });

    expect(loadSessionRecordHistory(dir, id)
      .filter((record) => record.type !== 'meta')
      .map((record) => record.type)).toEqual(['message', 'compaction', 'message']);
  });

  test('fails closed when an earlier mirror compaction is absent from canonical history', () => {
    const id = 'mirror-compaction-diverged';
    const baseline = [user('u1', 'canonical')];
    initializeMirror(id, baseline, {
      id: 'cmp_rogue', timestamp: 2, tailStartId: 'u1', summary: 'rogue',
    });

    expect(() => reconcileStandaloneSessionMirror({
      dir,
      sessionId: id,
      records: records(id, baseline, []),
    })).toThrow(RuntimeStorageError);
  });
});

function initializeMirror(
  id: string,
  messages: readonly AgentMessage[],
  compaction?: { readonly id: string; readonly timestamp: number; readonly tailStartId: string; readonly summary: string },
): void {
  const initialized = SessionStore.initializeNamed(dir, id, {
    type: 'meta',
    version: STORE_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    id,
    createdAt: 1,
    cwd: path.join(dir, 'workspace'),
    model: MODEL,
  });
  for (const message of messages) initialized.store.append({ type: 'message', message });
  if (compaction !== undefined) initialized.store.append({ type: 'compaction', ...compaction });
  initialized.store.fsync();
}

function records(
  id: string,
  mirrorTranscript: readonly AgentMessage[],
  mutations: readonly (
    | { readonly type: 'message_appended'; readonly message: AgentMessage }
    | { readonly type: 'compaction_committed'; readonly compaction: {
        readonly id: string;
        readonly timestamp: number;
        readonly tailStartId: string;
        readonly summary: string;
      } }
  )[],
  seed?: {
    readonly transcript: readonly AgentMessage[];
    readonly compaction?: { readonly id: string; readonly timestamp: number; readonly tailStartId: string; readonly summary: string };
    readonly mirrorRecords?: readonly LegacyMirrorRecord[];
  },
): RuntimeJournalRecord[] {
  const workspaceId = 'ws_01k1standalonerecovery0000000' as WorkspaceId;
  const threadId = 'thread_01k1standalonerecovery00000' as ThreadId;
  return [
    {
      type: 'thread_meta',
      version: 2,
      protocolVersion: PROTOCOL_VERSION,
      workspaceId,
      threadId,
      permissionCeiling: CEILING,
      createdAt: 1,
      cwd: path.join(dir, 'workspace'),
      model: MODEL,
      driverRef: { kind: 'session-v1', key: id },
    },
    {
      type: 'legacy_seed',
      sourceSessionId: id,
      transcript: seed?.transcript ?? mirrorTranscript,
      mirrorRecords: seed?.mirrorRecords ?? [
        ...mirrorTranscript.map((message) => ({ type: 'message' as const, message })),
        ...(seed?.compaction === undefined
          ? []
          : [{ type: 'compaction' as const, ...seed.compaction }]),
      ],
      usage: { cumulative: { input: 0, output: 0 }, turns: 0, contextTokens: 0 },
      ...(seed?.compaction !== undefined && { compaction: seed.compaction }),
    },
    ...(mutations.length === 0 ? [] : [{
      type: 'commit' as const,
      firstSeq: 1,
      envelopes: [{
        workspaceId,
        threadId,
        seq: 1,
        timestamp: 1,
        event: { type: 'runtime_diagnostic', severity: 'warning', code: 'test', message: 'test', scope: 'thread' },
      }] as const,
      mutations,
    }]),
  ];
}

function user(id: string, text: string): UserMessage {
  return {
    role: 'user',
    id,
    timestamp: 1,
    source: 'prompt',
    content: [{ type: 'text', text }],
  };
}
