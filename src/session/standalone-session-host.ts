// Internal composition root for exported direct Session instances. It owns one canonical
// ThreadRuntime, one backend-scoped standalone lease, and one private observer pump—never a
// workspace Supervisor or SupervisorLease.

import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  canonicalJson,
  deriveOpId,
  strictJsonSnapshot,
} from '../protocol/index.js';
import type {
  AgentMessage,
  ExternalOpId,
  ExternalThreadRuntimeOp,
  ModelConfig,
  ModelRef,
  OpReceipt,
  PermissionCeilingSnapshot,
  RunId,
  RuntimeEvent,
  TurnId,
  UserMessage,
} from '../protocol/index.js';
import { RuntimeStorageError } from '../shared/runtime-storage-error.js';
import { EventHub } from './event-hub.js';
import { LegacySessionThreadDriver } from './legacy-session-thread-driver.js';
import type {
  LegacyThreadExecutionPort,
  SessionInteractionState,
  SessionListener,
  SessionOptions,
  SessionRuntimeMirrorGuard,
} from './legacy-thread-execution.js';
import { LegacyThreadExecution } from './legacy-thread-execution.js';
import { StandaloneSessionEventHub } from './standalone-session-events.js';
import { reconcileStandaloneSessionMirror } from './standalone-session-recovery.js';
import {
  StandaloneSessionInUseError,
  StandaloneSessionLease,
} from './standalone-session-lease.js';
import {
  StandaloneThreadJournalPort,
  standaloneThreadIdentity,
} from './standalone-thread-journal.js';
import type {
  LegacyThreadSeedRecord,
  RuntimeThreadMutation,
  ThreadMetaRecord,
} from './thread-journal-records.js';
import { foldThreadJournal, ThreadJournalWriter } from './thread-journal.js';
import type {
  CommitEnvelopeInput,
  FoldedRunEntry,
  FoldedThreadJournal,
} from './thread-journal.js';
import type {
  PermissionPolicyPort,
  ThreadDriverAttachment,
  ThreadIdentityPort,
} from './thread-runtime-ports.js';
import { ThreadDriverHostController, ThreadRuntime } from './thread-runtime.js';
import type { MetaRecord, SessionListItem, SessionRecord } from './store.js';
import {
  defaultSessionDir,
  listSessions,
  loadSession,
  loadSessionRecordHistory,
  PROTOCOL_VERSION,
  SessionStore,
  STORE_VERSION,
} from './store.js';
import { UsageTracker } from './usage.js';

const STANDALONE_CEILING = strictJsonSnapshot({
  revision: 'standalone-session-v1',
  constraints: [],
}) as unknown as PermissionCeilingSnapshot;

export class StandaloneSessionHost {
  readonly execution: LegacyThreadExecutionPort;
  readonly #runtime: ThreadRuntime;
  readonly #events: EventHub;
  readonly #lease: StandaloneSessionLease;
  readonly #hub: StandaloneSessionEventHub;
  #model: ModelConfig;
  readonly #pendingActivities = new Set<Promise<void>>();
  #fatal: Error | undefined;
  #closed = false;

  private constructor(input: {
    readonly execution: LegacyThreadExecutionPort;
    readonly runtime: ThreadRuntime;
    readonly events: EventHub;
    readonly lease: StandaloneSessionLease;
    readonly hub: StandaloneSessionEventHub;
    readonly model: ModelConfig;
  }) {
    this.execution = input.execution;
    this.#runtime = input.runtime;
    this.#events = input.events;
    this.#lease = input.lease;
    this.#hub = input.hub;
    this.#model = input.model;
  }

  static async create(opts: SessionOptions): Promise<StandaloneSessionHost> {
    const dir = opts.dir ?? defaultSessionDir();
    // Allocation only chooses an unused stable name; no backend bytes are written before the host
    // owns that session's standalone authority.
    for (let attempt = 0; attempt <= 20; attempt++) {
      const { id } = SessionStore.createNew(dir);
      try {
        return await StandaloneSessionHost.#open(id, opts, 'create_new');
      } catch (error) {
        if (!(error instanceof StandaloneSessionInUseError) || attempt === 20) throw error;
      }
    }
    throw new Error('Unable to allocate a unique standalone Session id');
  }

  static async createWithId(
    id: string,
    opts: SessionOptions,
    runtimeMeta?: MetaRecord,
  ): Promise<StandaloneSessionHost> {
    return StandaloneSessionHost.#open(id, opts, 'create_named', runtimeMeta);
  }

  static async resume(id: string, opts: SessionOptions): Promise<StandaloneSessionHost> {
    return StandaloneSessionHost.#open(id, opts, 'resume');
  }

  static async list(dir?: string): Promise<SessionListItem[]> {
    return listSessions(dir ?? defaultSessionDir());
  }

  get id(): string {
    return this.execution.id;
  }

  async prompt(text: string): Promise<void> {
    return this.#submitActivity({
      type: 'prompt',
      opId: newExternalOpId(),
      workspaceId: this.#runtime.workspaceId,
      threadId: this.#runtime.threadId,
      text,
    });
  }

  async continue(): Promise<void> {
    this.#assertOperational();
    if (this.interactionState() !== 'idle') {
      throw new Error('任务仍在运行；请先完成或 abort，再继续');
    }
    return this.#submitActivity({
      type: 'continue',
      opId: newExternalOpId(),
      workspaceId: this.#runtime.workspaceId,
      threadId: this.#runtime.threadId,
    });
  }

  steer(input: string | UserMessage): void {
    this.#assertOperational();
    const op = {
      type: 'steer',
      opId: newExternalOpId(),
      workspaceId: this.#runtime.workspaceId,
      threadId: this.#runtime.threadId,
      text: legacyQueuedText(input),
    } as const;
    this.#enqueue(op, typeof input === 'string' ? undefined : {
      legacyQueuedMessage: snapshotLegacyQueuedMessage(input),
    });
  }

  followUp(input: string | UserMessage): void {
    this.#assertOperational();
    const op = {
      type: 'follow_up',
      opId: newExternalOpId(),
      workspaceId: this.#runtime.workspaceId,
      threadId: this.#runtime.threadId,
      text: legacyQueuedText(input),
    } as const;
    this.#enqueue(op, typeof input === 'string' ? undefined : {
      legacyQueuedMessage: snapshotLegacyQueuedMessage(input),
    });
  }

  abort(): void {
    if (this.#closed) return;
    this.#enqueue({
      type: 'abort',
      opId: newExternalOpId(),
      workspaceId: this.#runtime.workspaceId,
      threadId: this.#runtime.threadId,
      ...(this.#runtime.activeRunId() !== undefined && {
        expectedRunId: this.#runtime.activeRunId() as RunId,
      }),
    });
  }

  usage(): ReturnType<LegacyThreadExecutionPort['usage']> {
    return this.execution.usage();
  }

  interactionState(): SessionInteractionState {
    if (this.#pendingActivities.size > 0 && this.execution.interactionState() === 'idle') return 'running';
    return this.execution.interactionState();
  }

  runtimeFollowUpState(): 'idle' | 'retrying' | 'compacting' {
    return this.execution.runtimeFollowUpState();
  }

  currentModel(): ModelRef {
    return { ...this.#model.ref };
  }

  setModel(model: ModelConfig): void {
    this.#assertOperational();
    if (this.interactionState() !== 'idle') {
      throw new Error('任务仍在运行；请先完成或 abort，再切换模型');
    }
    const op: Extract<ExternalThreadRuntimeOp, { type: 'set_model' }> = {
      type: 'set_model',
      opId: newExternalOpId(),
      workspaceId: this.#runtime.workspaceId,
      threadId: this.#runtime.threadId,
      model: { ...model.ref },
    };
    // The complete trusted config is an in-memory sidecar; only ModelRef enters the journal. The
    // update is immediately visible and a later commit/dispatch failure latches the host fatal.
    this.#model = model;
    this.#enqueue(op, { resolvedModel: model });
  }

  status(): ReturnType<LegacyThreadExecutionPort['status']> {
    return { usage: this.usage(), model: this.currentModel(), sessionId: this.id };
  }

  get messages(): readonly AgentMessage[] {
    return this.execution.messages;
  }

  compactionCheckpoint(): ReturnType<LegacyThreadExecutionPort['compactionCheckpoint']> {
    return this.execution.compactionCheckpoint();
  }

  subscribe(listener: SessionListener): () => void {
    return this.#hub.subscribe(listener);
  }

  async waitForIdle(): Promise<void> {
    if (this.#closed) {
      this.#throwFatal();
      return;
    }
    this.#assertOperational();
    while (true) {
      const pendingActivities = [...this.#pendingActivities];
      await this.execution.waitForIdle();
      await this.#runtime.waitForIdle();
      await Promise.allSettled(pendingActivities);
      if (
        this.#pendingActivities.size === 0
        && this.execution.interactionState() === 'idle'
      ) {
        this.#throwFatal();
        return;
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const failures: unknown[] = [];
    // Legacy direct Session.close() is graceful for a normal Agent run: it only cancels detached
    // retry/compaction work, then waits for provider/tool execution to finish naturally. Preserve
    // that facade contract before invoking canonical ThreadRuntime.close(), whose Runtime-facing
    // thread_close semantics intentionally abort an active run.
    try {
      await this.execution.close();
      await this.#runtime.waitForIdle();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.#runtime.close();
    } catch (error) {
      failures.push(error);
    }
    // Ordinary listener drain is intentionally outside the close barrier.
    this.#hub.close();
    this.#events.close();
    try {
      this.#lease.release();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) throw new AggregateError(failures, `Session ${this.id} close failed`);
  }

  #submitActivity(
    op: Extract<ExternalThreadRuntimeOp, { type: 'prompt' | 'continue' }>,
  ): Promise<void> {
    const pending = this.#runActivity(op);
    this.#pendingActivities.add(pending);
    void pending.then(
      () => this.#pendingActivities.delete(pending),
      () => this.#pendingActivities.delete(pending),
    );
    return pending;
  }

  async #runActivity(
    op: Extract<ExternalThreadRuntimeOp, { type: 'prompt' | 'continue' }>,
  ): Promise<void> {
    this.#assertOperational();
    const stateAtAdmission = this.interactionState();
    if (op.type === 'prompt' && stateAtAdmission === 'retrying') {
      throw new Error('任务正在重试；请使用 steer() 或 followUp()');
    }
    const stashedDuringCompaction = op.type === 'prompt' && stateAtAdmission === 'compacting';
    // The callback observer itself is asynchronous, but its synchronous prefix must be able to
    // claim the post-compaction activity before the legacy adapter starts an implicit continue.
    // ThreadRuntime will durably accept and dispatch this same prompt through its mailbox.
    if (stashedDuringCompaction) this.execution.deferCompactionResumeToMailbox?.();
    const iterator = this.#events.subscribe({ threadIds: [this.#runtime.threadId] })
      [Symbol.asyncIterator]();
    try {
      const receipt = await this.#runtime.acceptExternal(op);
      assertAccepted(receipt);
      if (receipt.runId === undefined) throw new Error(`${op.type} was accepted without a RunId`);
      // Legacy Session historically resolves a prompt stashed during compaction at admission; its
      // eventual replay remains part of waitForIdle(), not this Promise's root boundary.
      if (stashedDuringCompaction) return;
      for (;;) {
        const item = await iterator.next();
        if (item.done) throw new Error(`Session ${this.id} event stream closed before agent_end`);
        const envelope = item.value;
        if (envelope.runId === receipt.runId && envelope.event.type === 'agent_end') {
          const hasDetachedSuccessor = envelope.event.willRetry === true
            || this.execution.runtimeFollowUpState() !== 'idle';
          if (!hasDetachedSuccessor) await this.#runtime.waitForIdle();
          await postCommitObserverTurn();
          return;
        }
        if (
          envelope.opId === op.opId
          && envelope.event.type === 'op_completed'
          && envelope.event.outcome === 'interrupted'
        ) {
          try {
            await this.execution.waitForIdle();
          } catch (error) {
            throw error;
          }
          await this.#runtime.waitForIdle();
          throw new Error(`Session ${op.type} was interrupted before agent_end`);
        }
      }
    } finally {
      await iterator.return?.();
    }
  }

  #enqueue(
    op: Exclude<ExternalThreadRuntimeOp, { type: 'prompt' | 'continue' | 'control_response' }>,
    prepared?: import('./thread-runtime-ports.js').ThreadRuntimePreparedInput,
  ): void {
    void this.#runtime.acceptExternal(op, prepared).then(
      (receipt) => {
        // abort() is a best-effort synchronous request. If the sampled RunId naturally completed
        // before FIFO admission, stale_run is the successful idempotent outcome—not host poison.
        if (!receipt.accepted && !(op.type === 'abort' && receipt.reason === 'stale_run')) {
          this.#latchFatal(receiptError(receipt));
        }
      },
      (error) => this.#latchFatal(error),
    );
  }

  #assertOperational(): void {
    if (this.#closed) throw new Error(`Session ${this.id} is closed`);
    this.#throwFatal();
    this.#lease.assertCurrent();
  }

  #latchFatal(error: unknown): void {
    if (this.#fatal !== undefined) return;
    this.#fatal = error instanceof Error ? error : new Error(String(error));
    this.execution.abort();
  }

  #throwFatal(): void {
    if (this.#fatal !== undefined) throw this.#fatal;
  }

  static async #open(
    id: string,
    opts: SessionOptions,
    mode: 'create_new' | 'create_named' | 'resume',
    runtimeMeta?: MetaRecord,
  ): Promise<StandaloneSessionHost> {
    const dir = opts.dir ?? defaultSessionDir();
    const lease = await StandaloneSessionLease.acquire(dir, id);
    const events = new EventHub();
    let hub: StandaloneSessionEventHub | undefined;
    let journal: StandaloneThreadJournalPort | undefined;
    let writer: ThreadJournalWriter | undefined;
    let execution: LegacyThreadExecution | undefined;
    let driver: LegacySessionThreadDriver | undefined;
    let runtime: ThreadRuntime | undefined;
    try {
      if (mode === 'create_new' && existsSync(path.join(dir, `${id}.jsonl`))) {
        throw new StandaloneSessionInUseError(id);
      }
      let legacyMeta: MetaRecord;
      if (mode === 'resume') {
        legacyMeta = loadSession(dir, id).meta;
      } else {
        const proposedMeta = runtimeMeta ?? newLegacyMeta(id, opts);
        if (proposedMeta.id !== id || proposedMeta.type !== 'meta'
          || proposedMeta.version !== STORE_VERSION) {
          throw new Error('Runtime Session meta does not match its deterministic id');
        }
        const initialized = SessionStore.initializeNamed(dir, id, proposedMeta);
        // Install the recoverable v1 meta before the canonical sidecar. A crash on either side of
        // sidecar creation then leaves a backend that Session.resume can reconstruct, never an
        // unreachable canonical orphan. Named create remains idempotent with an existing backend.
        legacyMeta = initialized.created ? proposedMeta : loadSession(dir, id).meta;
      }
      const bootstrap = standaloneBootstrap(dir, id, legacyMeta, opts);
      journal = await StandaloneThreadJournalPort.open({
        dir,
        sessionId: id,
        recordedCwd: legacyMeta.cwd,
        lease,
        bootstrap,
      });
      const records = await journal.load();
      const state = foldThreadJournal(records);
      if (existsSync(path.join(dir, `${id}.jsonl`))) {
        reconcileStandaloneSessionMirror({ dir, sessionId: id, records });
      }
      events.seed(journal.threadId, state.envelopes);
      writer = new ThreadJournalWriter({
        workspaceId: journal.workspaceId,
        threadId: journal.threadId,
        journal,
        events,
        clock: { now: () => Date.now() },
        state,
        records,
      });
      await interruptCrashedStandaloneActivities(writer);
      hub = new StandaloneSessionEventHub({
        threadId: journal.threadId,
        readEnvelopes: () => writer?.state.envelopes ?? state.envelopes,
      });

      const driverRef: { current?: LegacySessionThreadDriver } = {};
      const callerSink = opts.authoritativeEventSink;
      const effective: SessionOptions = {
        ...opts,
        dir,
        authoritativeEventSink: async (batch) => {
          // Kept only as an internal fault-injection/compatibility hook. The canonical driver
          // commit remains the sole path that assigns seq and writes the thread journal.
          if (callerSink !== undefined) await callerSink(batch);
          const current = driverRef.current;
          if (current === undefined) throw new Error('Standalone Session emitted before driver binding');
          await current.commitSessionEvents(batch);
        },
        observerPort: hub,
        runtimeMirrorGuard: combineGuards(lease, opts.runtimeMirrorGuard),
        runtimeQueueSeed: writer.state.checkpoint.frontend.queues,
      };
      execution = mode === 'resume'
        ? await LegacyThreadExecution.resume(id, effective)
        : await LegacyThreadExecution.createWithId(id, effective, legacyMeta);
      const host = new ThreadDriverHostController();
      driver = new LegacySessionThreadDriver({
        threadId: journal.threadId,
        host,
        session: execution,
        cwd: legacyMeta.cwd,
      });
      driverRef.current = driver;
      const attachment: ThreadDriverAttachment = {
        driver,
        durableRef: { kind: 'session-v1', key: id },
        initialCheckpoint: writer.state.checkpoint,
      };
      runtime = new ThreadRuntime({
        workspaceId: journal.workspaceId,
        cwd: legacyMeta.cwd,
        threadId: journal.threadId,
        writer,
        attachment,
        identityFactory: standaloneIdentityFactory(),
        clock: { now: () => Date.now() },
        permissionPolicy: standalonePermissionPolicy(),
        threadCeiling: STANDALONE_CEILING,
      });
      host.bind(runtime);
      await driver.recover([]);
      await driver.activate();

      const result = new StandaloneSessionHost({
        execution,
        runtime,
        events,
        lease,
        hub,
        model: opts.agentConfig.model,
      });
      if (canonicalJson(writer.state.checkpoint.frontend.model) !== canonicalJson(opts.agentConfig.model.ref)) {
        const receipt = await runtime.acceptExternal({
          type: 'set_model',
          opId: newExternalOpId(),
          workspaceId: journal.workspaceId,
          threadId: journal.threadId,
          model: { ...opts.agentConfig.model.ref },
        }, { resolvedModel: opts.agentConfig.model });
        assertAccepted(receipt);
        await runtime.waitForIdle();
      }
      return result;
    } catch (error) {
      const failures: unknown[] = [error];
      try {
        if (runtime !== undefined) await runtime.close();
        else if (driver !== undefined) await driver.close();
        else if (execution !== undefined) await execution.close();
      } catch (closeError) {
        failures.push(closeError);
      }
      try {
        if (runtime === undefined && writer !== undefined) await writer.close();
        else if (runtime === undefined && journal !== undefined) await journal.releaseWriteLease();
      } catch (closeError) {
        failures.push(closeError);
      }
      hub?.close();
      events.close();
      try {
        lease.release();
      } catch (closeError) {
        failures.push(closeError);
      }
      if (failures.length === 1) throw error;
      throw new AggregateError(failures, `Standalone Session ${id} open failed`);
    }
  }
}

/**
 * A direct Session has no process-independent driver to resume after its owner crashes. Close any
 * durably accepted/started root activity before constructing or attaching the replacement driver
 * so the old RunId can never become live again.
 */
async function interruptCrashedStandaloneActivities(writer: ThreadJournalWriter): Promise<void> {
  const recoverableActivities = [...writer.state.mailbox.entries()].filter(([, entry]) =>
    (entry.state === 'accepted_pending' || entry.state === 'started')
    && (entry.op.type === 'prompt' || entry.op.type === 'continue'));
  for (const [opId, entry] of recoverableActivities) {
    if ((entry.state !== 'accepted_pending' && entry.state !== 'started')
      || (entry.op.type !== 'prompt' && entry.op.type !== 'continue')) {
      continue;
    }
    const root = [...writer.state.runs.values()].find((run) => run.ownerOpId === opId);
    if (root === undefined) {
      throw new RuntimeStorageError(
        'run_reservation_missing',
        `Standalone recovery has no run for ${opId}`,
      );
    }
    const terminal = terminalStandaloneRun(writer.state, root.runId);
    const activity = writer.state.checkpoint.frontend.activity;
    const controlEnvelopes: CommitEnvelopeInput[] = [];
    const controlMutations: RuntimeThreadMutation[] = [];
    for (const request of writer.state.checkpoint.frontend.pendingControls) {
      if (!standaloneRunDescendsFromRoot(writer.state, request.owningRunId, root.runId)
        || writer.state.controlClaims.has(request.requestId)) {
        continue;
      }
      const resolutionOpId = deriveOpId({
        purpose: 'control_recovery',
        workspaceId: writer.state.meta.workspaceId,
        parts: [writer.state.meta.threadId, request.requestId],
      });
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
    const mutations: RuntimeThreadMutation[] = [
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
  }
}

function terminalStandaloneRun(state: FoldedThreadJournal, rootRunId: RunId): FoldedRunEntry {
  let current = state.runs.get(rootRunId);
  if (current === undefined) throw new RuntimeStorageError('run_reservation_missing', rootRunId);
  const visited = new Set<RunId>();
  for (;;) {
    if (visited.has(current.runId)) {
      throw new RuntimeStorageError('invalid_thread_journal', 'Standalone run lineage contains a cycle');
    }
    visited.add(current.runId);
    const successors = [...state.runs.values()].filter((run) =>
      run.predecessorRunId === current?.runId);
    if (successors.length === 0) return current;
    if (successors.length !== 1) {
      throw new RuntimeStorageError('invalid_thread_journal', 'Standalone run lineage forks');
    }
    current = successors[0] as FoldedRunEntry;
  }
}

function standaloneRunDescendsFromRoot(
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

function standaloneBootstrap(
  dir: string,
  sessionId: string,
  legacyMeta: MetaRecord,
  opts: SessionOptions,
): { readonly meta: ThreadMetaRecord; readonly legacySeed: LegacyThreadSeedRecord } {
  const identity = standaloneThreadIdentity(legacyMeta.cwd, sessionId);
  const loaded = existsSync(path.join(dir, `${sessionId}.jsonl`))
    ? loadSession(dir, sessionId)
    : undefined;
  const transcript = loaded?.active ?? [];
  const usage = new UsageTracker(opts.pricing);
  usage.seed(transcript);
  return {
    meta: {
      type: 'thread_meta',
      version: 2,
      protocolVersion: PROTOCOL_VERSION,
      workspaceId: identity.workspaceId,
      threadId: identity.threadId,
      permissionCeiling: STANDALONE_CEILING,
      createdAt: legacyMeta.createdAt,
      cwd: legacyMeta.cwd,
      model: legacyMeta.model,
      driverRef: { kind: 'session-v1', key: sessionId },
    },
    legacySeed: {
      type: 'legacy_seed',
      sourceSessionId: sessionId,
      transcript,
      mirrorRecords: loaded === undefined
        ? []
        : loadSessionRecordHistory(dir, sessionId)
          .flatMap((record) => record.type === 'meta' ? [] : [record]),
      usage: usage.snapshot(),
      ...(loaded?.lastCompaction !== undefined && loaded.active !== loaded.messages && {
        compaction: {
          id: loaded.lastCompaction.id,
          timestamp: loaded.lastCompaction.timestamp,
          tailStartId: loaded.lastCompaction.tailStartId,
          summary: loaded.lastCompaction.summary,
          ...(loaded.lastCompaction.contextTokensBefore !== undefined && {
            contextTokensBefore: loaded.lastCompaction.contextTokensBefore,
          }),
        },
      }),
    },
  };
}

function newLegacyMeta(id: string, opts: SessionOptions): MetaRecord {
  return {
    type: 'meta',
    version: STORE_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    id,
    createdAt: Date.now(),
    cwd: opts.agentConfig.cwd ?? process.cwd(),
    model: { ...opts.agentConfig.model.ref },
  };
}

function standaloneIdentityFactory(): ThreadIdentityPort {
  return {
    newRunId: () => `run_${crypto.randomUUID()}` as RunId,
    newTurnId: () => `turn_${crypto.randomUUID()}` as TurnId,
    deriveOpId,
  };
}

function standalonePermissionPolicy(): PermissionPolicyPort {
  return {
    async snapshotWorkspaceCeiling(): Promise<PermissionCeilingSnapshot> {
      return STANDALONE_CEILING;
    },
    async resolveCeiling(): Promise<PermissionCeilingSnapshot> {
      return STANDALONE_CEILING;
    },
  };
}

function newExternalOpId(): ExternalOpId {
  return `op_e_${crypto.randomUUID().replaceAll('-', '')}` as ExternalOpId;
}

function legacyQueuedText(input: string | UserMessage): string {
  if (typeof input === 'string') return input;
  return input.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n');
}

function snapshotLegacyQueuedMessage(input: UserMessage): Readonly<UserMessage> {
  return strictJsonSnapshot(input) as unknown as Readonly<UserMessage>;
}

function postCommitObserverTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function assertAccepted(receipt: OpReceipt): asserts receipt is OpReceipt & { accepted: true } {
  if (!receipt.accepted) throw receiptError(receipt);
}

function receiptError(receipt: Extract<OpReceipt, { accepted: false }>): Error {
  switch (receipt.reason) {
    case 'thread_busy_use_steer_or_follow_up':
      return new Error('Agent is running; use steer() or followUp()');
    case 'nothing_to_continue':
      return new Error('Nothing to continue');
    case 'thread_closed':
      return new Error('Session is closed');
    default:
      return new Error(`Session operation rejected: ${receipt.reason}`);
  }
}

function combineGuards(
  lease: StandaloneSessionLease,
  caller: SessionRuntimeMirrorGuard | undefined,
): SessionRuntimeMirrorGuard {
  return {
    assertCurrent(): void {
      lease.assertCurrent();
      caller?.assertCurrent();
    },
    beforeAppend(record: SessionRecord): void {
      lease.beforeAppend(record);
      caller?.beforeAppend(record);
    },
    afterAppend(record: SessionRecord): void {
      caller?.afterAppend(record);
      lease.afterAppend(record);
    },
  };
}
