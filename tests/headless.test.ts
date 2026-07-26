// headless 模式单测(规格见 docs/09-cli.md §6):注入 PassThrough 流,真实 Session +
// faux provider(gate 钉死时序,零计时器)。e2e(e2e/headless.test.ts)驱动构建产物验
// 同一契约;此处覆盖无需子进程即可确定性钉死的行为:protocol 首行、事件原样外发
// (无信封)、invalid line 容错、prompt-running 冲突、EOF/shutdown 流程与退出码。

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { expect, test } from 'vitest';
import { startHeadless } from '../src/cli/headless.js';
import { Session } from '../src/session/index.js';
import { PROTOCOL_VERSION } from '../src/session/index.js';
import { createFauxStreamFn, createGate } from '../src/providers/faux/index.js';
import type { FauxScript } from '../src/providers/faux/index.js';

interface Ev {
  type: string;
  [key: string]: unknown;
}

interface HeadlessRun {
  stdin: PassThrough;
  lines: string[];
  events: Ev[];
  exit: Promise<number>;
  send: (cmd: unknown) => void;
  sendRaw: (text: string) => void;
  /** faux 调用留档:出站转录断言用(docs/10 §5——不猜内部状态,只看 wire 面)。 */
  streamFn: ReturnType<typeof createFauxStreamFn>;
  /** 等待谓词命中的事件(先查历史再等未来;看门狗是 vitest 用例超时,无裸计时器)。 */
  waitForEvent: (pred: (e: Ev) => boolean) => Promise<Ev>;
}

async function startRun(script: FauxScript): Promise<HeadlessRun> {
  const dir = mkdtempSync(path.join(tmpdir(), 'coda-headless-'));
  const streamFn = createFauxStreamFn(script);
  const session = await Session.create({
    dir,
    agentConfig: {
      streamFn,
      model: { ref: { provider: 'faux', api: 'faux', model: 'test' } },
      tools: [],
      systemPrompt: 'test',
      cwd: dir,
    },
  });

  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const lines: string[] = [];
  const events: Ev[] = [];
  const waiters: { pred: (e: Ev) => boolean; resolve: (e: Ev) => void }[] = [];
  const rl = createInterface({ input: stdout, terminal: false });
  rl.on('line', (line) => {
    lines.push(line);
    const ev = JSON.parse(line) as Ev; // 管道纪律:每行必须可 parse,否则测试即失败
    events.push(ev);
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i] as (typeof waiters)[number];
      if (w.pred(ev)) {
        waiters.splice(i, 1);
        w.resolve(ev);
      }
    }
  });

  const exit = startHeadless(session, { stdin, stdout });
  return {
    stdin,
    lines,
    events,
    exit,
    streamFn,
    send: (cmd) => {
      stdin.write(`${JSON.stringify(cmd)}\n`);
    },
    sendRaw: (text) => {
      stdin.write(text);
    },
    waitForEvent: (pred) => {
      const found = events.find(pred);
      if (found !== undefined) return Promise.resolve(found);
      return new Promise<Ev>((resolve) => {
        waiters.push({ pred, resolve });
      });
    },
  };
}

test('protocol 首行 + SessionEvent 原样外发(无信封);EOF 视同 shutdown,exit 0', async () => {
  const run = await startRun({
    turns: [{ events: [{ kind: 'text', text: 'hello world' }] }],
  });

  const header = await run.waitForEvent((e) => e.type === 'protocol');
  expect(header).toEqual({ type: 'protocol', protocolVersion: PROTOCOL_VERSION });
  expect(run.lines[0]).toBe(JSON.stringify({ type: 'protocol', protocolVersion: PROTOCOL_VERSION }));

  run.send({ type: 'prompt', text: 'hi' });
  const end = await run.waitForEvent((e) => e.type === 'agent_end');
  expect(end['reason']).toBe('completed');

  // 原样外发:agent_start 行就是事件本身,不包裹信封、不加自定义字段
  const start = run.events.find((e) => e.type === 'agent_start');
  expect(start).toEqual({ type: 'agent_start', reason: 'prompt' });

  run.stdin.end(); // EOF → shutdown → flush → 0
  await expect(run.exit).resolves.toBe(0);
});

test('无法解析的 stdin 行:non-fatal error 且管道继续;shutdown 命令退出 0', async () => {
  const run = await startRun({
    turns: [{ events: [{ kind: 'text', text: 'still alive' }] }],
  });

  run.sendRaw('not json at all\n');
  const err1 = await run.waitForEvent((e) => e.type === 'error');
  expect(err1['fatal']).toBe(false);
  expect(String(err1['message'])).toContain('invalid command');

  run.send({ type: 'dance' }); // 未知命令类型同样容错
  const err2 = await run.waitForEvent((e) => e.type === 'error' && e !== err1);
  expect(err2['fatal']).toBe(false);

  run.send({ type: 'steer' }); // 缺 text 字段
  const err3 = await run.waitForEvent((e) => e.type === 'error' && e !== err1 && e !== err2);
  expect(String(err3['message'])).toContain('text');

  // 容错后管道继续可用
  run.send({ type: 'prompt', text: 'go' });
  const end = await run.waitForEvent((e) => e.type === 'agent_end');
  expect(end['reason']).toBe('completed');

  run.send({ type: 'shutdown' });
  await expect(run.exit).resolves.toBe(0);
});

test('prompt-running 冲突:non-fatal error,不 throw 到进程(gate 钉死时序)', async () => {
  const gate = createGate();
  const run = await startRun({
    turns: [{ events: [{ kind: 'gate', gate }, { kind: 'text', text: 'after gate' }] }],
  });

  run.send({ type: 'prompt', text: 'first' });
  await run.waitForEvent((e) => e.type === 'message_start' && (e['message'] as { role?: string }).role === 'assistant');

  // 流悬停在 gate:agent 确定处于 running,此刻的 prompt 必须变 error 事件
  run.send({ type: 'prompt', text: 'second' });
  const err = await run.waitForEvent((e) => e.type === 'error');
  expect(err).toEqual({ type: 'error', fatal: false, message: 'agent is running; use steer or follow_up' });

  gate.open();
  const end = await run.waitForEvent((e) => e.type === 'agent_end');
  expect(end['reason']).toBe('completed');

  run.send({ type: 'shutdown' });
  await expect(run.exit).resolves.toBe(0);
});

test('idle 时 steer:滞留队列,由下一次 prompt 的起跑 poll 捎上(docs/09 §6.2 映射表)', async () => {
  const run = await startRun({
    turns: [{ events: [{ kind: 'text', text: 'reply' }] }],
  });

  run.send({ type: 'steer', text: 'queued while idle' });
  const qu = await run.waitForEvent((e) => e.type === 'queue_update');
  expect((qu['steering'] as { text: string }[]).map((m) => m.text)).toEqual(['queued while idle']);
  // idle 的 steer 不自行起跑,也不报错
  expect(run.events.some((e) => e.type === 'agent_start')).toBe(false);
  expect(run.events.some((e) => e.type === 'error')).toBe(false);

  run.send({ type: 'prompt', text: 'now go' });
  const end = await run.waitForEvent((e) => e.type === 'agent_end');
  expect(end['reason']).toBe('completed');

  // 出站断言(faux calls):滞留的 steering 消息与 prompt 消息同批出站,prompt 在前
  expect(run.streamFn.calls).toHaveLength(1);
  const outbound = run.streamFn.calls[0]?.context.messages ?? [];
  expect(outbound.map((m) => m.role)).toEqual(['user', 'user']);
  const texts = outbound.map((m) =>
    m.role === 'user' ? m.content.filter((p) => p.type === 'text').map((p) => p.text).join('') : '',
  );
  expect(texts).toEqual(['now go', 'queued while idle']);

  // drain 消费时机的第二个 queue_update:steering 已清空(docs/06 §8.1 快照语义)
  const updates = run.events.filter((e) => e.type === 'queue_update');
  expect(updates).toHaveLength(2);
  expect(updates[1]?.['steering']).toEqual([]);

  run.send({ type: 'shutdown' });
  await expect(run.exit).resolves.toBe(0);
});

test('idle 时 abort:no-op——零事件、无异常,管道照常可用(docs/09 §6.2 映射表)', async () => {
  const run = await startRun({
    turns: [{ events: [{ kind: 'text', text: 'ok' }] }],
  });
  await run.waitForEvent((e) => e.type === 'protocol');

  run.send({ type: 'abort' });
  run.send({ type: 'prompt', text: 'go' });
  const end = await run.waitForEvent((e) => e.type === 'agent_end');
  expect(end['reason']).toBe('completed');            // idle abort 不把随后的 run 变成 aborted

  // abort 本身零输出:agent_start 之前只有 protocol 首行;全程无 error 事件
  const startIdx = run.events.findIndex((e) => e.type === 'agent_start');
  expect(run.events.slice(0, startIdx).map((e) => e.type)).toEqual(['protocol']);
  expect(run.events.filter((e) => e.type === 'error')).toEqual([]);

  run.send({ type: 'shutdown' });
  await expect(run.exit).resolves.toBe(0);
});

test('shutdown 运行中:先 abort 再落盘退出 0(agent_end reason aborted)', async () => {
  const gate = createGate();
  const run = await startRun({
    turns: [{ events: [{ kind: 'gate', gate }, { kind: 'text', text: 'never sent' }] }],
  });

  run.send({ type: 'prompt', text: 'go' });
  await run.waitForEvent((e) => e.type === 'message_start' && (e['message'] as { role?: string }).role === 'assistant');

  run.send({ type: 'shutdown' }); // 流悬停在 gate:shutdown 先 abort(gate 等待感知 signal)
  const end = await run.waitForEvent((e) => e.type === 'agent_end');
  expect(end['reason']).toBe('aborted');
  await expect(run.exit).resolves.toBe(0);
});
