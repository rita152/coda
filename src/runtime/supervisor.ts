// Workspace Supervisor and public RuntimePort. It routes identity-bearing ops to independent
// thread mailboxes while keeping provider/tool execution behind injected ThreadDriverPort objects.

import path from 'node:path';
import {
  assertThreadId,
  assertWorkspaceId,
  canonicalJson,
  canonicalizeRuntimeOp,
  isDerivedOpId,
  isExternalOpId,
  isThreadId,
  legacyWorkspaceId,
  runtimeOpPayloadHash,
  strictJsonSnapshot,
} from '../protocol/index.js';
import type {
  DerivedOpId,
  EventEnvelope,
  ExternalOpId,
  ModelConfig,
  OpId,
  OpReceipt,
  PermissionCeilingSnapshot,
  RunId,
  RuntimeOp,
  RuntimeEvent,
  ThreadId,
  ThreadSnapshot,
  ThreadSummary,
  WorkspaceId,
} from '../protocol/index.js';
import type { EventSubscriptionOptions } from '../session/event-hub.js';
import { EventHub } from '../session/event-hub.js';
import type {
  CommitEnvelopeInput,
  FoldedRunEntry,
  FoldedThreadJournal,
} from '../session/thread-journal.js';
import {
  foldThreadJournal,
  snapshotFromFold,
  ThreadJournalWriter,
} from '../session/thread-journal.js';
import {
  ThreadDriverHostController,
  ThreadRuntime,
} from '../session/thread-runtime.js';
import {
  RuntimeClosedError,
  RuntimeIdentityValidationError,
  RuntimeScopeDispatchError,
  RuntimeStorageError,
  WorkspaceBindingMismatchError,
} from './errors.js';
import { createDefaultRuntimeIdentityFactory } from './identity-factory.js';
import { validatePermissionCeilingSnapshot } from '../session/permission-ceiling.js';
import type {
  PermissionPolicyPort,
  RecoveryQueueCommand,
  RuntimeClock,
  RuntimeIdentityFactory,
  RuntimeJournalRecord,
  LegacyApprovalPatternRepository,
  RuntimeModelResolver,
  RuntimeStoragePort,
  RuntimeWorkspaceStoragePort,
  SupervisorLease,
  SupervisorOpLedgerRecord,
  ThreadCatalogRecord,
  ThreadDriverAttachment,
  ThreadDriverFactory,
  ThreadDriverPort,
  ThreadJournalPort,
  ThreadMetaRecord,
  ThreadResultDeliveryRecord,
  ThreadResultOutboxMutation,
} from './ports.js';

export interface RuntimePort {
  readonly workspaceId: WorkspaceId;
  newThreadId(): ThreadId;
  newOpId(): ExternalOpId;
  submit(op: RuntimeOp): Promise<OpReceipt>;
  events(options?: EventSubscriptionOptions): AsyncIterable<Readonly<EventEnvelope>>;
  listThreads(): Promise<readonly ThreadSummary[]>;
  getThreadSnapshot(threadId: ThreadId): Promise<Readonly<ThreadSnapshot> | undefined>;
  close(): Promise<void>;
}

export interface CreateRuntimeOptions {
  readonly workspace: {
    readonly cwd: string;
    readonly workspaceId?: WorkspaceId;
  };
  readonly storage: RuntimeStoragePort;
  readonly modelResolver: RuntimeModelResolver;
  readonly permissionPolicy: PermissionPolicyPort;
  readonly threadDriverFactory: ThreadDriverFactory;
  readonly identityFactory?: RuntimeIdentityFactory;
  readonly clock?: RuntimeClock;
  readonly capabilityMode?: 'static';
  readonly capabilityServices?: never;
}

export async function createRuntime(options: CreateRuntimeOptions): Promise<RuntimePort> {
  validateCreateOptions(options);
  const cwd = options.workspace.cwd;
  const workspaceId = options.workspace.workspaceId ?? legacyWorkspaceId(cwd);
  const identityFactory = options.identityFactory ?? createDefaultRuntimeIdentityFactory();
  const processEpoch = identityFactory.newProcessEpoch();
  if (typeof processEpoch !== 'string' || processEpoch.length === 0) {
    throw new RuntimeIdentityValidationError('invalid_legacy_identity_input', 'identityFactory.newProcessEpoch');
  }
  const workspace = await options.storage.openWorkspace({ cwd, workspaceId });
  if (workspace.workspaceId !== workspaceId || workspace.recordedCwd !== cwd) {
    await workspace.close().catch(() => undefined);
    throw new WorkspaceBindingMismatchError(
      workspaceId,
      workspace.recordedCwd,
      cwd,
    );
  }
  let lease: SupervisorLease;
  try {
    lease = await workspace.acquireSupervisorLease(processEpoch);
  } catch (error) {
    await workspace.close().catch(() => undefined);
    throw error;
  }
  let legacyApprovalPatterns: LegacyApprovalPatternRepository | undefined;
  try {
    if (options.threadDriverFactory.requirements.approvalMode === 'durable_legacy_bridge') {
      const open = workspace.openLegacyApprovalPatternRepository;
      if (open === undefined) {
        throw new RuntimeStorageError(
          'legacy_approval_storage_unavailable',
          'The selected static driver requires fenced legacy approval storage',
        );
      }
      legacyApprovalPatterns = await open.call(workspace, lease);
    }
    return await Supervisor.open({
      options,
      workspaceId,
      workspace,
      lease,
      identityFactory,
      ...(legacyApprovalPatterns !== undefined && { legacyApprovalPatterns }),
    });
  } catch (error) {
    await legacyApprovalPatterns?.close().catch(() => undefined);
    await workspace.releaseSupervisorLease(lease).catch(() => undefined);
    await workspace.close().catch(() => undefined);
    throw error;
  }
}

interface SupervisorOpenInput {
  readonly options: CreateRuntimeOptions;
  readonly workspaceId: WorkspaceId;
  readonly workspace: RuntimeWorkspaceStoragePort;
  readonly lease: SupervisorLease;
  readonly identityFactory: RuntimeIdentityFactory;
  readonly legacyApprovalPatterns?: LegacyApprovalPatternRepository;
}

class Supervisor implements RuntimePort {
  readonly workspaceId: WorkspaceId;
  readonly #cwd: string;
  readonly #workspace: RuntimeWorkspaceStoragePort;
  readonly #lease: SupervisorLease;
  readonly #identityFactory: RuntimeIdentityFactory;
  readonly #clock: RuntimeClock;
  readonly #modelResolver: RuntimeModelResolver;
  readonly #permissionPolicy: PermissionPolicyPort;
  readonly #driverFactory: ThreadDriverFactory;
  readonly #legacyApprovalPatterns: LegacyApprovalPatternRepository | undefined;
  readonly #pendingApprovalDiagnostics: {
    readonly code: string;
    readonly message: string;
  }[];
  readonly #events = new EventHub();
  readonly #threads = new Map<ThreadId, ThreadRuntime>();
  readonly #catalog = new Map<ThreadId, ThreadCatalogRecord>();
  readonly #threadMeta = new Map<ThreadId, ThreadMetaRecord>();
  readonly #unloaded = new Map<ThreadId, FoldedThreadJournal>();
  readonly #inFlight = new Set<Promise<unknown>>();
  readonly #threadUnloadFlights = new Map<ThreadId, Promise<void>>();
  readonly #opFlights = new Map<ExternalOpId, {
    readonly payloadHash: string;
    readonly promise: Promise<OpReceipt>;
  }>();
  readonly #threadClaims = new Map<ThreadId, {
    readonly kind: 'create' | 'attach' | 'attached' | 'existing';
    readonly opId?: ExternalOpId;
  }>();
  readonly #attachmentLifecycleOps = new Map<ThreadId, OpId>();
  readonly #closeController = new AbortController();
  #state: 'open' | 'closing' | 'closed' = 'open';
  #approvalFatal: Error | undefined;
  #approvalDiagnosticFlight: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;

  private constructor(input: SupervisorOpenInput) {
    this.workspaceId = input.workspaceId;
    this.#cwd = input.options.workspace.cwd;
    this.#workspace = input.workspace;
    this.#lease = input.lease;
    this.#identityFactory = input.identityFactory;
    this.#clock = input.options.clock ?? { now: () => Date.now() };
    this.#modelResolver = input.options.modelResolver;
    this.#permissionPolicy = input.options.permissionPolicy;
    this.#driverFactory = input.options.threadDriverFactory;
    this.#legacyApprovalPatterns = input.legacyApprovalPatterns;
    this.#pendingApprovalDiagnostics = [
      ...(input.legacyApprovalPatterns?.startupDiagnostics?.() ?? []),
    ];
  }

  static async open(input: SupervisorOpenInput): Promise<Supervisor> {
    const supervisor = new Supervisor(input);
    const catalog = await input.workspace.listThreads();
    for (const item of catalog) {
      supervisor.#catalog.set(item.summary.threadId, item);
      supervisor.#threadClaims.set(item.summary.threadId, { kind: 'existing' });
      supervisor.#events.registerThread(item.summary.threadId);
      const journal = await input.workspace.openThreadJournal(item.summary.threadId);
      if (journal === undefined) continue;
      const records = await journal.load();
      const initial = foldThreadJournal(records);
      supervisor.#events.seed(item.summary.threadId, initial.envelopes);
      const recovered = await supervisor.#recoverUnloadedJournal(item.summary.threadId, journal, records);
      const folded = withAttachmentRecoveryOverlay(recovered);
      supervisor.#threadMeta.set(item.summary.threadId, folded.meta);
      supervisor.#unloaded.set(item.summary.threadId, folded);
      if (folded.summary.state === 'closed' && item.summary.state !== 'closed') {
        supervisor.#catalog.set(item.summary.threadId, {
          ...item,
          summary: withoutActiveRunSummary(item.summary, 'closed'),
        });
      }
    }
    let ledger = await input.workspace.loadSupervisorOps();
    supervisor.#restoreReservedLifecycleClaims(ledger);
    await supervisor.#reconcileSupervisorLedger(ledger);
    ledger = await input.workspace.loadSupervisorOps();
    await supervisor.#recoverReservedLifecycleAndScope(ledger);
    ledger = await input.workspace.loadSupervisorOps();
    supervisor.#applyLifecycleLedger(ledger);
    await supervisor.#recoverAcceptedAttachments(ledger);
    await supervisor.#recoverThreadResultOutbox();
    return supervisor;
  }

  newThreadId(): ThreadId {
    this.#assertOpen();
    const threadId = this.#identityFactory.newThreadId();
    if (!isThreadId(threadId)) {
      throw new RuntimeIdentityValidationError('invalid_thread_id', 'identityFactory.newThreadId');
    }
    return threadId;
  }

  newOpId(): ExternalOpId {
    this.#assertOpen();
    const opId = this.#identityFactory.newOpId();
    if (!isExternalOpId(opId)) {
      throw new RuntimeIdentityValidationError('invalid_legacy_identity_input', 'identityFactory.newOpId');
    }
    return opId;
  }

  submit(input: RuntimeOp): Promise<OpReceipt> {
    if (this.#state !== 'open') return Promise.reject(new RuntimeClosedError());
    const run = this.#submit(input);
    this.#inFlight.add(run);
    void run.finally(() => this.#inFlight.delete(run)).catch(() => undefined);
    return run;
  }

  events(options?: EventSubscriptionOptions): AsyncIterable<Readonly<EventEnvelope>> {
    this.#assertOpen();
    return this.#events.subscribe(options);
  }

  async listThreads(): Promise<readonly ThreadSummary[]> {
    this.#assertOpen();
    const persisted = await this.#workspace.listThreads();
    const result = persisted.map((item) => this.#threads.get(item.summary.threadId)?.summary()
      ?? recoverySummary(this.#unloaded.get(item.summary.threadId))
      ?? item.summary);
    return snapshot(result);
  }

  async getThreadSnapshot(threadId: ThreadId): Promise<Readonly<ThreadSnapshot> | undefined> {
    this.#assertOpen();
    assertThreadId(threadId, 'threadId');
    const attached = this.#threads.get(threadId)?.snapshot();
    if (attached !== undefined) return attached;
    const unloaded = this.#unloaded.get(threadId);
    return unloaded === undefined ? undefined : snapshotFromFold({
      ...unloaded,
      summary: recoverySummary(unloaded) ?? unloaded.summary,
    });
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#state = 'closing';
    this.#closeController.abort();
    this.#closePromise = this.#performClose();
    return this.#closePromise;
  }

  async #submit(input: RuntimeOp): Promise<OpReceipt> {
    const op = canonicalizeRuntimeOp(input);
    const payloadHash = runtimeOpPayloadHash(op);
    const existingFlight = this.#opFlights.get(op.opId);
    if (existingFlight !== undefined) {
      if (existingFlight.payloadHash !== payloadHash) {
        return { accepted: false, opId: op.opId, duplicate: false, reason: 'op_id_conflict' };
      }
      const receipt = await existingFlight.promise;
      return { ...receipt, duplicate: true };
    }
    if (this.#approvalFatal !== undefined) {
      const replay = await this.#replayOpWhileApprovalFatal(op, payloadHash);
      if (replay !== undefined) return replay;
      throw this.#approvalFatal;
    }
    const flight = this.#submitCanonical(op);
    this.#opFlights.set(op.opId, { payloadHash, promise: flight });
    try {
      return await flight;
    } finally {
      this.#opFlights.delete(op.opId);
    }
  }

  async #replayOpWhileApprovalFatal(
    op: Readonly<RuntimeOp>,
    payloadHash: string,
  ): Promise<OpReceipt | undefined> {
    const record = (await this.#workspace.loadSupervisorOps())
      .find((candidate) => candidate.opId === op.opId);
    if (record === undefined) return undefined;
    if (record.payloadHash !== payloadHash) {
      return { accepted: false, opId: op.opId, duplicate: false, reason: 'op_id_conflict' };
    }
    if (record.state === 'final') {
      if (record.receipt === undefined) throw new Error(`Final ledger op ${op.opId} has no receipt`);
      return { ...record.receipt, duplicate: true };
    }
    const recovered = this.#recoverSupervisorReceipt(record);
    return recovered === undefined ? undefined : { ...recovered, duplicate: true };
  }

  async #submitCanonical(op: Readonly<RuntimeOp>): Promise<OpReceipt> {
    const payloadHash = runtimeOpPayloadHash(op);
    const creationKey = op.type === 'thread_create'
      ? `create_${new Bun.CryptoHasher('sha256').update(canonicalJson([
          this.workspaceId,
          op.threadId,
          op.opId,
        ])).digest('hex')}`
      : undefined;
    const scopeFreeze = op.type === 'cancel_scope' && op.workspaceId === this.workspaceId
      ? this.#freezeScope(op)
      : undefined;
    const reservedRecord: SupervisorOpLedgerRecord = {
      opId: op.opId,
      op,
      payloadHash,
      ...(creationKey !== undefined && { driverCreation: { creationKey } }),
      ...(scopeFreeze !== undefined && {
        targetThreadIds: scopeFreeze.targetThreadIds,
        resolvedTargets: scopeFreeze.resolvedTargets,
      }),
      state: 'reserved',
    };
    const reservation = await this.#workspace.reserveSupervisorOp(this.#lease, reservedRecord);
    if (reservation.kind === 'conflict') {
      return { accepted: false, opId: op.opId, duplicate: false, reason: 'op_id_conflict' };
    }
    if (reservation.kind === 'duplicate' && reservation.record.state === 'final') {
      const receipt = reservation.record.receipt;
      if (receipt === undefined) throw new Error(`Final ledger op ${op.opId} has no receipt`);
      return { ...receipt, duplicate: true };
    }
    const ledgerRecord = reservation.record;
    if (reservation.kind === 'duplicate') {
      const recovered = this.#recoverSupervisorReceipt(ledgerRecord);
      if (recovered !== undefined) {
        await this.#workspace.finalizeSupervisorOp(
          this.#lease,
          this.#finalSupervisorRecord(ledgerRecord, recovered),
        );
        return { ...recovered, duplicate: true };
      }
    }

    let receipt: OpReceipt;
    if (op.workspaceId !== this.workspaceId) {
      receipt = { accepted: false, opId: op.opId, duplicate: false, reason: 'workspace_mismatch' };
    } else {
      switch (op.type) {
        case 'thread_create':
          receipt = await this.#createThread(op, ledgerRecord);
          break;
        case 'thread_resume':
          receipt = await this.#resumeThread(op);
          break;
        case 'cancel_scope':
          receipt = await this.#cancelScope(op, ledgerRecord);
          break;
        default:
          receipt = await this.#routeThreadOp(op);
          break;
      }
    }
    await this.#workspace.finalizeSupervisorOp(
      this.#lease,
      this.#finalSupervisorRecord(ledgerRecord, receipt),
    );
    return reservation.kind === 'duplicate' ? { ...receipt, duplicate: true } : receipt;
  }

  async #createThread(
    op: Extract<RuntimeOp, { type: 'thread_create' }>,
    ledger: SupervisorOpLedgerRecord,
  ): Promise<OpReceipt> {
    const existingClaim = this.#threadClaims.get(op.threadId);
    if (existingClaim !== undefined && existingClaim.opId !== op.opId) {
      return rejected(op, 'thread_already_exists');
    }
    if (this.#catalog.has(op.threadId) && existingClaim?.opId !== op.opId) {
      return rejected(op, 'thread_already_exists');
    }
    this.#threadClaims.set(op.threadId, { kind: 'create', opId: op.opId });
    const failBeforeSideEffect = (reason: string): OpReceipt => {
      const current = this.#threadClaims.get(op.threadId);
      if (current?.kind === 'create' && current.opId === op.opId) this.#threadClaims.delete(op.threadId);
      return rejected(op, reason);
    };
    let parent: ThreadMetaRecord | undefined;
    if (op.parentThreadId !== undefined) {
      if (op.parentThreadId === op.threadId) return failBeforeSideEffect('invalid_parent_thread');
      parent = this.#threadMeta.get(op.parentThreadId);
      if (parent === undefined) return failBeforeSideEffect('invalid_parent_thread');
      if (op.createdByRunId !== undefined) {
        const parentRuntime = this.#threads.get(op.parentThreadId);
        if (parentRuntime?.activeRunId() !== op.createdByRunId) return failBeforeSideEffect('stale_parent_run');
      }
    } else if (op.createdByRunId !== undefined) {
      return failBeforeSideEffect('invalid_parent_thread');
    }

    let model: Awaited<ReturnType<RuntimeModelResolver['resolve']>>;
    let ceiling: PermissionCeilingSnapshot;
    try {
      model = await this.#resolveModel(op.model, op.threadId, op.opId);
      if (!model.ok) return failBeforeSideEffect(model.code);
      const workspaceCeiling = await this.#workspaceCeiling();
      const permissionCeiling = parent === undefined
        ? await this.#permissionPolicy.resolveCeiling({
          kind: 'root_thread',
          workspaceId: this.workspaceId,
          threadId: op.threadId,
          workspaceCeiling,
          ...(op.permissionNarrowing !== undefined && { requestedNarrowing: op.permissionNarrowing }),
        })
      : await this.#permissionPolicy.resolveCeiling({
          kind: 'child_thread',
          workspaceId: this.workspaceId,
          threadId: op.threadId,
          parentThreadId: op.parentThreadId as ThreadId,
          ...(op.createdByRunId !== undefined && { parentRunId: op.createdByRunId }),
          workspaceCeiling,
          parentCeiling: op.createdByRunId === undefined
            ? parent.permissionCeiling
            : this.#threads.get(op.parentThreadId as ThreadId)?.activeRunCeiling(op.createdByRunId)
              ?? parent.permissionCeiling,
          ...(op.permissionNarrowing !== undefined && { requestedNarrowing: op.permissionNarrowing }),
          });
      ceiling = validatePermissionCeilingSnapshot(
        permissionCeiling,
        parent === undefined
          ? undefined
          : {
              parentThreadId: op.parentThreadId as ThreadId,
              ...(op.createdByRunId !== undefined && { parentRunId: op.createdByRunId }),
              parentCeilingRevision: (op.createdByRunId === undefined
                ? parent.permissionCeiling
                : this.#threads.get(op.parentThreadId as ThreadId)?.activeRunCeiling(op.createdByRunId)
                  ?? parent.permissionCeiling).revision,
            },
      );
    } catch (error) {
      this.#threadClaims.delete(op.threadId);
      throw error;
    }
    const host = new ThreadDriverHostController();
    const creationKey = ledger.driverCreation?.creationKey;
    if (creationKey === undefined) throw new Error('thread_create has no durable creation key');
    const attachment = await this.#driverFactory.create({
      workspaceId: this.workspaceId,
      threadId: op.threadId,
      model: model.model,
      permissionCeiling: ceiling,
      ...(op.parentThreadId !== undefined && { parentThreadId: op.parentThreadId }),
      creationKey,
      ...(this.#legacyApprovalPatterns !== undefined && {
        legacyApprovalPatterns: this.#legacyApprovalPatterns,
      }),
    }, host);
    let journal: ThreadJournalPort | undefined;
    let writer: ThreadJournalWriter | undefined;
    try {
      const meta = snapshot<ThreadMetaRecord>({
      type: 'thread_meta',
      version: 2,
      protocolVersion: '1.0.0',
      workspaceId: this.workspaceId,
      threadId: op.threadId,
      ...(op.parentThreadId !== undefined && { parentThreadId: op.parentThreadId }),
      ...(op.createdByRunId !== undefined && { createdByRunId: op.createdByRunId }),
      createdByOpId: op.opId,
      permissionCeiling: ceiling,
      createdAt: this.#clock.now(),
      cwd: this.#cwd,
      model: op.model,
      driverRef: attachment.durableRef,
    });
      journal = await this.#workspace.createThreadJournal(this.#lease, { threadId: op.threadId, meta });
      await journal.acquireWriteLease(this.#lease);
      const records = await journal.load();
      writer = new ThreadJournalWriter({
      workspaceId: this.workspaceId,
      threadId: op.threadId,
      journal,
      events: this.#events,
      clock: this.#clock,
      state: foldThreadJournal(records),
      records,
      });
      this.#events.registerThread(op.threadId);
      await this.#commitApprovalStartupDiagnostics(writer);
      const summary: ThreadSummary = {
      threadId: op.threadId,
      ...(op.parentThreadId !== undefined && { parentThreadId: op.parentThreadId }),
      createdAt: meta.createdAt,
      state: 'idle',
    };
      await writer.commit([
      { event: { type: 'op_accepted', opType: op.type }, opId: op.opId },
      { event: { type: 'thread_created', thread: summary }, opId: op.opId },
      { event: { type: 'op_completed', opType: op.type, outcome: 'applied' }, opId: op.opId },
    ], [
      { type: 'model_selected', ownerOpId: op.opId, model: op.model },
    ]);
      const runtime = new ThreadRuntime({
      workspaceId: this.workspaceId,
      cwd: this.#cwd,
      threadId: op.threadId,
      writer,
      attachment,
      identityFactory: this.#identityFactory,
      clock: this.#clock,
      permissionPolicy: this.#permissionPolicy,
      threadCeiling: ceiling,
      onThreadResultPending: (result) => this.#deliverThreadResult(result),
      onWorkspaceApprovalFatal: (error) => this.#latchApprovalFatal(error),
      workspaceApprovalFailure: () => this.#approvalFatal,
    });
      host.bind(runtime);
      await attachment.driver.recover([]);
      await attachment.driver.activate();
      this.#threads.set(op.threadId, runtime);
      const catalog: ThreadCatalogRecord = {
      summary,
      format: 'runtime-v2',
      storageKey: `runtime:${op.threadId}`,
      driverRef: attachment.durableRef,
    };
      this.#catalog.set(op.threadId, catalog);
      this.#threadMeta.set(op.threadId, meta);
      this.#threadClaims.set(op.threadId, { kind: 'attached', opId: op.opId });
      this.#attachmentLifecycleOps.set(op.threadId, op.opId);
      return { accepted: true, opId: op.opId, duplicate: false, threadId: op.threadId };
    } catch (error) {
      const failures: unknown[] = [error];
      try {
        await attachment.driver.close();
      } catch (closeError) {
        failures.push(closeError);
      }
      try {
        if (writer !== undefined) await writer.close();
        else await journal?.releaseWriteLease();
      } catch (closeError) {
        failures.push(closeError);
      }
      if (failures.length === 1) throw error;
      throw new AggregateError(failures, `Thread ${op.threadId} create cleanup failed`);
    }
  }

  async #resumeThread(op: Extract<RuntimeOp, { type: 'thread_resume' }>): Promise<OpReceipt> {
    // A thread_closed envelope is published before the runtime has released its journal lease and
    // before the Supervisor has moved the attachment into #unloaded. Reattachment must cross that
    // complete unload boundary instead of racing the stale entry in #threads.
    await this.#threadUnloadFlights.get(op.threadId);
    let catalog = this.#catalog.get(op.threadId);
    if (catalog === undefined) return rejected(op, 'thread_not_found');
    if (this.#threads.has(op.threadId)) return rejected(op, 'thread_already_attached');
    const existingClaim = this.#threadClaims.get(op.threadId);
    if (existingClaim?.kind === 'attach' && existingClaim.opId !== op.opId) {
      return rejected(op, 'thread_attach_in_progress');
    }
    if (existingClaim?.kind === 'attached') return rejected(op, 'thread_already_attached');
    this.#threadClaims.set(op.threadId, { kind: 'attach', opId: op.opId });
    const releaseAttach = (): void => {
      const current = this.#threadClaims.get(op.threadId);
      if (current?.kind === 'attach' && current.opId === op.opId) {
        this.#threadClaims.set(op.threadId, { kind: 'existing' });
      }
    };
    let model: Awaited<ReturnType<RuntimeModelResolver['resolve']>>;
    try {
      model = await this.#resolveModel(op.model, op.threadId, op.opId);
    } catch (error) {
      releaseAttach();
      throw error;
    }
    if (!model.ok) {
      releaseAttach();
      return rejected(op, model.code);
    }
    let journal = await this.#workspace.openThreadJournal(op.threadId);
    if (journal === undefined && catalog.format === 'session-v1') {
      const imported = await this.#workspace.importLegacyThread(this.#lease, op.threadId);
      if (imported === undefined) {
        releaseAttach();
        return rejected(op, 'thread_not_found');
      }
      const workspaceCeiling = await this.#workspaceCeiling();
      const permissionCeiling = validatePermissionCeilingSnapshot(await this.#permissionPolicy.resolveCeiling({
        kind: 'root_thread',
        workspaceId: this.workspaceId,
        threadId: op.threadId,
        workspaceCeiling,
      }));
      const meta = snapshot<ThreadMetaRecord>({
        type: 'thread_meta',
        version: 2,
        protocolVersion: '1.0.0',
        workspaceId: this.workspaceId,
        threadId: op.threadId,
        createdByOpId: op.opId,
        permissionCeiling,
        createdAt: imported.catalog.summary.createdAt,
        cwd: this.#cwd,
        model: op.model,
        driverRef: imported.driverRef,
      });
      journal = await this.#workspace.createThreadJournal(this.#lease, {
        threadId: op.threadId,
        meta,
        initialRecords: [imported.seed],
      });
      catalog = {
        summary: imported.catalog.summary,
        format: 'runtime-v2',
        storageKey: `runtime:${op.threadId}`,
        driverRef: imported.driverRef,
      };
      this.#catalog.set(op.threadId, catalog);
      this.#threadMeta.set(op.threadId, meta);
    }
    if (journal === undefined) {
      releaseAttach();
      return rejected(op, 'thread_not_found');
    }
    await journal.acquireWriteLease(this.#lease);
    let factoryStarted = false;
    let attachment: ThreadDriverAttachment | undefined;
    let writer: ThreadJournalWriter | undefined;
    try {
      const records = await journal.load();
      const state = foldThreadJournal(records);
      const host = new ThreadDriverHostController();
      const driverRef = catalog.driverRef ?? state.meta.driverRef;
      let expectedAttachmentCheckpoint = state.checkpoint;
      if (driverRef === undefined) {
        const createRecord = await this.#acceptedCreateRecord(op.threadId);
        if (createRecord === undefined) throw new Error('thread_driver_unavailable');
        expectedAttachmentCheckpoint = snapshot({
          ...state.checkpoint,
          frontend: {
            ...state.checkpoint.frontend,
            model: op.model,
          },
        });
        factoryStarted = true;
        const created = await this.#createAndBindRecoveredDriver({
          createRecord,
          model: model.model,
          state,
          expectedCheckpoint: expectedAttachmentCheckpoint,
          host,
          capture: (value) => { attachment = value; },
        });
        attachment = created.attachment;
        if (!created.checkpointMatches) {
          let safelyClosed = false;
          try {
            await attachment.driver.close();
            safelyClosed = true;
          } finally {
            if (safelyClosed) releaseAttach();
          }
          await journal.releaseWriteLease();
          return rejected(op, 'driver_checkpoint_mismatch');
        }
        catalog = this.#catalog.get(op.threadId) ?? { ...catalog, driverRef: attachment.durableRef };
      } else {
        factoryStarted = true;
        attachment = await this.#driverFactory.resume({
          workspaceId: this.workspaceId,
          threadId: op.threadId,
          model: model.model,
          durableRef: driverRef,
          permissionCeiling: state.meta.permissionCeiling,
          committedCheckpoint: state.checkpoint,
          usedRequestIds: snapshot([...state.usedRequestIds]),
          ...(this.#legacyApprovalPatterns !== undefined && {
            legacyApprovalPatterns: this.#legacyApprovalPatterns,
          }),
        }, host);
      }
      if (canonicalJson(attachment.initialCheckpoint) !== canonicalJson(expectedAttachmentCheckpoint)) {
        let safelyClosed = false;
        try {
          await attachment.driver.close();
          safelyClosed = true;
        } finally {
          if (safelyClosed) releaseAttach();
        }
        await journal.releaseWriteLease();
        return rejected(op, 'driver_checkpoint_mismatch');
      }
      writer = new ThreadJournalWriter({
        workspaceId: this.workspaceId,
        threadId: op.threadId,
        journal,
        events: this.#events,
        clock: this.#clock,
        state,
        records,
      });
      await this.#commitApprovalStartupDiagnostics(writer);
      const runtime = new ThreadRuntime({
        workspaceId: this.workspaceId,
        cwd: this.#cwd,
        threadId: op.threadId,
        writer,
        attachment,
        identityFactory: this.#identityFactory,
        clock: this.#clock,
        permissionPolicy: this.#permissionPolicy,
        threadCeiling: state.meta.permissionCeiling,
        onThreadResultPending: (result) => this.#deliverThreadResult(result),
        onWorkspaceApprovalFatal: (error) => this.#latchApprovalFatal(error),
        workspaceApprovalFailure: () => this.#approvalFatal,
      });
      host.bind(runtime);
      await this.#recoverQueueEffects(attachment.driver, writer);
      const recoveredState = writer.state;
      const summary: ThreadSummary = {
        ...recoveredState.summary,
        state: recoveredState.summary.suspendedWork?.length ? 'suspended' : 'idle',
      };
      const staleModelOps = [...recoveredState.mailbox.entries()].filter(([, entry]) =>
        entry.op.type === 'set_model'
        && (entry.state === 'accepted_pending' || entry.state === 'started'));
      const resumeEnvelopes: CommitEnvelopeInput[] = staleModelOps.map(([opId]) => ({
        event: { type: 'op_completed', opType: 'set_model', outcome: 'superseded' },
        opId,
      }));
      resumeEnvelopes.push(
        { event: { type: 'op_accepted', opType: op.type }, opId: op.opId },
        { event: { type: 'thread_resumed', thread: summary }, opId: op.opId },
        { event: { type: 'op_completed', opType: op.type, outcome: 'applied' }, opId: op.opId },
      );
      const resumeMutations: import('./ports.js').RuntimeThreadMutation[] = staleModelOps.map(([opId]) => ({
        type: 'completed',
        opId,
        outcome: 'superseded',
      }));
      resumeMutations.push(
        { type: 'model_selected', ownerOpId: op.opId, model: op.model },
      );
      await writer.commit(
        resumeEnvelopes as [CommitEnvelopeInput, ...CommitEnvelopeInput[]],
        resumeMutations,
      );
      await attachment.driver.activate();
      this.#threads.set(op.threadId, runtime);
      this.#threadClaims.set(op.threadId, { kind: 'attached', opId: op.opId });
      this.#attachmentLifecycleOps.set(op.threadId, op.opId);
      await this.#deliverPendingResultsForParent(op.threadId).catch(() => undefined);
      return { accepted: true, opId: op.opId, duplicate: false, threadId: op.threadId };
    } catch (error) {
      const failures: unknown[] = [error];
      let safelyClosed = false;
      if (attachment !== undefined) {
        try {
          await attachment.driver.close();
          safelyClosed = true;
        } catch (closeError) {
          failures.push(closeError);
        }
      }
      try {
        if (writer !== undefined) await writer.close();
        else await journal.releaseWriteLease();
      } catch (closeError) {
        failures.push(closeError);
      }
      if (!factoryStarted || safelyClosed) releaseAttach();
      if (failures.length === 1) throw error;
      throw new AggregateError(
        failures,
        `Thread ${op.threadId} resume cleanup failed: ${formatError(failures.at(-1))}`,
      );
    }
  }

  async #routeThreadOp(
    op: Exclude<RuntimeOp, { type: 'thread_create' | 'thread_resume' | 'cancel_scope' }>,
  ): Promise<OpReceipt> {
    const thread = this.#threads.get(op.threadId);
    if (thread === undefined) {
      if (!this.#catalog.has(op.threadId)) return rejected(op, 'thread_not_found');
      if (op.type === 'thread_close') {
        return this.#closeUnattached(op);
      }
      return rejected(op, 'thread_not_attached');
    }
    if (op.type === 'set_model') {
      const resolution = await this.#resolveModel(op.model, op.threadId, op.opId);
      if (!resolution.ok) return rejected(op, resolution.code);
      return thread.acceptExternal(op, { resolvedModel: resolution.model });
    }
    const receipt = await thread.acceptExternal(op);
    if (op.type === 'thread_close' && receipt.accepted) {
      // Defer close by one microtask so the unload flight is visible before thread_closed can be
      // published. A resume submitted from that event can then await lease release and cleanup.
      const unload = Promise.resolve().then(() => thread.close(op)).then(() => {
        if (this.#threads.get(op.threadId) !== thread) return;
        this.#threads.delete(op.threadId);
        this.#unloaded.set(op.threadId, thread.durableState());
        this.#attachmentLifecycleOps.delete(op.threadId);
        const catalog = this.#catalog.get(op.threadId);
        if (catalog !== undefined) {
          this.#catalog.set(op.threadId, { ...catalog, summary: { ...catalog.summary, state: 'closed' } });
        }
        this.#threadClaims.set(op.threadId, { kind: 'existing' });
      });
      this.#threadUnloadFlights.set(op.threadId, unload);
      this.#inFlight.add(unload);
      void unload.finally(() => {
        if (this.#threadUnloadFlights.get(op.threadId) === unload) {
          this.#threadUnloadFlights.delete(op.threadId);
        }
        this.#inFlight.delete(unload);
      }).catch(() => undefined);
    }
    return receipt;
  }

  async #closeUnattached(op: Extract<RuntimeOp, { type: 'thread_close' }>): Promise<OpReceipt> {
    const catalog = this.#catalog.get(op.threadId);
    if (catalog === undefined) return rejected(op, 'thread_not_found');
    if (catalog.summary.state !== 'closed') {
      this.#catalog.set(op.threadId, { ...catalog, summary: { ...catalog.summary, state: 'closed' } });
    }
    const unloaded = this.#unloaded.get(op.threadId);
    if (unloaded !== undefined) {
      this.#unloaded.set(op.threadId, {
        ...unloaded,
        summary: withoutActiveRunSummary(unloaded.summary, 'closed'),
      });
    }
    this.#threadClaims.set(op.threadId, { kind: 'existing' });
    return { accepted: true, opId: op.opId, duplicate: false, threadId: op.threadId };
  }

  async #recoverQueueEffects(
    driver: ThreadDriverPort,
    writer: ThreadJournalWriter,
  ): Promise<void> {
    const candidates: Array<{
      readonly opId: OpId;
      readonly op: Extract<import('../protocol/index.js').MailboxRuntimeOp, { type: 'steer' | 'follow_up' }>;
      readonly state: 'accepted_pending' | 'started';
    }> = [];
    for (const [opId, entry] of writer.state.mailbox) {
      if ((entry.op.type === 'steer' || entry.op.type === 'follow_up')
        && (entry.state === 'accepted_pending' || entry.state === 'started')) {
        candidates.push({ opId, op: entry.op, state: entry.state });
      }
    }
    const startEnvelopes: CommitEnvelopeInput[] = [];
    const startMutations: import('./ports.js').RuntimeThreadMutation[] = [];
    for (const { opId, op: queueOp, state } of candidates) {
      if (state !== 'accepted_pending') continue;
      startEnvelopes.push({ event: { type: 'op_started', opType: queueOp.type }, opId });
      startMutations.push({ type: 'started', opId });
    }
    if (startEnvelopes.length > 0) {
      await writer.commit(
        startEnvelopes as [CommitEnvelopeInput, ...CommitEnvelopeInput[]],
        startMutations,
      );
    }

    const commands: RecoveryQueueCommand[] = [];
    const noOpIds = new Set<OpId>();
    for (const { opId, op: queueOp } of candidates) {
      const effectCommitted = writer.state.envelopes.some((envelope) =>
        envelope.opId === opId && envelope.event.type === 'queue_update');
      if (effectCommitted) continue;
      if (queueOp.text.trim().length === 0) {
        noOpIds.add(opId);
      } else {
        commands.push({ op: queueOp });
      }
    }
    await driver.recover(snapshot(commands));

    const completionEnvelopes: CommitEnvelopeInput[] = [];
    const completionMutations: import('./ports.js').RuntimeThreadMutation[] = [];
    for (const { opId, op: queueOp } of candidates) {
      const effectCommitted = writer.state.envelopes.some((envelope) =>
        envelope.opId === opId && envelope.event.type === 'queue_update');
      if (!effectCommitted && !noOpIds.has(opId)) {
        throw new RuntimeStorageError('queue_recovery_effect_missing', opId);
      }
      const outcome = noOpIds.has(opId) ? 'no_op' as const : 'applied' as const;
      completionEnvelopes.push({
        event: { type: 'op_completed', opType: queueOp.type, outcome },
        opId,
      });
      completionMutations.push({ type: 'completed', opId, outcome });
    }
    if (completionEnvelopes.length > 0) {
      await writer.commit(
        completionEnvelopes as [CommitEnvelopeInput, ...CommitEnvelopeInput[]],
        completionMutations,
      );
    }
  }

  async #recoverThreadResultOutbox(): Promise<void> {
    for (const state of this.#unloaded.values()) {
      for (const result of state.pendingThreadResults.values()) {
        if (!state.deliveredThreadResults.has(result.resultOpId)) {
          await this.#deliverThreadResult(result);
        }
      }
    }
  }

  #restoreReservedLifecycleClaims(records: readonly SupervisorOpLedgerRecord[]): void {
    for (const record of records) {
      if (record.state !== 'reserved') continue;
      if (record.op.type === 'thread_create') {
        const current = this.#threadClaims.get(record.op.threadId);
        if (current === undefined || current.kind === 'existing') {
          this.#threadClaims.set(record.op.threadId, { kind: 'create', opId: record.op.opId });
        }
      } else if (record.op.type === 'thread_resume' && this.#catalog.has(record.op.threadId)) {
        const current = this.#threadClaims.get(record.op.threadId);
        if (current === undefined || current.kind === 'existing') {
          this.#threadClaims.set(record.op.threadId, { kind: 'attach', opId: record.op.opId });
        }
      }
    }
  }

  async #recoverReservedLifecycleAndScope(
    records: readonly SupervisorOpLedgerRecord[],
  ): Promise<void> {
    for (const record of records) {
      if (record.state !== 'reserved') continue;
      if (record.op.type !== 'thread_create'
        && record.op.type !== 'thread_resume'
        && record.op.type !== 'cancel_scope') continue;
      await this.#submitCanonical(record.op);
    }
  }

  async #recoverAcceptedAttachments(records: readonly SupervisorOpLedgerRecord[]): Promise<void> {
    const latest = new Map<ThreadId, SupervisorOpLedgerRecord>();
    for (const record of records) {
      if (record.state !== 'final' || record.receipt?.accepted !== true) continue;
      if (record.op.type === 'thread_create'
        || record.op.type === 'thread_resume'
        || record.op.type === 'thread_close') {
        latest.set(record.op.threadId, record);
      }
    }
    for (const [threadId, record] of latest) {
      if (record.op.type === 'thread_close' || this.#threads.has(threadId)) continue;
      const catalog = this.#catalog.get(threadId);
      if (catalog === undefined || this.#unloaded.get(threadId)?.summary.state === 'closed') continue;
      await this.#recoverAcceptedAttachment(record, catalog);
    }
  }

  async #acceptedCreateRecord(threadId: ThreadId): Promise<SupervisorOpLedgerRecord | undefined> {
    const records = await this.#workspace.loadSupervisorOps();
    return records.findLast((record) =>
      record.state === 'final'
      && record.receipt?.accepted === true
      && record.op.type === 'thread_create'
      && record.op.threadId === threadId);
  }

  async #createAndBindRecoveredDriver(input: {
    readonly createRecord: SupervisorOpLedgerRecord;
    readonly model: ModelConfig;
    readonly state: FoldedThreadJournal;
    readonly expectedCheckpoint: import('./ports.js').ThreadDriverCheckpoint;
    readonly host: ThreadDriverHostController;
    readonly capture: (attachment: ThreadDriverAttachment) => void;
  }): Promise<{ readonly attachment: ThreadDriverAttachment; readonly checkpointMatches: boolean }> {
    const createOp = input.createRecord.op;
    if (createOp.type !== 'thread_create') {
      throw new RuntimeStorageError('invalid_supervisor_op', 'Driver binding record is not thread_create');
    }
    const creationKey = input.createRecord.driverCreation?.creationKey;
    if (creationKey === undefined) {
      throw new RuntimeStorageError(
        'thread_driver_unavailable',
        `Accepted create has no creation key: ${createOp.threadId}`,
      );
    }
    const attachment = await this.#driverFactory.create({
      workspaceId: this.workspaceId,
      threadId: createOp.threadId,
      model: input.model,
      permissionCeiling: input.state.meta.permissionCeiling,
      ...(input.state.meta.parentThreadId !== undefined && {
        parentThreadId: input.state.meta.parentThreadId,
      }),
      creationKey,
      ...(this.#legacyApprovalPatterns !== undefined && {
        legacyApprovalPatterns: this.#legacyApprovalPatterns,
      }),
    }, input.host);
    input.capture(attachment);
    if (canonicalJson(attachment.initialCheckpoint) !== canonicalJson(input.expectedCheckpoint)) {
      return { attachment, checkpointMatches: false };
    }
    const receipt = input.createRecord.receipt;
    if (receipt === undefined) {
      throw new RuntimeStorageError('invalid_supervisor_final', `Accepted create has no receipt: ${createOp.opId}`);
    }
    await this.#workspace.finalizeSupervisorOp(this.#lease, {
      ...input.createRecord,
      driverCreation: { creationKey, driverRef: attachment.durableRef },
      state: 'final',
      receipt,
    });
    const catalog = this.#catalog.get(createOp.threadId);
    if (catalog !== undefined) {
      this.#catalog.set(createOp.threadId, { ...catalog, driverRef: attachment.durableRef });
    }
    return { attachment, checkpointMatches: true };
  }

  async #recoverAcceptedAttachment(
    record: SupervisorOpLedgerRecord,
    catalog: ThreadCatalogRecord,
  ): Promise<void> {
    const op = record.op;
    if (op.type !== 'thread_create' && op.type !== 'thread_resume') return;
    const journal = await this.#workspace.openThreadJournal(op.threadId);
    if (journal === undefined) {
      throw new RuntimeStorageError('thread_not_found', `Accepted attachment has no journal: ${op.threadId}`);
    }
    await journal.acquireWriteLease(this.#lease);
    let writer: ThreadJournalWriter | undefined;
    let attachment: ThreadDriverAttachment | undefined;
    try {
      const records = await journal.load();
      const state = foldThreadJournal(records);
      const resolution = await this.#resolveModel(
        state.checkpoint.frontend.model,
        op.threadId,
        op.opId,
      );
      writer = new ThreadJournalWriter({
        workspaceId: this.workspaceId,
        threadId: op.threadId,
        journal,
        events: this.#events,
        clock: this.#clock,
        state,
        records,
      });
      await this.#commitApprovalStartupDiagnostics(writer);
      if (!resolution.ok) {
        await writer.commit([{
          event: {
            type: 'runtime_diagnostic',
            severity: 'warning',
            code: `attachment_${resolution.code}`,
            message: resolution.message,
            scope: 'thread',
          },
        }]);
        const interrupted = withAttachmentRecoveryOverlay(writer.state);
        this.#unloaded.set(op.threadId, interrupted);
        this.#catalog.set(op.threadId, {
          ...catalog,
          summary: withoutActiveRunSummary(interrupted.summary, 'closed'),
        });
        this.#threadClaims.set(op.threadId, { kind: 'existing' });
        await writer.close();
        return;
      }

      const host = new ThreadDriverHostController();
      let driverRef = catalog.driverRef ?? state.meta.driverRef ?? record.driverCreation?.driverRef;
      if (driverRef === undefined) {
        const createRecord = op.type === 'thread_create' ? record : await this.#acceptedCreateRecord(op.threadId);
        if (createRecord === undefined) {
          throw new RuntimeStorageError(
            'thread_driver_unavailable',
            `Accepted attachment has no create binding: ${op.threadId}`,
          );
        }
        const created = await this.#createAndBindRecoveredDriver({
          createRecord,
          model: resolution.model,
          state,
          expectedCheckpoint: state.checkpoint,
          host,
          capture: (value) => { attachment = value; },
        });
        attachment = created.attachment;
        if (!created.checkpointMatches) {
          throw new RuntimeStorageError(
            'driver_checkpoint_mismatch',
            `Recovered driver differs from committed attachment ${op.threadId}`,
          );
        }
        driverRef = attachment.durableRef;
        catalog = this.#catalog.get(op.threadId) ?? { ...catalog, driverRef };
      } else {
        attachment = await this.#driverFactory.resume({
          workspaceId: this.workspaceId,
          threadId: op.threadId,
          model: resolution.model,
          durableRef: driverRef,
          permissionCeiling: state.meta.permissionCeiling,
          committedCheckpoint: state.checkpoint,
          usedRequestIds: snapshot([...state.usedRequestIds]),
          ...(this.#legacyApprovalPatterns !== undefined && {
            legacyApprovalPatterns: this.#legacyApprovalPatterns,
          }),
        }, host);
      }
      if (canonicalJson(attachment.durableRef) !== canonicalJson(driverRef)
        || canonicalJson(attachment.initialCheckpoint) !== canonicalJson(state.checkpoint)) {
        throw new RuntimeStorageError(
          'driver_checkpoint_mismatch',
          `Recovered driver differs from committed attachment ${op.threadId}`,
        );
      }
      const runtime = new ThreadRuntime({
        workspaceId: this.workspaceId,
        cwd: this.#cwd,
        threadId: op.threadId,
        writer,
        attachment,
        identityFactory: this.#identityFactory,
        clock: this.#clock,
        permissionPolicy: this.#permissionPolicy,
        threadCeiling: state.meta.permissionCeiling,
        onThreadResultPending: (result) => this.#deliverThreadResult(result),
        onWorkspaceApprovalFatal: (error) => this.#latchApprovalFatal(error),
        workspaceApprovalFailure: () => this.#approvalFatal,
      });
      host.bind(runtime);
      await this.#recoverQueueEffects(attachment.driver, writer);
      await attachment.driver.activate();
      this.#threads.set(op.threadId, runtime);
      this.#threadClaims.set(op.threadId, { kind: 'attached', opId: op.opId });
      this.#attachmentLifecycleOps.set(op.threadId, op.opId);
      this.#unloaded.delete(op.threadId);
      await this.#deliverPendingResultsForParent(op.threadId).catch(() => undefined);
    } catch (error) {
      const failures: unknown[] = [error];
      if (attachment !== undefined) {
        try {
          await attachment.driver.close();
        } catch (closeError) {
          failures.push(closeError);
        }
      }
      try {
        if (writer !== undefined) await writer.close();
        else await journal.releaseWriteLease();
      } catch (closeError) {
        failures.push(closeError);
      }
      if (failures.length === 1) throw error;
      throw new AggregateError(
        failures,
        `Thread ${op.threadId} recovery cleanup failed: ${formatError(failures.at(-1))}`,
      );
    }
  }

  async #deliverPendingResultsForParent(parentThreadId: ThreadId): Promise<void> {
    const pending = [...this.#unloaded.values()].flatMap((state) =>
      [...state.pendingThreadResults.values()].filter((result) =>
        result.parentThreadId === parentThreadId
        && !state.deliveredThreadResults.has(result.resultOpId)));
    for (const result of pending) await this.#deliverThreadResult(result);
  }

  async #deliverThreadResult(
    result: ThreadResultOutboxMutation,
    allowClosing = false,
  ): Promise<void> {
    if (this.#state !== 'open' && !(allowClosing && this.#state === 'closing')) return;
    const claim = await this.#workspace.reserveDerivedOpIdentity(this.#lease, {
      opId: result.resultOpId,
      purpose: 'thread_result',
      workspaceId: this.workspaceId,
      parts: [result.parentThreadId, result.childThreadId, result.terminalRunId],
    });
    if (claim.kind === 'conflict') throw new RuntimeStorageError(
      'derived_op_identity_conflict',
      `Conflicting child result identity ${result.resultOpId}`,
    );

    const parent = this.#threads.get(result.parentThreadId);
    let parentCommitSeq: number | undefined;
    if (parent !== undefined) {
      parentCommitSeq = await parent.commitThreadResult(result);
    } else {
      const parentState = this.#unloaded.get(result.parentThreadId);
      const envelope = parentState?.envelopes.find((candidate) => candidate.opId === result.resultOpId);
      if (envelope !== undefined) {
        if (envelope.event.type !== 'thread_result'
          || canonicalJson(envelope.event) !== canonicalJson(threadResultEvent(result))) {
          throw new RuntimeStorageError('thread_result_conflict', result.resultOpId);
        }
        parentCommitSeq = envelope.seq;
      }
    }
    if (parentCommitSeq === undefined) return;
    if (this.#state !== 'open' && !(allowClosing && this.#state === 'closing')) return;
    await this.#acknowledgeThreadResult({
      type: 'thread_result_delivered',
      resultOpId: result.resultOpId,
      parentThreadId: result.parentThreadId,
      parentCommitSeq,
    }, result.childThreadId);
  }

  async #acknowledgeThreadResult(
    record: ThreadResultDeliveryRecord,
    childThreadId: ThreadId,
  ): Promise<void> {
    const attached = this.#threads.get(childThreadId);
    if (attached !== undefined) {
      await attached.acknowledgeThreadResult(record);
      return;
    }
    const known = this.#unloaded.get(childThreadId);
    if (known?.deliveredThreadResults.has(record.resultOpId)) return;
    const journal = await this.#workspace.openThreadJournal(childThreadId);
    if (journal === undefined) throw new RuntimeStorageError('thread_result_child_missing', childThreadId);
    await journal.acquireWriteLease(this.#lease);
    const records = await journal.load();
    const writer = new ThreadJournalWriter({
      workspaceId: this.workspaceId,
      threadId: childThreadId,
      journal,
      events: this.#events,
      clock: this.#clock,
      state: foldThreadJournal(records),
      records,
    });
    try {
      if (!writer.state.deliveredThreadResults.has(record.resultOpId)) {
        await writer.appendPrepare(record);
      }
      this.#unloaded.set(childThreadId, writer.state);
    } finally {
      await writer.close();
    }
  }

  #applyLifecycleLedger(records: readonly SupervisorOpLedgerRecord[]): void {
    const latest = new Map<ThreadId, SupervisorOpLedgerRecord>();
    for (const record of records) {
      if (record.state !== 'final' || record.receipt?.accepted !== true) continue;
      if (record.op.type === 'thread_create'
        || record.op.type === 'thread_resume'
        || record.op.type === 'thread_close') {
        latest.set(record.op.threadId, record);
      }
    }
    for (const [threadId, record] of latest) {
      if (record.op.type !== 'thread_close') continue;
      const unloaded = this.#unloaded.get(threadId);
      if (unloaded !== undefined) {
        this.#unloaded.set(threadId, {
          ...unloaded,
          summary: withoutActiveRunSummary(unloaded.summary, 'closed'),
        });
      }
      const catalog = this.#catalog.get(threadId);
      if (catalog !== undefined) {
        this.#catalog.set(threadId, {
          ...catalog,
          summary: withoutActiveRunSummary(catalog.summary, 'closed'),
        });
      }
    }
  }

  async #cancelScope(
    op: Extract<RuntimeOp, { type: 'cancel_scope' }>,
    ledger: SupervisorOpLedgerRecord,
  ): Promise<OpReceipt> {
    if (op.scope === 'subtree' && (op.rootThreadId === undefined || !this.#catalog.has(op.rootThreadId))) {
      return rejected(op, 'thread_not_found');
    }
    const targets = [...(ledger.targetThreadIds ?? [])];
    const resolvedByThread = new Map(
      (ledger.resolvedTargets ?? []).map((item) => [item.threadId, item] as const),
    );
    const failures: ThreadId[] = [];
    await Promise.all(targets.map(async (threadId) => {
      const frozen = resolvedByThread.get(threadId);
      if (frozen === undefined) throw new Error('scope target was not durably resolved');
      const derivedOpId = frozen.derivedOpId;
      if (!isDerivedOpId(derivedOpId)) throw new Error('identity_factory_invalid_derived_op');
      const claim = await this.#workspace.reserveDerivedOpIdentity(this.#lease, {
        opId: derivedOpId,
        purpose: 'cancel_target',
        workspaceId: this.workspaceId,
        parts: [op.opId, threadId],
      });
      if (claim.kind === 'conflict') throw new Error('derived_op_identity_conflict');
      try {
        const derived = {
          type: 'abort',
          opId: derivedOpId,
          workspaceId: this.workspaceId,
          threadId,
          parentOpId: op.opId,
          resolvedTarget: frozen.target,
        } as const;
        const thread = this.#threads.get(threadId);
        if (thread === undefined) await this.#acceptUnloadedAbort(derived);
        else await thread.acceptInternal(derived);
      } catch {
        failures.push(threadId);
      }
    }));
    if (failures.length > 0) throw new RuntimeScopeDispatchError(op.opId, failures);
    return {
      accepted: true,
      opId: op.opId,
      duplicate: false,
      targetThreadIds: targets,
    };
  }

  #freezeScope(op: Extract<RuntimeOp, { type: 'cancel_scope' }>): {
    readonly targetThreadIds: readonly ThreadId[];
    readonly resolvedTargets: readonly {
      readonly threadId: ThreadId;
      readonly target: import('../protocol/index.js').ResolvedAbortTarget;
      readonly derivedOpId: DerivedOpId;
    }[];
  } {
    const targetThreadIds = op.scope === 'workspace'
      ? [...this.#catalog.keys()]
      : op.rootThreadId !== undefined && this.#catalog.has(op.rootThreadId)
        ? collectSubtree(op.rootThreadId, this.#threadMeta)
        : [];
    const resolvedTargets = targetThreadIds.map((threadId) => {
      const target = this.#threads.get(threadId)?.currentAbortTarget()
        ?? abortTargetFromFold(this.#unloaded.get(threadId));
      const derivedOpId = this.#identityFactory.deriveOpId({
        purpose: 'cancel_target',
        workspaceId: this.workspaceId,
        parts: [op.opId, threadId],
      });
      if (!isDerivedOpId(derivedOpId)) throw new Error('identity_factory_invalid_derived_op');
      return {
        threadId,
        target,
        derivedOpId,
      };
    });
    return snapshot({ targetThreadIds, resolvedTargets });
  }

  async #acceptUnloadedAbort(
    op: Extract<import('../protocol/index.js').InternalThreadRuntimeOp, { type: 'abort' }>,
  ): Promise<void> {
    const journal = await this.#workspace.openThreadJournal(op.threadId);
    if (journal === undefined) throw new Error(`Missing journal for scope target ${op.threadId}`);
    await journal.acquireWriteLease(this.#lease);
    const records = await journal.load();
    const state = foldThreadJournal(records);
    const existing = state.mailbox.get(op.opId);
    if (existing !== undefined) {
      if (canonicalJson(existing.op) !== canonicalJson(op)) {
        await journal.releaseWriteLease();
        throw new RuntimeStorageError('op_id_conflict', `Conflicting internal OpId ${op.opId}`);
      }
      await journal.releaseWriteLease();
      return;
    }
    const writer = new ThreadJournalWriter({
      workspaceId: this.workspaceId,
      threadId: op.threadId,
      journal,
      events: this.#events,
      clock: this.#clock,
      state,
      records,
    });
    try {
      await writer.appendPrepare({
        type: 'mailbox_prepare',
        opId: op.opId,
        op,
        timestamp: this.#clock.now(),
      });
      await writer.commit([
        { event: { type: 'op_accepted', opType: 'abort', parentOpId: op.parentOpId }, opId: op.opId },
        { event: { type: 'op_started', opType: 'abort', parentOpId: op.parentOpId }, opId: op.opId },
      ], [{
        type: 'accepted_pending',
        opId: op.opId,
        opType: 'abort',
        resolvedTarget: op.resolvedTarget,
        parentOpId: op.parentOpId,
      }, { type: 'started', opId: op.opId }]);
      if (op.resolvedTarget.kind === 'suspended') {
        const target = op.resolvedTarget;
        const owner = writer.state.mailbox.get(target.ownerOpId);
        const root = [...writer.state.runs.values()].find((run) => run.ownerOpId === target.ownerOpId);
        const terminal = writer.state.runs.get(target.terminalRunId);
        const finishOwner = owner !== undefined && root !== undefined
          && owner.state !== 'completed' && owner.state !== 'rejected'
          && (owner.op.type === 'prompt' || owner.op.type === 'continue');
        const mutations: import('./ports.js').RuntimeThreadMutation[] = [];
        if (finishOwner) {
          mutations.push({ type: 'completed', opId: target.ownerOpId, outcome: 'interrupted' });
          if (terminal !== undefined && terminal.state !== 'terminal' && terminal.state !== 'prepared') {
            mutations.push({ type: 'run_terminal', runId: terminal.runId, status: 'aborted' });
          }
        }
        if (target.inputOwnerOpId !== undefined && writer.state.inputOwners.has(target.inputOwnerOpId)) {
          mutations.push({
            type: 'input_cancelled',
            ownerOpId: target.inputOwnerOpId,
            byAbortOpId: op.opId,
          });
        }
        mutations.push({ type: 'completed', opId: op.opId, outcome: 'applied' });
        if (finishOwner && root !== undefined && (owner.op.type === 'prompt' || owner.op.type === 'continue')) {
          await writer.commit([
            {
              event: {
                type: 'op_completed',
                opType: owner.op.type,
                terminalRunId: target.terminalRunId,
                outcome: 'interrupted',
              },
              opId: target.ownerOpId,
              runId: root.runId,
            },
            {
              event: { type: 'op_completed', opType: 'abort', outcome: 'applied', parentOpId: op.parentOpId },
              opId: op.opId,
            },
          ], mutations);
        } else {
          await writer.commit([{
            event: { type: 'op_completed', opType: 'abort', outcome: 'applied', parentOpId: op.parentOpId },
            opId: op.opId,
          }], mutations);
        }
      } else {
        await writer.commit([{
          event: { type: 'op_completed', opType: 'abort', outcome: 'no_op', parentOpId: op.parentOpId },
          opId: op.opId,
        }], [{ type: 'completed', opId: op.opId, outcome: 'no_op' }]);
      }
      this.#unloaded.set(op.threadId, writer.state);
      const catalog = this.#catalog.get(op.threadId);
      if (catalog !== undefined) this.#catalog.set(op.threadId, { ...catalog, summary: writer.state.summary });
    } finally {
      await writer.close();
    }
  }

  async #recoverLegacyApprovalResponse(
    writer: ThreadJournalWriter,
    response: Extract<RuntimeOp, { type: 'control_response' }>,
    request: Extract<RuntimeEvent, { type: 'control_request'; kind: 'approval' }>,
    state: 'accepted_pending' | 'started',
  ): Promise<void> {
    const repository = this.#legacyApprovalPatterns;
    const openAdapter = this.#driverFactory.openLegacyApprovalAdapter;
    if (repository === undefined || openAdapter === undefined) {
      throw new RuntimeStorageError(
        'legacy_approval_recovery_unavailable',
        'Durable legacy approval recovery requires a fenced repository and static adapter',
      );
    }
    if (state === 'accepted_pending') {
      await writer.commit([{
        event: { type: 'op_started', opType: 'control_response' },
        opId: response.opId,
      }], [{ type: 'started', opId: response.opId }]);
    }
    const claim = writer.state.controlClaims.get(request.requestId);
    if (claim === undefined || claim.responseOpId !== response.opId) {
      throw new RuntimeStorageError('legacy_approval_claim_missing', request.requestId);
    }
    const proposal = request.payload.legacyProposal;
    if (proposal === undefined) {
      throw new RuntimeStorageError('legacy_approval_proposal_missing', request.requestId);
    }
    const adapter = await openAdapter.call(this.#driverFactory, {
      workspaceId: this.workspaceId,
      threadId: writer.state.meta.threadId,
      patterns: repository,
    });
    let result: Awaited<ReturnType<typeof adapter.applyResponse>>;
    try {
      result = await adapter.applyResponse({
        request: snapshot({
          workspaceId: this.workspaceId,
          threadId: writer.state.meta.threadId,
          requestId: request.requestId,
          owningRunId: request.owningRunId,
          owningTurnId: request.owningTurnId,
          toolCallId: request.payload.toolCallId,
          description: request.payload.description,
          policyRevision: request.policyRevision,
          proposal,
        }),
        responseOpId: response.opId,
        acceptedAt: claim.acceptedAt,
        decision: 'allow_always',
      });
    } catch (error) {
      const failure = new RuntimeStorageError(
        'legacy_approval_unknown_outcome',
        error instanceof Error ? error.message : String(error),
      );
      this.#latchApprovalFatal(failure);
      throw failure;
    } finally {
      await adapter.close().catch(() => undefined);
    }
    if (!result.ok) {
      if (result.code === 'legacy_approval_definitely_not_applied') {
        const resolutionOpId = this.#identityFactory.deriveOpId({
          purpose: 'control_recovery',
          workspaceId: this.workspaceId,
          parts: [writer.state.meta.threadId, request.requestId],
        });
        if (!isDerivedOpId(resolutionOpId)) throw new Error('identity_factory_invalid_derived_op');
        const claim = await this.#workspace.reserveDerivedOpIdentity(this.#lease, {
          opId: resolutionOpId,
          purpose: 'control_recovery',
          workspaceId: this.workspaceId,
          parts: [writer.state.meta.threadId, request.requestId],
        });
        if (claim.kind === 'conflict') throw new Error('derived_op_identity_conflict');
        const resolution: Extract<RuntimeEvent, { type: 'control_resolved' }> = {
          type: 'control_resolved',
          requestId: request.requestId,
          kind: request.kind,
          owningRunId: request.owningRunId,
          owningTurnId: request.owningTurnId,
          policyRevision: request.policyRevision,
          decision: 'aborted',
        };
        await writer.commit([
          {
            event: resolution,
            runId: request.owningRunId,
            turnId: request.owningTurnId,
            opId: resolutionOpId,
          },
          {
            event: { type: 'op_completed', opType: 'control_response', outcome: 'interrupted' },
            opId: response.opId,
          },
          {
            event: {
              type: 'runtime_diagnostic',
              severity: 'warning',
              code: result.code,
              message: result.message,
              scope: 'thread',
            },
          },
        ], [
          { type: 'control_resolved', resolution },
          { type: 'completed', opId: response.opId, outcome: 'interrupted' },
          {
            type: 'control_response_claim_released',
            requestId: request.requestId,
            responseOpId: response.opId,
            reason: 'effect_definitely_not_applied',
          },
        ]);
        return;
      }
      const failure = new RuntimeStorageError(result.code, result.message);
      this.#latchApprovalFatal(failure);
      throw failure;
    }
    const resolution: Extract<RuntimeEvent, { type: 'control_resolved'; kind: 'approval' }> = {
      type: 'control_resolved',
      requestId: request.requestId,
      kind: 'approval',
      owningRunId: request.owningRunId,
      owningTurnId: request.owningTurnId,
      policyRevision: request.policyRevision,
      decision: result.effectiveDecision,
      ...(result.effectiveDecision !== 'allow_always' && {
        requestedDecision: 'allow_always',
      }),
    };
    try {
      await writer.commit([
        {
          event: resolution,
          runId: request.owningRunId,
          turnId: request.owningTurnId,
          opId: response.opId,
        },
        {
          event: { type: 'op_completed', opType: 'control_response', outcome: 'applied' },
          opId: response.opId,
        },
      ], [
        { type: 'control_resolved', resolution },
        { type: 'completed', opId: response.opId, outcome: 'applied' },
      ]);
    } catch (error) {
      const failure = new RuntimeStorageError(
        'legacy_approval_unknown_outcome',
        error instanceof Error ? error.message : String(error),
      );
      this.#latchApprovalFatal(failure);
      throw failure;
    }
  }

  async #recoverUnloadedJournal(
    threadId: ThreadId,
    journal: import('./ports.js').ThreadJournalPort,
    initialRecords: readonly RuntimeJournalRecord[],
  ): Promise<FoldedThreadJournal> {
    let state = foldThreadJournal(initialRecords);
    const recoverable = [...state.mailbox.entries()].filter(([, entry]) =>
      entry.state === 'prepared'
      || (entry.state === 'accepted_pending'
        && (entry.op.type === 'prompt' || entry.op.type === 'continue'))
      || (entry.state === 'started'
        && entry.op.type !== 'set_model'
        && entry.op.type !== 'steer'
        && entry.op.type !== 'follow_up')
      || (entry.state === 'accepted_pending' && entry.op.type === 'control_response'));
    if (recoverable.length === 0) return state;
    await journal.acquireWriteLease(this.#lease);
    const records = await journal.load();
    state = foldThreadJournal(records);
    const writer = new ThreadJournalWriter({
      workspaceId: this.workspaceId,
      threadId,
      journal,
      events: this.#events,
      clock: this.#clock,
      state,
      records,
    });
    try {
      for (const [opId, entry] of state.mailbox) {
        if (entry.state === 'prepared') {
          const parentOpId = 'parentOpId' in entry.op ? entry.op.parentOpId : undefined;
          await writer.commit([{
            event: {
              type: 'op_rejected',
              opType: entry.op.type,
              reason: 'interrupted_before_accept',
              ...(parentOpId !== undefined && { parentOpId }),
            },
            opId,
          }], [{ type: 'rejected', opId, reason: 'interrupted_before_accept' }]);
          continue;
        }
        if ((entry.state === 'accepted_pending' || entry.state === 'started')
          && entry.op.type === 'control_response') {
          const response = entry.op;
          const pendingRequest = writer.state.checkpoint.frontend.pendingControls
            .find((candidate) => candidate.requestId === response.requestId);
          const historicalRequest = writer.state.envelopes.find((envelope) =>
            envelope.event.type === 'control_request'
            && envelope.event.requestId === response.requestId);
          const committedResolution = writer.state.envelopes.findLast((envelope) =>
            envelope.event.type === 'control_resolved'
            && envelope.event.requestId === response.requestId);
          const request = pendingRequest
            ?? (historicalRequest?.event.type === 'control_request' ? historicalRequest.event : undefined);
          if (request === undefined) {
            throw new RuntimeStorageError('control_request_not_found', response.requestId);
          }
          if (committedResolution?.event.type === 'control_resolved') {
            const outcome = committedResolution.opId === response.opId
              && committedResolution.event.decision !== 'aborted'
              ? 'applied' as const
              : 'interrupted' as const;
            await writer.commit([{
              event: { type: 'op_completed', opType: 'control_response', outcome },
              opId,
            }], [{ type: 'completed', opId, outcome }]);
            continue;
          }
          if (
            pendingRequest?.kind === 'approval'
            && pendingRequest.payload.legacyProposal !== undefined
            && response.decision === 'allow_always'
            && !pendingRequest.payload.legacyProposal.forceConfirm
            && pendingRequest.payload.legacyProposal.patterns.length > 0
          ) {
            await this.#recoverLegacyApprovalResponse(
              writer,
              response,
              pendingRequest,
              entry.state,
            );
            continue;
          }
          const resolutionOpId = this.#identityFactory.deriveOpId({
            purpose: 'control_recovery',
            workspaceId: this.workspaceId,
            parts: [threadId, request.requestId],
          });
          if (!isDerivedOpId(resolutionOpId)) throw new Error('identity_factory_invalid_derived_op');
          const claim = await this.#workspace.reserveDerivedOpIdentity(this.#lease, {
            opId: resolutionOpId,
            purpose: 'control_recovery',
            workspaceId: this.workspaceId,
            parts: [threadId, request.requestId],
          });
          if (claim.kind === 'conflict') throw new Error('derived_op_identity_conflict');
          const resolution: Extract<RuntimeEvent, { type: 'control_resolved' }> = {
            type: 'control_resolved',
            requestId: request.requestId,
            kind: request.kind,
            owningRunId: request.owningRunId,
            owningTurnId: request.owningTurnId,
            policyRevision: request.policyRevision,
            decision: 'aborted',
          };
          const envelopes: CommitEnvelopeInput[] = [];
          const mutations: import('./ports.js').RuntimeThreadMutation[] = [];
          if (entry.state === 'accepted_pending') {
            envelopes.push({
              event: { type: 'op_started', opType: 'control_response' },
              opId,
            });
            mutations.push({ type: 'started', opId });
          }
          envelopes.push(
            {
              event: resolution,
              opId: resolutionOpId,
              runId: request.owningRunId,
              turnId: request.owningTurnId,
            },
            {
              event: { type: 'op_completed', opType: 'control_response', outcome: 'interrupted' },
              opId,
            },
          );
          mutations.push(
            { type: 'control_resolved', resolution },
            { type: 'completed', opId, outcome: 'interrupted' },
          );
          if (entry.state === 'accepted_pending') {
            mutations.push({
              type: 'control_response_claim_released',
              requestId: request.requestId,
              responseOpId: response.opId,
              reason: 'effect_definitely_not_applied',
            });
          }
          await writer.commit(
            envelopes as [CommitEnvelopeInput, ...CommitEnvelopeInput[]],
            mutations,
          );
          continue;
        }
        const recoverableActivity = (entry.op.type === 'prompt' || entry.op.type === 'continue')
          && (entry.state === 'accepted_pending' || entry.state === 'started');
        if (!recoverableActivity && entry.state !== 'started') continue;
        if (entry.op.type === 'set_model') continue;
        const parentOpId = 'parentOpId' in entry.op ? entry.op.parentOpId : undefined;
        if (entry.op.type === 'prompt' || entry.op.type === 'continue') {
          const root = [...writer.state.runs.values()].find((run) => run.ownerOpId === opId);
          if (root === undefined) {
            throw new RuntimeStorageError('run_reservation_missing', `Recovery has no run for ${opId}`);
          }
          const terminal = terminalRunForRoot(writer.state, root.runId);
          const activity = writer.state.checkpoint.frontend.activity;
          const unresolvedControls = writer.state.checkpoint.frontend.pendingControls.filter((request) =>
            runDescendsFromRoot(writer.state, request.owningRunId, root.runId)
            && !writer.state.controlClaims.has(request.requestId));
          const controlEnvelopes: CommitEnvelopeInput[] = [];
          const controlMutations: import('./ports.js').RuntimeThreadMutation[] = [];
          for (const request of unresolvedControls) {
            const resolutionOpId = this.#identityFactory.deriveOpId({
              purpose: 'control_recovery',
              workspaceId: this.workspaceId,
              parts: [threadId, request.requestId],
            });
            if (!isDerivedOpId(resolutionOpId)) throw new Error('identity_factory_invalid_derived_op');
            const claim = await this.#workspace.reserveDerivedOpIdentity(this.#lease, {
              opId: resolutionOpId,
              purpose: 'control_recovery',
              workspaceId: this.workspaceId,
              parts: [threadId, request.requestId],
            });
            if (claim.kind === 'conflict') throw new Error('derived_op_identity_conflict');
            const resolution: Extract<RuntimeEvent, { type: 'control_resolved' }> = {
              type: 'control_resolved',
              requestId: request.requestId,
              kind: request.kind,
              owningRunId: request.owningRunId,
              owningTurnId: request.owningTurnId,
              policyRevision: request.policyRevision,
              decision: 'aborted',
            };
            controlEnvelopes.push({
              event: resolution,
              opId: resolutionOpId,
              runId: request.owningRunId,
              turnId: request.owningTurnId,
            });
            controlMutations.push({ type: 'control_resolved', resolution });
          }
          const mutations: import('./ports.js').RuntimeThreadMutation[] = [
            { type: 'completed', opId, outcome: 'interrupted' },
            { type: 'run_terminal', runId: terminal.runId, status: 'interrupted' },
            {
              type: 'activity_interrupted',
              rootOpId: opId,
              rootRunId: root.runId,
              terminalRunId: terminal.runId,
              ...(activity?.turnId !== undefined && { terminalTurnId: activity.turnId }),
              ...(activity?.partialAssistant?.id !== undefined && {
                discardedPartialAssistantId: activity.partialAssistant.id,
              }),
              discardedStartedToolCallIds: activity?.toolExecutions
                .filter((tool) => tool.result === undefined)
                .map((tool) => tool.toolCallId) ?? [],
            },
          ];
          const parentThreadId = writer.state.meta.parentThreadId;
          if (parentThreadId !== undefined) {
            const resultOpId = this.#identityFactory.deriveOpId({
              purpose: 'thread_result',
              workspaceId: this.workspaceId,
              parts: [parentThreadId, threadId, terminal.runId],
            });
            if (!isDerivedOpId(resultOpId)) throw new Error('identity_factory_invalid_derived_op');
            mutations.push({
              type: 'thread_result_pending',
              resultOpId,
              parentThreadId,
              childThreadId: threadId,
              terminalRunId: terminal.runId,
              status: 'error',
            });
          }
          controlEnvelopes.push({
            event: {
              type: 'op_completed',
              opType: entry.op.type,
              terminalRunId: terminal.runId,
              outcome: 'interrupted',
            },
            opId,
            runId: root.runId,
          });
          await writer.commit(
            controlEnvelopes as [CommitEnvelopeInput, ...CommitEnvelopeInput[]],
            [...controlMutations, ...mutations],
          );
        } else {
          await writer.commit([{
            event: {
              type: 'op_completed',
              opType: entry.op.type,
              outcome: 'interrupted',
              ...(parentOpId !== undefined && { parentOpId }),
            },
            opId,
          }], [{ type: 'completed', opId, outcome: 'interrupted' }]);
        }
      }
      return writer.state;
    } finally {
      await writer.close();
    }
  }

  async #reconcileSupervisorLedger(records: readonly SupervisorOpLedgerRecord[]): Promise<void> {
    for (const record of records) {
      if (record.state === 'final') continue;
      const receipt = this.#recoverSupervisorReceipt(record);
      if (receipt === undefined) continue;
      await this.#workspace.finalizeSupervisorOp(
        this.#lease,
        this.#finalSupervisorRecord(record, receipt),
      );
    }
  }

  #finalSupervisorRecord(
    record: SupervisorOpLedgerRecord,
    receipt: OpReceipt,
  ): SupervisorOpLedgerRecord {
    let driverCreation = record.driverCreation;
    if (record.op.type === 'thread_create') {
      const creationKey = driverCreation?.creationKey;
      if (creationKey === undefined) {
        throw new RuntimeStorageError('invalid_supervisor_op', 'thread_create has no creation key');
      }
      const meta = this.#threadMeta.get(record.op.threadId);
      const driverRef = receipt.accepted && meta?.createdByOpId === record.op.opId
        ? this.#catalog.get(record.op.threadId)?.driverRef ?? meta.driverRef ?? driverCreation?.driverRef
        : undefined;
      driverCreation = {
        creationKey,
        ...(driverRef !== undefined && { driverRef }),
      };
    }
    return {
      ...record,
      ...(driverCreation !== undefined && { driverCreation }),
      state: 'final',
      receipt,
    };
  }

  #recoverSupervisorReceipt(record: SupervisorOpLedgerRecord): OpReceipt | undefined {
    const op = record.op;
    if (op.workspaceId !== this.workspaceId) {
      return { accepted: false, opId: op.opId, duplicate: false, reason: 'workspace_mismatch' };
    }
    if (op.type === 'cancel_scope') {
      const resolved = record.resolvedTargets ?? [];
      const allCompleted = resolved.every((target) => {
        const entry = this.#unloaded.get(target.threadId)?.mailbox.get(target.derivedOpId);
        return entry?.state === 'completed';
      });
      return allCompleted
        ? {
            accepted: true,
            opId: op.opId,
            duplicate: false,
            targetThreadIds: record.targetThreadIds ?? [],
          }
        : undefined;
    }
    const state = this.#threads.get(op.threadId)?.durableState() ?? this.#unloaded.get(op.threadId);
    const lifecycle = state?.envelopes.findLast((envelope) => envelope.opId === op.opId
      && (envelope.event.type === 'op_completed' || envelope.event.type === 'op_rejected'));
    if (lifecycle?.event.type === 'op_rejected') {
      return rejected(op, lifecycle.event.reason);
    }
    if (lifecycle?.event.type === 'op_completed') {
      const rootRun = op.type === 'prompt' || op.type === 'continue'
        ? [...(state?.runs.values() ?? [])].find((run) => run.ownerOpId === op.opId)
        : undefined;
      return {
        accepted: true,
        opId: op.opId,
        duplicate: false,
        threadId: op.threadId,
        ...(rootRun !== undefined && { runId: rootRun.runId }),
      };
    }
    const mailbox = state?.mailbox.get(op.opId);
    if (mailbox?.state === 'rejected') return rejected(op, mailbox.reason ?? 'rejected');
    if (mailbox !== undefined && mailbox.state !== 'prepared') {
      const run = [...(state?.runs.values() ?? [])].find((candidate) => candidate.ownerOpId === op.opId);
      return {
        accepted: true,
        opId: op.opId,
        duplicate: false,
        threadId: op.threadId,
        ...(run !== undefined && { runId: run.runId }),
      };
    }
    if (op.type === 'thread_close' && this.#catalog.get(op.threadId)?.summary.state === 'closed') {
      return { accepted: true, opId: op.opId, duplicate: false, threadId: op.threadId };
    }
    return undefined;
  }

  async #resolveModel(
    ref: RuntimeOp extends never ? never : Extract<RuntimeOp, { type: 'set_model' }>['model'],
    threadId: ThreadId,
    opId: ExternalOpId,
  ): Promise<Awaited<ReturnType<RuntimeModelResolver['resolve']>>> {
    const resolution = await this.#modelResolver.resolve(ref, {
      workspaceId: this.workspaceId,
      threadId,
      opId,
      signal: this.#closeController.signal,
    });
    if (resolution.ok && canonicalJson(resolution.model.ref) !== canonicalJson(ref)) {
      throw new Error('RuntimeModelResolver returned a mismatched ModelRef');
    }
    return resolution;
  }

  async #workspaceCeiling(): Promise<PermissionCeilingSnapshot> {
    return validatePermissionCeilingSnapshot(await this.#permissionPolicy.snapshotWorkspaceCeiling({
      workspaceId: this.workspaceId,
      cwd: this.#cwd,
    }));
  }

  async #performClose(): Promise<void> {
    const failures: unknown[] = [];
    while (this.#inFlight.size > 0) {
      await Promise.allSettled([...this.#inFlight]);
    }
    const cohort = [...this.#threads.entries()].sort(([left], [right]) =>
      threadDepth(right, this.#threadMeta) - threadDepth(left, this.#threadMeta));
    for (const [threadId, thread] of cohort) {
      try {
        const lifecycleOp = this.#attachmentLifecycleOps.get(threadId);
        if (lifecycleOp === undefined) throw new Error(`Thread ${threadId} has no attachment lifecycle OpId`);
        const opId = this.#identityFactory.deriveOpId({
          purpose: 'thread_close_on_runtime_close',
          workspaceId: this.workspaceId,
          parts: [threadId, lifecycleOp],
        });
        if (!isDerivedOpId(opId)) throw new Error('identity_factory_invalid_derived_op');
        const claim = await this.#workspace.reserveDerivedOpIdentity(this.#lease, {
          opId,
          purpose: 'thread_close_on_runtime_close',
          workspaceId: this.workspaceId,
          parts: [threadId, lifecycleOp],
        });
        if (claim.kind === 'conflict') throw new Error('derived_op_identity_conflict');
        const closeOp = {
          type: 'thread_close' as const,
          opId,
          workspaceId: this.workspaceId,
          threadId,
        };
        await thread.acceptInternal(closeOp);
        await thread.close(closeOp);
      } catch (error) {
        failures.push(error);
      }
      this.#threads.delete(threadId);
      this.#attachmentLifecycleOps.delete(threadId);
      const closedState = thread.durableState();
      this.#unloaded.set(threadId, closedState);
      for (const result of closedState.pendingThreadResults.values()) {
        if (closedState.deliveredThreadResults.has(result.resultOpId)) continue;
        try {
          await this.#deliverThreadResult(result, true);
        } catch (error) {
          failures.push(error);
        }
      }
    }
    this.#events.close();
    try {
      await this.#legacyApprovalPatterns?.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.#workspace.releaseSupervisorLease(this.#lease);
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.#workspace.close();
    } catch (error) {
      failures.push(error);
    }
    this.#state = 'closed';
    if (failures.length > 0) throw new AggregateError(failures, 'Runtime close failed');
  }

  #assertOpen(): void {
    if (this.#state !== 'open') throw new RuntimeClosedError();
  }

  #latchApprovalFatal(error: Error): void {
    if (this.#approvalFatal !== undefined) return;
    this.#approvalFatal = error;
    for (const thread of this.#threads.values()) {
      thread.stopForWorkspaceApprovalFatal(error);
    }
  }

  async #commitApprovalStartupDiagnostics(writer: ThreadJournalWriter): Promise<void> {
    if (this.#pendingApprovalDiagnostics.length === 0) return;
    const existing = this.#approvalDiagnosticFlight;
    if (existing !== undefined) {
      await existing;
      return;
    }
    const diagnostics = [...this.#pendingApprovalDiagnostics];
    const flight = writer.commit(diagnostics.map((diagnostic) => ({
      event: {
        type: 'runtime_diagnostic' as const,
        severity: 'warning' as const,
        code: diagnostic.code,
        message: diagnostic.message,
        scope: 'thread' as const,
      },
    })) as [CommitEnvelopeInput, ...CommitEnvelopeInput[]]).then(() => {
      this.#pendingApprovalDiagnostics.splice(0, diagnostics.length);
    });
    this.#approvalDiagnosticFlight = flight;
    try {
      await flight;
    } finally {
      if (this.#approvalDiagnosticFlight === flight) this.#approvalDiagnosticFlight = undefined;
    }
  }
}

function validateCreateOptions(options: CreateRuntimeOptions): void {
  const cwd = options.workspace.cwd;
  if (
    typeof cwd !== 'string' ||
    cwd.length === 0 ||
    cwd.includes('\u0000') ||
    !cwd.isWellFormed() ||
    !path.isAbsolute(cwd)
  ) {
    throw new RuntimeIdentityValidationError('invalid_workspace_cwd', 'workspace.cwd');
  }
  if (options.workspace.workspaceId !== undefined) {
    assertWorkspaceId(options.workspace.workspaceId, 'workspace.workspaceId');
  }
  if (options.capabilityMode !== undefined && options.capabilityMode !== 'static') {
    throw new TypeError('Phase-1 Runtime only supports capabilityMode="static"');
  }
  if ((options as { readonly capabilityServices?: unknown }).capabilityServices !== undefined) {
    throw new TypeError('Phase-1 Runtime does not accept capabilityServices');
  }
}

function rejected(
  op: { readonly opId: ExternalOpId; readonly threadId?: ThreadId },
  reason: string,
): OpReceipt {
  return {
    accepted: false,
    opId: op.opId,
    duplicate: false,
    reason,
    ...(op.threadId !== undefined && { threadId: op.threadId }),
  };
}

function snapshot<T>(value: T): T {
  return strictJsonSnapshot(value) as T;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function threadResultEvent(
  result: ThreadResultOutboxMutation,
): Extract<RuntimeEvent, { type: 'thread_result' }> {
  return {
    type: 'thread_result',
    resultOpId: result.resultOpId,
    childThreadId: result.childThreadId,
    terminalRunId: result.terminalRunId,
    status: result.status,
    ...(result.summary !== undefined && { summary: result.summary }),
  };
}

function withoutActiveRunSummary(
  summary: ThreadSummary,
  state: ThreadSummary['state'],
): ThreadSummary {
  const { activeRunId: _activeRunId, ...rest } = summary;
  void _activeRunId;
  return { ...rest, state };
}

function collectSubtree(root: ThreadId, meta: ReadonlyMap<ThreadId, ThreadMetaRecord>): ThreadId[] {
  const result: ThreadId[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift() as ThreadId;
    result.push(current);
    for (const record of meta.values()) {
      if (record.parentThreadId === current) queue.push(record.threadId);
    }
  }
  return result;
}

function threadDepth(threadId: ThreadId, meta: ReadonlyMap<ThreadId, ThreadMetaRecord>): number {
  let depth = 0;
  let current = meta.get(threadId)?.parentThreadId;
  const visited = new Set<ThreadId>();
  while (current !== undefined && !visited.has(current)) {
    visited.add(current);
    depth++;
    current = meta.get(current)?.parentThreadId;
  }
  return depth;
}

function terminalRunForRoot(state: FoldedThreadJournal, rootRunId: RunId): FoldedRunEntry {
  let current = state.runs.get(rootRunId);
  if (current === undefined) throw new RuntimeStorageError('run_reservation_missing', rootRunId);
  for (;;) {
    const successor = [...state.runs.values()].find((run) => run.predecessorRunId === current?.runId);
    if (successor === undefined) return current;
    current = successor;
  }
}

function runDescendsFromRoot(
  state: FoldedThreadJournal,
  runId: RunId,
  rootRunId: RunId,
): boolean {
  let current = state.runs.get(runId);
  const visited = new Set<RunId>();
  while (current !== undefined && !visited.has(current.runId)) {
    if (current.runId === rootRunId) return true;
    visited.add(current.runId);
    current = current.predecessorRunId === undefined
      ? undefined
      : state.runs.get(current.predecessorRunId);
  }
  return false;
}

function recoverySummary(state: FoldedThreadJournal | undefined): ThreadSummary | undefined {
  if (state === undefined) return undefined;
  const reserved = [...state.mailbox.entries()].flatMap(([opId, entry]) => {
    if (entry.state !== 'accepted_pending'
      || (entry.op.type !== 'prompt' && entry.op.type !== 'continue')) return [];
    const run = [...state.runs.values()].find((candidate) => candidate.ownerOpId === opId);
    return run === undefined ? [] : [{ kind: 'reserved_op' as const, ownerOpId: opId, runId: run.runId }];
  });
  const existing = state.summary.suspendedWork ?? [];
  const suspendedWork = [...existing, ...reserved];
  if (suspendedWork.length === 0) return state.summary;
  const { activeRunId, ...summary } = state.summary;
  void activeRunId;
  return { ...summary, state: 'suspended', suspendedWork };
}

function withAttachmentRecoveryOverlay(state: FoldedThreadJournal): FoldedThreadJournal {
  const latestLifecycleSeq = state.envelopes.findLast((envelope) =>
    envelope.event.type === 'thread_created' || envelope.event.type === 'thread_resumed')?.seq ?? 0;
  const latestRecoverySeq = state.envelopes.findLast((envelope) =>
    envelope.event.type === 'runtime_diagnostic'
    && envelope.event.scope === 'thread'
    && (envelope.event.code === 'attachment_model_not_found'
      || envelope.event.code === 'attachment_credentials_unavailable'
      || envelope.event.code === 'attachment_invalid_model'))?.seq ?? 0;
  if (latestRecoverySeq <= latestLifecycleSeq || state.summary.state === 'closed') return state;
  return {
    ...state,
    summary: withoutActiveRunSummary(state.summary, 'closed'),
  };
}

function abortTargetFromFold(
  state: FoldedThreadJournal | undefined,
): import('../protocol/index.js').ResolvedAbortTarget {
  if (state === undefined) return { kind: 'no_current_activity' };
  const suspended = recoverySummary(state)?.suspendedWork?.[0];
  if (suspended?.kind === 'reserved_op') {
    return {
      kind: 'suspended',
      ownerOpId: suspended.ownerOpId,
      terminalRunId: suspended.runId,
      ...(state.inputOwners.has(suspended.ownerOpId) && { inputOwnerOpId: suspended.ownerOpId }),
    };
  }
  if (suspended?.kind === 'interrupted') {
    return {
      kind: 'suspended',
      ownerOpId: suspended.ownerOpId,
      terminalRunId: suspended.terminalRunId,
      ...(suspended.inputOwnerOpId !== undefined && { inputOwnerOpId: suspended.inputOwnerOpId }),
    };
  }
  const activeRunId = state.summary.activeRunId;
  return activeRunId === undefined
    ? { kind: 'no_current_activity' }
    : { kind: 'run', runId: activeRunId };
}
