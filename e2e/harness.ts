// L5 e2e harness(规格见 docs/10-testing.md §7):spawn 构建产物 dist/main.js,
// 走 --json headless 管道驱动完整会话:stdin 写 JSON 命令、逐行收 stdout NDJSON。
// faux 脚本是 FauxScript 的可序列化子集(events/stopReason/usage,无 gate/回调),
// 写成临时 JSON 文件经 --faux-script 传入。
// 计时纪律:本文件的 setTimeout 只用于单事件 15s 看门狗(挂起时快速失败并倾倒已收事件),
// 不用于等待条件;唯一允许宽松时序的是 steer 用例(docs/10 §7 用例 3 + §8 flake 政策)。
// bun:test 用例超时统一 60s(慢 CI 余量):单事件看门狗先于用例超时触发,失败信息更有用。

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assertSanitizedTestEnvironment,
  sanitizedTestEnvironment,
} from '../scripts/test-environment.js';

const ROOT = path.resolve(import.meta.dir, '..');
export const DIST_MAIN = path.join(ROOT, 'dist', 'main.js');
export const WATCHDOG_MS = 15_000;
/** bun:test 用例超时(慢 CI 余量;单事件看门狗 15s 先触发,给出事件倾倒)。 */
export const CASE_TIMEOUT_MS = 60_000;

/**
 * e2e 依赖 Bun.build 构建产物:缺失时给出可执行的修复提示,而不是含糊的 spawn 失败。
 * 已知限制:只检查存在性,不检查新旧——规范入口 `bun run test:e2e` 会先重建,
 * 裸跑 `bun test e2e` 则可能驱动陈旧 dist。
 */
export function requireDist(): void {
  if (!existsSync(DIST_MAIN)) {
    throw new Error(
      `e2e requires the built CLI at ${DIST_MAIN} — run \`bun run test:e2e\` ` +
        '(docs/10-testing.md §2: L5 drives the Bun.build output).',
    );
  }
}

/** stdout NDJSON 行解析后的宽松事件形状(tolerant reader:未知字段/类型一律容忍)。 */
export interface Ev {
  type: string;
  [key: string]: unknown;
}

export interface StartOptions {
  /** FauxScript 的可序列化子集,原样写入临时 JSON 文件。 */
  script: unknown;
  /** cwd 下的预置文件(相对路径 → 内容)。 */
  files?: Record<string, string>;
  /** --resume <id>(配合 sessionDir 复用会话目录)。 */
  resume?: string;
  sessionDir?: string;
  cwd?: string;
  /** -p <text>(一次性模式;与 json:false 组合可测人类可读模式退出码)。 */
  prompt?: string;
  /** 默认 true(--json headless);false 走人类可读输出——此时 stdout 行不是 NDJSON,勿断言 parseErrors。 */
  json?: boolean;
  /** 额外 CLI flags(如 ['--approval-mode', 'interactive'],M6 审批用例)。 */
  extraArgs?: string[];
  /** 安全环境变量覆盖;HOME 默认隔离到本次临时 cwd，继承环境会先移除凭证与 endpoint。 */
  env?: Record<string, string>;
}

export interface CodaProc {
  child: ReturnType<typeof Bun.spawn>;
  cwd: string;
  sessionDir: string;
  /** stdout 原始行(管道纪律断言用:每行必须可 JSON.parse)。 */
  lines: string[];
  events: Ev[];
  /** 无法 JSON.parse(或无 type 字段)的 stdout 行——任何用例都应断言其为空。 */
  parseErrors: string[];
  stderr: () => string;
  send: (cmd: unknown) => void;
  sendRaw: (text: string) => void;
  endStdin: () => void;
  /** 等待谓词命中的事件(先查历史再等未来;超时 reject 并倾倒已收事件)。 */
  waitForEvent: (pred: (e: Ev) => boolean, label: string, timeoutMs?: number) => Promise<Ev>;
  waitForExit: (timeoutMs?: number) => Promise<number>;
  /** 测试收尾兜底:进程若还活着强杀(正常路径经 shutdown/EOF 自然退出)。 */
  kill: () => void;
}

export function startCoda(opts: StartOptions): CodaProc {
  const cwd = opts.cwd ?? mkdtempSync(path.join(tmpdir(), 'coda-e2e-'));
  const sessionDir = opts.sessionDir ?? path.join(cwd, 'sessions');
  const isolatedHome = path.join(cwd, '.home');
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(isolatedHome, { recursive: true });
  for (const [name, content] of Object.entries(opts.files ?? {})) {
    writeFileSync(path.join(cwd, name), content, 'utf8');
  }
  const scriptPath = path.join(cwd, `faux-script-${Math.random().toString(36).slice(2, 8)}.json`);
  writeFileSync(scriptPath, JSON.stringify(opts.script), 'utf8');

  const args = [DIST_MAIN];
  if (opts.json !== false) args.push('--json');
  args.push(
    '--provider', 'faux', '--faux-script', scriptPath,
    '--session-dir', sessionDir, '--cwd', cwd,
  );
  if (opts.prompt !== undefined) args.push('-p', opts.prompt);
  if (opts.resume !== undefined) args.push('--resume', opts.resume);
  if (opts.extraArgs !== undefined) args.push(...opts.extraArgs);
  const childEnv = buildE2eEnvironment(Bun.env, isolatedHome, opts.env);
  const child = Bun.spawn([Bun.argv[0] as string, '--no-env-file', ...args], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: childEnv,
  });

  const lines: string[] = [];
  const events: Ev[] = [];
  const parseErrors: string[] = [];
  let stderrBuf = '';
  type Waiter = { pred: (e: Ev) => boolean; resolve: (e: Ev) => void };
  const waiters: Waiter[] = [];

  const onLine = (line: string): void => {
    lines.push(line);
    let ev: Ev;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { type?: unknown }).type !== 'string') {
        parseErrors.push(line);
        return;
      }
      ev = parsed as Ev;
    } catch {
      parseErrors.push(line);
      return;
    }
    events.push(ev);
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i] as Waiter;
      if (w.pred(ev)) {
        waiters.splice(i, 1);
        w.resolve(ev);
      }
    }
  };

  let stdoutBuf = '';
  const stdoutDone = pumpText(child.stdout, (chunk) => {
    stdoutBuf += chunk;
    let newline = stdoutBuf.indexOf('\n');
    while (newline >= 0) {
      const raw = stdoutBuf.slice(0, newline);
      stdoutBuf = stdoutBuf.slice(newline + 1);
      onLine(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
      newline = stdoutBuf.indexOf('\n');
    }
  }).then(() => {
    if (stdoutBuf.length > 0) onLine(stdoutBuf.endsWith('\r') ? stdoutBuf.slice(0, -1) : stdoutBuf);
  });
  const stderrDone = pumpText(child.stderr, (chunk) => {
    stderrBuf += chunk;
  });

  let processExited = false;
  const childExit = child.exited.then(
    (code) => {
      processExited = true;
      return code;
    },
    (error: unknown) => {
      processExited = true;
      throw error;
    },
  );
  const completion = combineProcessCompletion(childExit, stdoutDone, stderrDone);
  // waitForExit 会观察同一个 rejection；提前挂 handler 避免调用者尚未等待时触发 unhandled rejection。
  void completion.catch(() => undefined);

  const watchdogMessage = (label: string): string =>
    `watchdog: timed out waiting for ${label}\n` +
    `events so far: ${typeSeq(events).join(' → ') || '(none)'}\n` +
    `parse errors: ${parseErrors.length}\nstderr: ${stderrBuf || '(empty)'}`;

  return {
    child,
    cwd,
    sessionDir,
    lines,
    events,
    parseErrors,
    stderr: () => stderrBuf,
    send: (cmd) => {
      child.stdin.write(`${JSON.stringify(cmd)}\n`);
      child.stdin.flush();
    },
    sendRaw: (text) => {
      child.stdin.write(text);
      child.stdin.flush();
    },
    endStdin: () => {
      child.stdin.end();
    },
    waitForEvent: (pred, label, timeoutMs = WATCHDOG_MS) => {
      const found = events.find(pred);
      if (found !== undefined) return Promise.resolve(found);
      return new Promise<Ev>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(entry);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(new Error(watchdogMessage(label)));
        }, timeoutMs);
        timer.unref();
        const entry: Waiter = {
          pred,
          resolve: (e) => {
            clearTimeout(timer);
            resolve(e);
          },
        };
        waiters.push(entry);
      });
    },
    waitForExit: (timeoutMs = WATCHDOG_MS) =>
      waitWithWatchdog(completion, timeoutMs, () => watchdogMessage('process exit')),
    kill: () => {
      if (!processExited) child.kill(9);
    },
  };
}

/** E2E 子进程只继承非敏感变量，并默认使用测试拥有的 HOME。 */
export function buildE2eEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  isolatedHome: string,
  overrides?: Readonly<Record<string, string>>,
): Record<string, string> {
  const env = {
    ...sanitizedTestEnvironment(source),
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    ...overrides,
  };
  assertSanitizedTestEnvironment(env);
  return env;
}

/** 进程退出与两个输出 pump 共同构成 completion；任一失败都原样传播给 waitForExit。 */
export async function combineProcessCompletion(
  childExit: Promise<number>,
  stdoutDone: Promise<void>,
  stderrDone: Promise<void>,
): Promise<number> {
  const [code] = await Promise.all([childExit, stdoutDone, stderrDone]);
  return code;
}

function waitWithWatchdog<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: () => string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(timeoutMessage()));
    }, timeoutMs);
    timer.unref();
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function pumpText(stream: ReadableStream<Uint8Array>, onChunk: (text: string) => void): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk(decoder.decode(value, { stream: true }));
    }
    const tail = decoder.decode();
    if (tail.length > 0) onChunk(tail);
  } finally {
    reader.releaseLock();
  }
}

// ---------- 事件断言辅助 ----------

/** 归一化:事件 type 序列(message_start/end 附角色标注),与 L4 快照口径一致。 */
export function typeSeq(events: Ev[]): string[] {
  return events.map((e) => {
    const role = msgRole(e);
    if ((e.type === 'message_start' || e.type === 'message_end') && role !== undefined) {
      return `${e.type}(${role})`;
    }
    return e.type;
  });
}

/** 断言 expected 是 actual 的有序子序列(usage_update / queue_update 等叠加事件可穿插)。 */
export function assertSubsequence(actual: string[], expected: string[]): void {
  let i = 0;
  for (const a of actual) {
    if (a === expected[i]) i++;
  }
  if (i < expected.length) {
    throw new Error(
      `event sequence missing "${expected[i] as string}" (matched ${i}/${expected.length})\n` +
        `actual: ${actual.join(' → ')}`,
    );
  }
}

export function msgRole(e: Ev | undefined): string | undefined {
  return (e?.['message'] as { role?: string } | undefined)?.role;
}

export function msgSource(e: Ev | undefined): string | undefined {
  return (e?.['message'] as { source?: string } | undefined)?.source;
}

/** message 事件内 TextPart 拼接。 */
export function msgText(e: Ev | undefined): string {
  const msg = e?.['message'] as { content?: { type: string; text?: string }[] } | undefined;
  return (msg?.content ?? [])
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .join('');
}

/** tool_execution_end.result 的 TextPart 拼接。 */
export function resultText(e: Ev | undefined): string {
  const result = e?.['result'] as { content?: { type: string; text?: string }[] } | undefined;
  return (result?.content ?? [])
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .join('');
}

/** 读 JSONL 文件为记录数组(resume 用例校验会话文件)。 */
export function readJsonl(file: string): Record<string, unknown>[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}
