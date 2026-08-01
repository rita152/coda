// Phase-1 compatibility exports. Canonical journal ownership moved to `session` in Phase 2.

export {
  emptyCheckpoint,
  foldThreadJournal,
  snapshotFromFold,
  ThreadJournalWriter,
} from '../session/thread-journal.js';
export type {
  CommitEnvelopeInput,
  FoldedMailboxEntry,
  FoldedRunEntry,
  FoldedThreadJournal,
  FoldedTurnEntry,
} from '../session/thread-journal.js';
