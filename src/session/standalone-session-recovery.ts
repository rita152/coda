// Canonical-to-v1 recovery for direct Session. The canonical sidecar is committed first, so the
// legacy JSONL mirror may only be an exact prefix after a crash or a degraded mirror append.

import { canonicalJson } from '../protocol/index.js';
import { RuntimeStorageError } from '../shared/runtime-storage-error.js';
import type {
  LegacyMirrorRecord,
  LegacyThreadSeedRecord,
  RuntimeJournalRecord,
} from './thread-journal-records.js';
import type { ThreadCompactionCheckpoint } from './thread-runtime-ports.js';
import type { CompactionRecord } from './store.js';
import { loadSessionRecordHistory, SessionStore } from './store.js';

export function reconcileStandaloneSessionMirror(input: {
  readonly dir: string;
  readonly sessionId: string;
  readonly records: readonly RuntimeJournalRecord[];
}): void {
  const seed = input.records.find(
    (record): record is LegacyThreadSeedRecord => record.type === 'legacy_seed',
  );
  if (seed === undefined || seed.mirrorRecords === undefined) {
    throw mismatch('canonical sidecar has no exact v1 mirror baseline');
  }

  const expected: LegacyMirrorRecord[] = [...seed.mirrorRecords];
  for (const record of input.records) {
    if (record.type !== 'commit') continue;
    for (const mutation of record.mutations ?? []) {
      if (mutation.type === 'message_appended') {
        expected.push({ type: 'message', message: mutation.message });
      } else if (mutation.type === 'compaction_committed') {
        expected.push(recordFromCheckpoint(mutation.compaction));
      }
    }
  }

  const store = new SessionStore(input.dir, input.sessionId);
  store.repairTail();
  const actual = mirrorRecords(input.dir, input.sessionId);
  assertRecordPrefix(actual, expected);
  for (const record of expected.slice(actual.length)) {
    store.append(record);
  }
  store.fsync();

  if (canonicalJson(mirrorRecords(input.dir, input.sessionId)) !== canonicalJson(expected)) {
    throw mismatch('legacy mirror repair did not converge');
  }
}

function assertRecordPrefix(
  actual: readonly LegacyMirrorRecord[],
  expected: readonly LegacyMirrorRecord[],
): void {
  if (actual.length > expected.length) {
    throw mismatch('legacy mirror is ahead of canonical history');
  }
  for (let index = 0; index < actual.length; index++) {
    if (canonicalJson(actual[index]) !== canonicalJson(expected[index])) {
      throw mismatch(`legacy mirror diverges at record ${index}`);
    }
  }
}

function mirrorRecords(dir: string, sessionId: string): LegacyMirrorRecord[] {
  return loadSessionRecordHistory(dir, sessionId).flatMap<LegacyMirrorRecord>((record) => {
    if (record.type === 'message') return [{ type: 'message' as const, message: record.message }];
    if (record.type === 'compaction') return [record];
    return [];
  });
}

function recordFromCheckpoint(checkpoint: ThreadCompactionCheckpoint): CompactionRecord {
  return {
    type: 'compaction',
    id: checkpoint.id,
    timestamp: checkpoint.timestamp,
    tailStartId: checkpoint.tailStartId,
    summary: checkpoint.summary,
    ...(checkpoint.contextTokensBefore !== undefined && {
      contextTokensBefore: checkpoint.contextTokensBefore,
    }),
  };
}

function mismatch(message: string): RuntimeStorageError {
  return new RuntimeStorageError('standalone_mirror_checkpoint_mismatch', message);
}
