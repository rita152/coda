// Runtime journal reducer plus a Phase-1-compatible writer facade. Phase 2 delegates IO, seq
// allocation, atomic commit, and observer publication to narrow session-layer collaborators.

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
  ThreadId,
  ThreadSnapshot,
  ThreadSummary,
  TurnId,
  WorkspaceId,
} from '../protocol/index.js';
import type { CommitEnvelopeInput } from './event-committer.js';
import { EventCommitter } from './event-committer.js';
import { RuntimeEventStreamError } from './event-errors.js';
import type { EventHub } from './event-hub.js';
import { TranscriptRepository } from './transcript-repository.js';
import { RuntimeStorageError } from '../shared/runtime-storage-error.js';
import type {
  RuntimeClock,
  ThreadDriverCheckpoint,
  ThreadDriverCheckpointMutation,
  ThreadDriverEvent,
} from './thread-runtime-ports.js';
import type {
  RuntimeJournalRecord,
  RuntimeThreadMutation,
  ThreadCommitRecord,
  ThreadJournalAppendPort,
  ThreadMetaRecord,
} from './thread-journal-records.js';

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
  /** Canonical rule scopes durably discovered by prior invocation freshness checks. */
  readonly observedRuleScopes: ReadonlySet<string>;
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

export type { CommitEnvelopeInput } from './event-committer.js';

export class ThreadJournalWriter {
  readonly #repository: TranscriptRepository<RuntimeJournalRecord, FoldedThreadJournal>;
  readonly #committer: EventCommitter<RuntimeJournalRecord, FoldedThreadJournal, RuntimeThreadMutation>;

  constructor(input: {
    readonly workspaceId: WorkspaceId;
    readonly threadId: ThreadId;
    readonly journal: ThreadJournalAppendPort;
    readonly events: EventHub;
    readonly clock: RuntimeClock;
    readonly state: FoldedThreadJournal;
    readonly records: readonly RuntimeJournalRecord[];
  }) {
    this.#repository = new TranscriptRepository({
      journal: input.journal,
      records: input.records,
      fold: foldThreadJournal,
    });
    this.#committer = new EventCommitter({
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      repository: this.#repository,
      clock: input.clock,
      highWaterSeq: (state) => state.highWaterSeq,
      createCommitRecord: ({ firstSeq, envelopes, mutations }) => ({
        type: 'commit',
        firstSeq,
        envelopes,
        ...(mutations.length > 0 && { mutations }),
      }),
      publish: (envelopes) => input.events.publish(envelopes),
      onWriterFatal: (failure) => input.events.failThread(
        input.threadId,
        failure instanceof RuntimeStorageError ? failure.code : 'writer_failed',
      ),
    });
  }

  get state(): FoldedThreadJournal {
    return this.#repository.state;
  }

  async appendPrepare(record: Exclude<RuntimeJournalRecord, ThreadCommitRecord | ThreadMetaRecord>): Promise<void> {
    await this.#committer.append([snapshot(record)]);
  }

  async commit(
    envelopeInputs: readonly [CommitEnvelopeInput, ...CommitEnvelopeInput[]],
    mutations: readonly RuntimeThreadMutation[] = [],
    acceptedTimestamp?: number,
  ): Promise<readonly Readonly<EventEnvelope>[]> {
    return this.#committer.commit(envelopeInputs, mutations, acceptedTimestamp);
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
    await this.#committer.commit(inputs, mutations);
  }

  async drain(): Promise<void> {
    await this.#committer.drain();
  }

  async close(): Promise<void> {
    await this.#committer.close();
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
  const observedRuleScopes = new Set<string>();
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
    validateCommitCorrespondence(record, mailbox);
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
          if (mutation.reason === 'continue' && (summary.suspendedWork?.length ?? 0) > 0) {
            const [, ...remaining] = summary.suspendedWork as readonly import('../protocol/index.js').SuspendedWorkItem[];
            const { suspendedWork: _suspendedWork, ...rest } = summary;
            void _suspendedWork;
            summary = {
              ...rest,
              ...(remaining.length > 0 && { suspendedWork: remaining }),
            };
          }
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
        case 'rule_scope_observed':
          observedRuleScopes.add(mutation.scope);
          break;
        case 'rule_scope_window_replaced': {
          const current = [...observedRuleScopes].sort(compareUtf8);
          if (canonicalJson(current) !== canonicalJson(mutation.consumedScopes)) {
            throw new RuntimeStorageError(
              'rule_scope_window_mismatch',
              `Rule scope window for ${mutation.owningTurnId} does not match its durable witness`,
            );
          }
          observedRuleScopes.clear();
          for (const scope of mutation.replacementScopes) observedRuleScopes.add(scope);
          break;
        }
        case 'message_appended':
        case 'control_resolved':
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
    observedRuleScopes,
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

function validateCommitCorrespondence(
  record: ThreadCommitRecord,
  mailbox: ReadonlyMap<OpId, FoldedMailboxEntry>,
): void {
  const lifecycleEnvelopes = record.envelopes.filter((envelope) =>
    envelope.opId !== undefined && mailbox.has(envelope.opId)
    && isMailboxLifecycleEvent(envelope.event));
  const lifecycleMutations = (record.mutations ?? []).filter(isMailboxLifecycleMutation);
  if (lifecycleEnvelopes.length !== lifecycleMutations.length) {
    throw invalidJournal('Mailbox lifecycle envelopes and mutations differ');
  }
  for (let index = 0; index < lifecycleMutations.length; index++) {
    const mutation = lifecycleMutations[index];
    const envelope = lifecycleEnvelopes[index];
    if (mutation === undefined || envelope === undefined || envelope.opId !== mutation.opId) {
      throw invalidJournal('Mailbox lifecycle envelope/mutation order differs');
    }
    const prepared = mailbox.get(mutation.opId);
    if (prepared === undefined || !isMailboxLifecycleEvent(envelope.event)
      || envelope.event.opType !== prepared.op.type) {
      throw invalidJournal('Mailbox lifecycle operation differs from prepare');
    }
    const expectedEvent = mutation.type === 'accepted_pending' ? 'op_accepted'
      : mutation.type === 'started' ? 'op_started'
        : mutation.type === 'completed' ? 'op_completed' : 'op_rejected';
    if (envelope.event.type !== expectedEvent) {
      throw invalidJournal('Mailbox lifecycle event type differs from mutation');
    }
    if (mutation.type === 'completed' && envelope.event.type === 'op_completed'
      && envelope.event.outcome !== mutation.outcome) {
      throw invalidJournal('Mailbox completion outcome differs from mutation');
    }
    if (mutation.type === 'rejected' && envelope.event.type === 'op_rejected'
      && envelope.event.reason !== mutation.reason) {
      throw invalidJournal('Mailbox rejection reason differs from mutation');
    }
  }

  requireExactProjection(
    'message_end',
    (record.mutations ?? []).flatMap((mutation) =>
      mutation.type === 'message_appended' ? [canonicalJson(mutation.message)] : []),
    record.envelopes.flatMap((envelope) =>
      envelope.event.type === 'message_end' ? [canonicalJson(envelope.event.message)] : []),
  );
  requireExactProjection(
    'control_request',
    (record.mutations ?? []).flatMap((mutation) =>
      mutation.type === 'control_requested' ? [canonicalJson(mutation.request)] : []),
    record.envelopes.flatMap((envelope) =>
      envelope.event.type === 'control_request' ? [canonicalJson(envelope.event)] : []),
  );
  requireExactProjection(
    'control_resolved',
    (record.mutations ?? []).flatMap((mutation) =>
      mutation.type === 'control_resolved' ? [canonicalJson(mutation.resolution)] : []),
    record.envelopes.flatMap((envelope) =>
      envelope.event.type === 'control_resolved' ? [canonicalJson(envelope.event)] : []),
  );
  requireExactProjection(
    'compaction_end',
    (record.mutations ?? []).flatMap((mutation) =>
      mutation.type === 'compaction_committed' ? ['committed'] : []),
    record.envelopes.flatMap((envelope) =>
      envelope.event.type === 'compaction_end' && envelope.event.ok ? ['committed'] : []),
  );

  for (const mutation of record.mutations ?? []) {
    if (mutation.type === 'turn_activated') {
      const matched = record.envelopes.some((envelope) =>
        envelope.runId === mutation.runId && envelope.turnId === mutation.turnId
        && (envelope.event.type === 'turn_start' || envelope.event.type === 'queue_update'));
      if (!matched) throw invalidJournal('turn_activated has no matching first turn envelope');
    } else if (mutation.type === 'rule_scope_window_replaced') {
      const matched = record.envelopes.some((envelope) =>
        envelope.turnId === mutation.owningTurnId && envelope.event.type === 'turn_start');
      if (!matched) throw invalidJournal('rule scope window replacement has no matching turn_start');
    }
  }
}

function requireExactProjection(
  label: string,
  mutations: readonly string[],
  envelopes: readonly string[],
): void {
  const left = [...mutations].sort();
  const right = [...envelopes].sort();
  if (canonicalJson(left) !== canonicalJson(right)) {
    throw invalidJournal(`${label} envelopes and mutations differ`);
  }
}

function isMailboxLifecycleMutation(
  mutation: RuntimeThreadMutation,
): mutation is Extract<RuntimeThreadMutation, {
  type: 'accepted_pending' | 'started' | 'completed' | 'rejected';
}> {
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

function invalidJournal(message: string): RuntimeStorageError {
  return new RuntimeStorageError('invalid_thread_journal', message);
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
