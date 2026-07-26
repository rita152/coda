// 截断原语:行数 + 字节双上限(谁先命中算谁),头部/尾部两个方向。
// 常量与 read 默认读取量一致(docs/07-tools.md §1.6:2000 行 / 48*1024 字节,
// pi-mono 与 opencode 的事实标准)。字节计数按 UTF-8;切割永远落在行边界上,
// 绝不产出半个多字节字符。

export const MAX_OUTPUT_LINES = 2000;
export const MAX_OUTPUT_BYTES = 48 * 1024;

export interface ClipResult {
  text: string;          // 截断后的文本(未截断时即原文)
  truncated: boolean;
  totalLines: number;    // 原文总行数
  totalBytes: number;    // 原文总字节数(UTF-8)
  keptLines: number;     // 保留的行数
  /** 头部截断:保留区最后一行的 1-indexed 行号;尾部截断:保留区第一行的 1-indexed 行号。 */
  boundaryLine: number;
}

export interface ClipLimits {
  maxLines?: number;
  maxBytes?: number;
}

function splitLines(text: string): string[] {
  // 按 \n 切分;结尾换行不额外产生空行(与人对「行数」的直觉一致)
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** 保留头部:命中行/字节上限即停(read/框架 post-hook 方向)。 */
export function clipHead(text: string, limits?: ClipLimits): ClipResult {
  const maxLines = limits?.maxLines ?? MAX_OUTPUT_LINES;
  const maxBytes = limits?.maxBytes ?? MAX_OUTPUT_BYTES;
  const lines = splitLines(text);
  const totalBytes = Buffer.byteLength(text, 'utf8');

  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    if (kept.length >= maxLines) break;
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1; // + '\n'
    if (kept.length > 0 && bytes + lineBytes > maxBytes) break;
    kept.push(line);
    bytes += lineBytes;
    if (bytes > maxBytes) break; // 首行即超限:保留该行后停(至少产出一行)
  }

  const truncated = kept.length < lines.length;
  return {
    text: truncated ? kept.join('\n') : text,
    truncated,
    totalLines: lines.length,
    totalBytes,
    keptLines: kept.length,
    boundaryLine: kept.length, // 保留区最后一行的行号
  };
}

/** 保留尾部:bash 方向(错误几乎总在末尾)。 */
export function clipTail(text: string, limits?: ClipLimits): ClipResult {
  const maxLines = limits?.maxLines ?? MAX_OUTPUT_LINES;
  const maxBytes = limits?.maxBytes ?? MAX_OUTPUT_BYTES;
  const lines = splitLines(text);
  const totalBytes = Buffer.byteLength(text, 'utf8');

  const kept: string[] = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (kept.length >= maxLines) break;
    const line = lines[i] as string;
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
    if (kept.length > 0 && bytes + lineBytes > maxBytes) break;
    kept.unshift(line);
    bytes += lineBytes;
    if (bytes > maxBytes) break;
  }

  const truncated = kept.length < lines.length;
  return {
    text: truncated ? kept.join('\n') : text,
    truncated,
    totalLines: lines.length,
    totalBytes,
    keptLines: kept.length,
    boundaryLine: lines.length - kept.length + 1, // 保留区第一行的行号
  };
}
