// bash 工具:每次 spawn 新进程执行 shell 命令(工具 Executor 语义见 docs/07-tools.md)。
// 关键点:detached 进程组 + killProcessTree(只杀直接子进程会漏掉孙进程);
// stdout+stderr 合并进滚动窗口(约 2× MAX_OUTPUT_BYTES,防长命令吃内存);
// 总量首次越过 1× 上限时全文落盘并此后持续追加(落盘文件保证全量);
// 结果尾部截断(clipTail——命令错误几乎总在末尾),details 打 truncated 标记
// 跳过框架 post-hook，避免二次截断。

import type { FileSink } from 'bun';
import { z } from 'zod';
import {
  MAX_OUTPUT_BYTES,
  clipTail,
  killProcessTree,
  resolveToolWorkdir,
  safeBasename,
  spillToFile,
  truncationDir,
} from '../shared/index.js';
import type { ToolContext, ToolExecutionInput, ToolOutput } from './types.js';

const DEFAULT_TIMEOUT_MS = 120_000;
/** 滚动窗口容量:约 2× 输出上限。结果只保尾部 1×,留 2× 保证截断有余量。 */
const WINDOW_BYTES = 2 * MAX_OUTPUT_BYTES;
/** onUpdate 节流间隔:每 100ms 推送累计输出快照。 */
const UPDATE_THROTTLE_MS = 100;
/** 'exit' 后收尾输出的 drain 窗口:流 'end' 先到则提前结束(见 execute 内注释)。 */
const DRAIN_WINDOW_MS = 300;

function withoutShellPathOverrides(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const clean = { ...env };
  delete clean.BASH_ENV;
  delete clean.CDPATH;
  return clean;
}

interface StreamPump {
  done: Promise<void>;
  cancel(): Promise<void>;
}

/** Web ReadableStream 增量消费器;cancel 用于后台孤儿持有管道写端时主动收尾。 */
function pumpStream(
  stream: ReadableStream<Uint8Array>,
  onChunk: (chunk: Uint8Array) => void | Promise<void>,
  onEnd?: () => void | Promise<void>,
): StreamPump {
  const reader = stream.getReader();
  let finished = false;
  const done = (async (): Promise<void> => {
    try {
      for (;;) {
        const { done: ended, value } = await reader.read();
        if (ended) break;
        await onChunk(value);
      }
      await onEnd?.();
    } finally {
      finished = true;
      reader.releaseLock();
    }
  })();
  return {
    done,
    async cancel(): Promise<void> {
      if (!finished) {
        try {
          await reader.cancel();
        } catch {
          // 已关闭/并发关闭:无需再处理
        }
      }
      await done.catch(() => undefined);
    },
  };
}

/** 等所有流读完,或 capMs 到期(后台孤儿持有管道写端时流永远不 end)。 */
async function drainPumps(pumps: StreamPump[], capMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, capMs);
  });
  try {
    await Promise.race([Promise.all(pumps.map((pump) => pump.done)), cap]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array();
  return new Uint8Array(Bun.concatArrayBuffers(chunks));
}

async function waitForSink(result: number | Promise<number>): Promise<void> {
  await result;
}

export const bashParameters = z.object({
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

export type BashArgs = z.infer<typeof bashParameters>;

export interface BashDetails {
  truncated: boolean;
  spilledPath?: string | undefined; // 全文落盘位置(截断且落盘成功时存在)
}

export const BASH_DESCRIPTION =
  'Execute a bash command and return its combined stdout/stderr output. ' +
  "The output always ends with 'exit code N'. " +
  "Use the workdir parameter to run in a different directory instead of 'cd'. " +
  'Long output keeps the tail (2000 lines / 48KB); the full output is saved to a file whose path is included in the result.';

export const BASH_PROMPT_SNIPPET =
  'bash: AVOID `cd <dir> && cmd` — pass the workdir parameter instead. ' +
  'Output is stdout and stderr combined; on long output only the tail is shown and the full output is saved to a file.';

export async function executeBash(
  call: ToolExecutionInput<BashArgs>,
  ctx: ToolContext,
): Promise<ToolOutput<BashDetails>> {
    const { command, workdir } = call.args;
    const timeoutMs = call.args.timeout ?? DEFAULT_TIMEOUT_MS;
    const cwd = resolveToolWorkdir(ctx.cwd, workdir);

    // workdir 预检:spawn 对不存在 cwd 的报错(ENOENT)对模型不可读,前置成明确文案
    if (workdir !== undefined) {
      let stat;
      try {
        stat = await Bun.file(cwd).stat();
      } catch {
        throw new Error(`Working directory does not exist: ${workdir}`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`Working directory is not a directory: ${workdir}`);
      }
    }
    if (ctx.signal.aborted) throw new Error('User aborted the command');

    // detached: true → 子进程成为进程组组长(pgid = pid),killProcessTree 按 -pid 覆盖全组
    let resolveExit!: (value: { code: number | null; signal: number | null }) => void;
    let rejectExit!: (reason: unknown) => void;
    const exited = new Promise<{ code: number | null; signal: number | null }>((resolve, reject) => {
      resolveExit = resolve;
      rejectExit = reject;
    });
    const child = (() => {
      try {
        return Bun.spawn({
          cmd: ['bash', '-c', command],
          detached: true,
          cwd,
          // 非交互 bash 会执行继承的 BASH_ENV，cd 还会受 CDPATH 改写；清掉二者，
          // 让静态路径分析与真正执行使用同一套可观察语义。
          env: withoutShellPathOverrides(Bun.env),
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
          onExit(_proc, code, signal, err) {
            if (err !== undefined) rejectExit(err);
            else resolveExit({ code, signal });
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to spawn bash: ${message}`);
      }
    })();

    // ---- 输出收集:滚动窗口 + 越限落盘 ----
    const windowChunks: Uint8Array[] = [];
    let windowBytes = 0;
    let totalBytes = 0;
    let windowTrimmed = false; // 窗口丢过头部 chunk ⇒ 内存中已非全量
    let spilledPath: string | undefined;
    let spillWriter: FileSink | undefined;
    let spillBroken = false; // 落盘失败(磁盘满/权限):降级为不再尝试,不炸工具结果
    const spillDir = truncationDir('bash');
    const spillBase = `${safeBasename(`${Date.now()}-${call.id}`)}.txt`;

    // 落盘全程走 FileSink 写原始字节(spillToFile 只负责建目录/建文件),
    // 避免 chunk 边界劈开多字节字符后经 string 转码引入替换符。
    const abandonSpill = async (): Promise<void> => {
      const writer = spillWriter;
      spillWriter = undefined;
      spilledPath = undefined; // 文件已不全量,不再对外宣告
      spillBroken = true;
      if (writer !== undefined) {
        try {
          await waitForSink(writer.end());
        } catch {
          // 落盘本就已失败,关闭失败无需覆盖工具结果
        }
      }
    };
    const startSpill = async (): Promise<void> => {
      const p = spillToFile(spillDir, spillBase, '');
      if (p === undefined) {
        spillBroken = true;
        return;
      }
      try {
        const writer = Bun.file(p).writer();
        spillWriter = writer;
        await waitForSink(writer.write(concatChunks(windowChunks))); // 此刻窗口未修剪,仍是全量
        spilledPath = p;
      } catch {
        await abandonSpill();
      }
    };
    const finishSpill = async (): Promise<void> => {
      const writer = spillWriter;
      spillWriter = undefined;
      if (writer === undefined) return;
      try {
        await waitForSink(writer.end());
      } catch {
        spilledPath = undefined;
        spillBroken = true;
      }
    };

    // ---- onUpdate 100ms 节流(累计快照;lastPushEnd 在回调返回后记账,
    // 保证外部观测到的相邻间隔 ≥ UPDATE_THROTTLE_MS)----
    let pendingUpdate = '';
    let cumulativeUpdate = '';
    let lastPushEnd = 0; // 0 = 尚未推过 → 首条立即推
    let updateTimer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const pushUpdate = (): void => {
      cumulativeUpdate += pendingUpdate;
      pendingUpdate = '';
      ctx.onUpdate?.({ output: cumulativeUpdate });
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

    const appendDecoded = (text: string): void => {
      if (ctx.onUpdate === undefined || text === '') return;
      pendingUpdate += text;
      maybePushUpdate();
    };
    const onData = async (chunk: Uint8Array, decoder: TextDecoder): Promise<void> => {
      totalBytes += chunk.byteLength;
      windowChunks.push(chunk);
      windowBytes += chunk.byteLength;

      if (spillWriter !== undefined) {
        try {
          await waitForSink(spillWriter.write(chunk));
        } catch {
          await abandonSpill();
        }
      } else if (!spillBroken && totalBytes > MAX_OUTPUT_BYTES) {
        await startSpill(); // 首次越过 1× 上限:整窗(=全量)落盘,含当前 chunk
      }

      // 修剪只可能发生在 totalBytes > 2× 上限之后,彼时必已落盘(或落盘已知失败)
      while (windowBytes > WINDOW_BYTES && windowChunks.length > 1) {
        const head = windowChunks.shift() as Uint8Array;
        windowBytes -= head.byteLength;
        windowTrimmed = true;
      }

      appendDecoded(decoder.decode(chunk, { stream: true }));
    };

    // 两条 Web Stream 共用一条处理链,确保滚动窗口及 FileSink 的写入顺序稳定且无并发竞争。
    let outputChain = Promise.resolve();
    const enqueueData = (chunk: Uint8Array, decoder: TextDecoder): Promise<void> => {
      outputChain = outputChain.then(() => onData(chunk, decoder));
      return outputChain;
    };
    const enqueueDecoderEnd = (decoder: TextDecoder): Promise<void> => {
      outputChain = outputChain.then(() => appendDecoded(decoder.decode()));
      return outputChain;
    };
    const stdoutDecoder = new TextDecoder();
    const stderrDecoder = new TextDecoder();
    const pumps = [
      pumpStream(
        child.stdout,
        (chunk) => enqueueData(chunk, stdoutDecoder),
        () => enqueueDecoderEnd(stdoutDecoder),
      ),
      pumpStream(
        child.stderr,
        (chunk) => enqueueData(chunk, stderrDecoder),
        () => enqueueDecoderEnd(stderrDecoder),
      ),
    ];

    // ---- timeout / abort:killProcessTree(SIGTERM → 3s → SIGKILL 全组)----
    let timedOut = false;
    let aborted = false;
    const killTree = (): void => {
      void killProcessTree(child.pid);
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
    if (ctx.signal.aborted) onAbort();

    let exit: { code: number | null; signal: number | null };
    try {
      // 以 'exit' 事件为准判定命令结束——不能等 'close':`cmd &` 起的后台子进程
      // 继承 stdio 管道写端,'close' 会被拖到孤儿退出为止,exit 0 的命令被误判成超时
      exit = await exited.catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to spawn bash: ${message}`);
      });
      // 命令已结束:先撤 timeout 计时器,防 drain 窗口内误触发 timedOut
      clearTimeout(killer);
      // exit 后 stdio 可能仍有未读数据,给一个短暂 drain 窗口收尾(流 'end' 先到为准)
      await drainPumps(pumps, DRAIN_WINDOW_MS);
    } finally {
      closed = true;
      clearTimeout(killer);
      if (updateTimer !== undefined) clearTimeout(updateTimer);
      ctx.signal.removeEventListener('abort', onAbort);
      // 管道可能仍被后台孤儿持有,显式 cancel,不再挂着读端
      await Promise.all(pumps.map((pump) => pump.cancel()));
      await outputChain.catch(() => undefined);
      await finishSpill();
    }
    // 结果决议前清理进程组残留:bash 不复用持久 shell 或后台 job。
    // 此刻组里仍存活的只会是泄漏的后台孤儿。组已消失时是 ESRCH 快路径。
    await killProcessTree(child.pid);
    // 收尾补推:门槛已满足(或从未推过)才推,不破坏节流不变量
    if (pendingUpdate !== '' && (lastPushEnd === 0 || Date.now() - lastPushEnd >= UPDATE_THROTTLE_MS)) {
      pushUpdate();
    }

    // ---- 结果文本:尾部截断 + 截断头注 + 退出状态 ----
    const windowText = new TextDecoder().decode(concatChunks(windowChunks));
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
      // Runtime envelopes are strict JSON: an optional field must be absent rather than present
      // with `undefined`. Keep the JSON projection stable while making the in-memory
      // ToolResult safe to commit as a canonical tool_execution_end event.
      details: { truncated, ...(spilledPath !== undefined && { spilledPath }) },
    };
}
