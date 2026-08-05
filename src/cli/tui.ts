// 全屏交互 TUI(规格见 docs/09-cli.md §1–5):OpenTUI 独占 raw stdin/stdout，
// 把 RuntimeEvent payload 渲染为顶部向下增长的转录区；普通 composer 或临时审批面板固定在底部。
// 本模块只在双 TTY 的交互分支动态加载；headless 与一次性模式不加载 native TUI 依赖。

import { isThreadId, isTurnId } from '../protocol/index.js';
import type {
  AgentMessage,
  ApprovalPresentation,
  AssistantMessage,
  ModelRef,
  PlanStep,
  ProviderEvent,
  RuntimeDiffSnapshot,
  RuntimeThreadListItem,
  ThreadId,
  ToolCallPart,
  ToolResultMessage,
  UserMessage,
  WorkspaceRuntimeSnapshot,
} from '../protocol/index.js';
import type {
  CliControlActions,
  CliApprovalDecision as ApprovalDecision,
  CliInteractionState,
  CliRuntimeEvent,
  CliThreadUsage,
} from './frontend-types.js';
import { runtimeHomeDir } from '../shared/index.js';
import type {
  CliSession,
  InteractiveSession,
} from './interactive-runtime.js';
import type {
  PendingApprovalView,
  RuntimeWorkspaceActions,
} from './runtime-frontend.js';
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
  sanitizeTerminalLine,
  sanitizeTerminalText,
  sanitizeTerminalTitle,
} from './terminal-sanitize.js';
import {
  commandPaletteEntries,
  renderInteractiveHelp,
} from './command-catalog.js';
import type { CliTheme, CommandAvailability } from './command-catalog.js';
import {
  approvalAllowsAlways,
  filterSessionItems,
  formatApprovalPresentation,
  formatPermissionSnapshot,
  formatReviewSnapshot,
} from './review-format.js';
import {
  explorationCall,
  explorationRows,
  formatExplorationRow,
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
  planPlainText,
} from './plan-presentation.js';
import {
  applyWorkspaceCompletion,
  copyTextToClipboard,
  editDraftWithExternalEditor,
  exportTranscript,
  promptHistoryEntries,
  runThreadPresentationTransition,
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
import { displayWidth, toolHeadline, truncateToWidth } from './renderer.js';
import {
  approvalKeyDecision,
  CTRL_C_EXIT_WINDOW_MS,
  decideEnter,
  DoublePress,
  formatStatusLines,
  InputHistory,
  INSERT_MODE_CHOICES,
  interactionCanAbort,
  interactionEnterState,
  selectInsertModeChoice,
  SLASH_COMMAND_SPECS,
} from './tui-controls.js';
import type { InsertMode, SlashCommand } from './tui-controls.js';
import type {
  CliRenderer,
  ColorInput,
  KeyEvent,
  MarkdownRenderable,
  PasteEvent,
  Renderable,
  TextChunk,
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
const WORKING_SUMMARY_MAX_CODE_UNITS = 4_096;
const COMPOSER_PADDING_X = 1;
const PROMPT_MAX_VISIBLE_ROWS = 8;
const PROMPT_MEASURE_HEIGHT = 65_535;
const PROMPT_RULE_ROWS = 2;
const COMPOSER_FOOTER_ROWS = 3;
const PROMPT_MENU_MAX_ROWS = 8;
const SLASH_COMMAND_COLUMN_WIDTH = 32;
const TRANSCRIPT_PADDING_X = 2;
const TRANSCRIPT_PADDING_Y = 1;
// 与 Codex history cell 一致：独立转录块间保留恰好一行，块内续行不再额外留白。
const TRANSCRIPT_BLOCK_GAP_ROWS = 1;
const TRANSCRIPT_MIN_CONTENT_ROWS = 1;
const TRANSCRIPT_PADDED_MIN_ROWS =
  TRANSCRIPT_MIN_CONTENT_ROWS + TRANSCRIPT_PADDING_Y * 2;
const MIN_HEADER_VIEWPORT_ROWS = 12;
export const TRANSCRIPT_REPLAY_CHUNK_MESSAGES = 120;

const WORKING_GRAPHEME_SEGMENTER = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('en', { granularity: 'grapheme' })
  : undefined;

function workingGraphemes(value: string): string[] {
  return WORKING_GRAPHEME_SEGMENTER === undefined
    ? [...value]
    : [...WORKING_GRAPHEME_SEGMENTER.segment(value)].map((segment) => segment.segment);
}

function formatWorkingSummary(value: string): string {
  return sanitizeTerminalLine(value).replace(/ +/gu, ' ');
}

function toolTranscriptBlockKey(toolCallId: string, occurrence: number): string {
  return occurrence <= 1
    ? `tool:${toolCallId}`
    : `tool:${toolCallId}:occurrence:${occurrence}`;
}

type Tone = 'normal' | 'muted' | 'accent' | 'success' | 'warning' | 'danger' | 'cyan' | 'blue';

export interface TuiPalette {
  border: string;
  promptBorder: string;
  approvalSurface: string;
  cursor: string;
  muted: string;
  accent: string;
  success: string;
  warning: string;
  danger: string;
  cyan: string;
  blue: string;
}

const AUTO_PALETTE: TuiPalette = {
  border: '#c9ccd3',
  promptBorder: '#a0205e',
  approvalSurface: '#f4f4f5',
  cursor: '#c94740',
  muted: '#636873',
  accent: '#c94740',
  success: '#2f7647',
  warning: '#8a5a0a',
  danger: '#bd2e38',
  cyan: '#276a7a',
  blue: '#1769d1',
};

const THEME_PALETTES: Readonly<Record<Exclude<CliTheme, 'auto' | 'mono'>, TuiPalette>> = {
  light: AUTO_PALETTE,
  dark: {
    border: '#8b93a1',
    promptBorder: '#ff70b7',
    approvalSurface: '#202126',
    cursor: '#ff7b72',
    muted: '#a7afbd',
    accent: '#ff7b72',
    success: '#6fdb91',
    warning: '#f2cc60',
    danger: '#ff7b86',
    cyan: '#72d4e4',
    blue: '#8ab4f8',
  },
  'high-contrast': {
    border: '#ffffff',
    promptBorder: '#ffff00',
    approvalSurface: '#000000',
    cursor: '#ffff00',
    muted: '#ffffff',
    accent: '#ffff00',
    success: '#00ff00',
    warning: '#ffff00',
    danger: '#ff4d4d',
    cyan: '#00ffff',
    blue: '#6ea8fe',
  },
};

export function resolveTuiTheme(
  theme: CliTheme = 'auto',
  color = true,
): { readonly color: boolean; readonly palette: TuiPalette } {
  if (!color || theme === 'mono') return { color: false, palette: AUTO_PALETTE };
  return {
    color: true,
    palette: theme === 'auto' ? AUTO_PALETTE : THEME_PALETTES[theme],
  };
}

export interface TuiOptions {
  cwd: string;
  model?: ModelRef;
  version: string;
  color: boolean;
  theme?: CliTheme;
  contextLimit?: number;
  resumed?: boolean;
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
  workspace?: RuntimeWorkspaceActions;
  projectRuleWarnings?: ProjectRuleWarningSource;
}

interface ProjectRuleWarningSource {
  subscribeWarnings(listener: (message: string) => void): () => void;
}

interface TuiScreenOptions extends TuiOptions {
  onSubmit?: () => void;
  interactionState: () => TuiPhase;
  /** 测试可注入确定性的 highlighter；生产缺省使用 OpenTUI 全局 client。 */
  treeSitterClient?: TreeSitterClient;
  /** Deterministic performance probe: one callback per coalesced visual stream frame. */
  onStreamFrame?: (taskCount: number) => void;
  /** 生产启用 Working 行的帧驱动流光；测试默认保持静态画面。 */
  workingAnimation?: boolean;
}

export interface TuiScreen {
  render(event: CliRuntimeEvent): void;
  activePanel(): 'transcript' | 'diff' | 'sessions';
  replayTranscript(messages: readonly AgentMessage[]): void;
  resetTranscript(messages: readonly AgentMessage[], highWaterSeq?: number): void;
  openDiffViewer(snapshot: Readonly<RuntimeDiffSnapshot>): void;
  handleDiffViewerKey(key: KeyEvent): 'none' | 'handled' | 'toggle-scope';
  openSessionPicker(items: readonly RuntimeThreadListItem[], query: string): void;
  handleSessionPickerKey(key: KeyEvent):
    | { readonly kind: 'none' | 'handled' }
    | { readonly kind: 'select'; readonly threadId: ThreadId };
  println(text: string, tone?: Tone): void;
  setUsage(usage: CliThreadUsage): void;
  setTransientStatus(status: string | undefined): void;
  setCommandPrompt(
    prompt: string | undefined,
    secret: boolean,
    choices?: readonly ProviderCommandChoice[],
  ): void;
  setModel(model: ModelRef | undefined, contextLimit?: number): void;
  setProviderCommandsAvailable(available: boolean): void;
  setInsertMode(mode: InsertMode): void;
  resolveApproval(): void;
  handleApprovalPanelKey(key: KeyEvent): ApprovalPanelKeyResult;
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
  placeholder: TextRenderable;
  markdown: MarkdownRenderable;
  textBlocks: Map<number, string>;
}

interface ToolView {
  headline: string;
  name: string;
  text?: TextRenderable;
  appendDetail?: (renderable: Renderable) => void;
  bash?: BashToolView;
  startedAt: number;
  blockKey: string;
  explorationGroup?: ExplorationGroupView;
}

interface BashToolView {
  readonly container: Renderable;
  readonly header: TextRenderable;
  readonly output: TextRenderable;
  readonly appendDetail: (renderable: Renderable) => void;
  readonly command: string;
  latestOutput: string;
  state: 'running' | 'completed';
  isError: boolean;
}

interface ExplorationGroupView {
  readonly container: Renderable;
  readonly title: TextRenderable;
  readonly body: TextRenderable;
  readonly appendDetail: (renderable: Renderable) => void;
  readonly calls: ExplorationCall[];
  readonly failures: string[];
  readonly activeCallKeys: Set<string>;
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

export type ApprovalPanelKeyResult =
  | { readonly kind: 'none' | 'handled' }
  | { readonly kind: 'decision'; readonly decision: ApprovalDecision };

interface ApprovalPanelOption {
  readonly decision: Exclude<ApprovalDecision, 'abort'>;
  readonly label: string;
  readonly shortcut: 'y' | 'a' | 'n';
}

type ApprovalPanelLine =
  | { readonly kind: 'blank' }
  | { readonly kind: 'title' | 'command' | 'detail'; readonly text: string }
  | { readonly kind: 'field'; readonly label: string; readonly value: string }
  | { readonly kind: 'option'; readonly index: number; readonly option: ApprovalPanelOption };

export type TuiPhase = CliInteractionState;

/** 审批决议必须来自完全无修饰键的 y/a/n/Esc。 */
export function approvalDecisionForKey(
  key: Pick<KeyEvent, 'name' | 'ctrl' | 'meta' | 'shift' | 'option' | 'super' | 'hyper'>,
): ReturnType<typeof approvalKeyDecision> {
  if (key.ctrl || key.meta || key.shift || key.option || key.super || key.hyper) return undefined;
  return approvalKeyDecision(key.name);
}

interface ApprovalPanelCopy {
  readonly title: string;
  readonly reason: string;
  readonly command?: string;
  readonly target?: string;
}

function approvalPanelCopy(
  presentation: Readonly<ApprovalPresentation>,
): ApprovalPanelCopy {
  const canonicalTarget = presentation.normalizedResources
    .find((resource) =>
      resource['resourceType'] === 'command' &&
      resource['access'] === 'execute' &&
      typeof resource['canonicalTarget'] === 'string' &&
      resource['canonicalTarget'].trim() !== ''
    )?.['canonicalTarget'];
  const command = typeof canonicalTarget === 'string' ? canonicalTarget : undefined;
  const reason = sanitizeTerminalText(presentation.risk.description);
  const target = command === undefined
    ? sanitizeTerminalText(safeJsonValue(presentation.normalizedResources))
    : undefined;
  return {
    title: command === undefined
      ? 'Would you like to allow the following action?'
      : 'Would you like to run the following command?',
    reason,
    ...(command === undefined ? {} : { command: sanitizeTerminalText(command) }),
    ...(target === undefined ? {} : { target }),
  };
}

function safeJsonValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'undefined';
  } catch {
    return '[unavailable]';
  }
}

function approvalPanelOptions(
  presentation: Readonly<ApprovalPresentation>,
): readonly ApprovalPanelOption[] {
  return [
    { decision: 'allow_once', label: 'Yes, proceed', shortcut: 'y' },
    ...(approvalAllowsAlways(presentation)
      ? [{
          decision: 'allow_always' as const,
          label: "Yes, and don't ask again for this approved scope",
          shortcut: 'a' as const,
        }]
      : []),
    {
      decision: 'deny',
      label: 'No, and tell Coda what to do differently',
      shortcut: 'n',
    },
  ];
}

function approvalPanelLineText(line: ApprovalPanelLine, selectedIndex: number): string {
  switch (line.kind) {
    case 'blank':
      return '';
    case 'field':
      return `${line.label}: ${line.value}`;
    case 'option':
      return `${line.index === selectedIndex ? '›' : ' '} ${line.index + 1}. ` +
        `${line.option.label} (${line.option.shortcut})`;
    default:
      return line.text;
  }
}

function wrappedApprovalRows(
  lines: readonly ApprovalPanelLine[],
  selectedIndex: number,
  width: number,
): number {
  return lines.reduce((rows, line) => {
    const physicalLines = approvalPanelLineText(line, selectedIndex).split('\n');
    return rows + physicalLines.reduce((lineRows, physicalLine) =>
      lineRows + Math.max(1, Math.ceil(displayWidth(physicalLine) / Math.max(1, width))), 0);
  }, 0);
}

/** 矮窗口优先保住当前审批选项，并随选择移动可见窗口，禁止盲选被裁掉的决议。 */
function visibleApprovalLines(
  lines: readonly ApprovalPanelLine[],
  selectedIndex: number,
  width: number,
  maxRows: number,
): readonly ApprovalPanelLine[] {
  if (wrappedApprovalRows(lines, selectedIndex, width) <= maxRows) return lines;
  const selectedLine = lines.findIndex((line) =>
    line.kind === 'option' && line.index === selectedIndex);
  if (selectedLine < 0) return lines.slice(-1);

  const rowsFor = (line: ApprovalPanelLine): number =>
    wrappedApprovalRows([line], selectedIndex, width);
  let start = selectedLine;
  let end = selectedLine + 1;
  let rows = rowsFor(lines[selectedLine] as ApprovalPanelLine);
  while (end < lines.length) {
    const next = rowsFor(lines[end] as ApprovalPanelLine);
    if (rows + next > maxRows) break;
    rows += next;
    end++;
  }
  while (start > 0) {
    const previous = rowsFor(lines[start - 1] as ApprovalPanelLine);
    if (rows + previous > maxRows) break;
    rows += previous;
    start--;
  }
  return lines.slice(start, end);
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
    StyledText,
    SyntaxStyle: Syntax,
    TextRenderable: Text,
    TextareaRenderable: Textarea,
    bold,
    dim,
    fg,
    strikethrough,
  } = await import('@opentui/core');

  // 透明背景让终端自身的背景色/透明度透出；前景与语义色仍由 coda 控制。
  const transparentBackground = RGBA.fromValues(0, 0, 0, 0);
  // 正文跟随终端默认前景；OpenTUI 0.4.5 的硬件光标路径会丢失 default
  // intent 并退化为白色 OSC 12，因此光标使用兼顾明暗背景的固定品牌色。
  const terminalForeground = RGBA.defaultForeground();
  const resolvedTheme = resolveTuiTheme(opts.theme, opts.color);
  const palette = resolvedTheme.palette;
  const cursorForeground = RGBA.fromHex(palette.cursor);
  const interactionState = opts.interactionState;
  let approvalPending = false;
  let commandPrompt: string | undefined;
  let commandChoices: readonly ProviderCommandChoice[] = [];
  let secretInput = false;
  let secretValue = '';
  let rewritingSecret = false;
  let submitHandler = opts.onSubmit ?? (() => {});
  const colored = <T extends object>(value: T): T | Record<string, never> =>
    resolvedTheme.color ? value : {};
  const toneColor = (tone: Tone): ColorInput => {
    if (!resolvedTheme.color) return terminalForeground;
    switch (tone) {
      case 'muted': return palette.muted;
      case 'accent': return palette.accent;
      case 'success': return palette.success;
      case 'warning': return palette.warning;
      case 'danger': return palette.danger;
      case 'cyan': return palette.cyan;
      case 'blue': return palette.blue;
      default: return terminalForeground;
    }
  };

  const syntaxStyle = Syntax.fromStyles({
    default: { fg: terminalForeground },
    'markup.heading.1': { ...(resolvedTheme.color && { fg: palette.accent }), bold: true },
    'markup.heading.2': { ...(resolvedTheme.color && { fg: palette.accent }), bold: true },
    'markup.heading.3': { ...(resolvedTheme.color && { fg: palette.warning }), bold: true },
    'markup.list': resolvedTheme.color ? { fg: palette.accent } : {},
    'markup.raw': resolvedTheme.color ? { fg: palette.success } : {},
    'markup.link': resolvedTheme.color ? { fg: palette.cyan, underline: true } : { underline: true },
    keyword: { ...(resolvedTheme.color && { fg: palette.accent }), bold: true },
    string: resolvedTheme.color ? { fg: palette.success } : {},
    number: resolvedTheme.color ? { fg: palette.warning } : {},
    comment: { ...(resolvedTheme.color && { fg: palette.muted }), italic: true },
  });
  let screenDestroyed = false;

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
        borderColor: palette.border,
        titleColor: palette.accent,
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
      ...colored({ fg: palette.accent }),
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
        borderColor: palette.border,
      }),
    });
    const tipsTitle = new Text(renderer, {
      id: 'coda-tips-title',
      height: 1,
      content: 'Tips for getting started',
      selectable: false,
      bg: transparentBackground,
      fg: terminalForeground,
      ...colored({ fg: palette.accent }),
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
      ...colored({ fg: palette.muted }),
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
        paddingX: TRANSCRIPT_PADDING_X,
        paddingTop: TRANSCRIPT_PADDING_Y,
        paddingBottom: TRANSCRIPT_PADDING_Y,
        rowGap: TRANSCRIPT_BLOCK_GAP_ROWS,
        backgroundColor: transparentBackground,
      },
      verticalScrollbarOptions: {
        visible: false,
        trackOptions: { visible: false },
      },
    });

    const diffPanel = new Box(renderer, {
      id: 'coda-diff-panel',
      width: '100%',
      flexGrow: 1,
      minHeight: 1,
      visible: false,
      flexDirection: 'column',
      paddingX: 2,
      backgroundColor: transparentBackground,
    });
    const diffHeader = new Text(renderer, {
      id: 'coda-diff-header',
      width: '100%',
      height: 1,
      truncate: true,
      selectable: false,
      bg: transparentBackground,
      fg: terminalForeground,
      ...colored({ fg: palette.accent }),
    });
    const diffFiles = new Text(renderer, {
      id: 'coda-diff-files',
      width: '100%',
      height: 'auto',
      maxHeight: 6,
      wrapMode: 'word',
      selectable: true,
      bg: transparentBackground,
      fg: terminalForeground,
      ...colored({ fg: palette.muted }),
    });
    const diffScroll = new ScrollBox(renderer, {
      id: 'coda-diff-scroll',
      width: '100%',
      flexGrow: 1,
      minHeight: 1,
      scrollY: true,
      scrollX: false,
      viewportCulling: true,
      backgroundColor: transparentBackground,
      wrapperOptions: { backgroundColor: transparentBackground },
      viewportOptions: { backgroundColor: transparentBackground },
      contentOptions: {
        flexDirection: 'column',
        minHeight: 'auto',
        backgroundColor: transparentBackground,
      },
      verticalScrollbarOptions: { visible: false, trackOptions: { visible: false } },
    });
    const diffBody = new Text(renderer, {
      id: 'coda-diff-body',
      width: '100%',
      height: 'auto',
      wrapMode: 'none',
      selectable: true,
      bg: transparentBackground,
      fg: terminalForeground,
    });
    diffScroll.add(diffBody);
    diffPanel.add(diffHeader);
    diffPanel.add(diffFiles);
    diffPanel.add(diffScroll);

    const sessionPanel = new Box(renderer, {
      id: 'coda-session-panel',
      width: '100%',
      flexGrow: 1,
      minHeight: 1,
      visible: false,
      flexDirection: 'column',
      paddingX: 2,
      backgroundColor: transparentBackground,
    });
    const sessionHeader = new Text(renderer, {
      id: 'coda-session-header',
      width: '100%',
      height: 2,
      content: '',
      wrapMode: 'word',
      selectable: false,
      bg: transparentBackground,
      fg: terminalForeground,
      ...colored({ fg: palette.accent }),
    });
    const sessionList = new Text(renderer, {
      id: 'coda-session-list',
      width: '100%',
      flexGrow: 1,
      content: '',
      wrapMode: 'word',
      selectable: true,
      bg: transparentBackground,
      fg: terminalForeground,
    });
    sessionPanel.add(sessionHeader);
    sessionPanel.add(sessionList);

    const composer = new Box(renderer, {
      id: 'coda-composer',
      width: '100%',
      height: 1 + PROMPT_RULE_ROWS + COMPOSER_FOOTER_ROWS,
      flexShrink: 0,
      flexDirection: 'column',
      paddingX: COMPOSER_PADDING_X,
      backgroundColor: transparentBackground,
    });
    const approvalPanel = new Box(renderer, {
      id: 'coda-approval-panel',
      width: '100%',
      height: 0,
      visible: false,
      flexShrink: 0,
      flexDirection: 'column',
      paddingX: 1,
      paddingTop: 1,
      backgroundColor: resolvedTheme.color
        ? RGBA.fromHex(palette.approvalSurface)
        : transparentBackground,
    });
    const approvalText = new Text(renderer, {
      id: 'coda-approval-content',
      width: '100%',
      height: 0,
      content: '',
      wrapMode: 'char',
      selectable: true,
      bg: transparentBackground,
      fg: terminalForeground,
    });
    approvalPanel.add(approvalText);
    const approvalFooter = new Box(renderer, {
      id: 'coda-approval-footer',
      width: '100%',
      height: 0,
      visible: false,
      flexShrink: 0,
      paddingX: 1,
      backgroundColor: transparentBackground,
    });
    const approvalHint = new Text(renderer, {
      id: 'coda-approval-hint',
      width: '100%',
      height: 1,
      content: 'Press enter to confirm or esc to cancel',
      truncate: true,
      selectable: false,
      bg: transparentBackground,
      fg: terminalForeground,
      ...colored({ fg: palette.muted }),
    });
    approvalFooter.add(approvalHint);
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
        ...colored({ fg: palette.muted }),
      });
      row.add(prefix);
      row.add(command);
      row.add(description);
      slashMenu.add(row);
      return { row, prefix, command, description };
    });
    const workingText = new Text(renderer, {
      id: 'coda-working',
      width: '100%',
      height: 0,
      visible: false,
      flexShrink: 0,
      content: '',
      truncate: true,
      selectable: false,
      bg: transparentBackground,
      fg: terminalForeground,
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
        borderColor: palette.promptBorder,
        focusedBorderColor: palette.promptBorder,
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
        placeholderColor: palette.muted,
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
      ...colored({ fg: palette.muted }),
    });
    const taskText = new Text(renderer, {
      id: 'coda-task-status',
      width: '100%',
      height: 1,
      truncate: true,
      selectable: false,
      bg: transparentBackground,
      fg: terminalForeground,
      ...colored({ fg: palette.muted }),
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
      ...colored({ fg: palette.muted }),
    });
    const modelText = new Text(renderer, {
      id: 'coda-model',
      height: 1,
      content: sanitizeTerminalText(formatModelRef(opts.model)),
      truncate: true,
      selectable: false,
      bg: transparentBackground,
      fg: terminalForeground,
      ...colored({ fg: palette.muted }),
    });
    runtimeRow.add(contextText);
    runtimeRow.add(modelText);
    composer.add(approvalPanel);
    composer.add(approvalFooter);
    composer.add(slashMenu);
    composer.add(workingText);
    composer.add(promptBox);
    composer.add(taskText);
    composer.add(workspaceText);
    composer.add(runtimeRow);

    page.add(header);
    page.add(transcript);
    page.add(diffPanel);
    page.add(sessionPanel);
    page.add(composer);
    renderer.root.add(page);

    let activity: string | undefined;
    let transientStatus: string | undefined;
    let inputChangeHandler: (draft: string) => void = () => {};
    let layoutWidth = renderer.width;
    let layoutHeight = renderer.height;
    let headerRows = 9;
    const branch = opts.workspaceSnapshot.git?.branch;
    const gitDirty = opts.workspaceSnapshot.git?.dirty ?? false;
    let hasInteracted = opts.resumed === true ||
      (opts.presentation?.store.snapshot().draft ?? '') !== '';
    let selectedModel = opts.model;
    let providerCommandsAvailable = opts.providerCommands !== undefined;
    let insertMode: InsertMode = 'steering';
    let selectedContextLimit = opts.contextLimit;
    let usage: CliThreadUsage = {
      cumulative: { input: 0, output: 0 },
      turns: 0,
      contextTokens: 0,
    };
    let steerCount = 0;
    let followUpCount = 0;
    let currentAssistant: AssistantView | undefined;
    const workingReasoningBlocks = new Map<number, string>();
    let workingSummary: string | undefined;
    let workingShimmerOffset = 0;
    let workingAnimationLive = false;
    let planSteps: readonly PlanStep[] | undefined;
    let planText: TextRenderable | undefined;
    const toolViews = new Map<string, ToolView>();
    const bashToolViews = new Set<BashToolView>();
    const toolOccurrenceCounts = new Map<string, number>();
    let activeExplorationGroup: ExplorationGroupView | undefined;
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
    let transcriptGeneration = 0;
    let unreadAfterSeq = opts.presentation?.store.snapshot().unreadAfterSeq ?? 0;
    let lastObservedHighWater = opts.eventHighWaterSeq?.() ?? 0;
    let transcriptSearchQuery = opts.presentation?.store.snapshot().search?.query ?? '';
    let transcriptSearchOrdinal = opts.presentation?.store.snapshot().search?.matchOrdinal ?? 0;
    let blockSequence = 0;
    let replayMessages: readonly AgentMessage[] = [];
    let replayCursor = 0;
    let replayBanner: TextRenderable | undefined;
    const replayCompletedToolCalls = new Set<string>();
    const replayToolResultHeadlines = new Map<number, string>();
    const replayToolResultBashCommands = new Map<number, string>();
    const replayToolCallBlockKeys = new Map<string, string>();
    const replayToolResultBlockKeys = new Map<number, string>();
    const replayToolResultExplorations = new Map<
      number,
      { readonly call: ExplorationCall; readonly blockKey: string }
    >();
    const replayDeferredToolCallKeys = new Set<string>();
    const replayDeferredToolStarts = new Map<
      number,
      Array<{ readonly part: ToolCallPart; readonly blockKey: string }>
    >();
    const replayExplorationGroups = new Map<string, ExplorationGroupView>();
    let replayLatestPlanSteps:
      | Extract<CliRuntimeEvent, { type: 'plan_update' }>['steps']
      | undefined;
    let transcriptInsertIndex: number | undefined;
    let blockInsertIndex: number | undefined;
    let activePanel: 'transcript' | 'diff' | 'sessions' = 'transcript';
    let diffSnapshot: Readonly<RuntimeDiffSnapshot> | undefined;
    let diffFileIndex = 0;
    let allSessionItems: readonly RuntimeThreadListItem[] = [];
    let sessionItems: readonly RuntimeThreadListItem[] = [];
    let sessionQuery = '';
    let sessionIndex = 0;
    let approvalCard: {
      readonly toolCallId: string;
      readonly presentation: Readonly<ApprovalPresentation>;
      selectedIndex: number;
      expanded: boolean;
    } | undefined;

    interface TranscriptBlock {
      readonly key: string;
      readonly aliases: string[];
      readonly renderable: Renderable;
      readonly text: () => string;
    }
    const transcriptBlocks: TranscriptBlock[] = [];

    const addTranscriptRenderable = (renderable: Renderable): void => {
      if (transcriptInsertIndex === undefined) {
        transcript.add(renderable);
        return;
      }
      transcript.add(renderable, transcriptInsertIndex);
      transcriptInsertIndex++;
    };

    const workspace = formatWorkspacePath(opts.cwd, runtimeHomeDir());

    const textOptions = (tone: Tone): { fg?: ColorInput; bg?: ColorInput } => {
      return { fg: toneColor(tone), bg: transparentBackground };
    };

    const fullApprovalLines = (): readonly ApprovalPanelLine[] => {
      if (approvalCard === undefined) return [];
      const copy = approvalPanelCopy(approvalCard.presentation);
      const options = approvalPanelOptions(approvalCard.presentation);
      const details = approvalCard.expanded
        ? formatApprovalPresentation(approvalCard.presentation).slice(0, -1)
        : [];
      return [
        { kind: 'title', text: copy.title },
        { kind: 'blank' },
        { kind: 'field', label: 'Environment', value: 'local' },
        { kind: 'blank' },
        { kind: 'field', label: 'Reason', value: copy.reason },
        { kind: 'blank' },
        copy.command === undefined
          ? { kind: 'field', label: 'Target', value: copy.target ?? '(no resources)' }
          : { kind: 'command', text: `$ ${copy.command}` },
        ...(details.length === 0
          ? []
          : [
              { kind: 'blank' } as const,
              { kind: 'detail', text: 'Details' } as const,
              ...details.map((text): ApprovalPanelLine => ({ kind: 'detail', text })),
            ]),
        { kind: 'blank' },
        ...options.map((option, index): ApprovalPanelLine => ({
          kind: 'option',
          index,
          option,
        })),
        { kind: 'blank' },
      ];
    };

    const renderApprovalLines = (lines: readonly ApprovalPanelLine[]): void => {
      if (approvalCard === undefined) {
        approvalText.content = '';
        return;
      }
      const card = approvalCard;
      const chunks: TextChunk[] = [];
      const normal = fg(terminalForeground);
      const muted = fg(toneColor('muted'));
      const selected = fg(toneColor('cyan'));
      const commandName = fg(toneColor('cyan'));
      const commandFlag = fg(toneColor('accent'));
      const commandString = fg(toneColor('success'));
      const append = (...parts: readonly TextChunk[]): void => {
        chunks.push(...parts);
      };
      const appendCommand = (value: string): void => {
        let expectsCommand = true;
        for (const part of value.split(/(\s+)/u).filter((token) => token !== '')) {
          if (/^\s+$/u.test(part)) {
            append(normal(part));
          } else if (expectsCommand) {
            append(commandName(part));
            expectsCommand = false;
          } else if (part === '|' || part === '||' || part === '&&' || part === ';') {
            append(normal(part));
            expectsCommand = true;
          } else if (part.startsWith('--')) {
            append(commandFlag(part));
          } else if (/^['"`]/u.test(part)) {
            append(commandString(part));
          } else {
            append(normal(part));
          }
        }
      };
      lines.forEach((line, lineIndex) => {
        switch (line.kind) {
          case 'blank':
            break;
          case 'title':
            append(bold(normal(line.text)));
            break;
          case 'field':
            append(normal(`${line.label}: `), bold(normal(line.value)));
            break;
          case 'command':
            append(normal('$ '));
            appendCommand(line.text.replace(/^\$ /u, ''));
            break;
          case 'detail':
            append(line.text === 'Details' ? bold(muted(line.text)) : muted(line.text));
            break;
          case 'option': {
            const active = line.index === card.selectedIndex;
            const prefix = `${active ? '›' : ' '} ${line.index + 1}. `;
            if (active) {
              append(
                bold(selected(prefix)),
                bold(selected(line.option.label)),
                selected(` (${line.option.shortcut})`),
              );
            } else {
              append(normal(prefix), normal(line.option.label), muted(` (${line.option.shortcut})`));
            }
            break;
          }
        }
        if (lineIndex < lines.length - 1) append(normal('\n'));
      });
      approvalText.content = new StyledText(chunks);
    };

    const refreshWorkspace = (): void => {
      workspaceText.content = sanitizeTerminalText(
        branch === undefined
          ? workspace
          : `${workspace}  (${branch}${gitDirty ? '*' : ''})`,
      );
    };

    const shortThreadId = (): string => {
      const threadId = opts.workspace?.currentThreadId ?? opts.threadId ?? 'unattached';
      return threadId.length <= 12 ? threadId : `…${threadId.slice(-10)}`;
    };

    const unreadCount = (): number => unreadAfterSeq === 0
      ? 0
      : Math.max(1, lastObservedHighWater - unreadAfterSeq);

    const refreshTaskStatus = (): void => {
      const phase = approvalPending ? 'approval' : interactionState();
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
              phase: interactionState(),
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
      const nextKey = `${nextMode}\0${interactionState()}\0${source}\0${nextItems
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
          resolvedTheme.color
            ? disabled
              ? palette.warning
              : palette.accent
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

    const workingLabel = (): string => workingSummary ?? 'Working';
    const renderWorking = (): void => {
      const label = workingLabel();
      if (!resolvedTheme.color) {
        workingText.content = '• ' + label;
        return;
      }
      const graphemes = workingGraphemes(label);
      const cycle = Math.max(1, graphemes.length + 6);
      const highlightStart = Math.floor(workingShimmerOffset % cycle) - 3;
      const highlightEnd = highlightStart + 3;
      const muted = fg(toneColor('muted'));
      const highlight = fg(toneColor('accent'));
      const chunks: TextChunk[] = [muted('• ')];
      for (const [index, grapheme] of graphemes.entries()) {
        chunks.push(
          index >= highlightStart && index < highlightEnd
            ? highlight(grapheme)
            : muted(grapheme),
        );
      }
      workingText.content = new StyledText(chunks);
    };
    const workingShouldBeVisible = (): boolean =>
      !approvalPending &&
      (interactionState() === 'running' ||
        interactionState() === 'retrying' ||
        interactionState() === 'compacting');
    const syncWorkingAnimation = (): void => {
      const shouldAnimate =
        opts.workingAnimation === true &&
        resolvedTheme.color &&
        workingText.visible &&
        !screenDestroyed;
      if (shouldAnimate && !workingAnimationLive) {
        workingAnimationLive = true;
        renderer.requestLive();
      } else if (!shouldAnimate && workingAnimationLive) {
        workingAnimationLive = false;
        renderer.dropLive();
      }
    };
    const workingFrameCallback = async (deltaTime: number): Promise<void> => {
      if (!workingAnimationLive || screenDestroyed) return;
      const cycle = Math.max(1, workingGraphemes(workingLabel()).length + 6);
      workingShimmerOffset =
        (workingShimmerOffset + Math.max(0, deltaTime) / 90) % cycle;
      renderWorking();
    };
    if (opts.workingAnimation === true && resolvedTheme.color) {
      renderer.setFrameCallback(workingFrameCallback);
    }
    const setWorkingSummary = (value: string | undefined): void => {
      const formatted = value === undefined ? '' : formatWorkingSummary(value);
      workingSummary = formatted === '' ? undefined : formatted;
      renderWorking();
      renderer.requestRender();
    };
    const refreshWorkingSummary = (): void => {
      const latest = [...workingReasoningBlocks.entries()]
        .sort(([left], [right]) => right - left)
        .map(([, text]) => text)
        .find((text) => formatWorkingSummary(text) !== '');
      setWorkingSummary(latest);
    };
    const clearWorkingSummary = (): void => {
      workingReasoningBlocks.clear();
      setWorkingSummary(undefined);
    };
    const appendWorkingSummary = (contentIndex: number, delta: string): void => {
      workingReasoningBlocks.set(
        contentIndex,
        ((workingReasoningBlocks.get(contentIndex) ?? '') + sanitizeTerminalText(delta))
          .slice(0, WORKING_SUMMARY_MAX_CODE_UNITS),
      );
      refreshWorkingSummary();
    };
    const finishWorkingSummary = (contentIndex: number, content: string): void => {
      const safeContent = sanitizeTerminalText(content).slice(0, WORKING_SUMMARY_MAX_CODE_UNITS);
      if (safeContent !== '' || !workingReasoningBlocks.has(contentIndex)) {
        workingReasoningBlocks.set(contentIndex, safeContent);
      }
      refreshWorkingSummary();
    };
    const syncWorkingSummaryFromMessage = (message: AssistantMessage): void => {
      workingReasoningBlocks.clear();
      for (const [contentIndex, part] of message.content.entries()) {
        if (part.type === 'reasoning' && part.kind === 'summary') {
          workingReasoningBlocks.set(
            contentIndex,
            sanitizeTerminalText(part.text).slice(0, WORKING_SUMMARY_MAX_CODE_UNITS),
          );
        }
      }
      refreshWorkingSummary();
    };

    const refreshComposerLayout = (): void => {
      refreshPromptMenu();
      if (approvalPending && approvalCard !== undefined) {
        const availableRows = Math.max(1, layoutHeight - headerRows);
        const footerRows = availableRows > 1 ? 1 : 0;
        const availablePanelRows = availableRows - footerRows;
        const contentWidth = Math.max(1, layoutWidth - COMPOSER_PADDING_X * 2 - 2);
        const paddingTop = availablePanelRows > 1 ? 1 : 0;
        const lines = visibleApprovalLines(
          fullApprovalLines(),
          approvalCard.selectedIndex,
          contentWidth,
          Math.max(1, availablePanelRows - paddingTop),
        );
        renderApprovalLines(lines);
        const contentRows = wrappedApprovalRows(
          lines,
          approvalCard.selectedIndex,
          contentWidth,
        );
        const panelRows = Math.min(availablePanelRows, contentRows + paddingTop);
        const transcriptRows = Math.max(0, availableRows - panelRows - footerRows);

        renderSlashRows(0);
        approvalPanel.visible = true;
        approvalPanel.paddingTop = paddingTop;
        approvalPanel.height = panelRows;
        approvalText.height = Math.max(1, panelRows - paddingTop);
        approvalFooter.visible = footerRows > 0;
        approvalFooter.height = footerRows;
        slashMenu.visible = false;
        workingText.visible = false;
        workingText.height = 0;
        promptBox.visible = false;
        input.visible = false;
        taskText.visible = false;
        workspaceText.visible = false;
        runtimeRow.visible = false;
        composer.height = panelRows + footerRows;
        transcript.visible = activePanel === 'transcript' && transcriptRows > 0;
        transcript.minHeight = Math.max(1, transcriptRows);
        transcript.maxHeight = Math.max(1, transcriptRows);
        transcript.content.paddingTop = transcriptRows >= TRANSCRIPT_PADDED_MIN_ROWS
          ? TRANSCRIPT_PADDING_Y
          : 0;
        transcript.content.paddingBottom = transcript.content.paddingTop;
        refreshCursorVisibility();
        syncWorkingAnimation();
        return;
      }

      approvalPanel.visible = false;
      approvalPanel.height = 0;
      approvalText.height = 0;
      approvalFooter.visible = false;
      approvalFooter.height = 0;
      const taskVisible = layoutHeight >= 3;
      const workspaceVisible = layoutHeight >= 4;
      const runtimeVisible = layoutHeight >= 5;
      taskText.visible = taskVisible;
      workspaceText.visible = workspaceVisible;
      runtimeRow.visible = runtimeVisible;
      const footerRows =
        Number(taskVisible) + Number(workspaceVisible) + Number(runtimeVisible);

      const ordinaryComposerRows = Math.max(
        0,
        layoutHeight - headerRows - footerRows,
      );
      // 极窄高度优先保留可编辑 prompt；有两行时才让 Working 占据 prompt 正上方的一行。
      const workingRows =
        workingShouldBeVisible() && ordinaryComposerRows >= 2 ? 1 : 0;
      workingText.visible = workingRows > 0;
      workingText.height = workingRows;
      const rowsAfterHeaderAndFooter = ordinaryComposerRows - workingRows;
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
      const reservedTranscriptRows = transcriptRows;
      const transcriptPadding = reservedTranscriptRows >= TRANSCRIPT_PADDED_MIN_ROWS
        ? TRANSCRIPT_PADDING_Y
        : 0;
      transcript.visible = activePanel === 'transcript' && reservedTranscriptRows > 0;
      transcript.minHeight = reservedTranscriptRows;
      transcript.content.paddingTop = transcriptPadding;
      transcript.content.paddingBottom = transcriptPadding;

      if (!promptVisible) {
        renderSlashRows(0);
        promptBox.height = 0;
        composer.height = footerRows;
        transcript.maxHeight = undefined;
        syncWorkingAnimation();
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
          inputAndTranscriptRows - reservedTranscriptRows - 1,
        ),
      );
      renderSlashRows(menuRows);
      const viewportRows = Math.max(
        1,
        Math.min(
          PROMPT_MAX_VISIBLE_ROWS,
          inputAndTranscriptRows - reservedTranscriptRows - menuRows,
        ),
      );
      const visibleRows = Math.min(naturalRows, viewportRows);
      promptBox.height = visibleRows + ruleRows;
      composer.height = menuRows + workingRows + visibleRows + ruleRows + footerRows;
      transcript.maxHeight = undefined;
      syncWorkingAnimation();
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
          // A second Esc falls through to the product's abort handling.
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
      const phase = interactionState();
      renderWorking();
      refreshTaskStatus();
      contextText.content = formatContextUsage(usage.contextTokens, selectedContextLimit);
      const queue =
        steerCount > 0 || followUpCount > 0
          ? ` · steer ${steerCount} · follow-up ${followUpCount}`
          : '';
      const compact = layoutWidth < 68;
      if (approvalPending) {
        setPromptPlaceholder('');
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
            ? 'Compacting · Esc abort'
            : `Compacting context · Esc abort${queue}`,
        );
      } else if (phase === 'running' || phase === 'retrying') {
        const label = activity ?? (phase === 'retrying' ? 'retrying' : 'working');
        const enterHint = insertMode === 'following'
          ? 'Enter follow-up'
          : 'Enter steer';
        setPromptPlaceholder(
          compact
            ? `${label} · ${enterHint} · Esc abort`
            : `${label} · ${enterHint} · Esc abort${queue}`,
        );
      } else {
        setPromptPlaceholder('');
      }
      if (resolvedTheme.color) {
        input.placeholderColor = palette.muted;
        promptBox.borderColor = palette.promptBorder;
        promptBox.focusedBorderColor = palette.promptBorder;
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
      while (transcriptBlocks.some((block) =>
        block.key === key || block.aliases.includes(key))) {
        key = `${requestedKey}:${++blockSequence}`;
      }
      renderable.id = `coda-transcript-block-${++blockSequence}`;
      const block = { key, aliases: [], renderable, text };
      if (blockInsertIndex === undefined) transcriptBlocks.push(block);
      else {
        transcriptBlocks.splice(blockInsertIndex, 0, block);
        blockInsertIndex++;
      }
    };

    const addTranscriptBlockAlias = (renderable: Renderable, requestedKey: string): void => {
      const block = transcriptBlocks.find((candidate) => candidate.renderable === renderable);
      if (block === undefined || block.key === requestedKey || block.aliases.includes(requestedKey)) return;
      if (transcriptBlocks.some((candidate) =>
        candidate.key === requestedKey || candidate.aliases.includes(requestedKey))) {
        return;
      }
      block.aliases.push(requestedKey);
    };

    const captureScrollAnchor = (): TranscriptScrollAnchor | undefined => {
      if (transcriptBlocks.length === 0) return undefined;
      const recoverable = transcriptBlocks.filter((block) =>
        block.key.startsWith('message:') || block.key.startsWith('tool:'));
      const anchors = recoverable.length > 0 ? recoverable : transcriptBlocks;
      // Renderable coordinates already include ScrollBox's content translation, so compare
      // them with the viewport's absolute top instead of the logical scroll offset.
      const top = transcript.viewport.y;
      // If the viewport begins in rowGap, anchor the following block instead of attaching an
      // out-of-range logical offset to the preceding block. This matters for bordered user
      // prompts, whose three-row geometry makes a gap-aligned viewport much more common.
      const firstVisible = anchors.findIndex((block) =>
        block.renderable.y + Math.max(1, block.renderable.height) > top
      );
      const index = firstVisible < 0 ? anchors.length - 1 : firstVisible;
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

    const persistUnreadBoundary = (): void => {
      if (!manuallyScrolled || opts.presentation === undefined) return;
      // Output does not move a manual viewport, so its already-laid-out durable anchor remains
      // authoritative. Re-capturing here would scan every block for every provider delta and can
      // select a newly queued block whose layout coordinate is still the default y=0.
      const state = opts.presentation.store.snapshot();
      opts.presentation.store.setScrollState(state.scrollAnchor, unreadAfterSeq);
    };

    const transcriptMaximum = (): number =>
      Math.max(0, transcript.scrollHeight - transcript.viewport.height);

    // OpenTUI 0.4.5 re-engages sticky-bottom at maximum - 1 during layout. Coda keeps the
    // documented presentation mode authoritative by disabling native sticky behavior only
    // while a real manual navigation is active, then re-enabling it at the exact latest row.
    const pauseTranscriptFollowing = (): void => {
      transcript.stickyScroll = false;
      manuallyScrolled = true;
    };

    const observeOutputEvent = (visibleOutput = true, deferVisualRefresh = false): void => {
      const current = opts.eventHighWaterSeq?.() ?? lastObservedHighWater + 1;
      if (!visibleOutput) {
        lastObservedHighWater = Math.max(lastObservedHighWater, current);
        return;
      }
      if (manuallyScrolled && current > lastObservedHighWater) {
        const startedUnreadInterval = unreadAfterSeq === 0;
        if (startedUnreadInterval) unreadAfterSeq = lastObservedHighWater;
        lastObservedHighWater = current;
        // The unread boundary is durable and immutable until latest is reached. Later deltas only
        // advance the in-memory high-water used by the footer; they must not rewrite the same
        // presentation state or recalculate the viewport anchor.
        if (startedUnreadInterval) persistUnreadBoundary();
      } else {
        lastObservedHighWater = Math.max(lastObservedHighWater, current);
        if (!manuallyScrolled) {
          unreadAfterSeq = 0;
          opts.presentation?.store.markRead();
        }
      }
      if (deferVisualRefresh) {
        queueFrameTask('stream-status', refreshStatus);
      } else {
        refreshTaskStatus();
      }
    };

    const finishExplorationGroup = (): void => {
      activeExplorationGroup = undefined;
    };

    const addText = (
      content: string,
      tone: Tone = 'normal',
      blockKey = `event:${++blockSequence}`,
    ): TextRenderable => {
      finishExplorationGroup();
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
      addTranscriptRenderable(text);
      registerTranscriptBlock(blockKey, text, () => safeContent);
      return text;
    };

    /**
     * 一次工具调用的摘要、结果和附带 diff 共享一个顶层块：ScrollBox 只在不同调用之间
     * 施加全局 rowGap，块内始终紧凑，等价于 Codex 的一个 history cell。
     */
    const addToolText = (
      content: string,
      tone: Tone,
      blockKey: string,
    ): { readonly text: TextRenderable; readonly appendDetail: (renderable: Renderable) => void } => {
      finishExplorationGroup();
      const safeContent = sanitizeTerminalText(content);
      const box = new Box(renderer, {
        width: '100%',
        height: 'auto',
        flexShrink: 0,
        flexDirection: 'column',
        rowGap: 0,
        backgroundColor: transparentBackground,
      });
      const text = new Text(renderer, {
        width: '100%',
        height: 'auto',
        flexShrink: 0,
        content: safeContent,
        wrapMode: 'word',
        selectable: true,
        ...textOptions(tone),
      });
      box.add(text);
      addTranscriptRenderable(box);
      registerTranscriptBlock(blockKey, box, () => {
        const current = text.content;
        return typeof current === 'string' ? current : safeContent;
      });
      return {
        text,
        appendDetail: (renderable: Renderable): void => {
          box.add(renderable);
          renderer.requestRender();
        },
      };
    };

    const explorationRowContent = (row: ReturnType<typeof explorationRows>[number]): string =>
      sanitizeTerminalLine(formatExplorationRow(row));

    const explorationGroupContent = (group: ExplorationGroupView): string => [
      ...explorationRows(group.calls)
        .map((row, index) => `${index === 0 ? '  └ ' : '    '}${explorationRowContent(row)}`),
      ...group.failures.map((failure) => `  ✗ ${failure}`),
    ].join('\n');

    const explorationGroupChunks = (group: ExplorationGroupView): TextChunk[] => {
      const rows = explorationRows(group.calls);
      const normal = fg(terminalForeground);
      const muted = fg(toneColor('muted'));
      const action = fg(toneColor('cyan'));
      const chunks: TextChunk[] = [];
      rows.forEach((row, index) => {
        const label = sanitizeTerminalLine(row.label);
        const target = sanitizeTerminalLine(row.target);
        chunks.push(muted(index === 0 ? '  └ ' : '    '), action(label));
        if (target !== '') chunks.push(normal(` ${target}`));
        if (index < rows.length - 1) chunks.push(normal('\n'));
      });
      for (const failure of group.failures) {
        if (chunks.length > 0) chunks.push(normal('\n'));
        chunks.push(fg(toneColor('danger'))(`  ✗ ${failure}`));
      }
      return chunks;
    };

    const refreshExplorationGroup = (group: ExplorationGroupView): void => {
      const normal = fg(terminalForeground);
      const failureSuffix = group.failures.length === 0
        ? ''
        : ` · ${group.failures.length} failed`;
      group.title.content = new StyledText([
        fg(toneColor('muted'))('• '),
        bold(normal(
          `${group.activeCallKeys.size === 0 ? 'Explored' : 'Exploring'}${failureSuffix}`,
        )),
      ]);
      group.body.content = new StyledText(explorationGroupChunks(group));
      renderer.requestRender();
    };

    const recordExplorationFailure = (
      group: ExplorationGroupView,
      headline: string,
      result: ToolResultMessage,
    ): void => {
      const head = truncateToWidth(sanitizeTerminalText(resultHead(result)), 96);
      group.failures.push(`${sanitizeTerminalLine(headline)}${head === '' ? '' : ` · ${head}`}`);
    };

    const completeExplorationGroups = (): void => {
      const groups = new Set<ExplorationGroupView>();
      if (activeExplorationGroup !== undefined) groups.add(activeExplorationGroup);
      for (const view of toolViews.values()) {
        if (view.explorationGroup !== undefined) groups.add(view.explorationGroup);
      }
      for (const group of groups) {
        group.activeCallKeys.clear();
        refreshExplorationGroup(group);
      }
    };

    const addExplorationCall = (
      call: ExplorationCall,
      blockKey: string,
    ): ExplorationGroupView => {
      const existing = activeExplorationGroup;
      if (existing !== undefined) {
        existing.calls.push(call);
        existing.activeCallKeys.add(blockKey);
        addTranscriptBlockAlias(existing.container, blockKey);
        refreshExplorationGroup(existing);
        return existing;
      }

      const box = new Box(renderer, {
        width: '100%',
        height: 'auto',
        flexShrink: 0,
        flexDirection: 'column',
        rowGap: 0,
        backgroundColor: transparentBackground,
      });
      const title = new Text(renderer, {
        width: '100%',
        height: 'auto',
        flexShrink: 0,
        content: '• Exploring',
        wrapMode: 'word',
        selectable: true,
        ...textOptions('normal'),
      });
      const body = new Text(renderer, {
        width: '100%',
        height: 'auto',
        flexShrink: 0,
        content: '',
        wrapMode: 'word',
        selectable: true,
        ...textOptions('normal'),
      });
      box.add(title);
      box.add(body);
      addTranscriptRenderable(box);
      const appendDetail = (renderable: Renderable): void => {
        box.add(renderable);
        renderer.requestRender();
      };
      const group: ExplorationGroupView = {
        container: box,
        title,
        body,
        appendDetail,
        calls: [call],
        failures: [],
        activeCallKeys: new Set([blockKey]),
      };
      registerTranscriptBlock(
        blockKey,
        box,
        () => {
          const status = group.activeCallKeys.size === 0 ? 'Explored' : 'Exploring';
          const failureSuffix = group.failures.length === 0
            ? ''
            : ` · ${group.failures.length} failed`;
          return `${status}${failureSuffix}\n${explorationGroupContent(group)}`;
        },
      );
      activeExplorationGroup = group;
      refreshExplorationGroup(group);
      return group;
    };

    const bashTokenTone = (tone: BashTokenTone): Tone => {
      switch (tone) {
        case 'command': return 'blue';
        case 'flag': return 'accent';
        case 'string': return 'success';
        case 'operator': return 'cyan';
        case 'comment': return 'muted';
        default: return 'normal';
      }
    };

    const bashTokenChunks = (tokens: readonly BashToken[]): TextChunk[] =>
      tokens.map((token) => fg(toneColor(bashTokenTone(token.tone)))(token.text));

    const bashTranscriptContent = (view: BashToolView): string => {
      const preview = previewBashOutput(view.latestOutput);
      const output = preview.lines.length === 0
        ? (view.state === 'completed' ? ['(no output)'] : [])
        : preview.lines;
      const title = view.state === 'running' ? 'Running' : 'Ran';
      const marker = view.state === 'completed' && view.isError
        ? (resolvedTheme.color ? '✗' : '[x]')
        : '•';
      return [`${marker} ${title} ${view.command}`, ...output].join('\n');
    };

    /** 将 bash 命令与其输出保持为一个可原位刷新的紧凑块。 */
    const refreshBashTool = (view: BashToolView): void => {
      const normal = fg(terminalForeground);
      const muted = fg(toneColor('muted'));
      const statusTone: Tone = view.state === 'running'
        ? 'cyan'
        : view.isError
          ? 'danger'
          : 'success';
      const title = view.state === 'running' ? 'Running' : 'Ran';
      const statusGlyph = view.state === 'completed' && view.isError
        ? (resolvedTheme.color ? '✗' : '[x]')
        : '•';
      const contentWidth = Math.max(1, layoutWidth - TRANSCRIPT_PADDING_X * 2);
      const headerPrefix = `${statusGlyph} ${title} `;
      const continuationPrefix = '  │ ';
      const command = layoutBashCommand(
        view.command,
        Math.max(1, contentWidth - displayWidth(headerPrefix)),
        Math.max(1, contentWidth - displayWidth(continuationPrefix)),
        displayWidth,
      );
      const headerChunks: TextChunk[] = [
        fg(toneColor(statusTone))(statusGlyph),
        normal(' '),
        bold(normal(title)),
      ];
      const first = command.lines[0] ?? [];
      if (first.length > 0) headerChunks.push(normal(' '), ...bashTokenChunks(first));
      for (const line of command.lines.slice(1)) {
        headerChunks.push(normal('\n'), muted(continuationPrefix), ...bashTokenChunks(line));
      }
      view.header.content = new StyledText(headerChunks);

      const preview = previewBashOutput(view.latestOutput);
      const visibleLines = preview.lines.length === 0
        ? (view.state === 'completed' ? ['(no output)'] : [])
        : preview.lines;
      const outputFirstPrefix = '  └ ';
      const outputNextPrefix = '    ';
      const outputWidth = Math.max(1, contentWidth - displayWidth(outputFirstPrefix));
      const outputChunks: TextChunk[] = [];
      const headLines = preview.omittedLines === undefined
        ? visibleLines.length
        : Math.min(2, visibleLines.length);
      visibleLines.forEach((rawLine, index) => {
        const prefix = index === 0 ? outputFirstPrefix : outputNextPrefix;
        outputChunks.push(
          muted(prefix),
          muted(truncateToWidth(rawLine.replaceAll('\t', '  '), outputWidth)),
        );
        if (preview.omittedLines !== undefined && index + 1 === headLines) {
          outputChunks.push(normal('\n'), muted(outputNextPrefix), muted(bashOutputEllipsis(preview.omittedLines)));
        }
        if (index < visibleLines.length - 1) outputChunks.push(normal('\n'));
      });
      view.output.visible = outputChunks.length > 0;
      view.output.content = outputChunks.length === 0 ? '' : new StyledText(outputChunks);
      renderer.requestRender();
    };

    const addBashTool = (
      command: string,
      blockKey: string,
      state: BashToolView['state'] = 'running',
      latestOutput = '',
      isError = false,
    ): BashToolView => {
      finishExplorationGroup();
      const box = new Box(renderer, {
        width: '100%',
        height: 'auto',
        flexShrink: 0,
        flexDirection: 'column',
        rowGap: 0,
        backgroundColor: transparentBackground,
      });
      const header = new Text(renderer, {
        width: '100%',
        height: 'auto',
        flexShrink: 0,
        content: '',
        wrapMode: 'word',
        selectable: true,
        ...textOptions('normal'),
      });
      const output = new Text(renderer, {
        width: '100%',
        height: 'auto',
        flexShrink: 0,
        content: '',
        visible: false,
        wrapMode: 'word',
        selectable: true,
        ...textOptions('muted'),
      });
      box.add(header);
      box.add(output);
      addTranscriptRenderable(box);
      const appendDetail = (renderable: Renderable): void => {
        box.add(renderable);
        renderer.requestRender();
      };
      const view: BashToolView = {
        container: box,
        header,
        output,
        appendDetail,
        command: sanitizeTerminalText(command),
        latestOutput: sanitizeTerminalText(latestOutput),
        state,
        isError,
      };
      bashToolViews.add(view);
      registerTranscriptBlock(blockKey, box, () => bashTranscriptContent(view));
      refreshBashTool(view);
      return view;
    };

    const refreshBashToolViews = (): void => {
      for (const view of bashToolViews) refreshBashTool(view);
    };

    const addUserPrompt = (
      content: string,
      tone: Tone,
      blockKey: string,
    ): void => {
      finishExplorationGroup();
      const prompt = new Box(renderer, {
        width: '100%',
        height: 'auto',
        flexShrink: 0,
        flexDirection: 'column',
        border: ['top', 'bottom'],
        borderStyle: 'single',
        backgroundColor: transparentBackground,
        borderColor: terminalForeground,
        ...colored({ borderColor: palette.promptBorder }),
      });
      const body = new Text(renderer, {
        width: '100%',
        height: 'auto',
        flexShrink: 0,
        content,
        wrapMode: 'word',
        selectable: true,
        ...textOptions(tone),
      });
      prompt.add(body);
      addTranscriptRenderable(prompt);
      registerTranscriptBlock(blockKey, prompt, () => content);
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
        addUserPrompt(`» steering\n${body}`, 'cyan', `message:${message.id}`);
      } else if (message.source === 'follow_up') {
        addUserPrompt(`» follow-up\n${body}`, 'cyan', `message:${message.id}`);
      } else {
        addUserPrompt(body, 'normal', `message:${message.id}`);
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
      const placeholder = new Text(renderer, {
        width: '100%',
        height: 1,
        content: ' ',
        selectable: false,
        bg: transparentBackground,
        fg: terminalForeground,
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
      box.add(placeholder);
      box.add(markdown);
      addTranscriptRenderable(box);
      const view: AssistantView = {
        id,
        placeholder,
        markdown,
        textBlocks: new Map(),
      };
      registerTranscriptBlock(
        `message:${id}`,
        box,
        () => joinedBlocks(view.textBlocks),
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
      const textContent = joinedBlocks(view.textBlocks);
      view.placeholder.visible = streaming && textContent === '';
      view.markdown.content = textContent;
      view.markdown.visible = textContent !== '';
      view.markdown.streaming = streaming;
    };

    const pendingFrameTasks = new Map<string, () => void>();
    let streamFrameScheduled = false;
    const cancelFrameTask = (key: string): void => {
      pendingFrameTasks.delete(key);
    };
    const flushStreamFrame = (): void => {
      streamFrameScheduled = false;
      if (screenDestroyed || pendingFrameTasks.size === 0) return;
      const tasks = [...pendingFrameTasks.values()];
      pendingFrameTasks.clear();
      for (const task of tasks) task();
      opts.onStreamFrame?.(tasks.length);
      renderer.requestRender();
      if (pendingFrameTasks.size > 0) scheduleStreamFrame();
    };
    const scheduleStreamFrame = (): void => {
      if (screenDestroyed || streamFrameScheduled) return;
      streamFrameScheduled = true;
      renderer.once('frame', flushStreamFrame);
      renderer.requestRender();
    };
    const queueFrameTask = (key: string, task: () => void): void => {
      pendingFrameTasks.set(key, task);
      scheduleStreamFrame();
    };
    const queueAssistantRefresh = (view: AssistantView): void => {
      queueFrameTask(`assistant:${view.id}`, () => refreshAssistant(view, true));
    };

    const syncAssistant = (view: AssistantView, message: AssistantMessage): void => {
      cancelFrameTask(`assistant:${view.id}`);
      view.textBlocks.clear();
      for (const [index, part] of message.content.entries()) {
        if (part.type === 'text') {
          view.textBlocks.set(index, sanitizeTerminalText(part.text));
        }
      }
      refreshAssistant(view, false);
    };

    const assistantHasVisibleTranscriptContent = (message: AssistantMessage): boolean =>
      message.content.some((part) =>
        part.type === 'text' && sanitizeTerminalText(part.text) !== '');

    const addAssistantMessage = (message: AssistantMessage): void => {
      if (assistantHasVisibleTranscriptContent(message)) {
        finishExplorationGroup();
        const view = createAssistant(message.id);
        syncAssistant(view, message);
      }
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

    const resultText = (result: ToolResultMessage): string =>
      result.content.find((part): part is { type: 'text'; text: string } => part.type === 'text')
        ?.text ?? '';

    const resultHead = (result: ToolResultMessage): string => firstLine(resultText(result));

    const onToolStart = (
      toolCallId: string,
      toolName: string,
      args: unknown,
    ): void => {
      clearWorkingSummary();
      const occurrence = (toolOccurrenceCounts.get(toolCallId) ?? 0) + 1;
      toolOccurrenceCounts.set(toolCallId, occurrence);
      const blockKey = toolTranscriptBlockKey(toolCallId, occurrence);
      const safeToolName = firstLine(sanitizeTerminalText(toolName));
      const rawHeadline = toolHeadline(toolName, args);
      const headline =
        rawHeadline === undefined ? undefined : sanitizeTerminalText(rawHeadline);
      const exploration = explorationCall(toolName, args);
      const bashCommand = toolName === 'bash' ? bashCommandFromArgs(args) : undefined;
      activity = `${safeToolName} running`;
      refreshStatus();
      if (exploration !== undefined) {
        const explorationGroup = addExplorationCall(exploration, blockKey);
        toolViews.set(toolCallId, {
          headline: headline ?? safeToolName,
          name: safeToolName,
          startedAt: Date.now(),
          blockKey,
          explorationGroup,
        });
        return;
      }
      finishExplorationGroup();
      if (bashCommand !== undefined) {
        const bash = addBashTool(bashCommand, blockKey);
        toolViews.set(toolCallId, {
          headline: headline ?? safeToolName,
          name: safeToolName,
          bash,
          startedAt: Date.now(),
          blockKey,
        });
        return;
      }
      if (headline === undefined) return;
      const tool = addToolText(
        `● ${headline}`,
        'cyan',
        blockKey,
      );
      toolViews.set(toolCallId, {
        headline,
        name: safeToolName,
        text: tool.text,
        appendDetail: tool.appendDetail,
        startedAt: Date.now(),
        blockKey,
      });
    };

    const onToolUpdate = (toolCallId: string, output: string): void => {
      const view = toolViews.get(toolCallId);
      if (view?.bash !== undefined) {
        const safeOutput = sanitizeTerminalText(output);
        queueFrameTask(`tool:${toolCallId}`, () => {
          const current = toolViews.get(toolCallId);
          if (current?.bash === undefined) return;
          current.bash.latestOutput = safeOutput;
          refreshBashTool(current.bash);
        });
        return;
      }
      if (view?.text === undefined) return;
      const safeOutput = sanitizeTerminalText(output);
      queueFrameTask(`tool:${toolCallId}`, () => {
        const current = toolViews.get(toolCallId);
        if (current?.text === undefined) return;
        const tail = truncateToWidth(firstLineFromEnd(safeOutput.trimEnd()), 88);
        current.text.content =
          tail === '' ? `● ${current.headline}` : `● ${current.headline}\n  ↳ ${tail}`;
      });
    };

    const onToolEnd = (toolCallId: string, result: ToolResultMessage): void => {
      cancelFrameTask(`tool:${toolCallId}`);
      const view = toolViews.get(toolCallId);
      if (view?.bash !== undefined) {
        view.bash.latestOutput = sanitizeTerminalText(resultText(result));
        view.bash.state = 'completed';
        view.bash.isError = result.isError;
        refreshBashTool(view.bash);
        toolViews.delete(toolCallId);
        addDiff(result.details, view.bash.appendDetail);
        activity = defaultActivity(interactionState());
        refreshStatus();
        return;
      }
      const head = truncateToWidth(sanitizeTerminalText(resultHead(result)), 96);
      const suffix = toolDetailsSuffix(result);
      const marker = result.isError ? '✗' : '✓';
      const elapsed = view === undefined ? undefined : Date.now() - view.startedAt;
      const finalText = sanitizeTerminalText(
        `${marker} ${view?.headline ?? result.toolName}` +
          (elapsed === undefined ? '' : ` · ${formatElapsed(elapsed)}`) +
          (suffix !== undefined ? ` · ${suffix}` : head !== '' ? ` · ${head}` : ''),
      );
      if (view?.explorationGroup !== undefined) {
        view.explorationGroup.activeCallKeys.delete(view.blockKey);
        if (result.isError) {
          recordExplorationFailure(view.explorationGroup, view.headline, result);
        }
        refreshExplorationGroup(view.explorationGroup);
        toolViews.delete(toolCallId);
        addDiff(result.details, view.explorationGroup.appendDetail);
        activity = defaultActivity(interactionState());
        refreshStatus();
        return;
      }

      finishExplorationGroup();
      let renderedAsPlan = false;
      if (result.toolName === 'plan') {
        const steps = planStepsFromDetails(result.details);
        if (!result.isError && steps !== undefined) {
          updatePlan(steps);
          renderedAsPlan = true;
        }
      }
      let appendDetail = view?.appendDetail;
      if (view?.text === undefined) {
        if (!renderedAsPlan) {
          const completed = addToolText(
            finalText,
            result.isError ? 'danger' : 'success',
            `event:${++blockSequence}`,
          );
          appendDetail = completed.appendDetail;
        }
      } else {
        view.text.content = finalText;
        if (resolvedTheme.color) view.text.fg = result.isError ? palette.danger : palette.success;
        toolViews.delete(toolCallId);
      }
      addDiff(result.details, appendDetail);
      activity = defaultActivity(interactionState());
      refreshStatus();
    };

    const addDiff = (
      details: unknown,
      appendDetail?: (renderable: Renderable) => void,
    ): void => {
      const diff = stringField(asRecord(details), 'diff');
      if (diff === undefined || diff === '') return;
      finishExplorationGroup();
      const lines = diff.replace(/\n$/, '').split('\n');
      const box = new Box(renderer, {
        width: '100%',
        height: 'auto',
        flexShrink: 0,
        flexDirection: 'column',
        rowGap: 0,
        backgroundColor: transparentBackground,
      });
      const transcriptLines: string[] = [];
      for (const line of lines.slice(0, DIFF_MAX_LINES)) {
        const tone: Tone =
          line.startsWith('+') && !line.startsWith('+++')
            ? 'success'
            : line.startsWith('-') && !line.startsWith('---')
              ? 'danger'
            : line.startsWith('@@')
              ? 'cyan'
              : 'muted';
        const content = sanitizeTerminalText(`  ${line}`);
        transcriptLines.push(content);
        box.add(new Text(renderer, {
          width: '100%',
          height: 'auto',
          flexShrink: 0,
          content,
          wrapMode: 'word',
          selectable: true,
          ...textOptions(tone),
        }));
      }
      if (lines.length > DIFF_MAX_LINES) {
        const content = `  … ${lines.length - DIFF_MAX_LINES} more diff lines`;
        transcriptLines.push(content);
        box.add(new Text(renderer, {
          width: '100%',
          height: 'auto',
          flexShrink: 0,
          content,
          wrapMode: 'word',
          selectable: true,
          ...textOptions('muted'),
        }));
      }
      if (appendDetail === undefined) addTranscriptRenderable(box);
      else appendDetail(box);
      registerTranscriptBlock(`event:${++blockSequence}`, box, () => transcriptLines.join('\n'));
      renderer.requestRender();
    };

    const refreshPlan = (): void => {
      if (planText === undefined || planSteps === undefined) return;
      const presentation = layoutPlan(
        planSteps,
        Math.max(1, layoutWidth - TRANSCRIPT_PADDING_X * 2),
        displayWidth,
        !resolvedTheme.color,
      );
      const normal = fg(terminalForeground);
      const muted = fg(toneColor('muted'));
      const active = fg(toneColor('cyan'));
      const chunks: TextChunk[] = [muted('• '), bold(normal(presentation.title))];
      const progress = formatPlanProgress(presentation.progress);
      if (progress !== undefined) {
        chunks.push(muted(`${resolvedTheme.color ? ' · ' : ' | '}${progress}`));
      }
      if (presentation.lines.length > 0) chunks.push(normal('\n'));
      presentation.lines.forEach((line, index) => {
        chunks.push(muted(line.prefix));
        if (line.status === 'completed') {
          if (line.marker !== '') chunks.push(dim(muted(`${line.marker} `)));
          chunks.push(strikethrough(dim(muted(line.text))));
        } else if (line.status === 'in_progress') {
          if (line.marker !== '') chunks.push(bold(active(`${line.marker} `)));
          chunks.push(bold(active(line.text)));
        } else if (line.status === 'pending') {
          if (line.marker !== '') chunks.push(dim(muted(`${line.marker} `)));
          chunks.push(dim(muted(line.text)));
        } else {
          chunks.push(dim(muted(line.text)));
        }
        if (index < presentation.lines.length - 1) chunks.push(normal('\n'));
      });
      planText.content = new StyledText(chunks);
      renderer.requestRender();
    };

    const updatePlan = (steps: Extract<CliRuntimeEvent, { type: 'plan_update' }>['steps']): void => {
      finishExplorationGroup();
      // plan 是整表替换的 Runtime 快照；单行化防止不可信 step 文本伪造列表层级。
      planSteps = steps.map((step) => ({
        step: sanitizeTerminalLine(step.step),
        status: step.status,
      }));
      if (planText === undefined) {
        planText = new Text(renderer, {
          id: 'coda-plan',
          width: '100%',
          height: 'auto',
          flexShrink: 0,
          content: '',
          wrapMode: 'word',
          selectable: true,
          ...textOptions('normal'),
        });
        addTranscriptRenderable(planText);
        registerTranscriptBlock(
          'plan',
          planText,
          () => planPlainText(planSteps ?? [], !resolvedTheme.color),
        );
      }
      refreshPlan();
    };

    const onProviderUpdate = (
      messageId: string,
      event: Extract<CliRuntimeEvent, { type: 'message_update' }>['event'],
    ): void => {
      const assistantForText = (): AssistantView => {
        if (currentAssistant === undefined || currentAssistant.id !== messageId) {
          currentAssistant = createAssistant(messageId);
        }
        return currentAssistant;
      };
      const isDisplaySafeReasoningSummary = (candidate: ProviderEvent): boolean => {
        if (!('partial' in candidate) || !('contentIndex' in candidate)) return false;
        const part = candidate.partial.content[candidate.contentIndex];
        return part?.type === 'reasoning' && part.kind === 'summary';
      };
      switch (event.type) {
        case 'text_start': {
          const part = event.partial.content[event.contentIndex];
          const initial = part?.type === 'text' ? sanitizeTerminalText(part.text) : '';
          if (initial === '') break;
          const view = assistantForText();
          finishExplorationGroup();
          view.textBlocks.set(event.contentIndex, initial);
          queueAssistantRefresh(view);
          break;
        }
        case 'text_delta': {
          const delta = sanitizeTerminalText(event.delta);
          if (delta === '') break;
          const view = assistantForText();
          finishExplorationGroup();
          const previous = view.textBlocks.get(event.contentIndex) ?? '';
          view.textBlocks.set(
            event.contentIndex,
            previous + delta,
          );
          queueAssistantRefresh(view);
          break;
        }
        case 'text_end': {
          const content = sanitizeTerminalText(event.content);
          if (content === '') break;
          const view = assistantForText();
          finishExplorationGroup();
          view.textBlocks.set(event.contentIndex, content);
          queueAssistantRefresh(view);
          break;
        }
        case 'reasoning_start': {
          if (!isDisplaySafeReasoningSummary(event)) break;
          clearWorkingSummary();
          break;
        }
        case 'reasoning_delta': {
          if (!isDisplaySafeReasoningSummary(event)) break;
          appendWorkingSummary(event.contentIndex, event.delta);
          break;
        }
        case 'reasoning_end': {
          if (!isDisplaySafeReasoningSummary(event)) break;
          finishWorkingSummary(event.contentIndex, event.content);
          break;
        }
        case 'tool_call_start': {
          clearWorkingSummary();
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

    const scrollAnchorBlock = (
      anchor: TranscriptScrollAnchor,
    ): TranscriptBlock | undefined => {
      const candidates = [anchor.blockKey, ...anchor.fallbackBlockKeys];
      return candidates
        .map((key) => transcriptBlocks.find((candidate) =>
          candidate.key === key || candidate.aliases.includes(key)))
        .find((candidate) => candidate !== undefined);
    };
    const restoreScrollAnchor = (
      anchor: TranscriptScrollAnchor,
    ): boolean => {
      const block = scrollAnchorBlock(anchor);
      if (block === undefined) return false;
      pauseTranscriptFollowing();
      // Moving scrollTop by the block-to-viewport delta keeps the same logical row inside
      // the anchored block, regardless of prepended replay segments or a resized viewport.
      transcript.scrollTop = Math.max(
        0,
        transcript.scrollTop + block.renderable.y +
          anchor.logicalOffset - transcript.viewport.y,
      );
      return true;
    };
    const scheduleScrollRestore = (anchor: TranscriptScrollAnchor): void => {
      const generation = transcriptGeneration;
      pendingScrollAnchor = anchor;
      if (scrollRestoreScheduled) return;
      scrollRestoreScheduled = true;
      renderer.once('frame', () => {
        if (screenDestroyed || generation !== transcriptGeneration) return;
        scrollRestoreScheduled = false;
        const pending = pendingScrollAnchor;
        pendingScrollAnchor = undefined;
        if (pending !== undefined && !restoreScrollAnchor(pending)) {
          // A saved anchor can point into an older replay segment. The first tail frame has
          // already rendered; load only until that stable key becomes available, then restore
          // it instead of falsely reporting that the message was compacted.
          while (replayCursor > 0) {
            if (!loadEarlierReplay()) break;
            if (scrollAnchorBlock(pending) !== undefined) {
              // The inserted renderable receives its final y only on the next layout frame.
              // loadEarlierReplay already queued that frame; overwrite its temporary viewport
              // anchor with the durable target so the target wins after layout.
              pendingScrollAnchor = pending;
              renderer.requestRender();
              return;
            }
          }
          transientStatus = 'saved scroll anchor was compacted; showing surviving transcript';
        }
        renderer.requestRender();
      });
      renderer.requestRender();
    };

    const jumpToLatest = (): void => {
      // Move while native sticky is paused, then re-enable it from the exact bottom. This avoids
      // treating maximum - 1 as latest while still letting subsequent content follow naturally.
      transcript.stickyScroll = false;
      transcript.scrollTo({ x: 0, y: transcript.scrollHeight });
      transcript.stickyScroll = true;
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
      if (replayCursor > 0) {
        const generation = transcriptGeneration;
        loadEarlierReplay(true);
        renderer.once('frame', () => {
          if (!screenDestroyed && generation === transcriptGeneration) {
            searchTranscript('', direction);
          }
        });
        renderer.requestRender();
        return true;
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
      pauseTranscriptFollowing();
      transcript.scrollChildIntoView(match.renderable.id);
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

    const render = (event: CliRuntimeEvent): void => {
      switch (event.type) {
        case 'agent_start':
          finishExplorationGroup();
          transientStatus = undefined;
          clearWorkingSummary();
          activity = event.reason === 'follow_up' ? 'follow-up' : 'working';
          if (event.reason === 'follow_up') addText('↪ follow-up', 'cyan');
          refreshStatus();
          break;
        case 'agent_end':
          completeExplorationGroups();
          finishExplorationGroup();
          currentAssistant = undefined;
          clearWorkingSummary();
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
            currentAssistant = undefined;
            clearWorkingSummary();
          }
          break;
        case 'message_update':
          onProviderUpdate(event.messageId, event.event);
          break;
        case 'message_end':
          if (event.message.role === 'assistant') {
            syncWorkingSummaryFromMessage(event.message);
            if (assistantHasVisibleTranscriptContent(event.message)) finishExplorationGroup();
            let view =
              currentAssistant?.id === event.message.id
                ? currentAssistant
                : undefined;
            if (view === undefined && assistantHasVisibleTranscriptContent(event.message)) {
              view = createAssistant(event.message.id);
            }
            if (view !== undefined) syncAssistant(view, event.message);
            addAssistantWarning(event.message);
            currentAssistant = undefined;
          }
          break;
        case 'tool_execution_start':
          if (approvalCard?.toolCallId === event.toolCallId) {
            approvalPending = false;
            approvalCard = undefined;
          }
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
        case 'control_request':
          if (event.kind !== 'approval') break;
          finishExplorationGroup();
          clearWorkingSummary();
          approvalPending = true;
          {
            approvalCard = {
              toolCallId: event.payload.toolCallId,
              presentation: event.payload.presentation,
              selectedIndex: 0,
              expanded: false,
            };
          }
          refreshStatus();
          break;
        case 'error':
          completeExplorationGroups();
          if (interactionState() === 'idle') transientStatus = undefined;
          activity = defaultActivity(interactionState());
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
          clearWorkingSummary();
          activity = `retry ${event.attempt}/${event.maxAttempts}`;
          addText(
            `↻ retry ${event.attempt}/${event.maxAttempts} in ${event.delayMs}ms · ${event.errorMessage}`,
            'warning',
          );
          refreshStatus();
          break;
        case 'compaction_start':
          clearWorkingSummary();
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
          activity = defaultActivity(interactionState());
          refreshStatus();
          break;
        default:
          break;
      }
      const streamingUpdate =
        event.type === 'message_update' || event.type === 'tool_execution_update';
      observeOutputEvent(
        event.type !== 'queue_update' &&
        event.type !== 'usage_update' &&
        event.type !== 'turn_start' &&
        event.type !== 'turn_end',
        streamingUpdate,
      );
    };

    const renderDeferredReplayStarts = (messageIndex: number): void => {
      for (const deferred of replayDeferredToolStarts.get(messageIndex) ?? []) {
        const { part, blockKey } = deferred;
        const exploration = explorationCall(part.name, part.arguments);
        if (exploration !== undefined) {
          replayExplorationGroups.set(
            blockKey,
            addExplorationCall(exploration, blockKey),
          );
          continue;
        }
        const bashCommand = part.name === 'bash'
          ? bashCommandFromArgs(part.arguments)
          : undefined;
        if (bashCommand !== undefined) {
          addBashTool(bashCommand, blockKey);
          continue;
        }
        const headline = toolHeadline(part.name, part.arguments);
        addToolText(
          `● ${sanitizeTerminalText(headline ?? part.name)}`,
          'cyan',
          blockKey,
        );
      }
    };

    const renderHistoricalMessages = (
      messages: readonly AgentMessage[],
      start: number,
      end: number,
    ): void => {
      // A lazily prepended segment is not necessarily contiguous with the already-rendered
      // tail. Keep its exploration cell local rather than merging across that visual seam.
      if (transcriptInsertIndex !== undefined) finishExplorationGroup();
      for (let messageIndex = start; messageIndex < end; messageIndex++) {
        const message = messages[messageIndex];
        if (message === undefined) continue;
        if (message.role === 'user') addUser(message);
        else if (message.role === 'assistant') {
          addAssistantMessage(message);
          for (const [contentIndex, part] of message.content.entries()) {
            if (part.type === 'tool_call') {
              const callKey = `${messageIndex}:${contentIndex}`;
              const blockKey = replayToolCallBlockKeys.get(callKey) ??
                toolTranscriptBlockKey(part.id, 1);
              if (replayCompletedToolCalls.has(callKey) ||
                replayDeferredToolCallKeys.has(callKey)) continue;
              const exploration = explorationCall(part.name, part.arguments);
              if (exploration !== undefined) {
                replayExplorationGroups.set(
                  blockKey,
                  addExplorationCall(exploration, blockKey),
                );
                continue;
              }
              const bashCommand = part.name === 'bash'
                ? bashCommandFromArgs(part.arguments)
                : undefined;
              if (bashCommand !== undefined) {
                addBashTool(bashCommand, blockKey);
                continue;
              }
              const headline = toolHeadline(part.name, part.arguments);
              if (headline !== undefined) {
                addToolText(
                  `● ${sanitizeTerminalText(headline)}`,
                  'cyan',
                  blockKey,
                );
              }
            }
          }
        }
        else {
          // Historical replay is a pure projection. In particular, loading an older segment
          // must not mutate the current plan or live tool/activity state.
          const exploration = replayToolResultExplorations.get(messageIndex);
          if (exploration !== undefined) {
            const group = replayExplorationGroups.get(exploration.blockKey) ??
              addExplorationCall(exploration.call, exploration.blockKey);
            group.activeCallKeys.delete(exploration.blockKey);
            if (message.isError) {
              recordExplorationFailure(
                group,
                formatExplorationRow(exploration.call),
                message,
              );
            }
            refreshExplorationGroup(group);
            replayExplorationGroups.delete(exploration.blockKey);
            addDiff(message.details, group.appendDetail);
            renderDeferredReplayStarts(messageIndex);
            continue;
          }
          finishExplorationGroup();
          const bashCommand = replayToolResultBashCommands.get(messageIndex);
          if (bashCommand !== undefined) {
            const bash = addBashTool(
              bashCommand,
              replayToolResultBlockKeys.get(messageIndex) ??
                `tool:${message.toolCallId}:result:${message.id}`,
              'completed',
              sanitizeTerminalText(resultText(message)),
              message.isError,
            );
            addDiff(message.details, bash.appendDetail);
            renderDeferredReplayStarts(messageIndex);
            continue;
          }
          const headline = replayToolResultHeadlines.get(messageIndex) ??
            sanitizeTerminalText(message.toolName);
          const head = truncateToWidth(sanitizeTerminalText(resultHead(message)), 96);
          const suffix = toolDetailsSuffix(message);
          const marker = message.isError ? '✗' : '✓';
          const renderedAsPlan = message.toolName === 'plan' &&
            !message.isError &&
            planStepsFromDetails(message.details) !== undefined;
          let appendDetail: ((renderable: Renderable) => void) | undefined;
          if (!renderedAsPlan) {
            const completed = addToolText(
              `${marker} ${headline}` +
                (suffix !== undefined ? ` · ${suffix}` : head !== '' ? ` · ${head}` : ''),
              message.isError ? 'danger' : 'success',
              replayToolResultBlockKeys.get(messageIndex) ??
                `tool:${message.toolCallId}:result:${message.id}`,
            );
            appendDetail = completed.appendDetail;
          }
          addDiff(message.details, appendDetail);
        }
        renderDeferredReplayStarts(messageIndex);
      }
    };

    const indexReplayToolPairs = (messages: readonly AgentMessage[]): void => {
      replayCompletedToolCalls.clear();
      replayToolResultHeadlines.clear();
      replayToolResultBashCommands.clear();
      replayToolCallBlockKeys.clear();
      replayToolResultBlockKeys.clear();
      replayToolResultExplorations.clear();
      replayExplorationGroups.clear();
      replayDeferredToolCallKeys.clear();
      replayDeferredToolStarts.clear();
      replayLatestPlanSteps = undefined;
      const occurrences = new Map<string, number>();
      for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
        const message = messages[messageIndex];
        if (message?.role === 'tool_result') {
          if (message.toolName === 'plan' && !message.isError) {
            const steps = planStepsFromDetails(message.details);
            if (steps !== undefined) replayLatestPlanSteps = steps;
          }
          continue;
        }
        if (message?.role !== 'assistant') continue;
        const calls = new Map<string, {
          readonly key: string;
          readonly part: ToolCallPart;
          readonly blockKey: string;
          readonly headline: string;
          readonly exploration: ExplorationCall | undefined;
          readonly bashCommand: string | undefined;
        }>();
        const orderedCalls: Array<NonNullable<ReturnType<typeof calls.get>>> = [];
        for (const [contentIndex, part] of message.content.entries()) {
          if (part.type !== 'tool_call') continue;
          const occurrence = (occurrences.get(part.id) ?? 0) + 1;
          occurrences.set(part.id, occurrence);
          const callKey = `${messageIndex}:${contentIndex}`;
          const blockKey = toolTranscriptBlockKey(part.id, occurrence);
          replayToolCallBlockKeys.set(callKey, blockKey);
          const call = {
            key: callKey,
            part,
            blockKey,
            headline: sanitizeTerminalText(toolHeadline(part.name, part.arguments) ?? part.name),
            exploration: explorationCall(part.name, part.arguments),
            bashCommand: part.name === 'bash' ? bashCommandFromArgs(part.arguments) : undefined,
          };
          calls.set(part.id, call);
          orderedCalls.push(call);
        }
        const resultIndexes = new Map<string, number>();
        for (let resultIndex = messageIndex + 1; resultIndex < messages.length; resultIndex++) {
          const result = messages[resultIndex];
          if (result?.role !== 'tool_result') break;
          const call = calls.get(result.toolCallId);
          if (call === undefined) continue;
          replayCompletedToolCalls.add(call.key);
          resultIndexes.set(call.key, resultIndex);
          replayToolResultHeadlines.set(resultIndex, call.headline);
          if (call.bashCommand !== undefined) {
            replayToolResultBashCommands.set(resultIndex, call.bashCommand);
          }
          replayToolResultBlockKeys.set(
            resultIndex,
            replayToolCallBlockKeys.get(call.key) ?? toolTranscriptBlockKey(result.toolCallId, 1),
          );
          if (call.exploration !== undefined) {
            replayToolResultExplorations.set(resultIndex, {
              call: call.exploration,
              blockKey: replayToolCallBlockKeys.get(call.key) ??
                toolTranscriptBlockKey(result.toolCallId, 1),
            });
          }
          calls.delete(result.toolCallId);
        }
        let releaseAfter = messageIndex;
        for (const call of orderedCalls) {
          const resultIndex = resultIndexes.get(call.key);
          if (resultIndex !== undefined) {
            releaseAfter = Math.max(releaseAfter, resultIndex);
            continue;
          }
          replayDeferredToolCallKeys.add(call.key);
          const pending = replayDeferredToolStarts.get(releaseAfter) ?? [];
          pending.push({ part: call.part, blockKey: call.blockKey });
          replayDeferredToolStarts.set(releaseAfter, pending);
        }
      }
      toolOccurrenceCounts.clear();
      for (const [toolCallId, occurrence] of occurrences) {
        toolOccurrenceCounts.set(toolCallId, occurrence);
      }
    };

    const replayChunkStart = (messages: readonly AgentMessage[], target: number): number => {
      let start = Math.max(0, Math.min(target, messages.length));
      const lowerBound = Math.max(0, start - TRANSCRIPT_REPLAY_CHUNK_MESSAGES);
      while (start > lowerBound) {
        const message = messages[start];
        if (
          message?.role === 'user' &&
          (message.source === 'prompt' || message.source === 'follow_up')
        ) {
          break;
        }
        start--;
      }
      return start;
    };

    const refreshReplayBanner = (): void => {
      if (replayBanner === undefined) return;
      const loaded = replayMessages.length - replayCursor;
      replayBanner.content = replayCursor === 0
        ? `— resumed session · ${replayMessages.length} messages —`
        : `— resumed session · showing last ${loaded}/${replayMessages.length} messages · ` +
          'PageUp loads earlier —';
    };

    const loadEarlierReplay = (all = false): boolean => {
      if (replayCursor <= 0) return false;
      const anchor = captureScrollAnchor();
      pauseTranscriptFollowing();
      const previousCursor = replayCursor;
      const target = all
        ? 0
        : Math.max(0, previousCursor - TRANSCRIPT_REPLAY_CHUNK_MESSAGES);
      const nextCursor = replayChunkStart(replayMessages, target);
      transcriptInsertIndex = 1;
      blockInsertIndex = 1;
      try {
        renderHistoricalMessages(replayMessages, nextCursor, previousCursor);
      } finally {
        transcriptInsertIndex = undefined;
        blockInsertIndex = undefined;
      }
      replayCursor = nextCursor;
      refreshReplayBanner();
      if (anchor !== undefined) scheduleScrollRestore(anchor);
      transientStatus = replayCursor === 0
        ? 'complete transcript loaded'
        : `${previousCursor - nextCursor} earlier messages loaded · PageUp for more`;
      refreshStatus();
      return true;
    };

    const replayTranscript = (messages: readonly AgentMessage[]): void => {
      clearWorkingSummary();
      if (messages.length === 0) return;
      replayMessages = [...messages];
      indexReplayToolPairs(replayMessages);
      replayCursor = replayChunkStart(
        replayMessages,
        Math.max(0, replayMessages.length - TRANSCRIPT_REPLAY_CHUNK_MESSAGES),
      );
      replayBanner = addText('', 'muted', 'replay:banner');
      refreshReplayBanner();
      renderHistoricalMessages(replayMessages, replayCursor, replayMessages.length);
      if (replayLatestPlanSteps !== undefined) updatePlan(replayLatestPlanSteps);
      activity = undefined;
      refreshStatus();
    };

    const resetTranscript = (messages: readonly AgentMessage[], highWaterSeq?: number): void => {
      transcriptGeneration++;
      pendingScrollAnchor = undefined;
      scrollRestoreScheduled = false;
      mouseScrollStateScheduled = false;
      pendingFrameTasks.clear();
      activePanel = 'transcript';
      diffPanel.visible = false;
      sessionPanel.visible = false;
      transcript.visible = true;
      for (const child of transcript.getChildren()) transcript.remove(child);
      transcriptBlocks.splice(0, transcriptBlocks.length);
      replayMessages = [];
      replayCursor = 0;
      replayBanner = undefined;
      replayCompletedToolCalls.clear();
      replayToolResultHeadlines.clear();
      replayToolResultBashCommands.clear();
      replayToolCallBlockKeys.clear();
      replayToolResultBlockKeys.clear();
      replayToolResultExplorations.clear();
      replayExplorationGroups.clear();
      replayDeferredToolCallKeys.clear();
      replayDeferredToolStarts.clear();
      replayLatestPlanSteps = undefined;
      toolOccurrenceCounts.clear();
      toolViews.clear();
      bashToolViews.clear();
      activeExplorationGroup = undefined;
      currentAssistant = undefined;
      clearWorkingSummary();
      planSteps = undefined;
      planText = undefined;
      approvalCard = undefined;
      approvalPending = false;
      transcriptSearchQuery = '';
      transcriptSearchOrdinal = 0;
      manuallyScrolled = false;
      unreadAfterSeq = 0;
      lastObservedHighWater = highWaterSeq ?? opts.eventHighWaterSeq?.() ?? lastObservedHighWater;
      replayTranscript(messages);
      jumpToLatest();
    };

    const refreshDiffViewer = (): void => {
      const snapshot = diffSnapshot;
      if (snapshot === undefined) return;
      const files = snapshot.files;
      diffFileIndex = Math.max(0, Math.min(diffFileIndex, Math.max(0, files.length - 1)));
      const current = files[diffFileIndex];
      diffHeader.content = files.length === 0
        ? `${snapshot.scope} diff · no files · Tab switch scope · Esc close`
        : `${snapshot.scope} diff · ${diffFileIndex + 1}/${files.length} · ` +
          '←/→ file · ↑/↓ scroll · PgUp/PgDn · Tab scope · Esc close';
      diffFiles.content = files.length === 0
        ? '(no changed files)'
        : files.map((file, index) =>
            sanitizeTerminalText(
              `${index === diffFileIndex ? '›' : ' '} [${file.group}] ${file.status} ${file.path}`,
            ))
          .join('\n');
      diffBody.content = current === undefined
        ? ''
        : sanitizeTerminalText(current.patch === '' ? '(no textual patch)' : current.patch);
      diffScroll.scrollTo({ x: 0, y: 0 });
      renderer.requestRender();
    };

    const openDiffViewer = (snapshot: Readonly<RuntimeDiffSnapshot>): void => {
      diffSnapshot = snapshot;
      diffFileIndex = 0;
      activePanel = 'diff';
      sessionPanel.visible = false;
      transcript.visible = false;
      diffPanel.visible = true;
      refreshDiffViewer();
    };

    const closeDiffViewer = (): void => {
      if (!diffPanel.visible) return;
      activePanel = 'transcript';
      diffPanel.visible = false;
      transcript.visible = true;
      diffSnapshot = undefined;
      renderer.requestRender();
    };

    const handleDiffViewerKey = (key: KeyEvent): 'none' | 'handled' | 'toggle-scope' => {
      if (!diffPanel.visible) return 'none';
      if (key.name === 'escape') {
        closeDiffViewer();
        return 'handled';
      }
      if (key.name === 'left' || key.name === 'right') {
        const count = diffSnapshot?.files.length ?? 0;
        if (count > 0) {
          diffFileIndex = (diffFileIndex + (key.name === 'left' ? -1 : 1) + count) % count;
          refreshDiffViewer();
        }
        return 'handled';
      }
      if (key.name === 'up' || key.name === 'down') {
        diffScroll.scrollBy(key.name === 'up' ? -1 : 1);
        return 'handled';
      }
      if (key.name === 'pageup' || key.name === 'pagedown') {
        diffScroll.scrollBy(key.name === 'pageup' ? -0.9 : 0.9, 'viewport');
        return 'handled';
      }
      if (key.name === 'home') {
        diffScroll.scrollTo({ x: 0, y: 0 });
        return 'handled';
      }
      if (key.name === 'end') {
        diffScroll.scrollTo({ x: 0, y: diffScroll.scrollHeight });
        return 'handled';
      }
      if (key.name === 'tab') return 'toggle-scope';
      // While the diff owns the viewport, every key belongs to that panel. In particular,
      // printable keys must not leak into the hidden composer.
      return 'handled';
    };

    const refreshSessionPicker = (): void => {
      sessionIndex = Math.max(0, Math.min(sessionIndex, Math.max(0, sessionItems.length - 1)));
      sessionHeader.content =
        `Sessions · ${sessionItems.length} match(es)` +
        `${sessionQuery === '' ? '' : ` · search ${JSON.stringify(sessionQuery)}`}\n` +
        'Type to search · Backspace edit · ↑/↓ select · Enter switch · Esc close';
      if (sessionItems.length === 0) {
        sessionList.content = 'No matching sessions.';
      } else {
        const radius = Math.max(2, Math.floor((layoutHeight - 10) / 4));
        const start = Math.max(0, Math.min(sessionIndex - radius, sessionItems.length - radius * 2 - 1));
        const visible = sessionItems.slice(start, start + radius * 2 + 1);
        sessionList.content = visible.map((item, offset) => {
          const index = start + offset;
          const state = item.thread.archivedAt === undefined
            ? item.thread.state
            : `${item.thread.state}, archived`;
          return sanitizeTerminalText(
            `${index === sessionIndex ? '›' : ' '} ${item.thread.title?.trim() || '(untitled)'}\n` +
            `    ${state} · ${new Date(item.updatedAt).toISOString()} · ${item.cwd}\n` +
            `    ${item.preview ?? '(no preview)'} · ${item.thread.threadId}`,
          );
        }).join('\n\n');
      }
      renderer.requestRender();
    };

    const openSessionPicker = (
      items: readonly RuntimeThreadListItem[],
      query: string,
    ): void => {
      activePanel = 'sessions';
      diffPanel.visible = false;
      diffSnapshot = undefined;
      transcript.visible = false;
      sessionPanel.visible = true;
      allSessionItems = items;
      sessionQuery = sanitizeTerminalText(query);
      sessionItems = filterSessionItems(allSessionItems, sessionQuery);
      sessionIndex = 0;
      refreshSessionPicker();
    };

    const closeSessionPicker = (): void => {
      if (!sessionPanel.visible) return;
      activePanel = 'transcript';
      sessionPanel.visible = false;
      transcript.visible = true;
      allSessionItems = [];
      sessionItems = [];
      renderer.requestRender();
    };

    const handleSessionPickerKey = (key: KeyEvent):
      | { readonly kind: 'none' | 'handled' }
      | { readonly kind: 'select'; readonly threadId: ThreadId } => {
      if (!sessionPanel.visible) return { kind: 'none' };
      if (key.name === 'escape') {
        closeSessionPicker();
        return { kind: 'handled' };
      }
      if (key.name === 'up' || key.name === 'down') {
        if (sessionItems.length > 0) {
          sessionIndex = (sessionIndex + (key.name === 'up' ? -1 : 1) + sessionItems.length)
            % sessionItems.length;
          refreshSessionPicker();
        }
        return { kind: 'handled' };
      }
      if (key.name === 'return' || key.name === 'enter' || key.name === 'kpenter') {
        const selected = sessionItems[sessionIndex];
        if (selected === undefined) return { kind: 'handled' };
        closeSessionPicker();
        return { kind: 'select', threadId: selected.thread.threadId };
      }
      if (key.name === 'backspace') {
        const characters = [...sessionQuery];
        characters.pop();
        sessionQuery = characters.join('');
        sessionItems = filterSessionItems(allSessionItems, sessionQuery);
        sessionIndex = 0;
        refreshSessionPicker();
        return { kind: 'handled' };
      }
      if (!key.ctrl && !key.meta && !key.option && !key.super && !key.hyper
        && key.sequence !== '' && !/[\p{Cc}\p{Cf}]/u.test(key.sequence)) {
        sessionQuery = sanitizeTerminalText(`${sessionQuery}${key.sequence}`);
        sessionItems = filterSessionItems(allSessionItems, sessionQuery);
        sessionIndex = 0;
        refreshSessionPicker();
        return { kind: 'handled' };
      }
      return { kind: 'handled' };
    };

    const applyResponsiveLayout = (width: number, height: number): void => {
      layoutWidth = width;
      layoutHeight = height;
      refreshBashToolViews();
      refreshPlan();
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
      const beforeTop = transcript.scrollTop;
      const beforeMaximum = transcriptMaximum();
      const wasManuallyScrolled = manuallyScrolled;
      const canMove = direction === 'up'
        ? beforeTop > 0
        : beforeTop < beforeMaximum;
      const canLoadEarlierAtTop = direction === 'up' && replayCursor > 0 && beforeTop <= 0;

      // A wheel event over content that has not entered layout yet is a real no-op. Do not let
      // intent alone create a manual mode, anchor, or unread boundary.
      if (!canMove && !canLoadEarlierAtTop && !(direction === 'down' && manuallyScrolled)) {
        return;
      }
      if (direction === 'up' && (canMove || canLoadEarlierAtTop)) {
        // The callback runs before ScrollBox's built-in movement. Pause sticky now so the next
        // layout cannot turn a one-row wheel-up into maximum - 1 -> maximum rebound.
        pauseTranscriptFollowing();
        // Freeze a stable, already-laid-out anchor for output that can arrive before the frame
        // callback records the post-wheel position. A speculative no-move is rolled back below.
        persistScrollState();
      }
      if (mouseScrollStateScheduled) return;
      mouseScrollStateScheduled = true;
      const generation = transcriptGeneration;
      // ScrollBox applies its built-in movement later in this dispatch. Inspect the result on the
      // next frame so only an actual movement (or a real segment load) changes presentation mode.
      renderer.once('frame', () => {
        if (screenDestroyed || generation !== transcriptGeneration) return;
        mouseScrollStateScheduled = false;
        const afterTop = transcript.scrollTop;
        const afterMaximum = transcriptMaximum();
        if (direction === 'up') {
          if (replayCursor > 0 && afterTop <= 0 && loadEarlierReplay()) {
            const wheelStep = Math.max(1, event.scroll?.delta ?? 1);
            // loadEarlierReplay first restores the stable anchor after prepend. Register after it
            // so this same wheel interaction then exposes an earlier row instead of only loading.
            renderer.once('frame', () => {
              if (screenDestroyed || generation !== transcriptGeneration) return;
              transcript.scrollBy(-wheelStep);
              pauseTranscriptFollowing();
              persistScrollState();
              refreshTaskStatus();
              renderer.requestRender();
            });
            renderer.requestRender();
            return;
          }
          if (afterTop < beforeTop) {
            pauseTranscriptFollowing();
            persistScrollState();
            refreshTaskStatus();
          } else if (!wasManuallyScrolled) {
            // Sticky was paused speculatively before built-in dispatch, but no movement occurred.
            jumpToLatest();
          }
        } else if (manuallyScrolled && afterTop >= afterMaximum) {
          jumpToLatest();
        } else if (manuallyScrolled && afterTop > beforeTop) {
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
      activePanel: () => activePanel,
      replayTranscript,
      resetTranscript,
      openDiffViewer,
      handleDiffViewerKey,
      openSessionPicker,
      handleSessionPickerKey,
      println(text: string, tone: Tone = 'normal'): void {
        addText(text, tone);
        observeOutputEvent();
      },
      setUsage(nextUsage: CliThreadUsage): void {
        usage = nextUsage;
        refreshStatus();
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
      setInsertMode(mode: InsertMode): void {
        insertMode = mode;
        refreshStatus();
      },
      resolveApproval(): void {
        approvalPending = false;
        approvalCard = undefined;
        refreshStatus();
        input.focus();
        refreshCursorVisibility();
      },
      handleApprovalPanelKey(key: KeyEvent): ApprovalPanelKeyResult {
        if (!approvalPending || approvalCard === undefined) return { kind: 'none' };
        if (key.ctrl || key.meta || key.shift || key.option || key.super || key.hyper) {
          return { kind: 'none' };
        }
        if (key.name === 'v') {
          approvalCard.expanded = !approvalCard.expanded;
          refreshComposerLayout();
          return { kind: 'handled' };
        }
        const options = approvalPanelOptions(approvalCard.presentation);
        if ((key.name === 'up' || key.name === 'down') && options.length > 0) {
          const delta = key.name === 'up' ? -1 : 1;
          approvalCard.selectedIndex =
            (approvalCard.selectedIndex + delta + options.length) % options.length;
          refreshComposerLayout();
          return { kind: 'handled' };
        }
        if (
          key.name === 'return' || key.name === 'enter' || key.name === 'kpenter' ||
          key.name === 'linefeed'
        ) {
          const selected = options[approvalCard.selectedIndex];
          return selected === undefined
            ? { kind: 'handled' }
            : { kind: 'decision', decision: selected.decision };
        }
        const decision = approvalDecisionForKey(key);
        return decision === undefined
          ? { kind: 'none' }
          : { kind: 'decision', decision };
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
        // Diff/session payloads come from live Runtime queries and are intentionally not stored.
        // A recovered presentation therefore has exactly one safe panel: the transcript.
        activePanel = 'transcript';
        diffPanel.visible = false;
        sessionPanel.visible = false;
        transcript.visible = true;
        vimEnabled = state.vimEnabled;
        vimInsertMode = !vimEnabled;
        unreadAfterSeq = state.unreadAfterSeq <= lastObservedHighWater
          ? state.unreadAfterSeq
          : 0;
        transcriptSearchQuery = state.search?.query ?? '';
        transcriptSearchOrdinal = state.search?.matchOrdinal ?? 0;
        if (state.draft !== '') input.setText(state.draft);
        input.gotoBufferEnd();
        if (state.scrollAnchor !== undefined) {
          // Manual mode begins with the durable navigation fact, not one layout frame later.
          // Output arriving between restorePresentation and that frame is already unread.
          pauseTranscriptFollowing();
          scheduleScrollRestore(state.scrollAnchor);
        }
        refreshStatus();
      },
      setVimEnabled(enabled: boolean): void {
        vimEnabled = enabled;
        vimInsertMode = !enabled;
        refreshStatus();
      },
      handleComposerModeKey,
      scrollPage(direction: -1 | 1): void {
        if (direction < 0 && loadEarlierReplay()) {
          // Prepending preserves the prior anchor. Move after that restore so the first PageUp is
          // visibly a PageUp, rather than an invisible segment-load-only operation.
          const generation = transcriptGeneration;
          renderer.once('frame', () => {
            if (screenDestroyed || generation !== transcriptGeneration) return;
            transcript.scrollBy(-0.8, 'viewport');
            pauseTranscriptFollowing();
            persistScrollState();
            refreshTaskStatus();
            renderer.requestRender();
          });
          renderer.requestRender();
          return;
        }
        if (direction < 0) {
          const beforeTop = transcript.scrollTop;
          if (beforeTop <= 0) return;
          transcript.stickyScroll = false;
          transcript.scrollBy(-0.8, 'viewport');
          if (transcript.scrollTop < beforeTop) {
            pauseTranscriptFollowing();
            persistScrollState();
            refreshTaskStatus();
          } else if (!manuallyScrolled) {
            transcript.stickyScroll = true;
          }
        } else {
          if (!manuallyScrolled) return;
          const beforeTop = transcript.scrollTop;
          transcript.scrollBy(0.8, 'viewport');
          if (transcript.scrollTop >= transcriptMaximum()) jumpToLatest();
          else if (transcript.scrollTop > beforeTop) persistScrollState();
        }
      },
      destroy(): void {
        if (screenDestroyed) return;
        screenDestroyed = true;
        pendingFrameTasks.clear();
        renderer.off('resize', onResize);
        if (!renderer.isDestroyed) {
          if (opts.workingAnimation === true && resolvedTheme.color) {
            renderer.removeFrameCallback(workingFrameCallback);
          }
          if (workingAnimationLive) renderer.dropLive();
        }
        workingAnimationLive = false;
        syntaxStyle.destroy();
      },
    };
  } catch (error) {
    if (!screenDestroyed) {
      screenDestroyed = true;
      syntaxStyle.destroy();
    }
    renderer.destroy();
    throw error;
  }
}

/**
 * 生产入口只负责 native renderer 与视图初始化；交互控制器单独导出供内存终端测试。
 */
export async function startTui(
  session: CliSession,
  approval: CliControlActions | undefined,
  opts: TuiOptions,
): Promise<number> {
  const openTui = await import('@opentui/core');
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
      interactionState: () => session.interactionState(),
      workingAnimation: true,
    });
    initializingScreen.setUsage(session.usage());
    if (opts.resumed === true) initializingScreen.replayTranscript(session.messages);
    if (opts.presentation !== undefined) {
      initializingScreen.restorePresentation(opts.presentation.store.snapshot());
    }
    initializingScreen.focusInput();
  } catch (error) {
    initializingScreen?.destroy();
    renderer.destroy();
    throw error;
  }
  const screen = initializingScreen;

  return runTuiController(session, approval, screen, renderer, {
    ...(opts.projectRuleWarnings !== undefined && {
      projectRuleWarnings: opts.projectRuleWarnings,
    }),
    ...(opts.providerCommands !== undefined && {
      providerCommands: opts.providerCommands,
    }),
    cwd: opts.cwd,
    version: opts.version,
    ...(opts.workspace !== undefined && { workspace: opts.workspace }),
    ...(opts.presentation !== undefined && { presentation: opts.presentation }),
  });
}

interface TuiControllerOptions {
  cwd?: string;
  version?: string;
  presentation?: TuiOptions['presentation'];
  providerCommands?: {
    registry: ProviderRegistry;
    runtime: InteractiveSession;
  };
  workspace?: RuntimeWorkspaceActions;
  projectRuleWarnings?: ProjectRuleWarningSource;
  /** 内存测试禁用 process signal 接线，避免并行用例互相影响。 */
  installSignalHandlers?: boolean;
}

type TuiControllerRenderer =
  Pick<CliRenderer, 'keyInput' | 'idle' | 'destroy'> &
  Partial<Pick<CliRenderer, 'suspend' | 'resume' | 'copyToClipboardOSC52'>>;

/**
 * 复用纯 TUI 交互决策，保证 prompt/steer/follow-up/审批语义集中定义。
 * 返回前总是关闭 Runtime-backed frontend 并恢复 renderer。
 */
export function runTuiController(
  session: CliSession,
  approval: CliControlActions | undefined,
  screen: TuiScreen,
  renderer: TuiControllerRenderer,
  opts: TuiControllerOptions,
): Promise<number> {
  const history = new InputHistory();
  history.replace(promptHistoryEntries(session.messages));
  const ctrlCExit = new DoublePress(CTRL_C_EXIT_WINDOW_MS);
  type ApprovalRequestEvent = Extract<
    CliRuntimeEvent,
    { type: 'control_request'; kind: 'approval' }
  >;
  const approvalQueue: string[] = [];
  const approvalEvents = new Map<string, ApprovalRequestEvent>();
  let closing = false;
  let editing = false;
  let paletteReturnDraft: string | undefined;
  let latestPromptDraft = opts.presentation?.store.snapshot().draft ?? screen.getInput();
  let providerTaskDraft: string | undefined;
  let providerInputActive = false;
  let providerBeginning = false;
  let insertMode: InsertMode = 'steering';
  let insertModePickerActive = false;
  let insertModePickerDraft: string | undefined;
  let reverseSearchQuery: string | undefined;
  let activeDiffScope: 'turn' | 'workspace' = 'turn';
  let panelRequestGeneration = 0;
  const enqueueApproval = (event: ApprovalRequestEvent): boolean => {
    if (approvalEvents.has(event.requestId)) return false;
    approvalEvents.set(event.requestId, event);
    approvalQueue.push(event.requestId);
    return true;
  };
  const renderCurrentApproval = (): void => {
    const id = approvalQueue[0];
    const event = id === undefined ? undefined : approvalEvents.get(id);
    if (event === undefined) screen.resolveApproval();
    else screen.render(event);
  };
  const clearApprovalQueue = (): void => {
    approvalQueue.length = 0;
    approvalEvents.clear();
  };
  const replaceApprovalQueue = (requests: readonly PendingApprovalView[]): void => {
    const previousHead = approvalQueue[0];
    clearApprovalQueue();
    for (const request of requests) {
      enqueueApproval({
        type: 'control_request',
        requestId: request.requestId,
        kind: 'approval',
        owningRunId: request.presentation.target.runId,
        owningTurnId: request.presentation.target.turnId,
        policyRevision: request.presentation.revisions.effectivePolicy,
        payload: {
          toolCallId: request.toolCallId,
          description: request.description,
          presentation: request.presentation,
        },
      });
    }
    const nextHead = approvalQueue[0];
    if (previousHead === nextHead) return;
    if (nextHead === undefined) screen.resolveApproval();
    else {
      renderCurrentApproval();
    }
  };

  if (opts.workspace !== undefined) {
    replaceApprovalQueue(opts.workspace.pendingApprovals());
  }

  return new Promise<number>((resolve) => {
    const printError = (error: unknown): void => {
      screen.println(
        `prompt failed · ${error instanceof Error ? error.message : String(error)}`,
        'danger',
      );
    };

    screen.setInputChangeHandler((draft) => {
      if (insertModePickerActive || providerInputActive || draft.startsWith('/')) return;
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

    /** 复用 commandPrompt 弹层交互；picker 结束后恢复被保护的草稿。 */
    const beginInsertModePicker = (): string => {
      insertModePickerDraft = paletteReturnDraft ?? latestPromptDraft;
      paletteReturnDraft = undefined;
      insertModePickerActive = true;
      screen.setCommandPrompt('Insert mode · how Enter routes while running', false, [
        ...INSERT_MODE_CHOICES.map((choice) => ({
          value: choice.value,
          label: choice.label,
          description: choice.value === 'steering'
            ? 'Enter steers the current run'
            : 'Enter queues a follow-up',
        })),
      ]);
      return '';
    };

    const finishInsertModePicker = (): void => {
      insertModePickerActive = false;
      screen.setCommandPrompt(undefined, false);
      const draft = insertModePickerDraft ?? '';
      insertModePickerDraft = undefined;
      screen.setInput(draft);
    };

    const cancelInsertModePicker = (): void => {
      finishInsertModePicker();
      screen.println('Insert mode unchanged.', 'muted');
    };

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

    const switchPresentation = (): void => {
      const workspace = opts.workspace;
      if (workspace === undefined) return;
      const state = opts.presentation?.store.switchToThread(workspace.currentThreadId);
      history.replace(promptHistoryEntries(session.messages));
      clearApprovalQueue();
      screen.resolveApproval();
      latestPromptDraft = state?.draft ?? '';
      screen.resetTranscript(session.messages, workspace.eventHighWaterSeq());
      if (state !== undefined) screen.restorePresentation(state);
      screen.setInput(latestPromptDraft);
      screen.setUsage(session.usage());
      screen.setModel(session.currentModel());
      replaceApprovalQueue(workspace.pendingApprovals());
      screen.println(`switched to ${workspace.currentThreadId}`, 'success');
    };

    const transitionPresentation = async (
      transition: () => Promise<unknown>,
    ): Promise<void> => {
      const workspace = opts.workspace;
      if (workspace === undefined) return;
      await runThreadPresentationTransition(
        workspace,
        opts.presentation?.store,
        transition,
        switchPresentation,
      );
    };

    const runWorkspaceCommand = async (command: SlashCommand): Promise<void> => {
      const workspace = opts.workspace;
      if (workspace === undefined) {
        screen.println(`/${command.cmd} is unavailable in this mode`, 'warning');
        return;
      }
      try {
        switch (command.cmd) {
          case 'sessions': {
            const generation = ++panelRequestGeneration;
            const requestedFromPanel = screen.activePanel();
            const sessions = await workspace.listSessions();
            if (
              generation !== panelRequestGeneration ||
              screen.activePanel() !== requestedFromPanel
            ) return;
            screen.openSessionPicker(
              sessions,
              command.query,
            );
            return;
          }
          case 'resume':
          case 'switch':
            if (!isThreadId(command.threadId)) {
              if (command.cmd === 'resume' && command.threadId === '') {
                screen.openSessionPicker(
                  await workspace.listSessions(),
                  '',
                );
              } else {
                screen.println(`usage: /${command.cmd} <thread-id>`, 'warning');
              }
              return;
            }
            const targetThreadId = command.threadId;
            await transitionPresentation(() => workspace.switchSession(targetThreadId));
            return;
          case 'new':
            await transitionPresentation(() => workspace.newSession());
            return;
          case 'rename':
            if (command.title === '') {
              screen.println('usage: /rename <title>', 'warning');
              return;
            }
            await workspace.renameSession(command.title);
            screen.println('Thread renamed.', 'success');
            return;
          case 'archive':
            if (command.mode !== '' && command.mode !== 'on' && command.mode !== 'off') {
              screen.println('usage: /archive [on|off]', 'warning');
              return;
            }
            await workspace.archiveSession(command.mode !== 'off');
            screen.println(command.mode === 'off' ? 'Thread restored.' : 'Thread archived.', 'success');
            return;
          case 'compact':
            await workspace.compactConversation();
            screen.println('Conversation compacted.', 'success');
            return;
          case 'fork':
          case 'retry':
            if (command.turnId !== '' && !isTurnId(command.turnId)) {
              screen.println(`usage: /${command.cmd} [turn-id]`, 'warning');
              return;
            }
            const targetTurnId = command.turnId === '' ? undefined : command.turnId;
            if (command.cmd === 'fork') {
              await transitionPresentation(() => workspace.forkConversation(
                targetTurnId,
              ));
            } else {
              await transitionPresentation(() => workspace.retryConversation(
                targetTurnId,
              ));
            }
            return;
          case 'review': {
            const snapshot = await workspace.reviewSnapshot();
            if (snapshot === undefined) screen.println('No review data for this session.', 'warning');
            else formatReviewSnapshot(snapshot).forEach((line) => screen.println(line, 'muted'));
            return;
          }
          case 'diff': {
            const scope = command.scope === '' ? 'turn' : command.scope;
            if (scope !== 'turn' && scope !== 'workspace') {
              screen.println('usage: /diff [turn|workspace]', 'warning');
              return;
            }
            const generation = ++panelRequestGeneration;
            const requestedFromPanel = screen.activePanel();
            const snapshot = await workspace.diffSnapshot(scope);
            if (
              generation !== panelRequestGeneration ||
              screen.activePanel() !== requestedFromPanel
            ) return;
            if (snapshot === undefined) screen.println('No diff data for this session.', 'warning');
            else {
              activeDiffScope = scope;
              screen.openDiffViewer(snapshot);
            }
            return;
          }
          case 'permissions':
            formatPermissionSnapshot(await workspace.workspaceSnapshot())
              .forEach((line) => screen.println(line, 'muted'));
            return;
          default:
            return;
        }
      } catch (error) {
        screen.println(`${command.cmd} failed · ${sanitizeTerminalError(error)}`, 'danger');
      }
    };

    /** null = clear command text; string = replace composer with returned draft. */
    const runCommand = (command: SlashCommand): string | null => {
      switch (command.cmd) {
        case 'quit':
          void shutdown(0);
          return null;
        case 'abort':
          if (interactionCanAbort(session.interactionState())) session.abort();
          else screen.println('No active run to abort.', 'warning');
          return null;
        case 'help':
          for (const line of renderInteractiveHelp()) screen.println(line, 'muted');
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
        case 'insert_mode':
          return beginInsertModePicker();
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
        case 'sessions':
        case 'resume':
        case 'switch':
        case 'new':
        case 'rename':
        case 'archive':
        case 'compact':
        case 'fork':
        case 'retry':
        case 'review':
        case 'diff':
        case 'permissions':
          void runWorkspaceCommand(command);
          return paletteReturnDraft ?? null;
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
              if (interactionEnterState(session.interactionState()) === 'running') {
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

    function submit(): void {
      if (closing || approvalQueue.length > 0) return;
      const raw = screen.getInput();
      if (insertModePickerActive) {
        screen.markInteracted();
        const mode = selectInsertModeChoice(raw);
        if (mode === undefined) {
          screen.println('choose steering or following', 'warning');
          return;
        }
        insertMode = mode;
        screen.setInsertMode(mode);
        finishInsertModePicker();
        screen.println(`Insert mode: ${mode}.`, 'success');
        return;
      }
      if (providerController?.active === true) {
        screen.markInteracted();
        screen.clearInput();
        void providerController.submit(raw);
        return;
      }
      const action = decideEnter(
        interactionEnterState(session.interactionState()),
        insertMode,
        raw,
      );
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
      submit();
    });

    const consume = (key: KeyEvent): void => {
      key.preventDefault();
      key.stopPropagation();
    };

    const handlePendingApprovalKey = (key: KeyEvent): boolean => {
      if (approvalQueue.length === 0 || approval === undefined) return false;
      const approvalAction = screen.handleApprovalPanelKey(key);
      if (approvalAction.kind === 'handled') {
        consume(key);
        return true;
      }
      const decision = approvalAction.kind === 'decision'
        ? approvalAction.decision
        : undefined;
      if (decision === 'abort') {
        consume(key);
        clearApprovalQueue();
        session.abort();
        screen.resolveApproval();
        return true;
      }
      if (decision !== undefined) {
        consume(key);
        const id = approvalQueue[0];
        const request = id === undefined ? undefined : approvalEvents.get(id);
        if (request === undefined) return true;
        if (decision === 'allow_always' && !approvalAllowsAlways(request.payload.presentation)) {
          screen.println('Allow always is unavailable because Runtime provided no frozen scope.', 'warning');
          return true;
        }
        approvalQueue.shift();
        if (id !== undefined) {
          approvalEvents.delete(id);
          approval.resolveApproval(id, decision);
        }
        if (approvalQueue.length === 0) screen.resolveApproval();
        else renderCurrentApproval();
        return true;
      }
      // 审批中其余键（含所有修饰键组合）全部冻结，不能编辑 prompt 或背景 panel。
      consume(key);
      return true;
    };

    const onKeyPress = (key: KeyEvent): void => {
      if (closing) return;
      if (editing) {
        consume(key);
        return;
      }
      if (handlePendingApprovalKey(key)) return;
      const sessionPickerAction = screen.handleSessionPickerKey(key);
      if (sessionPickerAction.kind !== 'none') {
        consume(key);
        if (sessionPickerAction.kind === 'select' && opts.workspace !== undefined) {
          void transitionPresentation(
            () => opts.workspace?.switchSession(sessionPickerAction.threadId) ?? Promise.resolve(),
          ).catch((error: unknown) => {
            screen.println(`switch failed · ${sanitizeTerminalError(error)}`, 'danger');
          });
        }
        return;
      }
      const diffAction = screen.handleDiffViewerKey(key);
      if (diffAction !== 'none') {
        consume(key);
        if (diffAction === 'toggle-scope' && opts.workspace !== undefined) {
          const generation = ++panelRequestGeneration;
          const next = activeDiffScope === 'turn' ? 'workspace' : 'turn';
          void opts.workspace.diffSnapshot(next).then((snapshot) => {
            if (
              generation !== panelRequestGeneration ||
              screen.activePanel() !== 'diff'
            ) return;
            if (snapshot === undefined) {
              screen.println(`No ${next} diff data.`, 'warning');
              return;
            }
            activeDiffScope = next;
            screen.openDiffViewer(snapshot);
          }).catch((error: unknown) => {
            screen.println(`diff failed · ${sanitizeTerminalError(error)}`, 'danger');
          });
        }
        return;
      }
      const isEnter = key.name === 'return' || key.name === 'enter' || key.name === 'kpenter';
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

      if (key.name === 'escape' && providerController?.active === true) {
        providerController.back();
        consume(key);
        return;
      }

      if (key.name === 'escape' && insertModePickerActive) {
        cancelInsertModePicker();
        consume(key);
        return;
      }

      if (key.name === 'escape' && paletteReturnDraft !== undefined) {
        const draft = paletteReturnDraft;
        paletteReturnDraft = undefined;
        screen.setInput(draft);
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
        submit();
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
        if (screen.getInput() === '' && session.interactionState() === 'idle') void shutdown(0);
        return;
      }
      if (key.name === 'escape') {
        consume(key);
        if (interactionCanAbort(session.interactionState())) {
          session.abort();
          screen.setTransientStatus('aborting…');
        }
      }
    };

    const onPaste = (event: PasteEvent): void => {
      if (closing || approvalQueue.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
    };

    const unsubSession = session.subscribe((event) => {
      try {
        if (event.type === 'control_request' && event.kind === 'approval') {
          if (!enqueueApproval(event)) return;
          if (approvalQueue.length === 1) renderCurrentApproval();
        } else {
          screen.render(event);
        }
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
    const unsubPendingApprovals = opts.workspace?.subscribePendingApprovals((snapshot) => {
      if (snapshot.threadId !== opts.workspace?.currentThreadId || closing) return;
      try {
        replaceApprovalQueue(snapshot.approvals);
      } catch (error) {
        screen.println(
          `TUI approval sync failed · ${error instanceof Error ? error.message : String(error)}`,
          'danger',
        );
        void shutdown(1, true);
      }
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
      unsubPendingApprovals?.();
      unsubAttached?.();
      clearApprovalQueue();
    };

    let screenStopped = false;
    const stopScreen = (): void => {
      if (screenStopped) return;
      screenStopped = true;
      screen.destroy();
    };

    async function shutdown(code: number, forceAbort = false): Promise<void> {
      if (closing) return;
      closing = true;
      cleanup();
      try {
        if (forceAbort || interactionCanAbort(session.interactionState())) {
          session.abort();
        }
        await providerController?.close();
        await session.close();
        if (editing) renderer.resume?.();
        // Working 动画持有 live-render 引用；cleanup 已退订 agent_end，必须在 idle 前释放。
        stopScreen();
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
        stopScreen();
        renderer.destroy();
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

function formatElapsed(milliseconds: number): string {
  return milliseconds < 1_000
    ? `${Math.max(0, milliseconds)}ms`
    : `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
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
