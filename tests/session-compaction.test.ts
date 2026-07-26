// M7 compaction(docs/08-session-persistence.md §6,docs/10 §5 用例 9):
// faux provider + 真实 tmpdir。覆盖:threshold 主动触发(shouldStopAfterTurn 停 + 摘要请求 +
// CompactionRecord 落盘 + 续跑出站骤降且首条 synthetic + 配对合法)、overflow 被动、摘要失败
// 硬截断、压缩期 prompt 暂存重放 + steer 不丢;selectTailStart 纯函数单测。
// 纪律:时序只用 gate 与事件等待(无计时器);出站断言一律用 faux 的 calls。

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentMessage,
  AssistantMessage,
  ModelConfig,
  ToolResultMessage,
  UserMessage,
} from '../src/protocol/index.js';
import { createFauxStreamFn, createGate } from '../src/providers/faux/index.js';
import type { FauxScript } from '../src/providers/faux/index.js';
import type { CompactionRecord, MetaRecord, SessionEvent, SessionRecord } from '../src/session/index.js';
import { PROTOCOL_VERSION, selectTailStart, Session, SUMMARIZE_PROMPT } from '../src/session/index.js';
import { HARD_TRUNCATION_SUMMARY } from '../src/session/compactor.js';
import type { ToolDefinition } from '../src/tools/types.js';
import { makeTool, TEST_MODEL, textOutput, toWireShape } from './helpers/agent-harness.js';
import { assertToolCallPairing } from './helpers/wire-pairing.js';

// 小 context 上限:令 threshold 用小 usage 即可触发;keepRatio 极小令切点落在最后 turn。
const SMALL_MODEL: ModelConfig = {
  ref: TEST_MODEL.ref,
  limits: { context: 200, output: 0 },
};

let tmpdir: string;
beforeEach(() => {
  tmpdir = mkdtempSync(path.join(os.tmpdir(), 'coda-compact-'));
});
afterEach(() => {
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

function metaRecord(id: string): MetaRecord {
  return { type: 'meta', version: 1, protocolVersion: PROTOCOL_VERSION, id, createdAt: Date.now(), cwd: tmpdir, model: TEST_MODEL.ref };
}
function user(id: string, text: string, source: UserMessage['source'] = 'prompt'): UserMessage {
  return { role: 'user', id, timestamp: 1, content: [{ type: 'text', text }], source };
}
function assistant(id: string, text: string, usageInput = 10): AssistantMessage {
  return {
    role: 'assistant', id, timestamp: 2, content: [{ type: 'text', text }],
    model: TEST_MODEL.ref, stopReason: 'stop', usage: { input: usageInput, output: 5 },
  };
}

/** 预置一份多 turn 转录并写盘,供 resume 后触发压缩(单 run 只有一个 user 起点,无从演示丢弃)。 */
function seedTranscript(id: string, messages: AgentMessage[]): void {
  const records: SessionRecord[] = [metaRecord(id), ...messages.map((m) => ({ type: 'message' as const, message: m }))];
  writeFileSync(path.join(tmpdir, `${id}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

async function resume(
  id: string,
  script: FauxScript,
  tools: ToolDefinition[],
  compaction?: Parameters<typeof Session.create>[0]['compaction'],
): Promise<Harness> {
  const streamFn = createFauxStreamFn(script);
  const session = await Session.resume(id, {
    dir: tmpdir,
    compaction,
    agentConfig: { streamFn, model: SMALL_MODEL, tools, systemPrompt: 'You are a test agent.', cwd: tmpdir },
  });
  return instrument(session, streamFn);
}

function readRecords(id: string): SessionRecord[] {
  return readFileSync(path.join(tmpdir, `${id}.jsonl`), 'utf8').split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l) as SessionRecord);
}

// ==================================================================
// A. selectTailStart 纯函数
// ==================================================================

describe('selectTailStart 纯函数(docs/08 §6.3)', () => {
  const u = (id: string, source: UserMessage['source']): UserMessage => user(id, 'x', source);
  const a = (id: string): AssistantMessage => assistant(id, 'y');
  const tr = (id: string, toolCallId: string): ToolResultMessage => ({
    role: 'tool_result', id, timestamp: 3, toolCallId, toolName: 't', content: [{ type: 'text', text: 'r' }], isError: false,
  });

  it('空转录 → 0', () => {
    expect(selectTailStart([], 100)).toBe(0);
  });

  it('keepBudget 极小 → 切点对齐到最近 turn 起点 user(不切开 tool_call/result)', () => {
    // [u1,a1,u2(prompt),a2(tool_call 已略),tr2] —— 切点应落在 u2,保留 [u2,a2,tr2]
    const msgs: AgentMessage[] = [u('u1', 'prompt'), a('a1'), u('u2', 'prompt'), a('a2'), tr('tr2', 'c')];
    expect(selectTailStart(msgs, 1)).toBe(2);
  });

  it('keepBudget 极大 → 保留全部(对齐到首个 user)', () => {
    const msgs: AgentMessage[] = [u('u1', 'prompt'), a('a1'), u('u2', 'steering'), a('a2')];
    expect(selectTailStart(msgs, 1e9)).toBe(0);
  });

  it('synthetic user 不作切点(只认 prompt/steering/follow_up)', () => {
    const synth: UserMessage = { role: 'user', id: 's', timestamp: 1, content: [{ type: 'text', text: 'x' }], source: 'synthetic' };
    // 尾部 [synth, a] 无合法起点 → 退化保留最后一整 turn(u2)
    const msgs: AgentMessage[] = [u('u1', 'prompt'), u('u2', 'follow_up'), synth, a('a2')];
    expect(selectTailStart(msgs, 1)).toBe(1);   // u2(follow_up)
  });
});

// ==================================================================
// B. threshold 主动压缩(核心验收)
// ==================================================================

describe('threshold 主动压缩(docs/08 §6.1/§6.2,docs/10 §5 用例 9)', () => {
  it('超阈值 → shouldStopAfterTurn 停 + 摘要请求 + record 落盘 + 续跑出站骤降且首条 synthetic', async () => {
    const id = '20260101-000000-cmpa';
    // 预置两轮历史(4 条),resume 后再跑一个高 usage 的 tool turn 触发阈值。
    seedTranscript(id, [
      user('u1', '第一件事', 'prompt'), assistant('a1', '好', 10),
      user('u2', '第二件事', 'prompt'), assistant('a2', '嗯', 10),
    ]);
    const lookup = makeTool('lookup', async () => textOutput('found'));

    const h = await resume(
      id,
      {
        turns: [
          // run: 高 usage 的 tool turn(contextTokens = 190+10 = 200 > 0.8*200=160)→ turn_end 触发停
          { events: [{ kind: 'tool_call', name: 'lookup', args: { value: 'x' }, id: 'call_hot' }], usage: { input: 190, output: 10 } },
          // 摘要请求(faux call #1):systemPrompt 应为 SUMMARIZE_PROMPT
          { events: [{ kind: 'text', text: '任务摘要:做了 A 和 B,待办 C。' }] },
          // 续跑重采样(faux call #2):出站已折叠
          { events: [{ kind: 'text', text: '继续完成 C' }], usage: { input: 50, output: 10 } },
        ],
      },
      [lookup],
      { keepRatio: 0.05 },   // keepBudget = 200*0.05 = 10 → 切点落在最后 turn(u3)
    );

    await h.session.prompt('第三件事');
    // 续跑续到底:等第二个 completed 的 agent_end(压缩后的 continue run)
    await h.waitForEvent(
      (e) => e.type === 'agent_end' && e.reason === 'completed' && h.events.filter((x) => x.type === 'agent_end').length >= 2,
    );
    await h.session.close();

    // compaction 事件对
    expect(h.events.some((e) => e.type === 'compaction_start' && e.reason === 'threshold')).toBe(true);
    const end = h.events.find((e) => e.type === 'compaction_end');
    expect(end?.type === 'compaction_end' && end.ok).toBe(true);
    expect(end?.type === 'compaction_end' && end.droppedMessages).toBeGreaterThan(0);

    // 三次 faux call:热 turn、摘要、续跑
    expect(h.streamFn.calls).toHaveLength(3);
    // 摘要请求 = 一次独立 faux call,systemPrompt 为 SUMMARIZE_PROMPT
    expect(h.streamFn.calls[1]?.context.systemPrompt).toBe(SUMMARIZE_PROMPT);

    // 续跑出站(call #2):首条为 synthetic summary,消息数骤降,配对合法
    const outbound = h.streamFn.calls[2]?.context.messages ?? [];
    const first = outbound[0] as UserMessage;
    expect(first.source).toBe('synthetic');
    expect(first.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('[Conversation summary]') });
    // 权威转录含 [u1,a1,u2,a2,u3,a3,tr3,...],出站折叠后显著更短
    expect(outbound.length).toBeLessThan(h.session.messages.length);
    assertToolCallPairing(toWireShape(outbound));

    // CompactionRecord 落盘(历史 append-only,只增不改)
    const records = readRecords(id);
    const cmp = records.find((r): r is CompactionRecord => r.type === 'compaction');
    expect(cmp).toBeDefined();
    expect(cmp?.summary).toContain('任务摘要');
    expect(cmp?.contextTokensBefore).toBe(200);
    // tailStartId 指向 u3(第三件事 的 prompt user)
    const u3 = [...h.session.messages].find((m) => m.role === 'user' && m.content.some((p) => p.type === 'text' && p.text === '第三件事'));
    expect(cmp?.tailStartId).toBe(u3?.id);
  });

  it('无 model.limits.context → 不触发压缩(M7 默认 enabled 但需上限)', async () => {
    const streamFn = createFauxStreamFn({
      turns: [{ events: [{ kind: 'text', text: 'done' }], usage: { input: 999999, output: 10 } }],
    });
    const session = await Session.create({
      dir: tmpdir,
      agentConfig: { streamFn, model: TEST_MODEL, tools: [], systemPrompt: 'test', cwd: tmpdir },   // 无 limits
    });
    const h = instrument(session, streamFn);
    await h.session.prompt('go');
    await h.session.close();
    expect(h.events.some((e) => e.type === 'compaction_start')).toBe(false);
    expect(h.streamFn.calls).toHaveLength(1);
  });
});

// ==================================================================
// C. overflow 被动压缩 + 摘要失败硬截断
// ==================================================================

describe('overflow 被动压缩(docs/08 §6.1/§6.5)', () => {
  it('overflow error → 不重试,直接压缩;续跑出站折叠', async () => {
    const id = '20260101-000000-ovfl';
    seedTranscript(id, [
      user('u1', 'A', 'prompt'), assistant('a1', 'ok', 190),   // seed contextTokens = 195
      user('u2', 'B', 'prompt'), assistant('a2', 'ok', 190),
    ]);

    const h = await resume(
      id,
      {
        turns: [
          { error: { message: 'context length exceeded', details: { kind: 'overflow', retryable: false } } },
          { events: [{ kind: 'text', text: '历史摘要' }] },          // 摘要
          { events: [{ kind: 'text', text: '重试成功' }], usage: { input: 40, output: 5 } },   // 续跑
        ],
      },
      [],
      { keepRatio: 0.05 },
    );

    await h.session.prompt('C');
    await h.waitForEvent(
      (e) => e.type === 'agent_end' && e.reason === 'completed',
    );
    await h.session.close();

    // 无重试,走被动压缩
    expect(h.events.some((e) => e.type === 'retry_scheduled')).toBe(false);
    expect(h.events.some((e) => e.type === 'compaction_start' && e.reason === 'overflow')).toBe(true);
    expect(h.streamFn.calls).toHaveLength(3);
    const cmp = readRecords(id).find((r): r is CompactionRecord => r.type === 'compaction');
    expect(cmp).toBeDefined();
    // 续跑出站首条 synthetic;error assistant 被 transform 过滤,配对仍合法
    const outbound = h.streamFn.calls[2]?.context.messages ?? [];
    expect((outbound[0] as UserMessage).source).toBe('synthetic');
    expect(outbound.some((m) => m.role === 'assistant' && m.stopReason === 'error')).toBe(false);
  });

  it('overflow 摘要失败 → 硬截断占位,照常写 record 续跑', async () => {
    const id = '20260101-000000-hard';
    seedTranscript(id, [
      user('u1', 'A', 'prompt'), assistant('a1', 'ok', 190),
      user('u2', 'B', 'prompt'), assistant('a2', 'ok', 190),
    ]);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const h = await resume(
      id,
      {
        turns: [
          { error: { message: 'overflow', details: { kind: 'overflow', retryable: false } } },
          { error: { message: 'summary boom', details: { kind: 'http', status: 500, retryable: true } } }, // 摘要失败
          { events: [{ kind: 'text', text: '截断后继续' }], usage: { input: 40, output: 5 } },
        ],
      },
      [],
      { keepRatio: 0.05 },
    );

    await h.session.prompt('C');
    await h.waitForEvent((e) => e.type === 'agent_end' && e.reason === 'completed');
    await h.session.close();

    const end = h.events.find((e) => e.type === 'compaction_end');
    expect(end?.type === 'compaction_end' && end.ok).toBe(true);   // 硬截断也算压缩成功(有损但会话活)
    const cmp = readRecords(id).find((r): r is CompactionRecord => r.type === 'compaction');
    expect(cmp?.summary).toBe(HARD_TRUNCATION_SUMMARY);
    // 续跑出站首条 synthetic,内容为占位
    const outbound = h.streamFn.calls[2]?.context.messages ?? [];
    expect((outbound[0] as UserMessage).content[0]).toMatchObject({ type: 'text', text: expect.stringContaining(HARD_TRUNCATION_SUMMARY) });
    expect(errSpy.mock.calls.some((a) => String(a[0]).includes('hard-truncating'))).toBe(true);
  });

  it('无限循环护栏(docs/08 §8):每轮都 overflow → 压缩 → 硬截断 → fatal 停,不无限重压缩', async () => {
    const id = '20260101-000000-guard';
    seedTranscript(id, [
      user('u1', 'A', 'prompt'), assistant('a1', 'ok', 190),
      user('u2', 'B', 'prompt'), assistant('a2', 'ok', 190),
    ]);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // 每次采样都 overflow(尾部单 turn 过大的极端);摘要请求也是一次 faux call。
    // 若无护栏,provider 永远 overflow → 无限压缩;faux 脚本给足够多 turn 证明「有界」。
    const overflowTurn = { error: { message: 'ctx', details: { kind: 'overflow' as const, retryable: false } } };
    const h = await resume(
      id,
      {
        turns: [
          overflowTurn,                                        // #1 overflow → 压缩(summarize)
          { events: [{ kind: 'text', text: 'summary1' }], usage: { input: 10, output: 5 } }, // 摘要调用
          overflowTurn,                                        // 续跑仍 #2 overflow → 强制硬截断(不 summarize)
          overflowTurn,                                        // 续跑仍 #3 overflow → fatal 停
          overflowTurn, overflowTurn, overflowTurn,            // 护栏若失效会被继续消费
        ],
      },
      [],
      { keepRatio: 0.05 },
    );

    await h.session.prompt('C');
    await h.waitForEvent((e) => e.type === 'error' && e.fatal === true);
    await h.session.close();

    // fatal 到达且停:compaction_start 恰好 2 次(第 1 次 summarize、第 2 次硬截断),不是 5+ 次
    const starts = h.events.filter((e) => e.type === 'compaction_start');
    expect(starts).toHaveLength(2);
    const fatal = h.events.find((e) => e.type === 'error' && e.fatal === true);
    expect(fatal?.type === 'error' && fatal.message).toContain('larger context window');
    // 第 2 次是硬截断(HARD_TRUNCATION_SUMMARY),没有第二次 summarize 调用被消耗到 fatal 之后
    const cmps = readRecords(id).filter((r): r is CompactionRecord => r.type === 'compaction');
    expect(cmps.at(-1)?.summary).toBe(HARD_TRUNCATION_SUMMARY);
    errSpy.mockRestore();
  });
});

// ==================================================================
// D. 压缩期间 prompt 暂存重放 + steer 不丢
// ==================================================================

describe('压缩期间用户输入:prompt 暂存重放、steer 不丢(docs/08 §6.4)', () => {
  it('gate 悬停摘要期间 prompt+steer → 压缩后重放,出站含两者', async () => {
    const id = '20260101-000000-stash';
    seedTranscript(id, [
      user('u1', 'A', 'prompt'), assistant('a1', 'ok', 190),
      user('u2', 'B', 'prompt'), assistant('a2', 'ok', 190),
    ]);
    const gate = createGate();

    const h = await resume(
      id,
      {
        turns: [
          // 触发阈值的热 turn
          { events: [{ kind: 'text', text: '热' }], usage: { input: 190, output: 10 } },
          // 摘要请求:gate 悬停,给测试窗口注入 prompt/steer
          { events: [{ kind: 'gate', gate }, { kind: 'text', text: '摘要文本' }] },
          // 重放 prompt 的 run:此处消费暂存 prompt + 队列里的 steer
          { events: [{ kind: 'text', text: '答复' }], usage: { input: 40, output: 5 } },
        ],
      },
      [],
      { keepRatio: 0.05 },
    );

    await h.session.prompt('第三件事');                  // 触发压缩
    await h.waitForEvent((e) => e.type === 'compaction_start');
    // 此刻压缩 op 正卡在摘要 gate:暂存 prompt、透传 steer
    await h.session.prompt('压缩期间的新输入');            // 应被暂存
    h.session.steer('顺便这个也办了');                     // 直接入 agent 队列
    gate.open();

    await h.waitForEvent(
      (e) => e.type === 'agent_end' && e.reason === 'completed' && h.events.filter((x) => x.type === 'agent_end').length >= 2,
    );
    await h.session.close();

    // 摘要是 call #1;重放 prompt 的 run 是 call #2
    expect(h.streamFn.calls.length).toBeGreaterThanOrEqual(3);
    const replay = h.streamFn.calls[2]?.context.messages ?? [];
    const texts = replay.flatMap((m) => m.content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text));
    expect(texts.some((t) => t.includes('压缩期间的新输入'))).toBe(true);   // 暂存 prompt 已重放
    expect(texts.some((t) => t.includes('顺便这个也办了'))).toBe(true);     // steer 未丢
    // 首条仍是折叠后的 synthetic summary
    expect((replay[0] as UserMessage).source).toBe('synthetic');
  });
});
