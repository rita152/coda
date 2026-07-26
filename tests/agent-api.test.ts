// M3 Agent API 与框架横切行为测试(L4):状态机、waitForIdle、钩子、截断 post-hook。
// 规格出处 docs/05-agent-loop.md §1/§4/§7、docs/07-tools.md §1.6。

import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PendingMessageQueue, runLoop } from '../src/agent/index.js';
import type { LoopConfig } from '../src/agent/index.js';
import { hasResidue } from '../src/agent/agent.js';
import type { AgentEvent, AgentMessage, ToolResultMessage } from '../src/protocol/index.js';
import { createFauxStreamFn, createGate } from '../src/providers/faux/index.js';
import { FileTracker } from '../src/shared/index.js';
import type { ToolDefinition } from '../src/tools/types.js';
import { makeHarness, makeTool, TEST_MODEL, textOutput } from './helpers/agent-harness.js';
import { renderToolSchemas } from '../src/agent/index.js';

describe('Agent API 与状态机(docs/05 §1)', () => {
  it('运行中调 prompt() throw;steer/followUp 随时入队不 throw', async () => {
    const gate = createGate();
    const h = makeHarness({
      turns: [{ events: [{ kind: 'gate', gate }, { kind: 'text', text: 'ok' }] }],
    });
    // idle 时 steer/followUp 不 throw
    h.agent.steer('early steer');
    h.agent.followUp('early follow-up');
    h.agent.clearQueues();

    const run = h.agent.prompt('go');
    expect(h.agent.state).toBe('running');
    expect(() => h.agent.prompt('again')).toThrow(/use steer\(\) or followUp\(\)/);
    h.agent.steer('mid-run steer');       // 不 throw
    h.agent.followUp('mid-run follow-up');
    h.agent.clearQueues();                 // 本用例只测 API 合法性,清空免得注入改变剧本
    gate.open();
    await run;
    expect(h.agent.state).toBe('idle');
  });

  it('空转录 continue() throw Nothing to continue', () => {
    const h = makeHarness({ turns: [] });
    expect(() => h.agent.continue()).toThrow('Nothing to continue');
  });

  it('waitForIdle:慢 async listener 处理完 agent_end 后才 resolve', async () => {
    const h = makeHarness({ turns: [{ events: [{ kind: 'text', text: 'ok' }] }] });
    let settled = false;
    h.agent.subscribe(async (e) => {
      if (e.type === 'agent_end') {
        await new Promise((r) => setTimeout(r, 20));   // 宽松时序用例:验证 waitForIdle 等 listener settle
        settled = true;
      }
    });
    await h.agent.prompt('go');
    await h.agent.waitForIdle();
    expect(settled).toBe(true);
  });

  it('beforeToolCall block → isError 回喂任务继续;afterToolCall 可整体改写结果', async () => {
    const alpha = makeTool('alpha', async () => textOutput('raw'));
    const h = makeHarness(
      {
        turns: [
          {
            events: [
              { kind: 'tool_call', name: 'alpha', args: { value: 'blockme' }, id: 'call_1' },
              { kind: 'tool_call', name: 'alpha', args: { value: 'pass' }, id: 'call_2' },
            ],
          },
          { events: [{ kind: 'text', text: 'done' }] },
        ],
      },
      {
        tools: [alpha],
        beforeToolCall: async (call) =>
          (call.arguments as { value?: string }).value === 'blockme'
            ? { block: true, reason: 'User denied permission: not allowed.' }
            : {},
        afterToolCall: async (_call, result) => ({
          ...result,
          content: result.isError ? result.content : [{ type: 'text', text: 'rewritten' }],
        }),
      },
    );
    await h.agent.prompt('go');

    const results = h.events
      .filter((e): e is Extract<AgentEvent, { type: 'message_end' }> => e.type === 'message_end')
      .map((e) => e.message)
      .filter((m): m is ToolResultMessage => m.role === 'tool_result');
    expect(results).toHaveLength(2);
    expect(results[0]?.isError).toBe(true);
    expect(results[0]?.content[0]?.type === 'text' && results[0].content[0].text).toContain('denied');
    expect(results[1]?.isError).toBe(false);
    expect(results[1]?.content[0]?.type === 'text' && results[1].content[0].text).toBe('rewritten');
    expect(h.streamFn.calls).toHaveLength(2);   // 任务继续
  });

  it('systemPrompt 组装:promptSnippet 拼进 Tool usage notes,tools schema 出站', async () => {
    const withSnippet = makeTool('alpha', async () => textOutput('a'));
    (withSnippet as { promptSnippet?: string }).promptSnippet = 'Always alpha before beta.';
    const h = makeHarness(
      { turns: [{ events: [{ kind: 'text', text: 'ok' }] }] },
      { tools: [withSnippet], systemPrompt: 'BASE PROMPT' },
    );
    await h.agent.prompt('go');

    const ctx = h.streamFn.calls[0]?.context;
    expect(ctx?.systemPrompt).toContain('BASE PROMPT');
    expect(ctx?.systemPrompt).toContain('# Tool usage notes');
    expect(ctx?.systemPrompt).toContain('Always alpha before beta.');
    expect(ctx?.tools?.map((t) => t.name)).toEqual(['alpha']);
    expect(ctx?.tools?.[0]?.parameters).toMatchObject({ type: 'object' });
  });
});

/** 跑通「单 turn 工具批 → 框架截断 post-hook」的最小 runLoop 场景,返回全部 tool_result。 */
async function runTruncationScenario(
  tools: ToolDefinition[],
  toolCalls: { name: string; id: string }[],
  spillDir: string,
): Promise<ToolResultMessage[]> {
  const streamFn = createFauxStreamFn({
    turns: [
      { events: toolCalls.map((c) => ({ kind: 'tool_call' as const, name: c.name, args: {}, id: c.id })) },
      { events: [{ kind: 'text', text: 'ok' }] },
    ],
  });
  const cfg: LoopConfig = {
    streamFn,
    model: TEST_MODEL,
    tools,
    toolSchemas: renderToolSchemas(tools),
    systemPrompt: 'test',
    cwd: process.cwd(),
    fileTracker: new FileTracker(),
    spillDir,
    steeringMode: () => 'one-at-a-time',
    followUpMode: () => 'one-at-a-time',
  };
  const events: AgentEvent[] = [];
  const transcript: AgentMessage[] = [];
  await runLoop(
    cfg,
    transcript,
    { steering: new PendingMessageQueue('steering'), followUp: new PendingMessageQueue('follow_up') },
    new AbortController().signal,
    async (e) => {
      events.push(e);
    },
    {
      initialPending: [
        { role: 'user', id: 'u1', timestamp: 1, content: [{ type: 'text', text: 'go' }], source: 'prompt' },
      ],
      skipInitialPoll: true,
    },
  );
  return events
    .filter((e): e is Extract<AgentEvent, { type: 'message_end' }> => e.type === 'message_end')
    .map((e) => e.message)
    .filter((m): m is ToolResultMessage => m.role === 'tool_result');
}

describe('框架级截断 post-hook(docs/07 §1.6)', () => {
  it('工具输出超 2000 行:截断 + 落盘 + 尾部续读提示;自带 truncated 标记则跳过', async () => {
    const spillDir = mkdtempSync(path.join(tmpdir(), 'coda-spill-'));
    const bigText = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join('\n');

    const big = makeTool('big', async () => textOutput(bigText));
    const selfTruncated = makeTool('self', async () => ({
      content: [{ type: 'text' as const, text: bigText }],
      details: { truncated: true },
    }));

    const results = await runTruncationScenario(
      [big, selfTruncated],
      [
        { name: 'big', id: 'call_big' },
        { name: 'self', id: 'call_self' },
      ],
      spillDir,
    );

    const bigResult = results.find((r) => r.toolCallId === 'call_big');
    const bigTextOut = bigResult?.content[0]?.type === 'text' ? bigResult.content[0].text : '';
    expect(bigTextOut).toContain('[Output truncated: showing first 2000 of 3000 lines.');
    expect(bigTextOut).toContain('Full output saved to: ');
    const savedPath = /Full output saved to: (.+)$/m.exec(bigTextOut)?.[1];
    expect(savedPath !== undefined && existsSync(savedPath)).toBe(true);
    expect(readFileSync(savedPath as string, 'utf8')).toBe(bigText);   // 落盘内容全量

    // 自带 truncated 标记:框架不做二次截断
    const selfResult = results.find((r) => r.toolCallId === 'call_self');
    const selfTextOut = selfResult?.content[0]?.type === 'text' ? selfResult.content[0].text : '';
    expect(selfTextOut).toBe(bigText);

    rmSync(spillDir, { recursive: true, force: true });
  });

  it('工具输出 <2000 行但 >48KB:字节维度截断生效(保留 ≤48KB)+ 落盘全量', async () => {
    const spillDir = mkdtempSync(path.join(tmpdir(), 'coda-spill-'));
    // 100 行 × 1KB(1023 字符 + '\n'):行数远低于 2000 上限,总量 100KB 超 48KB 字节上限
    const wideText = Array.from({ length: 100 }, () => 'x'.repeat(1023)).join('\n');
    const wide = makeTool('wide', async () => textOutput(wideText));

    const results = await runTruncationScenario([wide], [{ name: 'wide', id: 'call_wide' }], spillDir);
    const result = results.find((r) => r.toolCallId === 'call_wide');
    const text = result?.content[0]?.type === 'text' ? result.content[0].text : '';

    const noteIndex = text.indexOf('\n[Output truncated: showing first ');
    expect(noteIndex).toBeGreaterThan(-1);          // 删掉字节维度则 100 行不触发截断,此处即红
    // 保留区(截断注之前)字节数 ≤ 48KB,且确有丢弃
    expect(Buffer.byteLength(text.slice(0, noteIndex), 'utf8')).toBeLessThanOrEqual(48 * 1024);
    const kept = /showing first (\d+) of 100 lines\./.exec(text);
    expect(kept).not.toBeNull();
    expect(Number(kept?.[1])).toBeGreaterThan(0);
    expect(Number(kept?.[1])).toBeLessThan(100);
    // 落盘全量 + 续读提示
    const savedPath = /Full output saved to: (.+)$/m.exec(text)?.[1];
    expect(savedPath !== undefined && existsSync(savedPath)).toBe(true);
    expect(readFileSync(savedPath as string, 'utf8')).toBe(wideText);

    rmSync(spillDir, { recursive: true, force: true });
  });
});

describe('continue() 三路启动(docs/05 §1.2)', () => {
  it('idle 时 followUp() 后 continue():agent_start reason follow_up,出站含 source:follow_up 消息', async () => {
    const h = makeHarness({ turns: [{ events: [{ kind: 'text', text: 'answered' }] }] });
    h.agent.followUp('please also do this');
    await h.agent.continue();

    const start = h.events.find((e) => e.type === 'agent_start');
    expect(start?.type === 'agent_start' && start.reason).toBe('follow_up');
    expect(h.streamFn.calls).toHaveLength(1);
    const msgs = h.streamFn.calls[0]?.context.messages ?? [];
    const fu = msgs.find((m) => m.role === 'user' && m.source === 'follow_up');
    expect(fu).toBeDefined();
    expect(fu?.role === 'user' && fu.content[0]?.type === 'text' && fu.content[0].text).toBe(
      'please also do this',
    );
  });

  it('残局重采样:terminate 收尾(末条 tool_result)后 continue():reason continue', async () => {
    const done = makeTool('done', async () => ({
      content: [{ type: 'text' as const, text: 'fin' }],
      terminate: true,
    }));
    const h = makeHarness(
      {
        turns: [
          { events: [{ kind: 'tool_call', name: 'done', args: {}, id: 'call_t' }] },
          { events: [{ kind: 'text', text: 'resumed' }] },
        ],
      },
      { tools: [done] },
    );
    await h.agent.prompt('go');
    // terminate 提前收尾:转录以 tool_result 结尾——正是 continue() 第 3 路的残局形态
    expect(h.agent.transcript[h.agent.transcript.length - 1]?.role).toBe('tool_result');

    await h.agent.continue();
    expect(h.streamFn.calls).toHaveLength(2);
    const start2 = h.events.filter((e) => e.type === 'agent_start')[1];
    expect(start2?.type === 'agent_start' && start2.reason).toBe('continue');
  });

  it('完整完结转录:continue() throw Nothing to continue', async () => {
    const h = makeHarness({ turns: [{ events: [{ kind: 'text', text: 'done' }] }] });
    await h.agent.prompt('hi');
    expect(() => h.agent.continue()).toThrow('Nothing to continue');
  });

  it('hasResidue 残局判定:tool_result 收尾 / 未配对 toolCall / aborted 收尾 / 完结转录', () => {
    const model = { provider: 'p', api: 'x', model: 'm' };
    const user: AgentMessage = {
      role: 'user', id: 'u1', timestamp: 1, content: [{ type: 'text', text: 'hi' }], source: 'prompt',
    };
    const asstToolCall: AgentMessage = {
      role: 'assistant', id: 'a1', timestamp: 2,
      content: [{ type: 'tool_call', id: 'c1', name: 't', arguments: {} }],
      model, stopReason: 'tool_calls', usage: { input: 0, output: 0 },
    };
    const toolResult: AgentMessage = {
      role: 'tool_result', id: 'tr1', timestamp: 3, toolCallId: 'c1', toolName: 't',
      content: [{ type: 'text', text: 'ok' }], isError: false,
    };
    const asstStop: AgentMessage = {
      role: 'assistant', id: 'a2', timestamp: 4, content: [{ type: 'text', text: 'done' }],
      model, stopReason: 'stop', usage: { input: 0, output: 0 },
    };
    const asstAborted: AgentMessage = { ...asstStop, id: 'a3', content: [], stopReason: 'aborted' };

    expect(hasResidue([user, asstToolCall, toolResult])).toBe(true);            // 末条 tool_result
    expect(hasResidue([user, asstToolCall])).toBe(true);                        // 末条 assistant 自己的 toolCall 未配对(崩溃形态)
    expect(hasResidue([user, asstToolCall, toolResult, asstAborted])).toBe(true); // 末条 aborted assistant
    expect(hasResidue([user, asstToolCall, toolResult, asstStop])).toBe(false); // 完整完结
    // 判据限定尾部:历史中段的孤儿(abort 既成事实,transform 出站已修复)不算残局——
    // 否则之后每次 continue() 都被误判为「有残局」而重采样(M4 核查发现)
    expect(hasResidue([user, asstToolCall, asstStop])).toBe(false);
    expect(hasResidue([])).toBe(false);                                         // 空转录
  });
});
