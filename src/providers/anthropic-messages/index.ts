// Anthropic Messages adapter(M7,规格见 docs/04-provider-adapter.md §8)。
// src/ 内唯一允许 import "@anthropic-ai/sdk" 的目录(ESLint 规则 B')。
// 对外只导出 streamAnthropicMessages。铁律:一旦被调用绝不 throw、绝不 reject;
// 一切错误(网络/4xx/5xx/abort/SSE 中断/setup 异常)编码为流内 error 事件。

import Anthropic from '@anthropic-ai/sdk';
import type { ModelConfig, ModelRef, StreamFn } from '../../protocol/index.js';
import { ProviderEventStream } from '../../protocol/index.js';
import { resolveCompat, type ResolvedAnthropicCompat } from './compat.js';
import { buildParams } from './convert.js';
import { finalize, handleEvent, newStreamState } from './consume.js';
import { pushErrorEvent } from './errors.js';

export { detectCompat, resolveCompat } from './compat.js';
export type { AnthropicCompatFlags, ResolvedAnthropicCompat } from './compat.js';
export { convertMessages, buildParams } from './convert.js';
export { consumeAnthropicStreamForTest, runAnthropicStream };

export const streamAnthropicMessages: StreamFn = (model, context, options) => {
  const compat = resolveCompat(model);
  return runAnthropicStream(model.ref, options?.signal, async () => {
    const client = getClient(model);
    const params = buildParams(model, context, options, compat);
    return client.messages.create(params, { signal: options?.signal });
  });
};

/**
 * 消费管线本体(测试注入点):push start → eventsFactory → 逐事件状态机 → finalize;
 * 任何异常(含 factory reject、SSE in-band error、abort)统一走 pushErrorEvent。
 * fixture 回放与真实 SDK 走完全相同的路径。
 */
function runAnthropicStream(
  ref: ModelRef,
  signal: AbortSignal | undefined,
  eventsFactory: () => Promise<AsyncIterable<unknown>>,
): ProviderEventStream {
  const stream = new ProviderEventStream();
  const state = newStreamState(ref);
  stream.push({ type: 'start', partial: state.partial });
  void (async () => {
    try {
      const events = await eventsFactory();
      for await (const event of events) {
        handleEvent(event, state, stream);
      }
      // 中途 abort 时 SDK 的 SSE 迭代器可能捕获 AbortError 后 clean return(不 throw):
      // for-await 正常结束 + signal 已 abort + 无 stop_reason ⇒ 是中途打断,必须编码为
      // aborted 而非「残缺流」——否则用户的 Esc 会被 session 层当可重试网络错误(docs/04 §4.6)。
      if (signal?.aborted && !state.stopReason) {
        pushErrorEvent(new Anthropic.APIUserAbortError(), state, stream, signal);
        return;
      }
      finalize(state, stream);
    } catch (err) {
      pushErrorEvent(err, state, stream, signal);
    }
  })();
  return stream;
}

/** 供 fixture 回放测试直接消费事件序列(与生产路径同一管线,仅事件来源不同)。 */
function consumeAnthropicStreamForTest(
  ref: ModelRef,
  _compat: ResolvedAnthropicCompat,
  events: () => Promise<AsyncIterable<unknown>>,
  signal?: AbortSignal,
): ProviderEventStream {
  // compat 参数保留在签名上与 openai-chat 对齐(入站解析当前不依赖 compat;方言差异全在出站)。
  return runAnthropicStream(ref, signal, events);
}

// SDK client 按 (baseURL, apiKey, headers) 惰性构造并缓存。maxRetries 保留 SDK 默认;
// 整轮重发策略在 session 层——SSE 流中途断开 SDK 不会续传。
const clientCache = new Map<string, Anthropic>();

function getClient(model: ModelConfig): Anthropic {
  const baseURL = anthropicSdkBaseURL(model.baseURL);
  const key = JSON.stringify([
    baseURL ?? null,
    model.apiKey ?? null,
    Object.entries(model.headers ?? {}).sort(),
  ]);
  let client = clientCache.get(key);
  if (!client) {
    client = new Anthropic({
      baseURL,
      apiKey: model.apiKey ?? 'missing-api-key',   // 本地/网关端点也要占位值,SDK 缺 key 直接 throw
      ...(model.headers && { defaultHeaders: model.headers }),
    });
    clientCache.set(key, client);
  }
  return client;
}

/**
 * Coda 的 provider base URL 与 OpenAI 风格一致，指向版本根（通常以 /v1
 * 结尾）；Anthropic SDK 自己会追加 /v1/messages，故只在该精确尾段存在时剥离。
 * 这让 OpenCode Go 的固定 .../v1 根可由两种 adapter 共用而不产生 /v1/v1。
 */
export function anthropicSdkBaseURL(baseURL: string | undefined): string | undefined {
  return baseURL?.replace(/\/v1\/?$/u, '');
}
