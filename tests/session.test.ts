// M5 session 层集成测试(docs/08-session-persistence.md §9 M5 验收四条,docs/10 §5 末段):
// L4 层 = faux provider + 真实 tmpdir。覆盖:message_end 即时落盘、kill(不 close)→ resume、
// 恢复「工具执行中被杀」后 continue 的 transform 修复(核心验收)、尾行半截恢复、
// details 序列化降级、磁盘写失败的内存模式降级。
// 纪律:时序只用 gate 与事件等待(无计时器);出站断言一律用 faux 的 calls。

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import { strictJsonSnapshot } from '../src/protocol/index.js';
import type { AgentMessage, AssistantMessage, ToolResultMessage, UserMessage } from '../src/protocol/index.js';
import { INTERRUPTED_RESULT_TEXT } from '../src/agent/index.js';
import { createFauxStreamFn, createGate } from '../src/providers/faux/index.js';
import type { FauxScript } from '../src/providers/faux/index.js';
import type { MessageRecord, MetaRecord, SessionEvent, SessionRecord } from '../src/session/index.js';
import { PROTOCOL_VERSION, Session, SessionStore } from '../src/session/index.js';
import type { ToolDefinition } from '../src/tools/types.js';
import { makeTool, TEST_MODEL, textOutput, toWireShape } from './helpers/agent-harness.js';
import { assertToolCallPairing } from './helpers/wire-pairing.js';

let tmpdir: string;
beforeEach(() => {
  tmpdir = mkdtempSync(path.join(os.tmpdir(), 'coda-session-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmpdir, { recursive: true, force: true });
});

// ---------- harness ----------

interface SessionHarness {
  session: Session;
  events: SessionEvent[];
  streamFn: ReturnType<typeof createFauxStreamFn>;
  /** 等待谓词命中的下一个事件(只看未来事件,不含历史)。 */
  waitForEvent: (pred: (e: SessionEvent) => boolean) => Promise<SessionEvent>;
}

function instrument(session: Session, streamFn: ReturnType<typeof createFauxStreamFn>): SessionHarness {
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
        waiters.push({ pred, resolve });
      }),
  };
}

async function makeSession(script: FauxScript, tools: ToolDefinition[] = []): Promise<SessionHarness> {
  const streamFn = createFauxStreamFn(script);
  const session = await Session.create({
    dir: tmpdir,
    agentConfig: { streamFn, model: TEST_MODEL, tools, systemPrompt: 'You are a test agent.', cwd: tmpdir },
  });
  return instrument(session, streamFn);
}

async function resumeSession(id: string, script: FauxScript, tools: ToolDefinition[] = []): Promise<SessionHarness> {
  const streamFn = createFauxStreamFn(script);
  const session = await Session.resume(id, {
    dir: tmpdir,
    agentConfig: { streamFn, model: TEST_MODEL, tools, systemPrompt: 'You are a test agent.', cwd: tmpdir },
  });
  return instrument(session, streamFn);
}

const sessionFile = (id: string): string => path.join(tmpdir, `${id}.jsonl`);

function readRecords(id: string): SessionRecord[] {
  return readFileSync(sessionFile(id), 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as SessionRecord);
}

function fileMessages(id: string): AgentMessage[] {
  return readRecords(id)
    .filter((r): r is MessageRecord => r.type === 'message')
    .map((r) => r.message);
}

// ---------- 1. message_end 即时落盘 ----------

describe('每条 message_end 即时追加 JSONL(docs/08 §3.3)', () => {
  it('工具 turn 剧本:meta 首行,message 行序与转录深等', async () => {
    const lookup = makeTool('lookup', async () => textOutput('result!'));
    const h = await makeSession(
      {
        turns: [
          { events: [{ kind: 'text', text: '先查一下' }, { kind: 'tool_call', name: 'lookup', args: { value: 'x' }, id: 'call_1' }] },
          { events: [{ kind: 'text', text: '完成' }] },
        ],
      },
      [lookup],
    );
    await h.session.prompt('go');
    await h.session.close();

    const records = readRecords(h.session.id);
    const meta = records[0] as MetaRecord;
    expect(meta).toMatchObject({
      type: 'meta',
      version: 1,
      protocolVersion: PROTOCOL_VERSION,
      id: h.session.id,
      cwd: tmpdir,
      model: TEST_MODEL.ref,
    });
    expect(typeof meta.createdAt).toBe('number');

    // meta 之后全部是 message 行,行序与权威转录一致且逐条深等
    expect(records.slice(1).every((r) => r.type === 'message')).toBe(true);
    const onDisk = fileMessages(h.session.id);
    expect(onDisk.map((m) => m.role)).toEqual(['user', 'assistant', 'tool_result', 'assistant']);
    expect(onDisk).toEqual([...h.session.messages]);

    // usage_update 旁路事件随 assistant message_end 发出(docs/08 §7.2)
    const updates = h.events.filter((e) => e.type === 'usage_update');
    expect(updates.length).toBe(2);
    const last = updates[updates.length - 1];
    expect(last?.type === 'usage_update' && last.usage.turns).toBe(2);
  });

  it('流式期间不落盘:gate 悬停时 assistant 尚未写入,message_end 一次性写终态', async () => {
    const gate = createGate();
    const h = await makeSession({
      turns: [{ events: [{ kind: 'text', text: 'streaming now' }, { kind: 'gate', gate }] }],
    });
    const updated = h.waitForEvent((e) => e.type === 'message_update');
    const run = h.session.prompt('go');
    await updated;

    // 悬停点:文件里只有 meta + user,流式中的 assistant 不在盘上
    const mid = readRecords(h.session.id);
    expect(mid.map((r) => r.type)).toEqual(['meta', 'message']);
    expect((mid[1] as MessageRecord).message.role).toBe('user');

    gate.open();
    await run;
    await h.session.close();

    const after = fileMessages(h.session.id);
    expect(after.map((m) => m.role)).toEqual(['user', 'assistant']);
    const assistant = after[1] as AssistantMessage;
    expect(assistant.stopReason).toBe('stop');                    // 终态含 stopReason/usage
    expect(assistant.usage).toEqual({ input: 100, output: 10 });
    expect(assistant.content).toEqual([{ type: 'text', text: 'streaming now' }]);
  });
});

// ---------- 2. kill(不 close)→ resume ----------

describe('kill → resume(docs/08 §9 M5 验收 1/4)', () => {
  it('直接丢弃 Session 不 close:resume 后转录深等、usage cumulative 与手工求和一致', async () => {
    const lookup = makeTool('lookup', async () => textOutput('found'));
    const h = await makeSession(
      {
        turns: [
          { events: [{ kind: 'tool_call', name: 'lookup', args: { value: 'q' }, id: 'call_1' }], usage: { input: 120, output: 15, cacheRead: 20 } },
          { events: [{ kind: 'text', text: 'answer' }], usage: { input: 240, output: 30, reasoning: 5 } },
        ],
      },
      [lookup],
    );
    await h.session.prompt('question');
    const origMessages = [...h.session.messages];
    const origUsage = h.session.usage();
    // 不调 close 直接丢弃对象——append 是同步落盘,等价 kill -9 后的文件现场

    const r = await resumeSession(h.session.id, { turns: [] });
    expect(r.streamFn.calls).toHaveLength(0);                     // 恢复完成后不自动跑(docs/08 §4.3)
    expect([...r.session.messages]).toEqual(origMessages);

    const usage = r.session.usage();
    expect(usage).toEqual(origUsage);                             // 恢复后统计不丢
    // 手工求和:独立于实现的期望值(逐条 assistant 逐字段相加)
    expect(usage.cumulative).toEqual({ input: 360, output: 45, cacheRead: 20, reasoning: 5 });
    expect(usage.turns).toBe(2);
    expect(usage.lastTurn).toEqual({ input: 240, output: 30, reasoning: 5 });
    expect(usage.contextTokens).toBe(270);
  });

  it('尾行半截 JSON:恢复成功(半截行丢弃),会话可继续对话', async () => {
    const h = await makeSession({ turns: [{ events: [{ kind: 'text', text: 'hello world' }] }] });
    await h.session.prompt('hi');

    // 手工 truncate 文件尾:assistant 行只剩前 25 字节,模拟写半行被杀
    const file = sessionFile(h.session.id);
    const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0);
    const tail = lines[lines.length - 1] as string;
    writeFileSync(file, [...lines.slice(0, -1), tail.slice(0, 25)].join('\n'), 'utf8');

    const r = await resumeSession(h.session.id, { turns: [{ events: [{ kind: 'text', text: 'again' }] }] });
    expect([...r.session.messages].map((m) => m.role)).toEqual(['user']);   // 半截 assistant 被丢弃
    expect(r.session.usage().turns).toBe(0);

    await r.session.prompt('go on');                              // 恢复后照常开新一轮
    expect([...r.session.messages].map((m) => m.role)).toEqual(['user', 'user', 'assistant']);
    const outbound = r.streamFn.calls[0]?.context.messages ?? [];
    expect(outbound.map((m) => m.role)).toEqual(['user', 'user']);   // 出站只含两条完整 user

    // repairTail 回归(核查发现的真缺陷):残片若不截掉,恢复后的 append 会粘在半截行
    // 尾部形成「中部损坏行」,下一次 load 按规格拒绝。这里断言二次 resume 依旧成功。
    const r2 = await resumeSession(h.session.id, { turns: [] });
    expect([...r2.session.messages].map((m) => m.role)).toEqual(['user', 'user', 'assistant']);
  });

  it('repairTail:残片恰在换行前崩溃(JSON 完整无行尾)→ 补换行保留记录', async () => {
    const h = await makeSession({ turns: [{ events: [{ kind: 'text', text: 'hello world' }] }] });
    await h.session.prompt('hi');
    const file = sessionFile(h.session.id);
    const raw = readFileSync(file, 'utf8');
    writeFileSync(file, raw.slice(0, -1), 'utf8');   // 去掉末尾 \n:记录完整但无行尾

    const r = await resumeSession(h.session.id, { turns: [{ events: [{ kind: 'text', text: 'again' }] }] });
    expect([...r.session.messages].map((m) => m.role)).toEqual(['user', 'assistant']);   // 记录保留
    await r.session.prompt('go on');
    // 回归点:补换行后追加不粘行——文件 5 行(meta + 4 消息)全部可独立 parse,再恢复不 throw。
    // (转录角色序不作断言:faux 跨会话复用确定性 id,store 的同 id 去重防御会折叠展示)
    const rawAfter = readFileSync(file, 'utf8');
    const linesAfter = rawAfter.split('\n').filter((l) => l.length > 0);
    expect(linesAfter).toHaveLength(5);
    for (const line of linesAfter) expect(() => JSON.parse(line)).not.toThrow();
    await expect(resumeSession(h.session.id, { turns: [] })).resolves.toBeDefined();
  });
});

// ---------- 3. 恢复「工具执行中被杀」+ continue(核心验收) ----------

describe('恢复「工具执行中被杀」的会话(docs/08 §9 M5 第 2 条——核心验收)', () => {
  it('resume → session.continue():出站 Context 中悬空 toolCall 已被 transform 补合成中断结果', async () => {
    // 手工构造现场:meta + user + assistant(tool_calls) 半途,tool_result 缺失
    const id = '20260101-000000-dead';
    const meta: MetaRecord = {
      type: 'meta', version: 1, protocolVersion: PROTOCOL_VERSION,
      id, createdAt: Date.now(), cwd: tmpdir, model: TEST_MODEL.ref,
    };
    const userMsg: UserMessage = {
      role: 'user', id: 'u1', timestamp: 1, content: [{ type: 'text', text: '找 x' }], source: 'prompt',
    };
    const killed: AssistantMessage = {
      role: 'assistant', id: 'a1', timestamp: 2,
      content: [
        { type: 'text', text: '我来查' },
        { type: 'tool_call', id: 'call_dead', name: 'lookup', arguments: { value: 'x' }, rawArguments: '{"value":"x"}' },
      ],
      model: TEST_MODEL.ref, stopReason: 'tool_calls', usage: { input: 100, output: 10 },
    };
    const records = [meta, { type: 'message', message: userMsg }, { type: 'message', message: killed }];
    writeFileSync(sessionFile(id), records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

    const r = await resumeSession(id, { turns: [{ events: [{ kind: 'text', text: '接着做' }] }] });
    expect(r.session.usage().turns).toBe(1);                      // 半途 assistant 的 usage 已 seed

    await r.session.continue();
    const start = r.events.find((e) => e.type === 'agent_start');
    expect(start?.type === 'agent_start' && start.reason).toBe('continue');

    // 出站断言只看 faux calls(不猜 agent 内部状态)
    expect(r.streamFn.calls).toHaveLength(1);
    const outbound = r.streamFn.calls[0]?.context.messages ?? [];
    expect(outbound.map((m) => m.role)).toEqual(['user', 'assistant', 'tool_result']);
    const synth = outbound[2] as ToolResultMessage;
    expect(synth.toolCallId).toBe('call_dead');
    expect(synth.toolName).toBe('lookup');
    expect(synth.isError).toBe(true);
    expect(synth.content).toEqual([{ type: 'text', text: INTERRUPTED_RESULT_TEXT }]);
    assertToolCallPairing(toWireShape(outbound));                 // tool_calls/tool 配对合法

    // 修复只存在于出站视图:权威转录与文件都不出现合成 tool_result;新 assistant 照常追加落盘
    expect([...r.session.messages].some((m) => m.role === 'tool_result')).toBe(false);
    expect(fileMessages(id).map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
    const end = r.events.find((e) => e.type === 'agent_end');
    expect(end?.type === 'agent_end' && end.reason).toBe('completed');
  });
});

// ---------- 4. details 落盘 ----------

describe('ToolResultMessage.details 落盘(docs/08 §3.2)', () => {
  it('可序列化 details 随行落盘(恢复后 UI 要用)', async () => {
    const editLike = makeTool('edit_like', async () => ({
      content: [{ type: 'text' as const, text: 'edited' }],
      details: { linesChanged: 3 },
    }));
    const h = await makeSession(
      {
        turns: [
          { events: [{ kind: 'tool_call', name: 'edit_like', args: {}, id: 'call_d' }] },
          { events: [{ kind: 'text', text: 'done' }] },
        ],
      },
      [editLike],
    );
    await h.session.prompt('go');
    await h.session.close();

    const onDisk = fileMessages(h.session.id).find((m): m is ToolResultMessage => m.role === 'tool_result');
    expect(onDisk?.details).toEqual({ linesChanged: 3 });
  });

  it('循环引用 details:落盘置 undefined 并告警,写盘不失败;内存转录保留原引用', async () => {
    interface Circular { name: string; self?: Circular }
    const circular: Circular = { name: 'diff' };
    circular.self = circular;
    const withDetails = makeTool('with_details', async () => ({
      content: [{ type: 'text' as const, text: 'edited' }],
      details: circular,
    }));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const h = await makeSession(
      {
        turns: [
          { events: [{ kind: 'tool_call', name: 'with_details', args: {}, id: 'call_c' }] },
          { events: [{ kind: 'text', text: 'done' }] },
        ],
      },
      [withDetails],
    );
    await h.session.prompt('go');
    await h.session.close();

    // 内存(权威转录)保留 details 原引用
    const inMemory = [...h.session.messages].find((m): m is ToolResultMessage => m.role === 'tool_result');
    expect(inMemory?.details).toBe(circular);

    // 盘上该行 details 键消失(置 undefined 后序列化),且后续消息照常写入 → 写盘未失败
    const onDisk = fileMessages(h.session.id);
    expect(onDisk.map((m) => m.role)).toEqual(['user', 'assistant', 'tool_result', 'assistant']);
    const diskResult = onDisk.find((m): m is ToolResultMessage => m.role === 'tool_result');
    expect(diskResult !== undefined && 'details' in diskResult).toBe(false);

    // 无持久化失败事件;告警形态 = console.error 诊断
    expect(h.events.some((e) => e.type === 'error')).toBe(false);
    expect(errSpy.mock.calls.some((args) => String(args[0]).includes('not serializable'))).toBe(true);
  });
});

// ---------- 5. 磁盘写失败降级 ----------

describe('磁盘写失败降级(docs/08 §8)', () => {
  it('append throw → non-fatal error 事件一次,会话降级内存模式继续跑', async () => {
    const h = await makeSession({
      turns: [
        { events: [{ kind: 'text', text: 'first' }] },
        { events: [{ kind: 'text', text: 'second' }] },
      ],
    });
    const appendSpy = vi.spyOn(SessionStore.prototype, 'append').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device');
    });

    await h.session.prompt('go');
    const errors = h.events.filter((e): e is Extract<SessionEvent, { type: 'error' }> => e.type === 'error');
    expect(errors).toHaveLength(1);                               // 降级闩锁:之后不再尝试也不再报
    expect(errors[0]?.fatal).toBe(false);
    expect(errors[0]?.message).toMatch(/persist/i);
    const end = h.events.find((e) => e.type === 'agent_end');
    expect(end?.type === 'agent_end' && end.reason).toBe('completed');   // loop 未被打断

    // 内存里会话完整,usage 照常统计
    expect([...h.session.messages].map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(h.session.usage().turns).toBe(1);
    expect(h.events.some((e) => e.type === 'usage_update')).toBe(true);

    // 第二轮照常跑,不再产生新的持久化错误事件,append 也不再被调用
    await h.session.prompt('again');
    expect([...h.session.messages]).toHaveLength(4);
    expect(h.events.filter((e) => e.type === 'error')).toHaveLength(1);
    expect(appendSpy).toHaveBeenCalledTimes(1);

    // 盘上只有降级前写入的 meta 首行
    expect(readRecords(h.session.id).map((r) => r.type)).toEqual(['meta']);
  });
});

// ---------- 6. usage_update 保序与串行送达(核查修复回归) ----------

describe('usage_update 与主事件同链保序(docs/08 §7.2;session.ts 旁路事件走同一 await 链)', () => {
  it('async listener:message_end(assistant) 后紧跟 usage_update;全程无重入;close 前全部送达', async () => {
    const h = await makeSession({
      turns: [
        { events: [{ kind: 'text', text: 'one' }] },
        { events: [{ kind: 'text', text: 'two' }] },
      ],
    });

    // 慢消费者(仅微任务让出,无计时器):进入即置忙,处理完毕才解除——
    // 若旁路事件被 void fanout(不 await),下一事件会在处理中重入,当场记账。
    const entryOrder: string[] = [];
    const completionOrder: string[] = [];
    const usageTurns: number[] = [];
    let busy = false;
    let reentered = 0;
    h.session.subscribe(async (e) => {
      if (busy) reentered++;
      busy = true;
      const label = e.type === 'message_end' ? `message_end(${e.message.role})` : e.type;
      entryOrder.push(label);
      if (e.type === 'usage_update') usageTurns.push(e.usage.turns);
      for (let hop = 0; hop < 64; hop++) await Promise.resolve();
      completionOrder.push(label);
      busy = false;
    });

    await h.session.prompt('go');
    await h.session.prompt('again');
    await h.session.close();

    expect(reentered).toBe(0);                                    // 串行:任一事件处理期间无并发进入
    expect(completionOrder).toEqual(entryOrder);                  // 完成序 == 到达序(逐个 await 的直接证据)

    // 每个 assistant 的 message_end 之后,紧邻的下一个事件必是 usage_update(不提前、不滞后)
    const assistantEnds = entryOrder
      .map((t, i) => [t, i] as const)
      .filter(([t]) => t === 'message_end(assistant)')
      .map(([, i]) => i);
    expect(assistantEnds).toHaveLength(2);
    for (const i of assistantEnds) expect(entryOrder[i + 1]).toBe('usage_update');

    // close() 返回前全部送达,且快照内容单调递增
    expect(entryOrder.filter((t) => t === 'usage_update')).toHaveLength(2);
    expect(usageTurns).toEqual([1, 2]);
  });
});

// ---------- 7. costUSD 回填(核查修复回归) ----------

describe('costUSD 回填落盘消息(docs/08 §7.3:统计与转录同源,价格变动不漂移)', () => {
  const PRICING = { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 };
  // 手算:(1000-200-100)*3 + 200*0.3 + 100*3.75 + 500*15,单位 1e-6 美元
  const EXPECTED = (700 * 3 + 200 * 0.3 + 100 * 3.75 + 500 * 15) / 1e6;

  it('带 pricing:盘上 assistant 行 usage.costUSD 与手算一致;cumulative 同步', async () => {
    const streamFn = createFauxStreamFn({
      turns: [{ events: [{ kind: 'text', text: 'ok' }], usage: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100 } }],
    });
    const session = await Session.create({
      dir: tmpdir,
      pricing: PRICING,
      agentConfig: { streamFn, model: TEST_MODEL, tools: [], systemPrompt: 'test', cwd: tmpdir },
    });
    await session.prompt('go');
    await session.close();

    const disk = fileMessages(session.id).find((m): m is AssistantMessage => m.role === 'assistant');
    expect(disk?.usage.costUSD).toBeCloseTo(EXPECTED, 12);
    expect(session.usage().cumulative.costUSD).toBeCloseTo(EXPECTED, 12);
  });

  it('不带 pricing resume:消息自带 costUSD 优先,cumulative.costUSD 与原会话一致', async () => {
    const streamFn = createFauxStreamFn({
      turns: [{ events: [{ kind: 'text', text: 'ok' }], usage: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100 } }],
    });
    const session = await Session.create({
      dir: tmpdir,
      pricing: PRICING,
      agentConfig: { streamFn, model: TEST_MODEL, tools: [], systemPrompt: 'test', cwd: tmpdir },
    });
    await session.prompt('go');
    const original = session.usage();
    await session.close();

    const r = await resumeSession(session.id, { turns: [] });       // resumeSession 不带 pricing
    expect(r.session.usage().cumulative.costUSD).toBeCloseTo(EXPECTED, 12);
    expect(r.session.usage().cumulative).toEqual(original.cumulative);
  });
});

// ---------- 8. create fail-fast 与 closed 守卫(核查修复回归) ----------

describe('Session.create fail-fast 与 closed 守卫(docs/08 §8)', () => {
  it.skipIf(process.getuid?.() === 0)(
    'create:会话目录不可写 → rejects(meta 写失败不得静默进内存模式,否则 --resume 无迹可寻)',
    async () => {
      const roDir = path.join(tmpdir, 'readonly-sessions');
      mkdirSync(roDir);
      chmodSync(roDir, 0o500);
      try {
        const streamFn = createFauxStreamFn({ turns: [] });
        await expect(
          Session.create({
            dir: roDir,
            agentConfig: { streamFn, model: TEST_MODEL, tools: [], systemPrompt: 'test', cwd: tmpdir },
          }),
        ).rejects.toThrow();
      } finally {
        chmodSync(roDir, 0o700);                                  // 还原权限,afterEach rmSync 可清理
      }
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    'createWithId:meta 临时写失败不留下空 target 或临时 orphan',
    async () => {
      const roDir = path.join(tmpdir, 'readonly-runtime-sessions');
      mkdirSync(roDir);
      chmodSync(roDir, 0o500);
      const id = 'runtime-atomic-test';
      try {
        const streamFn = createFauxStreamFn({ turns: [] });
        await expect(Session.createWithId(id, {
          dir: roDir,
          agentConfig: { streamFn, model: TEST_MODEL, tools: [], systemPrompt: 'test', cwd: tmpdir },
        })).rejects.toThrow();
        expect(existsSync(path.join(roDir, `${id}.jsonl`))).toBe(false);
        expect(readdirSync(roDir).some((name) => name.includes(id))).toBe(false);
      } finally {
        chmodSync(roDir, 0o700);
      }
    },
  );

  it('close() 后:prompt() 是 async rejection(非同步 throw);steer/followUp 同步 throw', async () => {
    const h = await makeSession({ turns: [] });
    await h.session.close();

    let p: Promise<void> | undefined;
    expect(() => {
      p = h.session.prompt('late');                               // Promise 契约:不同步 throw
    }).not.toThrow();
    await expect(p).rejects.toThrow(/closed/);

    expect(() => h.session.steer('late')).toThrow(/closed/);
    expect(() => h.session.followUp('late')).toThrow(/closed/);
  });

  it('agent running 时 session.prompt():rejection 而非同步 throw,.catch 能接住', async () => {
    const gate = createGate();
    const h = await makeSession({
      turns: [{ events: [{ kind: 'gate', gate }, { kind: 'text', text: 'after gate' }] }],
    });
    const started = h.waitForEvent((e) => e.type === 'message_start' && e.message.role === 'assistant');
    const run = h.session.prompt('first');
    await started;                                                // gate 悬停:agent 确定 running

    let second: Promise<void> | undefined;
    expect(() => {
      second = h.session.prompt('again');
    }).not.toThrow();
    await expect(second).rejects.toThrow(/running/i);

    gate.open();
    await run;                                                    // 冲突不影响第一个任务收尾
    await h.session.close();
    expect([...h.session.messages].map((m) => m.role)).toEqual(['user', 'assistant']);
  });
});

describe('Runtime authoritative event lane', () => {
  it('uses one JSON-safe projection for arbitrary tool details in tool_end, transcript, and mirror', async () => {
    const unsafe = makeTool('unsafe_details', async () => ({
      content: [{ type: 'text', text: 'safe result' }],
      details: {
        optional: undefined,
        callback: () => 'not JSON',
      },
    }));
    const streamFn = createFauxStreamFn({
      turns: [
        { events: [{ kind: 'tool_call', name: 'unsafe_details', args: {}, id: 'unsafe-call' }] },
        { events: [{ kind: 'text', text: 'done' }] },
      ],
    });
    const committed: SessionEvent[] = [];
    const session = await Session.create({
      dir: tmpdir,
      authoritativeEventSink: async (input) => {
        const batch = Array.isArray(input) ? [...input] : [input];
        strictJsonSnapshot(batch);
        committed.push(...batch);
      },
      agentConfig: {
        streamFn,
        model: TEST_MODEL,
        tools: [unsafe],
        systemPrompt: 'test',
        cwd: tmpdir,
      },
    });

    await session.prompt('go');
    const toolEnd = committed.find((event) => event.type === 'tool_execution_end');
    if (toolEnd?.type !== 'tool_execution_end') throw new Error('missing tool_execution_end');
    expect(toolEnd.result).not.toHaveProperty('details');
    const messageStart = committed.find((event) =>
      event.type === 'message_start' && event.message.role === 'tool_result');
    if (messageStart?.type !== 'message_start' || messageStart.message.role !== 'tool_result') {
      throw new Error('missing canonical tool result message_start');
    }
    expect(messageStart.message).toEqual(toolEnd.result);
    const canonicalMessage = committed.find((event) =>
      event.type === 'message_end' && event.message.role === 'tool_result');
    if (canonicalMessage?.type !== 'message_end' || canonicalMessage.message.role !== 'tool_result') {
      throw new Error('missing canonical tool result message');
    }
    expect(canonicalMessage.message).toEqual(toolEnd.result);
    const turnEnd = committed.find((event) => event.type === 'turn_end' && event.toolResults.length > 0);
    if (turnEnd?.type !== 'turn_end') throw new Error('missing canonical turn_end tool result');
    expect(turnEnd.toolResults[0]).toEqual(toolEnd.result);
    const agentEnd = committed.find((event) => event.type === 'agent_end');
    if (agentEnd?.type !== 'agent_end') throw new Error('missing canonical agent_end');
    expect(agentEnd.messages.find((message) => message.role === 'tool_result')).toEqual(toolEnd.result);
    const mirrored = fileMessages(session.id).find((message) => message.role === 'tool_result');
    expect(mirrored).toEqual(toolEnd.result);
    await session.close();
  });

  it('提交失败先中止副作用，prompt/waitForIdle 可观察，且失败事件不落 v1 镜像', async () => {
    const streamFn = createFauxStreamFn({
      turns: [{ events: [{ kind: 'text', text: 'must not be sampled' }] }],
    });
    const attempted: SessionEvent['type'][] = [];
    const publicEvents: SessionEvent[] = [];
    const failure = new Error('canonical journal unavailable');
    const session = await Session.create({
      dir: tmpdir,
      authoritativeEventSink: async (events) => {
        attempted.push(...events.map((event) => event.type));
        if (events.some((event) => event.type === 'turn_start')) throw failure;
      },
      agentConfig: {
        streamFn,
        model: TEST_MODEL,
        tools: [],
        systemPrompt: 'test',
        cwd: tmpdir,
      },
    });
    session.subscribe((event) => {
      publicEvents.push(event);
    });

    await expect(session.prompt('go')).rejects.toBe(failure);
    await expect(session.waitForIdle()).rejects.toBe(failure);

    expect(attempted).toEqual(['agent_start', 'turn_start']);
    expect(publicEvents.map((event) => event.type)).toEqual(['agent_start']);
    expect(streamFn.calls).toHaveLength(0);
    expect(readRecords(session.id).map((record) => record.type)).toEqual(['meta']);
    await session.close();
  });

  it('assistant message 与 usage 以一个 authoritative batch 成败，不留下 split checkpoint', async () => {
    const streamFn = createFauxStreamFn({
      turns: [{
        events: [{ kind: 'text', text: 'priced answer' }],
        usage: { input: 100, output: 10 },
      }],
    });
    const committed: SessionEvent[] = [];
    const failure = new Error('usage checkpoint unavailable');
    const session = await Session.create({
      dir: tmpdir,
      pricing: { inputPer1M: 2, outputPer1M: 3 },
      authoritativeEventSink: async (input) => {
        const batch = Array.isArray(input) ? [...input] : [input];
        if (batch.some((event) => event.type === 'usage_update')) throw failure;
        committed.push(...batch);
      },
      agentConfig: {
        streamFn,
        model: TEST_MODEL,
        tools: [],
        systemPrompt: 'test',
        cwd: tmpdir,
      },
    });

    await expect(session.prompt('go')).rejects.toBe(failure);
    await expect(session.waitForIdle()).rejects.toBe(failure);
    expect(committed.some((event) => event.type === 'message_end'
      && event.message.role === 'assistant')).toBe(false);
    expect(fileMessages(session.id).map((message) => message.role)).toEqual(['user']);
    await session.close();

    const resumed = await Session.resume(session.id, {
      dir: tmpdir,
      pricing: { inputPer1M: 2, outputPer1M: 3 },
      agentConfig: {
        streamFn: createFauxStreamFn({ turns: [] }),
        model: TEST_MODEL,
        tools: [],
        systemPrompt: 'test',
        cwd: tmpdir,
      },
    });
    expect(resumed.usage()).toEqual({
      cumulative: { input: 0, output: 0 },
      turns: 0,
      contextTokens: 0,
    });
    await resumed.close();
  });

  it('按 canonical batch → v1 mirror → public listener 排序并可无漂移 resume usage', async () => {
    const streamFn = createFauxStreamFn({
      turns: [{
        events: [{ kind: 'text', text: 'ordered answer' }],
        usage: { input: 100, output: 10 },
      }],
    });
    const batches: SessionEvent[][] = [];
    const session = await Session.create({
      dir: tmpdir,
      pricing: { inputPer1M: 2, outputPer1M: 3 },
      authoritativeEventSink: async (input) => {
        batches.push(Array.isArray(input) ? [...input] : [input]);
      },
      agentConfig: {
        streamFn,
        model: TEST_MODEL,
        tools: [],
        systemPrompt: 'test',
        cwd: tmpdir,
      },
    });
    const listenerMirrorRoles: string[][] = [];
    session.subscribe((event) => {
      if (event.type === 'message_end') {
        listenerMirrorRoles.push(fileMessages(session.id).map((message) => message.role));
      }
    });

    await session.prompt('go');
    const messageUsageBatch = batches.find((batch) =>
      batch.some((event) => event.type === 'message_end' && event.message.role === 'assistant'));
    expect(messageUsageBatch?.map((event) => event.type)).toEqual(['message_end', 'usage_update']);
    expect(listenerMirrorRoles).toEqual([['user'], ['user', 'assistant']]);
    const beforeClose = session.usage();
    expect(beforeClose.cumulative.costUSD).toBe(0.00023);
    await session.close();

    const resumed = await Session.resume(session.id, {
      dir: tmpdir,
      agentConfig: {
        streamFn: createFauxStreamFn({ turns: [] }),
        model: TEST_MODEL,
        tools: [],
        systemPrompt: 'test',
        cwd: tmpdir,
      },
    });
    expect(resumed.usage()).toEqual(beforeClose);
    await resumed.close();
  });
});
