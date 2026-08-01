// bash 工具测试(docs/10-testing.md §6.2 矩阵):真实子进程 + 真实 tmpdir。
// 计时类断言均给宽松上下界并标注「宽松时序用例」——L3 是唯一允许真实时间流逝的层。

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { FileTracker } from '../shared/index.js';
import { bashTool } from './bash.js';
import type { BashDetails } from './bash.js';
import type { ToolContext } from './types.js';

let dir: string;
const spilledFiles: string[] = []; // 截断落盘产物,用例结束后清理(位于 ~/.coda/truncated/bash)

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'coda-bash-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const f of spilledFiles.splice(0)) {
    try {
      unlinkSync(f);
    } catch {
      /* 已被删除或未创建 */
    }
  }
});

function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    cwd: dir,
    signal: new AbortController().signal,
    fileTracker: new FileTracker(),
    ...overrides,
  };
}

function run(
  args: { command: string; timeout?: number; workdir?: string },
  ctx: ToolContext = makeCtx(),
) {
  return bashTool.execute({ id: 'call_bash_1', args }, ctx);
}

/** 断言 promise 拒绝并返回错误对象(bash 的失败语义是 throw,loop 层转 isError)。 */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected promise to reject');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('bash:声明与 schema', () => {
  it('executionMode sequential、kind execute,参数面与规格一致', () => {
    expect(bashTool.name).toBe('bash');
    expect(bashTool.executionMode).toBe('sequential');
    expect(bashTool.kind).toBe('execute');
    const schema = z.toJSONSchema(bashTool.parameters) as {
      properties: Record<string, { maximum?: number; minimum?: number }>;
      required?: string[];
    };
    expect(Object.keys(schema.properties).sort()).toEqual([
      'command',
      'description',
      'timeout',
      'workdir',
    ]);
    expect(schema.required).toEqual(['command']);
    expect(schema.properties['timeout']?.minimum).toBe(1);
    expect(schema.properties['timeout']?.maximum).toBe(600_000);
  });
});

describe('bash:基本执行', () => {
  it('echo:输出 + 末尾 exit code 0,details 无截断', async () => {
    const out = await run({ command: 'echo hello' });
    expect(out.content).toEqual([{ type: 'text', text: 'hello\nexit code 0' }]);
    const details = out.details as BashDetails;
    expect(details.truncated).toBe(false);
    expect(details.spilledPath).toBeUndefined();
    expect('spilledPath' in details).toBe(false);
  });

  it('无输出命令:结果只有 exit code 行', async () => {
    const out = await run({ command: 'true' });
    expect(out.content).toEqual([{ type: 'text', text: 'exit code 0' }]);
  });

  it('stderr 并入输出', async () => {
    const out = await run({ command: 'echo out; echo err >&2' });
    const text = (out.content[0] as { text: string }).text;
    expect(text).toContain('out');
    expect(text).toContain('err');
    expect(text.endsWith('exit code 0')).toBe(true);
  });
});

describe('bash:exit code(§6.2 exit code 行)', () => {
  it('非零退出 → throw,消息含 exit code 与 stderr(完整结果文本)', async () => {
    const err = await rejection(run({ command: 'echo some-stdout; echo the-failure >&2; exit 3' }));
    expect(err.message).toContain('exit code 3');
    expect(err.message).toContain('the-failure'); // 模型需要 stderr 判断怎么修
    expect(err.message).toContain('some-stdout');
  });
});

describe('bash:workdir(§6.2 workdir 行)', () => {
  it('指定 workdir 后 pwd 生效', async () => {
    const sub = path.join(dir, 'sub');
    mkdirSync(sub);
    const out = await run({ command: 'pwd', workdir: sub });
    const text = (out.content[0] as { text: string }).text;
    // bash 会把 PWD 归一化为物理路径(macOS 的 /var → /private/var),对齐 realpath
    expect(text.split('\n')[0]).toBe(realpathSync(sub));
  });

  it('相对 workdir 始终相对 ctx.cwd，而不是启动进程 cwd', async () => {
    const sub = path.join(dir, 'sub');
    mkdirSync(sub);
    const out = await run({ command: 'pwd', workdir: 'sub' });
    const text = (out.content[0] as { text: string }).text;
    expect(text.split('\n')[0]).toBe(realpathSync(sub));
  });

  it('省略 workdir → ctx.cwd', async () => {
    const out = await run({ command: 'pwd' });
    const text = (out.content[0] as { text: string }).text;
    expect(text.split('\n')[0]).toBe(realpathSync(dir));
  });

  it('workdir 不存在 → throw', async () => {
    const missing = path.join(dir, 'no-such-dir');
    const err = await rejection(run({ command: 'echo hi', workdir: missing }));
    expect(err.message).toContain('Working directory does not exist');
    expect(err.message).toContain(missing);
  });
});

describe('bash:timeout 与 kill tree(宽松时序用例)', () => {
  it(
    'timeout:sleep 5 + timeout 1000 → throw 超时文案,耗时 0.9s–4s',
    async () => {
      const start = Date.now();
      const err = await rejection(run({ command: 'sleep 5', timeout: 1000 }));
      const elapsed = Date.now() - start;
      expect(err.message).toContain(
        'Command timed out after 1000 ms and was killed. ' +
          'Retry with a larger timeout value if the command legitimately needs more time.',
      );
      // 宽松时序:下界防 timeout 未生效(过早返回),上界防 kill 失败等满 sleep
      expect(elapsed).toBeGreaterThanOrEqual(900);
      expect(elapsed).toBeLessThan(4000);
    },
    15_000,
  );

  it(
    'kill tree:孙进程(sleep 30 & sleep 30)超时后进程组无存活',
    async () => {
      // $$ 是 bash -c 的自身 pid = detached 进程组组长 pgid,经输出带出给测试
      const err = await rejection(
        run({ command: 'echo "PGID=$$"; sleep 30 & sleep 30', timeout: 1000 }),
      );
      const m = /PGID=(\d+)/.exec(err.message);
      expect(m).not.toBeNull();
      const pgid = Number((m as RegExpExecArray)[1]);

      // 宽松时序:SIGTERM 后子孙进程死亡与 init 收尸存在毫秒级窗口,轮询至 ESRCH
      let dead = false;
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        try {
          process.kill(-pgid, 0);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ESRCH') dead = true;
        }
        if (dead) break;
        await sleep(50);
      }
      expect(dead).toBe(true);
    },
    15_000,
  );

  it(
    '后台孤儿:sleep 30 & echo started → 以 exit 判定快速返回 exit 0,进程组被清理',
    async () => {
      const start = Date.now();
      // 回归靶:等 'close' 的实现会被孤儿持有的管道拖到 timeout(10s)误判超时 throw
      const out = await run({ command: 'echo "PGID=$$"; sleep 30 & echo started', timeout: 10_000 });
      const elapsed = Date.now() - start;
      const text = (out.content[0] as { text: string }).text;

      // 宽松时序:exit 即时 + drain 窗口(百毫秒级)+ 孤儿清理,远小于 timeout/sleep
      expect(elapsed).toBeLessThan(5000);
      expect(text).toContain('started');
      expect(text.endsWith('exit code 0')).toBe(true);

      // 返回后进程组应无存活:后台孤儿(sleep 30)已被 killProcessTree 清掉
      const m = /PGID=(\d+)/.exec(text);
      expect(m).not.toBeNull();
      const pgid = Number((m as RegExpExecArray)[1]);
      // 宽松时序:信号送达与 init 收尸存在毫秒级窗口,轮询至 ESRCH
      let dead = false;
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        try {
          process.kill(-pgid, 0);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ESRCH') dead = true;
        }
        if (dead) break;
        await sleep(50);
      }
      expect(dead).toBe(true);
    },
    15_000,
  );
});

describe('bash:abort(宽松时序用例)', () => {
  it(
    '执行中 abort → 进程组被杀,消息保留已有输出并注明中断',
    async () => {
      const controller = new AbortController();
      const ctx = makeCtx({ signal: controller.signal });
      const start = Date.now();
      setTimeout(() => controller.abort(), 200); // 计时类用例:200ms 后触发中断
      const err = await rejection(run({ command: 'echo started; sleep 30', timeout: 60_000 }, ctx));
      const elapsed = Date.now() - start;
      expect(err.message).toContain('started'); // 中断前的输出保留在结果里
      expect(err.message.endsWith('User aborted the command')).toBe(true);
      expect(elapsed).toBeLessThan(5000); // 远小于 sleep 30:确实被杀而非跑完
    },
    15_000,
  );

  it('signal 已 aborted → 立即 throw,不 spawn', async () => {
    const controller = new AbortController();
    controller.abort();
    const ctx = makeCtx({ signal: controller.signal });
    const err = await rejection(run({ command: 'sleep 30' }, ctx));
    expect(err.message).toBe('User aborted the command');
  });
});

describe('bash:尾部截断与落盘(§6.2 tail 截断行)', () => {
  it(
    '5000 行长输出:保尾 2000 行/48KB,落盘文件存在且内容全量(字节精确)',
    async () => {
      const pad = '.'.repeat(20);
      const out = await run({
        // 每行约 30 字节 × 5000 行 ≈ 150KB:同时越过字节上限(流式落盘)与滚动窗口(修剪)
        command: `i=1; while [ $i -le 5000 ]; do echo "line-$i-${pad}"; i=$((i+1)); done`,
      });
      const text = (out.content[0] as { text: string }).text;
      const details = out.details as BashDetails;

      // 截断头注 + 落盘路径 + 末尾 exit code
      expect(text.startsWith('...output truncated...\nFull output saved to: ')).toBe(true);
      expect(text.endsWith('exit code 0')).toBe(true);
      expect(details.truncated).toBe(true);
      expect(details.spilledPath).toBeDefined();
      const spilled = details.spilledPath as string;
      spilledFiles.push(spilled);
      expect(text).toContain(`Full output saved to: ${spilled}`);

      // 保尾不保头:末行在、首行不在,正文行数 ≤ 2000
      expect(text).toContain(`line-5000-${pad}`);
      expect(text).not.toContain(`line-1-${pad}`);
      const bodyLines = text.split('\n').length - 3; // 头注 2 行 + exit code 1 行
      expect(bodyLines).toBeLessThanOrEqual(2000);

      // 落盘文件内容全量且字节精确
      const expected =
        Array.from({ length: 5000 }, (_, i) => `line-${i + 1}-${pad}`).join('\n') + '\n';
      expect(readFileSync(spilled, 'utf8')).toBe(expected);
    },
    15_000,
  );

  it(
    '仅行数越限(3000 短行 < 48KB):同样截断并落盘全量',
    async () => {
      const out = await run({
        command: 'i=1; while [ $i -le 3000 ]; do echo "x$i"; i=$((i+1)); done',
      });
      const text = (out.content[0] as { text: string }).text;
      const details = out.details as BashDetails;

      expect(details.truncated).toBe(true);
      expect(text).toContain('...output truncated...');
      expect(details.spilledPath).toBeDefined();
      const spilled = details.spilledPath as string;
      spilledFiles.push(spilled);

      // 保尾:x1001..x3000 共 2000 行;x1000 及更早被截掉
      expect(text).toContain('\nx1001\n');
      expect(text).not.toContain('\nx1000\n');
      expect(text.endsWith('exit code 0')).toBe(true);

      const expected = Array.from({ length: 3000 }, (_, i) => `x${i + 1}`).join('\n') + '\n';
      expect(readFileSync(spilled, 'utf8')).toBe(expected);
    },
    15_000,
  );

  it(
    '仅字节越限(100 行 × 约 1KB ≈ 100KB,远少于 2000 行):正文 ≤ 48KB,落盘全量',
    async () => {
      const pad = '0'.repeat(1000); // printf '%01000d' 0 → 1000 个零
      const out = await run({
        command: `pad=$(printf '%01000d' 0); i=1; while [ $i -le 100 ]; do echo "line-$i-$pad"; i=$((i+1)); done`,
      });
      const text = (out.content[0] as { text: string }).text;
      const details = out.details as BashDetails;

      expect(details.truncated).toBe(true);
      expect(text.startsWith('...output truncated...\nFull output saved to: ')).toBe(true);
      expect(text.endsWith('exit code 0')).toBe(true);
      expect(details.spilledPath).toBeDefined();
      const spilled = details.spilledPath as string;
      spilledFiles.push(spilled);
      expect(text).toContain(`Full output saved to: ${spilled}`);

      // 正文 = 剥掉 2 行截断头注与 1 行 exit code 尾:字节维度受 48KB 上限约束
      const lines = text.split('\n');
      const body = lines.slice(2, -1).join('\n');
      expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(48 * 1024);
      // 保尾不保头
      expect(body).toContain(`line-100-${pad}`);
      expect(body).not.toContain(`line-1-${pad}`);

      // 落盘文件内容全量且字节精确
      const expected =
        Array.from({ length: 100 }, (_, i) => `line-${i + 1}-${pad}`).join('\n') + '\n';
      expect(readFileSync(spilled, 'utf8')).toBe(expected);
    },
    15_000,
  );
});

describe('bash:onUpdate 节流(宽松时序用例)', () => {
  it(
    '持续输出:相邻 update 间隔 ≥ 100ms(允许首条例外),每条都是累计快照',
    async () => {
      const stamps: number[] = [];
      const snapshots: string[] = [];
      const ctx = makeCtx({
        onUpdate: (u) => {
          stamps.push(Date.now());
          snapshots.push(u.output ?? '');
        },
      });
      const out = await run(
        { command: 'i=0; while [ $i -lt 25 ]; do echo "tick-$i"; sleep 0.03; i=$((i+1)); done' },
        ctx,
      );

      expect(stamps.length).toBeGreaterThanOrEqual(3);
      // 首条立即推(例外),其后每对相邻间隔 ≥ 100ms
      for (let i = 2; i < stamps.length; i++) {
        expect((stamps[i] as number) - (stamps[i - 1] as number)).toBeGreaterThanOrEqual(100);
      }
      // 每个 update 都替换前一个快照，内容单调扩展而不会要求 UI 拼接。
      expect(snapshots[0]?.startsWith('tick-0\n')).toBe(true);
      for (let i = 1; i < snapshots.length; i++) {
        expect(snapshots[i]?.startsWith(snapshots[i - 1] ?? '')).toBe(true);
      }
      expect(snapshots.at(-1)).toContain('tick-5\n');
      // 最终结果仍是全量输出
      const text = (out.content[0] as { text: string }).text;
      expect(text).toContain('tick-24');
      expect(text.endsWith('exit code 0')).toBe(true);
    },
    15_000,
  );
});
