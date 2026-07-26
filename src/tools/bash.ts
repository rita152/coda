// bash 工具:每次 spawn 新进程执行 shell 命令(规格见 docs/07-tools.md §2.5)。
// 关键点:detached 进程组 + killProcessTree(只杀直接子进程会漏掉孙进程);
// stdout+stderr 合并进滚动窗口(约 2× MAX_OUTPUT_BYTES,防长命令吃内存);
// 总量首次越过 1× 上限时全文落盘并此后持续追加(落盘文件保证全量);
// 结果尾部截断(clipTail——命令错误几乎总在末尾),details 打 truncated 标记
// 跳过框架 post-hook(docs/07 §1.6)。

import { spawn } from 'node:child_process';
import { appendFileSync, statSync } from 'node:fs';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import {
  MAX_OUTPUT_BYTES,
  clipTail,
  killProcessTree,
  safeBasename,
  spillToFile,
  truncationDir,
} from '../shared/index.js';
import type { ToolContext, ToolDefinition, ToolOutput } from './types.js';

const DEFAULT_TIMEOUT_MS = 120_000;
/** 滚动窗口容量:约 2× 输出上限。结果只保尾部 1×,留 2× 保证截断有余量。 */
const WINDOW_BYTES = 2 * MAX_OUTPUT_BYTES;
/** onUpdate 节流间隔(docs/07 §2.5:100ms 推送增量输出)。 */
const UPDATE_THROTTLE_MS = 100;
/** 'exit' 后收尾输出的 drain 窗口:流 'end' 先到则提前结束(见 execute 内注释)。 */
const DRAIN_WINDOW_MS = 300;

function streamDone(stream: Readable | null): Promise<void> {
  if (stream === null || stream.readableEnded || stream.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    stream.once('end', resolve);
    stream.once('close', resolve);
  });
}

/** 等所有流 'end'/'close',或 capMs 到期(后台孤儿持有管道写端时流永远不 end)。 */
async function drainStreams(streams: Array<Readable | null>, capMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const cap = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, capMs);
  });
  try {
    await Promise.race([Promise.all(streams.map(streamDone)), cap]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const BashParams = z.object({
  command: z.string().describe('The command to execute'),
  timeout: z
    .number()
    .int()
    .min(1)
    .max(600_000)
    .optional()
    .describe('Timeout in milliseconds (default 120000)'),
  workdir: z
    .string()
    .optional()
    .describe("Working directory for this command. Use this instead of 'cd'"),
  description: z
    .string()
    .optional()
    .describe('5-10 word active-voice summary of what this command does'),
});

type BashArgs = z.infer<typeof BashParams>;

export interface BashDetails {
  truncated: boolean;
  spilledPath?: string | undefined; // 全文落盘位置(截断且落盘成功时存在)
}

export const bashTool: ToolDefinition<BashArgs, BashDetails> = {
  name: 'bash',
  description:
    'Execute a bash command and return its combined stdout/stderr output. ' +
    "The output always ends with 'exit code N'. " +
    "Use the workdir parameter to run in a different directory instead of 'cd'. " +
    'Long output keeps the tail (2000 lines / 48KB); the full output is saved to a file whose path is included in the result.',
  parameters: BashParams,
  executionMode: 'sequential',
  kind: 'execute',
  promptSnippet:
    'bash: AVOID `cd <dir> && cmd` — pass the workdir parameter instead. ' +
    'Output is stdout and stderr combined; on long output only the tail is shown and the full output is saved to a file.',

  async execute(call, ctx: ToolContext): Promise<ToolOutput<BashDetails>> {
    const { command, workdir } = call.args;
    const timeoutMs = call.args.timeout ?? DEFAULT_TIMEOUT_MS;
    const cwd = workdir ?? ctx.cwd;

    // workdir 预检:spawn 对不存在 cwd 的报错(ENOENT)对模型不可读,前置成明确文案
    if (workdir !== undefined) {
      let stat;
      try {
        stat = statSync(cwd);
      } catch {
        throw new Error(`Working directory does not exist: ${workdir}`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`Working directory is not a directory: ${workdir}`);
      }
    }
    if (ctx.signal.aborted) throw new Error('User aborted the command');

    // detached: true → 子进程成为进程组组长(pgid = pid),killProcessTree 按 -pid 覆盖全组
    const child = spawn('bash', ['-c', command], {
      detached: true,
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // ---- 输出收集:滚动窗口 + 越限落盘(docs/07 §2.5)----
    const windowChunks: Buffer[] = [];
    let windowBytes = 0;
    let totalBytes = 0;
    let windowTrimmed = false; // 窗口丢过头部 chunk ⇒ 内存中已非全量
    let spilledPath: string | undefined;
    let spillBroken = false; // 落盘失败(磁盘满/权限):降级为不再尝试,不炸工具结果
    const spillDir = truncationDir('bash');
    const spillBase = `${safeBasename(`${Date.now()}-${call.id}`)}.txt`;

    // 落盘全程走 Buffer 追加(spillToFile 只负责建目录/建文件),
    // 避免 chunk 边界劈开多字节字符后经 string 转码引入替换符。
    const startSpill = (): void => {
      const p = spillToFile(spillDir, spillBase, '');
      if (p === undefined) {
        spillBroken = true;
        return;
      }
      try {
        appendFileSync(p, Buffer.concat(windowChunks)); // 此刻窗口未修剪,仍是全量
        spilledPath = p;
      } catch {
        spillBroken = true;
      }
    };

    // ---- onUpdate 100ms 节流(增量推送;lastPushEnd 在回调返回后记账,
    // 保证外部观测到的相邻间隔 ≥ UPDATE_THROTTLE_MS)----
    let pendingUpdate = '';
    let lastPushEnd = 0; // 0 = 尚未推过 → 首条立即推
    let updateTimer: NodeJS.Timeout | undefined;
    let closed = false;

    const pushUpdate = (): void => {
      const output = pendingUpdate;
      pendingUpdate = '';
      ctx.onUpdate?.({ output });
      lastPushEnd = Date.now();
    };
    const maybePushUpdate = (): void => {
      if (pendingUpdate === '') return;
      const elapsed = Date.now() - lastPushEnd;
      if (lastPushEnd === 0 || elapsed >= UPDATE_THROTTLE_MS) {
        pushUpdate();
        return;
      }
      if (closed || updateTimer !== undefined) return; // 收尾后不再排程;结果本身含全量输出
      updateTimer = setTimeout(() => {
        updateTimer = undefined;
        maybePushUpdate(); // 重查门槛,不满足则再排程
      }, UPDATE_THROTTLE_MS - elapsed + 1);
    };

    const onData = (chunk: Buffer, decoder: StringDecoder): void => {
      totalBytes += chunk.length;
      windowChunks.push(chunk);
      windowBytes += chunk.length;

      if (spilledPath !== undefined) {
        try {
          appendFileSync(spilledPath, chunk);
        } catch {
          spillBroken = true;
          spilledPath = undefined; // 文件已不全量,不再对外宣告
        }
      } else if (!spillBroken && totalBytes > MAX_OUTPUT_BYTES) {
        startSpill(); // 首次越过 1× 上限:整窗(=全量)落盘,含当前 chunk
      }

      // 修剪只可能发生在 totalBytes > 2× 上限之后,彼时必已落盘(或落盘已知失败)
      while (windowBytes > WINDOW_BYTES && windowChunks.length > 1) {
        const head = windowChunks.shift() as Buffer;
        windowBytes -= head.length;
        windowTrimmed = true;
      }

      if (ctx.onUpdate !== undefined) {
        pendingUpdate += decoder.write(chunk);
        maybePushUpdate();
      }
    };

    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    child.stdout?.on('data', (c: Buffer) => onData(c, stdoutDecoder));
    child.stderr?.on('data', (c: Buffer) => onData(c, stderrDecoder));

    // ---- timeout / abort:killProcessTree(SIGTERM → 3s → SIGKILL 全组)----
    let timedOut = false;
    let aborted = false;
    const killTree = (): void => {
      if (child.pid !== undefined) void killProcessTree(child.pid);
    };
    const killer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);
    const onAbort = (): void => {
      aborted = true;
      killTree();
    };
    ctx.signal.addEventListener('abort', onAbort, { once: true });

    let exit: { code: number | null; signal: NodeJS.Signals | null };
    try {
      // 以 'exit' 事件为准判定命令结束——不能等 'close':`cmd &` 起的后台子进程
      // 继承 stdio 管道写端,'close' 会被拖到孤儿退出为止,exit 0 的命令被误判成超时
      exit = await new Promise((resolve, reject) => {
        child.once('error', (err) => reject(new Error(`Failed to spawn bash: ${err.message}`)));
        child.once('exit', (code, signal) => resolve({ code, signal }));
      });
      // 命令已结束:先撤 timeout 计时器,防 drain 窗口内误触发 timedOut
      clearTimeout(killer);
      // exit 后 stdio 可能仍有未读数据,给一个短暂 drain 窗口收尾(流 'end' 先到为准)
      await drainStreams([child.stdout, child.stderr], DRAIN_WINDOW_MS);
    } finally {
      closed = true;
      clearTimeout(killer);
      if (updateTimer !== undefined) clearTimeout(updateTimer);
      ctx.signal.removeEventListener('abort', onAbort);
      // 管道可能仍被后台孤儿持有,显式销毁,不再挂着读端
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
    // 结果决议前清理进程组残留:bash v1 无持久 shell/后台 job 语义(docs/07 §2.5,
    // PTY 会话是 v2),此刻组里仍存活的只会是泄漏的后台孤儿。组已消失时是 ESRCH 快路径。
    if (child.pid !== undefined) await killProcessTree(child.pid);
    // 收尾补推:门槛已满足(或从未推过)才推,不破坏节流不变量
    if (pendingUpdate !== '' && (lastPushEnd === 0 || Date.now() - lastPushEnd >= UPDATE_THROTTLE_MS)) {
      pushUpdate();
    }

    // ---- 结果文本:尾部截断 + 截断头注 + 退出状态(docs/07 §2.5)----
    const windowText = Buffer.concat(windowChunks).toString('utf8');
    const clip = clipTail(windowText);
    // 行数截断但字节未越限(如 5000 行短输出):流式路径未触发落盘,此刻窗口仍全量,补落盘
    if (clip.truncated && spilledPath === undefined && !spillBroken && !windowTrimmed) {
      spilledPath = spillToFile(spillDir, spillBase, windowText);
    }
    const truncated = clip.truncated || windowTrimmed;

    const parts: string[] = [];
    if (truncated) {
      parts.push('...output truncated...');
      if (spilledPath !== undefined) parts.push(`Full output saved to: ${spilledPath}`);
    }
    // 命令输出几乎总带结尾换行;剥掉单个尾 \n,避免与状态行之间出现空行
    const body = clip.text.endsWith('\n') ? clip.text.slice(0, -1) : clip.text;
    if (body !== '') parts.push(body);

    if (aborted) {
      parts.push('User aborted the command');
      throw new Error(parts.join('\n'));
    }
    if (timedOut) {
      parts.push(
        `Command timed out after ${timeoutMs} ms and was killed. ` +
          'Retry with a larger timeout value if the command legitimately needs more time.',
      );
      throw new Error(parts.join('\n'));
    }
    if (exit.code === null) {
      // 非 timeout/abort 的信号死亡(外部 kill 等):同样是失败,给模型可读的说明
      parts.push(`Command was killed by signal ${exit.signal ?? 'unknown'}`);
      throw new Error(parts.join('\n'));
    }

    parts.push(`exit code ${exit.code}`);
    const text = parts.join('\n');
    // 非 0 退出 → throw(loop 层转 isError),消息=完整结果文本:模型需要 stderr 判断怎么修
    if (exit.code !== 0) throw new Error(text);

    return {
      content: [{ type: 'text', text }],
      details: { truncated, spilledPath },
    };
  },
};
