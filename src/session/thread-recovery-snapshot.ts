// JSON materialization of the recovery projection. The journal remains authoritative; file storage
// accepts this cache only with an integrity digest and an exact journal inode/size boundary.

import {
  canonicalJson,
  isDerivedOpId,
  isOpId,
  isRunId,
  isThreadId,
  isTurnId,
  strictJsonSnapshot,
  validateEventEnvelope,
} from '../protocol/index.js';
import type {
  AssistantMessage,
  EventEnvelope,
  OpId,
  ProviderEvent,
  RunId,
  RuntimeEvent,
  TurnId,
} from '../protocol/index.js';
import { RuntimeStorageError } from '../shared/runtime-storage-error.js';
import {
  decodeDurableEventEnvelope,
  emptyJournalMessageCodecState,
  encodeDurableEventEnvelope,
} from './thread-journal-codec.js';
import type {
  DurableEventEnvelope,
  JournalMessageCodecState,
} from './thread-journal-codec.js';
import type {
  FoldedMailboxEntry,
  FoldedControlResolution,
  FoldedOpTerminal,
  FoldedRunEntry,
  FoldedThreadResult,
  FoldedThreadJournal,
  FoldedTurnEntry,
} from './thread-journal.js';
import { THREAD_REPLAY_BYTE_LIMIT, THREAD_REPLAY_LIMIT } from './thread-journal.js';
import type { RuntimeThreadMutation, ThreadMetaRecord } from './thread-journal-records.js';

export interface SerializedThreadRecoveryState {
  readonly meta: ThreadMetaRecord;
  readonly highWaterSeq: number;
  /** One public seed partial per cut assistant lifecycle; later updates use the v3 delta grammar. */
  readonly envelopes: readonly (EventEnvelope | DurableEventEnvelope)[];
  readonly replayBytes: number;
  readonly checkpoint: FoldedThreadJournal['checkpoint'];
  readonly summary: FoldedThreadJournal['summary'];
  readonly mailbox: readonly (readonly [OpId, FoldedMailboxEntry])[];
  readonly runs: readonly (readonly [RunId, FoldedRunEntry])[];
  readonly turns: readonly (readonly [string, FoldedTurnEntry])[];
  readonly messageTurnIds: readonly (readonly [string, TurnId])[];
  readonly inputOwners: readonly (readonly [OpId, { readonly sourceOpId: OpId }])[];
  readonly pendingThreadResults: readonly (readonly [string,
    Extract<RuntimeThreadMutation, { type: 'thread_result_pending' }>])[];
  readonly deliveredThreadResults: readonly string[];
  readonly usedRequestIds: readonly string[];
  readonly controlClaims: readonly (readonly [string, {
    readonly responseOpId: import('../protocol/index.js').ExternalOpId;
    readonly decision: import('../protocol/index.js').ControlResponseDecision;
    readonly acceptedAt: number;
  }])[];
  readonly opTerminals: readonly (readonly [OpId, FoldedOpTerminal])[];
  readonly threadResults: readonly (readonly [string, FoldedThreadResult])[];
  readonly controlRequests: readonly (readonly [string,
    Extract<RuntimeEvent, { type: 'control_request' }>])[];
  readonly controlResolutions: readonly (readonly [string, FoldedControlResolution])[];
  readonly observedRuleScopes: readonly string[];
}

export function serializeThreadRecoveryState(
  state: Readonly<FoldedThreadJournal>,
): SerializedThreadRecoveryState {
  const envelopes = encodeReplayTail(state.envelopes);
  return snapshot({
    meta: state.meta,
    highWaterSeq: state.highWaterSeq,
    envelopes,
    replayBytes: state.replayBytes,
    checkpoint: state.checkpoint,
    summary: state.summary,
    mailbox: [...state.mailbox],
    runs: [...state.runs],
    turns: [...state.turns],
    messageTurnIds: [...state.messageTurnIds],
    inputOwners: [...state.inputOwners],
    pendingThreadResults: [...state.pendingThreadResults],
    deliveredThreadResults: [...state.deliveredThreadResults],
    usedRequestIds: [...state.usedRequestIds],
    controlClaims: [...state.controlClaims],
    opTerminals: [...state.opTerminals],
    threadResults: [...state.threadResults],
    controlRequests: [...state.controlRequests],
    controlResolutions: [...state.controlResolutions],
    observedRuleScopes: [...state.observedRuleScopes],
  });
}

export function deserializeThreadRecoveryState(
  input: unknown,
  expectedMeta: Readonly<ThreadMetaRecord>,
): FoldedThreadJournal {
  const value = strictJsonSnapshot(input);
  if (!isRecord(value)) throw invalidSnapshot('Recovery state is not an object');
  assertExactKeys(value, [
    'meta', 'highWaterSeq', 'envelopes', 'replayBytes', 'checkpoint', 'summary', 'mailbox', 'runs',
    'turns', 'messageTurnIds', 'inputOwners', 'pendingThreadResults',
    'deliveredThreadResults', 'usedRequestIds', 'controlClaims', 'opTerminals',
    'threadResults', 'controlRequests', 'controlResolutions', 'observedRuleScopes',
  ]);
  if (canonicalJson(value['meta']) !== canonicalJson(expectedMeta)) {
    throw invalidSnapshot('Recovery state metadata differs from the journal header');
  }
  if (!isNonNegativeSafeInteger(value['highWaterSeq'])
    || !isNonNegativeSafeInteger(value['replayBytes']) || !Array.isArray(value['envelopes'])
    || value['envelopes'].length > THREAD_REPLAY_LIMIT) {
    throw invalidSnapshot('Recovery state high-water/replay tail is invalid');
  }
  const highWaterSeq = value['highWaterSeq'];
  const envelopes = decodeReplayTail(value['envelopes'], expectedMeta);
  let expectedSeq = highWaterSeq - envelopes.length + 1;
  for (const envelope of envelopes) {
    if (envelope.workspaceId !== expectedMeta.workspaceId || envelope.threadId !== expectedMeta.threadId
      || envelope.seq !== expectedSeq++) {
      throw invalidSnapshot('Recovery replay tail is not contiguous at high-water');
    }
  }
  const replayBytes = replayTailBytes(envelopes);
  if (replayBytes !== value['replayBytes'] || replayBytes > THREAD_REPLAY_BYTE_LIMIT) {
    throw invalidSnapshot('Recovery replay tail exceeds or disagrees with its byte boundary');
  }
  if (!isRecord(value['checkpoint']) || !isRecord(value['summary'])
    || value['summary']['threadId'] !== expectedMeta.threadId) {
    throw invalidSnapshot('Recovery checkpoint/summary is invalid');
  }

  const mailbox = entryMap(value['mailbox'], 'mailbox', isOpId, isRecord) as
    Map<OpId, FoldedMailboxEntry>;
  const runs = entryMap(value['runs'], 'runs', isRunId, isRecord) as Map<RunId, FoldedRunEntry>;
  const turns = entryMap(value['turns'], 'turns', isString, isTurnEntry) as Map<string, FoldedTurnEntry>;
  const messageTurnIds = entryMap(value['messageTurnIds'], 'messageTurnIds', isString, isTurnId) as
    Map<string, TurnId>;
  const inputOwners = entryMap(value['inputOwners'], 'inputOwners', isOpId, isInputOwner) as
    Map<OpId, { readonly sourceOpId: OpId }>;
  const pendingThreadResults = entryMap(
    value['pendingThreadResults'],
    'pendingThreadResults',
    isDerivedOpId,
    isPendingThreadResult,
  ) as Map<import('../protocol/index.js').DerivedOpId,
    Extract<RuntimeThreadMutation, { type: 'thread_result_pending' }>>;
  const deliveredThreadResults = stringSet(
    value['deliveredThreadResults'],
    'deliveredThreadResults',
    isDerivedOpId,
  ) as Set<import('../protocol/index.js').DerivedOpId>;
  const usedRequestIds = stringSet(value['usedRequestIds'], 'usedRequestIds', isString);
  const controlClaims = entryMap(value['controlClaims'], 'controlClaims', isString, isControlClaim) as
    FoldedThreadJournal['controlClaims'];
  const opTerminals = entryMap(value['opTerminals'], 'opTerminals', isOpId, isOpTerminal) as
    Map<OpId, FoldedOpTerminal>;
  const threadResults = entryMap(
    value['threadResults'],
    'threadResults',
    isDerivedOpId,
    isThreadResult,
  ) as FoldedThreadJournal['threadResults'];
  const controlRequests = entryMap(
    value['controlRequests'],
    'controlRequests',
    isString,
    isControlRequest,
  ) as FoldedThreadJournal['controlRequests'];
  const controlResolutions = entryMap(
    value['controlResolutions'],
    'controlResolutions',
    isString,
    isControlResolution,
  ) as FoldedThreadJournal['controlResolutions'];
  for (const [resultOpId, result] of threadResults) {
    if (result.event.resultOpId !== resultOpId) {
      throw invalidSnapshot('Recovery thread-result index identity differs from its key');
    }
  }
  for (const [requestId, request] of controlRequests) {
    if (request.requestId !== requestId) {
      throw invalidSnapshot('Recovery control-request index identity differs from its key');
    }
  }
  for (const [requestId, resolution] of controlResolutions) {
    if (resolution.event.requestId !== requestId) {
      throw invalidSnapshot('Recovery control-resolution index identity differs from its key');
    }
  }
  validateRecoveryIndexes({
    meta: expectedMeta,
    highWaterSeq,
    mailbox,
    opTerminals,
    threadResults,
    controlRequests,
    controlResolutions,
  });
  const observedRuleScopes = stringSet(value['observedRuleScopes'], 'observedRuleScopes', isString);

  return {
    meta: expectedMeta,
    highWaterSeq,
    envelopes,
    replayBytes,
    checkpoint: value['checkpoint'] as unknown as FoldedThreadJournal['checkpoint'],
    summary: value['summary'] as unknown as FoldedThreadJournal['summary'],
    mailbox,
    runs,
    turns,
    messageTurnIds,
    inputOwners,
    pendingThreadResults,
    deliveredThreadResults,
    usedRequestIds,
    controlClaims,
    opTerminals,
    threadResults,
    controlRequests,
    controlResolutions,
    observedRuleScopes,
  };
}

function entryMap(
  input: unknown,
  label: string,
  keyGuard: (value: unknown) => boolean,
  valueGuard: (value: unknown) => boolean,
): Map<unknown, unknown> {
  if (!Array.isArray(input)) throw invalidSnapshot(`${label} is not an entry array`);
  const result = new Map<unknown, unknown>();
  for (const entry of input) {
    if (!Array.isArray(entry) || entry.length !== 2
      || !keyGuard(entry[0]) || !valueGuard(entry[1]) || result.has(entry[0])) {
      throw invalidSnapshot(`${label} contains an invalid/duplicate entry`);
    }
    result.set(entry[0], entry[1]);
  }
  return result;
}

function stringSet(
  input: unknown,
  label: string,
  guard: (value: unknown) => boolean,
): Set<string> {
  if (!Array.isArray(input) || !input.every(guard)) throw invalidSnapshot(`${label} is invalid`);
  const result = new Set(input as string[]);
  if (result.size !== input.length) throw invalidSnapshot(`${label} contains duplicates`);
  return result;
}

function isTurnEntry(value: unknown): boolean {
  return isRecord(value) && isRunId(value['runId']) && isTurnId(value['turnId'])
    && isPositiveSafeInteger(value['turnOrdinal']) && typeof value['activated'] === 'boolean';
}

function isInputOwner(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 1 && isOpId(value['sourceOpId']);
}

function isPendingThreadResult(value: unknown): boolean {
  return isRecord(value) && value['type'] === 'thread_result_pending'
    && isDerivedOpId(value['resultOpId']) && isThreadId(value['parentThreadId'])
    && isThreadId(value['childThreadId']) && isRunId(value['terminalRunId']);
}

function isControlClaim(value: unknown): boolean {
  return isRecord(value) && typeof value['responseOpId'] === 'string'
    && typeof value['decision'] === 'string' && typeof value['acceptedAt'] === 'number'
    && Number.isFinite(value['acceptedAt']);
}

function isOpTerminal(value: unknown): boolean {
  return isRecord(value) && isPositiveSafeInteger(value['seq']) && isRecord(value['event'])
    && (value['event']['type'] === 'op_completed' || value['event']['type'] === 'op_rejected');
}

function isThreadResult(value: unknown): boolean {
  return isRecord(value) && isPositiveSafeInteger(value['seq']) && isRecord(value['event'])
    && value['event']['type'] === 'thread_result' && isDerivedOpId(value['event']['resultOpId']);
}

function isControlRequest(value: unknown): boolean {
  return isRecord(value) && value['type'] === 'control_request'
    && typeof value['requestId'] === 'string';
}

function isControlResolution(value: unknown): boolean {
  return isRecord(value) && isPositiveSafeInteger(value['seq']) && isRecord(value['event'])
    && value['event']['type'] === 'control_resolved' && typeof value['event']['requestId'] === 'string'
    && isOpId(value['opId']);
}

function validateRecoveryIndexes(input: {
  readonly meta: Readonly<ThreadMetaRecord>;
  readonly highWaterSeq: number;
  readonly mailbox: ReadonlyMap<OpId, FoldedMailboxEntry>;
  readonly opTerminals: ReadonlyMap<OpId, FoldedOpTerminal>;
  readonly threadResults: FoldedThreadJournal['threadResults'];
  readonly controlRequests: FoldedThreadJournal['controlRequests'];
  readonly controlResolutions: FoldedThreadJournal['controlResolutions'];
}): void {
  for (const [opId, entry] of input.mailbox) {
    if (!isRecord(entry) || !isRecord(entry.op) || entry.op['opId'] !== opId
      || entry.op['workspaceId'] !== input.meta.workspaceId
      || entry.op['threadId'] !== input.meta.threadId
      || (entry.state !== 'prepared' && entry.state !== 'accepted_pending'
        && entry.state !== 'started' && entry.state !== 'completed' && entry.state !== 'rejected')
      || (entry.acceptedSeq !== undefined
        && (!isPositiveSafeInteger(entry.acceptedSeq) || entry.acceptedSeq > input.highWaterSeq))
      || (entry.effectCommitted !== undefined && typeof entry.effectCommitted !== 'boolean')) {
      throw invalidSnapshot('Recovery mailbox index is inconsistent');
    }
  }
  for (const [opId, terminal] of input.opTerminals) {
    if (terminal.seq > input.highWaterSeq) throw invalidSnapshot('Recovery op terminal exceeds high-water');
    const runId = terminal.event.type === 'op_completed'
      && (terminal.event.opType === 'prompt' || terminal.event.opType === 'continue'
        || terminal.event.opType === 'compact')
      ? terminal.event.terminalRunId
      : undefined;
    validateIndexedEnvelope(input.meta, terminal.seq, terminal.event, {
      opId,
      ...(runId !== undefined && { runId }),
    });
    const mailbox = input.mailbox.get(opId);
    if (mailbox !== undefined
      && (mailbox.op.type !== terminal.event.opType
        || (terminal.event.type === 'op_completed' && mailbox.state !== 'completed')
        || (terminal.event.type === 'op_rejected' && mailbox.state !== 'rejected'))) {
      throw invalidSnapshot('Recovery op terminal differs from mailbox state');
    }
  }
  for (const [resultOpId, result] of input.threadResults) {
    if (result.seq > input.highWaterSeq) throw invalidSnapshot('Recovery thread result exceeds high-water');
    validateIndexedEnvelope(input.meta, result.seq, result.event, { opId: resultOpId });
  }
  for (const request of input.controlRequests.values()) {
    validateIndexedEnvelope(input.meta, 1, request, {
      runId: request.owningRunId,
      turnId: request.owningTurnId,
    });
  }
  for (const resolution of input.controlResolutions.values()) {
    if (resolution.seq > input.highWaterSeq || resolution.opId === undefined) {
      throw invalidSnapshot('Recovery control resolution exceeds high-water or lacks OpId');
    }
    validateIndexedEnvelope(input.meta, resolution.seq, resolution.event, {
      opId: resolution.opId,
      runId: resolution.event.owningRunId,
      turnId: resolution.event.owningTurnId,
    });
  }
}

function validateIndexedEnvelope(
  meta: Readonly<ThreadMetaRecord>,
  seq: number,
  event: RuntimeEvent,
  identity: { readonly opId?: OpId; readonly runId?: RunId; readonly turnId?: TurnId },
): void {
  try {
    validateEventEnvelope({
      workspaceId: meta.workspaceId,
      threadId: meta.threadId,
      seq,
      timestamp: 0,
      ...identity,
      event,
    });
  } catch {
    throw invalidSnapshot('Recovery event index contains an invalid public event');
  }
}

function assertExactKeys(value: Readonly<Record<string, unknown>>, required: readonly string[]): void {
  if (Object.keys(value).length !== required.length
    || required.some((key) => !Object.hasOwn(value, key))) {
    throw invalidSnapshot('Recovery state has unknown or missing fields');
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function encodeReplayTail(
  envelopes: readonly Readonly<EventEnvelope>[],
): readonly (Readonly<EventEnvelope> | DurableEventEnvelope)[] {
  const codec = emptyJournalMessageCodecState();
  const encoded: (Readonly<EventEnvelope> | DurableEventEnvelope)[] = [];
  let seededMidLifecycle = false;
  for (const envelope of envelopes) {
    const event = envelope.event;
    if (event.type === 'message_update'
      && (codec.activeAssistant === undefined
        || codec.activeAssistant.id !== event.messageId)) {
      // A retained window may begin midway through an assistant lifecycle. That first cumulative
      // partial is the bounded replay base; every following update is encoded as an actual delta.
      encoded.push(envelope);
      seedReplayCodec(codec, envelope);
      seededMidLifecycle = true;
      continue;
    }
    if (event.type === 'message_start' && event.message.role === 'assistant'
      && codec.activeAssistant !== undefined) {
      // An activity_interrupted mutation is not itself a public envelope. A later message_start is
      // therefore also a deterministic replay reset when the retained window crosses that commit.
      encoded.push(envelope);
      seedReplayCodec(codec, envelope);
      seededMidLifecycle = false;
      continue;
    }
    if (event.type === 'message_end' && event.message.role === 'assistant'
      && (seededMidLifecycle || codec.activeAssistant === undefined
        || codec.activeAssistant.id !== event.message.id)) {
      encoded.push(envelope);
      seedReplayCodec(codec, envelope);
      seededMidLifecycle = false;
      continue;
    }
    encoded.push(encodeDurableEventEnvelope(envelope, codec));
    if (event.type === 'message_start' && event.message.role === 'assistant') {
      seededMidLifecycle = false;
    } else if (event.type === 'message_end' && event.message.role === 'assistant') {
      seededMidLifecycle = false;
    }
  }
  return encoded;
}

function decodeReplayTail(
  input: readonly unknown[],
  meta: Readonly<ThreadMetaRecord>,
): readonly Readonly<EventEnvelope>[] {
  const codec = emptyJournalMessageCodecState();
  const decoded: Readonly<EventEnvelope>[] = [];
  for (const stored of input) {
    let envelope: Readonly<EventEnvelope>;
    if (isCompactMessageUpdateEnvelope(stored)) {
      envelope = decodeDurableEventEnvelope(stored, meta.workspaceId, meta.threadId, codec);
    } else {
      envelope = validateEventEnvelope(stored);
      seedReplayCodec(codec, envelope);
    }
    decoded.push(envelope);
  }
  return decoded;
}

function isCompactMessageUpdateEnvelope(input: unknown): boolean {
  if (!isRecord(input) || !isRecord(input['event'])
    || input['event']['type'] !== 'message_update' || !isRecord(input['event']['event'])) {
    return false;
  }
  return !Object.hasOwn(input['event']['event'], 'partial');
}

function seedReplayCodec(
  state: JournalMessageCodecState,
  envelope: Readonly<EventEnvelope>,
): void {
  const event = envelope.event;
  if (event.type === 'message_start' && event.message.role === 'assistant') {
    state.activeAssistant = snapshot(event.message);
    state.nextBlockStartIndex = 0;
    state.openBlocks = snapshot([]);
    return;
  }
  if (event.type === 'message_update') {
    if (!('partial' in event.event) || !('contentIndex' in event.event)) {
      throw invalidSnapshot('Recovery replay contains a non-block provider event');
    }
    const partial = event.event.partial;
    state.activeAssistant = snapshot(partial);
    state.nextBlockStartIndex = partial.content.length;
    state.openBlocks = replaySeedOpenBlocks(partial, event.event);
    return;
  }
  if (event.type === 'message_end' && event.message.role === 'assistant') {
    delete state.activeAssistant;
    state.nextBlockStartIndex = 0;
    state.openBlocks = snapshot([]);
  }
}

function replaySeedOpenBlocks(
  partial: Readonly<AssistantMessage>,
  event: Extract<ProviderEvent, { readonly contentIndex: number }>,
): JournalMessageCodecState['openBlocks'] {
  const endedIndex = event.type.endsWith('_end') ? event.contentIndex : undefined;
  return snapshot(partial.content.flatMap((part, contentIndex) => {
    if (contentIndex === endedIndex) return [];
    return [{ contentIndex, family: part.type }];
  }));
}

function replayTailBytes(envelopes: readonly Readonly<EventEnvelope>[]): number {
  return envelopes.reduce(
    (total, envelope) => total + new TextEncoder().encode(canonicalJson(envelope)).byteLength,
    0,
  );
}

function invalidSnapshot(message: string): RuntimeStorageError {
  return new RuntimeStorageError('invalid_recovery_snapshot', message);
}

function snapshot<T>(value: T): T {
  return strictJsonSnapshot(value) as T;
}
