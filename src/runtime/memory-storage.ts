// Deterministic in-memory RuntimeStoragePort used by embedders and offline concurrency tests.
// It models workspace/thread leases and fencing; persistence lasts for the storage object's lifetime.

import {
  assertWorkspaceId,
  canonicalJson,
  canonicalJsonSha256,
  isExternalOpId,
  isWellFormedUnicode,
  legacyWorkspaceId,
  strictJsonSnapshot,
} from '../protocol/index.js';
import type {
  PolicyGrant,
  PolicyGrantCommitResult,
  PolicyGrantRepository,
  PolicyGrantSnapshot,
} from '../capabilities/types.js';
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
  LegacyApprovalRecoveryInventory,
  LegacyApprovalPatternRepository,
  LegacyApprovalPatternCommitResult,
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
  readonly policyGrants: Map<ExternalOpId, Readonly<PolicyGrant>>;
  readonly legacyApprovalOutbox: Map<ExternalOpId, MemoryLegacyApprovalReceipt>;
}

interface MemoryLegacyApprovalReceipt {
  readonly responseOpId: ExternalOpId;
  readonly acceptedAt: number;
  readonly patterns: readonly [string, ...string[]];
  readonly state: 'reserved' | 'applied';
}

export interface MemoryRuntimeWorkspaceStoragePort extends RuntimeWorkspaceStoragePort {
  inspectLegacyApprovalRecovery(
    lease: Readonly<SupervisorLease>,
  ): Promise<Readonly<LegacyApprovalRecoveryInventory>>;
  openPolicyGrantRepository(
    lease: Readonly<SupervisorLease>,
    mode: PolicyGrantRepository['mode'],
  ): Promise<PolicyGrantRepository>;
}

export interface MemoryRuntimeStorage extends RuntimeStoragePort {
  openWorkspace(input: {
    readonly cwd: string;
    readonly workspaceId?: WorkspaceId;
  }): Promise<MemoryRuntimeWorkspaceStoragePort>;
  /** Test-only inspection returns detached immutable records, never the mutable backing maps. */
  inspectWorkspace(workspaceId: WorkspaceId): {
    readonly ops: readonly SupervisorOpLedgerRecord[];
    readonly threads: readonly ThreadCatalogRecord[];
  } | undefined;
}

export function createMemoryRuntimeStorage(): MemoryRuntimeStorage {
  const workspaces = new Map<WorkspaceId, MemoryWorkspace>();
  const legacyApprovalPatterns = new Set<string>();

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

    async openWorkspace(input): Promise<MemoryRuntimeWorkspaceStoragePort> {
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
          policyGrants: new Map(),
          legacyApprovalOutbox: new Map(),
        };
        workspaces.set(workspaceId, workspace);
      } else if (workspace.recordedCwd !== input.cwd) {
        throw new WorkspaceBindingMismatchError(workspaceId, workspace.recordedCwd, input.cwd);
      }
      return new MemoryWorkspacePort(workspace, legacyApprovalPatterns);
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

class MemoryWorkspacePort implements MemoryRuntimeWorkspaceStoragePort {
  readonly workspaceId: WorkspaceId;
  readonly recordedCwd: string;
  #closed = false;

  constructor(
    private readonly workspace: MemoryWorkspace,
    private readonly legacyApprovalPatterns: Set<string>,
  ) {
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

  async openLegacyApprovalPatternRepository(
    lease: Readonly<SupervisorLease>,
  ): Promise<LegacyApprovalPatternRepository> {
    this.#assertFence(lease);
    return new MemoryLegacyApprovalPatternRepository(
      this,
      snapshot(lease),
      this.workspace.legacyApprovalOutbox,
      this.legacyApprovalPatterns,
    );
  }

  async inspectLegacyApprovalRecovery(
    lease: Readonly<SupervisorLease>,
  ): Promise<Readonly<LegacyApprovalRecoveryInventory>> {
    this.#assertFence(lease);
    return snapshot({
      hasPendingReservedOutbox: [...this.workspace.legacyApprovalOutbox.values()]
        .some((receipt) => receipt.state === 'reserved'),
    });
  }

  async openPolicyGrantRepository(
    lease: Readonly<SupervisorLease>,
    mode: PolicyGrantRepository['mode'],
  ): Promise<PolicyGrantRepository> {
    this.#assertFence(lease);
    return new MemoryPolicyGrantRepository(
      this,
      snapshot(lease),
      this.workspace.policyGrants,
      this.legacyApprovalPatterns,
      mode,
    );
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

class MemoryPolicyGrantRepository implements PolicyGrantRepository {
  readonly workspaceId: WorkspaceId;
  readonly mode: PolicyGrantRepository['mode'];
  #closed = false;

  constructor(
    private readonly workspace: MemoryWorkspacePort,
    private readonly lease: SupervisorLease,
    private readonly grants: Map<ExternalOpId, Readonly<PolicyGrant>>,
    private readonly legacyPatterns: Set<string>,
    mode: PolicyGrantRepository['mode'],
  ) {
    this.workspaceId = lease.workspaceId;
    this.mode = mode;
  }

  async snapshot(): Promise<Readonly<PolicyGrantSnapshot>> {
    this.#assertOpen();
    this.workspace.assertCurrentLease(this.lease);
    return policyGrantSnapshot(
      this.workspaceId,
      this.mode,
      grantsForMode(this.grants.values(), this.mode),
      this.legacyPatterns,
    );
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
      this.workspace.assertCurrentLease(this.lease);
    } catch {
      return policyGrantFenced('stale_fence', 'Policy grant repository lost its workspace fence');
    }
    const normalized = validatePolicyGrant(grant, this.workspaceId, this.mode);
    const prior = this.grants.get(normalized.grantId);
    const currentRevision = policyGrantSnapshot(
      this.workspaceId,
      this.mode,
      grantsForMode(this.grants.values(), this.mode),
      this.legacyPatterns,
    ).revision;
    if (prior !== undefined) {
      return canonicalJson(prior) === canonicalJson(normalized)
        ? { kind: 'duplicate', revision: currentRevision }
        : {
            kind: 'conflict',
            revision: currentRevision,
            message: `Policy grant ${normalized.grantId} changed its durable payload`,
          };
    }
    // Fence comparison and receipt/grant insertion are one synchronous memory transaction.
    // There is no await between the captured-fence check and the mutation.
    try {
      this.workspace.assertCurrentLease(this.lease);
    } catch {
      return policyGrantFenced('stale_fence', 'Policy grant repository lost its workspace fence');
    }
    this.grants.set(normalized.grantId, normalized);
    if (normalized.scope.kind === 'legacy_global_approvals_v1') {
      for (const pattern of normalized.scope.patterns) this.legacyPatterns.add(pattern);
    }
    return {
      kind: 'applied',
      revision: policyGrantSnapshot(
        this.workspaceId,
        this.mode,
        grantsForMode(this.grants.values(), this.mode),
        this.legacyPatterns,
      ).revision,
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new RuntimeStorageError('stale_fence', 'Policy grant repository is closed');
    }
  }
}

class MemoryLegacyApprovalPatternRepository implements LegacyApprovalPatternRepository {
  readonly workspaceId: WorkspaceId;
  #closed = false;

  constructor(
    private readonly workspace: MemoryWorkspacePort,
    private readonly lease: SupervisorLease,
    private readonly outbox: Map<ExternalOpId, MemoryLegacyApprovalReceipt>,
    private readonly patterns: Set<string>,
  ) {
    this.workspaceId = lease.workspaceId;
  }

  async snapshot(): Promise<Readonly<import('../protocol/index.js').LegacyApprovalPatternSnapshot>> {
    this.#assertOpen();
    this.workspace.assertCurrentLease(this.lease);
    return legacyApprovalSnapshot(this.patterns);
  }

  async commit(input: {
    readonly responseOpId: ExternalOpId;
    readonly acceptedAt: number;
    readonly patterns: readonly [string, ...string[]];
  }): Promise<LegacyApprovalPatternCommitResult> {
    if (this.#closed) {
      return {
        kind: 'fenced',
        code: 'stale_fence',
        message: 'Legacy approval repository is closed',
      };
    }
    try {
      this.workspace.assertCurrentLease(this.lease);
    } catch {
      return {
        kind: 'fenced',
        code: 'stale_fence',
        message: 'Legacy approval repository lost its workspace fence',
      };
    }
    const normalized = validateLegacyApprovalCommitInput(input);
    const prior = this.outbox.get(normalized.responseOpId);
    if (prior !== undefined) {
      if (!sameLegacyApprovalReceipt(prior, normalized)) {
        return {
          kind: 'conflict',
          revision: legacyApprovalSnapshot(this.patterns).revision,
          message: `Legacy approval response ${input.responseOpId} changed its durable payload`,
        };
      }
      if (prior.state === 'applied') {
        return { kind: 'duplicate', revision: legacyApprovalSnapshot(this.patterns).revision };
      }
    } else {
      this.outbox.set(normalized.responseOpId, snapshot({ ...normalized, state: 'reserved' as const }));
    }
    for (const pattern of normalized.patterns) this.patterns.add(pattern);
    this.outbox.set(normalized.responseOpId, snapshot({ ...normalized, state: 'applied' as const }));
    return { kind: 'applied', revision: legacyApprovalSnapshot(this.patterns).revision };
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed) throw new RuntimeStorageError('stale_fence', 'Legacy approval repository is closed');
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

function validateLegacyApprovalCommitInput(input: {
  readonly responseOpId: ExternalOpId;
  readonly acceptedAt: number;
  readonly patterns: readonly [string, ...string[]];
}): Omit<MemoryLegacyApprovalReceipt, 'state'> {
  if (!isExternalOpId(input.responseOpId)) {
    throw new RuntimeStorageError('invalid_legacy_approval_receipt', 'responseOpId must be external');
  }
  if (!Number.isSafeInteger(input.acceptedAt) || input.acceptedAt < 0) {
    throw new RuntimeStorageError('invalid_legacy_approval_receipt', 'acceptedAt must be a non-negative safe integer');
  }
  const patterns = [...input.patterns];
  if (patterns.length === 0
    || patterns.some((pattern) => !isWellFormedUnicode(pattern) || pattern.length === 0)
    || canonicalJson(patterns) !== canonicalJson([...new Set(patterns)].sort(compareUtf8))) {
    throw new RuntimeStorageError(
      'invalid_legacy_approval_receipt',
      'patterns must be a non-empty, sorted, unique Unicode string tuple',
    );
  }
  return snapshot({
    responseOpId: input.responseOpId,
    acceptedAt: input.acceptedAt,
    patterns: patterns as [string, ...string[]],
  });
}

function sameLegacyApprovalReceipt(
  prior: MemoryLegacyApprovalReceipt,
  candidate: Omit<MemoryLegacyApprovalReceipt, 'state'>,
): boolean {
  return canonicalJson({
    responseOpId: prior.responseOpId,
    acceptedAt: prior.acceptedAt,
    patterns: prior.patterns,
  }) === canonicalJson(candidate);
}

function legacyApprovalSnapshot(
  patterns: ReadonlySet<string>,
): Readonly<import('../protocol/index.js').LegacyApprovalPatternSnapshot> {
  const sorted = [...patterns].sort(compareUtf8);
  return snapshot({
    revision: `legacy-approval-v1-${canonicalJsonSha256(sorted)}`,
    patterns: sorted,
  });
}

function validatePolicyGrant(
  input: Readonly<PolicyGrant>,
  workspaceId: WorkspaceId,
  mode: PolicyGrantRepository['mode'],
): Readonly<PolicyGrant> {
  let value: unknown;
  try {
    value = strictJsonSnapshot(input);
  } catch (error) {
    throw invalidPolicyGrant(error);
  }
  if (!isRecord(value)) throw invalidPolicyGrant();
  assertExactPolicyGrantKeys(value, [
    'grantId',
    'workspaceId',
    'capabilityId',
    'capabilityVersion',
    'registrationDigest',
    'scope',
    'policyBasisRevision',
    'acceptedAt',
  ]);
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
    throw invalidPolicyGrant();
  }
  if (mode === 'workspace') validateCanonicalPolicyGrantScope(value.scope);
  else validateLegacyPolicyGrantScope(value.scope);
  return value as unknown as Readonly<PolicyGrant>;
}

function validateCanonicalPolicyGrantScope(input: unknown): void {
  if (!isRecord(input)) throw invalidPolicyGrant();
  assertExactPolicyGrantKeys(input, ['kind', 'resourcePatterns', 'attributes']);
  if (input.kind !== 'canonical_resources_v1'
    || !Array.isArray(input.resourcePatterns)
    || input.resourcePatterns.length === 0
    || !isRecord(input.attributes)) {
    throw invalidPolicyGrant();
  }
  const canonicalPatterns: string[] = [];
  for (const pattern of input.resourcePatterns) {
    if (!isRecord(pattern)) throw invalidPolicyGrant();
    assertExactPolicyGrantKeys(pattern, ['resourceType', 'access', 'matcher', 'pattern']);
    if (!isPolicyGrantResourceType(pattern.resourceType)
      || !isPolicyGrantResourceAccess(pattern.access)
      || pattern.matcher !== 'canonical_target_exact_v1'
      || !isNonEmptyWellFormedString(pattern.pattern)) {
      throw invalidPolicyGrant();
    }
    canonicalPatterns.push(canonicalJson(pattern));
  }
  for (let index = 1; index < canonicalPatterns.length; index++) {
    if (compareUtf8(canonicalPatterns[index - 1]!, canonicalPatterns[index]!) >= 0) {
      throw invalidPolicyGrant();
    }
  }
}

function validateLegacyPolicyGrantScope(input: unknown): void {
  if (!isRecord(input)) throw invalidPolicyGrant();
  assertExactPolicyGrantKeys(input, ['kind', 'patterns']);
  if (input.kind !== 'legacy_global_approvals_v1'
    || !Array.isArray(input.patterns)
    || input.patterns.length === 0
    || input.patterns.some((pattern) => !isNonEmptyWellFormedString(pattern))
    || canonicalJson(input.patterns) !== canonicalJson([...new Set(input.patterns)].sort(compareUtf8))) {
    throw invalidPolicyGrant();
  }
}

function grantsForMode(
  grants: Iterable<Readonly<PolicyGrant>>,
  mode: PolicyGrantRepository['mode'],
): readonly Readonly<PolicyGrant>[] {
  return [...grants].filter((grant) => mode === 'workspace'
    ? grant.scope.kind === 'canonical_resources_v1'
    : grant.scope.kind === 'legacy_global_approvals_v1');
}

function policyGrantSnapshot(
  workspaceId: WorkspaceId,
  mode: PolicyGrantRepository['mode'],
  grants: Iterable<Readonly<PolicyGrant>>,
  legacyPatterns: ReadonlySet<string>,
): Readonly<PolicyGrantSnapshot> {
  const copied = [...grants].map((grant) => snapshot(grant));
  if (mode === 'legacy_global_approvals_v1') {
    const legacyGlobal = legacyApprovalSnapshot(legacyPatterns);
    return snapshot({
      workspaceId,
      revision: `policy-grants-legacy-v1-${canonicalJsonSha256({
        workspaceId,
        grants: copied,
        legacyGlobal,
      })}`,
      grants: copied,
      legacyGlobal,
    });
  }
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

function invalidPolicyGrant(error?: unknown): RuntimeStorageError {
  const detail = error instanceof Error ? `: ${error.message}` : '';
  return new RuntimeStorageError('invalid_policy_grant', `Invalid policy grant${detail}`);
}

function assertExactPolicyGrantKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
): void {
  if (Object.keys(value).length !== required.length
    || required.some((key) => !Object.hasOwn(value, key))) {
    throw invalidPolicyGrant();
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isWorkspaceIdValue(value: unknown): value is WorkspaceId {
  try {
    assertWorkspaceId(value);
    return true;
  } catch {
    return false;
  }
}

function isNonEmptyWellFormedString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && isWellFormedUnicode(value);
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

function snapshot<T>(value: T): T {
  // strictJsonSnapshot validates and owns the complete object graph; the boundary type is restored
  // because runtime records are all protocol-declared strict-JSON structures.
  return strictJsonSnapshot(value) as T;
}
