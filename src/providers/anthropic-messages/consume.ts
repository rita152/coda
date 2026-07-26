// 入站解析:Anthropic Messages 流事件状态机(规格见 docs/04-provider-adapter.md §7、§8)。
// Messages 的 content_block_start/delta/stop 天然对应内部协议三段式,不需按 index 归并 arguments
// (input_json_delta 自带块定位)。手写 for-await 消费(理由见 docs/04 §7)。
// 签名不 import @anthropic-ai/sdk 类型:事件形状结构化读取,fixture 回放测试直接喂 JSON 行。

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

interface BlockState {
  kind: 'text' | 'reasoning' | 'tool_call';
  contentIndex: number;
  part: TextPart | ReasoningPart | ToolCallPart;
  closed: boolean;
}

// usage 累加器:分量各自 last-wins,input 恒由分量重算(inclusive 口径,docs/03 §3.2)。
interface UsageAcc {
  inputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  thinking: number;
}

export interface StreamState {
  partial: AssistantMessage;
  blocks: Map<number, BlockState>;   // Anthropic 的 wire index → 块状态(我方 contentIndex 另行递增)
  stopReason: string | null;
  usage: UsageAcc;
}

export function newStreamState(ref: ModelRef): StreamState {
  return {
    partial: {
      role: 'assistant',
      id: `an_${crypto.randomUUID()}`,
      timestamp: Date.now(),
      content: [],
      model: ref,
      stopReason: 'stop',               // 临时值,finalize/错误路径覆盖
      usage: { input: 0, output: 0 },   // usage 事件可能不全,缺失保持 0
    },
    blocks: new Map(),
    stopReason: null,
    usage: { inputTokens: 0, cacheRead: 0, cacheWrite: 0, output: 0, thinking: 0 },
  };
}

// ---------- 事件处理 ----------

export function handleEvent(event: unknown, state: StreamState, stream: ProviderEventStream): void {
  if (event === null || typeof event !== 'object') return;   // 垃圾事件容忍
  const e = event as Record<string, unknown>;
  switch (e['type']) {
    case 'message_start': {
      const message = e['message'] as Record<string, unknown> | undefined;
      applyUsage(message?.['usage'], state);                 // 初始 usage(input 侧确定,output 为部分值)
      break;
    }
    case 'content_block_start':
      openBlock(e, state, stream);
      break;
    case 'content_block_delta':
      blockDelta(e, state, stream);
      break;
    case 'content_block_stop': {
      const idx = numberOr(e['index'], -1);
      const block = state.blocks.get(idx);
      if (block && !block.closed) closeBlock(block, state, stream);
      break;
    }
    case 'message_delta': {
      const delta = e['delta'] as Record<string, unknown> | undefined;
      const sr = delta?.['stop_reason'];
      if (typeof sr === 'string') state.stopReason = sr;
      applyUsage(e['usage'], state);                         // 最终 usage(output 侧确定)
      break;
    }
    case 'message_stop':
      // 终结标记:实际收尾在 finalize(与 openai-chat 对齐,统一 abort 处理路径)
      break;
    default:
      break;                                                 // 未知事件(ping/非标扩展)静默忽略
  }
}

function openBlock(e: Record<string, unknown>, state: StreamState, stream: ProviderEventStream): void {
  const idx = numberOr(e['index'], state.blocks.size);
  const cb = (e['content_block'] as Record<string, unknown> | undefined) ?? {};
  const contentIndex = state.partial.content.length;         // 我方递增序 = content 数组下标(append-only)
  const type = cb['type'];

  if (type === 'text') {
    const part: TextPart = { type: 'text', text: '' };
    state.partial.content.push(part);
    state.blocks.set(idx, { kind: 'text', contentIndex, part, closed: false });
    stream.push({ type: 'text_start', contentIndex, partial: state.partial });
  } else if (type === 'thinking') {
    const part: ReasoningPart = { type: 'reasoning', text: '' };
    const sig = cb['signature'];
    if (typeof sig === 'string' && sig.length > 0) part.signature = sig;   // start 可能已带签名
    const initial = cb['thinking'];
    if (typeof initial === 'string' && initial.length > 0) part.text = initial;
    state.partial.content.push(part);
    state.blocks.set(idx, { kind: 'reasoning', contentIndex, part, closed: false });
    stream.push({ type: 'reasoning_start', contentIndex, partial: state.partial });
  } else if (type === 'tool_use') {
    const id = typeof cb['id'] === 'string' && cb['id'].length > 0 ? cb['id'] : `toolu_${crypto.randomUUID()}`;
    const part: ToolCallPart = {
      type: 'tool_call',
      id,
      name: typeof cb['name'] === 'string' ? (cb['name'] as string) : '',
      arguments: {},
      rawArguments: '',
    };
    state.partial.content.push(part);
    state.blocks.set(idx, { kind: 'tool_call', contentIndex, part, closed: false });
    stream.push({ type: 'tool_call_start', contentIndex, partial: state.partial });
  }
  // 其它块类型(redacted_thinking / server_tool_use 等)当前不建模:不入 content,后续 delta/stop 因
  // blocks 无该 index 而被忽略——转录里不出现未知块,符合协议演进的 tolerant reader 纪律。
}

function blockDelta(e: Record<string, unknown>, state: StreamState, stream: ProviderEventStream): void {
  const idx = numberOr(e['index'], -1);
  const block = state.blocks.get(idx);
  if (!block || block.closed) return;
  const delta = (e['delta'] as Record<string, unknown> | undefined) ?? {};
  const dType = delta['type'];

  if (dType === 'text_delta' && block.kind === 'text') {
    const text = delta['text'];
    if (typeof text === 'string' && text.length > 0) {
      (block.part as TextPart).text += text;
      stream.push({ type: 'text_delta', contentIndex: block.contentIndex, delta: text, partial: state.partial });
    }
  } else if (dType === 'thinking_delta' && block.kind === 'reasoning') {
    const text = delta['thinking'];
    if (typeof text === 'string' && text.length > 0) {
      (block.part as ReasoningPart).text += text;
      stream.push({ type: 'reasoning_delta', contentIndex: block.contentIndex, delta: text, partial: state.partial });
    }
  } else if (dType === 'signature_delta' && block.kind === 'reasoning') {
    // signature 是块级元数据,非文本内容:并入 ReasoningPart.signature,不发 delta 事件
    const sig = delta['signature'];
    if (typeof sig === 'string' && sig.length > 0) {
      const part = block.part as ReasoningPart;
      part.signature = (part.signature ?? '') + sig;
    }
  } else if (dType === 'input_json_delta' && block.kind === 'tool_call') {
    const frag = delta['partial_json'];
    if (typeof frag === 'string' && frag.length > 0) {
      const part = block.part as ToolCallPart;
      part.rawArguments = (part.rawArguments ?? '') + frag;
      part.arguments = parsePartialJson(part.rawArguments);   // 容错解析持续刷新(UI 实时预览)
      stream.push({ type: 'tool_call_delta', contentIndex: block.contentIndex, delta: frag, partial: state.partial });
    }
  }
}

function closeBlock(block: BlockState, state: StreamState, stream: ProviderEventStream): void {
  block.closed = true;
  if (block.kind === 'text') {
    stream.push({ type: 'text_end', contentIndex: block.contentIndex, content: (block.part as TextPart).text, partial: state.partial });
  } else if (block.kind === 'reasoning') {
    stream.push({ type: 'reasoning_end', contentIndex: block.contentIndex, content: (block.part as ReasoningPart).text, partial: state.partial });
  } else {
    finalizeToolArguments(block.part as ToolCallPart);
    stream.push({ type: 'tool_call_end', contentIndex: block.contentIndex, toolCall: block.part as ToolCallPart, partial: state.partial });
  }
}

/** 最终解析:可解析为对象时以严格 JSON.parse 为准,否则保留容错解析结果(length 截断等)。 */
function finalizeToolArguments(part: ToolCallPart): void {
  const raw = part.rawArguments ?? '';
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      part.arguments = parsed as Record<string, unknown>;
      return;
    }
  } catch {
    // 非法/截断 JSON:保留容错解析结果,rawArguments 留现场
  }
  part.arguments = parsePartialJson(raw);
}

// ---------- usage 与收尾 ----------

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' ? v : fallback;
}

/**
 * usage 换算(docs/03 §3.2,M7 重点:Anthropic exclusive → 内部 inclusive):
 *   input = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
 *   output = output_tokens;cacheRead/cacheWrite/reasoning 为信息性拆分
 * 非标扩展字段(inference_geo/iterations/service_tier/嵌套 cache_creation)一律容忍忽略。
 * 分量 last-wins:message_start 定 input 侧,message_delta 定 output 侧,合并后重算 partial.usage。
 */
function applyUsage(raw: unknown, state: StreamState): void {
  if (raw === null || typeof raw !== 'object') return;
  const u = raw as Record<string, unknown>;
  const acc = state.usage;
  if (typeof u['input_tokens'] === 'number') acc.inputTokens = u['input_tokens'];
  if (typeof u['cache_read_input_tokens'] === 'number') acc.cacheRead = u['cache_read_input_tokens'];
  if (typeof u['cache_creation_input_tokens'] === 'number') acc.cacheWrite = u['cache_creation_input_tokens'];
  if (typeof u['output_tokens'] === 'number') acc.output = u['output_tokens'];
  const details = u['output_tokens_details'] as Record<string, unknown> | undefined;
  if (details && typeof details['thinking_tokens'] === 'number') acc.thinking = details['thinking_tokens'];

  const usage: Usage = { input: acc.inputTokens + acc.cacheRead + acc.cacheWrite, output: acc.output };
  if (acc.cacheRead > 0) usage.cacheRead = acc.cacheRead;         // 0 视为缺省,不落噪声字段
  if (acc.cacheWrite > 0) usage.cacheWrite = acc.cacheWrite;
  if (acc.thinking > 0 && acc.thinking <= usage.output) usage.reasoning = acc.thinking;
  state.partial.usage = usage;
}

// stop_reason 映射(docs/04 §8 列 end_turn/max_tokens/tool_use/refusal;stop_sequence/pause_turn
// 是 adapter 补充)。pause_turn 是服务端工具(web_search 等)对未完成 turn 的中断,本该由「重发
// 部分 assistant 续跑」处理;coda v1 只接客户端工具,pause_turn 实际不可达,故当作干净 stop 收尾
// (无 tool_calls 的 stop → loop 走 agent_end completed,不做续跑——这是有意的近似,非「loop 层
// 可继续」)。若将来接服务端工具,需为 pause_turn 引入区分表示以支持续跑。
const STOP_REASON_MAP: Record<string, AssistantMessage['stopReason']> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  pause_turn: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  refusal: 'content_filter',
};

/**
 * 流正常结束的收尾:flush 未闭合块、映射 stop_reason、push done(或 stop_reason 缺失时按 error 收尾)。
 * 错误路径不走这里(见 errors.ts)。
 */
export function finalize(state: StreamState, stream: ProviderEventStream): void {
  closeOpenBlocks(state, stream);
  if (state.stopReason === null) {
    // 流结束仍无 stop_reason:残缺流,按 error 编码;网络类,可重试
    state.partial.stopReason = 'error';
    state.partial.errorMessage = 'stream ended without stop_reason';
    state.partial.errorDetails = { kind: 'network', retryable: true };
    stream.push({ type: 'error', message: state.partial });
    stream.end(state.partial);
    return;
  }
  const mapped = STOP_REASON_MAP[state.stopReason];
  if (mapped === undefined) {
    console.warn(`[anthropic-messages] unknown stop_reason '${state.stopReason}', treating as 'stop'`);
  }
  state.partial.stopReason = mapped ?? 'stop';
  stream.push({ type: 'done', message: state.partial });
  stream.end(state.partial);
}

/** 关闭全部未闭合块(收尾/错误路径调用)。 */
export function closeOpenBlocks(state: StreamState, stream: ProviderEventStream): void {
  for (const block of state.blocks.values()) {
    if (!block.closed) closeBlock(block, state, stream);
  }
}
