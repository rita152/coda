// Deterministic in-memory RuntimeStoragePort used by embedders and offline concurrency tests.
// It models workspace/thread leases and fencing; persistence lasts for the storage object's lifetime.

import {
  canonicalJson,
  legacyWorkspaceId,
  strictJsonSnapshot,
} from '../protocol/index.js';
import type {
  ExternalOpId,
  ThreadId,
  WorkspaceId,
  WorkspaceWriteFence,
  WorkspaceWriteFenceValidation,
} from '../protocol/index.js';
import { WorkspaceBindingMismatchError, WorkspaceInUseError, RuntimeStorageError } from './errors.js';
import type {
  DerivedOpIdentityClaim,
  DerivedOpIdentityReservation,
  LegacyThreadImport,
  RuntimeJournalRecord,
  RuntimeStoragePort,
  RuntimeWorkspaceStoragePort,
  StoredThreadLocator,
  SupervisorLease,
  SupervisorOpLedgerRecord,
  SupervisorOpReservation,
  ThreadCatalogRecord,
  ThreadJournalPort,
  ThreadMetaRecord,
} from './ports.js';

interface MemoryJournal {
  readonly records: RuntimeJournalRecord[];
  catalog: ThreadCatalogRecord;
  leaseOwner?: symbol;
}

interface MemoryWorkspace {
  readonly workspaceId: WorkspaceId;
  readonly recordedCwd: string;
  fencingCounter: number;
  activeLease?: SupervisorLease;
  readonly ops: Map<ExternalOpId, SupervisorOpLedgerRecord>;
  readonly derivedById: Map<string, DerivedOpIdentityClaim>;
  readonly derivedByTuple: Map<string, DerivedOpIdentityClaim>;
  readonly journals: Map<ThreadId, MemoryJournal>;
}

export interface MemoryRuntimeStorage extends RuntimeStoragePort {
  /** Test-only inspection returns detached immutable records, never the mutable backing maps. */
  inspectWorkspace(workspaceId: WorkspaceId): {
    readonly ops: readonly SupervisorOpLedgerRecord[];
    readonly threads: readonly ThreadCatalogRecord[];
  } | undefined;
}

export function createMemoryRuntimeStorage(): MemoryRuntimeStorage {
  const workspaces = new Map<WorkspaceId, MemoryWorkspace>();

  return {
    async listStoredThreads(): Promise<readonly StoredThreadLocator[]> {
      const result: StoredThreadLocator[] = [];
      for (const workspace of workspaces.values()) {
        for (const journal of workspace.journals.values()) {
          const catalog = overlayCatalogDriverRef(
            journal.catalog,
            workspace.ops.values(),
            journal.records[0]?.type === 'thread_meta' ? journal.records[0].createdByOpId : undefined,
          );
          result.push(snapshot({
            ownerWorkspaceId: workspace.workspaceId,
            ownerRecordedCwd: workspace.recordedCwd,
            threadId: catalog.summary.threadId,
            catalog,
            executionEligibility: { kind: 'mutable' as const },
          }));
        }
      }
      return result;
    },

    async openWorkspace(input): Promise<RuntimeWorkspaceStoragePort> {
      const workspaceId = input.workspaceId ?? legacyWorkspaceId(input.cwd);
      let workspace = workspaces.get(workspaceId);
      if (workspace === undefined) {
        workspace = {
          workspaceId,
          recordedCwd: input.cwd,
          fencingCounter: 0,
          ops: new Map(),
          derivedById: new Map(),
          derivedByTuple: new Map(),
          journals: new Map(),
        };
        workspaces.set(workspaceId, workspace);
      } else if (workspace.recordedCwd !== input.cwd) {
        throw new WorkspaceBindingMismatchError(workspaceId, workspace.recordedCwd, input.cwd);
      }
      return new MemoryWorkspacePort(workspace);
    },

    inspectWorkspace(workspaceId) {
      const workspace = workspaces.get(workspaceId);
      if (workspace === undefined) return undefined;
      return snapshot({
        ops: [...workspace.ops.values()],
        threads: [...workspace.journals.values()].map((journal) =>
          overlayCatalogDriverRef(
            journal.catalog,
            workspace.ops.values(),
            journal.records[0]?.type === 'thread_meta' ? journal.records[0].createdByOpId : undefined,
          )),
      });
    },
  };
}

class MemoryWorkspacePort implements RuntimeWorkspaceStoragePort {
  readonly workspaceId: WorkspaceId;
  readonly recordedCwd: string;
  #closed = false;

  constructor(private readonly workspace: MemoryWorkspace) {
    this.workspaceId = workspace.workspaceId;
    this.recordedCwd = workspace.recordedCwd;
  }

  async acquireSupervisorLease(processEpoch: string): Promise<SupervisorLease> {
    this.#assertOpen();
    if (this.workspace.activeLease !== undefined) {
      throw new WorkspaceInUseError(this.workspaceId);
    }
    const lease: SupervisorLease = snapshot({
      workspaceId: this.workspaceId,
      processEpoch,
      fencingToken: String(++this.workspace.fencingCounter),
    });
    this.workspace.activeLease = lease;
    return lease;
  }

  async releaseSupervisorLease(lease: Readonly<SupervisorLease>): Promise<void> {
    this.#assertFence(lease);
    for (const journal of this.workspace.journals.values()) {
      if (journal.leaseOwner !== undefined) {
        throw new RuntimeStorageError('thread_lease_active', 'Cannot release a supervisor lease with active thread writers');
      }
    }
    this.workspace.activeLease = undefined;
  }

  async validateWriteFence(
    fence: Readonly<WorkspaceWriteFence>,
  ): Promise<WorkspaceWriteFenceValidation> {
    if (fence.workspaceId !== this.workspaceId) return { current: false, code: 'wrong_workspace' };
    const current = this.workspace.activeLease;
    return current?.fencingToken === fence.fencingToken
      ? { current: true }
      : { current: false, code: 'stale_fence' };
  }

  async listThreads(): Promise<readonly ThreadCatalogRecord[]> {
    this.#assertOpen();
    return snapshot([...this.workspace.journals.values()].map((journal) =>
      overlayCatalogDriverRef(
        journal.catalog,
        this.workspace.ops.values(),
        journal.records[0]?.type === 'thread_meta' ? journal.records[0].createdByOpId : undefined,
      )));
  }

  async loadSupervisorOps(): Promise<readonly SupervisorOpLedgerRecord[]> {
    this.#assertOpen();
    return snapshot([...this.workspace.ops.values()]);
  }

  async reserveDerivedOpIdentity(
    lease: Readonly<SupervisorLease>,
    claim: DerivedOpIdentityClaim,
  ): Promise<DerivedOpIdentityReservation> {
    this.#assertFence(lease);
    const tuple = derivedTuple(claim);
    const byId = this.workspace.derivedById.get(claim.opId);
    const byTuple = this.workspace.derivedByTuple.get(tuple);
    if (byId !== undefined || byTuple !== undefined) {
      if (byId !== undefined && byTuple !== undefined && derivedTuple(byId) === tuple && byTuple.opId === claim.opId) {
        return { kind: 'duplicate', claim: snapshot(byId) };
      }
      return { kind: 'conflict', claim: snapshot(byId ?? (byTuple as DerivedOpIdentityClaim)) };
    }
    const stored = snapshot(claim);
    this.workspace.derivedById.set(stored.opId, stored);
    this.workspace.derivedByTuple.set(tuple, stored);
    return { kind: 'claimed', claim: stored };
  }

  async reserveSupervisorOp(
    lease: Readonly<SupervisorLease>,
    record: SupervisorOpLedgerRecord,
  ): Promise<SupervisorOpReservation> {
    this.#assertFence(lease);
    const derived = this.workspace.derivedById.get(record.opId);
    if (derived !== undefined) return { kind: 'conflict', record: snapshot(record) };
    const existing = this.workspace.ops.get(record.opId);
    if (existing !== undefined) {
      return existing.payloadHash === record.payloadHash
        ? { kind: 'duplicate', record: snapshot(existing) }
        : { kind: 'conflict', record: snapshot(existing) };
    }
    const stored = snapshot(record);
    this.workspace.ops.set(stored.opId, stored);
    return { kind: 'reserved', record: stored };
  }

  async finalizeSupervisorOp(
    lease: Readonly<SupervisorLease>,
    record: SupervisorOpLedgerRecord,
  ): Promise<void> {
    this.#assertFence(lease);
    const existing = this.workspace.ops.get(record.opId);
    if (existing === undefined || existing.payloadHash !== record.payloadHash) {
      throw new RuntimeStorageError('supervisor_op_conflict', `Cannot finalize unknown/conflicting op ${record.opId}`);
    }
    if (record.state !== 'final' || record.receipt === undefined) {
      throw new RuntimeStorageError('invalid_supervisor_final', `Final op ${record.opId} has no receipt`);
    }
    if (existing.state === 'final') {
      if (isFinalDriverRefEnrichment(existing, record)) {
        this.workspace.ops.set(record.opId, snapshot(record));
        return;
      }
      if (canonicalJson(existing) !== canonicalJson(record)) {
        throw new RuntimeStorageError('supervisor_op_conflict', `Final op ${record.opId} changed`);
      }
      return;
    }
    this.workspace.ops.set(record.opId, snapshot(record));
  }

  async createThreadJournal(
    lease: Readonly<SupervisorLease>,
    input: {
      readonly threadId: ThreadId;
      readonly meta: ThreadMetaRecord;
      readonly initialRecords?: readonly import('./ports.js').LegacyThreadSeedRecord[];
    },
  ): Promise<ThreadJournalPort> {
    this.#assertFence(lease);
    const existing = this.workspace.journals.get(input.threadId);
    const meta = snapshot(input.meta);
    const records = [meta, ...(input.initialRecords ?? []).map(snapshot)];
    if (existing !== undefined) {
      if (canonicalJson(existing.records.slice(0, records.length)) !== canonicalJson(records)) {
        throw new RuntimeStorageError(
          'thread_meta_conflict',
          `Thread ${input.threadId} has different immutable initial records`,
        );
      }
      return new MemoryJournalPort(this, existing);
    }
    const journal: MemoryJournal = {
      records,
      catalog: snapshot({
        summary: {
          threadId: input.threadId,
          ...(meta.parentThreadId !== undefined && { parentThreadId: meta.parentThreadId }),
          createdAt: meta.createdAt,
          state: 'idle',
        },
        format: 'runtime-v2',
        storageKey: `memory:${this.workspaceId}:${input.threadId}`,
        ...(meta.driverRef !== undefined && { driverRef: meta.driverRef }),
      }),
    };
    this.workspace.journals.set(input.threadId, journal);
    return new MemoryJournalPort(this, journal);
  }

  async openThreadJournal(threadId: ThreadId): Promise<ThreadJournalPort | undefined> {
    this.#assertOpen();
    const journal = this.workspace.journals.get(threadId);
    return journal === undefined ? undefined : new MemoryJournalPort(this, journal);
  }

  async importLegacyThread(
    lease: Readonly<SupervisorLease>,
    threadId: ThreadId,
  ): Promise<LegacyThreadImport | undefined> {
    this.#assertFence(lease);
    const journal = this.workspace.journals.get(threadId);
    if (journal === undefined || journal.catalog.format !== 'session-v1' || journal.catalog.driverRef === undefined) {
      return undefined;
    }
    const seed = journal.records.find((record) => record.type === 'legacy_seed');
    if (seed === undefined) return undefined;
    return snapshot({
      catalog: journal.catalog,
      seed,
      driverRef: journal.catalog.driverRef,
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  assertCurrentLease(lease: Readonly<SupervisorLease>): void {
    this.#assertFence(lease);
  }

  #assertOpen(): void {
    if (this.#closed) throw new RuntimeStorageError('workspace_port_closed', 'Workspace storage port is closed');
  }

  #assertFence(lease: Readonly<SupervisorLease>): void {
    this.#assertOpen();
    const current = this.workspace.activeLease;
    if (
      lease.workspaceId !== this.workspaceId ||
      current === undefined ||
      current.fencingToken !== lease.fencingToken ||
      current.processEpoch !== lease.processEpoch
    ) {
      throw new RuntimeStorageError('stale_fence', 'Workspace write fence is no longer current');
    }
  }
}

class MemoryJournalPort implements ThreadJournalPort {
  readonly #owner = Symbol('memory-thread-journal-writer');
  #lease: SupervisorLease | undefined;

  constructor(
    private readonly workspace: MemoryWorkspacePort,
    private readonly journal: MemoryJournal,
  ) {}

  async acquireWriteLease(lease: Readonly<SupervisorLease>): Promise<void> {
    this.workspace.assertCurrentLease(lease);
    if (this.journal.leaseOwner !== undefined && this.journal.leaseOwner !== this.#owner) {
      throw new RuntimeStorageError('thread_in_use', 'Thread already has a writer');
    }
    this.journal.leaseOwner = this.#owner;
    this.#lease = snapshot(lease);
  }

  async load(): Promise<readonly RuntimeJournalRecord[]> {
    return snapshot(this.journal.records);
  }

  async append(
    records: readonly RuntimeJournalRecord[],
    options: { readonly flush: true },
  ): Promise<void> {
    if (options.flush !== true || this.#lease === undefined) {
      throw new RuntimeStorageError('thread_not_writable', 'Thread journal has no active write lease');
    }
    this.workspace.assertCurrentLease(this.#lease);
    const copies = records.map(snapshot);
    this.journal.records.push(...copies);
    for (const record of copies) {
      if (record.type === 'commit') updateCatalog(this.journal, record);
    }
  }

  async releaseWriteLease(): Promise<void> {
    if (this.#lease !== undefined && this.journal.leaseOwner === this.#owner) {
      this.journal.leaseOwner = undefined;
    }
    this.#lease = undefined;
  }
}

function updateCatalog(journal: MemoryJournal, record: Extract<RuntimeJournalRecord, { type: 'commit' }>): void {
  let summary = journal.catalog.summary;
  for (const envelope of record.envelopes) {
    const event = envelope.event;
    if (event.type === 'thread_created' || event.type === 'thread_resumed') summary = event.thread;
    if (event.type === 'thread_closed') summary = withoutActiveRun(summary, 'closed');
  }
  for (const mutation of record.mutations ?? []) {
    if (mutation.type === 'run_reserved' || mutation.type === 'run_started') {
      summary = {
        ...summary,
        state: mutation.type === 'run_reserved' ? 'starting' : 'running',
        activeRunId: mutation.runId,
      };
    } else if (mutation.type === 'run_terminal' && summary.activeRunId === mutation.runId) {
      summary = withoutActiveRun(summary, 'idle');
    }
  }
  journal.catalog = snapshot({ ...journal.catalog, summary });
}

function withoutActiveRun(
  summary: ThreadCatalogRecord['summary'],
  state: ThreadCatalogRecord['summary']['state'],
): ThreadCatalogRecord['summary'] {
  const { activeRunId, ...rest } = summary;
  void activeRunId;
  return { ...rest, state };
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

function derivedTuple(claim: DerivedOpIdentityClaim): string {
  return JSON.stringify([claim.purpose, claim.workspaceId, ...claim.parts]);
}

function snapshot<T>(value: T): T {
  // strictJsonSnapshot validates and owns the complete object graph; the boundary type is restored
  // because runtime records are all protocol-declared strict-JSON structures.
  return strictJsonSnapshot(value) as T;
}
