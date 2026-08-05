// Pure TUI interaction decisions. This module owns no terminal, Runtime, or session lifecycle;
// the OpenTUI controller maps these values onto its canonical frontend operations.

import type {
  CliApprovalDecision as ApprovalDecision,
  CliInteractionState,
  CliThreadUsage,
} from './frontend-types.js';
import { findSlashCommand } from './command-catalog.js';

export { SLASH_COMMAND_SPECS } from './command-catalog.js';
export type { SlashCommandSpec } from './command-catalog.js';

export const CTRL_C_EXIT_WINDOW_MS = 1500;

/** While a run is active, plain Enter routes text by this insert mode. */
export type InsertMode = 'steering' | 'following';

export const INSERT_MODE_CHOICES: readonly { value: InsertMode; label: string }[] = [
  { value: 'steering', label: 'steering' },
  { value: 'following', label: 'following' },
];

/** Resolve a picker submission to one of the supported insert modes. */
export function selectInsertModeChoice(raw: string): InsertMode | undefined {
  const normalized = raw.trim().toLocaleLowerCase('en-US');
  if (normalized === 'steering') return 'steering';
  if (normalized === 'following') return 'following';
  const number = Number(normalized);
  if (
    Number.isInteger(number) &&
    number >= 1 &&
    number <= INSERT_MODE_CHOICES.length
  ) {
    return INSERT_MODE_CHOICES[number - 1]?.value;
  }
  return undefined;
}

/** retrying Enter remains steering; compacting accepts a deferred prompt. */
export function interactionEnterState(
  state: CliInteractionState,
): 'idle' | 'running' {
  return state === 'running' || state === 'retrying' ? 'running' : 'idle';
}

export function interactionCanAbort(state: CliInteractionState): boolean {
  return state !== 'idle';
}

export type SlashCommand =
  | {
      cmd:
        | 'quit'
        | 'insert_mode'
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

/** Return undefined for ordinary input; slash commands are resolved through the catalog. */
export function parseSlashCommand(text: string): SlashCommand | undefined {
  if (!text.startsWith('/')) return undefined;
  const space = text.indexOf(' ');
  const head = (space === -1 ? text.slice(1) : text.slice(1, space)).toLowerCase();
  const rest = space === -1 ? '' : text.slice(space + 1).trim();
  switch (findSlashCommand(head)?.actionId) {
    case 'app.quit':
      return { cmd: 'quit' };
    case 'task.insert-mode':
      return { cmd: 'insert_mode' };
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

export type EnterAction =
  | { kind: 'none' }
  | { kind: 'prompt'; text: string }
  | { kind: 'steer'; text: string }
  | { kind: 'follow_up'; text: string }
  | { kind: 'command'; command: SlashCommand };

/** Map Enter onto prompt, steering, follow-up, or a catalog command. */
export function decideEnter(
  state: 'idle' | 'running',
  mode: InsertMode,
  raw: string,
): EnterAction {
  const text = raw.trim();
  if (text === '') return { kind: 'none' };
  const slash = parseSlashCommand(text);
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
  if (state === 'running') {
    return mode === 'following'
      ? { kind: 'follow_up', text }
      : { kind: 'steer', text };
  }
  if (slash !== undefined) return { kind: 'command', command: slash };
  return { kind: 'prompt', text };
}

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

/** Per-thread prompt history used by the TUI composer. */
export class InputHistory {
  #items: string[] = [];
  #index = 0;
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

  up(current: string): string {
    this.resetSearch();
    if (this.#items.length === 0) return current;
    if (this.#index === this.#items.length) this.#draft = current;
    if (this.#index > 0) this.#index--;
    return this.#items[this.#index] ?? current;
  }

  down(): string {
    this.resetSearch();
    if (this.#index < this.#items.length) this.#index++;
    if (this.#index === this.#items.length) return this.#draft;
    return this.#items[this.#index] ?? this.#draft;
  }

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

/** Double-press disambiguation with an injected timestamp. */
export class DoublePress {
  #last = Number.NEGATIVE_INFINITY;

  constructor(private readonly windowMs: number) {}

  hit(now: number): boolean {
    const isDouble = now - this.#last <= this.windowMs;
    this.#last = isDouble ? Number.NEGATIVE_INFINITY : now;
    return isDouble;
  }

  reset(): void {
    this.#last = Number.NEGATIVE_INFINITY;
  }
}

export function formatStatusLines(usage: CliThreadUsage, model?: string): string[] {
  const cumulative = usage.cumulative;
  const lines: string[] = [];
  if (model !== undefined) lines.push(`model: ${model}`);
  lines.push(`turns: ${usage.turns}`);
  let tokens = `tokens: ${cumulative.input} in / ${cumulative.output} out`;
  if (cumulative.reasoning !== undefined) tokens += ` (${cumulative.reasoning} reasoning)`;
  if (cumulative.cacheRead !== undefined) tokens += ` (${cumulative.cacheRead} cache read)`;
  lines.push(tokens);
  if (cumulative.costUSD !== undefined) lines.push(`cost: $${cumulative.costUSD.toFixed(4)}`);
  if (usage.lastTurn !== undefined) {
    lines.push(`last turn: ${usage.lastTurn.input} in / ${usage.lastTurn.output} out`);
  }
  return lines;
}
