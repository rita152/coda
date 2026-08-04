import { describe, expect, test } from 'bun:test';
import type {
  AssistantMessage,
  ExternalOpId,
  ModelConfig,
  PermissionCeilingSnapshot,
  RunId,
  StreamFn,
  ThreadId,
  TurnId,
  WorkspaceId,
} from '../../protocol/index.js';
import { ProviderEventStream } from '../../protocol/index.js';
import { emptyCheckpoint } from '../../session/index.js';
import type {
  ThreadDriverHostServices,
  ThreadDriverCheckpoint,
} from '../../session/index.js';
import type { ThreadDriverEvent } from '../../session/thread-runtime-ports.js';
import { createRuntimeThreadDriverFactory } from './index.js';

const WORKSPACE_ID = 'workspace-runtime-driver-factory' as WorkspaceId;
const THREAD_ID = 'thread-runtime-driver-factory' as ThreadId;
const ROOT_OP_ID = 'op_e_f0000000000000000000000000000001' as ExternalOpId;
const ROOT_RUN_ID = 'run-runtime-driver-factory-root' as RunId;
const TURN_ID = 'turn-runtime-driver-factory-1' as TurnId;
const MODEL: ModelConfig = {
  ref: { provider: 'faux', api: 'faux', model: 'runtime-driver-factory' },
};
const CEILING: PermissionCeilingSnapshot = {
  revision: 'runtime-driver-factory-ceiling',
  constraints: [],
};
const UNUSED_STREAM: StreamFn = () => new ProviderEventStream();
type CapturedRuntimeTurn = Awaited<ReturnType<
  NonNullable<ThreadDriverHostServices['captureRuntimeTurn']>
>>;

describe('createRuntimeThreadDriverFactory', () => {
  test('create defaults to an empty checkpoint and snapshots an explicit initial checkpoint', async () => {
    const factory = createFactory();
    const emptyAttachment = await factory.create({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      model: MODEL,
      permissionCeiling: CEILING,
    }, new RegistryCaptureHost(UNUSED_STREAM));
    expect(emptyAttachment.initialCheckpoint).toEqual(emptyCheckpoint(MODEL.ref));
    await emptyAttachment.driver.close();

    const initialCheckpoint = checkpointWithPlan('created from seed');
    const seededAttachment = await factory.create({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      model: MODEL,
      permissionCeiling: CEILING,
      initialCheckpoint,
    }, new RegistryCaptureHost(UNUSED_STREAM));
    expect(seededAttachment.initialCheckpoint).toEqual(initialCheckpoint);
    expect(seededAttachment.initialCheckpoint).not.toBe(initialCheckpoint);
    await seededAttachment.driver.close();
  });

  test('resume snapshots the exact committed checkpoint without a secondary identity', async () => {
    const committedCheckpoint = checkpointWithPlan('committed before resume');
    const attachment = await createFactory().resume({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      model: MODEL,
      permissionCeiling: CEILING,
      committedCheckpoint,
      usedRequestIds: ['request-already-used'],
    }, new RegistryCaptureHost(UNUSED_STREAM));

    expect(attachment.initialCheckpoint).toEqual(committedCheckpoint);
    expect(attachment.initialCheckpoint).not.toBe(committedCheckpoint);
    expect(Object.keys(attachment).sort()).toEqual(['driver', 'initialCheckpoint']);
    await attachment.driver.close();
  });

  test('runs a prompt through the real driver and registry turn capture with canonical causality', async () => {
    const streamFn = createTextStreamFn('captured reply');
    const host = new RegistryCaptureHost(streamFn);
    const attachment = await createFactory().create({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      model: MODEL,
      permissionCeiling: CEILING,
    }, host);
    await attachment.driver.recover([]);
    await attachment.driver.activate();

    const completion = await attachment.driver.dispatch({
      op: {
        type: 'prompt',
        opId: ROOT_OP_ID,
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        text: 'capture this prompt',
      },
      runId: ROOT_RUN_ID,
      permissionCeiling: CEILING,
      resolvedInput: {
        kind: 'prompt_input',
        sourceOpId: ROOT_OP_ID,
        text: 'capture this prompt',
      },
    }).completion;

    expect(completion).toEqual({
      kind: 'activity',
      status: 'completed',
      terminalRunId: ROOT_RUN_ID,
    });
    expect(host.captureCalls).toHaveLength(1);
    expect(host.captureCalls[0]).toMatchObject({
      rootOpId: ROOT_OP_ID,
      runId: ROOT_RUN_ID,
      turnId: TURN_ID,
      model: MODEL,
    });
    expect(host.timeline.slice(0, 4)).toEqual([
      'commit:agent_start',
      'reserve:turn',
      'capture:registry_turn',
      'commit:turn_start',
    ]);
    expect(host.events.find((input) => input.event.type === 'agent_start')).toMatchObject({
      opId: ROOT_OP_ID,
      runId: ROOT_RUN_ID,
    });
    expect(host.events.find((input) => input.event.type === 'turn_start')).toMatchObject({
      runId: ROOT_RUN_ID,
      turnId: TURN_ID,
    });
    expect(host.events.find((input) => input.event.type === 'agent_end')).toMatchObject({
      event: { type: 'agent_end', reason: 'completed' },
      opId: ROOT_OP_ID,
      runId: ROOT_RUN_ID,
    });
    expect(streamFn.calls[0]?.context.systemPrompt).toBe('registry-captured');
    expect(streamFn.calls[0]?.context.messages[0]).toMatchObject({
      role: 'user',
      source: 'prompt',
      content: [{ type: 'text', text: 'capture this prompt' }],
    });
    await attachment.driver.close();
  });
});

function createFactory() {
  return createRuntimeThreadDriverFactory({
    configure: () => ({ compactionStreamFn: UNUSED_STREAM }),
  });
}

function createTextStreamFn(text: string): StreamFn & {
  readonly calls: Array<{ readonly context: Parameters<StreamFn>[1] }>;
} {
  const calls: Array<{ readonly context: Parameters<StreamFn>[1] }> = [];
  const streamFn: StreamFn = (model, context) => {
    calls.push({ context });
    const stream = new ProviderEventStream();
    const partial: AssistantMessage = {
      role: 'assistant',
      id: 'assistant-runtime-driver-factory',
      timestamp: 1,
      content: [],
      model: model.ref,
      stopReason: 'stop',
      usage: { input: 1, output: 1 },
    };
    stream.push({ type: 'start', partial });
    const part = { type: 'text' as const, text: '' };
    partial.content.push(part);
    stream.push({ type: 'text_start', contentIndex: 0, partial });
    part.text = text;
    stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial });
    stream.push({ type: 'text_end', contentIndex: 0, content: text, partial });
    stream.push({ type: 'done', message: partial });
    stream.end(partial);
    return stream;
  };
  return Object.assign(streamFn, { calls });
}

function checkpointWithPlan(step: string): ThreadDriverCheckpoint {
  const checkpoint = emptyCheckpoint(MODEL.ref);
  return {
    ...checkpoint,
    frontend: {
      ...checkpoint.frontend,
      plan: [{ step, status: 'pending' }],
    },
  };
}

class RegistryCaptureHost implements ThreadDriverHostServices {
  readonly events: ThreadDriverEvent[] = [];
  readonly timeline: string[] = [];
  readonly captureCalls: Array<Parameters<
    NonNullable<ThreadDriverHostServices['captureRuntimeTurn']>
  >[0]> = [];

  constructor(private readonly streamFn: StreamFn) {}

  async commitEvent(input: ThreadDriverEvent): Promise<void> {
    if (input.event.type === 'turn_start' && this.captureCalls.length === 0) {
      throw new Error('turn_start committed before registry capture');
    }
    this.timeline.push(`commit:${input.event.type}`);
    this.events.push(input);
  }

  async commitEventBatch(
    inputs: readonly [ThreadDriverEvent, ...ThreadDriverEvent[]],
  ): Promise<void> {
    for (const input of inputs) await this.commitEvent(input);
  }

  async reserveSuccessor(): Promise<{
    readonly runId: RunId;
    readonly permissionCeiling: PermissionCeilingSnapshot;
  }> {
    throw new Error('successor reservation is unexpected on the prompt happy path');
  }

  async reserveTurn(input: {
    readonly runId: RunId;
    readonly turnOrdinal: number;
  }): Promise<{
    readonly turnId: TurnId;
    readonly workspaceCeiling: PermissionCeilingSnapshot;
    readonly runCeiling: PermissionCeilingSnapshot;
    readonly turnCeiling: PermissionCeilingSnapshot;
  }> {
    expect(input).toEqual({ runId: ROOT_RUN_ID, turnOrdinal: 1 });
    this.timeline.push('reserve:turn');
    return {
      turnId: TURN_ID,
      workspaceCeiling: CEILING,
      runCeiling: CEILING,
      turnCeiling: CEILING,
    };
  }

  async captureRuntimeTurn(
    input: Parameters<NonNullable<ThreadDriverHostServices['captureRuntimeTurn']>>[0],
  ): Promise<CapturedRuntimeTurn> {
    this.captureCalls.push(input);
    this.timeline.push('capture:registry_turn');
    return {
      streamFn: this.streamFn,
      assemble: (messages) => ({
        ok: true,
        context: {
          systemPrompt: 'registry-captured',
          messages: [...messages],
          tools: [],
        },
      }),
      prepareToolCall: async () => ({ ok: false, message: 'unexpected tool call' }),
    };
  }
}
