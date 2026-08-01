// Explicit-root JSON/JSONL RuntimeStoragePort. The factory is pure; all filesystem and
// lease activity starts at an explicit query/open call. A kernel-held loopback listener is
// the workspace writer authority, while on-disk lock records are audit/fencing metadata only.

import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  assertThreadId,
  assertWorkspaceId,
  canonicalJson,
  canonicalizeRuntimeOp,
  isDerivedOpId,
  isExternalOpId,
  isOpId,
  isRunId,
  isThreadId,
  isTurnId,
  isWellFormedUnicode,
  legacyThreadId,
  legacyWorkspaceId,
  runtimeOpPayloadHash,
  sha256Hex,
  strictJsonSnapshot,
  validateEventEnvelope,
} from '../protocol/index.js';
import type {
  AgentMessage,
  ExternalOpId,
  ModelRef,
  ThreadId,
  ThreadUsage,
  WorkspaceId,
  WorkspaceWriteFence,
  WorkspaceWriteFenceValidation,
} from '../protocol/index.js';
import { RuntimeStorageError, WorkspaceBindingMismatchError, WorkspaceInUseError } from './errors.js';
import type {
  DerivedOpIdentityClaim,
  DerivedOpIdentityReservation,
  LegacyThreadImport,
  LegacyThreadSeedRecord,
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
} from './ports.js';

export interface FileRuntimeStorageOptions {
  readonly root: string;
  /** Existing append-only Session v1 directory. It is indexed read-only until explicit import. */
  readonly legacySessionDir?: string;
}

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

interface LegacyMetaRecord {
  readonly type: 'meta';
  readonly version: 1;
  readonly protocolVersion: string;
  readonly id: string;
  readonly createdAt: number;
  readonly cwd: string;
  readonly model: ModelRef;
}

interface LegacyCompactionRecord {
  readonly type: 'compaction';
  readonly id: string;
  readonly timestamp: number;
  readonly tailStartId: string;
  readonly summary: string;
  readonly contextTokensBefore?: number;
}

interface LegacySessionView {
  readonly meta: LegacyMetaRecord;
  readonly seed: LegacyThreadSeedRecord;
}

export function createFileRuntimeStorage(options: FileRuntimeStorageOptions): RuntimeStoragePort {
  assertSafeAbsolutePath(options.root, 'root');
  if (options.legacySessionDir !== undefined) {
    assertSafeAbsolutePath(options.legacySessionDir, 'legacySessionDir');
  }
  const root = options.root;
  const legacySessionDir = options.legacySessionDir;
  return {
    async listStoredThreads(): Promise<readonly StoredThreadLocator[]> {
      const canonical = readAllCanonicalLocators(root);
      const claimedLegacyKeys = new Set(
        canonical.flatMap((item) => item.catalog.driverRef?.kind === 'session-v1'
          ? [item.catalog.driverRef.key]
          : []),
      );
      const legacy = legacySessionDir === undefined
        ? []
        : readLegacyLocators(legacySessionDir, claimedLegacyKeys);
      return snapshot([...canonical, ...legacy]);
    },

    async openWorkspace(input): Promise<RuntimeWorkspaceStoragePort> {
      assertExecutableCwd(input.cwd);
      const workspaceId = input.workspaceId === undefined
        ? legacyWorkspaceId(input.cwd)
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
      return new FileWorkspacePort(workspaceDir, binding, legacySessionDir);
    },
  };
}

class FileWorkspacePort implements RuntimeWorkspaceStoragePort {
  readonly workspaceId: WorkspaceId;
  readonly recordedCwd: string;
  readonly #ledgerFile: string;
  readonly #catalogFile: string;
  readonly #threadsDir: string;
  readonly #lockFile: string;
  readonly #authorityPort: number;
  #lockServer: Bun.TCPSocketListener | undefined;
  #lockRecord: SupervisorLockRecord | undefined;
  #lease: SupervisorLease | undefined;
  #closed = false;

  constructor(
    readonly workspaceDir: string,
    binding: WorkspaceBindingFile,
    private readonly legacySessionDir: string | undefined,
  ) {
    this.workspaceId = binding.workspaceId;
    this.recordedCwd = binding.recordedCwd;
    this.#ledgerFile = safeChild(workspaceDir, 'ledger.json');
    this.#catalogFile = safeChild(workspaceDir, 'catalog.json');
    this.#threadsDir = safeChild(workspaceDir, 'threads');
    this.#lockFile = safeChild(workspaceDir, 'supervisor.lock');
    this.#authorityPort = workspaceAuthorityPort(this.workspaceId);
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
    const ledger = this.#readLedger();
    const canonical = this.#readCatalog().threads.map((entry) => {
      const ownerOpId = entry.format === 'runtime-v2'
        ? readJournalHeader(this.#threadFile(entry.summary.threadId)).createdByOpId
        : undefined;
      return overlayCatalogDriverRef(entry, ledger.ops, ownerOpId);
    });
    const claimed = new Set(canonical.flatMap((entry) => entry.driverRef?.kind === 'session-v1'
      ? [entry.driverRef.key]
      : []));
    const legacy = this.legacySessionDir === undefined
      ? []
      : readLegacyLocators(this.legacySessionDir, claimed)
        .filter((item) => item.ownerWorkspaceId === this.workspaceId)
        .map((item) => item.catalog);
    return snapshot([...canonical, ...legacy]);
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
      if (!isFinalDriverRefEnrichment(existing, record)
        && canonicalJson(existing) !== canonicalJson(record)) {
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
      readonly initialRecords?: readonly LegacyThreadSeedRecord[];
    },
  ): Promise<ThreadJournalPort> {
    this.#assertFence(lease);
    const threadId = assertThreadId(input.threadId);
    validateThreadMeta(input.meta, this.workspaceId, threadId);
    const initialRecords = [input.meta, ...(input.initialRecords ?? [])];
    for (const record of input.initialRecords ?? []) {
      validateJournalRecord(record, this.workspaceId, threadId, false);
    }
    const file = this.#threadFile(threadId);
    if (!existsSync(file)) {
      try {
        writeJsonLinesExclusive(file, initialRecords);
      } catch (error) {
        if (!isAlreadyExists(error)) throw storageFailure('thread_create_failed', file, error);
      }
    }
    const storedRecords = readJournalRecords(file, this.workspaceId, threadId, 'strict');
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
    this.#upsertCatalogFromRecords(file, storedRecords);
    return new FileJournalPort(this, threadId, file);
  }

  async openThreadJournal(threadIdInput: ThreadId): Promise<ThreadJournalPort | undefined> {
    this.#assertLeaseHeld();
    const threadId = assertThreadId(threadIdInput);
    const file = this.#threadFile(threadId);
    if (!existsSync(file)) return undefined;
    assertRegularFileNoSymlink(file);
    // Validate immutable ownership before handing out a writer-capable port.
    readJournalRecords(file, this.workspaceId, threadId, 'strict');
    return new FileJournalPort(this, threadId, file);
  }

  async importLegacyThread(
    lease: Readonly<SupervisorLease>,
    threadIdInput: ThreadId,
  ): Promise<LegacyThreadImport | undefined> {
    this.#assertFence(lease);
    const threadId = assertThreadId(threadIdInput);
    if (this.legacySessionDir === undefined) return undefined;
    for (const item of readLegacyLocators(this.legacySessionDir, new Set())) {
      if (item.threadId !== threadId || item.ownerWorkspaceId !== this.workspaceId) continue;
      if (item.executionEligibility.kind !== 'mutable' || item.sourceSessionId === undefined) return undefined;
      const file = safeLegacySessionFile(this.legacySessionDir, item.sourceSessionId);
      const view = readLegacySession(file);
      const driverRef = item.catalog.driverRef;
      if (driverRef === undefined) return undefined;
      return snapshot({ catalog: item.catalog, seed: view.seed, driverRef });
    }
    return undefined;
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

  updateCatalog(threadId: ThreadId, records: readonly RuntimeJournalRecord[]): void {
    this.#assertLeaseHeld();
    const catalog = this.#readCatalog();
    const index = catalog.threads.findIndex((entry) => entry.summary.threadId === threadId);
    const entry = catalog.threads[index];
    if (entry === undefined) {
      throw new RuntimeStorageError('catalog_thread_missing', `Thread ${threadId} is absent from catalog`);
    }
    const summary = foldCatalogSummary(entry.summary, records);
    const threads = [...catalog.threads];
    threads[index] = snapshot({ ...entry, summary });
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
    this.#readCatalog();
  }

  async #reconcileCatalog(): Promise<void> {
    this.#assertLeaseHeld();
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
      const journal = new FileJournalPort(this, header.threadId, file);
      // The temporary writer lease both proves single ownership and durably repairs a torn tail.
      await journal.acquireWriteLease(this.#lease as SupervisorLease);
      let records: readonly RuntimeJournalRecord[];
      try {
        records = await journal.load();
      } finally {
        await journal.releaseWriteLease();
      }
      const previous = existingById.get(header.threadId);
      const initial = previous?.summary ?? summaryFromMeta(header);
      reconciled.push(snapshot({
        summary: foldCatalogSummary(initial, records),
        format: 'runtime-v2',
        storageKey: entry.name,
        ...(header.driverRef !== undefined && { driverRef: header.driverRef }),
      }));
      existingById.delete(header.threadId);
    }
    const missingRuntime = [...existingById.values()].find((entry) => entry.format === 'runtime-v2');
    if (missingRuntime !== undefined) {
      throw new RuntimeStorageError(
        'catalog_orphan',
        `Catalog references missing thread journal ${missingRuntime.summary.threadId}`,
      );
    }
    // session-v1 entries are a read-only index and may legitimately have no canonical journal yet.
    reconciled.push(...[...existingById.values()].filter((entry) => entry.format === 'session-v1'));
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
    const previous = index < 0 ? undefined : catalog.threads[index];
    if (previous?.format === 'session-v1') {
      throw new RuntimeStorageError('thread_catalog_conflict', `Thread ${meta.threadId} is already a v1 entry`);
    }
    const entry = snapshot<ThreadCatalogRecord>({
      summary: foldCatalogSummary(previous?.summary ?? summaryFromMeta(meta), records),
      format: 'runtime-v2',
      storageKey: path.basename(file),
      ...(meta.driverRef !== undefined && { driverRef: meta.driverRef }),
    });
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

class FileJournalPort implements ThreadJournalPort {
  readonly #lockFile: string;
  #lockFd: number | undefined;
  #lockRecord: ThreadLockRecord | undefined;
  #lease: SupervisorLease | undefined;

  constructor(
    private readonly workspace: FileWorkspacePort,
    private readonly threadId: ThreadId,
    private readonly file: string,
  ) {
    this.#lockFile = `${file}.lock`;
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

  async load(): Promise<readonly RuntimeJournalRecord[]> {
    if (this.#lease === undefined) {
      this.workspace.assertLeaseHeld();
      return readJournalRecords(this.file, this.workspace.workspaceId, this.threadId, 'strict');
    }
    this.workspace.assertFence(this.#lease);
    return readJournalRecords(this.file, this.workspace.workspaceId, this.threadId, 'repair');
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
    const existing = readJournalRecords(
      this.file,
      this.workspace.workspaceId,
      this.threadId,
      'repair',
    );
    const validated = records.map((record) =>
      validateJournalRecord(record, this.workspace.workspaceId, this.threadId, false));
    validateJournalSequence([...existing, ...validated], this.workspace.workspaceId, this.threadId);
    const data = `${validated.map((record) => canonicalJson(record)).join('\n')}\n`;
    appendFileSync(this.file, data, { encoding: 'utf8', flag: 'a' });
    fsyncFile(this.file);
    this.workspace.updateCatalog(this.threadId, validated);
  }

  async releaseWriteLease(): Promise<void> {
    const record = this.#lockRecord;
    if (record !== undefined) unlinkIfExact(this.#lockFile, record);
    if (this.#lockFd !== undefined) closeSync(this.#lockFd);
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
    const catalog = existsSync(catalogFile)
      ? readCatalog(catalogFile)
      : { version: 1 as const, threads: [] };
    const ledgerFile = safeChild(workspaceDir, 'ledger.json');
    const ledgerOps = existsSync(ledgerFile)
      ? readLedger(ledgerFile, binding.workspaceId).ops
      : [];
    const byId = new Map(catalog.threads.map((item) => [item.summary.threadId, item]));
    const inventory: ThreadCatalogRecord[] = [];
    const threadsDir = safeChild(workspaceDir, 'threads');
    if (existsSync(threadsDir)) {
      assertDirectoryNoSymlink(threadsDir);
      for (const journalEntry of readdirSync(threadsDir, { withFileTypes: true })) {
        if (!journalEntry.name.startsWith('th-') || !journalEntry.name.endsWith('.jsonl')) continue;
        if (!journalEntry.isFile() || journalEntry.isSymbolicLink()) {
          throw new RuntimeStorageError('unsafe_storage_key', `Invalid journal entry: ${journalEntry.name}`);
        }
        const file = safeChild(threadsDir, journalEntry.name);
        const header = readJournalHeader(file);
        validateThreadMeta(header, binding.workspaceId, header.threadId);
        if (`th-${sha256Hex(header.threadId)}.jsonl` !== journalEntry.name) {
          throw new RuntimeStorageError('thread_storage_key_mismatch', `Invalid storage key for ${header.threadId}`);
        }
        const records = readJournalRecords(file, binding.workspaceId, header.threadId, 'read_only');
        const previous = byId.get(header.threadId);
        inventory.push(snapshot(overlayCatalogDriverRef({
          summary: foldCatalogSummary(previous?.summary ?? summaryFromMeta(header), records),
          format: 'runtime-v2' as const,
          storageKey: journalEntry.name,
          ...(header.driverRef !== undefined && { driverRef: header.driverRef }),
        }, ledgerOps, header.createdByOpId)));
        byId.delete(header.threadId);
      }
    }
    const orphan = [...byId.values()].find((item) => item.format === 'runtime-v2');
    if (orphan !== undefined) {
      throw new RuntimeStorageError('catalog_orphan', `Missing journal for ${orphan.summary.threadId}`);
    }
    inventory.push(...[...byId.values()].filter((item) => item.format === 'session-v1'));
    for (const thread of inventory) {
      const sourceSessionId = thread.driverRef?.kind === 'session-v1'
        ? thread.driverRef.key
        : undefined;
      result.push(snapshot({
        ...(sourceSessionId !== undefined && { sourceSessionId }),
        ownerWorkspaceId: binding.workspaceId,
        ownerRecordedCwd: binding.recordedCwd,
        threadId: thread.summary.threadId,
        catalog: thread,
        executionEligibility: { kind: 'mutable' as const },
      }));
    }
  }
  return result;
}

function readLegacyLocators(
  legacySessionDir: string,
  claimedSessionIds: ReadonlySet<string>,
): StoredThreadLocator[] {
  if (!existsSync(legacySessionDir)) return [];
  assertDirectoryNoSymlink(legacySessionDir);
  const result: StoredThreadLocator[] = [];
  for (const entry of readdirSync(legacySessionDir, { withFileTypes: true })) {
    if (!entry.name.endsWith('.jsonl') || !entry.isFile() || entry.isSymbolicLink()) continue;
    const sourceSessionId = entry.name.slice(0, -'.jsonl'.length);
    if (!isWellFormedUnicode(sourceSessionId) || sourceSessionId.length === 0
      || claimedSessionIds.has(sourceSessionId)) continue;
    try {
      const file = safeLegacySessionFile(legacySessionDir, sourceSessionId);
      const view = readLegacySession(file);
      if (view.meta.id !== sourceSessionId) continue;
      const ownerWorkspaceId = legacyWorkspaceId(view.meta.cwd);
      const threadId = legacyThreadId(ownerWorkspaceId, view.meta.id);
      const mutable = isExecutableCwd(view.meta.cwd);
      const catalog = snapshot<ThreadCatalogRecord>({
        summary: {
          threadId,
          createdAt: view.meta.createdAt,
          state: 'closed',
        },
        format: 'session-v1',
        storageKey: `legacy-session-v1:${sha256Hex(view.meta.id)}`,
        driverRef: { kind: 'session-v1', key: view.meta.id },
      });
      result.push(snapshot({
        sourceSessionId,
        ownerWorkspaceId,
        ownerRecordedCwd: view.meta.cwd,
        threadId,
        catalog,
        executionEligibility: mutable
          ? { kind: 'mutable' as const }
          : { kind: 'read_only' as const, code: 'invalid_legacy_workspace_cwd' as const },
      }));
    } catch {
      // Invalid/lone-surrogate v1 metadata is quarantined from the mutable/read-only identity index.
    }
  }
  return result;
}

function readLegacySession(file: string): LegacySessionView {
  assertRegularFileNoSymlink(file);
  const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.length > 0);
  const messages: AgentMessage[] = [];
  let meta: LegacyMetaRecord | undefined;
  let compaction: LegacyCompactionRecord | undefined;
  for (let index = 0; index < lines.length; index++) {
    let parsed: unknown;
    try { parsed = JSON.parse(lines[index] as string); } catch { parsed = undefined; }
    if (!isRecord(parsed) || typeof parsed.type !== 'string') {
      if (index === lines.length - 1) break;
      throw new RuntimeStorageError('invalid_legacy_session', `Legacy session is corrupt at line ${index + 1}`);
    }
    if (parsed.type === 'meta') {
      if (meta !== undefined || index !== 0) throw new RuntimeStorageError('invalid_legacy_session', 'Invalid v1 meta position');
      meta = validateLegacyMeta(parsed);
    } else if (parsed.type === 'message') {
      if (!isRecord(parsed.message)) throw new RuntimeStorageError('invalid_legacy_session', 'Invalid v1 message');
      messages.push(validateAgentMessage(parsed.message));
    } else if (parsed.type === 'compaction') {
      compaction = validateLegacyCompaction(parsed);
    } else {
      throw new RuntimeStorageError('invalid_legacy_session', `Unknown v1 record ${parsed.type}`);
    }
  }
  if (meta === undefined) throw new RuntimeStorageError('invalid_legacy_session', 'Legacy session has no meta');
  const usage = usageFromTranscript(messages);
  const seedCompaction = compaction === undefined ? undefined : {
    id: compaction.id,
    timestamp: compaction.timestamp,
    tailStartId: compaction.tailStartId,
    summary: compaction.summary,
    ...(compaction.contextTokensBefore !== undefined && {
      contextTokensBefore: compaction.contextTokensBefore,
    }),
  };
  return snapshot({
    meta,
    seed: {
      type: 'legacy_seed',
      sourceSessionId: meta.id,
      transcript: messages,
      usage,
      ...(seedCompaction !== undefined && { compaction: seedCompaction }),
    },
  });
}

function readJournalRecords(
  file: string,
  workspaceId: WorkspaceId,
  threadId: ThreadId,
  mode: 'strict' | 'repair' | 'read_only',
): readonly RuntimeJournalRecord[] {
  assertRegularFileNoSymlink(file);
  const bytes = readFileSync(file);
  const records: RuntimeJournalRecord[] = [];
  let cursor = 0;
  let line = 0;
  let lastGoodOffset = 0;
  let needsFinalNewline = false;
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
      const record = validateJournalRecord(parsed, workspaceId, threadId, records.length === 0);
      records.push(record);
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
      truncateSync(file, lastGoodOffset);
      fsyncFile(file);
      break;
    }
    cursor = next;
  }
  if (needsFinalNewline) {
    appendFileSync(file, '\n', 'utf8');
    fsyncFile(file);
  }
  if (records.length === 0 || records[0]?.type !== 'thread_meta') {
    throw new RuntimeStorageError('invalid_thread_journal', `Thread ${threadId} has no meta header`);
  }
  validateJournalSequence(records, workspaceId, threadId);
  return snapshot(records);
}

function validateJournalSequence(
  records: readonly RuntimeJournalRecord[],
  workspaceId: WorkspaceId,
  threadId: ThreadId,
): void {
  if (records.length === 0 || records[0]?.type !== 'thread_meta') {
    throw new RuntimeStorageError('invalid_thread_journal', `Thread ${threadId} has no meta header`);
  }

  const mailboxPrepares = new Map<OpIdString, Extract<RuntimeJournalRecord, { type: 'mailbox_prepare' }>>();
  const mailboxStates = new Map<OpIdString, 'prepared' | 'accepted_pending' | 'started' | 'completed' | 'rejected'>();
  const usedRunIds = new Map<string, string>();
  const runStates = new Map<string, 'reserved' | 'started' | 'terminal'>();
  const successorByPredecessor = new Map<string, Extract<RuntimeJournalRecord, { type: 'successor_run_prepare' }>>();
  const successorByRun = new Map<string, Extract<RuntimeJournalRecord, { type: 'successor_run_prepare' }>>();
  const turnByKey = new Map<string, Extract<RuntimeJournalRecord, { type: 'turn_prepare' }>>();
  const usedTurnIds = new Map<string, string>();
  const activatedTurns = new Set<string>();
  const pendingResults = new Map<string, Extract<RuntimeThreadMutation, { type: 'thread_result_pending' }>>();
  const deliveredResults = new Set<string>();
  const usedRequestIds = new Set<string>();
  const controlClaims = new Map<string, ExternalOpId>();
  let legacySeedSeen = false;
  let nextSeq = 1;

  for (let index = 0; index < records.length; index++) {
    const record = records[index] as RuntimeJournalRecord;
    if (record.type === 'thread_meta') {
      if (index !== 0 || record.workspaceId !== workspaceId || record.threadId !== threadId) {
        throw invalidJournal('thread_meta must appear exactly once at position zero');
      }
      continue;
    }
    if (record.type === 'legacy_seed') {
      if (legacySeedSeen || index !== 1) {
        throw invalidJournal('legacy_seed must appear at most once immediately after thread_meta');
      }
      legacySeedSeen = true;
      continue;
    }
    if (record.type === 'mailbox_prepare') {
      if (mailboxPrepares.has(record.opId)) throw invalidJournal(`Duplicate mailbox prepare ${record.opId}`);
      mailboxPrepares.set(record.opId, record);
      mailboxStates.set(record.opId, 'prepared');
      continue;
    }
    if (record.type === 'successor_run_prepare') {
      const prior = successorByPredecessor.get(record.predecessorRunId);
      if (prior !== undefined) {
        throw invalidJournal(`Duplicate successor reservation for ${record.predecessorRunId}`);
      }
      claimIdentity(usedRunIds, record.runId, successorIdentityKey(record), 'RunId');
      if (!usedRunIds.has(record.predecessorRunId)) {
        throw invalidJournal(`Successor predecessor is unknown: ${record.predecessorRunId}`);
      }
      successorByPredecessor.set(record.predecessorRunId, record);
      successorByRun.set(record.runId, record);
      continue;
    }
    if (record.type === 'turn_prepare') {
      const key = turnReservationKey(record.runId, record.turnOrdinal);
      if (turnByKey.has(key)) throw invalidJournal(`Duplicate turn reservation ${key}`);
      if (!usedRunIds.has(record.runId)) throw invalidJournal(`Turn reservation has unknown RunId ${record.runId}`);
      claimIdentity(usedTurnIds, record.turnId, key, 'TurnId');
      turnByKey.set(key, record);
      continue;
    }
    if (record.type === 'thread_result_delivered') {
      const pending = pendingResults.get(record.resultOpId);
      if (pending === undefined || pending.parentThreadId !== record.parentThreadId) {
        throw invalidJournal(`Thread result delivery has no matching outbox item ${record.resultOpId}`);
      }
      if (deliveredResults.has(record.resultOpId)) {
        throw invalidJournal(`Duplicate thread result delivery ${record.resultOpId}`);
      }
      deliveredResults.add(record.resultOpId);
      continue;
    }

    if (record.firstSeq !== nextSeq) {
      throw invalidJournal(`Commit sequence expected ${nextSeq}, received ${record.firstSeq}`);
    }
    nextSeq += record.envelopes.length;
    validateCommitCorrespondence(record, mailboxPrepares);

    for (const mutation of record.mutations ?? []) {
      switch (mutation.type) {
        case 'accepted_pending':
          transitionMailbox(mailboxStates, mutation.opId, ['prepared'], 'accepted_pending');
          break;
        case 'started':
          transitionMailbox(mailboxStates, mutation.opId, ['accepted_pending'], 'started');
          break;
        case 'completed':
          transitionMailbox(mailboxStates, mutation.opId, ['accepted_pending', 'started'], 'completed');
          break;
        case 'rejected':
          transitionMailbox(mailboxStates, mutation.opId, ['prepared'], 'rejected');
          break;
        case 'run_reserved': {
          if (mutation.reason === 'retry' || mutation.reason === 'compaction') {
            const prepared = successorByRun.get(mutation.runId);
            if (prepared === undefined
              || prepared.predecessorRunId !== mutation.predecessorRunId
              || prepared.reason !== mutation.reason
              || canonicalJson(prepared.permissionCeiling) !== canonicalJson(mutation.permissionCeiling)) {
              throw invalidJournal(`Run activation does not match successor prepare ${mutation.runId}`);
            }
            claimIdentity(usedRunIds, mutation.runId, successorIdentityKey(prepared), 'RunId');
          } else if ('ownerOpId' in mutation) {
            const prepared = mailboxPrepares.get(mutation.ownerOpId);
            if (prepared === undefined || prepared.op.type !== mutation.reason) {
              throw invalidJournal(`Root run has no matching mailbox prepare ${mutation.runId}`);
            }
            claimIdentity(usedRunIds, mutation.runId, rootRunIdentityKey(mutation.ownerOpId), 'RunId');
          } else {
            throw invalidJournal(`Malformed root run reservation ${mutation.runId}`);
          }
          if (runStates.has(mutation.runId)) throw invalidJournal(`RunId activated twice ${mutation.runId}`);
          runStates.set(mutation.runId, 'reserved');
          break;
        }
        case 'run_started':
          transitionRun(runStates, mutation.runId, ['reserved'], 'started');
          break;
        case 'run_terminal':
          transitionRun(runStates, mutation.runId, ['reserved', 'started'], 'terminal');
          break;
        case 'turn_activated': {
          const key = turnReservationKey(mutation.runId, mutation.turnOrdinal);
          const prepared = turnByKey.get(key);
          if (prepared === undefined || prepared.turnId !== mutation.turnId) {
            throw invalidJournal(`Turn activation has no matching prepare ${mutation.turnId}`);
          }
          if (activatedTurns.has(key)) throw invalidJournal(`Turn activated twice ${mutation.turnId}`);
          activatedTurns.add(key);
          break;
        }
        case 'input_materialized': {
          const prepared = mailboxPrepares.get(mutation.ownerOpId);
          if (prepared === undefined || (prepared.op.type !== 'prompt' && prepared.op.type !== 'continue')) {
            throw invalidJournal(`Input owner is not a prompt/continue op ${mutation.ownerOpId}`);
          }
          break;
        }
        case 'input_transferred':
          if (!mailboxPrepares.has(mutation.fromOpId) || !mailboxPrepares.has(mutation.toOpId)) {
            throw invalidJournal('Input transfer references an unknown mailbox op');
          }
          break;
        case 'input_cancelled':
          if (!mailboxPrepares.has(mutation.ownerOpId) || !mailboxPrepares.has(mutation.byAbortOpId)) {
            throw invalidJournal('Input cancellation references an unknown mailbox op');
          }
          break;
        case 'control_requested':
          if (usedRequestIds.has(mutation.request.requestId)) {
            throw invalidJournal(`Control request identity reused ${mutation.request.requestId}`);
          }
          usedRequestIds.add(mutation.request.requestId);
          break;
        case 'control_response_claimed':
          if (!usedRequestIds.has(mutation.requestId) || controlClaims.has(mutation.requestId)) {
            throw invalidJournal(`Invalid control response claim ${mutation.requestId}`);
          }
          controlClaims.set(mutation.requestId, mutation.responseOpId);
          break;
        case 'control_response_claim_released':
          if (controlClaims.get(mutation.requestId) !== mutation.responseOpId) {
            throw invalidJournal(`Control response release does not own claim ${mutation.requestId}`);
          }
          controlClaims.delete(mutation.requestId);
          break;
        case 'control_resolved':
          if (!usedRequestIds.has(mutation.resolution.requestId)) {
            throw invalidJournal(`Control resolution has no request ${mutation.resolution.requestId}`);
          }
          break;
        case 'thread_result_pending': {
          if (mutation.childThreadId !== threadId || pendingResults.has(mutation.resultOpId)) {
            throw invalidJournal(`Invalid or duplicate thread result outbox item ${mutation.resultOpId}`);
          }
          pendingResults.set(mutation.resultOpId, mutation);
          break;
        }
        case 'message_appended':
        case 'compaction_committed':
        case 'activity_interrupted':
        case 'model_selected':
        case 'rule_scope_observed':
          break;
      }
    }
  }
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
    case 'legacy_seed':
      return validateLegacySeed(value);
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
      assertExactKeys(value, ['type', 'firstSeq', 'envelopes'], ['mutations']);
      if (!isPositiveSafeInteger(value.firstSeq) || !Array.isArray(value.envelopes)
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
      }) as RuntimeJournalRecord;
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

function validateThreadMeta(input: unknown, workspaceId: WorkspaceId, threadId: ThreadId): ThreadMetaRecord {
  const value = snapshotUnknown(input, 'invalid_thread_meta');
  if (isRecord(value)) {
    assertExactKeys(value, [
      'type', 'version', 'protocolVersion', 'workspaceId', 'threadId', 'permissionCeiling',
      'createdAt', 'cwd', 'model',
    ], ['parentThreadId', 'createdByRunId', 'createdByOpId', 'driverRef']);
  }
  if (!isRecord(value) || value.type !== 'thread_meta' || value.version !== 2
    || !isNonEmptyWellFormedString(value.protocolVersion) || value.workspaceId !== workspaceId
    || value.threadId !== threadId || !isThreadId(value.threadId)
    || (value.parentThreadId !== undefined && !isThreadId(value.parentThreadId))
    || (value.createdByRunId !== undefined && !isRunId(value.createdByRunId))
    || (value.createdByOpId !== undefined && !isExternalOpId(value.createdByOpId))
    || !isPermissionCeiling(value.permissionCeiling) || !isFiniteNumber(value.createdAt)
    || typeof value.cwd !== 'string' || !isWellFormedUnicode(value.cwd)
    || !isModelRef(value.model) || (value.driverRef !== undefined && !isDriverRef(value.driverRef))) {
    throw new RuntimeStorageError('invalid_thread_meta', `Invalid metadata for thread ${threadId}`);
  }
  return value as unknown as ThreadMetaRecord;
}

function validateLegacySeed(input: unknown): LegacyThreadSeedRecord {
  const value = snapshotUnknown(input, 'invalid_legacy_seed');
  if (isRecord(value)) {
    assertExactKeys(value, ['type', 'sourceSessionId', 'transcript', 'usage'], ['compaction']);
  }
  if (!isRecord(value) || value.type !== 'legacy_seed'
    || !isNonEmptyWellFormedString(value.sourceSessionId)
    || !Array.isArray(value.transcript) || !isThreadUsage(value.usage)) {
    throw new RuntimeStorageError('invalid_legacy_seed', 'Invalid legacy seed');
  }
  const transcript = value.transcript.map((message) => validateAgentMessage(message));
  if (value.compaction !== undefined) validateCompactionCheckpoint(value.compaction);
  return snapshot({ ...value, transcript }) as unknown as LegacyThreadSeedRecord;
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
      if (value.reason === 'prompt') {
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
    case 'rule_scope_observed':
      assertExactKeys(value, ['type', 'scope', 'owningTurnId', 'invocationId']);
      if (isWellFormedString(value.scope) && isTurnId(value.owningTurnId)
        && isWellFormedString(value.invocationId)) return value as unknown as RuntimeThreadMutation;
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
    if (isRecord(entry)) assertExactKeys(entry, ['summary', 'format', 'storageKey'], ['driverRef']);
    if (!isRecord(entry) || !isThreadSummary(entry.summary)
      || (entry.format !== 'runtime-v2' && entry.format !== 'session-v1')
      || !isNonEmptyWellFormedString(entry.storageKey)
      || (entry.driverRef !== undefined && !isDriverRef(entry.driverRef))) {
      throw new RuntimeStorageError('invalid_thread_catalog', 'Invalid thread catalog entry');
    }
    if (ids.has(entry.summary.threadId as string)) {
      throw new RuntimeStorageError('invalid_thread_catalog', 'Duplicate thread catalog entry');
    }
    ids.add(entry.summary.threadId as string);
  }
}

function validateSupervisorOpRecord(input: unknown, workspaceId: WorkspaceId): void {
  const value = snapshotUnknown(input, 'invalid_supervisor_op');
  if (isRecord(value)) {
    assertExactKeys(value, ['opId', 'op', 'payloadHash', 'state'], [
      'targetThreadIds', 'resolvedTargets', 'driverCreation', 'receipt',
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
  if (value.driverCreation !== undefined) {
    if (!isRecord(value.driverCreation)) {
      throw new RuntimeStorageError('invalid_supervisor_op', 'Invalid driver creation claim');
    }
    assertExactKeys(value.driverCreation, ['creationKey'], ['driverRef']);
    if (!isNonEmptyWellFormedString(value.driverCreation.creationKey)
      || (value.driverCreation.driverRef !== undefined && !isDriverRef(value.driverCreation.driverRef))) {
      throw new RuntimeStorageError('invalid_supervisor_op', 'Invalid driver creation claim');
    }
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
  if ((op.type === 'thread_create') !== (value.driverCreation !== undefined)) {
    throw new RuntimeStorageError('invalid_supervisor_op', 'Driver creation claim is on the wrong op type');
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

function overlayCatalogDriverRef(
  catalog: ThreadCatalogRecord,
  records: Iterable<SupervisorOpLedgerRecord>,
  ownerOpId: ExternalOpId | undefined,
): ThreadCatalogRecord {
  let bound = catalog.driverRef;
  for (const record of records) {
    if (record.op.type !== 'thread_create'
      || record.op.threadId !== catalog.summary.threadId
      || (record.state === 'final' && record.receipt?.accepted !== true)
      || record.driverCreation?.driverRef === undefined) continue;
    if (record.opId !== ownerOpId) {
      throw new RuntimeStorageError('thread_driver_ref_conflict', catalog.summary.threadId);
    }
    const candidate = record.driverCreation.driverRef;
    if (bound !== undefined && canonicalJson(bound) !== canonicalJson(candidate)) {
      throw new RuntimeStorageError('thread_driver_ref_conflict', catalog.summary.threadId);
    }
    bound = candidate;
  }
  return bound === undefined ? catalog : { ...catalog, driverRef: bound };
}

function isFinalDriverRefEnrichment(
  existing: SupervisorOpLedgerRecord,
  candidate: SupervisorOpLedgerRecord,
): boolean {
  if (existing.state !== 'final' || candidate.state !== 'final'
    || existing.op.type !== 'thread_create'
    || existing.receipt?.accepted !== true || candidate.receipt?.accepted !== true
    || existing.driverCreation?.driverRef !== undefined
    || candidate.driverCreation?.driverRef === undefined) return false;
  return canonicalJson({
    ...existing,
    driverCreation: {
      ...existing.driverCreation,
      driverRef: candidate.driverCreation.driverRef,
    },
  }) === canonicalJson(candidate);
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
  const bytes = readFileSync(file);
  const newline = bytes.indexOf(0x0a);
  if (newline < 0) throw new RuntimeStorageError('invalid_thread_journal', 'Thread meta line is incomplete');
  try {
    const parsed = JSON.parse(bytes.subarray(0, newline).toString('utf8')) as unknown;
    if (!isRecord(parsed) || parsed.type !== 'thread_meta' || !isThreadId(parsed.threadId)
      || !isWorkspaceIdValue(parsed.workspaceId)) {
      throw new Error('invalid meta header');
    }
    return validateThreadMeta(parsed, parsed.workspaceId, parsed.threadId);
  } catch (error) {
    throw storageFailure('invalid_thread_journal', file, error);
  }
}

function validateLegacyMeta(input: unknown): LegacyMetaRecord {
  const value = snapshotUnknown(input, 'invalid_legacy_session');
  if (!isRecord(value) || value.type !== 'meta' || value.version !== 1
    || !isNonEmptyWellFormedString(value.protocolVersion) || typeof value.id !== 'string'
    || value.id.length === 0 || !isWellFormedUnicode(value.id) || !isFiniteNumber(value.createdAt)
    || typeof value.cwd !== 'string' || !isWellFormedUnicode(value.cwd) || !isModelRef(value.model)) {
    throw new RuntimeStorageError('invalid_legacy_session', 'Invalid v1 meta');
  }
  return value as unknown as LegacyMetaRecord;
}

function validateLegacyCompaction(input: unknown): LegacyCompactionRecord {
  const value = snapshotUnknown(input, 'invalid_legacy_session');
  if (!isRecord(value) || value.type !== 'compaction' || typeof value.id !== 'string'
    || !isFiniteNumber(value.timestamp) || typeof value.tailStartId !== 'string'
    || typeof value.summary !== 'string'
    || (value.contextTokensBefore !== undefined && !isFiniteNumber(value.contextTokensBefore))) {
    throw new RuntimeStorageError('invalid_legacy_session', 'Invalid v1 compaction');
  }
  return value as unknown as LegacyCompactionRecord;
}

function validateAgentMessage(input: unknown): AgentMessage {
  const value = snapshotUnknown(input, 'invalid_legacy_session');
  if (!isRecord(value) || (value.role !== 'user' && value.role !== 'assistant' && value.role !== 'tool_result')
    || !isWellFormedString(value.id) || !isFiniteNumber(value.timestamp) || !Array.isArray(value.content)) {
    throw new RuntimeStorageError('invalid_legacy_session', 'Invalid v1 AgentMessage');
  }
  if (value.role === 'user') {
    assertExactKeys(value, ['role', 'id', 'timestamp', 'content'], ['source']);
    if (value.source !== undefined && value.source !== 'prompt' && value.source !== 'steering'
      && value.source !== 'follow_up' && value.source !== 'synthetic') {
      throw new RuntimeStorageError('invalid_legacy_session', 'Invalid v1 user message source');
    }
  } else if (value.role === 'assistant') {
    assertExactKeys(value, [
      'role', 'id', 'timestamp', 'content', 'model', 'stopReason', 'usage',
    ], ['errorMessage', 'errorDetails']);
    if (!isModelRef(value.model) || !isUsage(value.usage) || !isStopReason(value.stopReason)
      || (value.errorMessage !== undefined && !isWellFormedString(value.errorMessage))
      || (value.errorDetails !== undefined && !isProviderErrorDetails(value.errorDetails))) {
      throw new RuntimeStorageError('invalid_legacy_session', 'Invalid v1 assistant message');
    }
  } else {
    assertExactKeys(value, [
      'role', 'id', 'timestamp', 'toolCallId', 'toolName', 'content', 'isError',
    ], ['details']);
    if (!isWellFormedString(value.toolCallId) || !isWellFormedString(value.toolName)
      || typeof value.isError !== 'boolean') {
      throw new RuntimeStorageError('invalid_legacy_session', 'Invalid v1 tool result message');
    }
  }
  for (const part of value.content) {
    if (!isMessagePart(part, value.role)) {
      throw new RuntimeStorageError('invalid_legacy_session', 'Invalid v1 message content');
    }
  }
  return value as unknown as AgentMessage;
}

function usageFromTranscript(messages: readonly AgentMessage[]): ThreadUsage {
  let lastTurn: import('../protocol/index.js').Usage | undefined;
  let cumulative: import('../protocol/index.js').Usage = { input: 0, output: 0 };
  let turns = 0;
  let contextTokens = 0;
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const usage = message.usage;
    turns++;
    lastTurn = usage;
    cumulative = addUsage(cumulative, usage);
    if (message.stopReason !== 'error' && message.stopReason !== 'aborted') {
      contextTokens = usage.input + usage.output;
    }
  }
  return snapshot({ ...(lastTurn !== undefined && { lastTurn }), cumulative, turns, contextTokens });
}

function addUsage(
  left: import('../protocol/index.js').Usage,
  right: import('../protocol/index.js').Usage,
): import('../protocol/index.js').Usage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    ...sumOptional(left, right, 'cacheRead'),
    ...sumOptional(left, right, 'cacheWrite'),
    ...sumOptional(left, right, 'reasoning'),
    ...sumOptional(left, right, 'costUSD'),
  };
}

function sumOptional(
  left: import('../protocol/index.js').Usage,
  right: import('../protocol/index.js').Usage,
  key: 'cacheRead' | 'cacheWrite' | 'reasoning' | 'costUSD',
): Partial<import('../protocol/index.js').Usage> {
  if (left[key] === undefined && right[key] === undefined) return {};
  return { [key]: (left[key] ?? 0) + (right[key] ?? 0) };
}

function foldCatalogSummary(
  initial: ThreadCatalogRecord['summary'],
  records: readonly RuntimeJournalRecord[],
): ThreadCatalogRecord['summary'] {
  let summary = initial;
  for (const record of records) {
    if (record.type !== 'commit') continue;
    for (const envelope of record.envelopes) {
      if (envelope.event.type === 'thread_created' || envelope.event.type === 'thread_resumed') {
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

function fsyncFile(file: string): void {
  const fd = openSync(file, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
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

function safeLegacySessionFile(directory: string, sessionId: string): string {
  if (sessionId.includes('/') || sessionId.includes('\\')) {
    throw new RuntimeStorageError('unsafe_storage_key', 'Legacy session id contains a separator');
  }
  return safeChild(directory, `${sessionId}.jsonl`);
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

function isDriverRef(value: unknown): boolean {
  if (!isRecord(value)) return false;
  try {
    assertExactKeys(value, ['kind', 'key']);
    return isNonEmptyWellFormedString(value.kind) && isNonEmptyWellFormedString(value.key)
      && !value.key.includes('\u0000');
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
      'parentThreadId', 'title', 'activeRunId', 'pendingRunIds', 'suspendedWork',
    ]);
    if (!isThreadId(value.threadId) || !isFiniteNumber(value.createdAt)
      || typeof value.state !== 'string' || !states.has(value.state)
      || (value.parentThreadId !== undefined && !isThreadId(value.parentThreadId))
      || (value.title !== undefined && !isWellFormedString(value.title))
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
      assertExactKeys(value, ['type', 'text']);
      return isWellFormedString(value.text);
    }
    if (value.type === 'image' && role !== 'assistant') {
      assertExactKeys(value, ['type', 'data', 'mimeType']);
      return isWellFormedString(value.data) && isWellFormedString(value.mimeType);
    }
    if (value.type === 'reasoning' && role === 'assistant') {
      assertExactKeys(value, ['type', 'text'], ['signature']);
      return isWellFormedString(value.text)
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
    'prompt', 'continue', 'steer', 'follow_up', 'set_model', 'control_response', 'thread_close',
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
  if (op.type === 'prompt' || op.type === 'continue') return isRunId(value.runId);
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
