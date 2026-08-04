// read 工具:带行号的文本读取 + 图片 ImagePart(工具 Executor 语义见 docs/07-tools.md)。
// 三重上限:MAX_OUTPUT_LINES 行 / MAX_OUTPUT_BYTES 字节 / 单行 2000 字符;
// 流式逐行读取并同时计数行与字节,命中字节上限即中断上游文件流,
// 不整读大文件进内存(opencode 做法)。>20MB 直接拒读(gemini-cli 保险)。

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES } from '../shared/index.js';
import type { ToolContext, ToolExecutionInput, ToolOutput } from './types.js';

// 参数 schema 与当前工具契约逐字段一致。
export const readParameters = z.object({
  path: z.string().describe('Path to the file to read (absolute, or relative to cwd)'),
  offset: z.number().int().min(1).optional().describe('Line number to start reading from (1-indexed)'),
  limit: z.number().int().min(1).optional().describe('Maximum number of lines to read (default 2000)'),
});

export type ReadArgs = z.infer<typeof readParameters>;

export interface ReadDetails {
  path: string;          // resolve 后的绝对路径
  truncated: boolean;    // 行数/字节任一截断即 true;框架 post-hook 见之跳过
  totalLines?: number;   // 字节截断提前收流时未知,缺省
}

const MAX_LINE_CHARS = 2000;                 // 单行字符上限
const MAX_FILE_BYTES = 20 * 1024 * 1024;     // gemini-cli 的 20MB 文件上限保险
const SAMPLE_BYTES = 4096;                   // 二进制采样窗口
const NON_PRINTABLE_RATIO = 0.3;             // 不可打印占比阈值
const UTF8_ENCODER = new TextEncoder();
const ABORTED_MESSAGE = 'User aborted the read operation.';

// 图片走 ImagePart 返回,不算二进制拒读。
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

// 扩展名黑名单:常见二进制格式,免采样直接拒读(黑名单 ∪ 采样,命中任一即二进制)
const BINARY_EXTENSIONS = new Set([
  '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.zst', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.a', '.o', '.obj', '.lib', '.bin', '.wasm', '.node',
  '.class', '.jar', '.war', '.pyc',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods',
  '.ttf', '.otf', '.woff', '.woff2', '.eot', '.ico', '.icns',
  '.bmp', '.tif', '.tiff', '.heic', '.heif', '.avif', '.psd',
  '.mp3', '.mp4', '.m4a', '.avi', '.mov', '.mkv', '.wav', '.flac', '.ogg', '.webm',
  '.sqlite', '.db', '.dmg', '.iso', '.pkg', '.deb', '.rpm',
]);

/** 4KB 采样:含 NUL 即二进制;控制字符占比 > 30% 即二进制(≥0x80 视为 UTF-8 多字节,不算)。 */
async function sampleLooksBinary(absPath: string): Promise<boolean> {
  const buf = new Uint8Array(await Bun.file(absPath).slice(0, SAMPLE_BYTES).arrayBuffer());
  if (buf.length === 0) return false;
  let nonPrintable = 0;
  for (const b of buf) {
    if (b === 0) return true;
    if ((b < 32 && b !== 9 && b !== 10 && b !== 13) || b === 127) nonPrintable++;
  }
  return nonPrintable / buf.length > NON_PRINTABLE_RATIO;
}

/** Bun.file Web stream → readline 等价的物理行;提前 break 时取消上游读取。 */
async function* streamLines(file: Bun.BunFile): AsyncGenerator<string> {
  const reader = file.stream().getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let complete = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        break;
      }
      pending += decoder.decode(value, { stream: true });
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        const raw = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        yield raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        newline = pending.indexOf('\n');
      }
    }
    pending += decoder.decode();
    if (pending.length > 0) yield pending.endsWith('\r') ? pending.slice(0, -1) : pending;
  } finally {
    if (!complete) await reader.cancel();
    reader.releaseLock();
  }
}

/** 单行 2000 字符截断;边界落在代理对中间时回退一位,不产出孤立 surrogate。 */
function clipLongLine(raw: string): string {
  if (raw.length <= MAX_LINE_CHARS) return raw;
  let end = MAX_LINE_CHARS;
  const code = raw.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--; // 末位是高位代理:整个字符留到截断线外
  return `${raw.slice(0, end)}...`;
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error(ABORTED_MESSAGE);
}

/** 同目录下与 basename 互为子串(不区分大小写)的最多 3 个候选,展示为相对 cwd 的路径。 */
function findSimilarNames(absPath: string, cwd: string): string[] {
  const dir = path.dirname(absPath);
  const base = path.basename(absPath).toLowerCase();
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch {
    return []; // 目录本身不存在/不可读:不出候选
  }
  return names
    .filter((n) => {
      const ln = n.toLowerCase();
      return ln.includes(base) || base.includes(ln);
    })
    .sort()
    .slice(0, 3)
    .map((n) => {
      const abs = path.join(dir, n);
      const rel = path.relative(cwd, abs);
      return rel.startsWith('..') ? abs : rel;
    });
}

export const READ_DESCRIPTION =
  'Reads a file from the local filesystem and returns its content with 1-indexed line numbers ("N: text"). ' +
  'By default reads the first 2000 lines (up to 50KB); use offset and limit to page through larger files, ' +
  'following the continuation hint at the end of truncated output. Lines longer than 2000 characters are truncated. ' +
  'Image files (png/jpeg/gif/webp) are returned as images; other binary files cannot be read.';

export const READ_PROMPT_SNIPPET =
  'The read tool prefixes every output line with its line number as "N: ". The prefix is not part of the file — ' +
  'when constructing oldText for the edit tool, strip the line-number prefix and use the raw line content.';

export async function executeRead(
  { args }: ToolExecutionInput<ReadArgs>,
  ctx: ToolContext,
): Promise<ToolOutput<ReadDetails>> {
    const resolved = path.resolve(ctx.cwd, args.path);
    assertNotAborted(ctx.signal);

    let stat;
    try {
      stat = statSync(resolved);
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') {
        const candidates = findSimilarNames(resolved, ctx.cwd);
        let msg = `File not found: ${args.path}`;
        if (candidates.length > 0) {
          msg += `\n\nDid you mean one of these?\n${candidates.map((c) => `  ${c}`).join('\n')}`;
        }
        throw new Error(msg);
      }
      throw err;
    }

    if (stat.isDirectory()) {
      throw new Error(`Path is a directory, not a file: ${args.path}. Use the ls tool to list its contents.`);
    }
    if (stat.size > MAX_FILE_BYTES) {
      const mb = (stat.size / (1024 * 1024)).toFixed(1);
      throw new Error(
        `File is too large to read: ${args.path} (${mb}MB exceeds the 20MB limit). ` +
          'Use the grep tool to search within it, or bash (head/tail/sed) to view specific sections.',
      );
    }

    // 图片:base64 走 ImagePart,读取成功同样登记 FileTracker
    const ext = path.extname(resolved).toLowerCase();
    const imageMime = IMAGE_MIME[ext];
    if (imageMime !== undefined) {
      const data = (await Bun.file(resolved).bytes()).toBase64();
      assertNotAborted(ctx.signal);
      ctx.fileTracker.markRead(resolved, stat.mtimeMs);
      return {
        content: [{ type: 'image', data, mimeType: imageMime }],
        details: { path: resolved, truncated: false },
      };
    }

    if (BINARY_EXTENSIONS.has(ext)) {
      throw new Error(`Cannot read binary file: ${args.path}`);
    }
    const looksBinary = await sampleLooksBinary(resolved);
    assertNotAborted(ctx.signal);
    if (looksBinary) throw new Error(`Cannot read binary file: ${args.path}`);

    const offset = args.offset ?? 1;
    const limit = args.limit ?? MAX_OUTPUT_LINES;

    // 流式逐行:kept 收集展示区,lineNo 持续计数总行数;
    // 字节截断即 break 中断上游流(此后总行数未知),行数截断则继续消费只计数。
    const kept: string[] = [];
    let lineNo = 0;
    let bytes = 0;
    let byteCapped = false;
    let hasMoreAfterLimit = false;

    for await (const raw of streamLines(Bun.file(resolved))) {
      // 纯 fs 工具:关键 await 后检查 signal(docs/07 §4)
      assertNotAborted(ctx.signal);
      lineNo++;
      if (lineNo < offset) continue;
      if (kept.length >= limit) {
        hasMoreAfterLimit = true;
        continue; // 不再收集,只数完总行数(行数截断文案需要 of N)
      }
      const line = clipLongLine(raw);
      const lineBytes = UTF8_ENCODER.encode(line).byteLength + 1; // + '\n'
      if (kept.length > 0 && bytes + lineBytes > MAX_OUTPUT_BYTES) {
        byteCapped = true;
        break;
      }
      kept.push(line);
      bytes += lineBytes;
      if (bytes > MAX_OUTPUT_BYTES) {
        byteCapped = true; // 首行即超限:保留该行后停(与 clipHead 一致,至少产出一行)
        break;
      }
    }
    assertNotAborted(ctx.signal);

    // offset 越界:显式 offset 超出总行数(流已读完,lineNo 即总行数)。
    // 空文件的 offset=1 与省略 offset 等价:同样返回读完态而非报错
    if (args.offset !== undefined && !byteCapped && args.offset > Math.max(lineNo, 1)) {
      throw new Error(`Offset ${args.offset} is out of range for this file (${lineNo} lines).`);
    }

    // 结尾三态,永远告诉模型下一步 offset。
    let tail: string;
    if (byteCapped) {
      const last = offset + kept.length - 1;
      tail = `[Output capped at 50KB at line ${last}. Use offset=${last + 1} to continue.]`;
    } else if (hasMoreAfterLimit) {
      const last = offset + kept.length - 1;
      tail = `[Showing lines ${offset}-${last} of ${lineNo}. Use offset=${last + 1} to continue.]`;
    } else {
      tail = `(End of file - total ${lineNo} lines)`;
    }

    const numbered = kept.map((l, i) => `${offset + i}: ${l}`);
    const text = [...numbered, tail].join('\n');

    // 读取成功登记:edit/write read-before-edit 硬约束的数据来源。
    ctx.fileTracker.markRead(resolved, stat.mtimeMs);

    const details: ReadDetails = { path: resolved, truncated: byteCapped || hasMoreAfterLimit };
    if (!byteCapped) details.totalLines = lineNo;
    return { content: [{ type: 'text', text }], details };
}
