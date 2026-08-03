// Presentation-only actions for the TUI. These helpers read
// the frontend transcript projection and write only explicit user-facing destinations; they do not
// read repositories or call Agent/Session internals.

import {
  closeSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentMessage, AssistantMessage, ThreadId } from '../protocol/index.js';
import { sanitizeTerminalText } from './terminal-sanitize.js';

export type TranscriptContentMode = 'latest' | 'text' | 'raw';

export interface WorkspaceCompletion {
  readonly start: number;
  readonly end: number;
  readonly query: string;
  readonly candidates: readonly string[];
}

export interface ExternalEditorOptions {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface TranscriptExportOptions {
  readonly cwd: string;
  readonly destination?: string;
  readonly mode: TranscriptContentMode;
  readonly now?: () => Date;
}

export interface PresentationThreadNavigator {
  readonly currentThreadId: ThreadId;
  isAttached?(): boolean;
  switchSession(threadId: ThreadId): Promise<void>;
}

/**
 * Keep Runtime thread selection and frontend-only presentation state in one visible transaction.
 * The durability barrier runs before Runtime changes; a presentation failure after the change
 * restores the source Runtime thread and asks the surface to project that source again.
 */
export async function runThreadPresentationTransition(
  navigator: PresentationThreadNavigator,
  store: { flush(): void } | undefined,
  transition: () => Promise<unknown>,
  presentCurrentThread: () => void,
): Promise<void> {
  const sourceThreadId = navigator.currentThreadId;
  const sourceWasAttached = navigator.isAttached?.() ?? true;
  store?.flush();
  try {
    await transition();
    presentCurrentThread();
  } catch (error) {
    if (sourceWasAttached && navigator.currentThreadId !== sourceThreadId) {
      try {
        await navigator.switchSession(sourceThreadId);
        presentCurrentThread();
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Thread presentation transition failed and ${sourceThreadId} could not be restored`,
        );
      }
    }
    throw error;
  }
}

export function latestAssistantText(messages: readonly AgentMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== 'assistant') continue;
    const text = assistantText(message);
    if (text !== '') return sanitizeTerminalText(text);
  }
  return undefined;
}

/** Rebuild Ctrl+R history from the canonical thread transcript after resume. */
export function promptHistoryEntries(messages: readonly AgentMessage[]): readonly string[] {
  return messages.flatMap((message): string[] => {
    if (message.role !== 'user' || message.source === 'synthetic') return [];
    const text = sanitizeTerminalText(
      message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n'),
    );
    return text.trim() === '' ? [] : [text];
  });
}

export function transcriptContent(
  messages: readonly AgentMessage[],
  mode: TranscriptContentMode,
): string {
  if (mode === 'latest') return latestAssistantText(messages) ?? '';
  if (mode === 'raw') {
    // JSON escaping keeps control bytes inert while preserving the canonical message payload.
    return messages.map((message) => JSON.stringify(message)).join('\n') +
      (messages.length === 0 ? '' : '\n');
  }
  return messages.map(formatMessageText).filter((item) => item !== '').join('\n\n') +
    (messages.length === 0 ? '' : '\n');
}

/** Bounded, symlink-safe workspace index used by @ completion. */
export function workspacePathCandidates(
  cwd: string,
  query: string,
  limit = 50,
): readonly string[] {
  const foldedQuery = normalizeCompletionQuery(query).toLocaleLowerCase('en-US');
  const pending = [''];
  const candidates: string[] = [];
  let visited = 0;
  while (pending.length > 0 && visited < 5_000) {
    const relativeDirectory = pending.shift();
    if (relativeDirectory === undefined) break;
    let entries;
    try {
      entries = readdirSync(path.join(cwd, relativeDirectory), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      visited++;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const relative = relativeDirectory === ''
        ? entry.name
        : `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) pending.push(relative);
      if (!entry.isDirectory() && !entry.isFile()) continue;
      const display = entry.isDirectory() ? `${relative}/` : relative;
      const score = fuzzyPathScore(display.toLocaleLowerCase('en-US'), foldedQuery);
      if (score !== undefined) candidates.push(`${String(score).padStart(6, '0')}\0${display}`);
    }
  }
  return candidates
    .sort((left, right) => left.localeCompare(right, 'en'))
    .slice(0, Math.max(1, limit))
    .map((candidate) => candidate.slice(candidate.indexOf('\0') + 1));
}

export function workspaceCompletionAtCursor(
  text: string,
  cursor: number,
  cwd: string,
  limit = 50,
): WorkspaceCompletion | undefined {
  const safeCursor = Math.max(0, Math.min(text.length, cursor));
  const before = text.slice(0, safeCursor);
  const match = /(?:^|\s)@([^\s@]*)$/u.exec(before);
  if (match === null) return undefined;
  const query = match[1] ?? '';
  const start = safeCursor - query.length - 1;
  return {
    start,
    end: safeCursor,
    query,
    candidates: workspacePathCandidates(cwd, query, limit),
  };
}

export function applyWorkspaceCompletion(
  text: string,
  completion: WorkspaceCompletion,
  candidate: string,
): { readonly text: string; readonly cursor: number } {
  const inserted = `@${candidate}`;
  return {
    text: text.slice(0, completion.start) + inserted + text.slice(completion.end),
    cursor: completion.start + inserted.length,
  };
}

export async function editDraftWithExternalEditor(
  draft: string,
  options: ExternalEditorOptions,
): Promise<string> {
  const environment = options.env ?? Bun.env;
  const editor = environment['VISUAL'] ?? environment['EDITOR'];
  if (editor === undefined || editor.trim() === '') {
    throw new Error('$VISUAL or $EDITOR is not configured');
  }
  const directory = mkdtempSync(path.join(os.tmpdir(), 'coda-editor-'));
  const file = path.join(directory, 'prompt.md');
  try {
    writeFileSync(file, draft, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const command = editorCommand(editor, file, environment);
    const child = Bun.spawn(command, {
      cwd: options.cwd,
      env: {
        ...environment,
        CODA_EDITOR: editor,
        CODA_DRAFT_FILE: file,
      },
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const exitCode = await child.exited;
    if (exitCode !== 0) throw new Error(`editor exited with status ${exitCode}`);
    const edited = sanitizeTerminalText(readFileSync(file, 'utf8'));
    return edited.endsWith('\n') ? edited.slice(0, -1) : edited;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function copyTextToClipboard(text: string): Promise<void> {
  const commands = clipboardCommands();
  let lastError: unknown;
  for (const command of commands) {
    try {
      const child = Bun.spawn(command, {
        stdin: 'pipe',
        stdout: 'ignore',
        stderr: 'pipe',
      });
      child.stdin.write(text);
      child.stdin.end();
      const [exitCode, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      if (exitCode === 0) return;
      lastError = new Error(
        `${command[0] ?? 'clipboard command'} exited with status ${exitCode}` +
          (stderr.trim() === '' ? '' : `: ${sanitizeTerminalText(stderr).trim()}`),
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `clipboard is unavailable${lastError === undefined ? '' : `: ${errorMessage(lastError)}`}`,
  );
}

export function exportTranscript(
  messages: readonly AgentMessage[],
  options: TranscriptExportOptions,
): string {
  const destination = options.destination ?? defaultExportName(options.mode, options.now?.() ?? new Date());
  const absolute = path.resolve(options.cwd, destination);
  const content = transcriptContent(messages, options.mode);
  const descriptor = openSync(absolute, 'wx', 0o600);
  try {
    try {
      writeFileSync(descriptor, content, 'utf8');
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    try {
      unlinkSync(absolute);
    } catch {
      // Keep the primary write error.
    }
    throw error;
  }
  return absolute;
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function formatMessageText(message: AgentMessage): string {
  if (message.role === 'assistant') {
    const text = assistantText(message);
    return text === '' ? '' : `coda\n${sanitizeTerminalText(text)}`;
  }
  if (message.role === 'user') {
    const text = message.content
      .map((part) => part.type === 'text' ? part.text : `[image · ${part.mimeType}]`)
      .join('\n');
    return `you\n${sanitizeTerminalText(text)}`;
  }
  return `tool ${sanitizeTerminalText(message.toolName)}\n${sanitizeTerminalText(
    message.content
      .map((part) => part.type === 'text' ? part.text : `[image · ${part.mimeType}]`)
      .join('\n'),
  )}`;
}

function normalizeCompletionQuery(query: string): string {
  return query.replace(/^@/u, '').replace(/^\.\//u, '');
}

function fuzzyPathScore(candidate: string, query: string): number | undefined {
  if (query === '') return candidate.split('/').length * 100 + candidate.length;
  const direct = candidate.indexOf(query);
  if (direct >= 0) return direct * 10 + candidate.length;
  let cursor = 0;
  let score = 1_000;
  for (const character of query) {
    const found = candidate.indexOf(character, cursor);
    if (found < 0) return undefined;
    score += found - cursor;
    cursor = found + 1;
  }
  return score + candidate.length;
}

function editorCommand(
  editor: string,
  file: string,
  environment: Readonly<Record<string, string | undefined>>,
): string[] {
  if (process.platform === 'win32') {
    const command = environment['COMSPEC'] ?? 'cmd.exe';
    return [command, '/d', '/s', '/c', `${editor} "${file.replaceAll('"', '""')}"`];
  }
  const shell = environment['SHELL'] ?? '/bin/sh';
  // EDITOR is an explicit user-controlled shell command (for example "code --wait"). Parse only
  // that value, then pass the generated temporary path as a separate positional argument.
  return [
    shell,
    '-c',
    'eval "set -- $CODA_EDITOR"; exec "$@" "$CODA_DRAFT_FILE"',
  ];
}

function clipboardCommands(): readonly string[][] {
  if (process.platform === 'darwin') return [['pbcopy']];
  if (process.platform === 'win32') return [['clip.exe']];
  return [['wl-copy'], ['xclip', '-selection', 'clipboard']];
}

function defaultExportName(mode: TranscriptContentMode, now: Date): string {
  const stamp = now.toISOString().replaceAll(':', '-');
  return `coda-transcript-${stamp}.${mode === 'raw' ? 'jsonl' : 'txt'}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
