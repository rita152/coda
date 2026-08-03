// 渲染器(规格见 docs/09-cli.md §1.3/§4/§5):把 SessionEvent 翻译成终端像素。
// 渲染模型:append-only 转录区 + 底部动态区(interactive 时,\x1b[<n>F\x1b[J 整体重绘,
// 3–4 行:流式尾行/分隔线/活动行+队列徽标/输入行);非交互(非 TTY / -p)走 plain 模式
// (纯追加);color 独立控制 SGR 着色——NO_COLOR 只禁着色不禁光标控制(docs/09 §1.3)。
// 单写入者纪律:stdout 只有本 Renderer 写(§1.3)——repl 的输入行/状态提示也经由这里落屏。
// 动态区数学不变量:物理转录只含完整行(以 \n 收尾),流式中的未完行缓冲为动态区首行,
// 因此 \x1b[<n>F 的行数恒等于上次绘制的动态行数,无需列跟踪;前提是动态行物理不换行,
// 故动态区文本一律先经 sanitizeDynText 清洗 \t/\r 再量宽截断。

import type {
  AgentMessage,
  AssistantMessage,
  ProviderEvent,
  ToolCallPart,
  ToolResultMessage,
  UserMessage,
} from '../protocol/index.js';
import type {
  CliSessionEvent as SessionEvent,
  CliSessionUsage as SessionUsage,
} from './frontend-types.js';
import {
  explorationCall,
  explorationRows,
} from './exploration.js';
import type { ExplorationCall } from './exploration.js';
import {
  bashCommandFromArgs,
  bashOutputEllipsis,
  layoutBashCommand,
  previewBashOutput,
} from './bash-presentation.js';
import type { BashToken, BashTokenTone } from './bash-presentation.js';
import {
  formatPlanProgress,
  layoutPlan,
} from './plan-presentation.js';
import { sanitizeTerminalLine, sanitizeTerminalText } from './terminal-sanitize.js';

export interface RendererOptions {
  color: boolean;
  interactive: boolean;
  /** Replace coda-owned status chrome with portable ASCII; user/model payload remains Unicode. */
  ascii?: boolean;
}

export interface Renderer {
  render(e: SessionEvent): void;
  replayTranscript(messages: readonly AgentMessage[]): void;
  /** 等待此前渲染排队的 stdout 内容；Session listener 用它施加有序背压。 */
  drain(): Promise<void>;
  // ---- 以下为 repl 专用扩展(main.ts 不感知;plain 模式下多为 no-op)----
  /** 输入行内容进动态区(repl 管键位与输入状态,渲染归这里)。 */
  setInputLine?(text: string, cursor?: number): void;
  /** 临时状态提示(如「再按一次 Ctrl+C 退出」);undefined 清除。 */
  setStatus?(text: string | undefined): void;
  /** Runtime approval presentation freezes whether the permanent-scope action exists. */
  setApprovalAllowsAlways?(available: boolean): void;
  /** Replace the active approval prompt without appending another transcript entry. */
  setApprovalRequest?(request: {
    readonly description: string;
    readonly allowAlways: boolean;
  } | undefined): void;
  /** 转录区追加一行(斜杠命令 /status /queue /help 的输出)。 */
  println?(text: string): void;
  /** 进入交互:开 bracketed paste(\x1b[?2004h)并首绘动态区。 */
  mount?(): void;
  /** 退出交互:清动态区、关 bracketed paste。 */
  unmount?(): void;
  /** SIGWINCH 重绘动态区(转录区 append-only 不回改,docs/09 §8)。 */
  redraw?(): void;
}

// ---- SGR 代码 ----
const RESET = '\x1b[0m';
const BOLD = '1';
const DIM = '2';
const DIM_ITALIC = '2;3';
const DIM_STRIKETHROUGH = '2;9';
const RED = '31';
const GREEN = '32';
const BLUE = '34';
const YELLOW = '33';
const CYAN = '36';
const CYAN_BOLD = '1;36';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const DIFF_MAX_LINES = 40; // docs/09 §4:diff 渲染上限
const WORKING_SUMMARY_MAX_CODE_UNITS = 4_096;
const PASTE_ON = '\x1b[?2004h';
const PASTE_OFF = '\x1b[?2004l';

// ---- 简化 wcwidth(docs/09 §8:动态区截断按显示宽度而非 code unit)----

export function charWidth(cp: number): number {
  if (cp === 0x200d) return 0; // ZWJ
  if (cp >= 0x0300 && cp <= 0x036f) return 0; // combining marks
  if (cp === 0xfe0f) return 0; // variation selector
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK 部首/汉字/假名
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul 音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) || // 全角形式
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji 主区
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

export function displayWidth(s: string): number {
  let w = 0;
  for (const grapheme of graphemes(s)) w += graphemeWidth(grapheme);
  return w;
}

/** 头部截断到显示宽度(超出以 … 收尾)。 */
export function truncateToWidth(s: string, max: number): string {
  if (displayWidth(s) <= max) return s;
  let w = 0;
  let out = '';
  for (const ch of graphemes(s)) {
    const cw = graphemeWidth(ch);
    if (w + cw > max - 1) break; // 给 … 留 1 列
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

/**
 * 动态区文本清洗(docs/09 §1.3 动态区数学不变量):\x1b[<n>F 重绘依赖「每个动态行
 * 物理不换行」,而 \t 由终端展开到制表位(物理宽度 1–8 列,charWidth 只记 1)、\r 拉回
 * 列首——任一出现都会让 clearDyn 的上移行数失准,残片永久污染转录区。因此动态区文本
 * 在截断/量宽之前统一清洗:\t → 固定 2 空格、\r 剥除。转录区 append 保留原文不清洗。
 */
export function sanitizeDynText(s: string): string {
  return s.replaceAll('\t', '  ').replaceAll('\r', '');
}

/** 尾部截断:保留末端(流式尾行/输入行要看最新内容)。 */
export function tailToWidth(s: string, max: number): string {
  if (displayWidth(s) <= max) return s;
  const chars = graphemes(s);
  let w = 0;
  let start = chars.length;
  for (let i = chars.length - 1; i >= 0; i--) {
    const cw = graphemeWidth(chars[i] ?? '');
    if (w + cw > max - 1) break;
    w += cw;
    start = i;
  }
  return `…${chars.slice(start).join('')}`;
}

export interface ClassicInputLayout {
  readonly lines: readonly string[];
  readonly cursorRow: number;
  readonly cursorColumn: number;
}

/** Multiline classic composer layout with a cursor-bearing window around the active row. */
export function layoutClassicInput(
  text: string,
  cursor: number,
  width: number,
  maxRows = 8,
): ClassicInputLayout {
  // Render and measure the exact same representation. A tab occupies two cells in the
  // classic dynamic area, so expand it before wrapping and cursor-offset mapping.
  const normalize = (value: string): string => sanitizeTerminalText(value).replaceAll('\t', '  ');
  const clean = normalize(text);
  const cleanCursor = normalize(text.slice(0, Math.max(0, cursor))).length;
  const terminalWidth = Math.max(4, width);
  const lines: string[] = [];
  const prefixes: string[] = [];
  let content = '';
  let contentWidth = 0;
  let sourceOffset = 0;
  let cursorRow = 0;
  let cursorColumn = 2;

  const startLine = (): void => {
    prefixes.push(lines.length === 0 ? '> ' : '  ');
    content = '';
    contentWidth = 0;
  };
  const finishLine = (): void => {
    const prefix = prefixes[lines.length] ?? (lines.length === 0 ? '> ' : '  ');
    lines.push(`${prefix}${content}`);
  };
  const captureCursor = (): void => {
    cursorRow = lines.length;
    const prefix = prefixes[lines.length] ?? (lines.length === 0 ? '> ' : '  ');
    cursorColumn = displayWidth(prefix) + contentWidth;
  };

  startLine();
  if (cleanCursor === 0) captureCursor();
  for (const token of graphemes(clean)) {
    if (sourceOffset === cleanCursor) captureCursor();
    if (token === '\n') {
      finishLine();
      sourceOffset += token.length;
      startLine();
      if (sourceOffset === cleanCursor) captureCursor();
      continue;
    }
    const tokenWidth = graphemeWidth(token);
    const available = terminalWidth - 2;
    if (content !== '' && contentWidth + tokenWidth > available) {
      finishLine();
      startLine();
      if (sourceOffset === cleanCursor) captureCursor();
    }
    content += token;
    contentWidth += tokenWidth;
    sourceOffset += token.length;
    if (sourceOffset === cleanCursor) captureCursor();
  }
  finishLine();

  const visibleRows = Math.max(1, maxRows);
  if (lines.length <= visibleRows) return { lines, cursorRow, cursorColumn };
  const start = Math.min(
    Math.max(0, cursorRow - Math.floor(visibleRows / 2)),
    lines.length - visibleRows,
  );
  return {
    lines: lines.slice(start, start + visibleRows),
    cursorRow: cursorRow - start,
    cursorColumn,
  };
}

const GRAPHEME_SEGMENTER = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('en', { granularity: 'grapheme' })
  : undefined;

function graphemes(value: string): string[] {
  return GRAPHEME_SEGMENTER === undefined
    ? [...value]
    : [...GRAPHEME_SEGMENTER.segment(value)].map((segment) => segment.segment);
}

function graphemeWidth(value: string): number {
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(value)) return 2;
  let width = 0;
  for (const character of value) width += charWidth(character.codePointAt(0) ?? 0);
  return width;
}

// ---- 工具头单行摘要(docs/09 §4 表:用 args 生成,不等结果)----

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function firstLine(s: string): string {
  const i = s.indexOf('\n');
  return i === -1 ? s : s.slice(0, i);
}

/** plan 工具返回 undefined(不渲染工具头,由 plan_update 负责)。 */
export function toolHeadline(name: string, args: unknown): string | undefined {
  const a = asRecord(args);
  switch (name) {
    case 'plan':
      return undefined;
    case 'bash': {
      const cmd = str(a['command']) ?? '';
      return `bash: ${truncateToWidth(firstLine(cmd), 80)}`;
    }
    case 'read': {
      const extras: string[] = [];
      if (typeof a['offset'] === 'number') extras.push(`offset=${a['offset']}`);
      if (typeof a['limit'] === 'number') extras.push(`limit=${a['limit']}`);
      return `read ${str(a['path']) ?? ''}${extras.length > 0 ? ` [${extras.join(' ')}]` : ''}`;
    }
    case 'edit': {
      const n = Array.isArray(a['edits']) ? a['edits'].length : 1;
      return `edit ${str(a['path']) ?? ''} (${n} edit${n === 1 ? '' : 's'})`;
    }
    case 'write':
      return `write ${str(a['path']) ?? ''}`;
    case 'grep': {
      const limit = typeof a['limit'] === 'number' ? ` (limit ${a['limit']})` : '';
      return `grep "${str(a['pattern']) ?? ''}" ${str(a['path']) ?? ''}${limit}`.trimEnd();
    }
    case 'glob':
      return `glob ${str(a['pattern']) ?? ''} ${str(a['path']) ?? ''}`.trimEnd();
    case 'ls':
      return `ls ${str(a['path']) ?? '.'}`;
    default: {
      let json = '';
      try {
        json = JSON.stringify(args) ?? '';
      } catch {
        json = '';
      }
      return `${name} ${truncateToWidth(json, 60)}`.trimEnd();
    }
  }
}

// ---- Renderer 实现 ----

export interface RendererOutput {
  enqueue(chunk: string): void;
  drain(): Promise<void>;
  columns?: number;
}

interface ActiveExplorationCall {
  readonly call: ExplorationCall;
  readonly group: ExplorationGroup;
  result?: ToolResultMessage;
}

interface ExplorationGroup {
  readonly calls: ActiveExplorationCall[];
  sealed: boolean;
  rendered: boolean;
}

interface ActiveBashCall {
  readonly command: string;
}

export function createRenderer(out: RendererOutput, opts: RendererOptions): Renderer {
  const color = opts.color;
  const ascii = opts.ascii === true;
  const glyph = {
    rule: ascii ? '-' : '─',
    idle: ascii ? '.' : '·',
    followUp: ascii ? '->' : '↪',
    steering: ascii ? '>>' : '»',
    explored: ascii ? '*' : '•',
    exploredBranch: ascii ? '\\' : '└',
    tool: ascii ? '*' : '●',
    success: ascii ? '[ok]' : '✓',
    failure: ascii ? '[x]' : '✗',
    fatal: ascii ? '[x]' : '✖',
    warning: ascii ? '[!]' : '⚠',
    retry: ascii ? '[retry]' : '↻',
    compact: ascii ? '[compact]' : '⋯',
    done: ascii ? '[done]' : '∙ done',
    aborted: ascii ? '[aborted]' : '∙ aborted',
    error: ascii ? '[error]' : '∙ ended with error',
    planDone: ascii ? '[x]' : '✔',
    planActive: ascii ? '[>]' : '▶',
    planPending: ascii ? '[ ]' : '○',
    replay: ascii ? '--' : '—',
  } as const;
  const separator = ascii ? ' | ' : ' · ';
  const spinnerFrames = ascii ? ['|', '/', '-', '\\'] : SPINNER_FRAMES;
  const productChrome = (value: string): string => ascii
    ? value
        .replaceAll(' · ', ' | ')
        .replaceAll('—', '--')
        .replaceAll('…', '...')
        .replaceAll('✓', '[ok]')
        .replaceAll('✔', '[x]')
        .replaceAll('✗', '[x]')
        .replaceAll('✖', '[x]')
        .replaceAll('⚠', '[!]')
        .replaceAll('▶', '[>]')
        .replaceAll('○', '[ ]')
        .replaceAll('↻', '[retry]')
        .replaceAll('⋯', '[compact]')
    : value;
  // interactive(光标控制/动态区重绘)与 color(SGR 着色)解耦:\x1b[F/\x1b[J 是光标
  // 控制不是着色,NO_COLOR 规范只禁 SGR——无 color 的交互终端仍需动态区,否则 raw mode
  // 下输入行不可见。非交互(非 TTY / -p)→ plain 纯追加(docs/09 §1.3)。
  const ansi = opts.interactive;

  // 动态区状态
  let dynRows = 0;
  let input: string | undefined; // undefined = repl 未接管(-p 模式无输入行)
  let inputCursor = 0;
  let cursorPlacement: { row: number; column: number } | undefined;
  let cursorRowsAboveBottom = 0;
  let status: string | undefined;
  let approvalPrompt: string | undefined; // M6 审批提示(docs/09 §4:动态区变审批提示行)
  let approvalDescription: string | undefined;
  let activity: string | undefined;
  let activityTail: string | undefined; // 工具流式输出尾行
  let steerCount = 0;
  let followCount = 0;
  let running = false;
  let spin = 0;

  // 流式状态
  let pending = ''; // ansi:未完行缓冲(动态区首行);plain 不用
  let pendingKind: 'text' | 'reasoning' = 'text';
  let midLine = false; // plain:当前物理行未收尾
  let usage: SessionUsage | undefined;
  const reasoningSummaries = new Map<number, string>();
  const toolStartedAt = new Map<string, number>();
  const explorationGroups = new Set<ExplorationGroup>();
  let activeExplorationGroup: ExplorationGroup | undefined;
  const startedExplorationCalls = new Map<string, ActiveExplorationCall>();
  const startedBashCalls = new Map<string, ActiveBashCall>();
  // classic/plain 没有 TUI 的 HistoryCell 容器；以这两个标记复现「独立工具块前一行空白、
  // 同一调用的结果/diff 紧贴」的排版节奏。
  const visibleToolStarts = new Set<string>();
  let hasTranscriptContent = false;
  let lastTranscriptLineWasBlank = false;

  const write = (s: string): void => {
    out.enqueue(s);
  };
  const paint = (s: string, code: string): string => (color ? `\x1b[${code}m${s}${RESET}` : s);
  const width = (): number => (typeof out.columns === 'number' && out.columns > 0 ? out.columns : 80);

  function clearDyn(): void {
    if (cursorRowsAboveBottom > 0) {
      write(`\x1b[${cursorRowsAboveBottom}B\r`);
      cursorRowsAboveBottom = 0;
    }
    if (dynRows > 0) {
      write(`\x1b[${dynRows}F\x1b[J`);
      dynRows = 0;
    }
  }

  function composeDynLines(): string[] {
    const w = width();
    const lines: string[] = [];
    if (pending !== '') {
      // 清洗必须先于截断:\t → 2 空格改变显示宽度,截断后再清洗会破坏宽度上限
      const tail = tailToWidth(sanitizeDynText(pending), w - 1);
      lines.push(pendingKind === 'reasoning' ? paint(tail, DIM_ITALIC) : tail);
    }
    lines.push(paint(glyph.rule.repeat(Math.min(w - 1, 60)), DIM));
    // 活动行 + 队列徽标(docs/09 §5:同一行,两队列皆空时徽标不显示)
    const activityGlyph = running
      ? (spinnerFrames[spin % spinnerFrames.length] ?? (ascii ? '|' : '⠋'))
      : glyph.idle;
    spin++;
    // 优先级:临时状态提示 > 审批提示(键位已切审批模式,提示必须在场)> 常规活动行
    const approval = approvalPrompt !== undefined ? paint(approvalPrompt, YELLOW) : undefined;
    let act = status ?? approval ?? (running ? (activity ?? (ascii ? 'streaming...' : 'streaming…')) : 'idle');
    if (status === undefined && approval === undefined && activityTail !== undefined) {
      act += `  ${activityTail}`;
    }
    let line = `${activityGlyph} ${sanitizeDynText(act)}`;
    if (steerCount > 0 || followCount > 0) {
      line += `  ${paint(`[steer ${steerCount}${separator}follow-up ${followCount}]`, CYAN)}`;
    }
    if (usage !== undefined) {
      line += `  ${paint(`${usage.cumulative.input + usage.cumulative.output} tok`, DIM)}`;
    }
    lines.push(truncVisible(line, w - 1));
    cursorPlacement = undefined;
    if (input !== undefined) {
      const layout = layoutClassicInput(input, inputCursor, w - 1);
      const startRow = lines.length;
      lines.push(...layout.lines);
      cursorPlacement = {
        row: startRow + layout.cursorRow,
        column: layout.cursorColumn,
      };
    }
    return lines;
  }

  /** 含 ANSI 的行按可见宽度截断:超出时退化为剥色截断(动态区不允许换行)。 */
  function truncVisible(line: string, max: number): string {
    const plainText = line.replace(/\x1b\[[0-9;]*m/g, '');
    if (displayWidth(plainText) <= max) return line;
    return truncateToWidth(plainText, max);
  }

  function drawDyn(): void {
    if (!ansi) return;
    const lines = composeDynLines();
    write(`${lines.join('\n')}\n`);
    dynRows = lines.length;
    if (cursorPlacement !== undefined) {
      cursorRowsAboveBottom = dynRows - cursorPlacement.row;
      write(
        `\x1b[${cursorRowsAboveBottom}A\r` +
          (cursorPlacement.column > 0 ? `\x1b[${cursorPlacement.column}C` : ''),
      );
    }
  }

  function redrawDyn(): void {
    if (!ansi) return;
    clearDyn();
    drawDyn();
  }

  /** 转录区追加一整行:先清动态区 → 追加 → 重绘(docs/09 §1.3 唯一稳妥顺序)。 */
  function appendLine(text: string): void {
    if (ansi) {
      clearDyn();
      write(`${text}\n`);
      drawDyn();
    } else {
      if (midLine) {
        write('\n');
        midLine = false;
      }
      write(`${text}\n`);
    }
    if (text !== '') hasTranscriptContent = true;
    lastTranscriptLineWasBlank = text === '';
  }

  function appendLines(text: string): void {
    for (const line of text.split('\n')) appendLine(line);
  }

  /** 对齐 Codex 的 cell inset：仅在不同工具调用开始前插入一行，而非逐输出行留白。 */
  function startToolBlock(): void {
    if (hasTranscriptContent && !lastTranscriptLineWasBlank) appendLine('');
  }

  function startExplorationCall(toolCallId: string, call: ExplorationCall): void {
    const group = activeExplorationGroup ?? {
      calls: [],
      sealed: false,
      rendered: false,
    };
    if (activeExplorationGroup === undefined) {
      activeExplorationGroup = group;
      explorationGroups.add(group);
    }
    const active: ActiveExplorationCall = { call, group };
    group.calls.push(active);
    startedExplorationCalls.set(toolCallId, active);
  }

  /**
   * classic/plain 是 append-only：边界只封存当前组，必须等组内每个并行调用都有
   * 结果后才能写 `Explored`。这避免 read 尚未完成时被非探索工具的 start 伪造成功。
   */
  function renderExplorationGroup(group: ExplorationGroup, allowIncomplete: boolean): void {
    if (group.rendered) return;
    const complete = group.calls.every((entry) => entry.result !== undefined);
    if (!complete && !allowIncomplete) return;
    group.rendered = true;
    explorationGroups.delete(group);
    startToolBlock();
    const failures = group.calls.filter((entry) => entry.result?.isError === true);
    const title = complete ? 'Explored' : 'Exploration incomplete';
    appendLine(
      `${paint(glyph.explored, DIM)} ${paint(title, BOLD)}` +
        (failures.length === 0
          ? ''
          : paint(`${separator}${failures.length} failed`, RED)),
    );
    const rows = explorationRows(group.calls.map((entry) => entry.call));
    for (const [index, row] of rows.entries()) {
      const prefix = index === 0 ? `  ${glyph.exploredBranch} ` : '    ';
      const target = sanitizeTerminalLine(row.target);
      appendLine(
        `${paint(prefix, DIM)}${paint(row.label, CYAN)}` +
          (target === '' ? '' : ` ${target}`),
      );
    }
    for (const entry of failures) {
      const result = entry.result;
      if (result === undefined) continue;
      const head = sanitizeTerminalLine(firstLine(bashResultText(result)));
      const target = sanitizeTerminalLine(entry.call.target);
      appendLine(paint(
        `  ${glyph.failure} ${entry.call.label}` +
          (target === '' ? '' : ` ${target}`) +
          (head === '' ? '' : `: ${truncateToWidth(head, 100)}`),
        RED,
      ));
    }
    for (const entry of group.calls) {
      if (entry.result !== undefined) renderDiff(entry.result.details);
    }
  }

  function flushExplorationCalls(allowIncomplete = false): void {
    if (activeExplorationGroup !== undefined) {
      activeExplorationGroup.sealed = true;
      activeExplorationGroup = undefined;
    }
    for (const group of [...explorationGroups]) {
      if (group.sealed) renderExplorationGroup(group, allowIncomplete);
    }
  }

  function bashTokenColor(tone: BashTokenTone): string | undefined {
    switch (tone) {
      case 'command': return BLUE;
      case 'flag': return RED;
      case 'string': return GREEN;
      case 'operator': return CYAN;
      case 'comment': return DIM;
      default: return undefined;
    }
  }

  function paintBashTokens(tokens: readonly BashToken[]): string {
    return tokens.map((token) => {
      const code = bashTokenColor(token.tone);
      return code === undefined ? token.text : paint(token.text, code);
    }).join('');
  }

  function bashResultText(result: ToolResultMessage): string {
    return result.content.find((part): part is { type: 'text'; text: string } => part.type === 'text')
      ?.text ?? '';
  }

  function renderBashStart(command: string): void {
    startToolBlock();
    const safeCommand = sanitizeTerminalText(command);
    const headerPrefix = `${glyph.tool} Running `;
    const continuationPrefix = `  ${ascii ? '|' : '│'} `;
    const layout = layoutBashCommand(
      safeCommand,
      Math.max(1, width() - displayWidth(headerPrefix)),
      Math.max(1, width() - displayWidth(continuationPrefix)),
      displayWidth,
    );
    appendLine(
      `${paint(glyph.tool, CYAN)} ${paint('Running', BOLD)} ` +
        `${paintBashTokens(layout.lines[0] ?? [])}`.trimEnd(),
    );
    for (const line of layout.lines.slice(1)) {
      appendLine(`${paint(continuationPrefix, DIM)}${paintBashTokens(line)}`);
    }
  }

  /** 已完成 bash 统一渲染为 Codex 风格的命令头和首尾输出预览。 */
  function renderBashResult(command: string, result: ToolResultMessage): void {
    startToolBlock();
    const safeCommand = sanitizeTerminalText(command);
    const statusCode = result.isError ? RED : GREEN;
    const statusGlyph = result.isError ? glyph.failure : glyph.tool;
    const headerPrefix = `${statusGlyph} Ran `;
    const continuationPrefix = `  ${ascii ? '|' : '│'} `;
    const outputFirstPrefix = `  ${ascii ? '\\' : '└'} `;
    const outputNextPrefix = '    ';
    const layout = layoutBashCommand(
      safeCommand,
      Math.max(1, width() - displayWidth(headerPrefix)),
      Math.max(1, width() - displayWidth(continuationPrefix)),
      displayWidth,
    );
    const first = layout.lines[0] ?? [];
    appendLine(`${paint(statusGlyph, statusCode)} ${paint('Ran', BOLD)} ${paintBashTokens(first)}`.trimEnd());
    for (const line of layout.lines.slice(1)) {
      appendLine(`${paint(continuationPrefix, DIM)}${paintBashTokens(line)}`);
    }

    const preview = previewBashOutput(sanitizeTerminalText(bashResultText(result)));
    if (preview.lines.length === 0) {
      appendLine(paint(`${outputFirstPrefix}(no output)`, DIM));
      return;
    }
    const headLines = preview.omittedLines === undefined
      ? preview.lines.length
      : Math.min(2, preview.lines.length);
    for (const [index, rawLine] of preview.lines.entries()) {
      const prefix = index === 0 ? outputFirstPrefix : outputNextPrefix;
      const line = truncateToWidth(rawLine.replaceAll('\t', '  '), Math.max(1, width() - displayWidth(prefix)));
      appendLine(paint(`${prefix}${line}`, DIM));
      if (preview.omittedLines !== undefined && index + 1 === headLines) {
        appendLine(paint(`${outputNextPrefix}${bashOutputEllipsis(preview.omittedLines)}`, DIM));
      }
    }
  }

  /** 与全屏 TUI 一致：标题 + 进度 + 树状三态 checklist，而不是无层级的纯文本。 */
  function renderPlanUpdate(steps: Extract<SessionEvent, { type: 'plan_update' }>['steps']): void {
    startToolBlock();
    const useAscii = ascii || !color;
    const presentation = layoutPlan(
      steps.map((step) => ({
        step: sanitizeTerminalLine(step.step),
        status: step.status,
      })),
      Math.max(1, width() - 1),
      displayWidth,
      useAscii,
    );
    const progress = formatPlanProgress(presentation.progress);
    const bullet = useAscii ? '*' : glyph.explored;
    appendLine(
      `${paint(bullet, DIM)} ${paint(presentation.title, BOLD)}` +
        (progress === undefined ? '' : paint(`${useAscii ? ' | ' : ' · '}${progress}`, DIM)),
    );
    for (const line of presentation.lines) {
      const text = `${line.prefix}${line.marker === '' ? '' : `${line.marker} `}${line.text}`;
      const code = line.status === 'completed'
        ? DIM_STRIKETHROUGH
        : line.status === 'in_progress'
          ? CYAN_BOLD
          : DIM;
      appendLine(paint(text, code));
    }
  }

  // ---- 流式文本 ----

  function streamAppend(delta: string, kind: 'text' | 'reasoning'): void {
    delta = sanitizeTerminalText(delta);
    if (!ansi) {
      write(kind === 'reasoning' ? paint(delta, DIM_ITALIC) : delta);
      midLine = !delta.endsWith('\n');
      return;
    }
    pendingKind = kind;
    const parts = (pending + delta).split('\n');
    pending = parts.pop() ?? '';
    for (const line of parts) {
      appendLine(kind === 'reasoning' ? paint(line, DIM_ITALIC) : line);
    }
    redrawDyn();
  }

  /** text_end/reasoning_end 补换行;abort 等场景由 message_end 兜底调用。 */
  function endStreamLine(): void {
    if (!ansi) {
      if (midLine) {
        write('\n');
        midLine = false;
      }
      return;
    }
    if (pending !== '') {
      const line = pending;
      pending = '';
      appendLine(pendingKind === 'reasoning' ? paint(line, DIM_ITALIC) : line);
    }
  }

  // ---- 事件处理 ----

  function onProviderEvent(ev: ProviderEvent): void {
    const isDisplaySafeReasoningSummary = (event: ProviderEvent): boolean => {
      if (!('partial' in event) || !('contentIndex' in event)) return false;
      const part = event.partial.content[event.contentIndex];
      return part?.type === 'reasoning' && part.kind === 'summary';
    };
    switch (ev.type) {
      case 'text_delta':
        if (ev.delta !== '') flushExplorationCalls();
        streamAppend(ev.delta, 'text');
        break;
      case 'reasoning_start':
        if (!isDisplaySafeReasoningSummary(ev)) break;
        reasoningSummaries.clear();
        reasoningSummaries.set(ev.contentIndex, '');
        activity = 'Working';
        redrawDyn();
        break;
      case 'reasoning_delta': {
        if (!isDisplaySafeReasoningSummary(ev)) break;
        const summary = (reasoningSummaries.get(ev.contentIndex) ?? '') +
          sanitizeTerminalText(ev.delta);
        reasoningSummaries.set(ev.contentIndex, summary.slice(0, WORKING_SUMMARY_MAX_CODE_UNITS));
        activity = sanitizeTerminalLine(summary).replace(/ +/gu, ' ') || 'Working';
        redrawDyn();
        break;
      }
      case 'text_end':
        endStreamLine();
        break;
      case 'reasoning_end': {
        if (!isDisplaySafeReasoningSummary(ev)) break;
        const summary = sanitizeTerminalText(ev.content).slice(0, WORKING_SUMMARY_MAX_CODE_UNITS);
        if (summary !== '' || !reasoningSummaries.has(ev.contentIndex)) {
          reasoningSummaries.set(ev.contentIndex, summary);
        }
        const visible = reasoningSummaries.get(ev.contentIndex) ?? '';
        activity = sanitizeTerminalLine(visible).replace(/ +/gu, ' ') || 'Working';
        redrawDyn();
        break;
      }
      case 'tool_call_start': {
        // 不渲染参数流,动态区提示 preparing <name>…(docs/09 §4)
        reasoningSummaries.clear();
        const part = ev.partial.content[ev.contentIndex];
        const name = part !== undefined && part.type === 'tool_call' ? part.name : 'tool';
        activity = `preparing ${sanitizeTerminalLine(name)}${ascii ? '...' : '…'}`;
        redrawDyn();
        break;
      }
      default:
        break; // tool_call_delta/start 快照等:tolerant 忽略
    }
  }

  function userEcho(m: UserMessage): void {
    flushExplorationCalls();
    const text = sanitizeTerminalText(m.content
      .map((p) => (p.type === 'text' ? p.text : '[image]'))
      .join('\n')
      .trimEnd());
    switch (m.source) {
      case 'steering':
        appendLines(paint(`${glyph.steering} steering: ${text}`, CYAN));
        break;
      case 'follow_up':
        appendLines(paint(`${glyph.steering} follow-up: ${text}`, CYAN));
        break;
      case 'synthetic':
        appendLine(paint(truncateToWidth(firstLine(text), 80), DIM));
        break;
      default:
        appendLines(`${paint('you:', BOLD)} ${text}`);
    }
  }

  function assistantEndWarnings(m: AssistantMessage): void {
    if (m.stopReason === 'length') {
      flushExplorationCalls();
      appendLine(paint('[output truncated by model limit]', YELLOW));
    } else if (m.stopReason === 'aborted') {
      flushExplorationCalls();
      appendLine(paint('[aborted]', YELLOW));
    }
    else if (m.stopReason === 'error') {
      flushExplorationCalls();
      appendLine(paint(`[error] ${sanitizeTerminalLine(m.errorMessage ?? 'provider error')}`, RED));
    }
  }

  function detailsSuffix(result: ToolResultMessage): string | undefined {
    const d = asRecord(result.details);
    const parts: string[] = [];
    const p = str(d['path']);
    if (p !== undefined) parts.push(shortenPath(sanitizeTerminalLine(p)));
    if (typeof d['totalLines'] === 'number') parts.push(`(${d['totalLines']} lines)`);
    if (typeof d['additions'] === 'number' && typeof d['deletions'] === 'number') {
      parts.push(`+${d['additions']} -${d['deletions']}`);
    }
    return parts.length > 0 ? parts.join(' ') : undefined;
  }

  /** 成功 plan 的权威可见投影紧随其后的 plan_update；不要先写一条冗余工具结果。 */
  function planSnapshot(
    details: unknown,
  ): Extract<SessionEvent, { type: 'plan_update' }>['steps'] | undefined {
    const steps = asRecord(details)['steps'];
    if (!Array.isArray(steps) || !steps.every((candidate) => {
      const step = asRecord(candidate);
      return typeof step['step'] === 'string' &&
        (step['status'] === 'pending' ||
          step['status'] === 'in_progress' ||
          step['status'] === 'completed');
    })) return undefined;
    return steps.map((candidate) => {
      const step = asRecord(candidate);
      return {
        step: step['step'] as string,
        status: step['status'] as 'pending' | 'in_progress' | 'completed',
      };
    });
  }

  function onToolEnd(result: ToolResultMessage): void {
    const exploration = startedExplorationCalls.get(result.toolCallId);
    startedExplorationCalls.delete(result.toolCallId);
    const bash = startedBashCalls.get(result.toolCallId);
    startedBashCalls.delete(result.toolCallId);
    const startedAt = toolStartedAt.get(result.toolCallId);
    toolStartedAt.delete(result.toolCallId);
    const hadVisibleToolStart = visibleToolStarts.delete(result.toolCallId);
    if (exploration !== undefined) {
      exploration.result = result;
      if (exploration.group.sealed) renderExplorationGroup(exploration.group, false);
      return;
    }

    flushExplorationCalls();
    if (bash !== undefined) {
      renderBashResult(bash.command, result);
      renderDiff(result.details);
      return;
    }
    if (result.toolName === 'plan' && !result.isError && planSnapshot(result.details) !== undefined) {
      renderDiff(result.details);
      return;
    }
    const head = sanitizeTerminalLine(firstLine(
      result.content.find((p): p is { type: 'text'; text: string } => p.type === 'text')?.text ?? '',
    ));
    const toolName = sanitizeTerminalLine(result.toolName);
    const elapsed = startedAt === undefined ? '' : `${separator}${formatElapsed(Date.now() - startedAt)}`;
    if (!hadVisibleToolStart) startToolBlock();
    if (result.isError) {
      appendLine(paint(`  ${glyph.failure} ${toolName}${elapsed}: ${truncateToWidth(head, 100)}`, RED));
    } else {
      const suffix = detailsSuffix(result) ?? (
        head !== '' ? `${ascii ? '' : '· '}${truncateToWidth(head, 80)}` : ''
      );
      appendLine(
        `  ${paint(glyph.success, GREEN)} ${toolName}${elapsed}` +
          `${suffix !== '' ? ` ${paint(suffix, DIM)}` : ''}`,
      );
    }
    renderDiff(result.details);
  }

  /** details.diff 以 ± 着色渲染,上限 40 行,超出提示行数(docs/09 §4)。 */
  function renderDiff(details: unknown): void {
    const diff = str(asRecord(details)['diff']);
    if (diff === undefined || diff === '') return;
    flushExplorationCalls();
    const lines = sanitizeTerminalText(diff).replace(/\n$/, '').split('\n');
    for (const line of lines.slice(0, DIFF_MAX_LINES)) {
      let code: string | undefined;
      if (line.startsWith('+') && !line.startsWith('+++')) code = GREEN;
      else if (line.startsWith('-') && !line.startsWith('---')) code = RED;
      else if (line.startsWith('@@')) code = CYAN;
      else code = DIM;
      appendLine(`  ${paint(line, code)}`);
    }
    if (lines.length > DIFF_MAX_LINES) {
      appendLine(paint(`  ${ascii ? '...' : '…'} (+${lines.length - DIFF_MAX_LINES} more diff lines)`, DIM));
    }
  }

  function usageSummary(reason: 'completed' | 'aborted' | 'error'): string {
    const head = reason === 'completed' ? glyph.done : reason === 'aborted' ? glyph.aborted : glyph.error;
    if (usage === undefined) return head;
    const c = usage.cumulative;
    let s = `${head}${separator}${usage.turns} turn${usage.turns === 1 ? '' : 's'}${separator}tokens ${c.input} in / ${c.output} out`;
    if (c.costUSD !== undefined) s += `${separator}$${c.costUSD.toFixed(4)}`;
    return s;
  }

  function render(e: SessionEvent): void {
    switch (e.type) {
      case 'agent_start':
        flushExplorationCalls();
        running = true;
        reasoningSummaries.clear();
        activity = 'Working';
        if (e.reason === 'follow_up') appendLine(paint(`${glyph.followUp} follow-up`, CYAN));
        else redrawDyn();
        break;
      case 'agent_end':
        flushExplorationCalls(true);
        explorationGroups.clear();
        activeExplorationGroup = undefined;
        startedExplorationCalls.clear();
        startedBashCalls.clear();
        toolStartedAt.clear();
        visibleToolStarts.clear();
        endStreamLine();
        running = false;
        activity = undefined;
        activityTail = undefined;
        reasoningSummaries.clear();
        approvalPrompt = undefined; // abort 收尾等场景兜底撤下审批提示
        approvalDescription = undefined;
        if (e.reason === 'error') appendLine(paint(`${glyph.fatal} agent run failed`, RED));
        appendLine(paint(usageSummary(e.reason), DIM));
        break;
      case 'turn_start':
        break; // 无可见输出(docs/09 §4)
      case 'turn_end':
        appendLine(''); // 空行分隔;动态区徽标随 appendLine 重绘刷新
        break;
      case 'message_start':
        if (e.message.role === 'user') userEcho(e.message);
        else if (e.message.role === 'assistant') {
          pending = '';
          pendingKind = 'text';
          reasoningSummaries.clear();
          activity = 'Working';
          redrawDyn();
        }
        break;
      case 'message_update':
        onProviderEvent(e.event);
        break;
      case 'message_end':
        if (e.message.role === 'assistant') {
          endStreamLine(); // abort/error 中断时流没走到 *_end,这里兜底收行
          assistantEndWarnings(e.message);
        }
        break; // tool_result 由 tool_execution_end 渲染,此处去重(docs/09 §4)
      case 'tool_execution_start': {
        approvalPrompt = undefined; // 审批已决议(放行或拒绝都会走到 start),提示撤下
        approvalDescription = undefined;
        reasoningSummaries.clear();
        const exploration = explorationCall(e.toolName, e.args);
        const bashCommand = e.toolName === 'bash' ? bashCommandFromArgs(e.args) : undefined;
        const headline = toolHeadline(e.toolName, e.args);
        toolStartedAt.set(e.toolCallId, Date.now());
        if (exploration !== undefined) {
          startExplorationCall(e.toolCallId, exploration);
        } else if (bashCommand !== undefined) {
          flushExplorationCalls();
          startedBashCalls.set(e.toolCallId, { command: bashCommand });
        } else {
          flushExplorationCalls();
          if (headline !== undefined) {
            startToolBlock();
            appendLine(`${paint(glyph.tool, CYAN)} ${sanitizeTerminalLine(headline)}`);
            visibleToolStarts.add(e.toolCallId);
          }
        }
        activity = `${sanitizeTerminalLine(e.toolName)} running${ascii ? '...' : '…'}`;
        activityTail = undefined;
        redrawDyn();
        break;
      }
      case 'tool_execution_update': {
        const output = e.update.output;
        if (typeof output === 'string') {
          // 工具流式输出(bash 等)常含 \t/\r,同样先清洗再按显示宽度截断
          const tail = sanitizeDynText(
            sanitizeTerminalText(output).trimEnd().split('\n').pop() ?? '',
          );
          activityTail = truncateToWidth(tail, 60);
          redrawDyn();
        }
        break;
      }
      case 'tool_execution_end':
        onToolEnd(e.result);
        activity = running ? 'Working' : undefined;
        activityTail = undefined;
        redrawDyn();
        break;
      case 'queue_update':
        steerCount = e.steering.length;
        followCount = e.followUp.length;
        if (ansi) redrawDyn();
        else if (steerCount > 0 || followCount > 0) {
          flushExplorationCalls();
          appendLine(`[steer ${steerCount}${separator}follow-up ${followCount}]`);
        }
        break;
      case 'plan_update':
        flushExplorationCalls();
        renderPlanUpdate(e.steps);
        break;
      case 'approval_request':
        // M6(docs/09 §4):转录区一行留痕(plain/headless 可读),动态区切审批提示;
        // 键位表由 repl 同步切审批模式,提示与键位来自同一事件,不会失配。
        flushExplorationCalls();
        appendLine(paint(`? approval required: ${sanitizeTerminalLine(e.description)}`, YELLOW));
        approvalDescription = sanitizeTerminalLine(e.description);
        approvalPrompt = approvalPromptText(approvalDescription, false);
        redrawDyn();
        break;
      case 'error':
        flushExplorationCalls();
        appendLine(
          e.fatal
            ? paint(`${glyph.fatal} fatal: ${sanitizeTerminalLine(e.message)}`, RED)
            : paint(`${glyph.warning} ${sanitizeTerminalLine(e.message)}`, YELLOW),
        );
        break;
      case 'usage_update':
        usage = e.usage;
        redrawDyn();
        break;
      case 'retry_scheduled':
        flushExplorationCalls();
        appendLine(
          paint(
            `${glyph.retry} retry ${e.attempt}/${e.maxAttempts} in ${e.delayMs}ms: ${sanitizeTerminalLine(e.errorMessage)}`,
            YELLOW,
          ),
        );
        break;
      case 'compaction_start':
        flushExplorationCalls();
        appendLine(paint(`${glyph.compact} compacting context${ascii ? '...' : '…'}`, DIM));
        break;
      case 'compaction_end':
        flushExplorationCalls();
        appendLine(
          paint(e.ok
            ? `${glyph.compact} compaction done (dropped ${e.droppedMessages} messages)`
            : `${glyph.compact} compaction failed`, DIM),
        );
        break;
      default:
        break; // tolerant reader:未知事件静默忽略(docs/03 §7)
    }
  }

  function replayTranscript(messages: readonly AgentMessage[]): void {
    if (messages.length === 0) return;
    const resultCalls = new Map<number, ToolCallPart>();
    const deferredStarts = new Map<number, ToolCallPart[]>();
    let latestPlan: Extract<SessionEvent, { type: 'plan_update' }>['steps'] | undefined;
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
      const message = messages[messageIndex];
      if (message?.role === 'tool_result') {
        if (message.toolName === 'plan' && !message.isError) {
          latestPlan = planSnapshot(message.details) ?? latestPlan;
        }
        continue;
      }
      if (message?.role !== 'assistant') continue;
      const calls = new Map<string, { key: string; part: ToolCallPart }>();
      const orderedCalls: Array<{ key: string; part: ToolCallPart }> = [];
      for (const [contentIndex, part] of message.content.entries()) {
        if (part.type !== 'tool_call') continue;
        const call = { key: `${messageIndex}:${contentIndex}`, part };
        calls.set(part.id, call);
        orderedCalls.push(call);
      }
      const resultIndexes = new Map<string, number>();
      for (let resultIndex = messageIndex + 1; resultIndex < messages.length; resultIndex++) {
        const result = messages[resultIndex];
        if (result?.role !== 'tool_result') break;
        const call = calls.get(result.toolCallId);
        if (call === undefined) continue;
        resultIndexes.set(call.key, resultIndex);
        resultCalls.set(resultIndex, call.part);
        calls.delete(result.toolCallId);
      }
      let releaseAfter = messageIndex;
      for (const call of orderedCalls) {
        const resultIndex = resultIndexes.get(call.key);
        if (resultIndex !== undefined) {
          releaseAfter = Math.max(releaseAfter, resultIndex);
          continue;
        }
        const pending = deferredStarts.get(releaseAfter) ?? [];
        pending.push(call.part);
        deferredStarts.set(releaseAfter, pending);
      }
    }

    const startReplayCall = (part: ToolCallPart, expectsResult: boolean): void => {
      const exploration = explorationCall(part.name, part.arguments);
      const command = part.name === 'bash' ? bashCommandFromArgs(part.arguments) : undefined;
      if (exploration !== undefined) {
        startExplorationCall(part.id, exploration);
      } else if (command !== undefined) {
        flushExplorationCalls();
        if (expectsResult) startedBashCalls.set(part.id, { command });
        else renderBashStart(command);
      } else {
        flushExplorationCalls();
        const headline = toolHeadline(part.name, part.arguments);
        if (!expectsResult || headline !== undefined) {
          startToolBlock();
          appendLine(
            `${paint(glyph.tool, CYAN)} ${sanitizeTerminalLine(headline ?? part.name)}`,
          );
          if (expectsResult) visibleToolStarts.add(part.id);
        }
      }
    };

    flushExplorationCalls(true);
    explorationGroups.clear();
    activeExplorationGroup = undefined;
    startedExplorationCalls.clear();
    startedBashCalls.clear();
    toolStartedAt.clear();
    visibleToolStarts.clear();
    appendLine(paint(`${glyph.replay} resumed session${separator}${messages.length} messages ${glyph.replay}`, DIM));
    for (const [messageIndex, m] of messages.entries()) {
      if (m.role === 'user') {
        userEcho(m);
      } else if (m.role === 'assistant') {
        for (const part of m.content) {
          if (part.type === 'text') {
            flushExplorationCalls();
            appendLines(sanitizeTerminalText(part.text).trimEnd());
          }
          else if (part.type === 'reasoning') {
            // 仅在交互动态行显示本轮 reasoning summary；历史与 plain 不添加伪摘要。
          }
        }
        assistantEndWarnings(m);
      } else {
        const part = resultCalls.get(messageIndex);
        if (part !== undefined) startReplayCall(part, true);
        onToolEnd(m);
      }
      for (const part of deferredStarts.get(messageIndex) ?? []) startReplayCall(part, false);
    }
    flushExplorationCalls(true);
    if (latestPlan !== undefined) renderPlanUpdate(latestPlan);
    explorationGroups.clear();
    activeExplorationGroup = undefined;
    startedExplorationCalls.clear();
    startedBashCalls.clear();
    toolStartedAt.clear();
    visibleToolStarts.clear();
    appendLine('');
  }

  return {
    render,
    replayTranscript,
    drain: () => out.drain(),
    setInputLine(text: string, cursor = text.length): void {
      // layoutClassicInput sanitizes the original text and its original cursor prefix together;
      // retaining the source here keeps CRLF/control-sequence length changes cursor-safe.
      input = text;
      inputCursor = Math.max(0, Math.min(cursor, text.length));
      redrawDyn();
    },
    setStatus(text: string | undefined): void {
      status = text === undefined ? undefined : productChrome(sanitizeTerminalLine(text));
      redrawDyn();
    },
    setApprovalAllowsAlways(available: boolean): void {
      if (approvalDescription === undefined) return;
      approvalPrompt = approvalPromptText(approvalDescription, available);
      redrawDyn();
    },
    setApprovalRequest(request): void {
      if (request === undefined) {
        approvalDescription = undefined;
        approvalPrompt = undefined;
      } else {
        approvalDescription = sanitizeTerminalLine(request.description);
        approvalPrompt = approvalPromptText(approvalDescription, request.allowAlways);
      }
      redrawDyn();
    },
    println(text: string): void {
      // `println` also carries raw transcript/review/diff/provider content. Its provenance is
      // intentionally opaque, so ASCII fallback must never rewrite payload glyphs here.
      flushExplorationCalls();
      appendLines(sanitizeTerminalText(text));
    },
    mount(): void {
      if (!ansi) return;
      write(PASTE_ON);
      redrawDyn();
    },
    unmount(): void {
      if (!ansi) return;
      clearDyn();
      write(PASTE_OFF);
    },
    redraw(): void {
      redrawDyn();
    },
  };
}

function approvalPromptText(description: string, allowAlways: boolean): string {
  return `Allow ${description}? [y=once / ${allowAlways ? 'a=always / ' : ''}n=deny / Esc=abort]`;
}

/** 长路径显示:保留末两段。 */
function shortenPath(p: string): string {
  const parts = p.split('/').filter((s) => s !== '');
  if (parts.length <= 2) return p;
  return parts.slice(-2).join('/');
}

function formatElapsed(milliseconds: number): string {
  return milliseconds < 1_000
    ? `${Math.max(0, milliseconds)}ms`
    : `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
}
