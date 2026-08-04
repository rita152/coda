// 错误映射(见 docs/04-provider-adapter.md 的流契约与 docs/08-session-persistence.md 的错误分类)。
// 形态对齐 src/providers/openai-chat/errors.ts:SDK 错误家族 → ProviderErrorDetails,
// stopReason 编码为 error/aborted。铁律:StreamFn 绝不 throw,一切错误编码为流内 error 事件。

import Anthropic from '@anthropic-ai/sdk';
import type { ProviderErrorDetails } from '../../protocol/index.js';
import type { ProviderEventStream } from '../../protocol/index.js';
import { closeOpenBlocks, type StreamState } from './consume.js';

export function pushErrorEvent(
  err: unknown,
  state: StreamState,
  stream: ProviderEventStream,
  signal?: AbortSignal,
): void {
  const aborted = err instanceof Anthropic.APIUserAbortError || signal?.aborted === true;
  const msg = state.partial;                       // 保留已累积的 content(转录如实记录半成品)
  closeOpenBlocks(state, stream);                  // 未闭合块补 *_end 事件
  msg.stopReason = aborted ? 'aborted' : 'error';
  if (!aborted) msg.errorMessage = describeError(err);
  msg.errorDetails = classifyError(err, aborted);
  stream.push({ type: 'error', message: msg });
  stream.end(msg);
}

function describeError(err: unknown): string {
  if (err instanceof Anthropic.APIError) {
    return `${err.constructor.name} status=${err.status ?? 'n/a'} requestID=${err.requestID ?? 'n/a'}: ${err.message}`;
  }
  return String(err);
}

// Anthropic 上下文溢出:400 invalid_request,文案形如 "prompt is too long: N tokens > M maximum"
const OVERFLOW_PATTERN = /prompt is too long|too many tokens|maximum.*(context|tokens)|context.*length/i;

function classifyError(err: unknown, aborted: boolean): ProviderErrorDetails {
  if (aborted) return { kind: 'aborted', retryable: false };
  if (err instanceof Anthropic.APIConnectionTimeoutError || err instanceof Anthropic.APIConnectionError) {
    return { kind: 'network', retryable: true };
  }
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === 'number' ? err.status : undefined;
    const code = innerErrorType(err);
    const requestId = err.requestID ?? undefined;
    const base = {
      ...(status === undefined ? {} : { status }),
      ...(code === undefined ? {} : { code }),
      ...(requestId === undefined ? {} : { requestId }),
    };
    // 判定顺序:429 限流最先(其文案常含 "too many tokens",不得被 overflow 抢先)→ overflow 文案
    // → auth → 5xx/瞬时 → 其余按 status
    if (status === 429) {
      return { ...base, kind: 'rate_limit', retryable: true, ...retryAfter(err) };
    }
    if ((status === 400 || status === undefined) && OVERFLOW_PATTERN.test(err.message)) {
      return { ...base, kind: 'overflow', retryable: false };   // 不重试,转交 compaction
    }
    if (status === 401 || status === 403) return { ...base, kind: 'auth', retryable: false };
    if (status === 408 || status === 409 || (status !== undefined && status >= 500)) {
      return { ...base, kind: 'http', retryable: true };
    }
    if (status !== undefined) return { ...base, kind: 'http', retryable: false };   // 其余 4xx(含 400 协议 bug)
    // status 缺失(SSE in-band error 等):按 error 体 type 分类,overloaded/api_error 是可重试瞬时故障
    if (code === 'overloaded_error' || code === 'api_error') {
      return { ...base, kind: 'http', retryable: true };
    }
    return { ...base, kind: 'unknown', retryable: false };
  }
  // SDK 只在请求建立阶段包装错误;SSE body 迭代期间的原生断连(undici TypeError 等)原样透出
  if (isNativeNetworkError(err)) return { kind: 'network', retryable: true };
  return { kind: 'unknown', retryable: false };
}

/** 从 Anthropic 错误体 { type:'error', error:{ type, message } } 读内层 error.type(充当 code)。 */
function innerErrorType(err: InstanceType<typeof Anthropic.APIError>): string | undefined {
  const body = err.error as { error?: { type?: unknown } } | undefined;
  const type = body?.error?.type;
  return typeof type === 'string' ? type : undefined;
}

const NETWORK_MESSAGE = /fetch failed|terminated|network|socket|ECONNRESET|ETIMEDOUT|EPIPE|UND_ERR/i;

function isNativeNetworkError(err: unknown): boolean {
  if (err instanceof TypeError && NETWORK_MESSAGE.test(err.message)) return true;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^(ECONN|ETIMEDOUT|EPIPE|UND_ERR)/.test(code);
}

function retryAfter(err: InstanceType<typeof Anthropic.APIError>): { retryAfterMs?: number } {
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
