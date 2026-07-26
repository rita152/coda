// 入站解析:chunk 累积状态机(规格见 docs/04-provider-adapter.md 第 4 节)。
// 累积算法照抄 openai-node ChatCompletionStream.ts 的 #accumulateChatCompletion:
// tool_calls 按 delta.tool_calls[].index 定位槽位、arguments 字符串拼接、name 覆盖不拼接。
// 签名不 import openai 类型(chunk 形状结构化读取)——fixture 回放测试直接喂 JSON 行。

import type { AssistantMessage, ModelRef, TextPart, ReasoningPart, ToolCallPart, Usage } from '../../protocol/index.js';
import type { ProviderEventStream } from '../../protocol/index.js';
import { parsePartialJson } from '../../shared/partial-json.js';
import type { ResolvedCompat } from './compat.js';

interface ToolSlot {
  contentIndex: number;
  part: ToolCallPart;
  closed: boolean;
}

export interface StreamState {
  partial: AssistantMessage;
  open: { kind: 'none' } | { kind: 'text' | 'reasoning'; contentIndex: number };
  toolSlots: Map<number, ToolSlot>;   // key = delta.tool_calls[].index(累积 key,不是数组位置)
  openToolIndex: number | null;       // 当前未关闭的 tool 槽位(wire index)
  finishReason: string | null;
}

export function newStreamState(ref: ModelRef): StreamState {
  return {
    partial: {
      role: 'assistant',
      id: `oa_${crypto.randomUUID()}`,
      timestamp: Date.now(),
      content: [],
      model: ref,
      stopReason: 'stop',               // 临时值,finalize/错误路径覆盖
      usage: { input: 0, output: 0 },   // usage chunk 可能不来,缺失保持 0
    },
    open: { kind: 'none' },
    toolSlots: new Map(),
    openToolIndex: null,
    finishReason: null,
  };
}

// ---------- chunk 处理 ----------

export function handleChunk(
  chunk: unknown,
  state: StreamState,
  stream: ProviderEventStream,
  compat: ResolvedCompat,
): void {
  const c = chunk as {
    choices?: {
      delta?: Record<string, unknown>;
      finish_reason?: string | null;
    }[];
    usage?: unknown;
  } | null;
  if (c === null || typeof c !== 'object') return;                  // 垃圾 chunk 容忍

  if (c.usage != null) applyUsage(c.usage, state);                  // 有的 provider 每个 chunk 都带 usage:覆盖不累加

  const choice = c.choices?.[0];
  if (!choice) return;                                              // 空 choices:usage chunk 或 keep-alive,容忍

  const delta = choice.delta ?? {};

  // reasoning 扩展字段(DeepSeek/OpenRouter/vLLM 系非标方言;SDK 类型不含,须自行读取)
  if (compat.reasoningFormat !== 'none') {
    const r = delta['reasoning_content'] ?? delta['reasoning'] ?? delta['reasoning_text'];
    if (typeof r === 'string' && r.length > 0) emitReasoningDelta(r, state, stream);
  }

  const content = delta['content'];
  if (typeof content === 'string' && content.length > 0) emitTextDelta(content, state, stream);

  // structured outputs 的拒绝路径以 delta.refusal 流出(官方累积器单独拼接):
  // 并入 text 通道,保证拒绝文本进转录(「转录永远完整」不变量)
  const refusal = delta['refusal'];
  if (typeof refusal === 'string' && refusal.length > 0) emitTextDelta(refusal, state, stream);

  const toolCalls = delta['tool_calls'];
  if (Array.isArray(toolCalls)) {
    for (const entry of toolCalls) handleToolCallDelta(entry as Record<string, unknown>, state, stream);
  }

  // deprecated 旧方言 delta.function_call:按官方累积器语义折算成单一 tool slot(伪 index -1)
  const functionCall = delta['function_call'];
  if (functionCall !== null && typeof functionCall === 'object') {
    handleToolCallDelta({ index: -1, function: functionCall }, state, stream);
  }

  if (choice.finish_reason != null) state.finishReason = choice.finish_reason;   // 不立即收尾:usage chunk 可能在其后
}

function emitTextDelta(delta: string, state: StreamState, stream: ProviderEventStream): void {
  if (state.open.kind !== 'text') {
    closeOpenBlocks(state, stream);
    const contentIndex = state.partial.content.length;
    const part: TextPart = { type: 'text', text: '' };
    state.partial.content.push(part);
    state.open = { kind: 'text', contentIndex };
    stream.push({ type: 'text_start', contentIndex, partial: state.partial });
  }
  const { contentIndex } = state.open;
  const part = state.partial.content[contentIndex] as TextPart;
  part.text += delta;
  stream.push({ type: 'text_delta', contentIndex, delta, partial: state.partial });
}

function emitReasoningDelta(delta: string, state: StreamState, stream: ProviderEventStream): void {
  if (state.open.kind !== 'reasoning') {
    closeOpenBlocks(state, stream);
    const contentIndex = state.partial.content.length;
    const part: ReasoningPart = { type: 'reasoning', text: '' };
    state.partial.content.push(part);
    state.open = { kind: 'reasoning', contentIndex };
    stream.push({ type: 'reasoning_start', contentIndex, partial: state.partial });
  }
  const { contentIndex } = state.open;
  const part = state.partial.content[contentIndex] as ReasoningPart;
  part.text += delta;
  stream.push({ type: 'reasoning_delta', contentIndex, delta, partial: state.partial });
}

function handleToolCallDelta(
  entry: Record<string, unknown>,
  state: StreamState,
  stream: ProviderEventStream,
): void {
  const fn = entry['function'] as Record<string, unknown> | undefined;
  const index = typeof entry['index'] === 'number' ? entry['index'] : 0;   // index 缺失回退 0(部分第三方从不给)

  let slot = state.toolSlots.get(index);
  if (!slot) {
    closeOpenBlocks(state, stream);                                        // 关闭 text/reasoning 与上一个 tool 槽位
    const id =
      typeof entry['id'] === 'string' && entry['id'].length > 0
        ? entry['id']
        : `call_${crypto.randomUUID()}`;                                   // id 缺失兜底(否则回传配对断裂 400)
    const contentIndex = state.partial.content.length;
    const part: ToolCallPart = {
      type: 'tool_call',
      id,
      name: typeof fn?.['name'] === 'string' ? (fn['name'] as string) : '',
      arguments: {},
      rawArguments: '',
    };
    state.partial.content.push(part);
    slot = { contentIndex, part, closed: false };
    state.toolSlots.set(index, slot);
    state.openToolIndex = index;
    stream.push({ type: 'tool_call_start', contentIndex, partial: state.partial });
  }

  if (typeof entry['id'] === 'string' && entry['id'].length > 0) slot.part.id = entry['id'];
  if (typeof fn?.['name'] === 'string' && (fn['name'] as string).length > 0) {
    slot.part.name = fn['name'] as string;                                 // 覆盖,不拼接
  }
  const args = fn?.['arguments'];
  if (typeof args === 'string' && args.length > 0) {
    if (slot.closed) {
      // 已关闭槽位的迟到分片(交错 index 方言):并入 raw 并同步刷新 arguments,
      // 不再发事件(块已 end);finalize 会对全部槽位做最终解析,保证 arguments == parse(raw)
      slot.part.rawArguments = (slot.part.rawArguments ?? '') + args;
      slot.part.arguments = parsePartialJson(slot.part.rawArguments);
      return;
    }
    slot.part.rawArguments = (slot.part.rawArguments ?? '') + args;        // 任意切割的 JSON 分片:拼接
    slot.part.arguments = parsePartialJson(slot.part.rawArguments);        // 容错解析持续刷新(UI 实时预览)
    stream.push({ type: 'tool_call_delta', contentIndex: slot.contentIndex, delta: args, partial: state.partial });
  }
}

/** 关闭当前打开的 text/reasoning 块与未关闭的 tool 槽位(通道切换/新 index/收尾时调用)。 */
export function closeOpenBlocks(state: StreamState, stream: ProviderEventStream): void {
  if (state.open.kind === 'text' || state.open.kind === 'reasoning') {
    const { kind, contentIndex } = state.open;
    const part = state.partial.content[contentIndex] as TextPart | ReasoningPart;
    stream.push(
      kind === 'text'
        ? { type: 'text_end', contentIndex, content: part.text, partial: state.partial }
        : { type: 'reasoning_end', contentIndex, content: part.text, partial: state.partial },
    );
    state.open = { kind: 'none' };
  }
  if (state.openToolIndex !== null) {
    const slot = state.toolSlots.get(state.openToolIndex);
    state.openToolIndex = null;
    if (slot && !slot.closed) closeToolSlot(slot, state, stream);
  }
}

function closeToolSlot(slot: ToolSlot, state: StreamState, stream: ProviderEventStream): void {
  slot.closed = true;
  const raw = slot.part.rawArguments ?? '';
  try {
    const parsed: unknown = JSON.parse(raw);                               // 最终解析
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      slot.part.arguments = parsed as Record<string, unknown>;
    }
  } catch {
    // 非法 JSON(length 截断等):保留容错解析结果,rawArguments 留现场;是否执行由 loop 层依 stopReason 决定
    slot.part.arguments = parsePartialJson(raw);
  }
  stream.push({ type: 'tool_call_end', contentIndex: slot.contentIndex, toolCall: slot.part, partial: state.partial });
}

// ---------- usage 与收尾 ----------

function applyUsage(usage: unknown, state: StreamState): void {
  const u = usage as Record<string, unknown>;
  if (typeof u !== 'object' || u === null) return;
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  const promptDetails = u['prompt_tokens_details'] as Record<string, unknown> | undefined;
  const completionDetails = u['completion_tokens_details'] as Record<string, unknown> | undefined;
  // 内部 Usage 是 inclusive 口径:prompt_tokens 已含 cached,直接用(pi 做 exclusive 减法,勿抄)
  const mapped: Usage = {
    input: num(u['prompt_tokens']) ?? 0,
    output: num(u['completion_tokens']) ?? 0,
  };
  const cacheRead = num(promptDetails?.['cached_tokens']);
  const cacheWrite = num(promptDetails?.['cache_write_tokens']);   // 非标扩展,可缺失
  const reasoning = num(completionDetails?.['reasoning_tokens']);
  // 协议不变量在 adapter 出口恒成立(03 §3.1):违反口径的明细字段丢弃,不污染下游
  if (cacheRead !== undefined && cacheWrite !== undefined && cacheRead + cacheWrite <= mapped.input) {
    mapped.cacheRead = cacheRead;
    mapped.cacheWrite = cacheWrite;
  } else if (cacheRead !== undefined && cacheRead <= mapped.input && cacheWrite === undefined) {
    mapped.cacheRead = cacheRead;
  } else if (cacheWrite !== undefined && cacheWrite <= mapped.input && cacheRead === undefined) {
    mapped.cacheWrite = cacheWrite;
  }
  if (reasoning !== undefined && reasoning <= mapped.output) mapped.reasoning = reasoning;
  state.partial.usage = mapped;                                    // 覆盖,不累加(最后一次为准)
}

const FINISH_REASON_MAP: Record<string, AssistantMessage['stopReason']> = {
  stop: 'stop',
  tool_calls: 'tool_calls',
  length: 'length',
  content_filter: 'content_filter',
  function_call: 'tool_calls',        // deprecated 旧方言
};

/**
 * 流正常结束的收尾:flush 未闭合块、映射 finish_reason、push done(或 finish_reason
 * 缺失时按协议以 error 收尾)。错误路径不走这里(见 errors.ts)。
 */
export function finalize(state: StreamState, stream: ProviderEventStream): void {
  closeOpenBlocks(state, stream);
  if (state.finishReason === null) {
    // 流结束仍无 finish_reason:残缺流,按 error 编码(pi 同款);网络类,可重试
    state.partial.stopReason = 'error';
    state.partial.errorMessage = 'stream ended without finish_reason';
    state.partial.errorDetails = { kind: 'network', retryable: true };
    stream.push({ type: 'error', message: state.partial });
    stream.end(state.partial);
    return;
  }
  // 全部槽位最终解析:交错 index 的迟到分片可能在块 end 之后补齐 raw,
  // 这里保证最终消息恒满足 arguments == parse(rawArguments)(可解析时)
  for (const slot of state.toolSlots.values()) {
    const raw = slot.part.rawArguments ?? '';
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        slot.part.arguments = parsed as Record<string, unknown>;
      }
    } catch {
      // 非法 JSON(length 截断等):保留容错解析结果
    }
  }
  const mapped = FINISH_REASON_MAP[state.finishReason];
  if (mapped === undefined) {
    // 未知方言值:保守当作 stop,但留下现场(规格 04 §4.4)
    console.warn(`[openai-chat] unknown finish_reason '${state.finishReason}', treating as 'stop'`);
  }
  state.partial.stopReason = mapped ?? 'stop';
  stream.push({ type: 'done', message: state.partial });
  stream.end(state.partial);
}
