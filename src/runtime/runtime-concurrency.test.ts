import { describe, expect, test } from 'bun:test';
import type {
  ExternalOpId,
  ModelConfig,
  ModelRef,
  RunId,
  RuntimeOp,
  ThreadId,
  WorkspaceId,
} from '../protocol/index.js';
import { deriveOpId } from '../protocol/index.js';
import {
  createCapabilityRegistry,
  createPolicyEngine,
  createPromptAssembler,
  createProviderAdapterRegistry,
} from '../capabilities/index.js';
import type { RuntimeCapabilityServices } from '../capabilities/index.js';
import { createMemoryRuntimeStorage } from './memory-storage.js';
import type {
  PermissionPolicyPort,
  PreparedThreadDriverCommand,
  RuntimeIdentityFactory,
  RuntimeThreadDriverFactory,
  ThreadDriverCompletion,
  ThreadDriverHostServices,
  RuntimeThreadDriverAttachment,
  ThreadDriverPort,
} from './ports.js';
import { createRuntime } from './supervisor.js';
import { emptyCheckpoint } from '../session/thread-journal.js';

const WORKSPACE_ID = 'ws_runtime_concurrency' as WorkspaceId;
const CWD = '/runtime/concurrency';
const MODEL: ModelConfig = { ref: { provider: 'faux', api: 'faux', model: 'test' } };

describe('Supervisor and per-thread runtime', () => {
  test('does not piggyback a concurrent different payload with the same OpId', async () => {
    const fixture = await runtimeFixture();
    const threadId = fixture.runtime.newThreadId();
    await createThread(fixture, threadId);
    const gate = deferred<void>();
    const entered = deferred<void>();
    fixture.policy.nextRunGate = { entered, release: gate };
    const opId = fixture.runtime.newOpId();
    const first = fixture.runtime.submit(prompt(opId, threadId, 'first'));
    await entered.promise;
    const conflict = await fixture.runtime.submit(prompt(opId, threadId, 'different'));
    expect(conflict).toMatchObject({ accepted: false, duplicate: false, reason: 'op_id_conflict' });
    gate.resolve();
    const accepted = await first;
    expect(accepted).toMatchObject({ accepted: true, duplicate: false });
    fixture.drivers.complete(threadId, accepted.accepted ? accepted.runId : undefined, 'completed');
    await fixture.runtime.close();
  });

  test('runs different threads independently, rejects a second task on one thread, and isolates abort', async () => {
    const fixture = await runtimeFixture();
    const left = fixture.runtime.newThreadId();
    const right = fixture.runtime.newThreadId();
    await createThread(fixture, left);
    await createThread(fixture, right);

    const leftReceipt = await fixture.runtime.submit(prompt(fixture.runtime.newOpId(), left, 'left'));
    const rightReceipt = await fixture.runtime.submit(prompt(fixture.runtime.newOpId(), right, 'right'));
    expect(leftReceipt.accepted).toBe(true);
    expect(rightReceipt.accepted).toBe(true);
    expect(fixture.drivers.promptDispatches(left)).toBe(1);
    expect(fixture.drivers.promptDispatches(right)).toBe(1);

    const busy = await fixture.runtime.submit(prompt(fixture.runtime.newOpId(), left, 'left-again'));
    expect(busy).toMatchObject({
      accepted: false,
      reason: 'thread_busy_use_steer_or_follow_up',
    });

    const abortReceipt = await fixture.runtime.submit({
      type: 'abort',
      opId: fixture.runtime.newOpId(),
      workspaceId: WORKSPACE_ID,
      threadId: left,
      expectedRunId: leftReceipt.accepted ? leftReceipt.runId : undefined,
    });
    expect(abortReceipt.accepted).toBe(true);
    expect(fixture.drivers.abortDispatches(left)).toBe(1);
    expect(fixture.drivers.abortDispatches(right)).toBe(0);
    expect(fixture.drivers.hasPending(right, rightReceipt.accepted ? rightReceipt.runId : undefined)).toBe(true);

    fixture.drivers.complete(right, rightReceipt.accepted ? rightReceipt.runId as RunId : undefined, 'completed');
    await fixture.runtime.close();
  });

  test('returns a durable duplicate receipt without dispatching a second time', async () => {
    const fixture = await runtimeFixture();
    const threadId = fixture.runtime.newThreadId();
    await createThread(fixture, threadId);
    const op = prompt(fixture.runtime.newOpId(), threadId, 'once');
    const first = await fixture.runtime.submit(op);
    const duplicate = await fixture.runtime.submit(op);
    expect(first).toMatchObject({ accepted: true, duplicate: false });
    expect(duplicate).toMatchObject({ accepted: true, duplicate: true, runId: first.accepted ? first.runId : undefined });
    expect(fixture.drivers.promptDispatches(threadId)).toBe(1);
    fixture.drivers.complete(threadId, first.accepted ? first.runId as RunId : undefined, 'completed');
    await fixture.runtime.close();
  });

  test('allocates sequence numbers independently per thread', async () => {
    const fixture = await runtimeFixture();
    const left = fixture.runtime.newThreadId();
    const right = fixture.runtime.newThreadId();
    await createThread(fixture, left);
    await createThread(fixture, right);
    const controller = new AbortController();
    const iterable = fixture.runtime.events({
      threadIds: [left, right],
      cursors: [{ threadId: left, afterSeq: 0 }, { threadId: right, afterSeq: 0 }],
      signal: controller.signal,
    });
    const iterator = iterable[Symbol.asyncIterator]();
    const received = [];
    for (let index = 0; index < 6; index++) {
      const item = await iterator.next();
      if (!item.done) received.push(item.value);
    }
    controller.abort();
    expect(received.filter((event) => event.threadId === left).map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(received.filter((event) => event.threadId === right).map((event) => event.seq)).toEqual([1, 2, 3]);
    await fixture.runtime.close();
  });
});

async function runtimeFixture(): Promise<{
  runtime: Awaited<ReturnType<typeof createRuntime>>;
  drivers: FakeDriverFactory;
  policy: FakePolicy;
  model: ModelConfig;
}> {
  const drivers = new FakeDriverFactory();
  const policy = new FakePolicy();
  const runtime = await createRuntime({
    workspace: { cwd: CWD, workspaceId: WORKSPACE_ID },
    storage: createMemoryRuntimeStorage(),
    modelResolver: {
      async resolve(ref): Promise<{ ok: true; model: ModelConfig }> {
        return { ok: true, model: { ...MODEL, ref } };
      },
    },
    permissionPolicy: policy,
    threadDriverFactory: drivers,
    capabilityServices: capabilityServices(),
    identityFactory: new FakeIdentityFactory(),
    clock: { now: () => 1 },
  });
  return { runtime, drivers, policy, model: MODEL };
}

async function createThread(
  fixture: Awaited<ReturnType<typeof runtimeFixture>>,
  threadId: ThreadId,
): Promise<void> {
  const receipt = await fixture.runtime.submit({
    type: 'thread_create',
    opId: fixture.runtime.newOpId(),
    workspaceId: WORKSPACE_ID,
    threadId,
    model: fixture.model.ref,
  });
  expect(receipt.accepted).toBe(true);
}

function prompt(opId: ExternalOpId, threadId: ThreadId, text: string): Extract<RuntimeOp, { type: 'prompt' }> {
  return { type: 'prompt', opId, workspaceId: WORKSPACE_ID, threadId, text };
}

class FakeIdentityFactory implements RuntimeIdentityFactory {
  #thread = 0;
  #run = 0;
  #turn = 0;
  #op = 0;

  newThreadId(): ThreadId { return `th_test_${++this.#thread}` as ThreadId; }
  newRunId(): RunId { return `run_test_${++this.#run}` as RunId; }
  newTurnId(): import('../protocol/index.js').TurnId {
    return `turn_test_${++this.#turn}` as import('../protocol/index.js').TurnId;
  }
  newOpId(): ExternalOpId {
    return `op_e_${(++this.#op).toString(16).padStart(32, '0')}` as ExternalOpId;
  }
  newProcessEpoch(): string { return 'test-process-epoch'; }
  deriveOpId(input: Parameters<typeof deriveOpId>[0]): ReturnType<typeof deriveOpId> { return deriveOpId(input); }
}

class FakePolicy implements PermissionPolicyPort {
  nextRunGate: { entered: Deferred<void>; release: Deferred<void> } | undefined;

  async snapshotWorkspaceCeiling(): Promise<{ revision: string; constraints: readonly [] }> {
    return { revision: 'workspace', constraints: [] };
  }

  async resolveCeiling(input: Parameters<PermissionPolicyPort['resolveCeiling']>[0]): Promise<{
    revision: string; constraints: readonly [];
  }> {
    if (input.kind === 'run' && this.nextRunGate !== undefined) {
      const gate = this.nextRunGate;
      this.nextRunGate = undefined;
      gate.entered.resolve();
      await gate.release.promise;
    }
    return { revision: input.kind, constraints: [] };
  }
}

class FakeDriverFactory implements RuntimeThreadDriverFactory {
  readonly #drivers = new Map<ThreadId, FakeDriver>();

  async create(input: {
    readonly threadId: ThreadId;
    readonly model: ModelConfig;
  }, host: ThreadDriverHostServices): Promise<RuntimeThreadDriverAttachment> {
    void host;
    return this.#attachment(input.threadId, input.model.ref);
  }

  async resume(input: {
    readonly threadId: ThreadId;
    readonly model: ModelConfig;
    readonly committedCheckpoint: import('./ports.js').ThreadDriverCheckpoint;
  }, host: ThreadDriverHostServices): Promise<RuntimeThreadDriverAttachment> {
    void host;
    const attachment = this.#attachment(input.threadId, input.model.ref);
    return { ...attachment, initialCheckpoint: input.committedCheckpoint };
  }

  complete(threadId: ThreadId, runId: RunId | undefined, status: 'completed' | 'aborted' | 'error'): void {
    if (runId === undefined) throw new Error('Missing run id');
    this.#drivers.get(threadId)?.complete(runId, status);
  }

  promptDispatches(threadId: ThreadId): number { return this.#drivers.get(threadId)?.promptCount ?? 0; }
  abortDispatches(threadId: ThreadId): number { return this.#drivers.get(threadId)?.abortCount ?? 0; }
  hasPending(threadId: ThreadId, runId: RunId | undefined): boolean {
    return runId !== undefined && (this.#drivers.get(threadId)?.hasPending(runId) ?? false);
  }

  #attachment(threadId: ThreadId, model: ModelRef): RuntimeThreadDriverAttachment {
    const driver = new FakeDriver();
    this.#drivers.set(threadId, driver);
    return {
      driver,
      initialCheckpoint: emptyCheckpoint(model),
    };
  }
}

function capabilityServices(): RuntimeCapabilityServices {
  return {
    capabilities: createCapabilityRegistry(),
    providers: createProviderAdapterRegistry(),
    promptAssembler: createPromptAssembler(),
    basePrompts: {
      async capture(input) {
        return { owner: input.context, model: input.model.ref, revision: 'base-v1', content: '' };
      },
    },
    ruleSnapshots: {
      async capture(input) {
        return {
          ok: true,
          snapshot: {
            revision: 'rules-v1',
            owner: input.context,
            discovery: {
              knownResourceScopes: [...input.knownResourceScopes],
              budget: input.budget,
              diagnostics: [],
            },
            files: [],
          },
        };
      },
    },
    ruleBudget: { maxFiles: 1, maxFileBytes: 1_024, maxBytes: 1_024, maxPromptTokens: 256 },
    policyEngine: createPolicyEngine(),
    ruleFreshness: { async check() { return { fresh: true }; } },
  };
}

class FakeDriver implements ThreadDriverPort {
  promptCount = 0;
  abortCount = 0;
  readonly #pending = new Map<RunId, Deferred<ThreadDriverCompletion>>();

  async recover(): Promise<void> {}
  async activate(): Promise<void> {}

  dispatch(command: PreparedThreadDriverCommand): { completion: Promise<ThreadDriverCompletion> } {
    if ((command.op.type === 'prompt' || command.op.type === 'continue') && 'runId' in command) {
      this.promptCount++;
      const completion = deferred<ThreadDriverCompletion>();
      this.#pending.set(command.runId, completion);
      return { completion: completion.promise };
    }
    if (command.op.type === 'abort' && 'resolvedTarget' in command) {
      this.abortCount++;
      if (command.resolvedTarget.kind === 'run') {
        this.complete(command.resolvedTarget.runId, 'aborted');
      }
      return { completion: Promise.resolve({ kind: 'operation', outcome: 'applied' }) };
    }
    return { completion: Promise.resolve({ kind: 'operation', outcome: 'applied' }) };
  }

  interactionState(): 'idle' | 'running' { return this.#pending.size === 0 ? 'idle' : 'running'; }

  async close(): Promise<void> {
    for (const runId of [...this.#pending.keys()]) this.complete(runId, 'aborted');
  }

  complete(runId: RunId, status: 'completed' | 'aborted' | 'error'): void {
    const pending = this.#pending.get(runId);
    if (pending === undefined) return;
    this.#pending.delete(runId);
    pending.resolve({ kind: 'activity', status, terminalRunId: runId });
  }

  hasPending(runId: RunId): boolean { return this.#pending.has(runId); }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return {
    promise,
    resolve(value: T): void {
      if (resolvePromise === undefined) throw new Error('Deferred is not initialized');
      resolvePromise(value);
    },
  };
}
