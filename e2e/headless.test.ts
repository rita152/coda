// L5 e2e:headless --json 驱动完整会话(docs/10-testing.md §7 用例 1–4 + docs/09 §6 关键行为)。
// 每个用例断言管道纪律:stdout 每一行都可 JSON.parse(parseErrors 为空)。
// 除标注的 steer 宽松时序用例(retry: 1)外,一切等待都是事件驱动 + 30s 看门狗。

import { afterEach, beforeAll, expect, test } from 'bun:test';
import type { CodaProc } from './harness.js';
import {
  assertSubsequence,
  CASE_TIMEOUT_MS,
  msgRole,
  msgSource,
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

test('case 1: pure text conversation — protocol header, event order, exit 0', async () => {
  const proc = track(
    startCoda({
      script: {
        turns: [{ events: [{ kind: 'text', text: 'Hello from faux!' }] }],
        onExhausted: 'emptyStop',
      },
    }),
  );

  // 启动首行:{"type":"protocol","protocolVersion":"…"} 旁路事件(docs/09 §6.3)
  const header = await proc.waitForEvent((e) => e.type === 'protocol', 'protocol header');
  expect(header).toEqual({ type: 'protocol', protocolVersion: '1.0.0' });

  proc.send({ type: 'prompt', text: 'say hello' });
  const end = await proc.waitForEvent((e) => e.type === 'agent_end', 'agent_end');
  expect(end['reason']).toBe('completed');

  proc.send({ type: 'shutdown' });
  expect(await proc.waitForExit()).toBe(0);

  expect(proc.events[0]?.type).toBe('protocol'); // 首行必须是 protocol
  assertSubsequence(typeSeq(proc.events), [
    'protocol',
    'agent_start',
    'turn_start',
    'message_start(user)',
    'message_start(assistant)',
    'message_update',
    'message_end(assistant)',
    'turn_end',
    'agent_end',
  ]);
  const assistantEnd = proc.events.find((e) => e.type === 'message_end' && msgRole(e) === 'assistant');
  expect(msgText(assistantEnd)).toBe('Hello from faux!');

  // 管道纪律:stdout 每一行都可 JSON.parse,且除 NDJSON 外零输出
  expect(proc.parseErrors).toEqual([]);
  expect(proc.lines.length).toBe(proc.events.length);
}, T);

test('case 2: tool loop — read preset file, tool_execution_* events and tool_result content', async () => {
  const proc = track(
    startCoda({
      files: { 'data.txt': 'e2e read payload\nsecond line\n' },
      script: {
        turns: [
          { events: [{ kind: 'tool_call', name: 'read', args: { path: 'data.txt' } }] },
          { events: [{ kind: 'text', text: 'file read.' }] },
        ],
        onExhausted: 'emptyStop',
      },
    }),
  );
  proc.send({ type: 'prompt', text: 'read data.txt' });

  const start = await proc.waitForEvent((e) => e.type === 'tool_execution_start', 'tool_execution_start');
  expect(start['toolName']).toBe('read');
  expect((start['args'] as { path?: string }).path).toBe('data.txt');

  const toolEnd = await proc.waitForEvent((e) => e.type === 'tool_execution_end', 'tool_execution_end');
  const result = toolEnd['result'] as { isError: boolean };
  expect(result.isError).toBe(false);
  expect(resultText(toolEnd)).toContain('1: e2e read payload'); // read 输出带 "N: " 行号前缀

  const end = await proc.waitForEvent((e) => e.type === 'agent_end', 'agent_end');
  expect(end['reason']).toBe('completed');

  proc.send({ type: 'shutdown' });
  expect(await proc.waitForExit()).toBe(0);

  // 工具回路事件文法:tool_execution_* → tool_result 消息对 → turn_end → 下一 turn
  assertSubsequence(typeSeq(proc.events), [
    'agent_start',
    'tool_execution_start',
    'tool_execution_end',
    'message_start(tool_result)',
    'message_end(tool_result)',
    'turn_end',
    'message_end(assistant)',
    'agent_end',
  ]);
  const toolResultEnd = proc.events.find((e) => e.type === 'message_end' && msgRole(e) === 'tool_result');
  expect(msgText(toolResultEnd)).toContain('e2e read payload');
  expect(proc.parseErrors).toEqual([]);
}, T);

// 宽松时序用例(docs/10 §7 用例 3):文件脚本无 gate,依赖 bash `sleep 0.5` 的执行窗口
// 在工具运行期间注入命令——e2e 是唯一允许这种宽松时序的层,按 §8 flake 政策标 retry: 1。
// 其精确版本已在 L4 用 gate 钉死,此处只验「管道通」。prompt-running 冲突共用同一窗口。
test('case 3: steer during tool run — steering injected at turn boundary; prompt conflict is non-fatal', async () => {
  const proc = track(
    startCoda({
      script: {
        turns: [
          {
            events: [
              { kind: 'text', text: 'running a command' },
              { kind: 'tool_call', name: 'bash', args: { command: 'sleep 0.5' } },
            ],
          },
          { events: [{ kind: 'text', text: 'adjusted per steering.' }] },
        ],
        onExhausted: 'emptyStop',
      },
    }),
  );
  proc.send({ type: 'prompt', text: 'run it' });
  await proc.waitForEvent((e) => e.type === 'tool_execution_start', 'tool_execution_start(bash)');

  // 工具运行中 prompt:不 throw 到进程,输出 non-fatal error(docs/09 §6.2)
  proc.send({ type: 'prompt', text: 'conflicting prompt' });
  const conflict = await proc.waitForEvent((e) => e.type === 'error', 'prompt-running conflict error');
  expect(conflict['fatal']).toBe(false);
  expect(conflict['message']).toBe('agent is running; use steer or follow_up');

  proc.send({ type: 'steer', text: 'focus on cli only' });
  const steered = await proc.waitForEvent(
    (e) => e.type === 'message_start' && msgRole(e) === 'user' && msgSource(e) === 'steering',
    'steering message_start',
  );
  expect(msgText(steered)).toBe('focus on cli only');

  const end = await proc.waitForEvent((e) => e.type === 'agent_end', 'agent_end');
  expect(end['reason']).toBe('completed');

  // steering 注入发生在工具结束后的 turn 边界(不打断执行中工具)
  const toolEndIdx = proc.events.findIndex((e) => e.type === 'tool_execution_end');
  const steerIdx = proc.events.findIndex((e) => e.type === 'message_start' && msgSource(e) === 'steering');
  expect(toolEndIdx).toBeGreaterThan(-1);
  expect(steerIdx).toBeGreaterThan(toolEndIdx);

  proc.send({ type: 'shutdown' });
  expect(await proc.waitForExit()).toBe(0);
  expect(proc.parseErrors).toEqual([]);
}, { timeout: CASE_TIMEOUT_MS, retry: 1 });

test('case 4: abort — agent_end(aborted) and clean exit', async () => {
  const proc = track(
    startCoda({
      script: {
        turns: [{ events: [{ kind: 'tool_call', name: 'bash', args: { command: 'sleep 5' } }] }],
        onExhausted: 'emptyStop',
      },
    }),
  );
  proc.send({ type: 'prompt', text: 'run long command' });
  await proc.waitForEvent((e) => e.type === 'tool_execution_start', 'tool_execution_start');

  proc.send({ type: 'abort' });
  const end = await proc.waitForEvent((e) => e.type === 'agent_end', 'agent_end');
  expect(end['reason']).toBe('aborted');

  proc.send({ type: 'shutdown' });
  expect(await proc.waitForExit()).toBe(0);
  expect(proc.parseErrors).toEqual([]);
}, T);

test('shutdown while running — abort → waitForIdle → flush → exit 0', async () => {
  const proc = track(
    startCoda({
      script: {
        turns: [{ events: [{ kind: 'tool_call', name: 'bash', args: { command: 'sleep 5' } }] }],
        onExhausted: 'emptyStop',
      },
    }),
  );
  proc.send({ type: 'prompt', text: 'run long command' });
  await proc.waitForEvent((e) => e.type === 'tool_execution_start', 'tool_execution_start');

  proc.send({ type: 'shutdown' }); // 运行中 shutdown:先 abort 再落盘退出(docs/09 §6.4)
  const end = await proc.waitForEvent((e) => e.type === 'agent_end', 'agent_end');
  expect(end['reason']).toBe('aborted');
  expect(await proc.waitForExit()).toBe(0);
  expect(proc.parseErrors).toEqual([]);
}, T);

test('invalid stdin lines — non-fatal error, pipe continues; EOF acts as shutdown', async () => {
  const proc = track(
    startCoda({
      script: {
        turns: [{ events: [{ kind: 'text', text: 'still alive' }] }],
        onExhausted: 'emptyStop',
      },
    }),
  );
  await proc.waitForEvent((e) => e.type === 'protocol', 'protocol header');

  proc.sendRaw('this is not json\n');
  const err1 = await proc.waitForEvent((e) => e.type === 'error', 'invalid json error');
  expect(err1['fatal']).toBe(false);
  expect(String(err1['message'])).toContain('invalid command');

  proc.send({ type: 'dance' }); // 未知命令类型同样容错
  const err2 = await proc.waitForEvent(
    (e) => e.type === 'error' && e !== err1,
    'unknown command error',
  );
  expect(err2['fatal']).toBe(false);
  expect(String(err2['message'])).toContain('invalid command');

  // 容错后管道继续可用
  proc.send({ type: 'prompt', text: 'hello' });
  const end = await proc.waitForEvent((e) => e.type === 'agent_end', 'agent_end');
  expect(end['reason']).toBe('completed');

  proc.endStdin(); // stdin EOF 视同 shutdown(docs/09 §6.4)
  expect(await proc.waitForExit()).toBe(0);
  expect(proc.parseErrors).toEqual([]);
}, T);
