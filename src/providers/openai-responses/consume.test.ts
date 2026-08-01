// Responses SSE fixture 回放：文本、reasoning、工具往返/并行、usage 与所有终态/错误。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';
import OpenAI from 'openai';
import type {
  AssistantMessage,
  Context,
  ModelRef,
  ProviderEvent,
  ToolCallPart,
} from '../../protocol/index.js';
import {
  assertValidProviderEventSequence,
  collectStream,
} from '../../../tests/helpers/provider-events.js';
import { convertInput } from './convert.js';
import { consumeResponsesStreamForTest } from './index.js';

const ref: ModelRef = {
  provider: 'openai',
  api: 'openai-responses',
  model: 'gpt-test',
};
const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__');

function readFixture(name: string): unknown[] {
  return readFileSync(path.join(fixturesDir, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as unknown);
}

async function* fixtureEvents(lines: unknown[]): AsyncIterable<unknown> {
  for (const line of lines) {
    await Promise.resolve();
    yield line;
  }
}

async function replay(name: string): Promise<{ events: ProviderEvent[]; final: AssistantMessage }> {
  const stream = consumeResponsesStreamForTest(
    ref,
    () => Promise.resolve(fixtureEvents(readFixture(name))),
  );
  return collectStream(stream);
}

function toolCallsOf(message: AssistantMessage): ToolCallPart[] {
  return message.content.filter((part): part is ToolCallPart => part.type === 'tool_call');
}

describe('fixture replay', () => {
  it('text: output_text delta → TextPart，completed → stop', async () => {
    const { events, final } = await replay('text');
    assertValidProviderEventSequence(events);
    expect(events.map((event) => event.type)).toEqual([
      'start',
      'text_start',
      'text_delta',
      'text_delta',
      'text_end',
      'done',
    ]);
    expect(final.content).toEqual([{ type: 'text', text: 'Hello Responses.' }]);
    expect(final.stopReason).toBe('stop');
    expect(final.usage).toEqual({ input: 8, output: 4 });
  });

  it('reasoning summary 带可 replay 的私有 signature，usage.reasoning 映射', async () => {
    const { events, final } = await replay('reasoning');
    assertValidProviderEventSequence(events);
    expect(final.content[0]).toMatchObject({
      type: 'reasoning',
      text: 'Checked the steps.',
    });
    const reasoning = final.content[0];
    if (reasoning?.type !== 'reasoning') throw new Error('expected reasoning part');
    expect(reasoning.signature).toStartWith('openai-responses:v1:');
    expect(reasoning.signature).toContain('enc_reasoning_fixture');
    expect(final.content[1]).toEqual({ type: 'text', text: 'The answer is 42.' });
    expect(final.usage).toEqual({ input: 12, output: 11, reasoning: 5 });

    const replayed = convertInput({ messages: [final] });
    expect(replayed[0]).toEqual({
      id: 'rs_reasoning',
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'Checked the steps.' }],
      encrypted_content: 'enc_reasoning_fixture',
    });
    expect(replayed[1]).toEqual({ role: 'assistant', content: 'The answer is 42.' });
  });

  it('无可见 summary 的 reasoning item 仍写入 transcript 并在工具回合完整 replay', async () => {
    const reasoningItem = {
      id: 'rs_hidden',
      type: 'reasoning',
      status: 'completed',
      summary: [],
      encrypted_content: 'enc_hidden',
    };
    const callItem = {
      id: 'fc_hidden',
      type: 'function_call',
      status: 'completed',
      call_id: 'call_hidden',
      name: 'read',
      arguments: '{"path":"hidden.ts"}',
    };
    const stream = consumeResponsesStreamForTest(ref, () => Promise.resolve(fixtureEvents([{
      type: 'response.completed',
      response: {
        output: [reasoningItem, callItem],
        usage: {
          input_tokens: 4,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
          output_tokens: 3,
          output_tokens_details: { reasoning_tokens: 2 },
        },
      },
    }])));
    const { events, final } = await collectStream(stream);
    assertValidProviderEventSequence(events);
    expect(final.content[0]).toMatchObject({ type: 'reasoning', text: '' });
    expect(final.content[1]).toMatchObject({ type: 'tool_call', id: 'call_hidden' });
    expect(convertInput({ messages: [final] })).toEqual([
      {
        id: 'rs_hidden',
        type: 'reasoning',
        summary: [],
        encrypted_content: 'enc_hidden',
      },
      {
        type: 'function_call',
        call_id: 'call_hidden',
        name: 'read',
        arguments: '{"path":"hidden.ts"}',
      },
    ]);
  });

  it('fragmented function call: call_id → ToolCallPart.id，工具结果以 function_call_output 回传', async () => {
    const { events, final } = await replay('tool-call');
    assertValidProviderEventSequence(events);
    expect(final.stopReason).toBe('tool_calls');
    const calls = toolCallsOf(final);
    expect(calls).toEqual([{
      type: 'tool_call',
      id: 'call_weather',
      name: 'get_weather',
      arguments: { city: 'Paris' },
      rawArguments: '{"city":"Paris"}',
    }]);
    expect(events.filter((event) => event.type === 'tool_call_delta')).toHaveLength(2);

    const context: Context = {
      messages: [
        final,
        {
          role: 'tool_result',
          id: 'tr',
          timestamp: 2,
          toolCallId: 'call_weather',
          toolName: 'get_weather',
          content: [{ type: 'text', text: 'sunny' }],
          isError: false,
        },
      ],
    };
    expect(convertInput(context)).toEqual([
      {
        type: 'function_call',
        call_id: 'call_weather',
        name: 'get_weather',
        arguments: '{"city":"Paris"}',
      },
      { type: 'function_call_output', call_id: 'call_weather', output: 'sunny' },
    ]);
  });

  it('parallel fragmented calls 独立累积，交错 delta 不串槽', async () => {
    const { events, final } = await replay('parallel-tool-calls');
    assertValidProviderEventSequence(events);
    expect(final.stopReason).toBe('tool_calls');
    expect(toolCallsOf(final)).toEqual([
      {
        type: 'tool_call',
        id: 'call_first',
        name: 'read',
        arguments: { path: 'a.ts' },
        rawArguments: '{"path":"a.ts"}',
      },
      {
        type: 'tool_call',
        id: 'call_second',
        name: 'read',
        arguments: { path: 'b.ts' },
        rawArguments: '{"path":"b.ts"}',
      },
    ]);
    const deltas = events.filter((event) => event.type === 'tool_call_delta');
    expect(deltas.map((event) => event.contentIndex)).toEqual([0, 1, 0, 1]);
  });

  it('usage 使用 inclusive 口径并保留有效 cache/reasoning 明细', async () => {
    const { events, final } = await replay('usage');
    assertValidProviderEventSequence(events);
    expect(final.usage).toEqual({
      input: 120,
      output: 31,
      cacheRead: 80,
      cacheWrite: 10,
      reasoning: 7,
    });
  });

  it('畸形 usage 数值不破坏内部非负与 inclusive 不变量', async () => {
    const stream = consumeResponsesStreamForTest(ref, () => Promise.resolve(fixtureEvents([{
      type: 'response.completed',
      response: {
        output: [],
        usage: {
          input_tokens: -1,
          input_tokens_details: { cached_tokens: 6, cache_write_tokens: -2 },
          output_tokens: 3.5,
          output_tokens_details: { reasoning_tokens: 4 },
        },
      },
    }])));
    const { events, final } = await collectStream(stream);
    assertValidProviderEventSequence(events);
    expect(final.usage).toEqual({ input: 0, output: 0 });
  });
});

describe('terminal and errors', () => {
  it('abort fixture:迭代器 clean return + signal aborted → aborted，半截文本保留', async () => {
    const controller = new AbortController();
    async function* abortingFixture(): AsyncIterable<unknown> {
      for (const event of readFixture('abort')) yield event;
      controller.abort();
    }
    const stream = consumeResponsesStreamForTest(
      ref,
      () => Promise.resolve(abortingFixture()),
      controller.signal,
    );
    const { events, final } = await collectStream(stream);
    assertValidProviderEventSequence(events);
    expect(final.stopReason).toBe('aborted');
    expect(final.errorMessage).toBeUndefined();
    expect(final.errorDetails).toEqual({ kind: 'aborted', retryable: false });
    expect(final.content).toEqual([{ type: 'text', text: 'partial' }]);
  });

  it('factory await 后已 abort 时不再消费缓冲事件', async () => {
    const controller = new AbortController();
    const stream = consumeResponsesStreamForTest(
      ref,
      async () => {
        controller.abort();
        return fixtureEvents(readFixture('text'));
      },
      controller.signal,
    );
    const { events, final } = await collectStream(stream);
    assertValidProviderEventSequence(events);
    expect(events.map((event) => event.type)).toEqual(['start', 'error']);
    expect(final.stopReason).toBe('aborted');
    expect(final.content).toEqual([]);
  });

  it('incomplete/max_output_tokens → done length；content_filter → done content_filter', async () => {
    const truncated = await replay('incomplete');
    assertValidProviderEventSequence(truncated.events);
    expect(truncated.final.stopReason).toBe('length');
    expect(truncated.final.content).toEqual([{ type: 'text', text: 'partial' }]);

    const filtered = consumeResponsesStreamForTest(ref, () => Promise.resolve(fixtureEvents([{
      type: 'response.incomplete',
      response: {
        output: [],
        incomplete_details: { reason: 'content_filter' },
        usage: {
          input_tokens: 2,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
          output_tokens: 0,
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    }])));
    const filteredResult = await collectStream(filtered);
    assertValidProviderEventSequence(filteredResult.events);
    expect(filteredResult.final.stopReason).toBe('content_filter');
  });

  it('unknown incomplete reason 编码为 error，不 reject', async () => {
    const stream = consumeResponsesStreamForTest(ref, () => Promise.resolve(fixtureEvents([{
      type: 'response.incomplete',
      response: { output: [], incomplete_details: { reason: 'new_reason' } },
    }])));
    const { events, final } = await collectStream(stream);
    assertValidProviderEventSequence(events);
    expect(final.stopReason).toBe('error');
    expect(final.errorDetails).toMatchObject({
      code: 'response_incomplete',
      kind: 'http',
      retryable: false,
    });
  });

  it('SSE error event 与 response.failed 都编码为流内 error', async () => {
    const sse = await replay('sse-error');
    assertValidProviderEventSequence(sse.events);
    expect(sse.final.stopReason).toBe('error');
    expect(sse.final.content).toEqual([{ type: 'text', text: 'before failure' }]);
    expect(sse.final.errorDetails).toMatchObject({
      code: 'server_error',
      kind: 'http',
      retryable: true,
    });

    const failed = await replay('failed');
    assertValidProviderEventSequence(failed.events);
    expect(failed.final.stopReason).toBe('error');
    expect(failed.final.errorMessage).toContain('prompt rejected');
    expect(failed.final.errorDetails).toMatchObject({
      code: 'invalid_prompt',
      kind: 'http',
      retryable: false,
    });
    expect(failed.final.usage).toEqual({ input: 5, output: 2 });
  });

  it('HTTP/factory errors 离线分类；StreamFn 管线始终 resolve 最终消息', async () => {
    const cases = [
      {
        error: OpenAI.APIError.generate(
          401,
          { error: { message: 'bad key' } },
          'bad key',
          new Headers(),
        ),
        expected: { kind: 'auth', retryable: false, status: 401 },
      },
      {
        error: OpenAI.APIError.generate(
          429,
          { error: { message: 'slow down' } },
          'slow down',
          new Headers({ 'retry-after': '2' }),
        ),
        expected: { kind: 'rate_limit', retryable: true, status: 429, retryAfterMs: 2000 },
      },
      {
        error: OpenAI.APIError.generate(
          500,
          { error: { message: 'server broke' } },
          'server broke',
          new Headers(),
        ),
        expected: { kind: 'http', retryable: true, status: 500 },
      },
    ];
    for (const testCase of cases) {
      const stream = consumeResponsesStreamForTest(
        ref,
        () => Promise.reject(testCase.error),
      );
      const { events, final } = await collectStream(stream);
      assertValidProviderEventSequence(events);
      expect(final.stopReason).toBe('error');
      expect(final.errorDetails).toMatchObject(testCase.expected);
      expect(Object.values(final.errorDetails ?? {})).not.toContain(undefined);
    }
  });

  it('无 terminal 的干净结束视为可重试网络错误', async () => {
    const stream = consumeResponsesStreamForTest(
      ref,
      () => Promise.resolve(fixtureEvents([])),
    );
    const { events, final } = await collectStream(stream);
    assertValidProviderEventSequence(events);
    expect(final.stopReason).toBe('error');
    expect(final.errorDetails).toEqual({ kind: 'network', retryable: true });
  });

  it('迭代中原生断连编码为 network error，已产生内容保留', async () => {
    async function* broken(): AsyncIterable<unknown> {
      yield {
        type: 'response.output_text.delta',
        item_id: 'msg',
        output_index: 0,
        content_index: 0,
        delta: 'x',
      };
      throw new TypeError('terminated');
    }
    const stream = consumeResponsesStreamForTest(ref, () => Promise.resolve(broken()));
    const { events, final } = await collectStream(stream);
    assertValidProviderEventSequence(events);
    expect(final.errorDetails).toEqual({ kind: 'network', retryable: true });
    expect(final.content).toEqual([{ type: 'text', text: 'x' }]);
  });
});
