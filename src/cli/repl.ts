// 交互 REPL(规格见 docs/09-cli.md §3):readline raw keypress + escapeCodeTimeout 50ms。
// 分工:repl 管键位与输入行状态,渲染(输入行/状态提示/转录)全部经 Renderer——
// stdout 单写入者纪律(docs/09 §1.3)。可测部分(历史环、斜杠命令、双击消歧、Enter 分派)
// 拆为纯函数/纯类导出,由 repl.test.ts 覆盖;关键键位接线使用伪 TTY 发送
// keypress 事件作 characterization，真实 PTY 退出/恢复仍由 e2e 覆盖。
//
// 人工冒烟清单(docs/09 §9 前四条,发布前真实终端过一遍):
// [ ] 流式输出期间打字,输入行内容不被 delta 冲花;Enter 后徽标出现 steer 1,
//     转录区在下个 turn 边界出现 » steering: 回显
// [ ] Esc 在 50ms 消歧下:方向键不触发 abort;流式中裸 Esc 一次即 abort,
//     assistant 消息以 [aborted] 收尾
// [ ] Alt+Enter 与 /f 前缀均能入 follow-up 队列(至少各在一种终端验证)
// [ ] coda --continue 重放转录后,新输入接在原上下文继续
// [ ] (M6)bash 调用弹出审批提示行,y 放行 / n 拒绝后任务继续,期间普通字符不进输入行;
//     审批中 Esc 一次即整体中止(assistant 以 [aborted] 收尾),决议后键位恢复正常

import * as readline from 'node:readline';
import process from 'node:process';
import { isThreadId, isTurnId } from '../protocol/index.js';
import type { QueuedMessage } from '../protocol/index.js';
import type {
  CliApprovalDecision as ApprovalDecision,
  CliInteractionState as SessionInteractionState,
  CliSessionEvent as SessionEvent,
  CliSessionUsage as SessionUsage,
} from './frontend-types.js';
import type {
  CliSession,
  InteractiveSession,
} from './interactive-runtime.js';
import type {
  PendingApprovalView,
  RuntimeWorkspaceActions,
} from './runtime-frontend.js';
import { ProviderCommandController } from './provider-commands.js';
import type { ProviderRegistry } from './provider-registry.js';
import {
  collectDoctorReport,
  formatAuthStatusLines,
  formatDoctorReportLines,
} from './product-commands.js';
import type { Renderer } from './renderer.js';
import { sanitizeTerminalError, sanitizeTerminalText } from './terminal-sanitize.js';
import {
  applyWorkspaceCompletion,
  copyTextToClipboard,
  editDraftWithExternalEditor,
  exportTranscript,
  latestAssistantText,
  MessageTranscriptSearch,
  promptHistoryEntries,
  runThreadPresentationTransition,
  transcriptContent,
  workspaceCompletionAtCursor,
  workspacePathCandidates,
} from './presentation-actions.js';
import {
  persistableDraft,
  type ThreadPresentationStore,
} from './presentation-state.js';
import {
  findSlashCommand,
  renderInteractiveHelp,
} from './command-catalog.js';
import {
  approvalAllowsAlways,
  filterSessionItems,
  formatApprovalPresentation,
  formatDiffSnapshot,
  formatPermissionSnapshot,
  formatReviewSnapshot,
  formatSessionItems,
} from './review-format.js';
export { SLASH_COMMAND_SPECS } from './command-catalog.js';
export type { SlashCommandSpec } from './command-catalog.js';

export const ESC_TIMEOUT_MS = 50; // Esc 消歧窗口(docs/09 §3.2)
export const ESC_EXIT_WINDOW_MS = 500; // 双 Esc 退出窗口
export const CTRL_C_EXIT_WINDOW_MS = 1500; // 双 Ctrl+C 退出窗口

/** retrying 的 Enter 仍是 steering；compacting 的 prompt 交给 Session 暂存。 */
export function interactionEnterState(
  state: SessionInteractionState,
): 'idle' | 'running' {
  return state === 'running' || state === 'retrying' ? 'running' : 'idle';
}

export function interactionCanAbort(state: SessionInteractionState): boolean {
  return state !== 'idle';
}

// ---- 纯逻辑:斜杠命令 ----

export type SlashCommand =
  | {
      cmd:
        | 'quit'
        | 'abort'
        | 'queue'
        | 'status'
        | 'doctor'
        | 'auth_status'
        | 'help'
        | 'login'
        | 'model'
        | 'logout'
        | 'edit'
        | 'restore'
        | 'search_next'
        | 'search_previous'
        | 'latest'
        | 'review'
        | 'permissions'
        | 'compact'
        | 'new';
    }
  | { cmd: 'follow_up'; text: string }
  | { cmd: 'history_search'; query: string }
  | { cmd: 'stash'; text: string }
  | { cmd: 'file_complete'; query: string }
  | { cmd: 'transcript_search'; query: string }
  | { cmd: 'copy'; mode: string }
  | { cmd: 'export'; mode: string; path: string }
  | { cmd: 'vim'; mode: string }
  | { cmd: 'draft'; action: string }
  | { cmd: 'diff'; scope: string }
  | { cmd: 'retry' | 'fork'; turnId: string }
  | { cmd: 'sessions'; query: string }
  | { cmd: 'resume' | 'switch'; threadId: string }
  | { cmd: 'rename'; title: string }
  | { cmd: 'archive'; mode: string }
  | { cmd: 'unknown'; input: string };

/** 非斜杠输入返回 undefined。空闲命令表:/quit /queue /status /help;/f|/followup 随时合法。 */
export function parseSlashCommand(text: string): SlashCommand | undefined {
  if (!text.startsWith('/')) return undefined;
  const space = text.indexOf(' ');
  const head = (space === -1 ? text.slice(1) : text.slice(1, space)).toLowerCase();
  const rest = space === -1 ? '' : text.slice(space + 1).trim();
  switch (findSlashCommand(head)?.actionId) {
    case 'app.quit':
      return { cmd: 'quit' };
    case 'task.queue':
      return { cmd: 'queue' };
    case 'task.status':
      return { cmd: 'status' };
    case 'doctor.run':
      return { cmd: 'doctor' };
    case 'auth.status':
      return { cmd: 'auth_status' };
    case 'help.show':
      return { cmd: 'help' };
    case 'auth.login':
      return { cmd: 'login' };
    case 'models.list':
      return { cmd: 'model' };
    case 'auth.logout':
      return { cmd: 'logout' };
    case 'task.follow-up':
      return { cmd: 'follow_up', text: rest };
    case 'task.abort':
      return { cmd: 'abort' };
    case 'history.search':
      return { cmd: 'history_search', query: rest };
    case 'draft.edit':
      return { cmd: 'edit' };
    case 'draft.files':
      return { cmd: 'file_complete', query: rest };
    case 'draft.stash':
      return { cmd: 'stash', text: rest };
    case 'draft.restore':
      return { cmd: 'restore' };
    case 'settings.vim':
      return { cmd: 'vim', mode: rest.toLocaleLowerCase('en-US') };
    case 'draft.manage':
      return { cmd: 'draft', action: rest.toLocaleLowerCase('en-US') };
    case 'transcript.search':
      return { cmd: 'transcript_search', query: rest };
    case 'transcript.next':
      return { cmd: 'search_next' };
    case 'transcript.previous':
      return { cmd: 'search_previous' };
    case 'transcript.latest':
      return { cmd: 'latest' };
    case 'review.diff':
      return { cmd: 'diff', scope: rest.toLocaleLowerCase('en-US') };
    case 'review.inspect':
      return { cmd: 'review' };
    case 'review.permissions':
      return { cmd: 'permissions' };
    case 'conversation.compact':
      return { cmd: 'compact' };
    case 'conversation.retry':
      return { cmd: 'retry', turnId: rest };
    case 'conversation.fork':
      return { cmd: 'fork', turnId: rest };
    case 'session.new':
      return { cmd: 'new' };
    case 'session.list':
      return { cmd: 'sessions', query: rest };
    case 'session.resume':
      return { cmd: 'resume', threadId: rest };
    case 'session.switch':
      return { cmd: 'switch', threadId: rest };
    case 'session.rename':
      return { cmd: 'rename', title: rest };
    case 'session.archive':
      return { cmd: 'archive', mode: rest.toLocaleLowerCase('en-US') };
    case 'content.copy':
      return { cmd: 'copy', mode: rest.toLocaleLowerCase('en-US') };
    case 'content.export': {
      const firstSpace = rest.indexOf(' ');
      const first = (firstSpace < 0 ? rest : rest.slice(0, firstSpace))
        .toLocaleLowerCase('en-US');
      if (first === 'text' || first === 'raw' || first === 'latest') {
        return {
          cmd: 'export',
          mode: first,
          path: firstSpace < 0 ? '' : rest.slice(firstSpace + 1).trim(),
        };
      }
      return { cmd: 'export', mode: 'text', path: rest };
    }
    default:
      return { cmd: 'unknown', input: text };
  }
}

// ---- 纯逻辑:Enter 分派(docs/09 §3 键位表的可测内核)----

export type EnterAction =
  | { kind: 'none' }
  | { kind: 'prompt'; text: string }
  | { kind: 'steer'; text: string }
  | { kind: 'follow_up'; text: string }
  | { kind: 'command'; command: SlashCommand };

/**
 * 空闲 Enter=prompt、运行中 Enter=steer、Alt+Enter=followUp;
 * 流式中 /f <text> 兜底 follow-up(docs/09 §3.2),其余斜杠命令仅空闲时生效——
 * 运行中输入 /status 等按普通文本 steer(键位表没有含糊地带)。
 */
export function decideEnter(state: 'idle' | 'running', meta: boolean, raw: string): EnterAction {
  const text = raw.trim();
  if (text === '') return { kind: 'none' };
  if (meta) return { kind: 'follow_up', text };
  const slash = parseSlashCommand(text);
  if (slash !== undefined && slash.cmd === 'follow_up') {
    return slash.text === '' ? { kind: 'none' } : { kind: 'follow_up', text: slash.text };
  }
  if (
    slash !== undefined &&
    (slash.cmd === 'login' || slash.cmd === 'model' || slash.cmd === 'logout')
  ) {
    return { kind: 'command', command: slash };
  }
  const slashName = text.startsWith('/')
    ? text.slice(1).split(/\s/u, 1)[0]?.toLocaleLowerCase('en-US')
    : undefined;
  if (
    state === 'running' &&
    slash !== undefined &&
    slashName !== undefined &&
    findSlashCommand(slashName)?.availableWhileRunning === true
  ) {
    return { kind: 'command', command: slash };
  }
  if (state === 'running') return { kind: 'steer', text };
  if (slash !== undefined) return { kind: 'command', command: slash };
  return { kind: 'prompt', text };
}

// ---- 纯逻辑:审批模式键位映射(M6,docs/09 §4)----

/**
 * 审批模式键位:y=allow_once / a=allow_always / n=deny / Esc=abort;其余键无审批动作。
 * Esc 在审批模式的语义 = 决议 abort(session.abort() → policy.onAbort(),时序纪律 R7),
 * 由调用侧执行——本函数只做映射,保持可测。
 */
export function approvalKeyDecision(keyName: string): ApprovalDecision | undefined {
  switch (keyName) {
    case 'y':
      return 'allow_once';
    case 'a':
      return 'allow_always';
    case 'n':
      return 'deny';
    case 'escape':
      return 'abort';
    default:
      return undefined;
  }
}

/**
 * 审批接线(main.ts 装配;结构同 headless 的 HeadlessApproval):broker 决议入口 +
 * approval_request 旁路订阅。preflight 串行(docs/05 §5)保证同一时刻至多一个 pending,
 * 队列只是防御形态。
 */
export interface ReplApproval {
  broker?: { resolve: (approvalId: string, decision: ApprovalDecision) => void };
  /** 调用纪律(R7):必须在 session.abort() 之后。 */
  onAbort: () => void;
  subscribe: (listener: (e: SessionEvent) => void) => () => void;
}

export interface ReplInput extends NodeJS.ReadableStream {
  readonly isTTY?: boolean;
  setRawMode(enabled: boolean): void;
}

export interface ReplOptions {
  /** 注入仅用于测试；生产默认 process.stdin。 */
  stdin?: ReplInput;
  /** stdout 等外部致命边界失败时，由 REPL 自己完成 abort、TTY 清理并 exit 1。 */
  fatalSignal?: AbortSignal;
  version?: string;
  providerCommands?: {
    registry: ProviderRegistry;
    runtime: InteractiveSession;
  };
  workspace?: RuntimeWorkspaceActions;
  presentation?: {
    readonly store: ThreadPresentationStore;
    readonly cwd: string;
    readonly editDraft?: (draft: string) => Promise<string>;
    readonly copyText?: (text: string) => Promise<void>;
  };
}

// ---- 纯逻辑:本会话输入历史(↑/↓)----

export class InputHistory {
  #items: string[] = [];
  #index = 0; // === items.length 表示「草稿位」
  #draft = '';
  #searchQuery: string | undefined;
  #searchIndex = 0;

  push(text: string): void {
    if (text.trim() === '') return;
    if (this.#items[this.#items.length - 1] !== text) this.#items.push(text);
    this.#index = this.#items.length;
    this.#draft = '';
    this.resetSearch();
  }

  /** Replace one thread's history projection without retaining entries from the prior thread. */
  replace(entries: readonly string[]): void {
    this.#items = [];
    for (const entry of entries) {
      if (entry.trim() === '') continue;
      if (this.#items[this.#items.length - 1] !== entry) this.#items.push(entry);
    }
    this.#index = this.#items.length;
    this.#draft = '';
    this.resetSearch();
  }

  /** ↑:首次上翻保存当前草稿;到顶后停在最旧一条。 */
  up(current: string): string {
    this.resetSearch();
    if (this.#items.length === 0) return current;
    if (this.#index === this.#items.length) this.#draft = current;
    if (this.#index > 0) this.#index--;
    return this.#items[this.#index] ?? current;
  }

  /** ↓:翻回草稿位时还原草稿。 */
  down(): string {
    this.resetSearch();
    if (this.#index < this.#items.length) this.#index++;
    if (this.#index === this.#items.length) return this.#draft;
    return this.#items[this.#index] ?? this.#draft;
  }

  /** Ctrl+R: repeated calls with the same query walk older matching entries. */
  reverseSearch(query: string): string | undefined {
    if (query !== this.#searchQuery) {
      this.#searchQuery = query;
      this.#searchIndex = this.#items.length;
    }
    for (let index = this.#searchIndex - 1; index >= 0; index--) {
      const candidate = this.#items[index];
      if (candidate?.toLocaleLowerCase('en-US').includes(
        query.toLocaleLowerCase('en-US'),
      ) !== true) {
        continue;
      }
      this.#searchIndex = index;
      return candidate;
    }
    return undefined;
  }

  resetSearch(): void {
    this.#searchQuery = undefined;
    this.#searchIndex = this.#items.length;
  }
}

const INPUT_SEGMENTER = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('en', { granularity: 'grapheme' })
  : undefined;

export function previousGraphemeBoundary(text: string, cursor: number): number {
  const boundaries = inputBoundaries(text);
  let previous = 0;
  for (const boundary of boundaries) {
    if (boundary >= cursor) return previous;
    previous = boundary;
  }
  return previous;
}

export function nextGraphemeBoundary(text: string, cursor: number): number {
  return inputBoundaries(text).find((boundary) => boundary > cursor) ?? text.length;
}

export function moveMultilineCursor(text: string, cursor: number, direction: -1 | 1): number {
  const lineStart = text.lastIndexOf('\n', Math.max(0, cursor - 1)) + 1;
  const lineEndIndex = text.indexOf('\n', cursor);
  const lineEnd = lineEndIndex === -1 ? text.length : lineEndIndex;
  const column = inputBoundaries(text.slice(lineStart, cursor)).length - 1;
  if (direction < 0) {
    if (lineStart === 0) return cursor;
    const previousEnd = lineStart - 1;
    const previousStart = text.lastIndexOf('\n', Math.max(0, previousEnd - 1)) + 1;
    return boundaryAtColumn(text, previousStart, previousEnd, column);
  }
  if (lineEnd === text.length) return cursor;
  const nextStart = lineEnd + 1;
  const nextEndIndex = text.indexOf('\n', nextStart);
  const nextEnd = nextEndIndex === -1 ? text.length : nextEndIndex;
  return boundaryAtColumn(text, nextStart, nextEnd, column);
}

function inputBoundaries(text: string): number[] {
  if (INPUT_SEGMENTER === undefined) {
    const boundaries = [0];
    let offset = 0;
    for (const item of text) {
      offset += item.length;
      boundaries.push(offset);
    }
    return boundaries;
  }
  const boundaries = [...INPUT_SEGMENTER.segment(text)].map((item) => item.index);
  if (boundaries[0] !== 0) boundaries.unshift(0);
  if (boundaries.at(-1) !== text.length) boundaries.push(text.length);
  return boundaries;
}

function boundaryAtColumn(
  text: string,
  start: number,
  end: number,
  column: number,
): number {
  const local = inputBoundaries(text.slice(start, end));
  return start + (local[Math.min(column, local.length - 1)] ?? 0);
}

// ---- 纯逻辑:双击消歧(Esc Esc / Ctrl+C Ctrl+C,时钟注入可测)----

export class DoublePress {
  #last = Number.NEGATIVE_INFINITY;
  constructor(private readonly windowMs: number) {}

  /** 返回 true 表示窗口内第二击(触发后归零,三连击不会连发)。 */
  hit(now: number): boolean {
    const isDouble = now - this.#last <= this.windowMs;
    this.#last = isDouble ? Number.NEGATIVE_INFINITY : now;
    return isDouble;
  }

  reset(): void {
    this.#last = Number.NEGATIVE_INFINITY;
  }
}

// ---- 纯逻辑:/status /queue 的输出格式 ----

export function formatStatusLines(usage: SessionUsage, model?: string): string[] {
  const c = usage.cumulative;
  const lines: string[] = [];
  if (model !== undefined) lines.push(`model: ${model}`);
  lines.push(`turns: ${usage.turns}`);
  let tok = `tokens: ${c.input} in / ${c.output} out`;
  if (c.reasoning !== undefined) tok += ` (${c.reasoning} reasoning)`;
  if (c.cacheRead !== undefined) tok += ` (${c.cacheRead} cache read)`;
  lines.push(tok);
  if (c.costUSD !== undefined) lines.push(`cost: $${c.costUSD.toFixed(4)}`);
  if (usage.lastTurn !== undefined) {
    lines.push(`last turn: ${usage.lastTurn.input} in / ${usage.lastTurn.output} out`);
  }
  return lines;
}

export function formatQueueLines(
  steering: readonly QueuedMessage[],
  followUp: readonly QueuedMessage[],
): string[] {
  if (steering.length === 0 && followUp.length === 0) return ['queues empty'];
  const lines: string[] = [];
  const block = (label: string, items: readonly QueuedMessage[]): void => {
    if (items.length === 0) return;
    lines.push(`${label} (${items.length}):`);
    items.forEach((m, i) => {
      const text = m.text.length > 60 ? `${m.text.slice(0, 60)}…` : m.text;
      lines.push(`  ${i + 1}. ${text}`);
    });
  };
  block('steering', steering);
  block('follow-up', followUp);
  return lines;
}

function formatModelRef(
  model: { provider: string; model: string } | undefined,
): string {
  return model === undefined
    ? 'no model selected'
    : `${model.provider}/${model.model}`;
}

// ---- REPL 主体 ----

export async function startRepl(
  session: CliSession,
  renderer: Renderer,
  approval?: ReplApproval,
  opts: ReplOptions = {},
): Promise<number> {
  const stdin: ReplInput = opts.stdin ?? process.stdin;
  let input = '';
  let cursor = 0;
  type ApprovalRequestEvent = Extract<SessionEvent, { type: 'approval_request' }>;
  const approvalQueue: string[] = []; // pending approvalId FIFO(非空 = 审批键位模式)
  const approvalEvents = new Map<string, ApprovalRequestEvent>();
  const history = new InputHistory();
  history.replace(promptHistoryEntries(session.messages));
  const escExit = new DoublePress(ESC_EXIT_WINDOW_MS);
  const ctrlCExit = new DoublePress(CTRL_C_EXIT_WINDOW_MS);
  let lastQueues: { steering: QueuedMessage[]; followUp: QueuedMessage[] } = {
    steering: [],
    followUp: [],
  };
  let pasting = false;
  let statusShown = false;
  let closing = false;
  let editing = false;
  let vimEnabled = opts.presentation?.store.snapshot().vimEnabled ?? false;
  let vimInsertMode = !vimEnabled;
  let paletteReturnDraft: string | undefined;
  let latestPromptDraft = opts.presentation?.store.snapshot().draft ?? '';
  let providerTaskDraft: string | undefined;
  let providerInputActive = false;
  let providerBeginning = false;
  let reverseSearchQuery: string | undefined;
  const transcriptSearch = new MessageTranscriptSearch(() => session.messages);
  const enqueueApproval = (event: ApprovalRequestEvent): boolean => {
    if (approvalEvents.has(event.approvalId)) return false;
    approvalEvents.set(event.approvalId, event);
    approvalQueue.push(event.approvalId);
    return true;
  };

  return await new Promise<number>((resolve) => {
    let secretInput = false;
    const renderInput = (): void => {
      if (secretInput) {
        const total = inputBoundaries(input).length - 1;
        const maskedCursor = inputBoundaries(input.slice(0, cursor)).length - 1;
        renderer.setInputLine?.('•'.repeat(total), maskedCursor);
      } else {
        renderer.setInputLine?.(input, cursor);
      }
    };
    const persistInput = (): void => {
      if (
        secretInput ||
        providerInputActive ||
        opts.presentation === undefined ||
        input.startsWith('/')
      ) return;
      latestPromptDraft = input;
      opts.presentation.store.setDraft(persistableDraft(input));
    };
    const setInput = (
      text: string,
      cur = text.length,
      persist = true,
    ): void => {
      input = text;
      cursor = cur;
      renderInput();
      if (persist) persistInput();
    };

    const setStatusHint = (text: string): void => {
      statusShown = true;
      renderer.setStatus?.(text);
    };
    const clearStatusHint = (): void => {
      if (!statusShown) return;
      statusShown = false;
      renderer.setStatus?.(undefined);
    };

    const renderCurrentApproval = (): void => {
      const approvalId = approvalQueue[0];
      const event = approvalId === undefined ? undefined : approvalEvents.get(approvalId);
      renderer.setApprovalRequest?.(event === undefined
        ? undefined
        : {
            description: event.description,
            allowAlways: approvalAllowsAlways(
              opts.workspace?.approvalPresentation(event.approvalId),
            ),
          });
    };
    const clearApprovalQueue = (): void => {
      approvalQueue.length = 0;
      approvalEvents.clear();
      renderCurrentApproval();
    };
    const replaceApprovalQueue = (
      requests: readonly PendingApprovalView[],
    ): readonly PendingApprovalView[] => {
      const previousHead = approvalQueue[0];
      const known = new Set(approvalEvents.keys());
      approvalQueue.length = 0;
      approvalEvents.clear();
      for (const request of requests) {
        enqueueApproval({
          type: 'approval_request',
          approvalId: request.approvalId,
          toolCallId: request.toolCallId,
          description: request.description,
        });
      }
      if (previousHead !== approvalQueue[0]) renderCurrentApproval();
      return requests.filter((request) => !known.has(request.approvalId));
    };
    const renderRecoveredApprovals = (requests: readonly PendingApprovalView[]): void => {
      for (const request of requests) {
        renderer.render({
          type: 'approval_request',
          approvalId: request.approvalId,
          toolCallId: request.toolCallId,
          description: request.description,
        });
        formatApprovalPresentation(
          opts.workspace?.approvalPresentation(request.approvalId),
          request.description,
        ).forEach((line) => renderer.println?.(line));
      }
      renderCurrentApproval();
    };

    if (opts.workspace !== undefined) {
      renderRecoveredApprovals(replaceApprovalQueue(opts.workspace.pendingApprovals()));
    }

    const canAbort = (): boolean => interactionCanAbort(session.interactionState());

    const restoreProviderTaskDraft = (): string => {
      const draft = providerTaskDraft ?? latestPromptDraft;
      providerTaskDraft = undefined;
      providerInputActive = false;
      latestPromptDraft = draft;
      if (!closing) setInput(draft);
      return draft;
    };

    const providerController =
      opts.providerCommands === undefined
        ? undefined
        : new ProviderCommandController(
            opts.providerCommands.registry,
            opts.providerCommands.runtime,
            {
              println: (text) => {
                renderer.println?.(text);
              },
              setCommandPrompt: (prompt, secret, choices) => {
                // Esc 离开秘密步骤时 controller 会先切换 prompt；必须在撤下掩码前
                // 清掉真实输入，否则 renderInput() 会把 key 短暂交给 renderer。
                if (secretInput && !secret) {
                  input = '';
                  cursor = 0;
                }
                secretInput = secret;
                if (prompt !== undefined) {
                  input = '';
                  cursor = 0;
                }
                if (choices !== undefined) {
                  choices.forEach((choice, index) => {
                    renderer.println?.(
                      `  ${index + 1}. ${choice.label}` +
                        (choice.description === undefined
                          ? ''
                          : ` · ${choice.description}`),
                    );
                  });
                }
                renderer.setStatus?.(
                  prompt === undefined || choices === undefined
                    ? prompt
                    : `${prompt} · 输入编号或名称`,
                );
                renderInput();
                if (prompt === undefined && !providerBeginning) {
                  restoreProviderTaskDraft();
                }
              },
              setModel: () => {
                // classic /status 每次从 runtime 读取；无需维护第二份模型状态。
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

    const unsub = session.subscribe((e) => {
      if (e.type === 'queue_update') {
        lastQueues = { steering: [...e.steering], followUp: [...e.followUp] };
      } else if (e.type === 'approval_request') {
        // Runtime projects canonical control_request through the primary event stream. Direct
        // Session keeps the legacy broker side channel below; id de-duplication supports both.
        if (enqueueApproval(e)) {
          formatApprovalPresentation(
            opts.workspace?.approvalPresentation(e.approvalId),
            e.description,
          ).forEach((line) => renderer.println?.(line));
        }
        renderCurrentApproval();
      } else if (e.type === 'error' && e.fatal) {
        void shutdown(1); // 致命错误进入退出流程(docs/09 §4)
      }
    });
    // 审批旁路通道:approval_request 入队即切审批键位(渲染提示由 renderer 的
    // approval_request 分支负责——main.ts 已把同一通道接到 renderer.render)。
    const unsubApproval = approval?.subscribe((e) => {
      if (e.type === 'approval_request') {
        enqueueApproval(e);
        renderCurrentApproval();
      }
    });
    const unsubPendingApprovals = opts.workspace?.subscribePendingApprovals((snapshot) => {
      if (snapshot.threadId !== opts.workspace?.currentThreadId || closing) return;
      const recovered = replaceApprovalQueue(snapshot.approvals);
      renderRecoveredApprovals(recovered);
    });
    const unsubAttached = opts.providerCommands?.runtime.subscribeSessionAttached(
      (messages) => {
        if (messages.length > 0) renderer.replayTranscript(messages);
      },
    );

    const onResize = (): void => {
      renderer.redraw?.();
    };
    const onSignal = (): void => {
      void shutdown(0);
    };

    const cleanup = (): void => {
      stdin.removeListener('keypress', onKeypress);
      process.removeListener('SIGWINCH', onResize);
      process.removeListener('SIGTERM', onSignal);
      opts.fatalSignal?.removeEventListener('abort', onFatalSignal);
      unsub();
      unsubApproval?.();
      unsubPendingApprovals?.();
      unsubAttached?.();
      clearApprovalQueue();
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      renderer.unmount?.();
    };

    /** 退出前:流式中先 abort,session.close() = waitForIdle + flush 落盘(docs/09 §3)。 */
    const shutdown = async (code: number, forceAbort = false): Promise<void> => {
      if (closing) return;
      closing = true;
      try {
        if (forceAbort || canAbort()) {
          session.abort();
          // R7 时序:abort 在前;pending 审批以 'abort' 决议,否则 waitForIdle 挂死
          clearApprovalQueue();
          approval?.onAbort();
        }
        await providerController?.close();
        await session.close();
      } catch (err) {
        code = 1;
        console.error(`[coda] REPL shutdown failed: ${sanitizeTerminalError(err)}`);
      } finally {
        cleanup();
        try {
          opts.presentation?.store.dispose();
        } catch (error) {
          code = 1;
          console.error(`[coda] REPL presentation save failed: ${sanitizeTerminalError(error)}`);
        }
        resolve(code);
      }
    };

    const onFatalSignal = (): void => {
      void shutdown(1, true);
    };

    const printErr = (err: unknown): void => {
      renderer.println?.(`prompt failed: ${err instanceof Error ? err.message : String(err)}`);
    };
    const printSearchMatch = (
      match: ReturnType<MessageTranscriptSearch['move']>,
    ): void => {
      if (match === undefined) {
        renderer.println?.('No transcript matches. Start with /search <query>.');
        return;
      }
      renderer.println?.(
        `match ${match.ordinal + 1}/${match.total} · ${match.label} · ${match.snippet}`,
      );
      opts.presentation?.store.setSearch({
        query: transcriptSearch.query,
        matchOrdinal: match.ordinal,
      });
    };

    const editComposerDraft = async (draft: string): Promise<void> => {
      if (opts.presentation === undefined || editing) {
        if (opts.presentation === undefined) {
          renderer.println?.('/edit is unavailable without presentation storage.');
        }
        return;
      }
      editing = true;
      clearStatusHint();
      renderer.setStatus?.('editing draft in $EDITOR…');
      stdin.removeListener('keypress', onKeypress);
      if (stdin.isTTY) stdin.setRawMode(false);
      try {
        const edited = await (
          opts.presentation.editDraft?.(draft) ??
          editDraftWithExternalEditor(draft, { cwd: opts.presentation.cwd })
        );
        if (!closing) {
          setInput(edited);
          renderer.println?.('Draft returned from $EDITOR.');
        }
      } catch (error) {
        if (!closing) {
          setInput(draft);
          renderer.println?.(`editor failed: ${sanitizeTerminalError(error)}`);
        }
      } finally {
        renderer.setStatus?.(undefined);
        if (!closing) {
          if (stdin.isTTY) stdin.setRawMode(true);
          stdin.on('keypress', onKeypress);
        }
        editing = false;
      }
    };

    const copyTranscript = async (mode: string): Promise<void> => {
      const normalized = mode === '' ? 'latest' : mode;
      if (normalized !== 'latest' && normalized !== 'raw') {
        renderer.println?.('usage: /copy [latest|raw]');
        return;
      }
      const content = transcriptContent(session.messages, normalized);
      if (content === '') {
        renderer.println?.('Nothing to copy.');
        return;
      }
      try {
        await (opts.presentation?.copyText?.(content) ?? copyTextToClipboard(content));
        renderer.println?.(
          normalized === 'raw' ? 'Raw transcript copied.' : 'Latest response copied.',
        );
      } catch (error) {
        renderer.println?.(`copy failed: ${sanitizeTerminalError(error)}`);
      }
    };

    const switchPresentation = (): string => {
      const workspace = opts.workspace;
      if (workspace === undefined) return latestPromptDraft;
      const state = opts.presentation?.store.switchToThread(workspace.currentThreadId);
      history.replace(promptHistoryEntries(session.messages));
      clearApprovalQueue();
      latestPromptDraft = state?.draft ?? '';
      setInput(latestPromptDraft);
      renderer.println?.(`— switched to ${workspace.currentThreadId} —`);
      for (const request of workspace.pendingApprovals()) {
        enqueueApproval({
          type: 'approval_request',
          approvalId: request.approvalId,
          toolCallId: request.toolCallId,
          description: request.description,
        });
        renderer.render({
          type: 'approval_request',
          approvalId: request.approvalId,
          toolCallId: request.toolCallId,
          description: request.description,
        });
        renderer.setApprovalAllowsAlways?.(approvalAllowsAlways(
          workspace.approvalPresentation(request.approvalId),
        ));
        formatApprovalPresentation(
          workspace.approvalPresentation(request.approvalId),
          request.description,
        ).forEach((line) => renderer.println?.(line));
      }
      renderCurrentApproval();
      return latestPromptDraft;
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
        renderer.println?.(`/${command.cmd} is unavailable in this mode.`);
        return;
      }
      try {
        switch (command.cmd) {
          case 'sessions': {
            const items = filterSessionItems(await workspace.listSessions(), command.query);
            formatSessionItems(items).forEach((line) => renderer.println?.(line));
            return;
          }
          case 'resume':
          case 'switch':
            if (!isThreadId(command.threadId)) {
              renderer.println?.(`usage: /${command.cmd} <thread-id>`);
              formatSessionItems(filterSessionItems(await workspace.listSessions(), ''))
                .forEach((line) => renderer.println?.(line));
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
              renderer.println?.('usage: /rename <title>');
              return;
            }
            await workspace.renameSession(command.title);
            renderer.println?.('Session renamed.');
            return;
          case 'archive':
            if (command.mode !== '' && command.mode !== 'on' && command.mode !== 'off') {
              renderer.println?.('usage: /archive [on|off]');
              return;
            }
            await workspace.archiveSession(command.mode !== 'off');
            renderer.println?.(command.mode === 'off' ? 'Session restored.' : 'Session archived.');
            return;
          case 'compact':
            await workspace.compactConversation();
            renderer.println?.('Conversation compacted.');
            return;
          case 'fork':
          case 'retry': {
            if (command.turnId !== '' && !isTurnId(command.turnId)) {
              renderer.println?.(`usage: /${command.cmd} [turn-id]`);
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
          }
          case 'review': {
            const snapshot = await workspace.reviewSnapshot();
            if (snapshot === undefined) renderer.println?.('No review data for this session.');
            else formatReviewSnapshot(snapshot).forEach((line) => renderer.println?.(line));
            return;
          }
          case 'diff': {
            const scope = command.scope === '' ? 'turn' : command.scope;
            if (scope !== 'turn' && scope !== 'workspace') {
              renderer.println?.('usage: /diff [turn|workspace]');
              return;
            }
            const snapshot = await workspace.diffSnapshot(scope);
            if (snapshot === undefined) renderer.println?.('No diff data for this session.');
            else formatDiffSnapshot(snapshot).forEach((line) => renderer.println?.(line));
            return;
          }
          case 'permissions':
            formatPermissionSnapshot(await workspace.workspaceSnapshot())
              .forEach((line) => renderer.println?.(line));
            return;
          default:
            return;
        }
      } catch (error) {
        renderer.println?.(`${command.cmd} failed: ${sanitizeTerminalError(error)}`);
      }
    };

    /** null = clear command text; string = replace composer with returned draft. */
    const runCommand = (c: SlashCommand): string | null => {
      switch (c.cmd) {
        case 'quit':
          void shutdown(0);
          return null;
        case 'abort':
          if (canAbort()) session.abort();
          else renderer.println?.('No active run to abort.');
          return null;
        case 'help':
          for (const line of renderInteractiveHelp('classic')) renderer.println?.(line);
          return null;
        case 'status':
          for (const l of formatStatusLines(
            session.usage(),
            formatModelRef(session.currentModel()),
          )) {
            renderer.println?.(l);
          }
          return null;
        case 'doctor': {
          const report = collectDoctorReport(opts.version ?? 'unknown');
          for (const line of formatDoctorReportLines(report)) renderer.println?.(line);
          return paletteReturnDraft ?? null;
        }
        case 'auth_status':
          if (opts.providerCommands === undefined) {
            renderer.println?.('/auth is unavailable in this mode');
          } else {
            for (const line of formatAuthStatusLines(opts.providerCommands.registry)) {
              renderer.println?.(line);
            }
          }
          return paletteReturnDraft ?? null;
        case 'login':
        case 'model':
        case 'logout':
          if (providerController === undefined) {
            renderer.println?.(`/${c.cmd} is unavailable in this mode`);
            return paletteReturnDraft ?? latestPromptDraft;
          }
          return beginProviderCommand(c.cmd);
        case 'queue':
          for (const l of formatQueueLines(lastQueues.steering, lastQueues.followUp)) {
            renderer.println?.(l);
          }
          return null;
        case 'follow_up':
          if (c.text !== '') session.followUp(c.text);
          return null;
        case 'history_search': {
          const query = c.query === '' ? latestPromptDraft : c.query;
          const match = history.reverseSearch(query);
          if (match === undefined) {
            renderer.println?.(`No prompt history match for ${JSON.stringify(query)}.`);
            return paletteReturnDraft ?? null;
          }
          setStatusHint(`history match · Ctrl+R for older · ${query}`);
          return match;
        }
        case 'edit':
          void editComposerDraft(paletteReturnDraft ?? latestPromptDraft);
          return paletteReturnDraft ?? latestPromptDraft;
        case 'file_complete': {
          const candidates = opts.presentation === undefined
            ? []
            : workspacePathCandidates(opts.presentation.cwd, c.query, 20);
          if (candidates.length === 0) renderer.println?.('No matching workspace paths.');
          else candidates.forEach((candidate) => renderer.println?.(`  @${candidate}`));
          return candidates.length === 1 ? `@${candidates[0]}` : (paletteReturnDraft ?? null);
        }
        case 'stash': {
          if (opts.presentation === undefined) {
            renderer.println?.('/stash is unavailable without presentation storage.');
            return paletteReturnDraft ?? null;
          }
          const draft = c.text || paletteReturnDraft || latestPromptDraft;
          if (draft === '') {
            renderer.println?.('No draft to stash.');
            return null;
          }
          try {
            opts.presentation.store.stash(persistableDraft(draft));
            latestPromptDraft = '';
            renderer.println?.('Draft stashed for this thread.');
            return '';
          } catch (error) {
            renderer.println?.(`stash failed: ${sanitizeTerminalError(error)}`);
            return draft;
          }
        }
        case 'restore': {
          try {
            const restored = opts.presentation?.store.restoreStash();
            if (restored === undefined) {
              renderer.println?.('No stashed draft for this thread.');
              return paletteReturnDraft ?? null;
            }
            latestPromptDraft = restored.text;
            renderer.println?.('Draft restored.');
            return restored.text;
          } catch (error) {
            renderer.println?.(`restore failed: ${sanitizeTerminalError(error)}`);
            return paletteReturnDraft ?? latestPromptDraft;
          }
        }
        case 'transcript_search': {
          if (c.query === '') {
            renderer.println?.('usage: /search <query>');
            return paletteReturnDraft ?? null;
          }
          printSearchMatch(transcriptSearch.setQuery(c.query));
          return paletteReturnDraft ?? null;
        }
        case 'search_next':
          printSearchMatch(transcriptSearch.move(1));
          return paletteReturnDraft ?? null;
        case 'search_previous':
          printSearchMatch(transcriptSearch.move(-1));
          return paletteReturnDraft ?? null;
        case 'latest': {
          const latest = latestAssistantText(session.messages);
          renderer.println?.(latest === undefined ? 'No assistant response yet.' : `latest response\n${latest}`);
          return paletteReturnDraft ?? null;
        }
        case 'copy':
          void copyTranscript(c.mode);
          return paletteReturnDraft ?? null;
        case 'export': {
          if (opts.presentation === undefined) {
            renderer.println?.('/export is unavailable without presentation storage.');
            return paletteReturnDraft ?? null;
          }
          try {
            const destination = exportTranscript(session.messages, {
              cwd: opts.presentation.cwd,
              mode: c.mode === 'raw' || c.mode === 'latest' ? c.mode : 'text',
              ...(c.path === '' ? {} : { destination: c.path }),
            });
            renderer.println?.(`Exported transcript to ${sanitizeTerminalText(destination)}.`);
          } catch (error) {
            renderer.println?.(`export failed: ${sanitizeTerminalError(error)}`);
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
          void runWorkspaceCommand(c);
          return paletteReturnDraft ?? null;
        case 'vim':
          if (c.mode !== 'on' && c.mode !== 'off') {
            renderer.println?.('usage: /vim <on|off>');
            return paletteReturnDraft ?? null;
          }
          opts.presentation?.store.setVimEnabled(c.mode === 'on');
          vimEnabled = c.mode === 'on';
          vimInsertMode = !vimEnabled;
          renderer.println?.(`Vim composer keys ${vimEnabled ? 'enabled (NORMAL)' : 'disabled'}.`);
          return paletteReturnDraft ?? null;
        case 'draft': {
          if (opts.presentation === undefined) {
            renderer.println?.('/draft is unavailable without presentation storage.');
            return paletteReturnDraft ?? null;
          }
          const draft = opts.presentation.store.snapshot().draft;
          if (c.action === 'show') {
            renderer.println?.(draft === '' ? 'No saved draft.' : `saved draft\n${draft}`);
            return paletteReturnDraft ?? null;
          }
          if (c.action === 'clear') {
            opts.presentation.store.setDraft(persistableDraft(''));
            latestPromptDraft = '';
            renderer.println?.('Saved draft cleared.');
            return '';
          }
          if (c.action === 'send') {
            if (draft === '') {
              renderer.println?.('No saved draft to send.');
              return paletteReturnDraft ?? null;
            }
            try {
              if (interactionEnterState(session.interactionState()) === 'running') {
                session.steer(draft);
              } else {
                session.prompt(draft).catch((error) => {
                  printErr(error);
                  opts.presentation?.store.setDraft(persistableDraft(draft));
                  if (input === '') setInput(draft);
                });
              }
              opts.presentation.store.setDraft(persistableDraft(''));
              latestPromptDraft = '';
              return '';
            } catch (error) {
              printErr(error);
              return draft;
            }
          }
          renderer.println?.('usage: /draft <show|send|clear>');
          return paletteReturnDraft ?? null;
        }
        case 'unknown':
          renderer.println?.(`unknown command: ${c.input} (try /help)`);
          return null;
      }
    };

    const submit = (meta: boolean): void => {
      if (providerController?.active === true) {
        const value = input;
        setInput('');
        void providerController.submit(value);
        return;
      }
      const action = decideEnter(interactionEnterState(session.interactionState()), meta, input);
      if (action.kind === 'none') {
        setInput('');
        return;
      }
      const submitted = input;
      let nextInput = '';
      if (action.kind !== 'command') history.push(input);
      try {
        switch (action.kind) {
          case 'prompt':
            latestPromptDraft = '';
            session.prompt(action.text).catch((error) => {
              printErr(error);
              if (input === '') setInput(action.text);
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
      } catch (err) {
        printErr(err);
        nextInput = submitted;
      }
      paletteReturnDraft = undefined;
      setInput(nextInput);
    };

    const insert = (s: string): void => {
      const clean = sanitizeTerminalText(s);
      input = input.slice(0, cursor) + clean + input.slice(cursor);
      cursor += clean.length;
      renderInput();
      persistInput();
    };

    const onKeypress = (str: string | undefined, key: readline.Key | undefined): void => {
      if (closing || editing) return;
      const k = key ?? {};
      const name = k.name ?? '';
      const pasteStart = '\x1b[200~';
      const pasteEnd = '\x1b[201~';

      // bracketed paste:粘贴换行不触发发送(docs/09 §8;Node 20+ keypress 解码
      // paste-start/paste-end,不支持的终端退化为逐行——已知限制)
      if (name === 'paste-start' || str === pasteStart) {
        pasting = true;
        return;
      }
      if (name === 'paste-end' || str === pasteEnd) {
        pasting = false;
        renderInput();
        return;
      }
      if (str?.includes(pasteStart) === true) {
        const marker = str.indexOf(pasteStart);
        const start = marker + pasteStart.length;
        const end = str.indexOf(pasteEnd, start);
        const before = str.slice(0, marker);
        const content = str.slice(start, end === -1 ? undefined : end);
        const after = end === -1 ? '' : str.slice(end + pasteEnd.length);
        insert(before + content + after);
        pasting = end === -1;
        return;
      }
      if (pasting && str?.includes(pasteEnd) === true) {
        const end = str.indexOf(pasteEnd);
        insert(str.slice(0, end) + str.slice(end + pasteEnd.length));
        pasting = false;
        return;
      }
      if (pasting) {
        if (str !== undefined && str !== '') insert(str);
        else if (name === 'return' || name === 'enter') insert('\n');
        return;
      }

      // 双击窗口:被其他按键打断即失效
      if (name !== 'escape') escExit.reset();
      if (!(k.ctrl === true && name === 'c')) ctrlCExit.reset();
      if (!(k.ctrl === true && name === 'r')) {
        reverseSearchQuery = undefined;
        history.resetSearch();
      }
      clearStatusHint();

      // 审批模式(M6,docs/09 §4):approval_request 期间键位表切换为
      // y=once / a=always / n=deny / Esc=abort;Ctrl+C / Ctrl+D 的退出组合仍然有效
      //(fall through 到下方正常处理),其余键位吞掉;决议后恢复正常键位。
      if (approvalQueue.length > 0 && approval?.broker !== undefined && k.ctrl !== true) {
        const decision = approvalKeyDecision(name);
        if (decision === 'abort') {
          if (escExit.hit(Date.now())) {
            void shutdown(0); // Esc Esc 快速退出仍可用(docs/09 §3)
            return;
          }
          // Esc 在审批模式的语义 = 决议 abort;时序纪律(R7):先 session.abort()
          //(任务观察到 cancellation),再 policy.onAbort()(pending 以 'abort' 决议)——
          // 顺序反了,审批结果会以「拒绝」形态漏给模型。
          clearApprovalQueue();
          session.abort();
          approval.onAbort();
          return;
        }
        if (decision !== undefined) {
          const id = approvalQueue[0];
          if (decision === 'allow_always'
            && !approvalAllowsAlways(id === undefined
              ? undefined
              : opts.workspace?.approvalPresentation(id))) {
            renderer.println?.('Allow always is unavailable because Runtime provided no frozen scope.');
            return;
          }
          approvalQueue.shift();
          if (id !== undefined) {
            approvalEvents.delete(id);
            approval.broker.resolve(id, decision);
          }
          renderCurrentApproval();
          return;
        }
        return; // 审批模式吞掉其余非 Ctrl 键位(输入行冻结,防误触)
      }

      if (name === 'escape' && providerController?.active === true) {
        providerController.back();
        escExit.reset();
        return;
      }

      if (vimEnabled && providerController?.active !== true) {
        if (name === 'escape' && vimInsertMode) {
          vimInsertMode = false;
          setStatusHint('VIM NORMAL · i insert · Esc abort/exit');
          return;
        }
        if (!vimInsertMode && k.ctrl !== true && k.meta !== true) {
          if (name === 'i' || str === 'i') {
            vimInsertMode = true;
            setStatusHint('VIM INSERT · Esc normal');
            return;
          }
          if (name === 'a' || str === 'a') {
            cursor = nextGraphemeBoundary(input, cursor);
            vimInsertMode = true;
            renderInput();
            setStatusHint('VIM INSERT · Esc normal');
            return;
          }
          if (name === 'h' || str === 'h') {
            cursor = previousGraphemeBoundary(input, cursor);
            renderInput();
            return;
          }
          if (name === 'l' || str === 'l') {
            cursor = nextGraphemeBoundary(input, cursor);
            renderInput();
            return;
          }
          if (name === 'j' || str === 'j' || name === 'down') {
            cursor = moveMultilineCursor(input, cursor, 1);
            renderInput();
            return;
          }
          if (name === 'k' || str === 'k' || name === 'up') {
            cursor = moveMultilineCursor(input, cursor, -1);
            renderInput();
            return;
          }
          if (str === '0' || name === 'home') {
            cursor = input.lastIndexOf('\n', Math.max(0, cursor - 1)) + 1;
            renderInput();
            return;
          }
          if (str === '$' || name === 'end') {
            const end = input.indexOf('\n', cursor);
            cursor = end === -1 ? input.length : end;
            renderInput();
            return;
          }
          if (name === 'x' || str === 'x' || name === 'delete') {
            if (cursor < input.length) {
              input = input.slice(0, cursor) + input.slice(nextGraphemeBoundary(input, cursor));
              renderInput();
              persistInput();
            }
            return;
          }
          if (name !== 'escape') return;
        }
      }

      if (k.ctrl === true && name === 'k' && providerController?.active !== true) {
        paletteReturnDraft = input;
        setInput('/', 1, false);
        setStatusHint('command palette · type to fuzzy-search · Esc returns to draft');
        return;
      }
      if (k.ctrl === true && name === 'f' && providerController?.active !== true) {
        paletteReturnDraft = input;
        setInput('/search ', '/search '.length, false);
        setStatusHint('transcript search · enter a query');
        return;
      }
      if (k.ctrl === true && name === 'r' && providerController?.active !== true) {
        reverseSearchQuery ??= input;
        const match = history.reverseSearch(reverseSearchQuery);
        if (match === undefined) {
          setStatusHint(`no older history match · ${reverseSearchQuery}`);
        } else {
          setInput(match);
          setStatusHint(`history match · Ctrl+R older · ${reverseSearchQuery}`);
        }
        return;
      }
      if (k.ctrl === true && name === 'o' && providerController?.active !== true) {
        void editComposerDraft(input);
        return;
      }
      if (k.meta === true && name === 's' && providerController?.active !== true) {
        if (opts.presentation === undefined || input === '') {
          renderer.println?.(input === '' ? 'No draft to stash.' : 'Draft storage unavailable.');
        } else {
          try {
            opts.presentation.store.stash(persistableDraft(input));
            latestPromptDraft = '';
            setInput('');
            renderer.println?.('Draft stashed for this thread.');
          } catch (error) {
            renderer.println?.(`stash failed: ${sanitizeTerminalError(error)}`);
          }
        }
        return;
      }
      if (name === 'tab' && providerController?.active !== true && opts.presentation !== undefined) {
        const completion = workspaceCompletionAtCursor(
          input,
          cursor,
          opts.presentation.cwd,
          20,
        );
        if (completion !== undefined && completion.candidates.length > 0) {
          const [selected] = completion.candidates;
          if (selected !== undefined) {
            const applied = applyWorkspaceCompletion(input, completion, selected);
            setInput(applied.text, applied.cursor);
          }
          if (completion.candidates.length > 1) {
            completion.candidates.forEach((candidate) => renderer.println?.(`  @${candidate}`));
          }
        }
        return;
      }

      if (k.ctrl === true && name === 'c') {
        if (input !== '') {
          setInput(''); // 输入非空:清空输入行(docs/09 §3)
          ctrlCExit.reset();
          return;
        }
        if (ctrlCExit.hit(Date.now())) {
          void shutdown(0);
          return;
        }
        setStatusHint('press Ctrl+C again to exit');
        return;
      }
      if (k.ctrl === true && name === 'd') {
        if (input === '' && !canAbort()) void shutdown(0);
        return;
      }
      if (name === 'escape') {
        if (paletteReturnDraft !== undefined) {
          const draft = paletteReturnDraft;
          paletteReturnDraft = undefined;
          setInput(draft);
          escExit.reset();
          return;
        }
        if (escExit.hit(Date.now())) {
          void shutdown(0);
          return;
        }
        if (canAbort()) session.abort(); // Esc 不消费输入框文本(docs/09 §3.1)
        return;
      }
      if (name === 'return' || name === 'enter') {
        if (k.shift === true) {
          insert('\n');
          return;
        }
        submit(k.meta === true); // Alt+Enter → key.meta && name==='return'(docs/09 §3.2)
        return;
      }
      if (name === 'up') {
        if (providerController?.active === true) return;
        if (input.includes('\n') && k.meta !== true) {
          cursor = moveMultilineCursor(input, cursor, -1);
          renderInput();
        } else {
          setInput(history.up(input));
        }
        return;
      }
      if (name === 'down') {
        if (providerController?.active === true) return;
        if (input.includes('\n') && k.meta !== true) {
          cursor = moveMultilineCursor(input, cursor, 1);
          renderInput();
        } else {
          setInput(history.down());
        }
        return;
      }
      if (name === 'left') {
        cursor = previousGraphemeBoundary(input, cursor);
        renderInput();
        return;
      }
      if (name === 'right') {
        cursor = nextGraphemeBoundary(input, cursor);
        renderInput();
        return;
      }
      if (name === 'home' || (k.ctrl === true && name === 'a')) {
        cursor = input.lastIndexOf('\n', Math.max(0, cursor - 1)) + 1;
        renderInput();
        return;
      }
      if (name === 'end' || (k.ctrl === true && name === 'e')) {
        const end = input.indexOf('\n', cursor);
        cursor = end === -1 ? input.length : end;
        renderInput();
        return;
      }
      if (name === 'backspace') {
        if (cursor > 0) {
          const previous = previousGraphemeBoundary(input, cursor);
          input = input.slice(0, previous) + input.slice(cursor);
          cursor = previous;
          renderInput();
          persistInput();
        }
        return;
      }
      if (name === 'delete') {
        if (cursor < input.length) {
          input = input.slice(0, cursor) + input.slice(nextGraphemeBoundary(input, cursor));
          renderInput();
          persistInput();
        }
        return;
      }
      if (k.ctrl === true && name === 'u') {
        setInput('');
        return;
      }
      if (k.ctrl === true || k.meta === true) return; // 其余控制组合忽略
      if (str !== undefined && str !== '') {
        // 剥控制字符,\t 保留在数据层(提交的文本含真实 tab);显示层由 renderer 的
        // sanitizeDynText 统一清洗(\t → 2 空格、\r 剥除),动态区行宽数学不受影响。
        // 非 paste 路径的裸换行不入输入行。
        const clean = sanitizeTerminalText(str).replaceAll('\n', '');
        if (clean !== '') insert(clean);
      }
    };

    // 接线:emitKeypressEvents 第二参仅取 escapeCodeTimeout(50ms 消歧,docs/09 §3.2)
    readline.emitKeypressEvents(
      stdin,
      { escapeCodeTimeout: ESC_TIMEOUT_MS } as unknown as readline.Interface,
    );
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on('keypress', onKeypress);
    process.on('SIGWINCH', onResize);
    process.once('SIGTERM', onSignal);

    renderer.mount?.();
    const restoredDraft = opts.presentation?.store.snapshot().draft ?? '';
    setInput(restoredDraft, restoredDraft.length, false);
    if (restoredDraft !== '') renderer.println?.('Restored this thread’s draft.');
    if (vimEnabled) setStatusHint('VIM NORMAL · i insert · Esc abort/exit');
    opts.fatalSignal?.addEventListener('abort', onFatalSignal, { once: true });
    if (opts.fatalSignal?.aborted === true) onFatalSignal();
  });
}
