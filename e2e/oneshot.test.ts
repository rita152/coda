// L5 e2e:一次性模式与退出码(docs/09 §6.4 + §8,M5 核查修复面)。
// - `coda --json -p "..."`:完整事件流后自动退出(无需 shutdown 命令/EOF);
//   agent_end reason 'error' → exit 1、completed → exit 0(-p 人类可读模式同规则);
// - `coda </dev/null`(非 TTY 空 stdin 且无 -p):不落入 REPL 挂起,stderr 用法提示,exit 2。

import { afterEach, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CodaProc } from './harness.js';
import {
  assertSubsequence,
  CASE_TIMEOUT_MS,
  msgRole,
  msgText,
  requireDist,
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

test('--json -p: full event stream then automatic exit 0 (docs/09 §6.4 one-shot)', async () => {
  const proc = track(
    startCoda({
      script: {
        turns: [{ events: [{ kind: 'text', text: 'one-shot answer' }] }],
        onExhausted: 'emptyStop',
      },
      prompt: 'say it once',
    }),
  );

  // 不写任何 stdin 命令、不关 stdin:agent_end 后自动 shutdown 退出
  const end = await proc.waitForEvent((e) => e.type === 'agent_end', 'agent_end');
  expect(end['reason']).toBe('completed');
  expect(await proc.waitForExit()).toBe(0);

  // -p 注入的 prompt 走完整事件流(protocol 首行 → run 骨架 → agent_end)
  expect(proc.events[0]?.type).toBe('protocol');
  assertSubsequence(typeSeq(proc.events), [
    'protocol',
    'agent_start',
    'turn_start',
    'message_start(user)',
    'message_start(assistant)',
    'message_end(assistant)',
    'turn_end',
    'agent_end',
  ]);
  const user = proc.events.find((e) => e.type === 'message_start' && msgRole(e) === 'user');
  expect(msgText(user)).toBe('say it once');
  expect(proc.parseErrors).toEqual([]); // 管道纪律不因 -p 特例松动
}, T);

test('--json -p: project-rule warning only uses stderr and never corrupts stdout NDJSON', async () => {
  const proc = track(
    startCoda({
      files: { 'AGENTS.md': 'x'.repeat(32 * 1024 + 1) },
      script: {
        turns: [{ events: [{ kind: 'text', text: 'warning stayed out of stdout' }] }],
        onExhausted: 'emptyStop',
      },
      prompt: 'trigger project-rule loading',
    }),
  );

  expect(await proc.waitForExit()).toBe(0);
  expect(proc.stderr()).toContain('[coda] warning: project rules');
  expect(proc.stderr()).toContain('exceeds per-file limit');
  expect(proc.parseErrors).toEqual([]);
}, T);

test('完整旧式非交互配置不读取损坏的 provider registry', async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'coda-e2e-legacy-'));
  const registryDir = path.join(cwd, '.home', '.coda');
  mkdirSync(registryDir, { recursive: true });
  writeFileSync(path.join(registryDir, 'providers.json'), '{broken', 'utf8');
  const proc = track(
    startCoda({
      cwd,
      script: {
        turns: [{ events: [{ kind: 'text', text: 'legacy still works' }] }],
        onExhausted: 'emptyStop',
      },
      prompt: 'use explicit faux config',
    }),
  );

  expect(await proc.waitForExit()).toBe(0);
  expect(proc.stderr()).not.toContain('provider 配置文件损坏');
  expect(proc.parseErrors).toEqual([]);
}, T);

test('--json -p: agent_end reason error → exit 1 (script-observable)', async () => {
  const proc = track(
    startCoda({
      script: {
        turns: [{ error: { message: 'provider blew up' } }],
        onExhausted: 'emptyStop',
      },
      prompt: 'doomed',
    }),
  );

  const end = await proc.waitForEvent((e) => e.type === 'agent_end', 'agent_end');
  expect(end['reason']).toBe('error');
  expect(await proc.waitForExit()).toBe(1);
  expect(proc.parseErrors).toEqual([]);
}, T);

test('-p (human-readable): completed → exit 0, error turn → exit 1', async () => {
  const ok = track(
    startCoda({
      script: { turns: [{ events: [{ kind: 'text', text: 'fine' }] }], onExhausted: 'emptyStop' },
      prompt: 'all good',
      json: false,
    }),
  );
  expect(await ok.waitForExit()).toBe(0);

  const bad = track(
    startCoda({
      script: { turns: [{ error: { message: 'provider blew up' } }], onExhausted: 'emptyStop' },
      prompt: 'doomed',
      json: false,
    }),
  );
  expect(await bad.waitForExit()).toBe(1);
}, T);

test('--json -p: retrying agent_end is intermediate; exits after recovered final agent_end', async () => {
  const proc = track(
    startCoda({
      script: {
        turns: [
          {
            error: {
              message: 'temporary outage',
              details: { kind: 'http', status: 503, retryable: true, retryAfterMs: 0 },
            },
          },
          { events: [{ kind: 'text', text: 'recovered after retry' }] },
        ],
        onExhausted: 'emptyStop',
      },
      prompt: 'retry once',
    }),
  );

  expect(await proc.waitForExit()).toBe(0);
  const ends = proc.events.filter((e) => e.type === 'agent_end');
  expect(ends).toHaveLength(2);
  expect(ends[0]).toMatchObject({ reason: 'error', willRetry: true });
  expect(ends[1]?.['reason']).toBe('completed');
  expect(ends[1]?.['willRetry']).toBeUndefined();
  const recovered = proc.events.find(
    (e) => e.type === 'message_end' && msgRole(e) === 'assistant' && msgText(e) === 'recovered after retry',
  );
  expect(recovered).toBeDefined();
  expect(proc.parseErrors).toEqual([]);
}, T);

test('-p (human-readable): prompt return does not close the scheduled retry', async () => {
  const proc = track(
    startCoda({
      script: {
        turns: [
          {
            error: {
              message: 'temporary outage',
              details: { kind: 'http', status: 503, retryable: true, retryAfterMs: 0 },
            },
          },
          { events: [{ kind: 'text', text: 'plain output recovered' }] },
        ],
        onExhausted: 'emptyStop',
      },
      prompt: 'retry once',
      json: false,
    }),
  );

  expect(await proc.waitForExit()).toBe(0);
  expect(proc.lines.join('\n')).toContain('plain output recovered');
}, T);

test('empty non-TTY stdin without -p: usage hint on stderr, exit 2 (no REPL hang)', async () => {
  const proc = track(
    startCoda({
      script: { turns: [], onExhausted: 'emptyStop' },
      json: false,
    }),
  );
  proc.endStdin(); // coda </dev/null 等价:立即 EOF、零字节

  expect(await proc.waitForExit()).toBe(2);
  expect(proc.stderr()).toContain('empty stdin');
  expect(proc.lines).toEqual([]); // 错误只走 stderr,stdout 零输出
}, T);
