// Chat Completions adapter(规格见 docs/04-provider-adapter.md)。
// src/ 内唯一允许 import "openai" 的目录(scripts/record-fixture.ts 有显式豁免)。
// 对外只导出 streamOpenAIChat 与 detectCompat。
// 铁律:一旦被调用绝不 throw、绝不 reject;一切错误编码为流内 error 事件。

import OpenAI from 'openai';
import type { ModelConfig, ModelRef, StreamFn } from '../../protocol/index.js';
import { ProviderEventStream } from '../../protocol/index.js';
import { resolveCompat, type ResolvedCompat } from './compat.js';
import { buildParams } from './convert.js';
import { finalize, handleChunk, newStreamState } from './consume.js';
import { pushErrorEvent } from './errors.js';

export { detectCompat, resolveCompat } from './compat.js';
export type { CompatFlags, ResolvedCompat } from './compat.js';
export { convertMessages, buildParams, toStrictSchema } from './convert.js';
export { consumeChatStreamForTest, runChatStream };

export const streamOpenAIChat: StreamFn = (model, context, options) => {
  const compat = resolveCompat(model);
  return runChatStream(model.ref, compat, options?.signal, async () => {
    const client = getClient(model);
    const params = buildParams(model, context, options, compat);
    return client.chat.completions.create(params, { signal: options?.signal });
  });
};

/**
 * 消费管线本体(测试注入点):push start → chunksFactory → 逐 chunk 状态机 → finalize;
 * 任何异常(含 factory reject、SSE in-band error、abort)统一走 pushErrorEvent。
 * fixture 回放与真实 SDK 走完全相同的路径。
 */
function runChatStream(
  ref: ModelRef,
  compat: ResolvedCompat,
  signal: AbortSignal | undefined,
  chunksFactory: () => Promise<AsyncIterable<unknown>>,
): ProviderEventStream {
  const stream = new ProviderEventStream();
  const state = newStreamState(ref);
  stream.push({ type: 'start', partial: state.partial });
  void (async () => {
    try {
      const chunks = await chunksFactory();
      for await (const chunk of chunks) {
        handleChunk(chunk, state, stream, compat);
      }
      // openai v6 的流在中途 abort 时不抛异常:SDK 的 SSE 迭代器捕获 AbortError 后
      // clean return(core/streaming.js),APIUserAbortError 只在请求建立阶段抛出。
      // 因此 for-await 正常结束 + signal 已 abort + 无 finish_reason ⇒ 这就是中途打断,
      // 必须编码为 aborted 而非「残缺流」——否则用户的 Esc 会被 session 层当可重试网络错误。
      if (signal?.aborted && !state.finishReason) {
        pushErrorEvent(new OpenAI.APIUserAbortError(), state, stream, signal);
        return;
      }
      finalize(state, stream);
    } catch (err) {
      pushErrorEvent(err, state, stream, signal);
    }
  })();
  return stream;
}

/** 供 fixture 回放测试直接消费 chunk 序列(与生产路径同一管线,仅 chunks 来源不同)。 */
function consumeChatStreamForTest(
  ref: ModelRef,
  compat: ResolvedCompat,
  chunks: () => Promise<AsyncIterable<unknown>>,
  signal?: AbortSignal,
): ProviderEventStream {
  return runChatStream(ref, compat, signal, chunks);
}

// SDK client 按 (baseURL, apiKey, headers) 惰性构造并缓存。maxRetries 保留 SDK 默认(2 次,
// 覆盖网络层瞬时错误);整轮重发策略在 session 层——SSE 流中途断开 SDK 不会续传。
const clientCache = new Map<string, OpenAI>();

function getClient(model: ModelConfig): OpenAI {
  const key = JSON.stringify([
    model.baseURL ?? null,
    model.apiKey ?? null,
    Object.entries(model.headers ?? {}).sort(),   // headers 不同必须是不同 client,否则第二个的头被静默忽略
  ]);
  let client = clientCache.get(key);
  if (!client) {
    client = new OpenAI({
      baseURL: model.baseURL,
      apiKey: model.apiKey ?? 'missing-api-key',   // 本地端点也要占位值,SDK 缺 key 直接 throw
      ...(model.headers && { defaultHeaders: model.headers }),
    });
    clientCache.set(key, client);
  }
  return client;
}
