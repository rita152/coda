// resume 会话选择器(规格见 docs/09-cli.md §2):`coda --resume` 无 id 时列出会话
// (编号 + id + 时间 + 首条 prompt 摘要)供选择。列表与提问全部走 stderr——
// stdout 是内容通道(-p 输出 / NDJSON),选择器绝不污染它。
// 非 TTY 或空列表返回 undefined(列表仍打到 stderr 供查看)。

import { createInterface } from 'node:readline/promises';
import process from 'node:process';
import type { SessionListItem } from '../session/index.js';
import { sanitizeTerminalLine } from './terminal-sanitize.js';

/** 测试注入口:缺省用 process.stdin / process.stderr。 */
export interface ResumePickerIO {
  input?: NodeJS.ReadableStream & { isTTY?: boolean };
  output?: NodeJS.WritableStream;
}

export async function pickSessionInteractive(
  sessions: SessionListItem[],
  io?: ResumePickerIO,
): Promise<string | undefined> {
  const input = io?.input ?? process.stdin;
  const output = io?.output ?? process.stderr;

  if (sessions.length === 0) {
    output.write('[coda] no sessions found\n');
    return undefined;
  }

  const listing = sessions
    .map((s, i) =>
      `  [${i + 1}] ${sanitizeTerminalLine(s.id)}  ${formatTime(s.createdAt)}  ` +
      sanitizeTerminalLine(s.title))
    .join('\n');
  output.write(`[coda] sessions:\n${listing}\n`);

  if (input.isTTY !== true) return undefined; // 非 TTY 无法交互:列表仅供查看

  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question('[coda] resume which session? (number or id, Enter to cancel) ')).trim();
    if (answer.length === 0) return undefined;
    const n = Number.parseInt(answer, 10);
    if (Number.isInteger(n) && String(n) === answer && n >= 1 && n <= sessions.length) {
      return sessions[n - 1]?.id;
    }
    return sessions.find((s) => s.id === answer)?.id; // 直接输入 id 也接受;无匹配即取消
  } catch {
    return undefined; // EOF / 中断:视同取消
  } finally {
    rl.close();
  }
}

function formatTime(ts: number): string {
  // 固定 ISO 派生格式(免 locale 抖动):YYYY-MM-DD HH:mm
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 16);
}
