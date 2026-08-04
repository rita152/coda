// Physical v3 journal codec. Public Runtime envelopes stay canonical while high-frequency
// message updates are stored as deltas and deterministically reconstructed at recovery/replay.

import {
  canonicalJson,
  strictJsonSnapshot,
  validateEventEnvelope,
} from '../protocol/index.js';
import type {
  AssistantMessage,
  AssistantTextPart,
  EventEnvelope,
  ProviderEvent,
  ReasoningPart,
  RuntimeEvent,
  ThreadId,
  ToolCallPart,
  WorkspaceId,
} from '../protocol/index.js';
import { parsePartialJson } from '../shared/partial-json.js';
import { RuntimeStorageError } from '../shared/runtime-storage-error.js';
import type {
  RuntimeJournalRecord,
  RuntimeThreadMutation,
  ThreadCommitRecord,
} from './thread-journal-records.js';

type AssistantMessageShell = Omit<AssistantMessage, 'content'>;
type TextPartMetadata = Omit<AssistantTextPart, 'text'>;
type ReasoningPartMetadata = Omit<ReasoningPart, 'text'>;
type ToolCallPartMetadata = Pick<ToolCallPart, 'type' | 'id' | 'name'>;
type ProviderBlockEvent = Extract<ProviderEvent, { readonly contentIndex: number }>;

export type CompactProviderBlockEvent =
  | { readonly type: 'text_start'; readonly contentIndex: number;
      readonly message: AssistantMessageShell; readonly part: AssistantTextPart }
  | { readonly type: 'text_delta'; readonly contentIndex: number; readonly delta: string;
      readonly message: AssistantMessageShell; readonly part: TextPartMetadata }
  | { readonly type: 'text_end'; readonly contentIndex: number;
      readonly message: AssistantMessageShell; readonly part: AssistantTextPart }
  | { readonly type: 'reasoning_start'; readonly contentIndex: number;
      readonly message: AssistantMessageShell; readonly part: ReasoningPart }
  | { readonly type: 'reasoning_delta'; readonly contentIndex: number; readonly delta: string;
      readonly message: AssistantMessageShell; readonly part: ReasoningPartMetadata }
  | { readonly type: 'reasoning_end'; readonly contentIndex: number;
      readonly message: AssistantMessageShell; readonly part: ReasoningPart }
  | { readonly type: 'tool_call_start'; readonly contentIndex: number;
      readonly message: AssistantMessageShell; readonly part: ToolCallPart }
  | { readonly type: 'tool_call_delta'; readonly contentIndex: number; readonly delta: string;
      readonly message: AssistantMessageShell; readonly part: ToolCallPartMetadata }
  | { readonly type: 'tool_call_end'; readonly contentIndex: number;
      readonly message: AssistantMessageShell; readonly part: ToolCallPart };

export interface CompactMessageUpdateEvent {
  readonly type: 'message_update';
  readonly messageId: string;
  readonly event: CompactProviderBlockEvent;
}

export type DurableEventEnvelope = Omit<EventEnvelope, 'event'> & {
  readonly event: Exclude<RuntimeEvent, { type: 'message_update' }> | CompactMessageUpdateEvent;
};

export interface DurableThreadCommitRecord extends Omit<ThreadCommitRecord, 'envelopes'> {
  readonly envelopes: readonly [DurableEventEnvelope, ...DurableEventEnvelope[]];
}

export type DurableRuntimeJournalRecord =
  | Exclude<RuntimeJournalRecord, ThreadCommitRecord>
  | DurableThreadCommitRecord;

type BlockFamily = 'text' | 'reasoning' | 'tool_call';

export interface JournalMessageCodecState {
  activeAssistant?: AssistantMessage;
  /** Provider block starts are append-ordered even if message_start already exposes placeholders. */
  nextBlockStartIndex: number;
  openBlocks: readonly {
    readonly contentIndex: number;
    readonly family: BlockFamily;
  }[];
}

export function emptyJournalMessageCodecState(): JournalMessageCodecState {
  return { nextBlockStartIndex: 0, openBlocks: Object.freeze([]) };
}

export function cloneJournalMessageCodecState(
  state: Readonly<JournalMessageCodecState>,
): JournalMessageCodecState {
  return {
    ...(state.activeAssistant !== undefined && { activeAssistant: snapshot(state.activeAssistant) }),
    nextBlockStartIndex: state.nextBlockStartIndex,
    openBlocks: snapshot(state.openBlocks),
  };
}

/** Encodes one already-canonical in-memory record and advances the supplied lifecycle state. */
export function encodeDurableJournalRecord(
  record: Readonly<RuntimeJournalRecord>,
  state: JournalMessageCodecState,
): DurableRuntimeJournalRecord {
  if (record.type !== 'commit') return snapshot(record);
  const envelopes = record.envelopes.map((envelope) => encodeEnvelope(envelope, state));
  applyRecoveryMutations(state, record.mutations);
  return snapshot({
    type: 'commit',
    firstSeq: record.firstSeq,
    envelopes: envelopes as [DurableEventEnvelope, ...DurableEventEnvelope[]],
    ...(record.mutations !== undefined && { mutations: record.mutations }),
  });
}

/** Decodes one physical commit, reconstructing canonical public envelopes before validation. */
export function decodeDurableCommitRecord(
  input: unknown,
  workspaceId: WorkspaceId,
  threadId: ThreadId,
  state: JournalMessageCodecState,
): ThreadCommitRecord {
  const value = strictJsonSnapshot(input);
  if (!isRecord(value)) throw invalidCodec('Durable commit is not an object');
  assertExactKeys(value, ['type', 'firstSeq', 'envelopes'], ['mutations']);
  if (value.type !== 'commit' || !isPositiveSafeInteger(value.firstSeq)
    || !Array.isArray(value.envelopes) || value.envelopes.length === 0
    || (value.mutations !== undefined && !Array.isArray(value.mutations))) {
    throw invalidCodec('Invalid durable commit shape');
  }
  const envelopes = value.envelopes.map((envelope) =>
    decodeEnvelope(envelope, workspaceId, threadId, state));
  const mutations = value.mutations as readonly RuntimeThreadMutation[] | undefined;
  applyRecoveryMutations(state, mutations);
  return snapshot({
    type: 'commit',
    firstSeq: value.firstSeq,
    envelopes: envelopes as [EventEnvelope, ...EventEnvelope[]],
    ...(mutations !== undefined && { mutations }),
  });
}

/** Snapshot replay uses the same physical envelope grammar without manufacturing commit records. */
export function encodeDurableEventEnvelope(
  envelope: Readonly<EventEnvelope>,
  state: JournalMessageCodecState,
): DurableEventEnvelope {
  return encodeEnvelope(envelope, state);
}

/** Expands one compact snapshot-replay envelope through the canonical public validator. */
export function decodeDurableEventEnvelope(
  input: unknown,
  workspaceId: WorkspaceId,
  threadId: ThreadId,
  state: JournalMessageCodecState,
): Readonly<EventEnvelope> {
  return decodeEnvelope(input, workspaceId, threadId, state);
}

function encodeEnvelope(
  input: Readonly<EventEnvelope>,
  state: JournalMessageCodecState,
): DurableEventEnvelope {
  const envelope = validateEventEnvelope(input);
  if (envelope.event.type !== 'message_update') {
    applyLifecycleEvent(state, envelope.event);
    return snapshot(envelope) as DurableEventEnvelope;
  }
  // Canonical envelope validation above proves message_update excludes provider start/terminal.
  const compact = compactProviderEvent(
    envelope.event.event as ProviderBlockEvent,
    envelope.event.messageId,
    state,
  );
  const { event: _event, ...identity } = envelope;
  void _event;
  return snapshot({
    ...identity,
    event: {
      type: 'message_update',
      messageId: envelope.event.messageId,
      event: compact,
    },
  });
}

function decodeEnvelope(
  input: unknown,
  workspaceId: WorkspaceId,
  threadId: ThreadId,
  state: JournalMessageCodecState,
): Readonly<EventEnvelope> {
  if (!isRecord(input) || !isRecord(input['event'])) {
    throw invalidCodec('Durable envelope has no event');
  }
  const event = input['event'];
  if (event['type'] !== 'message_update') {
    const envelope = validateEventEnvelope(input);
    if (envelope.workspaceId !== workspaceId || envelope.threadId !== threadId) {
      throw invalidCodec('Durable envelope ownership mismatch');
    }
    applyLifecycleEvent(state, envelope.event);
    return envelope;
  }
  assertExactKeys(event, ['type', 'messageId', 'event']);
  if (typeof event['messageId'] !== 'string') throw invalidCodec('Invalid compact messageId');
  const provider = expandProviderEvent(event['event'], event['messageId'], state);
  const envelope = validateEventEnvelope({
    ...input,
    event: {
      type: 'message_update',
      messageId: event['messageId'],
      event: provider,
    },
  });
  if (envelope.workspaceId !== workspaceId || envelope.threadId !== threadId) {
    throw invalidCodec('Durable envelope ownership mismatch');
  }
  return envelope;
}

function compactProviderEvent(
  event: ProviderBlockEvent,
  messageId: string,
  state: JournalMessageCodecState,
): CompactProviderBlockEvent {
  const partial = event.partial;
  const shell = messageShell(partial);
  const family = providerFamily(event.type);
  const current = requireActiveAssistant(state, messageId);
  const content = [...current.content];
  if (event.type === 'text_start'
    || event.type === 'reasoning_start'
    || event.type === 'tool_call_start') {
    if (event.contentIndex !== state.nextBlockStartIndex
      || event.contentIndex > content.length
      || findOpenBlock(state, event.contentIndex) !== undefined) {
      throw invalidCodec('Provider block start is not append-only');
    }
    const part = partial.content[event.contentIndex];
    if (part === undefined || part.type !== family) throw invalidCodec('Provider block start family mismatch');
    if (event.contentIndex === content.length) content.push(part);
    else content[event.contentIndex] = part;
    state.nextBlockStartIndex++;
    installOpenBlock(state, event.contentIndex, family);
    installPartial(state, partial, shell, content);
    return snapshot({ type: event.type, contentIndex: event.contentIndex, message: shell, part }) as
      CompactProviderBlockEvent;
  }
  requireOpenBlock(state, event.contentIndex, family);
  const previous = content[event.contentIndex];
  if (previous === undefined || previous.type !== family) throw invalidCodec('Provider block is missing');
  if (event.type === 'text_delta'
    || event.type === 'reasoning_delta'
    || event.type === 'tool_call_delta') {
    const next = deltaPart(previous, event.delta);
    content[event.contentIndex] = withPartMetadata(next, partial.content[event.contentIndex]);
    installPartial(state, partial, shell, content);
    return snapshot({
      type: event.type,
      contentIndex: event.contentIndex,
      delta: event.delta,
      message: shell,
      part: partMetadata(partial.content[event.contentIndex], family),
    }) as CompactProviderBlockEvent;
  }
  const part = partial.content[event.contentIndex];
  if (part === undefined || part.type !== family) throw invalidCodec('Provider block end family mismatch');
  if (event.type === 'text_end' || event.type === 'reasoning_end') {
    if ((part.type !== 'text' && part.type !== 'reasoning') || event.content !== part.text) {
      throw invalidCodec('Provider block end content differs from its partial');
    }
  }
  if (event.type === 'tool_call_end' && canonicalJson(event.toolCall) !== canonicalJson(part)) {
    throw invalidCodec('Provider tool end differs from its partial');
  }
  content[event.contentIndex] = part;
  installPartial(state, partial, shell, content);
  removeOpenBlock(state, event.contentIndex, family);
  return snapshot({ type: event.type, contentIndex: event.contentIndex, message: shell, part }) as
    CompactProviderBlockEvent;
}

function expandProviderEvent(
  input: unknown,
  messageId: string,
  state: JournalMessageCodecState,
): Extract<RuntimeEvent, { type: 'message_update' }>['event'] {
  if (!isRecord(input) || typeof input['type'] !== 'string') {
    throw invalidCodec('Compact provider event has no discriminator');
  }
  const type = input['type'];
  const family = providerFamily(type);
  const isDelta = type.endsWith('_delta');
  assertExactKeys(
    input,
    isDelta
      ? ['type', 'contentIndex', 'delta', 'message', 'part']
      : ['type', 'contentIndex', 'message', 'part'],
  );
  if (!isNonNegativeSafeInteger(input['contentIndex'])
    || (isDelta && typeof input['delta'] !== 'string')) {
    throw invalidCodec('Invalid compact provider event fields');
  }
  const contentIndex = input['contentIndex'];
  const shell = validateMessageShell(input['message'], messageId);
  const current = requireActiveAssistant(state, messageId);
  const content = [...current.content];
  let part: AssistantMessage['content'][number];
  if (type.endsWith('_start')) {
    if (contentIndex !== state.nextBlockStartIndex || contentIndex > content.length
      || findOpenBlock(state, contentIndex) !== undefined) {
      throw invalidCodec('Compact provider block start is not append-only');
    }
    part = validateFullPart(input['part'], family);
    if (contentIndex === content.length) content.push(part);
    else content[contentIndex] = part;
    state.nextBlockStartIndex++;
    installOpenBlock(state, contentIndex, family);
  } else if (isDelta) {
    requireOpenBlock(state, contentIndex, family);
    const previous = content[contentIndex];
    if (previous === undefined || previous.type !== family) throw invalidCodec('Compact provider block is missing');
    part = applyPartMetadata(deltaPart(previous, input['delta'] as string), input['part'], family);
    content[contentIndex] = part;
  } else {
    requireOpenBlock(state, contentIndex, family);
    part = validateFullPart(input['part'], family);
    content[contentIndex] = part;
    removeOpenBlock(state, contentIndex, family);
  }
  const partial = snapshot({ ...shell, content }) as AssistantMessage;
  setActiveAssistant(state, partial);
  if (type === 'text_start' || type === 'reasoning_start' || type === 'tool_call_start') {
    return snapshot({ type, contentIndex, partial }) as Extract<RuntimeEvent, { type: 'message_update' }>['event'];
  }
  if (type === 'text_delta' || type === 'reasoning_delta' || type === 'tool_call_delta') {
    return snapshot({ type, contentIndex, delta: input['delta'], partial }) as
      Extract<RuntimeEvent, { type: 'message_update' }>['event'];
  }
  if (type === 'text_end' || type === 'reasoning_end') {
    if (part.type !== family || !('text' in part)) throw invalidCodec('Compact text end is invalid');
    return snapshot({ type, contentIndex, content: part.text, partial }) as
      Extract<RuntimeEvent, { type: 'message_update' }>['event'];
  }
  if (part.type !== 'tool_call') throw invalidCodec('Compact tool end is invalid');
  return snapshot({ type: 'tool_call_end', contentIndex, toolCall: part, partial });
}

function applyLifecycleEvent(state: JournalMessageCodecState, event: RuntimeEvent): void {
  if (event.type === 'message_start' && event.message.role === 'assistant') {
    if (state.activeAssistant !== undefined) throw invalidCodec('Assistant message lifecycle overlaps');
    setActiveAssistant(state, event.message);
    state.nextBlockStartIndex = 0;
    replaceOpenBlocks(state, []);
  } else if (event.type === 'message_end' && event.message.role === 'assistant') {
    if (state.activeAssistant === undefined) {
      throw invalidCodec('Assistant message_end has no matching message_start');
    }
    if (state.activeAssistant.id !== event.message.id) {
      throw invalidCodec('Assistant message_end identity mismatch');
    }
    if (canonicalJson(state.activeAssistant.content) !== canonicalJson(event.message.content)) {
      throw invalidCodec('Assistant message_end content does not match reconstructed partial');
    }
    if (state.openBlocks.length > 0
      || state.nextBlockStartIndex !== state.activeAssistant.content.length) {
      throw invalidCodec('Assistant message_end has an incomplete provider block lifecycle');
    }
    clearActiveAssistant(state);
  }
}

function applyRecoveryMutations(
  state: JournalMessageCodecState,
  mutations: readonly RuntimeThreadMutation[] | undefined,
): void {
  if (mutations?.some((mutation) => mutation.type === 'activity_interrupted') === true) {
    clearActiveAssistant(state);
  }
}

function installPartial(
  state: JournalMessageCodecState,
  publicPartial: AssistantMessage,
  shell: AssistantMessageShell,
  content: AssistantMessage['content'],
): void {
  const reconstructed = snapshot({ ...shell, content }) as AssistantMessage;
  if (canonicalJson(reconstructed) !== canonicalJson(publicPartial)) {
    throw invalidCodec('Provider partial is not the deterministic delta fold');
  }
  setActiveAssistant(state, reconstructed);
}

function deltaPart(
  previous: AssistantMessage['content'][number],
  delta: string,
): AssistantMessage['content'][number] {
  if (previous.type === 'text') return { ...previous, text: previous.text + delta };
  if (previous.type === 'reasoning') return { ...previous, text: previous.text + delta };
  const rawArguments = (previous.rawArguments ?? '') + delta;
  return {
    ...previous,
    arguments: parsePartialJson(rawArguments),
    rawArguments,
  };
}

function partMetadata(
  input: AssistantMessage['content'][number] | undefined,
  family: BlockFamily,
): TextPartMetadata | ReasoningPartMetadata | ToolCallPartMetadata {
  if (input === undefined || input.type !== family) throw invalidCodec('Provider delta part family mismatch');
  if (input.type === 'text') {
    const { text: _text, ...metadata } = input;
    void _text;
    return metadata;
  }
  if (input.type === 'reasoning') {
    const { text: _text, ...metadata } = input;
    void _text;
    return metadata;
  }
  return { type: 'tool_call', id: input.id, name: input.name };
}

function withPartMetadata(
  derived: AssistantMessage['content'][number],
  publicPart: AssistantMessage['content'][number] | undefined,
): AssistantMessage['content'][number] {
  const metadata = partMetadata(publicPart, derived.type);
  return mergePartMetadata(
    derived,
    metadata as unknown as Readonly<Record<string, unknown>>,
    derived.type,
  );
}

function applyPartMetadata(
  derived: AssistantMessage['content'][number],
  input: unknown,
  family: BlockFamily,
): AssistantMessage['content'][number] {
  if (!isRecord(input)) throw invalidCodec('Compact part metadata is not an object');
  if (family === 'text') assertExactKeys(input, ['type'], ['phase']);
  else if (family === 'reasoning') assertExactKeys(input, ['type'], ['kind', 'signature']);
  else assertExactKeys(input, ['type', 'id', 'name']);
  return mergePartMetadata(derived, input, family);
}

function mergePartMetadata(
  derived: AssistantMessage['content'][number],
  metadata: Readonly<Record<string, unknown>>,
  family: BlockFamily,
): AssistantMessage['content'][number] {
  if (metadata['type'] !== family || derived.type !== family) throw invalidCodec('Compact part metadata family mismatch');
  if (family === 'text' && derived.type === 'text') {
    if (metadata['phase'] !== undefined
      && metadata['phase'] !== 'commentary' && metadata['phase'] !== 'final_answer') {
      throw invalidCodec('Invalid text phase');
    }
    return { type: 'text', text: derived.text,
      ...(metadata['phase'] !== undefined && { phase: metadata['phase'] }) } as AssistantTextPart;
  }
  if (family === 'reasoning' && derived.type === 'reasoning') {
    if (metadata['kind'] !== undefined && metadata['kind'] !== 'summary' && metadata['kind'] !== 'content') {
      throw invalidCodec('Invalid reasoning kind');
    }
    if (metadata['signature'] !== undefined && typeof metadata['signature'] !== 'string') {
      throw invalidCodec('Invalid reasoning signature');
    }
    return {
      type: 'reasoning',
      text: derived.text,
      ...(metadata['kind'] !== undefined && { kind: metadata['kind'] }),
      ...(metadata['signature'] !== undefined && { signature: metadata['signature'] }),
    } as ReasoningPart;
  }
  if (family === 'tool_call' && derived.type === 'tool_call') {
    if (typeof metadata['id'] !== 'string' || typeof metadata['name'] !== 'string') {
      throw invalidCodec('Invalid tool call metadata');
    }
    return { ...derived, id: metadata['id'], name: metadata['name'] };
  }
  throw invalidCodec('Compact part metadata does not match derived part');
}

function validateFullPart(
  input: unknown,
  family: BlockFamily,
): AssistantMessage['content'][number] {
  if (!isRecord(input) || input['type'] !== family) throw invalidCodec('Compact full part family mismatch');
  // The canonical envelope validator performs the complete recursive shape validation after the
  // partial is reconstructed. Snapshot here only detaches the physical record.
  return snapshot(input) as unknown as AssistantMessage['content'][number];
}

function validateMessageShell(input: unknown, messageId: string): AssistantMessageShell {
  if (!isRecord(input)) throw invalidCodec('Compact assistant shell is not an object');
  assertExactKeys(input, ['role', 'id', 'timestamp', 'model', 'stopReason', 'usage'], [
    'errorMessage', 'errorDetails',
  ]);
  if (input['role'] !== 'assistant' || input['id'] !== messageId) {
    throw invalidCodec('Compact assistant shell identity mismatch');
  }
  return snapshot(input) as unknown as AssistantMessageShell;
}

function messageShell(message: AssistantMessage): AssistantMessageShell {
  const { content: _content, ...shell } = message;
  void _content;
  return snapshot(shell);
}

function requireActiveAssistant(
  state: Readonly<JournalMessageCodecState>,
  messageId: string,
): AssistantMessage {
  if (state.activeAssistant === undefined || state.activeAssistant.id !== messageId) {
    throw invalidCodec('message_update has no matching assistant message_start');
  }
  return state.activeAssistant;
}

function providerFamily(type: string): BlockFamily {
  if (type === 'text_start' || type === 'text_delta' || type === 'text_end') return 'text';
  if (type === 'reasoning_start' || type === 'reasoning_delta' || type === 'reasoning_end') return 'reasoning';
  if (type === 'tool_call_start' || type === 'tool_call_delta' || type === 'tool_call_end') return 'tool_call';
  throw invalidCodec(`Unknown compact provider event ${type}`);
}

function findOpenBlock(
  state: Readonly<JournalMessageCodecState>,
  contentIndex: number,
): { readonly contentIndex: number; readonly family: BlockFamily } | undefined {
  return state.openBlocks.find((block) => block.contentIndex === contentIndex);
}

function requireOpenBlock(
  state: Readonly<JournalMessageCodecState>,
  contentIndex: number,
  family: BlockFamily,
): void {
  if (findOpenBlock(state, contentIndex)?.family !== family) {
    throw invalidCodec('Provider delta/end has no matching block start');
  }
}

function installOpenBlock(
  state: JournalMessageCodecState,
  contentIndex: number,
  family: BlockFamily,
): void {
  replaceOpenBlocks(state, [...state.openBlocks, { contentIndex, family }]);
}

function removeOpenBlock(
  state: JournalMessageCodecState,
  contentIndex: number,
  family: BlockFamily,
): void {
  requireOpenBlock(state, contentIndex, family);
  replaceOpenBlocks(state, state.openBlocks.filter((block) => block.contentIndex !== contentIndex));
}

function setActiveAssistant(state: JournalMessageCodecState, message: AssistantMessage): void {
  state.activeAssistant = snapshot(message);
}

function clearActiveAssistant(state: JournalMessageCodecState): void {
  delete state.activeAssistant;
  state.nextBlockStartIndex = 0;
  replaceOpenBlocks(state, []);
}

function replaceOpenBlocks(
  state: JournalMessageCodecState,
  blocks: JournalMessageCodecState['openBlocks'],
): void {
  state.openBlocks = snapshot(blocks);
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !allowed.has(key))) {
    throw invalidCodec('Compact journal record has unknown or missing fields');
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function invalidCodec(message: string): RuntimeStorageError {
  return new RuntimeStorageError('invalid_compact_journal', message);
}

function snapshot<T>(value: T): T {
  return strictJsonSnapshot(value) as T;
}
