// M7 auto-retry(docs/08-session-persistence.md §5,docs/10 §5 用例 9):
// faux provider + 真实 tmpdir。纯函数 decideRetry 单测 + session 集成(退避序列、willRetry、
// retry_scheduled、失败消息被 transform 过滤、成功 turn 重置计数、429 retryAfterMs、退避期 abort)。
// 计时器纪律:退避真实用 setTimeout,测试一律 vitest fake timers 驱动(唯一允许的计时器用法)。

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantMessage, ProviderErrorDetails } from '../src/protocol/index.js';
import { createFauxStreamFn } from '../src/providers/faux/index.js';
import type { FauxScript } from '../src/providers/faux/index.js';
import type { SessionEvent } from '../src/session/index.js';
import { decideRetry, Session } from '../src/session/index.js';
import { DEFAULT_RETRY_OPTIONS } from '../src/session/retry.js';
import { TEST_MODEL } from './helpers/agent-harness.js';

let tmpdir: string;
beforeEach(() => {
  tmpdir = mkdtempSync(path.join(os.tmpdir(), 'coda-retry-'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(tmpdir, { recursive: true, force: true });
});

// ---------- harness ----------

interface Harness {
  session: Session;
  events: SessionEvent[];
  streamFn: ReturnType<typeof createFauxStreamFn>;
  waitForEvent: (pred: (e: SessionEvent) => boolean) => Promise<SessionEvent>;
}

function instrument(session: Session, streamFn: ReturnType<typeof createFauxStreamFn>): Harness {
  const events: SessionEvent[] = [];
  const waiters: { pred: (e: SessionEvent) => boolean; resolve: (e: SessionEvent) => void }[] = [];
  session.subscribe((e) => {
    events.push(e);
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i] as (typeof waiters)[number];
      if (w.pred(e)) {
        waiters.splice(i, 1);
        w.resolve(e);
      }
    }
  });
  return {
    session,
    events,
    streamFn,
    waitForEvent: (pred) =>
      new Promise<SessionEvent>((resolve) => {
        const hit = events.find(pred);
        if (hit) return resolve(hit);
        waiters.push({ pred, resolve });
      }),
  };
}

async function makeSession(
  script: FauxScript,
  retry?: Parameters<typeof Session.create>[0]['retry'],
): Promise<Harness> {
  const streamFn = createFauxStreamFn(script);
  const session = await Session.create({
    dir: tmpdir,
    retry,
    // 关闭 compaction 干扰(无 limits 本就不触发,这里显式)
    compaction: { enabled: false },
    agentConfig: { streamFn, model: TEST_MODEL, tools: [], systemPrompt: 'test', cwd: tmpdir },
  });
  return instrument(session, streamFn);
}

// 确定 jitter:factor = 0.5 + 0.5 = 1.0 → delayMs 恰为 min(maxDelayMs, base)
const FIXED_JITTER = { jitter: () => 0.5 };
const err = (details: ProviderErrorDetails, message = 'boom'): FauxScript['turns'][number] => ({
  error: { message, details },
});

// ==================================================================
// A. decideRetry 纯函数单测
// ==================================================================

describe('decideRetry 纯函数(docs/08 §5.2)', () => {
  const opts = { maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 32000, jitter: () => 0.5 };
  const mk = (over: Partial<AssistantMessage>): AssistantMessage => ({
    role: 'assistant',
    id: 'a',
    timestamp: 0,
    content: [],
    model: TEST_MODEL.ref,
    stopReason: 'error',
    usage: { input: 0, output: 0 },
    ...over,
  });

  it('非 error 消息不重试', () => {
    expect(decideRetry(mk({ stopReason: 'stop' }), 0, opts)).toEqual({ retry: false, reason: expect.any(String) });
  });

  it('retryable:false 不重试', () => {
    const d = decideRetry(mk({ errorDetails: { kind: 'http', status: 500, retryable: false } }), 0, opts);
    expect(d.retry).toBe(false);
  });

  it('auth/overflow/aborted 分类硬否决(即使 retryable:true)', () => {
    for (const kind of ['auth', 'overflow', 'aborted'] as const) {
      const d = decideRetry(mk({ errorDetails: { kind, retryable: true } }), 0, opts);
      expect(d.retry).toBe(false);
    }
  });

  it('http 5xx 可重试,退避 = baseDelayMs * 2**attempt(jitter 0.5 → 系数 1.0)', () => {
    const details: ProviderErrorDetails = { kind: 'http', status: 503, retryable: true };
    expect(decideRetry(mk({ errorDetails: details }), 0, opts)).toEqual({ retry: true, delayMs: 1000 });
    expect(decideRetry(mk({ errorDetails: details }), 1, opts)).toEqual({ retry: true, delayMs: 2000 });
    expect(decideRetry(mk({ errorDetails: details }), 2, opts)).toEqual({ retry: true, delayMs: 4000 });
    expect(decideRetry(mk({ errorDetails: details }), 3, opts)).toEqual({ retry: true, delayMs: 8000 });
    expect(decideRetry(mk({ errorDetails: details }), 4, opts)).toEqual({ retry: true, delayMs: 16000 });
  });

  it('maxDelayMs 封顶', () => {
    const details: ProviderErrorDetails = { kind: 'http', status: 500, retryable: true };
    // attempt 6 → base 64000,封顶 32000 * 1.0
    expect(decideRetry(mk({ errorDetails: details }), 6, { ...opts, maxAttempts: 100 })).toEqual({ retry: true, delayMs: 32000 });
  });

  it('attempt >= maxAttempts 不重试', () => {
    const d = decideRetry(mk({ errorDetails: { kind: 'http', status: 500, retryable: true } }), 5, opts);
    expect(d.retry).toBe(false);
  });

  it('429 优先采用 retryAfterMs 作为 base', () => {
    const details: ProviderErrorDetails = { kind: 'rate_limit', status: 429, retryable: true, retryAfterMs: 7000 };
    expect(decideRetry(mk({ errorDetails: details }), 0, opts)).toEqual({ retry: true, delayMs: 7000 });
    // 即便 attempt 增大也用 retryAfterMs(不走指数)
    expect(decideRetry(mk({ errorDetails: details }), 3, opts)).toEqual({ retry: true, delayMs: 7000 });
  });

  it('无 errorDetails:errorMessage 网络文案兜底可重试,其余不重试', () => {
    expect(decideRetry(mk({ errorMessage: 'socket hang up' }), 0, opts).retry).toBe(true);
    expect(decideRetry(mk({ errorMessage: 'Bad Request: invalid param' }), 0, opts).retry).toBe(false);
  });

  it('jitter 影响系数:jitter 0 → 0.5×base', () => {
    const details: ProviderErrorDetails = { kind: 'http', status: 500, retryable: true };
    expect(decideRetry(mk({ errorDetails: details }), 0, { ...opts, jitter: () => 0 })).toEqual({ retry: true, delayMs: 500 });
  });

  it('默认选项:maxAttempts 5 / base 1000 / max 32000', () => {
    expect(DEFAULT_RETRY_OPTIONS.maxAttempts).toBe(5);
    expect(DEFAULT_RETRY_OPTIONS.baseDelayMs).toBe(1000);
    expect(DEFAULT_RETRY_OPTIONS.maxDelayMs).toBe(32000);
  });
});

// ==================================================================
// B. session 集成(fake timers)
// ==================================================================

describe('session auto-retry 集成(docs/08 §5.3,docs/10 §5 用例 9)', () => {
  it('turn1 error(500) → 退避 → turn2 成功:willRetry/retry_scheduled/出站一致', async () => {
    vi.useFakeTimers();
    const h = await makeSession(
      {
        turns: [
          err({ kind: 'http', status: 500, retryable: true }),
          { events: [{ kind: 'text', text: 'recovered' }] },
        ],
      },
      FIXED_JITTER,
    );

    void h.session.prompt('go');
    await h.waitForEvent((e) => e.type === 'retry_scheduled');

    const scheduled = h.events.find((e) => e.type === 'retry_scheduled');
    expect(scheduled).toMatchObject({ type: 'retry_scheduled', attempt: 1, maxAttempts: 5, delayMs: 1000 });

    // agent_end 注解 willRetry(UI 显示「重试中」而非「已结束」)
    const annotated = h.events.find((e) => e.type === 'agent_end');
    expect(annotated?.type === 'agent_end' && (annotated as { willRetry?: boolean }).willRetry).toBe(true);

    // 退避时长:advance 不足不续跑,advance 到点才续跑
    await vi.advanceTimersByTimeAsync(999);
    expect(h.streamFn.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await h.waitForEvent((e) => e.type === 'agent_end' && !(e as { willRetry?: boolean }).willRetry);

    expect(h.streamFn.calls).toHaveLength(2);
    // 重试 = continue:出站请求与失败前完全一致(失败的 error assistant 被 transform 过滤)
    const out0 = h.streamFn.calls[0]?.context.messages.map((m) => m.role);
    const out1 = h.streamFn.calls[1]?.context.messages.map((m) => m.role);
    expect(out0).toEqual(['user']);
    expect(out1).toEqual(['user']);   // error assistant 未混入 calls[1]
    expect(h.session.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
    expect((h.session.messages[1] as AssistantMessage).stopReason).toBe('error');
    expect((h.session.messages[2] as AssistantMessage).stopReason).toBe('stop');

    await h.session.close();
  });

  it('退避序列(500 连续失败):1000,2000,4000,8000,16000 后到上限透传 agent_end', async () => {
    vi.useFakeTimers();
    const errTurn = err({ kind: 'http', status: 500, retryable: true });
    const h = await makeSession(
      { turns: [errTurn, errTurn, errTurn, errTurn, errTurn, errTurn] },   // 6 次全失败
      FIXED_JITTER,
    );

    void h.session.prompt('go');
    const expected = [1000, 2000, 4000, 8000, 16000];
    for (const delay of expected) {
      await h.waitForEvent((e) => e.type === 'retry_scheduled' && e.delayMs === delay);
      await vi.advanceTimersByTimeAsync(delay);
    }
    // 第 6 次失败:attempt 5 >= maxAttempts 5 → 不再调度重试,透传终态 agent_end
    await vi.advanceTimersByTimeAsync(1);
    for (let i = 0; i < 16; i++) await Promise.resolve();

    const scheduled = h.events.filter((e) => e.type === 'retry_scheduled');
    expect(scheduled.map((e) => (e as { delayMs: number }).delayMs)).toEqual(expected);
    expect(h.streamFn.calls).toHaveLength(6);

    // 最后一个 agent_end 不带 willRetry(真正结束)
    const ends = h.events.filter((e) => e.type === 'agent_end');
    const last = ends[ends.length - 1];
    expect(last && (last as { willRetry?: boolean }).willRetry).toBeUndefined();

    await h.session.close();
  });

  it('不可重试(400 参数错)不退避,直接透传 agent_end', async () => {
    vi.useFakeTimers();
    const h = await makeSession(
      { turns: [err({ kind: 'http', status: 400, retryable: false }, 'invalid param')] },
      FIXED_JITTER,
    );
    await h.session.prompt('go');   // 无重试:prompt 一把跑完
    expect(h.events.some((e) => e.type === 'retry_scheduled')).toBe(false);
    expect(h.streamFn.calls).toHaveLength(1);
    const end = h.events.find((e) => e.type === 'agent_end');
    expect(end?.type === 'agent_end' && end.reason).toBe('error');
    expect((end as { willRetry?: boolean }).willRetry).toBeUndefined();
    await h.session.close();
  });

  it('429 采用 retryAfterMs 作为退避', async () => {
    vi.useFakeTimers();
    const h = await makeSession(
      {
        turns: [
          err({ kind: 'rate_limit', status: 429, retryable: true, retryAfterMs: 5000 }),
          { events: [{ kind: 'text', text: 'ok' }] },
        ],
      },
      FIXED_JITTER,
    );
    void h.session.prompt('go');
    const scheduled = await h.waitForEvent((e) => e.type === 'retry_scheduled');
    expect((scheduled as { delayMs: number }).delayMs).toBe(5000);   // retryAfterMs,非 base*2**0
    await vi.advanceTimersByTimeAsync(5000);
    await h.waitForEvent((e) => e.type === 'agent_end' && !(e as { willRetry?: boolean }).willRetry);
    expect(h.streamFn.calls).toHaveLength(2);
    await h.session.close();
  });

  it('成功 turn 重置 attempt:先失败一次重试成功,再次失败仍从 base 起算', async () => {
    vi.useFakeTimers();
    const errTurn = err({ kind: 'http', status: 500, retryable: true });
    const h = await makeSession(
      {
        turns: [
          errTurn,                                          // run1: 失败 → 退避 1000
          { events: [{ kind: 'text', text: 'first ok' }] }, // run1 续: 成功 → attempt 归零
          errTurn,                                          // run2(新 prompt): 失败 → 退避应再从 1000 起
          { events: [{ kind: 'text', text: 'second ok' }] },
        ],
      },
      FIXED_JITTER,
    );

    void h.session.prompt('go');
    await h.waitForEvent((e) => e.type === 'retry_scheduled' && e.delayMs === 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await h.waitForEvent((e) => e.type === 'agent_end' && !(e as { willRetry?: boolean }).willRetry);

    // 第二轮:因为成功 turn 已把 attempt 归零,退避序号从 0(delay 1000)重新开始
    const before = h.events.filter((e) => e.type === 'retry_scheduled').length;
    void h.session.prompt('again');
    await h.waitForEvent((e) => e.type === 'retry_scheduled' && h.events.filter((x) => x.type === 'retry_scheduled').length > before);
    const second = h.events.filter((e) => e.type === 'retry_scheduled');
    expect((second[second.length - 1] as { delayMs: number }).delayMs).toBe(1000);   // 未累积到 2000
    await vi.advanceTimersByTimeAsync(1000);
    await h.waitForEvent((e) => e.type === 'agent_end' && !(e as { willRetry?: boolean }).willRetry && (e as { messages: unknown[] }).messages.length > 0);
    await h.session.close();
    expect(h.streamFn.calls).toHaveLength(4);
  });

  it('退避等待期间 abort 立即生效:取消续跑,补发 error 事件', async () => {
    vi.useFakeTimers();
    const h = await makeSession(
      {
        turns: [
          err({ kind: 'http', status: 500, retryable: true }),
          { events: [{ kind: 'text', text: 'should not run' }] },
        ],
      },
      FIXED_JITTER,
    );
    void h.session.prompt('go');
    await h.waitForEvent((e) => e.type === 'retry_scheduled');

    h.session.abort();                          // 退避睡眠中途取消
    await h.waitForEvent((e) => e.type === 'error');

    // 不再续跑(即便把时钟推到底)
    await vi.advanceTimersByTimeAsync(60000);
    await Promise.resolve();
    expect(h.streamFn.calls).toHaveLength(1);
    const cancelled = h.events.find((e) => e.type === 'error');
    expect(cancelled?.type === 'error' && /cancel/i.test(cancelled.message)).toBe(true);
    await h.session.close();
  });

  it('收到 willRetry 的 agent_end 时同步 abort:仍补发 cancel error,不悬空(docs/08 §5.3)', async () => {
    // 核查发现:UI 把 willRetry 映射成「可取消的重试中」,收到该 agent_end 即同步 abort 是合理设计。
    // 此刻 op 已登记但 IIFE 续体尚未运行,controller 被同步置 aborted——早退分支若不补发 cancel error,
    // UI 永久停在「重试中」。修复后:op 不因 aborted 早退,交给 #runRetry 的 sleepWithAbort 补发。
    vi.useFakeTimers();
    const h = await makeSession(
      {
        turns: [
          err({ kind: 'http', status: 500, retryable: true }),
          { events: [{ kind: 'text', text: 'should not run' }] },
        ],
      },
      FIXED_JITTER,
    );
    // 订阅者在 willRetry 版 agent_end 到达时同步 abort(在 retry_scheduled fanout 之前)
    let abortedOnWillRetry = false;
    h.session.subscribe((e) => {
      if (e.type === 'agent_end' && (e as { willRetry?: boolean }).willRetry === true && !abortedOnWillRetry) {
        abortedOnWillRetry = true;
        h.session.abort();
      }
    });
    void h.session.prompt('go');
    await h.waitForEvent((e) => e.type === 'error' && /cancel/i.test((e as { message: string }).message));

    await vi.advanceTimersByTimeAsync(60000);
    await Promise.resolve();
    expect(abortedOnWillRetry).toBe(true);
    expect(h.streamFn.calls).toHaveLength(1);     // 未续跑
    const cancelled = h.events.find((e) => e.type === 'error');
    expect(cancelled?.type === 'error' && /cancel/i.test(cancelled.message)).toBe(true);
    await h.session.close();
  });
});
