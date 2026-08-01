// Global catalog bootstrap used before a workspace Runtime is opened. This preserves legacy
// --continue/--resume behavior without teaching the CLI how to scan Session files.

import { createInterface } from 'node:readline/promises';
import process from 'node:process';
import type { StoredThreadLocator } from '../runtime/index.js';
import type { CliFlags } from './config.js';
import { sanitizeTerminalLine } from './terminal-sanitize.js';

export type CliResumeSelectionCode =
  | 'ambiguous_thread_id'
  | 'invalid_legacy_workspace_cwd';

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

export function isRuntimeResumeRequest(
  flags: Pick<CliFlags, 'continue_' | 'resume'>,
): boolean {
  return flags.continue_ || flags.resume !== undefined;
}

export async function selectCliResumeTarget(
  stored: readonly StoredThreadLocator[],
  flags: Pick<CliFlags, 'continue_' | 'resume' | 'workspace'>,
  io?: RuntimeResumePickerIO,
): Promise<StoredThreadLocator | undefined> {
  const candidates = newestFirst(
    flags.workspace === undefined
      ? stored
      : stored.filter((item) => item.ownerWorkspaceId === flags.workspace),
  );

  if (flags.continue_) return requireMutable(candidates[0]);

  if (typeof flags.resume === 'string') {
    const matches = candidates.filter(
      (item) => item.sourceSessionId === flags.resume || item.threadId === flags.resume,
    );
    if (matches.length > 1) throw ambiguous(flags.resume, matches);
    return requireMutable(matches[0]);
  }

  if (flags.resume === true) {
    return requireMutable(await pickRuntimeThreadInteractive(candidates, io));
  }
  return undefined;
}

export async function pickRuntimeThreadInteractive(
  candidates: readonly StoredThreadLocator[],
  io?: RuntimeResumePickerIO,
): Promise<StoredThreadLocator | undefined> {
  const input = io?.input ?? process.stdin;
  const output = io?.output ?? process.stderr;
  if (candidates.length === 0) {
    output.write('[coda] no sessions found\n');
    return undefined;
  }

  const listing = candidates
    .map((item, index) => {
      const summary = item.catalog.summary;
      const id = sanitizeTerminalLine(item.sourceSessionId ?? item.threadId);
      const eligibility = item.executionEligibility.kind === 'mutable'
        ? ''
        : `  [${sanitizeTerminalLine(item.executionEligibility.code)}]`;
      return (
        `  [${index + 1}] ${id}  ${formatTime(summary.createdAt)}  ` +
        `${sanitizeTerminalLine(summary.title ?? '')}\n      ` +
        `workspace=${sanitizeTerminalLine(item.ownerWorkspaceId)} ` +
        `cwd=${sanitizeTerminalLine(item.ownerRecordedCwd)}` +
        eligibility
      );
    })
    .join('\n');
  output.write(`[coda] sessions:\n${listing}\n`);
  if (input.isTTY !== true) return undefined;

  const readline = createInterface({ input, output });
  try {
    const answer = (
      await readline.question('[coda] resume which session? (number or id, Enter to cancel) ')
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
    const matches = candidates.filter(
      (item) => item.sourceSessionId === answer || item.threadId === answer,
    );
    if (matches.length > 1) throw ambiguous(answer, matches);
    return matches[0];
  } catch (error) {
    if (error instanceof CliResumeSelectionError) throw error;
    return undefined;
  } finally {
    readline.close();
  }
}

function requireMutable(
  target: StoredThreadLocator | undefined,
): StoredThreadLocator | undefined {
  if (target === undefined || target.executionEligibility.kind === 'mutable') return target;
  throw new CliResumeSelectionError(
    target.executionEligibility.code,
    `session cannot be resumed because its recorded cwd is invalid: ${JSON.stringify(target.ownerRecordedCwd)}`,
    [target],
  );
}

function ambiguous(
  id: string,
  matches: readonly StoredThreadLocator[],
): CliResumeSelectionError {
  const choices = matches
    .map((item) => `${item.ownerWorkspaceId} (${item.ownerRecordedCwd})`)
    .join(', ');
  return new CliResumeSelectionError(
    'ambiguous_thread_id',
    `thread id ${JSON.stringify(id)} is ambiguous; use --workspace=<id>. Matches: ${choices}`,
    matches,
  );
}

function newestFirst(
  stored: readonly StoredThreadLocator[],
): StoredThreadLocator[] {
  return [...stored].sort(
    (left, right) => right.catalog.summary.createdAt - left.catalog.summary.createdAt,
  );
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toISOString().replace('T', ' ').slice(0, 16);
}
