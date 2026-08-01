// Canonical Runtime event union, identity-bearing envelope, and legacy single-thread projection.

import type { AgentEvent, PlanStep, QueuedMessage } from './agent-events.js';
import type { AgentMessage, AssistantMessage, ModelRef, ToolResultMessage, Usage } from './messages.js';
import {
  assertThreadId,
  isDerivedOpId,
  isExternalOpId,
  isOpId,
  isRunId,
  isThreadId,
  isTurnId,
  isWorkspaceId,
} from './identity.js';
import type {
  DerivedOpId,
  OpId,
  RunId,
  ThreadId,
  TurnId,
  WorkspaceId,
} from './identity.js';
import type {
  ApprovalControlDecision,
  PermissionCeilingSnapshot,
  ResourceConfirmationDecision,
  RuntimeOp,
} from './runtime-ops.js';
import { canonicalJson, strictJsonSnapshot } from './strict-json.js';
import type { StrictJsonValue } from './strict-json.js';

export type CanonicalAgentEvent =
  | Exclude<AgentEvent, { type: 'approval_request' } | { type: 'agent_end' }>
  | (Extract<AgentEvent, { type: 'agent_end' }> & { willRetry?: boolean });

export type RuntimeOpLifecycleEvent =
  | { type: 'op_accepted'; opType: RuntimeOp['type']; parentOpId?: OpId }
  | { type: 'op_started'; opType: RuntimeOp['type']; parentOpId?: OpId }
  | { type: 'op_completed'; opType: 'prompt' | 'continue'; terminalRunId: RunId;
      outcome: 'applied' | 'interrupted' | 'superseded'; parentOpId?: OpId }
  | { type: 'op_completed'; opType: Exclude<RuntimeOp['type'], 'prompt' | 'continue'>;
      outcome: 'applied' | 'no_op' | 'interrupted' | 'superseded'; parentOpId?: OpId }
  | { type: 'op_rejected'; opType: RuntimeOp['type']; reason: string; parentOpId?: OpId };

export interface LegacyApprovalProposal {
  readonly patterns: readonly string[];
  readonly forceConfirm: boolean;
}

export interface PolicyGrantResourcePattern {
  readonly resourceType: 'filesystem' | 'command' | 'network' | 'other';
  readonly access: 'read' | 'write' | 'execute' | 'connect';
  readonly matcher: 'canonical_target_exact_v1';
  readonly pattern: string;
}

export type PolicyGrantScope =
  | { readonly kind: 'canonical_resources_v1';
      readonly resourcePatterns: readonly [Readonly<PolicyGrantResourcePattern>,
        ...Readonly<PolicyGrantResourcePattern>[]];
      readonly attributes: Readonly<Record<string, unknown>> }
  | { readonly kind: 'legacy_global_approvals_v1';
      readonly patterns: readonly [string, ...string[]] };

export interface ApprovalGrantProposal {
  capabilityId: string;
  capabilityVersion: string;
  registrationDigest: string;
  policyBasisRevision: string;
  scope: Readonly<PolicyGrantScope>;
}

export interface ApprovalControlPayload {
  toolCallId: string;
  description: string;
  legacyProposal?: Readonly<LegacyApprovalProposal>;
  grantProposal?: Readonly<ApprovalGrantProposal>;
}

export interface ResourceConfirmationPayload {
  resourceType: string;
  resourceId: string;
  description: string;
}

export interface LegacyApprovalPatternSnapshot {
  readonly revision: string;
  readonly patterns: readonly string[];
}

export interface WorkspaceWriteFence {
  readonly workspaceId: WorkspaceId;
  readonly fencingToken: string;
}

export type WorkspaceWriteFenceValidation =
  | { readonly current: true }
  | { readonly current: false; readonly code: 'stale_fence' | 'wrong_workspace' };

export interface WorkspaceWriteFenceAuthority {
  validateWriteFence(fence: Readonly<WorkspaceWriteFence>): Promise<WorkspaceWriteFenceValidation>;
}

export type RuntimeControlEvent =
  | { type: 'control_request'; requestId: string;
      kind: 'approval'; owningRunId: RunId; owningTurnId: TurnId; policyRevision: string;
      payload: ApprovalControlPayload }
  | { type: 'control_request'; requestId: string;
      kind: 'resource_confirmation'; owningRunId: RunId; owningTurnId: TurnId;
      policyRevision: string; payload: ResourceConfirmationPayload }
  | { type: 'control_resolved'; requestId: string;
      kind: 'approval'; owningRunId: RunId; owningTurnId: TurnId; policyRevision: string;
      decision: ApprovalControlDecision | 'aborted'; requestedDecision?: ApprovalControlDecision }
  | { type: 'control_resolved'; requestId: string;
      kind: 'resource_confirmation'; owningRunId: RunId; owningTurnId: TurnId;
      policyRevision: string; decision: ResourceConfirmationDecision | 'aborted' };

export type ThreadResultEvent = {
  type: 'thread_result'; resultOpId: DerivedOpId; childThreadId: ThreadId; terminalRunId: RunId;
  status: 'completed' | 'aborted' | 'error'; summary?: string;
};

export interface ThreadUsage {
  lastTurn?: Usage;
  cumulative: Usage;
  turns: number;
  contextTokens: number;
}

export type RuntimeCoordinatorEvent =
  | { type: 'retry_scheduled'; attempt: number; maxAttempts: number; delayMs: number;
      errorMessage: string; predecessorRunId: RunId; successorRunId: RunId }
  | { type: 'compaction_start'; reason: 'threshold' | 'overflow';
      predecessorRunId: RunId; activityRunId: RunId }
  | { type: 'compaction_end'; activityRunId: RunId; ok: boolean; droppedMessages: number };

export type SuspendedWorkItem =
  | { readonly kind: 'reserved_op'; readonly ownerOpId: OpId; readonly runId: RunId }
  | { readonly kind: 'interrupted'; readonly ownerOpId: OpId;
      readonly terminalRunId: RunId; readonly inputOwnerOpId?: OpId };

export interface ThreadSummary {
  threadId: ThreadId;
  parentThreadId?: ThreadId;
  createdAt: number;
  title?: string;
  state: 'idle' | 'starting' | 'running' | 'retrying' | 'compacting' | 'suspended' | 'closing' | 'closed';
  activeRunId?: RunId;
  pendingRunIds?: readonly RunId[];
  suspendedWork?: readonly SuspendedWorkItem[];
}

export interface ThreadSnapshot {
  readonly thread: Readonly<ThreadSummary>;
  readonly model: Readonly<ModelRef>;
  readonly transcript: readonly AgentMessage[];
  readonly usage: Readonly<ThreadUsage>;
  readonly queues: {
    readonly steering: readonly QueuedMessage[];
    readonly followUp: readonly QueuedMessage[];
  };
  readonly plan: readonly PlanStep[];
  readonly pendingControls: readonly Extract<RuntimeControlEvent, { type: 'control_request' }>[];
  readonly activity?: {
    readonly runId: RunId;
    readonly turnId?: TurnId;
    readonly partialAssistant?: Readonly<AssistantMessage>;
    readonly toolExecutions: readonly {
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args: unknown;
      readonly lastUpdate?: Readonly<Record<string, unknown>>;
      readonly result?: Readonly<ToolResultMessage>;
    }[];
    readonly retry?: Readonly<Extract<RuntimeCoordinatorEvent, { type: 'retry_scheduled' }>>;
    readonly compaction?: Readonly<Extract<RuntimeCoordinatorEvent, { type: 'compaction_start' }>>;
  };
  readonly highWaterSeq: number;
}

export type RuntimePermissionMode = 'interactive' | 'allow' | 'deny' | 'custom';

export interface RuntimePermissionSnapshot {
  readonly mode: RuntimePermissionMode;
  readonly policyRevision: string;
  readonly ceiling: Readonly<PermissionCeilingSnapshot>;
}

/** Thread-independent Runtime truth consumed by cold-start frontends. */
export interface WorkspaceRuntimeSnapshot {
  readonly workspaceId: WorkspaceId;
  readonly permissions: Readonly<RuntimePermissionSnapshot>;
}

export type RuntimeLifecycleEvent =
  | { type: 'thread_created'; thread: ThreadSummary }
  | { type: 'thread_resumed'; thread: ThreadSummary }
  | { type: 'thread_closed'; threadId: ThreadId };

export type RuntimeDiagnosticEvent = {
  type: 'runtime_diagnostic';
  severity: 'warning' | 'error';
  code: string;
  message: string;
  scope: 'thread' | 'run' | 'turn';
};

export type RuntimeEvent =
  | CanonicalAgentEvent
  | RuntimeOpLifecycleEvent
  | RuntimeControlEvent
  | ThreadResultEvent
  | RuntimeCoordinatorEvent
  | RuntimeLifecycleEvent
  | RuntimeDiagnosticEvent
  | { type: 'usage_update'; usage: ThreadUsage };

export interface EventEnvelope<TEvent = RuntimeEvent> {
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly runId?: RunId;
  readonly turnId?: TurnId;
  readonly opId?: OpId;
  readonly seq: number;
  readonly timestamp: number;
  readonly event: TEvent;
}

/** Protocol-local shape structurally identical to the legacy session event surface. */
export type LegacySessionEvent =
  | (AgentEvent & { willRetry?: boolean })
  | { type: 'retry_scheduled'; attempt: number; maxAttempts: number; delayMs: number;
      errorMessage: string }
  | { type: 'compaction_start'; reason: 'threshold' | 'overflow' }
  | { type: 'compaction_end'; ok: boolean; droppedMessages: number }
  | { type: 'usage_update'; usage: ThreadUsage };

export class EventEnvelopeValidationError extends TypeError {
  override readonly name = 'EventEnvelopeValidationError';
  readonly code = 'invalid_event_envelope' as const;

  constructor(readonly reason: string) {
    super(`Invalid EventEnvelope: ${reason}`);
  }
}

/** Writer/recovery validator for strict JSON envelope snapshots and identity presence. */
export function validateEventEnvelope(input: unknown): Readonly<EventEnvelope> {
  try {
    const snapshot = strictJsonSnapshot(input);
    if (!isRecord(snapshot)) throw new Error('envelope must be an object');
    assertEnvelopeKeys(snapshot);
    if (!isWorkspaceId(snapshot.workspaceId)) throw new Error('invalid workspaceId');
    if (!isThreadId(snapshot.threadId)) throw new Error('invalid threadId');
    if (snapshot.runId !== undefined && !isRunId(snapshot.runId)) throw new Error('invalid runId');
    if (snapshot.turnId !== undefined && !isTurnId(snapshot.turnId)) throw new Error('invalid turnId');
    if (snapshot.opId !== undefined && !isOpId(snapshot.opId)) throw new Error('invalid opId');
    if (snapshot.turnId !== undefined && snapshot.runId === undefined) {
      throw new Error('turnId requires runId');
    }
    if (!Number.isSafeInteger(snapshot.seq) || typeof snapshot.seq !== 'number' || snapshot.seq < 1) {
      throw new Error('seq must be a positive safe integer');
    }
    if (typeof snapshot.timestamp !== 'number' || !Number.isFinite(snapshot.timestamp)) {
      throw new Error('timestamp must be finite');
    }
    if (!isRecord(snapshot.event) || typeof snapshot.event.type !== 'string') {
      throw new Error('event must have a discriminator');
    }
    validateRuntimeEventPayload(snapshot.event);
    validateEventIdentity(snapshot, snapshot.event);
    return snapshot as Readonly<EventEnvelope>;
  } catch (error) {
    if (error instanceof EventEnvelopeValidationError) throw error;
    throw new EventEnvelopeValidationError(error instanceof Error ? error.message : 'unknown error');
  }
}

/** Pure compatibility projection. Non-target and non-lossless event families are omitted. */
export function projectLegacySessionEvent(
  envelope: Readonly<EventEnvelope>,
  options: { readonly targetThreadId: ThreadId },
): Readonly<LegacySessionEvent> | undefined {
  const targetThreadId = assertThreadId(options.targetThreadId, 'targetThreadId');
  if (envelope.threadId !== targetThreadId) return undefined;

  const event = envelope.event;
  switch (event.type) {
    case 'agent_start':
    case 'agent_end':
    case 'turn_start':
    case 'turn_end':
    case 'message_start':
    case 'message_update':
    case 'message_end':
    case 'tool_execution_start':
    case 'tool_execution_update':
    case 'tool_execution_end':
    case 'queue_update':
    case 'plan_update':
    case 'error':
      return event;
    case 'control_request':
      if (event.kind !== 'approval') return undefined;
      return Object.freeze({
        type: 'approval_request',
        approvalId: event.requestId,
        toolCallId: event.payload.toolCallId,
        description: event.payload.description,
      });
    case 'retry_scheduled':
      return Object.freeze({
        type: event.type,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        errorMessage: event.errorMessage,
      });
    case 'compaction_start':
      return Object.freeze({ type: event.type, reason: event.reason });
    case 'compaction_end':
      return Object.freeze({
        type: event.type,
        ok: event.ok,
        droppedMessages: event.droppedMessages,
      });
    case 'usage_update':
      return Object.freeze({ type: event.type, usage: event.usage });
    case 'op_accepted':
    case 'op_started':
    case 'op_completed':
    case 'op_rejected':
    case 'control_resolved':
    case 'thread_result':
    case 'thread_created':
    case 'thread_resumed':
    case 'thread_closed':
    case 'runtime_diagnostic':
      return undefined;
  }
}

function validateEventIdentity(
  envelope: Readonly<Record<string, StrictJsonValue>>,
  event: Readonly<Record<string, StrictJsonValue>>,
): void {
  const type = event.type;
  switch (type) {
    case 'op_accepted':
    case 'op_started':
    case 'op_completed':
    case 'op_rejected':
      validateOpLifecycleIdentity(envelope, event);
      return;
    case 'thread_created':
    case 'thread_resumed':
      requireIdentity(envelope, false, false, true);
      if (!isExternalOpId(envelope.opId)) throw new Error(`${type} requires an external opId`);
      if (!isRecord(event.thread) || event.thread.threadId !== envelope.threadId) {
        throw new Error(`${type} identity mismatch`);
      }
      return;
    case 'thread_closed':
      requireIdentity(envelope, false, false, true);
      if (event.threadId !== envelope.threadId) {
        throw new Error('thread_closed identity mismatch');
      }
      return;
    case 'agent_start':
    case 'agent_end':
      requireIdentity(envelope, true, false, 'optional');
      if (envelope.opId !== undefined && !isExternalOpId(envelope.opId)) {
        throw new Error(`${type} root operation must be external`);
      }
      return;
    case 'turn_start':
    case 'turn_end':
    case 'message_start':
    case 'message_update':
    case 'message_end':
    case 'tool_execution_start':
    case 'tool_execution_update':
    case 'tool_execution_end':
    case 'plan_update':
    case 'usage_update':
      requireIdentity(envelope, true, true, false);
      return;
    case 'error':
      requireIdentity(envelope, true, 'optional', false);
      return;
    case 'queue_update':
      if (envelope.opId !== undefined) {
        requireIdentity(envelope, false, false, true);
        if (!isExternalOpId(envelope.opId)) throw new Error('queue mutation opId must be external');
      }
      else requireIdentity(envelope, true, true, false);
      return;
    case 'control_request':
      requireIdentity(envelope, true, true, false);
      requireOwningIdentityMatch(envelope, event);
      return;
    case 'control_resolved':
      requireIdentity(envelope, true, true, true);
      requireOwningIdentityMatch(envelope, event);
      if (event.decision !== 'aborted' && !isExternalOpId(envelope.opId)) {
        throw new Error('non-aborted control resolution requires an external response opId');
      }
      return;
    case 'retry_scheduled':
      requireIdentity(envelope, true, false, false);
      if (!isRunId(event.predecessorRunId) || event.successorRunId !== envelope.runId) {
        throw new Error('retry identity mismatch');
      }
      return;
    case 'compaction_start':
    case 'compaction_end':
      requireIdentity(envelope, true, false, false);
      if (event.activityRunId !== envelope.runId) throw new Error('compaction identity mismatch');
      if (type === 'compaction_start' && !isRunId(event.predecessorRunId)) {
        throw new Error('invalid compaction predecessor');
      }
      return;
    case 'thread_result':
      requireIdentity(envelope, false, false, true);
      if (!isDerivedOpId(event.resultOpId) || event.resultOpId !== envelope.opId
        || !isThreadId(event.childThreadId) || !isRunId(event.terminalRunId)) {
        throw new Error('thread result identity mismatch');
      }
      return;
    case 'runtime_diagnostic':
      validateDiagnosticIdentity(envelope, event);
      return;
    default:
      throw new Error(`unknown runtime event type: ${String(type)}`);
  }
}

function validateRuntimeEventPayload(event: Readonly<Record<string, StrictJsonValue>>): void {
  switch (event.type) {
    case 'agent_start':
      assertKeys(event, ['type', 'reason']);
      if (event.reason !== 'prompt' && event.reason !== 'follow_up' && event.reason !== 'continue') {
        throw new Error('invalid agent_start reason');
      }
      return;
    case 'agent_end':
      assertKeys(event, ['type', 'reason', 'messages'], ['willRetry']);
      if (event.reason !== 'completed' && event.reason !== 'aborted' && event.reason !== 'error') {
        throw new Error('invalid agent_end reason');
      }
      for (const message of requireArray(event.messages, 'messages')) validateAgentMessage(message);
      if (event.willRetry !== undefined) requireBoolean(event.willRetry, 'willRetry');
      return;
    case 'turn_start':
      assertKeys(event, ['type']);
      return;
    case 'turn_end':
      assertKeys(event, ['type', 'message', 'toolResults']);
      validateAssistantMessage(event.message);
      for (const result of requireArray(event.toolResults, 'toolResults')) {
        validateToolResultMessage(result);
      }
      return;
    case 'message_start':
    case 'message_end':
      assertKeys(event, ['type', 'message']);
      validateAgentMessage(event.message);
      return;
    case 'message_update':
      assertKeys(event, ['type', 'messageId', 'event']);
      requireString(event.messageId, 'messageId');
      validateMessageUpdateProviderEvent(event.event, event.messageId);
      return;
    case 'tool_execution_start':
      assertKeys(event, ['type', 'toolCallId', 'toolName', 'args']);
      requireString(event.toolCallId, 'toolCallId');
      requireString(event.toolName, 'toolName');
      return;
    case 'tool_execution_update':
      assertKeys(event, ['type', 'toolCallId', 'update']);
      requireString(event.toolCallId, 'toolCallId');
      {
        const update = requireRecord(event.update, 'update');
        if (update.output !== undefined) requireString(update.output, 'output');
      }
      return;
    case 'tool_execution_end':
      assertKeys(event, ['type', 'toolCallId', 'result']);
      requireString(event.toolCallId, 'toolCallId');
      validateToolResultMessage(event.result);
      if (requireRecord(event.result, 'result').toolCallId !== event.toolCallId) {
        throw new Error('tool result identity mismatch');
      }
      return;
    case 'queue_update':
      assertKeys(event, ['type', 'steering', 'followUp']);
      for (const item of requireArray(event.steering, 'steering')) validateQueuedMessage(item, 'steering');
      for (const item of requireArray(event.followUp, 'followUp')) validateQueuedMessage(item, 'follow_up');
      return;
    case 'plan_update':
      assertKeys(event, ['type', 'steps']);
      for (const step of requireArray(event.steps, 'steps')) validatePlanStep(step);
      return;
    case 'error':
      assertKeys(event, ['type', 'message', 'fatal']);
      requireString(event.message, 'message');
      requireBoolean(event.fatal, 'fatal');
      return;
    case 'op_accepted':
    case 'op_started':
      assertKeys(event, ['type', 'opType'], ['parentOpId']);
      if (!isRuntimeOpType(event.opType)) throw new Error('invalid opType');
      return;
    case 'op_completed':
      if (event.opType === 'prompt' || event.opType === 'continue') {
        assertKeys(event, ['type', 'opType', 'terminalRunId', 'outcome'], ['parentOpId']);
        if (!isRunId(event.terminalRunId)
          || (event.outcome !== 'applied'
            && event.outcome !== 'interrupted'
            && event.outcome !== 'superseded')) {
          throw new Error('invalid activity completion');
        }
      } else {
        assertKeys(event, ['type', 'opType', 'outcome'], ['parentOpId']);
        if (!isRuntimeOpType(event.opType)
          || event.opType === 'prompt'
          || event.opType === 'continue'
          || (event.outcome !== 'applied'
            && event.outcome !== 'no_op'
            && event.outcome !== 'interrupted'
            && event.outcome !== 'superseded')) {
          throw new Error('invalid operation completion');
        }
      }
      return;
    case 'op_rejected':
      assertKeys(event, ['type', 'opType', 'reason'], ['parentOpId']);
      if (!isRuntimeOpType(event.opType)) throw new Error('invalid opType');
      requireString(event.reason, 'reason');
      return;
    case 'control_request':
    case 'control_resolved':
      validateControlEvent(event);
      return;
    case 'thread_result':
      assertKeys(
        event,
        ['type', 'resultOpId', 'childThreadId', 'terminalRunId', 'status'],
        ['summary'],
      );
      if (!isDerivedOpId(event.resultOpId)
        || !isThreadId(event.childThreadId)
        || !isRunId(event.terminalRunId)
        || (event.status !== 'completed' && event.status !== 'aborted' && event.status !== 'error')) {
        throw new Error('invalid thread result');
      }
      if (event.summary !== undefined) requireString(event.summary, 'summary');
      return;
    case 'retry_scheduled':
      assertKeys(event, [
        'type',
        'attempt',
        'maxAttempts',
        'delayMs',
        'errorMessage',
        'predecessorRunId',
        'successorRunId',
      ]);
      requireNonNegativeSafeInteger(event.attempt, 'attempt');
      requireNonNegativeSafeInteger(event.maxAttempts, 'maxAttempts');
      requireNonNegativeSafeInteger(event.delayMs, 'delayMs');
      requireString(event.errorMessage, 'errorMessage');
      if (!isRunId(event.predecessorRunId) || !isRunId(event.successorRunId)) {
        throw new Error('invalid retry run identity');
      }
      return;
    case 'compaction_start':
      assertKeys(event, ['type', 'reason', 'predecessorRunId', 'activityRunId']);
      if ((event.reason !== 'threshold' && event.reason !== 'overflow')
        || !isRunId(event.predecessorRunId)
        || !isRunId(event.activityRunId)) {
        throw new Error('invalid compaction start');
      }
      return;
    case 'compaction_end':
      assertKeys(event, ['type', 'activityRunId', 'ok', 'droppedMessages']);
      if (!isRunId(event.activityRunId)) throw new Error('invalid compaction activity run');
      requireBoolean(event.ok, 'ok');
      requireNonNegativeSafeInteger(event.droppedMessages, 'droppedMessages');
      return;
    case 'thread_created':
    case 'thread_resumed':
      assertKeys(event, ['type', 'thread']);
      validateThreadSummary(event.thread);
      return;
    case 'thread_closed':
      assertKeys(event, ['type', 'threadId']);
      if (!isThreadId(event.threadId)) throw new Error('invalid closed thread id');
      return;
    case 'runtime_diagnostic':
      assertKeys(event, ['type', 'severity', 'code', 'message', 'scope']);
      if (event.severity !== 'warning' && event.severity !== 'error') {
        throw new Error('invalid diagnostic severity');
      }
      requireString(event.code, 'code');
      requireString(event.message, 'message');
      if (event.scope !== 'thread' && event.scope !== 'run' && event.scope !== 'turn') {
        throw new Error('invalid diagnostic scope');
      }
      return;
    case 'usage_update':
      assertKeys(event, ['type', 'usage']);
      validateThreadUsage(event.usage);
      return;
    default:
      throw new Error(`unknown runtime event type: ${String(event.type)}`);
  }
}

function validateControlEvent(event: Readonly<Record<string, StrictJsonValue>>): void {
  if (event.type === 'control_request') {
    assertKeys(event, [
      'type',
      'requestId',
      'kind',
      'owningRunId',
      'owningTurnId',
      'policyRevision',
      'payload',
    ]);
  } else if (event.kind === 'approval') {
    assertKeys(event, [
      'type',
      'requestId',
      'kind',
      'owningRunId',
      'owningTurnId',
      'policyRevision',
      'decision',
    ], ['requestedDecision']);
  } else {
    assertKeys(event, [
      'type',
      'requestId',
      'kind',
      'owningRunId',
      'owningTurnId',
      'policyRevision',
      'decision',
    ]);
  }

  requireString(event.requestId, 'requestId');
  requireString(event.policyRevision, 'policyRevision');
  if (!isRunId(event.owningRunId) || !isTurnId(event.owningTurnId)) {
    throw new Error('invalid control owner identity');
  }

  if (event.type === 'control_request') {
    if (event.kind === 'approval') validateApprovalPayload(event.payload);
    else if (event.kind === 'resource_confirmation') validateResourcePayload(event.payload);
    else throw new Error('invalid control kind');
    return;
  }

  if (event.kind === 'approval') {
    if (event.decision !== 'allow_once'
      && event.decision !== 'allow_always'
      && event.decision !== 'deny'
      && event.decision !== 'aborted') {
      throw new Error('invalid approval resolution');
    }
    if (event.requestedDecision !== undefined
      && (event.decision !== 'allow_once' || event.requestedDecision !== 'allow_always')) {
      throw new Error('requestedDecision is only valid for allow_always normalized to allow_once');
    }
    return;
  }
  if (event.kind === 'resource_confirmation') {
    if (event.decision !== 'confirm' && event.decision !== 'deny' && event.decision !== 'aborted') {
      throw new Error('invalid resource confirmation resolution');
    }
    return;
  }
  throw new Error('invalid control kind');
}

function validateApprovalPayload(value: StrictJsonValue | undefined): void {
  const payload = requireRecord(value, 'payload');
  assertKeys(payload, ['toolCallId', 'description'], ['legacyProposal', 'grantProposal']);
  requireString(payload.toolCallId, 'toolCallId');
  requireString(payload.description, 'description');
  if (payload.legacyProposal !== undefined && payload.grantProposal !== undefined) {
    throw new Error('approval proposals are mutually exclusive');
  }
  if (payload.legacyProposal !== undefined) {
    const proposal = requireRecord(payload.legacyProposal, 'legacyProposal');
    assertKeys(proposal, ['patterns', 'forceConfirm']);
    const patterns = requireArray(proposal.patterns, 'patterns');
    for (const pattern of patterns) requireString(pattern, 'pattern');
    requireBoolean(proposal.forceConfirm, 'forceConfirm');
  }
  if (payload.grantProposal !== undefined) validateGrantProposal(payload.grantProposal);
}

function validateGrantProposal(value: StrictJsonValue): void {
  const proposal = requireRecord(value, 'grantProposal');
  assertKeys(proposal, [
    'capabilityId',
    'capabilityVersion',
    'registrationDigest',
    'policyBasisRevision',
    'scope',
  ]);
  requireString(proposal.capabilityId, 'capabilityId');
  requireString(proposal.capabilityVersion, 'capabilityVersion');
  requireString(proposal.registrationDigest, 'registrationDigest');
  requireString(proposal.policyBasisRevision, 'policyBasisRevision');
  const scope = requireRecord(proposal.scope, 'scope');
  if (scope.kind === 'canonical_resources_v1') {
    assertKeys(scope, ['kind', 'resourcePatterns', 'attributes']);
    const patterns = requireArray(scope.resourcePatterns, 'resourcePatterns');
    if (patterns.length === 0) throw new Error('resourcePatterns must be non-empty');
    for (const item of patterns) {
      const pattern = requireRecord(item, 'resourcePattern');
      assertKeys(pattern, ['resourceType', 'access', 'matcher', 'pattern']);
      if (pattern.resourceType !== 'filesystem'
        && pattern.resourceType !== 'command'
        && pattern.resourceType !== 'network'
        && pattern.resourceType !== 'other') {
        throw new Error('invalid grant resource type');
      }
      if (pattern.access !== 'read'
        && pattern.access !== 'write'
        && pattern.access !== 'execute'
        && pattern.access !== 'connect') {
        throw new Error('invalid grant access');
      }
      if (pattern.matcher !== 'canonical_target_exact_v1') throw new Error('invalid grant matcher');
      requireString(pattern.pattern, 'pattern');
    }
    requireRecord(scope.attributes, 'attributes');
    return;
  }
  if (scope.kind === 'legacy_global_approvals_v1') {
    assertKeys(scope, ['kind', 'patterns']);
    const patterns = requireArray(scope.patterns, 'patterns');
    if (patterns.length === 0) throw new Error('legacy patterns must be non-empty');
    for (const pattern of patterns) requireString(pattern, 'pattern');
    return;
  }
  throw new Error('invalid grant scope');
}

function validateResourcePayload(value: StrictJsonValue | undefined): void {
  const payload = requireRecord(value, 'payload');
  assertKeys(payload, ['resourceType', 'resourceId', 'description']);
  requireString(payload.resourceType, 'resourceType');
  requireString(payload.resourceId, 'resourceId');
  requireString(payload.description, 'description');
}

function validateAgentMessage(value: StrictJsonValue | undefined): void {
  const message = requireRecord(value, 'message');
  if (message.role === 'user') {
    assertKeys(message, ['role', 'id', 'timestamp', 'content'], ['source']);
    validateMessageBase(message);
    for (const part of requireArray(message.content, 'content')) validateUserContentPart(part);
    if (message.source !== undefined
      && message.source !== 'prompt'
      && message.source !== 'steering'
      && message.source !== 'follow_up'
      && message.source !== 'synthetic') {
      throw new Error('invalid user message source');
    }
    return;
  }
  if (message.role === 'assistant') {
    validateAssistantMessage(message);
    return;
  }
  if (message.role === 'tool_result') {
    validateToolResultMessage(message);
    return;
  }
  throw new Error('invalid message role');
}

function validateAssistantMessage(value: StrictJsonValue | undefined): void {
  const message = requireRecord(value, 'assistant message');
  assertKeys(message, [
    'role',
    'id',
    'timestamp',
    'content',
    'model',
    'stopReason',
    'usage',
  ], ['errorMessage', 'errorDetails']);
  if (message.role !== 'assistant') throw new Error('invalid assistant role');
  validateMessageBase(message);
  for (const part of requireArray(message.content, 'content')) validateAssistantContentPart(part);
  validateModelRef(message.model);
  if (message.stopReason !== 'stop'
    && message.stopReason !== 'length'
    && message.stopReason !== 'tool_calls'
    && message.stopReason !== 'content_filter'
    && message.stopReason !== 'error'
    && message.stopReason !== 'aborted') {
    throw new Error('invalid stop reason');
  }
  if (message.errorMessage !== undefined) requireString(message.errorMessage, 'errorMessage');
  if (message.errorDetails !== undefined) validateProviderErrorDetails(message.errorDetails);
  validateUsage(message.usage);
}

function validateToolResultMessage(value: StrictJsonValue | undefined): void {
  const message = requireRecord(value, 'tool result');
  assertKeys(message, [
    'role',
    'id',
    'timestamp',
    'toolCallId',
    'toolName',
    'content',
    'isError',
  ], ['details']);
  if (message.role !== 'tool_result') throw new Error('invalid tool result role');
  validateMessageBase(message);
  requireString(message.toolCallId, 'toolCallId');
  requireString(message.toolName, 'toolName');
  for (const part of requireArray(message.content, 'content')) validateUserContentPart(part);
  requireBoolean(message.isError, 'isError');
}

function validateMessageBase(message: Readonly<Record<string, StrictJsonValue>>): void {
  requireString(message.id, 'message id');
  requireNumber(message.timestamp, 'message timestamp');
}

function validateUserContentPart(value: StrictJsonValue): void {
  const part = requireRecord(value, 'content part');
  if (part.type === 'text') {
    assertKeys(part, ['type', 'text']);
    requireString(part.text, 'text');
    return;
  }
  if (part.type === 'image') {
    assertKeys(part, ['type', 'data', 'mimeType']);
    requireString(part.data, 'data');
    requireString(part.mimeType, 'mimeType');
    return;
  }
  throw new Error('invalid user/tool-result content part');
}

function validateAssistantContentPart(value: StrictJsonValue): void {
  const part = requireRecord(value, 'assistant content part');
  if (part.type === 'text') {
    assertKeys(part, ['type', 'text']);
    requireString(part.text, 'text');
    return;
  }
  if (part.type === 'reasoning') {
    assertKeys(part, ['type', 'text'], ['signature']);
    requireString(part.text, 'text');
    if (part.signature !== undefined) requireString(part.signature, 'signature');
    return;
  }
  if (part.type === 'tool_call') {
    assertKeys(part, ['type', 'id', 'name', 'arguments'], ['rawArguments']);
    requireString(part.id, 'tool call id');
    requireString(part.name, 'tool name');
    requireRecord(part.arguments, 'tool arguments');
    if (part.rawArguments !== undefined) requireString(part.rawArguments, 'rawArguments');
    return;
  }
  throw new Error('invalid assistant content part');
}

function validateModelRef(value: StrictJsonValue | undefined): void {
  const model = requireRecord(value, 'model');
  assertKeys(model, ['provider', 'api', 'model']);
  requireString(model.provider, 'provider');
  requireString(model.api, 'api');
  requireString(model.model, 'model');
}

function validateProviderErrorDetails(value: StrictJsonValue): void {
  const details = requireRecord(value, 'errorDetails');
  assertKeys(details, ['kind', 'retryable'], [
    'status',
    'code',
    'requestId',
    'retryAfterMs',
  ]);
  if (details.kind !== 'network'
    && details.kind !== 'http'
    && details.kind !== 'overflow'
    && details.kind !== 'auth'
    && details.kind !== 'rate_limit'
    && details.kind !== 'aborted'
    && details.kind !== 'unknown') {
    throw new Error('invalid provider error kind');
  }
  requireBoolean(details.retryable, 'retryable');
  if (details.status !== undefined) requireNumber(details.status, 'status');
  if (details.code !== undefined) requireString(details.code, 'code');
  if (details.requestId !== undefined) requireString(details.requestId, 'requestId');
  if (details.retryAfterMs !== undefined) requireNumber(details.retryAfterMs, 'retryAfterMs');
}

function validateMessageUpdateProviderEvent(
  value: StrictJsonValue | undefined,
  messageId: StrictJsonValue,
): void {
  const provider = requireRecord(value, 'provider event');
  if (provider.type === 'start' || provider.type === 'done' || provider.type === 'error') {
    throw new Error('message_update only carries provider block events');
  }
  const startTypes = new Set(['text_start', 'reasoning_start', 'tool_call_start']);
  const deltaTypes = new Set(['text_delta', 'reasoning_delta', 'tool_call_delta']);
  const endTypes = new Set(['text_end', 'reasoning_end']);
  if (typeof provider.type !== 'string'
    || (!startTypes.has(provider.type)
      && !deltaTypes.has(provider.type)
      && !endTypes.has(provider.type)
      && provider.type !== 'tool_call_end')) {
    throw new Error('invalid provider block event');
  }

  if (startTypes.has(provider.type)) {
    assertKeys(provider, ['type', 'contentIndex', 'partial']);
  } else if (deltaTypes.has(provider.type)) {
    assertKeys(provider, ['type', 'contentIndex', 'delta', 'partial']);
    requireString(provider.delta, 'delta');
  } else if (endTypes.has(provider.type)) {
    assertKeys(provider, ['type', 'contentIndex', 'content', 'partial']);
    requireString(provider.content, 'content');
  } else {
    assertKeys(provider, ['type', 'contentIndex', 'toolCall', 'partial']);
    validateToolCallPart(provider.toolCall);
  }
  requireNonNegativeSafeInteger(provider.contentIndex, 'contentIndex');
  validateAssistantMessage(provider.partial);
  const partial = requireRecord(provider.partial, 'partial');
  if (partial.id !== messageId) throw new Error('provider partial messageId mismatch');
  const content = requireArray(partial.content, 'partial.content');
  const contentIndex = provider.contentIndex;
  if (typeof contentIndex !== 'number') throw new Error('invalid contentIndex');
  const part = content[contentIndex];
  if (part === undefined) throw new Error('contentIndex is outside partial.content');
  const partRecord = requireRecord(part, 'partial content part');

  if (provider.type.startsWith('text_')) {
    if (partRecord.type !== 'text') throw new Error('text event points to a non-text part');
    if (provider.type === 'text_end' && provider.content !== partRecord.text) {
      throw new Error('text_end content does not match partial');
    }
    return;
  }
  if (provider.type.startsWith('reasoning_')) {
    if (partRecord.type !== 'reasoning') {
      throw new Error('reasoning event points to a non-reasoning part');
    }
    if (provider.type === 'reasoning_end' && provider.content !== partRecord.text) {
      throw new Error('reasoning_end content does not match partial');
    }
    return;
  }
  if (partRecord.type !== 'tool_call') throw new Error('tool event points to a non-tool-call part');
  if (provider.type === 'tool_call_end'
    && canonicalJson(provider.toolCall) !== canonicalJson(partRecord)) {
    throw new Error('tool_call_end value does not match partial');
  }
}

function validateToolCallPart(value: StrictJsonValue | undefined): void {
  const part = requireRecord(value, 'toolCall');
  if (part.type !== 'tool_call') throw new Error('invalid tool call part type');
  validateAssistantContentPart(part);
}

function validateQueuedMessage(value: StrictJsonValue, expectedKind: 'steering' | 'follow_up'): void {
  const item = requireRecord(value, 'queued message');
  assertKeys(item, ['id', 'text', 'kind']);
  requireString(item.id, 'queue id');
  requireString(item.text, 'queue text');
  if (item.kind !== expectedKind) throw new Error('queue kind does not match its lane');
}

function validatePlanStep(value: StrictJsonValue): void {
  const item = requireRecord(value, 'plan step');
  assertKeys(item, ['step', 'status']);
  requireString(item.step, 'step');
  if (item.status !== 'pending' && item.status !== 'in_progress' && item.status !== 'completed') {
    throw new Error('invalid plan status');
  }
}

function validateThreadSummary(value: StrictJsonValue | undefined): void {
  const thread = requireRecord(value, 'thread');
  assertKeys(thread, ['threadId', 'createdAt', 'state'], [
    'parentThreadId',
    'title',
    'activeRunId',
    'pendingRunIds',
    'suspendedWork',
  ]);
  if (!isThreadId(thread.threadId)) throw new Error('invalid summary threadId');
  if (thread.parentThreadId !== undefined && !isThreadId(thread.parentThreadId)) {
    throw new Error('invalid summary parentThreadId');
  }
  requireNumber(thread.createdAt, 'createdAt');
  if (thread.title !== undefined) requireString(thread.title, 'title');
  if (thread.state !== 'idle'
    && thread.state !== 'starting'
    && thread.state !== 'running'
    && thread.state !== 'retrying'
    && thread.state !== 'compacting'
    && thread.state !== 'suspended'
    && thread.state !== 'closing'
    && thread.state !== 'closed') {
    throw new Error('invalid thread state');
  }
  if (thread.activeRunId !== undefined && !isRunId(thread.activeRunId)) {
    throw new Error('invalid activeRunId');
  }
  if (thread.pendingRunIds !== undefined) {
    for (const runId of requireArray(thread.pendingRunIds, 'pendingRunIds')) {
      if (!isRunId(runId)) throw new Error('invalid pendingRunId');
    }
  }
  if (thread.suspendedWork !== undefined) {
    for (const item of requireArray(thread.suspendedWork, 'suspendedWork')) {
      validateSuspendedWork(item);
    }
  }
}

function validateSuspendedWork(value: StrictJsonValue): void {
  const item = requireRecord(value, 'suspendedWork');
  if (item.kind === 'reserved_op') {
    assertKeys(item, ['kind', 'ownerOpId', 'runId']);
    if (!isOpId(item.ownerOpId) || !isRunId(item.runId)) throw new Error('invalid reserved work');
    return;
  }
  if (item.kind === 'interrupted') {
    assertKeys(item, ['kind', 'ownerOpId', 'terminalRunId'], ['inputOwnerOpId']);
    if (!isOpId(item.ownerOpId)
      || !isRunId(item.terminalRunId)
      || (item.inputOwnerOpId !== undefined && !isOpId(item.inputOwnerOpId))) {
      throw new Error('invalid interrupted work');
    }
    return;
  }
  throw new Error('invalid suspended work kind');
}

function validateThreadUsage(value: StrictJsonValue | undefined): void {
  const usage = requireRecord(value, 'usage');
  assertKeys(usage, ['cumulative', 'turns', 'contextTokens'], ['lastTurn']);
  if (usage.lastTurn !== undefined) validateUsage(usage.lastTurn);
  validateUsage(usage.cumulative);
  requireNonNegativeSafeInteger(usage.turns, 'turns');
  requireNonNegativeFinite(usage.contextTokens, 'contextTokens');
}

function validateUsage(value: StrictJsonValue | undefined): void {
  const usage = requireRecord(value, 'usage');
  assertKeys(usage, ['input', 'output'], [
    'cacheRead',
    'cacheWrite',
    'reasoning',
    'costUSD',
  ]);
  requireNonNegativeFinite(usage.input, 'input');
  requireNonNegativeFinite(usage.output, 'output');
  for (const key of ['cacheRead', 'cacheWrite', 'reasoning', 'costUSD'] as const) {
    if (usage[key] !== undefined) requireNonNegativeFinite(usage[key], key);
  }
  const cacheTotal = (typeof usage.cacheRead === 'number' ? usage.cacheRead : 0)
    + (typeof usage.cacheWrite === 'number' ? usage.cacheWrite : 0);
  if (typeof usage.input !== 'number' || usage.input < cacheTotal) {
    throw new Error('usage input is smaller than cache subdivisions');
  }
  if (typeof usage.output !== 'number'
    || usage.output < (typeof usage.reasoning === 'number' ? usage.reasoning : 0)) {
    throw new Error('usage output is smaller than reasoning subdivision');
  }
}

function assertKeys(
  value: Readonly<Record<string, StrictJsonValue>>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`unexpected event field: ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new Error(`missing event field: ${key}`);
  }
}

function requireRecord(
  value: StrictJsonValue | undefined,
  field: string,
): Readonly<Record<string, StrictJsonValue>> {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  return value;
}

function requireArray(value: StrictJsonValue | undefined, field: string): readonly StrictJsonValue[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value;
}

function requireString(value: StrictJsonValue | undefined, field: string): asserts value is string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
}

function requireBoolean(value: StrictJsonValue | undefined, field: string): asserts value is boolean {
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`);
}

function requireNumber(value: StrictJsonValue | undefined, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field} must be finite`);
}

function requireNonNegativeFinite(
  value: StrictJsonValue | undefined,
  field: string,
): asserts value is number {
  requireNumber(value, field);
  if (value < 0) throw new Error(`${field} must be non-negative`);
}

function requireNonNegativeSafeInteger(
  value: StrictJsonValue | undefined,
  field: string,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
}

function validateOpLifecycleIdentity(
  envelope: Readonly<Record<string, StrictJsonValue>>,
  event: Readonly<Record<string, StrictJsonValue>>,
): void {
  if (!isRuntimeOpType(event.opType)) throw new Error('invalid op lifecycle type');
  if (event.parentOpId !== undefined && !isOpId(event.parentOpId)) {
    throw new Error('invalid parent operation id');
  }
  if (event.type === 'op_rejected') {
    requireIdentity(envelope, false, false, true);
    validateOpLifecycleOrigin(envelope, event);
    return;
  }
  const hasRootRun = event.opType === 'prompt' || event.opType === 'continue';
  requireIdentity(envelope, hasRootRun, false, true);
  validateOpLifecycleOrigin(envelope, event);
  if (event.type === 'op_completed' && hasRootRun && !isRunId(event.terminalRunId)) {
    throw new Error('invalid terminal run id');
  }
}

function validateOpLifecycleOrigin(
  envelope: Readonly<Record<string, StrictJsonValue>>,
  event: Readonly<Record<string, StrictJsonValue>>,
): void {
  const opId = envelope.opId;
  const parentOpId = event.parentOpId;
  if (event.opType === 'abort') {
    if (isExternalOpId(opId) && parentOpId === undefined) return;
    if (isDerivedOpId(opId) && isExternalOpId(parentOpId)) return;
    throw new Error('abort lifecycle origin/parent combination is invalid');
  }
  if (event.opType === 'thread_close') {
    if (isExternalOpId(opId) && parentOpId === undefined) return;
    if (isDerivedOpId(opId) && (parentOpId === undefined || isExternalOpId(parentOpId))) return;
    throw new Error('thread_close lifecycle origin/parent combination is invalid');
  }
  if (!isExternalOpId(opId) || parentOpId !== undefined) {
    throw new Error('public operation lifecycle requires an external opId without parentOpId');
  }
}

function requireOwningIdentityMatch(
  envelope: Readonly<Record<string, StrictJsonValue>>,
  event: Readonly<Record<string, StrictJsonValue>>,
): void {
  if (event.owningRunId !== envelope.runId || event.owningTurnId !== envelope.turnId) {
    throw new Error('control owner identity mismatch');
  }
}

function validateDiagnosticIdentity(
  envelope: Readonly<Record<string, StrictJsonValue>>,
  event: Readonly<Record<string, StrictJsonValue>>,
): void {
  if (event.scope === 'thread') requireIdentity(envelope, false, false, false);
  else if (event.scope === 'run') requireIdentity(envelope, true, false, false);
  else if (event.scope === 'turn') requireIdentity(envelope, true, true, false);
  else throw new Error('invalid diagnostic scope');
}

function requireIdentity(
  envelope: Readonly<Record<string, StrictJsonValue>>,
  run: boolean | 'optional',
  turn: boolean | 'optional',
  op: boolean | 'optional',
): void {
  requirePresence(envelope.runId, run, 'runId');
  requirePresence(envelope.turnId, turn, 'turnId');
  requirePresence(envelope.opId, op, 'opId');
}

function requirePresence(
  value: StrictJsonValue | undefined,
  requirement: boolean | 'optional',
  field: string,
): void {
  if (requirement === true && value === undefined) throw new Error(`${field} is required`);
  if (requirement === false && value !== undefined) throw new Error(`${field} must be omitted`);
}

function assertEnvelopeKeys(envelope: Readonly<Record<string, StrictJsonValue>>): void {
  const required = new Set(['workspaceId', 'threadId', 'seq', 'timestamp', 'event']);
  const optional = new Set(['runId', 'turnId', 'opId']);
  for (const key of Object.keys(envelope)) {
    if (!required.has(key) && !optional.has(key)) throw new Error(`unknown envelope field: ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(envelope, key)) throw new Error(`missing envelope field: ${key}`);
  }
}

function isRuntimeOpType(value: StrictJsonValue | undefined): value is RuntimeOp['type'] {
  return value === 'thread_create'
    || value === 'thread_resume'
    || value === 'prompt'
    || value === 'continue'
    || value === 'steer'
    || value === 'follow_up'
    || value === 'set_model'
    || value === 'abort'
    || value === 'control_response'
    || value === 'thread_close'
    || value === 'cancel_scope';
}

function isRecord(value: unknown): value is Readonly<Record<string, StrictJsonValue>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
