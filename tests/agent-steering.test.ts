// Steering / follow-up 语义矩阵(docs/06 Steering、Follow-up 与取消)。
// 时序控制只用 gate 与事件等待;出站断言用 faux 的 calls(docs/10 测试策略)。

import { describe, expect, it } from 'bun:test';
import type { UserMessage } from '../src/protocol/index.js';
import type { AgentEvent } from '../src/protocol/agent-events.js';
import { createGate } from '../src/providers/faux/index.js';
import { makeHarness, makeTool, textOutput } from './helpers/agent-harness.js';

function queueUpdates(events: AgentEvent[]): Extract<AgentEvent, { type: 'queue_update' }>[] {
  return events.filter((e): e is Extract<AgentEvent, { type: 'queue_update' }> => e.type === 'queue_update');
}

function outboundSources(h: ReturnType<typeof makeHarness>, call: number): (string | undefined)[] {
  return (h.streamFn.calls[call]?.context.messages ?? [])
    .filter((m): m is UserMessage => m.role === 'user')
    .map((m) => m.source);
}

describe('语义 1:steering 不打断当前 turn', () => {
  it('工具执行中 steer:工具跑完(非 isError),注入发生在该批工具全部完成后的 turn 边界', async () => {
    const gate = createGate();
    let toolDone = false;
    const slow = makeTool('slow', async () => {
      await gate.opened;
      toolDone = true;
      return textOutput('slow finished');
    });
    const h = makeHarness(
      {
        turns: [
          { events: [{ kind: 'tool_call', name: 'slow', args: {}, id: 'c1' }] },
          { events: [{ kind: 'text', text: 'adjusted' }] },
        ],
      },
      { tools: [slow] },
    );
    const started = h.waitForEvent((e) => e.type === 'tool_execution_start');
    const run = h.agent.prompt('go');
    await started;
    h.agent.steer('别动 tests/');          // 工具执行中注入
    expect(toolDone).toBe(false);           // 消息入队时工具尚未结束
    gate.open();
    await run;

    // (a) 出站转录:steering user 紧跟 toolResult 之后(docs/06 §1 三种意图)
    const msgs = h.streamFn.calls[1]?.context.messages ?? [];
    expect(msgs.map((m) => (m.role === 'user' ? `user:${m.source}` : m.role))).toEqual([
      'user:prompt',
      'assistant',
      'tool_result',
      'user:steering',
    ]);
    // (b) 事件相对顺序:tool_execution_end → turn_end → (queue_update) → turn_start → message_start(user)
    const types = h.events.map((e) => e.type);
    const execEnd = types.indexOf('tool_execution_end');
    const turnEnd = types.indexOf('turn_end');
    const secondTurnStart = types.indexOf('turn_start', turnEnd);
    expect(execEnd).toBeLessThan(turnEnd);
    expect(turnEnd).toBeLessThan(secondTurnStart);
    // (c) 工具没有被中断
    const results = h.events.filter(
      (e): e is Extract<AgentEvent, { type: 'tool_execution_end' }> => e.type === 'tool_execution_end',
    );
    expect(results[0]?.result.isError).toBe(false);
  });
});

describe('语义 2:steering 续命', () => {
  it('assistant 无 toolCall + 流式期间注入 steering → 内层继续;队列空才 agent_end', async () => {
    const gate = createGate();
    const h = makeHarness({
      turns: [
        { events: [{ kind: 'text', text: 'first' }, { kind: 'gate', gate }] },
        { events: [{ kind: 'text', text: 'second' }] },
      ],
    });
    const run = h.agent.prompt('go');
    await h.waitForEvent((e) => e.type === 'message_update');
    h.agent.steer('续命消息');
    gate.open();
    await run;

    expect(h.streamFn.calls).toHaveLength(2);
    expect(outboundSources(h, 1)).toEqual(['prompt', 'steering']);
    const ends = h.events.filter((e) => e.type === 'agent_end');
    expect(ends).toHaveLength(1);
    expect(ends[0]?.type === 'agent_end' && ends[0].reason).toBe('completed');
  });

  it('边界 6:steering 注入后模型再发工具调用,内层继续跑多 turn', async () => {
    const gate = createGate();
    const work = makeTool('work', async () => textOutput('done'));
    const h = makeHarness(
      {
        turns: [
          { events: [{ kind: 'text', text: 'idle answer' }, { kind: 'gate', gate }] },
          { events: [{ kind: 'tool_call', name: 'work', args: {}, id: 'c1' }] },   // steering 触发新工具
          { events: [{ kind: 'tool_call', name: 'work', args: {}, id: 'c2' }] },
          { events: [{ kind: 'text', text: 'finally done' }] },
        ],
      },
      { tools: [work] },
    );
    const run = h.agent.prompt('go');
    await h.waitForEvent((e) => e.type === 'message_update');
    h.agent.steer('接着做 X');
    gate.open();
    await run;

    expect(h.streamFn.calls).toHaveLength(4);   // steering 后又跑了 3 次采样
    const ends = h.events.filter((e) => e.type === 'agent_end');
    expect(ends).toHaveLength(1);
  });

  it('边界 6 深链:steering 注入后连续 10 个 tool_call turn + 1 收尾,12 次采样单次 agent_end', async () => {
    const gate = createGate();
    const work = makeTool('work', async () => textOutput('done'));
    const toolTurns = Array.from({ length: 10 }, (_, i) => ({
      events: [{ kind: 'tool_call' as const, name: 'work', args: {}, id: `c${i + 1}` }],
    }));
    const h = makeHarness(
      {
        turns: [
          { events: [{ kind: 'text', text: 'idle answer' }, { kind: 'gate', gate }] },
          ...toolTurns,
          { events: [{ kind: 'text', text: 'finally done' }] },
        ],
      },
      { tools: [work] },
    );
    const run = h.agent.prompt('go');
    await h.waitForEvent((e) => e.type === 'message_update');
    h.agent.steer('接着做 X');
    gate.open();
    await run;

    // 1(被 steer 的首 turn)+ 10 个工具 turn + 1 收尾 = 12 次采样,全程单一 run
    expect(h.streamFn.calls).toHaveLength(12);
    const ends = h.events.filter((e) => e.type === 'agent_end');
    expect(ends).toHaveLength(1);
    expect(ends[0]?.type === 'agent_end' && ends[0].reason).toBe('completed');
  });
});

describe('语义 3:follow-up 只在收尾时消费;steering 永远优先', () => {
  it('流式期间 followUp:turn1 结束后续接(无中间 agent_end),消息 source 为 follow_up', async () => {
    const gate = createGate();
    const h = makeHarness({
      turns: [
        { events: [{ kind: 'text', text: 'task one' }, { kind: 'gate', gate }] },
        { events: [{ kind: 'text', text: 'task two' }] },
      ],
    });
    const run = h.agent.prompt('go');
    await h.waitForEvent((e) => e.type === 'message_update');
    h.agent.followUp('顺便更新 README');
    gate.open();
    await run;

    expect(h.streamFn.calls).toHaveLength(2);
    expect(outboundSources(h, 1)).toEqual(['prompt', 'follow_up']);
    expect(h.events.filter((e) => e.type === 'agent_end')).toHaveLength(1);
  });

  it('turn 内有工具时 follow-up 不被消费(对照 steering 的分化场景)', async () => {
    const work = makeTool('work', async () => textOutput('done'));
    const h = makeHarness(
      {
        turns: [
          { events: [{ kind: 'tool_call', name: 'work', args: {}, id: 'c1' }] },
          { events: [{ kind: 'text', text: 'still task one' }] },
          { events: [{ kind: 'text', text: 'follow-up turn' }] },
        ],
      },
      { tools: [work] },
    );
    const started = h.waitForEvent((e) => e.type === 'tool_execution_start');
    const run = h.agent.prompt('go');
    await started;
    h.agent.followUp('下一个任务');
    await run;

    // 工具回喂的 turn2 不含 follow_up(还没到收尾);turn3 才注入
    expect(h.streamFn.calls).toHaveLength(3);
    expect(outboundSources(h, 1)).toEqual(['prompt']);
    expect(outboundSources(h, 2)).toEqual(['prompt', 'follow_up']);
  });

  it('两队列都有:steering 先注入,follow-up 留待收尾', async () => {
    const gate = createGate();
    const h = makeHarness({
      turns: [
        { events: [{ kind: 'text', text: 't1' }, { kind: 'gate', gate }] },
        { events: [{ kind: 'text', text: 't2 (steered)' }] },
        { events: [{ kind: 'text', text: 't3 (follow-up)' }] },
      ],
    });
    const run = h.agent.prompt('go');
    await h.waitForEvent((e) => e.type === 'message_update');
    h.agent.followUp('follow 消息');   // 先入 follow-up
    h.agent.steer('steer 消息');       // 后入 steering——仍应先被消费
    gate.open();
    await run;

    expect(h.streamFn.calls).toHaveLength(3);
    expect(outboundSources(h, 1)).toEqual(['prompt', 'steering']);
    expect(outboundSources(h, 2)).toEqual(['prompt', 'steering', 'follow_up']);
    expect(h.events.filter((e) => e.type === 'agent_end')).toHaveLength(1);
  });

  it('矩阵行 2「两者都有」:工具执行中同时入两队 → steering 在 turn 边界注入,follow-up 等收尾', async () => {
    const gate = createGate();
    const slow = makeTool('slow', async () => {
      await gate.opened;
      return textOutput('slow done');
    });
    const h = makeHarness(
      {
        turns: [
          { events: [{ kind: 'tool_call', name: 'slow', args: {}, id: 'c1' }] },
          { events: [{ kind: 'text', text: 'steered' }] },
          { events: [{ kind: 'text', text: 'follow-up tail' }] },
        ],
      },
      { tools: [slow] },
    );
    const started = h.waitForEvent((e) => e.type === 'tool_execution_start');
    const run = h.agent.prompt('go');
    await started;
    h.agent.followUp('然后做 Y');
    h.agent.steer('先调整方向');
    gate.open();
    await run;

    expect(h.streamFn.calls).toHaveLength(3);
    // turn 边界(toolResult 之后):只注入 steering;收尾([J])才轮到 follow-up
    expect(outboundSources(h, 1)).toEqual(['prompt', 'steering']);
    expect(outboundSources(h, 2)).toEqual(['prompt', 'steering', 'follow_up']);
    expect(h.events.filter((e) => e.type === 'agent_end')).toHaveLength(1);
  });
});

describe('语义 4:one-at-a-time vs all', () => {
  it('one-at-a-time(默认):3 条 steering 分 3 个 turn 边界逐条注入,顺序 = 入队顺序', async () => {
    const gate = createGate();
    const h = makeHarness({
      turns: [
        { events: [{ kind: 'text', text: 't1' }, { kind: 'gate', gate }] },
        { events: [{ kind: 'text', text: 't2' }] },
        { events: [{ kind: 'text', text: 't3' }] },
        { events: [{ kind: 'text', text: 't4' }] },
      ],
    });
    const run = h.agent.prompt('go');
    await h.waitForEvent((e) => e.type === 'message_update');
    h.agent.steer('s1');
    h.agent.steer('s2');
    h.agent.steer('s3');
    gate.open();
    await run;

    expect(h.streamFn.calls).toHaveLength(4);
    // 逐次多一条 steering(docs/10 测试策略)
    expect(outboundSources(h, 1)).toEqual(['prompt', 'steering']);
    expect(outboundSources(h, 2)).toEqual(['prompt', 'steering', 'steering']);
    expect(outboundSources(h, 3)).toEqual(['prompt', 'steering', 'steering', 'steering']);
    const texts = (h.streamFn.calls[3]?.context.messages ?? [])
      .filter((m): m is UserMessage => m.role === 'user' && m.source === 'steering')
      .map((m) => (m.content[0]?.type === 'text' ? m.content[0].text : ''));
    expect(texts).toEqual(['s1', 's2', 's3']);
  });

  it("all 模式:一次注入全部 3 条", async () => {
    const gate = createGate();
    const h = makeHarness({
      turns: [
        { events: [{ kind: 'text', text: 't1' }, { kind: 'gate', gate }] },
        { events: [{ kind: 'text', text: 't2' }] },
      ],
    });
    h.agent.steeringMode = 'all';
    const run = h.agent.prompt('go');
    await h.waitForEvent((e) => e.type === 'message_update');
    h.agent.steer('s1');
    h.agent.steer('s2');
    h.agent.steer('s3');
    gate.open();
    await run;

    expect(h.streamFn.calls).toHaveLength(2);
    expect(outboundSources(h, 1)).toEqual(['prompt', 'steering', 'steering', 'steering']);
  });

  it("followUpMode 'all':3 条 follow-up 收尾时一次全部注入,顺序 = 入队顺序", async () => {
    const gate = createGate();
    const h = makeHarness({
      turns: [
        { events: [{ kind: 'text', text: 't1' }, { kind: 'gate', gate }] },
        { events: [{ kind: 'text', text: 't2' }] },
      ],
    });
    h.agent.followUpMode = 'all';
    const run = h.agent.prompt('go');
    await h.waitForEvent((e) => e.type === 'message_update');
    h.agent.followUp('f1');
    h.agent.followUp('f2');
    h.agent.followUp('f3');
    gate.open();
    await run;

    expect(h.streamFn.calls).toHaveLength(2);
    expect(outboundSources(h, 1)).toEqual(['prompt', 'follow_up', 'follow_up', 'follow_up']);
    const texts = (h.streamFn.calls[1]?.context.messages ?? [])
      .filter((m): m is UserMessage => m.role === 'user' && m.source === 'follow_up')
      .map((m) => (m.content[0]?.type === 'text' ? m.content[0].text : ''));
    expect(texts).toEqual(['f1', 'f2', 'f3']);
  });

  it("运行中把 steeringMode 从默认切到 'all':该次边界一次取空(live 读取生效)", async () => {
    const gate = createGate();
    const h = makeHarness({
      turns: [
        { events: [{ kind: 'text', text: 't1' }, { kind: 'gate', gate }] },
        { events: [{ kind: 'text', text: 't2' }] },
      ],
    });
    const run = h.agent.prompt('go');   // 起跑时仍是默认 one-at-a-time
    await h.waitForEvent((e) => e.type === 'message_update');
    h.agent.steer('s1');
    h.agent.steer('s2');
    h.agent.steer('s3');
    h.agent.steeringMode = 'all';       // 运行中切换:[I] 每次边界 live 读取,而非 run 起始快照
    gate.open();
    await run;

    expect(h.streamFn.calls).toHaveLength(2);
    expect(outboundSources(h, 1)).toEqual(['prompt', 'steering', 'steering', 'steering']);
  });
});

describe('起跑前 poll(注入点 ①)', () => {
  it('idle 时 steer 两条 → prompt():首 turn 捎上一条(one-at-a-time),prompt 消息在前', async () => {
    const h = makeHarness({
      turns: [
        { events: [{ kind: 'text', text: 't1' }] },
        { events: [{ kind: 'text', text: 't2' }] },
      ],
    });
    h.agent.steer('early-1');
    h.agent.steer('early-2');
    await h.agent.prompt('go');

    expect(outboundSources(h, 0)).toEqual(['prompt', 'steering']);   // 首 turn 注入 1 条
    expect(outboundSources(h, 1)).toEqual(['prompt', 'steering', 'steering']);   // 第二条下个边界

    // 起跑 drain 的 queue_update(docs/06 §3 观察):注入前发射且快照缩减
    const ups = queueUpdates(h.events);
    expect(ups).toHaveLength(4);                                     // 入队 ×2 + [A] drain + [I] drain
    const ids = ups[1]?.steering.map((q) => q.id) ?? [];
    expect(ups[2]?.steering.map((q) => q.id)).toEqual([ids[1] as string]);     // 第 1 条已出队,快照只剩第 2 条
    expect(ups[3]?.steering).toEqual([]);
    const drainIdx = h.events.indexOf(ups[2] as AgentEvent);
    const firstInjectIdx = h.events.findIndex((e) => e.type === 'message_start');
    expect(drainIdx).toBeGreaterThan(-1);
    expect(firstInjectIdx).toBeGreaterThan(drainIdx);                // 先快照后注入
  });
});

describe('queue_update 事件(docs/06 §3)', () => {
  it('入队、注入、清空三个时机各发快照;id 与注入后 UserMessage.id 一致;重复文本不错乱', async () => {
    const gate = createGate();
    const h = makeHarness({
      turns: [
        { events: [{ kind: 'text', text: 't1' }, { kind: 'gate', gate }] },
        { events: [{ kind: 'text', text: 't2' }] },
        { events: [{ kind: 'text', text: 't3' }] },
      ],
    });
    const run = h.agent.prompt('go');
    await h.waitForEvent((e) => e.type === 'message_update');
    const bothEnqueued = h.waitForEvent((e) => e.type === 'queue_update' && e.steering.length === 2);
    h.agent.steer('同样的文本');
    h.agent.steer('同样的文本');       // pi 教训回归:重复文本靠 id 区分
    await bothEnqueued;               // 入队时机的 queue_update 走异步 emit 链
    const afterEnqueue = queueUpdates(h.events);
    expect(afterEnqueue).toHaveLength(2);
    const ids = afterEnqueue[1]?.steering.map((q) => q.id) ?? [];
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);   // 两条同文本消息 id 不同

    gate.open();
    await run;

    // 注入时机的 queue_update:快照按序缩减,且注入消息的 message_start.id 与出队 id 对应
    const updates = queueUpdates(h.events);
    const injectionUpdates = updates.slice(2);
    expect(injectionUpdates[0]?.steering.map((q) => q.id)).toEqual([ids[1] as string]);   // 第 1 条已出队
    expect(injectionUpdates[1]?.steering).toEqual([]);                          // 第 2 条已出队
    const injectedIds = h.events
      .filter((e): e is Extract<AgentEvent, { type: 'message_start' }> => e.type === 'message_start')
      .map((e) => e.message)
      .filter((m): m is UserMessage => m.role === 'user' && m.source === 'steering')
      .map((m) => m.id);
    expect(injectedIds).toEqual(ids);   // QueuedMessage.id === 注入后 UserMessage.id

    // clearQueues:空快照(同样走异步链,等待到达)
    const cleared = h.waitForEvent(
      (e) => e.type === 'queue_update' && e.steering.length === 0 && e.followUp.length === 0,
    );
    h.agent.followUp('残留');
    h.agent.clearQueues();
    await cleared;
    const last = queueUpdates(h.events).at(-1);
    expect(last?.steering).toEqual([]);
    expect(last?.followUp).toEqual([]);
  });

  it('[J] follow-up 消费:注入前发 queue_update 且其 followUp 快照已不含该消息', async () => {
    const gate = createGate();
    const h = makeHarness({
      turns: [
        { events: [{ kind: 'text', text: 't1' }, { kind: 'gate', gate }] },
        { events: [{ kind: 'text', text: 't2' }] },
      ],
    });
    const run = h.agent.prompt('go');
    await h.waitForEvent((e) => e.type === 'message_update');
    h.agent.followUp('收尾任务');
    gate.open();
    await run;

    const ups = queueUpdates(h.events);
    expect(ups).toHaveLength(2);                    // 入队 1 次 + [J] drain 1 次
    expect(ups[0]?.followUp).toHaveLength(1);
    expect(ups[1]?.followUp).toEqual([]);           // drain 快照已不含该消息
    // queue_update 先于注入消息的 message_start(docs/06 §3)
    const drainIdx = h.events.indexOf(ups[1] as AgentEvent);
    const injectIdx = h.events.findIndex(
      (e) => e.type === 'message_start' && e.message.role === 'user' && e.message.source === 'follow_up',
    );
    expect(drainIdx).toBeGreaterThan(-1);
    expect(injectIdx).toBeGreaterThan(drainIdx);
  });

  it('边界 11:空文本/纯空白 steer 与 followUp 是 no-op,不入队不发事件', async () => {
    const h = makeHarness({ turns: [{ events: [{ kind: 'text', text: 'ok' }] }] });
    h.agent.steer('');
    h.agent.steer('   \n\t ');
    h.agent.followUp('');
    await h.agent.prompt('go');   // run 结束时 emit 链已 flush,若有事件必已到达
    expect(queueUpdates(h.events)).toHaveLength(0);
    expect(outboundSources(h, 0)).toEqual(['prompt']);
  });
});

describe('边界 8:length 截断的 turn 与 steering 共存', () => {
  it('length 全批合成失败后照常走 steering 注入点,重试请求含 steering 消息', async () => {
    const gate = createGate();
    const work = makeTool('work', async () => textOutput('never runs'));
    const h = makeHarness(
      {
        turns: [
          {
            events: [
              { kind: 'text', text: 'about to truncate' },
              { kind: 'gate', gate },
              { kind: 'tool_call', name: 'work', args: {}, id: 'c1', truncatedRaw: '{"val' },
            ],
            stopReason: 'length',
          },
          { events: [{ kind: 'text', text: 'retry with steer' }] },
        ],
      },
      { tools: [work] },
    );
    const run = h.agent.prompt('go');
    await h.waitForEvent((e) => e.type === 'message_update');
    h.agent.steer('顺便注意 Y');
    gate.open();
    await run;

    const msgs = h.streamFn.calls[1]?.context.messages ?? [];
    expect(msgs.map((m) => (m.role === 'user' ? `user:${m.source}` : m.role))).toEqual([
      'user:prompt',
      'assistant',
      'tool_result',        // length 合成失败结果
      'user:steering',      // steering 与截断重试共存
    ]);
    const synth = msgs[2];
    expect(synth?.role === 'tool_result' && synth.isError).toBe(true);
  });
});

describe('运行中 clearQueues(docs/06)', () => {
  it('流式挂起时入 2 条 steering 再 clearQueues:零注入、单 turn 完结、空快照事件已发', async () => {
    const gate = createGate();
    const h = makeHarness({
      turns: [{ events: [{ kind: 'text', text: 'only turn' }, { kind: 'gate', gate }] }],
    });
    const run = h.agent.prompt('go');
    await h.waitForEvent((e) => e.type === 'message_update');
    h.agent.steer('q1');
    h.agent.steer('q2');
    const cleared = h.waitForEvent(
      (e) => e.type === 'queue_update' && e.steering.length === 0 && e.followUp.length === 0,
    );
    h.agent.clearQueues();
    gate.open();
    await run;
    await cleared;

    expect(h.streamFn.calls).toHaveLength(1);   // 零注入 → 无「续命」采样,单 turn 完结
    expect(
      h.agent.transcript.filter((m): m is UserMessage => m.role === 'user').map((m) => m.source),
    ).toEqual(['prompt']);
    const ends = h.events.filter((e) => e.type === 'agent_end');
    expect(ends).toHaveLength(1);
    expect(ends[0]?.type === 'agent_end' && ends[0].reason).toBe('completed');
    expect(queueUpdates(h.events).at(-1)?.steering).toEqual([]);   // 空快照
  });

  it('先注入 1 条再 clearQueues:已注入转录的消息不受影响,仅清仍排队的消息', async () => {
    const gate1 = createGate();
    const gate2 = createGate();
    const h = makeHarness({
      turns: [
        { events: [{ kind: 'text', text: 't1' }, { kind: 'gate', gate: gate1 }] },
        { events: [{ kind: 'text', text: 't2' }, { kind: 'gate', gate: gate2 }] },
      ],
    });
    const run = h.agent.prompt('go');
    await h.waitForEvent((e) => e.type === 'message_update');
    h.agent.steer('s1');
    const injected = h.waitForEvent(
      (e) => e.type === 'message_start' && e.message.role === 'user' && e.message.source === 'steering',
    );
    gate1.open();
    await injected;             // s1 已入转录;turn2 因 gate2 挂起,边界未到
    h.agent.steer('s2');
    h.agent.clearQueues();
    gate2.open();
    await run;

    const users = h.agent.transcript.filter((m): m is UserMessage => m.role === 'user');
    expect(users.map((m) => m.source)).toEqual(['prompt', 'steering']);   // s1 保留在转录
    expect(users[1]?.content[0]?.type === 'text' && users[1].content[0].text).toBe('s1');
    expect(h.streamFn.calls).toHaveLength(2);   // s2 被清:无第 3 次采样
  });
});

describe('[H] shouldStopAfterTurn 优先于双队列(docs/05)', () => {
  it('同时入 steering 与 follow-up:两队列都未被 poll;agent_end 后 continue() 先后消费两条', async () => {
    const gate = createGate();
    const h = makeHarness(
      {
        turns: [
          { events: [{ kind: 'text', text: 't1' }, { kind: 'gate', gate }] },
          { events: [{ kind: 'text', text: 't2 (steered)' }] },
          { events: [{ kind: 'text', text: 't3 (follow-up)' }] },
        ],
      },
      { shouldStopAfterTurn: async () => true },
    );
    const run = h.agent.prompt('go');
    await h.waitForEvent((e) => e.type === 'message_update');
    h.agent.steer('留守 steering');
    h.agent.followUp('留守 follow-up');
    gate.open();
    await run;

    // 两队列都未被本 run 消费:单次采样,出站只有 prompt
    expect(h.streamFn.calls).toHaveLength(1);
    expect(outboundSources(h, 0)).toEqual(['prompt']);

    await h.agent.continue();   // 第 1 次:steering 优先
    expect(outboundSources(h, 1)).toEqual(['prompt', 'steering']);
    await h.agent.continue();   // 第 2 次:follow-up 仍完好在队,轮到它
    expect(outboundSources(h, 2)).toEqual(['prompt', 'steering', 'follow_up']);
    const starts = h.events.filter((e) => e.type === 'agent_start');
    expect(starts.map((s) => s.type === 'agent_start' && s.reason)).toEqual([
      'prompt',
      'follow_up',
      'follow_up',
    ]);
  });
});

describe('steer 的 UserMessage 对象重载(docs/06 边界 11 + source 强制)', () => {
  it("对象带 source:'prompt':注入后 source 被强制盖为 'steering'(队列 kind 与 source 永不分叉)", async () => {
    const gate = createGate();
    const h = makeHarness({
      turns: [
        { events: [{ kind: 'text', text: 't1' }, { kind: 'gate', gate }] },
        { events: [{ kind: 'text', text: 't2' }] },
      ],
    });
    const run = h.agent.prompt('go');
    await h.waitForEvent((e) => e.type === 'message_update');
    h.agent.steer({
      role: 'user',
      id: 'u_obj',
      timestamp: 1,
      content: [{ type: 'text', text: '对象重载消息' }],
      source: 'prompt',   // 错误标注:入队时必须被队列对应的 source 覆盖
    });
    gate.open();
    await run;

    expect(outboundSources(h, 1)).toEqual(['prompt', 'steering']);
    const injected = h.agent.transcript.find((m): m is UserMessage => m.role === 'user' && m.id === 'u_obj');
    expect(injected?.source).toBe('steering');
  });

  it('对象但纯空白 content:no-op,不入队不发事件(空文本守卫同样覆盖对象重载)', async () => {
    const h = makeHarness({ turns: [{ events: [{ kind: 'text', text: 'ok' }] }] });
    h.agent.steer({
      role: 'user',
      id: 'u_blank',
      timestamp: 1,
      content: [{ type: 'text', text: '   \n\t ' }],
      source: 'steering',
    });
    await h.agent.prompt('go');
    expect(queueUpdates(h.events)).toHaveLength(0);
    expect(outboundSources(h, 0)).toEqual(['prompt']);
  });
});
