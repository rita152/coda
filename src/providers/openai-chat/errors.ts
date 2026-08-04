// 错误映射(见 docs/04-provider-adapter.md 的流契约与 docs/08-session-persistence.md 的错误分类)。
// SSE in-band 错误(data 行带 error 字段)已被 SDK 转为 throw APIError,与 HTTP 错误同路径。

import OpenAI from 'openai';
import type { ProviderErrorDetails } from '../../protocol/index.js';
import type { ProviderEventStream } from '../../protocol/index.js';
import { closeOpenBlocks, type StreamState } from './consume.js';

export function pushErrorEvent(
  err: unknown,
  state: StreamState,
  stream: ProviderEventStream,
  signal?: AbortSignal,
): void {
  const aborted = err instanceof OpenAI.APIUserAbortError || signal?.aborted === true;
  const msg = state.partial;                       // 保留已累积的 content(转录如实记录半成品)
  closeOpenBlocks(state, stream);                  // 未闭合块补 *_end 事件
  msg.stopReason = aborted ? 'aborted' : 'error';
  if (!aborted) msg.errorMessage = describeError(err);
  msg.errorDetails = classifyError(err, aborted);
  stream.push({ type: 'error', message: msg });
  stream.end(msg);
}

function describeError(err: unknown): string {
  if (err instanceof OpenAI.APIError) {
    return `${err.constructor.name} status=${err.status ?? 'n/a'} requestID=${err.requestID ?? 'n/a'}: ${err.message}`;
  }
  return String(err);
}

const OVERFLOW_PATTERN = /context.length|context_length|maximum context|too many tokens/i;

export function classifyError(err: unknown, aborted: boolean): ProviderErrorDetails {
  if (aborted) return { kind: 'aborted', retryable: false };
  if (err instanceof OpenAI.APIConnectionTimeoutError || err instanceof OpenAI.APIConnectionError) {
    return { kind: 'network', retryable: true };
  }
  if (err instanceof OpenAI.APIError) {
    const status = typeof err.status === 'number' ? err.status : undefined;
    const code = typeof err.code === 'string' ? err.code : undefined;
    const requestId = err.requestID ?? undefined;
    // ProviderErrorDetails crosses the strict Runtime event boundary. Optional values must be
    // absent rather than present-as-undefined or an otherwise valid provider failure would
    // interrupt the run before its diagnostic message can commit.
    const base = {
      ...(status === undefined ? {} : { status }),
      ...(code === undefined ? {} : { code }),
      ...(requestId === undefined ? {} : { requestId }),
    };
    // 判定顺序:错误码最优先 → 429 限流(其文案常含 "too many tokens",不得被 overflow 抢先)
    // → 文案 fallback 仅限 400/in-band → 其余按 status
    if (code === 'context_length_exceeded') {
      return { ...base, kind: 'overflow', retryable: false };   // 不重试,转交 compaction
    }
    if (status === 429) {
      return { ...base, kind: 'rate_limit', retryable: true, ...retryAfter(err) };
    }
    if ((status === 400 || status === undefined) && OVERFLOW_PATTERN.test(err.message)) {
      return { ...base, kind: 'overflow', retryable: false };
    }
    if (status === 401 || status === 403) return { ...base, kind: 'auth', retryable: false };
    if (status === 408 || status === 409 || (status !== undefined && status >= 500)) {
      return { ...base, kind: 'http', retryable: true };
    }
    if (status !== undefined) return { ...base, kind: 'http', retryable: false };   // 其余 4xx(含 400 协议 bug)
    // SSE in-band 错误(SDK 以 status=undefined 的 APIError 抛出):按 error 体的 type/code 分类,
    // server_error/internal 类是可重试的瞬时故障(docs/08 §5.1)
    const type = (err as { type?: unknown }).type;
    if (type === 'server_error' || code === 'internal_error') {
      return { ...base, kind: 'http', retryable: true };
    }
    return { ...base, kind: 'unknown', retryable: false };
  }
  // SDK 只在请求建立阶段包装错误;SSE body 迭代期间的原生断连(undici TypeError
  // 'fetch failed'/'terminated'、ECONNRESET 等)原样透出,须自行识别为可重试网络错误
  if (isNativeNetworkError(err)) return { kind: 'network', retryable: true };
  return { kind: 'unknown', retryable: false };
}

const NETWORK_MESSAGE = /fetch failed|terminated|network|socket|ECONNRESET|ETIMEDOUT|EPIPE|UND_ERR/i;

function isNativeNetworkError(err: unknown): boolean {
  if (err instanceof TypeError && NETWORK_MESSAGE.test(err.message)) return true;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^(ECONN|ETIMEDOUT|EPIPE|UND_ERR)/.test(code);
}

function retryAfter(err: InstanceType<typeof OpenAI.APIError>): { retryAfterMs?: number } {
  const headers = err.headers as { get?: (k: string) => string | null } | undefined;
  const get = (k: string): string | null => {
    try {
      return headers?.get?.(k) ?? null;
    } catch {
      return null;
    }
  };
  const ms = Number(get('retry-after-ms'));
  if (Number.isFinite(ms) && ms > 0) return { retryAfterMs: ms };
  const ra = get('retry-after');
  const seconds = Number(ra);
  if (Number.isFinite(seconds) && seconds > 0) return { retryAfterMs: seconds * 1000 };
  if (ra) {
    const at = Date.parse(ra);                       // HTTP-date 形式(部分网关/CDN)
    if (Number.isFinite(at) && at > Date.now()) return { retryAfterMs: at - Date.now() };
  }
  return {};
}
