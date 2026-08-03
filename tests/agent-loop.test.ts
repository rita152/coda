// M3 runLoop 语义测试(L4,全离线,faux provider;规格出处 docs/05-agent-loop.md、docs/11 M3 验收)。
// 时序控制只用 gate 与事件等待;出站断言用 faux 的 calls。

import { describe, expect, it, vi } from 'bun:test';
import type {
  AgentEvent,
  AssistantMessage,
  ProviderEvent,
  ProviderEventStream,
  ToolResultMessage,
} from '../src/protocol/index.js';
import { createGate } from '../src/providers/faux/index.js';
import type { RuntimeTurnProvider } from '../src/agent/index.js';
import {
  makeHarness,
  makeRuntimeTurnProvider,
  makeTool,
  textOutput,
  typeSequence,
} from './helpers/agent-harness.js';

/** 只折叠连续的 message_update(唯一合法的高频重复);其余事件一律保留——意外重复即缺陷。 */
function collapse(seq: string[]): string[] {
  return seq.filter((t, i) => t !== 'message_update' || seq[i - 1] !== 'message_update');
}

function toolResultsOf(events: AgentEvent[]): ToolResultMessage[] {
  return events
    .filter((e): e is Extract<AgentEvent, { type: 'message_end' }> => e.type === 'message_end')
    .map((e) => e.message)
    .filter((m): m is ToolResultMessage => m.role === 'tool_result');
}

describe('runLoop:一路到完成路径(M3)', () => {
  it('纯文本回复 + 空队列:恰好 1 turn,事件骨架完整', async () => {
    const h = makeHarness({ turns: [{ events: [{ kind: 'text', text: 'hello world' }] }] });
    await h.agent.prompt('hi');

    expect(collapse(typeSequence(h.events))).toEqual([
      'agent_start(prompt)',
      'turn_start',
      'message_start(user)',
      'message_end(user)',
      'message_start(assistant)',
      'message_update',
      'message_end(assistant)',
      'turn_end',
      'agent_end(completed)',
    ]);
    // 出站断言:prompt 消息以 source:'prompt' 进入转录
    const call = h.streamFn.calls[0];
    expect(call?.context.messages).toHaveLength(1);
    const first = call?.context.messages[0];
    expect(first?.role).toBe('user');
    expect(first?.role === 'user' && first.source).toBe('prompt');
  });

  it('tool_calls → 执行 → 回喂 → stop:两 turn,结果按 id 配对回喂', async () => {
    const executed: string[] = [];
    const alpha = makeTool('alpha', async (args) => {
      executed.push(args.value ?? '');
      return textOutput(`alpha saw ${args.value ?? ''}`);
    });
    const h = makeHarness(
      {
        turns: [
          { events: [{ kind: 'tool_call', name: 'alpha', args: { value: 'x1' }, id: 'call_1' }] },
          { events: [{ kind: 'text', text: 'done' }] },
        ],
      },
      { tools: [alpha] },
    );
    await h.agent.prompt('go');

    expect(executed).toEqual(['x1']);
    expect(h.streamFn.calls).toHaveLength(2);
    // 第二次出站:assistant(tool_calls) 后紧跟 tool_result,配对合法
    const msgs = h.streamFn.calls[1]?.context.messages ?? [];
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'tool_result']);
    const tr = msgs[2] as ToolResultMessage;
    expect(tr.toolCallId).toBe('call_1');
    expect(tr.isError).toBe(false);
    expect(tr.content).toEqual([{ type: 'text', text: 'alpha saw x1' }]);
    // 事件骨架:tool 执行事件与 toolResult 消息都在 turn_end 前
    const seq = typeSequence(h.events);
    expect(seq.indexOf('tool_execution_end')).toBeLessThan(seq.indexOf('message_start(tool_result)'));
    expect(seq.indexOf('message_end(tool_result)')).toBeLessThan(seq.indexOf('turn_end'));
    const endSeq = h.events.filter((e) => e.type === 'agent_end');
    expect(endSeq).toHaveLength(1);
    expect(endSeq[0]?.type === 'agent_end' && endSeq[0].reason).toBe('completed');
  });

  it('同一 assistant 重复 toolCallId 在 prepare 前转为不可重试协议错误', async () => {
    const executed = vi.fn(async () => textOutput('must not execute'));
    const alpha = makeTool('alpha', executed);
    const h = makeHarness(
      {
        turns: [{
          events: [
            { kind: 'tool_call', name: 'alpha', args: { value: 'one' }, id: 'call_duplicate' },
            { kind: 'tool_call', name: 'alpha', args: { value: 'two' }, id: 'call_duplicate' },
          ],
        }],
      },
      { tools: [alpha] },
    );

    await h.agent.prompt('go');

    expect(executed).not.toHaveBeenCalled();
    expect(h.events.some((event) => event.type === 'tool_execution_start')).toBe(false);
    const final = h.agent.transcript.findLast((message) => message.role === 'assistant');
    expect(final?.role === 'assistant' && final.stopReason).toBe('error');
    expect(final?.role === 'assistant' && final.errorDetails).toMatchObject({
      code: 'duplicate_tool_call_id',
      retryable: false,
    });
    expect(final?.role === 'assistant' && final.content.some((part) => part.type === 'tool_call')).toBe(false);
  });

  it('Runtime turn 同时冻结 provider schema 与 executor，热更新只影响下一 turn', async () => {
    let liveVersion = 1;
    const capturedVersions: number[] = [];
    const executedVersions: number[] = [];
    const delegate: { current?: ReturnType<typeof makeHarness>['streamFn'] } = {};
    const runtimeTurnProvider: RuntimeTurnProvider = {
      capture: async () => {
        const capturedVersion = liveVersion;
        capturedVersions.push(capturedVersion);
        return {
          streamFn: (model, context, options) => {
            if (delegate.current === undefined) throw new Error('test provider delegate is not ready');
            return delegate.current(model, context, options);
          },
          assemble: (messages) => ({
            ok: true,
            context: {
              systemPrompt: `runtime-v${capturedVersion}`,
              messages: [...messages],
              tools: [{
                name: 'alpha',
                description: `schema-v${capturedVersion}`,
                parameters: { type: 'object' },
              }],
            },
          }),
          prepareToolCall: async (call) => ({
            ok: true,
            args: call.arguments,
            executionMode: 'parallel',
            execute: async () => {
              executedVersions.push(capturedVersion);
              return textOutput(`executor-v${capturedVersion}`);
            },
          }),
        };
      },
    };
    const h = makeHarness({
      turns: [
        {
          onRequest: () => { liveVersion = 2; },
          events: [{ kind: 'tool_call', name: 'alpha', args: {}, id: 'call_versioned' }],
        },
        { events: [{ kind: 'text', text: 'done' }] },
      ],
    }, { runtimeTurnProvider });
    delegate.current = h.streamFn;

    await h.agent.prompt('go');

    expect(capturedVersions).toEqual([1, 2]);
    expect(executedVersions).toEqual([1]);
    expect(h.streamFn.calls.map((call) => call.context.tools?.[0]?.description)).toEqual([
      'schema-v1',
      'schema-v2',
    ]);
  });

  it('Runtime turn snapshot 完成前不发布 turn_start', async () => {
    const gate = createGate();
    let markCaptureEntered!: () => void;
    const captureEntered = new Promise<void>((resolve) => { markCaptureEntered = resolve; });
    const delegate: { current?: ReturnType<typeof makeHarness>['streamFn'] } = {};
    const runtimeTurnProvider: RuntimeTurnProvider = {
      capture: async () => {
        markCaptureEntered();
        await gate.opened;
        return {
          streamFn: (model, context, options) => {
            if (delegate.current === undefined) throw new Error('test provider delegate is not ready');
            return delegate.current(model, context, options);
          },
          assemble: (messages) => ({
            ok: true,
            context: { systemPrompt: 'captured', messages: [...messages], tools: [] },
          }),
          prepareToolCall: async () => ({ ok: false, message: 'unexpected tool call' }),
        };
      },
    };
    const h = makeHarness({ turns: [{ events: [{ kind: 'text', text: 'done' }] }] }, {
      runtimeTurnProvider,
    });
    delegate.current = h.streamFn;

    const completion = h.agent.prompt('go');
    await captureEntered;
    expect(typeSequence(h.events)).toEqual(['agent_start(prompt)']);
    gate.open();
    await completion;
    expect(typeSequence(h.events)).toContain('turn_start');
  });

  it('Runtime turn snapshot 失败仍用完整 error turn 闭合，provider 零调用', async () => {
    const h = makeHarness({ turns: [{ events: [{ kind: 'text', text: 'must not sample' }] }] }, {
      runtimeTurnProvider: {
        capture: async () => { throw new Error('snapshot boom'); },
      },
    });

    await h.agent.prompt('go');

    expect(h.streamFn.calls).toHaveLength(0);
    expect(collapse(typeSequence(h.events))).toEqual([
      'agent_start(prompt)',
      'turn_start',
      'message_start(user)',
      'message_end(user)',
      'error',
      'message_start(assistant)',
      'message_end(assistant)',
      'turn_end',
      'agent_end(error)',
    ]);
  });

  it('Runtime turn snapshot 取消会唤醒 capture 并形成完整 aborted turn', async () => {
    let markCaptureEntered!: () => void;
    const captureEntered = new Promise<void>((resolve) => { markCaptureEntered = resolve; });
    const h = makeHarness({ turns: [{ events: [{ kind: 'text', text: 'must not sample' }] }] }, {
      runtimeTurnProvider: {
        capture: async ({ signal }): Promise<never> => {
          markCaptureEntered();
          await new Promise<never>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('capture aborted')), { once: true });
          });
          throw new Error('unreachable capture continuation');
        },
      },
    });

    const completion = h.agent.prompt('go');
    await captureEntered;
    h.agent.abort();
    await Promise.all([completion, h.agent.waitForIdle()]);

    expect(h.streamFn.calls).toHaveLength(0);
    expect(collapse(typeSequence(h.events))).toEqual([
      'agent_start(prompt)',
      'turn_start',
      'message_start(user)',
      'message_end(user)',
      'message_start(assistant)',
      'message_end(assistant)',
      'turn_end',
      'agent_end(aborted)',
    ]);
    const final = h.agent.transcript.findLast((message) => message.role === 'assistant');
    expect(final?.role === 'assistant' && final.stopReason).toBe('aborted');
    expect(final?.role === 'assistant' && final.errorDetails).toEqual({
      kind: 'aborted',
      retryable: false,
    });
  });

  it('两个 toolCall:结果按源顺序回填,tool_execution_end 按完成顺序(gate 控制第 1 个慢)', async () => {
    const gate = createGate();
    const slow = makeTool('slow', async () => {
      await gate.opened;                      // 测试观察到 fast 的 end 事件后才放行——完成顺序确定
      return textOutput('slow done');
    });
    const fast = makeTool('fast', async () => textOutput('fast done'));
    const h = makeHarness(
      {
        turns: [
          {
            events: [
              { kind: 'tool_call', name: 'slow', args: {}, id: 'call_s' },
              { kind: 'tool_call', name: 'fast', args: {}, id: 'call_f' },
            ],
          },
          { events: [{ kind: 'text', text: 'ok' }] },
        ],
      },
      { tools: [slow, fast] },
    );
    const fastEnded = h.waitForEvent((e) => e.type === 'tool_execution_end' && e.toolCallId === 'call_f');
    const run = h.agent.prompt('go');
    await fastEnded;                          // fast 先完成——同时证明批内确实并发(否则死锁超时)
    gate.open();
    await run;

    // tool_execution_end 按完成顺序:fast 先
    const execEnds = h.events.filter(
      (e): e is Extract<AgentEvent, { type: 'tool_execution_end' }> => e.type === 'tool_execution_end',
    );
    expect(execEnds.map((e) => e.toolCallId)).toEqual(['call_f', 'call_s']);
    // toolResult 消息按 assistant 源顺序:slow 先
    expect(toolResultsOf(h.events).map((m) => m.toolCallId)).toEqual(['call_s', 'call_f']);
    // 出站转录同序
    const msgs = h.streamFn.calls[1]?.context.messages ?? [];
    const wireOrder = msgs.filter((m): m is ToolResultMessage => m.role === 'tool_result');
    expect(wireOrder.map((m) => m.toolCallId)).toEqual(['call_s', 'call_f']);
  });

  it('stopReason length + toolCalls:全批合成 isError、execute 不被调用、loop 继续', async () => {
    const spy = vi.fn(async () => textOutput('should not run'));
    const alpha = makeTool('alpha', spy);
    const h = makeHarness(
      {
        turns: [
          {
            events: [
              { kind: 'tool_call', name: 'alpha', args: {}, id: 'call_a', truncatedRaw: '{"value":"ab' },
              { kind: 'tool_call', name: 'alpha', args: { value: 'ok' }, id: 'call_b' },
            ],
            stopReason: 'length',
          },
          { events: [{ kind: 'text', text: 'retry done' }] },
        ],
      },
      { tools: [alpha] },
    );
    await h.agent.prompt('go');

    expect(spy).not.toHaveBeenCalled();
    const results = toolResultsOf(h.events);
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.isError).toBe(true);
      expect(r.content[0]?.type === 'text' && r.content[0].text).toContain('stopReason: length');
      expect(r.content[0]?.type === 'text' && r.content[0].text).toContain('was not executed');
    }
    expect(h.streamFn.calls).toHaveLength(2);   // loop 继续采样
  });

  it('未知工具名:isError 含可用工具列表,任务继续', async () => {
    const alpha = makeTool('alpha', async () => textOutput('a'));
    const h = makeHarness(
      {
        turns: [
          { events: [{ kind: 'tool_call', name: 'nope', args: {}, id: 'call_x' }] },
          { events: [{ kind: 'text', text: 'recovered' }] },
        ],
      },
      { tools: [alpha] },
    );
    await h.agent.prompt('go');

    const [r] = toolResultsOf(h.events);
    expect(r?.isError).toBe(true);
    const text = r?.content[0]?.type === 'text' ? r.content[0].text : '';
    expect(text).toContain('Unknown tool "nope"');
    expect(text).toContain('alpha');
    expect(h.streamFn.calls).toHaveLength(2);
  });

  it('参数校验失败:isError 含逐字段错误与重写提示,任务继续', async () => {
    const strict = makeTool('strict', async () => textOutput('never'));
    const h = makeHarness(
      {
        turns: [
          { events: [{ kind: 'tool_call', name: 'strict', args: { value: 123 as unknown as string }, id: 'call_v' }] },
          { events: [{ kind: 'text', text: 'fixed' }] },
        ],
      },
      { tools: [strict] },
    );
    await h.agent.prompt('go');

    const [r] = toolResultsOf(h.events);
    expect(r?.isError).toBe(true);
    const text = r?.content[0]?.type === 'text' ? r.content[0].text : '';
    expect(text).toContain('invalid arguments');
    expect(text).toContain('rewrite the input');
    // 逐字段错误文案(z.prettifyError):必须含字段名与类型期望——删掉 prettifyError 拼接即红
    expect(text).toContain('value');
    expect(text).toContain('expected string, received number');
    expect(h.streamFn.calls).toHaveLength(2);
  });

  it('工具 execute throw:isError 回喂,loop 继续', async () => {
    const bad = makeTool('bad', async () => {
      throw new Error('disk on fire');
    });
    const h = makeHarness(
      {
        turns: [
          { events: [{ kind: 'tool_call', name: 'bad', args: {}, id: 'call_e' }] },
          { events: [{ kind: 'text', text: 'ok' }] },
        ],
      },
      { tools: [bad] },
    );
    await h.agent.prompt('go');

    const [r] = toolResultsOf(h.events);
    expect(r?.isError).toBe(true);
    expect(r?.content[0]?.type === 'text' && r.content[0].text).toBe('disk on fire');
    expect(h.streamFn.calls).toHaveLength(2);
  });

  it('terminate:全批 terminate → run 结束(不再采样)', async () => {
    const done = makeTool('done', async () => ({ content: [{ type: 'text' as const, text: 'fin' }], terminate: true }));
    const h = makeHarness(
      {
        // 只有 1 个 turn:若 loop 再采样,faux onExhausted:'throw' 会让测试失败
        turns: [{ events: [{ kind: 'tool_call', name: 'done', args: {}, id: 'call_t' }] }],
      },
      { tools: [done] },
    );
    await h.agent.prompt('go');

    expect(h.streamFn.calls).toHaveLength(1);
    const end = h.events.find((e) => e.type === 'agent_end');
    expect(end?.type === 'agent_end' && end.reason).toBe('completed');
  });

  it('terminate:2 个中 1 个 terminate → 继续采样', async () => {
    const done = makeTool('done', async () => ({ content: [{ type: 'text' as const, text: 'fin' }], terminate: true }));
    const keep = makeTool('keep', async () => textOutput('more'));
    const h = makeHarness(
      {
        turns: [
          {
            events: [
              { kind: 'tool_call', name: 'done', args: {}, id: 'call_1' },
              { kind: 'tool_call', name: 'keep', args: {}, id: 'call_2' },
            ],
          },
          { events: [{ kind: 'text', text: 'continue' }] },
        ],
      },
      { tools: [done, keep] },
    );
    await h.agent.prompt('go');
    expect(h.streamFn.calls).toHaveLength(2);
  });

  it('shouldStopAfterTurn 返回 true:直接结束、不 poll 队列,残留可被 continue() 消费', async () => {
    const gate = createGate();
    const h = makeHarness(
      {
        turns: [
          { events: [{ kind: 'text', text: 'thinking' }, { kind: 'gate', gate }] },
          { events: [{ kind: 'text', text: 'after steer' }] },
        ],
      },
      { shouldStopAfterTurn: async () => true },
    );
    const run = h.agent.prompt('go');
    await h.waitForEvent((e) => e.type === 'message_update');
    h.agent.steer('注入一条');           // 流式中入队;shouldStop 优先,不得被本 run 消费
    gate.open();
    await run;

    expect(h.streamFn.calls).toHaveLength(1);
    const end = h.events.find((e) => e.type === 'agent_end');
    expect(end?.type === 'agent_end' && end.reason).toBe('completed');

    // 残留队列由 continue() 消费:steering 消息以 source:'steering' 进入下一 run
    await h.agent.continue();
    expect(h.streamFn.calls).toHaveLength(2);
    const msgs = h.streamFn.calls[1]?.context.messages ?? [];
    const steered = msgs.find((m) => m.role === 'user' && m.source === 'steering');
    expect(steered).toBeDefined();
    const start2 = h.events.filter((e) => e.type === 'agent_start')[1];
    expect(start2?.type === 'agent_start' && start2.reason).toBe('follow_up');
  });

  it('steering 注入最小冒烟:运行中 steer(),注入落在 turn 边界,下一 turn 出站含 source:steering(docs/11 M3)', async () => {
    const gate = createGate();
    const h = makeHarness({
      turns: [
        { events: [{ kind: 'text', text: 'thinking' }, { kind: 'gate', gate }] },
        { events: [{ kind: 'text', text: 'after steer' }] },
      ],
    });
    const run = h.agent.prompt('go');
    await h.waitForEvent((e) => e.type === 'message_update');
    h.agent.steer('mid-run steer');       // 流式中入队;gate 保证入队先于 turn 结束
    gate.open();
    await run;

    // 注入不早于 turn 边界:第 1 次出站无 steering,第 2 次出站有
    expect(h.streamFn.calls).toHaveLength(2);
    const firstMsgs = h.streamFn.calls[0]?.context.messages ?? [];
    expect(firstMsgs.some((m) => m.role === 'user' && m.source === 'steering')).toBe(false);
    const secondMsgs = h.streamFn.calls[1]?.context.messages ?? [];
    const steered = secondMsgs.find((m) => m.role === 'user' && m.source === 'steering');
    expect(steered).toBeDefined();
    expect(steered?.role === 'user' && steered.content[0]?.type === 'text' && steered.content[0].text).toBe(
      'mid-run steer',
    );
    // 事件序:turn_end 之后 queue_update(drain 快照,M4)→ turn_start → message_start(user)
    // (turn 边界注入,非流中插入)
    const seq = typeSequence(h.events);
    const firstTurnEnd = seq.indexOf('turn_end');
    expect(firstTurnEnd).toBeGreaterThan(-1);
    expect(seq.slice(firstTurnEnd + 1, firstTurnEnd + 4)).toEqual([
      'queue_update',
      'turn_start',
      'message_start(user)',
    ]);
    // steering「续命」后正常完结:单次 agent_end(completed)
    const ends = h.events.filter((e) => e.type === 'agent_end');
    expect(ends).toHaveLength(1);
    expect(ends[0]?.type === 'agent_end' && ends[0].reason).toBe('completed');
  });

  it('sequential 声明:批内含 sequential 工具 → 整批顺序执行(事件严格嵌套)', async () => {
    const a = makeTool('a', async () => textOutput('a'));
    const b = makeTool('b', async () => textOutput('b'), { executionMode: 'sequential' });
    const h = makeHarness(
      {
        turns: [
          {
            events: [
              { kind: 'tool_call', name: 'a', args: {}, id: 'call_a' },
              { kind: 'tool_call', name: 'b', args: {}, id: 'call_b' },
            ],
          },
          { events: [{ kind: 'text', text: 'ok' }] },
        ],
      },
      { tools: [a, b] },
    );
    await h.agent.prompt('go');

    const seq = h.events
      .filter((e) => e.type === 'tool_execution_start' || e.type === 'tool_execution_end')
      .map((e) => `${e.type === 'tool_execution_start' ? 'start' : 'end'}:${'toolCallId' in e ? e.toolCallId : ''}`);
    expect(seq).toEqual(['start:call_a', 'end:call_a', 'start:call_b', 'end:call_b']);
  });

  it('faux error 事件(模拟 500):error assistant 入转录,agent_end(error);continue() 重采样', async () => {
    const h = makeHarness({
      turns: [
        { error: { message: 'HTTP 500 upstream exploded', details: { kind: 'http', status: 500, retryable: true } } },
        { events: [{ kind: 'text', text: 'second try ok' }] },
      ],
    });
    await h.agent.prompt('go');

    const end = h.events.find((e) => e.type === 'agent_end');
    expect(end?.type === 'agent_end' && end.reason).toBe('error');
    const assistant = h.agent.transcript.find((m) => m.role === 'assistant');
    expect(assistant?.role === 'assistant' && assistant.stopReason).toBe('error');
    expect(assistant?.role === 'assistant' && assistant.errorMessage).toContain('500');

    // 残局重采样:reason 'continue'
    await h.agent.continue();
    expect(h.streamFn.calls).toHaveLength(2);
    const start2 = h.events.filter((e) => e.type === 'agent_start')[1];
    expect(start2?.type === 'agent_start' && start2.reason).toBe('continue');
  });

  it('违约 StreamFn(同步 throw):防御路径合成 error assistant + fatal 事件,loop 不崩', async () => {
    const { Agent } = await import('../src/agent/index.js');
    const streamFn = () => {
      throw new Error('rogue provider');
    };
    const agent = new Agent({
      model: { ref: { provider: 'rogue', api: 'x', model: 'y' } },
      runtimeTurnProvider: makeRuntimeTurnProvider(streamFn),
    });
    const events: AgentEvent[] = [];
    agent.subscribe((e) => {
      events.push(e);
    });
    await agent.prompt('go');

    const fatal = events.find((e) => e.type === 'error');
    expect(fatal?.type === 'error' && fatal.fatal).toBe(true);
    const end = events.find((e) => e.type === 'agent_end');
    expect(end?.type === 'agent_end' && end.reason).toBe('error');
    const assistant = agent.transcript.find((m) => m.role === 'assistant');
    expect(assistant?.role === 'assistant' && assistant.stopReason).toBe('error');
    expect(assistant?.role === 'assistant' && assistant.errorMessage).toContain('protocol bug');
  });

  it('违约 StreamFn(迭代中途 throw):fatal error + agent_end(error),start/end 同 id、已流出内容保留', async () => {
    const { Agent } = await import('../src/agent/index.js');
    // 手工构造违约流:start + 一段 text_delta 后迭代器 throw。
    // 真 ProviderEventStream 的迭代器永不 throw——这里模拟的是协议 bug 的最后防线。
    // start 的 partial 为空、delta 的 partial 已生长:断言防御路径复用的是最新快照。
    const startPartial: AssistantMessage = {
      role: 'assistant',
      id: 'rogue_a1',
      timestamp: 1,
      content: [],
      model: { provider: 'rogue', api: 'x', model: 'y' },
      stopReason: 'stop',
      usage: { input: 0, output: 0 },
    };
    const grownPartial: AssistantMessage = {
      ...startPartial,
      content: [{ type: 'text', text: 'partial tex' }],
    };
    const rogueStream = {
      async *[Symbol.asyncIterator](): AsyncGenerator<ProviderEvent, undefined> {
        yield { type: 'start', partial: startPartial };
        yield { type: 'text_delta', contentIndex: 0, delta: 'partial tex', partial: grownPartial };
        throw new Error('mid-stream explosion');
      },
      result: () => Promise.resolve(grownPartial),   // 不会走到:迭代已 throw
    };
    const streamFn = () => rogueStream as unknown as ProviderEventStream;
    const agent = new Agent({
      model: { ref: { provider: 'rogue', api: 'x', model: 'y' } },
      runtimeTurnProvider: makeRuntimeTurnProvider(streamFn),
    });
    const events: AgentEvent[] = [];
    agent.subscribe((e) => {
      events.push(e);
    });
    await agent.prompt('go');

    const fatal = events.find((e) => e.type === 'error');
    expect(fatal?.type === 'error' && fatal.fatal).toBe(true);
    expect(fatal?.type === 'error' && fatal.message).toContain('mid-stream explosion');
    const end = events.find((e) => e.type === 'agent_end');
    expect(end?.type === 'agent_end' && end.reason).toBe('error');
    // error assistant 入转录:复用已宣布的消息 id,已流出的 partial 内容保留
    const assistant = agent.transcript.find((m) => m.role === 'assistant');
    expect(assistant?.role === 'assistant' && assistant.stopReason).toBe('error');
    expect(assistant?.id).toBe('rogue_a1');
    expect(assistant?.content[0]?.type === 'text' && assistant.content[0].text).toBe('partial tex');
    // start/end 同 id(不得为收尾另造一条新 assistant)
    const starts = events.filter(
      (e): e is Extract<AgentEvent, { type: 'message_start' }> =>
        e.type === 'message_start' && e.message.role === 'assistant',
    );
    const msgEnds = events.filter(
      (e): e is Extract<AgentEvent, { type: 'message_end' }> =>
        e.type === 'message_end' && e.message.role === 'assistant',
    );
    expect(starts).toHaveLength(1);
    expect(msgEnds).toHaveLength(1);
    expect(starts[0]?.message.id).toBe('rogue_a1');
    expect(msgEnds[0]?.message.id).toBe('rogue_a1');
  });

  it('违约 StreamFn(result() reject):防御路径收尾,已流出内容保留', async () => {
    const { Agent } = await import('../src/agent/index.js');
    const partial: AssistantMessage = {
      role: 'assistant',
      id: 'rogue_a2',
      timestamp: 1,
      content: [{ type: 'text', text: 'all streamed' }],
      model: { provider: 'rogue', api: 'x', model: 'y' },
      stopReason: 'stop',
      usage: { input: 0, output: 0 },
    };
    // 事件流合法走完(start → delta → done),但 result() reject——违约点在迭代之后
    const rogueStream = {
      async *[Symbol.asyncIterator](): AsyncGenerator<ProviderEvent, undefined> {
        yield { type: 'start', partial };
        yield { type: 'text_delta', contentIndex: 0, delta: 'all streamed', partial };
        yield { type: 'done', message: partial };
        return undefined;
      },
      result: () => Promise.reject(new Error('result exploded')),
    };
    const streamFn = () => rogueStream as unknown as ProviderEventStream;
    const agent = new Agent({
      model: { ref: { provider: 'rogue', api: 'x', model: 'y' } },
      runtimeTurnProvider: makeRuntimeTurnProvider(streamFn),
    });
    const events: AgentEvent[] = [];
    agent.subscribe((e) => {
      events.push(e);
    });
    await agent.prompt('go');

    const fatal = events.find((e) => e.type === 'error');
    expect(fatal?.type === 'error' && fatal.fatal).toBe(true);
    expect(fatal?.type === 'error' && fatal.message).toContain('result exploded');
    const end = events.find((e) => e.type === 'agent_end');
    expect(end?.type === 'agent_end' && end.reason).toBe('error');
    const assistant = agent.transcript.find((m) => m.role === 'assistant');
    expect(assistant?.role === 'assistant' && assistant.stopReason).toBe('error');
    expect(assistant?.id).toBe('rogue_a2');
    expect(assistant?.content[0]?.type === 'text' && assistant.content[0].text).toBe('all streamed');
  });

  it('listener throw:不影响 loop,后续 listener 仍收到事件', async () => {
    const h = makeHarness({ turns: [{ events: [{ kind: 'text', text: 'ok' }] }] });
    const seen: string[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.agent.subscribe(() => {
      throw new Error('bad listener');
    });
    h.agent.subscribe((e) => {
      seen.push(e.type);
    });
    await h.agent.prompt('go');
    errSpy.mockRestore();

    expect(seen).toContain('agent_end');
    const end = h.events.find((e) => e.type === 'agent_end');
    expect(end?.type === 'agent_end' && end.reason).toBe('completed');
  });
});
