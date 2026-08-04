// One thread's FIFO admission/mailbox and active-run gate. Driver dispatch is deliberately
// not awaited by the mailbox so steer/follow-up/abort can reach an active run.

import {
  canonicalJson,
  deriveInvocationId,
  isDerivedOpId,
  isRunId,
  isTurnId,
  ProviderEventStream,
  strictJsonSnapshot,
} from '../protocol/index.js';
import type {
  AgentMessage,
  AssistantMessage,
  ExternalThreadRuntimeOp,
  ExternalOpId,
  InternalOpReceipt,
  InternalThreadRuntimeOp,
  MailboxRuntimeOp,
  ModelConfig,
  OpId,
  OpReceipt,
  PermissionCeilingSnapshot,
  PolicyGrantScope,
  ResolvedAbortTarget,
  RunId,
  RuntimeOp,
  ThreadId,
  ThreadSnapshot,
  TurnId,
  WorkspaceId,
} from '../protocol/index.js';
import type {
  PolicyDecision,
  PolicyGrant,
  PolicyGrantRepositoryPort,
  PreparedInvocation,
  RuntimeCapabilityServices,
  RuleSnapshotDiagnostic,
  ThreadPolicyEngine,
  TurnPolicyContext,
} from '../capabilities/types.js';
import type {
  PermissionPolicyPort,
  PreparedThreadDriverCommand,
  RuntimeThreadDriverAttachment,
  RuntimeClock,
  ThreadDriverCheckpointMutation,
  ThreadDriverEvent,
  ThreadDriverHostServices,
  ThreadIdentityPort,
  ThreadRuntimePreparedInput,
} from './thread-runtime-ports.js';
import type { RuntimeTurnPort } from '../agent/index.js';
import type {
  RuntimeThreadMutation,
  ThreadResultDeliveryRecord,
  ThreadResultOutboxMutation,
} from './thread-journal-records.js';
import { RuntimeStorageError } from '../shared/runtime-storage-error.js';
import { FileTracker } from '../shared/index.js';
import { validatePermissionCeilingSnapshot } from './permission-ceiling.js';
import { snapshotFromFold, ThreadJournalWriter } from './thread-journal.js';
import type { CommitEnvelopeInput, FoldedThreadJournal } from './thread-journal.js';

interface ActiveRun {
  readonly rootOpId: ExternalOpId;
  readonly rootRunId: RunId;
  currentRunId: RunId;
  currentCeiling: PermissionCeilingSnapshot;
}

interface QueuedActivity {
  readonly op: Extract<RuntimeOp, { type: 'prompt' }>;
  readonly runId: RunId;
  readonly permissionCeiling: PermissionCeilingSnapshot;
  readonly command: Extract<PreparedThreadDriverCommand, { op: { type: 'prompt' } }>;
}

export interface ThreadRuntimeOptions {
  readonly workspaceId: WorkspaceId;
  readonly cwd: string;
  readonly threadId: ThreadId;
  readonly writer: ThreadJournalWriter;
  readonly attachment: RuntimeThreadDriverAttachment;
  readonly identityFactory: ThreadIdentityPort;
  readonly clock: RuntimeClock;
  readonly permissionPolicy: PermissionPolicyPort;
  readonly threadCeiling: PermissionCeilingSnapshot;
  readonly onThreadResultPending?: (result: ThreadResultOutboxMutation) => Promise<void>;
  readonly onWorkspaceApprovalFatal?: (error: Error) => void;
  readonly workspaceApprovalFailure?: () => Error | undefined;
  readonly capabilityServices?: Readonly<RuntimeCapabilityServices>;
  readonly threadPolicyEngine?: ThreadPolicyEngine;
  readonly policyGrants?: PolicyGrantRepositoryPort;
}

type CapabilityApprovalResult =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: string }
  | { readonly kind: 'aborted' };

interface PendingApprovalWaiter {
  readonly requestId: string;
  readonly owningRunId: RunId;
  readonly owningTurnId: TurnId;
  readonly resolve: (result: CapabilityApprovalResult) => void;
}

interface RuntimeTurnCaptureState {
  readonly promise: Promise<RuntimeTurnPort>;
  status: 'capturing' | 'captured' | 'failed';
  consumedRuleScopes?: readonly string[];
  ruleDiagnostics?: readonly Readonly<RuleSnapshotDiagnostic>[];
}

export class ThreadDriverHostController implements ThreadDriverHostServices {
  #runtime: ThreadRuntime | undefined;

  bind(runtime: ThreadRuntime): void {
    if (this.#runtime !== undefined) throw new Error('Thread driver host is already bound');
    this.#runtime = runtime;
  }

  commitEvent(
    event: ThreadDriverEvent,
    checkpointMutation?: ThreadDriverCheckpointMutation,
  ): Promise<void> {
    return this.#get().commitDriverEvent(event, checkpointMutation);
  }

  commitEventBatch(
    events: readonly [ThreadDriverEvent, ...ThreadDriverEvent[]],
    checkpointMutation?: ThreadDriverCheckpointMutation,
  ): Promise<void> {
    return this.#get().commitDriverEventBatch(events, checkpointMutation);
  }

  reserveSuccessor(input: {
    readonly threadId: ThreadId;
    readonly predecessorRunId: RunId;
    readonly reason: 'retry' | 'compaction';
  }): Promise<{ readonly runId: RunId; readonly permissionCeiling: PermissionCeilingSnapshot }> {
    return this.#get().reserveSuccessor(input);
  }

  reserveTurn(input: {
    readonly runId: RunId;
    readonly turnOrdinal: number;
  }): Promise<{
    readonly turnId: TurnId;
    readonly workspaceCeiling: PermissionCeilingSnapshot;
    readonly runCeiling: PermissionCeilingSnapshot;
    readonly turnCeiling: PermissionCeilingSnapshot;
  }> {
    return this.#get().reserveTurn(input);
  }

  captureRuntimeTurn(input: {
    readonly rootOpId: ExternalOpId;
    readonly runId: RunId;
    readonly turnId: TurnId;
    readonly model: Readonly<ModelConfig>;
    readonly transcript: readonly Readonly<AgentMessage>[];
    readonly signal: AbortSignal;
  }): Promise<RuntimeTurnPort> {
    return this.#get().captureRuntimeTurn(input);
  }

  #get(): ThreadRuntime {
    if (this.#runtime === undefined) throw new Error('Thread driver emitted before attachment activation');
    return this.#runtime;
  }
}

export class ThreadRuntime {
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly #cwd: string;
  readonly #writer: ThreadJournalWriter;
  readonly #attachment: RuntimeThreadDriverAttachment;
  readonly #identityFactory: ThreadIdentityPort;
  readonly #clock: RuntimeClock;
  readonly #permissionPolicy: PermissionPolicyPort;
  readonly #threadCeiling: PermissionCeilingSnapshot;
  readonly #onThreadResultPending: ((result: ThreadResultOutboxMutation) => Promise<void>) | undefined;
  readonly #onWorkspaceApprovalFatal: ((error: Error) => void) | undefined;
  readonly #workspaceApprovalFailure: (() => Error | undefined) | undefined;
  readonly #capabilityServices: Readonly<RuntimeCapabilityServices> | undefined;
  readonly #threadPolicyEngine: ThreadPolicyEngine | undefined;
  readonly #policyGrants: PolicyGrantRepositoryPort | undefined;
  readonly #fileTracker = new FileTracker();
  readonly #approvalWaiters = new Map<string, PendingApprovalWaiter>();
  readonly #runtimeTurnCaptures = new Map<string, RuntimeTurnCaptureState>();
  #admission: Promise<void> = Promise.resolve();
  #active: ActiveRun | undefined;
  readonly #queuedActivities: QueuedActivity[] = [];
  #closing = false;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #effectBarrier: Promise<void> = Promise.resolve();
  readonly #background = new Set<Promise<void>>();
  readonly #bestEffort = new Set<Promise<void>>();
  readonly #backgroundFailures: unknown[] = [];
  #approvalFatal: Error | undefined;
  readonly #turnReservations = new Map<string, {
    readonly turnId: TurnId;
    readonly workspaceCeiling: PermissionCeilingSnapshot;
    readonly runCeiling: PermissionCeilingSnapshot;
    readonly turnCeiling: PermissionCeilingSnapshot;
    readonly turnOrdinal: number;
    activated: boolean;
  }>();
  readonly #successors = new Map<string, {
    readonly runId: RunId;
    readonly permissionCeiling: PermissionCeilingSnapshot;
    readonly predecessorRunId: RunId;
    readonly reason: 'retry' | 'compaction';
  }>();
  #pendingSuccessor: {
    readonly runId: RunId;
    readonly permissionCeiling: PermissionCeilingSnapshot;
    readonly predecessorRunId: RunId;
    readonly reason: 'retry' | 'compaction';
  } | undefined;

  constructor(options: ThreadRuntimeOptions) {
    this.workspaceId = options.workspaceId;
    this.threadId = options.threadId;
    this.#cwd = options.cwd;
    this.#writer = options.writer;
    this.#attachment = options.attachment;
    this.#identityFactory = options.identityFactory;
    this.#clock = options.clock;
    this.#permissionPolicy = options.permissionPolicy;
    this.#threadCeiling = options.threadCeiling;
    this.#onThreadResultPending = options.onThreadResultPending;
    this.#onWorkspaceApprovalFatal = options.onWorkspaceApprovalFatal;
    this.#workspaceApprovalFailure = options.workspaceApprovalFailure;
    this.#capabilityServices = options.capabilityServices;
    this.#threadPolicyEngine = options.threadPolicyEngine;
    this.#policyGrants = options.policyGrants;
    for (const run of this.#writer.state.runs.values()) {
      if (run.predecessorRunId === undefined || (run.reason !== 'retry' && run.reason !== 'compaction')) continue;
      this.#successors.set(successorKey(run.predecessorRunId, run.reason), {
        runId: run.runId,
        permissionCeiling: run.permissionCeiling,
        predecessorRunId: run.predecessorRunId,
        reason: run.reason,
      });
    }
    for (const turn of this.#writer.state.turns.values()) {
      if (
        turn.workspaceCeiling === undefined ||
        turn.runCeiling === undefined ||
        turn.turnCeiling === undefined
      ) continue;
      const reservation = {
        turnId: turn.turnId,
        workspaceCeiling: turn.workspaceCeiling,
        runCeiling: turn.runCeiling,
        turnCeiling: turn.turnCeiling,
        turnOrdinal: turn.turnOrdinal,
        activated: turn.activated,
      };
      this.#turnReservations.set(turnOrdinalKey(turn.runId, turn.turnOrdinal), reservation);
      this.#turnReservations.set(turnIdentityKey(turn.runId, turn.turnId), reservation);
    }
  }

  snapshot(): Readonly<ThreadSnapshot> {
    return snapshotFromFold(this.#writer.state);
  }

  durableState(): FoldedThreadJournal {
    return this.#writer.state;
  }

  summary(): import('../protocol/index.js').ThreadSummary {
    return this.#writer.state.summary;
  }

  /**
   * ThreadRuntime quiescence barrier. It observes the same FIFO/effect/background lanes as close(),
   * but neither closes the driver nor waits for ordinary EventHub observers.
   */
  async waitForIdle(): Promise<void> {
    while (true) {
      const admission = this.#admission;
      const effect = this.#effectBarrier;
      const background = [...this.#background];
      await admission;
      await effect;
      await Promise.all(background);
      if (this.#backgroundFailures.length > 0) {
        throw new AggregateError(
          [...this.#backgroundFailures],
          `Thread ${this.threadId} background execution failed`,
        );
      }
      if (
        admission === this.#admission
        && effect === this.#effectBarrier
        && this.#background.size === 0
        && this.#active === undefined
        && this.#attachment.driver.interactionState() === 'idle'
      ) {
        return;
      }
    }
  }

  activeRunId(): RunId | undefined {
    return this.#active?.currentRunId;
  }

  currentAbortTarget(): ResolvedAbortTarget {
    return this.#resolveAbortTarget();
  }

  activeRunCeiling(runId: RunId): PermissionCeilingSnapshot | undefined {
    if (this.#active?.currentRunId === runId) return this.#active.currentCeiling;
    return this.#writer.state.runs.get(runId)?.permissionCeiling;
  }

  stopForWorkspaceApprovalFatal(error: Error): void {
    if (this.#approvalFatal !== undefined) return;
    this.#approvalFatal = error;
    const active = this.#active;
    try {
      if (active !== undefined) {
        const cancellation = this.#attachment.driver.dispatch({
          op: {
            type: 'abort',
            opId: active.rootOpId,
            workspaceId: this.workspaceId,
            threadId: this.threadId,
            expectedRunId: active.currentRunId,
          },
          resolvedTarget: { kind: 'run', runId: active.currentRunId },
        }).completion;
        void cancellation.catch(() => undefined);
      }
    } catch {
      // The fatal gate remains authoritative even when best-effort driver cancellation fails.
    }
    if (active !== undefined) {
      // A workspace fatal may race the control_request append outside admission. Queue the durable
      // resolution behind that append and only wake approval waiters after control_resolved commits.
      this.#track(this.#withAdmission(() => this.#abortPendingControls(active.rootOpId)));
    }
  }

  async commitThreadResult(result: ThreadResultOutboxMutation): Promise<number> {
    if (result.parentThreadId !== this.threadId) throw new Error('thread_result_parent_mismatch');
    const existing = this.#writer.state.envelopes.find((envelope) => envelope.opId === result.resultOpId);
    if (existing !== undefined) {
      if (existing.event.type !== 'thread_result' || canonicalJson(existing.event) !== canonicalJson({
        type: 'thread_result',
        resultOpId: result.resultOpId,
        childThreadId: result.childThreadId,
        terminalRunId: result.terminalRunId,
        status: result.status,
        ...(result.summary !== undefined && { summary: result.summary }),
      })) {
        throw new RuntimeStorageError('thread_result_conflict', result.resultOpId);
      }
      return existing.seq;
    }
    const [envelope] = await this.#writer.commit([{
      event: {
        type: 'thread_result',
        resultOpId: result.resultOpId,
        childThreadId: result.childThreadId,
        terminalRunId: result.terminalRunId,
        status: result.status,
        ...(result.summary !== undefined && { summary: result.summary }),
      },
      opId: result.resultOpId,
    }]);
    if (envelope === undefined) throw new Error('thread_result_commit_missing');
    return envelope.seq;
  }

  async acknowledgeThreadResult(record: ThreadResultDeliveryRecord): Promise<void> {
    if (this.#writer.state.deliveredThreadResults.has(record.resultOpId)) return;
    await this.#writer.appendPrepare(record);
  }

  acceptExternal(
    op: ExternalThreadRuntimeOp,
    prepared?: ThreadRuntimePreparedInput,
  ): Promise<OpReceipt> {
    return this.#withAdmission(() => this.#acceptExternal(op, prepared));
  }

  acceptInternal(op: InternalThreadRuntimeOp): Promise<InternalOpReceipt> {
    return this.#withAdmission(() => this.#acceptInternal(op));
  }

  async commitDriverEvent(
    input: ThreadDriverEvent,
    checkpointMutation?: ThreadDriverCheckpointMutation,
  ): Promise<void> {
    await this.commitDriverEventBatch([input], checkpointMutation);
  }

  async commitDriverEventBatch(
    inputs: readonly [ThreadDriverEvent, ...ThreadDriverEvent[]],
    checkpointMutation?: ThreadDriverCheckpointMutation,
  ): Promise<void> {
    if (this.#closed) throw new Error(`Thread ${this.threadId} is closed`);
    const extra: RuntimeThreadMutation[] = [];
    let activatesSuccessor = false;
    const pendingSuccessor = this.#pendingSuccessor;
    const virtuallyActivatedRuns = new Set<RunId>();
    const virtuallyActivatedTurns = new Set<string>();
    const deferredTurnDiagnostics: CommitEnvelopeInput[] = [];
    const turnCapturesToRelease = new Set<string>();
    const turnsToActivate: Array<{
      readonly key: string;
      readonly reservation: {
        activated: boolean;
        readonly turnOrdinal: number;
      };
    }> = [];
    let inputMaterialized = false;
    for (const input of inputs) {
      this.#assertDriverEventIdentity(input, virtuallyActivatedRuns, virtuallyActivatedTurns);
      const activatesAtAgentEnd =
        !activatesSuccessor &&
        pendingSuccessor !== undefined &&
        input.event.type === 'agent_end' &&
        input.runId === pendingSuccessor.predecessorRunId;
      const activatesAtCompactionStart =
        !activatesSuccessor &&
        pendingSuccessor !== undefined &&
        pendingSuccessor.reason === 'compaction' &&
        input.event.type === 'compaction_start' &&
        input.runId === pendingSuccessor.runId &&
        input.event.predecessorRunId === pendingSuccessor.predecessorRunId;
      if (pendingSuccessor !== undefined && this.#active !== undefined
        && (activatesAtAgentEnd || activatesAtCompactionStart)) {
        const predecessor = this.#writer.state.runs.get(pendingSuccessor.predecessorRunId);
        if (predecessor === undefined) throw new Error('successor predecessor is not durable');
        extra.push(
          {
            type: 'run_terminal',
            runId: pendingSuccessor.predecessorRunId,
            status: input.event.type === 'agent_end'
              ? input.event.reason === 'aborted'
                ? 'aborted'
                : input.event.reason === 'error' ? 'error' : 'completed'
              : input.event.reason === 'overflow' ? 'error' : 'completed',
          },
          {
            type: 'run_reserved',
            runId: pendingSuccessor.runId,
            reason: pendingSuccessor.reason,
            predecessorRunId: pendingSuccessor.predecessorRunId,
            permissionCeiling: pendingSuccessor.permissionCeiling,
          },
        );
        virtuallyActivatedRuns.add(pendingSuccessor.runId);
        if (activatesAtCompactionStart) {
          extra.push({ type: 'run_started', runId: pendingSuccessor.runId });
        }
        activatesSuccessor = true;
      }
      if (
        !activatesAtCompactionStart
        && input.event.type === 'compaction_start'
        && input.runId !== undefined
        && this.#writer.state.runs.get(input.runId)?.state === 'reserved'
      ) {
        // Automatic compaction reserves its successor atomically with the predecessor agent_end.
        // Its later compaction_start is therefore the durable transition that starts that run.
        extra.push({ type: 'run_started', runId: input.runId });
      }
      if (input.event.type === 'turn_start') {
        if (input.runId === undefined || input.turnId === undefined) {
          throw new Error('turn_start requires a reserved runId/turnId');
        }
        const key = turnIdentityKey(input.runId, input.turnId);
        const reservation = this.#turnReservations.get(key);
        if (reservation === undefined || reservation.activated || virtuallyActivatedTurns.has(key)) {
          throw new Error('turn_start does not match a fresh turn reservation');
        }
        const capture = this.#runtimeTurnCaptures.get(key);
        if (this.#capabilityServices !== undefined && capture === undefined) {
          throw new Error('registry_turn_capture_missing');
        }
        if (capture?.status === 'capturing') {
          throw new Error('registry_turn_capture_incomplete');
        }
        virtuallyActivatedTurns.add(key);
        turnsToActivate.push({ key, reservation });
        extra.push({
          type: 'turn_activated',
          runId: input.runId,
          turnId: input.turnId,
          turnOrdinal: reservation.turnOrdinal,
        });
        if (capture?.status === 'captured') {
          const consumedScopes = capture.consumedRuleScopes ?? [];
          if (consumedScopes.length > 0) {
            extra.push({
              type: 'rule_scope_window_replaced',
              consumedScopes,
              replacementScopes: [],
              owningTurnId: input.turnId,
            });
          }
          for (const diagnostic of capture.ruleDiagnostics ?? []) {
            deferredTurnDiagnostics.push({
              event: {
                type: 'runtime_diagnostic',
                severity: 'warning',
                code: diagnostic.code,
                message: diagnostic.path === undefined
                  ? diagnostic.message
                  : `${diagnostic.path}: ${diagnostic.message}`,
                scope: 'turn',
              },
              runId: input.runId,
              turnId: input.turnId,
            });
          }
        }
      }
      if (input.event.type === 'turn_end' && input.runId !== undefined && input.turnId !== undefined) {
        turnCapturesToRelease.add(turnIdentityKey(input.runId, input.turnId));
      }
      if (input.event.type === 'agent_start' && input.runId !== undefined) {
        const run = this.#writer.state.runs.get(input.runId);
        if (run?.state === 'reserved' || virtuallyActivatedRuns.has(input.runId)) {
          extra.push({ type: 'run_started', runId: input.runId });
        }
      }
      if (!inputMaterialized
        && input.event.type === 'message_end'
        && input.event.message.role === 'user'
        && input.event.message.source === 'prompt'
        && this.#active !== undefined
        && this.#writer.state.inputOwners.has(this.#active.rootOpId)) {
        extra.push({
          type: 'input_materialized',
          ownerOpId: this.#active.rootOpId,
          messageId: input.event.message.id,
        });
        inputMaterialized = true;
      }
    }
    await this.#writer.commitDriverEvents(inputs, checkpointMutation, extra);
    for (const { reservation } of turnsToActivate) reservation.activated = true;
    if (deferredTurnDiagnostics.length > 0) {
      await this.#writer.commit([
        deferredTurnDiagnostics[0]!,
        ...deferredTurnDiagnostics.slice(1),
      ]);
    }
    for (const key of turnCapturesToRelease) this.#runtimeTurnCaptures.delete(key);
    if (activatesSuccessor) this.#pendingSuccessor = undefined;
  }

  reserveSuccessor(input: {
    readonly threadId: ThreadId;
    readonly predecessorRunId: RunId;
    readonly reason: 'retry' | 'compaction';
  }): Promise<{ readonly runId: RunId; readonly permissionCeiling: PermissionCeilingSnapshot }> {
    return this.#withAdmission(async () => {
      this.#assertWorkspaceCapabilitiesAvailable();
      if (input.threadId !== this.threadId) throw new Error('invalid_successor_reservation');
      const key = successorKey(input.predecessorRunId, input.reason);
      const existing = this.#successors.get(key);
      if (existing !== undefined) return existing;
      if (this.#active?.currentRunId !== input.predecessorRunId) {
        throw new Error('invalid_successor_reservation');
      }
      if ([...this.#successors.values()].some((candidate) => candidate.predecessorRunId === input.predecessorRunId)) {
        throw new Error('invalid_successor_reservation');
      }
      const runId = this.#newRunId();
      const workspaceCeiling = await this.#workspaceCeiling();
      const permissionCeiling = validatePermissionCeilingSnapshot(await this.#permissionPolicy.resolveCeiling({
        kind: 'run',
        workspaceId: this.workspaceId,
        threadId: this.threadId,
        runId,
        workspaceCeiling,
        threadCeiling: this.#threadCeiling,
        predecessorRunId: input.predecessorRunId,
        predecessorCeiling: this.#active.currentCeiling,
      }));
      this.#assertWorkspaceCapabilitiesAvailable();
      await this.#writer.appendPrepare({
        type: 'successor_run_prepare',
        runId,
        predecessorRunId: input.predecessorRunId,
        reason: input.reason,
        permissionCeiling,
        timestamp: this.#clock.now(),
      });
      this.#assertWorkspaceCapabilitiesAvailable();
      const reservation = {
        runId,
        permissionCeiling,
        predecessorRunId: input.predecessorRunId,
        reason: input.reason,
      };
      this.#successors.set(key, reservation);
      this.#pendingSuccessor = reservation;
      this.#active.currentRunId = runId;
      this.#active.currentCeiling = permissionCeiling;
      return reservation;
    });
  }

  captureRuntimeTurn(input: {
    readonly rootOpId: ExternalOpId;
    readonly runId: RunId;
    readonly turnId: TurnId;
    readonly model: Readonly<ModelConfig>;
    readonly transcript: readonly Readonly<AgentMessage>[];
    readonly signal: AbortSignal;
  }): Promise<RuntimeTurnPort> {
    const key = turnIdentityKey(input.runId, input.turnId);
    const existing = this.#runtimeTurnCaptures.get(key);
    if (existing !== undefined) return existing.promise;

    const state = {} as RuntimeTurnCaptureState;
    const promise = Promise.resolve()
      .then(() => this.#captureRuntimeTurnOnce(input, state))
      .then(
        (runtimeTurn) => {
          state.status = 'captured';
          return runtimeTurn;
        },
        (error: unknown) => {
          state.status = 'failed';
          throw error;
        },
      );
    Object.assign(state, { promise, status: 'capturing' as const });
    // Publish the single-flight before invoking any mutable snapshot source. Serial and concurrent
    // callers for the same identity therefore observe the exact same immutable RuntimeTurnPort.
    this.#runtimeTurnCaptures.set(key, state);
    return promise;
  }

  async #captureRuntimeTurnOnce(
    input: {
      readonly rootOpId: ExternalOpId;
      readonly runId: RunId;
      readonly turnId: TurnId;
      readonly model: Readonly<ModelConfig>;
      readonly transcript: readonly Readonly<AgentMessage>[];
      readonly signal: AbortSignal;
    },
    state: RuntimeTurnCaptureState,
  ): Promise<RuntimeTurnPort> {
    this.#assertWorkspaceCapabilitiesAvailable();
    const services = this.#capabilityServices;
    const policyEngine = this.#threadPolicyEngine;
    const grantsRepository = this.#policyGrants;
    if (services === undefined || policyEngine === undefined || grantsRepository === undefined) {
      throw new Error('registry_runtime_services_unavailable');
    }
    const active = this.#active;
    if (active === undefined
      || active.rootOpId !== input.rootOpId
      || active.currentRunId !== input.runId) {
      throw new Error('registry_turn_identity_mismatch');
    }
    const reservation = this.#turnReservations.get(turnIdentityKey(input.runId, input.turnId));
    if (reservation === undefined) {
      throw new Error('registry_turn_not_reserved');
    }
    if (reservation.activated) {
      throw new Error('registry_turn_capture_after_start');
    }

    // Snapshot every mutable source exactly once at the turn boundary. Later preparation and
    // execution only retain references captured below, so hot updates affect the next turn only.
    const context = strictJsonSnapshot({
      workspaceId: this.workspaceId,
      threadId: this.threadId,
      runId: input.runId,
      turnId: input.turnId,
      cwd: this.#cwd,
    }) as unknown as Readonly<TurnPolicyContext>;
    const modelView = strictJsonSnapshot({
      ref: input.model.ref,
      ...(input.model.limits !== undefined && { limits: input.model.limits }),
    }) as unknown as Readonly<import('../capabilities/types.js').PromptModelView>;
    const catalog = services.capabilities.snapshot();
    const providers = services.providers.snapshot();
    const provider = providers.resolve(input.model.ref.api);
    throwIfTurnCaptureAborted(input.signal);
    const grants = await awaitTurnCaptureGate(grantsRepository.snapshot(), input.signal);
    const knownResourceScopes = [...this.#writer.state.observedRuleScopes].sort(compareUtf8);
    const ruleCapture = await awaitTurnCaptureGate(
      services.ruleSnapshots.capture(strictJsonSnapshot({
        context,
        knownResourceScopes,
        budget: services.ruleBudget,
      }) as unknown as Parameters<typeof services.ruleSnapshots.capture>[0]),
      input.signal,
    );
    if (!ruleCapture.ok) {
      throw new Error(`${ruleCapture.code}: ${ruleCapture.message}`);
    }
    const basePrompt = await awaitTurnCaptureGate(
      services.basePrompts.capture(strictJsonSnapshot({
        context,
        model: modelView,
      }) as unknown as Parameters<typeof services.basePrompts.capture>[0]),
      input.signal,
    );
    const effectivePolicy = await awaitTurnCaptureGate(policyEngine.capture({
      context,
      workspaceCeiling: reservation.workspaceCeiling,
      runCeiling: reservation.runCeiling,
      turnCeiling: reservation.turnCeiling,
      rules: ruleCapture.snapshot,
      grants,
    }), input.signal);
    this.#assertWorkspaceCapabilitiesAvailable();
    state.consumedRuleScopes = Object.freeze([...knownResourceScopes]);
    state.ruleDiagnostics = strictJsonSnapshot(
      ruleCapture.snapshot.discovery.diagnostics,
    ) as unknown as readonly Readonly<RuleSnapshotDiagnostic>[];
    // The transcript is an ownership witness supplied by the driver. PromptAssembler receives the
    // post-transform outbound view later; retaining this mutable array would violate snapshotting.
    void input.transcript;

    const streamFn = provider?.stream ?? ((model) => unsupportedProviderStream(
      model,
      this.#clock.now(),
      `No provider adapter is registered for API ${JSON.stringify(model.ref.api)}`,
    ));
    const runtimeTurn: RuntimeTurnPort = {
      streamFn,
      assemble: (outboundMessages) => services.promptAssembler.assemble({
        basePrompt,
        outboundMessages,
        effectivePolicy,
        model: modelView,
        catalog,
      }),
      prepareToolCall: async (call, sourceOrdinal, signal) => {
        const aborted = preflightAbort(signal);
        if (aborted !== undefined) return aborted;
        const invocationId = deriveInvocationId({
          workspaceId: this.workspaceId,
          threadId: this.threadId,
          runId: input.runId,
          turnId: input.turnId,
          sourceOrdinal,
        });
        const prepared = await catalog.prepare({
          capabilityId: call.name,
          rawArgs: call.arguments,
          context: {
            workspaceId: this.workspaceId,
            threadId: this.threadId,
            runId: input.runId,
            turnId: input.turnId,
            opId: input.rootOpId,
            invocationId,
            toolCallId: call.id,
            capabilityId: call.name,
            catalogRevision: catalog.revision,
            cwd: this.#cwd,
          },
          effectivePolicy,
        });
        const abortedAfterCatalog = preflightAbort(signal);
        if (abortedAfterCatalog !== undefined) return abortedAfterCatalog;
        if (!prepared.ok) return { ok: false, message: prepared.message };
        const invocation = prepared.invocation;
        const firstFreshness = await this.#checkInvocationFreshness(invocation, signal);
        if (!firstFreshness.ok) return firstFreshness;
        const abortedAfterFreshness = preflightAbort(signal);
        if (abortedAfterFreshness !== undefined) return abortedAfterFreshness;
        const rawDecision: unknown = await policyEngine.evaluate(invocation);
        const abortedAfterPolicy = preflightAbort(signal);
        if (abortedAfterPolicy !== undefined) return abortedAfterPolicy;
        const decision = snapshotPolicyDecision(rawDecision);
        if (decision === undefined) {
          return { ok: false, message: 'Policy engine returned an invalid decision.' };
        }
        if (decision.kind === 'deny') return { ok: false, message: decision.reason };
        if (decision.kind === 'ask') {
          const approval = await this.#requestRegistryApproval(invocation, decision, signal);
          const abortedAfterApproval = preflightAbort(signal);
          if (abortedAfterApproval !== undefined) return abortedAfterApproval;
          if (approval.kind === 'deny') return { ok: false, message: approval.reason };
          if (approval.kind === 'aborted') {
            return { ok: false, message: 'Tool execution was interrupted before approval completed.' };
          }
        }
        return {
          ok: true,
          args: invocation.args,
          executionMode: invocation.executionMode,
          execute: async ({ signal, onUpdate }) => {
            const abortedBeforeFreshness = preflightAbort(signal);
            if (abortedBeforeFreshness !== undefined) throw new Error(abortedBeforeFreshness.message);
            const finalFreshness = await this.#checkInvocationFreshness(invocation, signal);
            if (!finalFreshness.ok) throw new Error(finalFreshness.message);
            const abortedAfterFreshness = preflightAbort(signal);
            if (abortedAfterFreshness !== undefined) throw new Error(abortedAfterFreshness.message);
            this.#assertWorkspaceCapabilitiesAvailable();
            const abortedBeforeExecutor = preflightAbort(signal);
            if (abortedBeforeExecutor !== undefined) throw new Error(abortedBeforeExecutor.message);
            return invocation.executor(invocation.args, {
              ...invocation.context,
              signal,
              onUpdate,
              services: { fileTracker: this.#fileTracker },
            });
          },
        };
      },
    };
    return Object.freeze(runtimeTurn);
  }

  async #checkInvocationFreshness(
    invocation: Readonly<PreparedInvocation>,
    signal: AbortSignal,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> {
    const aborted = preflightAbort(signal);
    if (aborted !== undefined) return aborted;
    const services = this.#capabilityServices;
    if (services === undefined) return { ok: false, message: 'Registry runtime services are unavailable.' };
    this.#assertWorkspaceCapabilitiesAvailable();
    let freshness: unknown;
    try {
      freshness = await services.ruleFreshness.check({
        snapshot: invocation.effectivePolicy.rules,
        context: invocation.context,
        resources: invocation.resources,
        analysis: invocation.analysis,
      });
    } catch (error) {
      const abortedAfterFailure = preflightAbort(signal);
      if (abortedAfterFailure !== undefined) return abortedAfterFailure;
      return {
        ok: false,
        message: `Rule freshness check failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const abortedAfterCheck = preflightAbort(signal);
    if (abortedAfterCheck !== undefined) return abortedAfterCheck;
    this.#assertWorkspaceCapabilitiesAvailable();
    if (freshness === null || typeof freshness !== 'object' || Array.isArray(freshness)) {
      return { ok: false, message: 'Rule freshness checker returned an invalid result.' };
    }
    const result = freshness as Record<string, unknown>;
    const resultKeys = Object.keys(result).sort();
    if (result.fresh === true) {
      return resultKeys.length === 1 && resultKeys[0] === 'fresh'
        ? { ok: true }
        : { ok: false, message: 'Rule freshness checker returned an invalid result.' };
    }
    if (result.fresh !== false
      || (result.code !== 'rule_scope_missing' && result.code !== 'rule_changed')
      || typeof result.message !== 'string'
      || (result.code === 'rule_changed'
        ? canonicalJson(resultKeys) !== canonicalJson(['code', 'fresh', 'message'])
        : canonicalJson(resultKeys) !== canonicalJson(['code', 'fresh', 'message', 'missingScopes']))) {
      return { ok: false, message: 'Rule freshness checker returned an invalid result.' };
    }
    if (result.code === 'rule_scope_missing') {
      let missingScopes: readonly string[];
      try {
        missingScopes = strictJsonSnapshot(result.missingScopes) as unknown as readonly string[];
        if (missingScopes.length === 0
          || missingScopes.some((scope) => typeof scope !== 'string' || scope.length === 0)
          || missingScopes.some((scope, index) => index > 0
            && compareUtf8(missingScopes[index - 1]!, scope) >= 0)) {
          throw new TypeError('missingScopes must be non-empty, unique, and UTF-8 sorted');
        }
      } catch (error) {
        return {
          ok: false,
          message: `Invalid rule freshness result: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const unseen = missingScopes.filter((scope) => !this.#writer.state.observedRuleScopes.has(scope));
      if (unseen.length > 0) {
        const abortedBeforeCommit = preflightAbort(signal);
        if (abortedBeforeCommit !== undefined) return abortedBeforeCommit;
        await this.#writer.commit([{
          event: {
            type: 'runtime_diagnostic',
            severity: 'warning',
            code: 'rule_scope_observed',
            message: `Observed ${unseen.length} new rule scope${unseen.length === 1 ? '' : 's'}`,
            scope: 'thread',
          },
        }], unseen.map((scope) => ({
          type: 'rule_scope_observed' as const,
          scope,
          owningTurnId: invocation.context.turnId,
          invocationId: invocation.context.invocationId,
        })));
        const abortedAfterCommit = preflightAbort(signal);
        if (abortedAfterCommit !== undefined) return abortedAfterCommit;
      }
    }
    return { ok: false, message: result.message };
  }

  async #requestRegistryApproval(
    invocation: Readonly<PreparedInvocation>,
    decision: Extract<PolicyDecision, { readonly kind: 'ask' }>,
    signal: AbortSignal,
  ): Promise<CapabilityApprovalResult> {
    if (signal.aborted) return { kind: 'aborted' };
    this.#assertWorkspaceCapabilitiesAvailable();
    if (this.#policyGrants === undefined) throw new Error('policy_grant_repository_unavailable');
    const context = invocation.context;
    let waiter: Promise<CapabilityApprovalResult> | undefined;
    await this.#withAdmission(async () => {
      if (signal.aborted) {
        waiter = Promise.resolve({ kind: 'aborted' });
        return;
      }
      this.#assertWorkspaceCapabilitiesAvailable();
      const activity = this.#writer.state.checkpoint.frontend.activity;
      if (this.#closing || this.#closed
        || this.#active?.currentRunId !== context.runId
        || activity?.turnId !== context.turnId) {
        waiter = Promise.resolve({ kind: 'aborted' });
        return;
      }
      const requestId = this.#newApprovalRequestId();
      const requestPayload = strictJsonSnapshot({
        toolCallId: context.toolCallId,
        description: decision.description,
        ...(decision.grantProposal !== undefined && {
          grantProposal: {
            capabilityId: context.capabilityId,
            capabilityVersion: invocation.capabilityVersion,
            registrationDigest: invocation.registrationDigest,
            policyBasisRevision: invocation.effectivePolicy.policyBasisRevision,
            scope: decision.grantProposal,
          },
        }),
        presentation: {
          requestId,
          target: {
            workspaceId: context.workspaceId,
            threadId: context.threadId,
            runId: context.runId,
            turnId: context.turnId,
          },
          capability: {
            id: context.capabilityId,
            version: invocation.capabilityVersion,
            registrationDigest: invocation.registrationDigest,
          },
          normalizedResources: invocation.resources.map((resource) => ({
            selectorId: resource.selectorId,
            resourceType: resource.resourceType,
            access: resource.access,
            canonicalTarget: resource.canonicalTarget,
          })),
          risk: {
            code: decision.code,
            reason: decision.reason,
            description: decision.description,
          },
          allowOnce: {
            invocationId: context.invocationId,
            toolCallId: context.toolCallId,
          },
          ...(decision.grantProposal === undefined
            ? {}
            : { allowAlways: decision.grantProposal }),
          revisions: {
            catalog: context.catalogRevision,
            effectivePolicy: invocation.effectivePolicy.revision,
            policyBasis: invocation.effectivePolicy.policyBasisRevision,
            ceiling: invocation.effectivePolicy.ceilingRevision,
            grants: invocation.effectivePolicy.grantRevision,
          },
        },
      }) as unknown as Extract<
        import('../protocol/index.js').RuntimeControlEvent,
        { type: 'control_request'; kind: 'approval' }
      >['payload'];
      await this.#writer.commitDriverEvent({
        event: {
          type: 'control_request',
          requestId,
          kind: 'approval',
          owningRunId: context.runId,
          owningTurnId: context.turnId,
          policyRevision: invocation.effectivePolicy.revision,
          payload: requestPayload,
        },
        runId: context.runId,
        turnId: context.turnId,
      });
      let resolveWaiter!: (result: CapabilityApprovalResult) => void;
      waiter = new Promise<CapabilityApprovalResult>((resolve) => {
        resolveWaiter = resolve;
      });
      this.#approvalWaiters.set(requestId, {
        requestId,
        owningRunId: context.runId,
        owningTurnId: context.turnId,
        resolve: resolveWaiter,
      });
    });
    if (waiter === undefined) throw new Error('registry_approval_waiter_not_created');
    // Canonical abort resolves this waiter only after control_resolved is durable. Returning on the
    // raw signal here would let the Agent advance past the authoritative cancellation boundary.
    return waiter;
  }

  reserveTurn(input: {
    readonly runId: RunId;
    readonly turnOrdinal: number;
  }): Promise<{
    readonly turnId: TurnId;
    readonly workspaceCeiling: PermissionCeilingSnapshot;
    readonly runCeiling: PermissionCeilingSnapshot;
    readonly turnCeiling: PermissionCeilingSnapshot;
  }> {
    return this.#withAdmission(async () => {
      if (!Number.isSafeInteger(input.turnOrdinal) || input.turnOrdinal < 1) {
        throw new Error('invalid_turn_reservation');
      }
      const ordinalKey = turnOrdinalKey(input.runId, input.turnOrdinal);
      const prior = this.#turnReservations.get(ordinalKey);
      if (prior !== undefined) return prior;
      this.#assertWorkspaceCapabilitiesAvailable();
      if (this.#active?.currentRunId !== input.runId) {
        throw new Error('invalid_turn_reservation');
      }
      const previousOrdinals = [...this.#writer.state.turns.values()]
        .filter((turn) => turn.runId === input.runId)
        .map((turn) => turn.turnOrdinal);
      const expected = (previousOrdinals.length === 0 ? 0 : Math.max(...previousOrdinals)) + 1;
      if (input.turnOrdinal !== expected) throw new Error('invalid_turn_reservation');
      const turnId = this.#newTurnId();
      const workspaceCeiling = await this.#workspaceCeiling();
      const runCeiling = this.#active.currentCeiling;
      const turnCeiling = validatePermissionCeilingSnapshot(await this.#permissionPolicy.resolveCeiling({
        kind: 'turn',
        workspaceId: this.workspaceId,
        threadId: this.threadId,
        runId: input.runId,
        turnId,
        workspaceCeiling,
        runCeiling,
      }));
      this.#assertWorkspaceCapabilitiesAvailable();
      await this.#writer.appendPrepare({
        type: 'turn_prepare',
        runId: input.runId,
        turnId,
        turnOrdinal: input.turnOrdinal,
        workspaceCeiling,
        runCeiling,
        turnCeiling,
        timestamp: this.#clock.now(),
      });
      const reservation = {
        turnId,
        workspaceCeiling,
        runCeiling,
        turnCeiling,
        turnOrdinal: input.turnOrdinal,
        activated: false,
      };
      this.#turnReservations.set(ordinalKey, reservation);
      this.#turnReservations.set(turnIdentityKey(input.runId, turnId), reservation);
      // Once appendPrepare resolves, the TurnId is authoritative even if a workspace-wide fatal
      // gate latched concurrently. Return the durable reservation; the immediately following
      // runtime-turn capture observes the fatal gate and can still form a correctly identified
      // error/aborted turn instead of stranding an unknown TurnId.
      return reservation;
    });
  }

  close(op?: InternalThreadRuntimeOp | Extract<RuntimeOp, { type: 'thread_close' }>): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closing = true;
    this.#closePromise = (async () => {
      await this.#admission;
      const failures: unknown[] = [];
      if (this.#active !== undefined) {
        const abortCommand: PreparedThreadDriverCommand = {
          op: {
            type: 'abort',
            opId: op?.opId ?? this.#active.rootOpId,
            workspaceId: this.workspaceId,
            threadId: this.threadId,
            ...(op !== undefined && 'parentOpId' in op && op.parentOpId !== undefined
              ? { parentOpId: op.parentOpId }
              : {}),
            resolvedTarget: { kind: 'run', runId: this.#active.currentRunId },
          } as Extract<MailboxRuntimeOp, { type: 'abort' }>,
          resolvedTarget: { kind: 'run', runId: this.#active.currentRunId },
        };
        let cancellation: Promise<unknown> | undefined;
        try {
          cancellation = this.#attachment.driver.dispatch(abortCommand).completion;
          await this.#abortPendingControls(abortCommand.op.opId);
        } catch (error) {
          failures.push(error);
        }
        await cancellation?.catch((error) => failures.push(error));
      }
      while (this.#background.size > 0) {
        await Promise.all([...this.#background]);
      }
      failures.push(...this.#backgroundFailures);
      try {
        await this.#attachment.driver.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await this.#threadPolicyEngine?.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        if (op !== undefined) {
          const parentOpId = 'parentOpId' in op ? op.parentOpId : undefined;
          const outcome = failures.length === 0 ? 'applied' : 'interrupted';
          await this.#writer.commit([
            {
              event: {
                type: 'op_completed',
                opType: 'thread_close',
                outcome,
                ...(parentOpId !== undefined && { parentOpId }),
              },
              opId: op.opId,
            },
            {
              event: { type: 'thread_closed', threadId: this.threadId },
              opId: op.opId,
            },
          ], [{ type: 'completed', opId: op.opId, outcome }]);
        }
      } catch (error) {
        failures.push(error);
      } finally {
        this.#closed = true;
        this.#runtimeTurnCaptures.clear();
        try {
          await this.#writer.close();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, `Thread ${this.threadId} close failed`);
    })();
    return this.#closePromise;
  }

  async #acceptExternal(
    op: ExternalThreadRuntimeOp,
    prepared?: ThreadRuntimePreparedInput,
  ): Promise<OpReceipt> {
    await this.#effectBarrier;
    if (this.#closing || this.#closed) return rejectedExternal(op, 'thread_closed');
    const prior = this.#writer.state.mailbox.get(op.opId);
    if (prior !== undefined) {
      if (canonicalJson(prior.op) !== canonicalJson(op)) {
        return rejectedExternal(op, 'op_id_conflict');
      }
      if (prior.state === 'prepared') {
        const receipt = await this.#rejectExternal(op, 'interrupted_before_accept');
        return { ...receipt, duplicate: true };
      }
      if (prior.state === 'rejected') {
        return {
          accepted: false,
          opId: op.opId,
          duplicate: true,
          reason: prior.reason ?? 'rejected',
          threadId: this.threadId,
        };
      }
      const run = [...this.#writer.state.runs.values()].find((entry) => entry.ownerOpId === op.opId);
      return {
        accepted: true,
        opId: op.opId,
        duplicate: true,
        threadId: this.threadId,
        ...(run !== undefined && { runId: run.runId }),
      };
    }
    await this.#writer.appendPrepare({
      type: 'mailbox_prepare',
      opId: op.opId,
      op,
      timestamp: this.#clock.now(),
    });

    switch (op.type) {
      case 'prompt':
      case 'continue':
        return this.#acceptActivity(op);
      case 'set_model':
        if (this.#active !== undefined || this.#attachment.driver.interactionState() !== 'idle') {
          return this.#rejectExternal(op, 'thread_busy');
        }
        if (prepared?.resolvedModel === undefined) {
          return this.#rejectExternal(op, 'model_resolution_missing');
        }
        await this.#acceptOperation(op, { op, resolvedModel: prepared.resolvedModel });
        return { accepted: true, opId: op.opId, duplicate: false, threadId: this.threadId };
      case 'steer':
      case 'follow_up':
        await this.#acceptOperation(op, { op });
        return { accepted: true, opId: op.opId, duplicate: false, threadId: this.threadId };
      case 'control_response': {
        if (this.#writer.state.controlClaims.has(op.requestId)) {
          return this.#rejectExternal(op, 'control_response_already_claimed');
        }
        const pending = this.#writer.state.checkpoint.frontend.pendingControls
          .find((request) => request.requestId === op.requestId);
        if (pending === undefined) return this.#rejectExternal(op, 'control_request_not_found');
        const valid = pending.kind === 'approval'
          ? op.decision === 'allow_once' || op.decision === 'allow_always' || op.decision === 'deny'
          : op.decision === 'confirm' || op.decision === 'deny';
        if (!valid) return this.#rejectExternal(op, 'invalid_decision');
        if (pending.kind === 'approval'
          && op.decision === 'allow_always'
          && pending.payload.grantProposal === undefined) {
          return this.#rejectExternal(op, 'invalid_decision');
        }
        await this.#acceptOperation(op, { op });
        return { accepted: true, opId: op.opId, duplicate: false, threadId: this.threadId };
      }
      case 'thread_rename': {
        const updatedAt = this.#clock.now();
        const summary = {
          ...this.#writer.state.summary,
          title: op.title.trim(),
          updatedAt,
        };
        await this.#writer.commit([
          { event: { type: 'op_accepted', opType: op.type }, opId: op.opId },
          { event: { type: 'op_started', opType: op.type }, opId: op.opId },
          {
            event: { type: 'thread_updated', thread: summary, changed: 'title' },
            opId: op.opId,
          },
          {
            event: { type: 'op_completed', opType: op.type, outcome: 'applied' },
            opId: op.opId,
          },
        ], [
          { type: 'accepted_pending', opId: op.opId, opType: op.type },
          { type: 'started', opId: op.opId },
          { type: 'thread_title_updated', title: op.title.trim(), updatedAt },
          { type: 'completed', opId: op.opId, outcome: 'applied' },
        ]);
        return { accepted: true, opId: op.opId, duplicate: false, threadId: this.threadId };
      }
      case 'thread_archive': {
        if (op.archived
          && (this.#active !== undefined
            || this.#writer.state.checkpoint.frontend.pendingControls.length > 0)) {
          return this.#rejectExternal(op, 'thread_busy');
        }
        const updatedAt = this.#clock.now();
        const { archivedAt: _archivedAt, ...base } = this.#writer.state.summary;
        void _archivedAt;
        const archivedAt = op.archived ? updatedAt : undefined;
        const summary = {
          ...base,
          ...(archivedAt === undefined ? {} : { archivedAt }),
          updatedAt,
        };
        await this.#writer.commit([
          { event: { type: 'op_accepted', opType: op.type }, opId: op.opId },
          { event: { type: 'op_started', opType: op.type }, opId: op.opId },
          {
            event: { type: 'thread_updated', thread: summary, changed: 'archived' },
            opId: op.opId,
          },
          {
            event: { type: 'op_completed', opType: op.type, outcome: 'applied' },
            opId: op.opId,
          },
        ], [
          { type: 'accepted_pending', opId: op.opId, opType: op.type },
          { type: 'started', opId: op.opId },
          { type: 'thread_archive_updated', ...(archivedAt === undefined ? {} : { archivedAt }), updatedAt },
          { type: 'completed', opId: op.opId, outcome: 'applied' },
        ]);
        return { accepted: true, opId: op.opId, duplicate: false, threadId: this.threadId };
      }
      case 'compact':
        return this.#acceptActivity(op);
      case 'abort': {
        const target = this.#resolveAbortTarget(op.expectedRunId);
        if (op.expectedRunId !== undefined && target.kind === 'no_current_activity') {
          return this.#rejectExternal(op, 'stale_run');
        }
        await this.#acceptAbort(op, target);
        return { accepted: true, opId: op.opId, duplicate: false, threadId: this.threadId };
      }
      case 'thread_close':
        await this.#writer.commit([
          { event: { type: 'op_accepted', opType: op.type }, opId: op.opId },
          { event: { type: 'op_started', opType: op.type }, opId: op.opId },
        ], [
          { type: 'accepted_pending', opId: op.opId, opType: op.type },
          { type: 'started', opId: op.opId },
        ]);
        this.#closing = true;
        return { accepted: true, opId: op.opId, duplicate: false, threadId: this.threadId };
    }
  }

  async #acceptInternal(op: InternalThreadRuntimeOp): Promise<InternalOpReceipt> {
    await this.#effectBarrier;
    if (this.#closed) return { accepted: false, opId: op.opId, duplicate: false, reason: 'thread_closed', threadId: this.threadId };
    const existing = this.#writer.state.mailbox.get(op.opId);
    if (existing !== undefined) {
      if (canonicalJson(existing.op) !== canonicalJson(op)) {
        return {
          accepted: false,
          opId: op.opId,
          duplicate: false,
          reason: 'op_id_conflict',
          threadId: this.threadId,
        };
      }
      if (existing.state === 'rejected') {
        return {
          accepted: false,
          opId: op.opId,
          duplicate: true,
          reason: existing.reason ?? 'rejected',
          threadId: this.threadId,
        };
      }
      return { accepted: true, opId: op.opId, duplicate: true, threadId: this.threadId };
    }
    await this.#writer.appendPrepare({
      type: 'mailbox_prepare',
      opId: op.opId,
      op,
      timestamp: this.#clock.now(),
    });
    if (op.type === 'abort') {
      await this.#acceptAbort(op, op.resolvedTarget);
    } else {
      await this.#writer.commit([
        { event: { type: 'op_accepted', opType: 'thread_close', ...(op.parentOpId !== undefined && { parentOpId: op.parentOpId }) }, opId: op.opId },
        { event: { type: 'op_started', opType: 'thread_close', ...(op.parentOpId !== undefined && { parentOpId: op.parentOpId }) }, opId: op.opId },
      ], [
        { type: 'accepted_pending', opId: op.opId, opType: 'thread_close' },
        { type: 'started', opId: op.opId },
      ]);
      this.#closing = true;
    }
    return { accepted: true, opId: op.opId, duplicate: false, threadId: this.threadId };
  }

  async #acceptActivity(
    op: Extract<RuntimeOp, { type: 'prompt' | 'continue' | 'compact' }>,
  ): Promise<OpReceipt> {
    const interactionState = this.#attachment.driver.interactionState();
    const activeRun = this.#active === undefined
      ? undefined
      : this.#writer.state.runs.get(this.#active.currentRunId);
    const queueDuringCompaction = op.type === 'prompt'
      && this.#active !== undefined
      // The callback observer may enqueue immediately after durable compaction_end, when the
      // The driver already projects idle but the canonical compaction successor still owns the
      // thread. Keep that finalization window in the same FIFO admission rule.
      && (interactionState === 'compacting' || activeRun?.reason === 'compaction');
    if (!queueDuringCompaction && (this.#active !== undefined || interactionState !== 'idle')) {
      return this.#rejectExternal(op, 'thread_busy_use_steer_or_follow_up');
    }
    const suspended = this.#writer.state.summary.suspendedWork?.[0];
    if ((op.type === 'prompt' || op.type === 'compact') && suspended !== undefined) {
      return this.#rejectExternal(op, 'suspended_work_pending');
    }
    if (op.type === 'compact' && this.#writer.state.checkpoint.frontend.transcript.length === 0) {
      return this.#rejectExternal(op, 'nothing_to_compact');
    }
    const suspendedInputOwner = suspended === undefined
      ? undefined
      : suspended.kind === 'reserved_op' ? suspended.ownerOpId
        : suspended.inputOwnerOpId;
    const suspendedInput = suspendedInputOwner === undefined
      ? undefined
      : this.#writer.state.inputOwners.get(suspendedInputOwner);
    const sourcePrompt = suspendedInput === undefined
      ? undefined
      : this.#writer.state.mailbox.get(suspendedInput.sourceOpId)?.op;
    if (suspendedInput !== undefined && sourcePrompt?.type !== 'prompt') {
      throw new RuntimeStorageError('invalid_suspended_input', 'Suspended input source is not a prompt');
    }
    if (op.type === 'continue' && suspended === undefined
      && !hasContinuableState(this.#writer.state.checkpoint.frontend)) {
      return this.#rejectExternal(op, 'nothing_to_continue');
    }
    const runId = this.#newRunId();
    const workspaceCeiling = await this.#workspaceCeiling();
    const permissionCeiling = validatePermissionCeilingSnapshot(await this.#permissionPolicy.resolveCeiling({
      kind: 'run',
      workspaceId: this.workspaceId,
      threadId: this.threadId,
      runId,
      workspaceCeiling,
      threadCeiling: this.#threadCeiling,
      ...(op.type !== 'compact' && op.permissionNarrowing !== undefined && {
        requestedNarrowing: op.permissionNarrowing,
      }),
    }));
    if (!queueDuringCompaction) {
      this.#active = {
        rootOpId: op.opId,
        rootRunId: runId,
        currentRunId: runId,
        currentCeiling: permissionCeiling,
      };
    }
    const acceptanceMutations: RuntimeThreadMutation[] = [
      { type: 'accepted_pending', opId: op.opId, opType: op.type },
      {
        type: 'run_reserved',
        runId,
        ownerOpId: op.opId,
        reason: op.type,
        permissionCeiling,
      },
    ];
    if (op.type === 'continue' && suspendedInputOwner !== undefined && suspendedInput !== undefined) {
      acceptanceMutations.push({
        type: 'input_transferred',
        fromOpId: suspendedInputOwner,
        toOpId: op.opId,
      });
    }
    await this.#writer.commit([{
      event: { type: 'op_accepted', opType: op.type },
      opId: op.opId,
      runId,
    }], acceptanceMutations);
    const command: PreparedThreadDriverCommand = op.type === 'prompt'
      ? {
          op,
          runId,
          permissionCeiling,
          resolvedInput: { kind: 'prompt_input', sourceOpId: op.opId, text: op.text },
        }
      : op.type === 'continue' ? {
          op,
          runId,
          permissionCeiling,
          resolvedInput: sourcePrompt?.type === 'prompt'
            ? {
                kind: 'prompt_input',
                sourceOpId: suspendedInput?.sourceOpId as OpId,
                text: sourcePrompt.text,
              }
            : { kind: 'existing_residue' },
        }
      : { op, runId, permissionCeiling };
    if (queueDuringCompaction) {
      this.#queuedActivities.push({
        op,
        runId,
        permissionCeiling,
        command: command as Extract<PreparedThreadDriverCommand, { op: { type: 'prompt' } }>,
      });
      // The acceptance commit above and compaction_end share EventCommitter's serialized writer
      // chain. If this acceptance won, notify before compaction_end can resume the driver; if
      // compaction_end won, its prior auto-continue remains the authoritative ordering.
      this.#attachment.driver.activityQueuedDuringCompaction?.();
      return { accepted: true, opId: op.opId, duplicate: false, threadId: this.threadId, runId };
    }
    await this.#startActivity(op, runId, permissionCeiling, command);
    return { accepted: true, opId: op.opId, duplicate: false, threadId: this.threadId, runId };
  }

  async #startActivity(
    op: Extract<RuntimeOp, { type: 'prompt' | 'continue' | 'compact' }>,
    runId: RunId,
    permissionCeiling: PermissionCeilingSnapshot,
    command: Extract<PreparedThreadDriverCommand, { op: { type: 'prompt' | 'continue' | 'compact' } }>,
  ): Promise<void> {
    await this.#writer.commit([{
      event: { type: 'op_started', opType: op.type },
      opId: op.opId,
      runId,
    }], [
      { type: 'started', opId: op.opId },
      { type: 'run_started', runId },
    ]);
    let dispatch: ReturnType<RuntimeThreadDriverAttachment['driver']['dispatch']>;
    try {
      this.#assertWorkspaceCapabilitiesAvailable();
      dispatch = this.#attachment.driver.dispatch(command);
    } catch (error) {
      dispatch = { completion: Promise.reject(error) };
    }
    this.#track(this.#finishActivity(op, runId, permissionCeiling, dispatch.completion));
  }

  async #acceptOperation(
    op: Extract<ExternalThreadRuntimeOp, { type: 'steer' | 'follow_up' | 'control_response' | 'set_model' }>,
    command: PreparedThreadDriverCommand,
  ): Promise<void> {
    const acceptedAt = this.#clock.now();
    const mutations: RuntimeThreadMutation[] = [
      { type: 'accepted_pending', opId: op.opId, opType: op.type },
      { type: 'started', opId: op.opId },
    ];
    if (op.type === 'control_response') {
      mutations.push({
        type: 'control_response_claimed',
        requestId: op.requestId,
        responseOpId: op.opId,
        decision: op.decision,
        acceptedAt,
      });
    }
    await this.#writer.commit([
      { event: { type: 'op_accepted', opType: op.type }, opId: op.opId },
      { event: { type: 'op_started', opType: op.type }, opId: op.opId },
    ], mutations, acceptedAt);
    if (op.type === 'control_response') {
      const effect = this.#finishControlResponse(op, acceptedAt);
      this.#effectBarrier = this.#track(effect);
      return;
    }
    let completion: ReturnType<RuntimeThreadDriverAttachment['driver']['dispatch']>['completion'];
    try {
      completion = this.#attachment.driver.dispatch(command).completion;
    } catch (error) {
      completion = Promise.reject(error);
    }
    const effect = completion.then(
      async (result) => {
        const outcome = result.kind === 'operation' ? result.outcome : 'interrupted';
        const mutations: RuntimeThreadMutation[] = [
          { type: 'completed', opId: op.opId, outcome },
        ];
        if (op.type === 'set_model' && outcome === 'applied' && 'resolvedModel' in command) {
          mutations.push({ type: 'model_selected', ownerOpId: op.opId, model: command.resolvedModel.ref });
        }
        await this.#writer.commit([{
          event: { type: 'op_completed', opType: op.type, outcome },
          opId: op.opId,
        }], mutations);
      },
      async () => {
        await this.#writer.commit([{
          event: { type: 'op_completed', opType: op.type, outcome: 'interrupted' },
          opId: op.opId,
        }], [{ type: 'completed', opId: op.opId, outcome: 'interrupted' }]);
      },
    );
    this.#effectBarrier = this.#track(effect);
  }

  async #acceptAbort(
    op: Extract<MailboxRuntimeOp, { type: 'abort' }>,
    target: ResolvedAbortTarget,
  ): Promise<void> {
    const parentOpId = 'parentOpId' in op ? op.parentOpId : undefined;
    await this.#writer.commit([
      {
        event: { type: 'op_accepted', opType: 'abort', ...(parentOpId !== undefined && { parentOpId }) },
        opId: op.opId,
      },
      {
        event: { type: 'op_started', opType: 'abort', ...(parentOpId !== undefined && { parentOpId }) },
        opId: op.opId,
      },
    ], [{
      type: 'accepted_pending',
      opId: op.opId,
      opType: 'abort',
      resolvedTarget: target,
      ...(parentOpId !== undefined && { parentOpId }),
    }, { type: 'started', opId: op.opId }]);
    if (target.kind === 'suspended') {
      await this.#completeSuspendedAbort(op, target, parentOpId);
      return;
    }
    if (target.kind === 'no_current_activity') {
      await this.#completeAbort(op, 'no_op', parentOpId);
      return;
    }
    if ('resolvedTarget' in op && (
      this.#active?.currentRunId !== target.runId
      || this.#writer.state.runs.get(target.runId)?.state === 'terminal'
    )) {
      await this.#completeAbort(op, 'no_op', parentOpId);
      return;
    }
    let completion: ReturnType<RuntimeThreadDriverAttachment['driver']['dispatch']>['completion'];
    try {
      completion = this.#attachment.driver.dispatch({ op, resolvedTarget: target }).completion;
      // dispatch() synchronously propagates the run cancellation token. Only after that boundary
      // may pending approval waiters be durably concluded as aborted.
      await this.#abortPendingControls(op.opId);
    } catch (error) {
      completion = Promise.reject(error);
    }
    const effect = completion.then(
      () => this.#completeAbort(op, 'applied', parentOpId),
      () => this.#completeAbort(op, 'interrupted', parentOpId),
    );
    this.#effectBarrier = this.#track(effect);
  }

  async #finishControlResponse(
    op: Extract<RuntimeOp, { type: 'control_response' }>,
    acceptedAt: number,
  ): Promise<void> {
    const pending = this.#writer.state.checkpoint.frontend.pendingControls.find((request) =>
      request.requestId === op.requestId);
    if (pending?.kind === 'approval' && this.#policyGrants !== undefined) {
      await this.#finishRegistryControlResponse(op, acceptedAt, pending);
      return;
    }
    this.#failWorkspaceApproval(new RuntimeStorageError(
      'approval_unknown_outcome',
      `Durable approval state cannot apply response ${op.opId}`,
    ));
  }

  async #finishRegistryControlResponse(
    op: Extract<RuntimeOp, { type: 'control_response' }>,
    acceptedAt: number,
    request: Extract<
      import('../protocol/index.js').RuntimeControlEvent,
      { type: 'control_request'; kind: 'approval' }
    >,
  ): Promise<void> {
    const repository = this.#policyGrants;
    if (repository === undefined || op.decision === 'confirm') {
      this.#failWorkspaceApproval(new RuntimeStorageError(
        'policy_grant_unknown_outcome',
        `Policy grant repository cannot apply response ${op.opId}`,
      ));
      return;
    }

    const effectiveDecision: 'allow_once' | 'allow_always' | 'deny' = op.decision;
    const proposal = request.payload.grantProposal;
    if (op.decision === 'allow_always' && proposal === undefined) {
      this.#failWorkspaceApproval(new RuntimeStorageError(
        'policy_grant_proposal_missing',
        `Canonical allow_always response ${op.opId} has no frozen grant proposal`,
      ));
      return;
    }

    if (op.decision === 'allow_always' && proposal !== undefined) {
      const grant = strictJsonSnapshot({
        grantId: op.opId,
        workspaceId: this.workspaceId,
        capabilityId: proposal.capabilityId,
        capabilityVersion: proposal.capabilityVersion,
        registrationDigest: proposal.registrationDigest,
        scope: proposal.scope,
        policyBasisRevision: proposal.policyBasisRevision,
        acceptedAt,
      }) as unknown as Readonly<PolicyGrant>;
      let result: Awaited<ReturnType<typeof repository.commitAllowAlways>>;
      try {
        result = await repository.commitAllowAlways(grant);
      } catch (error) {
        this.#failWorkspaceApproval(new RuntimeStorageError(
          'policy_grant_unknown_outcome',
          error instanceof Error ? error.message : String(error),
        ));
        return;
      }
      if (result.kind === 'definitely_not_applied') {
        await this.#writer.commit([
          {
            event: { type: 'op_completed', opType: 'control_response', outcome: 'interrupted' },
            opId: op.opId,
          },
          {
            event: {
              type: 'runtime_diagnostic',
              severity: 'warning',
              code: 'policy_grant_definitely_not_applied',
              message: result.message,
              scope: 'thread',
            },
          },
        ], [
          { type: 'completed', opId: op.opId, outcome: 'interrupted' },
          {
            type: 'control_response_claim_released',
            requestId: request.requestId,
            responseOpId: op.opId,
            reason: 'effect_definitely_not_applied',
          },
        ]);
        return;
      }
      if (result.kind === 'conflict') {
        this.#failWorkspaceApproval(new RuntimeStorageError('policy_grant_conflict', result.message));
        return;
      }
      if (result.kind === 'fenced') {
        this.#failWorkspaceApproval(new RuntimeStorageError(result.code, result.message));
        return;
      }
    }

    const resolution: Extract<
      import('../protocol/index.js').RuntimeControlEvent,
      { type: 'control_resolved'; kind: 'approval' }
    > = {
      type: 'control_resolved',
      requestId: request.requestId,
      kind: 'approval',
      owningRunId: request.owningRunId,
      owningTurnId: request.owningTurnId,
      policyRevision: request.policyRevision,
      decision: effectiveDecision,
      ...(op.decision === 'allow_always' && effectiveDecision !== 'allow_always' && {
        requestedDecision: 'allow_always',
      }),
    };
    try {
      await this.#writer.commit([
        {
          event: resolution,
          runId: request.owningRunId,
          turnId: request.owningTurnId,
          opId: op.opId,
        },
        {
          event: { type: 'op_completed', opType: 'control_response', outcome: 'applied' },
          opId: op.opId,
        },
      ], [
        { type: 'control_resolved', resolution },
        { type: 'completed', opId: op.opId, outcome: 'applied' },
      ]);
    } catch (error) {
      this.#failWorkspaceApproval(new RuntimeStorageError(
        op.decision === 'allow_always'
          ? 'policy_grant_unknown_outcome'
          : 'approval_resolution_failed',
        error instanceof Error ? error.message : String(error),
      ));
      return;
    }
    const waiter = this.#approvalWaiters.get(request.requestId);
    if (waiter !== undefined) {
      this.#approvalWaiters.delete(request.requestId);
      waiter.resolve(effectiveDecision === 'deny'
        ? {
            kind: 'deny',
            reason:
              'User denied permission: the user rejected this capability invocation. ' +
              'Do not retry the same call; ask the user or take a different approach.',
          }
        : { kind: 'allow' });
    }
  }

  async #abortPendingControls(opId: OpId): Promise<void> {
    const pending = this.#writer.state.checkpoint.frontend.pendingControls;
    if (pending.length === 0) return;
    const envelopes = pending.map((request) => ({
      event: {
        type: 'control_resolved' as const,
        requestId: request.requestId,
        kind: request.kind,
        owningRunId: request.owningRunId,
        owningTurnId: request.owningTurnId,
        policyRevision: request.policyRevision,
        decision: 'aborted' as const,
      },
      runId: request.owningRunId,
      turnId: request.owningTurnId,
      opId,
    }));
    const mutations: RuntimeThreadMutation[] = envelopes.map((input) => ({
      type: 'control_resolved',
      resolution: input.event,
    }));
    await this.#writer.commit(
      envelopes as [typeof envelopes[number], ...typeof envelopes],
      mutations,
    );
    for (const request of pending) {
      const waiter = this.#approvalWaiters.get(request.requestId);
      if (waiter === undefined) continue;
      this.#approvalWaiters.delete(request.requestId);
      waiter.resolve({ kind: 'aborted' });
    }
  }

  #newApprovalRequestId(): string {
    for (let attempt = 0; attempt < 32; attempt++) {
      const requestId = `ap_${crypto.randomUUID().replaceAll('-', '')}`;
      if (!this.#writer.state.usedRequestIds.has(requestId)
        && !this.#approvalWaiters.has(requestId)) return requestId;
    }
    throw new Error('identity_collision');
  }

  #failWorkspaceApproval(error: Error): void {
    this.stopForWorkspaceApprovalFatal(error);
    this.#onWorkspaceApprovalFatal?.(error);
  }

  async #completeAbort(
    op: Extract<MailboxRuntimeOp, { type: 'abort' }>,
    outcome: 'applied' | 'no_op' | 'interrupted',
    parentOpId?: OpId,
  ): Promise<void> {
    await this.#writer.commit([{
      event: { type: 'op_completed', opType: 'abort', outcome, ...(parentOpId !== undefined && { parentOpId }) },
      opId: op.opId,
    }], [{ type: 'completed', opId: op.opId, outcome }]);
  }

  async #completeSuspendedAbort(
    op: Extract<MailboxRuntimeOp, { type: 'abort' }>,
    target: Extract<ResolvedAbortTarget, { kind: 'suspended' }>,
    parentOpId?: OpId,
  ): Promise<void> {
    const owner = this.#writer.state.mailbox.get(target.ownerOpId);
    const terminal = this.#writer.state.runs.get(target.terminalRunId);
    const root = [...this.#writer.state.runs.values()].find((run) => run.ownerOpId === target.ownerOpId);
    const finishOwner = owner !== undefined
      && owner.state !== 'completed' && owner.state !== 'rejected'
      && (owner.op.type === 'prompt' || owner.op.type === 'continue' || owner.op.type === 'compact')
      && root !== undefined;
    const stateMutations: RuntimeThreadMutation[] = [];
    if (finishOwner) {
      stateMutations.push({ type: 'completed', opId: target.ownerOpId, outcome: 'interrupted' });
      if (terminal !== undefined && terminal.state !== 'terminal' && terminal.state !== 'prepared') {
        stateMutations.push({ type: 'run_terminal', runId: terminal.runId, status: 'aborted' });
      }
    }
    if (target.inputOwnerOpId !== undefined
      && this.#writer.state.inputOwners.has(target.inputOwnerOpId)) {
      stateMutations.push({
        type: 'input_cancelled',
        ownerOpId: target.inputOwnerOpId,
        byAbortOpId: op.opId,
      });
    }
    stateMutations.push({ type: 'completed', opId: op.opId, outcome: 'applied' });
    const abortEnvelope = {
      event: {
        type: 'op_completed' as const,
        opType: 'abort' as const,
        outcome: 'applied' as const,
        ...(parentOpId !== undefined && { parentOpId }),
      },
      opId: op.opId,
    };
    if (finishOwner && root !== undefined) {
      await this.#writer.commit([
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
        abortEnvelope,
      ], stateMutations);
      return;
    }
    await this.#writer.commit([abortEnvelope], stateMutations);
  }

  async #finishActivity(
    op: Extract<RuntimeOp, { type: 'prompt' | 'continue' | 'compact' }>,
    rootRunId: RunId,
    rootCeiling: PermissionCeilingSnapshot,
    completion: ReturnType<RuntimeThreadDriverAttachment['driver']['dispatch']>['completion'],
  ): Promise<void> {
    let status: 'completed' | 'aborted' | 'error' = 'error';
    let reportedTerminalRunId: RunId | undefined;
    try {
      const result = await completion;
      if (result.kind !== 'activity') throw new Error('Activity driver returned an operation completion');
      if (result.status !== 'completed' && result.status !== 'aborted' && result.status !== 'error') {
        throw new Error('Activity driver returned an invalid status');
      }
      status = result.status;
      reportedTerminalRunId = result.terminalRunId;
    } catch {
      status = 'error';
    }
    let pendingToDeliver: ThreadResultOutboxMutation | undefined;
    await this.#withAdmission(async () => {
      const active = this.#active;
      let terminalRunId = active?.rootOpId === op.opId ? active.currentRunId : rootRunId;
      if (reportedTerminalRunId !== undefined) {
        const reported = this.#writer.state.runs.get(reportedTerminalRunId);
        const isCurrentCausalTerminal = active?.rootOpId === op.opId
          && active.rootRunId === rootRunId
          && active.currentRunId === reportedTerminalRunId
          && reported !== undefined
          && reported.state !== 'prepared';
        if (isCurrentCausalTerminal) {
          terminalRunId = reportedTerminalRunId;
        } else {
          status = 'error';
        }
      }
      const outcome = status === 'completed' ? 'applied' : 'interrupted';
      void rootCeiling;
      const mutations: RuntimeThreadMutation[] = [
        { type: 'completed', opId: op.opId, outcome },
        { type: 'run_terminal', runId: terminalRunId, status },
      ];
      const parentThreadId = this.#writer.state.meta.parentThreadId;
      if (parentThreadId !== undefined && op.type !== 'compact') {
        const resultOpId = this.#identityFactory.deriveOpId({
          purpose: 'thread_result',
          workspaceId: this.workspaceId,
          parts: [parentThreadId, this.threadId, terminalRunId],
        });
        if (!isDerivedOpId(resultOpId)) throw new Error('identity_factory_invalid_derived_op');
        pendingToDeliver = {
          type: 'thread_result_pending',
          resultOpId,
          parentThreadId,
          childThreadId: this.threadId,
          terminalRunId,
          status,
        };
        mutations.push(pendingToDeliver);
      }
      await this.#writer.commit([{
        event: { type: 'op_completed', opType: op.type, terminalRunId, outcome },
        opId: op.opId,
        runId: rootRunId,
      }], mutations);
      if (this.#active?.rootOpId === op.opId) this.#active = undefined;
      if (this.#closing) {
        await this.#cancelQueuedActivities();
      } else {
        await this.#startNextQueuedActivity();
      }
    });
    if (pendingToDeliver !== undefined && this.#onThreadResultPending !== undefined) {
      this.#trackBestEffort(this.#onThreadResultPending(pendingToDeliver));
    }
  }

  async #startNextQueuedActivity(): Promise<void> {
    const next = this.#queuedActivities.shift();
    if (next === undefined) return;
    this.#active = {
      rootOpId: next.op.opId,
      rootRunId: next.runId,
      currentRunId: next.runId,
      currentCeiling: next.permissionCeiling,
    };
    await this.#startActivity(next.op, next.runId, next.permissionCeiling, next.command);
  }

  async #cancelQueuedActivities(): Promise<void> {
    const queued = this.#queuedActivities.splice(0);
    for (const item of queued) {
      await this.#writer.commit([{
        event: {
          type: 'op_completed',
          opType: 'prompt',
          terminalRunId: item.runId,
          outcome: 'interrupted',
        },
        opId: item.op.opId,
        runId: item.runId,
      }], [
        { type: 'completed', opId: item.op.opId, outcome: 'interrupted' },
        { type: 'run_terminal', runId: item.runId, status: 'aborted' },
        { type: 'input_cancelled', ownerOpId: item.op.opId, byAbortOpId: item.op.opId },
      ]);
    }
  }

  async #rejectExternal(op: ExternalThreadRuntimeOp, reason: string): Promise<OpReceipt> {
    await this.#writer.commit([{
      event: { type: 'op_rejected', opType: op.type, reason },
      opId: op.opId,
    }], [{ type: 'rejected', opId: op.opId, reason }]);
    return rejectedExternal(op, reason);
  }

  #resolveAbortTarget(expectedRunId?: RunId): ResolvedAbortTarget {
    const current = this.#active?.currentRunId;
    if (current !== undefined && (expectedRunId === undefined || expectedRunId === current)) {
      return { kind: 'run', runId: current };
    }
    const suspended = this.#writer.state.summary.suspendedWork?.[0];
    if (suspended !== undefined) {
      if (suspended.kind === 'reserved_op' && (expectedRunId === undefined || expectedRunId === suspended.runId)) {
        return {
          kind: 'suspended',
          ownerOpId: suspended.ownerOpId,
          terminalRunId: suspended.runId,
          ...(this.#writer.state.inputOwners.has(suspended.ownerOpId)
            && { inputOwnerOpId: suspended.ownerOpId }),
        };
      }
      if (
        suspended.kind === 'interrupted' &&
        (expectedRunId === undefined || expectedRunId === suspended.terminalRunId)
      ) {
        return {
          kind: 'suspended',
          ownerOpId: suspended.ownerOpId,
          terminalRunId: suspended.terminalRunId,
          ...(suspended.inputOwnerOpId !== undefined && { inputOwnerOpId: suspended.inputOwnerOpId }),
        };
      }
    }
    return { kind: 'no_current_activity' };
  }

  async #workspaceCeiling(): Promise<PermissionCeilingSnapshot> {
    return validatePermissionCeilingSnapshot(await this.#permissionPolicy.snapshotWorkspaceCeiling({
      workspaceId: this.workspaceId,
      cwd: this.#cwd,
    }));
  }

  #assertWorkspaceCapabilitiesAvailable(): void {
    const failure = this.#workspaceCapabilityFailure();
    if (failure !== undefined) throw failure;
  }

  #workspaceCapabilityFailure(): Error | undefined {
    return this.#approvalFatal ?? this.#workspaceApprovalFailure?.();
  }

  #newRunId(): RunId {
    const runId = this.#identityFactory.newRunId();
    if (!isRunId(runId) || this.#writer.state.runs.has(runId)) throw new Error('identity_collision');
    return runId;
  }

  #newTurnId(): TurnId {
    const turnId = this.#identityFactory.newTurnId();
    if (!isTurnId(turnId) || [...this.#writer.state.turns.values()].some((turn) => turn.turnId === turnId)) {
      throw new Error('identity_collision');
    }
    return turnId;
  }

  #withAdmission<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#admission.then(operation);
    this.#admission = result.then(() => undefined, () => undefined);
    return result;
  }

  #track(task: Promise<void>): Promise<void> {
    const guarded: Promise<void> = task.catch((error) => {
      this.#backgroundFailures.push(error);
    }).finally(() => {
      this.#background.delete(guarded);
    });
    this.#background.add(guarded);
    return guarded;
  }

  #trackBestEffort(task: Promise<void>): void {
    const guarded = task.catch(() => undefined).finally(() => {
      this.#bestEffort.delete(guarded);
    });
    this.#bestEffort.add(guarded);
  }

  #assertDriverEventIdentity(
    input: ThreadDriverEvent,
    virtuallyActivatedRuns: ReadonlySet<RunId> = new Set(),
    virtuallyActivatedTurns: ReadonlySet<string> = new Set(),
  ): void {
    if (input.runId !== undefined) {
      const run = this.#writer.state.runs.get(input.runId);
      if (run === undefined) throw new Error('driver_event_unknown_run');
      if (run.state === 'terminal') throw new Error('driver_event_terminal_run');
      if (run.state === 'prepared' && !virtuallyActivatedRuns.has(input.runId)) {
        const reservation = [...this.#successors.values()].find((candidate) => candidate.runId === input.runId);
        const isReservationNotice = reservation !== undefined
          && input.event.type === 'retry_scheduled'
          && input.event.successorRunId === input.runId
          && input.event.predecessorRunId === reservation.predecessorRunId;
        const isCompactionActivation = reservation !== undefined
          && reservation.reason === 'compaction'
          && input.event.type === 'compaction_start'
          && input.event.activityRunId === input.runId
          && input.event.predecessorRunId === reservation.predecessorRunId;
        if (!isReservationNotice && !isCompactionActivation) {
          throw new Error('driver_event_unactivated_run');
        }
      }
    }
    if (input.turnId !== undefined) {
      if (input.runId === undefined) throw new Error('driver_event_turn_without_run');
      const reservation = this.#turnReservations.get(turnIdentityKey(input.runId, input.turnId));
      if (reservation === undefined) throw new Error('driver_event_unknown_turn');
      const turnKey = turnIdentityKey(input.runId, input.turnId);
      if (!reservation.activated && !virtuallyActivatedTurns.has(turnKey) && input.event.type !== 'turn_start') {
        throw new Error('driver_event_unactivated_turn');
      }
    }
    if (input.opId !== undefined && !this.#writer.state.mailbox.has(input.opId)) {
      throw new Error('driver_event_unknown_op');
    }
  }
}

function rejectedExternal(op: ExternalThreadRuntimeOp, reason: string): OpReceipt {
  return { accepted: false, opId: op.opId, duplicate: false, reason, threadId: op.threadId };
}

function hasContinuableState(frontend: RuntimeThreadDriverAttachment['initialCheckpoint']['frontend']): boolean {
  if (frontend.queues.steering.length > 0 || frontend.queues.followUp.length > 0) return true;
  const tail = frontend.transcript.at(-1);
  if (tail === undefined) return false;
  if (tail.role !== 'assistant') return true;
  return tail.stopReason === 'aborted' || tail.stopReason === 'error' || tail.stopReason === 'tool_calls';
}

function successorKey(runId: RunId, reason: 'retry' | 'compaction'): string {
  return canonicalJson(['successor', runId, reason]);
}

function turnOrdinalKey(runId: RunId, ordinal: number): string {
  return canonicalJson(['turn_ordinal', runId, ordinal]);
}

function turnIdentityKey(runId: RunId, turnId: TurnId): string {
  return canonicalJson(['turn_identity', runId, turnId]);
}

function unsupportedProviderStream(
  model: Readonly<ModelConfig>,
  timestamp: number,
  errorMessage: string,
): ProviderEventStream {
  const stream = new ProviderEventStream();
  const message: AssistantMessage = {
    role: 'assistant',
    id: `a_${crypto.randomUUID()}`,
    timestamp,
    content: [],
    model: { ...model.ref },
    stopReason: 'error',
    errorMessage,
    errorDetails: {
      kind: 'unknown',
      code: 'provider_adapter_not_found',
      retryable: false,
    },
    usage: { input: 0, output: 0 },
  };
  stream.push({ type: 'start', partial: message });
  stream.push({ type: 'error', message });
  stream.end(message);
  return stream;
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

async function awaitTurnCaptureGate<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  throwIfTurnCaptureAborted(signal);
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortListener = () => reject(turnCaptureAbortError());
    signal.addEventListener('abort', abortListener, { once: true });
  });
  try {
    const result = await Promise.race([operation, aborted]);
    throwIfTurnCaptureAborted(signal);
    return result;
  } finally {
    if (abortListener !== undefined) signal.removeEventListener('abort', abortListener);
  }
}

function throwIfTurnCaptureAborted(signal: AbortSignal): void {
  if (signal.aborted) throw turnCaptureAbortError();
}

function turnCaptureAbortError(): Error {
  const error = new Error('Runtime turn capture was interrupted.');
  error.name = 'AbortError';
  return error;
}

const PREFLIGHT_ABORTED_MESSAGE = 'Tool execution was interrupted before capability preflight completed.';

function preflightAbort(
  signal: AbortSignal,
): { readonly ok: false; readonly message: string } | undefined {
  return signal.aborted ? { ok: false, message: PREFLIGHT_ABORTED_MESSAGE } : undefined;
}

function snapshotPolicyDecision(input: unknown): PolicyDecision | undefined {
  let value: unknown;
  try {
    value = strictJsonSnapshot(input);
  } catch {
    return undefined;
  }
  if (!isDecisionRecord(value) || typeof value.kind !== 'string') return undefined;
  if (value.kind === 'allow') {
    return hasDecisionKeys(value, ['kind', 'code', 'reason'])
      && isDecisionString(value.code) && isDecisionString(value.reason)
      ? value as unknown as PolicyDecision
      : undefined;
  }
  if (value.kind === 'deny') {
    return hasDecisionKeys(value, ['kind', 'code', 'reason', 'recoverable'])
      && isDecisionString(value.code) && isDecisionString(value.reason)
      && value.recoverable === true
      ? value as unknown as PolicyDecision
      : undefined;
  }
  if (value.kind !== 'ask'
    || !hasDecisionKeys(value, ['kind', 'code', 'reason', 'description'], ['grantProposal'])
    || !isDecisionString(value.code)
    || !isDecisionString(value.reason)
    || !isDecisionString(value.description)
    || (value.grantProposal !== undefined && !isPolicyGrantScope(value.grantProposal))) {
    return undefined;
  }
  return value as unknown as PolicyDecision;
}

function isPolicyGrantScope(input: unknown): input is Readonly<PolicyGrantScope> {
  if (!isDecisionRecord(input) || typeof input.kind !== 'string') return false;
  if (input.kind !== 'canonical_resources_v1'
    || !hasDecisionKeys(input, ['kind', 'resourcePatterns', 'attributes'])
    || !Array.isArray(input.resourcePatterns)
    || input.resourcePatterns.length === 0
    || !isDecisionRecord(input.attributes)) {
    return false;
  }
  const canonicalPatterns: string[] = [];
  for (const candidate of input.resourcePatterns) {
    if (!isDecisionRecord(candidate)
      || !hasDecisionKeys(candidate, ['resourceType', 'access', 'matcher', 'pattern'])
      || (candidate.resourceType !== 'filesystem' && candidate.resourceType !== 'command'
        && candidate.resourceType !== 'network' && candidate.resourceType !== 'other')
      || (candidate.access !== 'read' && candidate.access !== 'write'
        && candidate.access !== 'execute' && candidate.access !== 'connect')
      || candidate.matcher !== 'canonical_target_exact_v1'
      || !isDecisionString(candidate.pattern)) {
      return false;
    }
    canonicalPatterns.push(canonicalJson(candidate));
  }
  return canonicalPatterns.every((pattern, index) => index === 0
    || compareUtf8(canonicalPatterns[index - 1]!, pattern) < 0);
}

function isDecisionRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isDecisionString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function hasDecisionKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => allowed.has(key));
}
