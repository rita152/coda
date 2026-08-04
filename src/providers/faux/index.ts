// faux provider:脚本化回放 ProviderEvent 的正式 provider(规格见 docs/10-testing.md 第 3 节)。
// 行为语义:
// - 第 n 次调用消费 turns[n];调用参数深拷贝进 calls,供测试断言出站转录。
// - 事件发射逐个让出微任务(不用计时器,除 gate 外零时间依赖——确定性的根基)。
// - 严格遵守事件文法;每个事件带同一个逐步生长的 partial 快照。
// - 铁律同守:一旦被调用绝不 throw/reject;abort 在每个发射间隙与 gate 等待中检查。

import type {
  AssistantMessage,
  Context,
  ModelConfig,
  ProviderErrorDetails,
  StreamFn,
  StreamOptions,
  TextPart,
  ReasoningPart,
  ToolCallPart,
  Usage,
} from '../../protocol/index.js';
import { ProviderEventStream } from '../../protocol/index.js';
import { parsePartialJson } from '../../shared/partial-json.js';
import type { FauxCall, FauxEventSpec, FauxScript, FauxTurn, Gate } from './types.js';

export { createGate } from './types.js';
export type { FauxCall, FauxEventSpec, FauxScript, FauxTurn, Gate } from './types.js';

const DEFAULT_CHUNK_SIZE = 8;

export function createFauxStreamFn(script: FauxScript): StreamFn & { readonly calls: FauxCall[] } {
  const calls: FauxCall[] = [];
  let callIndex = 0;

  const streamFn: StreamFn = (model, context, options) => {
    const n = callIndex++;
    calls.push(copyCall(model, context, options));

    const stream = new ProviderEventStream();
    const partial = makeEmptyAssistant(model, n);
    stream.push({ type: 'start', partial });

    const turn = script.turns[n];
    void (async () => {
      try {
        if (turn === undefined) {
          runExhausted(stream, partial, script, n);
          return;
        }
        try {
          turn.onRequest?.(model, context, options);
        } catch (err) {
          reportFailure(script, err);   // 断言失败上报到测试层,不被流内 error 吞没
          finishError(stream, partial, 'error', `[faux] onRequest hook threw: ${String(err)}`, {
            kind: 'unknown',
            retryable: false,
          });
          return;
        }
        const aborted = await emitEvents(stream, partial, turn.events ?? [], n, options?.signal);
        if (aborted) {
          finishError(stream, partial, 'aborted', '[faux] aborted by signal', {
            kind: 'aborted',
            retryable: false,
          }, turn.usage);
          return;
        }
        if (turn.error) {
          finishError(stream, partial, 'error', turn.error.message, turn.error.details, turn.usage);
          return;
        }
        finishDone(stream, partial, turn);
      } catch (err) {
        // faux 自身的 bug 也不许越过铁律外泄。
        finishError(stream, partial, 'error', `[faux] internal error: ${String(err)}`, {
          kind: 'unknown',
          retryable: false,
        });
      }
    })();

    return stream;
  };

  return Object.assign(streamFn, { calls }) as StreamFn & { readonly calls: FauxCall[] };
}

// ---------- 事件发射 ----------

/** 逐 spec 发射内容块;每个发射间隙让出微任务并检查 abort。返回 true 表示已 abort。 */
async function emitEvents(
  stream: ProviderEventStream,
  partial: AssistantMessage,
  events: FauxEventSpec[],
  callIndex: number,
  signal?: AbortSignal,
): Promise<boolean> {
  for (const spec of events) {
    if (await yieldAndCheckAbort(signal)) return true;
    switch (spec.kind) {
      case 'text':
      case 'reasoning': {
        if (await emitTextual(stream, partial, spec, signal)) return true;
        break;
      }
      case 'tool_call': {
        if (await emitToolCall(stream, partial, spec, callIndex, signal)) return true;
        break;
      }
      case 'gate': {
        if (await waitGate(spec.gate, signal)) return true;
        break;
      }
    }
  }
  return false;
}

async function emitTextual(
  stream: ProviderEventStream,
  partial: AssistantMessage,
  spec: { kind: 'text' | 'reasoning'; text: string; chunkSize?: number },
  signal?: AbortSignal,
): Promise<boolean> {
  const contentIndex = partial.content.length;
  const part: TextPart | ReasoningPart =
    spec.kind === 'text' ? { type: 'text', text: '' } : { type: 'reasoning', text: '' };
  partial.content.push(part);
  stream.push(
    spec.kind === 'text'
      ? { type: 'text_start', contentIndex, partial }
      : { type: 'reasoning_start', contentIndex, partial },
  );

  for (const chunk of splitChunks(spec.text, spec.chunkSize ?? DEFAULT_CHUNK_SIZE)) {
    if (await yieldAndCheckAbort(signal)) return true;
    part.text += chunk;
    stream.push(
      spec.kind === 'text'
        ? { type: 'text_delta', contentIndex, delta: chunk, partial }
        : { type: 'reasoning_delta', contentIndex, delta: chunk, partial },
    );
  }

  if (await yieldAndCheckAbort(signal)) return true;
  stream.push(
    spec.kind === 'text'
      ? { type: 'text_end', contentIndex, content: part.text, partial }
      : { type: 'reasoning_end', contentIndex, content: part.text, partial },
  );
  return false;
}

async function emitToolCall(
  stream: ProviderEventStream,
  partial: AssistantMessage,
  spec: { kind: 'tool_call'; name: string; args: Record<string, unknown>; id?: string; truncatedRaw?: string },
  callIndex: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const contentIndex = partial.content.length;
  const raw = spec.truncatedRaw ?? JSON.stringify(spec.args);
  const id = spec.id ?? `call_faux_${callIndex}_${contentIndex}`;   // 掺入调用序号,跨 turn 不冲突
  const part: ToolCallPart = { type: 'tool_call', id, name: spec.name, arguments: {}, rawArguments: '' };
  partial.content.push(part);
  stream.push({ type: 'tool_call_start', contentIndex, partial });

  for (const chunk of splitChunks(raw, DEFAULT_CHUNK_SIZE)) {
    if (await yieldAndCheckAbort(signal)) return true;
    part.rawArguments = (part.rawArguments ?? '') + chunk;
    part.arguments = parsePartialJson(part.rawArguments);   // 容错解析持续刷新,与真 adapter 一致
    stream.push({ type: 'tool_call_delta', contentIndex, delta: chunk, partial });
  }

  if (await yieldAndCheckAbort(signal)) return true;
  part.arguments = parsePartialJson(raw);   // 统一由 rawArguments 派生:解除脚本对象引用,保证 arguments == parse(raw)
  stream.push({ type: 'tool_call_end', contentIndex, toolCall: part, partial });
  return false;
}

// ---------- 收尾 ----------

function finishDone(stream: ProviderEventStream, partial: AssistantMessage, turn: FauxTurn): void {
  const hasToolCall = (turn.events ?? []).some((e) => e.kind === 'tool_call');
  partial.stopReason = turn.stopReason ?? (hasToolCall ? 'tool_calls' : 'stop');
  partial.usage = mergeUsage(turn.usage);
  stream.push({ type: 'done', message: partial });
  stream.end(partial);
}

function finishError(
  stream: ProviderEventStream,
  partial: AssistantMessage,
  stopReason: 'error' | 'aborted',
  message: string,
  details?: ProviderErrorDetails,
  usage?: Partial<Usage>,
): void {
  if (usage) partial.usage = mergeUsage(usage);   // 仅当剧本显式给出 usage 时套用
  partial.stopReason = stopReason;
  partial.errorMessage = message;
  if (details) partial.errorDetails = details;
  stream.push({ type: 'error', message: partial });
  stream.end(partial);
}

function runExhausted(
  stream: ProviderEventStream,
  partial: AssistantMessage,
  script: FauxScript,
  n: number,
): void {
  if ((script.onExhausted ?? 'throw') === 'emptyStop') {
    partial.stopReason = 'stop';
    partial.usage = mergeUsage(undefined);
    stream.push({ type: 'done', message: partial });
    stream.end(partial);
    return;
  }
  // 'throw':脚本耗尽即测试 bug。铁律禁止 StreamFn 抛异常,所以在断言层面让测试
  // 失败:微任务里抛出未捕获异常(bun:test 会将其归因到当前测试),流本身仍以
  // 协议合法的 error 事件收尾。
  const message = `[faux] script exhausted: unexpected call #${n + 1} (script has ${script.turns.length} turn(s))`;
  reportFailure(script, new Error(message));
  finishError(stream, partial, 'error', message, { kind: 'unknown', retryable: false });
}

// ---------- 辅助 ----------

function makeEmptyAssistant(model: ModelConfig, n: number): AssistantMessage {
  return {
    role: 'assistant',
    id: `faux_a${n}`,
    timestamp: Date.now(),
    content: [],
    model: model.ref,
    stopReason: 'stop',                 // 临时值,收尾时被 finishDone/finishError 覆盖
    usage: { input: 0, output: 0 },
  };
}

function mergeUsage(overrides: Partial<Usage> | undefined): Usage {
  const usage: Usage = {
    input: overrides?.input ?? 100,
    output: overrides?.output ?? 10,
  };
  if (overrides?.cacheRead !== undefined) usage.cacheRead = overrides.cacheRead;
  if (overrides?.cacheWrite !== undefined) usage.cacheWrite = overrides.cacheWrite;
  if (overrides?.reasoning !== undefined) usage.reasoning = overrides.reasoning;
  if (overrides?.costUSD !== undefined) usage.costUSD = overrides.costUSD;
  return usage;
}

function splitChunks(text: string, size: number): string[] {
  if (text.length === 0) return [];
  const step = Math.max(1, Math.floor(size));   // 非法 chunkSize 防同步死循环
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += step) {
    chunks.push(text.slice(i, i + step));
  }
  return chunks;
}

/** 让出一个微任务并检查 abort——保证消费端观察到真实的流式顺序,且 abort 及时生效。 */
async function yieldAndCheckAbort(signal?: AbortSignal): Promise<boolean> {
  await Promise.resolve();
  return signal?.aborted ?? false;
}

/** gate 等待中同时监听 abort;返回 true 表示因 abort 而结束等待。 */
function waitGate(gate: Gate, signal?: AbortSignal): Promise<boolean> {
  if (!signal) return gate.opened.then(() => false);
  if (signal.aborted) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const onAbort = (): void => resolve(true);
    signal.addEventListener('abort', onAbort, { once: true });
    void gate.opened.then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(false);
    });
  });
}

function copyCall(model: ModelConfig, context: Context, options?: StreamOptions): FauxCall {
  const call: FauxCall = {
    model: safeClone(model),
    context: safeClone(context),
  };
  if (options) {
    const rest = { ...options };
    delete rest.signal;               // AbortSignal 不可克隆,留档时剥离
    call.options = safeClone(rest);
  }
  return call;
}

/**
 * 容错深拷贝(铁律配套):Context 可能携带不可克隆值(如 ToolResultMessage.details
 * 里的函数/类实例),structuredClone 会 throw——那会让 streamFn 同步抛异常,打破
 * StreamFn 铁律。降级链:structuredClone → JSON round-trip(不可序列化值换占位符)
 * → 原引用(最终兜底,任何路径都不 throw)。
 */
function safeClone<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    // fallthrough
  }
  try {
    return JSON.parse(
      JSON.stringify(value, (_key, v: unknown) => {
        const t = typeof v;
        if (t === 'function' || t === 'symbol') return `[non-cloneable ${t}]`;
        if (t === 'bigint') return String(v);
        return v;
      }),
    ) as T;
  } catch {
    return value;                     // 循环引用等极端情况:保留原引用,仍不 throw
  }
}

/** 断言层失败上报:缺省 queueMicrotask 抛未捕获异常(bun:test 归因当前测试);可经 failFn 注入拦截。 */
function reportFailure(script: FauxScript, err: unknown): void {
  const error = err instanceof Error ? err : new Error(String(err));
  if (script.failFn) {
    script.failFn(error);
    return;
  }
  queueMicrotask(() => {
    throw error;
  });
}
