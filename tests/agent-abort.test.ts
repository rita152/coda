// M4 abort 全链路(docs/11 M4 验收 3/4——本里程碑核心验收;docs/06 §6/§7/§9)。
// 断言链:aborted 入转录(事实)→ 出站视图修复(transform)→ wire 配对合法(复用 M2 断言)。

import { describe, expect, it } from 'vitest';
import type { AssistantMessage, ToolResultMessage, UserMessage } from '../src/protocol/index.js';
import { INTERRUPTED_RESULT_TEXT } from '../src/agent/index.js';
import { createGate } from '../src/providers/faux/index.js';
import { makeHarness, makeTool, textOutput, toWireShape } from './helpers/agent-harness.js';
import { assertToolCallPairing } from './helpers/wire-pairing.js';

describe('流式中 abort(矩阵行 3)', () => {
  it('assistant 以 aborted 收尾且保留 partial 文本;agent_end(aborted);队列不清', async () => {
    const gate = createGate();
    const h = makeHarness({
      turns: [
        { events: [{ kind: 'text', text: 'partial answer that gets cut' }, { kind: 'gate', gate }] },
        { events: [{ kind: 'text', text: 'resumed cleanly' }] },
      ],
    });
    const run = h.agent.prompt('go');
    await h.waitForEvent((e) => e.type === 'message_update');
    h.agent.steer('打断前排队的消息');   // 边界 9:abort 恰逢 steering 刚入队
    h.agent.abort();
    gate.open();   // faux 在 gate 等待中观察 signal → aborted 收尾
    await run;

    const assistant = h.agent.transcript.find((m) => m.role === 'assistant') as AssistantMessage;
    expect(assistant.stopReason).toBe('aborted');
    // 已生成的 partial 内容保留在消息里(docs/05 §6 表)
    expect(assistant.content.some((p) => p.type === 'text' && p.text.length > 0)).toBe(true);
    const end = h.events.find((e) => e.type === 'agent_end');
    expect(end?.type === 'agent_end' && end.reason).toBe('aborted');
    expect(h.agent.state).toBe('idle');

    // abort 不清队列:continue() 优先消费 steering,reason 'follow_up',且不双重 drain
    await h.agent.continue();
    expect(h.streamFn.calls).toHaveLength(2);
    const outbound = h.streamFn.calls[1]?.context.messages ?? [];
    // 出站视图:aborted assistant 被 transform 过滤
    expect(outbound.some((m) => m.role === 'assistant' && m.stopReason === 'aborted')).toBe(false);
    const steered = outbound.filter((m): m is UserMessage => m.role === 'user' && m.source === 'steering');
    expect(steered).toHaveLength(1);   // 只 drain 了一次(skipInitialPoll 防双重消费)
    // 权威转录仍保留 aborted 事实
    expect(h.agent.transcript.some((m) => m.role === 'assistant' && m.stopReason === 'aborted')).toBe(true);
    const start2 = h.events.filter((e) => e.type === 'agent_start')[1];
    expect(start2?.type === 'agent_start' && start2.reason).toBe('follow_up');
  });
});

describe('工具执行中 abort(矩阵行 4——核心验收)', () => {
  it('sequential 批:执行中工具收到 signal;后续工具不执行不伪造;孤儿在下次出站补合成结果', async () => {
    const gate = createGate();
    let secondExecuted = false;
    let sawAbortSignal = false;
    const first = makeTool(
      'first',
      async (_args, ctx) => {
        await gate.opened;
        sawAbortSignal = ctx.signal.aborted;   // abort 后才放行,工具应能观察到
        throw new Error('Tool execution was interrupted');
      },
      { executionMode: 'sequential' },
    );
    const second = makeTool('second', async () => {
      secondExecuted = true;
      return textOutput('should never run');
    });
    const h = makeHarness(
      {
        turns: [
          {
            events: [
              { kind: 'tool_call', name: 'first', args: {}, id: 'c1' },
              { kind: 'tool_call', name: 'second', args: {}, id: 'c2' },
            ],
          },
          { events: [{ kind: 'text', text: 'recovered' }] },
        ],
      },
      { tools: [first, second] },
    );
    const started = h.waitForEvent((e) => e.type === 'tool_execution_start');
    const run = h.agent.prompt('go');
    await started;
    h.agent.abort();
    gate.open();
    await run;

    expect(sawAbortSignal).toBe(true);
    expect(secondExecuted).toBe(false);
    // 转录:c1 有 isError 结果(如实),c2 无任何结果(不伪造)——孤儿
    const transcriptResults = h.agent.transcript.filter(
      (m): m is ToolResultMessage => m.role === 'tool_result',
    );
    expect(transcriptResults.map((r) => r.toolCallId)).toEqual(['c1']);
    expect(transcriptResults[0]?.isError).toBe(true);
    const end = h.events.find((e) => e.type === 'agent_end');
    expect(end?.type === 'agent_end' && end.reason).toBe('aborted');
    // [G] 检查(docs/05 §2):工具批执行中被 abort → 批后直接收尾,不再发起下一次采样
    expect(h.streamFn.calls).toHaveLength(1);

    // 下一次出站(continue 重采样):孤儿 c2 已补合成结果,配对合法(检查 convertContext 产物)
    await h.agent.continue();
    const start2 = h.events.filter((e) => e.type === 'agent_start')[1];
    expect(start2?.type === 'agent_start' && start2.reason).toBe('continue');   // 队列空:纯重采样
    const outbound = h.streamFn.calls[1]?.context.messages ?? [];
    const outboundResults = outbound.filter((m): m is ToolResultMessage => m.role === 'tool_result');
    expect(outboundResults.map((r) => r.toolCallId)).toEqual(['c1', 'c2']);
    const synth = outboundResults[1];
    expect(synth?.isError).toBe(true);
    expect(synth?.content).toEqual([{ type: 'text', text: INTERRUPTED_RESULT_TEXT }]);
    // ★ 复用 M2 配对断言直接验 wire 形状(docs/11 M4 验收 3)
    assertToolCallPairing(toWireShape(outbound));
  });

  it('parallel 批:各工具自行了断,已 settle 的结果保留;批后 [G] 收尾 agent_end(aborted)', async () => {
    const gate = createGate();
    const fast = makeTool('fast', async () => textOutput('fast done'));
    const slow = makeTool('slow', async (_args, ctx) => {
      await gate.opened;
      if (ctx.signal.aborted) throw new Error('Tool execution was interrupted');
      return textOutput('slow done');
    });
    const h = makeHarness(
      {
        turns: [
          {
            events: [
              { kind: 'tool_call', name: 'fast', args: {}, id: 'cf' },
              { kind: 'tool_call', name: 'slow', args: {}, id: 'cs' },
            ],
          },
          { events: [{ kind: 'text', text: 'after' }] },
        ],
      },
      { tools: [fast, slow] },
    );
    const fastDone = h.waitForEvent((e) => e.type === 'tool_execution_end' && e.toolCallId === 'cf');
    const run = h.agent.prompt('go');
    await fastDone;
    h.agent.abort();
    gate.open();
    await run;

    // 已完成的 fast 结果保留且非 isError;slow 中断为 isError;按源顺序回填
    const results = h.agent.transcript.filter((m): m is ToolResultMessage => m.role === 'tool_result');
    expect(results.map((r) => [r.toolCallId, r.isError])).toEqual([
      ['cf', false],
      ['cs', true],
    ]);
    const end = h.events.find((e) => e.type === 'agent_end');
    expect(end?.type === 'agent_end' && end.reason).toBe('aborted');
    // 全批有结果:出站无需补孤儿,配对本就合法
    await h.agent.continue();
    assertToolCallPairing(toWireShape(h.streamFn.calls[1]?.context.messages ?? []));
  });
});

describe('idle abort 与队列保留细则', () => {
  it('idle 时 abort() 是 no-op', async () => {
    const h = makeHarness({ turns: [{ events: [{ kind: 'text', text: 'ok' }] }] });
    h.agent.abort();   // 不 throw、无副作用
    await h.agent.prompt('go');
    const end = h.events.find((e) => e.type === 'agent_end');
    expect(end?.type === 'agent_end' && end.reason).toBe('completed');
  });

  it('abort 后 follow-up 队列同样保留;steering 空时 continue() 消费 follow-up', async () => {
    const gate = createGate();
    const h = makeHarness({
      turns: [
        { events: [{ kind: 'text', text: 'cut' }, { kind: 'gate', gate }] },
        { events: [{ kind: 'text', text: 'follow-up run' }] },
      ],
    });
    const run = h.agent.prompt('go');
    await h.waitForEvent((e) => e.type === 'message_update');
    h.agent.followUp('之后做这个');
    h.agent.abort();
    gate.open();
    await run;

    await h.agent.continue();
    const outbound = h.streamFn.calls[1]?.context.messages ?? [];
    const followed = outbound.filter((m): m is UserMessage => m.role === 'user' && m.source === 'follow_up');
    expect(followed).toHaveLength(1);
    const start2 = h.events.filter((e) => e.type === 'agent_start')[1];
    expect(start2?.type === 'agent_start' && start2.reason).toBe('follow_up');
  });

  it('两队列皆空且转录完好时 continue() throw', async () => {
    const h = makeHarness({ turns: [{ events: [{ kind: 'text', text: 'done' }] }] });
    await h.agent.prompt('go');
    expect(() => h.agent.continue()).toThrow('Nothing to continue');
  });
});

describe('continue() 的 drain 语义(M4 对抗核查:skipInitialPoll 与队列优先级)', () => {
  it('abort 前排 2 条 steering:continue() 首次出站恰 1 条(预 drain 后 [A] 不再二次 drain),第 2 条下个边界注入', async () => {
    const gate = createGate();
    const h = makeHarness({
      turns: [
        { events: [{ kind: 'text', text: 'cut' }, { kind: 'gate', gate }] },
        { events: [{ kind: 'text', text: 'first continue turn' }] },
        { events: [{ kind: 'text', text: 'second steering turn' }] },
      ],
    });
    const run = h.agent.prompt('go');
    await h.waitForEvent((e) => e.type === 'message_update');
    h.agent.steer('s1');
    h.agent.steer('s2');
    h.agent.abort();
    gate.open();
    await run;

    await h.agent.continue();
    const steeringTexts = (call: number): string[] =>
      (h.streamFn.calls[call]?.context.messages ?? [])
        .filter((m): m is UserMessage => m.role === 'user' && m.source === 'steering')
        .map((m) => (m.content[0]?.type === 'text' ? m.content[0].text : ''));
    expect(h.streamFn.calls).toHaveLength(3);
    // 首次出站恰 1 条(one-at-a-time):无条件 drain 会让 [A] 把 s2 也吸进首 turn
    expect(steeringTexts(1)).toEqual(['s1']);
    // 两条都到齐且分属两次出站:s2 在下个 turn 边界([I])注入
    expect(steeringTexts(2)).toEqual(['s1', 's2']);
  });

  it('continue():steering 优先于 follow-up;follow-up 在该 run 收尾时才注入(docs/06 语义 3)', async () => {
    const gate = createGate();
    const h = makeHarness({
      turns: [
        { events: [{ kind: 'text', text: 'cut' }, { kind: 'gate', gate }] },
        { events: [{ kind: 'text', text: 'steered' }] },
        { events: [{ kind: 'text', text: 'follow-up tail' }] },
      ],
    });
    const run = h.agent.prompt('go');
    await h.waitForEvent((e) => e.type === 'message_update');
    h.agent.followUp('f1');   // 先入 follow-up
    h.agent.steer('s1');      // 后入 steering——continue() 仍先消费 steering(队列优先级,非跨队列 FIFO)
    h.agent.abort();
    gate.open();
    await run;

    await h.agent.continue();
    const start2 = h.events.filter((e) => e.type === 'agent_start')[1];
    expect(start2?.type === 'agent_start' && start2.reason).toBe('follow_up');
    const sources = (call: number): (string | undefined)[] =>
      (h.streamFn.calls[call]?.context.messages ?? [])
        .filter((m): m is UserMessage => m.role === 'user')
        .map((m) => m.source);
    // 首次出站:含 steering、无 follow_up
    expect(sources(1)).toEqual(['prompt', 'steering']);
    // follow-up 等该 run 收尾([J])才进转录
    expect(sources(2)).toEqual(['prompt', 'steering', 'follow_up']);
    expect(h.events.filter((e) => e.type === 'agent_end')).toHaveLength(2);   // abort run + continue run
  });
});
