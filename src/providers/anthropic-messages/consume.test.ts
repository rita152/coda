// 入站解析测试:Messages SSE fixture 回放(docs/10 §4)+ usage 换算 + 错误路径 + abort。
// fixture 回放与生产路径走同一条 runAnthropicStream 管线,只是事件来源不同。
// 本测试位于 adapter 目录内(非 tests/):tests/ 被 ESLint 禁止 import 真实 adapter(防在线测试)。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';
import Anthropic from '@anthropic-ai/sdk';
import type { AssistantMessage, ModelRef, ProviderEvent, ToolCallPart } from '../../protocol/index.js';
import { assertValidProviderEventSequence, collectStream } from '../../../tests/helpers/provider-events.js';
import { detectCompat } from './compat.js';
import { consumeAnthropicStreamForTest } from './index.js';

const ref: ModelRef = { provider: 'anthropic', api: 'anthropic-messages', model: 'claude-opus-5' };
const compat = detectCompat(undefined);   // Anthropic 官方 profile
const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__');

function readFixtureLines(name: string): unknown[] {
  return readFileSync(path.join(fixturesDir, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as unknown);
}

/** 模拟 SDK 的事件流:逐条让出微任务。data 带 type:'error' → throw APIError(SDK 遇 error 事件同款行为)。 */
async function* fixtureEvents(lines: unknown[]): AsyncIterable<unknown> {
  for (const line of lines) {
    await Promise.resolve();
    const obj = line as Record<string, unknown>;
    if (obj?.['type'] === 'error') {
      const body = obj['error'] as { message?: string } | undefined;
      throw Anthropic.APIError.generate(undefined, obj, body?.message, undefined);
    }
    yield line;
  }
}

async function replayFixture(name: string): Promise<{ events: ProviderEvent[]; final: AssistantMessage }> {
  const lines = readFixtureLines(name);
  const stream = consumeAnthropicStreamForTest(ref, compat, () => Promise.resolve(fixtureEvents(lines)));
  return collectStream(stream);
}

function toolCallsOf(final: AssistantMessage): ToolCallPart[] {
  return final.content.filter((p): p is ToolCallPart => p.type === 'tool_call');
}

describe('fixture 回放(真实录制 claude-opus-5,全部产出合法事件序列)', () => {
  it('text:三段式文本流,stopReason stop,inclusive usage 换算', async () => {
    const { events, final } = await replayFixture('text');
    assertValidProviderEventSequence(events);
    expect(events.map((e) => e.type)).toEqual([
      'start', 'text_start', 'text_delta', 'text_delta', 'text_end', 'done',
    ]);
    expect(final.content).toEqual([{ type: 'text', text: 'Hello from the fixture recorder.' }]);
    expect(final.stopReason).toBe('stop');
    // input=91(+cache 0),output=14;无 cache/reasoning 明细(0 视为缺省不落字段)
    expect(final.usage).toEqual({ input: 91, output: 14 });
  });

  it('tool:text 块后 tool_use 块,input_json_delta 累积,arguments=parse(rawArguments),id 从 wire 取', async () => {
    const { events, final } = await replayFixture('tool');
    assertValidProviderEventSequence(events);
    // 空 partial_json("")不发事件;3 个非空分片 → 3 个 tool_call_delta
    expect(events.filter((e) => e.type === 'tool_call_delta')).toHaveLength(3);
    const types = events.map((e) => e.type);
    expect(types.indexOf('text_end')).toBeLessThan(types.indexOf('tool_call_start'));

    expect(final.content[0]).toEqual({ type: 'text', text: "I'll check the current time in Tokyo." });
    const calls = toolCallsOf(final);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.id).toBe('toolu_01Tq8GG8A5ZVGUiU5DBwNkzZ');   // wire id 原样保留
    expect(calls[0]?.name).toBe('get_time');
    expect(calls[0]?.rawArguments).toBe('{"timezone": "Asia/Tokyo"}');
    expect(calls[0]?.arguments).toEqual({ timezone: 'Asia/Tokyo' });
    expect(final.stopReason).toBe('tool_calls');
    // input=95+826(cache_creation)=921,output=72,cacheWrite=826
    expect(final.usage).toEqual({ input: 921, output: 72, cacheWrite: 826 });
  });

  it('thinking:ReasoningPart 带 signature + 后续 TextPart;reasoning usage 映射', async () => {
    const { events, final } = await replayFixture('thinking');
    assertValidProviderEventSequence(events);
    // signature_delta 不产生 provider 事件(块级元数据并入 signature),不破坏三段式文法
    expect(events.some((e) => (e.type as string) === 'signature_delta')).toBe(false);

    expect(final.content).toHaveLength(2);
    const reasoning = final.content[0];
    expect(reasoning?.type).toBe('reasoning');
    if (reasoning?.type === 'reasoning') {
      expect(reasoning.text).toBe(
        "I'm breaking down the multiplication: 17 times 23 becomes 17 times 20 plus 17 times 3, " +
        'which gives me 340 plus 51, totaling 391.',
      );
      expect(reasoning.signature).toMatch(/^CAIS/);   // 原样回传的加密签名
    }
    expect(final.content[1]).toEqual({ type: 'text', text: '17 × 20 = 340, plus 17 × 3 = 51 → **391**' });
    expect(final.stopReason).toBe('stop');
    // input=534,output=71,reasoning=thinking_tokens=42
    expect(final.usage).toEqual({ input: 534, output: 71, reasoning: 42 });
  });
});

describe('usage 换算单测(exclusive → inclusive,各形态断言不变量)', () => {
  async function replayUsage(messageStartUsage: unknown, messageDeltaUsage: unknown): Promise<AssistantMessage> {
    const lines: unknown[] = [
      { type: 'message_start', message: { usage: messageStartUsage } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: messageDeltaUsage },
      { type: 'message_stop' },
    ];
    const stream = consumeAnthropicStreamForTest(ref, compat, () => Promise.resolve(fixtureEvents(lines)));
    return (await collectStream(stream)).final;
  }

  it('input 含 cacheRead+cacheWrite(inclusive),明细字段照录', async () => {
    const final = await replayUsage(
      { input_tokens: 100, cache_read_input_tokens: 800, cache_creation_input_tokens: 50, output_tokens: 1 },
      { input_tokens: 100, cache_read_input_tokens: 800, cache_creation_input_tokens: 50, output_tokens: 250,
        output_tokens_details: { thinking_tokens: 40 } },
    );
    // input = 100 + 800 + 50 = 950(inclusive);不变量 cacheRead+cacheWrite ≤ input 成立
    expect(final.usage).toEqual({ input: 950, output: 250, cacheRead: 800, cacheWrite: 50, reasoning: 40 });
    expect((final.usage.cacheRead ?? 0) + (final.usage.cacheWrite ?? 0)).toBeLessThanOrEqual(final.usage.input);
    expect(final.usage.reasoning ?? 0).toBeLessThanOrEqual(final.usage.output);
  });

  it('缺失 usage 字段容忍:全 0 不产生 NaN,non-standard 扩展字段忽略', async () => {
    const final = await replayUsage(
      { input_tokens: 10, service_tier: 'standard', inference_geo: 'not_available',
        cache_creation: { ephemeral_5m_input_tokens: 0 } },
      { output_tokens: 5, iterations: [{ input_tokens: 10, output_tokens: 5 }] },
    );
    expect(final.usage).toEqual({ input: 10, output: 5 });   // 非标字段不污染;0 明细不落
  });

  it('output_tokens 仅在 message_delta 出现:input 侧由 message_start 定,output 侧由 delta 定', async () => {
    const final = await replayUsage(
      { input_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 3 },
      { output_tokens: 88, output_tokens_details: { thinking_tokens: 0 } },
    );
    expect(final.usage).toEqual({ input: 200, output: 88 });   // thinking 0 不落 reasoning
  });
});

describe('stop_reason 映射', () => {
  async function replayStop(stopReason: string): Promise<{ events: ProviderEvent[]; final: AssistantMessage }> {
    const lines: unknown[] = [
      { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ];
    const stream = consumeAnthropicStreamForTest(ref, compat, () => Promise.resolve(fixtureEvents(lines)));
    return collectStream(stream);
  }

  it.each([
    ['end_turn', 'stop'],
    ['stop_sequence', 'stop'],
    ['pause_turn', 'stop'],
    ['max_tokens', 'length'],
    ['tool_use', 'tool_calls'],
    ['refusal', 'content_filter'],
  ] as const)('%s → %s', async (wire, internal) => {
    const { final } = await replayStop(wire);
    expect(final.stopReason).toBe(internal);
  });

  it('model_context_window_exceeded → overflow error(截断交给 compaction)', async () => {
    const { events, final } = await replayStop('model_context_window_exceeded');
    assertValidProviderEventSequence(events);
    expect(events.at(-1)?.type).toBe('error');
    expect(final.stopReason).toBe('error');
    expect(final.errorMessage).toContain('model context window exceeded');
    expect(final.errorDetails).toMatchObject({ kind: 'overflow', retryable: false });
  });

  it('未知 stop_reason fail closed 为 unknown error,不把截断误报为成功', async () => {
    const { events, final } = await replayStop('some_new_reason');
    assertValidProviderEventSequence(events);
    expect(events.at(-1)?.type).toBe('error');
    expect(final.stopReason).toBe('error');
    expect(final.errorMessage).toContain("unknown stop_reason 'some_new_reason'");
    expect(final.errorDetails).toMatchObject({ kind: 'unknown', retryable: false });
  });

  it('流结束无 stop_reason:按 error 编码(残缺流,network 可重试)', async () => {
    const lines: unknown[] = [
      { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'cut' } },
      // 无 content_block_stop / message_delta / message_stop:流被腰斩
    ];
    const stream = consumeAnthropicStreamForTest(ref, compat, () => Promise.resolve(fixtureEvents(lines)));
    const { events, final } = await collectStream(stream);
    assertValidProviderEventSequence(events);
    expect(final.stopReason).toBe('error');
    expect(final.errorMessage).toContain('without stop_reason');
    expect(final.errorDetails).toMatchObject({ kind: 'network', retryable: true });
    expect(final.content).toEqual([{ type: 'text', text: 'cut' }]);   // 半截内容保留
  });
});

describe('铁律:错误注入逐一断言 streamFn 调用本身 never throws/rejects', () => {
  const cases: { name: string; err: () => Error; expectKind: string; retryable: boolean }[] = [
    {
      name: 'create() reject APIConnectionError(断网)',
      err: () => new Anthropic.APIConnectionError({ message: 'Connection error.' }),
      expectKind: 'network', retryable: true,
    },
    {
      name: '401 AuthenticationError(无效 apiKey)',
      err: () => Anthropic.APIError.generate(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 'invalid x-api-key', new Headers()),
      expectKind: 'auth', retryable: false,
    },
    {
      name: '404 NotFoundError(错误 baseURL 路径)',
      err: () => Anthropic.APIError.generate(404, { type: 'error', error: { type: 'not_found_error', message: 'not found' } }, 'not found', new Headers()),
      expectKind: 'http', retryable: false,
    },
    {
      name: '429 RateLimitError',
      err: () => Anthropic.APIError.generate(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 'slow down', new Headers({ 'retry-after': '2' })),
      expectKind: 'rate_limit', retryable: true,
    },
    {
      name: '500 InternalServerError',
      err: () => Anthropic.APIError.generate(500, { type: 'error', error: { type: 'api_error', message: 'boom' } }, 'boom', new Headers()),
      expectKind: 'http', retryable: true,
    },
    {
      name: '400 prompt is too long → overflow',
      err: () => Anthropic.APIError.generate(400, { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 250000 tokens > 200000 maximum' } }, 'prompt is too long: 250000 tokens > 200000 maximum', new Headers()),
      expectKind: 'overflow', retryable: false,
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const stream = consumeAnthropicStreamForTest(ref, compat, () => Promise.reject(c.err()));
      const { events, final } = await collectStream(stream);       // 零 try/catch:reject 即测试失败
      assertValidProviderEventSequence(events);
      expect(final.stopReason).toBe('error');
      expect(final.errorDetails).toMatchObject({ kind: c.expectKind, retryable: c.retryable });
      expect(Object.values(final.errorDetails ?? {})).not.toContain(undefined);
      expect(final.errorMessage).toBeTruthy();
    });
  }

  it('429 的 retry-after 头映射为 retryAfterMs', async () => {
    const err = Anthropic.APIError.generate(429, { type: 'error', error: { type: 'rate_limit_error', message: 'rl' } }, 'rl', new Headers({ 'retry-after': '3' }));
    const stream = consumeAnthropicStreamForTest(ref, compat, () => Promise.reject(err));
    const { final } = await collectStream(stream);
    expect(final.errorDetails?.retryAfterMs).toBe(3000);
  });

  it('SSE 迭代中原生断连(undici TypeError)→ network 可重试', async () => {
    async function* broken(): AsyncIterable<unknown> {
      yield { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } };
      throw new TypeError('terminated');
    }
    const stream = consumeAnthropicStreamForTest(ref, compat, () => Promise.resolve(broken()));
    const { events, final } = await collectStream(stream);
    assertValidProviderEventSequence(events);
    expect(final.stopReason).toBe('error');
    expect(final.errorDetails).toMatchObject({ kind: 'network', retryable: true });
  });
});

describe('abort 感知:保留 partial,stopReason aborted,不设 errorMessage', () => {
  it('流中途 abort:APIUserAbortError → aborted,半截文本保留', async () => {
    async function* aborting(): AsyncIterable<unknown> {
      yield { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Half' } };
      throw new Anthropic.APIUserAbortError();
    }
    const ac = new AbortController();
    ac.abort();
    const stream = consumeAnthropicStreamForTest(ref, compat, () => Promise.resolve(aborting()), ac.signal);
    const { events, final } = await collectStream(stream);
    assertValidProviderEventSequence(events);
    expect(final.stopReason).toBe('aborted');
    expect(final.errorMessage).toBeUndefined();
    expect(final.errorDetails).toEqual({ kind: 'aborted', retryable: false });
    expect(final.content).toEqual([{ type: 'text', text: 'Half' }]);
  });

  it('流中途 abort(迭代器 clean return 不 throw)→ stopReason aborted', async () => {
    const ac = new AbortController();
    async function* cleanReturn(): AsyncIterable<unknown> {
      yield { type: 'message_start', message: { usage: { input_tokens: 2, output_tokens: 0 } } };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'half ' } };
      ac.abort();
      return;                                          // clean return,不 throw、无 stop_reason
    }
    const stream = consumeAnthropicStreamForTest(ref, compat, () => Promise.resolve(cleanReturn()), ac.signal);
    const { events, final } = await collectStream(stream);
    assertValidProviderEventSequence(events);
    expect(final.stopReason).toBe('aborted');           // 不得被编码为可重试 network error
    expect(final.errorDetails).toEqual({ kind: 'aborted', retryable: false });
    expect(final.content).toEqual([{ type: 'text', text: 'half ' }]);
  });
});
