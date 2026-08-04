// write 工具:新建或整体覆盖文件(工具 Executor 语义见 docs/07-tools.md)。
// 覆盖已有文件受 read-before-edit 硬约束;新文件不受约束。
// 覆盖时保留原文件 BOM 与行尾风格(模型永远输出 LF,这层负责翻译)。
// 写入经 per-path 串行队列(path-lock);abort 只在每个 await 后检查 signal。

import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { z } from 'zod';
import { withPathLock } from './path-lock.js';
import type { ToolContext, ToolExecutionInput, ToolOutput } from './types.js';

export const writeParameters = z.object({
  path: z.string().describe('Path to the file to write. Parent directories are created automatically'),
  content: z.string().describe('Full content to write (this replaces the entire file)'),
});

export type WriteArgs = z.infer<typeof writeParameters>;

/** approval UI / 持久化用的结构化细节(diff 不回喂模型)。 */
export interface WriteDetails {
  diff: string;        // unified diff(新文件时旧内容为空串)
  additions: number;
  deletions: number;
}

const BOM = '\uFEFF';
const UTF8_DECODER = new TextDecoder();

/** abort 检查:纯 fs 工具在关键 await 之后调用(docs/07 §4)。 */
function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('User aborted the write; the file was not modified.');
}

/** 行数统计:结尾换行不额外产生一行(与 shared/truncate.ts 的 splitLines 直觉一致)。 */
function countLines(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/**
 * 统计 unified diff 的增删行数:只统计首个 '@@' 之后的行(与 edit 的统计一致)。
 * 按前缀排除 '+++'/'---' 会把内容以 '++'/'--' 开头的增删行一并误杀。
 */
function countChanges(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue; // 跳过 ---/+++ 等头部
    if (line.startsWith('+')) additions++;
    else if (line.startsWith('-')) deletions++;
  }
  return { additions, deletions };
}

async function executeWriteArgs(args: WriteArgs, ctx: ToolContext): Promise<ToolOutput<WriteDetails>> {
  const absPath = path.resolve(ctx.cwd, args.path);

  return withPathLock(absPath, async () => {
    checkAborted(ctx.signal);

    // 现状探测:存在 → 覆盖路径(freshness + 风格保留);ENOENT → 新建路径
    const oldStat = await stat(absPath).catch((err: unknown) => {
      if ((err as { code?: string }).code === 'ENOENT') return undefined;
      throw err;
    });
    checkAborted(ctx.signal);

    if (oldStat?.isDirectory()) {
      throw new Error(`Cannot write to ${args.path}: it is a directory.`);
    }

    // read-before-edit 硬约束，仅覆盖已有文件时生效。
    let oldText = '';       // LF 空间的旧内容(diff 用;新文件为空串)
    let hasBom = false;
    let isCrlf = false;
    if (oldStat) {
      const fresh = ctx.fileTracker.assertFresh(absPath, oldStat.mtimeMs);
      if (!fresh.ok) {
        throw new Error(
          fresh.reason === 'never_read'
            ? 'File has not been read in this session. Use the read tool first.'
            : 'File has been modified since it was last read. Re-read it to see the current content.',
        );
      }
      const oldBytes = await Bun.file(absPath).bytes();
      checkAborted(ctx.signal);
      hasBom =
        oldBytes.length >= 3 &&
        oldBytes[0] === 0xef &&
        oldBytes[1] === 0xbb &&
        oldBytes[2] === 0xbf;
      const stripped = UTF8_DECODER.decode(oldBytes.subarray(hasBom ? 3 : 0));
      isCrlf = stripped.includes('\r\n');
      oldText = stripped.replaceAll('\r\n', '\n');
    }

    // LF 归一化(模型偶发 CRLF 也接住)→ 按原文件风格还原 → 补回 BOM
    const contentLf = args.content.replaceAll('\r\n', '\n');
    const body = isCrlf ? contentLf.replaceAll('\n', '\r\n') : contentLf;
    const finalText = (hasBom ? BOM : '') + body;

    // diff 在 LF 空间生成(与 edit 的匹配空间一致);新文件旧内容为空串。
    const diff = createTwoFilesPatch(args.path, args.path, oldText, contentLf);
    const { additions, deletions } = countChanges(diff);

    await mkdir(path.dirname(absPath), { recursive: true });
    checkAborted(ctx.signal);

    // Bun.write 是不可回退点,之后不再做 abort 检查——副作用已发生,
    // 报成功比报错更如实(abort 语义只保证「不写入」,不保证「写入后装没写」)。
    await Bun.write(absPath, finalText);
    const newStat = await stat(absPath);
    // 成功后登记:自己的写不算外部修改，后续 edit/write 无需重新 read。
    ctx.fileTracker.markRead(absPath, newStat.mtimeMs);

    const lines = countLines(args.content);
    const kb = (new TextEncoder().encode(finalText).byteLength / 1024).toFixed(1);
    return {
      content: [{ type: 'text', text: `Wrote ${lines} lines (${kb} KB) to ${args.path}` }],
      details: { diff, additions, deletions },
    };
  });
}

export const WRITE_DESCRIPTION =
  'Write a file to disk, creating it (and any missing parent directories) or replacing its entire contents. ' +
  'Prefer the edit tool for modifying existing files; use write only for new files or intentional full rewrites.';

export function executeWrite(
  call: ToolExecutionInput<WriteArgs>,
  ctx: ToolContext,
): Promise<ToolOutput<WriteDetails>> {
  return executeWriteArgs(call.args, ctx);
}
