// M6 验收 3(docs/11-roadmap.md)+ docs/07-tools.md §2.8:plan 工具整表替换语义、
// plan_update 旁路事件(loop 在 finalize 识别 details 后发出)、多 in_progress 提醒、
// 回显编号列表、promptSnippet 拼装(docs/07 §1.5)。
// 附:截断落盘统一验收(docs/11 M6「截断落盘完善」)——Session 路径 spillDir 含 sessionId
// (~/.coda/truncated/<sessionId>/,docs/07 §1.6;框架 post-hook 本体已在 tests/agent-api.test.ts 覆盖)。

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent, PlanStep, ToolResultMessage } from '../src/protocol/index.js';
import { createFauxStreamFn } from '../src/providers/faux/index.js';
import { Session } from '../src/session/index.js';
import { FileTracker } from '../src/shared/index.js';
import { planTool } from '../src/tools/plan.js';
import type { ToolContext } from '../src/tools/types.js';
import { makeHarness, makeTool, TEST_MODEL, textOutput } from './helpers/agent-harness.js';

// ---------- 仪器 ----------

/** 直接单测 execute 用的最小 ToolContext(plan 不触碰 ctx,仅满足类型)。 */
function toolCtx(): ToolContext {
  return { cwd: process.cwd(), signal: new AbortController().signal, fileTracker: new FileTracker() };
}

function planUpdates(events: AgentEvent[]): PlanStep[][] {
  return events
    .filter((e): e is Extract<AgentEvent, { type: 'plan_update' }> => e.type === 'plan_update')
    .map((e) => e.steps);
}

function resultText(r: ToolResultMessage | undefined): string {
  const part = r?.content[0];
  return part?.type === 'text' ? part.text : '';
}

// ---------- plan 工具与 plan_update(M6 验收 3) ----------

describe('整表替换语义(docs/07 §2.8)', () => {
  it('两个 turn 各调 plan(不同全表):两次 plan_update 快照均为完整新表,非增量', async () => {
    const table1: PlanStep[] = [
      { step: '定位配置加载代码', status: 'in_progress' },
      { step: '实现新格式解析', status: 'pending' },
    ];
    // 第二次全量重申:首步翻 completed、次步翻 in_progress、追加新步——快照必须含全部 3 步
    const table2: PlanStep[] = [
      { step: '定位配置加载代码', status: 'completed' },
      { step: '实现新格式解析', status: 'in_progress' },
      { step: '补回归测试', status: 'pending' },
    ];
    const h = makeHarness(
      {
        turns: [
          { events: [{ kind: 'tool_call', name: 'plan', args: { steps: table1 }, id: 'p1' }] },
          { events: [{ kind: 'tool_call', name: 'plan', args: { steps: table2 }, id: 'p2' }] },
          { events: [{ kind: 'text', text: 'done' }] },
        ],
      },
      { tools: [planTool] },
    );
    await h.agent.prompt('go');

    expect(planUpdates(h.events)).toEqual([table1, table2]);
    // 工具结果本体两条均非 isError(整表替换不是错误路径)
    const results = h.agent.transcript.filter((m): m is ToolResultMessage => m.role === 'tool_result');
    expect(results.map((r) => r.isError)).toEqual([false, false]);
  });

  it('空 steps 整表替换:仍发一次 plan_update 且快照为空数组;结果输出 (empty plan)', async () => {
    // 清空计划是合法的整表替换:loop 的鸭子识别(Array.isArray([]) 为真、every 空数组为真)
    // 照发 plan_update,快照即空数组——不得因「空」而吞掉旁路事件(否则 UI 无法反映计划被清空)。
    const h = makeHarness(
      {
        turns: [
          { events: [{ kind: 'tool_call', name: 'plan', args: { steps: [] }, id: 'p1' }] },
          { events: [{ kind: 'text', text: 'cleared' }] },
        ],
      },
      { tools: [planTool] },
    );
    await h.agent.prompt('go');

    expect(planUpdates(h.events)).toEqual([[]]); // 恰一次 plan_update,steps 为空
    const result = h.agent.transcript.find((m): m is ToolResultMessage => m.role === 'tool_result');
    expect(result?.isError).toBe(false);
    expect(resultText(result)).toBe('(empty plan)');
  });
});

describe('多 in_progress:提醒而非拒绝(docs/07 §2.8)', () => {
  it("两个 in_progress:结果 isError:false,输出含 'Reminder' 提醒文案;plan_update 照发", async () => {
    const steps: PlanStep[] = [
      { step: 'refactor renderer', status: 'in_progress' },
      { step: 'update tests', status: 'in_progress' },
    ];
    const h = makeHarness(
      {
        turns: [
          { events: [{ kind: 'tool_call', name: 'plan', args: { steps }, id: 'p1' }] },
          { events: [{ kind: 'text', text: 'noted' }] },
        ],
      },
      { tools: [planTool] },
    );
    await h.agent.prompt('go');

    const result = h.agent.transcript.find((m): m is ToolResultMessage => m.role === 'tool_result');
    expect(result?.isError).toBe(false); // 不拒绝
    expect(resultText(result)).toContain('Reminder');
    expect(resultText(result)).toContain('2 steps are in_progress');
    expect(planUpdates(h.events)).toEqual([steps]); // 违规提醒不影响快照发射
  });
});

describe('输出回显与 details(docs/07 §2.8)', () => {
  it("回显编号列表('1. [completed] …');details.steps 与参数逐字等", async () => {
    const steps: PlanStep[] = [
      { step: '定位配置加载代码', status: 'completed' },
      { step: '实现新格式解析', status: 'in_progress' },
      { step: '补回归测试', status: 'pending' },
    ];
    const out = await planTool.execute({ id: 'p1', args: { steps } }, toolCtx());

    expect(out.content).toEqual([
      {
        type: 'text',
        text: '1. [completed] 定位配置加载代码\n2. [in_progress] 实现新格式解析\n3. [pending] 补回归测试',
      },
    ]);
    expect(out.details).toEqual({ steps }); // 逐字等:UI/plan_update 用的就是这份快照
  });

  it("空 steps 数组 → '(empty plan)'", async () => {
    const out = await planTool.execute({ id: 'p1', args: { steps: [] } }, toolCtx());
    expect(out.content).toEqual([{ type: 'text', text: '(empty plan)' }]);
    expect(out.details).toEqual({ steps: [] });
  });
});

describe('注册形态(docs/07 §2.8/§1.5)', () => {
  it("kind='plan';promptSnippet 拼进 system prompt 的 # Tool usage notes 小节", async () => {
    expect(planTool.kind).toBe('plan'); // 权限分级:plan 默认直通不产生 approval(docs/07 §3.1)
    expect(planTool.executionMode).toBeUndefined(); // 不声明 sequential,不拖累批调度

    const h = makeHarness(
      { turns: [{ events: [{ kind: 'text', text: 'hi' }] }] },
      { tools: [planTool] },
    );
    await h.agent.prompt('go');
    const systemPrompt = h.streamFn.calls[0]?.context.systemPrompt ?? '';
    expect(systemPrompt).toContain('# Tool usage notes');
    expect(systemPrompt).toContain('Plan tool usage');
  });
});

// ---------- 截断落盘统一验收(docs/11 M6「截断落盘完善」) ----------

describe('截断落盘:Session 路径 spillDir 含 sessionId(docs/07 §1.6)', () => {
  it('超限工具输出全文落盘到 ~/.coda/truncated/<sessionId>/;结果尾部续读提示含该路径', async () => {
    // HOME 重定向到临时目录:truncationDir 基于 os.homedir()(POSIX 读 $HOME),
    // 测试不污染真实 ~/.coda;finally 恢复并整树清理。
    const prevHome = process.env['HOME'];
    const fakeHome = mkdtempSync(path.join(os.tmpdir(), 'coda-home-'));
    process.env['HOME'] = fakeHome;
    try {
      const fullText = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join('\n');
      const big = makeTool('big', async () => textOutput(fullText));
      const streamFn = createFauxStreamFn({
        turns: [
          { events: [{ kind: 'tool_call', name: 'big', args: {}, id: 'call_big' }] },
          { events: [{ kind: 'text', text: 'done' }] },
        ],
      });
      const session = await Session.create({
        dir: path.join(fakeHome, 'sessions'), // 会话存储与截断落盘分属两处,互不混淆
        agentConfig: { streamFn, model: TEST_MODEL, tools: [big], systemPrompt: 'test' },
      });
      await session.prompt('go');
      await session.close();

      // 落盘目录以 sessionId 为 scope(Session.create 注入 truncationScope = id)
      const spillRoot = path.join(fakeHome, '.coda', 'truncated', session.id);
      const files = readdirSync(spillRoot);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/-call_big\.txt$/);
      // 落盘为全文(3000 行),不是截断后的 2000 行
      expect(readFileSync(path.join(spillRoot, files[0] as string), 'utf8')).toBe(fullText);

      // 转录内是截断视图 + 可执行续读提示,提示中的落盘路径含 sessionId
      const result = session.messages.find((m): m is ToolResultMessage => m.role === 'tool_result');
      const text = resultText(result);
      expect(text).toContain('[Output truncated: showing first 2000 of 3000 lines.');
      expect(text).toContain(path.join('.coda', 'truncated', session.id));
    } finally {
      if (prevHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = prevHome;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
