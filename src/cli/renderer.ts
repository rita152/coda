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
  ToolResultMessage,
  UserMessage,
} from '../protocol/index.js';
import type {
  CliSessionEvent as SessionEvent,
  CliSessionUsage as SessionUsage,
} from './frontend-types.js';
import { sanitizeTerminalLine, sanitizeTerminalText } from './terminal-sanitize.js';

export interface RendererOptions {
  color: boolean;
  interactive: boolean;
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
const RED = '31';
const GREEN = '32';
const YELLOW = '33';
const CYAN = '36';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const DIFF_MAX_LINES = 40; // docs/09 §4:diff 渲染上限
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

export function createRenderer(out: RendererOutput, opts: RendererOptions): Renderer {
  const color = opts.color;
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
  const reasoningStartedAt = new Map<number, number>();
  const toolStartedAt = new Map<string, number>();

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
    lines.push(paint('─'.repeat(Math.min(w - 1, 60)), DIM));
    // 活动行 + 队列徽标(docs/09 §5:同一行,两队列皆空时徽标不显示)
    const glyph = running ? (SPINNER_FRAMES[spin % SPINNER_FRAMES.length] ?? '⠋') : '·';
    spin++;
    // 优先级:临时状态提示 > 审批提示(键位已切审批模式,提示必须在场)> 常规活动行
    const approval = approvalPrompt !== undefined ? paint(approvalPrompt, YELLOW) : undefined;
    let act = status ?? approval ?? (running ? (activity ?? 'streaming…') : 'idle');
    if (status === undefined && approval === undefined && activityTail !== undefined) {
      act += `  ${activityTail}`;
    }
    let line = `${glyph} ${sanitizeDynText(act)}`;
    if (steerCount > 0 || followCount > 0) {
      line += `  ${paint(`[steer ${steerCount} · follow-up ${followCount}]`, CYAN)}`;
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
  }

  function appendLines(text: string): void {
    for (const line of text.split('\n')) appendLine(line);
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
    switch (ev.type) {
      case 'text_delta':
        streamAppend(ev.delta, 'text');
        break;
      case 'reasoning_start':
        reasoningStartedAt.set(ev.contentIndex, Date.now());
        activity = 'thinking…';
        redrawDyn();
        break;
      case 'reasoning_delta':
        // Full reasoning is available through Runtime /review; keep the default transcript compact.
        break;
      case 'text_end':
        endStreamLine();
        break;
      case 'reasoning_end': {
        const startedAt = reasoningStartedAt.get(ev.contentIndex);
        reasoningStartedAt.delete(ev.contentIndex);
        appendLine(paint(
          `thinking · ${startedAt === undefined ? 'complete' : formatElapsed(Date.now() - startedAt)}`,
          DIM_ITALIC,
        ));
        activity = 'streaming…';
        redrawDyn();
        break;
      }
      case 'tool_call_start': {
        // 不渲染参数流,动态区提示 preparing <name>…(docs/09 §4)
        const part = ev.partial.content[ev.contentIndex];
        const name = part !== undefined && part.type === 'tool_call' ? part.name : 'tool';
        activity = `preparing ${sanitizeTerminalLine(name)}…`;
        redrawDyn();
        break;
      }
      default:
        break; // tool_call_delta/start 快照等:tolerant 忽略
    }
  }

  function userEcho(m: UserMessage): void {
    const text = sanitizeTerminalText(m.content
      .map((p) => (p.type === 'text' ? p.text : '[image]'))
      .join('\n')
      .trimEnd());
    switch (m.source) {
      case 'steering':
        appendLines(paint(`» steering: ${text}`, CYAN));
        break;
      case 'follow_up':
        appendLines(paint(`» follow-up: ${text}`, CYAN));
        break;
      case 'synthetic':
        appendLine(paint(truncateToWidth(firstLine(text), 80), DIM));
        break;
      default:
        appendLines(`${paint('you:', BOLD)} ${text}`);
    }
  }

  function assistantEndWarnings(m: AssistantMessage): void {
    if (m.stopReason === 'length') appendLine(paint('[output truncated by model limit]', YELLOW));
    else if (m.stopReason === 'aborted') appendLine(paint('[aborted]', YELLOW));
    else if (m.stopReason === 'error') {
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

  function onToolEnd(result: ToolResultMessage): void {
    const head = sanitizeTerminalLine(firstLine(
      result.content.find((p): p is { type: 'text'; text: string } => p.type === 'text')?.text ?? '',
    ));
    const toolName = sanitizeTerminalLine(result.toolName);
    const startedAt = toolStartedAt.get(result.toolCallId);
    toolStartedAt.delete(result.toolCallId);
    const elapsed = startedAt === undefined ? '' : ` · ${formatElapsed(Date.now() - startedAt)}`;
    if (result.isError) {
      appendLine(paint(`  ✗ ${toolName}${elapsed}: ${truncateToWidth(head, 100)}`, RED));
    } else {
      const suffix = detailsSuffix(result) ?? (head !== '' ? `· ${truncateToWidth(head, 80)}` : '');
      appendLine(`  ${paint('✓', GREEN)} ${toolName}${elapsed}${suffix !== '' ? ` ${paint(suffix, DIM)}` : ''}`);
    }
    renderDiff(result.details);
  }

  /** details.diff 以 ± 着色渲染,上限 40 行,超出提示行数(docs/09 §4)。 */
  function renderDiff(details: unknown): void {
    const diff = str(asRecord(details)['diff']);
    if (diff === undefined || diff === '') return;
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
      appendLine(paint(`  … (+${lines.length - DIFF_MAX_LINES} more diff lines)`, DIM));
    }
  }

  function usageSummary(reason: 'completed' | 'aborted' | 'error'): string {
    const head = reason === 'completed' ? '∙ done' : reason === 'aborted' ? '∙ aborted' : '∙ ended with error';
    if (usage === undefined) return head;
    const c = usage.cumulative;
    let s = `${head} · ${usage.turns} turn${usage.turns === 1 ? '' : 's'} · tokens ${c.input} in / ${c.output} out`;
    if (c.costUSD !== undefined) s += ` · $${c.costUSD.toFixed(4)}`;
    return s;
  }

  function render(e: SessionEvent): void {
    switch (e.type) {
      case 'agent_start':
        running = true;
        activity = 'streaming…';
        if (e.reason === 'follow_up') appendLine(paint('↪ follow-up', CYAN));
        else redrawDyn();
        break;
      case 'agent_end':
        endStreamLine();
        running = false;
        activity = undefined;
        activityTail = undefined;
        approvalPrompt = undefined; // abort 收尾等场景兜底撤下审批提示
        approvalDescription = undefined;
        if (e.reason === 'error') appendLine(paint('✖ agent run failed', RED));
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
          activity = 'streaming…';
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
        const headline = toolHeadline(e.toolName, e.args);
        toolStartedAt.set(e.toolCallId, Date.now());
        if (headline !== undefined) appendLine(`${paint('●', CYAN)} ${sanitizeTerminalLine(headline)}`);
        activity = `${sanitizeTerminalLine(e.toolName)} running…`;
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
        activity = running ? 'streaming…' : undefined;
        activityTail = undefined;
        redrawDyn();
        break;
      case 'queue_update':
        steerCount = e.steering.length;
        followCount = e.followUp.length;
        if (ansi) redrawDyn();
        else if (steerCount > 0 || followCount > 0) {
          appendLine(`[steer ${steerCount} · follow-up ${followCount}]`);
        }
        break;
      case 'plan_update':
        for (const s of e.steps) {
          const glyph = s.status === 'completed' ? '✔' : s.status === 'in_progress' ? '▶' : '○';
          appendLine(`${glyph} ${sanitizeTerminalLine(s.step)}`);
        }
        break;
      case 'approval_request':
        // M6(docs/09 §4):转录区一行留痕(plain/headless 可读),动态区切审批提示;
        // 键位表由 repl 同步切审批模式,提示与键位来自同一事件,不会失配。
        appendLine(paint(`? approval required: ${sanitizeTerminalLine(e.description)}`, YELLOW));
        approvalDescription = sanitizeTerminalLine(e.description);
        approvalPrompt = approvalPromptText(approvalDescription, false);
        redrawDyn();
        break;
      case 'error':
        appendLine(
          e.fatal
            ? paint(`✖ fatal: ${sanitizeTerminalLine(e.message)}`, RED)
            : paint(`⚠ ${sanitizeTerminalLine(e.message)}`, YELLOW),
        );
        break;
      case 'usage_update':
        usage = e.usage;
        redrawDyn();
        break;
      case 'retry_scheduled':
        appendLine(
          paint(
            `↻ retry ${e.attempt}/${e.maxAttempts} in ${e.delayMs}ms: ${sanitizeTerminalLine(e.errorMessage)}`,
            YELLOW,
          ),
        );
        break;
      case 'compaction_start':
        appendLine(paint('⋯ compacting context…', DIM));
        break;
      case 'compaction_end':
        appendLine(
          paint(e.ok ? `⋯ compaction done (dropped ${e.droppedMessages} messages)` : '⋯ compaction failed', DIM),
        );
        break;
      default:
        break; // tolerant reader:未知事件静默忽略(docs/03 §7)
    }
  }

  function replayTranscript(messages: readonly AgentMessage[]): void {
    if (messages.length === 0) return;
    appendLine(paint(`— resumed session · ${messages.length} messages —`, DIM));
    for (const m of messages) {
      if (m.role === 'user') {
        userEcho(m);
      } else if (m.role === 'assistant') {
        for (const part of m.content) {
          if (part.type === 'text') appendLines(sanitizeTerminalText(part.text).trimEnd());
          else if (part.type === 'reasoning') {
            appendLine(paint('thinking · complete', DIM_ITALIC));
          } else {
            appendLine(
              `${paint('●', CYAN)} ${sanitizeTerminalLine(toolHeadline(part.name, part.arguments) ?? part.name)}`,
            );
          }
        }
        assistantEndWarnings(m);
      } else {
        onToolEnd(m);
      }
    }
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
      status = text === undefined ? undefined : sanitizeTerminalLine(text);
      redrawDyn();
    },
    setApprovalAllowsAlways(available: boolean): void {
      if (approvalDescription === undefined) return;
      approvalPrompt = approvalPromptText(approvalDescription, available);
      redrawDyn();
    },
    println(text: string): void {
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
