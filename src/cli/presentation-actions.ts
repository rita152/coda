// Presentation-only actions for the TUI. These helpers read
// the frontend transcript projection and write only explicit user-facing destinations; they do not
// read repositories or call Agent/Session internals.

import {
  closeSync,
  fsyncSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { AgentMessage, AssistantMessage, ThreadId } from '../protocol/index.js';
import { sanitizeTerminalText } from './terminal-sanitize.js';

export type TranscriptContentMode = 'latest' | 'text' | 'raw';

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
