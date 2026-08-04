// Explicit-root JSON/JSONL RuntimeStoragePort. The factory is pure; all filesystem and
// lease activity starts at an explicit query/open call. A kernel-held loopback listener is
// the workspace writer authority, while on-disk lock records are audit/fencing metadata only.

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type {
  PolicyGrant,
  PolicyGrantCommitResult,
  PolicyGrantRepository,
  PolicyGrantSnapshot,
} from '../capabilities/types.js';
import {
  assertThreadId,
  assertWorkspaceId,
  canonicalJson,
  canonicalJsonSha256,
  classifyProtocolVersion,
  canonicalizeRuntimeOp,
  isDerivedOpId,
  isExternalOpId,
  isOpId,
  isRunId,
  isThreadId,
  isTurnId,
  isWellFormedUnicode,
  workspaceIdFromCwd,
  runtimeOpPayloadHash,
  sha256Hex,
  strictJsonSnapshot,
  validateEventEnvelope,
  PROTOCOL_VERSION,
} from '../protocol/index.js';
import type {
  AgentMessage,
  ExternalOpId,
  ModelRef,
  ThreadId,
  WorkspaceId,
  WorkspaceWriteFence,
  WorkspaceWriteFenceValidation,
} from '../protocol/index.js';
import { RuntimeStorageError, WorkspaceBindingMismatchError, WorkspaceInUseError } from './errors.js';
import {
  cloneJournalMessageCodecState,
  decodeDurableCommitRecord,
  emptyJournalMessageCodecState,
  encodeDurableJournalRecord,
} from '../session/thread-journal-codec.js';
import type { JournalMessageCodecState } from '../session/thread-journal-codec.js';
import {
  foldThreadJournal,
  foldThreadJournalAppend,
  threadJournalRequiresRecovery,
} from '../session/thread-journal.js';
import type { FoldedThreadJournal } from '../session/thread-journal.js';
import {
  deserializeThreadRecoveryState,
  serializeThreadRecoveryState,
} from '../session/thread-recovery-snapshot.js';
import type { SerializedThreadRecoveryState } from '../session/thread-recovery-snapshot.js';
import type {
  DerivedOpIdentityClaim,
  DerivedOpIdentityReservation,
  RuntimeJournalRecord,
  RuntimeStoragePort,
  RuntimeThreadMutation,
  RuntimeWorkspaceStoragePort,
  StoredThreadLocator,
  SupervisorLease,
  SupervisorOpLedgerRecord,
  SupervisorOpReservation,
  ThreadCatalogRecord,
  ThreadJournalPort,
  ThreadMetaRecord,
  ThreadSeedRecord,
} from './ports.js';

export interface FileRuntimeStorageOptions {
  readonly root: string;
  /** Deterministic diagnostics for proving that listing/startup do not consume journal bodies. */
  readonly onJournalRead?: (observation: Readonly<{
    readonly threadId: ThreadId;
    readonly kind: 'body' | 'tail' | 'snapshot';
    readonly bytes: number;
  }>) => void;
}

type JournalReadObserver = NonNullable<FileRuntimeStorageOptions['onJournalRead']>;

interface WorkspaceBindingFile {
  readonly version: 1;
  readonly workspaceId: WorkspaceId;
  readonly recordedCwd: string;
}

interface WorkspaceLedgerFile {
  readonly version: 1;
  readonly fencingCounter: number;
  readonly ops: readonly SupervisorOpLedgerRecord[];
  readonly derived: readonly DerivedOpIdentityClaim[];
}

interface ThreadCatalogFile {
  readonly version: 1;
  readonly threads: readonly ThreadCatalogRecord[];
}

interface PolicyGrantStoreFile {
  readonly version: 1;
  readonly workspaceId: WorkspaceId;
  readonly grants: readonly Readonly<PolicyGrant>[];
}

interface SupervisorLockRecord {
  readonly version: 1;
  readonly workspaceId: WorkspaceId;
  readonly processEpoch: string;
  readonly fencingToken: string;
  readonly pid: number;
  readonly authority: { readonly kind: 'loopback_tcp'; readonly port: number };
}

interface ThreadLockRecord {
  readonly version: 1;
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly processEpoch: string;
  readonly fencingToken: string;
  readonly ownerNonce: string;
}

export interface FileRuntimeWorkspaceStoragePort extends RuntimeWorkspaceStoragePort {
  openPolicyGrantRepository(
    lease: Readonly<SupervisorLease>,
  ): Promise<PolicyGrantRepository>;
}

export interface FileRuntimeStorage extends RuntimeStoragePort {
  openWorkspace(input: {
    readonly cwd: string;
    readonly workspaceId?: WorkspaceId;
  }): Promise<FileRuntimeWorkspaceStoragePort>;
}

export function createFileRuntimeStorage(options: FileRuntimeStorageOptions): FileRuntimeStorage {
  assertSafeAbsolutePath(options.root, 'root');
  const root = options.root;
  return {
    async listStoredThreads(): Promise<readonly StoredThreadLocator[]> {
      return snapshot(readAllCanonicalLocators(root));
    },

    async openWorkspace(input): Promise<FileRuntimeWorkspaceStoragePort> {
      assertExecutableCwd(input.cwd);
      const workspaceId = input.workspaceId === undefined
        ? workspaceIdFromCwd(input.cwd)
        : assertWorkspaceId(input.workspaceId);
      ensureDirectoryTreeNoSymlink(root);
      const workspaceDir = safeChild(root, `ws-${sha256Hex(workspaceId)}`);
      ensureDirectChildDirectory(root, workspaceDir);
      const bindingFile = safeChild(workspaceDir, 'binding.json');
      const requested = snapshot<WorkspaceBindingFile>({
        version: 1,
        workspaceId,
        recordedCwd: input.cwd,
      });
      try {
        writeJsonExclusive(bindingFile, requested);
      } catch (error) {
        if (!isAlreadyExists(error)) throw storageFailure('workspace_binding_write_failed', bindingFile, error);
      }
      const binding = readBinding(bindingFile);
      if (binding.workspaceId !== workspaceId || binding.recordedCwd !== input.cwd) {
        throw new WorkspaceBindingMismatchError(workspaceId, binding.recordedCwd, input.cwd);
      }
      return new FileWorkspacePort(workspaceDir, binding, options.onJournalRead);
    },
  };
}

class FileWorkspacePort implements FileRuntimeWorkspaceStoragePort {
  readonly workspaceId: WorkspaceId;
  readonly recordedCwd: string;
  readonly #ledgerFile: string;
  readonly #catalogFile: string;
  readonly #threadsDir: string;
  readonly #policyGrantsFile: string;
  readonly #lockFile: string;
  readonly #authorityPort: number;
  readonly #onJournalRead: JournalReadObserver | undefined;
  readonly #validatedJournals = new Map<ThreadId, ValidatedJournalLocator>();
  #lockServer: Bun.TCPSocketListener | undefined;
  #lockRecord: SupervisorLockRecord | undefined;
  #lease: SupervisorLease | undefined;
  #closed = false;

  constructor(
    readonly workspaceDir: string,
    binding: WorkspaceBindingFile,
    onJournalRead: JournalReadObserver | undefined,
  ) {
    this.workspaceId = binding.workspaceId;
    this.recordedCwd = binding.recordedCwd;
    this.#ledgerFile = safeChild(workspaceDir, 'ledger.json');
    this.#catalogFile = safeChild(workspaceDir, 'catalog.json');
    this.#threadsDir = safeChild(workspaceDir, 'threads');
    this.#policyGrantsFile = safeChild(workspaceDir, 'policy-grants.json');
    this.#lockFile = safeChild(workspaceDir, 'supervisor.lock');
    this.#authorityPort = workspaceAuthorityPort(this.workspaceId);
    this.#onJournalRead = onJournalRead;
  }

  async acquireSupervisorLease(processEpoch: string): Promise<SupervisorLease> {
    this.#assertOpen();
    assertWellFormedNonEmpty(processEpoch, 'processEpoch');
    if (this.#lease !== undefined || this.#lockServer !== undefined) {
      throw new WorkspaceInUseError(this.workspaceId);
    }
    let server: Bun.TCPSocketListener | undefined;
    let record: SupervisorLockRecord | undefined;
    try {
      server = await acquireKernelAuthority(this.#authorityPort, this.workspaceId);
      this.#lockServer = server;
      // Mutable storage is deliberately initialized only after kernel exclusion is held.
      this.#initializeMutableStorage();
      const ledger = this.#readLedger();
      const nextFence = ledger.fencingCounter + 1;
      if (!Number.isSafeInteger(nextFence)) {
        throw new RuntimeStorageError('fencing_exhausted', 'Workspace fencing counter exhausted');
      }
      const lease = snapshot<SupervisorLease>({
        workspaceId: this.workspaceId,
        processEpoch,
        fencingToken: String(nextFence),
      });
      this.#writeLedger({ ...ledger, fencingCounter: nextFence });
      record = snapshot<SupervisorLockRecord>({
        version: 1,
        ...lease,
        pid: process.pid,
        authority: { kind: 'loopback_tcp', port: this.#authorityPort },
      });
      writeJsonAtomic(this.#lockFile, record);
      this.#lockRecord = record;
      this.#lease = lease;
      await this.#reconcileCatalog();
      return lease;
    } catch (error) {
      if (record !== undefined) unlinkIfExact(this.#lockFile, record);
      this.#lockRecord = undefined;
      this.#lease = undefined;
      this.#lockServer = undefined;
      if (server !== undefined) closeKernelAuthority(server);
      throw error;
    }
  }

  async releaseSupervisorLease(lease: Readonly<SupervisorLease>): Promise<void> {
    this.#assertFence(lease);
    const activeThreadLocks = existsSync(this.#threadsDir)
      && readdirSync(this.#threadsDir).some((name) => name.endsWith('.lock'));
    if (activeThreadLocks) {
      throw new RuntimeStorageError('thread_lease_active', 'Thread writer locks remain active');
    }
    const server = this.#lockServer;
    const record = this.#lockRecord;
    // Delete our audit record while the OS authority is still held. A successor cannot race this unlink.
    if (record !== undefined) unlinkIfExact(this.#lockFile, record);
    this.#lockRecord = undefined;
    this.#lease = undefined;
    this.#lockServer = undefined;
    if (server !== undefined) closeKernelAuthority(server);
  }

  async validateWriteFence(fence: Readonly<WorkspaceWriteFence>): Promise<WorkspaceWriteFenceValidation> {
    if (fence.workspaceId !== this.workspaceId) return { current: false, code: 'wrong_workspace' };
    return this.#lease?.fencingToken === fence.fencingToken
      ? { current: true }
      : { current: false, code: 'stale_fence' };
  }

  async listThreads(): Promise<readonly ThreadCatalogRecord[]> {
    this.#assertLeaseHeld();
    return snapshot(this.#readCatalog().threads);
  }

  async loadSupervisorOps(): Promise<readonly SupervisorOpLedgerRecord[]> {
    this.#assertLeaseHeld();
    return snapshot(this.#readLedger().ops);
  }

  async reserveDerivedOpIdentity(
    lease: Readonly<SupervisorLease>,
    claim: DerivedOpIdentityClaim,
  ): Promise<DerivedOpIdentityReservation> {
    this.#assertFence(lease);
    validateDerivedClaim(claim, this.workspaceId);
    const ledger = this.#readLedger();
    const tuple = derivedTuple(claim);
    const byId = ledger.derived.find((entry) => entry.opId === claim.opId);
    const byTuple = ledger.derived.find((entry) => derivedTuple(entry) === tuple);
    const external = ledger.ops.find((entry) => entry.opId === claim.opId as unknown as ExternalOpId);
    if (external !== undefined || byId !== undefined || byTuple !== undefined) {
      if (external === undefined && byId !== undefined && byTuple !== undefined
        && derivedTuple(byId) === tuple && byTuple.opId === claim.opId) {
        return { kind: 'duplicate', claim: snapshot(byId) };
      }
      return { kind: 'conflict', claim: snapshot(byId ?? byTuple ?? claim) };
    }
    const stored = snapshot(claim);
    this.#writeLedger({ ...ledger, derived: [...ledger.derived, stored] });
    return { kind: 'claimed', claim: stored };
  }

  async reserveSupervisorOp(
    lease: Readonly<SupervisorLease>,
    record: SupervisorOpLedgerRecord,
  ): Promise<SupervisorOpReservation> {
    this.#assertFence(lease);
    validateSupervisorOpRecord(record, this.workspaceId);
    const ledger = this.#readLedger();
    if (ledger.derived.some((claim) => claim.opId === record.opId as unknown as string)) {
      return { kind: 'conflict', record: snapshot(record) };
    }
    const existing = ledger.ops.find((entry) => entry.opId === record.opId);
    if (existing !== undefined) {
      return existing.payloadHash === record.payloadHash
        ? { kind: 'duplicate', record: snapshot(existing) }
        : { kind: 'conflict', record: snapshot(existing) };
    }
    const stored = snapshot(record);
    this.#writeLedger({ ...ledger, ops: [...ledger.ops, stored] });
    return { kind: 'reserved', record: stored };
  }

  async finalizeSupervisorOp(
    lease: Readonly<SupervisorLease>,
    record: SupervisorOpLedgerRecord,
  ): Promise<void> {
    this.#assertFence(lease);
    validateSupervisorOpRecord(record, this.workspaceId);
    if (record.state !== 'final' || record.receipt === undefined) {
      throw new RuntimeStorageError('invalid_supervisor_final', 'Final supervisor op has no receipt');
    }
    const ledger = this.#readLedger();
    const index = ledger.ops.findIndex((entry) => entry.opId === record.opId);
    const existing = ledger.ops[index];
    if (existing === undefined || existing.payloadHash !== record.payloadHash) {
      throw new RuntimeStorageError('supervisor_op_conflict', `Unknown/conflicting op ${record.opId}`);
    }
    if (existing.state === 'final') {
      if (canonicalJson(existing) !== canonicalJson(record)) {
        throw new RuntimeStorageError('supervisor_op_conflict', `Final op ${record.opId} changed`);
      }
    }
    const ops = [...ledger.ops];
    ops[index] = snapshot(record);
    this.#writeLedger({ ...ledger, ops });
  }

  async createThreadJournal(
    lease: Readonly<SupervisorLease>,
    input: {
      readonly threadId: ThreadId;
      readonly meta: ThreadMetaRecord;
      readonly initialRecords?: readonly ThreadSeedRecord[];
    },
  ): Promise<ThreadJournalPort> {
    this.#assertFence(lease);
    const threadId = assertThreadId(input.threadId);
    validateThreadMeta(input.meta, this.workspaceId, threadId);
    if (input.meta.protocolVersion !== PROTOCOL_VERSION) {
      throw new RuntimeStorageError(
        'protocol_version_write_mismatch',
        `Thread ${threadId} protocolVersion ${input.meta.protocolVersion} does not match writer ${PROTOCOL_VERSION}`,
      );
    }
    const initialRecords = [input.meta, ...(input.initialRecords ?? [])];
    for (const record of input.initialRecords ?? []) {
      validateJournalRecord(record, this.workspaceId, threadId, false);
    }
    const file = this.#threadFile(threadId);
    let created = false;
    if (!existsSync(file)) {
      try {
        writeJsonLinesExclusive(file, initialRecords);
        created = true;
      } catch (error) {
        if (!isAlreadyExists(error)) throw storageFailure('thread_create_failed', file, error);
      }
    }
    const storedRecords = created
      ? snapshot(initialRecords)
      : readJournalInitialRecords(file, this.workspaceId, threadId, initialRecords.length);
    const storedMeta = storedRecords[0];
    if (storedMeta?.type !== 'thread_meta') {
      throw new RuntimeStorageError('invalid_thread_journal', `Thread ${threadId} has no metadata`);
    }
    validateThreadMeta(storedMeta, this.workspaceId, threadId);
    if (canonicalJson(storedRecords.slice(0, initialRecords.length)) !== canonicalJson(initialRecords)) {
      throw new RuntimeStorageError(
        'thread_meta_conflict',
        `Thread ${threadId} has different immutable initial records`,
      );
    }
    const catalogHasThread = this.#readCatalog().threads.some((entry) =>
      entry.summary.threadId === threadId);
    if (created || !catalogHasThread) {
      this.#upsertCatalogFromRecords(file, storedRecords);
    } else {
      this.#validatedJournals.set(threadId, {
        meta: storedMeta,
        boundary: journalBoundary(file),
      });
    }
    const locator = this.#validatedJournals.get(threadId);
    return new FileJournalPort(this, threadId, file, locator);
  }

  async openThreadJournal(threadIdInput: ThreadId): Promise<ThreadJournalPort | undefined> {
    this.#assertLeaseHeld();
    const threadId = assertThreadId(threadIdInput);
    const file = this.#threadFile(threadId);
    if (!existsSync(file)) return undefined;
    const boundary = journalBoundary(file);
    let locator = this.#validatedJournals.get(threadId);
    if (locator === undefined || !sameBoundary(locator.boundary, boundary)) {
      const meta = validateThreadMeta(readJournalHeader(file), this.workspaceId, threadId);
      locator = { meta, boundary };
      this.#validatedJournals.set(threadId, locator);
    }
    return new FileJournalPort(this, threadId, file, locator);
  }

  async openPolicyGrantRepository(
    lease: Readonly<SupervisorLease>,
  ): Promise<PolicyGrantRepository> {
    this.#assertFence(lease);
    if (!existsSync(this.#policyGrantsFile)) {
      try {
        writeJsonExclusive(this.#policyGrantsFile, {
          version: 1,
          workspaceId: this.workspaceId,
          grants: [],
        } satisfies PolicyGrantStoreFile);
      } catch (error) {
        if (!isAlreadyExists(error)) {
          throw storageFailure('policy_grant_store_create_failed', this.#policyGrantsFile, error);
        }
      }
    }
    // Opening is the recovery barrier for workspace mode: the single atomic file contains both
    // receipt identity and grant payload, so there is no separately reserved outbox to replay.
    readPolicyGrantStore(this.#policyGrantsFile, this.workspaceId);
    return new FilePolicyGrantRepository({
      workspace: this,
      lease: snapshot(lease),
      canonicalFile: this.#policyGrantsFile,
    });
  }

  async close(): Promise<void> {
    if (this.#lease !== undefined || this.#lockServer !== undefined) {
      throw new RuntimeStorageError('workspace_lease_active', 'Release Supervisor lease before closing storage');
    }
    this.#closed = true;
  }

  assertFence(lease: Readonly<SupervisorLease>): void {
    this.#assertFence(lease);
  }

  assertLeaseHeld(): void {
    this.#assertLeaseHeld();
  }

  observeJournalRead(
    threadId: ThreadId,
    kind: 'body' | 'tail' | 'snapshot',
    bytes: number,
  ): void {
    this.#onJournalRead?.({ threadId, kind, bytes });
  }

  updateCatalog(
    threadId: ThreadId,
    records: readonly RuntimeJournalRecord[],
    boundary: Readonly<JournalFileBoundary>,
    highWaterSeq: number,
  ): void {
    this.#assertLeaseHeld();
    const catalog = this.#readCatalog();
    const index = catalog.threads.findIndex((entry) => entry.summary.threadId === threadId);
    const entry = catalog.threads[index];
    if (entry === undefined) {
      throw new RuntimeStorageError('catalog_thread_missing', `Thread ${threadId} is absent from catalog`);
    }
    const summary = foldCatalogSummary(entry.summary, records);
    const threads = [...catalog.threads];
    threads[index] = snapshot({
      ...entry,
      summary,
      journal: {
        version: 3,
        dev: boundary.dev,
        ino: boundary.ino,
        mtimeMs: boundary.mtimeMs,
        ctimeMs: boundary.ctimeMs,
        size: boundary.size,
        snapshotSize: entry.journal?.snapshotSize ?? 0,
        highWaterSeq,
        replayStartSeq: entry.journal?.replayStartSeq ?? 1,
        recoveryRequired: true,
      },
      updatedAt: records.flatMap((record) => record.type === 'commit' ? record.envelopes : [])
        .at(-1)?.timestamp ?? entry.updatedAt,
    });
    this.#writeCatalog({ ...catalog, threads });
  }

  installRecoveryCatalog(
    threadId: ThreadId,
    state: Readonly<FoldedThreadJournal>,
    boundary: Readonly<JournalFileBoundary>,
  ): void {
    this.#assertLeaseHeld();
    const catalog = this.#readCatalog();
    const index = catalog.threads.findIndex((entry) => entry.summary.threadId === threadId);
    const entry = catalog.threads[index];
    if (entry === undefined) {
      throw new RuntimeStorageError('catalog_thread_missing', `Thread ${threadId} is absent from catalog`);
    }
    const replayStartSeq = state.envelopes[0]?.seq ?? state.highWaterSeq + 1;
    const preview = previewFromFold(state);
    const threads = [...catalog.threads];
    threads[index] = snapshot({
      ...entry,
      summary: state.summary,
      meta: state.meta,
      journal: {
        version: 3,
        dev: boundary.dev,
        ino: boundary.ino,
        mtimeMs: boundary.mtimeMs,
        ctimeMs: boundary.ctimeMs,
        size: boundary.size,
        snapshotSize: boundary.size,
        highWaterSeq: state.highWaterSeq,
        replayStartSeq,
        recoveryRequired: threadJournalRequiresRecovery(state),
      },
      ...(preview === undefined ? {} : { preview }),
      updatedAt: state.envelopes.at(-1)?.timestamp ?? entry.updatedAt ?? state.meta.createdAt,
    });
    this.#writeCatalog({ ...catalog, threads });
  }

  #initializeMutableStorage(): void {
    ensureDirectChildDirectory(this.workspaceDir, this.#threadsDir);
    if (!existsSync(this.#ledgerFile)) {
      try {
        writeJsonExclusive(this.#ledgerFile, {
          version: 1,
          fencingCounter: 0,
          ops: [],
          derived: [],
        } satisfies WorkspaceLedgerFile);
      } catch (error) {
        if (!isAlreadyExists(error)) throw storageFailure('ledger_create_failed', this.#ledgerFile, error);
      }
    }
    if (!existsSync(this.#catalogFile)) {
      try {
        writeJsonExclusive(this.#catalogFile, { version: 1, threads: [] } satisfies ThreadCatalogFile);
      } catch (error) {
        if (!isAlreadyExists(error)) throw storageFailure('catalog_create_failed', this.#catalogFile, error);
      }
    }
    this.#readLedger();
    try {
      this.#readCatalog();
    } catch (error) {
      if (!(error instanceof RuntimeStorageError) || error.code !== 'invalid_thread_catalog') throw error;
      this.#writeCatalog({
        version: 1,
        threads: listHeaderOnlyCatalog(this.#threadsDir, {
          version: 1,
          workspaceId: this.workspaceId,
          recordedCwd: this.recordedCwd,
        }),
      });
    }
  }

  async #reconcileCatalog(): Promise<void> {
    this.#assertLeaseHeld();
    this.#validatedJournals.clear();
    const catalog = this.#readCatalog();
    const existingById = new Map(catalog.threads.map((entry) => [entry.summary.threadId, entry]));
    const reconciled: ThreadCatalogRecord[] = [];
    for (const entry of readdirSync(this.#threadsDir, { withFileTypes: true })) {
      if (!entry.name.startsWith('th-') || !entry.name.endsWith('.jsonl')) continue;
      const file = safeChild(this.#threadsDir, entry.name);
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new RuntimeStorageError('unsafe_storage_key', `Thread journal is not a regular file: ${entry.name}`);
      }
      const header = readJournalHeader(file);
      validateThreadMeta(header, this.workspaceId, header.threadId);
      if (path.basename(this.#threadFile(header.threadId)) !== entry.name) {
        throw new RuntimeStorageError('thread_storage_key_mismatch', `Thread ${header.threadId} uses an invalid storage key`);
      }
      const previous = existingById.get(header.threadId);
      const boundary = journalBoundary(file);
      this.#validatedJournals.set(header.threadId, { meta: header, boundary });
      const indexed = previous?.journal;
      const exact = indexed !== undefined
        && indexed.dev === boundary.dev
        && indexed.ino === boundary.ino
        && indexed.size === boundary.size
        && indexed.mtimeMs === boundary.mtimeMs
        && indexed.ctimeMs === boundary.ctimeMs
        && previous?.meta !== undefined
        && canonicalJson(previous.meta) === canonicalJson(header);
      reconciled.push(snapshot({
        summary: previous?.summary ?? summaryFromMeta(header),
        format: 'runtime-v2',
        storageKey: entry.name,
        meta: header,
        journal: exact
          ? indexed
          : {
              version: 3,
              dev: boundary.dev,
              ino: boundary.ino,
              mtimeMs: boundary.mtimeMs,
              ctimeMs: boundary.ctimeMs,
              size: boundary.size,
              snapshotSize: indexed?.dev === boundary.dev && indexed.ino === boundary.ino
                ? indexed.snapshotSize : 0,
              highWaterSeq: indexed?.highWaterSeq ?? 0,
              replayStartSeq: indexed?.replayStartSeq ?? 1,
              recoveryRequired: true,
            },
        ...(previous?.preview !== undefined && { preview: previous.preview }),
        ...(previous?.updatedAt !== undefined && { updatedAt: previous.updatedAt }),
      }));
      existingById.delete(header.threadId);
    }
    const missingRuntime = [...existingById.values()][0];
    if (missingRuntime !== undefined) {
      throw new RuntimeStorageError(
        'catalog_orphan',
        `Catalog references missing thread journal ${missingRuntime.summary.threadId}`,
      );
    }
    const next = snapshot<ThreadCatalogFile>({ version: 1, threads: reconciled });
    if (canonicalJson(next) !== canonicalJson(catalog)) this.#writeCatalog(next);
  }

  #upsertCatalogFromRecords(file: string, records: readonly RuntimeJournalRecord[]): void {
    const meta = records[0];
    if (meta?.type !== 'thread_meta') {
      throw new RuntimeStorageError('invalid_thread_journal', 'Thread journal has no meta header');
    }
    const catalog = this.#readCatalog();
    const index = catalog.threads.findIndex((entry) => entry.summary.threadId === meta.threadId);
    const state = foldThreadJournal(records);
    const boundary = journalBoundary(file);
    const entry = snapshot<ThreadCatalogRecord>({
      summary: state.summary,
      format: 'runtime-v2',
      storageKey: path.basename(file),
      meta,
      journal: {
        version: 3,
        dev: boundary.dev,
        ino: boundary.ino,
        mtimeMs: boundary.mtimeMs,
        ctimeMs: boundary.ctimeMs,
        size: boundary.size,
        snapshotSize: 0,
        highWaterSeq: state.highWaterSeq,
        replayStartSeq: state.envelopes[0]?.seq ?? state.highWaterSeq + 1,
        recoveryRequired: true,
      },
      ...(previewFromFold(state) === undefined ? {} : { preview: previewFromFold(state) }),
      updatedAt: state.envelopes.at(-1)?.timestamp ?? meta.createdAt,
    });
    this.#validatedJournals.set(meta.threadId, { meta, boundary });
    const threads = [...catalog.threads];
    if (index < 0) threads.push(entry);
    else threads[index] = entry;
    this.#writeCatalog({ ...catalog, threads });
  }

  #threadFile(threadId: ThreadId): string {
    return safeChild(this.#threadsDir, `th-${sha256Hex(threadId)}.jsonl`);
  }

  #readLedger(): WorkspaceLedgerFile {
    return readLedger(this.#ledgerFile, this.workspaceId);
  }

  #writeLedger(value: WorkspaceLedgerFile): void {
    validateLedger(value, this.workspaceId);
    writeJsonAtomic(this.#ledgerFile, value);
  }

  #readCatalog(): ThreadCatalogFile {
    return readCatalog(this.#catalogFile);
  }

  #writeCatalog(value: ThreadCatalogFile): void {
    validateCatalog(value);
    writeJsonAtomic(this.#catalogFile, value);
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new RuntimeStorageError('workspace_port_closed', 'Workspace storage port is closed');
    }
  }

  #assertLeaseHeld(): void {
    this.#assertOpen();
    if (this.#lease === undefined || this.#lockServer === undefined) {
      throw new RuntimeStorageError('supervisor_lease_required', 'Supervisor lease is required');
    }
  }

  #assertFence(lease: Readonly<SupervisorLease>): void {
    this.#assertLeaseHeld();
    if (lease.workspaceId !== this.workspaceId
      || lease.fencingToken !== this.#lease?.fencingToken
      || lease.processEpoch !== this.#lease.processEpoch) {
      throw new RuntimeStorageError('stale_fence', 'Workspace write fence is not current');
    }
  }
}

class FilePolicyGrantRepository implements PolicyGrantRepository {
  readonly workspaceId: WorkspaceId;
  readonly #workspace: FileWorkspacePort;
  readonly #lease: SupervisorLease;
  readonly #canonicalFile: string;
  #closed = false;

  constructor(input: {
    readonly workspace: FileWorkspacePort;
    readonly lease: SupervisorLease;
    readonly canonicalFile: string;
  }) {
    this.#workspace = input.workspace;
    this.#lease = input.lease;
    this.#canonicalFile = input.canonicalFile;
    this.workspaceId = input.lease.workspaceId;
  }

  async snapshot(): Promise<Readonly<PolicyGrantSnapshot>> {
    this.#assertOpen();
    this.#workspace.assertFence(this.#lease);
    const store = readPolicyGrantStore(this.#canonicalFile, this.workspaceId);
    return workspacePolicyGrantSnapshot(this.workspaceId, store.grants);
  }

  async commitAllowAlways(
    grant: Readonly<PolicyGrant>,
  ): Promise<PolicyGrantCommitResult> {
    if (this.#closed) {
      return policyGrantFenced('stale_fence', 'Policy grant repository is closed');
    }
    if (grant.workspaceId !== this.workspaceId) {
      return policyGrantFenced('wrong_workspace', 'Policy grant belongs to a different workspace');
    }
    try {
      this.#workspace.assertFence(this.#lease);
    } catch {
      return policyGrantFenced('stale_fence', 'Policy grant repository lost its workspace fence');
    }
    return this.#commit(grant);
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  #commit(grant: Readonly<PolicyGrant>): PolicyGrantCommitResult {
    const file = this.#canonicalFile;
    const normalized = validatePolicyGrant(grant, this.workspaceId);
    const store = readPolicyGrantStore(file, this.workspaceId);
    const currentRevision = workspacePolicyGrantSnapshot(this.workspaceId, store.grants).revision;
    const prior = store.grants.find((candidate) => candidate.grantId === normalized.grantId);
    if (prior !== undefined) {
      return canonicalJson(prior) === canonicalJson(normalized)
        ? { kind: 'duplicate', revision: currentRevision }
        : {
            kind: 'conflict',
            revision: currentRevision,
            message: `Policy grant ${normalized.grantId} changed its durable payload`,
          };
    }
    const next = snapshot<PolicyGrantStoreFile>({
      ...store,
      grants: [...store.grants, normalized],
    });
    try {
      // The final fence comparison happens synchronously immediately before rename. Under the
      // kernel-held workspace authority that rename is the receipt/grant transaction's CAS point.
      writePolicyGrantStoreAtomic(
        file,
        next,
        () => { this.#workspace.assertFence(this.#lease); },
      );
    } catch (error) {
      if (error instanceof RuntimeStorageError && error.code === 'stale_fence') {
        return policyGrantFenced('stale_fence', error.message);
      }
      if (error instanceof PolicyGrantDefinitelyNotAppliedError) {
        return { kind: 'definitely_not_applied', message: formatStorageCause(error.originalCause) };
      }
      throw storageFailure('policy_grant_commit_outcome_unknown', file, error);
    }
    return {
      kind: 'applied',
      revision: workspacePolicyGrantSnapshot(this.workspaceId, next.grants).revision,
    };
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new RuntimeStorageError('stale_fence', 'Policy grant repository is closed');
    }
  }

}

class FileJournalPort implements ThreadJournalPort {
  readonly #lockFile: string;
  readonly #snapshotFile: string;
  #lockFd: number | undefined;
  #lockRecord: ThreadLockRecord | undefined;
  #lease: SupervisorLease | undefined;
  #journalFd: number | undefined;
  #journalBoundary: JournalFileBoundary | undefined;
  #sequenceState: JournalSequenceState | undefined;
  #codecState: JournalMessageCodecState | undefined;

  constructor(
    private readonly workspace: FileWorkspacePort,
    private readonly threadId: ThreadId,
    private readonly file: string,
    private readonly validatedLocator?: Readonly<ValidatedJournalLocator>,
  ) {
    this.#lockFile = `${file}.lock`;
    this.#snapshotFile = `${file}.recovery.json`;
  }

  async acquireWriteLease(lease: Readonly<SupervisorLease>): Promise<void> {
    this.workspace.assertFence(lease);
    if (this.#lease !== undefined) {
      if (canonicalJson(this.#lease) !== canonicalJson(lease)) {
        throw new RuntimeStorageError('stale_fence', `Thread ${this.threadId} captured another lease`);
      }
      return;
    }
    this.recoverStaleLockForCurrentFence(lease);
    const record = snapshot<ThreadLockRecord>({
      version: 1,
      workspaceId: lease.workspaceId,
      threadId: this.threadId,
      processEpoch: lease.processEpoch,
      fencingToken: lease.fencingToken,
      ownerNonce: crypto.randomUUID(),
    });
    let fd: number | undefined;
    try {
      fd = openRegularExclusive(this.#lockFile);
      writeFileSync(fd, `${canonicalJson(record)}\n`, 'utf8');
      fsyncSync(fd);
      fsyncDirectory(path.dirname(this.#lockFile));
      this.#lockFd = fd;
      this.#lockRecord = record;
      this.#lease = snapshot(lease);
    } catch (error) {
      if (fd !== undefined) {
        // The still-open inode cannot have been replaced; unlink before close prevents stale residue.
        try { unlinkSync(this.#lockFile); } catch { /* acquisition may have failed before create */ }
        closeSync(fd);
      }
      this.#lockFd = undefined;
      this.#lockRecord = undefined;
      this.#lease = undefined;
      if (isAlreadyExists(error)) {
        throw new RuntimeStorageError('thread_in_use', `Thread ${this.threadId} has a writer`);
      }
      throw storageFailure('thread_lease_failed', this.#lockFile, error);
    }
  }

  async loadState(): Promise<FoldedThreadJournal> {
    this.workspace.assertLeaseHeld();
    // The header/protocol/schema gate always precedes snapshot or body parsing.
    const currentBoundary = journalBoundary(this.file);
    const header = this.validatedLocator !== undefined
      && sameBoundary(this.validatedLocator.boundary, currentBoundary)
      ? this.validatedLocator.meta
      : validateThreadMeta(
          readJournalHeader(this.file),
          this.workspace.workspaceId,
          this.threadId,
        );
    const boundary = currentBoundary;
    const materialized = readRecoverySnapshot(
      this.#snapshotFile,
      header,
      this.workspace.workspaceId,
      this.threadId,
      (observation) => this.workspace.observeJournalRead(
        observation.threadId,
        observation.kind,
        observation.bytes,
      ),
    );
    if (materialized !== undefined && sameBoundary(materialized.boundary, boundary)) {
      if (this.#lease !== undefined) {
        this.#installValidatedBoundary({
          boundary,
          sequenceState: materialized.sequenceState,
          codecState: materialized.codecState,
        });
      }
      return materialized.state;
    }
    if (materialized !== undefined
      && materialized.boundary.dev === boundary.dev
      && materialized.boundary.ino === boundary.ino
      && materialized.boundary.size < boundary.size) {
      const tail = readValidatedJournalTail(
        this.file,
        this.workspace.workspaceId,
        this.threadId,
        this.#lease === undefined ? 'strict' : 'repair',
        materialized,
        boundary,
        (observation) => this.workspace.observeJournalRead(
          observation.threadId,
          observation.kind,
          observation.bytes,
        ),
      );
      const state = tail.state;
      if (state === undefined) {
        throw new RuntimeStorageError('invalid_thread_journal', 'Tail recovery did not materialize state');
      }
      if (this.#lease !== undefined) {
        this.#installValidatedBoundary(tail);
        await this.saveRecoveryState(state);
      }
      return state;
    }

    const loaded = readValidatedJournal(
      this.file,
      this.workspace.workspaceId,
      this.threadId,
      this.#lease === undefined ? 'strict' : 'repair',
      {
        foldState: true,
        observer: (observation) => this.workspace.observeJournalRead(
          observation.threadId,
          observation.kind,
          observation.bytes,
        ),
      },
    );
    const state = loaded.state;
    if (state === undefined) {
      throw new RuntimeStorageError('invalid_thread_journal', 'Full recovery did not materialize state');
    }
    if (this.#lease !== undefined) {
      this.#installValidatedBoundary(loaded);
      await this.saveRecoveryState(state);
    }
    return state;
  }

  async saveRecoveryState(state: Readonly<FoldedThreadJournal>): Promise<void> {
    if (this.#lease === undefined || this.#journalBoundary === undefined
      || this.#sequenceState === undefined || this.#codecState === undefined
      || this.#journalFd === undefined) {
      throw new RuntimeStorageError('thread_not_writable', `Thread ${this.threadId} has no recovery boundary`);
    }
    this.workspace.assertFence(this.#lease);
    assertJournalFileBoundary(this.file, this.#journalFd, this.#journalBoundary);
    if (state.meta.threadId !== this.threadId || state.meta.workspaceId !== this.workspace.workspaceId
      || state.highWaterSeq !== this.#sequenceState.nextSeq - 1) {
      throw new RuntimeStorageError('invalid_recovery_snapshot', 'Recovery state does not match journal sequence');
    }
    const serializedState = serializeThreadRecoveryState(state);
    writeRecoverySnapshot(this.#snapshotFile, {
      version: 1,
      workspaceId: this.workspace.workspaceId,
      threadId: this.threadId,
      boundary: this.#journalBoundary,
      state: serializedState,
      sequence: serializeJournalSequenceState(this.#sequenceState),
      codec: cloneJournalMessageCodecState(this.#codecState),
    });
    this.workspace.installRecoveryCatalog(
      this.threadId,
      state,
      this.#journalBoundary,
    );
  }

  async replayEvents(afterSeq: number, throughSeq: number): Promise<readonly import('../protocol/index.js').EventEnvelope[]> {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0
      || !Number.isSafeInteger(throughSeq) || throughSeq < afterSeq) {
      throw new RuntimeStorageError('invalid_event_cursor', 'Invalid event replay range');
    }
    const boundary = journalBoundary(this.file);
    const header = this.validatedLocator !== undefined
      && sameBoundary(this.validatedLocator.boundary, boundary)
      ? this.validatedLocator.meta
      : validateThreadMeta(
          readJournalHeader(this.file),
          this.workspace.workspaceId,
          this.threadId,
        );
    const materialized = readRecoverySnapshot(
      this.#snapshotFile,
      header,
      this.workspace.workspaceId,
      this.threadId,
      (observation) => this.workspace.observeJournalRead(
        observation.threadId,
        observation.kind,
        observation.bytes,
      ),
    );
    let state: FoldedThreadJournal;
    if (materialized !== undefined && sameBoundary(materialized.boundary, boundary)
      && recoveryStateCoversCursor(materialized.state, afterSeq)) {
      state = materialized.state;
    } else if (materialized !== undefined
      && materialized.boundary.dev === boundary.dev
      && materialized.boundary.ino === boundary.ino
      && materialized.boundary.size < boundary.size
      && recoveryStateCoversCursor(materialized.state, afterSeq)) {
      const tail = readValidatedJournalTail(
        this.file,
        this.workspace.workspaceId,
        this.threadId,
        'read_only',
        materialized,
        boundary,
        (observation) => this.workspace.observeJournalRead(
          observation.threadId,
          observation.kind,
          observation.bytes,
        ),
      );
      if (tail.state === undefined) {
        throw new RuntimeStorageError('invalid_thread_journal', 'Tail replay did not materialize state');
      }
      state = tail.state;
    } else {
      const loaded = readValidatedJournal(
        this.file,
        this.workspace.workspaceId,
        this.threadId,
        'read_only',
        {
          foldState: true,
          observer: (observation) => this.workspace.observeJournalRead(
            observation.threadId,
            observation.kind,
            observation.bytes,
          ),
        },
      );
      if (loaded.state === undefined) {
        throw new RuntimeStorageError('invalid_thread_journal', 'Replay recovery did not materialize state');
      }
      state = loaded.state;
    }
    return state.envelopes.filter((envelope) =>
      envelope.seq > afterSeq && envelope.seq <= throughSeq);
  }

  async append(
    records: readonly RuntimeJournalRecord[],
    options: { readonly flush: true },
  ): Promise<void> {
    if (this.#lease === undefined || options.flush !== true) {
      throw new RuntimeStorageError('thread_not_writable', `Thread ${this.threadId} has no writer lease`);
    }
    this.workspace.assertFence(this.#lease);
    if (records.length === 0) return;
    if (this.#sequenceState === undefined || this.#codecState === undefined
      || this.#journalBoundary === undefined
      || this.#journalFd === undefined) {
      const loaded = readValidatedJournal(
        this.file,
        this.workspace.workspaceId,
        this.threadId,
        'repair',
        {
          observer: (observation) => this.workspace.observeJournalRead(
            observation.threadId,
            observation.kind,
            observation.bytes,
          ),
        },
      );
      this.#installValidatedBoundary(loaded);
    }
    const sequenceState = this.#sequenceState;
    const codecState = this.#codecState;
    const boundary = this.#journalBoundary;
    const journalFd = this.#journalFd;
    if (sequenceState === undefined || codecState === undefined
      || boundary === undefined || journalFd === undefined) {
      throw new RuntimeStorageError('invalid_thread_journal', `Thread ${this.threadId} has no append boundary`);
    }
    assertJournalFileBoundary(this.file, journalFd, boundary);
    const validated = records.map((record) =>
      validateJournalRecord(record, this.workspace.workspaceId, this.threadId, false));
    const nextSequenceState = validateJournalSequenceAppend(
      validated,
      this.workspace.workspaceId,
      this.threadId,
      sequenceState,
    );
    const nextCodecState = cloneJournalMessageCodecState(codecState);
    const durable = validated.map((record) => encodeDurableJournalRecord(record, nextCodecState));
    const data = `${durable.map((record) => canonicalJson(record)).join('\n')}\n`;
    writeFileSync(journalFd, data, { encoding: 'utf8' });
    fsyncSync(journalFd);
    const expectedSize = boundary.size + Buffer.byteLength(data);
    const nextBoundary = journalBoundaryFromOpenFile(this.file, journalFd);
    if (nextBoundary.dev !== boundary.dev || nextBoundary.ino !== boundary.ino
      || nextBoundary.size !== expectedSize) {
      throw new RuntimeStorageError('invalid_thread_journal', 'Journal append boundary changed');
    }
    assertJournalFileBoundary(this.file, journalFd, nextBoundary);
    this.#sequenceState = nextSequenceState;
    this.#codecState = nextCodecState;
    this.#journalBoundary = nextBoundary;
    this.workspace.updateCatalog(
      this.threadId,
      validated,
      nextBoundary,
      nextSequenceState.nextSeq - 1,
    );
  }

  async releaseWriteLease(): Promise<void> {
    const record = this.#lockRecord;
    if (record !== undefined) unlinkIfExact(this.#lockFile, record);
    if (this.#journalFd !== undefined) closeSync(this.#journalFd);
    if (this.#lockFd !== undefined) closeSync(this.#lockFd);
    this.#journalFd = undefined;
    this.#journalBoundary = undefined;
    this.#sequenceState = undefined;
    this.#codecState = undefined;
    this.#lockFd = undefined;
    this.#lockRecord = undefined;
    this.#lease = undefined;
  }

  recoverStaleLockForCurrentFence(lease: Readonly<SupervisorLease>): void {
    this.workspace.assertFence(lease);
    if (!existsSync(this.#lockFile)) return;
    const current = readThreadLock(this.#lockFile);
    if (current.workspaceId !== lease.workspaceId || current.threadId !== this.threadId) {
      throw new RuntimeStorageError('thread_lock_mismatch', `Thread ${this.threadId} lock ownership is invalid`);
    }
    if (current.fencingToken === lease.fencingToken && current.processEpoch === lease.processEpoch) {
      throw new RuntimeStorageError('thread_in_use', `Thread ${this.threadId} has a writer`);
    }
    // Only the kernel-authorized successor Supervisor reaches here. No prior-fence process can
    // legitimately append, and exact comparison prevents deleting a concurrently replaced record.
    unlinkIfExact(this.#lockFile, current);
    if (existsSync(this.#lockFile)) {
      throw new RuntimeStorageError('thread_in_use', `Thread ${this.threadId} lock changed during recovery`);
    }
    fsyncDirectory(path.dirname(this.#lockFile));
  }

  #installValidatedBoundary(loaded: Readonly<ValidatedJournal>): void {
    let fd: number | undefined;
    try {
      fd = openSync(
        this.file,
        constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW,
      );
      assertJournalFileBoundary(this.file, fd, loaded.boundary);
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      if (error instanceof RuntimeStorageError) throw error;
      throw storageFailure('invalid_thread_journal', this.file, error);
    }
    if (this.#journalFd !== undefined) closeSync(this.#journalFd);
    this.#journalFd = fd;
    this.#journalBoundary = loaded.boundary;
    this.#sequenceState = loaded.sequenceState;
    this.#codecState = loaded.codecState;
  }
}

function readAllCanonicalLocators(root: string): StoredThreadLocator[] {
  if (!existsSync(root)) return [];
  assertDirectoryNoSymlink(root);
  const result: StoredThreadLocator[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.name.startsWith('ws-')) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new RuntimeStorageError('unsafe_storage_key', `Workspace entry is not a directory: ${entry.name}`);
    }
    const workspaceDir = safeChild(root, entry.name);
    const binding = readBinding(safeChild(workspaceDir, 'binding.json'));
    const catalogFile = safeChild(workspaceDir, 'catalog.json');
    const threadsDir = safeChild(workspaceDir, 'threads');
    const catalogExists = existsSync(catalogFile);
    let catalog: ThreadCatalogFile;
    if (!catalogExists) {
      catalog = { version: 1, threads: listHeaderOnlyCatalog(threadsDir, binding) };
    } else {
      try {
        catalog = readCatalog(catalogFile);
      } catch (error) {
        if (!(error instanceof RuntimeStorageError) || error.code !== 'invalid_thread_catalog') throw error;
        catalog = { version: 1, threads: listHeaderOnlyCatalog(threadsDir, binding) };
      }
    }
    for (const indexed of catalog.threads) {
      const threadId = indexed.summary.threadId;
      const expectedStorageKey = `th-${sha256Hex(threadId)}.jsonl`;
      if (indexed.storageKey !== expectedStorageKey
        || (indexed.meta !== undefined && indexed.meta.workspaceId !== binding.workspaceId)) {
        throw new RuntimeStorageError(
          'invalid_thread_catalog',
          `Catalog thread ${threadId} is outside its workspace/storage fence`,
        );
      }
      const file = safeChild(threadsDir, indexed.storageKey);
      if (!existsSync(file)) {
        throw new RuntimeStorageError('catalog_orphan', `Catalog references missing thread journal ${threadId}`);
      }
      const boundary = journalBoundary(file);
      const exact = indexed.meta !== undefined && indexed.journal !== undefined
        && indexed.journal.dev === boundary.dev && indexed.journal.ino === boundary.ino
        && indexed.journal.size === boundary.size
        && indexed.journal.mtimeMs === boundary.mtimeMs
        && indexed.journal.ctimeMs === boundary.ctimeMs;
      const meta = exact
        ? indexed.meta as ThreadMetaRecord
        : validateThreadMeta(readJournalHeader(file), binding.workspaceId, threadId);
      const thread: ThreadCatalogRecord = exact
        ? indexed
        : snapshot({
            ...indexed,
            meta,
            journal: {
              version: 3,
              ...boundary,
              snapshotSize: 0,
              highWaterSeq: indexed.journal?.highWaterSeq ?? 0,
              replayStartSeq: indexed.journal?.replayStartSeq ?? 1,
              recoveryRequired: true,
            },
          });
      result.push(snapshot({
        ownerWorkspaceId: binding.workspaceId,
        ownerRecordedCwd: binding.recordedCwd,
        threadId: thread.summary.threadId,
        catalog: thread,
      }));
    }
  }
  return result;
}

function listHeaderOnlyCatalog(
  threadsDir: string,
  binding: Readonly<WorkspaceBindingFile>,
): ThreadCatalogRecord[] {
  if (!existsSync(threadsDir)) return [];
  assertDirectoryNoSymlink(threadsDir);
  const result: ThreadCatalogRecord[] = [];
  for (const entry of readdirSync(threadsDir, { withFileTypes: true })) {
    if (!entry.name.startsWith('th-') || !entry.name.endsWith('.jsonl')) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new RuntimeStorageError('unsafe_storage_key', `Thread journal is not a regular file: ${entry.name}`);
    }
    const file = safeChild(threadsDir, entry.name);
    const raw = readJournalHeader(file);
    const meta = validateThreadMeta(raw, binding.workspaceId, raw.threadId);
    if (entry.name !== `th-${sha256Hex(meta.threadId)}.jsonl`) {
      throw new RuntimeStorageError('thread_storage_key_mismatch', `Thread ${meta.threadId} uses an invalid storage key`);
    }
    result.push(snapshot({
      summary: summaryFromMeta(meta),
      format: 'runtime-v2',
      storageKey: entry.name,
      meta,
      journal: {
        version: 3,
        ...journalBoundary(file),
        snapshotSize: 0,
        highWaterSeq: 0,
        replayStartSeq: 1,
        recoveryRequired: true,
      },
      updatedAt: meta.createdAt,
    }));
  }
  return result;
}

interface JournalFileBoundary {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

interface ValidatedJournalLocator {
  readonly meta: ThreadMetaRecord;
  readonly boundary: JournalFileBoundary;
}

interface SerializedJournalSequenceState {
  readonly recordCount: number;
  readonly mailboxPrepares: readonly (readonly [string,
    Extract<RuntimeJournalRecord, { type: 'mailbox_prepare' }>])[];
  readonly mailboxStates: readonly (readonly [string,
    'prepared' | 'accepted_pending' | 'started' | 'completed' | 'rejected'])[];
  readonly usedRunIds: readonly (readonly [string, string])[];
  readonly runStates: readonly (readonly [string, 'reserved' | 'started' | 'terminal'])[];
  readonly successorByPredecessor: readonly (readonly [string,
    Extract<RuntimeJournalRecord, { type: 'successor_run_prepare' }>])[];
  readonly successorByRun: readonly (readonly [string,
    Extract<RuntimeJournalRecord, { type: 'successor_run_prepare' }>])[];
  readonly turnByKey: readonly (readonly [string,
    Extract<RuntimeJournalRecord, { type: 'turn_prepare' }>])[];
  readonly usedTurnIds: readonly (readonly [string, string])[];
  readonly activatedTurns: readonly string[];
  readonly pendingResults: readonly (readonly [string,
    Extract<RuntimeThreadMutation, { type: 'thread_result_pending' }>])[];
  readonly deliveredResults: readonly string[];
  readonly usedRequestIds: readonly string[];
  readonly controlClaims: readonly (readonly [string, ExternalOpId])[];
  readonly observedRuleScopes: readonly string[];
  readonly seedSeen: boolean;
  readonly nextSeq: number;
}

interface ThreadRecoverySnapshotPayload {
  readonly version: 1;
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly boundary: JournalFileBoundary;
  readonly state: SerializedThreadRecoveryState;
  readonly sequence: SerializedJournalSequenceState;
  readonly codec: JournalMessageCodecState;
}

interface ThreadRecoverySnapshotFile extends ThreadRecoverySnapshotPayload {
  readonly digest: string;
}

interface ValidatedRecoverySnapshot {
  readonly boundary: JournalFileBoundary;
  readonly state: FoldedThreadJournal;
  readonly sequenceState: JournalSequenceState;
  readonly codecState: JournalMessageCodecState;
}

interface ValidatedJournal {
  readonly sequenceState: JournalSequenceState;
  readonly codecState: JournalMessageCodecState;
  readonly boundary: JournalFileBoundary;
  readonly state?: FoldedThreadJournal;
}

interface ReadValidatedJournalOptions {
  readonly foldState?: boolean;
  readonly observer?: JournalReadObserver;
}

interface JournalHeaderLine {
  readonly text: string;
  readonly nextOffset: number;
}

function readValidatedJournal(
  file: string,
  workspaceId: WorkspaceId,
  threadId: ThreadId,
  mode: 'strict' | 'repair' | 'read_only',
  options: ReadValidatedJournalOptions = {},
): ValidatedJournal {
  assertRegularFileNoSymlink(file);
  const fd = openSync(
    file,
    (mode === 'repair' ? constants.O_RDWR | constants.O_APPEND : constants.O_RDONLY)
      | constants.O_NOFOLLOW,
  );
  let initialBoundary: JournalFileBoundary;
  let bytes: Buffer;
  let header: ThreadMetaRecord;
  let bodyOffset: number;
  try {
    const initialStat = fstatSync(fd);
    initialBoundary = boundaryFromStat(initialStat);
    assertJournalFileBoundary(file, fd, initialBoundary);
    const headerLine = readJournalHeaderLine(fd, initialBoundary.size, file);
    header = validateThreadMeta(
      parseJournalHeaderValue(headerLine.text, file),
      workspaceId,
      threadId,
    );
    bodyOffset = headerLine.nextOffset;
    // Explicit-position header reads leave the descriptor at zero. The body is read only after
    // protocol compatibility succeeds, preserving the gate before any executable state is parsed.
    bytes = readFileSync(fd);
    if (bytes.length !== initialBoundary.size) {
      throw new RuntimeStorageError(
        'invalid_thread_journal',
        `Thread journal changed during load: ${file}`,
      );
    }
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  options.observer?.({
    threadId,
    kind: 'body',
    bytes: Math.max(0, bytes.length - bodyOffset),
  });
  let sequenceState = validateJournalSequence([header], workspaceId, threadId);
  let foldedState = options.foldState === true ? foldThreadJournal([header]) : undefined;
  let codecState = emptyJournalMessageCodecState();
  let cursor = bodyOffset;
  let line = 1;
  let lastGoodOffset = bodyOffset;
  let needsFinalNewline = false;
  let expectedSize = bytes.length;
  try {
    while (cursor < bytes.length) {
      const newline = bytes.indexOf(0x0a, cursor);
      const end = newline < 0 ? bytes.length : newline;
      const next = newline < 0 ? bytes.length : newline + 1;
      const text = bytes.subarray(cursor, end).toString('utf8');
      line++;
      if (text.length === 0) {
        if (next === bytes.length) break;
        throw new RuntimeStorageError('corrupt_thread_journal', `Empty journal record at line ${line}`);
      }
      try {
        const parsed = JSON.parse(text) as unknown;
        const candidateCodecState = cloneJournalMessageCodecState(codecState);
        const record = validateJournalRecord(
          parsed,
          workspaceId,
          threadId,
          false,
          candidateCodecState,
        );
        const candidateSequenceState = validateJournalSequenceAppend(
          [record],
          workspaceId,
          threadId,
          sequenceState,
        );
        const candidateFoldedState = foldedState === undefined
          ? undefined
          : foldThreadJournalAppend(foldedState, [record]);
        sequenceState = candidateSequenceState;
        foldedState = candidateFoldedState;
        codecState = candidateCodecState;
        lastGoodOffset = next;
        if (newline < 0 && mode === 'repair') needsFinalNewline = true;
      } catch (error) {
        if (next < bytes.length) {
          throw storageFailure('corrupt_thread_journal', `${file}:${line}`, error);
        }
        if (mode === 'strict') {
          throw new RuntimeStorageError('corrupt_tail_requires_write_lease', `Thread ${threadId} has a corrupt tail`);
        }
        if (mode === 'read_only') break;
        ftruncateSync(fd, lastGoodOffset);
        fsyncSync(fd);
        expectedSize = lastGoodOffset;
        break;
      }
      cursor = next;
    }
    if (needsFinalNewline) {
      writeFileSync(fd, '\n', 'utf8');
      fsyncSync(fd);
      expectedSize++;
    }
    const boundary = expectedSize === initialBoundary.size
      ? initialBoundary
      : journalBoundaryFromOpenFile(file, fd);
    if (boundary.size !== expectedSize) {
      throw new RuntimeStorageError('invalid_thread_journal', 'Repaired journal size differs from boundary');
    }
    assertJournalFileBoundary(file, fd, boundary);
    return {
      sequenceState,
      codecState: cloneJournalMessageCodecState(codecState),
      boundary,
      ...(foldedState !== undefined && { state: foldedState }),
    };
  } finally {
    closeSync(fd);
  }
}

function readValidatedJournalTail(
  file: string,
  workspaceId: WorkspaceId,
  threadId: ThreadId,
  mode: 'strict' | 'repair' | 'read_only',
  materialized: Readonly<ValidatedRecoverySnapshot>,
  initialBoundary: Readonly<JournalFileBoundary>,
  observer?: JournalReadObserver,
): ValidatedJournal {
  const fd = openSync(
    file,
    (mode === 'repair' ? constants.O_RDWR | constants.O_APPEND : constants.O_RDONLY)
      | constants.O_NOFOLLOW,
  );
  let codecState = cloneJournalMessageCodecState(materialized.codecState);
  let sequenceState = cloneJournalSequenceState(materialized.sequenceState);
  let foldedState = materialized.state;
  let expectedSize = initialBoundary.size;
  try {
    assertJournalFileBoundary(file, fd, initialBoundary);
    const length = initialBoundary.size - materialized.boundary.size;
    observer?.({ threadId, kind: 'tail', bytes: length });
    const bytes = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const count = readSync(
        fd,
        bytes,
        read,
        length - read,
        materialized.boundary.size + read,
      );
      if (count === 0) break;
      read += count;
    }
    if (read !== length) throw new RuntimeStorageError('invalid_thread_journal', 'Journal tail changed during read');
    let cursor = 0;
    let lastGoodOffset = materialized.boundary.size;
    let needsFinalNewline = false;
    while (cursor < bytes.length) {
      const newline = bytes.indexOf(0x0a, cursor);
      const end = newline < 0 ? bytes.length : newline;
      const next = newline < 0 ? bytes.length : newline + 1;
      const text = bytes.subarray(cursor, end).toString('utf8');
      if (text.length === 0) {
        if (next === bytes.length) break;
        throw new RuntimeStorageError('corrupt_thread_journal', 'Empty journal tail record');
      }
      try {
        const candidateCodecState = cloneJournalMessageCodecState(codecState);
        const record = validateJournalRecord(
          JSON.parse(text) as unknown,
          workspaceId,
          threadId,
          false,
          candidateCodecState,
        );
        const candidateSequenceState = validateJournalSequenceAppend(
          [record],
          workspaceId,
          threadId,
          sequenceState,
        );
        const candidateFoldedState = foldThreadJournalAppend(foldedState, [record]);
        sequenceState = candidateSequenceState;
        foldedState = candidateFoldedState;
        codecState = candidateCodecState;
        lastGoodOffset = materialized.boundary.size + next;
        if (newline < 0 && mode === 'repair') needsFinalNewline = true;
      } catch (error) {
        if (next < bytes.length) throw storageFailure('corrupt_thread_journal', file, error);
        if (mode === 'strict') {
          throw new RuntimeStorageError('corrupt_tail_requires_write_lease', `Thread ${threadId} has a corrupt tail`);
        }
        if (mode === 'read_only') break;
        ftruncateSync(fd, lastGoodOffset);
        fsyncSync(fd);
        expectedSize = lastGoodOffset;
        needsFinalNewline = false;
        break;
      }
      cursor = next;
    }
    if (needsFinalNewline) {
      writeFileSync(fd, '\n', 'utf8');
      fsyncSync(fd);
      expectedSize++;
    }
    const boundary = expectedSize === initialBoundary.size
      ? initialBoundary
      : journalBoundaryFromOpenFile(file, fd);
    if (boundary.size !== expectedSize) {
      throw new RuntimeStorageError('invalid_thread_journal', 'Repaired journal tail size differs from boundary');
    }
    assertJournalFileBoundary(file, fd, boundary);
    return {
      sequenceState,
      codecState: cloneJournalMessageCodecState(codecState),
      boundary,
      state: foldedState,
    };
  } finally {
    closeSync(fd);
  }
}

interface JournalSequenceState {
  recordCount: number;
  readonly mailboxPrepares: Map<OpIdString, Extract<RuntimeJournalRecord, { type: 'mailbox_prepare' }>>;
  readonly mailboxStates: Map<OpIdString, 'prepared' | 'accepted_pending' | 'started' | 'completed' | 'rejected'>;
  readonly usedRunIds: Map<string, string>;
  readonly runStates: Map<string, 'reserved' | 'started' | 'terminal'>;
  readonly successorByPredecessor: Map<string, Extract<RuntimeJournalRecord, { type: 'successor_run_prepare' }>>;
  readonly successorByRun: Map<string, Extract<RuntimeJournalRecord, { type: 'successor_run_prepare' }>>;
  readonly turnByKey: Map<string, Extract<RuntimeJournalRecord, { type: 'turn_prepare' }>>;
  readonly usedTurnIds: Map<string, string>;
  readonly activatedTurns: Set<string>;
  readonly pendingResults: Map<string, Extract<RuntimeThreadMutation, { type: 'thread_result_pending' }>>;
  readonly deliveredResults: Set<string>;
  readonly usedRequestIds: Set<string>;
  readonly controlClaims: Map<string, ExternalOpId>;
  readonly observedRuleScopes: Set<string>;
  seedSeen: boolean;
  nextSeq: number;
}

function validateJournalSequence(
  records: readonly RuntimeJournalRecord[],
  workspaceId: WorkspaceId,
  threadId: ThreadId,
): JournalSequenceState {
  if (records.length === 0 || records[0]?.type !== 'thread_meta') {
    throw new RuntimeStorageError('invalid_thread_journal', `Thread ${threadId} has no meta header`);
  }
  return validateJournalSequenceAppend(records, workspaceId, threadId, emptyJournalSequenceState());
}

function validateJournalSequenceAppend(
  records: readonly RuntimeJournalRecord[],
  workspaceId: WorkspaceId,
  threadId: ThreadId,
  previous: Readonly<JournalSequenceState>,
): JournalSequenceState {
  const state = cloneJournalSequenceState(previous);

  for (const record of records) {
    const index = state.recordCount;
    state.recordCount++;
    if (record.type === 'thread_meta') {
      if (index !== 0 || record.workspaceId !== workspaceId || record.threadId !== threadId) {
        throw invalidJournal('thread_meta must appear exactly once at position zero');
      }
      continue;
    }
    if (index === 0) {
      throw invalidJournal(`Thread ${threadId} has no meta header`);
    }
    if (record.type === 'thread_seed') {
      if (state.seedSeen || index !== 1) {
        throw invalidJournal('thread_seed must appear at most once immediately after thread_meta');
      }
      state.seedSeen = true;
      continue;
    }
    if (record.type === 'mailbox_prepare') {
      if (state.mailboxPrepares.has(record.opId)) throw invalidJournal(`Duplicate mailbox prepare ${record.opId}`);
      state.mailboxPrepares.set(record.opId, record);
      state.mailboxStates.set(record.opId, 'prepared');
      continue;
    }
    if (record.type === 'successor_run_prepare') {
      const prior = state.successorByPredecessor.get(record.predecessorRunId);
      if (prior !== undefined) {
        throw invalidJournal(`Duplicate successor reservation for ${record.predecessorRunId}`);
      }
      claimIdentity(state.usedRunIds, record.runId, successorIdentityKey(record), 'RunId');
      if (!state.usedRunIds.has(record.predecessorRunId)) {
        throw invalidJournal(`Successor predecessor is unknown: ${record.predecessorRunId}`);
      }
      state.successorByPredecessor.set(record.predecessorRunId, record);
      state.successorByRun.set(record.runId, record);
      continue;
    }
    if (record.type === 'turn_prepare') {
      const key = turnReservationKey(record.runId, record.turnOrdinal);
      if (state.turnByKey.has(key)) throw invalidJournal(`Duplicate turn reservation ${key}`);
      if (!state.usedRunIds.has(record.runId)) throw invalidJournal(`Turn reservation has unknown RunId ${record.runId}`);
      claimIdentity(state.usedTurnIds, record.turnId, key, 'TurnId');
      state.turnByKey.set(key, record);
      continue;
    }
    if (record.type === 'thread_result_delivered') {
      const pending = state.pendingResults.get(record.resultOpId);
      if (pending === undefined || pending.parentThreadId !== record.parentThreadId) {
        throw invalidJournal(`Thread result delivery has no matching outbox item ${record.resultOpId}`);
      }
      if (state.deliveredResults.has(record.resultOpId)) {
        throw invalidJournal(`Duplicate thread result delivery ${record.resultOpId}`);
      }
      state.deliveredResults.add(record.resultOpId);
      continue;
    }

    if (record.firstSeq !== state.nextSeq) {
      throw invalidJournal(`Commit sequence expected ${state.nextSeq}, received ${record.firstSeq}`);
    }
    state.nextSeq += record.envelopes.length;
    validateCommitCorrespondence(record, state.mailboxPrepares);

    for (const mutation of record.mutations ?? []) {
      switch (mutation.type) {
        case 'accepted_pending':
          transitionMailbox(state.mailboxStates, mutation.opId, ['prepared'], 'accepted_pending');
          break;
        case 'started':
          transitionMailbox(state.mailboxStates, mutation.opId, ['accepted_pending'], 'started');
          break;
        case 'completed':
          transitionMailbox(state.mailboxStates, mutation.opId, ['accepted_pending', 'started'], 'completed');
          break;
        case 'rejected':
          transitionMailbox(state.mailboxStates, mutation.opId, ['prepared'], 'rejected');
          break;
        case 'run_reserved': {
          if (mutation.reason === 'retry' || mutation.reason === 'compaction') {
            const prepared = state.successorByRun.get(mutation.runId);
            if (prepared === undefined
              || prepared.predecessorRunId !== mutation.predecessorRunId
              || prepared.reason !== mutation.reason
              || canonicalJson(prepared.permissionCeiling) !== canonicalJson(mutation.permissionCeiling)) {
              throw invalidJournal(`Run activation does not match successor prepare ${mutation.runId}`);
            }
            claimIdentity(state.usedRunIds, mutation.runId, successorIdentityKey(prepared), 'RunId');
          } else if ('ownerOpId' in mutation) {
            const prepared = state.mailboxPrepares.get(mutation.ownerOpId);
            if (prepared === undefined || prepared.op.type !== mutation.reason) {
              throw invalidJournal(`Root run has no matching mailbox prepare ${mutation.runId}`);
            }
            claimIdentity(state.usedRunIds, mutation.runId, rootRunIdentityKey(mutation.ownerOpId), 'RunId');
          } else {
            throw invalidJournal(`Malformed root run reservation ${mutation.runId}`);
          }
          if (state.runStates.has(mutation.runId)) throw invalidJournal(`RunId activated twice ${mutation.runId}`);
          state.runStates.set(mutation.runId, 'reserved');
          break;
        }
        case 'run_started':
          transitionRun(state.runStates, mutation.runId, ['reserved'], 'started');
          break;
        case 'run_terminal':
          transitionRun(state.runStates, mutation.runId, ['reserved', 'started'], 'terminal');
          break;
        case 'turn_activated': {
          const key = turnReservationKey(mutation.runId, mutation.turnOrdinal);
          const prepared = state.turnByKey.get(key);
          if (prepared === undefined || prepared.turnId !== mutation.turnId) {
            throw invalidJournal(`Turn activation has no matching prepare ${mutation.turnId}`);
          }
          if (state.activatedTurns.has(key)) throw invalidJournal(`Turn activated twice ${mutation.turnId}`);
          state.activatedTurns.add(key);
          break;
        }
        case 'input_materialized': {
          const prepared = state.mailboxPrepares.get(mutation.ownerOpId);
          if (prepared === undefined || (prepared.op.type !== 'prompt' && prepared.op.type !== 'continue')) {
            throw invalidJournal(`Input owner is not a prompt/continue op ${mutation.ownerOpId}`);
          }
          break;
        }
        case 'input_transferred':
          if (!state.mailboxPrepares.has(mutation.fromOpId) || !state.mailboxPrepares.has(mutation.toOpId)) {
            throw invalidJournal('Input transfer references an unknown mailbox op');
          }
          break;
        case 'input_cancelled':
          if (!state.mailboxPrepares.has(mutation.ownerOpId) || !state.mailboxPrepares.has(mutation.byAbortOpId)) {
            throw invalidJournal('Input cancellation references an unknown mailbox op');
          }
          break;
        case 'control_requested':
          if (state.usedRequestIds.has(mutation.request.requestId)) {
            throw invalidJournal(`Control request identity reused ${mutation.request.requestId}`);
          }
          state.usedRequestIds.add(mutation.request.requestId);
          break;
        case 'control_response_claimed':
          if (!state.usedRequestIds.has(mutation.requestId) || state.controlClaims.has(mutation.requestId)) {
            throw invalidJournal(`Invalid control response claim ${mutation.requestId}`);
          }
          state.controlClaims.set(mutation.requestId, mutation.responseOpId);
          break;
        case 'control_response_claim_released':
          if (state.controlClaims.get(mutation.requestId) !== mutation.responseOpId) {
            throw invalidJournal(`Control response release does not own claim ${mutation.requestId}`);
          }
          state.controlClaims.delete(mutation.requestId);
          break;
        case 'control_resolved':
          if (!state.usedRequestIds.has(mutation.resolution.requestId)) {
            throw invalidJournal(`Control resolution has no request ${mutation.resolution.requestId}`);
          }
          break;
        case 'thread_result_pending': {
          if (mutation.childThreadId !== threadId || state.pendingResults.has(mutation.resultOpId)) {
            throw invalidJournal(`Invalid or duplicate thread result outbox item ${mutation.resultOpId}`);
          }
          state.pendingResults.set(mutation.resultOpId, mutation);
          break;
        }
        case 'rule_scope_observed':
          state.observedRuleScopes.add(mutation.scope);
          break;
        case 'rule_scope_window_replaced': {
          const current = [...state.observedRuleScopes].sort(compareUtf8);
          if (canonicalJson(current) !== canonicalJson(mutation.consumedScopes)) {
            throw invalidJournal(`Rule scope window witness mismatch for ${mutation.owningTurnId}`);
          }
          state.observedRuleScopes.clear();
          for (const scope of mutation.replacementScopes) state.observedRuleScopes.add(scope);
          break;
        }
        case 'message_appended':
        case 'compaction_committed':
        case 'activity_interrupted':
        case 'model_selected':
          break;
      }
    }
  }
  return state;
}

function emptyJournalSequenceState(): JournalSequenceState {
  return {
    recordCount: 0,
    mailboxPrepares: new Map(),
    mailboxStates: new Map(),
    usedRunIds: new Map(),
    runStates: new Map(),
    successorByPredecessor: new Map(),
    successorByRun: new Map(),
    turnByKey: new Map(),
    usedTurnIds: new Map(),
    activatedTurns: new Set(),
    pendingResults: new Map(),
    deliveredResults: new Set(),
    usedRequestIds: new Set(),
    controlClaims: new Map(),
    observedRuleScopes: new Set(),
    seedSeen: false,
    nextSeq: 1,
  };
}

function cloneJournalSequenceState(previous: Readonly<JournalSequenceState>): JournalSequenceState {
  return {
    recordCount: previous.recordCount,
    mailboxPrepares: new Map(previous.mailboxPrepares),
    mailboxStates: new Map(previous.mailboxStates),
    usedRunIds: new Map(previous.usedRunIds),
    runStates: new Map(previous.runStates),
    successorByPredecessor: new Map(previous.successorByPredecessor),
    successorByRun: new Map(previous.successorByRun),
    turnByKey: new Map(previous.turnByKey),
    usedTurnIds: new Map(previous.usedTurnIds),
    activatedTurns: new Set(previous.activatedTurns),
    pendingResults: new Map(previous.pendingResults),
    deliveredResults: new Set(previous.deliveredResults),
    usedRequestIds: new Set(previous.usedRequestIds),
    controlClaims: new Map(previous.controlClaims),
    observedRuleScopes: new Set(previous.observedRuleScopes),
    seedSeen: previous.seedSeen,
    nextSeq: previous.nextSeq,
  };
}

function serializeJournalSequenceState(
  state: Readonly<JournalSequenceState>,
): SerializedJournalSequenceState {
  return snapshot({
    recordCount: state.recordCount,
    mailboxPrepares: [...state.mailboxPrepares],
    mailboxStates: [...state.mailboxStates],
    usedRunIds: [...state.usedRunIds],
    runStates: [...state.runStates],
    successorByPredecessor: [...state.successorByPredecessor],
    successorByRun: [...state.successorByRun],
    turnByKey: [...state.turnByKey],
    usedTurnIds: [...state.usedTurnIds],
    activatedTurns: [...state.activatedTurns],
    pendingResults: [...state.pendingResults],
    deliveredResults: [...state.deliveredResults],
    usedRequestIds: [...state.usedRequestIds],
    controlClaims: [...state.controlClaims],
    observedRuleScopes: [...state.observedRuleScopes],
    seedSeen: state.seedSeen,
    nextSeq: state.nextSeq,
  });
}

function deserializeJournalSequenceState(input: unknown): JournalSequenceState {
  if (!isRecord(input)) throw new RuntimeStorageError('invalid_recovery_snapshot', 'Sequence cache is invalid');
  assertExactKeys(input, [
    'recordCount', 'mailboxPrepares', 'mailboxStates', 'usedRunIds', 'runStates',
    'successorByPredecessor', 'successorByRun', 'turnByKey', 'usedTurnIds',
    'activatedTurns', 'pendingResults', 'deliveredResults', 'usedRequestIds',
    'controlClaims', 'observedRuleScopes', 'seedSeen', 'nextSeq',
  ]);
  if (!isNonNegativeSafeInteger(input.recordCount) || !isPositiveSafeInteger(input.nextSeq)
    || typeof input.seedSeen !== 'boolean') {
    throw new RuntimeStorageError('invalid_recovery_snapshot', 'Sequence counters are invalid');
  }
  const entries = (value: unknown, label: string): readonly (readonly [unknown, unknown])[] => {
    if (!Array.isArray(value) || value.some((entry) => !Array.isArray(entry) || entry.length !== 2)) {
      throw new RuntimeStorageError('invalid_recovery_snapshot', `${label} entries are invalid`);
    }
    const keys = value.map((entry) => canonicalJson(entry[0]));
    if (new Set(keys).size !== keys.length) {
      throw new RuntimeStorageError('invalid_recovery_snapshot', `${label} entries are duplicated`);
    }
    return value as readonly (readonly [unknown, unknown])[];
  };
  const strings = (value: unknown, label: string): readonly string[] => {
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')
      || new Set(value).size !== value.length) {
      throw new RuntimeStorageError('invalid_recovery_snapshot', `${label} set is invalid`);
    }
    return value as readonly string[];
  };
  return {
    recordCount: input.recordCount,
    mailboxPrepares: new Map(entries(input.mailboxPrepares, 'mailboxPrepares')) as JournalSequenceState['mailboxPrepares'],
    mailboxStates: new Map(entries(input.mailboxStates, 'mailboxStates')) as JournalSequenceState['mailboxStates'],
    usedRunIds: new Map(entries(input.usedRunIds, 'usedRunIds')) as JournalSequenceState['usedRunIds'],
    runStates: new Map(entries(input.runStates, 'runStates')) as JournalSequenceState['runStates'],
    successorByPredecessor: new Map(entries(
      input.successorByPredecessor,
      'successorByPredecessor',
    )) as JournalSequenceState['successorByPredecessor'],
    successorByRun: new Map(entries(input.successorByRun, 'successorByRun')) as JournalSequenceState['successorByRun'],
    turnByKey: new Map(entries(input.turnByKey, 'turnByKey')) as JournalSequenceState['turnByKey'],
    usedTurnIds: new Map(entries(input.usedTurnIds, 'usedTurnIds')) as JournalSequenceState['usedTurnIds'],
    activatedTurns: new Set(strings(input.activatedTurns, 'activatedTurns')),
    pendingResults: new Map(entries(input.pendingResults, 'pendingResults')) as JournalSequenceState['pendingResults'],
    deliveredResults: new Set(strings(input.deliveredResults, 'deliveredResults')),
    usedRequestIds: new Set(strings(input.usedRequestIds, 'usedRequestIds')),
    controlClaims: new Map(entries(input.controlClaims, 'controlClaims')) as JournalSequenceState['controlClaims'],
    observedRuleScopes: new Set(strings(input.observedRuleScopes, 'observedRuleScopes')),
    seedSeen: input.seedSeen,
    nextSeq: input.nextSeq,
  };
}

function writeRecoverySnapshot(
  file: string,
  payload: Readonly<ThreadRecoverySnapshotPayload>,
): void {
  const copied = snapshot(payload);
  writeJsonAtomic(file, {
    ...copied,
    digest: canonicalJsonSha256(copied),
  } satisfies ThreadRecoverySnapshotFile);
}

function readRecoverySnapshot(
  file: string,
  meta: Readonly<ThreadMetaRecord>,
  workspaceId: WorkspaceId,
  threadId: ThreadId,
  observer?: JournalReadObserver,
): ValidatedRecoverySnapshot | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const snapshotStat = lstatSync(file);
    observer?.({ threadId, kind: 'snapshot', bytes: snapshotStat.size });
    const value = readJsonUnknown(file, 'invalid_recovery_snapshot');
    if (!isRecord(value)) throw new Error('snapshot is not an object');
    assertExactKeys(value, [
      'version', 'workspaceId', 'threadId', 'boundary', 'state', 'sequence', 'codec', 'digest',
    ]);
    const { digest, ...payload } = value;
    if (value.version !== 1 || value.workspaceId !== workspaceId || value.threadId !== threadId
      || typeof digest !== 'string' || canonicalJsonSha256(payload) !== digest
      || !isJournalBoundary(value.boundary)) {
      throw new Error('snapshot identity, digest, or boundary is invalid');
    }
    const state = deserializeThreadRecoveryState(value.state, meta);
    const sequenceState = deserializeJournalSequenceState(value.sequence);
    const codecState = deserializeJournalCodecState(value.codec);
    if (sequenceState.nextSeq !== state.highWaterSeq + 1) {
      throw new Error('snapshot sequence differs from high-water');
    }
    return {
      boundary: value.boundary,
      state,
      sequenceState,
      codecState,
    };
  } catch {
    // Snapshot is a cache. Missing/corrupt/untrusted materialization always falls back to journal.
    return undefined;
  }
}

function deserializeJournalCodecState(input: unknown): JournalMessageCodecState {
  if (!isRecord(input)) throw new Error('codec state is not an object');
  assertExactKeys(input, ['nextBlockStartIndex', 'openBlocks'], ['activeAssistant']);
  const nextBlockStartIndex = input.nextBlockStartIndex;
  if (!isNonNegativeSafeInteger(nextBlockStartIndex)
    || !Array.isArray(input.openBlocks) || input.openBlocks.some((block) =>
    !isRecord(block) || !isNonNegativeSafeInteger(block.contentIndex)
    || (block.family !== 'text' && block.family !== 'reasoning' && block.family !== 'tool_call'))
    || (input.activeAssistant !== undefined
      && (!isRecord(input.activeAssistant) || input.activeAssistant.role !== 'assistant'))) {
    throw new Error('codec state is malformed');
  }
  const activeAssistant = input.activeAssistant === undefined
    ? undefined
    : validateAgentMessage(input.activeAssistant);
  if (activeAssistant !== undefined && activeAssistant.role !== 'assistant') {
    throw new Error('codec active message is not an assistant');
  }
  const openBlocks = input.openBlocks as readonly {
    readonly contentIndex: number;
    readonly family: 'text' | 'reasoning' | 'tool_call';
  }[];
  const openIndexes = new Set(openBlocks.map((block) => block.contentIndex));
  if (openIndexes.size !== openBlocks.length
    || (activeAssistant === undefined
      && (nextBlockStartIndex !== 0 || openBlocks.length !== 0))
    || (activeAssistant !== undefined
      && (nextBlockStartIndex > activeAssistant.content.length
        || openBlocks.some((block) => block.contentIndex >= nextBlockStartIndex
          || activeAssistant.content[block.contentIndex]?.type !== block.family)))) {
    throw new Error('codec lifecycle state is inconsistent');
  }
  return cloneJournalMessageCodecState({
    ...(activeAssistant !== undefined && { activeAssistant }),
    nextBlockStartIndex,
    openBlocks,
  });
}

function journalBoundary(file: string): JournalFileBoundary {
  assertRegularFileNoSymlink(file);
  const stat = lstatSync(file);
  return boundaryFromStat(stat);
}

function boundaryFromStat(stat: Readonly<{
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}>): JournalFileBoundary {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function journalBoundaryFromOpenFile(file: string, fd: number): JournalFileBoundary {
  const descriptor = fstatSync(fd);
  const pathname = lstatSync(file);
  const fromDescriptor = boundaryFromStat(descriptor);
  const fromPath = boundaryFromStat(pathname);
  if (!descriptor.isFile() || pathname.isSymbolicLink() || !pathname.isFile()
    || !sameBoundary(fromDescriptor, fromPath)) {
    throw new RuntimeStorageError(
      'invalid_thread_journal',
      `Thread journal changed outside the active writer: ${file}`,
    );
  }
  return fromDescriptor;
}

function isJournalBoundary(value: unknown): value is JournalFileBoundary {
  return isRecord(value) && isNonNegativeSafeInteger(value.dev)
    && isNonNegativeSafeInteger(value.ino) && isNonNegativeSafeInteger(value.size)
    && isNonNegativeFiniteNumber(value.mtimeMs) && isNonNegativeFiniteNumber(value.ctimeMs)
    && Object.keys(value).length === 5;
}

function sameBoundary(left: Readonly<JournalFileBoundary>, right: Readonly<JournalFileBoundary>): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function recoveryStateCoversCursor(state: Readonly<FoldedThreadJournal>, afterSeq: number): boolean {
  return afterSeq >= (state.envelopes[0]?.seq ?? state.highWaterSeq + 1) - 1;
}

type OpIdString = string;

function invalidJournal(message: string): RuntimeStorageError {
  return new RuntimeStorageError('invalid_thread_journal', message);
}

function claimIdentity(
  claims: Map<string, string>,
  identity: string,
  key: string,
  label: 'RunId' | 'TurnId',
): void {
  const existing = claims.get(identity);
  if (existing !== undefined && existing !== key) {
    throw invalidJournal(`${label} identity collision: ${identity}`);
  }
  claims.set(identity, key);
}

function successorIdentityKey(
  record: Extract<RuntimeJournalRecord, { type: 'successor_run_prepare' }>,
): string {
  return canonicalJson(['successor', record.predecessorRunId, record.reason]);
}

function rootRunIdentityKey(ownerOpId: string): string {
  return canonicalJson(['root', ownerOpId]);
}

function turnReservationKey(runId: string, ordinal: number): string {
  return canonicalJson(['turn', runId, ordinal]);
}

function transitionMailbox(
  states: Map<string, 'prepared' | 'accepted_pending' | 'started' | 'completed' | 'rejected'>,
  opId: string,
  expected: readonly ('prepared' | 'accepted_pending' | 'started')[],
  next: 'accepted_pending' | 'started' | 'completed' | 'rejected',
): void {
  const current = states.get(opId);
  if (current === undefined || !expected.includes(current as 'prepared' | 'accepted_pending' | 'started')) {
    throw invalidJournal(`Invalid mailbox transition ${String(current)} -> ${next} for ${opId}`);
  }
  states.set(opId, next);
}

function transitionRun(
  states: Map<string, 'reserved' | 'started' | 'terminal'>,
  runId: string,
  expected: readonly ('reserved' | 'started')[],
  next: 'started' | 'terminal',
): void {
  const current = states.get(runId);
  if (current === undefined || !expected.includes(current as 'reserved' | 'started')) {
    throw invalidJournal(`Invalid run transition ${String(current)} -> ${next} for ${runId}`);
  }
  states.set(runId, next);
}

function validateCommitCorrespondence(
  record: Extract<RuntimeJournalRecord, { type: 'commit' }>,
  mailboxPrepares: ReadonlyMap<string, Extract<RuntimeJournalRecord, { type: 'mailbox_prepare' }>>,
): void {
  const lifecycleEnvelopes = record.envelopes.flatMap((envelope) => {
    if (envelope.opId === undefined || !mailboxPrepares.has(envelope.opId)
      || !isMailboxLifecycleEvent(envelope.event)) return [];
    return [{ envelope, event: envelope.event }];
  });
  const lifecycleMutations = (record.mutations ?? []).filter(isMailboxLifecycleMutation);
  if (lifecycleEnvelopes.length !== lifecycleMutations.length) {
    throw invalidJournal('Mailbox lifecycle envelopes and mutations differ');
  }
  for (let index = 0; index < lifecycleMutations.length; index++) {
    const mutation = lifecycleMutations[index];
    const item = lifecycleEnvelopes[index];
    if (mutation === undefined || item === undefined || item.envelope.opId !== mutation.opId) {
      throw invalidJournal('Mailbox lifecycle envelope/mutation order differs');
    }
    const prepared = mailboxPrepares.get(mutation.opId);
    if (prepared === undefined || item.event.opType !== prepared.op.type) {
      throw invalidJournal('Mailbox lifecycle op type differs from prepare');
    }
    const expectedEvent = mutation.type === 'accepted_pending' ? 'op_accepted'
      : mutation.type === 'started' ? 'op_started'
        : mutation.type === 'completed' ? 'op_completed' : 'op_rejected';
    if (item.event.type !== expectedEvent) throw invalidJournal('Mailbox lifecycle event type differs from mutation');
    if (mutation.type === 'completed' && item.event.type === 'op_completed'
      && item.event.outcome !== mutation.outcome) {
      throw invalidJournal('Mailbox completion outcome differs from envelope');
    }
    if (mutation.type === 'rejected' && item.event.type === 'op_rejected'
      && item.event.reason !== mutation.reason) {
      throw invalidJournal('Mailbox rejection reason differs from envelope');
    }
  }

  for (const mutation of record.mutations ?? []) {
    if (mutation.type === 'message_appended') {
      requireMatchingEnvelope(record, 'message_end', (event) =>
        canonicalJson(event.message) === canonicalJson(mutation.message));
    } else if (mutation.type === 'control_requested') {
      requireMatchingEnvelope(record, 'control_request', (event) =>
        canonicalJson(event) === canonicalJson(mutation.request));
    } else if (mutation.type === 'control_resolved') {
      requireMatchingEnvelope(record, 'control_resolved', (event) =>
        canonicalJson(event) === canonicalJson(mutation.resolution));
    } else if (mutation.type === 'compaction_committed') {
      requireMatchingEnvelope(record, 'compaction_end', (event) => event.ok === true);
    } else if (mutation.type === 'turn_activated') {
      const found = record.envelopes.some((envelope) =>
        envelope.runId === mutation.runId && envelope.turnId === mutation.turnId
        && (envelope.event.type === 'turn_start' || envelope.event.type === 'queue_update'));
      if (!found) throw invalidJournal('turn_activated has no matching first turn envelope');
    } else if (mutation.type === 'rule_scope_window_replaced') {
      const found = record.envelopes.some((envelope) =>
        envelope.turnId === mutation.owningTurnId && envelope.event.type === 'turn_start');
      if (!found) throw invalidJournal('rule scope window replacement has no matching turn_start');
    } else if (mutation.type === 'thread_title_updated') {
      requireMatchingEnvelope(record, 'thread_updated', (event) =>
        event.changed === 'title'
        && event.thread.title === mutation.title
        && event.thread.updatedAt === mutation.updatedAt);
    } else if (mutation.type === 'thread_archive_updated') {
      requireMatchingEnvelope(record, 'thread_updated', (event) =>
        event.changed === 'archived'
        && event.thread.archivedAt === mutation.archivedAt
        && event.thread.updatedAt === mutation.updatedAt);
    }
  }
}

function isMailboxLifecycleMutation(
  mutation: RuntimeThreadMutation,
): mutation is Extract<RuntimeThreadMutation, { type: 'accepted_pending' | 'started' | 'completed' | 'rejected' }> {
  return mutation.type === 'accepted_pending' || mutation.type === 'started'
    || mutation.type === 'completed' || mutation.type === 'rejected';
}

function isMailboxLifecycleEvent(
  event: Readonly<import('../protocol/index.js').RuntimeEvent>,
): event is Extract<import('../protocol/index.js').RuntimeEvent, {
  type: 'op_accepted' | 'op_started' | 'op_completed' | 'op_rejected';
}> {
  return event.type === 'op_accepted' || event.type === 'op_started'
    || event.type === 'op_completed' || event.type === 'op_rejected';
}

function requireMatchingEnvelope<T extends import('../protocol/index.js').RuntimeEvent['type']>(
  record: Extract<RuntimeJournalRecord, { type: 'commit' }>,
  type: T,
  predicate: (event: Extract<import('../protocol/index.js').RuntimeEvent, { type: T }>) => boolean,
): void {
  const found = record.envelopes.some((envelope) =>
    envelope.event.type === type
    && predicate(envelope.event as Extract<import('../protocol/index.js').RuntimeEvent, { type: T }>));
  if (!found) throw invalidJournal(`${type} mutation has no matching envelope`);
}

function validateJournalRecord(
  input: unknown,
  workspaceId: WorkspaceId,
  threadId: ThreadId,
  requireMeta: boolean,
  physicalCodecState?: JournalMessageCodecState,
): RuntimeJournalRecord {
  const value = snapshotUnknown(input, 'invalid_thread_journal');
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new RuntimeStorageError('invalid_thread_journal', 'Journal record has no discriminator');
  }
  if (requireMeta && value.type !== 'thread_meta') {
    throw new RuntimeStorageError('invalid_thread_journal', 'First journal record must be thread_meta');
  }
  switch (value.type) {
    case 'thread_meta':
      return validateThreadMeta(value, workspaceId, threadId);
    case 'thread_seed':
      return validateThreadSeed(value);
    case 'mailbox_prepare':
      assertExactKeys(value, ['type', 'opId', 'op', 'timestamp']);
      if (!isOpId(value.opId) || !isRecord(value.op) || value.op.opId !== value.opId
        || !isFiniteNumber(value.timestamp)
        || !validateMailboxOp(value.op, workspaceId, threadId)) {
        throw new RuntimeStorageError('invalid_thread_journal', 'Invalid mailbox_prepare');
      }
      return value as unknown as RuntimeJournalRecord;
    case 'successor_run_prepare':
      assertExactKeys(value, [
        'type', 'runId', 'predecessorRunId', 'reason', 'permissionCeiling', 'timestamp',
      ]);
      if (!isRunId(value.runId) || !isRunId(value.predecessorRunId)
        || (value.reason !== 'retry' && value.reason !== 'compaction')
        || !isPermissionCeiling(value.permissionCeiling) || !isFiniteNumber(value.timestamp)) {
        throw new RuntimeStorageError('invalid_thread_journal', 'Invalid successor_run_prepare');
      }
      return value as unknown as RuntimeJournalRecord;
    case 'turn_prepare':
      assertExactKeys(value, [
        'type', 'runId', 'turnId', 'turnOrdinal', 'workspaceCeiling', 'runCeiling',
        'turnCeiling', 'timestamp',
      ]);
      if (!isRunId(value.runId) || !isTurnId(value.turnId)
        || !isPositiveSafeInteger(value.turnOrdinal)
        || !isPermissionCeiling(value.workspaceCeiling)
        || !isPermissionCeiling(value.runCeiling)
        || !isPermissionCeiling(value.turnCeiling)
        || !isFiniteNumber(value.timestamp)) {
        throw new RuntimeStorageError('invalid_thread_journal', 'Invalid turn_prepare');
      }
      return value as unknown as RuntimeJournalRecord;
    case 'commit': {
      if (physicalCodecState !== undefined) {
        const decoded = decodeDurableCommitRecord(input, workspaceId, threadId, physicalCodecState);
        return validateCanonicalCommit(decoded, workspaceId, threadId);
      }
      return validateCanonicalCommit(value, workspaceId, threadId);
    }
    case 'thread_result_delivered':
      assertExactKeys(value, ['type', 'resultOpId', 'parentThreadId', 'parentCommitSeq']);
      if (!isDerivedOpId(value.resultOpId) || !isThreadId(value.parentThreadId)
        || !isPositiveSafeInteger(value.parentCommitSeq)) {
        throw new RuntimeStorageError('invalid_thread_journal', 'Invalid thread_result_delivered');
      }
      return value as unknown as RuntimeJournalRecord;
    default:
      throw new RuntimeStorageError('invalid_thread_journal', `Unknown journal record ${value.type}`);
  }
}

function validateCanonicalCommit(
  input: unknown,
  workspaceId: WorkspaceId,
  threadId: ThreadId,
): Extract<RuntimeJournalRecord, { type: 'commit' }> {
      const value = snapshotUnknown(input, 'invalid_thread_journal');
      if (!isRecord(value)) {
        throw new RuntimeStorageError('invalid_thread_journal', 'Invalid commit shape');
      }
      assertExactKeys(value, ['type', 'firstSeq', 'envelopes'], ['mutations']);
      if (value.type !== 'commit' || !isPositiveSafeInteger(value.firstSeq) || !Array.isArray(value.envelopes)
        || value.envelopes.length === 0 || (value.mutations !== undefined && !Array.isArray(value.mutations))) {
        throw new RuntimeStorageError('invalid_thread_journal', 'Invalid commit shape');
      }
      const firstSeq = value.firstSeq;
      const envelopes = value.envelopes.map((envelope, index) => {
        const validated = validateEventEnvelope(envelope);
        if (validated.workspaceId !== workspaceId || validated.threadId !== threadId
          || validated.seq !== firstSeq + index) {
          throw new RuntimeStorageError('invalid_thread_journal', 'Commit envelope ownership/sequence mismatch');
        }
        return validated;
      });
      const mutations = value.mutations?.map((mutation) => validateMutation(mutation, workspaceId, threadId));
      return snapshot({
        type: 'commit',
        firstSeq,
        envelopes: envelopes as unknown as readonly [typeof envelopes[number], ...typeof envelopes],
        ...(mutations !== undefined && { mutations }),
      }) as Extract<RuntimeJournalRecord, { type: 'commit' }>;
}

function validateThreadMeta(input: unknown, workspaceId: WorkspaceId, threadId: ThreadId): ThreadMetaRecord {
  const value = snapshotUnknown(input, 'invalid_thread_meta');
  if (isRecord(value) && value.type === 'thread_meta') {
    assertReadableProtocolVersion(value.protocolVersion, threadId);
    if (value.version !== 3) {
      throw unsupportedJournalVersion(threadId, value.version);
    }
  }
  if (isRecord(value)) {
    assertExactKeys(value, [
      'type', 'version', 'protocolVersion', 'workspaceId', 'threadId', 'permissionCeiling',
      'createdAt', 'cwd', 'model',
    ], ['parentThreadId', 'createdByRunId', 'createdByOpId']);
  }
  if (!isRecord(value) || value.type !== 'thread_meta' || value.version !== 3
    || !isNonEmptyWellFormedString(value.protocolVersion) || value.workspaceId !== workspaceId
    || value.threadId !== threadId || !isThreadId(value.threadId)
    || (value.parentThreadId !== undefined && !isThreadId(value.parentThreadId))
    || (value.createdByRunId !== undefined && !isRunId(value.createdByRunId))
    || (value.createdByOpId !== undefined && !isExternalOpId(value.createdByOpId))
    || !isPermissionCeiling(value.permissionCeiling) || !isFiniteNumber(value.createdAt)
    || typeof value.cwd !== 'string' || !isWellFormedUnicode(value.cwd)
    || !isModelRef(value.model)) {
    throw new RuntimeStorageError('invalid_thread_meta', `Invalid metadata for thread ${threadId}`);
  }
  return value as unknown as ThreadMetaRecord;
}

function unsupportedJournalVersion(threadId: ThreadId, version: unknown): RuntimeStorageError {
  return new RuntimeStorageError(
    'unsupported_journal_version',
    `Thread ${threadId} uses unsupported journal version ${String(version)}; clear the workspace journal`,
  );
}

function assertReadableProtocolVersion(value: unknown, threadId: ThreadId): void {
  const compatibility = classifyProtocolVersion(value);
  if (compatibility.compatible) return;
  const version = JSON.stringify(value) ?? String(value);
  let message: string;
  switch (compatibility.code) {
    case 'malformed_protocol_version':
      message = `Thread ${threadId} has malformed protocolVersion ${version}; expected canonical MAJOR.MINOR.PATCH`;
      break;
    case 'retired_protocol_major':
      message = `Thread ${threadId} protocolVersion ${version} uses retired major ${compatibility.major}`;
      break;
    case 'unsupported_protocol_major':
      message = `Thread ${threadId} protocolVersion ${version} uses unsupported future major ${compatibility.major}`;
      break;
    case 'unsupported_protocol_minor':
      message = `Thread ${threadId} protocolVersion ${version} uses unsupported future minor ${compatibility.minor}`;
      break;
  }
  throw new RuntimeStorageError(compatibility.code, message);
}

function validateThreadSeed(input: unknown): ThreadSeedRecord {
  const value = snapshotUnknown(input, 'invalid_thread_seed');
  if (isRecord(value)) {
    assertExactKeys(value, ['type', 'transcript', 'turnProvenance', 'usage'], ['compaction']);
  }
  if (!isRecord(value) || value.type !== 'thread_seed'
    || !Array.isArray(value.transcript) || !Array.isArray(value.turnProvenance)
    || !isThreadUsage(value.usage)) {
    throw new RuntimeStorageError('invalid_thread_seed', 'Invalid thread seed');
  }
  const transcript = value.transcript.map((message) => validateAgentMessage(message));
  const turnProvenance = validateThreadSeedTurnProvenance(value.turnProvenance, transcript);
  if (value.compaction !== undefined) validateCompactionCheckpoint(value.compaction);
  return snapshot({
    ...value,
    transcript,
    turnProvenance,
  }) as unknown as ThreadSeedRecord;
}

function validateThreadSeedTurnProvenance(
  input: unknown,
  transcript: readonly AgentMessage[],
): ThreadSeedRecord['turnProvenance'] {
  if (!Array.isArray(input)) {
    throw new RuntimeStorageError('invalid_thread_seed', 'Invalid thread seed turn provenance');
  }
  if (input.length !== transcript.length) {
    throw new RuntimeStorageError('invalid_thread_seed', 'Invalid thread seed turn provenance');
  }
  const result = input.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new RuntimeStorageError('invalid_thread_seed', 'Invalid thread seed turn provenance');
    }
    assertExactKeys(entry, ['messageId', 'turnId']);
    if (!isNonEmptyWellFormedString(entry.messageId)
      || entry.messageId !== transcript[index]?.id || !isTurnId(entry.turnId)) {
      throw new RuntimeStorageError('invalid_thread_seed', 'Invalid thread seed turn provenance');
    }
    return { messageId: entry.messageId, turnId: entry.turnId };
  });
  return snapshot(result);
}

function validateMutation(
  input: unknown,
  workspaceId: WorkspaceId,
  threadId: ThreadId,
): RuntimeThreadMutation {
  const value = snapshotUnknown(input, 'invalid_thread_mutation');
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new RuntimeStorageError('invalid_thread_mutation', 'Mutation has no discriminator');
  }
  switch (value.type) {
    case 'accepted_pending':
      assertExactKeys(value, ['type', 'opId', 'opType'], ['resolvedTarget', 'parentOpId']);
      if (!isOpId(value.opId) || typeof value.opType !== 'string') break;
      if (value.opType === 'abort') {
        if (!isResolvedAbortTarget(value.resolvedTarget)
          || (value.parentOpId !== undefined && !isExternalOpId(value.parentOpId))) break;
      } else if (!isMailboxOpType(value.opType) || value.resolvedTarget !== undefined
        || value.parentOpId !== undefined) break;
      return value as unknown as RuntimeThreadMutation;
    case 'started':
      assertExactKeys(value, ['type', 'opId']);
      if (isOpId(value.opId)) return value as unknown as RuntimeThreadMutation;
      break;
    case 'completed':
      assertExactKeys(value, ['type', 'opId', 'outcome']);
      if (isOpId(value.opId) && isOutcome(value.outcome)) return value as unknown as RuntimeThreadMutation;
      break;
    case 'rejected':
      assertExactKeys(value, ['type', 'opId', 'reason']);
      if (isOpId(value.opId) && isWellFormedString(value.reason)) return value as unknown as RuntimeThreadMutation;
      break;
    case 'input_materialized':
      assertExactKeys(value, ['type', 'ownerOpId', 'messageId']);
      if (isOpId(value.ownerOpId) && isWellFormedString(value.messageId)) return value as unknown as RuntimeThreadMutation;
      break;
    case 'input_transferred':
      assertExactKeys(value, ['type', 'fromOpId', 'toOpId']);
      if (isOpId(value.fromOpId) && isOpId(value.toOpId)) return value as unknown as RuntimeThreadMutation;
      break;
    case 'input_cancelled':
      assertExactKeys(value, ['type', 'ownerOpId', 'byAbortOpId']);
      if (isOpId(value.ownerOpId) && isOpId(value.byAbortOpId)) return value as unknown as RuntimeThreadMutation;
      break;
    case 'message_appended':
      assertExactKeys(value, ['type', 'message']);
      validateAgentMessage(value.message);
      return value as unknown as RuntimeThreadMutation;
    case 'compaction_committed':
      assertExactKeys(value, ['type', 'compaction']);
      validateCompactionCheckpoint(value.compaction);
      return value as unknown as RuntimeThreadMutation;
    case 'control_requested': {
      assertExactKeys(value, ['type', 'request']);
      if (!isRecord(value.request) || value.request.type !== 'control_request') break;
      validateEventEnvelope({
        workspaceId,
        threadId,
        runId: value.request.owningRunId,
        turnId: value.request.owningTurnId,
        seq: 1,
        timestamp: 0,
        event: value.request,
      });
      return value as unknown as RuntimeThreadMutation;
    }
    case 'control_response_claimed':
      assertExactKeys(value, ['type', 'requestId', 'responseOpId', 'decision', 'acceptedAt']);
      if (isWellFormedString(value.requestId) && isExternalOpId(value.responseOpId)
        && isControlDecision(value.decision) && isFiniteNumber(value.acceptedAt)) {
        return value as unknown as RuntimeThreadMutation;
      }
      break;
    case 'control_response_claim_released':
      assertExactKeys(value, ['type', 'requestId', 'responseOpId', 'reason']);
      if (isWellFormedString(value.requestId) && isExternalOpId(value.responseOpId)
        && value.reason === 'effect_definitely_not_applied') return value as unknown as RuntimeThreadMutation;
      break;
    case 'control_resolved': {
      assertExactKeys(value, ['type', 'resolution']);
      if (!isRecord(value.resolution) || value.resolution.type !== 'control_resolved') break;
      validateEventEnvelope({
        workspaceId,
        threadId,
        runId: value.resolution.owningRunId,
        turnId: value.resolution.owningTurnId,
        // The mutation intentionally does not duplicate the response OpId; the
        // enclosing commit validates its real identity and matching envelope.
        opId: 'op_e_00000000000000000000000000000000',
        seq: 1,
        timestamp: 0,
        event: value.resolution,
      });
      return value as unknown as RuntimeThreadMutation;
    }
    case 'run_reserved':
      assertExactKeys(value, ['type', 'runId', 'reason', 'permissionCeiling'], ['ownerOpId', 'predecessorRunId']);
      if (!isRunId(value.runId) || !isPermissionCeiling(value.permissionCeiling)) break;
      if (value.reason === 'prompt' || value.reason === 'compact') {
        if (!isOpId(value.ownerOpId) || value.predecessorRunId !== undefined) break;
      } else if (value.reason === 'continue') {
        if (!isOpId(value.ownerOpId)
          || (value.predecessorRunId !== undefined && !isRunId(value.predecessorRunId))) break;
      } else if (value.reason === 'retry' || value.reason === 'compaction') {
        if (value.ownerOpId !== undefined || !isRunId(value.predecessorRunId)) break;
      } else break;
      return value as unknown as RuntimeThreadMutation;
    case 'run_started':
      assertExactKeys(value, ['type', 'runId']);
      if (isRunId(value.runId)) return value as unknown as RuntimeThreadMutation;
      break;
    case 'run_terminal':
      assertExactKeys(value, ['type', 'runId', 'status']);
      if (isRunId(value.runId) && isRunTerminalStatus(value.status)) return value as unknown as RuntimeThreadMutation;
      break;
    case 'turn_activated':
      assertExactKeys(value, ['type', 'runId', 'turnId', 'turnOrdinal']);
      if (isRunId(value.runId) && isTurnId(value.turnId) && isPositiveSafeInteger(value.turnOrdinal)) {
        return value as unknown as RuntimeThreadMutation;
      }
      break;
    case 'activity_interrupted':
      assertExactKeys(value, [
        'type', 'rootOpId', 'rootRunId', 'terminalRunId', 'discardedStartedToolCallIds',
      ], ['terminalTurnId', 'discardedPartialAssistantId']);
      if (isOpId(value.rootOpId) && isRunId(value.rootRunId) && isRunId(value.terminalRunId)
        && (value.terminalTurnId === undefined || isTurnId(value.terminalTurnId))
        && (value.discardedPartialAssistantId === undefined || isWellFormedString(value.discardedPartialAssistantId))
        && isStringArray(value.discardedStartedToolCallIds)) return value as unknown as RuntimeThreadMutation;
      break;
    case 'model_selected':
      assertExactKeys(value, ['type', 'ownerOpId', 'model']);
      if (isOpId(value.ownerOpId) && isModelRef(value.model)) return value as unknown as RuntimeThreadMutation;
      break;
    case 'thread_title_updated':
      assertExactKeys(value, ['type', 'title', 'updatedAt']);
      if (isNonEmptyWellFormedString(value.title)
        && value.title.length <= 200
        && isFiniteNumber(value.updatedAt)) return value as unknown as RuntimeThreadMutation;
      break;
    case 'thread_archive_updated':
      assertExactKeys(value, ['type', 'updatedAt'], ['archivedAt']);
      if (isFiniteNumber(value.updatedAt)
        && (value.archivedAt === undefined || isFiniteNumber(value.archivedAt))) {
        return value as unknown as RuntimeThreadMutation;
      }
      break;
    case 'rule_scope_observed':
      assertExactKeys(value, ['type', 'scope', 'owningTurnId', 'invocationId']);
      if (isWellFormedString(value.scope) && isTurnId(value.owningTurnId)
        && isWellFormedString(value.invocationId)) return value as unknown as RuntimeThreadMutation;
      break;
    case 'rule_scope_window_replaced':
      assertExactKeys(value, ['type', 'consumedScopes', 'replacementScopes', 'owningTurnId']);
      if (isCanonicalScopeArray(value.consumedScopes)
        && isCanonicalScopeArray(value.replacementScopes)
        && isTurnId(value.owningTurnId)) return value as unknown as RuntimeThreadMutation;
      break;
    case 'thread_result_pending':
      assertExactKeys(value, [
        'type', 'resultOpId', 'parentThreadId', 'childThreadId', 'terminalRunId', 'status',
      ], ['summary']);
      if (isDerivedOpId(value.resultOpId) && isThreadId(value.parentThreadId)
        && isThreadId(value.childThreadId) && isRunId(value.terminalRunId)
        && (value.status === 'completed' || value.status === 'aborted' || value.status === 'error')
        && (value.summary === undefined || isWellFormedString(value.summary))) {
        return value as unknown as RuntimeThreadMutation;
      }
      break;
    default:
      throw new RuntimeStorageError('invalid_thread_mutation', `Unknown mutation ${value.type}`);
  }
  throw new RuntimeStorageError('invalid_thread_mutation', `Malformed mutation ${value.type}`);
}

function readBinding(file: string): WorkspaceBindingFile {
  const value = readJsonUnknown(file, 'invalid_workspace_binding');
  if (isRecord(value)) assertExactKeys(value, ['version', 'workspaceId', 'recordedCwd']);
  if (!isRecord(value) || value.version !== 1 || !isWorkspaceIdValue(value.workspaceId)
    || typeof value.recordedCwd !== 'string' || !isWellFormedUnicode(value.recordedCwd)) {
    throw new RuntimeStorageError('invalid_workspace_binding', `Invalid workspace binding: ${file}`);
  }
  return value as unknown as WorkspaceBindingFile;
}

function readLedger(file: string, workspaceId: WorkspaceId): WorkspaceLedgerFile {
  const value = readJsonUnknown(file, 'invalid_workspace_ledger');
  validateLedger(value, workspaceId);
  return value as unknown as WorkspaceLedgerFile;
}

function validateLedger(input: unknown, workspaceId: WorkspaceId): void {
  const value = snapshotUnknown(input, 'invalid_workspace_ledger');
  if (isRecord(value)) assertExactKeys(value, ['version', 'fencingCounter', 'ops', 'derived']);
  if (!isRecord(value) || value.version !== 1 || !Number.isSafeInteger(value.fencingCounter)
    || typeof value.fencingCounter !== 'number' || value.fencingCounter < 0
    || !Array.isArray(value.ops) || !Array.isArray(value.derived)) {
    throw new RuntimeStorageError('invalid_workspace_ledger', 'Invalid workspace ledger shape/version');
  }
  const usedIds = new Set<string>();
  const usedTuples = new Set<string>();
  for (const op of value.ops) {
    validateSupervisorOpRecord(op, workspaceId);
    const opId = (op as Readonly<{ opId: string }>).opId;
    if (usedIds.has(opId)) throw new RuntimeStorageError('invalid_workspace_ledger', `Duplicate OpId ${opId}`);
    usedIds.add(opId);
  }
  for (const claim of value.derived) {
    validateDerivedClaim(claim, workspaceId);
    const typed = claim as unknown as DerivedOpIdentityClaim;
    const tuple = derivedTuple(typed);
    if (usedIds.has(typed.opId) || usedTuples.has(tuple)) {
      throw new RuntimeStorageError('invalid_workspace_ledger', 'Duplicate derived identity claim');
    }
    usedIds.add(typed.opId);
    usedTuples.add(tuple);
  }
}

function readCatalog(file: string): ThreadCatalogFile {
  const value = readJsonUnknown(file, 'invalid_thread_catalog');
  validateCatalog(value);
  return value as unknown as ThreadCatalogFile;
}

function validateCatalog(input: unknown): void {
  const value = snapshotUnknown(input, 'invalid_thread_catalog');
  if (isRecord(value)) assertExactKeys(value, ['version', 'threads']);
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.threads)) {
    throw new RuntimeStorageError('invalid_thread_catalog', 'Invalid thread catalog shape/version');
  }
  const ids = new Set<string>();
  for (const entry of value.threads) {
    if (isRecord(entry)) {
      assertExactKeys(entry, ['summary', 'format', 'storageKey'], [
        'meta', 'journal', 'preview', 'updatedAt',
      ]);
    }
    if (!isRecord(entry) || !isThreadSummary(entry.summary)
      || entry.format !== 'runtime-v2'
      || !isNonEmptyWellFormedString(entry.storageKey)
      || (entry.preview !== undefined && !isWellFormedString(entry.preview))
      || (entry.updatedAt !== undefined && !isFiniteNumber(entry.updatedAt))) {
      throw new RuntimeStorageError('invalid_thread_catalog', 'Invalid thread catalog entry');
    }
    if (isRecord(entry.meta) && entry.meta.type === 'thread_meta') {
      assertReadableProtocolVersion(entry.meta.protocolVersion, entry.summary.threadId as ThreadId);
      if (entry.meta.version !== 3) {
        throw unsupportedJournalVersion(entry.summary.threadId as ThreadId, entry.meta.version);
      }
    }
    if (entry.meta !== undefined) {
      if (!isRecord(entry.meta) || entry.meta.type !== 'thread_meta' || entry.meta.version !== 3
        || entry.meta.threadId !== entry.summary.threadId || !isWorkspaceIdValue(entry.meta.workspaceId)) {
        throw new RuntimeStorageError('invalid_thread_catalog', 'Invalid thread catalog metadata');
      }
    }
    if (entry.journal !== undefined) validateCatalogJournal(entry.journal);
    if (ids.has(entry.summary.threadId as string)) {
      throw new RuntimeStorageError('invalid_thread_catalog', 'Duplicate thread catalog entry');
    }
    ids.add(entry.summary.threadId as string);
  }
}

function validateCatalogJournal(input: unknown): void {
  if (!isRecord(input)) throw new RuntimeStorageError('invalid_thread_catalog', 'Invalid journal index');
  if (input.version !== 3) {
    throw new RuntimeStorageError(
      'unsupported_journal_version',
      `Catalog uses unsupported journal version ${String(input.version)}; clear the workspace journal`,
    );
  }
  assertExactKeys(input, [
    'version', 'size', 'snapshotSize', 'highWaterSeq', 'replayStartSeq', 'recoveryRequired',
  ], ['dev', 'ino', 'mtimeMs', 'ctimeMs']);
  if (!isNonNegativeSafeInteger(input.size)
    || !isNonNegativeSafeInteger(input.snapshotSize)
    || !isNonNegativeSafeInteger(input.highWaterSeq)
    || !isPositiveSafeInteger(input.replayStartSeq)
    || input.replayStartSeq > input.highWaterSeq + 1
    || typeof input.recoveryRequired !== 'boolean'
    || (input.dev !== undefined && !isNonNegativeSafeInteger(input.dev))
    || (input.ino !== undefined && !isNonNegativeSafeInteger(input.ino))
    || (input.mtimeMs !== undefined && !isNonNegativeFiniteNumber(input.mtimeMs))
    || (input.ctimeMs !== undefined && !isNonNegativeFiniteNumber(input.ctimeMs))) {
    throw new RuntimeStorageError('invalid_thread_catalog', 'Invalid journal index');
  }
}

function validateSupervisorOpRecord(input: unknown, workspaceId: WorkspaceId): void {
  const value = snapshotUnknown(input, 'invalid_supervisor_op');
  if (isRecord(value)) {
    assertExactKeys(value, ['opId', 'op', 'payloadHash', 'state'], [
      'targetThreadIds', 'resolvedTargets', 'retryPromptOpId',
      'retryPrompt', 'retryRejectionReason', 'receipt',
    ]);
  }
  if (!isRecord(value) || !isExternalOpId(value.opId) || !isRecord(value.op)
    || value.op.opId !== value.opId || value.op.workspaceId !== workspaceId
    || typeof value.payloadHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.payloadHash)
    || (value.state !== 'reserved' && value.state !== 'final')
    || (value.state === 'final' && !isRecord(value.receipt))) {
    throw new RuntimeStorageError('invalid_supervisor_op', 'Invalid Supervisor operation ledger record');
  }
  const op = canonicalizeRuntimeOp(value.op);
  if (runtimeOpPayloadHash(op) !== value.payloadHash) {
    throw new RuntimeStorageError('invalid_supervisor_op', 'Supervisor operation payload hash mismatch');
  }
  if (value.state === 'reserved' && value.receipt !== undefined) {
    throw new RuntimeStorageError('invalid_supervisor_op', 'Reserved Supervisor op carries a final receipt');
  }
  if (value.targetThreadIds !== undefined) {
    if (!Array.isArray(value.targetThreadIds) || !value.targetThreadIds.every(isThreadId)
      || new Set(value.targetThreadIds).size !== value.targetThreadIds.length) {
      throw new RuntimeStorageError('invalid_supervisor_op', 'Invalid targetThreadIds');
    }
  }
  if (value.resolvedTargets !== undefined) {
    if (!Array.isArray(value.resolvedTargets)) {
      throw new RuntimeStorageError('invalid_supervisor_op', 'Invalid resolvedTargets');
    }
    const ids = new Set<string>();
    for (const item of value.resolvedTargets) {
      if (!isRecord(item)) throw new RuntimeStorageError('invalid_supervisor_op', 'Invalid resolved target');
      assertExactKeys(item, ['threadId', 'target', 'derivedOpId']);
      if (!isThreadId(item.threadId) || !isResolvedAbortTarget(item.target)
        || !isDerivedOpId(item.derivedOpId) || ids.has(item.threadId)) {
        throw new RuntimeStorageError('invalid_supervisor_op', 'Invalid resolved target');
      }
      ids.add(item.threadId);
    }
    if (value.targetThreadIds === undefined
      || canonicalJson([...ids]) !== canonicalJson(value.targetThreadIds)) {
      throw new RuntimeStorageError('invalid_supervisor_op', 'Resolved targets differ from frozen target ids');
    }
  }
  if (value.retryPromptOpId !== undefined && !isExternalOpId(value.retryPromptOpId)) {
    throw new RuntimeStorageError('invalid_supervisor_op', 'Invalid retry prompt operation id');
  }
  if (value.retryPrompt !== undefined) {
    if (!isRecord(value.retryPrompt)) {
      throw new RuntimeStorageError('invalid_supervisor_op', 'Invalid frozen retry prompt');
    }
    assertExactKeys(value.retryPrompt, ['messageId', 'turnId', 'text', 'digest']);
    if (!isNonEmptyWellFormedString(value.retryPrompt.messageId)
      || !isTurnId(value.retryPrompt.turnId)
      || typeof value.retryPrompt.text !== 'string'
      || value.retryPrompt.text.trim() === ''
      || !isWellFormedUnicode(value.retryPrompt.text)
      || typeof value.retryPrompt.digest !== 'string'
      || !/^[0-9a-f]{64}$/.test(value.retryPrompt.digest)
      || sha256Hex(value.retryPrompt.text) !== value.retryPrompt.digest) {
      throw new RuntimeStorageError('invalid_supervisor_op', 'Invalid frozen retry prompt');
    }
  }
  if (value.retryRejectionReason !== undefined
    && value.retryRejectionReason !== 'source_thread_not_found'
    && value.retryRejectionReason !== 'source_thread_busy'
    && value.retryRejectionReason !== 'retry_turn_not_found'
    && value.retryRejectionReason !== 'retry_requires_text_prompt') {
    throw new RuntimeStorageError('invalid_supervisor_op', 'Invalid frozen retry rejection');
  }
  if (value.receipt !== undefined && !isReceiptForOperation(
    value.receipt,
    op,
    value.targetThreadIds as readonly ThreadId[] | undefined,
  )) {
    throw new RuntimeStorageError('invalid_supervisor_op', 'Invalid Supervisor operation receipt');
  }
  if (op.type === 'cancel_scope') {
    if (value.targetThreadIds === undefined || value.resolvedTargets === undefined) {
      throw new RuntimeStorageError('invalid_supervisor_op', 'Cancel scope has no frozen target set');
    }
  } else if (value.targetThreadIds !== undefined || value.resolvedTargets !== undefined) {
    throw new RuntimeStorageError('invalid_supervisor_op', 'Non-scope operation carries scope targets');
  }
  const hasRetryFreeze = (value.retryPrompt !== undefined) !== (value.retryRejectionReason !== undefined);
  if (op.type === 'conversation_retry') {
    if (value.retryPromptOpId === undefined || !hasRetryFreeze) {
      throw new RuntimeStorageError('invalid_supervisor_op', 'Retry prompt freeze is incomplete');
    }
    if (value.retryPromptOpId === op.opId) {
      throw new RuntimeStorageError('invalid_supervisor_op', 'Retry prompt operation reuses the root id');
    }
    if (value.retryPrompt !== undefined && op.turnId !== undefined
      && value.retryPrompt.turnId !== op.turnId) {
      throw new RuntimeStorageError('invalid_supervisor_op', 'Frozen retry turn differs from the op');
    }
  } else if (value.retryPromptOpId !== undefined
    || value.retryPrompt !== undefined
    || value.retryRejectionReason !== undefined) {
    throw new RuntimeStorageError('invalid_supervisor_op', 'Retry fields are on the wrong op type');
  }
}

function validateDerivedClaim(input: unknown, workspaceId: WorkspaceId): void {
  const value = snapshotUnknown(input, 'invalid_derived_claim');
  if (isRecord(value)) assertExactKeys(value, ['opId', 'purpose', 'workspaceId', 'parts']);
  if (!isRecord(value) || !isDerivedOpId(value.opId) || value.workspaceId !== workspaceId
    || (value.purpose !== 'cancel_target' && value.purpose !== 'control_recovery'
      && value.purpose !== 'thread_result' && value.purpose !== 'thread_close_on_runtime_close')
    || !Array.isArray(value.parts)
    || !value.parts.every((part) => typeof part === 'string' && isWellFormedUnicode(part))) {
    throw new RuntimeStorageError('invalid_derived_claim', 'Invalid derived operation identity claim');
  }
}

function readThreadLock(file: string): ThreadLockRecord {
  const value = readJsonUnknown(file, 'invalid_thread_lock');
  if (isRecord(value)) {
    assertExactKeys(value, [
      'version', 'workspaceId', 'threadId', 'processEpoch', 'fencingToken', 'ownerNonce',
    ]);
  }
  if (!isRecord(value) || value.version !== 1 || !isWorkspaceIdValue(value.workspaceId)
    || !isThreadId(value.threadId) || typeof value.processEpoch !== 'string'
    || typeof value.fencingToken !== 'string' || typeof value.ownerNonce !== 'string') {
    throw new RuntimeStorageError('invalid_thread_lock', `Invalid thread lock: ${file}`);
  }
  return value as unknown as ThreadLockRecord;
}

function readJournalHeader(file: string): ThreadMetaRecord {
  assertRegularFileNoSymlink(file);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    const header = readJournalHeaderLine(fd, stat.size, file);
    const parsed = parseJournalHeaderValue(header.text, file);
    if (!isRecord(parsed) || parsed.type !== 'thread_meta' || !isThreadId(parsed.threadId)
      || !isWorkspaceIdValue(parsed.workspaceId)) {
      throw new Error('invalid meta header');
    }
    return validateThreadMeta(parsed, parsed.workspaceId, parsed.threadId);
  } catch (error) {
    throw storageFailure('invalid_thread_journal', file, error);
  } finally {
    closeSync(fd);
  }
}

function readJournalInitialRecords(
  file: string,
  workspaceId: WorkspaceId,
  threadId: ThreadId,
  count: number,
): readonly RuntimeJournalRecord[] {
  assertRegularFileNoSymlink(file);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const boundary = boundaryFromStat(fstatSync(fd));
    const records: RuntimeJournalRecord[] = [];
    let offset = 0;
    for (let index = 0; index < count; index++) {
      const line = readJournalLine(fd, boundary.size, file, offset);
      const parsed = parseJournalHeaderValue(line.text, file);
      const record = index === 0
        ? validateThreadMeta(parsed, workspaceId, threadId)
        : validateJournalRecord(parsed, workspaceId, threadId, false);
      records.push(record);
      offset = line.nextOffset;
    }
    assertJournalFileBoundary(file, fd, boundary);
    return snapshot(records);
  } catch (error) {
    throw storageFailure('invalid_thread_journal', file, error);
  } finally {
    closeSync(fd);
  }
}

function readJournalHeaderLine(
  fd: number,
  fileSize: number,
  file: string,
): JournalHeaderLine {
  return readJournalLine(fd, fileSize, file, 0);
}

function readJournalLine(
  fd: number,
  fileSize: number,
  file: string,
  startOffset: number,
): JournalHeaderLine {
  const chunks: Buffer[] = [];
  let offset = startOffset;
  let length = 0;
  while (offset < fileSize) {
    const chunk = Buffer.allocUnsafe(Math.min(4096, fileSize - offset));
    const bytesRead = readSync(fd, chunk, 0, chunk.length, offset);
    if (bytesRead === 0) break;
    const bytes = chunk.subarray(0, bytesRead);
    const newline = bytes.indexOf(0x0a);
    if (newline >= 0) {
      chunks.push(bytes.subarray(0, newline));
      length += newline;
      return {
        text: Buffer.concat(chunks, length).toString('utf8'),
        nextOffset: offset + newline + 1,
      };
    }
    chunks.push(bytes);
    length += bytes.length;
    offset += bytes.length;
  }
  throw new RuntimeStorageError('invalid_thread_journal', `Journal record line is incomplete: ${file}`);
}

function parseJournalHeaderValue(
  text: string,
  file: string,
): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw storageFailure('invalid_thread_journal', file, error);
  }
}

function validateAgentMessage(input: unknown): AgentMessage {
  const value = snapshotUnknown(input, 'invalid_thread_journal');
  if (!isRecord(value) || (value.role !== 'user' && value.role !== 'assistant' && value.role !== 'tool_result')
    || !isWellFormedString(value.id) || !isFiniteNumber(value.timestamp) || !Array.isArray(value.content)) {
    throw new RuntimeStorageError('invalid_thread_journal', 'Invalid AgentMessage');
  }
  if (value.role === 'user') {
    assertExactKeys(value, ['role', 'id', 'timestamp', 'content'], ['source']);
    if (value.source !== undefined && value.source !== 'prompt' && value.source !== 'steering'
      && value.source !== 'follow_up' && value.source !== 'synthetic') {
      throw new RuntimeStorageError('invalid_thread_journal', 'Invalid user message source');
    }
  } else if (value.role === 'assistant') {
    assertExactKeys(value, [
      'role', 'id', 'timestamp', 'content', 'model', 'stopReason', 'usage',
    ], ['errorMessage', 'errorDetails']);
    if (!isModelRef(value.model) || !isUsage(value.usage) || !isStopReason(value.stopReason)
      || (value.errorMessage !== undefined && !isWellFormedString(value.errorMessage))
      || (value.errorDetails !== undefined && !isProviderErrorDetails(value.errorDetails))) {
      throw new RuntimeStorageError('invalid_thread_journal', 'Invalid assistant message');
    }
  } else {
    assertExactKeys(value, [
      'role', 'id', 'timestamp', 'toolCallId', 'toolName', 'content', 'isError',
    ], ['details']);
    if (!isWellFormedString(value.toolCallId) || !isWellFormedString(value.toolName)
      || typeof value.isError !== 'boolean') {
      throw new RuntimeStorageError('invalid_thread_journal', 'Invalid tool result message');
    }
  }
  for (const part of value.content) {
    if (!isMessagePart(part, value.role)) {
      throw new RuntimeStorageError('invalid_thread_journal', 'Invalid message content');
    }
  }
  return value as unknown as AgentMessage;
}

function foldCatalogSummary(
  initial: ThreadCatalogRecord['summary'],
  records: readonly RuntimeJournalRecord[],
): ThreadCatalogRecord['summary'] {
  let summary = initial;
  for (const record of records) {
    if (record.type !== 'commit') continue;
    for (const envelope of record.envelopes) {
      if (envelope.event.type === 'thread_created'
        || envelope.event.type === 'thread_resumed'
        || envelope.event.type === 'thread_updated') {
        summary = envelope.event.thread;
      } else if (envelope.event.type === 'thread_closed') {
        summary = omitActiveRun(summary, 'closed');
      }
    }
    for (const mutation of record.mutations ?? []) {
      if (mutation.type === 'run_reserved' || mutation.type === 'run_started') {
        summary = {
          ...summary,
          state: mutation.type === 'run_reserved' ? 'starting' : 'running',
          activeRunId: mutation.runId,
        };
      } else if (mutation.type === 'run_terminal' && summary.activeRunId === mutation.runId) {
        summary = omitActiveRun(summary, 'idle');
      }
    }
  }
  return snapshot(summary);
}

function summaryFromMeta(meta: ThreadMetaRecord): ThreadCatalogRecord['summary'] {
  return snapshot({
    threadId: meta.threadId,
    ...(meta.parentThreadId !== undefined && { parentThreadId: meta.parentThreadId }),
    createdAt: meta.createdAt,
    state: 'idle' as const,
  });
}

function previewFromFold(state: Readonly<FoldedThreadJournal>): string | undefined {
  for (let index = state.checkpoint.frontend.transcript.length - 1; index >= 0; index--) {
    const message = state.checkpoint.frontend.transcript[index];
    const text = message?.content.flatMap((part) => part.type === 'text' ? [part.text] : [])
      .join(' ').replace(/\s+/gu, ' ').trim();
    if (text !== undefined && text !== '') return text.length > 160 ? `${text.slice(0, 159)}…` : text;
  }
  return undefined;
}

async function acquireKernelAuthority(
  port: number,
  workspaceId: WorkspaceId,
): Promise<Bun.TCPSocketListener> {
  try {
    const listener = Bun.listen({
      hostname: '127.0.0.1',
      port,
      exclusive: true,
      socket: {
        open(socket): void { socket.end(); },
        data(socket): void { socket.end(); },
        error(socket): void { socket.close(); },
      },
    });
    listener.unref();
    return listener;
  } catch (error) {
    // Binding failures are fail-closed. No disk owner/fence record has been installed yet.
    void error;
    throw new WorkspaceInUseError(workspaceId);
  }
}

function closeKernelAuthority(listener: Bun.TCPSocketListener): void {
  listener.stop(true);
}

function workspaceAuthorityPort(workspaceId: WorkspaceId): number {
  const prefix = Number.parseInt(sha256Hex(`workspace-authority-v1\0${workspaceId}`).slice(0, 8), 16);
  return 30_000 + (prefix % 20_000);
}

function writeJsonExclusive(file: string, value: unknown): void {
  assertParentSafe(file);
  const fd = openRegularExclusive(file);
  try {
    writeFileSync(fd, `${canonicalJson(value)}\n`, 'utf8');
    fsyncSync(fd);
  } catch (error) {
    try { unlinkSync(file); } catch { /* preserve original failure */ }
    throw error;
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(path.dirname(file));
}

function writeJsonLinesExclusive(file: string, values: readonly unknown[]): void {
  assertParentSafe(file);
  const fd = openRegularExclusive(file);
  try {
    writeFileSync(fd, values.map((value) => `${canonicalJson(value)}\n`).join(''), 'utf8');
    fsyncSync(fd);
  } catch (error) {
    try { unlinkSync(file); } catch { /* preserve original failure */ }
    throw error;
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(path.dirname(file));
}

function writeJsonAtomic(file: string, value: unknown): void {
  assertParentSafe(file);
  const temporary = safeChild(path.dirname(file), `.tmp-${path.basename(file)}-${crypto.randomUUID()}`);
  let fd: number | undefined;
  try {
    fd = openRegularExclusive(temporary);
    writeFileSync(fd, `${canonicalJson(value)}\n`, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    assertNotSymlinkIfExists(file);
    renameSync(temporary, file);
    fsyncDirectory(path.dirname(file));
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch { /* temporary may not exist */ }
    throw error;
  }
}

class PolicyGrantDefinitelyNotAppliedError extends Error {
  constructor(readonly originalCause: unknown) {
    super(formatStorageCause(originalCause));
    this.name = 'PolicyGrantDefinitelyNotAppliedError';
  }
}

function writePolicyGrantStoreAtomic(
  file: string,
  value: PolicyGrantStoreFile,
  assertFence: () => void,
): void {
  let temporary: string | undefined;
  let fd: number | undefined;
  let renamed = false;
  try {
    assertParentSafe(file);
    temporary = safeChild(path.dirname(file), `.tmp-${path.basename(file)}-${crypto.randomUUID()}`);
    fd = openRegularExclusive(temporary);
    writeFileSync(fd, `${canonicalJson(value)}\n`, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    assertNotSymlinkIfExists(file);
    // No await or fallible storage operation may separate this captured-fence comparison from
    // the atomic rename that linearizes both the receipt and grant payload.
    assertFence();
    renameSync(temporary, file);
    renamed = true;
    fsyncDirectory(path.dirname(file));
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* preserve the transaction failure */ }
    }
    if (temporary !== undefined) {
      try { unlinkSync(temporary); } catch { /* absent after rename or failed create */ }
    }
    if (!renamed) {
      if (error instanceof RuntimeStorageError && error.code === 'stale_fence') throw error;
      throw new PolicyGrantDefinitelyNotAppliedError(error);
    }
    // Once rename succeeds the receipt/grant may be visible even if directory fsync fails. The
    // caller must degrade on this unknown outcome rather than claim definitely-not-applied.
    throw error;
  }
}

function readJsonUnknown(file: string, code: string): unknown {
  assertRegularFileNoSymlink(file);
  try {
    return snapshotUnknown(JSON.parse(readFileSync(file, 'utf8')) as unknown, code);
  } catch (error) {
    if (error instanceof RuntimeStorageError) throw error;
    throw storageFailure(code, file, error);
  }
}

function snapshotUnknown(input: unknown, code: string): unknown {
  try {
    return strictJsonSnapshot(input);
  } catch (error) {
    throw storageFailure(code, 'strict-json', error);
  }
}

function unlinkIfExact(file: string, expected: unknown): void {
  if (!existsSync(file)) return;
  try {
    const current = readJsonUnknown(file, 'invalid_lock_record');
    if (canonicalJson(current) !== canonicalJson(expected)) return;
    unlinkSync(file);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function assertJournalFileBoundary(
  file: string,
  fd: number,
  expected: Readonly<JournalFileBoundary>,
): void {
  try {
    const current = journalBoundaryFromOpenFile(file, fd);
    if (!sameBoundary(current, expected)) {
      throw new RuntimeStorageError(
        'invalid_thread_journal',
        `Thread journal changed outside the active writer: ${file}`,
      );
    }
  } catch (error) {
    if (error instanceof RuntimeStorageError) throw error;
    throw storageFailure('invalid_thread_journal', file, error);
  }
}

function fsyncDirectory(directory: string): void {
  const fd = openSync(directory, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function openRegularExclusive(file: string): number {
  assertParentSafe(file);
  return openSync(file, 'wx', 0o600);
}

function ensureDirectoryTreeNoSymlink(directory: string): void {
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    fsyncDirectory(path.dirname(directory));
  }
  // Existing ancestors may be host aliases (for example macOS /var -> /private/var); the
  // caller-selected root itself and every storage-owned descendant must not be a symlink.
  assertDirectoryNoSymlink(directory);
}

function ensureDirectChildDirectory(parent: string, child: string): void {
  assertDirectoryNoSymlink(parent);
  const expectedParent = realpathSync(parent);
  if (!existsSync(child)) {
    mkdirSync(child, { mode: 0o700 });
    fsyncDirectory(parent);
  }
  assertDirectoryNoSymlink(child);
  if (path.dirname(realpathSync(child)) !== expectedParent) {
    throw new RuntimeStorageError('unsafe_storage_key', `Directory escapes storage root: ${child}`);
  }
}

function assertParentSafe(file: string): void {
  const parent = path.dirname(file);
  assertDirectoryNoSymlink(parent);
  assertNotSymlinkIfExists(file);
}

function assertDirectoryNoSymlink(directory: string): void {
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new RuntimeStorageError('unsafe_storage_key', `Expected non-symlink directory: ${directory}`);
  }
}

function assertRegularFileNoSymlink(file: string): void {
  const stat = lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new RuntimeStorageError('unsafe_storage_key', `Expected non-symlink file: ${file}`);
  }
}

function assertNotSymlinkIfExists(file: string): void {
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) {
    throw new RuntimeStorageError('unsafe_storage_key', `Refusing symlink storage file: ${file}`);
  }
}

function safeChild(root: string, name: string): string {
  if (!isWellFormedUnicode(name) || name.includes('\u0000') || path.isAbsolute(name)
    || name === '..' || name.includes(path.sep)) {
    throw new RuntimeStorageError('unsafe_storage_key', 'Storage key is not a direct child name');
  }
  const candidate = path.join(root, name);
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new RuntimeStorageError('unsafe_storage_key', 'Storage key escapes its root');
  }
  return candidate;
}

function assertSafeAbsolutePath(value: string, field: string): void {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\u0000')
    || !isWellFormedUnicode(value)) {
    throw new TypeError(`${field} must be an absolute, well-formed path without NUL`);
  }
}

function assertExecutableCwd(value: string): void {
  if (!isExecutableCwd(value)) {
    throw new RuntimeStorageError('invalid_workspace_cwd', 'Workspace cwd is not executable on this host');
  }
}

function isExecutableCwd(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && path.isAbsolute(value)
    && !value.includes('\u0000') && isWellFormedUnicode(value);
}

function assertWellFormedNonEmpty(value: string, field: string): void {
  if (typeof value !== 'string' || value.length === 0 || !isWellFormedUnicode(value)) {
    throw new RuntimeStorageError('invalid_storage_identity', `${field} is invalid`);
  }
}

function isWorkspaceIdValue(value: unknown): value is WorkspaceId {
  try { assertWorkspaceId(value); return true; } catch { return false; }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isModelRef(value: unknown): value is ModelRef {
  if (!isRecord(value)) return false;
  try {
    assertExactKeys(value, ['provider', 'api', 'model']);
    return isWellFormedString(value.provider) && isWellFormedString(value.api)
      && isWellFormedString(value.model);
  } catch {
    return false;
  }
}

function isPermissionCeiling(value: unknown): boolean {
  if (!isRecord(value)) return false;
  try {
    assertExactKeys(value, ['revision', 'constraints'], ['inheritedFrom']);
    if (!isNonEmptyWellFormedString(value.revision) || !Array.isArray(value.constraints)
      || !value.constraints.every(isRecord)) return false;
    if (value.inheritedFrom !== undefined) {
      if (!isRecord(value.inheritedFrom)) return false;
      assertExactKeys(value.inheritedFrom, ['parentThreadId', 'parentCeilingRevision'], ['parentRunId']);
      if (!isThreadId(value.inheritedFrom.parentThreadId)
        || (value.inheritedFrom.parentRunId !== undefined && !isRunId(value.inheritedFrom.parentRunId))
        || !isNonEmptyWellFormedString(value.inheritedFrom.parentCeilingRevision)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function isUsage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  try {
    assertExactKeys(value, ['input', 'output'], [
      'cacheRead', 'cacheWrite', 'reasoning', 'costUSD',
    ]);
    return isNonNegativeFiniteNumber(value.input) && isNonNegativeFiniteNumber(value.output)
      && (value.cacheRead === undefined || isNonNegativeFiniteNumber(value.cacheRead))
      && (value.cacheWrite === undefined || isNonNegativeFiniteNumber(value.cacheWrite))
      && (value.reasoning === undefined || isNonNegativeFiniteNumber(value.reasoning))
      && (value.costUSD === undefined || isNonNegativeFiniteNumber(value.costUSD));
  } catch {
    return false;
  }
}

function isThreadUsage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  try {
    assertExactKeys(value, ['cumulative', 'turns', 'contextTokens'], ['lastTurn']);
    return isUsage(value.cumulative) && Number.isSafeInteger(value.turns)
      && typeof value.turns === 'number' && value.turns >= 0
      && isNonNegativeFiniteNumber(value.contextTokens)
      && (value.lastTurn === undefined || isUsage(value.lastTurn));
  } catch {
    return false;
  }
}

function isThreadSummary(value: unknown): value is ThreadCatalogRecord['summary'] {
  const states = new Set(['idle', 'starting', 'running', 'retrying', 'compacting', 'suspended', 'closing', 'closed']);
  if (!isRecord(value)) return false;
  try {
    assertExactKeys(value, ['threadId', 'createdAt', 'state'], [
      'parentThreadId', 'title', 'archivedAt', 'updatedAt', 'activeRunId',
      'pendingRunIds', 'suspendedWork',
    ]);
    if (!isThreadId(value.threadId) || !isFiniteNumber(value.createdAt)
      || typeof value.state !== 'string' || !states.has(value.state)
      || (value.parentThreadId !== undefined && !isThreadId(value.parentThreadId))
      || (value.title !== undefined && !isWellFormedString(value.title))
      || (value.archivedAt !== undefined && !isFiniteNumber(value.archivedAt))
      || (value.updatedAt !== undefined && !isFiniteNumber(value.updatedAt))
      || (value.activeRunId !== undefined && !isRunId(value.activeRunId))) return false;
    if (value.pendingRunIds !== undefined && (!Array.isArray(value.pendingRunIds)
      || !value.pendingRunIds.every(isRunId)
      || new Set(value.pendingRunIds).size !== value.pendingRunIds.length)) return false;
    if (value.suspendedWork !== undefined && (!Array.isArray(value.suspendedWork)
      || !value.suspendedWork.every(isSuspendedWorkItem))) return false;
    return true;
  } catch {
    return false;
  }
}

function isSuspendedWorkItem(value: unknown): boolean {
  if (!isRecord(value)) return false;
  try {
    if (value.kind === 'reserved_op') {
      assertExactKeys(value, ['kind', 'ownerOpId', 'runId']);
      return isOpId(value.ownerOpId) && isRunId(value.runId);
    }
    if (value.kind === 'interrupted') {
      assertExactKeys(value, ['kind', 'ownerOpId', 'terminalRunId'], ['inputOwnerOpId']);
      return isOpId(value.ownerOpId) && isRunId(value.terminalRunId)
        && (value.inputOwnerOpId === undefined || isOpId(value.inputOwnerOpId));
    }
  } catch {
    return false;
  }
  return false;
}

function isMessagePart(value: unknown, role: AgentMessage['role']): boolean {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  try {
    if (value.type === 'text') {
      assertExactKeys(value, ['type', 'text'], role === 'assistant' ? ['phase'] : []);
      return isWellFormedString(value.text)
        && (role !== 'assistant'
          || value.phase === undefined
          || value.phase === 'commentary'
          || value.phase === 'final_answer');
    }
    if (value.type === 'image' && role !== 'assistant') {
      assertExactKeys(value, ['type', 'data', 'mimeType']);
      return isWellFormedString(value.data) && isWellFormedString(value.mimeType);
    }
    if (value.type === 'reasoning' && role === 'assistant') {
      assertExactKeys(value, ['type', 'text'], ['kind', 'signature']);
      return isWellFormedString(value.text)
        && (value.kind === undefined || value.kind === 'summary' || value.kind === 'content')
        && (value.signature === undefined || isWellFormedString(value.signature));
    }
    if (value.type === 'tool_call' && role === 'assistant') {
      assertExactKeys(value, ['type', 'id', 'name', 'arguments'], ['rawArguments']);
      return isWellFormedString(value.id) && isWellFormedString(value.name)
        && isRecord(value.arguments)
        && (value.rawArguments === undefined || isWellFormedString(value.rawArguments));
    }
  } catch {
    return false;
  }
  return false;
}

function isProviderErrorDetails(value: unknown): boolean {
  if (!isRecord(value)) return false;
  try {
    assertExactKeys(value, ['kind', 'retryable'], [
      'status', 'code', 'requestId', 'retryAfterMs',
    ]);
    return new Set(['network', 'http', 'overflow', 'auth', 'rate_limit', 'aborted', 'unknown']).has(String(value.kind))
      && typeof value.retryable === 'boolean'
      && (value.status === undefined || isFiniteNumber(value.status))
      && (value.code === undefined || isWellFormedString(value.code))
      && (value.requestId === undefined || isWellFormedString(value.requestId))
      && (value.retryAfterMs === undefined || isNonNegativeFiniteNumber(value.retryAfterMs));
  } catch {
    return false;
  }
}

function isStopReason(value: unknown): boolean {
  return value === 'stop' || value === 'length' || value === 'tool_calls'
    || value === 'content_filter' || value === 'error' || value === 'aborted';
}

function validateMailboxOp(
  value: Readonly<Record<string, unknown>>,
  workspaceId: WorkspaceId,
  threadId: ThreadId,
): boolean {
  try {
    if (value.workspaceId !== workspaceId || value.threadId !== threadId || typeof value.type !== 'string') {
      return false;
    }
    if (isExternalOpId(value.opId)) {
      const canonical = canonicalizeRuntimeOp(value);
      return canonical.type !== 'thread_create' && canonical.type !== 'thread_resume'
        && canonical.type !== 'conversation_fork' && canonical.type !== 'conversation_retry'
        && canonical.type !== 'cancel_scope' && canonicalJson(canonical) === canonicalJson(value);
    }
    if (!isDerivedOpId(value.opId)) return false;
    if (value.type === 'abort') {
      assertExactKeys(value, [
        'type', 'opId', 'workspaceId', 'threadId', 'parentOpId', 'resolvedTarget',
      ]);
      return isExternalOpId(value.parentOpId) && isResolvedAbortTarget(value.resolvedTarget);
    }
    if (value.type === 'thread_close') {
      assertExactKeys(value, ['type', 'opId', 'workspaceId', 'threadId'], ['parentOpId']);
      return value.parentOpId === undefined || isExternalOpId(value.parentOpId);
    }
    return false;
  } catch {
    return false;
  }
}

function isResolvedAbortTarget(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  try {
    if (value.kind === 'run') {
      assertExactKeys(value, ['kind', 'runId']);
      return isRunId(value.runId);
    }
    if (value.kind === 'suspended') {
      assertExactKeys(value, ['kind', 'ownerOpId', 'terminalRunId'], ['inputOwnerOpId']);
      return isOpId(value.ownerOpId) && isRunId(value.terminalRunId)
        && (value.inputOwnerOpId === undefined || isOpId(value.inputOwnerOpId));
    }
    if (value.kind === 'no_current_activity') {
      assertExactKeys(value, ['kind']);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function isMailboxOpType(value: string): boolean {
  return new Set([
    'prompt', 'continue', 'steer', 'follow_up', 'set_model', 'control_response',
    'thread_rename', 'thread_archive', 'compact', 'thread_close',
  ]).has(value);
}

function isOutcome(value: unknown): boolean {
  return value === 'applied' || value === 'no_op' || value === 'interrupted' || value === 'superseded';
}

function isRunTerminalStatus(value: unknown): boolean {
  return value === 'completed' || value === 'aborted' || value === 'error' || value === 'interrupted';
}

function isControlDecision(value: unknown): boolean {
  return value === 'allow_once' || value === 'allow_always' || value === 'deny'
    || value === 'confirm';
}

function isWellFormedString(value: unknown): value is string {
  return typeof value === 'string' && isWellFormedUnicode(value);
}

function isNonEmptyWellFormedString(value: unknown): value is string {
  return isWellFormedString(value) && value.length > 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => isWellFormedString(item));
}

function isCanonicalScopeArray(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.every((item) => isWellFormedString(item) && item.length > 0)
    && value.every((scope, index) => index === 0
      || compareUtf8(value[index - 1] as string, scope) < 0);
}

function validateCompactionCheckpoint(value: unknown): void {
  if (!isRecord(value)) throw new RuntimeStorageError('invalid_thread_mutation', 'Invalid compaction checkpoint');
  assertExactKeys(value, ['id', 'timestamp', 'tailStartId', 'summary'], ['contextTokensBefore']);
  if (!isWellFormedString(value.id) || !isFiniteNumber(value.timestamp)
    || !isWellFormedString(value.tailStartId) || !isWellFormedString(value.summary)
    || (value.contextTokensBefore !== undefined && !isFiniteNumber(value.contextTokensBefore))) {
    throw new RuntimeStorageError('invalid_thread_mutation', 'Invalid compaction checkpoint');
  }
}

function isOpReceipt(value: unknown, opId: ExternalOpId): boolean {
  if (!isRecord(value) || value.opId !== opId || typeof value.accepted !== 'boolean'
    || typeof value.duplicate !== 'boolean') return false;
  try {
    if (value.accepted) {
      assertExactKeys(value, ['accepted', 'opId', 'duplicate'], [
        'threadId', 'runId', 'targetThreadIds',
      ]);
      return (value.threadId === undefined || isThreadId(value.threadId))
        && (value.runId === undefined || isRunId(value.runId))
        && (value.targetThreadIds === undefined
          || (Array.isArray(value.targetThreadIds) && value.targetThreadIds.every(isThreadId)));
    }
    assertExactKeys(value, ['accepted', 'opId', 'duplicate', 'reason'], ['threadId']);
    return isWellFormedString(value.reason)
      && (value.threadId === undefined || isThreadId(value.threadId));
  } catch {
    return false;
  }
}

function isReceiptForOperation(
  value: unknown,
  op: Readonly<import('../protocol/index.js').RuntimeOp>,
  frozenTargets: readonly ThreadId[] | undefined,
): boolean {
  if (!isOpReceipt(value, op.opId) || !isRecord(value) || value.duplicate !== false) return false;
  if (!value.accepted) {
    return !('threadId' in op) || value.threadId === undefined || value.threadId === op.threadId;
  }
  if (op.type === 'cancel_scope') {
    return value.threadId === undefined && value.runId === undefined
      && frozenTargets !== undefined
      && canonicalJson(value.targetThreadIds) === canonicalJson(frozenTargets);
  }
  if (value.threadId !== op.threadId || value.targetThreadIds !== undefined) return false;
  if (op.type === 'prompt' || op.type === 'continue' || op.type === 'compact'
    || op.type === 'conversation_retry') return isRunId(value.runId);
  return value.runId === undefined;
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key)) || keys.some((key) => !allowed.has(key))) {
    throw new RuntimeStorageError('invalid_storage_schema', 'Persisted record has missing or unknown fields');
  }
}

function derivedTuple(claim: DerivedOpIdentityClaim): string {
  return canonicalJson([claim.purpose, claim.workspaceId, claim.parts]);
}

function readPolicyGrantStore(file: string, workspaceId: WorkspaceId): PolicyGrantStoreFile {
  const value = readJsonUnknown(file, 'invalid_policy_grant_store');
  if (isRecord(value)) assertExactKeys(value, ['version', 'workspaceId', 'grants']);
  if (!isRecord(value)
    || value.version !== 1
    || value.workspaceId !== workspaceId
    || !isWorkspaceIdValue(value.workspaceId)
    || !Array.isArray(value.grants)) {
    throw new RuntimeStorageError('invalid_policy_grant_store', 'Invalid canonical policy grant store');
  }
  const grantIds = new Set<string>();
  const grants = value.grants.map((grant) => {
    const normalized = validatePolicyGrant(
      grant,
      workspaceId,
      'invalid_policy_grant_store',
    );
    if (grantIds.has(normalized.grantId)) {
      throw new RuntimeStorageError('invalid_policy_grant_store', 'Duplicate policy grant receipt');
    }
    grantIds.add(normalized.grantId);
    return normalized;
  });
  return snapshot({ version: 1, workspaceId, grants });
}

function validatePolicyGrant(
  input: unknown,
  workspaceId: WorkspaceId,
  code = 'invalid_policy_grant',
): Readonly<PolicyGrant> {
  let value: unknown;
  try {
    value = strictJsonSnapshot(input);
  } catch (error) {
    throw invalidPolicyGrant(code, error);
  }
  if (!isRecord(value)) throw invalidPolicyGrant(code);
  assertExactPolicyGrantKeys(value, [
    'grantId',
    'workspaceId',
    'capabilityId',
    'capabilityVersion',
    'registrationDigest',
    'scope',
    'policyBasisRevision',
    'acceptedAt',
  ], code);
  if (!isExternalOpId(value.grantId)
    || !isWorkspaceIdValue(value.workspaceId)
    || value.workspaceId !== workspaceId
    || !isNonEmptyWellFormedString(value.capabilityId)
    || !isNonEmptyWellFormedString(value.capabilityVersion)
    || !isNonEmptyWellFormedString(value.registrationDigest)
    || !isNonEmptyWellFormedString(value.policyBasisRevision)
    || typeof value.acceptedAt !== 'number'
    || !Number.isSafeInteger(value.acceptedAt)
    || value.acceptedAt < 0) {
    throw invalidPolicyGrant(code);
  }
  validateCanonicalPolicyGrantScope(value.scope, code);
  return value as unknown as Readonly<PolicyGrant>;
}

function validateCanonicalPolicyGrantScope(input: unknown, code: string): void {
  if (!isRecord(input)) throw invalidPolicyGrant(code);
  assertExactPolicyGrantKeys(input, ['kind', 'resourcePatterns', 'attributes'], code);
  if (input.kind !== 'canonical_resources_v1'
    || !Array.isArray(input.resourcePatterns)
    || input.resourcePatterns.length === 0
    || !isRecord(input.attributes)) {
    throw invalidPolicyGrant(code);
  }
  const canonicalPatterns: string[] = [];
  for (const pattern of input.resourcePatterns) {
    if (!isRecord(pattern)) throw invalidPolicyGrant(code);
    assertExactPolicyGrantKeys(
      pattern,
      ['resourceType', 'access', 'matcher', 'pattern'],
      code,
    );
    if (!isPolicyGrantResourceType(pattern.resourceType)
      || !isPolicyGrantResourceAccess(pattern.access)
      || pattern.matcher !== 'canonical_target_exact_v1'
      || !isNonEmptyWellFormedString(pattern.pattern)) {
      throw invalidPolicyGrant(code);
    }
    canonicalPatterns.push(canonicalJson(pattern));
  }
  for (let index = 1; index < canonicalPatterns.length; index++) {
    if (compareUtf8(canonicalPatterns[index - 1]!, canonicalPatterns[index]!) >= 0) {
      throw invalidPolicyGrant(code);
    }
  }
}

function workspacePolicyGrantSnapshot(
  workspaceId: WorkspaceId,
  grants: Iterable<Readonly<PolicyGrant>>,
): Readonly<PolicyGrantSnapshot> {
  const copied = [...grants].map((grant) => snapshot(grant));
  return snapshot({
    workspaceId,
    revision: `policy-grants-v1-${canonicalJsonSha256({ workspaceId, grants: copied })}`,
    grants: copied,
  });
}

function policyGrantFenced(
  code: 'stale_fence' | 'wrong_workspace',
  message: string,
): Extract<PolicyGrantCommitResult, { kind: 'fenced' }> {
  return { kind: 'fenced', code, message };
}

function invalidPolicyGrant(code: string, error?: unknown): RuntimeStorageError {
  const detail = error instanceof Error ? `: ${error.message}` : '';
  return new RuntimeStorageError(code, `Invalid policy grant${detail}`);
}

function assertExactPolicyGrantKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  code: string,
): void {
  if (Object.keys(value).length !== required.length
    || required.some((key) => !Object.hasOwn(value, key))) {
    throw invalidPolicyGrant(code);
  }
}

function isPolicyGrantResourceType(value: unknown): boolean {
  return value === 'filesystem' || value === 'command' || value === 'network' || value === 'other';
}

function isPolicyGrantResourceAccess(value: unknown): boolean {
  return value === 'read' || value === 'write' || value === 'execute' || value === 'connect';
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

function formatStorageCause(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function omitActiveRun(
  summary: ThreadCatalogRecord['summary'],
  state: ThreadCatalogRecord['summary']['state'],
): ThreadCatalogRecord['summary'] {
  const { activeRunId, ...rest } = summary;
  void activeRunId;
  return { ...rest, state };
}

function storageFailure(code: string, subject: string, error: unknown): RuntimeStorageError {
  if (error instanceof RuntimeStorageError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new RuntimeStorageError(code, `${subject}: ${message}`);
}

function isAlreadyExists(error: unknown): boolean {
  return hasErrorCode(error, 'EEXIST');
}

function isMissing(error: unknown): boolean {
  return hasErrorCode(error, 'ENOENT');
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === 'object' && 'code' in error
    && (error as { readonly code?: unknown }).code === code;
}

function snapshot<T>(value: T): T {
  return strictJsonSnapshot(value) as T;
}
