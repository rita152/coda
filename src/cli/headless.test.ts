// headless 生命周期单测(docs/09 §6.4 M5 核查修复面):
// (1) fatal:true 的 error 事件 → 事件照常外发后 shutdown 并 exit 1(「致命错误 → exit 1」);
// (2) initialPrompt(--json -p 一次性特例)→ 启动注入 prompt,agent_end 后自动 shutdown,
//     reason 'error' → exit 1、completed → 0。
// 基础契约(protocol 首行/容错/EOF)已由 tests/headless.test.ts 覆盖,此处不重复。
// 纪律:注入 PassThrough 流 + 真实 Session + faux provider,零计时器;
// fatal 通过 AgentConfig.systemPrompt 函数 throw 触发 loop 的防御路径(不 mock 内部)。

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { expect, test, vi } from 'bun:test';
import { createFauxStreamFn } from '../providers/faux/index.js';
import type { FauxScript } from '../providers/faux/index.js';
import { Session } from '../session/index.js';
import type { RetryOptions } from '../session/index.js';
import { startHeadless } from './headless.js';

interface Ev {
  type: string;
  [key: string]: unknown;
}

interface RunOptions {
  script: FauxScript;
  initialPrompt?: string;
  /** 覆盖 systemPrompt(函数 throw 可触发 loop 防御路径的 fatal 事件)。 */
  systemPrompt?: string | (() => string);
  retry?: RetryOptions;
}

interface HeadlessRun {
  stdin: PassThrough;
  events: Ev[];
  exit: Promise<number>;
  send: (cmd: unknown) => void;
  waitForEvent: (pred: (e: Ev) => boolean) => Promise<Ev>;
}

function signal(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

async function startRun(opts: RunOptions): Promise<HeadlessRun> {
  const dir = mkdtempSync(path.join(tmpdir(), 'coda-headless-cli-'));
  const session = await Session.create({
    dir,
    ...(opts.retry !== undefined && { retry: opts.retry }),
    agentConfig: {
      streamFn: createFauxStreamFn(opts.script),
      model: { ref: { provider: 'faux', api: 'faux', model: 'test' } },
      tools: [],
      systemPrompt: opts.systemPrompt ?? 'test',
      cwd: dir,
    },
  });

  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const events: Ev[] = [];
  const waiters: { pred: (e: Ev) => boolean; resolve: (e: Ev) => void }[] = [];
  const rl = createInterface({ input: stdout, terminal: false });
  rl.on('line', (line) => {
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

  const exit = startHeadless(session, {
    stdin,
    stdout: {
      enqueue: (chunk) => {
        stdout.write(chunk);
      },
      drain: () => Promise.resolve(),
    },
    ...(opts.initialPrompt !== undefined && { initialPrompt: opts.initialPrompt }),
  });
  return {
    stdin,
    events,
    exit,
    send: (cmd) => {
      stdin.write(`${JSON.stringify(cmd)}\n`);
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

test('fatal error 事件:照常外发后走 shutdown 路径,exit 1(docs/09 §6.4)', async () => {
  // systemPrompt 函数 throw → streamAssistantResponse 防御路径发 {type:'error',fatal:true}
  const run = await startRun({
    script: { turns: [{ events: [{ kind: 'text', text: 'unreachable' }] }] },
    systemPrompt: () => {
      throw new Error('system prompt bug');
    },
  });

  run.send({ type: 'prompt', text: 'go' });
  const fatal = await run.waitForEvent((e) => e.type === 'error' && e['fatal'] === true);
  expect(String(fatal['message'])).toContain('system prompt bug');

  // 不需要 shutdown 命令/EOF:fatal 自行触发退出,且退出码为 1(不是 shutdown 的 0)
  await expect(run.exit).resolves.toBe(1);
  // 事件流完整闭合:fatal 后 agent_end(error) 仍照常外发(abort→close 不吞尾部事件)
  const end = run.events.find((e) => e.type === 'agent_end');
  expect(end?.['reason']).toBe('error');
});

test('initialPrompt 一次性特例:注入 prompt → agent_end(completed) 自动 shutdown,exit 0', async () => {
  const run = await startRun({
    script: { turns: [{ events: [{ kind: 'text', text: 'one shot answer' }] }], onExhausted: 'emptyStop' },
    initialPrompt: 'say it once',
  });

  // 不写任何 stdin 命令:事件流完整外发后自动退出
  await expect(run.exit).resolves.toBe(0);
  expect(run.events[0]).toEqual({ type: 'protocol', protocolVersion: '1.0.0' });
  const types = run.events.map((e) => e.type);
  expect(types).toContain('agent_start');
  expect(types).toContain('agent_end');
  const user = run.events.find(
    (e) => e.type === 'message_start' && (e['message'] as { role?: string }).role === 'user',
  );
  expect((user?.['message'] as { content: { text?: string }[] }).content[0]?.text).toBe('say it once');
});

test('initialPrompt 一次性特例:stdin EOF 不会中止仍在等待的真实异步任务', async () => {
  const retryGate = signal();
  const run = await startRun({
    script: {
      turns: [
        {
          error: {
            message: 'retry after EOF',
            details: { kind: 'http', status: 503, retryable: true },
          },
        },
        { events: [{ kind: 'text', text: 'answer after EOF' }] },
      ],
      onExhausted: 'emptyStop',
    },
    initialPrompt: 'keep running',
    retry: {
      jitter: () => 0.5,
      sleep: async () => {
        await retryGate.promise;
        return false;
      },
    },
  });

  await run.waitForEvent((event) =>
    event.type === 'agent_end' && event['willRetry'] === true);
  run.stdin.end();
  retryGate.open();

  await expect(run.exit).resolves.toBe(0);
  const ends = run.events.filter((event) => event.type === 'agent_end');
  expect(ends).toHaveLength(2);
  expect(ends.at(-1)?.['reason']).toBe('completed');
  expect(JSON.stringify(run.events)).toContain('answer after EOF');
});

test('initialPrompt 一次性特例:agent_end reason error → exit 1(脚本可感知)', async () => {
  const run = await startRun({
    script: { turns: [{ error: { message: 'provider blew up' } }], onExhausted: 'emptyStop' },
    initialPrompt: 'doomed',
  });

  await expect(run.exit).resolves.toBe(1);
  const end = run.events.find((e) => e.type === 'agent_end');
  expect(end?.['reason']).toBe('error');
});

test('initialPrompt 一次性特例:RetrySleep reject 发 fatal error 并 exit 1', async () => {
  const run = await startRun({
    script: {
      turns: [
        {
          error: {
            message: 'temporary outage',
            details: { kind: 'http', status: 503, retryable: true },
          },
        },
      ],
    },
    initialPrompt: 'retry once',
    retry: {
      jitter: () => 0.5,
      sleep: () => Promise.reject(new Error('injected sleep failure')),
    },
  });

  await expect(run.exit).resolves.toBe(1);
  const fatal = run.events.find((e) => e.type === 'error' && e['fatal'] === true);
  expect(String(fatal?.['message'])).toContain('injected sleep failure');
  const ends = run.events.filter((e) => e.type === 'agent_end');
  expect(ends).toHaveLength(1);
  expect(ends[0]?.['willRetry']).toBe(true);
});

test('protocol stdout 失败会关闭 Session、只诊断一次并 exit 1', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'coda-headless-output-failure-'));
  const session = await Session.create({
    dir,
    agentConfig: {
      streamFn: createFauxStreamFn({ turns: [], onExhausted: 'emptyStop' }),
      model: { ref: { provider: 'faux', api: 'faux', model: 'test' } },
      tools: [],
      systemPrompt: 'test',
      cwd: dir,
    },
  });
  const failure = new Error('broken stdout');
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  try {
    await expect(
      startHeadless(session, {
        stdin: new PassThrough(),
        stdout: {
          enqueue: () => undefined,
          drain: () => Promise.reject(failure),
        },
      }),
    ).resolves.toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    await expect(session.prompt('after close')).rejects.toThrow(/closed/i);
  } finally {
    errorSpy.mockRestore();
  }
});

test('Session listener 等待每条 NDJSON drain 后才放行下一事件', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'coda-headless-backpressure-'));
  const session = await Session.create({
    dir,
    agentConfig: {
      streamFn: createFauxStreamFn({
        turns: [{ events: [{ kind: 'text', text: 'answer' }] }],
        onExhausted: 'emptyStop',
      }),
      model: { ref: { provider: 'faux', api: 'faux', model: 'test' } },
      tools: [],
      systemPrompt: 'test',
      cwd: dir,
    },
  });
  const stdin = new PassThrough();
  const protocolDrain = signal();
  const firstEventDrain = signal();
  const firstEventBlocked = signal();
  const agentEnded = signal();
  const events: Ev[] = [];
  let drainCalls = 0;

  const exit = startHeadless(session, {
    stdin,
    stdout: {
      enqueue(chunk) {
        const event = JSON.parse(chunk) as Ev;
        events.push(event);
        if (event.type === 'agent_end') agentEnded.open();
      },
      drain() {
        drainCalls++;
        if (drainCalls === 1) return protocolDrain.promise;
        if (drainCalls === 2) {
          firstEventBlocked.open();
          return firstEventDrain.promise;
        }
        return Promise.resolve();
      },
    },
  });

  expect(events.map((e) => e.type)).toEqual(['protocol']);
  protocolDrain.open();
  stdin.write(`${JSON.stringify({ type: 'prompt', text: 'go' })}\n`);

  await firstEventBlocked.promise;
  expect(events.map((e) => e.type)).toEqual(['protocol', 'agent_start']);

  firstEventDrain.open();
  await agentEnded.promise;
  stdin.end();
  await expect(exit).resolves.toBe(0);
});
