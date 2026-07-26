// glob 工具:ripgrep --files 驱动的文件查找(规格见 docs/07-tools.md §2.3)。
// 天然吃 .gitignore(rg 15 默认只在 git 仓库内读 .gitignore,显式加
// --no-require-git 让非 git 目录同样生效);排序抄 gemini-cli sortFileEntries:
// 24 小时内修改过的文件按 mtime 新→旧排最前,其余按字母序。

import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { RG_MISSING_MESSAGE, resolveRgPath } from './rg.js';
import type { ToolContext, ToolDefinition, ToolOutput } from './types.js';

const DEFAULT_LIMIT = 100;
const RECENCY_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/** signal 触发中断后的错误文案(对齐 grep/bash 的 "User aborted the ...",docs/07 §4)。 */
const MSG_ABORTED = 'User aborted the glob search';

const GlobParams = z.object({
  pattern: z.string().describe("Glob pattern, e.g. '**/*.ts' or 'src/**/*.test.ts'"),
  path: z
    .string()
    .optional()
    .describe("Directory to search. Omit for cwd — do NOT pass 'undefined' or 'null'"),
  limit: z.number().int().min(1).optional().describe('Maximum files to return (default 100)'),
});

type GlobArgs = z.infer<typeof GlobParams>;

interface FileEntry {
  display: string; // 给模型看的路径(cwd 内相对 cwd,越出 cwd 用绝对路径)
  mtimeMs: number;
}

/** 排序抄 gemini-cli sortFileEntries:recent 按 mtime 降序在前,其余 localeCompare。 */
function sortFileEntries(entries: FileEntry[], nowMs: number): FileEntry[] {
  return [...entries].sort((a, b) => {
    const aRecent = nowMs - a.mtimeMs < RECENCY_THRESHOLD_MS;
    const bRecent = nowMs - b.mtimeMs < RECENCY_THRESHOLD_MS;
    if (aRecent && bRecent) return b.mtimeMs - a.mtimeMs;
    if (aRecent) return -1;
    if (bRecent) return 1;
    return a.display.localeCompare(b.display);
  });
}

/** spawn rg --files 并收集 stdout 行;exit 0/1 均为正常(1 = 无匹配),≥2 才是报错。 */
function runRgFiles(
  rgPath: string,
  pattern: string,
  searchDir: string,
  signal: AbortSignal,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    // { signal }:abort 时 node 自动 kill 子进程并以 AbortError 走 error 事件
    const child = spawn(rgPath, ['--files', '--no-require-git', '--glob', pattern], {
      cwd: searchDir,
      signal,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (err) => {
      reject(signal.aborted ? new Error(MSG_ABORTED) : err);
    });
    child.on('close', (code) => {
      if (signal.aborted) return reject(new Error(MSG_ABORTED));
      if (code !== 0 && code !== 1) {
        // 典型:glob 语法错误。rg 的 stderr 文案本身面向人可读,转述给模型即可
        return reject(new Error(`Glob search failed: ${stderr.trim() || `rg exited with code ${String(code)}`}`));
      }
      resolve(stdout.split('\n').filter((line) => line.length > 0));
    });
  });
}

export const globTool: ToolDefinition<GlobArgs> = {
  name: 'glob',
  description:
    'Find files matching a glob pattern (recursive, respects .gitignore). ' +
    'Files modified within the last 24 hours are listed first (newest first), the rest alphabetically.',
  parameters: GlobParams,
  kind: 'search',

  async execute(call, ctx: ToolContext): Promise<ToolOutput<unknown>> {
    const searchDir = path.resolve(ctx.cwd, call.args.path ?? '.');
    const shownDir = call.args.path ?? searchDir;
    const limit = call.args.limit ?? DEFAULT_LIMIT;
    const { pattern } = call.args;

    try {
      const st = await stat(searchDir);
      if (!st.isDirectory()) throw new Error(`Not a directory: ${shownDir}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Directory not found: ${shownDir}`);
      }
      throw err;
    }

    const rgPath = resolveRgPath();
    if (rgPath === undefined) throw new Error(RG_MISSING_MESSAGE);

    const relPaths = await runRgFiles(rgPath, pattern, searchDir, ctx.signal);
    if (relPaths.length === 0) {
      return { content: [{ type: 'text', text: `No files match pattern "${pattern}"` }] };
    }

    // stat 拿 mtime(排序用);瞬时消失的文件按 0 处理(等价「很旧」,不炸整个结果)
    const entries: FileEntry[] = await Promise.all(
      relPaths.map(async (rel) => {
        const abs = path.resolve(searchDir, rel);
        const relToCwd = path.relative(ctx.cwd, abs);
        const display = relToCwd === '' || relToCwd.startsWith('..') ? abs : relToCwd;
        try {
          return { display, mtimeMs: (await stat(abs)).mtimeMs };
        } catch {
          return { display, mtimeMs: 0 };
        }
      }),
    );
    if (ctx.signal.aborted) throw new Error(MSG_ABORTED);

    const sorted = sortFileEntries(entries, Date.now());
    const total = sorted.length;
    let text = sorted
      .slice(0, limit)
      .map((e) => e.display)
      .join('\n');
    if (total > limit) {
      text += `\n(Results truncated: showing first ${limit}. Refine the pattern or path.)`;
    }
    return { content: [{ type: 'text', text }] };
  },
};
