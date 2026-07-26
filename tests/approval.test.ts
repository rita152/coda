// M6 验收 1(docs/11-roadmap.md)+ docs/07-tools.md §3/§4:ApprovalBroker 单元与
// beforeToolCall 挂载的 loop 集成矩阵(faux + makeHarness,全离线)。
// R7 时序纪律(codex 教训,docs/05 §6 末段):abort 时先 agent.abort()(任务观察到
// cancellation)再 broker.abortAll()(pending 以 'abort' 决议);审批被 abort 决议的
// 工具结果文案必须是中断形态('[Tool execution was interrupted]'),绝不以「拒绝」
// 形态漏给模型——deny 与 abort 是两种类型(docs/07 §3.2)。
// 纪律(docs/10 §5/§8):时序只用事件等待,禁计时器;出站断言一律用 faux 的 calls。

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type {
  AgentEvent,
  AssistantMessage,
  ToolCallPart,
  ToolResultMessage,
} from '../src/protocol/index.js';
import { ApprovalBroker, INTERRUPTED_RESULT_TEXT } from '../src/agent/index.js';
import type { ApprovalDecision } from '../src/agent/index.js';
import { createApprovalPolicy, DOOM_LOOP_NOTE } from '../src/cli/approval-policy.js';
import type { ToolDefinition } from '../src/tools/types.js';
import { makeHarness, makeTool, textOutput } from './helpers/agent-harness.js';

type ApprovalRequestEvent = Extract<AgentEvent, { type: 'approval_request' }>;

// ---------- 测试仪器 ----------

/** broker 事件面仪器:approval_request 收集 + 可等待(事件先到或 waiter 先到皆可)。 */
function instrumentBroker(initialRules: Iterable<string> = []): {
  broker: ApprovalBroker;
  seen: ApprovalRequestEvent[];
  nextRequest: () => Promise<ApprovalRequestEvent>;
} {
  const seen: ApprovalRequestEvent[] = [];
  const buffered: ApprovalRequestEvent[] = [];
  const waiters: ((e: ApprovalRequestEvent) => void)[] = [];
  const broker = new ApprovalBroker((e) => {
    if (e.type !== 'approval_request') return;
    seen.push(e);
    const w = waiters.shift();
    if (w !== undefined) w(e);
    else buffered.push(e);
  }, initialRules);
  return {
    broker,
    seen,
    nextRequest: () => {
      const b = buffered.shift();
      if (b !== undefined) return Promise.resolve(b);
      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },
  };
}

/**
 * 按 docs/07 §3.2 决策语义构造的最小 beforeToolCall 钩子(policy 层的测试等价物):
 * deny → block + 'User denied permission…' 回喂文案(任务继续);
 * abort → requestAbort()(任务观察到 cancellation)+ block 中断形态文案(R7:
 * 绝不以拒绝形态漏给模型);allow_* → 放行。observed 留档钩子看到的决议。
 */
function approvalHook(
  broker: ApprovalBroker,
  requestAbort: () => void,
  observed?: ApprovalDecision[],
): (call: ToolCallPart) => Promise<{ block: true; reason: string } | { block?: false }> {
  return async (call) => {
    const outcome = await broker.request({
      toolCallId: call.id,
      description: `${call.name} ${JSON.stringify(call.arguments)}`,
      patterns: [`${call.name}:*`],
    });
    observed?.push(outcome.decision);
    if (outcome.decision === 'deny') {
      return {
        block: true,
        reason:
          'User denied permission: rejected by user. ' +
          'Do not retry the same call; ask the user or take a different approach.',
      };
    }
    if (outcome.decision === 'abort') {
      requestAbort();
      return { block: true, reason: INTERRUPTED_RESULT_TEXT };
    }
    return {};
  };
}

function resultText(r: ToolResultMessage | undefined): string {
  const part = r?.content[0];
  return part?.type === 'text' ? part.text : '';
}

// ---------- broker 与 loop 集成矩阵 ----------

describe('deny:回喂而非终止(M6 验收 1 前半)', () => {
  it('deny → isError 结果含 User denied 文案回喂模型;任务继续产出替代方案 turn', async () => {
    const { broker, nextRequest } = instrumentBroker();
    let executed = false;
    const danger = makeTool('danger', async () => {
      executed = true;
      return textOutput('ran');
    });
    let abortRef: () => void = () => {};
    const h = makeHarness(
      {
        turns: [
          { events: [{ kind: 'tool_call', name: 'danger', args: { value: 'x' }, id: 'c1' }] },
          { events: [{ kind: 'text', text: 'understood — taking an alternative approach instead' }] },
        ],
      },
      { tools: [danger], beforeToolCall: approvalHook(broker, () => abortRef()) },
    );
    abortRef = () => h.agent.abort();

    const run = h.agent.prompt('go');
    const req = await nextRequest();
    expect(req.toolCallId).toBe('c1');
    expect(req.description).toContain('danger');
    broker.resolve(req.approvalId, 'deny');
    await run;

    // 拦截生效:工具本体未执行;结果是 isError 的拒绝文案(loop 由 reject 路径合成)
    expect(executed).toBe(false);
    const result = h.agent.transcript.find((m): m is ToolResultMessage => m.role === 'tool_result');
    expect(result?.isError).toBe(true);
    expect(resultText(result)).toContain('User denied');

    // 回喂:第二次出站的 messages 里模型真的看到该拒绝理由(docs/07 §3.2:deny 是引导不是终止)
    expect(h.streamFn.calls).toHaveLength(2);
    const fed = (h.streamFn.calls[1]?.context.messages ?? []).find(
      (m): m is ToolResultMessage => m.role === 'tool_result' && m.toolCallId === 'c1',
    );
    expect(fed?.isError).toBe(true);
    expect(resultText(fed)).toContain('User denied');

    // 任务继续:替代方案 turn 落转录,run 以 completed 收尾
    const final = h.agent.transcript[h.agent.transcript.length - 1] as AssistantMessage;
    expect(final.content.some((p) => p.type === 'text' && p.text.includes('alternative'))).toBe(true);
    const end = h.events.find((e) => e.type === 'agent_end');
    expect(end?.type === 'agent_end' && end.reason).toBe('completed');
  });
});

describe('abort 决议:任务停止(docs/07 §3.2)', () => {
  it('abort 决议 → 钩子内 requestAbort;agent_end(aborted),不再采样;结果为中断形态', async () => {
    const { broker, nextRequest } = instrumentBroker();
    let executed = false;
    const danger = makeTool('danger', async () => {
      executed = true;
      return textOutput('ran');
    });
    let abortRef: () => void = () => {};
    const h = makeHarness(
      {
        turns: [
          { events: [{ kind: 'tool_call', name: 'danger', args: {}, id: 'c1' }] },
          { events: [{ kind: 'text', text: 'never reached' }] },
        ],
      },
      { tools: [danger], beforeToolCall: approvalHook(broker, () => abortRef()) },
    );
    abortRef = () => h.agent.abort();

    const run = h.agent.prompt('go');
    const req = await nextRequest();
    broker.resolve(req.approvalId, 'abort');
    await run;

    expect(executed).toBe(false);
    // 结果文案是中断形态,不是拒绝形态
    const result = h.agent.transcript.find((m): m is ToolResultMessage => m.role === 'tool_result');
    expect(result?.isError).toBe(true);
    expect(resultText(result)).toBe(INTERRUPTED_RESULT_TEXT);
    // 任务停止:[G] 检查收尾,不发起第二次采样
    const end = h.events.find((e) => e.type === 'agent_end');
    expect(end?.type === 'agent_end' && end.reason).toBe('aborted');
    expect(h.streamFn.calls).toHaveLength(1);
    expect(h.agent.state).toBe('idle');
  });
});

describe('★ 审批等待中 abort()(M6 验收 1 后半,R7 时序)', () => {
  it("先 agent.abort() 再 broker.abortAll():决议 'abort' 非 'deny';结果中断形态;agent_end(aborted);无悬挂", async () => {
    const { broker, nextRequest } = instrumentBroker();
    let executed = false;
    const danger = makeTool('danger', async () => {
      executed = true;
      return textOutput('ran');
    });
    const observed: ApprovalDecision[] = [];
    let abortRef: () => void = () => {};
    const h = makeHarness(
      {
        turns: [
          { events: [{ kind: 'tool_call', name: 'danger', args: {}, id: 'c1' }] },
          { events: [{ kind: 'text', text: 'never reached' }] },
        ],
      },
      { tools: [danger], beforeToolCall: approvalHook(broker, () => abortRef(), observed) },
    );
    abortRef = () => h.agent.abort();

    const run = h.agent.prompt('go');
    // 工具 batch 的 beforeToolCall 已挂起在 broker.request(approval_request 已发、未决议)
    await nextRequest();
    expect(broker.pendingCount).toBe(1);

    // ★ R7 时序纪律:先让任务观察到 cancellation,再以 abort 决议清 pending
    h.agent.abort();
    broker.abortAll();
    await run;

    // (i) 决议是 'abort' 不是 'deny'
    expect(observed).toEqual(['abort']);
    // (ii) 该工具结果是中断形态,绝不以「拒绝」形态漏给模型
    expect(executed).toBe(false);
    const result = h.agent.transcript.find((m): m is ToolResultMessage => m.role === 'tool_result');
    expect(result?.isError).toBe(true);
    expect(resultText(result)).toBe(INTERRUPTED_RESULT_TEXT);
    expect(resultText(result)).not.toContain('User denied');
    // (iii) agent_end(aborted);模型没有任何机会看到拒绝形态(不再采样)
    const end = h.events.find((e) => e.type === 'agent_end');
    expect(end?.type === 'agent_end' && end.reason).toBe('aborted');
    expect(h.streamFn.calls).toHaveLength(1);
    // (iv) 无悬挂 Promise
    expect(broker.pendingCount).toBe(0);
  });

  it('★ 多 call 审批批次:第 1 个审批中 abort → 不对后续 call 发起新审批,不死锁(R7 preflight)', async () => {
    // 核查发现的 R7 死锁:preflight 循环串行 prepare,abort 后若不检查 signal 会对下一个 call
    // 再调 beforeToolCall→broker.request,而 abortAll 已清空 pending,新请求永不 resolve → 挂死。
    const { broker, nextRequest, seen } = instrumentBroker();
    let secondExecuted = false;
    const first = makeTool('first', async () => textOutput('ran-1'));
    const second = makeTool('second', async () => {
      secondExecuted = true;
      return textOutput('ran-2');
    });
    let abortRef: () => void = () => {};
    const h = makeHarness(
      {
        turns: [
          {
            events: [
              { kind: 'tool_call', name: 'first', args: {}, id: 'c1' },
              { kind: 'tool_call', name: 'second', args: {}, id: 'c2' },
            ],
          },
          { events: [{ kind: 'text', text: 'never reached' }] },
        ],
      },
      { tools: [first, second], beforeToolCall: approvalHook(broker, () => abortRef()) },
    );
    abortRef = () => h.agent.abort();

    const run = h.agent.prompt('go');
    await nextRequest();                 // c1 审批挂起(preflight 串行:c2 尚未 prepare)
    expect(broker.pendingCount).toBe(1);

    h.agent.abort();
    broker.abortAll();
    // 30ms 看门狗:preflight 未修则 run 永不 resolve,这里会超时(vitest 用例超时兜底)
    await run;                           // 不死锁——若挂起测试超时即回归

    // c2 没有被发起第二次审批(preflight 在 abort 后停止 prepare 剩余 call)
    expect(seen).toHaveLength(1);
    expect(seen[0]?.toolCallId).toBe('c1');
    expect(broker.pendingCount).toBe(0);
    expect(secondExecuted).toBe(false);
    const end = h.events.find((e) => e.type === 'agent_end');
    expect(end?.type === 'agent_end' && end.reason).toBe('aborted');

    // c2 成孤儿:下一次出站由 transform 补合成中断结果,配对合法
    await h.agent.continue();
    const outbound = h.streamFn.calls[1]?.context.messages ?? [];
    const results2 = outbound.filter((m): m is ToolResultMessage => m.role === 'tool_result');
    expect(results2.map((r) => r.toolCallId).sort()).toEqual(['c1', 'c2']);
  });
});

describe('allow_always:记忆与放行(docs/07 §3.2)', () => {
  it('首次弹审批;resolve(allow_always) 后同 patterns 第二次调用不发事件直接放行', async () => {
    const { broker, nextRequest, seen } = instrumentBroker();
    const executedIds: string[] = [];
    const danger = makeTool('danger', async (args) => {
      executedIds.push(args.value ?? '');
      return textOutput('ran');
    });
    let abortRef: () => void = () => {};
    const h = makeHarness(
      {
        turns: [
          { events: [{ kind: 'tool_call', name: 'danger', args: { value: 'first' }, id: 'c1' }] },
          { events: [{ kind: 'tool_call', name: 'danger', args: { value: 'second' }, id: 'c2' }] },
          { events: [{ kind: 'text', text: 'finished' }] },
        ],
      },
      { tools: [danger], beforeToolCall: approvalHook(broker, () => abortRef()) },
    );
    abortRef = () => h.agent.abort();

    const run = h.agent.prompt('go');
    const req = await nextRequest();
    expect(req.toolCallId).toBe('c1');
    broker.resolve(req.approvalId, 'allow_always');
    await run;

    // 第二次 request 未发事件(命中 alwaysRules 直接放行),两次工具都真实执行
    expect(seen).toHaveLength(1);
    expect(executedIds).toEqual(['first', 'second']);
    expect(broker.rules).toContain('danger:*');
    const results = h.agent.transcript.filter((m): m is ToolResultMessage => m.role === 'tool_result');
    expect(results.map((r) => [r.toolCallId, r.isError])).toEqual([
      ['c1', false],
      ['c2', false],
    ]);
    const end = h.events.find((e) => e.type === 'agent_end');
    expect(end?.type === 'agent_end' && end.reason).toBe('completed');
    expect(h.streamFn.calls).toHaveLength(3);
  });

  it('非 force 的 allow_always:outcome 带 learned,patterns 全部记入 rules', async () => {
    const { broker, nextRequest } = instrumentBroker();
    const p = broker.request({
      toolCallId: 'c1',
      description: 'edit two files',
      patterns: ['edit:/proj/**', 'write:/proj/**'],
    });
    const req = await nextRequest();
    broker.resolve(req.approvalId, 'allow_always');
    expect(await p).toEqual({ decision: 'allow_always', learned: ['edit:/proj/**', 'write:/proj/**'] });
    expect([...broker.rules].sort()).toEqual(['edit:/proj/**', 'write:/proj/**']);
  });

  it('forceConfirm:绕过 alwaysRules 仍弹审批;allow_always 降级 allow_once 不记忆(docs/07 §3.3)', async () => {
    // patterns 已全命中 alwaysRules——forceConfirm($()/doom-loop 升级)仍必须弹
    const { broker, nextRequest, seen } = instrumentBroker(['bash:npm *']);
    const p = broker.request(
      { toolCallId: 'c1', description: 'npm run $(evil)', patterns: ['bash:npm *'] },
      { forceConfirm: true },
    );
    const req = await nextRequest();
    broker.resolve(req.approvalId, 'allow_always');
    // 降级为 allow_once,无 learned,规则集未被污染
    expect(await p).toEqual({ decision: 'allow_once' });
    expect(broker.rules).toEqual(['bash:npm *']);

    // 再次 forceConfirm 同 patterns:记忆不生效,仍弹
    const p2 = broker.request(
      { toolCallId: 'c2', description: 'npm run $(evil)', patterns: ['bash:npm *'] },
      { forceConfirm: true },
    );
    const req2 = await nextRequest();
    broker.resolve(req2.approvalId, 'allow_once');
    expect((await p2).decision).toBe('allow_once');
    expect(seen).toHaveLength(2);
  });
});

describe('resolver 注册表边界(docs/07 §3.1/§4)', () => {
  it('resolve 未知 id 是 no-op;同 id 重复 resolve 第二次无效', async () => {
    const { broker, nextRequest } = instrumentBroker();
    broker.resolve('ap_nonexistent', 'deny'); // 不 throw、无副作用

    const p = broker.request({ toolCallId: 'c1', description: 'd', patterns: ['t:*'] });
    const req = await nextRequest();
    broker.resolve(req.approvalId, 'allow_once');
    broker.resolve(req.approvalId, 'deny'); // 已决议:no-op,不得改写首次决议
    expect((await p).decision).toBe('allow_once');
    expect(broker.pendingCount).toBe(0);
  });

  it('并发多个 pending 各自独立决议(乱序 resolve 不串线)', async () => {
    const { broker, nextRequest } = instrumentBroker();
    const pa = broker.request({ toolCallId: 'a', description: 'da', patterns: ['a:*'] });
    const pb = broker.request({ toolCallId: 'b', description: 'db', patterns: ['b:*'] });
    const ra = await nextRequest();
    const rb = await nextRequest();
    expect(ra.toolCallId).toBe('a');
    expect(rb.toolCallId).toBe('b');
    expect(ra.approvalId).not.toBe(rb.approvalId);
    expect(broker.pendingCount).toBe(2);

    broker.resolve(rb.approvalId, 'deny'); // 后发先决
    broker.resolve(ra.approvalId, 'allow_once');
    expect((await pa).decision).toBe('allow_once');
    expect((await pb).decision).toBe('deny');
    expect(broker.pendingCount).toBe(0);
  });

  it('abortAll:全部 pending 以 abort 决议,不留悬挂 Promise', async () => {
    const { broker, nextRequest } = instrumentBroker();
    const pa = broker.request({ toolCallId: 'a', description: 'da', patterns: ['a:*'] });
    const pb = broker.request({ toolCallId: 'b', description: 'db', patterns: ['b:*'] });
    await nextRequest();
    await nextRequest();
    broker.abortAll();
    expect((await pa).decision).toBe('abort');
    expect((await pb).decision).toBe('abort');
    expect(broker.pendingCount).toBe(0);
  });
});

// ---------- approval-policy 层(docs/07 §5 权限清单 + docs/11 M6 验收 2) ----------

/** 测试用 bash 形态工具(kind: 'execute',policy 按 call.name === 'bash' 走结构分析分支)。 */
function bashTool(onRun: (command: string) => void): ToolDefinition {
  return {
    name: 'bash',
    description: 'test bash tool',
    kind: 'execute',
    parameters: z.object({ command: z.string().describe('command to run') }),
    execute: async ({ args }) => {
      onRun((args as { command: string }).command);
      return textOutput('ok');
    },
  };
}

/** 测试用 edit 形态工具(kind: 'edit',policy 产出项目根泛化 pattern)。 */
function editTool(onRun: (p: string) => void): ToolDefinition {
  return {
    name: 'edit',
    description: 'test edit tool',
    kind: 'edit',
    parameters: z.object({ path: z.string().describe('file path') }),
    execute: async ({ args }) => {
      onRun((args as { path: string }).path);
      return textOutput('edited');
    },
  };
}

describe('approval-policy:kind 直通 / doom-loop / bash 升级 / 泛化(docs/07 §3/§5)', () => {
  let tmp: string;
  let rulesFile: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'coda-approval-'));
    rulesFile = path.join(tmp, 'approvals.json');
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  interface PolicyHarness {
    h: ReturnType<typeof makeHarness>;
    broker: ApprovalBroker;
    seen: ApprovalRequestEvent[];
    nextRequest: () => Promise<ApprovalRequestEvent>;
  }

  function makePolicyHarness(
    script: Parameters<typeof makeHarness>[0],
    tools: ToolDefinition[],
  ): PolicyHarness {
    const { broker, seen, nextRequest } = instrumentBroker();
    let abortRef: () => void = () => {};
    const policy = createApprovalPolicy({
      broker,
      projectRoot: tmp,
      tools,
      rulesFile,
      requestAbort: () => abortRef(),
    });
    const h = makeHarness(script, { tools, beforeToolCall: policy.beforeToolCall });
    abortRef = () => h.agent.abort();
    return { h, broker, seen, nextRequest };
  }

  it('read/search/plan kind 直通:不产生任何 approval_request(docs/07 §3.1/§5)', async () => {
    let runs = 0;
    const lookup: ToolDefinition = { ...makeTool('lookup', async () => {
      runs += 1;
      return textOutput('found');
    }), kind: 'read' };
    const { h, seen } = makePolicyHarness(
      {
        turns: [
          { events: [{ kind: 'tool_call', name: 'lookup', args: { value: 'a' }, id: 'c1' }] },
          { events: [{ kind: 'tool_call', name: 'lookup', args: { value: 'b' }, id: 'c2' }] },
          { events: [{ kind: 'text', text: 'done' }] },
        ],
      },
      [lookup],
    );
    await h.agent.prompt('go');

    expect(seen).toHaveLength(0); // 直通:零审批
    expect(runs).toBe(2);
    const end = h.events.find((e) => e.type === 'agent_end');
    expect(end?.type === 'agent_end' && end.reason).toBe('completed');
  });

  it('doom-loop(M6 验收 2):同工具同参数连发 3 次,第 3 次必弹审批(绕过 kind 直通),description 含提醒', async () => {
    let runs = 0;
    const lookup: ToolDefinition = { ...makeTool('lookup', async () => {
      runs += 1;
      return textOutput('found');
    }), kind: 'read' };
    const sameArgs = { value: 'same' };
    const { h, broker, seen, nextRequest } = makePolicyHarness(
      {
        turns: [
          { events: [{ kind: 'tool_call', name: 'lookup', args: sameArgs, id: 'c1' }] },
          { events: [{ kind: 'tool_call', name: 'lookup', args: sameArgs, id: 'c2' }] },
          { events: [{ kind: 'tool_call', name: 'lookup', args: sameArgs, id: 'c3' }] },
          { events: [{ kind: 'text', text: 'done' }] },
        ],
      },
      [lookup],
    );
    const run = h.agent.prompt('go');
    // 正向断言钉死阈值(off-by-one 立即失败,不依赖超时):阈值高方向下三连全直通、run 直接完成
    // 而从未弹审批 → race 命中 run 分支,expect 立即失败,而非 nextRequest 永久挂起等 vitest 超时。
    const raced = await Promise.race([
      nextRequest().then((req) => ({ kind: 'request' as const, req })),
      run.then(() => ({ kind: 'completed' as const })),
    ]);
    expect(raced.kind).toBe('request'); // run 先完成 = 从未弹审批(阈值回归)
    if (raced.kind !== 'request') return; // 类型收窄(上一行已使测试失败)
    const req = raced.req;
    // 恰第 3 次弹(前两次 kind 直通):此刻 seen 只 1 条;阈值低方向下 toolCallId≠c3 紧接失败
    expect(seen).toHaveLength(1);
    expect(req.toolCallId).toBe('c3');
    expect(req.description).toContain(DOOM_LOOP_NOTE);
    broker.resolve(req.approvalId, 'allow_once');
    await run;

    expect(seen).toHaveLength(1);
    expect(runs).toBe(3); // allow_once 放行第 3 次
  });

  it("bash 'echo $(rm -rf /)':升级为强制确认,allow_always 不泛化(第二次同命令仍弹)(docs/07 §3.3/§5)", async () => {
    const ran: string[] = [];
    const cmd = 'echo $(rm -rf /)';
    const { h, broker, seen, nextRequest } = makePolicyHarness(
      {
        turns: [
          { events: [{ kind: 'tool_call', name: 'bash', args: { command: cmd }, id: 'c1' }] },
          { events: [{ kind: 'tool_call', name: 'bash', args: { command: cmd }, id: 'c2' }] },
          { events: [{ kind: 'text', text: 'done' }] },
        ],
      },
      [bashTool((c) => ran.push(c))],
    );
    const run = h.agent.prompt('go');
    const req1 = await nextRequest();
    expect(req1.toolCallId).toBe('c1');
    broker.resolve(req1.approvalId, 'allow_always'); // forceConfirm 下降级 allow_once,不记忆
    const req2 = await nextRequest(); // ★ 同命令第二次仍弹:always 泛化被拒绝
    expect(req2.toolCallId).toBe('c2');
    broker.resolve(req2.approvalId, 'allow_once');
    await run;

    expect(seen).toHaveLength(2);
    expect(ran).toEqual([cmd, cmd]); // 两次均为放行后的真实执行
    expect(broker.rules).toEqual([]); // 未学到任何规则
    expect(existsSync(rulesFile)).toBe(false); // 也未持久化
  });

  it("bash denylist('rm -rf /'):直接 deny 不进 approval;任务继续(docs/07 §3.3)", async () => {
    const ran: string[] = [];
    const { h, seen } = makePolicyHarness(
      {
        turns: [
          { events: [{ kind: 'tool_call', name: 'bash', args: { command: 'rm -rf /' }, id: 'c1' }] },
          { events: [{ kind: 'text', text: 'that is destructive — suggesting a safer path' }] },
        ],
      },
      [bashTool((c) => ran.push(c))],
    );
    await h.agent.prompt('go');

    expect(seen).toHaveLength(0); // 不进 approval
    expect(ran).toEqual([]); // 未执行
    const result = h.agent.transcript.find((m): m is ToolResultMessage => m.role === 'tool_result');
    expect(result?.isError).toBe(true);
    expect(resultText(result)).toContain('User denied permission');
    const end = h.events.find((e) => e.type === 'agent_end');
    expect(end?.type === 'agent_end' && end.reason).toBe('completed'); // deny 是引导不是终止
  });

  it('allow_always 泛化按 kind 生效:edit 按项目根 pattern,批准一次后根内其他路径直通;规则持久化(docs/07 §3.2/§5)', async () => {
    const edited: string[] = [];
    const { h, broker, seen, nextRequest } = makePolicyHarness(
      {
        turns: [
          { events: [{ kind: 'tool_call', name: 'edit', args: { path: 'src/a.ts' }, id: 'c1' }] },
          { events: [{ kind: 'tool_call', name: 'edit', args: { path: 'src/b.ts' }, id: 'c2' }] },
          { events: [{ kind: 'text', text: 'done' }] },
        ],
      },
      [editTool((p) => edited.push(p))],
    );
    const run = h.agent.prompt('go');
    const req = await nextRequest();
    expect(req.toolCallId).toBe('c1');
    broker.resolve(req.approvalId, 'allow_always');
    await run;

    expect(seen).toHaveLength(1); // 第二个不同路径的 edit 命中泛化规则,直通
    expect(edited).toEqual(['src/a.ts', 'src/b.ts']);
    const pattern = `edit:${tmp}/**`;
    expect(broker.rules).toContain(pattern);
    // allow_always 持久化到 rulesFile(docs/11 M6 交付物:按 kind 泛化的规则记忆)
    const persisted: unknown = JSON.parse(readFileSync(rulesFile, 'utf8'));
    expect(persisted).toContain(pattern);
  });
});
