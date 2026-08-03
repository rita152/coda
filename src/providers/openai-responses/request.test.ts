// Responses summary 参数的窄范围兼容降级；不得吞掉显式 reasoning 或其他 API 错误。

import { describe, expect, it } from 'bun:test';
import OpenAI from 'openai';
import type { ResponseCreateParamsStreaming } from 'openai/resources/responses/responses';
import { createResponsesStreamWithSummaryFallback } from './request.js';

const baseParams: ResponseCreateParamsStreaming = {
  model: 'gpt-test',
  input: 'hello',
  stream: true,
  reasoning: { summary: 'auto' },
};

async function* emptyEvents(): AsyncIterable<unknown> {
  // Intentionally empty: this helper only negotiates the request before stream consumption.
}

function apiError(status: number, param: string | null, message = 'unsupported parameter') {
  return new OpenAI.APIError(status, { message, param }, undefined, new Headers());
}

describe('Responses request summary fallback', () => {
  it('keeps a supported summary request to one attempt', async () => {
    const calls: ResponseCreateParamsStreaming[] = [];
    const stream = await createResponsesStreamWithSummaryFallback(baseParams, undefined, (params) => {
      calls.push(params);
      return Promise.resolve(emptyEvents());
    });

    expect(stream).toBeDefined();
    expect(calls).toEqual([baseParams]);
  });

  for (const param of ['reasoning', 'reasoning.summary'] as const) {
    it(`retries once without summary-only reasoning when param=${param}`, async () => {
      const calls: ResponseCreateParamsStreaming[] = [];
      await createResponsesStreamWithSummaryFallback(baseParams, undefined, (params) => {
        calls.push(params);
        if (calls.length === 1) return Promise.reject(apiError(400, param));
        return Promise.resolve(emptyEvents());
      });

      expect(calls).toHaveLength(2);
      expect(calls[0]).toBe(baseParams);
      expect(calls[1]).not.toHaveProperty('reasoning');
      expect(calls[1]).toEqual({ model: 'gpt-test', input: 'hello', stream: true });
      expect(baseParams.reasoning).toEqual({ summary: 'auto' });
    });
  }

  it('does not downgrade unrelated, unstructured, or non-400 API errors', async () => {
    for (const error of [
      apiError(400, 'temperature'),
      apiError(400, null, 'reasoning is unsupported'),
      apiError(403, 'reasoning.summary'),
      apiError(422, 'reasoning.summary'),
      new OpenAI.APIConnectionError({ message: 'network failed' }),
    ]) {
      let calls = 0;
      await expect(createResponsesStreamWithSummaryFallback(baseParams, undefined, () => {
        calls++;
        return Promise.reject(error);
      })).rejects.toBe(error);
      expect(calls).toBe(1);
    }
  });

  it('does not drop explicit effort or any future reasoning option', async () => {
    const params: ResponseCreateParamsStreaming = {
      ...baseParams,
      reasoning: { summary: 'auto', effort: 'medium' },
    };
    let calls = 0;
    const error = apiError(400, 'reasoning.summary');
    await expect(createResponsesStreamWithSummaryFallback(params, undefined, () => {
      calls++;
      return Promise.reject(error);
    })).rejects.toBe(error);
    expect(calls).toBe(1);
  });

  it('checks abort before a fallback request', async () => {
    const controller = new AbortController();
    let calls = 0;
    await expect(createResponsesStreamWithSummaryFallback(baseParams, controller.signal, () => {
      calls++;
      controller.abort();
      return Promise.reject(apiError(400, 'reasoning'));
    })).rejects.toBeInstanceOf(OpenAI.APIUserAbortError);
    expect(calls).toBe(1);
  });

  it('attempts no third request when the fallback also fails', async () => {
    const secondError = apiError(500, null, 'server failed');
    let calls = 0;
    await expect(createResponsesStreamWithSummaryFallback(baseParams, undefined, () => {
      calls++;
      return calls === 1
        ? Promise.reject(apiError(400, 'reasoning'))
        : Promise.reject(secondError);
    })).rejects.toBe(secondError);
    expect(calls).toBe(2);
  });
});
