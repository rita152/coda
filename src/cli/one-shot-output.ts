// Explicit one-shot output adapter. Human rendering consumes the frontend event projection;
// stream-json writes only complete canonical EventEnvelopes received from RuntimePort.

import { PROTOCOL_VERSION } from '../protocol/index.js';
import type { AssistantMessage, EventEnvelope } from '../protocol/index.js';
import type {
  CliRuntimeEnvelopeListener,
  CliRuntimeEvent,
  CliThreadUsage,
} from './frontend-types.js';
import type { CliSession } from './interactive-runtime.js';
import type { CliOutputMode } from './command-catalog.js';
import type { HeadlessOutput } from './headless.js';
import { sanitizeTerminalError, sanitizeTerminalLine } from './terminal-sanitize.js';
import { toolHeadline } from './renderer.js';

export type OneShotStatus = 'completed' | 'aborted' | 'error' | 'timeout';

export interface OneShotResult {
  readonly type: 'result';
  readonly version: 1;
  readonly status: OneShotStatus;
  readonly exitCode: number;
  readonly text: string;
  readonly usage: CliThreadUsage;
  readonly error?: string;
}

export type OneShotStreamRecord =
  | {
      readonly type: 'stream_start';
      readonly version: 1;
      readonly protocolVersion: string;
    }
  | { readonly type: 'event'; readonly envelope: Readonly<EventEnvelope> }
  | OneShotResult;

interface OneShotSession extends CliSession {
  subscribeEnvelopes(listener: CliRuntimeEnvelopeListener): () => void;
}

export interface OneShotOutputOptions {
  readonly prompt: string;
  readonly mode: CliOutputMode;
  readonly finalOnly: boolean;
  readonly timeoutMs?: number;
  readonly stdout: HeadlessOutput;
  readonly stderr?: Pick<NodeJS.WriteStream, 'write'>;
  /** Ordered stdout's first-failure signal; aborts the run before a broken pipe can outlive it. */
  readonly fatalSignal?: AbortSignal;
}

/**
 * Run exactly one Runtime-backed prompt. Lifecycle, timeout abort, usage, and persistence
 * remain owned by the Runtime behind CliSession.
 */
export async function startOneShotOutput(
  session: OneShotSession,
  options: OneShotOutputOptions,
): Promise<number> {
  const stderr = options.stderr ?? process.stderr;
  const writeJson = (record: OneShotStreamRecord): void => {
    options.stdout.enqueue(`${JSON.stringify(record)}\n`);
  };

  let latestText = '';
  let lastError: string | undefined;
  let outputFailure: unknown;
  let timedOut = false;
  let terminal: Extract<CliRuntimeEvent, { type: 'agent_end' }> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let resolveTerminal!: () => void;
  const terminalReached = new Promise<void>((resolve) => {
    resolveTerminal = resolve;
  });

  const progress = (message: string): void => {
    if (options.mode !== 'text' || options.finalOnly) return;
    stderr.write(`[coda] ${sanitizeTerminalLine(message)}\n`);
  };
  const onOutputFailure = (): void => {
    if (outputFailure !== undefined) return;
    outputFailure = options.fatalSignal?.reason ?? new Error('stdout write failed');
    session.abort();
  };
  options.fatalSignal?.addEventListener('abort', onOutputFailure, { once: true });
  if (options.fatalSignal?.aborted === true) onOutputFailure();
  const unsubscribeEnvelopes = options.mode === 'stream-json' && !options.finalOnly
    ? session.subscribeEnvelopes((envelope) => {
        writeJson({ type: 'event', envelope });
      })
    : () => undefined;
  const unsubscribe = session.subscribe((event) => {
    switch (event.type) {
      case 'agent_start':
        progress(timedOut ? 'timeout reached; aborting the started run' : 'running');
        if (timedOut) session.abort();
        break;
      case 'message_end':
        if (event.message.role === 'assistant') {
          latestText = assistantText(event.message);
          if (event.message.stopReason === 'error') {
            lastError = sanitizeTerminalError(
              event.message.errorMessage ?? 'agent run ended with an error',
            );
          }
        }
        break;
      case 'tool_execution_start': {
        const summary = toolHeadline(event.toolName, event.args);
        progress(summary === undefined ? `tool ${event.toolName}` : `tool ${summary}`);
        break;
      }
      case 'control_request':
        if (event.kind === 'approval') {
          progress(`waiting for approval: ${event.payload.description}`);
        }
        break;
      case 'retry_scheduled':
        progress(`retry ${event.attempt}/${event.maxAttempts} in ${event.delayMs}ms`);
        break;
      case 'compaction_start':
        progress('compacting context');
        break;
      case 'error':
        lastError = sanitizeTerminalError(event.message);
        if (event.fatal) progress(`fatal: ${lastError}`);
        break;
      case 'agent_end':
        if (event.willRetry !== true) {
          terminal = event;
          if (timeout !== undefined) {
            clearTimeout(timeout);
            timeout = undefined;
          }
          resolveTerminal();
        }
        break;
      default:
        break;
    }
  });

  let promptFailure: unknown;
  try {
    if (options.mode === 'stream-json' && !options.finalOnly) {
      writeJson({
        type: 'stream_start',
        version: 1,
        protocolVersion: PROTOCOL_VERSION,
      });
      // Establish the stream before starting a side-effecting run. A pipe that is already
      // closed must fail here, while later event writes use fatalSignal to abort immediately.
      await options.stdout.drain();
    }
    if (outputFailure === undefined) {
      if (options.timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          if (terminal !== undefined || timedOut) return;
          timedOut = true;
          progress(`timeout after ${formatDuration(options.timeoutMs as number)}; aborting`);
          session.abort();
        }, options.timeoutMs);
      }
      await session.prompt(options.prompt);
      if (terminal === undefined) await terminalReached;
    }
  } catch (error) {
    if (outputFailure === undefined) {
      promptFailure = error;
      lastError = sanitizeTerminalError(error);
    }
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    unsubscribeEnvelopes();
    unsubscribe();
    options.fatalSignal?.removeEventListener('abort', onOutputFailure);
    try {
      await session.close();
    } catch (error) {
      promptFailure ??= error;
      lastError ??= sanitizeTerminalError(error);
    }
  }

  if (outputFailure !== undefined) {
    stderr.write(`[coda] stdout write failed: ${sanitizeTerminalError(outputFailure)}\n`);
    return 1;
  }

  const status: OneShotStatus = timedOut
    ? 'timeout'
    : promptFailure !== undefined || terminal?.reason === 'error'
      ? 'error'
      : terminal?.reason === 'aborted'
        ? 'aborted'
        : 'completed';
  if (status === 'error' && lastError === undefined) {
    lastError = 'agent run ended with an error';
  }
  const exitCode = status === 'completed' ? 0 : status === 'timeout' ? 124 : 1;
  const result: OneShotResult = {
    type: 'result',
    version: 1,
    status,
    exitCode,
    text: latestText,
    usage: session.usage(),
    // A retryable attempt may emit an error before its successor completes successfully.
    // Only terminal failures carry error so a completed result cannot retain stale attempt state.
    ...(status === 'completed' || lastError === undefined ? {} : { error: lastError }),
  };

  if (options.mode === 'text') {
    if (latestText !== '') {
      options.stdout.enqueue(latestText.endsWith('\n') ? latestText : `${latestText}\n`);
    }
    if (status !== 'completed') {
      stderr.write(
        `[coda] ${status}${lastError === undefined ? '' : `: ${sanitizeTerminalLine(lastError)}`}\n`,
      );
    }
  } else if (options.mode === 'json') {
    writeJson(result);
  } else {
    writeJson(result);
  }
  try {
    await options.stdout.drain();
  } catch (error) {
    stderr.write(`[coda] stdout write failed: ${sanitizeTerminalError(error)}\n`);
    return 1;
  }
  return exitCode;
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is Extract<AssistantMessage['content'][number], { type: 'text' }> =>
      part.type === 'text')
    .map((part) => part.text)
    .join('\n\n');
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  if (milliseconds % 60_000 === 0) return `${milliseconds / 60_000}m`;
  return `${milliseconds / 1_000}s`;
}
