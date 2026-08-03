// Runtime-owned stored thread selection. The picker treats locators only as canonical ThreadId
// handles; workspace ownership metadata is consumed later solely to reopen the authoritative
// workspace, never as a format or execution-eligibility heuristic.

import { createInterface } from 'node:readline/promises';
import process from 'node:process';
import type { StoredThreadLocator } from '../runtime/index.js';
import type { CliFlags } from './config.js';
import { sanitizeTerminalLine } from './terminal-sanitize.js';

export type CliResumeSelectionCode = 'ambiguous_thread_id';

export class CliResumeSelectionError extends Error {
  override readonly name = 'CliResumeSelectionError';

  constructor(
    readonly code: CliResumeSelectionCode,
    message: string,
    readonly candidates: readonly StoredThreadLocator[] = [],
  ) {
    super(message);
  }
}

export interface RuntimeResumePickerIO {
  readonly input?: NodeJS.ReadableStream & { isTTY?: boolean };
  readonly output?: NodeJS.WritableStream;
}

export function isRuntimeResumeRequest(flags: Pick<CliFlags, 'continue_' | 'resume'>): boolean {
  return flags.continue_ || flags.resume !== undefined;
}

export async function selectCliResumeTarget(
  stored: readonly StoredThreadLocator[],
  flags: Pick<CliFlags, 'continue_' | 'resume'>,
  io?: RuntimeResumePickerIO,
): Promise<StoredThreadLocator | undefined> {
  if (flags.continue_) return stored[0];

  if (typeof flags.resume === 'string') {
    return selectByThreadId(stored, flags.resume);
  }

  if (flags.resume === true) return pickRuntimeThreadInteractive(stored, io);
  return undefined;
}

export async function pickRuntimeThreadInteractive(
  candidates: readonly StoredThreadLocator[],
  io?: RuntimeResumePickerIO,
): Promise<StoredThreadLocator | undefined> {
  const input = io?.input ?? process.stdin;
  const output = io?.output ?? process.stderr;
  if (candidates.length === 0) {
    output.write('[coda] no threads found\n');
    return undefined;
  }

  const listing = candidates
    .map((item, index) => `  [${index + 1}] ${sanitizeTerminalLine(item.threadId)}`)
    .join('\n');
  output.write(`[coda] threads:\n${listing}\n`);
  if (input.isTTY !== true) return undefined;

  const readline = createInterface({ input, output });
  try {
    const answer = (
      await readline.question('[coda] resume which thread? (number or id, Enter to cancel) ')
    ).trim();
    if (answer.length === 0) return undefined;
    const ordinal = Number.parseInt(answer, 10);
    if (
      Number.isInteger(ordinal) &&
      String(ordinal) === answer &&
      ordinal >= 1 &&
      ordinal <= candidates.length
    ) {
      return candidates[ordinal - 1];
    }
    return selectByThreadId(candidates, answer);
  } catch (error) {
    if (error instanceof CliResumeSelectionError) throw error;
    return undefined;
  } finally {
    readline.close();
  }
}

function selectByThreadId(
  candidates: readonly StoredThreadLocator[],
  threadId: string,
): StoredThreadLocator | undefined {
  const matches = candidates.filter((item) => item.threadId === threadId);
  if (matches.length > 1) {
    throw new CliResumeSelectionError(
      'ambiguous_thread_id',
      `thread id ${JSON.stringify(threadId)} appears more than once in Runtime storage`,
      matches,
    );
  }
  return matches[0];
}
