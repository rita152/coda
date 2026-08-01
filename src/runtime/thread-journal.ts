// Phase-1 temporary authoritative per-thread writer/reducer. It owns seq allocation and folds the
// complete frontend checkpoint; Phase 2 extracts the same semantics into Repository/EventCommitter.

import {
  canonicalJson,
  strictJsonSnapshot,
  validateEventEnvelope,
} from '../protocol/index.js';
import type {
  EventEnvelope,
  ModelRef,
  OpId,
  PermissionCeilingSnapshot,
  RunId,
  RuntimeEvent,
  ThreadId,
  ThreadSnapshot,
  ThreadSummary,
  TurnId,
  WorkspaceId,
} from '../protocol/index.js';
import { RuntimeEventStreamError, RuntimeStorageError } from './errors.js';
import type { WorkspaceEventStream } from './event-stream.js';
import type {
  RuntimeClock,
  RuntimeJournalRecord,
  RuntimeThreadMutation,
  ThreadCommitRecord,
  ThreadDriverCheckpoint,
  ThreadDriverCheckpointMutation,
  ThreadDriverEvent,
  ThreadJournalPort,
  ThreadMetaRecord,
} from './ports.js';

export interface FoldedThreadJournal {
  readonly meta: ThreadMetaRecord;
  readonly highWaterSeq: number;
  readonly envelopes: readonly Readonly<EventEnvelope>[];
  readonly checkpoint: ThreadDriverCheckpoint;
  readonly summary: ThreadSummary;
  readonly mailbox: ReadonlyMap<OpId, FoldedMailboxEntry>;
  readonly runs: ReadonlyMap<RunId, FoldedRunEntry>;
  readonly turns: ReadonlyMap<string, FoldedTurnEntry>;
  readonly inputOwners: ReadonlyMap<OpId, { readonly sourceOpId: OpId }>;
  readonly pendingThreadResults: ReadonlyMap<import('../protocol/index.js').DerivedOpId,
    Extract<RuntimeThreadMutation, { type: 'thread_result_pending' }>>;
  readonly deliveredThreadResults: ReadonlySet<import('../protocol/index.js').DerivedOpId>;
  readonly usedRequestIds: ReadonlySet<string>;
  readonly controlClaims: ReadonlyMap<string, {
    readonly responseOpId: import('../protocol/index.js').ExternalOpId;
    readonly decision: import('../protocol/index.js').ControlResponseDecision;
    readonly acceptedAt: number;
  }>;
}

export interface FoldedMailboxEntry {
  readonly op: import('../protocol/index.js').MailboxRuntimeOp;
  readonly state: 'prepared' | 'accepted_pending' | 'started' | 'completed' | 'rejected';
  readonly outcome?: 'applied' | 'no_op' | 'interrupted' | 'superseded';
  readonly reason?: string;
  readonly resolvedTarget?: import('../protocol/index.js').ResolvedAbortTarget;
}

export interface FoldedRunEntry {
  readonly runId: RunId;
  readonly ownerOpId?: OpId;
  readonly state: 'prepared' | 'reserved' | 'started' | 'terminal';
  readonly reason: 'prompt' | 'continue' | 'retry' | 'compaction';
  readonly status?: 'completed' | 'aborted' | 'error' | 'interrupted';
  readonly predecessorRunId?: RunId;
  readonly permissionCeiling: PermissionCeilingSnapshot;
}

export interface FoldedTurnEntry {
  readonly runId: RunId;
  readonly turnId: TurnId;
  readonly turnOrdinal: number;
  readonly workspaceCeiling?: PermissionCeilingSnapshot;
  readonly runCeiling?: PermissionCeilingSnapshot;
  readonly turnCeiling?: PermissionCeilingSnapshot;
  readonly activated: boolean;
}

export interface CommitEnvelopeInput {
  readonly event: RuntimeEvent;
  readonly runId?: RunId;
  readonly turnId?: TurnId;
  readonly opId?: OpId;
}

export class ThreadJournalWriter {
  readonly #workspaceId: WorkspaceId;
  readonly #threadId: ThreadId;
  readonly #journal: ThreadJournalPort;
  readonly #events: WorkspaceEventStream;
  readonly #clock: RuntimeClock;
  #state: FoldedThreadJournal;
  readonly #records: RuntimeJournalRecord[];
  #chain: Promise<void> = Promise.resolve();
  #fatal: Error | undefined;

  constructor(input: {
    readonly workspaceId: WorkspaceId;
    readonly threadId: ThreadId;
    readonly journal: ThreadJournalPort;
    readonly events: WorkspaceEventStream;
    readonly clock: RuntimeClock;
    readonly state: FoldedThreadJournal;
    readonly records: readonly RuntimeJournalRecord[];
  }) {
    this.#workspaceId = input.workspaceId;
    this.#threadId = input.threadId;
    this.#journal = input.journal;
    this.#events = input.events;
    this.#clock = input.clock;
    this.#state = input.state;
    this.#records = [...input.records];
  }

  get state(): FoldedThreadJournal {
    return this.#state;
  }

  async appendPrepare(record: Exclude<RuntimeJournalRecord, ThreadCommitRecord | ThreadMetaRecord>): Promise<void> {
    await this.#serialize(async () => {
      const copy = snapshot(record);
      await this.#journal.append([copy], { flush: true });
      this.#records.push(copy);
      this.#state = foldThreadJournal(this.#records);
    });
  }

  async commit(
    envelopeInputs: readonly [CommitEnvelopeInput, ...CommitEnvelopeInput[]],
    mutations: readonly RuntimeThreadMutation[] = [],
    acceptedTimestamp?: number,
  ): Promise<readonly Readonly<EventEnvelope>[]> {
    let output: readonly Readonly<EventEnvelope>[] = [];
    await this.#serialize(async () => {
      output = await this.#commitNow(envelopeInputs, mutations, acceptedTimestamp);
    });
    return output;
  }

  async commitDriverEvent(
    input: ThreadDriverEvent,
    checkpointMutation?: ThreadDriverCheckpointMutation,
    extraMutations: readonly RuntimeThreadMutation[] = [],
  ): Promise<void> {
    await this.commitDriverEvents([input], checkpointMutation, extraMutations);
  }

  async commitDriverEvents(
    inputs: readonly [ThreadDriverEvent, ...ThreadDriverEvent[]],
    checkpointMutation?: ThreadDriverCheckpointMutation,
    extraMutations: readonly RuntimeThreadMutation[] = [],
  ): Promise<void> {
    await this.#serialize(async () => {
      const mutations: RuntimeThreadMutation[] = [...extraMutations];
      for (const input of inputs) {
        if (input.event.type === 'message_end') {
          mutations.push({ type: 'message_appended', message: input.event.message });
        } else if (input.event.type === 'control_request') {
          mutations.push({ type: 'control_requested', request: input.event });
        } else if (input.event.type === 'control_resolved') {
          mutations.push({ type: 'control_resolved', resolution: input.event });
        }
      }
      if (checkpointMutation?.type === 'compaction_committed') {
        mutations.push({ type: 'compaction_committed', compaction: checkpointMutation.compaction });
      } else if (checkpointMutation?.type === 'activity_interrupted') {
        mutations.push(checkpointMutation);
      } else if (checkpointMutation?.type === 'model_selected') {
        mutations.push({
          type: 'model_selected',
          ownerOpId: checkpointMutation.ownerOpId,
          model: checkpointMutation.model,
        });
      }
      await this.#commitNow(inputs, mutations);
    });
  }

  async drain(): Promise<void> {
    await this.#chain;
    if (this.#fatal !== undefined) throw this.#fatal;
  }

  async close(): Promise<void> {
    try {
      await this.drain();
    } finally {
      await this.#journal.releaseWriteLease();
    }
  }

  async #serialize(operation: () => Promise<void>): Promise<void> {
    const run = this.#chain.then(async () => {
      if (this.#fatal !== undefined) throw this.#fatal;
      try {
        await operation();
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        this.#fatal = failure;
        this.#events.failThread(this.#threadId, failure instanceof RuntimeStorageError ? failure.code : 'writer_failed');
        throw failure;
      }
    });
    this.#chain = run.catch(() => undefined);
    await run;
  }

  async #commitNow(
    envelopeInputs: readonly [CommitEnvelopeInput, ...CommitEnvelopeInput[]],
    mutations: readonly RuntimeThreadMutation[],
    acceptedTimestamp?: number,
  ): Promise<readonly Readonly<EventEnvelope>[]> {
    const firstSeq = this.#state.highWaterSeq + 1;
    if (firstSeq > Number.MAX_SAFE_INTEGER - envelopeInputs.length + 1) {
      throw new RuntimeEventStreamError('sequence_exhausted', this.#threadId);
    }
    const timestamp = acceptedTimestamp ?? this.#clock.now();
    const envelopes = envelopeInputs.map((input, index) => validateEventEnvelope({
      workspaceId: this.#workspaceId,
      threadId: this.#threadId,
      ...(input.runId !== undefined && { runId: input.runId }),
      ...(input.turnId !== undefined && { turnId: input.turnId }),
      ...(input.opId !== undefined && { opId: input.opId }),
      seq: firstSeq + index,
      timestamp,
      event: input.event,
    }));
    const record = snapshot({
      type: 'commit' as const,
      firstSeq,
      envelopes: envelopes as unknown as readonly [EventEnvelope, ...EventEnvelope[]],
      ...(mutations.length > 0 && { mutations }),
    });
    await this.#journal.append([record], { flush: true });
    this.#records.push(record);
    this.#state = foldThreadJournal(this.#records);
    this.#events.publish(envelopes);
    return envelopes;
  }
}

export function foldThreadJournal(records: readonly RuntimeJournalRecord[]): FoldedThreadJournal {
  const meta = records[0];
  if (meta === undefined || meta.type !== 'thread_meta') {
    throw new RuntimeStorageError('missing_thread_meta', 'Thread journal has no v2 meta record');
  }
  const envelopes: Readonly<EventEnvelope>[] = [];
  const mailbox = new Map<OpId, FoldedMailboxEntry>();
  const runs = new Map<RunId, FoldedRunEntry>();
  const turns = new Map<string, FoldedTurnEntry>();
  const inputOwners = new Map<OpId, { readonly sourceOpId: OpId }>();
  const pendingThreadResults = new Map<import('../protocol/index.js').DerivedOpId,
    Extract<RuntimeThreadMutation, { type: 'thread_result_pending' }>>();
  const deliveredThreadResults = new Set<import('../protocol/index.js').DerivedOpId>();
  const usedRequestIds = new Set<string>();
  const controlClaims = new Map<string, {
    readonly responseOpId: import('../protocol/index.js').ExternalOpId;
    readonly decision: import('../protocol/index.js').ControlResponseDecision;
    readonly acceptedAt: number;
  }>();
  let checkpoint = emptyCheckpoint(meta.model);
  let summary: ThreadSummary = {
    threadId: meta.threadId,
    ...(meta.parentThreadId !== undefined && { parentThreadId: meta.parentThreadId }),
    createdAt: meta.createdAt,
    state: 'idle',
  };
  let highWaterSeq = 0;

  for (const record of records.slice(1)) {
    if (record.type === 'legacy_seed') {
      checkpoint = snapshot({
        frontend: {
          ...checkpoint.frontend,
          transcript: record.transcript,
          usage: record.usage,
        },
        execution: {
          ...(record.compaction !== undefined && { compaction: record.compaction }),
        },
      });
      continue;
    }
    if (record.type === 'mailbox_prepare') {
      if (mailbox.has(record.opId)) throw new RuntimeStorageError('duplicate_mailbox_prepare', record.opId);
      mailbox.set(record.opId, { op: record.op, state: 'prepared' });
      continue;
    }
    if (record.type === 'successor_run_prepare') {
      if (runs.has(record.runId)) throw new RuntimeStorageError('identity_collision', record.runId);
      runs.set(record.runId, {
        runId: record.runId,
        state: 'prepared',
        reason: record.reason,
        predecessorRunId: record.predecessorRunId,
        permissionCeiling: record.permissionCeiling,
      });
      continue;
    }
    if (record.type === 'turn_prepare') {
      const key = turnKey(record.runId, record.turnOrdinal);
      if (turns.has(key) || [...turns.values()].some((turn) => turn.turnId === record.turnId)) {
        throw new RuntimeStorageError('identity_collision', record.turnId);
      }
      turns.set(key, {
        runId: record.runId,
        turnId: record.turnId,
        turnOrdinal: record.turnOrdinal,
        workspaceCeiling: record.workspaceCeiling,
        runCeiling: record.runCeiling,
        turnCeiling: record.turnCeiling,
        activated: false,
      });
      continue;
    }
    if (record.type === 'thread_result_delivered') {
      if (!pendingThreadResults.has(record.resultOpId)) {
        throw new RuntimeStorageError('thread_result_missing', record.resultOpId);
      }
      if (deliveredThreadResults.has(record.resultOpId)) {
        throw new RuntimeStorageError('thread_result_already_delivered', record.resultOpId);
      }
      deliveredThreadResults.add(record.resultOpId);
      continue;
    }
    if (record.type !== 'commit') continue;
    if (record.firstSeq !== highWaterSeq + 1) {
      throw new RuntimeEventStreamError('invalid_persisted_sequence', meta.threadId);
    }
    for (const envelope of record.envelopes) {
      const validated = validateEventEnvelope(envelope);
      if (
        validated.workspaceId !== meta.workspaceId ||
        validated.threadId !== meta.threadId ||
        validated.seq !== highWaterSeq + 1
      ) {
        throw new RuntimeEventStreamError('invalid_persisted_sequence', meta.threadId);
      }
      highWaterSeq = validated.seq;
      envelopes.push(validated);
      checkpoint = reduceDriverCheckpoint(checkpoint, {
        event: validated.event,
        ...(validated.runId !== undefined && { runId: validated.runId }),
        ...(validated.turnId !== undefined && { turnId: validated.turnId }),
        ...(validated.opId !== undefined && { opId: validated.opId }),
      });
      if (validated.event.type === 'thread_created' || validated.event.type === 'thread_resumed') {
        summary = validated.event.thread;
      } else if (validated.event.type === 'thread_closed') {
        summary = withoutActiveRun(summary, 'closed');
      }
    }
    for (const mutation of record.mutations ?? []) {
      switch (mutation.type) {
        case 'accepted_pending': {
          const existing = mailbox.get(mutation.opId);
          if (existing === undefined) {
            throw new RuntimeStorageError('mailbox_record_missing', `Mailbox mutation has no prepare: ${mutation.opId}`);
          }
          mailbox.set(mutation.opId, {
            op: existing.op,
            state: 'accepted_pending',
            ...('resolvedTarget' in mutation && { resolvedTarget: mutation.resolvedTarget }),
          });
          break;
        }
        case 'started':
        case 'completed':
        case 'rejected': {
          const existing = mailbox.get(mutation.opId);
          if (existing === undefined) {
            throw new RuntimeStorageError('mailbox_record_missing', `Mailbox mutation has no prepare: ${mutation.opId}`);
          }
          mailbox.set(mutation.opId, {
            op: existing.op,
            state: mutation.type,
            ...(mutation.type === 'completed' && { outcome: mutation.outcome }),
            ...(mutation.type === 'rejected' && { reason: mutation.reason }),
            ...(existing.resolvedTarget !== undefined && { resolvedTarget: existing.resolvedTarget }),
          });
          break;
        }
        case 'run_reserved': {
          const prepared = runs.get(mutation.runId);
          if (prepared !== undefined && prepared.state !== 'prepared') {
            throw new RuntimeStorageError('identity_collision', mutation.runId);
          }
          const entry: FoldedRunEntry = {
            runId: mutation.runId,
            ...('ownerOpId' in mutation && { ownerOpId: mutation.ownerOpId }),
            state: 'reserved',
            reason: mutation.reason,
            ...('predecessorRunId' in mutation && mutation.predecessorRunId !== undefined
              && { predecessorRunId: mutation.predecessorRunId }),
            permissionCeiling: mutation.permissionCeiling,
          };
          runs.set(mutation.runId, entry);
          if (mutation.reason === 'prompt' && 'ownerOpId' in mutation) {
            inputOwners.set(mutation.ownerOpId, { sourceOpId: mutation.ownerOpId });
          }
          const hasActiveRun = summary.activeRunId !== undefined
            && summary.activeRunId !== mutation.runId
            && runs.get(summary.activeRunId)?.state !== 'terminal';
          if (hasActiveRun) {
            summary = {
              ...summary,
              pendingRunIds: [...(summary.pendingRunIds ?? []), mutation.runId],
              suspendedWork: [
                ...(summary.suspendedWork ?? []),
                ...('ownerOpId' in mutation
                  ? [{ kind: 'reserved_op' as const, ownerOpId: mutation.ownerOpId, runId: mutation.runId }]
                  : []),
              ],
            };
          } else {
            summary = { ...summary, state: 'starting', activeRunId: mutation.runId };
          }
          break;
        }
        case 'run_started': {
          const existing = runs.get(mutation.runId);
          if (existing === undefined) throw new RuntimeStorageError('run_reservation_missing', mutation.runId);
          runs.set(mutation.runId, { ...existing, state: 'started' });
          summary = withoutQueuedRun(summary, mutation.runId);
          summary = { ...summary, state: 'running', activeRunId: mutation.runId };
          break;
        }
        case 'run_terminal': {
          const existing = runs.get(mutation.runId);
          if (existing === undefined) throw new RuntimeStorageError('run_reservation_missing', mutation.runId);
          runs.set(mutation.runId, { ...existing, state: 'terminal', status: mutation.status });
          if (summary.activeRunId === mutation.runId) {
            summary = withoutActiveRun(
              summary,
              (summary.suspendedWork?.length ?? 0) > 0 ? 'suspended' : 'idle',
            );
          }
          break;
        }
        case 'turn_activated': {
          const key = turnKey(mutation.runId, mutation.turnOrdinal);
          const prepared = turns.get(key);
          if (prepared === undefined || prepared.turnId !== mutation.turnId || prepared.activated) {
            throw new RuntimeStorageError('turn_reservation_missing', mutation.turnId);
          }
          turns.set(key, { ...prepared, activated: true });
          break;
        }
        case 'model_selected':
          checkpoint = { ...checkpoint, frontend: { ...checkpoint.frontend, model: mutation.model } };
          break;
        case 'control_response_claimed':
          controlClaims.set(mutation.requestId, {
            responseOpId: mutation.responseOpId,
            decision: mutation.decision,
            acceptedAt: mutation.acceptedAt,
          });
          break;
        case 'control_response_claim_released':
          if (controlClaims.get(mutation.requestId)?.responseOpId === mutation.responseOpId) {
            controlClaims.delete(mutation.requestId);
          }
          break;
        case 'compaction_committed':
          checkpoint = { ...checkpoint, execution: { ...checkpoint.execution, compaction: mutation.compaction } };
          break;
        case 'activity_interrupted':
          checkpoint = { ...checkpoint, frontend: withoutActivity(checkpoint.frontend) };
          summary = {
            ...withoutActiveRun(summary, 'suspended'),
            suspendedWork: [{
              kind: 'interrupted',
              ownerOpId: mutation.rootOpId,
              terminalRunId: mutation.terminalRunId,
              ...(inputOwners.has(mutation.rootOpId) && { inputOwnerOpId: mutation.rootOpId }),
            }],
          };
          break;
        case 'input_materialized':
          inputOwners.delete(mutation.ownerOpId);
          break;
        case 'input_transferred': {
          const input = inputOwners.get(mutation.fromOpId);
          if (input === undefined) throw new RuntimeStorageError('input_owner_missing', mutation.fromOpId);
          inputOwners.delete(mutation.fromOpId);
          inputOwners.set(mutation.toOpId, input);
          summary = withoutSuspendedOwner(summary, mutation.fromOpId);
          break;
        }
        case 'input_cancelled':
          inputOwners.delete(mutation.ownerOpId);
          summary = withoutSuspendedOwner(summary, mutation.ownerOpId);
          break;
        case 'control_requested':
          if (usedRequestIds.has(mutation.request.requestId)) {
            throw new RuntimeStorageError('control_request_identity_reused', mutation.request.requestId);
          }
          usedRequestIds.add(mutation.request.requestId);
          break;
        case 'thread_result_pending':
          if (pendingThreadResults.has(mutation.resultOpId)) {
            throw new RuntimeStorageError('thread_result_identity_reused', mutation.resultOpId);
          }
          pendingThreadResults.set(mutation.resultOpId, mutation);
          break;
        case 'message_appended':
        case 'control_resolved':
        case 'rule_scope_observed':
          break;
      }
    }
  }

  return {
    meta,
    highWaterSeq,
    envelopes,
    checkpoint,
    summary,
    mailbox,
    runs,
    turns,
    inputOwners,
    pendingThreadResults,
    deliveredThreadResults,
    usedRequestIds,
    controlClaims,
  };
}

export function snapshotFromFold(state: FoldedThreadJournal): Readonly<ThreadSnapshot> {
  return snapshot({
    thread: state.summary,
    ...state.checkpoint.frontend,
    highWaterSeq: state.highWaterSeq,
  });
}

export function emptyCheckpoint(model: ModelRef): ThreadDriverCheckpoint {
  return snapshot({
    frontend: {
      model,
      transcript: [],
      usage: {
        cumulative: { input: 0, output: 0 },
        turns: 0,
        contextTokens: 0,
      },
      queues: { steering: [], followUp: [] },
      plan: [],
      pendingControls: [],
    },
    execution: {},
  });
}

function reduceDriverCheckpoint(
  current: ThreadDriverCheckpoint,
  input: ThreadDriverEvent,
  mutation?: ThreadDriverCheckpointMutation,
): ThreadDriverCheckpoint {
  const event = input.event;
  let frontend = current.frontend;
  let execution = current.execution;
  switch (event.type) {
    case 'message_end':
      frontend = { ...frontend, transcript: [...frontend.transcript, event.message] };
      break;
    case 'queue_update':
      frontend = {
        ...frontend,
        queues: { steering: event.steering, followUp: event.followUp },
      };
      break;
    case 'plan_update':
      frontend = { ...frontend, plan: event.steps };
      break;
    case 'usage_update':
      frontend = { ...frontend, usage: event.usage };
      break;
    case 'control_request':
      frontend = { ...frontend, pendingControls: [...frontend.pendingControls, event] };
      break;
    case 'control_resolved':
      frontend = {
        ...frontend,
        pendingControls: frontend.pendingControls.filter((request) => request.requestId !== event.requestId),
      };
      break;
    case 'turn_start':
      if (input.runId !== undefined) {
        frontend = {
          ...frontend,
          activity: {
            runId: input.runId,
            ...(input.turnId !== undefined && { turnId: input.turnId }),
            toolExecutions: frontend.activity?.toolExecutions ?? [],
          },
        };
      }
      break;
    case 'message_start':
      if (event.message.role === 'assistant' && frontend.activity !== undefined) {
        frontend = { ...frontend, activity: { ...frontend.activity, partialAssistant: event.message } };
      }
      break;
    case 'message_update':
      if ('partial' in event.event && frontend.activity !== undefined) {
        frontend = { ...frontend, activity: { ...frontend.activity, partialAssistant: event.event.partial } };
      }
      break;
    case 'tool_execution_start':
      if (frontend.activity !== undefined) {
        frontend = {
          ...frontend,
          activity: {
            ...frontend.activity,
            toolExecutions: [...frontend.activity.toolExecutions, {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              args: event.args,
            }],
          },
        };
      }
      break;
    case 'tool_execution_update':
      if (frontend.activity !== undefined) {
        frontend = {
          ...frontend,
          activity: {
            ...frontend.activity,
            toolExecutions: frontend.activity.toolExecutions.map((tool) =>
              tool.toolCallId === event.toolCallId ? { ...tool, lastUpdate: event.update } : tool),
          },
        };
      }
      break;
    case 'tool_execution_end':
      if (frontend.activity !== undefined) {
        frontend = {
          ...frontend,
          activity: {
            ...frontend.activity,
            toolExecutions: frontend.activity.toolExecutions.map((tool) =>
              tool.toolCallId === event.toolCallId ? { ...tool, result: event.result } : tool),
          },
        };
      }
      break;
    case 'retry_scheduled':
      if (frontend.activity !== undefined) {
        frontend = { ...frontend, activity: { ...frontend.activity, retry: event } };
      }
      break;
    case 'compaction_start':
      if (frontend.activity !== undefined) {
        frontend = { ...frontend, activity: { ...frontend.activity, compaction: event } };
      }
      break;
    case 'agent_end':
      if (event.willRetry !== true) frontend = withoutActivity(frontend);
      break;
    default:
      break;
  }

  if (mutation?.type === 'compaction_committed') {
    execution = { ...execution, compaction: mutation.compaction };
  } else if (mutation?.type === 'model_selected') {
    frontend = { ...frontend, model: mutation.model };
  } else if (mutation?.type === 'activity_interrupted') {
    frontend = withoutActivity(frontend);
  }
  return snapshot({ frontend, execution });
}

function turnKey(runId: RunId, ordinal: number): string {
  return canonicalJson(['turn', runId, ordinal]);
}

function withoutActiveRun(
  summary: ThreadSummary,
  state: ThreadSummary['state'],
): ThreadSummary {
  const { activeRunId: _activeRunId, ...rest } = summary;
  void _activeRunId;
  return { ...rest, state };
}

function withoutSuspendedOwner(summary: ThreadSummary, ownerOpId: OpId): ThreadSummary {
  const remaining = (summary.suspendedWork ?? []).filter((item) =>
    item.ownerOpId !== ownerOpId
    && (item.kind !== 'interrupted' || item.inputOwnerOpId !== ownerOpId));
  if (remaining.length > 0) return { ...summary, suspendedWork: remaining };
  const { suspendedWork: _suspendedWork, ...rest } = summary;
  void _suspendedWork;
  return {
    ...rest,
    state: summary.state === 'suspended' ? 'idle' : summary.state,
  };
}

function withoutQueuedRun(summary: ThreadSummary, runId: RunId): ThreadSummary {
  const pendingRunIds = (summary.pendingRunIds ?? []).filter((candidate) => candidate !== runId);
  const suspendedWork = (summary.suspendedWork ?? []).filter((item) =>
    item.kind !== 'reserved_op' || item.runId !== runId);
  const {
    pendingRunIds: _pendingRunIds,
    suspendedWork: _suspendedWork,
    ...rest
  } = summary;
  void _pendingRunIds;
  void _suspendedWork;
  return {
    ...rest,
    ...(pendingRunIds.length > 0 && { pendingRunIds }),
    ...(suspendedWork.length > 0 && { suspendedWork }),
  };
}

function withoutActivity(
  frontend: ThreadDriverCheckpoint['frontend'],
): ThreadDriverCheckpoint['frontend'] {
  const { activity: _activity, ...rest } = frontend;
  void _activity;
  return rest;
}

function snapshot<T>(value: T): T {
  return strictJsonSnapshot(value) as T;
}
