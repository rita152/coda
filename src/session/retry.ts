// auto-retry 决策纯函数(规格见 docs/08-session-persistence.md §5.2)。
// 无 IO、无计时器:只吃「一条 error assistant 消息 + 当前已重试次数」,吐退避决策。
// 这是从 pi 3300 行教训里换来的形态——重试逻辑一旦与循环控制缠在一起就再也测不动。
// 退避实际睡眠(sleepWithAbort)是 session 层的副作用,不在本文件。

import type { AssistantMessage, ProviderErrorDetails } from '../protocol/index.js';

export interface RetryOptions {
  maxAttempts?: number; // 默认 5:允许的重试次数(attempt 0..maxAttempts-1)
  baseDelayMs?: number; // 默认 1000:指数退避基数
  maxDelayMs?: number; // 默认 32000:单次退避封顶(乘 jitter 前)
  jitter?: () => number; // 默认 Math.random;测试注入确定值以断言退避序列
}

export type ResolvedRetryOptions = Required<RetryOptions>;

export const DEFAULT_RETRY_OPTIONS: ResolvedRetryOptions = {
  maxAttempts: 5,
  baseDelayMs: 1000,
  maxDelayMs: 32000,
  jitter: Math.random,
};

export function resolveRetryOptions(opts?: RetryOptions): ResolvedRetryOptions {
  return { ...DEFAULT_RETRY_OPTIONS, ...opts };
}

export type RetryDecision = { retry: false; reason: string } | { retry: true; delayMs: number };

/**
 * 退避决策(docs/08 §5.2):
 *   stopReason !== 'error'         → 不重试(aborted 是用户意志,非错误也无从重试)
 *   分类不可重试 / retryable:false → 不重试(理由带 kind)
 *   attempt >= maxAttempts         → 不重试(上限)
 * 否则 base = errorDetails.retryAfterMs ?? baseDelayMs * 2**attempt,
 *     delayMs = min(maxDelayMs, base) * (0.5 + jitter())  —— full jitter。
 */
export function decideRetry(
  msg: AssistantMessage,
  attempt: number,
  opts: ResolvedRetryOptions,
): RetryDecision {
  if (msg.stopReason !== 'error') return { retry: false, reason: `stopReason is '${msg.stopReason}', not an error` };

  const cls = classifyRetryable(msg.errorDetails, msg.errorMessage);
  if (!cls.retryable) return { retry: false, reason: cls.reason };

  if (attempt >= opts.maxAttempts) return { retry: false, reason: `max attempts reached (${opts.maxAttempts})` };

  const base = msg.errorDetails?.retryAfterMs ?? opts.baseDelayMs * 2 ** attempt;
  const delayMs = Math.min(opts.maxDelayMs, base) * (0.5 + opts.jitter());
  return { retry: true, delayMs };
}

/**
 * 结构化优先、字符串兜底(docs/08 §5.1)。adapter 最了解错误来源并填 errorDetails;
 * 缺省时对 errorMessage 做保守的网络类文案匹配——宁可漏判可重试,不可误判把 4xx 重放。
 */
function classifyRetryable(
  details: ProviderErrorDetails | undefined,
  errorMessage: string | undefined,
): { retryable: boolean; reason: string } {
  if (details) {
    // overflow 转交 compaction(§6.1),auth/aborted 重试无意义:分类硬否决,忽略 retryable 标志
    if (details.kind === 'overflow' || details.kind === 'auth' || details.kind === 'aborted') {
      return { retryable: false, reason: `error kind '${details.kind}' is not retryable` };
    }
    if (details.retryable === false) {
      return { retryable: false, reason: `error kind '${details.kind}' marked non-retryable by adapter` };
    }
    if (details.kind === 'network' || details.kind === 'http' || details.kind === 'rate_limit') {
      return { retryable: true, reason: details.kind };
    }
    // unknown:仅当 adapter 显式判为可重试才重试(in-band server_error 等由 adapter 归 http)
    return details.retryable === true
      ? { retryable: true, reason: 'unknown (adapter marked retryable)' }
      : { retryable: false, reason: `error kind '${details.kind}' is not retryable` };
  }

  const text = errorMessage ?? '';
  if (/\b(timeout|timed out|econnreset|econnrefused|enotfound|network|socket hang up|fetch failed|502|503|504)\b/i.test(text)) {
    return { retryable: true, reason: 'network (matched from errorMessage)' };
  }
  return { retryable: false, reason: 'no structured errorDetails and errorMessage not classifiable' };
}

/**
 * 可被 abort 取消的退避睡眠(session 层唯一的计时器用法)。
 * resolve(true) = 被 signal 取消(计时器已 clear);resolve(false) = 睡满。绝不 reject。
 * 测试用 vitest fake timers 驱动;abort 路径不依赖计时器,同步生效。
 */
export function sleepWithAbort(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(false);
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
