// Canonical multi-thread NDJSON transport. stdin carries full RuntimeOps; stdout carries only
// the protocol hello, EventEnvelopes, receipts, and transport errors.

import { createInterface } from 'node:readline';
import process from 'node:process';
import { PROTOCOL_VERSION } from '../protocol/index.js';
import type {
  EventEnvelope,
  ExternalOpId,
  OpReceipt,
  RuntimeOp,
  ThreadId,
} from '../protocol/index.js';
import type { RuntimePort } from '../runtime/index.js';
import { sanitizeTerminalError } from './terminal-sanitize.js';

export interface HeadlessOutput {
  enqueue(chunk: string): void;
  drain(): Promise<void>;
}

export type HeadlessOutputFrame =
  | Readonly<EventEnvelope>
  | { readonly type: 'op_receipt'; readonly receipt: OpReceipt }
  | {
      readonly type: 'transport_error';
      readonly fatal: boolean;
      readonly message: string;
      readonly code?:
        | 'invalid_input'
        | 'scope_dispatch_failed'
        | 'event_subscription_gap'
        | 'runtime_event_stream_fatal';
      readonly opId?: ExternalOpId;
      readonly failedThreadIds?: readonly ThreadId[];
      readonly threadId?: ThreadId;
      readonly lastDeliveredSeq?: number;
      readonly nextAvailableSeq?: number;
      readonly causeCode?: string;
    };

export type HeadlessRuntimePort = Pick<RuntimePort, 'workspaceId' | 'submit' | 'events' | 'close'>;

export async function startHeadless(
  runtime: HeadlessRuntimePort,
  options: {
    readonly stdin: NodeJS.ReadableStream;
    readonly stdout: HeadlessOutput;
    /** Fully identified setup and prompt operations submitted after the hot subscription is installed. */
    readonly initialOps?: readonly RuntimeOp[];
  },
): Promise<number> {
  // events() is hot on return. Register before hello/readline so the first submitted lifecycle
  // op cannot outrun the transport subscription.
  const events = runtime.events();
  const initialPrompt = options.initialOps?.findLast(
    (op): op is Extract<RuntimeOp, { readonly type: 'prompt' }> => op.type === 'prompt',
  );
  const writeLine = (frame: HeadlessOutputFrame | Record<string, unknown>): void => {
    options.stdout.enqueue(`${JSON.stringify(frame)}\n`);
  };
  writeLine({
    type: 'protocol',
    protocolVersion: PROTOCOL_VERSION,
    workspaceId: runtime.workspaceId,
  });
  await options.stdout.drain();

  let settled = false;
  let accepting = true;
  let discardQueuedCommands = false;
  let shuttingDown = false;
  let requestedExitCode = 0;
  let commandTail: Promise<void> = Promise.resolve();
  let resolveExit!: (code: number) => void;
  const exit = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  const finish = (code: number): void => {
    if (settled) return;
    settled = true;
    resolveExit(code);
  };

  const beginShutdown = (
    code: number,
    source: 'transport' | 'event_stream' | 'interrupt' = 'transport',
  ): void => {
    requestedExitCode = Math.max(requestedExitCode, code);
    accepting = false;
    if (source !== 'transport') discardQueuedCommands = true;
    if (shuttingDown) return;
    shuttingDown = true;
    void Promise.resolve().then(async () => {
      try {
        if (source === 'transport') {
          // EOF is orderly: every complete line accepted before it must finish dispatching before
          // close freezes Runtime admission.
          await commandTail;
          await runtime.close();
        } else {
          // Fatal stream failure and signals must be able to interrupt an in-flight operation.
          await runtime.close();
          await commandTail;
        }
        if (source !== 'event_stream') await eventPump;
        await options.stdout.drain();
        finish(requestedExitCode);
      } catch (error) {
        try {
          writeLine({
            type: 'transport_error',
            fatal: true,
            message: `shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
          });
          await options.stdout.drain();
        } catch (outputError) {
          console.error(
            `[coda] stdout write failed during headless shutdown: ${sanitizeTerminalError(outputError)}`,
          );
        }
        finish(1);
      }
    });
  };

  const eventPump = (async () => {
    try {
      for await (const envelope of events) {
        writeLine(envelope);
        await options.stdout.drain();
        if (
          initialPrompt !== undefined &&
          envelope.threadId === initialPrompt.threadId &&
          envelope.event.type === 'agent_end' &&
          envelope.event.willRetry !== true
        ) {
          beginShutdown(envelope.event.reason === 'error' ? 1 : 0);
        }
      }
    } catch (error) {
      writeLine(streamTransportError(error));
      try {
        await options.stdout.drain();
      } catch (outputError) {
        console.error(
          `[coda] stdout write failed after runtime stream failure: ${sanitizeTerminalError(outputError)}`,
        );
      }
      beginShutdown(1, 'event_stream');
    }
  })();

  const dispatchOp = async (op: RuntimeOp): Promise<void> => {
    try {
      const receipt = await runtime.submit(op);
      writeLine({ type: 'op_receipt', receipt });
      await options.stdout.drain();
      if (initialPrompt?.opId === op.opId && !receipt.accepted) beginShutdown(1);
    } catch (error) {
      const frame = submitTransportError(error);
      writeLine(frame);
      await options.stdout.drain();
      if (frame.fatal) beginShutdown(1, 'interrupt');
    }
  };

  const dispatchLine = async (line: string): Promise<void> => {
    if (discardQueuedCommands) return;
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      writeLine(invalidInput(`invalid command: not valid JSON: ${truncate(trimmed)}`));
      await options.stdout.drain();
      return;
    }
    if (!isRecord(parsed)) {
      writeLine(invalidInput(`invalid command: expected a JSON object: ${truncate(trimmed)}`));
      await options.stdout.drain();
      return;
    }
    await dispatchOp(parsed as RuntimeOp);
  };

  const onLine = (line: string): void => {
    if (!accepting || settled) return;
    commandTail = commandTail.then(() => dispatchLine(line)).catch((error: unknown) => {
      writeLine({
        type: 'transport_error',
        fatal: true,
        message: error instanceof Error ? error.message : String(error),
      });
      beginShutdown(1);
    });
  };
  const onSignal = (): void => beginShutdown(0, 'interrupt');
  const onInputError = (error: unknown): void => {
    if (!accepting) return;
    writeLine({
      type: 'transport_error',
      fatal: true,
      message: `stdin failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    beginShutdown(1, 'interrupt');
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const readline = createInterface({ input: options.stdin, terminal: false });
  readline.on('line', onLine);
  readline.on('close', () => {
    if (initialPrompt === undefined) beginShutdown(0);
  });
  options.stdin.on('error', onInputError);

  for (const op of options.initialOps ?? []) onLine(JSON.stringify(op));

  const code = await exit;
  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGTERM', onSignal);
  options.stdin.removeListener('error', onInputError);
  readline.close();
  releaseStdin(options.stdin);
  return code;
}

function invalidInput(message: string): Extract<HeadlessOutputFrame, { type: 'transport_error' }> {
  return { type: 'transport_error', fatal: false, code: 'invalid_input', message };
}

function submitTransportError(
  error: unknown,
): Extract<HeadlessOutputFrame, { type: 'transport_error' }> {
  const record = errorRecord(error);
  if (record.code === 'scope_dispatch_failed') {
    return {
      type: 'transport_error',
      fatal: false,
      code: 'scope_dispatch_failed',
      message: errorMessage(error),
      ...(typeof record.opId === 'string' && { opId: record.opId as ExternalOpId }),
      ...(Array.isArray(record.failedThreadIds) && {
        failedThreadIds: record.failedThreadIds as ThreadId[],
      }),
    };
  }
  if (
    record.name === 'RuntimeOpValidationError' ||
    record.code === 'invalid_external_op_id' ||
    record.code === 'invalid_runtime_op'
  ) {
    return invalidInput(`invalid command: ${errorMessage(error)}`);
  }
  return { type: 'transport_error', fatal: true, message: errorMessage(error) };
}

function streamTransportError(
  error: unknown,
): Extract<HeadlessOutputFrame, { type: 'transport_error' }> {
  const record = errorRecord(error);
  if (record.code === 'event_subscription_gap') {
    return {
      type: 'transport_error',
      fatal: true,
      code: 'event_subscription_gap',
      message: errorMessage(error),
      ...(typeof record.threadId === 'string' && { threadId: record.threadId as ThreadId }),
      ...(typeof record.lastDeliveredSeq === 'number' && {
        lastDeliveredSeq: record.lastDeliveredSeq,
      }),
      ...(typeof record.nextAvailableSeq === 'number' && {
        nextAvailableSeq: record.nextAvailableSeq,
      }),
    };
  }
  return {
    type: 'transport_error',
    fatal: true,
    code: 'runtime_event_stream_fatal',
    message: errorMessage(error),
    ...(typeof record.threadId === 'string' && { threadId: record.threadId as ThreadId }),
    ...(typeof record.causeCode === 'string' && { causeCode: record.causeCode }),
  };
}

function errorRecord(error: unknown): Readonly<Record<string, unknown>> {
  return isRecord(error) ? error : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function truncate(text: string, max = 120): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function releaseStdin(stdin: NodeJS.ReadableStream): void {
  const stream = stdin as NodeJS.ReadableStream & {
    unref?: () => void;
    destroy?: () => void;
  };
  if (typeof stream.unref === 'function') stream.unref();
  else if (typeof stream.destroy === 'function') stream.destroy();
}
