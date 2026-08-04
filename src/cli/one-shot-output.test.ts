import { describe, expect, it } from 'bun:test';
import { PROTOCOL_VERSION } from '../protocol/index.js';
import type {
  AgentMessage,
  AssistantMessage,
  EventEnvelope,
  ExternalOpId,
  RunId,
  ThreadId,
  TurnId,
  UserMessage,
  WorkspaceId,
} from '../protocol/index.js';
import type { CliSession } from './interactive-runtime.js';
import type {
  CliRuntimeEnvelopeListener,
  CliRuntimeEvent,
  CliRuntimeEventListener,
} from './frontend-types.js';
import { createOrderedOutput } from '../shared/ordered-output.js';
import { startOneShotOutput } from './one-shot-output.js';

const MODEL = { provider: 'faux', api: 'faux', model: 'test' } as const;
const WORKSPACE_ID = 'workspace-one-shot' as WorkspaceId;
const THREAD_ID = 'thread-one-shot' as ThreadId;
const RUN_ID = 'run-one-shot' as RunId;
const TURN_ID = 'turn-one-shot' as TurnId;
const OP_ID = 'op_e_00000000000000000000000000000001' as ExternalOpId;
const EMPTY_USAGE = {
  cumulative: { input: 3, output: 2 },
  turns: 1,
  contextTokens: 5,
} as const;

class ScriptedSession implements CliSession {
  readonly #listeners = new Set<CliRuntimeEventListener>();
  readonly #envelopeListeners = new Set<CliRuntimeEnvelopeListener>();
  readonly messages: readonly AgentMessage[] = [];
  readonly #answer: string;
  readonly #failure: boolean;
  readonly #waitForAbort: boolean;
  readonly #retryThenSuccess: boolean;
  readonly #delayAfterTerminalMs: number;
  #finishPrompt: (() => void) | undefined;
  #seq = 0;
  abortCalls = 0;
  closed = false;

  constructor(options: {
    answer?: string;
    failure?: boolean;
    waitForAbort?: boolean;
    retryThenSuccess?: boolean;
    delayAfterTerminalMs?: number;
  } = {}) {
    this.#answer = options.answer ?? 'final answer';
    this.#failure = options.failure ?? false;
    this.#waitForAbort = options.waitForAbort ?? false;
    this.#retryThenSuccess = options.retryThenSuccess ?? false;
    this.#delayAfterTerminalMs = options.delayAfterTerminalMs ?? 0;
  }

  interactionState(): 'idle' {
    return 'idle';
  }

  currentModel(): typeof MODEL {
    return MODEL;
  }

  usage(): typeof EMPTY_USAGE {
    return EMPTY_USAGE;
  }

  subscribe(listener: CliRuntimeEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  subscribeEnvelopes(listener: CliRuntimeEnvelopeListener): () => void {
    this.#envelopeListeners.add(listener);
    return () => this.#envelopeListeners.delete(listener);
  }

  async prompt(text: string): Promise<void> {
    this.#emit({ type: 'agent_start', reason: 'prompt' });
    this.#emit({ type: 'message_start', message: user(text) });
    if (this.#waitForAbort) {
      await new Promise<void>((resolve) => {
        this.#finishPrompt = resolve;
      });
      return;
    }
    if (this.#retryThenSuccess) {
      this.#emit({ type: 'error', fatal: false, message: 'retryable provider failure' });
      this.#emit({
        type: 'retry_scheduled',
        attempt: 1,
        maxAttempts: 2,
        delayMs: 1,
        errorMessage: 'retryable provider failure',
        predecessorRunId: 'run-retry-1' as RunId,
        successorRunId: 'run-retry-2' as RunId,
      });
      this.#emit({ type: 'agent_end', reason: 'error', messages: [], willRetry: true });
      this.#emit({ type: 'agent_start', reason: 'continue' });
    }
    const message = assistant(this.#answer, this.#failure ? 'error' : 'stop');
    this.#emit({ type: 'message_end', message });
    if (this.#failure) this.#emit({ type: 'error', fatal: false, message: 'provider failed' });
    this.#emit({
      type: 'agent_end',
      reason: this.#failure ? 'error' : 'completed',
      messages: [message],
    });
    if (this.#delayAfterTerminalMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.#delayAfterTerminalMs));
    }
  }

  steer(): void {}

  followUp(): void {}

  abort(): void {
    this.abortCalls++;
    if (!this.#waitForAbort || this.#finishPrompt === undefined) return;
    this.#emit({ type: 'agent_end', reason: 'aborted', messages: [] });
    this.#finishPrompt();
    this.#finishPrompt = undefined;
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  #emit(event: CliRuntimeEvent): void {
    this.#seq++;
    const turnScoped = event.type === 'message_start' || event.type === 'message_end';
    const envelope: Readonly<EventEnvelope> = {
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      runId: event.type === 'retry_scheduled' ? event.successorRunId : RUN_ID,
      ...(turnScoped ? { turnId: TURN_ID } : {}),
      ...(event.type === 'agent_start' || event.type === 'agent_end' ? { opId: OP_ID } : {}),
      seq: this.#seq,
      timestamp: 1_700_000_000_000 + this.#seq,
      event,
    };
    for (const listener of [...this.#envelopeListeners]) void listener(envelope);
    for (const listener of [...this.#listeners]) void listener(event);
  }
}

describe('opt-in one-shot output adapter', () => {
  it('writes human progress to stderr and only the final response to stdout', async () => {
    const io = output();
    const code = await startOneShotOutput(new ScriptedSession({ answer: 'hello\nworld' }), {
      prompt: 'go',
      mode: 'text',
      finalOnly: false,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(0);
    expect(io.out()).toBe('hello\nworld\n');
    expect(io.err()).toContain('[coda] running');
  });

  it('emits one stable result object for JSON and keeps failures non-zero', async () => {
    const io = output();
    const code = await startOneShotOutput(new ScriptedSession({ failure: true }), {
      prompt: 'fail',
      mode: 'json',
      finalOnly: false,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(1);
    expect(io.err()).toBe('');
    expect(io.lines()).toEqual([{
      type: 'result',
      version: 1,
      status: 'error',
      exitCode: 1,
      text: 'final answer',
      usage: EMPTY_USAGE,
      error: 'provider failed',
    }]);
  });

  it('streams complete envelopes in prompt lifecycle order, or only the result with --final-only', async () => {
    for (const finalOnly of [false, true]) {
      const io = output();
      expect(await startOneShotOutput(new ScriptedSession(), {
        prompt: 'stream',
        mode: 'stream-json',
        finalOnly,
        stdout: io.stdout,
        stderr: io.stderr,
      })).toBe(0);
      const records = io.lines();
      expect(records.at(-1)).toMatchObject({ type: 'result', status: 'completed', exitCode: 0 });
      if (finalOnly) expect(records).toHaveLength(1);
      else {
        expect(records[0]).toEqual({
          type: 'stream_start',
          version: 1,
          protocolVersion: PROTOCOL_VERSION,
        });
        const eventRecords = records.filter((record) => record['type'] === 'event');
        expect(eventRecords.map((record) =>
          (record['envelope'] as EventEnvelope).event.type)).toEqual([
          'agent_start',
          'message_start',
          'message_end',
          'agent_end',
        ]);
        expect(eventRecords[0]).toEqual({
          type: 'event',
          envelope: {
            workspaceId: WORKSPACE_ID,
            threadId: THREAD_ID,
            runId: RUN_ID,
            opId: OP_ID,
            seq: 1,
            timestamp: 1_700_000_000_001,
            event: { type: 'agent_start', reason: 'prompt' },
          },
        });
        expect(eventRecords[1]).toMatchObject({
          envelope: {
            workspaceId: WORKSPACE_ID,
            threadId: THREAD_ID,
            runId: RUN_ID,
            turnId: TURN_ID,
            seq: 2,
            timestamp: 1_700_000_000_002,
          },
        });
        expect(eventRecords.every((record) => record['event'] === undefined)).toBe(true);
      }
    }
  });

  it('does not leak an earlier retry error into a completed terminal result', async () => {
    const io = output();
    expect(await startOneShotOutput(new ScriptedSession({ retryThenSuccess: true }), {
      prompt: 'recover',
      mode: 'json',
      finalOnly: true,
      stdout: io.stdout,
      stderr: io.stderr,
    })).toBe(0);
    expect(io.lines()).toEqual([{
      type: 'result',
      version: 1,
      status: 'completed',
      exitCode: 0,
      text: 'final answer',
      usage: EMPTY_USAGE,
    }]);
  });

  it('aborts the current run at timeout and reports conventional exit 124', async () => {
    const io = output();
    const code = await startOneShotOutput(new ScriptedSession({ waitForAbort: true }), {
      prompt: 'wait',
      mode: 'json',
      finalOnly: true,
      timeoutMs: 5,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(124);
    expect(io.lines()).toEqual([{
      type: 'result',
      version: 1,
      status: 'timeout',
      exitCode: 124,
      text: '',
      usage: EMPTY_USAGE,
    }]);
  });

  it('cancels the deadline at the terminal event even when prompt cleanup resolves later', async () => {
    const io = output();
    const code = await startOneShotOutput(
      new ScriptedSession({ delayAfterTerminalMs: 20 }),
      {
        prompt: 'finish near the deadline',
        mode: 'json',
        finalOnly: true,
        timeoutMs: 5,
        stdout: io.stdout,
        stderr: io.stderr,
      },
    );
    expect(code).toBe(0);
    expect(io.lines()).toEqual([{
      type: 'result',
      version: 1,
      status: 'completed',
      exitCode: 0,
      text: 'final answer',
      usage: EMPTY_USAGE,
    }]);
  });

  it('aborts and closes the run as soon as ordered stream stdout breaks', async () => {
    const failure = new Error('broken pipe');
    const written: string[] = [];
    let writeCalls = 0;
    const stdout = createOrderedOutput({
      write(chunk) {
        writeCalls++;
        if (writeCalls === 2) throw failure;
        written.push(chunk);
        return chunk.length;
      },
      flush: () => 0,
    });
    let stderr = '';
    const session = new ScriptedSession({ waitForAbort: true });

    const code = await startOneShotOutput(session, {
      prompt: 'must stop with the pipe',
      mode: 'stream-json',
      finalOnly: false,
      stdout,
      fatalSignal: stdout.failureSignal,
      stderr: {
        write(chunk) {
          stderr += String(chunk);
          return true;
        },
      },
    });

    expect(code).toBe(1);
    expect(session.abortCalls).toBe(1);
    expect(session.closed).toBe(true);
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0] as string)).toMatchObject({ type: 'stream_start' });
    expect(stderr).toContain('[coda] stdout write failed: broken pipe');
  });
});

function assistant(text: string, stopReason: AssistantMessage['stopReason']): AssistantMessage {
  return {
    role: 'assistant',
    id: 'assistant-1',
    timestamp: 2,
    content: [{ type: 'text', text }],
    model: MODEL,
    stopReason,
    usage: { input: 3, output: 2 },
    ...(stopReason === 'error' ? { errorMessage: 'provider failed' } : {}),
  };
}

function user(text: string): UserMessage {
  return {
    role: 'user',
    id: 'user-1',
    timestamp: 1,
    content: [{ type: 'text', text }],
    source: 'prompt',
  };
}

function output(): {
  readonly stdout: { enqueue(chunk: string): void; drain(): Promise<void> };
  readonly stderr: { write(chunk: string | Uint8Array): boolean };
  readonly out: () => string;
  readonly err: () => string;
  readonly lines: () => Record<string, unknown>[];
} {
  let stdout = '';
  let stderr = '';
  return {
    stdout: {
      enqueue: (chunk) => { stdout += chunk; },
      drain: () => Promise.resolve(),
    },
    stderr: {
      write: (chunk) => {
        stderr += String(chunk);
        return true;
      },
    },
    out: () => stdout,
    err: () => stderr,
    lines: () => stdout.trimEnd().split('\n').filter(Boolean).map((line) =>
      JSON.parse(line) as Record<string, unknown>),
  };
}
