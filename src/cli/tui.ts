// 全屏交互 TUI(规格见 docs/09-cli.md §1–5):OpenTUI 独占 raw stdin/stdout，
// 直接把 SessionEvent 投影为顶部向下增长的转录区，并把输入框和三行状态固定在底部。
// 本模块只在双 TTY 的交互分支动态加载；headless 与一次性模式不加载 native TUI 依赖。

import type {
  AgentMessage,
  AssistantMessage,
  ModelRef,
  PlanStep,
  QueuedMessage,
  ToolResultMessage,
  UserMessage,
  WorkspaceRuntimeSnapshot,
} from '../protocol/index.js';
import type {
  CliInteractionState as SessionInteractionState,
  CliSessionEvent as SessionEvent,
  CliSessionUsage as SessionUsage,
} from './frontend-types.js';
import { runtimeHomeDir } from '../shared/index.js';
import type {
  CliSession,
  InteractiveSession,
} from './interactive-runtime.js';
import {
  ProviderCommandController,
  type ProviderCommandChoice,
} from './provider-commands.js';
import type { ProviderRegistry } from './provider-registry.js';
import {
  collectDoctorReport,
  formatAuthStatusLines,
  formatDoctorReportLines,
} from './product-commands.js';
import {
  sanitizeTerminalError,
  sanitizeTerminalText,
  sanitizeTerminalTitle,
} from './terminal-sanitize.js';
import {
  commandPaletteEntries,
  renderInteractiveHelp,
} from './command-catalog.js';
import type { CommandAvailability } from './command-catalog.js';
import {
  applyWorkspaceCompletion,
  copyTextToClipboard,
  editDraftWithExternalEditor,
  exportTranscript,
  promptHistoryEntries,
  transcriptContent,
  workspaceCompletionAtCursor,
  workspacePathCandidates,
} from './presentation-actions.js';
import {
  persistableDraft,
  type ThreadPresentationState,
  type ThreadPresentationStore,
  type TranscriptScrollAnchor,
} from './presentation-state.js';
export { sanitizeTerminalText, sanitizeTerminalTitle };
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
  interactionCanAbort,
  interactionEnterState,
  SLASH_COMMAND_SPECS,
} from './repl.js';
import type { ReplApproval, SlashCommand, SlashCommandSpec } from './repl.js';
import type {
  CliRenderer,
  ColorInput,
  KeyEvent,
  MarkdownRenderable,
  PasteEvent,
  Renderable,
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

const DIFF_MAX_LINES = 24;
const COMPOSER_PADDING_X = 1;
const PROMPT_MAX_VISIBLE_ROWS = 8;
const PROMPT_MEASURE_HEIGHT = 65_535;
const PROMPT_RULE_ROWS = 2;
const COMPOSER_FOOTER_ROWS = 3;
const PROMPT_MENU_MAX_ROWS = 8;
const SLASH_COMMAND_COLUMN_WIDTH = 32;
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
  model?: ModelRef;
  version: string;
  color: boolean;
  contextLimit?: number;
  resumed?: boolean;
  branch?: string;
  gitDirty?: boolean;
  threadId?: string;
  workspaceSnapshot: Readonly<WorkspaceRuntimeSnapshot>;
  eventHighWaterSeq?: () => number;
  presentation?: {
    readonly store: ThreadPresentationStore;
    readonly editDraft?: (draft: string) => Promise<string>;
    readonly copyText?: (text: string) => Promise<void>;
  };
  providerCommands?: {
    registry: ProviderRegistry;
    runtime: InteractiveSession;
  };
  projectRuleWarnings?: ProjectRuleWarningSource;
}

interface ProjectRuleWarningSource {
  subscribeWarnings(listener: (message: string) => void): () => void;
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
  setGitDirty(dirty: boolean): void;
  setTransientStatus(status: string | undefined): void;
  setCommandPrompt(
    prompt: string | undefined,
    secret: boolean,
    choices?: readonly ProviderCommandChoice[],
  ): void;
  setModel(model: ModelRef | undefined, contextLimit?: number): void;
  setProviderCommandsAvailable(available: boolean): void;
  resolveApproval(): void;
  getInput(): string;
  setInput(text: string): void;
  clearInput(): void;
  focusInput(): void;
  handleSlashMenuKey(key: KeyEvent): boolean;
  setSubmitHandler(handler: () => void): void;
  setInputChangeHandler(handler: (draft: string) => void): void;
  markInteracted(): void;
  openCommandPalette(): void;
  openTranscriptSearch(): void;
  searchTranscript(query: string, direction?: -1 | 1): boolean;
  jumpToLatest(): void;
  restorePresentation(state: ThreadPresentationState): void;
  setVimEnabled(enabled: boolean): void;
  handleComposerModeKey(key: KeyEvent): boolean;
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

interface PromptMenuItem {
  kind: 'slash' | 'command' | 'file';
  key: string;
  value: string;
  label: string;
  description?: string;
  availability?: CommandAvailability;
  replacement?: {
    readonly start: number;
    readonly end: number;
  };
}

export type TuiPhase = SessionInteractionState;

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
  return interactionEnterState(phase);
}

export function tuiCanAbort(phase: TuiPhase): boolean {
  return interactionCanAbort(phase);
}

/** 审批决议必须来自完全无修饰键的 y/a/n/Esc。 */
export function approvalDecisionForKey(
  key: Pick<KeyEvent, 'name' | 'ctrl' | 'meta' | 'shift' | 'option' | 'super' | 'hyper'>,
): ReturnType<typeof approvalKeyDecision> {
  if (key.ctrl || key.meta || key.shift || key.option || key.super || key.hyper) return undefined;
  return approvalKeyDecision(key.name);
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

export interface GitStatus {
  readonly branch?: string;
  readonly dirty: boolean;
}

export async function detectGitStatus(cwd: string): Promise<GitStatus> {
  try {
    const child = Bun.spawn(
      ['git', '-C', cwd, 'status', '--porcelain=v1', '--branch', '--untracked-files=normal'],
      {
      stdout: 'pipe',
      stderr: 'ignore',
      },
    );
    const [code, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
    ]);
    if (code !== 0) return { dirty: false };
    return parseGitStatusOutput(stdout);
  } catch {
    return { dirty: false };
  }
}

export function parseGitStatusOutput(stdout: string): GitStatus {
  const lines = stdout.replaceAll('\r\n', '\n').split('\n');
  const heading = lines[0]?.startsWith('## ') === true ? lines[0].slice(3) : '';
  const branch = heading
    .replace(/^No commits yet on /u, '')
    .split('...')[0]
    ?.trim();
  return {
    ...(branch === undefined || branch === '' || branch === 'HEAD (no branch)'
      ? {}
      : { branch }),
    dirty: lines.slice(1).some((line) => line !== ''),
  };
}

/** Compatibility helper retained for callers/tests that only need the branch label. */
export async function detectGitBranch(cwd: string): Promise<string | undefined> {
  return (await detectGitStatus(cwd)).branch;
}

/** Compatibility projection of the canonical fuzzy palette's currently enabled actions. */
export function matchingSlashCommands(
  text: string,
  phase: TuiPhase,
): readonly SlashCommandSpec[] {
  if (!/^\/[^\s/]*$/u.test(text)) return [];
  return commandPaletteEntries(text.slice(1), {
    phase,
    approvalPending: false,
    providerPromptActive: false,
    providerCommandsAvailable: true,
    hasModel: true,
    hasTranscript: true,
    hasStash: true,
  })
    .filter((entry) => entry.availability.kind === 'enabled')
    .map((entry) => entry.command);
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
  let commandPrompt: string | undefined;
  let commandChoices: readonly ProviderCommandChoice[] = [];
  let secretInput = false;
  let secretValue = '';
  let rewritingSecret = false;
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
      content: opts.model === undefined
        ? 'Welcome!\n\nConnect a model\nto start coding'
        : 'Welcome back!\n\nA coding agent\nfor your workspace',
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
      content: opts.model === undefined
        ? '1. /login — save an API key\n' +
          '2. /model — choose a model\n' +
          '3. Enter a task · OAuth coming soon (disabled)'
        : 'Enter sends · Shift+Enter adds a line\n' +
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
    const slashMenu = new Box(renderer, {
      id: 'coda-slash-menu',
      width: '100%',
      height: 0,
      visible: false,
      flexShrink: 0,
      flexDirection: 'column',
      backgroundColor: transparentBackground,
    });
    const slashRows = Array.from({ length: PROMPT_MENU_MAX_ROWS }, (_, index) => {
      const row = new Box(renderer, {
        id: `coda-slash-row-${index}`,
        width: '100%',
        height: 1,
        visible: false,
        flexShrink: 0,
        flexDirection: 'row',
        backgroundColor: transparentBackground,
      });
      const prefix = new Text(renderer, {
        id: `coda-slash-prefix-${index}`,
        width: 2,
        height: 1,
        content: '  ',
        selectable: false,
        bg: transparentBackground,
        fg: terminalForeground,
      });
      const command = new Text(renderer, {
        id: `coda-slash-command-${index}`,
        width: SLASH_COMMAND_COLUMN_WIDTH,
        height: 1,
        truncate: true,
        selectable: false,
        bg: transparentBackground,
        fg: terminalForeground,
      });
      const description = new Text(renderer, {
        id: `coda-slash-description-${index}`,
        flexGrow: 1,
        height: 1,
        truncate: true,
        selectable: false,
        bg: transparentBackground,
        fg: terminalForeground,
        ...colored({ fg: PALETTE.muted }),
      });
      row.add(prefix);
      row.add(command);
      row.add(description);
      slashMenu.add(row);
      return { row, prefix, command, description };
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
    const taskText = new Text(renderer, {
      id: 'coda-task-status',
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
      content: sanitizeTerminalText(formatModelRef(opts.model)),
      truncate: true,
      selectable: false,
      bg: transparentBackground,
      fg: terminalForeground,
      ...colored({ fg: PALETTE.muted }),
    });
    runtimeRow.add(contextText);
    runtimeRow.add(modelText);
    composer.add(slashMenu);
    composer.add(promptBox);
    composer.add(taskText);
    composer.add(workspaceText);
    composer.add(runtimeRow);

    page.add(header);
    page.add(transcript);
    page.add(composer);
    renderer.root.add(page);

    let activity: string | undefined;
    let transientStatus: string | undefined;
    let inputChangeHandler: (draft: string) => void = () => {};
    let layoutWidth = renderer.width;
    let layoutHeight = renderer.height;
    let headerRows = 9;
    let branch = opts.branch;
    let gitDirty = opts.gitDirty ?? false;
    let hasInteracted = opts.resumed === true ||
      (opts.presentation?.store.snapshot().draft ?? '') !== '';
    let selectedModel = opts.model;
    let providerCommandsAvailable = opts.providerCommands !== undefined;
    let selectedContextLimit = opts.contextLimit;
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
    let promptMenuMode: 'none' | 'slash' | 'command' | 'file' = 'none';
    let promptMenuItems: readonly PromptMenuItem[] = [];
    let promptMenuSelectedIndex = 0;
    let promptMenuKey = '';
    let slashMenuDismissedInput: string | undefined;
    let vimEnabled = opts.presentation?.store.snapshot().vimEnabled ?? false;
    let vimInsertMode = !vimEnabled;
    let manuallyScrolled = false;
    let mouseScrollStateScheduled = false;
    let pendingScrollAnchor: TranscriptScrollAnchor | undefined;
    let scrollRestoreScheduled = false;
    let unreadAfterSeq = opts.presentation?.store.snapshot().unreadAfterSeq ?? 0;
    let lastObservedHighWater = opts.eventHighWaterSeq?.() ?? 0;
    let transcriptSearchQuery = opts.presentation?.store.snapshot().search?.query ?? '';
    let transcriptSearchOrdinal = opts.presentation?.store.snapshot().search?.matchOrdinal ?? 0;
    let blockSequence = 0;

    interface TranscriptBlock {
      readonly key: string;
      readonly renderable: Renderable;
      readonly text: () => string;
    }
    const transcriptBlocks: TranscriptBlock[] = [];

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
        branch === undefined
          ? workspace
          : `${workspace}  (${branch}${gitDirty ? '*' : ''})`,
      );
    };

    const shortThreadId = (): string => {
      const threadId = opts.threadId ?? 'unattached';
      return threadId.length <= 12 ? threadId : `…${threadId.slice(-10)}`;
    };

    const unreadCount = (): number => unreadAfterSeq === 0
      ? 0
      : Math.max(1, lastObservedHighWater - unreadAfterSeq);

    const refreshTaskStatus = (): void => {
      const phase = approvalPending ? 'approval' : interaction.phase;
      const queue = `${steerCount}/${followUpCount}`;
      const permission = opts.workspaceSnapshot.permissions.mode;
      const unread = unreadCount();
      const vim = vimEnabled ? ` · VIM ${vimInsertMode ? 'INSERT' : 'NORMAL'}` : '';
      const newOutput = unread > 0 ? ` · ${unread} new` : '';
      const activityLabel = activity === undefined ? '' : `:${firstLine(activity)}`;
      taskText.content = sanitizeTerminalText(
        layoutWidth < 68
          ? `${phase}${activityLabel} · ${permission} · q ${queue}${newOutput}${vim}`
          : `${phase}${activityLabel} · thread ${shortThreadId()} · permissions ${permission} · ` +
            `queue ${queue}${newOutput}${vim}`,
      );
    };

    const promptContentWidth = (): number =>
      Math.max(1, layoutWidth - COMPOSER_PADDING_X * 2);

    const setPromptPlaceholder = (value: string): void => {
      input.placeholder = truncateToWidth(firstLine(value), promptContentWidth());
    };

    const refreshPromptMenu = (): void => {
      const source = input.plainText;
      let nextMode: typeof promptMenuMode = 'none';
      let nextItems: readonly PromptMenuItem[] = [];
      let completionQuery = '';
      if (!approvalPending && !secretInput) {
        if (commandPrompt !== undefined && commandChoices.length > 0) {
          const query = source.trim().toLocaleLowerCase('en-US');
          nextMode = 'command';
          nextItems = commandChoices
            .filter((choice) => {
              if (query === '') return true;
              return [choice.label, choice.value, choice.description]
                .filter((part): part is string => part !== undefined)
                .some((part) =>
                  part.toLocaleLowerCase('en-US').includes(query),
                );
            })
            .map((choice) => ({
              kind: 'command',
              key: `${choice.value}\0${choice.label}`,
              value: choice.value,
              label: choice.label,
              ...(choice.description !== undefined && {
                description: choice.description,
              }),
            }));
        } else if (commandPrompt === undefined && slashMenuDismissedInput !== source) {
          if (/^\/[^\s/]*$/u.test(source)) {
            nextMode = 'slash';
            nextItems = commandPaletteEntries(source.slice(1), {
              phase: interaction.phase,
              approvalPending,
              providerPromptActive: false,
              providerCommandsAvailable,
              hasModel: selectedModel !== undefined,
              hasTranscript: transcriptBlocks.length > 0,
              hasStash: opts.presentation?.store.snapshot().stashedDraft !== undefined,
            }).map(({ command, availability }) => ({
              kind: 'slash',
              key: `${command.name}\0${availability.kind}`,
              value: command.name,
              label:
                `[${command.category}] /${command.name}` +
                (command.argumentHint === undefined ? '' : ` ${command.argumentHint}`),
              description: [
                command.description,
                command.shortcuts[0],
                availability.kind === 'disabled'
                  ? `unavailable: ${availability.reason}`
                  : undefined,
              ].filter((part): part is string => part !== undefined).join(' · '),
              availability,
            }));
          } else {
            const completion = workspaceCompletionAtCursor(
              source,
              input.cursorOffset,
              opts.cwd,
              50,
            );
            if (completion !== undefined) {
              completionQuery = completion.query.toLocaleLowerCase('en-US');
              nextMode = 'file';
              nextItems = completion.candidates.map((candidate) => ({
                kind: 'file',
                key: candidate,
                value: candidate,
                label: `@${candidate}`,
                description: candidate.endsWith('/') ? 'directory' : 'file',
                replacement: { start: completion.start, end: completion.end },
              }));
            }
          }
        }
      }
      if (nextItems.length === 0) nextMode = 'none';
      const nextKey = `${nextMode}\0${interaction.phase}\0${source}\0${nextItems
        .map((item) => item.key)
        .join('\0')}`;
      if (nextKey !== promptMenuKey) {
        const query =
          nextMode === 'slash'
            ? source.slice(1).toLocaleLowerCase('en-US')
            : nextMode === 'file'
              ? completionQuery
              : source.trim().toLocaleLowerCase('en-US');
        const exact =
          nextMode === 'slash'
            ? nextItems.findIndex((item) => {
                const command = SLASH_COMMAND_SPECS.find(
                  (candidate) => candidate.name === item.value,
                );
                return (
                  item.value.toLocaleLowerCase('en-US') === query ||
                  command?.aliases?.some(
                    (alias) =>
                      alias.toLocaleLowerCase('en-US') === query,
                  ) === true
                );
              })
            : nextItems.findIndex(
                (item) =>
                  item.value.toLocaleLowerCase('en-US') === query ||
                  item.label.toLocaleLowerCase('en-US') === query,
              );
        promptMenuSelectedIndex = exact === -1 ? 0 : exact;
        promptMenuKey = nextKey;
      } else if (promptMenuSelectedIndex >= nextItems.length) {
        promptMenuSelectedIndex = Math.max(0, nextItems.length - 1);
      }
      promptMenuMode = nextMode;
      promptMenuItems = nextItems;
    };

    const renderSlashRows = (visibleRows: number): void => {
      slashMenu.visible = visibleRows > 0;
      slashMenu.height = visibleRows;
      const descriptionVisible = layoutWidth >= 52;
      const startIndex = Math.max(
        0,
        Math.min(
          promptMenuSelectedIndex - Math.floor(visibleRows / 2),
          promptMenuItems.length - visibleRows,
        ),
      );
      for (const [rowIndex, parts] of slashRows.entries()) {
        const itemIndex = startIndex + rowIndex;
        const item =
          rowIndex < visibleRows ? promptMenuItems[itemIndex] : undefined;
        parts.row.visible = item !== undefined;
        if (item === undefined) continue;
        const selected = itemIndex === promptMenuSelectedIndex;
        const disabled = item.availability?.kind === 'disabled';
        const selectedColor: ColorInput =
          opts.color
            ? disabled
              ? PALETTE.warning
              : PALETTE.accent
            : terminalForeground;
        parts.prefix.content = selected ? (disabled ? '× ' : '→ ') : '  ';
        parts.command.content = item.label;
        parts.description.content = item.description ?? '';
        parts.command.width = descriptionVisible
          ? SLASH_COMMAND_COLUMN_WIDTH
          : Math.max(1, promptContentWidth() - 2);
        parts.description.visible =
          descriptionVisible && item.description !== undefined;
        parts.prefix.fg = selected ? selectedColor : terminalForeground;
        parts.command.fg = selected
          ? selectedColor
          : disabled
            ? toneColor('muted')
            : terminalForeground;
        parts.description.fg = selected
          ? selectedColor
          : toneColor('muted');
      }
    };

    const refreshComposerLayout = (): void => {
      refreshPromptMenu();
      const taskVisible = layoutHeight >= 3;
      const workspaceVisible = layoutHeight >= 4 || approvalPending;
      const runtimeVisible = layoutHeight >= 5;
      taskText.visible = taskVisible;
      workspaceText.visible = workspaceVisible;
      runtimeRow.visible = runtimeVisible;
      const footerRows =
        Number(taskVisible) + Number(workspaceVisible) + Number(runtimeVisible);

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
        promptMenuItems.length > 0
          ? inputAndTranscriptRows >= TRANSCRIPT_MIN_CONTENT_ROWS + 1
            ? TRANSCRIPT_MIN_CONTENT_ROWS
            : 0
          : inputAndTranscriptRows >= TRANSCRIPT_PADDED_MIN_ROWS + 1
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
        renderSlashRows(0);
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
      const menuRows = Math.min(
        promptMenuItems.length,
        slashRows.length,
        Math.max(
          0,
          inputAndTranscriptRows - transcriptRows - 1,
        ),
      );
      renderSlashRows(menuRows);
      const viewportRows = Math.max(
        1,
        Math.min(
          PROMPT_MAX_VISIBLE_ROWS,
          inputAndTranscriptRows - transcriptRows - menuRows,
        ),
      );
      const visibleRows = Math.min(naturalRows, viewportRows);
      promptBox.height = visibleRows + ruleRows;
      composer.height = menuRows + visibleRows + ruleRows + footerRows;
    };

    const completeSelectedMenuItem = (): boolean => {
      const selected = promptMenuItems[promptMenuSelectedIndex];
      if (selected === undefined || !slashMenu.visible) return false;
      if (selected.availability?.kind === 'disabled') {
        transientStatus = selected.availability.reason;
        refreshTaskStatus();
        return true;
      }
      if (selected.kind === 'file' && promptMenuMode === 'file') {
        const replacement = selected.replacement;
        if (replacement === undefined) return false;
        const applied = applyWorkspaceCompletion(
          input.plainText,
          {
            ...replacement,
            query: input.plainText.slice(replacement.start + 1, replacement.end),
            candidates: [selected.value],
          },
          selected.value,
        );
        input.setText(applied.text);
        input.cursorOffset = applied.cursor;
        return true;
      }
      if (selected.kind !== 'slash' || promptMenuMode !== 'slash') return false;
      slashMenuDismissedInput = undefined;
      input.setText(`/${selected.value} `);
      input.gotoBufferEnd();
      return true;
    };

    const selectedCommandChoice = (): string | undefined => {
      const selected = promptMenuItems[promptMenuSelectedIndex];
      return selected?.kind === 'command' &&
        promptMenuMode === 'command' &&
        slashMenu.visible
        ? selected.value
        : undefined;
    };

    const handleSlashMenuKey = (key: KeyEvent): boolean => {
      if (key.ctrl || key.meta || key.shift || key.option || key.super || key.hyper) {
        return false;
      }
      if (key.name === 'tab') {
        if (promptMenuMode === 'command' && slashMenu.visible) return true;
        const source = input.plainText;
        if (!/^\/[^\s/]*$/u.test(source) && promptMenuMode !== 'file') return false;
        slashMenuDismissedInput = undefined;
        refreshComposerLayout();
        completeSelectedMenuItem();
        return true;
      }
      if (!slashMenu.visible || promptMenuItems.length === 0) return false;
      if (key.name === 'up' || key.name === 'down') {
        const delta = key.name === 'up' ? -1 : 1;
        promptMenuSelectedIndex =
          (promptMenuSelectedIndex + delta + promptMenuItems.length) %
          promptMenuItems.length;
        renderSlashRows(slashMenu.height);
        return true;
      }
      if (
        key.name === 'escape' &&
        (promptMenuMode === 'slash' || promptMenuMode === 'file')
      ) {
        slashMenuDismissedInput = input.plainText;
        refreshComposerLayout();
        return true;
      }
      return false;
    };

    const synchronizeSecretInput = (): void => {
      if (!secretInput || rewritingSecret) return;
      const rendered = input.plainText;
      const cursorAfter = input.cursorOffset;
      const old = secretValue;
      const mask = '•';
      let start = cursorAfter;
      let inserted = '';
      let removed = 0;

      const firstRaw = [...rendered].findIndex((character) => character !== mask);
      if (firstRaw >= 0) {
        let endRaw = firstRaw;
        while (endRaw < rendered.length && rendered[endRaw] !== mask) endRaw++;
        start = firstRaw;
        inserted = rendered.slice(firstRaw, endRaw);
        removed = Math.max(0, old.length + inserted.length - rendered.length);
      } else if (rendered.length < old.length) {
        start = cursorAfter;
        removed = old.length - rendered.length;
      } else if (rendered.length > old.length) {
        const insertedLength = rendered.length - old.length;
        start = Math.max(0, cursorAfter - insertedLength);
        inserted = rendered.slice(start, start + insertedLength);
      } else {
        return;
      }

      start = Math.max(0, Math.min(start, old.length));
      removed = Math.max(0, Math.min(removed, old.length - start));
      secretValue =
        old.slice(0, start) + inserted + old.slice(start + removed);
      rewritingSecret = true;
      input.setText(mask.repeat(secretValue.length));
      input.cursorOffset = start + inserted.length;
      rewritingSecret = false;
    };

    const handleComposerModeKey = (key: KeyEvent): boolean => {
      if (!vimEnabled || secretInput || approvalPending) return false;
      if (key.ctrl || key.meta || key.option || key.super || key.hyper) return false;
      if (vimInsertMode) {
        if (key.name !== 'escape') return false;
        vimInsertMode = false;
        refreshTaskStatus();
        return true;
      }
      switch (key.name) {
        case 'i':
          vimInsertMode = true;
          refreshTaskStatus();
          return true;
        case 'a':
          input.moveCursorRight();
          vimInsertMode = true;
          refreshTaskStatus();
          return true;
        case 'h':
        case 'left':
          input.moveCursorLeft();
          return true;
        case 'l':
        case 'right':
          input.moveCursorRight();
          return true;
        case 'j':
        case 'down':
          input.moveCursorDown();
          return true;
        case 'k':
        case 'up':
          input.moveCursorUp();
          return true;
        case '0':
        case 'home':
          input.gotoLineStart();
          return true;
        case '$':
        case 'end':
          input.gotoLineTextEnd();
          return true;
        case 'x':
        case 'delete':
          input.deleteChar();
          return true;
        case 'u':
          input.undo();
          return true;
        case 'escape':
          // A second Esc keeps the product's existing abort/exit semantics.
          return false;
        default:
          return true;
      }
    };

    input.onSubmit = () => {
      if (promptMenuItems[promptMenuSelectedIndex]?.availability?.kind === 'disabled') {
        completeSelectedMenuItem();
        return;
      }
      completeSelectedMenuItem();
      submitHandler();
    };
    input.onKeyDown = (key) => {
      if (handleComposerModeKey(key)) {
        key.preventDefault();
        key.stopPropagation();
        return;
      }
      if (
        secretInput &&
        key.ctrl &&
        (key.name === 'z' || key.name === 'y')
      ) {
        key.preventDefault();
        key.stopPropagation();
        return;
      }
      if (!handleSlashMenuKey(key)) return;
      key.preventDefault();
      key.stopPropagation();
    };
    input.onContentChange = () => {
      synchronizeSecretInput();
      if (slashMenuDismissedInput !== input.plainText) {
        slashMenuDismissedInput = undefined;
      }
      if (!secretInput) {
        inputChangeHandler(input.plainText);
        if (input.plainText !== '') markInteracted();
      }
      refreshComposerLayout();
    };

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
      refreshTaskStatus();
      contextText.content = formatContextUsage(usage.contextTokens, selectedContextLimit);
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
      if (commandPrompt !== undefined) {
        setPromptPlaceholder(commandPrompt);
      } else if (transientStatus !== undefined) {
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

    const registerTranscriptBlock = (
      requestedKey: string,
      renderable: Renderable,
      text: () => string,
    ): void => {
      let key = requestedKey;
      while (transcriptBlocks.some((block) => block.key === key)) {
        key = `${requestedKey}:${++blockSequence}`;
      }
      renderable.id = `coda-transcript-block-${++blockSequence}`;
      transcriptBlocks.push({ key, renderable, text });
    };

    const captureScrollAnchor = (): TranscriptScrollAnchor | undefined => {
      if (transcriptBlocks.length === 0) return undefined;
      const recoverable = transcriptBlocks.filter((block) =>
        block.key.startsWith('message:') || block.key.startsWith('tool:'));
      const anchors = recoverable.length > 0 ? recoverable : transcriptBlocks;
      const top = transcript.scrollTop;
      let index = 0;
      for (let candidate = 0; candidate < anchors.length; candidate++) {
        const block = anchors[candidate];
        if (block !== undefined && block.renderable.y <= top) index = candidate;
      }
      const selected = anchors[index];
      if (selected === undefined) return undefined;
      const fallbackBlockKeys = [
        ...anchors.slice(Math.max(0, index - 4), index).reverse(),
        ...anchors.slice(index + 1, index + 5),
      ].map((block) => block.key);
      return {
        blockKey: selected.key,
        logicalOffset: Math.max(0, top - selected.renderable.y),
        fallbackBlockKeys,
        observedHighWaterSeq: lastObservedHighWater,
      };
    };

    const persistScrollState = (): void => {
      if (!manuallyScrolled) return;
      opts.presentation?.store.setScrollState(
        captureScrollAnchor(),
        unreadAfterSeq,
      );
    };

    const observeOutputEvent = (visibleOutput = true): void => {
      const current = opts.eventHighWaterSeq?.() ?? lastObservedHighWater + 1;
      if (!visibleOutput) {
        lastObservedHighWater = Math.max(lastObservedHighWater, current);
        return;
      }
      if (manuallyScrolled && current > lastObservedHighWater) {
        if (unreadAfterSeq === 0) unreadAfterSeq = lastObservedHighWater;
        lastObservedHighWater = current;
        persistScrollState();
      } else {
        lastObservedHighWater = Math.max(lastObservedHighWater, current);
        if (!manuallyScrolled) {
          unreadAfterSeq = 0;
          opts.presentation?.store.markRead();
        }
      }
      refreshTaskStatus();
    };

    const addText = (
      content: string,
      tone: Tone = 'normal',
      blockKey = `event:${++blockSequence}`,
    ): TextRenderable => {
      const safeContent = sanitizeTerminalText(content);
      const text = new Text(renderer, {
        width: '100%',
        height: 'auto',
        flexShrink: 0,
        content: safeContent,
        wrapMode: 'word',
        selectable: true,
        ...textOptions(tone),
      });
      transcript.add(text);
      registerTranscriptBlock(blockKey, text, () => safeContent);
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
        addText(body, 'muted', `message:${message.id}`);
      } else if (message.source === 'steering') {
        addText(`» steering\n${body}`, 'cyan', `message:${message.id}`);
      } else if (message.source === 'follow_up') {
        addText(`» follow-up\n${body}`, 'cyan', `message:${message.id}`);
      } else {
        addText(`you\n${body}`, 'accent', `message:${message.id}`);
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
      const view: AssistantView = {
        id,
        reasoning,
        markdown,
        reasoningBlocks: new Map(),
        textBlocks: new Map(),
      };
      registerTranscriptBlock(
        `message:${id}`,
        box,
        () => `${joinedBlocks(view.reasoningBlocks)}\n${joinedBlocks(view.textBlocks)}`,
      );
      return view;
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
      const text = addText(`● ${headline}`, 'cyan', `tool:${toolCallId}`);
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

    const restoreScrollAnchor = (
      anchor: TranscriptScrollAnchor,
    ): boolean => {
      const candidates = [anchor.blockKey, ...anchor.fallbackBlockKeys];
      const block = candidates
        .map((key) => transcriptBlocks.find((candidate) => candidate.key === key))
        .find((candidate) => candidate !== undefined);
      if (block === undefined) return false;
      transcript.scrollTop = Math.max(0, block.renderable.y + anchor.logicalOffset);
      manuallyScrolled = true;
      return true;
    };
    const scheduleScrollRestore = (anchor: TranscriptScrollAnchor): void => {
      pendingScrollAnchor = anchor;
      if (scrollRestoreScheduled) return;
      scrollRestoreScheduled = true;
      renderer.once('frame', () => {
        scrollRestoreScheduled = false;
        const pending = pendingScrollAnchor;
        pendingScrollAnchor = undefined;
        if (pending !== undefined && !restoreScrollAnchor(pending)) {
          transientStatus = 'saved scroll anchor was compacted; showing surviving transcript';
        }
        renderer.requestRender();
      });
      renderer.requestRender();
    };

    const jumpToLatest = (): void => {
      transcript.scrollTo({ x: 0, y: transcript.scrollHeight });
      manuallyScrolled = false;
      unreadAfterSeq = 0;
      lastObservedHighWater = opts.eventHighWaterSeq?.() ?? lastObservedHighWater;
      opts.presentation?.store.markRead();
      refreshStatus();
    };

    const searchTranscript = (query: string, direction: -1 | 1 = 1): boolean => {
      const safeQuery = sanitizeTerminalText(query).trim();
      if (safeQuery !== '') {
        if (safeQuery !== transcriptSearchQuery) transcriptSearchOrdinal = 0;
        transcriptSearchQuery = safeQuery;
      }
      if (transcriptSearchQuery === '') {
        transientStatus = 'start with /search <query>';
        refreshStatus();
        return false;
      }
      const folded = transcriptSearchQuery.toLocaleLowerCase('en-US');
      const matches = transcriptBlocks.filter((block) =>
        block.text().toLocaleLowerCase('en-US').includes(folded));
      if (matches.length === 0) {
        transientStatus = `no matches · ${transcriptSearchQuery}`;
        refreshStatus();
        return false;
      }
      if (safeQuery === '') {
        transcriptSearchOrdinal =
          (transcriptSearchOrdinal + direction + matches.length) % matches.length;
      } else {
        transcriptSearchOrdinal = Math.min(transcriptSearchOrdinal, matches.length - 1);
      }
      const match = matches[transcriptSearchOrdinal];
      if (match === undefined) return false;
      transcript.scrollChildIntoView(match.renderable.id);
      manuallyScrolled = true;
      transientStatus =
        `match ${transcriptSearchOrdinal + 1}/${matches.length} · ${transcriptSearchQuery}`;
      opts.presentation?.store.setSearch({
        query: transcriptSearchQuery,
        matchOrdinal: transcriptSearchOrdinal,
      });
      persistScrollState();
      refreshStatus();
      return true;
    };

    const markInteracted = (): void => {
      if (hasInteracted) return;
      hasInteracted = true;
      applyResponsiveLayout(layoutWidth, layoutHeight);
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
            markInteracted();
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
      observeOutputEvent(
        event.type !== 'queue_update' &&
        event.type !== 'usage_update' &&
        event.type !== 'turn_start' &&
        event.type !== 'turn_end',
      );
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
      if (hasInteracted) {
        const showCompactHeader = height >= MIN_HEADER_VIEWPORT_ROWS;
        header.visible = showCompactHeader;
        tips.visible = false;
        logo.visible = false;
        headerRows = showCompactHeader ? 3 : 0;
        header.height = headerRows;
        brand.width = '100%';
        brandCopy.height = 1;
        brandCopy.content = sanitizeTerminalText(
          `coda · ${shortThreadId()} · ${formatModelRef(selectedModel)}`,
        );
        modelText.visible = true;
        refreshStatus();
        return;
      }
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
        ? selectedModel === undefined
          ? 'Welcome!\n\nConnect a model\nto start coding'
          : 'Welcome back!\n\nA coding agent\nfor your workspace'
        : `coda v${sanitizeTerminalText(opts.version)}\nA focused coding agent`;
      brandCopy.height = showLogo ? 5 : 2;
      modelText.visible = true;
      refreshStatus();
    };

    const onResize = (width: number, height: number): void => {
      const anchor = manuallyScrolled ? captureScrollAnchor() : undefined;
      applyResponsiveLayout(width, height);
      if (anchor !== undefined) {
        scheduleScrollRestore(anchor);
      }
    };
    transcript.onMouseScroll = (event) => {
      const direction = event.scroll?.direction;
      if (direction !== 'up' && direction !== 'down') return;
      if (direction === 'up') manuallyScrolled = true;
      if (!manuallyScrolled || mouseScrollStateScheduled) return;
      mouseScrollStateScheduled = true;
      // ScrollBox applies its built-in wheel movement during the same dispatch. Persist on the
      // next frame so the stable anchor reflects the resulting viewport, not the prior one.
      renderer.once('frame', () => {
        mouseScrollStateScheduled = false;
        const maximum = Math.max(0, transcript.scrollHeight - transcript.viewport.height);
        if (transcript.scrollTop >= maximum - 1) jumpToLatest();
        else {
          persistScrollState();
          refreshTaskStatus();
        }
      });
      renderer.requestRender();
    };
    renderer.on('resize', onResize);
    applyResponsiveLayout(renderer.width, renderer.height);

    return {
      render,
      replayTranscript,
      println(text: string, tone: Tone = 'normal'): void {
        addText(text, tone);
        observeOutputEvent();
      },
      setUsage(nextUsage: SessionUsage): void {
        usage = nextUsage;
        refreshStatus();
      },
      setBranch(nextBranch: string | undefined): void {
        branch = nextBranch;
        refreshWorkspace();
      },
      setGitDirty(nextDirty: boolean): void {
        gitDirty = nextDirty;
        refreshWorkspace();
      },
      setTransientStatus(status: string | undefined): void {
        transientStatus =
          status === undefined ? undefined : sanitizeTerminalText(status);
        refreshStatus();
      },
      setCommandPrompt(
        prompt: string | undefined,
        secret: boolean,
        choices?: readonly ProviderCommandChoice[],
      ): void {
        commandPrompt =
          prompt === undefined ? undefined : sanitizeTerminalText(prompt);
        commandChoices = (choices ?? []).map((choice) => ({
          value: choice.value,
          label: sanitizeTerminalText(choice.label),
          ...(choice.description !== undefined && {
            description: sanitizeTerminalText(choice.description),
          }),
        }));
        secretInput = secret;
        secretValue = '';
        rewritingSecret = true;
        input.clear();
        rewritingSecret = false;
        refreshStatus();
      },
      setModel(model: ModelRef | undefined, contextLimit?: number): void {
        selectedModel = model;
        selectedContextLimit = contextLimit;
        modelText.content = sanitizeTerminalText(formatModelRef(selectedModel));
        renderer.setTerminalTitle(
          sanitizeTerminalTitle(
            selectedModel === undefined
              ? 'coda · no model'
              : `coda · ${selectedModel.model}`,
          ),
        );
        refreshStatus();
      },
      setProviderCommandsAvailable(available: boolean): void {
        providerCommandsAvailable = available;
        refreshComposerLayout();
      },
      resolveApproval(): void {
        approvalPending = false;
        refreshStatus();
      },
      getInput: () =>
        secretInput
          ? secretValue
          : (selectedCommandChoice() ?? input.plainText),
      setInput(text: string): void {
        if (secretInput) {
          secretValue = text;
          rewritingSecret = true;
          input.setText('•'.repeat(text.length));
          rewritingSecret = false;
        } else {
          input.setText(text);
        }
        input.gotoBufferEnd();
      },
      clearInput(): void {
        secretValue = '';
        rewritingSecret = true;
        input.clear();
        rewritingSecret = false;
      },
      focusInput(): void {
        input.focus();
      },
      handleSlashMenuKey,
      setSubmitHandler(handler: () => void): void {
        submitHandler = handler;
      },
      setInputChangeHandler(handler: (draft: string) => void): void {
        inputChangeHandler = handler;
      },
      markInteracted,
      openCommandPalette(): void {
        slashMenuDismissedInput = undefined;
        input.setText('/');
        input.gotoBufferEnd();
        refreshComposerLayout();
      },
      openTranscriptSearch(): void {
        input.setText('/search ');
        input.gotoBufferEnd();
        refreshComposerLayout();
      },
      searchTranscript,
      jumpToLatest,
      restorePresentation(state: ThreadPresentationState): void {
        vimEnabled = state.vimEnabled;
        vimInsertMode = !vimEnabled;
        unreadAfterSeq = state.unreadAfterSeq <= lastObservedHighWater
          ? state.unreadAfterSeq
          : 0;
        transcriptSearchQuery = state.search?.query ?? '';
        transcriptSearchOrdinal = state.search?.matchOrdinal ?? 0;
        if (state.draft !== '') input.setText(state.draft);
        input.gotoBufferEnd();
        if (state.scrollAnchor !== undefined) scheduleScrollRestore(state.scrollAnchor);
        refreshStatus();
      },
      setVimEnabled(enabled: boolean): void {
        vimEnabled = enabled;
        vimInsertMode = !enabled;
        refreshStatus();
      },
      handleComposerModeKey,
      scrollPage(direction: -1 | 1): void {
        transcript.scrollBy(direction * 0.8, 'viewport');
        if (direction < 0) {
          manuallyScrolled = true;
          persistScrollState();
          refreshTaskStatus();
        } else {
          const maximum = Math.max(0, transcript.scrollHeight - transcript.viewport.height);
          if (transcript.scrollTop >= maximum - 1) jumpToLatest();
          else persistScrollState();
        }
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
  session: CliSession,
  approval: ReplApproval | undefined,
  opts: TuiOptions,
): Promise<number> {
  const openTui = await import('@opentui/core');
  const detectedGit = opts.branch === undefined || opts.gitDirty === undefined
    ? await detectGitStatus(opts.cwd)
    : { branch: opts.branch, dirty: opts.gitDirty };
  const branch = opts.branch ?? detectedGit.branch;
  const gitDirty = opts.gitDirty ?? detectedGit.dirty;
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
    renderer.setTerminalTitle(
      sanitizeTerminalTitle(
        opts.model === undefined ? 'coda · no model' : `coda · ${opts.model.model}`,
      ),
    );
    initializingScreen = await createTuiScreen(renderer, {
      ...opts,
      branch,
      gitDirty,
      interaction,
    });
    initializingScreen.setUsage(session.usage());
    if (opts.resumed === true) initializingScreen.replayTranscript(session.messages);
    if (opts.presentation !== undefined) {
      initializingScreen.restorePresentation(opts.presentation.store.snapshot());
    }
    initializingScreen.focusInput();
  } catch (error) {
    renderer.destroy();
    initializingScreen?.destroy();
    throw error;
  }
  const screen = initializingScreen;

  return runTuiController(session, approval, screen, renderer, {
    interaction,
    ...(opts.projectRuleWarnings !== undefined && {
      projectRuleWarnings: opts.projectRuleWarnings,
    }),
    ...(opts.providerCommands !== undefined && {
      providerCommands: opts.providerCommands,
    }),
    cwd: opts.cwd,
    version: opts.version,
    ...(opts.presentation !== undefined && { presentation: opts.presentation }),
  });
}

interface TuiControllerOptions {
  interaction: TuiInteractionState;
  cwd?: string;
  version?: string;
  presentation?: TuiOptions['presentation'];
  providerCommands?: {
    registry: ProviderRegistry;
    runtime: InteractiveSession;
  };
  projectRuleWarnings?: ProjectRuleWarningSource;
  /** 内存测试禁用 process signal 接线，避免并行用例互相影响。 */
  installSignalHandlers?: boolean;
}

type TuiControllerRenderer =
  Pick<CliRenderer, 'keyInput' | 'idle' | 'destroy'> &
  Partial<Pick<CliRenderer, 'suspend' | 'resume' | 'copyToClipboardOSC52'>>;

/**
 * 复用 classic REPL 的纯交互决策，保证 prompt/steer/follow-up/审批语义
 * 不因换渲染框架而分叉。返回前总是关闭 Session 并恢复 renderer。
 */
export function runTuiController(
  session: CliSession,
  approval: ReplApproval | undefined,
  screen: TuiScreen,
  renderer: TuiControllerRenderer,
  opts: TuiControllerOptions,
): Promise<number> {
  const history = new InputHistory();
  for (const prompt of promptHistoryEntries(session.messages)) history.push(prompt);
  const escExit = new DoublePress(ESC_EXIT_WINDOW_MS);
  const ctrlCExit = new DoublePress(CTRL_C_EXIT_WINDOW_MS);
  const approvalQueue: string[] = [];
  let lastQueues: { steering: QueuedMessage[]; followUp: QueuedMessage[] } = {
    steering: [],
    followUp: [],
  };
  let closing = false;
  let editing = false;
  let paletteReturnDraft: string | undefined;
  let latestPromptDraft = opts.presentation?.store.snapshot().draft ?? screen.getInput();
  let providerTaskDraft: string | undefined;
  let providerInputActive = false;
  let providerBeginning = false;
  let reverseSearchQuery: string | undefined;
  const enqueueApproval = (approvalId: string): boolean => {
    if (approvalQueue.includes(approvalId)) return false;
    approvalQueue.push(approvalId);
    return true;
  };

  return new Promise<number>((resolve) => {
    const printError = (error: unknown): void => {
      screen.println(
        `prompt failed · ${error instanceof Error ? error.message : String(error)}`,
        'danger',
      );
    };

    screen.setInputChangeHandler((draft) => {
      if (providerInputActive || draft.startsWith('/')) return;
      latestPromptDraft = draft;
      opts.presentation?.store.setDraft(persistableDraft(draft));
    });

    const restoreProviderTaskDraft = (): string => {
      const draft = providerTaskDraft ?? latestPromptDraft;
      providerTaskDraft = undefined;
      providerInputActive = false;
      latestPromptDraft = draft;
      if (!closing) screen.setInput(draft);
      return draft;
    };

    const providerController =
      opts.providerCommands === undefined
        ? undefined
        : new ProviderCommandController(
            opts.providerCommands.registry,
            opts.providerCommands.runtime,
            {
              println: (text, tone) => {
                screen.println(text, tone);
              },
              setCommandPrompt: (prompt, secret, choices) => {
                screen.setCommandPrompt(prompt, secret, choices);
                if (prompt === undefined && !providerBeginning) {
                  restoreProviderTaskDraft();
                }
              },
              setModel: (model, contextLimit) => {
                screen.setModel(model, contextLimit);
              },
            },
          );

    const beginProviderCommand = (
      command: 'login' | 'model' | 'logout',
    ): string => {
      if (providerController === undefined) return latestPromptDraft;
      providerTaskDraft ??= paletteReturnDraft ?? latestPromptDraft;
      paletteReturnDraft = undefined;
      providerInputActive = true;
      providerBeginning = true;
      providerController.begin(command);
      providerBeginning = false;
      providerInputActive = providerController.active;
      return providerController.active ? '' : restoreProviderTaskDraft();
    };
    screen.setProviderCommandsAvailable(providerController !== undefined);

    const unsubscribeProjectWarnings = opts.projectRuleWarnings?.subscribeWarnings((message) => {
      try {
        screen.println(`⚠ project rules · ${message}`, 'warning');
      } catch {
        // warning 是非致命旁路；视图失败不能打断或悬挂 session 生命周期。
      }
    });

    const editComposerDraft = async (draft: string): Promise<void> => {
      if (opts.presentation === undefined || editing) {
        if (opts.presentation === undefined) {
          screen.println('/edit is unavailable without presentation storage', 'warning');
        }
        return;
      }
      editing = true;
      screen.setTransientStatus('editing draft in $EDITOR…');
      renderer.suspend?.();
      try {
        const edited = await (
          opts.presentation.editDraft?.(draft) ??
          editDraftWithExternalEditor(draft, { cwd: opts.cwd ?? process.cwd() })
        );
        if (!closing) {
          screen.setInput(edited);
          screen.println('Draft returned from $EDITOR.', 'success');
        }
      } catch (error) {
        if (!closing) {
          screen.setInput(draft);
          screen.println(`editor failed · ${sanitizeTerminalError(error)}`, 'danger');
        }
      } finally {
        if (!closing) renderer.resume?.();
        editing = false;
      }
    };

    const copyTranscript = async (mode: string): Promise<void> => {
      const normalized = mode === '' ? 'latest' : mode;
      if (normalized !== 'latest' && normalized !== 'raw') {
        screen.println('usage: /copy [latest|raw]', 'warning');
        return;
      }
      const content = transcriptContent(session.messages, normalized);
      if (content === '') {
        screen.println('Nothing to copy.', 'warning');
        return;
      }
      try {
        if (opts.presentation?.copyText !== undefined) {
          await opts.presentation.copyText(content);
        } else if (renderer.copyToClipboardOSC52?.(content) !== true) {
          await copyTextToClipboard(content);
        }
        screen.println(
          normalized === 'raw' ? 'Raw transcript copied.' : 'Latest response copied.',
          'success',
        );
      } catch (error) {
        screen.println(`copy failed · ${sanitizeTerminalError(error)}`, 'danger');
      }
    };

    /** null = clear command text; string = replace composer with returned draft. */
    const runCommand = (command: SlashCommand): string | null => {
      switch (command.cmd) {
        case 'quit':
          void shutdown(0);
          return null;
        case 'abort':
          if (tuiCanAbort(opts.interaction.phase)) session.abort();
          else screen.println('No active run to abort.', 'warning');
          return null;
        case 'help':
          for (const line of renderInteractiveHelp('tui')) screen.println(line, 'muted');
          return null;
        case 'status':
          for (const line of formatStatusLines(
            session.usage(),
            formatModelRef(session.currentModel()),
          )) {
            screen.println(line, 'muted');
          }
          return null;
        case 'doctor': {
          const report = collectDoctorReport(opts.version ?? 'unknown');
          for (const line of formatDoctorReportLines(report)) {
            screen.println(line, report.ok ? 'muted' : 'warning');
          }
          return paletteReturnDraft ?? null;
        }
        case 'auth_status':
          if (opts.providerCommands === undefined) {
            screen.println('/auth is unavailable in this mode', 'warning');
          } else {
            for (const line of formatAuthStatusLines(opts.providerCommands.registry)) {
              screen.println(line, 'muted');
            }
          }
          return paletteReturnDraft ?? null;
        case 'login':
        case 'model':
        case 'logout':
          if (providerController === undefined) {
            screen.println(`/${command.cmd} is unavailable in this mode`, 'warning');
            return paletteReturnDraft ?? latestPromptDraft;
          }
          return beginProviderCommand(command.cmd);
        case 'queue':
          for (const line of formatQueueLines(lastQueues.steering, lastQueues.followUp)) {
            screen.println(line, 'muted');
          }
          return null;
        case 'follow_up':
          if (command.text !== '') session.followUp(command.text);
          return null;
        case 'history_search': {
          const query = command.query === '' ? latestPromptDraft : command.query;
          const match = history.reverseSearch(query);
          if (match === undefined) {
            screen.setTransientStatus(`no prompt history match · ${query}`);
            return paletteReturnDraft ?? null;
          }
          screen.setTransientStatus(`history match · Ctrl+R older · ${query}`);
          return match;
        }
        case 'edit':
          void editComposerDraft(paletteReturnDraft ?? latestPromptDraft);
          return paletteReturnDraft ?? latestPromptDraft;
        case 'file_complete': {
          const candidates = workspacePathCandidates(
            opts.cwd ?? process.cwd(),
            command.query,
            50,
          );
          if (candidates.length === 0) screen.println('No matching workspace paths.', 'warning');
          else candidates.forEach((candidate) => screen.println(`@${candidate}`, 'muted'));
          return candidates.length === 1 ? `@${candidates[0]}` : (paletteReturnDraft ?? null);
        }
        case 'stash': {
          if (opts.presentation === undefined) {
            screen.println('/stash is unavailable without presentation storage', 'warning');
            return paletteReturnDraft ?? null;
          }
          const draft = command.text || paletteReturnDraft || latestPromptDraft;
          if (draft === '') {
            screen.println('No draft to stash.', 'warning');
            return null;
          }
          try {
            opts.presentation.store.stash(persistableDraft(draft));
            latestPromptDraft = '';
            screen.println('Draft stashed for this thread.', 'success');
            return '';
          } catch (error) {
            screen.println(`stash failed · ${sanitizeTerminalError(error)}`, 'danger');
            return draft;
          }
        }
        case 'restore': {
          try {
            const restored = opts.presentation?.store.restoreStash();
            if (restored === undefined) {
              screen.println('No stashed draft for this thread.', 'warning');
              return paletteReturnDraft ?? null;
            }
            latestPromptDraft = restored.text;
            screen.println('Draft restored.', 'success');
            return restored.text;
          } catch (error) {
            screen.println(`restore failed · ${sanitizeTerminalError(error)}`, 'danger');
            return paletteReturnDraft ?? latestPromptDraft;
          }
        }
        case 'transcript_search':
          if (command.query === '') screen.setTransientStatus('usage: /search <query>');
          else screen.searchTranscript(command.query);
          return paletteReturnDraft ?? null;
        case 'search_next':
          screen.searchTranscript('', 1);
          return paletteReturnDraft ?? null;
        case 'search_previous':
          screen.searchTranscript('', -1);
          return paletteReturnDraft ?? null;
        case 'latest':
          screen.jumpToLatest();
          return paletteReturnDraft ?? null;
        case 'copy':
          void copyTranscript(command.mode);
          return paletteReturnDraft ?? null;
        case 'export': {
          if (opts.presentation === undefined) {
            screen.println('/export is unavailable without presentation storage', 'warning');
            return paletteReturnDraft ?? null;
          }
          try {
            const destination = exportTranscript(session.messages, {
              cwd: opts.cwd ?? process.cwd(),
              mode: command.mode === 'raw' || command.mode === 'latest'
                ? command.mode
                : 'text',
              ...(command.path === '' ? {} : { destination: command.path }),
            });
            screen.println(`Exported transcript to ${destination}.`, 'success');
          } catch (error) {
            screen.println(`export failed · ${sanitizeTerminalError(error)}`, 'danger');
          }
          return paletteReturnDraft ?? null;
        }
        case 'vim':
          if (command.mode !== 'on' && command.mode !== 'off') {
            screen.println('usage: /vim <on|off>', 'warning');
            return paletteReturnDraft ?? null;
          }
          opts.presentation?.store.setVimEnabled(command.mode === 'on');
          screen.setVimEnabled(command.mode === 'on');
          screen.println(`Vim composer keys ${command.mode === 'on' ? 'enabled' : 'disabled'}.`, 'success');
          return paletteReturnDraft ?? null;
        case 'draft': {
          if (opts.presentation === undefined) {
            screen.println('/draft is unavailable without presentation storage', 'warning');
            return paletteReturnDraft ?? null;
          }
          const draft = opts.presentation.store.snapshot().draft;
          if (command.action === 'show') {
            screen.println(draft === '' ? 'No saved draft.' : `saved draft\n${draft}`, 'muted');
            return paletteReturnDraft ?? null;
          }
          if (command.action === 'clear') {
            opts.presentation.store.setDraft(persistableDraft(''));
            latestPromptDraft = '';
            screen.println('Saved draft cleared.', 'success');
            return '';
          }
          if (command.action === 'send') {
            if (draft === '') {
              screen.println('No saved draft to send.', 'warning');
              return paletteReturnDraft ?? null;
            }
            try {
              if (tuiEnterState(opts.interaction.phase) === 'running') {
                session.steer(draft);
              } else {
                session.prompt(draft).catch((error) => {
                  printError(error);
                  opts.presentation?.store.setDraft(persistableDraft(draft));
                  if (screen.getInput() === '') screen.setInput(draft);
                });
              }
              opts.presentation.store.setDraft(persistableDraft(''));
              latestPromptDraft = '';
              screen.markInteracted();
              return '';
            } catch (error) {
              printError(error);
              return draft;
            }
          }
          screen.println('usage: /draft <show|send|clear>', 'warning');
          return paletteReturnDraft ?? null;
        }
        case 'unknown':
          screen.println(`unknown command: ${command.input} (try /help)`, 'warning');
          return null;
      }
    };

    function submit(meta: boolean): void {
      if (closing || approvalQueue.length > 0) return;
      const raw = screen.getInput();
      if (providerController?.active === true) {
        screen.markInteracted();
        screen.clearInput();
        void providerController.submit(raw);
        return;
      }
      const action = decideEnter(tuiEnterState(opts.interaction.phase), meta, raw);
      if (action.kind === 'none') {
        screen.clearInput();
        return;
      }
      screen.markInteracted();
      let nextInput = '';
      if (action.kind !== 'command') history.push(raw);
      try {
        switch (action.kind) {
          case 'prompt':
            latestPromptDraft = '';
            session.prompt(action.text).catch((error) => {
              printError(error);
              if (screen.getInput() === '') screen.setInput(action.text);
            });
            break;
          case 'steer':
            session.steer(action.text);
            latestPromptDraft = '';
            break;
          case 'follow_up':
            session.followUp(action.text);
            latestPromptDraft = '';
            break;
          case 'command':
            nextInput = runCommand(action.command) ?? paletteReturnDraft ?? '';
            break;
        }
      } catch (error) {
        printError(error);
        nextInput = raw;
      }
      paletteReturnDraft = undefined;
      screen.setInput(nextInput);
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
      if (editing) {
        consume(key);
        return;
      }
      const isEnter = key.name === 'return' || key.name === 'enter' || key.name === 'kpenter';
      if (key.name !== 'escape') escExit.reset();
      if (!(key.ctrl && key.name === 'c')) ctrlCExit.reset();
      if (!(key.ctrl && key.name === 'r')) {
        reverseSearchQuery = undefined;
        history.resetSearch();
      }
      screen.setTransientStatus(undefined);

      if (key.name === 'end' && !key.ctrl && !key.meta && !key.shift) {
        screen.jumpToLatest();
        consume(key);
        return;
      }
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

      if (key.name === 'escape' && providerController?.active === true) {
        providerController.back();
        escExit.reset();
        consume(key);
        return;
      }

      if (key.name === 'escape' && paletteReturnDraft !== undefined) {
        const draft = paletteReturnDraft;
        paletteReturnDraft = undefined;
        screen.setInput(draft);
        escExit.reset();
        consume(key);
        return;
      }

      if (screen.handleComposerModeKey(key)) {
        consume(key);
        return;
      }

      if (providerController?.active !== true && key.ctrl && key.name === 'k') {
        paletteReturnDraft = screen.getInput();
        screen.openCommandPalette();
        screen.setTransientStatus('command palette · fuzzy search · Esc returns to draft');
        consume(key);
        return;
      }
      if (providerController?.active !== true && key.ctrl && key.name === 'f') {
        paletteReturnDraft = screen.getInput();
        screen.openTranscriptSearch();
        screen.setTransientStatus('transcript search · enter a query');
        consume(key);
        return;
      }
      if (providerController?.active !== true && key.ctrl && key.name === 'r') {
        reverseSearchQuery ??= screen.getInput();
        const match = history.reverseSearch(reverseSearchQuery);
        if (match === undefined) {
          screen.setTransientStatus(`no older history match · ${reverseSearchQuery}`);
        } else {
          screen.setInput(match);
          screen.setTransientStatus(`history match · Ctrl+R older · ${reverseSearchQuery}`);
        }
        consume(key);
        return;
      }
      if (providerController?.active !== true && key.ctrl && key.name === 'o') {
        void editComposerDraft(screen.getInput());
        consume(key);
        return;
      }
      if (providerController?.active !== true && key.meta && key.name === 's') {
        const draft = screen.getInput();
        if (opts.presentation === undefined || draft === '') {
          screen.println(
            draft === '' ? 'No draft to stash.' : 'Draft storage unavailable.',
            'warning',
          );
        } else {
          try {
            opts.presentation.store.stash(persistableDraft(draft));
            latestPromptDraft = '';
            screen.clearInput();
            screen.println('Draft stashed for this thread.', 'success');
          } catch (error) {
            screen.println(`stash failed · ${sanitizeTerminalError(error)}`, 'danger');
          }
        }
        consume(key);
        return;
      }

      if (screen.handleSlashMenuKey(key)) {
        consume(key);
        return;
      }

      if (isEnter && key.meta) {
        submit(true);
        consume(key);
        return;
      }
      if (key.meta && key.name === 'up') {
        if (providerController?.active === true) {
          consume(key);
          return;
        }
        screen.setInput(history.up(screen.getInput()));
        consume(key);
        return;
      }
      if (key.meta && key.name === 'down') {
        if (providerController?.active === true) {
          consume(key);
          return;
        }
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
      if (event.type === 'approval_request') {
        // Runtime delivers canonical control requests on the primary event stream. The legacy
        // side channel below remains for direct Session; de-duplication keeps mixed adapters safe.
        escExit.reset();
        if (!enqueueApproval(event.approvalId)) return;
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
      if (!enqueueApproval(event.approvalId)) return;
      screen.render(event);
    });
    const unsubAttached = opts.providerCommands?.runtime.subscribeSessionAttached(
      (messages) => {
        if (messages.length > 0) screen.replayTranscript(messages);
        screen.setUsage(session.usage());
      },
    );

    const onSignal = (): void => {
      void shutdown(0, true);
    };

    const cleanup = (): void => {
      screen.setSubmitHandler(() => {});
      screen.setInputChangeHandler(() => {});
      renderer.keyInput.off('keypress', onKeyPress);
      renderer.keyInput.off('paste', onPaste);
      if (opts.installSignalHandlers !== false) {
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
        process.removeListener('SIGHUP', onSignal);
      }
      unsubSession();
      unsubApproval?.();
      unsubAttached?.();
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
        await providerController?.close();
        await session.close();
        if (editing) renderer.resume?.();
        await renderer.idle();
      } catch (error) {
        code = 1;
        console.error(`[coda] TUI shutdown failed: ${sanitizeTerminalError(error)}`);
      } finally {
        unsubscribeProjectWarnings?.();
        try {
          opts.presentation?.store.dispose();
        } catch (error) {
          code = 1;
          console.error(`[coda] TUI presentation save failed: ${sanitizeTerminalError(error)}`);
        }
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

function formatModelRef(model: ModelRef | undefined): string {
  return model === undefined
    ? 'no model selected'
    : `${model.provider}/${model.model}`;
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
