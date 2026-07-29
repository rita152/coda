// 全屏交互 TUI(规格见 docs/09-cli.md §1–5):OpenTUI 独占 raw stdin/stdout，
// 直接把 SessionEvent 投影为顶部向下增长的转录区，并把输入框和两行状态固定在底部。
// 本模块只在双 TTY 的交互分支动态加载；headless 与一次性模式不加载 native TUI 依赖。

import type {
  AgentMessage,
  AssistantMessage,
  ModelRef,
  PlanStep,
  QueuedMessage,
  ToolResultMessage,
  UserMessage,
} from '../protocol/index.js';
import type { Session, SessionEvent, SessionUsage } from '../session/index.js';
import { runtimeHomeDir } from '../shared/index.js';
import { toolHeadline, truncateToWidth } from './renderer.js';
import {
  approvalKeyDecision,
  CTRL_C_EXIT_WINDOW_MS,
  decideEnter,
  DoublePress,
  ESC_EXIT_WINDOW_MS,
  formatQueueLines,
  formatStatusLines,
  InputHistory,
} from './repl.js';
import type { ReplApproval, SlashCommand } from './repl.js';
import type {
  CliRenderer,
  ColorInput,
  KeyEvent,
  MarkdownRenderable,
  PasteEvent,
  TextRenderable,
  TreeSitterClient,
} from '@opentui/core';

const PIXEL_LOGO = [
  '   ▄█▄    ▄█▄',
  '  █████▄▄█████',
  ' ██████████████',
  ' ██  ▀████▀  ██',
  '  ▀███▄▄▄▄███▀',
  '    ▀█▀  ▀█▀',
].join('\n');

const HELP_LINES = [
  'Enter: send (idle) / steer (running) · Shift+Enter: newline',
  'Alt+Enter or /f <text>: follow-up · PageUp/PageDown: scroll output',
  'Esc: abort · Esc Esc / Ctrl+C Ctrl+C: quit · Ctrl+D: quit when idle',
  '/quit  /queue  /status  /help',
];

const DIFF_MAX_LINES = 24;
const COMPOSER_PADDING_X = 1;
const PROMPT_MAX_VISIBLE_ROWS = 8;
const PROMPT_MEASURE_HEIGHT = 65_535;
const PROMPT_RULE_ROWS = 2;
const COMPOSER_FOOTER_ROWS = 2;
const TRANSCRIPT_PADDING_Y = 1;
const TRANSCRIPT_MIN_CONTENT_ROWS = 1;
const TRANSCRIPT_PADDED_MIN_ROWS =
  TRANSCRIPT_MIN_CONTENT_ROWS + TRANSCRIPT_PADDING_Y * 2;
const MIN_HEADER_VIEWPORT_ROWS = 10;

type Tone = 'normal' | 'muted' | 'accent' | 'success' | 'warning' | 'danger' | 'cyan';

interface Palette {
  border: string;
  promptBorder: string;
  cursor: string;
  muted: string;
  accent: string;
  success: string;
  warning: string;
  danger: string;
  cyan: string;
}

const PALETTE: Palette = {
  border: '#c9ccd3',
  promptBorder: '#a0205e',
  cursor: '#c94740',
  muted: '#636873',
  accent: '#c94740',
  success: '#2f7647',
  warning: '#8a5a0a',
  danger: '#bd2e38',
  cyan: '#276a7a',
};

export interface TuiOptions {
  cwd: string;
  model: ModelRef;
  version: string;
  color: boolean;
  contextLimit?: number;
  resumed?: boolean;
  branch?: string;
}

interface TuiScreenOptions extends TuiOptions {
  onSubmit?: () => void;
  interaction?: TuiInteractionState;
  /** 测试可注入确定性的 highlighter；生产缺省使用 OpenTUI 全局 client。 */
  treeSitterClient?: TreeSitterClient;
}

export interface TuiScreen {
  render(event: SessionEvent): void;
  replayTranscript(messages: readonly AgentMessage[]): void;
  println(text: string, tone?: Tone): void;
  setUsage(usage: SessionUsage): void;
  setBranch(branch: string | undefined): void;
  setTransientStatus(status: string | undefined): void;
  resolveApproval(): void;
  getInput(): string;
  setInput(text: string): void;
  clearInput(): void;
  focusInput(): void;
  setSubmitHandler(handler: () => void): void;
  scrollPage(direction: -1 | 1): void;
  destroy(): void;
}

interface AssistantView {
  id: string;
  reasoning: TextRenderable;
  markdown: MarkdownRenderable;
  reasoningBlocks: Map<number, string>;
  textBlocks: Map<number, string>;
}

interface ToolView {
  headline: string;
  name: string;
  text: TextRenderable;
}

export type TuiPhase = 'idle' | 'running' | 'retrying' | 'compacting';

/**
 * TUI 唯一的交互状态投影。它只由 SessionEvent 推导，可随时丢弃重建；
 * 视图标题、Enter 分派和 Esc 语义共享同一个实例，避免各自读取不同状态源。
 */
export class TuiInteractionState {
  #phase: TuiPhase = 'idle';

  get phase(): TuiPhase {
    return this.#phase;
  }

  apply(event: SessionEvent): void {
    switch (event.type) {
      case 'agent_start':
        this.#phase = 'running';
        break;
      case 'agent_end':
        this.#phase = event.willRetry === true ? 'retrying' : 'idle';
        break;
      case 'retry_scheduled':
        this.#phase = 'retrying';
        break;
      case 'compaction_start':
        this.#phase = 'compacting';
        break;
      case 'compaction_end':
        this.#phase = 'idle';
        break;
      case 'error':
        // retry 的取消、sleep 失败和 continue 失败都只以 error 收尾，不再补 agent_end。
        if (event.fatal || this.#phase === 'retrying') this.#phase = 'idle';
        break;
      default:
        break;
    }
  }
}

/** running/retrying 的 Enter 是 steering；compacting 的 prompt 由 Session 暂存。 */
export function tuiEnterState(phase: TuiPhase): 'idle' | 'running' {
  return phase === 'running' || phase === 'retrying' ? 'running' : 'idle';
}

export function tuiCanAbort(phase: TuiPhase): boolean {
  return phase !== 'idle';
}

/** 审批决议必须来自完全无修饰键的 y/a/n/Esc。 */
export function approvalDecisionForKey(
  key: Pick<KeyEvent, 'name' | 'ctrl' | 'meta' | 'shift' | 'option' | 'super' | 'hyper'>,
): ReturnType<typeof approvalKeyDecision> {
  if (key.ctrl || key.meta || key.shift || key.option || key.super || key.hyper) return undefined;
  return approvalKeyDecision(key.name);
}

/**
 * 所有不可信内容进入 OpenTUI 组件前的统一边界。Bun.stripANSI 处理 CSI/OSC/DCS
 * 等完整与未闭合序列；第二步移除其保留的 C0/C1，仅保留 tab/newline。
 */
export function sanitizeTerminalText(text: string): string {
  return Bun.stripANSI(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

/** OSC terminal title 必须保持单行；普通视图文本仍可保留 tab/newline。 */
export function sanitizeTerminalTitle(text: string): string {
  return sanitizeTerminalText(text).replace(/[\t\n]+/g, ' ').trim();
}

/** 1000 制 token 短格式，status/footer 共用。 */
export function formatTokenCount(value: number): string {
  const safe = Math.max(0, Math.round(value));
  if (safe < 1_000) return String(safe);
  if (safe < 1_000_000) return compactNumber(safe / 1_000, 'k');
  return compactNumber(safe / 1_000_000, 'm');
}

/** contextTokens 是最近一次确认的上下文，而不是全会话累计 token。 */
export function formatContextUsage(contextTokens: number, limit?: number): string {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return `context ${formatTokenCount(contextTokens)} tokens · limit unknown`;
  }
  const percent = Math.min(999, Math.max(0, (contextTokens / limit) * 100));
  const percentText = percent > 0 && percent < 10 ? percent.toFixed(1) : percent.toFixed(0);
  return `context ${formatTokenCount(contextTokens)} / ${formatTokenCount(limit)} · ${percentText}%`;
}

/** 只把 HOME 本身或其真实子路径缩写，避免 /Users/a 与 /Users/ab 的前缀误判。 */
export function formatWorkspacePath(cwd: string, home: string): string {
  const normalizedHome = home.endsWith('/') ? home.slice(0, -1) : home;
  if (cwd === normalizedHome) return '~';
  if (cwd.startsWith(`${normalizedHome}/`)) return `~${cwd.slice(normalizedHome.length)}`;
  return cwd;
}

export async function detectGitBranch(cwd: string): Promise<string | undefined> {
  try {
    const child = Bun.spawn(['git', '-C', cwd, 'branch', '--show-current'], {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const [code, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
    ]);
    const branch = stdout.trim();
    return code === 0 && branch !== '' ? branch : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 构建纯视图。生产由 startTui 驱动；测试可用 @opentui/core/testing 注入 renderer，
 * 无需真实 TTY。ScrollBox 的 content minHeight:auto 是“短内容从顶部起排”的关键。
 */
export async function createTuiScreen(
  renderer: CliRenderer,
  opts: TuiScreenOptions,
): Promise<TuiScreen> {
  const {
    BoxRenderable: Box,
    MarkdownRenderable: Markdown,
    RGBA,
    ScrollBoxRenderable: ScrollBox,
    SyntaxStyle: Syntax,
    TextRenderable: Text,
    TextareaRenderable: Textarea,
  } = await import('@opentui/core');

  // 透明背景让终端自身的背景色/透明度透出；前景与语义色仍由 coda 控制。
  const transparentBackground = RGBA.fromValues(0, 0, 0, 0);
  // 正文跟随终端默认前景；OpenTUI 0.4.5 的硬件光标路径会丢失 default
  // intent 并退化为白色 OSC 12，因此光标使用兼顾明暗背景的固定品牌色。
  const terminalForeground = RGBA.defaultForeground();
  const cursorForeground = RGBA.fromHex(PALETTE.cursor);
  const interaction = opts.interaction ?? new TuiInteractionState();
  let approvalPending = false;
  let submitHandler = opts.onSubmit ?? (() => {});
  const colored = <T extends object>(value: T): T | Record<string, never> =>
    opts.color ? value : {};
  const toneColor = (tone: Tone): ColorInput => {
    if (!opts.color) return terminalForeground;
    switch (tone) {
      case 'muted': return PALETTE.muted;
      case 'accent': return PALETTE.accent;
      case 'success': return PALETTE.success;
      case 'warning': return PALETTE.warning;
      case 'danger': return PALETTE.danger;
      case 'cyan': return PALETTE.cyan;
      default: return terminalForeground;
    }
  };

  const syntaxStyle = Syntax.fromStyles({
    default: { fg: terminalForeground },
    'markup.heading.1': { ...(opts.color && { fg: PALETTE.accent }), bold: true },
    'markup.heading.2': { ...(opts.color && { fg: PALETTE.accent }), bold: true },
    'markup.heading.3': { ...(opts.color && { fg: PALETTE.warning }), bold: true },
    'markup.list': opts.color ? { fg: PALETTE.accent } : {},
    'markup.raw': opts.color ? { fg: PALETTE.success } : {},
    'markup.link': opts.color ? { fg: PALETTE.cyan, underline: true } : { underline: true },
    keyword: { ...(opts.color && { fg: PALETTE.accent }), bold: true },
    string: opts.color ? { fg: PALETTE.success } : {},
    number: opts.color ? { fg: PALETTE.warning } : {},
    comment: { ...(opts.color && { fg: PALETTE.muted }), italic: true },
  });

  try {
    const page = new Box(renderer, {
      id: 'coda-page',
      width: '100%',
      height: '100%',
      flexDirection: 'column',
      shouldFill: true,
      backgroundColor: transparentBackground,
    });

    const header = new Box(renderer, {
      id: 'coda-header',
      width: '100%',
      height: 9,
      flexShrink: 0,
      flexDirection: 'row',
      alignItems: 'center',
      border: true,
      title: ` coda v${sanitizeTerminalText(opts.version)} `,
      paddingX: 2,
      columnGap: 2,
      backgroundColor: transparentBackground,
      borderColor: terminalForeground,
      titleColor: terminalForeground,
      ...colored({
        borderColor: PALETTE.border,
        titleColor: PALETTE.accent,
      }),
    });

    const brand = new Box(renderer, {
      id: 'coda-brand',
      width: 43,
      height: '100%',
      flexDirection: 'row',
      alignItems: 'center',
      columnGap: 2,
      flexShrink: 0,
      backgroundColor: transparentBackground,
    });
    const logo = new Text(renderer, {
      id: 'coda-logo',
      width: 16,
      height: 6,
      content: PIXEL_LOGO,
      selectable: false,
      bg: transparentBackground,
      fg: terminalForeground,
      ...colored({ fg: PALETTE.accent }),
    });
    const brandCopy = new Text(renderer, {
      id: 'coda-brand-copy',
      flexGrow: 1,
      height: 5,
      content: 'Welcome back!\n\nA coding agent\nfor your workspace',
      wrapMode: 'word',
      selectable: false,
      bg: transparentBackground,
      fg: terminalForeground,
    });
    brand.add(logo);
    brand.add(brandCopy);

    const tips = new Box(renderer, {
      id: 'coda-tips',
      flexGrow: 1,
      height: 6,
      flexDirection: 'column',
      border: ['left'],
      paddingLeft: 2,
      flexShrink: 1,
      backgroundColor: transparentBackground,
      borderColor: terminalForeground,
      ...colored({
        borderColor: PALETTE.border,
      }),
    });
    const tipsTitle = new Text(renderer, {
      id: 'coda-tips-title',
      height: 1,
      content: 'Tips for getting started',
      selectable: false,
      bg: transparentBackground,
      fg: terminalForeground,
      ...colored({ fg: PALETTE.accent }),
    });
    const tipsBody = new Text(renderer, {
      id: 'coda-tips-body',
      flexGrow: 1,
      content:
        'Enter sends · Shift+Enter adds a line\n' +
        'Esc aborts the current run · PageUp/PageDown scroll\n' +
        '/help shows every shortcut',
      wrapMode: 'word',
      selectable: false,
      bg: transparentBackground,
      fg: terminalForeground,
      ...colored({ fg: PALETTE.muted }),
    });
    tips.add(tipsTitle);
    tips.add(tipsBody);
    header.add(brand);
    header.add(tips);

    const transcript = new ScrollBox(renderer, {
      id: 'coda-transcript',
      width: '100%',
      flexGrow: 1,
      minHeight: 1,
      scrollY: true,
      scrollX: false,
      stickyScroll: true,
      stickyStart: 'bottom',
      viewportCulling: true,
      backgroundColor: transparentBackground,
      wrapperOptions: {
        backgroundColor: transparentBackground,
      },
      viewportOptions: {
        backgroundColor: transparentBackground,
      },
      contentOptions: {
        flexDirection: 'column',
        justifyContent: 'flex-start',
        minHeight: 'auto',
        paddingX: 2,
        paddingTop: TRANSCRIPT_PADDING_Y,
        paddingBottom: TRANSCRIPT_PADDING_Y,
        rowGap: 1,
        backgroundColor: transparentBackground,
      },
      verticalScrollbarOptions: {
        visible: false,
        trackOptions: { visible: false },
      },
    });

    const composer = new Box(renderer, {
      id: 'coda-composer',
      width: '100%',
      height: 1 + PROMPT_RULE_ROWS + COMPOSER_FOOTER_ROWS,
      flexShrink: 0,
      flexDirection: 'column',
      paddingX: COMPOSER_PADDING_X,
      backgroundColor: transparentBackground,
    });
    const promptBox = new Box(renderer, {
      id: 'coda-prompt-box',
      width: '100%',
      height: 1 + PROMPT_RULE_ROWS,
      flexShrink: 0,
      border: ['top', 'bottom'],
      borderStyle: 'single',
      backgroundColor: transparentBackground,
      borderColor: terminalForeground,
      focusedBorderColor: terminalForeground,
      ...colored({
        borderColor: PALETTE.promptBorder,
        focusedBorderColor: PALETTE.promptBorder,
      }),
    });
    const input = new Textarea(renderer, {
      id: 'coda-input',
      width: '100%',
      height: '100%',
      placeholder: '',
      wrapMode: 'word',
      cursorStyle: { style: 'line', blinking: true },
      keyBindings: [
        { name: 'enter', action: 'submit' },
        { name: 'return', action: 'submit' },
        { name: 'kpenter', action: 'submit' },
        { name: 'linefeed', action: 'submit' },
        { name: 'enter', shift: true, action: 'newline' },
        { name: 'return', shift: true, action: 'newline' },
        { name: 'kpenter', shift: true, action: 'newline' },
        { name: 'linefeed', shift: true, action: 'newline' },
      ],
      onSubmit: () => {
        submitHandler();
      },
      onMouseDown() {
        // 全局 autoFocus 保持关闭，把鼠标聚焦行为明确限定在 prompt。
        this.focus();
      },
      backgroundColor: transparentBackground,
      focusedBackgroundColor: transparentBackground,
      textColor: terminalForeground,
      focusedTextColor: terminalForeground,
      placeholderColor: terminalForeground,
      cursorColor: cursorForeground,
      ...colored({
        placeholderColor: PALETTE.muted,
      }),
    });
    promptBox.add(input);

    const refreshCursorVisibility = (): void => {
      input.showCursor = input.visible && !approvalPending;
    };

    const workspaceText = new Text(renderer, {
      id: 'coda-workspace',
      width: '100%',
      height: 1,
      truncate: true,
      selectable: false,
      bg: transparentBackground,
      fg: terminalForeground,
      ...colored({ fg: PALETTE.muted }),
    });
    const runtimeRow = new Box(renderer, {
      id: 'coda-runtime-row',
      width: '100%',
      height: 1,
      flexDirection: 'row',
      justifyContent: 'space-between',
      backgroundColor: transparentBackground,
    });
    const contextText = new Text(renderer, {
      id: 'coda-context',
      flexGrow: 1,
      height: 1,
      truncate: true,
      selectable: false,
      bg: transparentBackground,
      fg: terminalForeground,
      ...colored({ fg: PALETTE.muted }),
    });
    const modelText = new Text(renderer, {
      id: 'coda-model',
      height: 1,
      content: sanitizeTerminalText(`${opts.model.provider}/${opts.model.model}`),
      truncate: true,
      selectable: false,
      bg: transparentBackground,
      fg: terminalForeground,
      ...colored({ fg: PALETTE.muted }),
    });
    runtimeRow.add(contextText);
    runtimeRow.add(modelText);
    composer.add(promptBox);
    composer.add(workspaceText);
    composer.add(runtimeRow);

    page.add(header);
    page.add(transcript);
    page.add(composer);
    renderer.root.add(page);

    let activity: string | undefined;
    let transientStatus: string | undefined;
    let layoutWidth = renderer.width;
    let layoutHeight = renderer.height;
    let headerRows = 9;
    let branch = opts.branch;
    let usage: SessionUsage = {
      cumulative: { input: 0, output: 0 },
      turns: 0,
      contextTokens: 0,
    };
    let steerCount = 0;
    let followUpCount = 0;
    let currentAssistant: AssistantView | undefined;
    let planText: TextRenderable | undefined;
    const toolViews = new Map<string, ToolView>();

    const workspace = formatWorkspacePath(opts.cwd, runtimeHomeDir());

    const textOptions = (tone: Tone): { fg?: ColorInput; bg?: ColorInput } => {
      return { fg: toneColor(tone), bg: transparentBackground };
    };

    const refreshWorkspace = (): void => {
      if (approvalPending) {
        workspaceText.content =
          layoutWidth < 68
            ? 'Approval · y/a/n/Esc'
            : 'Approval required · y once · a always · n deny · Esc abort';
        return;
      }
      workspaceText.content = sanitizeTerminalText(
        branch === undefined ? workspace : `${workspace}  (${branch})`,
      );
    };

    const promptContentWidth = (): number =>
      Math.max(1, layoutWidth - COMPOSER_PADDING_X * 2);

    const setPromptPlaceholder = (value: string): void => {
      input.placeholder = truncateToWidth(firstLine(value), promptContentWidth());
    };

    const refreshComposerLayout = (): void => {
      const workspaceVisible = layoutHeight >= 4 || approvalPending;
      const runtimeVisible = layoutHeight >= 5;
      workspaceText.visible = workspaceVisible;
      runtimeRow.visible = runtimeVisible;
      const footerRows = Number(workspaceVisible) + Number(runtimeVisible);

      const rowsAfterHeaderAndFooter = Math.max(
        0,
        layoutHeight - headerRows - footerRows,
      );
      const promptVisible = rowsAfterHeaderAndFooter >= 1;
      const ruleRows = promptVisible
        ? Math.min(PROMPT_RULE_ROWS, Math.max(0, rowsAfterHeaderAndFooter - 1))
        : 0;
      promptBox.border =
        ruleRows === 2 ? ['top', 'bottom'] : ruleRows === 1 ? ['top'] : [];
      promptBox.visible = promptVisible;
      input.visible = promptVisible;
      // 审批时 draft 被刻意冻结；隐藏光标，避免误导用户以为仍可编辑。
      refreshCursorVisibility();

      const inputAndTranscriptRows = Math.max(
        0,
        rowsAfterHeaderAndFooter - ruleRows,
      );
      const transcriptRows =
        inputAndTranscriptRows >= TRANSCRIPT_PADDED_MIN_ROWS + 1
          ? TRANSCRIPT_PADDED_MIN_ROWS
          : inputAndTranscriptRows >= TRANSCRIPT_MIN_CONTENT_ROWS + 1
            ? TRANSCRIPT_MIN_CONTENT_ROWS
            : 0;
      const transcriptPadding =
        transcriptRows >= TRANSCRIPT_PADDED_MIN_ROWS ? TRANSCRIPT_PADDING_Y : 0;
      transcript.visible = transcriptRows > 0;
      transcript.minHeight = transcriptRows;
      transcript.content.paddingTop = transcriptPadding;
      transcript.content.paddingBottom = transcriptPadding;

      if (!promptVisible) {
        promptBox.height = 0;
        composer.height = footerRows;
        return;
      }

      // resize 回调中 input.width 仍是上一帧；显式按新宽度测量。
      // virtualLineCount 又会被当前 viewport 截断，不能用于自然高度。
      const measurement = input.editorView.measureForDimensions(
        promptContentWidth(),
        PROMPT_MEASURE_HEIGHT,
      );
      const naturalRows = Math.max(1, measurement?.lineCount ?? input.lineCount);
      const viewportRows = Math.max(
        1,
        Math.min(
          PROMPT_MAX_VISIBLE_ROWS,
          inputAndTranscriptRows - transcriptRows,
        ),
      );
      const visibleRows = Math.min(naturalRows, viewportRows);
      promptBox.height = visibleRows + ruleRows;
      composer.height = visibleRows + ruleRows + footerRows;
    };
    input.onContentChange = refreshComposerLayout;

    const defaultActivity = (phase: TuiPhase): string | undefined => {
      switch (phase) {
        case 'running':
          return 'working';
        case 'retrying':
          return 'retrying';
        case 'compacting':
          return 'compacting context';
        case 'idle':
          return undefined;
      }
    };

    const refreshStatus = (): void => {
      const phase = interaction.phase;
      contextText.content = formatContextUsage(usage.contextTokens, opts.contextLimit);
      const queue =
        steerCount > 0 || followUpCount > 0
          ? ` · steer ${steerCount} · follow-up ${followUpCount}`
          : '';
      const compact = layoutWidth < 68;
      if (approvalPending) {
        setPromptPlaceholder('');
        if (opts.color) {
          input.placeholderColor = PALETTE.warning;
          promptBox.borderColor = PALETTE.warning;
          promptBox.focusedBorderColor = PALETTE.warning;
        }
        refreshWorkspace();
        refreshComposerLayout();
        return;
      }
      if (transientStatus !== undefined) {
        setPromptPlaceholder(transientStatus);
      } else if (phase === 'compacting') {
        setPromptPlaceholder(
          compact
            ? 'Compacting · Enter queue · Esc abort'
            : `Compacting context · Enter queue · Alt+Enter follow-up · Esc abort${queue}`,
        );
      } else if (phase === 'running' || phase === 'retrying') {
        const label = activity ?? (phase === 'retrying' ? 'retrying' : 'working');
        setPromptPlaceholder(
          compact
            ? `${label} · Enter steer · Esc abort`
            : `${label} · Enter steer · Alt+Enter follow-up · Esc abort${queue}`,
        );
      } else {
        setPromptPlaceholder('');
      }
      if (opts.color) {
        input.placeholderColor = PALETTE.muted;
        promptBox.borderColor = PALETTE.promptBorder;
        promptBox.focusedBorderColor = PALETTE.promptBorder;
      }
      refreshWorkspace();
      refreshComposerLayout();
    };

    const addText = (content: string, tone: Tone = 'normal'): TextRenderable => {
      const text = new Text(renderer, {
        width: '100%',
        height: 'auto',
        flexShrink: 0,
        content: sanitizeTerminalText(content),
        wrapMode: 'word',
        selectable: true,
        ...textOptions(tone),
      });
      transcript.add(text);
      return text;
    };

    const addUser = (message: UserMessage): void => {
      const body = message.content
        .map((part) =>
          part.type === 'text'
            ? sanitizeTerminalText(part.text)
            : `[image · ${sanitizeTerminalText(part.mimeType)}]`,
        )
        .join('\n')
        .trimEnd();
      if (message.source === 'synthetic') {
        addText(body, 'muted');
      } else if (message.source === 'steering') {
        addText(`» steering\n${body}`, 'cyan');
      } else if (message.source === 'follow_up') {
        addText(`» follow-up\n${body}`, 'cyan');
      } else {
        addText(`you\n${body}`, 'accent');
      }
    };

    const createAssistant = (id: string): AssistantView => {
      const box = new Box(renderer, {
        width: '100%',
        height: 'auto',
        flexShrink: 0,
        flexDirection: 'column',
        rowGap: 0,
        backgroundColor: transparentBackground,
      });
      const label = new Text(renderer, {
        width: '100%',
        height: 1,
        content: 'coda',
        selectable: false,
        ...textOptions('accent'),
      });
      const reasoning = new Text(renderer, {
        width: '100%',
        height: 'auto',
        flexShrink: 0,
        content: '',
        visible: false,
        wrapMode: 'word',
        ...textOptions('muted'),
      });
      const markdown = new Markdown(renderer, {
        width: '100%',
        height: 'auto',
        flexShrink: 0,
        content: '',
        visible: false,
        syntaxStyle,
        streaming: true,
        conceal: true,
        concealCode: false,
        internalBlockMode: 'top-level',
        ...(opts.treeSitterClient !== undefined && {
          treeSitterClient: opts.treeSitterClient,
        }),
        bg: transparentBackground,
        fg: terminalForeground,
      });
      box.add(label);
      box.add(reasoning);
      box.add(markdown);
      transcript.add(box);
      return {
        id,
        reasoning,
        markdown,
        reasoningBlocks: new Map(),
        textBlocks: new Map(),
      };
    };

    const joinedBlocks = (blocks: ReadonlyMap<number, string>): string =>
      [...blocks.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, text]) => text)
        .filter((text) => text !== '')
        .join('\n\n');

    const refreshAssistant = (view: AssistantView, streaming: boolean): void => {
      const reasoningContent = joinedBlocks(view.reasoningBlocks);
      const textContent = joinedBlocks(view.textBlocks);
      view.reasoning.content =
        reasoningContent === '' ? '' : `thinking\n${reasoningContent}`;
      view.reasoning.visible = reasoningContent !== '';
      view.markdown.content = textContent;
      view.markdown.visible = textContent !== '';
      view.markdown.streaming = streaming;
    };

    const syncAssistant = (view: AssistantView, message: AssistantMessage): void => {
      view.reasoningBlocks.clear();
      view.textBlocks.clear();
      for (const [index, part] of message.content.entries()) {
        if (part.type === 'reasoning') {
          view.reasoningBlocks.set(index, sanitizeTerminalText(part.text));
        } else if (part.type === 'text') {
          view.textBlocks.set(index, sanitizeTerminalText(part.text));
        }
      }
      refreshAssistant(view, false);
    };

    const addAssistantMessage = (message: AssistantMessage): void => {
      const view = createAssistant(message.id);
      syncAssistant(view, message);
      addAssistantWarning(message);
    };

    const addAssistantWarning = (message: AssistantMessage): void => {
      if (message.stopReason === 'length') {
        addText('[output truncated by model limit]', 'warning');
      } else if (message.stopReason === 'aborted') {
        addText('[aborted]', 'warning');
      } else if (message.stopReason === 'error') {
        addText(`[error] ${message.errorMessage ?? 'provider error'}`, 'danger');
      }
    };

    const resultHead = (result: ToolResultMessage): string =>
      firstLine(
        result.content.find((part): part is { type: 'text'; text: string } => part.type === 'text')
          ?.text ?? '',
      );

    const onToolStart = (
      toolCallId: string,
      toolName: string,
      args: unknown,
    ): void => {
      const safeToolName = firstLine(sanitizeTerminalText(toolName));
      const rawHeadline = toolHeadline(toolName, args);
      const headline =
        rawHeadline === undefined ? undefined : sanitizeTerminalText(rawHeadline);
      activity = `${safeToolName} running`;
      refreshStatus();
      if (headline === undefined) return;
      const text = addText(`● ${headline}`, 'cyan');
      toolViews.set(toolCallId, { headline, name: safeToolName, text });
    };

    const onToolUpdate = (toolCallId: string, output: string): void => {
      const view = toolViews.get(toolCallId);
      if (view === undefined) return;
      const safeOutput = sanitizeTerminalText(output);
      const tail = truncateToWidth(firstLineFromEnd(safeOutput.trimEnd()), 88);
      view.text.content = tail === '' ? `● ${view.headline}` : `● ${view.headline}\n  ↳ ${tail}`;
    };

    const onToolEnd = (toolCallId: string, result: ToolResultMessage): void => {
      const view = toolViews.get(toolCallId);
      const head = truncateToWidth(sanitizeTerminalText(resultHead(result)), 96);
      const suffix = toolDetailsSuffix(result);
      const marker = result.isError ? '✗' : '✓';
      const finalText = sanitizeTerminalText(
        `${marker} ${view?.headline ?? result.toolName}` +
          (suffix !== undefined ? ` · ${suffix}` : head !== '' ? ` · ${head}` : ''),
      );
      let renderedAsPlan = false;
      if (result.toolName === 'plan') {
        const steps = planStepsFromDetails(result.details);
        if (!result.isError && steps !== undefined) {
          updatePlan(steps);
          renderedAsPlan = true;
        }
      }
      if (view === undefined) {
        if (!renderedAsPlan) {
          addText(finalText, result.isError ? 'danger' : 'success');
        }
      } else {
        view.text.content = finalText;
        if (opts.color) view.text.fg = result.isError ? PALETTE.danger : PALETTE.success;
        toolViews.delete(toolCallId);
      }
      addDiff(result.details);
      activity = defaultActivity(interaction.phase);
      refreshStatus();
    };

    const addDiff = (details: unknown): void => {
      const diff = stringField(asRecord(details), 'diff');
      if (diff === undefined || diff === '') return;
      const lines = diff.replace(/\n$/, '').split('\n');
      for (const line of lines.slice(0, DIFF_MAX_LINES)) {
        const tone: Tone =
          line.startsWith('+') && !line.startsWith('+++')
            ? 'success'
            : line.startsWith('-') && !line.startsWith('---')
              ? 'danger'
              : line.startsWith('@@')
                ? 'cyan'
                : 'muted';
        addText(`  ${line}`, tone);
      }
      if (lines.length > DIFF_MAX_LINES) {
        addText(`  … ${lines.length - DIFF_MAX_LINES} more diff lines`, 'muted');
      }
    };

    const updatePlan = (steps: Extract<SessionEvent, { type: 'plan_update' }>['steps']): void => {
      const content = [
        'plan',
        ...steps.map((step) => {
          const glyph =
            step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '▶' : '○';
          return `${glyph} ${sanitizeTerminalText(step.step)}`;
        }),
      ].join('\n');
      if (planText === undefined) {
        planText = addText(content, 'muted');
      } else {
        planText.content = content;
      }
    };

    const onProviderUpdate = (
      messageId: string,
      event: Extract<SessionEvent, { type: 'message_update' }>['event'],
    ): void => {
      if (currentAssistant === undefined || currentAssistant.id !== messageId) {
        currentAssistant = createAssistant(messageId);
      }
      const view = currentAssistant;
      switch (event.type) {
        case 'text_start': {
          const part = event.partial.content[event.contentIndex];
          const initial = part?.type === 'text' ? sanitizeTerminalText(part.text) : '';
          view.textBlocks.set(event.contentIndex, initial);
          refreshAssistant(view, true);
          break;
        }
        case 'text_delta': {
          const previous = view.textBlocks.get(event.contentIndex) ?? '';
          view.textBlocks.set(
            event.contentIndex,
            previous + sanitizeTerminalText(event.delta),
          );
          refreshAssistant(view, true);
          break;
        }
        case 'text_end':
          view.textBlocks.set(event.contentIndex, sanitizeTerminalText(event.content));
          refreshAssistant(view, true);
          break;
        case 'reasoning_start': {
          const part = event.partial.content[event.contentIndex];
          const initial = part?.type === 'reasoning' ? sanitizeTerminalText(part.text) : '';
          view.reasoningBlocks.set(event.contentIndex, initial);
          refreshAssistant(view, true);
          break;
        }
        case 'reasoning_delta': {
          const previous = view.reasoningBlocks.get(event.contentIndex) ?? '';
          view.reasoningBlocks.set(
            event.contentIndex,
            previous + sanitizeTerminalText(event.delta),
          );
          refreshAssistant(view, true);
          break;
        }
        case 'reasoning_end':
          view.reasoningBlocks.set(event.contentIndex, sanitizeTerminalText(event.content));
          refreshAssistant(view, true);
          break;
        case 'tool_call_start': {
          const part = event.partial.content[event.contentIndex];
          const name = part?.type === 'tool_call' ? part.name : 'tool';
          activity = `preparing ${firstLine(sanitizeTerminalText(name))}`;
          refreshStatus();
          break;
        }
        case 'tool_call_delta':
        case 'tool_call_end':
        case 'start':
        case 'done':
        case 'error':
          break;
        default:
          break;
      }
    };

    const render = (event: SessionEvent): void => {
      interaction.apply(event);
      switch (event.type) {
        case 'agent_start':
          transientStatus = undefined;
          activity = event.reason === 'follow_up' ? 'follow-up' : 'working';
          if (event.reason === 'follow_up') addText('↪ follow-up', 'cyan');
          refreshStatus();
          break;
        case 'agent_end':
          currentAssistant = undefined;
          if (event.willRetry === true) {
            activity = 'retrying';
          } else {
            transientStatus = undefined;
            activity = undefined;
            const label =
              event.reason === 'completed'
                ? '∙ done'
                : event.reason === 'aborted'
                  ? '∙ aborted'
                  : '∙ ended with error';
            addText(label, event.reason === 'error' ? 'danger' : 'muted');
          }
          refreshStatus();
          break;
        case 'turn_start':
          break;
        case 'turn_end':
          break;
        case 'message_start':
          if (event.message.role === 'user') {
            addUser(event.message);
          } else if (event.message.role === 'assistant') {
            currentAssistant = createAssistant(event.message.id);
          }
          break;
        case 'message_update':
          onProviderUpdate(event.messageId, event.event);
          break;
        case 'message_end':
          if (event.message.role === 'assistant') {
            const view =
              currentAssistant?.id === event.message.id
                ? currentAssistant
                : createAssistant(event.message.id);
            syncAssistant(view, event.message);
            addAssistantWarning(event.message);
            currentAssistant = undefined;
          }
          break;
        case 'tool_execution_start':
          approvalPending = false;
          onToolStart(event.toolCallId, event.toolName, event.args);
          break;
        case 'tool_execution_update':
          if (typeof event.update.output === 'string') {
            onToolUpdate(event.toolCallId, event.update.output);
          }
          break;
        case 'tool_execution_end':
          onToolEnd(event.toolCallId, event.result);
          break;
        case 'queue_update':
          steerCount = event.steering.length;
          followUpCount = event.followUp.length;
          refreshStatus();
          break;
        case 'plan_update':
          updatePlan(event.steps);
          break;
        case 'approval_request':
          approvalPending = true;
          addText(`? approval required\n${event.description}`, 'warning');
          refreshStatus();
          break;
        case 'error':
          if (interaction.phase === 'idle') transientStatus = undefined;
          activity = defaultActivity(interaction.phase);
          addText(
            `${event.fatal ? '✖ fatal' : '⚠ warning'} · ${event.message}`,
            event.fatal ? 'danger' : 'warning',
          );
          refreshStatus();
          break;
        case 'usage_update':
          usage = event.usage;
          refreshStatus();
          break;
        case 'retry_scheduled':
          activity = `retry ${event.attempt}/${event.maxAttempts}`;
          addText(
            `↻ retry ${event.attempt}/${event.maxAttempts} in ${event.delayMs}ms · ${event.errorMessage}`,
            'warning',
          );
          refreshStatus();
          break;
        case 'compaction_start':
          activity = 'compacting context';
          addText('⋯ compacting context…', 'muted');
          refreshStatus();
          break;
        case 'compaction_end':
          transientStatus = undefined;
          addText(
            event.ok
              ? `⋯ compaction done · dropped ${event.droppedMessages} messages`
              : '⋯ compaction failed',
            event.ok ? 'muted' : 'warning',
          );
          activity = defaultActivity(interaction.phase);
          refreshStatus();
          break;
        default:
          break;
      }
    };

    const replayTranscript = (messages: readonly AgentMessage[]): void => {
      if (messages.length === 0) return;
      addText(`— resumed session · ${messages.length} messages —`, 'muted');
      for (const message of messages) {
        if (message.role === 'user') addUser(message);
        else if (message.role === 'assistant') {
          addAssistantMessage(message);
          for (const part of message.content) {
            if (part.type === 'tool_call') {
              onToolStart(part.id, part.name, part.arguments);
            }
          }
        }
        else onToolEnd(message.toolCallId, message);
      }
      activity = undefined;
      refreshStatus();
    };

    const applyResponsiveLayout = (width: number, height: number): void => {
      layoutWidth = width;
      layoutHeight = height;
      const showHeader = height >= MIN_HEADER_VIEWPORT_ROWS;
      const showTips = showHeader && width >= 78 && height >= 22;
      const showLogo = showHeader && width >= 58 && height >= 18;
      header.visible = showHeader;
      tips.visible = showTips;
      logo.visible = showLogo;
      headerRows = showHeader ? (showTips ? 9 : showLogo ? 8 : 4) : 0;
      header.height = headerRows;
      brand.width = showTips ? (width < 100 ? 38 : 43) : '100%';
      brandCopy.content = showLogo
        ? 'Welcome back!\n\nA coding agent\nfor your workspace'
        : `coda v${sanitizeTerminalText(opts.version)}\nA focused coding agent`;
      brandCopy.height = showLogo ? 5 : 2;
      modelText.visible = width >= 52;
      refreshStatus();
    };

    const onResize = (width: number, height: number): void => {
      applyResponsiveLayout(width, height);
    };
    renderer.on('resize', onResize);
    applyResponsiveLayout(renderer.width, renderer.height);

    return {
      render,
      replayTranscript,
      println: addText,
      setUsage(nextUsage: SessionUsage): void {
        usage = nextUsage;
        refreshStatus();
      },
      setBranch(nextBranch: string | undefined): void {
        branch = nextBranch;
        refreshWorkspace();
      },
      setTransientStatus(status: string | undefined): void {
        transientStatus =
          status === undefined ? undefined : sanitizeTerminalText(status);
        refreshStatus();
      },
      resolveApproval(): void {
        approvalPending = false;
        refreshStatus();
      },
      getInput: () => input.plainText,
      setInput(text: string): void {
        input.setText(text);
        input.gotoBufferEnd();
      },
      clearInput(): void {
        input.clear();
      },
      focusInput(): void {
        input.focus();
      },
      setSubmitHandler(handler: () => void): void {
        submitHandler = handler;
      },
      scrollPage(direction: -1 | 1): void {
        transcript.scrollBy(direction * 0.8, 'viewport');
      },
      destroy(): void {
        renderer.off('resize', onResize);
        syntaxStyle.destroy();
      },
    };
  } catch (error) {
    renderer.destroy();
    syntaxStyle.destroy();
    throw error;
  }
}

/**
 * 生产入口只负责 native renderer 与视图初始化；交互控制器单独导出供内存终端测试。
 */
export async function startTui(
  session: Session,
  approval: ReplApproval | undefined,
  opts: TuiOptions,
): Promise<number> {
  const openTui = await import('@opentui/core');
  const branch = opts.branch ?? (await detectGitBranch(opts.cwd));
  const interaction = new TuiInteractionState();
  const transparentBackground = openTui.RGBA.fromValues(0, 0, 0, 0);
  const renderer = await openTui.createCliRenderer({
    screenMode: 'alternate-screen',
    clearOnShutdown: true,
    exitOnCtrlC: false,
    exitSignals: [],
    autoFocus: false,
    consoleMode: 'disabled',
    openConsoleOnError: false,
    targetFps: 30,
    maxFps: 30,
    useMouse: true,
    useKittyKeyboard: {},
    // 0.4.5 的运行时构造器尚未读取该字段；保留它以兼容修复后的版本。
    backgroundColor: transparentBackground,
  });

  let initializingScreen: TuiScreen | undefined;
  try {
    // 0.4.5 必须通过 setter 同步 native framebuffer；背景透明与 NO_COLOR 无关。
    // 视图树也逐层使用 alpha=0，避免任何子组件重新画出不透明色块。
    renderer.setBackgroundColor(transparentBackground);
    renderer.setTerminalTitle(sanitizeTerminalTitle(`coda · ${opts.model.model}`));
    initializingScreen = await createTuiScreen(renderer, {
      ...opts,
      branch,
      interaction,
    });
    initializingScreen.setUsage(session.usage());
    if (opts.resumed === true) initializingScreen.replayTranscript(session.messages);
    initializingScreen.focusInput();
  } catch (error) {
    renderer.destroy();
    initializingScreen?.destroy();
    throw error;
  }
  const screen = initializingScreen;

  return runTuiController(session, approval, screen, renderer, {
    model: opts.model,
    interaction,
  });
}

interface TuiControllerOptions {
  model: ModelRef;
  interaction: TuiInteractionState;
  /** 内存测试禁用 process signal 接线，避免并行用例互相影响。 */
  installSignalHandlers?: boolean;
}

type TuiControllerRenderer = Pick<CliRenderer, 'keyInput' | 'idle' | 'destroy'>;

/**
 * 复用 classic REPL 的纯交互决策，保证 prompt/steer/follow-up/审批语义
 * 不因换渲染框架而分叉。返回前总是关闭 Session 并恢复 renderer。
 */
export function runTuiController(
  session: Session,
  approval: ReplApproval | undefined,
  screen: TuiScreen,
  renderer: TuiControllerRenderer,
  opts: TuiControllerOptions,
): Promise<number> {
  const history = new InputHistory();
  const escExit = new DoublePress(ESC_EXIT_WINDOW_MS);
  const ctrlCExit = new DoublePress(CTRL_C_EXIT_WINDOW_MS);
  const approvalQueue: string[] = [];
  let lastQueues: { steering: QueuedMessage[]; followUp: QueuedMessage[] } = {
    steering: [],
    followUp: [],
  };
  let closing = false;

  return new Promise<number>((resolve) => {
    const printError = (error: unknown): void => {
      screen.println(
        `prompt failed · ${error instanceof Error ? error.message : String(error)}`,
        'danger',
      );
    };

    const runCommand = (command: SlashCommand): void => {
      switch (command.cmd) {
        case 'quit':
          void shutdown(0);
          break;
        case 'help':
          for (const line of HELP_LINES) screen.println(line, 'muted');
          break;
        case 'status':
          for (const line of formatStatusLines(session.usage(), opts.model.model)) {
            screen.println(line, 'muted');
          }
          break;
        case 'queue':
          for (const line of formatQueueLines(lastQueues.steering, lastQueues.followUp)) {
            screen.println(line, 'muted');
          }
          break;
        case 'follow_up':
          if (command.text !== '') session.followUp(command.text);
          break;
        case 'unknown':
          screen.println(`unknown command: ${command.input} (try /help)`, 'warning');
          break;
      }
    };

    function submit(meta: boolean): void {
      if (closing || approvalQueue.length > 0) return;
      const raw = screen.getInput();
      const action = decideEnter(tuiEnterState(opts.interaction.phase), meta, raw);
      if (action.kind === 'none') {
        screen.clearInput();
        return;
      }
      history.push(raw);
      try {
        switch (action.kind) {
          case 'prompt':
            session.prompt(action.text).catch(printError);
            break;
          case 'steer':
            session.steer(action.text);
            break;
          case 'follow_up':
            session.followUp(action.text);
            break;
          case 'command':
            runCommand(action.command);
            break;
        }
      } catch (error) {
        printError(error);
      }
      screen.clearInput();
    }
    screen.setSubmitHandler(() => {
      submit(false);
    });

    const consume = (key: KeyEvent): void => {
      key.preventDefault();
      key.stopPropagation();
    };

    const onKeyPress = (key: KeyEvent): void => {
      if (closing) return;
      const isEnter = key.name === 'return' || key.name === 'enter' || key.name === 'kpenter';
      if (key.name !== 'escape') escExit.reset();
      if (!(key.ctrl && key.name === 'c')) ctrlCExit.reset();
      screen.setTransientStatus(undefined);

      if (key.name === 'pageup' || key.name === 'pagedown') {
        screen.scrollPage(key.name === 'pageup' ? -1 : 1);
        consume(key);
        return;
      }

      if (approvalQueue.length > 0 && approval?.broker !== undefined) {
        const decision = approvalDecisionForKey(key);
        if (decision === 'abort') {
          consume(key);
          escExit.reset();
          approvalQueue.length = 0;
          session.abort();
          approval.onAbort();
          screen.resolveApproval();
          return;
        }
        if (decision !== undefined) {
          consume(key);
          const id = approvalQueue.shift();
          if (id !== undefined) approval.broker.resolve(id, decision);
          if (approvalQueue.length === 0) screen.resolveApproval();
          return;
        }
        // 审批中其余键（含所有修饰键组合）全部冻结，不能编辑 prompt。
        consume(key);
        return;
      }

      if (isEnter && key.meta) {
        submit(true);
        consume(key);
        return;
      }
      if (key.meta && key.name === 'up') {
        screen.setInput(history.up(screen.getInput()));
        consume(key);
        return;
      }
      if (key.meta && key.name === 'down') {
        screen.setInput(history.down());
        consume(key);
        return;
      }
      if (key.ctrl && key.name === 'c') {
        consume(key);
        if (screen.getInput() !== '') {
          screen.clearInput();
          ctrlCExit.reset();
        } else if (ctrlCExit.hit(Date.now())) {
          void shutdown(0);
        } else {
          screen.setTransientStatus('press Ctrl+C again to exit');
        }
        return;
      }
      if (key.ctrl && key.name === 'd') {
        consume(key);
        if (screen.getInput() === '' && opts.interaction.phase === 'idle') void shutdown(0);
        return;
      }
      if (key.name === 'escape') {
        consume(key);
        if (escExit.hit(Date.now())) {
          void shutdown(0);
        } else if (tuiCanAbort(opts.interaction.phase)) {
          session.abort();
          screen.setTransientStatus('aborting…');
        } else {
          screen.setTransientStatus('press Esc again to exit');
        }
      }
    };

    const onPaste = (event: PasteEvent): void => {
      if (closing || approvalQueue.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
    };

    const unsubSession = session.subscribe((event) => {
      if (event.type === 'queue_update') {
        lastQueues = {
          steering: [...event.steering],
          followUp: [...event.followUp],
        };
      }
      try {
        screen.render(event);
      } catch (error) {
        screen.println(
          `TUI render failed · ${error instanceof Error ? error.message : String(error)}`,
          'danger',
        );
        void shutdown(1, true);
        return;
      }
      if (event.type === 'error' && event.fatal) void shutdown(1, true);
    });
    const unsubApproval = approval?.subscribe((event) => {
      if (event.type !== 'approval_request') return;
      escExit.reset();
      approvalQueue.push(event.approvalId);
      screen.render(event);
    });

    const onSignal = (): void => {
      void shutdown(0, true);
    };

    const cleanup = (): void => {
      screen.setSubmitHandler(() => {});
      renderer.keyInput.off('keypress', onKeyPress);
      renderer.keyInput.off('paste', onPaste);
      if (opts.installSignalHandlers !== false) {
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
        process.removeListener('SIGHUP', onSignal);
      }
      unsubSession();
      unsubApproval?.();
      approvalQueue.length = 0;
    };

    async function shutdown(code: number, forceAbort = false): Promise<void> {
      if (closing) return;
      closing = true;
      cleanup();
      try {
        if (forceAbort || tuiCanAbort(opts.interaction.phase)) {
          session.abort();
          approval?.onAbort();
        }
        await session.close();
        await renderer.idle();
      } catch (error) {
        code = 1;
        console.error('[coda] TUI shutdown failed:', error);
      } finally {
        renderer.destroy();
        screen.destroy();
        resolve(code);
      }
    }

    renderer.keyInput.on('keypress', onKeyPress);
    renderer.keyInput.on('paste', onPaste);
    if (opts.installSignalHandlers !== false) {
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);
      process.once('SIGHUP', onSignal);
    }
  });
}

function compactNumber(value: number, suffix: string): string {
  const digits = value < 10 ? 1 : 0;
  return `${value.toFixed(digits).replace(/\.0$/, '')}${suffix}`;
}

function firstLine(text: string): string {
  const newline = text.indexOf('\n');
  return newline === -1 ? text : text.slice(0, newline);
}

function firstLineFromEnd(text: string): string {
  const newline = text.lastIndexOf('\n');
  return newline === -1 ? text : text.slice(newline + 1);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === 'string' ? candidate : undefined;
}

function planStepsFromDetails(details: unknown): PlanStep[] | undefined {
  const candidate = asRecord(details)['steps'];
  if (!Array.isArray(candidate)) return undefined;
  const steps: PlanStep[] = [];
  for (const value of candidate) {
    const step = asRecord(value);
    const text = stringField(step, 'step');
    const status = step['status'];
    if (
      text === undefined ||
      (status !== 'pending' && status !== 'in_progress' && status !== 'completed')
    ) {
      return undefined;
    }
    steps.push({ step: sanitizeTerminalText(text), status });
  }
  return steps;
}

function toolDetailsSuffix(result: ToolResultMessage): string | undefined {
  const details = asRecord(result.details);
  const parts: string[] = [];
  const path = stringField(details, 'path');
  if (path !== undefined) parts.push(shortenPath(path));
  if (typeof details['totalLines'] === 'number') {
    parts.push(`${details['totalLines']} lines`);
  }
  if (typeof details['additions'] === 'number' && typeof details['deletions'] === 'number') {
    parts.push(`+${details['additions']} -${details['deletions']}`);
  }
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function shortenPath(value: string): string {
  const parts = value.split('/').filter((part) => part !== '');
  return parts.length <= 2 ? value : parts.slice(-2).join('/');
}
