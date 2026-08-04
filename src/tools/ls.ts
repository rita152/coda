// ls 工具:非递归目录列举(工具 Executor 语义见 docs/07-tools.md,样板取 pi-mono ls.ts)。
// 字母序、目录加 / 后缀、含 dotfiles;递归找文件是 glob 的事。被 .gitignore
// 忽略的目录仍列出名字(不递归故无「内容遍历」一说),不做任何过滤。

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ToolContext, ToolExecutionInput, ToolOutput } from './types.js';

const DEFAULT_LIMIT = 500;

export const lsParameters = z.object({
  path: z
    .string()
    .optional()
    .describe("Directory to list. Omit for cwd — do NOT pass 'undefined' or 'null'"),
  limit: z.number().int().min(1).optional().describe('Maximum entries to return (default 500)'),
});

export type LsArgs = z.infer<typeof lsParameters>;

export const LS_DESCRIPTION =
  'List the entries of a directory (non-recursive), in alphabetical order. ' +
  "Directories are suffixed with '/'. Dotfiles are included. " +
  'Use the glob tool to find files recursively.';

export async function executeLs(
  call: ToolExecutionInput<LsArgs>,
  ctx: ToolContext,
): Promise<ToolOutput<unknown>> {
    const target = path.resolve(ctx.cwd, call.args.path ?? '.');
    const shown = call.args.path ?? target; // 报错回显模型原话;省略 path 时回显解析后的 cwd
    const limit = call.args.limit ?? DEFAULT_LIMIT;

    let dirents;
    try {
      dirents = await readdir(target, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // path 指向文件 → 规格文案,引导模型改用 read。
      if (code === 'ENOTDIR') throw new Error(`Not a directory: ${shown} (did you mean the read tool?)`);
      if (code === 'ENOENT') throw new Error(`Directory not found: ${shown}`);
      throw err;
    }
    // 纯 fs 工具:关键 await 之后检查 signal 即可(docs/07 §4);文案对齐 grep/bash
    if (ctx.signal.aborted) throw new Error('User aborted the directory listing');

    if (dirents.length === 0) {
      return { content: [{ type: 'text', text: '(empty directory)' }] };
    }

    // 字母序用码元序 .sort():跨平台确定,readdir 自身顺序无保证
    const entries = dirents
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((d) => (d.isDirectory() ? `${d.name}/` : d.name));

    const total = entries.length;
    let text = entries.slice(0, limit).join('\n');
    if (total > limit) {
      text += `\n(Showing first ${limit} of ${total} entries. Use glob for targeted listing.)`;
    }
    return { content: [{ type: 'text', text }] };
}
