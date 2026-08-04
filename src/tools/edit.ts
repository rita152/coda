// edit 工具:old/new 精确替换 + 零风险归一化 fuzzy(工具 Executor 语义见 docs/07-tools.md)。
// 匹配策略两层到顶:精确 indexOf → 归一化空间按行匹配(NFKC + trimEnd + 不可见字符
// → ASCII),明确拒绝编辑距离/相似度类匹配——静默改错的代价远大于让模型重发一次。
// 失败语义:throw 即失败，错误文案面向模型、告知下一步动作。

import type { Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { z } from 'zod';
import type { ToolContext, ToolExecutionInput, ToolOutput } from './types.js';
import { withPathLock } from './path-lock.js';

// ---- 参数 schema ----

export const editParameters = z.object({
  path: z.string().describe('Path to the file to edit'),
  edits: z
    .array(
      z.object({
        oldText: z
          .string()
          .describe('Exact text to replace, as it appears in the file (strip read line-number prefixes)'),
        newText: z.string().describe('Replacement text (must differ from oldText)'),
        replaceAll: z
          .boolean()
          .optional()
          .describe('Replace all occurrences (default false: oldText must be unique)'),
      }),
    )
    .min(1)
    .describe('All edits are matched against the original file content; edits must not overlap'),
});

export type EditArgs = z.infer<typeof editParameters>;

/** 结构化细节:unified diff 进 UI 不回喂模型。 */
export interface EditDetails {
  diff: string;
  additions: number;
  deletions: number;
}

// ---- 错误文案 ----

const MSG_NEVER_READ = 'File has not been read in this session. Use the read tool first.';
const MSG_STALE = 'File has been modified since it was last read. Re-read it to see the current content.';
const MSG_IDENTICAL = 'No changes to apply: oldText and newText are identical.';
const MSG_EMPTY_OLD_TEXT =
  'oldText is empty. To create a new file or replace its entire content, use the write tool instead.';
const MSG_ABORTED = 'The edit was aborted; no changes were written.';

function msgNotFound(p: string): string {
  return (
    `Could not find the text to replace in ${p}. It must match exactly, including whitespace ` +
    'and indentation. Re-read the file and try again.'
  );
}

function msgOccurrences(n: number, p: string): string {
  return (
    `Found ${n} occurrences of the text in ${p}. Provide more surrounding context to make the ` +
    'match unique, or set replaceAll: true.'
  );
}

function msgOverlap(p: string): string {
  return (
    `Edits overlap in ${p}: all edits are matched against the original file content and must ` +
    'target distinct regions. Merge overlapping edits into a single edit.'
  );
}

// ---- 归一化(fuzzy 第二层,只修「模型不可能看见的差异」) ----

/**
 * 行归一化:NFKC(全角/兼容字符)→ 智能引号/Unicode 破折号/特殊空格 → ASCII、
 * 零宽字符剔除 → trimEnd(行尾空白)。只用于匹配空间,绝不写回文件。
 */
function normalizeLine(line: string): string {
  return line
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")   // 智能单引号
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')   // 智能双引号
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-') // 连字符、en/em dash、水平条、减号
    .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ')  // NBSP 与各类宽度空格(多数已被 NFKC 覆盖,此处兜底)
    .replace(/[\u200B\u200C\u200D\uFEFF]/g, '')           // 零宽字符剔除
    .trimEnd();
}

// ---- 行索引与匹配 ----

interface LineIndex {
  lines: string[]; // 结尾换行不产生幽灵空行(与 shared/truncate 的行数直觉一致)
  starts: number[]; // 每行首字符在 work 中的偏移
}

function buildLineIndex(work: string): LineIndex {
  const lines = work.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const starts: number[] = [];
  let off = 0;
  for (const line of lines) {
    starts.push(off);
    off += line.length + 1;
  }
  return { lines, starts };
}

/** 非重叠精确匹配的全部起始偏移。 */
function findAllExact(haystack: string, needle: string): number[] {
  const hits: number[] = [];
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) break;
    hits.push(i);
    from = i + needle.length;
  }
  return hits;
}

/** 归一化空间按行匹配(非重叠),返回起始行号列表。 */
function findFuzzyMatches(normFileLines: string[], normOldLines: string[]): number[] {
  const hits: number[] = [];
  const n = normOldLines.length;
  let i = 0;
  while (i + n <= normFileLines.length) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (normFileLines[i + j] !== normOldLines[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      hits.push(i);
      i += n;
    } else {
      i++;
    }
  }
  return hits;
}

interface Range {
  start: number;
  end: number;
  text: string;
}

/**
 * fuzzy 命中的行区间 → work 中的字符区间(行 overlay:只覆盖被触及的行,
 * 未触碰行保留原始字节)。oldText 带结尾换行时区间含末行换行符。
 */
function fuzzyRange(
  work: string,
  idx: LineIndex,
  startLine: number,
  lineCount: number,
  oldHadTrailingNewline: boolean,
  newText: string,
): Range {
  const start = idx.starts[startLine] as number;
  const lastLine = startLine + lineCount - 1;
  const end = oldHadTrailingNewline
    ? lastLine + 1 < idx.lines.length
      ? (idx.starts[lastLine + 1] as number)
      : work.length
    : (idx.starts[lastLine] as number) + (idx.lines[lastLine] as string).length;
  return { start, end, text: newText };
}

/** oldText 拆行:结尾换行是行终止符而非空行(与 buildLineIndex 同一约定)。 */
function splitOldText(oldText: string): { lines: string[]; hadTrailingNewline: boolean } {
  const lines = oldText.split('\n');
  const hadTrailingNewline = lines.length > 1 && lines[lines.length - 1] === '';
  if (hadTrailingNewline) lines.pop();
  return { lines, hadTrailingNewline };
}

/**
 * 单条 edit → 替换区间列表。两层匹配(精确 indexOf → 归一化按行),唯一性检查
 * 在两层空间各自执行;到此为止,不做编辑距离/相似度。
 */
function resolveEdit(
  work: string,
  idx: LineIndex,
  normFileLines: string[],
  edit: { oldText: string; newText: string; replaceAll: boolean },
  pathLabel: string,
): Range[] {
  // 第一层:精确匹配,命中即用
  const exact = findAllExact(work, edit.oldText);
  if (exact.length > 0) {
    if (exact.length > 1 && !edit.replaceAll) throw new Error(msgOccurrences(exact.length, pathLabel));
    return exact.map((start) => ({ start, end: start + edit.oldText.length, text: edit.newText }));
  }
  // 第二层:归一化空间按行匹配
  const old = splitOldText(edit.oldText);
  const normOldLines = old.lines.map(normalizeLine);
  // 纯空白 oldText(归一化后全为空行)禁止进 fuzzy:否则会静默命中文件里任意空行区
  if (normOldLines.every((line) => line === '')) throw new Error(msgNotFound(pathLabel));
  const fuzzy = findFuzzyMatches(normFileLines, normOldLines);
  if (fuzzy.length === 0) throw new Error(msgNotFound(pathLabel));
  if (fuzzy.length > 1 && !edit.replaceAll) throw new Error(msgOccurrences(fuzzy.length, pathLabel));
  return fuzzy.map((line) =>
    fuzzyRange(work, idx, line, old.lines.length, old.hadTrailingNewline, edit.newText),
  );
}

// ---- diff 统计 ----

function countDiffLines(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  for (const line of diff.split('\n')) {
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

// ---- raw ↔ work 偏移映射(混合行尾文件的未触碰字节逐字节保留) ----

/**
 * raw → LF 匹配空间 work。crlfNewlines 记录每个源自 CRLF 的 '\n' 在 work 中的偏移,
 * 供 workToRawOffset 把匹配区间映射回 raw——写回时只替换被触碰区间,其余字节
 * (含各行自己的行尾)原样保留,不做全文行尾统一。
 */
function buildWorkSpace(raw: string): { work: string; crlfNewlines: number[] } {
  const crlfNewlines: number[] = [];
  if (!raw.includes('\r\n')) return { work: raw, crlfNewlines };
  const chunks: string[] = [];
  let rawPos = 0;
  let workLen = 0;
  for (;;) {
    const j = raw.indexOf('\r\n', rawPos);
    if (j === -1) {
      chunks.push(raw.slice(rawPos));
      break;
    }
    chunks.push(raw.slice(rawPos, j), '\n');
    workLen += j - rawPos;
    crlfNewlines.push(workLen);
    workLen += 1;
    rawPos = j + 2;
  }
  return { work: chunks.join(''), crlfNewlines };
}

/**
 * work 偏移 → raw 偏移:加上此前(< workOffset)出现过的 CRLF 个数。
 * 恰指向 CRLF 产生的 '\n' 时返回 '\r' 的位置:区间含该换行则 CRLF 整对被替换,
 * 区间止于该换行则 CRLF 整对完整保留。
 */
function workToRawOffset(workOffset: number, crlfNewlines: number[]): number {
  let lo = 0;
  let hi = crlfNewlines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((crlfNewlines[mid] as number) < workOffset) lo = mid + 1;
    else hi = mid;
  }
  return workOffset + lo;
}

function countNewlines(s: string): number {
  let n = 0;
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) n++;
  return n;
}

// ---- 工具本体 ----

const BOM = new Uint8Array([0xef, 0xbb, 0xbf]);
const UTF8_DECODER = new TextDecoder();
const UTF8_ENCODER = new TextEncoder();

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error(MSG_ABORTED);
}

export const EDIT_DESCRIPTION =
  'Replace exact text in an existing file. Each oldText must match the current file content ' +
  'exactly (including whitespace and indentation) and must be unique unless replaceAll is set. ' +
  'Prefer this tool over write for modifying existing files.';

export const EDIT_PROMPT_SNIPPET =
  'Before editing a file, read it in the current session first. When composing oldText from ' +
  'read output, strip the `N: ` line-number prefixes — copy the content verbatim otherwise.';

// zod 校验前的无损结构修补:只做结构搬运,不猜语义。
export function prepareEditArguments(raw: unknown): unknown {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const obj: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
    // 高频畸形 1:edits 数组被发成 JSON 字符串
    if (typeof obj.edits === 'string') {
      try {
        obj.edits = JSON.parse(obj.edits);
      } catch {
        // 解析失败保留原样,交给 zod 生成可恢复错误。
      }
    }
    // 高频畸形 2:模型把 oldText/newText 平铺在顶层
    if (!obj.edits && obj.oldText !== undefined) {
      return {
        path: obj.path,
        edits: [{ oldText: obj.oldText, newText: obj.newText, replaceAll: obj.replaceAll }],
      };
    }
    return obj;
}

export async function executeEdit(
  call: ToolExecutionInput<EditArgs>,
  ctx: ToolContext,
): Promise<ToolOutput<EditDetails>> {
    const args = call.args;
    const absPath = path.resolve(ctx.cwd, args.path);

    // 同路径写操作串行化;abort 由每个 await 后的显式检查负责(docs/07 §4)
    return withPathLock(absPath, async () => {
      throwIfAborted(ctx.signal);

      // 与文件内容无关的不变量先拦;oldText/newText 统一 CRLF→LF(模型偶发 CRLF 防御)
      const edits = args.edits.map((e) => ({
        oldText: e.oldText.replaceAll('\r\n', '\n'),
        newText: e.newText.replaceAll('\r\n', '\n'),
        replaceAll: e.replaceAll ?? false,
      }));
      for (const e of edits) {
        if (e.oldText.length === 0) throw new Error(MSG_EMPTY_OLD_TEXT);
        if (e.oldText === e.newText) throw new Error(MSG_IDENTICAL);
      }

      let st: Stats;
      try {
        st = await stat(absPath);
      } catch (err) {
        if ((err as { code?: string }).code === 'ENOENT') {
          throw new Error(`File not found: ${args.path}. Use the write tool to create a new file.`);
        }
        throw err;
      }
      throwIfAborted(ctx.signal);
      if (st.isDirectory()) throw new Error(`Cannot edit a directory: ${args.path}`);

      // read-before-edit 硬约束。
      const fresh = ctx.fileTracker.assertFresh(absPath, st.mtimeMs);
      if (!fresh.ok) throw new Error(fresh.reason === 'never_read' ? MSG_NEVER_READ : MSG_STALE);

      const buf = await Bun.file(absPath).bytes();
      throwIfAborted(ctx.signal);

      // BOM/CRLF 三步之一:剥 BOM + CRLF→LF,匹配替换全在 LF 空间进行;
      // 同时记录 CRLF 位置,写回时把 work 区间映射回 raw 区间(混合行尾安全)
      const hadBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
      const raw = UTF8_DECODER.decode(buf.subarray(hadBom ? 3 : 0));
      const { work, crlfNewlines } = buildWorkSpace(raw);

      // 多 edit 语义:所有 oldText 对原始内容匹配 → 重叠报错 → 按 offset 逆序应用;
      // 任何一条失败在落盘前 throw,整体不落盘(原子性)
      const idx = buildLineIndex(work);
      const normFileLines = idx.lines.map(normalizeLine);
      const ranges: Range[] = [];
      for (const e of edits) {
        ranges.push(...resolveEdit(work, idx, normFileLines, e, args.path));
      }
      const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
      for (let i = 1; i < sorted.length; i++) {
        if ((sorted[i] as Range).start < (sorted[i - 1] as Range).end) {
          throw new Error(msgOverlap(args.path));
        }
      }
      let next = work;
      for (let i = sorted.length - 1; i >= 0; i--) {
        const r = sorted[i] as Range;
        next = next.slice(0, r.start) + r.text + next.slice(r.end);
      }

      // BOM/CRLF 三步之三:work 区间映射回 raw 就地替换——未触碰字节(含各行
      // 自己的行尾)逐字节保留;替换文本内部的换行取文件多数行尾风格
      // (全 CRLF 文件即 CRLF,与旧行为一致);写回补 BOM
      const crlfCount = crlfNewlines.length;
      const preferCrlf = crlfCount > 0 && crlfCount * 2 > countNewlines(work);
      let patched = raw;
      for (let i = sorted.length - 1; i >= 0; i--) {
        const r = sorted[i] as Range;
        const text = preferCrlf ? r.text.replaceAll('\n', '\r\n') : r.text;
        patched =
          patched.slice(0, workToRawOffset(r.start, crlfNewlines)) +
          text +
          patched.slice(workToRawOffset(r.end, crlfNewlines));
      }
      const encoded = UTF8_ENCODER.encode(patched);
      const outBuf = hadBom ? concatBytes(BOM, encoded) : encoded;
      throwIfAborted(ctx.signal);
      await Bun.write(absPath, outBuf);

      // 成功后刷新登记:自己的写不算外部修改
      const st2 = await stat(absPath);
      ctx.fileTracker.markRead(absPath, st2.mtimeMs);

      // diff 进 details 供 UI/审批渲染,不回喂模型(省 token)
      const diff = createTwoFilesPatch(args.path, args.path, work, next);
      const { additions, deletions } = countDiffLines(diff);
      return {
        content: [{ type: 'text', text: `Applied ${args.edits.length} edit(s) to ${args.path}` }],
        details: { diff, additions, deletions },
      };
    });
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.length + right.length);
  out.set(left);
  out.set(right, left.length);
  return out;
}
