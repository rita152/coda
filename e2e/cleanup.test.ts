// L5 e2e:启动清理接线(docs/07-tools.md §1.6)。cleanup 函数本体的 7 天边界在
// src/cli/cleanup.test.ts 单测钉死;这里只证一件事:main.ts 启动确实调用了清理——
// HOME 指到临时目录,预置过期落盘文件,跑一次一次性会话后文件应消失。
// mtime 用 utimesSync 伪造,零计时器;进程自然退出即 fs 操作已 settle。

import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, expect, test } from 'bun:test';
import type { CodaProc } from './harness.js';
import { CASE_TIMEOUT_MS, requireDist, startCoda } from './harness.js';

beforeAll(() => {
  requireDist();
});

const procs: CodaProc[] = [];
afterEach(() => {
  for (const p of procs.splice(0)) p.kill();
});

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

test('启动时清理 $HOME/.coda/truncated 的过期落盘;新文件保留', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'coda-home-'));
  const scope = path.join(home, '.coda', 'truncated', 's-old');
  mkdirSync(scope, { recursive: true });
  const old = path.join(scope, 'expired.txt');
  const fresh = path.join(scope, 'fresh.txt');
  writeFileSync(old, 'stale spill', 'utf8');
  writeFileSync(fresh, 'recent spill', 'utf8');
  const oldSec = (Date.now() - RETENTION_MS - 60_000) / 1000;
  utimesSync(old, oldSec, oldSec);

  const proc = startCoda({
    env: { HOME: home },
    prompt: 'say hi', // --json -p 一次性:agent_end 后自动 shutdown,进程自然退出
    script: {
      turns: [{ events: [{ kind: 'text', text: 'hi' }] }],
      onExhausted: 'emptyStop',
    },
  });
  procs.push(proc);

  expect(await proc.waitForExit()).toBe(0);
  expect(existsSync(old)).toBe(false); // 过期文件被启动清理删除(main.ts 接线的直接证明)
  expect(existsSync(fresh)).toBe(true); // 7 天内的保留
  expect(proc.parseErrors).toEqual([]);
}, { timeout: CASE_TIMEOUT_MS });
