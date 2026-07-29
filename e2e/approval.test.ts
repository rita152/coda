// L5 e2e:审批流(docs/07-tools.md §3、docs/09-cli.md §6.5)。--approval-mode interactive
// 下经 headless approval 命令面驱动:deny 回喂后任务继续、allow_once 放行、allow_always
// 记忆、abort 决议的中断形态(时序纪律 R7:结果必须是 '[Tool execution was interrupted]',
// 绝不以「拒绝」形态漏给模型)、不带 flag 的默认 allow 回归。
// 一切等待都是事件驱动 + 看门狗,零裸计时器。

import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, expect, test } from 'bun:test';
import type { CodaProc } from './harness.js';
import {
  assertSubsequence,
  CASE_TIMEOUT_MS,
  msgRole,
  msgText,
  requireDist,
  resultText,
  startCoda,
  typeSeq,
} from './harness.js';

beforeAll(() => {
  requireDist();
});

const procs: CodaProc[] = [];
afterEach(() => {
  for (const p of procs.splice(0)) p.kill();
});
function track(p: CodaProc): CodaProc {
  procs.push(p);
  return p;
}

const T = { timeout: CASE_TIMEOUT_MS };
const INTERACTIVE = ['--approval-mode', 'interactive'];

/**
 * HOME 隔离:approval 策略把 allow_always 规则持久化到 $HOME/.coda/approvals.json
 * 并在启动时预加载——不隔离则测试间(以及与开发者真实配置间)互相污染,
 * 第二次运行 allow_* 用例会因规则已记忆而不再弹审批。
 */
function freshHome(): { HOME: string } {
  return { HOME: mkdtempSync(path.join(tmpdir(), 'coda-approval-home-')) };
}

test('deny — isError "User denied" 回喂,任务继续产出替代 turn(引导不是终止)', async () => {
  const proc = track(
    startCoda({
      extraArgs: INTERACTIVE,
      env: freshHome(),
      script: {
        turns: [
          { events: [{ kind: 'tool_call', name: 'bash', args: { command: 'touch denied-marker.txt' } }] },
          { events: [{ kind: 'text', text: 'took a different approach.' }] },
        ],
        onExhausted: 'emptyStop',
      },
    }),
  );
  proc.send({ type: 'prompt', text: 'run something' });

  const req = await proc.waitForEvent((e) => e.type === 'approval_request', 'approval_request');
  expect(typeof req['approvalId']).toBe('string');
  expect(typeof req['toolCallId']).toBe('string');
  expect(String(req['description'])).toContain('bash');
  expect(String(req['description'])).toContain('touch denied-marker.txt');

  // 畸形 approval 命令(缺 decision):non-fatal 容错,管道继续(docs/09 §6.3)
  proc.send({ type: 'approval', approvalId: req['approvalId'] });
  const bad = await proc.waitForEvent((e) => e.type === 'error', 'invalid approval command error');
  expect(bad['fatal']).toBe(false);
  expect(String(bad['message'])).toContain('invalid command');

  proc.send({ type: 'approval', approvalId: req['approvalId'], decision: 'deny' });

  const toolEnd = await proc.waitForEvent((e) => e.type === 'tool_execution_end', 'tool_execution_end');
  expect((toolEnd['result'] as { isError?: boolean }).isError).toBe(true);
  expect(resultText(toolEnd)).toContain('User denied');

  // deny 是引导不是终止(docs/07 §3.2):任务继续,模型换路收尾
  const end = await proc.waitForEvent((e) => e.type === 'agent_end', 'agent_end');
  expect(end['reason']).toBe('completed');
  expect(existsSync(path.join(proc.cwd, 'denied-marker.txt'))).toBe(false); // 命令确实没执行
  const alt = proc.events.find(
    (e) => e.type === 'message_end' && msgRole(e) === 'assistant' && msgText(e).includes('different approach'),
  );
  expect(alt).toBeDefined();

  // 审批发生在 prepare 阶段:approval_request 先于该工具的 tool_execution_start
  assertSubsequence(typeSeq(proc.events), [
    'approval_request',
    'tool_execution_start',
    'tool_execution_end',
    'agent_end',
  ]);

  proc.send({ type: 'shutdown' });
  expect(await proc.waitForExit()).toBe(0);
  expect(proc.parseErrors).toEqual([]);
}, T);

test('allow_once — 放行执行,输出回喂;不记忆(同类调用再次弹审批)', async () => {
  const proc = track(
    startCoda({
      extraArgs: INTERACTIVE,
      env: freshHome(),
      script: {
        turns: [
          { events: [{ kind: 'tool_call', name: 'bash', args: { command: 'echo approved-run' } }] },
          { events: [{ kind: 'tool_call', name: 'bash', args: { command: 'echo approved-run' } }] },
          { events: [{ kind: 'text', text: 'ran twice.' }] },
        ],
        onExhausted: 'emptyStop',
      },
    }),
  );
  proc.send({ type: 'prompt', text: 'run it' });

  const req1 = await proc.waitForEvent((e) => e.type === 'approval_request', 'first approval_request');
  proc.send({ type: 'approval', approvalId: req1['approvalId'], decision: 'allow_once' });

  const toolEnd = await proc.waitForEvent((e) => e.type === 'tool_execution_end', 'tool_execution_end');
  expect((toolEnd['result'] as { isError?: boolean }).isError).toBe(false);
  expect(resultText(toolEnd)).toContain('approved-run');

  // allow_once 不记忆:第二次同类调用再次弹审批(docs/07 §3.2)
  const req2 = await proc.waitForEvent(
    (e) => e.type === 'approval_request' && e['approvalId'] !== req1['approvalId'],
    'second approval_request',
  );
  proc.send({ type: 'approval', approvalId: req2['approvalId'], decision: 'allow_once' });

  const end = await proc.waitForEvent((e) => e.type === 'agent_end', 'agent_end');
  expect(end['reason']).toBe('completed');

  proc.send({ type: 'shutdown' });
  expect(await proc.waitForExit()).toBe(0);
  expect(proc.parseErrors).toEqual([]);
}, T);

test('allow_always — 记忆 pattern,同前缀命令不再弹审批', async () => {
  const proc = track(
    startCoda({
      extraArgs: INTERACTIVE,
      env: freshHome(),
      script: {
        turns: [
          { events: [{ kind: 'tool_call', name: 'bash', args: { command: 'echo again' } }] },
          { events: [{ kind: 'tool_call', name: 'bash', args: { command: 'echo more' } }] },
          { events: [{ kind: 'text', text: 'done twice.' }] },
        ],
        onExhausted: 'emptyStop',
      },
    }),
  );
  proc.send({ type: 'prompt', text: 'run twice' });

  const req = await proc.waitForEvent((e) => e.type === 'approval_request', 'approval_request');
  proc.send({ type: 'approval', approvalId: req['approvalId'], decision: 'allow_always' });

  const end = await proc.waitForEvent((e) => e.type === 'agent_end', 'agent_end');
  expect(end['reason']).toBe('completed');

  // 只有第一次弹审批;两次 bash 都成功执行
  expect(proc.events.filter((e) => e.type === 'approval_request')).toHaveLength(1);
  const toolEnds = proc.events.filter((e) => e.type === 'tool_execution_end');
  expect(toolEnds).toHaveLength(2);
  for (const te of toolEnds) expect((te['result'] as { isError?: boolean }).isError).toBe(false);

  proc.send({ type: 'shutdown' });
  expect(await proc.waitForExit()).toBe(0);
  expect(proc.parseErrors).toEqual([]);
}, T);

test('approval 决议 abort — 结果是中断形态而非拒绝形态(R7),run 以 aborted 收尾', async () => {
  const proc = track(
    startCoda({
      extraArgs: INTERACTIVE,
      env: freshHome(),
      script: {
        turns: [{ events: [{ kind: 'tool_call', name: 'bash', args: { command: 'touch abort-marker.txt' } }] }],
        onExhausted: 'emptyStop',
      },
    }),
  );
  proc.send({ type: 'prompt', text: 'run it' });

  const req = await proc.waitForEvent((e) => e.type === 'approval_request', 'approval_request');
  proc.send({ type: 'approval', approvalId: req['approvalId'], decision: 'abort' });

  const toolEnd = await proc.waitForEvent((e) => e.type === 'tool_execution_end', 'tool_execution_end');
  expect((toolEnd['result'] as { isError?: boolean }).isError).toBe(true);
  expect(resultText(toolEnd)).toContain('[Tool execution was interrupted]');
  expect(resultText(toolEnd)).not.toMatch(/denied/i); // 绝不以「拒绝」形态漏给模型

  const end = await proc.waitForEvent((e) => e.type === 'agent_end', 'agent_end');
  expect(end['reason']).toBe('aborted');
  expect(existsSync(path.join(proc.cwd, 'abort-marker.txt'))).toBe(false); // 命令确实没执行

  proc.send({ type: 'shutdown' });
  expect(await proc.waitForExit()).toBe(0);
  expect(proc.parseErrors).toEqual([]);
}, T);

test('审批悬挂中收到 abort 命令 — session.abort 先行、pending 以中断形态决议,不挂死', async () => {
  const proc = track(
    startCoda({
      extraArgs: INTERACTIVE,
      env: freshHome(),
      script: {
        turns: [{ events: [{ kind: 'tool_call', name: 'bash', args: { command: 'touch abort-cmd-marker.txt' } }] }],
        onExhausted: 'emptyStop',
      },
    }),
  );
  proc.send({ type: 'prompt', text: 'run it' });

  await proc.waitForEvent((e) => e.type === 'approval_request', 'approval_request');
  proc.send({ type: 'abort' }); // 不应答审批,直接硬中断(docs/07 §4:pending 不留悬挂)

  const end = await proc.waitForEvent((e) => e.type === 'agent_end', 'agent_end');
  expect(end['reason']).toBe('aborted');
  const toolEnd = proc.events.find((e) => e.type === 'tool_execution_end');
  expect(toolEnd).toBeDefined();
  expect(resultText(toolEnd)).toContain('[Tool execution was interrupted]');
  expect(resultText(toolEnd)).not.toMatch(/denied/i);
  expect(existsSync(path.join(proc.cwd, 'abort-cmd-marker.txt'))).toBe(false);

  proc.send({ type: 'shutdown' });
  expect(await proc.waitForExit()).toBe(0);
  expect(proc.parseErrors).toEqual([]);
}, T);

test('默认(不带 flag)= allow:不产生 approval_request,工具直接执行;approval 命令报不可用', async () => {
  const proc = track(
    startCoda({
      script: {
        turns: [
          { events: [{ kind: 'tool_call', name: 'bash', args: { command: 'echo default-allow' } }] },
          { events: [{ kind: 'text', text: 'done.' }] },
        ],
        onExhausted: 'emptyStop',
      },
    }),
  );
  proc.send({ type: 'prompt', text: 'run it' });

  const toolEnd = await proc.waitForEvent((e) => e.type === 'tool_execution_end', 'tool_execution_end');
  expect((toolEnd['result'] as { isError?: boolean }).isError).toBe(false);
  expect(resultText(toolEnd)).toContain('default-allow');

  const end = await proc.waitForEvent((e) => e.type === 'agent_end', 'agent_end');
  expect(end['reason']).toBe('completed');
  expect(proc.events.filter((e) => e.type === 'approval_request')).toHaveLength(0);

  // allow 模式没有 broker:approval 命令容错回报,不退出
  proc.send({ type: 'approval', approvalId: 'ap_nope', decision: 'deny' });
  const err = await proc.waitForEvent((e) => e.type === 'error', 'approval unavailable error');
  expect(err['fatal']).toBe(false);
  expect(String(err['message'])).toContain('approval not available');

  proc.send({ type: 'shutdown' });
  expect(await proc.waitForExit()).toBe(0);
  expect(proc.parseErrors).toEqual([]);
}, T);

test('审批悬挂中收到 shutdown — pending 决议后落盘退出,不挂死(exit 0)', async () => {
  const proc = track(
    startCoda({
      extraArgs: INTERACTIVE,
      env: freshHome(),
      script: {
        turns: [{ events: [{ kind: 'tool_call', name: 'bash', args: { command: 'touch shutdown-marker.txt' } }] }],
        onExhausted: 'emptyStop',
      },
    }),
  );
  proc.send({ type: 'prompt', text: 'run it' });

  await proc.waitForEvent((e) => e.type === 'approval_request', 'approval_request');
  proc.send({ type: 'shutdown' }); // 不应答审批直接 shutdown:abort → onAbort → close(docs/09 §6.4)

  expect(await proc.waitForExit()).toBe(0); // 挂死即看门狗失败——这是 waitForIdle 不悬挂的直接证明
  expect(existsSync(path.join(proc.cwd, 'shutdown-marker.txt'))).toBe(false);
  expect(proc.parseErrors).toEqual([]);
}, T);

test('--approval-mode deny — 静态拦截 edit/execute(无 approval_request),read 直通,任务继续', async () => {
  const proc = track(
    startCoda({
      extraArgs: ['--approval-mode', 'deny'],
      env: freshHome(),
      files: { 'data.txt': 'deny-mode read payload\n' },
      script: {
        turns: [
          { events: [{ kind: 'tool_call', name: 'bash', args: { command: 'touch deny-mode-marker.txt' } }] },
          { events: [{ kind: 'tool_call', name: 'read', args: { path: 'data.txt' } }] },
          { events: [{ kind: 'text', text: 'stayed read-only.' }] },
        ],
        onExhausted: 'emptyStop',
      },
    }),
  );
  proc.send({ type: 'prompt', text: 'try to write' });

  const end = await proc.waitForEvent((e) => e.type === 'agent_end', 'agent_end');
  expect(end['reason']).toBe('completed');

  // deny 模式不建 broker:全程零 approval_request(docs/07 §3 + 任务分工约定)
  expect(proc.events.filter((e) => e.type === 'approval_request')).toHaveLength(0);

  const toolEnds = proc.events.filter((e) => e.type === 'tool_execution_end');
  expect(toolEnds).toHaveLength(2);
  const bashEnd = toolEnds[0];
  expect((bashEnd?.['result'] as { isError?: boolean }).isError).toBe(true);
  expect(resultText(bashEnd)).toContain('approval');
  expect(existsSync(path.join(proc.cwd, 'deny-mode-marker.txt'))).toBe(false); // 拦住了
  const readEnd = toolEnds[1];
  expect((readEnd?.['result'] as { isError?: boolean }).isError).toBe(false); // read 直通
  expect(resultText(readEnd)).toContain('deny-mode read payload');

  proc.send({ type: 'shutdown' });
  expect(await proc.waitForExit()).toBe(0);
  expect(proc.parseErrors).toEqual([]);
}, T);
