// 入站解析测试:SSE chunk fixture 回放(见 docs/10-testing.md)+ 错误路径单测。
// fixture 回放与生产路径走同一条 runChatStream 管线,只是 chunks 来源不同。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';
import OpenAI from 'openai';
import type { AssistantMessage, ModelRef, ProviderEvent, ToolCallPart } from '../../protocol/index.js';
import { assertValidProviderEventSequence, collectStream } from '../../../tests/helpers/provider-events.js';
import { assertToolCallPairing } from '../../../tests/helpers/wire-pairing.js';
import { detectCompat, type ResolvedCompat } from './compat.js';
import { convertMessages, consumeChatStreamForTest } from './index.js';

const ref: ModelRef = { provider: 'openai', api: 'openai-chat', model: 'test-model' };
const openaiCompat = detectCompat(undefined);                     // OpenAI 全开 profile
const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__');

function readFixtureLines(name: string): unknown[] {
  return readFileSync(path.join(fixturesDir, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as unknown);
}

/** 模拟 SDK 的 SSE 层:逐行让出微任务;data 行带 error 字段 → throw APIError(SDK 同款行为)。 */
async function* fixtureChunks(lines: unknown[]): AsyncIterable<unknown> {
  for (const line of lines) {
    await Promise.resolve();
    const obj = line as Record<string, unknown>;
    if (obj !== null && typeof obj === 'object' && obj['error']) {
      const e = obj['error'] as { message?: string };
      throw new OpenAI.APIError(undefined as never, obj['error'], e.message, undefined as never);
    }
    yield line;
  }
}

async function replayFixture(
  name: string,
  compat: ResolvedCompat = openaiCompat,
): Promise<{ events: ProviderEvent[]; final: AssistantMessage }> {
  const lines = readFixtureLines(name);
  const stream = consumeChatStreamForTest(ref, compat, () => Promise.resolve(fixtureChunks(lines)));
  return collectStream(stream);
}

function toolCallsOf(final: AssistantMessage): ToolCallPart[] {
  return final.content.filter((p): p is ToolCallPart => p.type === 'tool_call');
}

describe('fixture 回放(全部产出合法事件序列)', () => {
  it('basic-text:三段式文本流,stopReason stop,usage 映射', async () => {
    const { events, final } = await replayFixture('basic-text');
    assertValidProviderEventSequence(events);
    expect(events.map((e) => e.type)).toEqual([
      'start', 'text_start', 'text_delta', 'text_delta', 'text_delta', 'text_end', 'done',
    ]);
    expect(final.content).toEqual([{ type: 'text', text: 'Hello world!' }]);
    expect(final.stopReason).toBe('stop');
    expect(final.usage).toEqual({ input: 12, output: 3 });
  });

  it('parallel-tool-calls:按 index 定位槽位不串包,同 chunk 双 index,arguments 逐段拼接', async () => {
    const { events, final } = await replayFixture('parallel-tool-calls');
    assertValidProviderEventSequence(events);
    // 流式期间容错解析持续刷新:第一个 tool_call_delta('{"path":')后 partial 中已是 { path: null }
    const firstDelta = events.find((e) => e.type === 'tool_call_delta');
    if (firstDelta?.type === 'tool_call_delta') {
      expect(firstDelta.delta).toBe('{"path":');
    }
    const calls = toolCallsOf(final);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ id: 'call_a', name: 'read', arguments: { path: 'a.ts' } });
    expect(calls[0]?.rawArguments).toBe('{"path":"a.ts"}');
    expect(calls[1]).toMatchObject({ id: 'call_b', name: 'grep', arguments: { pattern: 'x' } });
    expect(final.stopReason).toBe('tool_calls');
    expect(events.filter((e) => e.type === 'tool_call_end')).toHaveLength(2);
  });

  it('usage-chunk:空 choices 的 usage chunk 不 crash,inclusive 口径映射明细字段', async () => {
    const { events, final } = await replayFixture('usage-chunk');
    assertValidProviderEventSequence(events);
    expect(final.stopReason).toBe('stop');
    expect(final.usage).toEqual({ input: 1000, output: 250, cacheRead: 800, cacheWrite: 100, reasoning: 200 });
  });

  it('usage-missing:无 usage chunk 时保持全 0,无 NaN,done 正常', async () => {
    const { events, final } = await replayFixture('usage-missing');
    assertValidProviderEventSequence(events);
    expect(final.usage).toEqual({ input: 0, output: 0 });
    expect(final.stopReason).toBe('stop');
  });

  it('length-truncated:照常产出 ToolCallPart,rawArguments 保留截断现场,stopReason length', async () => {
    const { events, final } = await replayFixture('length-truncated');
    assertValidProviderEventSequence(events);
    const calls = toolCallsOf(final);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.rawArguments).toBe('{"path":"a.ts","old_string":"foo');
    expect(calls[0]?.arguments).toEqual({ path: 'a.ts', old_string: 'foo' });   // 容错解析结果
    expect(final.stopReason).toBe('length');   // 不执行是 loop 层的事,adapter 不隐藏
  });

  it('in-band-error:data 行 error → error 事件,已流出内容保留,errorDetails 分类', async () => {
    const { events, final } = await replayFixture('in-band-error');
    assertValidProviderEventSequence(events);
    expect(events.at(-1)?.type).toBe('error');
    expect(final.stopReason).toBe('error');
    expect(final.errorMessage).toContain('server had an error');
    // in-band server_error 是可重试的瞬时故障;code 从 error 体读取。
    expect(final.errorDetails).toMatchObject({ kind: 'http', retryable: true, code: 'internal_error' });
    expect(final.content).toEqual([{ type: 'text', text: 'part' }]);   // 半截内容保留
  });

  it('missing-tool-call-id:兜底生成 call_ 前缀 id,同槽位归并,两次回放 id 不冲突', async () => {
    const r1 = await replayFixture('missing-tool-call-id');
    const r2 = await replayFixture('missing-tool-call-id');
    assertValidProviderEventSequence(r1.events);
    const c1 = toolCallsOf(r1.final);
    expect(c1).toHaveLength(1);                                  // 同槽位后续 delta 归并,不裂成两个
    expect(c1[0]?.id).toMatch(/^call_/);
    expect(c1[0]?.arguments).toEqual({ path: 'x' });
    expect(c1[0]?.id).not.toBe(toolCallsOf(r2.final)[0]?.id);    // 兜底 id 不冲突

    // 出站回传:兜底 id 仍可正确配对。
    const call = c1[0] as ToolCallPart;
    const wire = convertMessages({
      messages: [
        r1.final,
        { role: 'tool_result', id: 'tr', timestamp: 1, toolCallId: call.id, toolName: call.name,
          content: [{ type: 'text', text: 'ok' }], isError: false },
      ],
    }, openaiCompat);
    assertToolCallPairing(wire);
  });

  it('reasoning-content:方言开启时产出 ReasoningPart 三段式;关闭时忽略不 crash', async () => {
    const on = await replayFixture('reasoning-content');
    assertValidProviderEventSequence(on.events);
    expect(on.final.content).toEqual([
      { type: 'reasoning', text: '先想一想' },
      { type: 'text', text: '答案是 42' },
    ]);
    expect(on.events.filter((e) => e.type.startsWith('reasoning_')).length).toBeGreaterThan(2);

    expect(on.final.stopReason).toBe('stop');
    const off = await replayFixture('reasoning-content', { ...openaiCompat, supportsReasoning: false });
    assertValidProviderEventSequence(off.events);
    expect(off.final.content).toEqual([{ type: 'text', text: '答案是 42' }]);
  });

  it('empty-choices-keepalive:中途空 choices 静默忽略,后续 chunk 正常', async () => {
    const { events, final } = await replayFixture('empty-choices-keepalive');
    assertValidProviderEventSequence(events);
    expect(final.stopReason).toBe('stop');
    expect(final.usage).toEqual({ input: 0, output: 0 });
    expect(final.content).toEqual([{ type: 'text', text: 'ab' }]);
  });

  it('text-then-tool:contentIndex 递进,text_end 在 tool_call_start 之前', async () => {
    const { events, final } = await replayFixture('text-then-tool');
    assertValidProviderEventSequence(events);
    expect(final.content[0]).toEqual({ type: 'text', text: '我来查一下。' });
    expect(final.content[1]?.type).toBe('tool_call');
    expect(final.stopReason).toBe('tool_calls');
    const types = events.map((e) => e.type);
    expect(types.indexOf('text_end')).toBeLessThan(types.indexOf('tool_call_start'));
  });

  it('interleaved-tool-calls:index 0→1→0 迟到分片,最终 arguments 恒等于 parse(rawArguments)', async () => {
    const { events, final } = await replayFixture('interleaved-tool-calls');
    // 事件层:块 0 已 end,迟到分片不再发事件(文法保持合法)
    assertValidProviderEventSequence(events);
    const calls = toolCallsOf(final);
    expect(calls).toHaveLength(2);
    // 关键断言:迟到分片并入后最终解析,arguments 与完整 raw 一致(官方累积器同款结果)
    expect(calls[0]?.rawArguments).toBe('{"path":"a.ts"}');
    expect(calls[0]?.arguments).toEqual({ path: 'a.ts' });
    expect(calls[1]?.arguments).toEqual({ pattern: 'x' });
  });

  it('content-filter:走 done 分支正常收尾,stopReason content_filter', async () => {
    const { events, final } = await replayFixture('content-filter');
    assertValidProviderEventSequence(events);
    expect(events.at(-1)?.type).toBe('done');
    expect(final.stopReason).toBe('content_filter');
  });
});

describe('真实录制方言回归(kimi-k3 via opencode zen gateway,2026-07-27 录制)', () => {
  // 方言特征:reasoning_content 扩展、非 call_ 前缀的 tool id、网关自定义
  // x-opencode-type 空 choices chunk、结尾标准 usage chunk。
  const gatewayCompat: ResolvedCompat = {
    ...detectCompat('https://opencode.ai/zen/go/v1'),   // 保守 profile
    supportsUsageInStreaming: true,
  };

  it('recorded-kimi-text:reasoning_content 三段式 + 文本 + usage,自定义 chunk 容忍', async () => {
    const { events, final } = await replayFixture('recorded-kimi-text', gatewayCompat);
    assertValidProviderEventSequence(events);
    expect(final.stopReason).toBe('stop');
    expect(final.content.some((p) => p.type === 'reasoning')).toBe(true);
    expect(final.content.some((p) => p.type === 'text')).toBe(true);
    expect(final.usage.input).toBeGreaterThan(0);
    expect(final.usage.reasoning).toBeGreaterThan(0);
  });

  it('recorded-kimi-tool:工具调用方言(非 call_ 前缀 id)正确归并', async () => {
    const { events, final } = await replayFixture('recorded-kimi-tool', gatewayCompat);
    assertValidProviderEventSequence(events);
    expect(final.stopReason).toBe('tool_calls');
    const calls = toolCallsOf(final);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('get_time');
    expect(calls[0]?.arguments).toMatchObject({ timezone: expect.stringContaining('Tokyo') as unknown });
    expect(calls[0]?.id).toBeTruthy();   // 方言 id 原样保留(如 get_time_0),不强改 call_ 前缀
  });
});

describe('铁律:错误注入方式逐一断言 streamFn 调用本身 never throws/rejects', () => {
  const cases: { name: string; err: () => Error; expectKind: string; retryable: boolean }[] = [
    {
      name: 'create() reject APIConnectionError(断网)',
      err: () => new OpenAI.APIConnectionError({ message: 'Connection error.' }),
      expectKind: 'network', retryable: true,
    },
    {
      name: '401 AuthenticationError(无效 apiKey)',
      err: () => OpenAI.APIError.generate(401, { error: { message: 'Incorrect API key' } }, 'Incorrect API key', new Headers()),
      expectKind: 'auth', retryable: false,
    },
    {
      name: '404 NotFoundError(错误 baseURL 路径)',
      err: () => OpenAI.APIError.generate(404, { error: { message: 'Not found' } }, 'Not found', new Headers()),
      expectKind: 'http', retryable: false,
    },
    {
      name: '429 RateLimitError',
      err: () => OpenAI.APIError.generate(429, { error: { message: 'Rate limit' } }, 'Rate limit', new Headers({ 'retry-after': '2' })),
      expectKind: 'rate_limit', retryable: true,
    },
    {
      name: '500 InternalServerError',
      err: () => OpenAI.APIError.generate(500, { error: { message: 'boom' } }, 'boom', new Headers()),
      expectKind: 'http', retryable: true,
    },
    {
      name: '400 context_length_exceeded → overflow',
      err: () => OpenAI.APIError.generate(400, { error: { message: "This model's maximum context length is exceeded", code: 'context_length_exceeded' } }, 'context length', new Headers()),
      expectKind: 'overflow', retryable: false,
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const stream = consumeChatStreamForTest(ref, openaiCompat, () => Promise.reject(c.err()));
      const { events, final } = await collectStream(stream);       // 零 try/catch:reject 即测试失败
      assertValidProviderEventSequence(events);
      expect(final.stopReason).toBe('error');
      expect(final.errorDetails).toMatchObject({ kind: c.expectKind, retryable: c.retryable });
      expect(Object.values(final.errorDetails ?? {})).not.toContain(undefined);
      expect(final.errorMessage).toBeTruthy();
    });
  }

  it('429 的 retry-after 头映射为 retryAfterMs', async () => {
    const err = OpenAI.APIError.generate(429, { error: { message: 'rl' } }, 'rl', new Headers({ 'retry-after': '3' }));
    const stream = consumeChatStreamForTest(ref, openaiCompat, () => Promise.reject(err));
    const { final } = await collectStream(stream);
    expect(final.errorDetails?.retryAfterMs).toBe(3000);
  });

  it('流中途 abort:APIUserAbortError → stopReason aborted,半截文本保留,不设 errorMessage', async () => {
    const lines = readFixtureLines('basic-text');
    async function* abortingChunks(): AsyncIterable<unknown> {
      yield lines[0];
      yield lines[1];                                   // "Hello"
      throw new OpenAI.APIUserAbortError();
    }
    const ac = new AbortController();
    ac.abort();
    const stream = consumeChatStreamForTest(ref, openaiCompat, () => Promise.resolve(abortingChunks()), ac.signal);
    const { events, final } = await collectStream(stream);
    assertValidProviderEventSequence(events);
    expect(final.stopReason).toBe('aborted');
    expect(final.errorMessage).toBeUndefined();
    expect(final.errorDetails).toEqual({ kind: 'aborted', retryable: false });
    expect(final.content).toEqual([{ type: 'text', text: 'Hello' }]);
  });

  it('流中途 abort(SDK v6 真实形态:迭代器 clean return 不 throw)→ stopReason aborted', async () => {
    // openai v6 的 SSE 迭代器捕获 AbortError 后静默 return——不会抛 APIUserAbortError。
    // 本用例忠实模拟该形态:signal aborted + 迭代器提前正常结束、无 finish_reason。
    const ac = new AbortController();
    async function* cleanReturn(): AsyncIterable<unknown> {
      yield { choices: [{ index: 0, delta: { content: 'half ' }, finish_reason: null }] };
      ac.abort();
      return;                                          // clean return,不 throw
    }
    const stream = consumeChatStreamForTest(ref, openaiCompat, () => Promise.resolve(cleanReturn()), ac.signal);
    const { events, final } = await collectStream(stream);
    assertValidProviderEventSequence(events);
    expect(final.stopReason).toBe('aborted');           // 不得被编码为可重试 network error
    expect(final.errorDetails).toEqual({ kind: 'aborted', retryable: false });
    expect(final.content).toEqual([{ type: 'text', text: 'half ' }]);
  });

  it('SSE 迭代中原生断连(undici TypeError)→ network 可重试', async () => {
    async function* broken(): AsyncIterable<unknown> {
      yield { choices: [{ index: 0, delta: { content: 'x' }, finish_reason: null }] };
      throw new TypeError('terminated');
    }
    const stream = consumeChatStreamForTest(ref, openaiCompat, () => Promise.resolve(broken()));
    const { final } = await collectStream(stream);
    expect(final.stopReason).toBe('error');
    expect(final.errorDetails).toMatchObject({ kind: 'network', retryable: true });
  });

  it('function_call 旧方言:delta.function_call 累积为 tool slot,与 finish_reason 一致', async () => {
    async function* legacy(): AsyncIterable<unknown> {
      yield { choices: [{ index: 0, delta: { function_call: { name: 'get_time', arguments: '{"tz":' } }, finish_reason: null }] };
      yield { choices: [{ index: 0, delta: { function_call: { arguments: '"UTC"}' } }, finish_reason: null }] };
      yield { choices: [{ index: 0, delta: {}, finish_reason: 'function_call' }] };
    }
    const stream = consumeChatStreamForTest(ref, openaiCompat, () => Promise.resolve(legacy()));
    const { events, final } = await collectStream(stream);
    assertValidProviderEventSequence(events);
    expect(final.stopReason).toBe('tool_calls');
    const calls = toolCallsOf(final);
    expect(calls).toHaveLength(1);                      // 声称支持就必须有 ToolCallPart,不许空转录
    expect(calls[0]).toMatchObject({ name: 'get_time', arguments: { tz: 'UTC' } });
    expect(calls[0]?.id).toMatch(/^call_/);
  });

  it('delta.refusal 并入 text 通道(转录永远完整)', async () => {
    async function* refusal(): AsyncIterable<unknown> {
      yield { choices: [{ index: 0, delta: { refusal: 'I cannot ' }, finish_reason: null }] };
      yield { choices: [{ index: 0, delta: { refusal: 'help with that.' }, finish_reason: null }] };
      yield { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
    }
    const stream = consumeChatStreamForTest(ref, openaiCompat, () => Promise.resolve(refusal()));
    const { final } = await collectStream(stream);
    expect(final.content).toEqual([{ type: 'text', text: 'I cannot help with that.' }]);
  });

  it('流结束无 finish_reason:按 error 编码(残缺流,network 可重试)', async () => {
    async function* truncated(): AsyncIterable<unknown> {
      yield { choices: [{ index: 0, delta: { content: 'cut ' }, finish_reason: null }] };
    }
    const stream = consumeChatStreamForTest(ref, openaiCompat, () => Promise.resolve(truncated()));
    const { events, final } = await collectStream(stream);
    assertValidProviderEventSequence(events);
    expect(final.stopReason).toBe('error');
    expect(final.errorMessage).toContain('without finish_reason');
    expect(final.errorDetails).toMatchObject({ kind: 'network', retryable: true });
    expect(final.content).toEqual([{ type: 'text', text: 'cut ' }]);
  });
});
