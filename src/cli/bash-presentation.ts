// Bash 工具的紧凑展示投影：提取命令、做轻量 shell 高亮，并将输出压缩为首尾预览。
// 这里不承载执行状态或完整转录；调用方仍以 Runtime 的 ToolResult 为权威事实。

export type BashTokenTone =
  | 'normal'
  | 'command'
  | 'flag'
  | 'string'
  | 'operator'
  | 'comment';

export interface BashToken {
  readonly text: string;
  readonly tone: BashTokenTone;
}

export interface BashCommandLayout {
  /** Header 的命令片段在首行，其余项应以前缀续行。 */
  readonly lines: readonly (readonly BashToken[])[];
  /** 超过续行上限时，附加的省略行所代表的命令行数。 */
  readonly omittedContinuationLines: number | undefined;
}

export interface BashOutputPreview {
  readonly lines: readonly string[];
  readonly omittedLines: number | undefined;
}

export const BASH_OUTPUT_PREVIEW_MAX_LINES = 5;
export const BASH_OUTPUT_PREVIEW_HEAD_LINES = 2;
export const BASH_COMMAND_CONTINUATION_MAX_LINES = 2;

const BASH_GRAPHEME_SEGMENTER = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('en', { granularity: 'grapheme' })
  : undefined;

function bashGraphemes(value: string): readonly string[] {
  return BASH_GRAPHEME_SEGMENTER === undefined
    ? [...value]
    : [...BASH_GRAPHEME_SEGMENTER.segment(value)].map((segment) => segment.segment);
}

/** 从未信任的工具参数中提取 bash command；调用方负责再做终端控制符清洗。 */
export function bashCommandFromArgs(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const command = (args as Record<string, unknown>)['command'];
  return typeof command === 'string' ? command : undefined;
}

/**
 * 不试图完整解析 bash，而是覆盖 CLI 呈现需要的稳定语义：可执行文件、flag、引号字符串、
 * shell 分隔符和注释。命令实际执行仍完全由 bash 工具负责。
 */
export function highlightBashCommand(command: string): readonly BashToken[] {
  const tokens: BashToken[] = [];
  let index = 0;
  let expectsCommand = true;

  const push = (text: string, tone: BashTokenTone): void => {
    if (text === '') return;
    const previous = tokens.at(-1);
    if (previous?.tone === tone) {
      tokens[tokens.length - 1] = { text: `${previous.text}${text}`, tone };
    } else {
      tokens.push({ text, tone });
    }
  };

  while (index < command.length) {
    const character = command[index] ?? '';
    if (character === '\r') {
      if (command[index + 1] === '\n') index++;
      push('\n', 'normal');
      expectsCommand = true;
      index++;
      continue;
    }
    if (character === '\n') {
      push(character, 'normal');
      expectsCommand = true;
      index++;
      continue;
    }
    if (/\s/u.test(character)) {
      const start = index;
      while (index < command.length) {
        const next = command[index] ?? '';
        if (next === '\n' || next === '\r' || !/\s/u.test(next)) break;
        index++;
      }
      push(command.slice(start, index), 'normal');
      continue;
    }
    if (character === '#' && (index === 0 || /\s/u.test(command[index - 1] ?? ''))) {
      const end = command.indexOf('\n', index);
      const comment = end === -1 ? command.slice(index) : command.slice(index, end);
      push(comment, 'comment');
      index += comment.length;
      continue;
    }
    if (character === '\'' || character === '"') {
      const quote = character;
      const start = index++;
      while (index < command.length) {
        const next = command[index] ?? '';
        if (next === '\\' && quote === '"' && index + 1 < command.length) {
          index += 2;
          continue;
        }
        index++;
        if (next === quote) break;
      }
      push(command.slice(start, index), 'string');
      continue;
    }
    if (';&|><()'.includes(character)) {
      const start = index++;
      while (index < command.length && ';&|><'.includes(command[index] ?? '')) index++;
      push(command.slice(start, index), 'operator');
      expectsCommand = character !== ')';
      continue;
    }

    const start = index;
    while (index < command.length) {
      const next = command[index] ?? '';
      if (/\s/u.test(next) || next === '\n' || next === '\r' || '\'";&|><()'.includes(next)) break;
      index++;
    }
    const word = command.slice(start, index);
    if (word === '') {
      // 防御未知 Unicode 分隔符导致的零进度；以普通文本保留，而不是吞掉命令内容。
      push(character, 'normal');
      index++;
      continue;
    }
    const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/u.test(word);
    const tone: BashTokenTone = word.startsWith('-')
      ? 'flag'
      : expectsCommand && !assignment
        ? 'command'
        : 'normal';
    push(word, tone);
    if (!assignment) expectsCommand = false;
  }
  return tokens;
}

/**
 * 按可显示宽度将已高亮命令拆成 header 和最多两行 continuation。
 * 词间空白会在换行处丢弃，超长单词则按字符切开，保证每行都有进度。
 */
export function layoutBashCommand(
  command: string,
  firstLineWidth: number,
  continuationLineWidth: number,
  measureWidth: (value: string) => number,
  continuationLimit = BASH_COMMAND_CONTINUATION_MAX_LINES,
): BashCommandLayout {
  const firstWidth = Math.max(1, firstLineWidth);
  const continuationWidth = Math.max(1, continuationLineWidth);
  const source = highlightBashCommand(command);
  const lines: BashToken[][] = [];
  let current: BashToken[] = [];
  let currentWidth = 0;

  const capacity = (): number => lines.length === 0 ? firstWidth : continuationWidth;
  const pushToken = (text: string, tone: BashTokenTone): void => {
    if (text === '') return;
    const previous = current.at(-1);
    if (previous?.tone === tone) {
      current[current.length - 1] = { text: `${previous.text}${text}`, tone };
    } else {
      current.push({ text, tone });
    }
    currentWidth += measureWidth(text);
  };
  const trimEnd = (): void => {
    while (current.length > 0) {
      const lastIndex = current.length - 1;
      const last = current[lastIndex];
      if (last === undefined) break;
      const trimmed = last.text.replace(/\s+$/u, '');
      if (trimmed === last.text) break;
      currentWidth -= measureWidth(last.text) - measureWidth(trimmed);
      if (trimmed === '') current.pop();
      else current[lastIndex] = { ...last, text: trimmed };
    }
  };
  const finishLine = (force = false): void => {
    trimEnd();
    if (current.length > 0 || force) lines.push(current);
    current = [];
    currentWidth = 0;
  };
  const appendLongToken = (text: string, tone: BashTokenTone): void => {
    let remaining = text;
    while (remaining !== '') {
      const available = Math.max(1, capacity() - currentWidth);
      let taken = '';
      for (const grapheme of bashGraphemes(remaining)) {
        const candidate = `${taken}${grapheme}`;
        if (taken !== '' && measureWidth(candidate) > available) break;
        taken = candidate;
        if (measureWidth(taken) >= available) break;
      }
      if (taken === '') {
        finishLine();
        continue;
      }
      pushToken(taken, tone);
      remaining = remaining.slice(taken.length);
      if (remaining !== '') finishLine();
    }
  };
  const appendWord = (text: string, tone: BashTokenTone): void => {
    const wordWidth = measureWidth(text);
    if (currentWidth > 0 && currentWidth + wordWidth > capacity()) finishLine();
    if (wordWidth > capacity() - currentWidth) appendLongToken(text, tone);
    else pushToken(text, tone);
  };

  for (const token of source) {
    const pieces = token.text.split(/(\n|[\t ]+)/u);
    for (const piece of pieces) {
      if (piece === '') continue;
      if (piece === '\n') {
        finishLine(true);
        continue;
      }
      if (/^[\t ]+$/u.test(piece)) {
        if (currentWidth > 0 && currentWidth + measureWidth(piece) <= capacity()) {
          pushToken(piece, token.tone);
        }
        continue;
      }
      appendWord(piece, token.tone);
    }
  }
  finishLine(lines.length === 0);

  const continuationLines = Math.max(0, lines.length - 1);
  const allowedLines = 1 + Math.max(0, continuationLimit);
  if (lines.length <= allowedLines) {
    return { lines, omittedContinuationLines: undefined };
  }
  const omitted = continuationLines - continuationLimit;
  const fullMarker = `… +${omitted} command line${omitted === 1 ? '' : 's'}`;
  const marker = [fullMarker, `… +${omitted}`, `+${omitted}`, '…']
    .find((candidate) => measureWidth(candidate) <= continuationWidth) ?? '…';
  return {
    lines: [
      ...lines.slice(0, allowedLines),
      [{ text: marker, tone: 'comment' }],
    ],
    omittedContinuationLines: omitted,
  };
}

/**
 * 输出保持首两行和末两行，中间以一行省略提示替代；尾部 bash 状态行由状态点表达，
 * 因而不重复显示 `exit code N`。
 */
export function previewBashOutput(
  output: string,
  maxLines = BASH_OUTPUT_PREVIEW_MAX_LINES,
): BashOutputPreview {
  const lines = splitOutputLines(output);
  if (lines.at(-1) !== undefined && /^exit code \d+$/u.test(lines.at(-1) ?? '')) lines.pop();
  if (lines.length <= maxLines) return { lines, omittedLines: undefined };

  const head = Math.min(BASH_OUTPUT_PREVIEW_HEAD_LINES, Math.floor((maxLines - 1) / 2));
  const tail = Math.max(1, maxLines - head - 1);
  return {
    lines: [...lines.slice(0, head), ...lines.slice(-tail)],
    omittedLines: lines.length - head - tail,
  };
}

export function bashOutputEllipsis(omittedLines: number): string {
  return `… +${omittedLines} lines (use /review to view output)`;
}

function splitOutputLines(output: string): string[] {
  const normalized = output.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  if (normalized === '') return [];
  const lines = normalized.split('\n');
  if (normalized.endsWith('\n')) lines.pop();
  return lines;
}
