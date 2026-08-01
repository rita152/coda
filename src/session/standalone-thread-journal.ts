// Standalone direct-Session journal authority. One backend-scoped StandaloneSessionLease fences
// this private canonical sidecar; no workspace storage or SupervisorLease participates.

import {
  closeSync,
  existsSync,
  ftruncateSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import {
  canonicalizeRuntimeOp,
  canonicalJson,
  isDerivedOpId,
  isExternalOpId,
  isOpId,
  isRunId,
  isThreadId,
  isTurnId,
  isWorkspaceId,
  isWellFormedUnicode,
  legacyThreadId,
  legacyWorkspaceId,
  sha256Hex,
  strictJsonSnapshot,
  validateEventEnvelope,
} from '../protocol/index.js';
import type { ThreadId, WorkspaceId } from '../protocol/index.js';
import { RuntimeStorageError } from '../shared/runtime-storage-error.js';
import { validatePermissionCeilingSnapshot } from './permission-ceiling.js';
import type {
  LegacyThreadSeedRecord,
  RuntimeJournalRecord,
  ThreadJournalAppendPort,
  ThreadMetaRecord,
} from './thread-journal-records.js';
import { foldThreadJournal } from './thread-journal.js';
import type { StandaloneSessionLease } from './standalone-session-lease.js';

const SIDECAR_DIRECTORY = '.standalone-runtime';
const SIDECAR_DOMAIN = 'standalone-thread-journal-v1';

export interface StandaloneThreadIdentity {
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
}

export interface StandaloneThreadJournalBootstrap {
  readonly meta: ThreadMetaRecord;
  readonly legacySeed?: LegacyThreadSeedRecord;
}

export interface StandaloneThreadJournalOpenOptions {
  readonly dir: string;
  readonly sessionId: string;
  /** Exact cwd bytes recorded by the v1 Session meta. */
  readonly recordedCwd: string;
  readonly lease: StandaloneSessionLease;
  /** Required only when the sidecar does not exist yet. */
  readonly bootstrap?: StandaloneThreadJournalBootstrap;
}

/** Stable legacy identity projection shared by create and resume. */
export function standaloneThreadIdentity(
  recordedCwd: string,
  sessionId: string,
): Readonly<StandaloneThreadIdentity> {
  const workspaceId = legacyWorkspaceId(recordedCwd);
  return Object.freeze({
    workspaceId,
    threadId: legacyThreadId(workspaceId, sessionId),
  });
}

/**
 * A private JSONL implementation of the canonical append port.
 *
 * `releaseWriteLease()` only closes this port. The caller owns and releases the backend-scoped
 * StandaloneSessionLease after ThreadRuntime/EventCommitter have fully drained.
 */
export class StandaloneThreadJournalPort implements ThreadJournalAppendPort {
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly file: string;
  readonly created: boolean;
  readonly #recordedCwd: string;
  readonly #sessionId: string;
  readonly #lease: StandaloneSessionLease;
  #appendFd: number | undefined;
  #expectedSize: number;
  #highWaterSeq: number;
  #closed = false;

  private constructor(input: {
    readonly identity: Readonly<StandaloneThreadIdentity>;
    readonly file: string;
    readonly recordedCwd: string;
    readonly sessionId: string;
    readonly lease: StandaloneSessionLease;
    readonly created: boolean;
    readonly appendFd: number;
    readonly expectedSize: number;
    readonly highWaterSeq: number;
  }) {
    this.workspaceId = input.identity.workspaceId;
    this.threadId = input.identity.threadId;
    this.file = input.file;
    this.#recordedCwd = input.recordedCwd;
    this.#sessionId = input.sessionId;
    this.#lease = input.lease;
    this.created = input.created;
    this.#appendFd = input.appendFd;
    this.#expectedSize = input.expectedSize;
    this.#highWaterSeq = input.highWaterSeq;
  }

  static async open(options: StandaloneThreadJournalOpenOptions): Promise<StandaloneThreadJournalPort> {
    options.lease.assertCurrent();
    const identity = standaloneThreadIdentity(options.recordedCwd, options.sessionId);
    mkdirSync(options.dir, { recursive: true });
    const canonicalDir = realpathSync(options.dir);
    const sidecarDir = path.join(canonicalDir, SIDECAR_DIRECTORY);
    mkdirSync(sidecarDir, { recursive: true });
    const file = path.join(
      sidecarDir,
      `${sha256Hex(`${SIDECAR_DOMAIN}\0${canonicalDir}\0${options.sessionId}`)}.jsonl`,
    );

    let created = false;
    if (!existsSync(file)) {
      const bootstrap = options.bootstrap;
      if (bootstrap === undefined) {
        throw new RuntimeStorageError(
          'standalone_sidecar_missing',
          `Standalone thread sidecar is missing for Session ${options.sessionId}`,
        );
      }
      const records: RuntimeJournalRecord[] = [
        bootstrap.meta,
        ...(bootstrap.legacySeed === undefined ? [] : [bootstrap.legacySeed]),
      ];
      const validated = validateJournal(
        records,
        identity,
        options.recordedCwd,
        options.sessionId,
      );
      createAtomic(file, validated);
      created = true;
    }

    // A process may die after writing a complete record but before its LF, or midway through the
    // final record. Repair only that physical tail while this backend's lease is authoritative;
    // newline-terminated/middle corruption remains fail-closed in readRecords/validateJournal.
    assertRegularFile(file);
    repairTornTail(file, options.lease);
    const initialRecords = validateJournal(
      readRecords(file),
      identity,
      options.recordedCwd,
      options.sessionId,
    );
    const appendFd = openSync(file, 'a');
    try {
      const stat = fstatSync(appendFd);
      const port = new StandaloneThreadJournalPort({
        identity,
        file,
        recordedCwd: options.recordedCwd,
        sessionId: options.sessionId,
        lease: options.lease,
        created,
        appendFd,
        expectedSize: stat.size,
        highWaterSeq: foldThreadJournal(initialRecords).highWaterSeq,
      });
      options.lease.assertCurrent();
      return port;
    } catch (error) {
      closeSync(appendFd);
      throw error;
    }
  }

  async load(): Promise<readonly RuntimeJournalRecord[]> {
    this.#assertWritable();
    const fd = this.#appendFd;
    if (fd === undefined) {
      throw new RuntimeStorageError('standalone_journal_closed', 'Standalone journal is closed');
    }
    this.#assertAppendTarget(fd);
    const records = readRecords(this.file);
    const validated = validateJournal(
      records,
      { workspaceId: this.workspaceId, threadId: this.threadId },
      this.#recordedCwd,
      this.#sessionId,
    );
    if (foldThreadJournal(validated).highWaterSeq !== this.#highWaterSeq) {
      throw new RuntimeStorageError(
        'standalone_journal_changed',
        'Standalone journal changed outside its writer authority',
      );
    }
    return validated;
  }

  async append(
    records: readonly RuntimeJournalRecord[],
    options: { readonly flush: true },
  ): Promise<void> {
    this.#assertWritable();
    if (options.flush !== true) {
      throw new RuntimeStorageError('standalone_flush_required', 'Standalone journal append must flush');
    }
    if (records.length === 0) return;

    const validated = validateAppend(
      records,
      { workspaceId: this.workspaceId, threadId: this.threadId },
      this.#highWaterSeq,
    );
    const data = `${validated.records.map((record) => canonicalJson(record)).join('\n')}\n`;
    this.#lease.assertCurrent();
    const fd = this.#appendFd;
    if (fd === undefined) {
      throw new RuntimeStorageError('standalone_journal_closed', 'Standalone journal is closed');
    }
    this.#assertAppendTarget(fd);
    try {
      writeFileSync(fd, data, 'utf8');
      fsyncSync(fd);
    } catch (error) {
      this.#closeAppendFd();
      this.#closed = true;
      throw error;
    }
    this.#expectedSize += new TextEncoder().encode(data).byteLength;
    this.#highWaterSeq = validated.highWaterSeq;
    this.#lease.assertCurrent();
  }

  async releaseWriteLease(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeAppendFd();
  }

  #assertWritable(): void {
    if (this.#closed) {
      throw new RuntimeStorageError('standalone_journal_closed', 'Standalone journal is closed');
    }
    this.#lease.assertCurrent();
    assertRegularFile(this.file);
  }

  #assertAppendTarget(fd: number): void {
    const descriptor = fstatSync(fd);
    const target = lstatSync(this.file);
    if (!target.isFile() || target.isSymbolicLink()
      || descriptor.dev !== target.dev || descriptor.ino !== target.ino
      || descriptor.size !== this.#expectedSize || target.size !== this.#expectedSize) {
      throw new RuntimeStorageError(
        'standalone_journal_changed',
        'Standalone journal changed outside its writer authority',
      );
    }
  }

  #closeAppendFd(): void {
    const fd = this.#appendFd;
    this.#appendFd = undefined;
    if (fd !== undefined) closeSync(fd);
  }
}

function createAtomic(file: string, records: readonly RuntimeJournalRecord[]): void {
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  let linked = false;
  try {
    const fd = openSync(temporary, 'wx');
    try {
      const data = `${records.map((record) => canonicalJson(record)).join('\n')}\n`;
      writeFileSync(fd, data, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // A hard-link install is atomic and refuses to replace an independently-created sidecar.
    linkSync(temporary, file);
    linked = true;
    fsyncDirectory(directory);
  } catch (error) {
    if (isAlreadyExists(error) && existsSync(file)) return;
    throw error;
  } finally {
    try { unlinkSync(temporary); } catch { /* the temporary may not have been created */ }
    if (linked) fsyncDirectory(directory);
  }
}

function readRecords(file: string): readonly RuntimeJournalRecord[] {
  assertRegularFile(file);
  const raw = readFileSync(file, 'utf8');
  if (raw.length === 0 || !raw.endsWith('\n')) {
    throw new RuntimeStorageError('corrupt_thread_journal', 'Standalone journal has a corrupt tail');
  }
  const lines = raw.slice(0, -1).split('\n');
  if (lines.some((line) => line.length === 0)) {
    throw new RuntimeStorageError('corrupt_thread_journal', 'Standalone journal contains an empty record');
  }
  try {
    return lines.map((line) => strictJsonSnapshot(JSON.parse(line)) as unknown as RuntimeJournalRecord);
  } catch (error) {
    throw new RuntimeStorageError(
      'corrupt_thread_journal',
      `Standalone journal is not valid JSONL: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function repairTornTail(file: string, lease: StandaloneSessionLease): void {
  lease.assertCurrent();
  const fd = openSync(file, 'r+');
  try {
    const descriptor = fstatSync(fd);
    const target = lstatSync(file);
    if (!target.isFile() || target.isSymbolicLink()
      || descriptor.dev !== target.dev || descriptor.ino !== target.ino) {
      throw new RuntimeStorageError(
        'standalone_journal_changed',
        'Standalone journal changed outside its writer authority',
      );
    }

    const raw = readFileSync(fd);
    if (raw.length === 0 || raw[raw.length - 1] === 0x0a) return;

    const lastNewline = raw.lastIndexOf(0x0a);
    const fragment = raw.subarray(lastNewline + 1);
    let completeJson = false;
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(fragment);
      JSON.parse(decoded);
      completeJson = true;
    } catch {
      // A non-JSON final fragment can only be an interrupted append and is safe to discard.
    }

    if (completeJson) {
      const written = writeSync(fd, '\n', raw.length, 'utf8');
      if (written !== 1) {
        throw new RuntimeStorageError(
          'standalone_journal_write_failed',
          'Could not complete the standalone journal tail',
        );
      }
    } else {
      ftruncateSync(fd, lastNewline + 1);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  lease.assertCurrent();
}

/**
 * Validate only the new durable boundary. TranscriptRepository has already folded the complete
 * candidate journal before calling append; repeating a read/parse/full fold here made N event
 * commits quadratic twice over. Open/resume still validates the complete persisted journal.
 */
function validateAppend(
  input: readonly RuntimeJournalRecord[],
  identity: Readonly<StandaloneThreadIdentity>,
  currentHighWaterSeq: number,
): {
  readonly records: readonly RuntimeJournalRecord[];
  readonly highWaterSeq: number;
} {
  const records = input.map((record) =>
    strictJsonSnapshot(record) as unknown as RuntimeJournalRecord);
  let highWaterSeq = currentHighWaterSeq;
  for (const record of records) {
    if (record.type === 'thread_meta' || record.type === 'legacy_seed') {
      throw new RuntimeStorageError(
        'invalid_thread_journal',
        'Standalone journal bootstrap records cannot be appended',
      );
    }
    validateRuntimeRecord(record, identity);
    if (record.type === 'commit') {
        if (!Number.isSafeInteger(record.firstSeq) || record.firstSeq !== highWaterSeq + 1
          || record.firstSeq < 1) {
          throw new RuntimeStorageError('invalid_thread_journal', 'Invalid standalone commit');
        }
        highWaterSeq += record.envelopes.length;
    }
  }
  return { records, highWaterSeq };
}

function validateJournal(
  input: readonly RuntimeJournalRecord[],
  identity: Readonly<StandaloneThreadIdentity>,
  recordedCwd: string,
  sessionId: string,
): readonly RuntimeJournalRecord[] {
  const records = input.map((record) =>
    strictJsonSnapshot(record) as unknown as RuntimeJournalRecord);
  const meta = records[0];
  if (meta === undefined || meta.type !== 'thread_meta') {
    throw new RuntimeStorageError('invalid_thread_journal', 'Standalone journal has no thread_meta');
  }
  validateMeta(meta, identity, recordedCwd);
  let seedCount = 0;
  for (let index = 1; index < records.length; index++) {
    const record = records[index] as RuntimeJournalRecord;
    switch (record.type) {
      case 'legacy_seed':
        seedCount++;
        if (record.sourceSessionId !== sessionId || index !== 1 || seedCount !== 1) {
          throw new RuntimeStorageError('standalone_identity_mismatch', 'Legacy seed ownership is invalid');
        }
        validateLegacySeed(record, identity);
        break;
      case 'thread_meta':
        throw new RuntimeStorageError('invalid_thread_journal', 'Standalone journal repeats thread_meta');
      default:
        validateRuntimeRecord(record, identity);
        break;
    }
  }
  // The canonical reducer is the final sequence/state-machine validation before durable append.
  foldThreadJournal(records);
  return records;
}

function validateMeta(
  meta: ThreadMetaRecord,
  identity: Readonly<StandaloneThreadIdentity>,
  recordedCwd: string,
): void {
  if (!hasExactKeys(meta as unknown, [
    'type', 'version', 'protocolVersion', 'workspaceId', 'threadId', 'permissionCeiling',
    'createdAt', 'cwd', 'model',
  ], ['parentThreadId', 'createdByRunId', 'createdByOpId', 'driverRef'])
    || meta.version !== 2 || !isWorkspaceId(meta.workspaceId) || !isThreadId(meta.threadId)
    || meta.workspaceId !== identity.workspaceId || meta.threadId !== identity.threadId
    || meta.cwd !== recordedCwd) {
    throw new RuntimeStorageError('standalone_identity_mismatch', 'Standalone thread identity is invalid');
  }
  if (typeof meta.protocolVersion !== 'string' || meta.protocolVersion.length === 0
    || !Number.isFinite(meta.createdAt) || !isModelRef(meta.model)
    || (meta.parentThreadId !== undefined && !isThreadId(meta.parentThreadId))
    || (meta.createdByRunId !== undefined && !isRunId(meta.createdByRunId))
    || (meta.createdByOpId !== undefined && !isExternalOpId(meta.createdByOpId))) {
    throw new RuntimeStorageError('invalid_thread_meta', 'Standalone thread metadata is invalid');
  }
  validatePermissionCeilingSnapshot(meta.permissionCeiling);
}

function validateRuntimeRecord(
  record: Exclude<RuntimeJournalRecord, ThreadMetaRecord | LegacyThreadSeedRecord>,
  identity: Readonly<StandaloneThreadIdentity>,
): void {
  try {
    validateRuntimeRecordUnchecked(record, identity);
  } catch (error) {
    if (error instanceof RuntimeStorageError
      && (error.code === 'standalone_identity_mismatch' || error.code === 'invalid_thread_journal')) {
      throw error;
    }
    throw invalidJournal(error instanceof Error ? error.message : String(error));
  }
}

function validateRuntimeRecordUnchecked(
  record: Exclude<RuntimeJournalRecord, ThreadMetaRecord | LegacyThreadSeedRecord>,
  identity: Readonly<StandaloneThreadIdentity>,
): void {
  switch (record.type) {
    case 'mailbox_prepare':
      if (!hasExactKeys(record as unknown, ['type', 'opId', 'op', 'timestamp'])
        || !isOpId(record.opId) || record.op.opId !== record.opId
        || !Number.isFinite(record.timestamp)
        || !validateMailboxOp(record.op, identity)) {
        throw invalidJournal('Invalid standalone mailbox prepare');
      }
      return;
    case 'successor_run_prepare':
      if (!hasExactKeys(record as unknown, [
        'type', 'runId', 'predecessorRunId', 'reason', 'permissionCeiling', 'timestamp',
      ]) || !isRunId(record.runId) || !isRunId(record.predecessorRunId)
        || (record.reason !== 'retry' && record.reason !== 'compaction')
        || !Number.isFinite(record.timestamp)) {
        throw invalidJournal('Invalid successor reservation');
      }
      validatePermissionCeilingSnapshot(record.permissionCeiling);
      return;
    case 'turn_prepare':
      if (!hasExactKeys(record as unknown, [
        'type', 'runId', 'turnId', 'turnOrdinal', 'workspaceCeiling', 'runCeiling',
        'turnCeiling', 'timestamp',
      ]) || !isRunId(record.runId) || !isTurnId(record.turnId)
        || !isPositiveSafeInteger(record.turnOrdinal) || !Number.isFinite(record.timestamp)) {
        throw invalidJournal('Invalid turn reservation');
      }
      validatePermissionCeilingSnapshot(record.workspaceCeiling);
      validatePermissionCeilingSnapshot(record.runCeiling);
      validatePermissionCeilingSnapshot(record.turnCeiling);
      return;
    case 'thread_result_delivered':
      if (!hasExactKeys(record as unknown, [
        'type', 'resultOpId', 'parentThreadId', 'parentCommitSeq',
      ]) || !isDerivedOpId(record.resultOpId) || !isThreadId(record.parentThreadId)
        || !isPositiveSafeInteger(record.parentCommitSeq)) {
        throw invalidJournal('Invalid thread result delivery');
      }
      return;
    case 'commit':
      if (!hasExactKeys(record as unknown, ['type', 'firstSeq', 'envelopes'], ['mutations'])
        || !isPositiveSafeInteger(record.firstSeq) || !Array.isArray(record.envelopes)
        || record.envelopes.length === 0
        || (record.mutations !== undefined && !Array.isArray(record.mutations))) {
        throw invalidJournal('Invalid standalone commit');
      }
      for (const [offset, envelope] of record.envelopes.entries()) {
        const validated = validateEventEnvelope(envelope);
        if (validated.workspaceId !== identity.workspaceId
          || validated.threadId !== identity.threadId
          || validated.seq !== record.firstSeq + offset) {
          throw new RuntimeStorageError(
            'standalone_identity_mismatch',
            'Commit envelope ownership is invalid',
          );
        }
      }
      for (const mutation of record.mutations ?? []) validateMutation(mutation, identity);
      return;
  }
}

function validateMailboxOp(
  input: unknown,
  identity: Readonly<StandaloneThreadIdentity>,
): boolean {
  if (!isRecord(input) || input.workspaceId !== identity.workspaceId
    || input.threadId !== identity.threadId) return false;
  try {
    if (isExternalOpId(input.opId)) {
      const canonical = canonicalizeRuntimeOp(input);
      return canonical.type !== 'thread_create' && canonical.type !== 'thread_resume'
        && canonical.type !== 'cancel_scope'
        && canonicalJson(canonical) === canonicalJson(input);
    }
    if (!isDerivedOpId(input.opId)) return false;
    if (input.type === 'abort') {
      return hasExactKeys(input, [
        'type', 'opId', 'workspaceId', 'threadId', 'parentOpId', 'resolvedTarget',
      ]) && isExternalOpId(input.parentOpId) && isResolvedAbortTarget(input.resolvedTarget);
    }
    return input.type === 'thread_close'
      && hasExactKeys(input, ['type', 'opId', 'workspaceId', 'threadId'], ['parentOpId'])
      && (input.parentOpId === undefined || isExternalOpId(input.parentOpId));
  } catch {
    return false;
  }
}

function validateMutation(
  input: unknown,
  identity: Readonly<StandaloneThreadIdentity>,
): void {
  if (!isRecord(input) || typeof input.type !== 'string') throw invalidMutation('missing discriminator');
  const value = input;
  switch (value.type) {
    case 'accepted_pending':
      if (!isOpId(value.opId) || typeof value.opType !== 'string') break;
      if (value.opType === 'abort') {
        if (!hasExactKeys(value, ['type', 'opId', 'opType', 'resolvedTarget'], ['parentOpId'])
          || !isResolvedAbortTarget(value.resolvedTarget)
          || (value.parentOpId !== undefined && !isExternalOpId(value.parentOpId))) break;
      } else if (!hasExactKeys(value, ['type', 'opId', 'opType'])
        || !isMailboxOpType(value.opType)) break;
      return;
    case 'started':
      if (hasExactKeys(value, ['type', 'opId']) && isOpId(value.opId)) return;
      break;
    case 'completed':
      if (hasExactKeys(value, ['type', 'opId', 'outcome']) && isOpId(value.opId)
        && isOutcome(value.outcome)) return;
      break;
    case 'rejected':
      if (hasExactKeys(value, ['type', 'opId', 'reason']) && isOpId(value.opId)
        && isWellFormedString(value.reason)) return;
      break;
    case 'input_materialized':
      if (hasExactKeys(value, ['type', 'ownerOpId', 'messageId']) && isOpId(value.ownerOpId)
        && isWellFormedString(value.messageId)) return;
      break;
    case 'input_transferred':
      if (hasExactKeys(value, ['type', 'fromOpId', 'toOpId']) && isOpId(value.fromOpId)
        && isOpId(value.toOpId)) return;
      break;
    case 'input_cancelled':
      if (hasExactKeys(value, ['type', 'ownerOpId', 'byAbortOpId']) && isOpId(value.ownerOpId)
        && isOpId(value.byAbortOpId)) return;
      break;
    case 'message_appended':
      if (!hasExactKeys(value, ['type', 'message'])) break;
      validateSeedMessage(value.message, identity);
      return;
    case 'compaction_committed':
      if (!hasExactKeys(value, ['type', 'compaction'])) break;
      validateCompactionCheckpoint(value.compaction);
      return;
    case 'control_requested':
      if (!hasExactKeys(value, ['type', 'request']) || !isRecord(value.request)
        || value.request.type !== 'control_request') break;
      validateControlEvent(value.request, identity);
      return;
    case 'control_response_claimed':
      if (hasExactKeys(value, ['type', 'requestId', 'responseOpId', 'decision', 'acceptedAt'])
        && isWellFormedString(value.requestId) && isExternalOpId(value.responseOpId)
        && isControlDecision(value.decision) && Number.isFinite(value.acceptedAt)) return;
      break;
    case 'control_response_claim_released':
      if (hasExactKeys(value, ['type', 'requestId', 'responseOpId', 'reason'])
        && isWellFormedString(value.requestId) && isExternalOpId(value.responseOpId)
        && value.reason === 'effect_definitely_not_applied') return;
      break;
    case 'control_resolved':
      if (!hasExactKeys(value, ['type', 'resolution']) || !isRecord(value.resolution)
        || value.resolution.type !== 'control_resolved') break;
      validateControlEvent(value.resolution, identity);
      return;
    case 'run_reserved':
      if (!hasExactKeys(value, ['type', 'runId', 'reason', 'permissionCeiling'], [
        'ownerOpId', 'predecessorRunId',
      ]) || !isRunId(value.runId)) break;
      validatePermissionCeilingSnapshot(value.permissionCeiling);
      if ((value.reason === 'prompt' || value.reason === 'continue' || value.reason === 'compact')
        && isOpId(value.ownerOpId)
        && (value.predecessorRunId === undefined || (value.reason === 'continue'
          && isRunId(value.predecessorRunId)))) return;
      if ((value.reason === 'retry' || value.reason === 'compaction')
        && value.ownerOpId === undefined && isRunId(value.predecessorRunId)) return;
      break;
    case 'run_started':
      if (hasExactKeys(value, ['type', 'runId']) && isRunId(value.runId)) return;
      break;
    case 'run_terminal':
      if (hasExactKeys(value, ['type', 'runId', 'status']) && isRunId(value.runId)
        && isRunTerminalStatus(value.status)) return;
      break;
    case 'turn_activated':
      if (hasExactKeys(value, ['type', 'runId', 'turnId', 'turnOrdinal']) && isRunId(value.runId)
        && isTurnId(value.turnId) && isPositiveSafeInteger(value.turnOrdinal)) return;
      break;
    case 'activity_interrupted':
      if (hasExactKeys(value, [
        'type', 'rootOpId', 'rootRunId', 'terminalRunId', 'discardedStartedToolCallIds',
      ], ['terminalTurnId', 'discardedPartialAssistantId'])
        && isOpId(value.rootOpId) && isRunId(value.rootRunId) && isRunId(value.terminalRunId)
        && (value.terminalTurnId === undefined || isTurnId(value.terminalTurnId))
        && (value.discardedPartialAssistantId === undefined
          || isWellFormedString(value.discardedPartialAssistantId))
        && isStringArray(value.discardedStartedToolCallIds)) return;
      break;
    case 'model_selected':
      if (hasExactKeys(value, ['type', 'ownerOpId', 'model']) && isOpId(value.ownerOpId)
        && isModelRef(value.model)) return;
      break;
    case 'thread_title_updated':
      if (hasExactKeys(value, ['type', 'title', 'updatedAt'])
        && isWellFormedString(value.title) && value.title.trim().length > 0
        && value.title.length <= 200 && Number.isFinite(value.updatedAt)) return;
      break;
    case 'thread_archive_updated':
      if (hasExactKeys(value, ['type', 'updatedAt'], ['archivedAt'])
        && Number.isFinite(value.updatedAt)
        && (value.archivedAt === undefined || Number.isFinite(value.archivedAt))) return;
      break;
    case 'rule_scope_observed':
      if (hasExactKeys(value, ['type', 'scope', 'owningTurnId', 'invocationId'])
        && isWellFormedString(value.scope) && isTurnId(value.owningTurnId)
        && isWellFormedString(value.invocationId)) return;
      break;
    case 'rule_scope_window_replaced':
      if (hasExactKeys(value, [
        'type', 'consumedScopes', 'replacementScopes', 'owningTurnId',
      ]) && isCanonicalScopeArray(value.consumedScopes)
        && isCanonicalScopeArray(value.replacementScopes)
        && isTurnId(value.owningTurnId)) return;
      break;
    case 'thread_result_pending':
      if (hasExactKeys(value, [
        'type', 'resultOpId', 'parentThreadId', 'childThreadId', 'terminalRunId', 'status',
      ], ['summary']) && isDerivedOpId(value.resultOpId) && isThreadId(value.parentThreadId)
        && isThreadId(value.childThreadId) && isRunId(value.terminalRunId)
        && (value.status === 'completed' || value.status === 'aborted' || value.status === 'error')
        && (value.summary === undefined || isWellFormedString(value.summary))) return;
      break;
    default:
      throw invalidMutation(`unknown ${value.type}`);
  }
  throw invalidMutation(`malformed ${value.type}`);
}

function validateControlEvent(
  input: Readonly<Record<string, unknown>>,
  identity: Readonly<StandaloneThreadIdentity>,
): void {
  const event = input as unknown as Extract<import('../protocol/index.js').RuntimeEvent, {
    type: 'control_request' | 'control_resolved';
  }>;
  validateEventEnvelope({
    workspaceId: identity.workspaceId,
    threadId: identity.threadId,
    runId: event.owningRunId,
    turnId: event.owningTurnId,
    ...(event.type === 'control_resolved' && {
      opId: 'op_e_00000000000000000000000000000000' as const,
    }),
    seq: 1,
    timestamp: 0,
    event,
  });
}

function validateCompactionCheckpoint(input: unknown): void {
  if (!isRecord(input) || !hasExactKeys(
    input,
    ['id', 'timestamp', 'tailStartId', 'summary'],
    ['contextTokensBefore'],
  ) || !isWellFormedString(input.id) || !Number.isFinite(input.timestamp)
    || !isWellFormedString(input.tailStartId) || !isWellFormedString(input.summary)
    || (input.contextTokensBefore !== undefined && !Number.isFinite(input.contextTokensBefore))) {
    throw invalidMutation('invalid compaction checkpoint');
  }
}

function isResolvedAbortTarget(input: unknown): boolean {
  if (!isRecord(input) || typeof input.kind !== 'string') return false;
  if (input.kind === 'run') {
    return hasExactKeys(input, ['kind', 'runId']) && isRunId(input.runId);
  }
  if (input.kind === 'suspended') {
    return hasExactKeys(input, ['kind', 'ownerOpId', 'terminalRunId'], ['inputOwnerOpId'])
      && isOpId(input.ownerOpId) && isRunId(input.terminalRunId)
      && (input.inputOwnerOpId === undefined || isOpId(input.inputOwnerOpId));
  }
  return input.kind === 'no_current_activity' && hasExactKeys(input, ['kind']);
}

function isMailboxOpType(value: string): boolean {
  return value === 'prompt' || value === 'continue' || value === 'steer'
    || value === 'follow_up' || value === 'set_model'
    || value === 'control_response' || value === 'thread_rename'
    || value === 'thread_archive' || value === 'compact'
    || value === 'thread_close';
}

function isOutcome(value: unknown): boolean {
  return value === 'applied' || value === 'no_op'
    || value === 'interrupted' || value === 'superseded';
}

function isRunTerminalStatus(value: unknown): boolean {
  return value === 'completed' || value === 'aborted'
    || value === 'error' || value === 'interrupted';
}

function isControlDecision(value: unknown): boolean {
  return value === 'allow_once' || value === 'allow_always'
    || value === 'deny' || value === 'confirm';
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isWellFormedString(value: unknown): value is string {
  return typeof value === 'string' && isWellFormedUnicode(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isWellFormedString);
}

function isCanonicalScopeArray(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.every((scope) => isWellFormedString(scope) && scope.length > 0)
    && value.every((scope, index) => index === 0
      || compareUtf8(value[index - 1] as string, scope) < 0);
}

function compareUtf8(left: string, right: string): number {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index++) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function invalidJournal(message: string): RuntimeStorageError {
  return new RuntimeStorageError('invalid_thread_journal', message);
}

function invalidMutation(message: string): RuntimeStorageError {
  return new RuntimeStorageError('invalid_thread_mutation', message);
}

function validateLegacySeed(
  seed: LegacyThreadSeedRecord,
  identity: Readonly<StandaloneThreadIdentity>,
): void {
  if (!hasExactKeys(seed as unknown, ['type', 'sourceSessionId', 'transcript', 'usage'], [
    'compaction', 'mirrorRecords', 'turnProvenance',
  ])
    || typeof seed.sourceSessionId !== 'string' || seed.sourceSessionId.length === 0
    || !seed.sourceSessionId.isWellFormed()
    || !Array.isArray(seed.transcript)
    || (seed.mirrorRecords !== undefined && !Array.isArray(seed.mirrorRecords))) {
    throw new RuntimeStorageError('invalid_legacy_seed', 'Standalone legacy seed is invalid');
  }
  for (const message of seed.transcript) validateSeedMessage(message, identity);
  if (seed.turnProvenance !== undefined) {
    if (seed.turnProvenance.length !== seed.transcript.length) {
      throw new RuntimeStorageError('invalid_legacy_seed', 'Invalid legacy turn provenance');
    }
    for (const [index, provenance] of seed.turnProvenance.entries()) {
      if (!isRecord(provenance)
        || !hasExactKeys(provenance, ['messageId', 'turnId'])
        || typeof provenance.messageId !== 'string'
        || provenance.messageId !== seed.transcript[index]?.id
        || typeof provenance.turnId !== 'string'
        || provenance.turnId.length === 0
        || !provenance.turnId.isWellFormed()) {
        throw new RuntimeStorageError('invalid_legacy_seed', 'Invalid legacy turn provenance');
      }
    }
  }
  validateEventEnvelope({
    workspaceId: identity.workspaceId,
    threadId: identity.threadId,
    runId: 'run_standalone_seed_validation',
    turnId: 'turn_standalone_seed_validation',
    seq: 1,
    timestamp: 0,
    event: { type: 'usage_update', usage: seed.usage },
  });
  if (seed.compaction !== undefined) validateLegacyCompaction(seed.compaction);
  for (const record of seed.mirrorRecords ?? []) {
    if (!isRecord(record)) {
      throw new RuntimeStorageError('invalid_legacy_seed', 'Invalid legacy mirror record');
    }
    if (record.type === 'message' && hasExactKeys(record, ['type', 'message'])) {
      validateSeedMessage(record.message, identity);
      continue;
    }
    if (record.type === 'compaction' && hasExactKeys(
      record,
      ['type', 'id', 'timestamp', 'tailStartId', 'summary'],
      ['contextTokensBefore'],
    )) {
      validateLegacyCompaction(record);
      continue;
    }
    throw new RuntimeStorageError('invalid_legacy_seed', 'Invalid legacy mirror record');
  }
}

function validateSeedMessage(
  message: unknown,
  identity: Readonly<StandaloneThreadIdentity>,
): void {
  validateEventEnvelope({
    workspaceId: identity.workspaceId,
    threadId: identity.threadId,
    runId: 'run_standalone_seed_validation',
    turnId: 'turn_standalone_seed_validation',
    seq: 1,
    timestamp: 0,
    event: {
      type: 'message_end',
      message: message as LegacyThreadSeedRecord['transcript'][number],
    },
  });
}

function validateLegacyCompaction(input: unknown): void {
  if (!isRecord(input)) {
    throw new RuntimeStorageError('invalid_legacy_seed', 'Invalid legacy compaction record');
  }
  const value = input;
  if (typeof value.id !== 'string' || !value.id.isWellFormed()
    || !Number.isFinite(value.timestamp)
    || typeof value.tailStartId !== 'string' || !value.tailStartId.isWellFormed()
    || typeof value.summary !== 'string' || !value.summary.isWellFormed()
    || (value.contextTokensBefore !== undefined
      && (typeof value.contextTokensBefore !== 'number' || !Number.isFinite(value.contextTokensBefore)))) {
    throw new RuntimeStorageError('invalid_legacy_seed', 'Invalid legacy compaction record');
  }
}

function hasExactKeys(
  input: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  if (!isRecord(input)) return false;
  const value = input;
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => allowed.has(key));
}

function isModelRef(value: unknown): boolean {
  return isRecord(value)
    && typeof value.provider === 'string' && value.provider.length > 0
    && typeof value.api === 'string' && value.api.length > 0
    && typeof value.model === 'string' && value.model.length > 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertRegularFile(file: string): void {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new RuntimeStorageError('unsafe_storage_key', 'Standalone sidecar must be a regular file');
  }
}

function fsyncDirectory(directory: string): void {
  const fd = openSync(directory, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EEXIST';
}
