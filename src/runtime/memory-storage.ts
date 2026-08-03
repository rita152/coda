// Deterministic in-memory RuntimeStoragePort used by embedders and offline concurrency tests.
// It models workspace/thread leases and fencing; persistence lasts for the storage object's lifetime.

import {
  assertWorkspaceId,
  canonicalJson,
  canonicalJsonSha256,
  isExternalOpId,
  isWellFormedUnicode,
  workspaceIdFromCwd,
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
  ThreadSeedRecord,
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
}

export interface MemoryRuntimeWorkspaceStoragePort extends RuntimeWorkspaceStoragePort {
  openPolicyGrantRepository(
    lease: Readonly<SupervisorLease>,
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

  return {
    async listStoredThreads(): Promise<readonly StoredThreadLocator[]> {
      const result: StoredThreadLocator[] = [];
      for (const workspace of workspaces.values()) {
        for (const journal of workspace.journals.values()) {
          const catalog = journal.catalog;
          result.push(snapshot({
            ownerWorkspaceId: workspace.workspaceId,
            ownerRecordedCwd: workspace.recordedCwd,
            threadId: catalog.summary.threadId,
            catalog,
          }));
        }
      }
      return result;
    },

    async openWorkspace(input): Promise<MemoryRuntimeWorkspaceStoragePort> {
      const workspaceId = input.workspaceId ?? workspaceIdFromCwd(input.cwd);
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
        threads: [...workspace.journals.values()].map((journal) => journal.catalog),
      });
    },
  };
}

class MemoryWorkspacePort implements MemoryRuntimeWorkspaceStoragePort {
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
    return snapshot([...this.workspace.journals.values()].map((journal) => journal.catalog));
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
      readonly initialRecords?: readonly ThreadSeedRecord[];
    },
  ): Promise<ThreadJournalPort> {
    this.#assertFence(lease);
    const existing = this.workspace.journals.get(input.threadId);
    const meta = snapshot(input.meta);
    const records: RuntimeJournalRecord[] = [
      meta,
      ...(input.initialRecords ?? []).map(snapshot),
    ];
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

  async openPolicyGrantRepository(
    lease: Readonly<SupervisorLease>,
  ): Promise<PolicyGrantRepository> {
    this.#assertFence(lease);
    return new MemoryPolicyGrantRepository(
      this,
      snapshot(lease),
      this.workspace.policyGrants,
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
  ) {
    this.workspaceId = lease.workspaceId;
    this.mode = 'workspace';
  }

  async snapshot(): Promise<Readonly<PolicyGrantSnapshot>> {
    this.#assertOpen();
    this.workspace.assertCurrentLease(this.lease);
    return policyGrantSnapshot(this.workspaceId, this.grants.values());
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
    const normalized = validatePolicyGrant(grant, this.workspaceId);
    const prior = this.grants.get(normalized.grantId);
    const currentRevision = policyGrantSnapshot(this.workspaceId, this.grants.values()).revision;
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
    return {
      kind: 'applied',
      revision: policyGrantSnapshot(this.workspaceId, this.grants.values()).revision,
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
    if (event.type === 'thread_created'
      || event.type === 'thread_resumed'
      || event.type === 'thread_updated') summary = event.thread;
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

function derivedTuple(claim: DerivedOpIdentityClaim): string {
  return JSON.stringify([claim.purpose, claim.workspaceId, ...claim.parts]);
}

function validatePolicyGrant(
  input: Readonly<PolicyGrant>,
  workspaceId: WorkspaceId,
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
  validateCanonicalPolicyGrantScope(value.scope);
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

function policyGrantSnapshot(
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
