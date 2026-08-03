// grep 工具:调 ripgrep 二进制做内容搜索(规格见 docs/07-tools.md §2.4)。
// 要点:--json 流式解析 match 事件;match 数达 limit 即 kill rg(大仓库不搜完再截断);
// context 不用 rg 的 -C(会让 limit 数到 context 行),命中后自行读文件切片,limit 只数 match;
// exit 1 = 无匹配不是错误;exit ≥ 2 才 throw(附 stderr);ToolContext.signal 触发时 kill rg。

import path from 'node:path';
import { z } from 'zod';
import type { ToolContext, ToolExecutionInput, ToolOutput } from './types.js';
import { RG_MISSING_MESSAGE, resolveRgPath } from './rg.js';

const DEFAULT_LIMIT = 100;
const MAX_LINE_CHARS = 500;

/** limit 命中 kill rg 后附在结果尾部的提示(docs/07 §2.4)。 */
export const MORE_MATCHES_NOTE = '(more matches available — refine pattern or path)';
/** signal 触发中断后的错误文案(对齐 bash 的 "User aborted the command",docs/07 §2.5/§4)。 */
export const GREP_ABORTED_MESSAGE = 'User aborted the search';

export const grepParameters = z.object({
  pattern: z.string().describe('Regex to search for (ripgrep syntax)'),
  path: z.string().optional().describe('File or directory to search. Omit for cwd'),
  glob: z.string().optional().describe("Filter files, e.g. '*.ts' or '**/*.spec.ts'"),
  ignoreCase: z.boolean().optional().describe('Case-insensitive search'),
  literal: z.boolean().optional().describe('Treat pattern as a fixed string, not regex'),
  context: z.number().int().min(0).optional().describe('Lines of context around each match'),
  limit: z.number().int().min(1).optional().describe('Maximum matches (default 100)'),
});

export type GrepArgs = z.infer<typeof grepParameters>;

/**
 * 结构化细节(不发给模型):limit 早停是否发生、rg 是否确实被我们 kill
 * (早停路径下进程以 signal 终止,即 close 的 code === null)——让「达 limit 即 kill」可观测。
 */
export interface GrepDetails {
  limitReached: boolean;
  rgKilled: boolean;
}

interface RgMatch {
  file: string;   // rg 报告的路径(相对搜索 cwd,可能带 ./ 前缀)
  line: number;   // 1-indexed
  text: string;   // 已去行尾、截到 500 字符
}

interface RgRun {
  matches: RgMatch[];
  limitReached: boolean;
  code: number | null;    // 被 signal kill 时为 null
  signal: number | null;
  stderr: string;
}

/** 去掉 rg lines.text 的结尾换行与 CRLF 文件的 \r。 */
function stripEol(text: string): string {
  return text.replace(/\r?\n$/, '').replace(/\r$/, '');
}

/** 单行截到 500 字符(docs/07 §2.4)。 */
function clipLine(text: string): string {
  return text.length > MAX_LINE_CHARS ? text.slice(0, MAX_LINE_CHARS) : text;
}

/** 展示路径:剥掉 rg 对 '.' 搜索路径产出的 ./ 前缀。 */
function displayPath(file: string): string {
  return file.startsWith('./') ? file.slice(2) : file;
}

/**
 * rg --json 的 text/bytes 双形态取值:内容(path 或 lines)非 UTF-8 时 rg 输出
 * {"bytes": "<base64>"} 而非 {"text": ...}。bytes 形态降级解码为 UTF-8
 * (不可解码字节变 U+FFFD 替换符),照常计为 match,不静默丢弃(假阴性)。
 */
function decodeJsonText(v: unknown): string | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as { text?: unknown; bytes?: unknown };
  if (typeof o.text === 'string') return o.text;
  if (typeof o.bytes === 'string') {
    return new TextDecoder().decode(Uint8Array.fromBase64(o.bytes));
  }
  return undefined;
}

/** 从 --json 的一行事件中提取 match;非 match 事件返回 undefined。 */
function extractMatch(evt: unknown): RgMatch | undefined {
  if (typeof evt !== 'object' || evt === null) return undefined;
  const e = evt as {
    type?: unknown;
    data?: { path?: unknown; line_number?: unknown; lines?: unknown };
  };
  if (e.type !== 'match') return undefined;
  const file = decodeJsonText(e.data?.path);
  const line = e.data?.line_number;
  const text = decodeJsonText(e.data?.lines);
  if (file === undefined || typeof line !== 'number' || text === undefined) {
    return undefined;
  }
  return { file, line, text: clipLine(stripEol(text)) };
}

/**
 * spawn rg 并流式解析 --json 输出;match 数达 limit 即 kill(不等全仓搜完),
 * signal 触发同样 kill。resolve 于进程 close(即 rg 确已退出)。
 */
async function runRipgrep(
  rgPath: string,
  rgArgs: string[],
  cwd: string,
  limit: number,
  signal: AbortSignal,
): Promise<RgRun> {
  if (signal.aborted) throw new Error(GREP_ABORTED_MESSAGE);

  const matches: RgMatch[] = [];
  let limitReached = false;
  let resolveExit!: (value: { code: number | null; signal: number | null }) => void;
  let rejectExit!: (reason: unknown) => void;
  const exit = new Promise<{ code: number | null; signal: number | null }>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });

  const child = Bun.spawn({
    cmd: [rgPath, ...rgArgs],
    cwd,
    signal,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    killSignal: 'SIGTERM',
    onExit(_proc, code, signalCode, err) {
      if (err !== undefined) rejectExit(err);
      else resolveExit({ code, signal: signalCode });
    },
  });

  const handleLine = (line: string): void => {
    if (limitReached || line === '') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // 非 JSON 行(不应出现),忽略
    }
    const m = extractMatch(parsed);
    if (m === undefined) return;
    matches.push(m);
    if (matches.length >= limit) {
      limitReached = true;
      child.kill('SIGTERM');
    }
  };

  const stdout = consumeLines(child.stdout, handleLine, () => limitReached);
  const stderr = new Response(child.stderr).text();
  const [status, stderrText] = await Promise.all([exit, stderr, stdout]);
  return { matches, limitReached, code: status.code, signal: status.signal, stderr: stderrText };
}

/** Web ReadableStream 增量解码为行;stop 后取消读端,避免 limit 早停仍继续缓冲 rg 输出。 */
async function consumeLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
  stop: () => boolean,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let leftover = '';
  try {
    while (!stop()) {
      const { done, value } = await reader.read();
      if (done) break;
      leftover += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = leftover.indexOf('\n')) !== -1) {
        onLine(leftover.slice(0, idx));
        leftover = leftover.slice(idx + 1);
        if (stop()) break;
      }
    }
    if (stop()) {
      await reader.cancel();
      leftover = '';
      return;
    }
    leftover += decoder.decode();
    if (leftover !== '') onLine(leftover);
  } finally {
    reader.releaseLock();
  }
}

/** 带缓存读文件行(context 切片用);读不到(已删/二进制读失败)返回 undefined,降级为无 context。 */
async function readFileLines(
  absPath: string,
  cache: Map<string, string[] | null>,
): Promise<string[] | undefined> {
  const hit = cache.get(absPath);
  if (hit !== undefined) return hit ?? undefined;
  let lines: string[] | null;
  try {
    const content = await Bun.file(absPath).text();
    lines = content.split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop(); // 结尾换行不算一行
  } catch {
    lines = null;
  }
  cache.set(absPath, lines);
  return lines ?? undefined;
}

/**
 * gnu grep 风格格式化,按文件分组(docs/07 §2.4):
 * match 行 `path:line: text`,context 行 `path-line- text`。
 * 相邻 match 的 context 区间重叠时合并,不重复输出;match 行格式优先。
 */
async function formatMatches(matches: RgMatch[], contextN: number, cwd: string): Promise<string[]> {
  const byFile = new Map<string, RgMatch[]>();
  for (const m of matches) {
    const group = byFile.get(m.file);
    if (group !== undefined) group.push(m);
    else byFile.set(m.file, [m]);
  }

  const cache = new Map<string, string[] | null>();
  const out: string[] = [];
  for (const [file, group] of byFile) {
    const shown = displayPath(file);
    if (contextN === 0) {
      for (const m of group) out.push(`${shown}:${m.line}: ${m.text}`);
      continue;
    }
    const fileLines = await readFileLines(path.resolve(cwd, file), cache);
    if (fileLines === undefined) {
      for (const m of group) out.push(`${shown}:${m.line}: ${m.text}`);
      continue;
    }
    const matchByLine = new Map(group.map((m) => [m.line, m.text]));
    // 求 match ± context 的行号并集:重叠区间自然去重
    const wanted = new Set<number>();
    for (const m of group) {
      wanted.add(m.line); // match 行永远保留(文件已变短时也不丢)
      const lo = Math.max(1, m.line - contextN);
      const hi = Math.min(fileLines.length, m.line + contextN);
      for (let n = lo; n <= hi; n++) wanted.add(n);
    }
    for (const n of [...wanted].sort((a, b) => a - b)) {
      const matchText = matchByLine.get(n);
      if (matchText !== undefined) {
        out.push(`${shown}:${n}: ${matchText}`);
      } else {
        out.push(`${shown}-${n}- ${clipLine(stripEol(fileLines[n - 1] ?? ''))}`);
      }
    }
  }
  return out;
}

export const GREP_DESCRIPTION =
  'Search file contents for a regex pattern using ripgrep. Respects .gitignore; includes hidden files. ' +
  'Results are grouped by file in grep format: "path:line: text" for matches, "path-line- text" for context lines. ' +
  'Prefer this over running grep/rg through the bash tool.';

export async function executeGrep(
  { args }: ToolExecutionInput<GrepArgs>,
  ctx: ToolContext,
): Promise<ToolOutput<GrepDetails>> {
    const rgPath = await resolveRgPath();
    if (rgPath === undefined) throw new Error(RG_MISSING_MESSAGE);
    if (ctx.signal.aborted) throw new Error(GREP_ABORTED_MESSAGE);

    const limit = args.limit ?? DEFAULT_LIMIT;
    // --hidden 让 dotfiles 可搜,但会连带解除 rg 对 .git/ 的默认跳过,必须显式排除(docs/07 §2.4);
    // --no-require-git 让 .gitignore 在非 git 目录同样生效(与 glob 一致)
    const rgArgs = [
      '--json',
      '--line-number',
      '--color=never',
      '--hidden',
      '--no-require-git',
      '--glob',
      '!.git/**',
    ];
    if (args.ignoreCase === true) rgArgs.push('--ignore-case');
    if (args.literal === true) rgArgs.push('--fixed-strings');
    if (args.glob !== undefined) rgArgs.push('--glob', args.glob);
    // '--' 防 pattern 以 '-' 开头时被误读为 flag;语义与 docs/07 的 spawn 形态一致
    rgArgs.push('--', args.pattern, args.path ?? '.');

    const run = await runRipgrep(rgPath, rgArgs, ctx.cwd, limit, ctx.signal);
    if (ctx.signal.aborted) throw new Error(GREP_ABORTED_MESSAGE);

    if (!run.limitReached) {
      if (run.code === null) {
        // 非 limit、非 abort 却被信号终止(外部 kill):按 rg 故障处理
        throw new Error(`ripgrep terminated unexpectedly: ${run.stderr.trim()}`);
      }
      if (run.code >= 2) {
        throw new Error(`ripgrep exited with code ${run.code}: ${run.stderr.trim()}`);
      }
    }
    const details: GrepDetails = {
      limitReached: run.limitReached,
      rgKilled: run.limitReached && (run.code === null || run.signal !== null),
    };
    if (run.matches.length === 0) {
      // exit 1(无匹配)不是错误:空串会让模型困惑,给明确文案
      return { content: [{ type: 'text', text: 'No matches found' }], details };
    }

    const lines = await formatMatches(run.matches, args.context ?? 0, ctx.cwd);
    if (run.limitReached) lines.push(MORE_MATCHES_NOTE);
    return { content: [{ type: 'text', text: lines.join('\n') }], details };
}
