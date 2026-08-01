// Responses adapter 错误映射：HTTP/SSE/abort 全部转成流内 ProviderEvent.error。

import OpenAI from 'openai';
import type { ProviderErrorDetails } from '../../protocol/index.js';
import type { ProviderEventStream } from '../../protocol/index.js';
import { closeOpenBlocks, type ResponsesStreamState } from './consume.js';
import { ResponsesWireError } from './wire-error.js';

export function pushResponsesErrorEvent(
  err: unknown,
  state: ResponsesStreamState,
  stream: ProviderEventStream,
  signal?: AbortSignal,
): void {
  if (state.terminal) return;
  const aborted = err instanceof OpenAI.APIUserAbortError || signal?.aborted === true;
  closeOpenBlocks(state, stream);
  state.partial.stopReason = aborted ? 'aborted' : 'error';
  if (!aborted) state.partial.errorMessage = describeError(err);
  state.partial.errorDetails = classifyResponsesError(err, aborted);
  state.terminal = true;
  stream.push({ type: 'error', message: state.partial });
  stream.end(state.partial);
}

function describeError(err: unknown): string {
  if (err instanceof OpenAI.APIError) {
    return `${err.constructor.name} status=${err.status ?? 'n/a'} requestID=${err.requestID ?? 'n/a'}: ${err.message}`;
  }
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

const OVERFLOW_PATTERN = /context.length|context_length|maximum context|too many tokens/i;

export function classifyResponsesError(err: unknown, aborted: boolean): ProviderErrorDetails {
  if (aborted) return { kind: 'aborted', retryable: false };
  if (err instanceof OpenAI.APIConnectionTimeoutError || err instanceof OpenAI.APIConnectionError) {
    return { kind: 'network', retryable: true };
  }
  if (err instanceof OpenAI.APIError) {
    const status = typeof err.status === 'number' ? err.status : undefined;
    const code = typeof err.code === 'string' ? err.code : undefined;
    const requestId = err.requestID ?? undefined;
    const base = {
      ...(status === undefined ? {} : { status }),
      ...(code === undefined ? {} : { code }),
      ...(requestId === undefined ? {} : { requestId }),
    };
    if (code === 'context_length_exceeded') return { ...base, kind: 'overflow', retryable: false };
    if (status === 429) return { ...base, kind: 'rate_limit', retryable: true, ...retryAfter(err) };
    if ((status === 400 || status === undefined) && OVERFLOW_PATTERN.test(err.message)) {
      return { ...base, kind: 'overflow', retryable: false };
    }
    if (status === 401 || status === 403) return { ...base, kind: 'auth', retryable: false };
    if (status === 408 || status === 409 || (status !== undefined && status >= 500)) {
      return { ...base, kind: 'http', retryable: true };
    }
    if (status !== undefined) return { ...base, kind: 'http', retryable: false };
    const type = (err as { type?: unknown }).type;
    if (type === 'server_error' || code === 'internal_error') {
      return { ...base, kind: 'http', retryable: true };
    }
    return { ...base, kind: 'unknown', retryable: false };
  }
  if (err instanceof ResponsesWireError) {
    const code = err.code;
    if (code === 'context_length_exceeded' || OVERFLOW_PATTERN.test(err.message)) {
      return { code, kind: 'overflow', retryable: false };
    }
    if (code === 'rate_limit_exceeded') return { code, kind: 'rate_limit', retryable: true };
    if (code === 'server_error' || code === 'vector_store_timeout' || code === 'internal_error') {
      return { code, kind: 'http', retryable: true };
    }
    return { code, kind: 'http', retryable: false };
  }
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
  const headers = err.headers as { get?: (key: string) => string | null } | undefined;
  const get = (key: string): string | null => {
    try {
      return headers?.get?.(key) ?? null;
    } catch {
      return null;
    }
  };
  const milliseconds = Number(get('retry-after-ms'));
  if (Number.isFinite(milliseconds) && milliseconds > 0) return { retryAfterMs: milliseconds };
  const retryAfter = get('retry-after');
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) return { retryAfterMs: seconds * 1000 };
  if (retryAfter) {
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at) && at > Date.now()) return { retryAfterMs: at - Date.now() };
  }
  return {};
}
