// Responses 请求协商：仅对默认 effort 的 summary 参数做一次窄范围兼容降级。

import OpenAI from 'openai';
import type { ResponseCreateParamsStreaming } from 'openai/resources/responses/responses';

type CreateResponsesStream = (
  params: ResponseCreateParamsStreaming,
  signal: AbortSignal | undefined,
) => Promise<AsyncIterable<unknown>>;

/**
 * 首次请求保留 reasoning summary；只有 API 明确拒绝 summary-only 参数时，才按旧 wire
 * 省略整个 reasoning 字段重试一次。显式 effort 或其他 reasoning 选项绝不静默降级。
 */
export async function createResponsesStreamWithSummaryFallback(
  params: ResponseCreateParamsStreaming,
  signal: AbortSignal | undefined,
  create: CreateResponsesStream,
): Promise<AsyncIterable<unknown>> {
  try {
    return await create(params, signal);
  } catch (error) {
    if (!canRetryWithoutReasoning(params, error)) throw error;
    if (signal?.aborted === true) throw new OpenAI.APIUserAbortError();
    const fallbackParams = { ...params };
    delete fallbackParams.reasoning;
    return create(fallbackParams, signal);
  }
}

function canRetryWithoutReasoning(
  params: ResponseCreateParamsStreaming,
  error: unknown,
): boolean {
  const reasoning = params.reasoning;
  if (!isPlainRecord(reasoning)) return false;
  const keys = Object.keys(reasoning);
  if (keys.length !== 1 || keys[0] !== 'summary' || reasoning['summary'] !== 'auto') return false;
  return error instanceof OpenAI.APIError &&
    error.status === 400 &&
    (error.param === 'reasoning' || error.param === 'reasoning.summary');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
