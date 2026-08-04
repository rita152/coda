// EventStream 语义测试，覆盖 docs/04-provider-adapter.md“流”的 non-throwing terminal contract。
import { afterEach, describe, expect, it, vi } from 'bun:test';
import { EventStream } from './event-stream.js';
import type { AssistantMessage } from './messages.js';
import { ProviderEventStream } from './provider.js';

async function collect<T, R>(stream: EventStream<T, R>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('EventStream', () => {
  it('push → 迭代:FIFO 顺序(先 push 后迭代)', async () => {
    const s = new EventStream<string, string>();
    s.push('a');
    s.push('b');
    s.push('c');
    s.end('done');
    expect(await collect(s)).toEqual(['a', 'b', 'c']);
  });

  it('先 await 后 push 的零延迟路径', async () => {
    const s = new EventStream<string, string>();
    const consumer = collect(s);
    await Promise.resolve();          // 消费者先挂起等待
    s.push('a');
    s.push('b');
    s.end('done');
    expect(await consumer).toEqual(['a', 'b']);
  });

  it('end() 已调用但 buffer 未空:先吐完 buffer 再 done', async () => {
    const s = new EventStream<string, string>();
    s.push('a');
    s.push('b');
    s.end('r');                       // end 时无消费者,事件仍在 buffer
    expect(await collect(s)).toEqual(['a', 'b']);
    expect(await s.result()).toBe('r');
  });

  it('end() 使进行中的迭代收到 done,并 resolve result()', async () => {
    const s = new EventStream<string, string>();
    const consumer = collect(s);
    const result = s.result();
    s.end('final');
    expect(await consumer).toEqual([]);
    expect(await result).toBe('final');
  });

  it('result():end 前调用挂起,多次调用返回同一个 Promise', async () => {
    const s = new EventStream<string, string>();
    const p1 = s.result();
    const p2 = s.result();
    expect(p1).toBe(p2);              // 缓存的同一 Promise
    let resolved = false;
    void p1.then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);     // end 前 pending
    s.end('r');
    expect(await p1).toBe('r');
    expect(s.result()).toBe(p1);      // end 后仍是同一个
  });

  it('end 后 push 被忽略并产生开发警告', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = new EventStream<string, string>();
    s.push('a');
    s.end('r');
    s.push('b');                      // 忽略
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await collect(s)).toEqual(['a']);
  });

  it('end 只生效一次,第二次忽略 + 警告,result 保持第一次的值', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = new EventStream<string, string>();
    s.end('first');
    s.end('second');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await s.result()).toBe('first');
  });

  it('消费者 break 提前退出:不消费剩余事件、不终止流,result() 仍可用', async () => {
    const s = new EventStream<string, string>();
    s.push('a');
    s.push('b');
    s.push('c');
    const seen: string[] = [];
    for await (const e of s) {
      seen.push(e);
      if (seen.length === 1) break;   // 触发迭代器 return()
    }
    expect(seen).toEqual(['a']);
    s.push('d');                      // 生产者不受影响
    s.end('r');
    expect(await s.result()).toBe('r');
    // break 后再次迭代:剩余事件仍在队列(单消费者语义,break 不吞事件)
    expect(await collect(s)).toEqual(['b', 'c', 'd']);
  });

  it('迭代器永不 throw:错误以事件形态经过循环体', async () => {
    const s = new EventStream<{ type: string }, string>();
    s.push({ type: 'error' });
    s.end('r');
    const types: string[] = [];
    // 无 try/catch——若迭代器 throw,本测试直接失败
    for await (const e of s) types.push(e.type);
    expect(types).toEqual(['error']);
  });

  it('交错时序:push 与 await 交替,顺序保持', async () => {
    const s = new EventStream<number, string>();
    const it1 = s[Symbol.asyncIterator]();
    s.push(1);
    const r1 = await it1.next();
    const p2 = it1.next();            // 先挂起
    s.push(2);
    const r2 = await p2;
    s.end('r');
    const r3 = await it1.next();
    expect([r1.value, r2.value, r3.done]).toEqual([1, 2, true]);
  });

  it('迭代器被放弃时清理 pending waiter:race+return 后 push 的事件不被吞', async () => {
    const s = new EventStream<string, string>();
    const it1 = s[Symbol.asyncIterator]();
    const abandoned = it1.next();            // 注册 waiter 后被放弃(Promise.race 输掉的形态)
    await it1.return?.();                    // break 触发 return():必须摘除残留 waiter
    s.push('x');                             // 若 waiter 残留,'x' 会被投递给无人读取的 Promise
    s.end('r');
    expect(await collect(s)).toEqual(['x']); // 事件仍可被后续消费者取到
    expect((await abandoned).done).toBe(true); // 被放弃的 next() 以 done 决议,不悬挂
  });

  it('return() 后迭代器关闭:后续 next() 恒 done(async iterator 协议)', async () => {
    const s = new EventStream<string, string>();
    s.push('a');
    const it1 = s[Symbol.asyncIterator]();
    await it1.return?.();
    expect((await it1.next()).done).toBe(true);   // buffer 里还有 'a',但本迭代器已关闭
    s.end('r');
    expect(await collect(s)).toEqual(['a']);      // 事件留给下一个消费者
  });

  it('多个并发 pending next():push 按 FIFO 投递,end() 冲刷全部 waiter', async () => {
    const s = new EventStream<string, string>();
    const it1 = s[Symbol.asyncIterator]();
    const p1 = it1.next();
    const p2 = it1.next();            // waiters.length === 2
    s.push('a');
    s.push('b');
    expect((await p1).value).toBe('a');
    expect((await p2).value).toBe('b');
    const p3 = it1.next();
    const p4 = it1.next();
    s.end('r');                       // 同时 done 两个挂起的 waiter
    expect((await p3).done).toBe(true);
    expect((await p4).done).toBe(true);
  });

  it('多迭代器互偷(文档化语义):共享同一队列,end 后双方均 done', async () => {
    const s = new EventStream<string, string>();
    const it1 = s[Symbol.asyncIterator]();
    const it2 = s[Symbol.asyncIterator]();
    s.push('a');
    s.push('b');
    expect((await it1.next()).value).toBe('a');   // it1 偷走第一个
    expect((await it2.next()).value).toBe('b');   // it2 偷走第二个
    s.end('r');
    expect((await it1.next()).done).toBe(true);
    expect((await it2.next()).done).toBe(true);
  });

  it('无背压:大量 push 无消费者,buffer 无上界,随后 FIFO 全量排空', async () => {
    const s = new EventStream<number, string>();
    const N = 10_000;
    for (let i = 0; i < N; i++) s.push(i);
    s.end('r');
    const out = await collect(s);
    expect(out).toHaveLength(N);
    expect(out[0]).toBe(0);
    expect(out[N - 1]).toBe(N - 1);
    expect(out.every((v, i) => v === i)).toBe(true);
  });

  it('永不 reject:next()/result() 的 Promise 在任何状态下都不进入 rejected', async () => {
    const s = new EventStream<string, string>();
    const rejections: unknown[] = [];
    const guard = <T>(p: Promise<T>): Promise<T | undefined> =>
      p.catch((e: unknown) => { rejections.push(e); return undefined; });

    void guard(s.result());
    const it1 = s[Symbol.asyncIterator]();
    void guard(it1.next());           // 挂起状态
    s.push('a');
    s.end('r');
    await guard(it1.next());          // end 后 next
    await guard(it1.next());
    await guard(s.result());

    // 循环体自身 throw:流状态不受影响,result() 仍可用
    const s2 = new EventStream<string, string>();
    s2.push('x');
    s2.push('y');
    s2.end('r2');
    try {
      for await (const e of s2) {
        if (e === 'x') throw new Error('consumer bug');
      }
    } catch {
      // 消费者自己的异常,与流无关
    }
    expect(await guard(s2.result())).toBe('r2');
    expect(await collect(s2)).toEqual(['y']);     // 剩余事件仍可迭代
    expect(rejections).toEqual([]);               // 全程零 rejection
  });
});

describe('ProviderEventStream', () => {
  it('captures a growing provider accumulator at push time even while the consumer is behind', async () => {
    const stream = new ProviderEventStream();
    const partial: AssistantMessage = {
      role: 'assistant',
      id: 'a_snapshot',
      timestamp: 1,
      content: [],
      model: { provider: 'faux', api: 'faux', model: 'test' },
      stopReason: 'stop',
      usage: { input: 0, output: 0 },
    };

    stream.push({ type: 'start', partial });
    const part = { type: 'text' as const, text: '' };
    partial.content.push(part);
    stream.push({ type: 'text_start', contentIndex: 0, partial });
    part.text = '你好';
    stream.push({ type: 'text_delta', contentIndex: 0, delta: '你好', partial });
    stream.push({ type: 'text_end', contentIndex: 0, content: '你好', partial });
    partial.usage = { input: 7, output: 2 };
    stream.push({ type: 'done', message: partial });
    stream.end(partial);

    // Mutating the adapter-owned accumulator after enqueue/end cannot rewrite queued events or
    // result().  This models an authoritative commit awaiting while the provider keeps parsing.
    part.text = '被后续修改';
    partial.usage.output = 999;

    const events = await collect(stream);
    expect(events[0]).toMatchObject({ type: 'start', partial: { content: [] } });
    expect(events[1]).toMatchObject({
      type: 'text_start',
      partial: { content: [{ type: 'text', text: '' }] },
    });
    expect(events[2]).toMatchObject({
      type: 'text_delta',
      partial: { content: [{ type: 'text', text: '你好' }] },
    });
    expect(events[4]).toMatchObject({
      type: 'done',
      message: { content: [{ type: 'text', text: '你好' }], usage: { input: 7, output: 2 } },
    });
    expect(await stream.result()).toMatchObject({
      content: [{ type: 'text', text: '你好' }],
      usage: { input: 7, output: 2 },
    });
    expect(Object.isFrozen(events[2])).toBe(true);
  });
});
