import { describe, expect, test } from 'bun:test';

import { RuntimeStorageError as SharedRuntimeStorageError } from '../shared/runtime-storage-error.js';
import { ThreadJournalWriter as SessionThreadJournalWriter } from '../session/thread-journal.js';
import { ThreadRuntime as SessionThreadRuntime } from '../session/thread-runtime.js';
import { RuntimeStorageError } from './errors.js';
import { ThreadJournalWriter } from './thread-journal.js';
import { Phase1ThreadRuntime, ThreadRuntime } from './thread-runtime.js';

describe('Phase-1 session compatibility exports', () => {
  test('preserves implementation and error class identity', () => {
    expect(Phase1ThreadRuntime).toBe(SessionThreadRuntime);
    expect(ThreadRuntime).toBe(SessionThreadRuntime);
    expect(ThreadJournalWriter).toBe(SessionThreadJournalWriter);
    expect(RuntimeStorageError).toBe(SharedRuntimeStorageError);
    expect(new RuntimeStorageError('test', 'failure')).toBeInstanceOf(SharedRuntimeStorageError);
  });
});
