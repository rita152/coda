// faux provider 测试:事件语法自检 + StreamFn 铁律 + 属性测试
// (docs/10-testing.md 第 3 节、第 9 节 M1 验收;docs/03-internal-protocol.md 第 10 节)。
import { describe, expect, it, vi } from 'vitest';
import type { Context, ModelConfig, ProviderEvent } from '../../protocol/index.js';
import {
  assertValidProviderEventSequence,
  collectStream,
  foldDeltas,
  microtaskUntil,
} from '../../../tests/helpers/provider-events.js';
import { createFauxStreamFn, createGate, parsePartialJson } from './index.js';
import type { FauxScript } from './index.js';

const model: ModelConfig = { ref: { provider: 'faux', api: 'faux', model: 'faux-1' } };
const context: Context = {
  systemPrompt: 'sys',
  messages: [{ role: 'user', id: 'u1', timestamp: 1, content: [{ type: 'text', text: 'hi' }] }],
};

describe('createFauxStreamFn:基本回放', () => {
  it('text 剧本:事件文法合法、按 chunkSize 分片、最终消息与快照一致', async () => {
    const fn = createFauxStreamFn({
      turns: [{ events: [{ kind: 'text', text: 'hello world!', chunkSize: 5 }] }],
    });
    const { events, final } = await collectStream(fn(model, context));

    assertValidProviderEventSequence(events);
    expect(events.map((e) => e.type)).toEqual([
      'start', 'text_start', 'text_delta', 'text_delta', 'text_delta', 'text_end', 'done',
    ]);
    expect(final.content).toEqual([{ type: 'text', text: 'hello world!' }]);
    expect(final.stopReason).toBe('stop');
    expect(final.usage).toEqual({ input: 100, output: 10 });   // 缺省 usage
    expect(final.model).toEqual(model.ref);

    // 每个事件的 partial 是同一个逐步生长的对象;done.message 即最终形态
    for (const e of events) {
      const snapshot = e.type === 'done' || e.type === 'error' ? e.message : e.partial;
      expect(snapshot).toBe(final);
    }
  });

  it('reasoning + text 多块:contentIndex 递增,折叠 delta 等于块内容', async () => {
    const fn = createFauxStreamFn({
      turns: [{ events: [
        { kind: 'reasoning', text: '思考中……', chunkSize: 3 },
        { kind: 'text', text: '答案是 42' },
      ] }],
    });
    const { events, final } = await collectStream(fn(model, context));

    assertValidProviderEventSequence(events);
    expect(final.content).toEqual([
      { type: 'reasoning', text: '思考中……' },
      { type: 'text', text: '答案是 42' },
    ]);
    const folded = foldDeltas(events);
    expect(folded.get(0)).toBe('思考中……');
    expect(folded.get(1)).toBe('答案是 42');
  });

  it('tool_call 剧本:缺省 stopReason 推断为 tool_calls,arguments 解析、rawArguments 保留', async () => {
    const fn = createFauxStreamFn({
      turns: [{ events: [
        { kind: 'text', text: '我来读文件' },
        { kind: 'tool_call', name: 'read', args: { path: 'a.ts', offset: 1 }, id: 'call_1' },
      ] }],
    });
    const { events, final } = await collectStream(fn(model, context));

    assertValidProviderEventSequence(events);
    expect(final.stopReason).toBe('tool_calls');
    const end = events.find((e) => e.type === 'tool_call_end');
    expect(end && end.type === 'tool_call_end' ? end.toolCall : undefined).toMatchObject({
      id: 'call_1', name: 'read', arguments: { path: 'a.ts', offset: 1 },
    });
    // delta 折叠 == rawArguments == JSON.stringify(args)
    expect(foldDeltas(events).get(1)).toBe(JSON.stringify({ path: 'a.ts', offset: 1 }));
    // 流式期间 partial 中的 arguments 被容错解析持续刷新(最终等于完整参数)
    const part = final.content[1];
    expect(part?.type === 'tool_call' ? part.rawArguments : undefined).toBe(
      JSON.stringify({ path: 'a.ts', offset: 1 }),
    );
  });

  it('length 截断:truncatedRaw 写入 rawArguments,arguments 为容错解析结果', async () => {
    const truncated = '{"path":"a.ts","old_string":"foo';
    const fn = createFauxStreamFn({
      turns: [{
        events: [{ kind: 'tool_call', name: 'edit', args: {}, truncatedRaw: truncated }],
        stopReason: 'length',
      }],
    });
    const { events, final } = await collectStream(fn(model, context));

    assertValidProviderEventSequence(events);
    expect(final.stopReason).toBe('length');
    const end = events.find((e) => e.type === 'tool_call_end');
    const toolCall = end && end.type === 'tool_call_end' ? end.toolCall : undefined;
    expect(toolCall?.rawArguments).toBe(truncated);
    expect(toolCall?.arguments).toEqual({ path: 'a.ts', old_string: 'foo' });  // 容错解析
  });

  it('usage 覆盖与多 turn 剧本:第 n 次调用消费 turns[n]', async () => {
    const fn = createFauxStreamFn({
      turns: [
        { events: [{ kind: 'text', text: 'one' }], usage: { input: 7, cacheRead: 3 } },
        { events: [{ kind: 'text', text: 'two' }] },
      ],
    });
    const r1 = await collectStream(fn(model, context));
    const r2 = await collectStream(fn(model, context));
    expect(r1.final.usage).toEqual({ input: 7, output: 10, cacheRead: 3 });
    expect(r1.final.content).toEqual([{ type: 'text', text: 'one' }]);
    expect(r2.final.content).toEqual([{ type: 'text', text: 'two' }]);
  });
});

describe('StreamFn 铁律:错误也是流,绝不 throw', () => {
  it('error 剧本:先发内容再以 error 事件收尾,已流出内容保留,errorDetails 透传', async () => {
    const fn = createFauxStreamFn({
      turns: [{
        events: [{ kind: 'text', text: '流到一半' }],
        error: { message: 'boom', details: { kind: 'http', status: 500, retryable: true } },
      }],
    });
    // 调用方零 try/catch——若 streamFn throw/reject,本测试直接失败
    const { events, final } = await collectStream(fn(model, context));

    assertValidProviderEventSequence(events);
    expect(events.at(-1)?.type).toBe('error');
    expect(final.stopReason).toBe('error');
    expect(final.errorMessage).toBe('boom');
    expect(final.errorDetails).toEqual({ kind: 'http', status: 500, retryable: true });
    expect(final.content).toEqual([{ type: 'text', text: '流到一半' }]);  // 半截内容保留
  });

  it('result() 在错误场景 resolve(而非 reject)', async () => {
    const fn = createFauxStreamFn({ turns: [{ error: { message: 'x' } }] });
    const msg = await fn(model, context).result();   // 若 reject,await 会 throw 使测试失败
    expect(msg.stopReason).toBe('error');
  });

  it('脚本耗尽 onExhausted:"emptyStop" 回空 stop turn', async () => {
    const fn = createFauxStreamFn({ turns: [], onExhausted: 'emptyStop' });
    const { events, final } = await collectStream(fn(model, context));
    assertValidProviderEventSequence(events);
    expect(final.stopReason).toBe('stop');
    expect(final.content).toEqual([]);
  });
});

describe('铁律边角:不可克隆值、钩子异常、脚本耗尽', () => {
  it('context 携带不可克隆 details 时 streamFn 不 throw(铁律),calls 仍留档', async () => {
    const hostile: Context = {
      messages: [
        { role: 'user', id: 'u1', timestamp: 1, content: [{ type: 'text', text: 'hi' }] },
        {
          role: 'tool_result', id: 'tr1', timestamp: 2, toolCallId: 'tc1', toolName: 'x',
          content: [], isError: false,
          details: { fn: () => 'not cloneable', big: 10n },   // structuredClone 会对函数抛 DataCloneError
        },
      ],
    };
    const fn = createFauxStreamFn({ turns: [{ events: [{ kind: 'text', text: 'ok' }] }] });
    // 若 copyCall 直接 structuredClone,这一行会同步 throw——铁律测试
    const { events, final } = await collectStream(fn(model, hostile));
    assertValidProviderEventSequence(events);
    expect(final.stopReason).toBe('stop');
    expect(fn.calls).toHaveLength(1);
    expect(fn.calls[0]?.context.messages).toHaveLength(2);   // 降级拷贝仍然留档
  });

  it('onRequest 抛断言异常:经 failFn 上报测试层,流仍以合法 error 事件收尾', async () => {
    const failures: Error[] = [];
    const fn = createFauxStreamFn({
      turns: [{ events: [{ kind: 'text', text: 'never' }], onRequest: () => { throw new Error('assert failed'); } }],
      failFn: (e) => failures.push(e),
    });
    const { events, final } = await collectStream(fn(model, context));   // 不 throw
    assertValidProviderEventSequence(events);
    expect(final.stopReason).toBe('error');
    expect(final.errorMessage).toContain('onRequest hook threw');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toBe('assert failed');
  });

  it('脚本耗尽 onExhausted 缺省 "throw":经 failFn 上报,流仍合法收尾', async () => {
    const failures: Error[] = [];
    const fn = createFauxStreamFn({ turns: [], failFn: (e) => failures.push(e) });
    const { events, final } = await collectStream(fn(model, context));
    assertValidProviderEventSequence(events);
    expect(final.stopReason).toBe('error');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toContain('script exhausted');
  });

  it('error turn 尊重显式给出的 usage', async () => {
    const fn = createFauxStreamFn({
      turns: [{ error: { message: 'x' }, usage: { input: 50 } }],
    });
    const { final } = await collectStream(fn(model, context));
    expect(final.usage).toEqual({ input: 50, output: 10 });
  });

  it('chunkSize 非法值(0)不挂死,按 1 处理', async () => {
    const fn = createFauxStreamFn({
      turns: [{ events: [{ kind: 'text', text: 'abc', chunkSize: 0 }] }],
    });
    const { events, final } = await collectStream(fn(model, context));
    assertValidProviderEventSequence(events);
    expect(final.content).toEqual([{ type: 'text', text: 'abc' }]);
    expect(events.filter((e) => e.type === 'text_delta')).toHaveLength(3);
  });

  it('缺省 toolCallId 跨 turn 唯一(转录配对不歧义)', async () => {
    const fn = createFauxStreamFn({
      turns: [
        { events: [{ kind: 'tool_call', name: 'a', args: {} }] },
        { events: [{ kind: 'tool_call', name: 'b', args: {} }] },
      ],
    });
    const r1 = await collectStream(fn(model, context));
    const r2 = await collectStream(fn(model, context));
    const id1 = r1.final.content[0]?.type === 'tool_call' ? r1.final.content[0].id : undefined;
    const id2 = r2.final.content[0]?.type === 'tool_call' ? r2.final.content[0].id : undefined;
    expect(id1).toBeDefined();
    expect(id1).not.toBe(id2);
  });
});

describe('partial 快照的中间态(非恒真断言)', () => {
  it('流式期间逐事件深拷贝采样:快照单调生长,末份深等于最终消息', async () => {
    const fn = createFauxStreamFn({
      turns: [{ events: [
        { kind: 'text', text: 'hello world', chunkSize: 4 },
        { kind: 'tool_call', name: 'grep', args: { pattern: 'foo', limit: 10 } },
      ] }],
    });
    const stream = fn(model, context);
    const snapshots: unknown[] = [];
    const argSamples: { rawSoFar: string; args: unknown }[] = [];
    let rawSoFar = '';
    for await (const e of stream) {
      if (e.type === 'done' || e.type === 'error') {
        snapshots.push(structuredClone(e.message));
        continue;
      }
      snapshots.push(structuredClone(e.partial));
      if (e.type === 'tool_call_delta') {
        rawSoFar += e.delta;
        const part = e.partial.content[e.contentIndex];
        argSamples.push({
          rawSoFar,
          args: part?.type === 'tool_call' ? structuredClone(part.arguments) : undefined,
        });
      }
    }
    const final = await stream.result();

    // 末份快照深等于 done.message(M1 验收第 2 条的非恒真版本)
    expect(snapshots.at(-1)).toEqual(structuredClone(final));
    // 快照内容块数单调不减(前缀式生长)
    const lengths = snapshots.map((s) => (s as { content: unknown[] }).content.length);
    for (let i = 1; i < lengths.length; i++) {
      expect(lengths[i]).toBeGreaterThanOrEqual(lengths[i - 1] as number);
    }
    // 流式期间 arguments 被容错解析持续刷新:每一步都等于截至当前 raw 的解析结果
    expect(argSamples.length).toBeGreaterThan(1);
    for (const sample of argSamples) {
      expect(sample.args).toEqual(parsePartialJson(sample.rawSoFar));
    }
    // 最终参数与 raw 一致
    const toolPart = final.content[1];
    expect(toolPart?.type === 'tool_call' ? toolPart.arguments : undefined)
      .toEqual({ pattern: 'foo', limit: 10 });
  });
});

describe('abort 与 gate', () => {
  it('gate:流悬停直到测试放行(受控注入点)', async () => {
    const gate = createGate();
    const fn = createFauxStreamFn({
      turns: [{ events: [
        { kind: 'text', text: 'before' },
        { kind: 'gate', gate },
        { kind: 'text', text: 'after' },
      ] }],
    });
    const stream = fn(model, context);
    const seen: ProviderEvent[] = [];
    const consumer = (async () => { for await (const e of stream) seen.push(e); })();

    await microtaskUntil(() => seen.some((e) => e.type === 'text_end'));
    for (let i = 0; i < 50; i++) await Promise.resolve();   // 充分排空微任务
    expect(seen.filter((e) => e.type === 'text_start')).toHaveLength(1);  // 第二块未开始

    gate.open();
    await consumer;
    assertValidProviderEventSequence(seen);
    expect((await stream.result()).content).toEqual([
      { type: 'text', text: 'before' },
      { type: 'text', text: 'after' },
    ]);
  });

  it('gate 等待中 abort:以 aborted 收尾,已发内容保留', async () => {
    const gate = createGate();   // 永不 open
    const ac = new AbortController();
    const fn = createFauxStreamFn({
      turns: [{ events: [
        { kind: 'text', text: 'partial output' },
        { kind: 'gate', gate },
        { kind: 'text', text: 'never' },
      ] }],
    });
    const stream = fn(model, context, { signal: ac.signal });
    const seen: ProviderEvent[] = [];
    const consumer = (async () => { for await (const e of stream) seen.push(e); })();

    await microtaskUntil(() => seen.some((e) => e.type === 'text_end'));
    ac.abort();
    await consumer;
    const final = await stream.result();

    expect(seen.at(-1)?.type).toBe('error');
    expect(final.stopReason).toBe('aborted');
    expect(final.errorDetails).toEqual({ kind: 'aborted', retryable: false });
    expect(final.content).toEqual([{ type: 'text', text: 'partial output' }]);
    // error 路径允许截断,但本例中块已闭合,整条流仍应合法
    assertValidProviderEventSequence(seen);
  });

  it('发射间隙 abort:未 gate 也能及时中断(块可截断)', async () => {
    const ac = new AbortController();
    const fn = createFauxStreamFn({
      turns: [{ events: [{ kind: 'text', text: 'x'.repeat(400), chunkSize: 1 }] }],
    });
    const stream = fn(model, context, { signal: ac.signal });
    const seen: ProviderEvent[] = [];
    const consumer = (async () => {
      for await (const e of stream) {
        seen.push(e);
        if (seen.filter((x) => x.type === 'text_delta').length === 3) ac.abort();
      }
    })();
    await consumer;
    const final = await stream.result();
    expect(final.stopReason).toBe('aborted');
    expect(seen.at(-1)?.type).toBe('error');
    expect(seen.filter((e) => e.type === 'text_delta').length).toBeLessThan(400);
  });
});

describe('calls 留档与 onRequest', () => {
  it('calls 深拷贝调用参数,signal 剥离,与原对象隔离', async () => {
    const ac = new AbortController();
    const fn = createFauxStreamFn({ turns: [{ events: [{ kind: 'text', text: 'ok' }] }] });
    const liveContext: Context = structuredClone(context);
    await collectStream(fn(model, liveContext, { signal: ac.signal, temperature: 0.5 }));

    expect(fn.calls).toHaveLength(1);
    expect(fn.calls[0]?.context).toEqual(liveContext);
    expect(fn.calls[0]?.options).toEqual({ temperature: 0.5 });   // signal 已剥离

    liveContext.messages.push({ role: 'user', id: 'u2', timestamp: 2, content: [] });
    expect(fn.calls[0]?.context.messages).toHaveLength(1);        // 深拷贝:事后突变不影响留档
  });

  it('onRequest 钩子收到本次调用参数', async () => {
    const onRequest = vi.fn();
    const fn = createFauxStreamFn({ turns: [{ events: [], onRequest }] });
    await collectStream(fn(model, context, { temperature: 1 }));
    expect(onRequest).toHaveBeenCalledTimes(1);
    expect(onRequest).toHaveBeenCalledWith(model, context, { temperature: 1 });
  });
});

describe('属性测试:随机剧本折叠一致性', () => {
  // 固定种子的伪随机(mulberry32),保证确定性——CI 不接受 flake
  function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('随机事件剧本:文法恒合法,delta 折叠恒等于最终消息内容', async () => {
    const rand = mulberry32(20260726);
    for (let round = 0; round < 25; round++) {
      const specs: FauxScript['turns'][number]['events'] = [];
      const blockCount = 1 + Math.floor(rand() * 4);
      for (let b = 0; b < blockCount; b++) {
        const roll = rand();
        const text = 'x'.repeat(1 + Math.floor(rand() * 40));
        const chunkSize = 1 + Math.floor(rand() * 7);
        if (roll < 0.4) specs.push({ kind: 'text', text, chunkSize });
        else if (roll < 0.7) specs.push({ kind: 'reasoning', text, chunkSize });
        else specs.push({ kind: 'tool_call', name: 'grep', args: { pattern: text, deep: { n: b } } });
      }
      const fn = createFauxStreamFn({ turns: [{ events: specs }] });
      const { events, final } = await collectStream(fn(model, context));

      assertValidProviderEventSequence(events);
      const folded = foldDeltas(events);
      final.content.forEach((part, i) => {
        if (part.type === 'text' || part.type === 'reasoning') {
          expect(folded.get(i)).toBe(part.text);
        } else if (part.type === 'tool_call') {
          expect(folded.get(i)).toBe(part.rawArguments);
          expect(part.arguments).toEqual(JSON.parse(part.rawArguments ?? '{}'));
        }
      });
    }
  });
});

describe('parsePartialJson(容错解析)', () => {
  it.each([
    ['', {}],
    ['{', {}],
    ['{"a"', {}],
    ['{"a":', { a: null }],
    ['{"a":1', { a: 1 }],
    ['{"a":1,', { a: 1 }],
    ['{"a":"b', { a: 'b' }],
    ['{"a":"b\\', { a: 'b' }],
    ['{"a":{"b":[1,2', { a: { b: [1, 2] } }],
    ['{"a":1}', { a: 1 }],
    ['[1,2]', {}],            // 非对象顶层:返回 {}
    ['not json', {}],
  ])('parsePartialJson(%j) → %j', (input, expected) => {
    expect(parsePartialJson(input)).toEqual(expected);
  });
});
