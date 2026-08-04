// OpenAI Responses adapter。SDK 只存在于本目录；agent 仅看到 StreamFn/ProviderEvent。
// 铁律：一旦被调用绝不 throw/reject，所有失败都编码为流内 error 事件。

import OpenAI from 'openai';
import type { ModelConfig, ModelRef, StreamFn } from '../../protocol/index.js';
import { ProviderEventStream } from '../../protocol/index.js';
import { buildParams } from './convert.js';
import {
  finishMissingTerminal,
  handleResponseEvent,
  newResponsesStreamState,
} from './consume.js';
import { pushResponsesErrorEvent } from './errors.js';
import { createResponsesStreamWithSummaryFallback } from './request.js';

export { buildParams, convertInput, convertTools } from './convert.js';
export { consumeResponsesStreamForTest };

export const streamOpenAIResponses: StreamFn = (model, context, options) =>
  runResponsesStream(model.ref, options?.signal, async () => {
    const client = getClient(model);
    const params = buildParams(model, context, options);
    return createResponsesStreamWithSummaryFallback(
      params,
      options?.signal,
      async (attempt, signal) => client.responses.create(attempt, { signal }),
    );
  });

function runResponsesStream(
  ref: ModelRef,
  signal: AbortSignal | undefined,
  eventsFactory: () => Promise<AsyncIterable<unknown>>,
): ProviderEventStream {
  const stream = new ProviderEventStream();
  const state = newResponsesStreamState(ref);
  stream.push({ type: 'start', partial: state.partial });
  void (async () => {
    try {
      const events = await eventsFactory();
      if (signal?.aborted) {
        pushResponsesErrorEvent(new OpenAI.APIUserAbortError(), state, stream, signal);
        return;
      }
      for await (const event of events) {
        // for-await 的 next() 是关键 await 边界：abort 可能在事件已缓冲但尚未交给
        // adapter 时发生，恢复后必须先停，不能继续把取消后的内容写进 transcript。
        if (signal?.aborted) {
          pushResponsesErrorEvent(new OpenAI.APIUserAbortError(), state, stream, signal);
          return;
        }
        handleResponseEvent(event, state, stream);
        if (state.terminal) return;
      }
      if (signal?.aborted) {
        pushResponsesErrorEvent(new OpenAI.APIUserAbortError(), state, stream, signal);
        return;
      }
      finishMissingTerminal(state, stream);
    } catch (err) {
      pushResponsesErrorEvent(err, state, stream, signal);
    }
  })();
  return stream;
}

function consumeResponsesStreamForTest(
  ref: ModelRef,
  events: () => Promise<AsyncIterable<unknown>>,
  signal?: AbortSignal,
): ProviderEventStream {
  return runResponsesStream(ref, signal, events);
}

const clientCache = new Map<string, OpenAI>();

function getClient(model: ModelConfig): OpenAI {
  const key = JSON.stringify([
    model.baseURL ?? null,
    model.apiKey ?? null,
    Object.entries(model.headers ?? {}).sort(),
  ]);
  let client = clientCache.get(key);
  if (client === undefined) {
    client = new OpenAI({
      baseURL: model.baseURL,
      apiKey: model.apiKey ?? 'missing-api-key',
      ...(model.headers !== undefined && { defaultHeaders: model.headers }),
    });
    clientCache.set(key, client);
  }
  return client;
}
