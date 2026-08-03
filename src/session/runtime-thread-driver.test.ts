import { describe, expect, test } from 'bun:test';
import type {
  ExternalOpId,
  ModelConfig,
  ModelRef,
  PermissionCeilingSnapshot,
  RunId,
  ThreadId,
  ThreadUsage,
  TurnId,
  WorkspaceId,
} from '../protocol/index.js';
import { RuntimeThreadDriver } from './runtime-thread-driver.js';
import type { RuntimeThreadExecutionPort } from './runtime-thread-execution.js';
import type {
  ThreadDriverEvent,
  ThreadDriverHostServices,
} from './thread-runtime-ports.js';

const WORKSPACE_ID = 'workspace-driver-causality' as WorkspaceId;
const THREAD_ID = 'thread-driver-causality' as ThreadId;
const ROOT_OP_ID = 'op_e_10000000000000000000000000000001' as ExternalOpId;
const ABORT_OP_ID = 'op_e_10000000000000000000000000000002' as ExternalOpId;
const ROOT_RUN_ID = 'run-driver-root' as RunId;
const SUCCESSOR_RUN_ID = 'run-driver-successor' as RunId;
const MODEL: ModelConfig = {
  ref: { provider: 'faux', api: 'faux', model: 'driver-causality' },
};
const CEILING: PermissionCeilingSnapshot = { revision: 'driver-ceiling', constraints: [] };

describe('RuntimeThreadDriver causality', () => {
  test('keeps successor abort authoritative across a gated predecessor agent_end commit', async () => {
    const execution = new GatedExecution();
    const host = new GatedAgentEndHost();
    const driver = new RuntimeThreadDriver({ threadId: THREAD_ID, host, execution });
    await driver.recover([]);
    await driver.activate();

    const activity = driver.dispatch({
      op: {
        type: 'prompt',
        opId: ROOT_OP_ID,
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        text: 'retry me',
      },
      runId: ROOT_RUN_ID,
      permissionCeiling: CEILING,
      resolvedInput: { kind: 'prompt_input', sourceOpId: ROOT_OP_ID, text: 'retry me' },
    }).completion;
    const agentEnd = driver.commitExecutionEvent({
      type: 'agent_end',
      reason: 'error',
      messages: [],
      willRetry: true,
    });
    await host.agentEndCommitEntered.promise;

    expect(await driver.dispatch({
      op: {
        type: 'abort',
        opId: ABORT_OP_ID,
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        expectedRunId: SUCCESSOR_RUN_ID,
      },
      resolvedTarget: { kind: 'run', runId: SUCCESSOR_RUN_ID },
    }).completion).toEqual({ kind: 'operation', outcome: 'applied' });

    host.releaseAgentEndCommit.resolve(undefined);
    await agentEnd;
    execution.releasePrompt.resolve(undefined);
    await expect(activity).resolves.toEqual({
      kind: 'activity',
      status: 'aborted',
      terminalRunId: SUCCESSOR_RUN_ID,
    });
    expect(execution.abortCalls).toBe(1);
    await driver.close();
  });

  test('keeps a gated root agent_end authoritative over a later root abort', async () => {
    const execution = new GatedExecution();
    const host = new GatedAgentEndHost();
    const driver = new RuntimeThreadDriver({ threadId: THREAD_ID, host, execution });
    await driver.recover([]);
    await driver.activate();

    const activity = driver.dispatch({
      op: {
        type: 'prompt',
        opId: ROOT_OP_ID,
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        text: 'complete me',
      },
      runId: ROOT_RUN_ID,
      permissionCeiling: CEILING,
      resolvedInput: { kind: 'prompt_input', sourceOpId: ROOT_OP_ID, text: 'complete me' },
    }).completion;
    const agentEnd = driver.commitExecutionEvent({
      type: 'agent_end',
      reason: 'completed',
      messages: [],
    });
    await host.agentEndCommitEntered.promise;

    expect(await driver.dispatch({
      op: {
        type: 'abort',
        opId: ABORT_OP_ID,
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        expectedRunId: ROOT_RUN_ID,
      },
      resolvedTarget: { kind: 'run', runId: ROOT_RUN_ID },
    }).completion).toEqual({ kind: 'operation', outcome: 'applied' });

    host.releaseAgentEndCommit.resolve(undefined);
    await agentEnd;
    execution.releasePrompt.resolve(undefined);
    await expect(activity).resolves.toEqual({
      kind: 'activity',
      status: 'completed',
      terminalRunId: ROOT_RUN_ID,
    });
    expect(execution.abortCalls).toBe(1);
    await driver.close();
  });
});

class GatedAgentEndHost implements ThreadDriverHostServices {
  readonly agentEndCommitEntered = deferred<void>();
  readonly releaseAgentEndCommit = deferred<void>();

  async commitEvent(input: ThreadDriverEvent): Promise<void> {
    if (input.event.type !== 'agent_end') return;
    expect(input.runId).toBe(ROOT_RUN_ID);
    this.agentEndCommitEntered.resolve(undefined);
    await this.releaseAgentEndCommit.promise;
  }

  async commitEventBatch(inputs: readonly [ThreadDriverEvent, ...ThreadDriverEvent[]]): Promise<void> {
    for (const input of inputs) await this.commitEvent(input);
  }

  async reserveSuccessor(input: {
    readonly threadId: ThreadId;
    readonly predecessorRunId: RunId;
    readonly reason: 'retry' | 'compaction';
  }): Promise<{ readonly runId: RunId; readonly permissionCeiling: PermissionCeilingSnapshot }> {
    expect(input).toEqual({
      threadId: THREAD_ID,
      predecessorRunId: ROOT_RUN_ID,
      reason: 'retry',
    });
    return { runId: SUCCESSOR_RUN_ID, permissionCeiling: CEILING };
  }

  async reserveTurn(): Promise<{
    readonly turnId: TurnId;
    readonly workspaceCeiling: PermissionCeilingSnapshot;
    readonly runCeiling: PermissionCeilingSnapshot;
    readonly turnCeiling: PermissionCeilingSnapshot;
  }> {
    throw new Error('turn reservation is unused');
  }
}

class GatedExecution implements RuntimeThreadExecutionPort {
  readonly messages = [];
  readonly releasePrompt = deferred<void>();
  abortCalls = 0;

  async prompt(): Promise<void> { await this.releasePrompt.promise; }
  async continue(): Promise<void> {}
  async compact(): Promise<{ readonly aborted: boolean }> { return { aborted: false }; }
  steer(): void {}
  followUp(): void {}
  abort(): void { this.abortCalls++; }
  usage(): ThreadUsage {
    return { cumulative: { input: 0, output: 0 }, turns: 0, contextTokens: 0 };
  }
  interactionState(): 'idle' | 'running' | 'retrying' | 'compacting' { return 'running'; }
  runtimeFollowUpState(): 'idle' | 'retrying' | 'compacting' { return 'retrying'; }
  deferCompactionResumeToMailbox(): void {}
  currentModel(): ModelRef { return MODEL.ref; }
  setModel(): void {}
  compactionCheckpoint(): undefined { return undefined; }
  async close(): Promise<void> {}
  async waitForIdle(): Promise<void> {}
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  return {
    promise: new Promise<T>((resolve) => { resolvePromise = resolve; }),
    resolve(value: T): void { resolvePromise(value); },
  };
}
