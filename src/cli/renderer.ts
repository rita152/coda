// Append-only 人类可读渲染器：把 canonical RuntimeEvent 投影为一次性命令的终端输出。
// 全屏交互由 OpenTUI 独占；本模块不接管 raw TTY、输入行或光标重绘。

import type {
  AgentMessage,
  AssistantMessage,
  ProviderEvent,
  ToolCallPart,
  ToolResultMessage,
  UserMessage,
} from '../protocol/index.js';
import type {
  CliRuntimeEvent,
  CliThreadUsage,
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
  /** Replace coda-owned status chrome with portable ASCII; user/model payload remains Unicode. */
  ascii?: boolean;
}

export interface Renderer {
  render(e: CliRuntimeEvent): void;
  replayTranscript(messages: readonly AgentMessage[]): void;
  /** 等待此前渲染排队的 stdout 内容；Runtime event subscriber 用它施加有序背压。 */
  drain(): Promise<void>;
}

// ---- SGR 代码 ----
const RESET = '\x1b[0m';
const BOLD = '1';
const DIM = '2';
const DIM_STRIKETHROUGH = '2;9';
const RED = '31';
const GREEN = '32';
const BLUE = '34';
const YELLOW = '33';
const CYAN = '36';
const CYAN_BOLD = '1;36';

const DIFF_MAX_LINES = 40; // docs/09 §4:diff 渲染上限

// ---- 简化 wcwidth：终端布局和截断按显示宽度而非 code unit ----

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
    replay: ascii ? '--' : '—',
  } as const;
  const separator = ascii ? ' | ' : ' · ';
  // 流式状态
  let midLine = false;
  let usage: CliThreadUsage | undefined;
  const toolStartedAt = new Map<string, number>();
  const explorationGroups = new Set<ExplorationGroup>();
  let activeExplorationGroup: ExplorationGroup | undefined;
  const startedExplorationCalls = new Map<string, ActiveExplorationCall>();
  const startedBashCalls = new Map<string, ActiveBashCall>();
  // Append-only 输出没有 TUI 的 HistoryCell 容器；以这两个标记复现「独立工具块前一行空白、
  // 同一调用的结果/diff 紧贴」的排版节奏。
  const visibleToolStarts = new Set<string>();
  let hasTranscriptContent = false;
  let lastTranscriptLineWasBlank = false;

  const write = (s: string): void => {
    out.enqueue(s);
  };
  const paint = (s: string, code: string): string => (color ? `\x1b[${code}m${s}${RESET}` : s);
  const width = (): number => (typeof out.columns === 'number' && out.columns > 0 ? out.columns : 80);

  /** 转录区追加一整行；若流式 delta 尚未收行，先补齐物理换行。 */
  function appendLine(text: string): void {
    if (midLine) {
      write('\n');
      midLine = false;
    }
    write(`${text}\n`);
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
   * Append-only 渲染在边界只封存当前组，必须等组内每个并行调用都有
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
  function renderPlanUpdate(steps: Extract<CliRuntimeEvent, { type: 'plan_update' }>['steps']): void {
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

  function streamAppend(delta: string): void {
    const sanitized = sanitizeTerminalText(delta);
    write(sanitized);
    midLine = !sanitized.endsWith('\n');
  }

  /** text_end 补换行;abort 等场景由 message_end 兜底调用。 */
  function endStreamLine(): void {
    if (midLine) {
      write('\n');
      midLine = false;
    }
  }

  // ---- 事件处理 ----

  function onProviderEvent(ev: ProviderEvent): void {
    switch (ev.type) {
      case 'text_delta':
        if (ev.delta !== '') flushExplorationCalls();
        streamAppend(ev.delta);
        break;
      case 'text_end':
        endStreamLine();
        break;
      default:
        break; // reasoning/tool-call 流不进入 append-only 正文。
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
  ): Extract<CliRuntimeEvent, { type: 'plan_update' }>['steps'] | undefined {
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

  function render(e: CliRuntimeEvent): void {
    switch (e.type) {
      case 'agent_start':
        flushExplorationCalls();
        if (e.reason === 'follow_up') appendLine(paint(`${glyph.followUp} follow-up`, CYAN));
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
        if (e.reason === 'error') appendLine(paint(`${glyph.fatal} agent run failed`, RED));
        appendLine(paint(usageSummary(e.reason), DIM));
        break;
      case 'turn_start':
        break; // 无可见输出(docs/09 §4)
      case 'turn_end':
        appendLine('');
        break;
      case 'message_start':
        if (e.message.role === 'user') userEcho(e.message);
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
        break;
      }
      case 'tool_execution_update':
        break;
      case 'tool_execution_end':
        onToolEnd(e.result);
        break;
      case 'queue_update': {
        const steerCount = e.steering.length;
        const followCount = e.followUp.length;
        if (steerCount > 0 || followCount > 0) {
          flushExplorationCalls();
          appendLine(`[steer ${steerCount}${separator}follow-up ${followCount}]`);
        }
        break;
      }
      case 'plan_update':
        flushExplorationCalls();
        renderPlanUpdate(e.steps);
        break;
      case 'control_request':
        if (e.kind !== 'approval') break;
        flushExplorationCalls();
        appendLine(
          paint(`? approval required: ${sanitizeTerminalLine(e.payload.presentation.risk.description)}`, YELLOW),
        );
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
    let latestPlan: Extract<CliRuntimeEvent, { type: 'plan_update' }>['steps'] | undefined;
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
            // Reasoning 不进入 append-only 正文。
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
  };
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
