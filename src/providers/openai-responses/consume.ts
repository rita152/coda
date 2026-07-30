// 入站转换：Responses SSE 事件 → ProviderEvent。
// 只读取结构化 wire 字段，fixture 与真实 SDK 流共用同一状态机。

import type {
  AssistantMessage,
  ModelRef,
  ReasoningPart,
  TextPart,
  ToolCallPart,
  Usage,
} from '../../protocol/index.js';
import type { ProviderEventStream } from '../../protocol/index.js';
import { parsePartialJson } from '../../shared/partial-json.js';
import { encodeReasoningMetadata } from './reasoning.js';
import { ResponsesWireError } from './wire-error.js';

interface TextSlot {
  kind: 'text';
  contentIndex: number;
  part: TextPart;
  closed: boolean;
}

interface ReasoningSlot {
  kind: 'reasoning';
  contentIndex: number;
  part: ReasoningPart;
  itemId: string;
  reasoningKind: 'item' | 'summary' | 'content';
  wireIndex: number;
  encryptedContent?: string;
  closed: boolean;
}

interface ToolSlot {
  kind: 'tool_call';
  contentIndex: number;
  part: ToolCallPart;
  itemId: string;
  outputIndex: number;
  closed: boolean;
}

type BlockSlot = TextSlot | ReasoningSlot | ToolSlot;

export interface ResponsesStreamState {
  partial: AssistantMessage;
  textSlots: Map<string, TextSlot>;
  reasoningSlots: Map<string, ReasoningSlot>;
  toolSlotsByItem: Map<string, ToolSlot>;
  toolSlotsByOutput: Map<number, ToolSlot>;
  terminal: boolean;
}

export function newResponsesStreamState(ref: ModelRef): ResponsesStreamState {
  return {
    partial: {
      role: 'assistant',
      id: `oar_${crypto.randomUUID()}`,
      timestamp: Date.now(),
      content: [],
      model: ref,
      stopReason: 'stop',
      usage: { input: 0, output: 0 },
    },
    textSlots: new Map(),
    reasoningSlots: new Map(),
    toolSlotsByItem: new Map(),
    toolSlotsByOutput: new Map(),
    terminal: false,
  };
}

export function handleResponseEvent(
  event: unknown,
  state: ResponsesStreamState,
  stream: ProviderEventStream,
): void {
  if (event === null || typeof event !== 'object') return;
  const wire = event as Record<string, unknown>;
  const type = wire['type'];
  if (typeof type !== 'string') return;

  switch (type) {
    case 'response.output_item.added':
      syncOutputItem(wire['item'], numberOr(wire['output_index'], 0), false, state, stream);
      break;
    case 'response.output_item.done':
      syncOutputItem(wire['item'], numberOr(wire['output_index'], 0), true, state, stream);
      break;
    case 'response.content_part.added':
      syncContentPart(wire, false, state, stream);
      break;
    case 'response.content_part.done':
      syncContentPart(wire, true, state, stream);
      break;
    case 'response.output_text.delta':
      appendTextEvent(wire, 'output_text', state, stream);
      break;
    case 'response.output_text.done':
      finishTextEvent(wire, 'output_text', 'text', state, stream);
      break;
    case 'response.refusal.delta':
      appendTextEvent(wire, 'refusal', state, stream);
      break;
    case 'response.refusal.done':
      finishTextEvent(wire, 'refusal', 'refusal', state, stream);
      break;
    case 'response.reasoning_summary_part.added':
      syncReasoningPartEvent(wire, 'summary', false, state, stream);
      break;
    case 'response.reasoning_summary_part.done':
      syncReasoningPartEvent(wire, 'summary', true, state, stream);
      break;
    case 'response.reasoning_summary_text.delta':
      appendReasoningEvent(wire, 'summary', state, stream);
      break;
    case 'response.reasoning_summary_text.done':
      finishReasoningEvent(wire, 'summary', state, stream);
      break;
    case 'response.reasoning_text.delta':
      appendReasoningEvent(wire, 'content', state, stream);
      break;
    case 'response.reasoning_text.done':
      finishReasoningEvent(wire, 'content', state, stream);
      break;
    case 'response.function_call_arguments.delta':
      appendFunctionArguments(wire, state, stream);
      break;
    case 'response.function_call_arguments.done':
      finishFunctionArguments(wire, state, stream);
      break;
    case 'response.completed': {
      const response = asRecord(wire['response']);
      syncResponse(response, state, stream);
      const hasCalls = state.partial.content.some((part) => part.type === 'tool_call');
      finishDone(state, stream, hasCalls ? 'tool_calls' : 'stop');
      break;
    }
    case 'response.incomplete': {
      const response = asRecord(wire['response']);
      syncResponse(response, state, stream);
      const details = asRecord(response['incomplete_details']);
      const reason = details['reason'];
      if (reason === 'max_output_tokens') {
        finishDone(state, stream, 'length');
      } else if (reason === 'content_filter') {
        finishDone(state, stream, 'content_filter');
      } else {
        throw new ResponsesWireError(
          `response incomplete without a supported reason: ${String(reason)}`,
          'response_incomplete',
        );
      }
      break;
    }
    case 'response.failed': {
      const response = asRecord(wire['response']);
      syncResponse(response, state, stream);
      const error = asRecord(response['error']);
      throw new ResponsesWireError(
        typeof error['message'] === 'string' ? error['message'] : 'Responses API response failed',
        typeof error['code'] === 'string' ? error['code'] : undefined,
      );
    }
    case 'error':
      throw new ResponsesWireError(
        typeof wire['message'] === 'string' ? wire['message'] : 'Responses API stream error',
        typeof wire['code'] === 'string' ? wire['code'] : undefined,
      );
    default:
      break;
  }
}

function syncContentPart(
  wire: Record<string, unknown>,
  close: boolean,
  state: ResponsesStreamState,
  stream: ProviderEventStream,
): void {
  const part = asRecord(wire['part']);
  const type = part['type'];
  if (type === 'output_text') {
    syncText(
      textKey('output_text', stringOr(wire['item_id'], ''), numberOr(wire['content_index'], 0)),
      stringOr(part['text'], ''),
      close,
      state,
      stream,
    );
  } else if (type === 'refusal') {
    syncText(
      textKey('refusal', stringOr(wire['item_id'], ''), numberOr(wire['content_index'], 0)),
      stringOr(part['refusal'], ''),
      close,
      state,
      stream,
    );
  } else if (type === 'reasoning_text') {
    syncReasoning(
      stringOr(wire['item_id'], ''),
      'content',
      numberOr(wire['content_index'], 0),
      stringOr(part['text'], ''),
      close,
      undefined,
      state,
      stream,
    );
  }
}

function appendTextEvent(
  wire: Record<string, unknown>,
  kind: 'output_text' | 'refusal',
  state: ResponsesStreamState,
  stream: ProviderEventStream,
): void {
  const delta = wire['delta'];
  if (typeof delta !== 'string' || delta.length === 0) return;
  const key = textKey(kind, stringOr(wire['item_id'], ''), numberOr(wire['content_index'], 0));
  appendText(ensureTextSlot(key, state, stream), delta, state, stream);
}

function finishTextEvent(
  wire: Record<string, unknown>,
  kind: 'output_text' | 'refusal',
  valueField: 'text' | 'refusal',
  state: ResponsesStreamState,
  stream: ProviderEventStream,
): void {
  syncText(
    textKey(kind, stringOr(wire['item_id'], ''), numberOr(wire['content_index'], 0)),
    stringOr(wire[valueField], ''),
    true,
    state,
    stream,
  );
}

function syncText(
  key: string,
  complete: string,
  close: boolean,
  state: ResponsesStreamState,
  stream: ProviderEventStream,
): void {
  const slot = ensureTextSlot(key, state, stream);
  appendMissing(slot, complete, state, stream);
  if (close) closeBlock(slot, state, stream);
}

function ensureTextSlot(
  key: string,
  state: ResponsesStreamState,
  stream: ProviderEventStream,
): TextSlot {
  let slot = state.textSlots.get(key);
  if (slot !== undefined) return slot;
  const contentIndex = state.partial.content.length;
  const part: TextPart = { type: 'text', text: '' };
  slot = { kind: 'text', contentIndex, part, closed: false };
  state.partial.content.push(part);
  state.textSlots.set(key, slot);
  stream.push({ type: 'text_start', contentIndex, partial: state.partial });
  return slot;
}

function appendText(
  slot: TextSlot,
  delta: string,
  state: ResponsesStreamState,
  stream: ProviderEventStream,
): void {
  if (slot.closed) throw new ResponsesWireError('text delta arrived after the content block closed');
  slot.part.text += delta;
  stream.push({ type: 'text_delta', contentIndex: slot.contentIndex, delta, partial: state.partial });
}

function appendReasoningEvent(
  wire: Record<string, unknown>,
  kind: 'summary' | 'content',
  state: ResponsesStreamState,
  stream: ProviderEventStream,
): void {
  const delta = wire['delta'];
  if (typeof delta !== 'string' || delta.length === 0) return;
  const itemId = stringOr(wire['item_id'], '');
  const index = reasoningIndex(wire, kind);
  const slot = ensureReasoningSlot(itemId, kind, index, undefined, state, stream);
  appendReasoning(slot, delta, state, stream);
}

function finishReasoningEvent(
  wire: Record<string, unknown>,
  kind: 'summary' | 'content',
  state: ResponsesStreamState,
  stream: ProviderEventStream,
): void {
  syncReasoning(
    stringOr(wire['item_id'], ''),
    kind,
    reasoningIndex(wire, kind),
    stringOr(wire['text'], ''),
    true,
    undefined,
    state,
    stream,
  );
}

function syncReasoningPartEvent(
  wire: Record<string, unknown>,
  kind: 'summary' | 'content',
  close: boolean,
  state: ResponsesStreamState,
  stream: ProviderEventStream,
): void {
  const part = asRecord(wire['part']);
  syncReasoning(
    stringOr(wire['item_id'], ''),
    kind,
    reasoningIndex(wire, kind),
    stringOr(part['text'], ''),
    close,
    undefined,
    state,
    stream,
  );
}

function syncReasoning(
  itemId: string,
  kind: 'item' | 'summary' | 'content',
  index: number,
  complete: string,
  close: boolean,
  encryptedContent: string | undefined,
  state: ResponsesStreamState,
  stream: ProviderEventStream,
): void {
  const slot = ensureReasoningSlot(itemId, kind, index, encryptedContent, state, stream);
  appendMissing(slot, complete, state, stream);
  if (close) closeBlock(slot, state, stream);
}

function ensureReasoningSlot(
  itemId: string,
  kind: 'item' | 'summary' | 'content',
  index: number,
  encryptedContent: string | undefined,
  state: ResponsesStreamState,
  stream: ProviderEventStream,
): ReasoningSlot {
  const key = reasoningKey(itemId, kind, index);
  let slot = state.reasoningSlots.get(key);
  if (slot !== undefined) {
    if (encryptedContent !== undefined) {
      slot.encryptedContent = encryptedContent;
      refreshReasoningSignature(slot);
    }
    return slot;
  }
  const contentIndex = state.partial.content.length;
  const part: ReasoningPart = { type: 'reasoning', text: '' };
  slot = {
    kind: 'reasoning',
    contentIndex,
    part,
    itemId,
    reasoningKind: kind,
    wireIndex: index,
    ...(encryptedContent !== undefined && { encryptedContent }),
    closed: false,
  };
  refreshReasoningSignature(slot);
  state.partial.content.push(part);
  state.reasoningSlots.set(key, slot);
  stream.push({ type: 'reasoning_start', contentIndex, partial: state.partial });
  return slot;
}

function appendReasoning(
  slot: ReasoningSlot,
  delta: string,
  state: ResponsesStreamState,
  stream: ProviderEventStream,
): void {
  if (slot.closed) throw new ResponsesWireError('reasoning delta arrived after the content block closed');
  slot.part.text += delta;
  stream.push({ type: 'reasoning_delta', contentIndex: slot.contentIndex, delta, partial: state.partial });
}

function refreshReasoningSignature(slot: ReasoningSlot): void {
  slot.part.signature = encodeReasoningMetadata({
    itemId: slot.itemId,
    kind: slot.reasoningKind,
    index: slot.wireIndex,
    ...(slot.encryptedContent !== undefined && { encryptedContent: slot.encryptedContent }),
  });
}

function appendFunctionArguments(
  wire: Record<string, unknown>,
  state: ResponsesStreamState,
  stream: ProviderEventStream,
): void {
  const delta = wire['delta'];
  if (typeof delta !== 'string' || delta.length === 0) return;
  const slot = ensureToolSlot(
    stringOr(wire['item_id'], ''),
    numberOr(wire['output_index'], 0),
    undefined,
    undefined,
    state,
    stream,
  );
  appendToolDelta(slot, delta, state, stream);
}

function finishFunctionArguments(
  wire: Record<string, unknown>,
  state: ResponsesStreamState,
  stream: ProviderEventStream,
): void {
  const slot = ensureToolSlot(
    stringOr(wire['item_id'], ''),
    numberOr(wire['output_index'], 0),
    undefined,
    typeof wire['name'] === 'string' ? wire['name'] : undefined,
    state,
    stream,
  );
  syncToolArguments(slot, stringOr(wire['arguments'], ''), state, stream);
  closeBlock(slot, state, stream);
}

function ensureToolSlot(
  itemId: string,
  outputIndex: number,
  callId: string | undefined,
  name: string | undefined,
  state: ResponsesStreamState,
  stream: ProviderEventStream,
): ToolSlot {
  let slot = state.toolSlotsByItem.get(itemId) ?? state.toolSlotsByOutput.get(outputIndex);
  if (slot === undefined) {
    const contentIndex = state.partial.content.length;
    const part: ToolCallPart = {
      type: 'tool_call',
      id: callId ?? (itemId.length > 0 ? itemId : `call_${crypto.randomUUID()}`),
      name: name ?? '',
      arguments: {},
      rawArguments: '',
    };
    slot = { kind: 'tool_call', contentIndex, part, itemId, outputIndex, closed: false };
    state.partial.content.push(part);
    state.toolSlotsByOutput.set(outputIndex, slot);
    if (itemId.length > 0) state.toolSlotsByItem.set(itemId, slot);
    stream.push({ type: 'tool_call_start', contentIndex, partial: state.partial });
  }
  if (itemId.length > 0) {
    slot.itemId = itemId;
    state.toolSlotsByItem.set(itemId, slot);
  }
  if (callId !== undefined && callId.length > 0) slot.part.id = callId;
  if (name !== undefined && name.length > 0) slot.part.name = name;
  return slot;
}

function appendToolDelta(
  slot: ToolSlot,
  delta: string,
  state: ResponsesStreamState,
  stream: ProviderEventStream,
): void {
  if (slot.closed) throw new ResponsesWireError('function-call arguments arrived after the tool block closed');
  slot.part.rawArguments = (slot.part.rawArguments ?? '') + delta;
  slot.part.arguments = parsePartialJson(slot.part.rawArguments);
  stream.push({ type: 'tool_call_delta', contentIndex: slot.contentIndex, delta, partial: state.partial });
}

function syncToolArguments(
  slot: ToolSlot,
  complete: string,
  state: ResponsesStreamState,
  stream: ProviderEventStream,
): void {
  appendMissing(slot, complete, state, stream);
  parseToolArguments(slot.part);
}

function syncOutputItem(
  rawItem: unknown,
  outputIndex: number,
  close: boolean,
  state: ResponsesStreamState,
  stream: ProviderEventStream,
): void {
  const item = asRecord(rawItem);
  const itemType = item['type'];
  const itemId = stringOr(item['id'], `output_${outputIndex}`);
  if (itemType === 'message') {
    const content = Array.isArray(item['content']) ? item['content'] : [];
    for (let i = 0; i < content.length; i++) {
      const part = asRecord(content[i]);
      if (part['type'] === 'output_text') {
        syncText(
          textKey('output_text', itemId, i),
          stringOr(part['text'], ''),
          close,
          state,
          stream,
        );
      } else if (part['type'] === 'refusal') {
        syncText(
          textKey('refusal', itemId, i),
          stringOr(part['refusal'], ''),
          close,
          state,
          stream,
        );
      }
    }
  } else if (itemType === 'reasoning') {
    syncReasoningItem(item, itemId, close, state, stream);
  } else if (itemType === 'function_call') {
    const slot = ensureToolSlot(
      itemId,
      outputIndex,
      typeof item['call_id'] === 'string' ? item['call_id'] : undefined,
      typeof item['name'] === 'string' ? item['name'] : undefined,
      state,
      stream,
    );
    syncToolArguments(slot, stringOr(item['arguments'], ''), state, stream);
    if (close) closeBlock(slot, state, stream);
  }
}

function syncReasoningItem(
  item: Record<string, unknown>,
  itemId: string,
  close: boolean,
  state: ResponsesStreamState,
  stream: ProviderEventStream,
): void {
  const encryptedContent =
    typeof item['encrypted_content'] === 'string' ? item['encrypted_content'] : undefined;
  const summary = Array.isArray(item['summary']) ? item['summary'] : [];
  for (let i = 0; i < summary.length; i++) {
    const part = asRecord(summary[i]);
    syncReasoning(
      itemId,
      'summary',
      i,
      stringOr(part['text'], ''),
      close,
      encryptedContent,
      state,
      stream,
    );
  }
  const content = Array.isArray(item['content']) ? item['content'] : [];
  for (let i = 0; i < content.length; i++) {
    const part = asRecord(content[i]);
    syncReasoning(
      itemId,
      'content',
      i,
      stringOr(part['text'], ''),
      close,
      encryptedContent,
      state,
      stream,
    );
  }
  if (close && summary.length === 0 && content.length === 0) {
    // Reasoning 模型可只返回可 replay 的 id/encrypted_content 而没有可见 summary。
    // 用空 ReasoningPart + item-only 私有信封把该 output item 留在权威 transcript 中；
    // 否则紧随其后的 function_call_output 回合会丢掉模型要求重放的 reasoning item。
    syncReasoning(
      itemId,
      'item',
      0,
      '',
      true,
      encryptedContent,
      state,
      stream,
    );
  }
  if (encryptedContent !== undefined) {
    for (const slot of state.reasoningSlots.values()) {
      if (slot.itemId === itemId) {
        slot.encryptedContent = encryptedContent;
        refreshReasoningSignature(slot);
      }
    }
  }
}

function syncResponse(
  response: Record<string, unknown>,
  state: ResponsesStreamState,
  stream: ProviderEventStream,
): void {
  const output = Array.isArray(response['output']) ? response['output'] : [];
  for (let i = 0; i < output.length; i++) syncOutputItem(output[i], i, true, state, stream);
  applyUsage(response['usage'], state);
}

function appendMissing(
  slot: BlockSlot,
  complete: string,
  state: ResponsesStreamState,
  stream: ProviderEventStream,
): void {
  const current =
    slot.kind === 'tool_call' ? (slot.part.rawArguments ?? '') : slot.part.text;
  if (current === complete) return;
  if (!complete.startsWith(current)) {
    throw new ResponsesWireError(
      `${slot.kind} final value does not extend the streamed prefix`,
      'stream_reconciliation_error',
    );
  }
  const suffix = complete.slice(current.length);
  if (suffix.length === 0) return;
  if (slot.kind === 'text') appendText(slot, suffix, state, stream);
  else if (slot.kind === 'reasoning') appendReasoning(slot, suffix, state, stream);
  else appendToolDelta(slot, suffix, state, stream);
}

function closeBlock(
  slot: BlockSlot,
  state: ResponsesStreamState,
  stream: ProviderEventStream,
): void {
  if (slot.closed) return;
  slot.closed = true;
  if (slot.kind === 'text') {
    stream.push({
      type: 'text_end',
      contentIndex: slot.contentIndex,
      content: slot.part.text,
      partial: state.partial,
    });
  } else if (slot.kind === 'reasoning') {
    stream.push({
      type: 'reasoning_end',
      contentIndex: slot.contentIndex,
      content: slot.part.text,
      partial: state.partial,
    });
  } else {
    parseToolArguments(slot.part);
    stream.push({
      type: 'tool_call_end',
      contentIndex: slot.contentIndex,
      toolCall: slot.part,
      partial: state.partial,
    });
  }
}

function parseToolArguments(part: ToolCallPart): void {
  const raw = part.rawArguments ?? '';
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      part.arguments = parsed as Record<string, unknown>;
      return;
    }
  } catch {
    // incomplete/length 路径保留容错解析结果与 rawArguments 现场
  }
  part.arguments = parsePartialJson(raw);
}

export function closeOpenBlocks(
  state: ResponsesStreamState,
  stream: ProviderEventStream,
): void {
  const blocks: BlockSlot[] = [
    ...state.textSlots.values(),
    ...state.reasoningSlots.values(),
    ...state.toolSlotsByOutput.values(),
  ];
  blocks.sort((a, b) => a.contentIndex - b.contentIndex);
  for (const block of blocks) closeBlock(block, state, stream);
}

function finishDone(
  state: ResponsesStreamState,
  stream: ProviderEventStream,
  stopReason: AssistantMessage['stopReason'],
): void {
  closeOpenBlocks(state, stream);
  state.partial.stopReason = stopReason;
  state.terminal = true;
  stream.push({ type: 'done', message: state.partial });
  stream.end(state.partial);
}

export function finishMissingTerminal(
  state: ResponsesStreamState,
  stream: ProviderEventStream,
): void {
  closeOpenBlocks(state, stream);
  state.partial.stopReason = 'error';
  state.partial.errorMessage = 'stream ended without a terminal Responses event';
  state.partial.errorDetails = { kind: 'network', retryable: true };
  state.terminal = true;
  stream.push({ type: 'error', message: state.partial });
  stream.end(state.partial);
}

function applyUsage(raw: unknown, state: ResponsesStreamState): void {
  if (raw === null || typeof raw !== 'object') return;
  const usage = raw as Record<string, unknown>;
  const input = numberOr(usage['input_tokens'], 0);
  const output = numberOr(usage['output_tokens'], 0);
  const inputDetails = asRecord(usage['input_tokens_details']);
  const outputDetails = asRecord(usage['output_tokens_details']);
  const cacheRead = optionalNumber(inputDetails['cached_tokens']);
  const cacheWrite = optionalNumber(inputDetails['cache_write_tokens']);
  const reasoning = optionalNumber(outputDetails['reasoning_tokens']);
  const mapped: Usage = { input, output };
  if (
    cacheRead !== undefined &&
    cacheRead > 0 &&
    (cacheWrite ?? 0) + cacheRead <= input
  ) {
    mapped.cacheRead = cacheRead;
  }
  if (
    cacheWrite !== undefined &&
    cacheWrite > 0 &&
    (cacheRead ?? 0) + cacheWrite <= input
  ) {
    mapped.cacheWrite = cacheWrite;
  }
  if (reasoning !== undefined && reasoning > 0 && reasoning <= output) mapped.reasoning = reasoning;
  state.partial.usage = mapped;
}

function textKey(kind: 'output_text' | 'refusal', itemId: string, contentIndex: number): string {
  return `${kind}:${itemId}:${contentIndex}`;
}

function reasoningKey(
  itemId: string,
  kind: 'item' | 'summary' | 'content',
  index: number,
): string {
  return `${itemId}:${kind}:${index}`;
}

function reasoningIndex(wire: Record<string, unknown>, kind: 'summary' | 'content'): number {
  return numberOr(wire[kind === 'summary' ? 'summary_index' : 'content_index'], 0);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : fallback;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}
