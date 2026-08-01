import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'bun:test';
import { z } from 'zod';
import type {
  AgentMessage,
  EventEnvelope,
  ExternalOpId,
  ModelConfig,
  PermissionCeilingSnapshot,
  RunId,
  ThreadId,
  TurnId,
  WorkspaceId,
} from '../../protocol/index.js';
import { createFauxStreamFn, createGate } from '../../providers/faux/index.js';
import {
  createFileRuntimeStorage,
  createMemoryRuntimeStorage,
  createRuntime,
} from '../../runtime/index.js';
import type {
  LegacyApprovalAdapterFactory,
  LegacyApprovalPatternRepositoryPort,
  PermissionPolicyPort,
  ThreadDriverCheckpoint,
  ThreadDriverEvent,
  ThreadDriverHostServices,
} from '../../runtime/ports.js';
import { loadSession, Session } from '../../session/index.js';
import type { ModelPricing } from '../../session/index.js';
import { LegacyThreadExecution } from '../../session/legacy-thread-execution.js';
import type { ToolDefinition } from '../../tools/types.js';
import {
  createLegacySessionThreadDriverFactory,
  LegacySessionCheckpointMismatchError,
} from './index.js';

const MODEL: ModelConfig = { ref: { provider: 'faux', api: 'faux', model: 'test' } };
const WORKSPACE_ID = 'workspace-test' as WorkspaceId;
const THREAD_ID = 'thread-test' as ThreadId;
const RUN_ID = 'run-test' as RunId;
const OP_ID = 'op_e_11111111111111111111111111111111' as ExternalOpId;
const CEILING: PermissionCeilingSnapshot = { revision: 'ceiling-v1', constraints: [] };

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'coda-legacy-driver-'));
  dirs.push(dir);
  return dir;
}

function host(options?: {
  failType?: ThreadDriverEvent['event']['type'];
  failFirstTurnReservation?: boolean;
}): {
  readonly port: ThreadDriverHostServices;
  readonly events: ThreadDriverEvent[];
  readonly batches: ThreadDriverEvent[][];
  readonly actions: string[];
  readonly turnOrdinals: number[];
  readonly waitForEventCount: (
    type: ThreadDriverEvent['event']['type'],
    count: number,
  ) => Promise<void>;
} {
  const events: ThreadDriverEvent[] = [];
  const batches: ThreadDriverEvent[][] = [];
  const actions: string[] = [];
  const turnOrdinals: number[] = [];
  const waiters: {
    readonly type: ThreadDriverEvent['event']['type'];
    readonly count: number;
    readonly resolve: () => void;
  }[] = [];
  let turn = 0;
  let successor = 0;
  const notify = (): void => {
    for (let index = waiters.length - 1; index >= 0; index--) {
      const waiter = waiters[index] as (typeof waiters)[number];
      if (events.filter((event) => event.event.type === waiter.type).length >= waiter.count) {
        waiters.splice(index, 1);
        waiter.resolve();
      }
    }
  };
  return {
    events,
    batches,
    actions,
    turnOrdinals,
    waitForEventCount: (type, count) => {
      if (events.filter((event) => event.event.type === type).length >= count) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => waiters.push({ type, count, resolve }));
    },
    port: {
      commitEvent: async (event) => {
        if (event.event.type === options?.failType) throw new Error(`commit failed: ${event.event.type}`);
        actions.push(`commit:${event.event.type}`);
        events.push(event);
        notify();
      },
      commitEventBatch: async (batch) => {
        const failed = batch.find((event) => event.event.type === options?.failType);
        if (failed !== undefined) throw new Error(`commit failed: ${failed.event.type}`);
        batches.push([...batch]);
        for (const event of batch) {
          actions.push(`commit:${event.event.type}`);
          events.push(event);
        }
        notify();
      },
      reserveTurn: async (input) => {
        turnOrdinals.push(input.turnOrdinal);
        if (options?.failFirstTurnReservation === true && turnOrdinals.length === 1) {
          throw new Error('first turn reservation failed');
        }
        turn++;
        actions.push('reserve:turn');
        return {
          turnId: `turn-${turn}` as TurnId,
          workspaceCeiling: CEILING,
          runCeiling: CEILING,
          turnCeiling: { revision: `turn-ceiling-${turn}`, constraints: [] },
        };
      },
      reserveSuccessor: async (input) => {
        successor++;
        actions.push(`reserve:${input.reason}`);
        return {
          runId: `successor-${successor}` as RunId,
          permissionCeiling: CEILING,
        };
      },
    },
  };
}

function fixedPermissionPolicy(): PermissionPolicyPort {
  return {
    snapshotWorkspaceCeiling: async () => CEILING,
    resolveCeiling: async () => CEILING,
  };
}

describe('legacy Session ThreadDriver factory', () => {
  it('adapter open 后 mirror prepare 失败会精确 close 一次', async () => {
    const dir = tempDir();
    const creationKey = 'cleanup-mirror-prepare';
    const sessionId = deterministicSessionIdForTest(creationKey);
    writeFileSync(path.join(dir, `${sessionId}.jsonl`), 'foreign backend\n', 'utf8');
    const approval = trackedApprovalAdapterFactory();
    const factory = cleanupTestFactory(dir, approval.factory);

    await expect(factory.create({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      model: MODEL,
      permissionCeiling: CEILING,
      creationKey,
      legacyApprovalPatterns: approvalPatterns(),
    }, host().port)).rejects.toBeInstanceOf(LegacySessionCheckpointMismatchError);
    expect(approval.opens).toBe(1);
    expect(approval.closes).toBe(1);
  });

  it('Session create 失败会清理已打开的 adapter', async () => {
    const dir = tempDir();
    const approval = trackedApprovalAdapterFactory();
    const create = vi.spyOn(LegacyThreadExecution, 'createWithId').mockImplementation(async () => {
      throw new Error('injected Session create failure');
    });
    try {
      await expect(cleanupTestFactory(dir, approval.factory).create({
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        model: MODEL,
        permissionCeiling: CEILING,
        creationKey: 'cleanup-session-create',
        legacyApprovalPatterns: approvalPatterns(),
      }, host().port)).rejects.toThrow('injected Session create failure');
      expect(approval.opens).toBe(1);
      expect(approval.closes).toBe(1);
    } finally {
      create.mockRestore();
    }
  });

  it('Session resume 失败会清理已打开的 adapter', async () => {
    const dir = tempDir();
    const seed = await createLegacySessionThreadDriverFactory({
      sessionDir: dir,
      configure: ({ model }) => ({
        sessionOptions: {
          agentConfig: {
            streamFn: createFauxStreamFn({ turns: [] }),
            model,
            tools: [],
            systemPrompt: 'resume cleanup seed',
            cwd: dir,
          },
        },
      }),
    }).create({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      model: MODEL,
      permissionCeiling: CEILING,
      creationKey: 'cleanup-session-resume',
    }, host().port);
    await seed.driver.close();

    const approval = trackedApprovalAdapterFactory();
    const resume = vi.spyOn(LegacyThreadExecution, 'resume').mockImplementation(async () => {
      throw new Error('injected Session resume failure');
    });
    try {
      await expect(cleanupTestFactory(dir, approval.factory).resume({
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        model: MODEL,
        permissionCeiling: CEILING,
        durableRef: seed.durableRef,
        committedCheckpoint: seed.initialCheckpoint,
        usedRequestIds: [],
        legacyApprovalPatterns: approvalPatterns(),
      }, host().port)).rejects.toThrow('injected Session resume failure');
      expect(approval.opens).toBe(1);
      expect(approval.closes).toBe(1);
    } finally {
      resume.mockRestore();
    }
  });

  it('mirror finish 失败会同时 close 已创建 Session 与 adapter', async () => {
    const dir = tempDir();
    const approval = trackedApprovalAdapterFactory();
    const originalCreate = LegacyThreadExecution.createWithId.bind(LegacyThreadExecution);
    const create = vi.spyOn(LegacyThreadExecution, 'createWithId').mockImplementation(async (...args) => {
      const session = await originalCreate(...args);
      writeFileSync(path.join(dir, `${args[0]}.jsonl`), 'foreign tail\n', { flag: 'a' });
      return session;
    });
    const close = vi.spyOn(LegacyThreadExecution.prototype, 'close');
    try {
      await expect(cleanupTestFactory(dir, approval.factory).create({
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        model: MODEL,
        permissionCeiling: CEILING,
        creationKey: 'cleanup-mirror-finish',
        legacyApprovalPatterns: approvalPatterns(),
      }, host().port)).rejects.toThrow(/created backend|fingerprint|concurrent/i);
      expect(close).toHaveBeenCalledTimes(1);
      expect(approval.closes).toBe(1);
    } finally {
      close.mockRestore();
      create.mockRestore();
    }
  });

  it('driver 组装后 checkpoint 投影失败通过 driver 统一 close Session 与 adapter', async () => {
    const dir = tempDir();
    const approval = trackedApprovalAdapterFactory();
    const projection = vi.spyOn(LegacyThreadExecution.prototype, 'compactionCheckpoint')
      .mockImplementation(() => {
        throw new Error('injected attachment projection failure');
      });
    const close = vi.spyOn(LegacyThreadExecution.prototype, 'close');
    try {
      await expect(cleanupTestFactory(dir, approval.factory).create({
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        model: MODEL,
        permissionCeiling: CEILING,
        creationKey: 'cleanup-attachment-projection',
        legacyApprovalPatterns: approvalPatterns(),
      }, host().port)).rejects.toThrow('injected attachment projection failure');
      expect(close).toHaveBeenCalledTimes(1);
      expect(approval.closes).toBe(1);
    } finally {
      close.mockRestore();
      projection.mockRestore();
    }
  });

  it('creationKey 经哈希形成幂等安全 backend，重复 create 不产生第二个文件', async () => {
    const dir = tempDir();
    let configurations = 0;
    const factory = createLegacySessionThreadDriverFactory({
      sessionDir: dir,
      configure: ({ model }) => {
        configurations++;
        return {
          sessionOptions: {
            agentConfig: {
              streamFn: createFauxStreamFn({ turns: [] }),
              model,
              tools: [],
              systemPrompt: 'test',
              cwd: dir,
            },
          },
        };
      },
    });
    const firstHost = host();
    const first = await factory.create({
      workspaceId: WORKSPACE_ID,
      threadId: '../path-like-thread' as ThreadId,
      model: MODEL,
      permissionCeiling: CEILING,
      creationKey: 'stable/create/key',
    }, firstHost.port);
    await first.driver.close();
    const second = await factory.create({
      workspaceId: WORKSPACE_ID,
      threadId: '../path-like-thread' as ThreadId,
      model: MODEL,
      permissionCeiling: CEILING,
      creationKey: 'stable/create/key',
    }, host().port);

    expect(first.durableRef).toEqual(second.durableRef);
    expect(first.durableRef.kind).toBe('session-v1');
    expect(first.durableRef.key).toMatch(/^runtime-[0-9a-f]{40}$/);
    expect(readdirSync(dir).filter((name) => name.endsWith('.jsonl'))).toHaveLength(1);
    expect(configurations).toBe(2);
    await second.driver.close();
    await expect(factory.create({
      workspaceId: WORKSPACE_ID,
      threadId: '../different-path' as ThreadId,
      model: MODEL,
      permissionCeiling: CEILING,
      creationKey: 'stable/create/key',
    }, host().port)).rejects.toBeInstanceOf(LegacySessionCheckpointMismatchError);
    expect(readdirSync(dir).filter((name) => name.endsWith('.jsonl'))).toHaveLength(1);
  });

  it('拒绝无 persistent claim 的预置 deterministic backend，不把外来文件 bless 为 Runtime backend', async () => {
    const dir = tempDir();
    const creationKey = 'prepositioned-without-claim';
    const sessionId = deterministicSessionIdForTest(creationKey);
    const foreign = await Session.createWithId(sessionId, {
      dir,
      agentConfig: {
        streamFn: createFauxStreamFn({ turns: [] }),
        model: MODEL,
        tools: [],
        systemPrompt: 'foreign',
        cwd: dir,
      },
    });
    await foreign.close();
    const backendFile = path.join(dir, `${sessionId}.jsonl`);
    const before = await Bun.file(backendFile).text();
    const factory = createLegacySessionThreadDriverFactory({
      sessionDir: dir,
      configure: ({ model }) => ({
        sessionOptions: {
          agentConfig: {
            streamFn: createFauxStreamFn({ turns: [] }),
            model,
            tools: [],
            systemPrompt: 'runtime',
            cwd: dir,
          },
        },
      }),
    });

    await expect(factory.create({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      model: MODEL,
      permissionCeiling: CEILING,
      creationKey,
    }, host().port)).rejects.toBeInstanceOf(LegacySessionCheckpointMismatchError);
    expect(await Bun.file(backendFile).text()).toBe(before);
    expect(await Bun.file(path.join(dir, `${sessionId}.runtime-claim.json`)).exists()).toBe(false);
  });

  it('复用 status=creating 的精确 meta-only crash artifact 并原子转为 active claim', async () => {
    const dir = tempDir();
    const creationKey = 'backend-before-finish-crash';
    const sessionId = deterministicSessionIdForTest(creationKey);
    const meta = {
      type: 'meta' as const,
      version: 1 as const,
      protocolVersion: '1.0.0',
      id: sessionId,
      createdAt: 42,
      cwd: dir,
      model: MODEL.ref,
    };
    const backendBytes = `${JSON.stringify(meta)}\n`;
    writeFileSync(path.join(dir, `${sessionId}.jsonl`), backendBytes, 'utf8');
    const claimFile = path.join(dir, `${sessionId}.runtime-claim.json`);
    writeFileSync(claimFile, `${JSON.stringify({
      type: 'coda_runtime_legacy_mirror_claim',
      version: 1,
      sourceSessionId: sessionId,
      activeSessionId: sessionId,
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      recordedCwd: dir,
      backendMeta: meta,
      creationKey,
      generation: 0,
      expectedTail: {
        byteLength: Buffer.byteLength(backendBytes),
        sha256: createHash('sha256').update(backendBytes).digest('hex'),
      },
      status: 'creating',
    })}\n`, 'utf8');
    const factory = createLegacySessionThreadDriverFactory({
      sessionDir: dir,
      configure: ({ model }) => ({
        sessionOptions: {
          agentConfig: {
            streamFn: createFauxStreamFn({ turns: [] }),
            model,
            tools: [],
            systemPrompt: 'runtime',
            cwd: dir,
          },
        },
      }),
    });

    const attachment = await factory.create({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      model: MODEL,
      permissionCeiling: CEILING,
      creationKey,
    }, host().port);
    expect(attachment.durableRef).toEqual({ kind: 'session-v1', key: sessionId });
    expect(await Bun.file(path.join(dir, `${sessionId}.jsonl`)).text()).toBe(backendBytes);
    expect(JSON.parse(await Bun.file(claimFile).text())).toMatchObject({
      sourceSessionId: sessionId,
      activeSessionId: sessionId,
      creationKey,
      status: 'active',
    });
    expect(readdirSync(dir).filter((name) => name.endsWith('.jsonl'))).toEqual([`${sessionId}.jsonl`]);
    await attachment.driver.close();
  });

  it('resume 只接受 session-v1 安全 ref，并在验证后逐字段回传 canonical checkpoint', async () => {
    const dir = tempDir();
    const factory = createLegacySessionThreadDriverFactory({
      sessionDir: dir,
      configure: ({ model }) => ({
        sessionOptions: {
          agentConfig: {
            streamFn: createFauxStreamFn({ turns: [] }),
            model,
            tools: [],
            systemPrompt: 'test',
            cwd: dir,
          },
        },
      }),
    });
    const created = await factory.create({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      model: MODEL,
      permissionCeiling: CEILING,
      creationKey: 'resume-key',
    }, host().port);
    await created.driver.close();
    const checkpoint: ThreadDriverCheckpoint = {
      frontend: {
        model: MODEL.ref,
        transcript: [],
        usage: { cumulative: { input: 0, output: 0 }, turns: 0, contextTokens: 0 },
        queues: { steering: [], followUp: [] },
        plan: [{ step: 'canonical only', status: 'pending' }],
        pendingControls: [],
      },
      execution: {},
    };
    const resumed = await factory.resume({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      model: MODEL,
      durableRef: created.durableRef,
      permissionCeiling: CEILING,
      committedCheckpoint: checkpoint,
      usedRequestIds: [],
    }, host().port);
    expect(resumed.initialCheckpoint).toEqual(checkpoint);
    await resumed.driver.close();

    await expect(factory.resume({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      model: MODEL,
      durableRef: { kind: 'session-v1', key: '../escape' },
      permissionCeiling: CEILING,
      committedCheckpoint: checkpoint,
      usedRequestIds: [],
    }, host().port)).rejects.toThrow(/invalid legacy session driver ref/i);
  });

  it('canonical checkpoint 比 v1 mirror 超前时只追加缺失消息并恢复一致 usage', async () => {
    const dir = tempDir();
    const factory = createLegacySessionThreadDriverFactory({
      sessionDir: dir,
      configure: ({ model }) => ({
        sessionOptions: {
          agentConfig: {
            streamFn: createFauxStreamFn({ turns: [] }),
            model,
            tools: [],
            systemPrompt: 'test',
            cwd: dir,
          },
        },
      }),
    });
    const created = await factory.create({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      model: MODEL,
      permissionCeiling: CEILING,
      creationKey: 'repair-key',
    }, host().port);
    await created.driver.close();
    const transcript: AgentMessage[] = [
      {
        role: 'user',
        id: 'u_canonical',
        timestamp: 1,
        content: [{ type: 'text', text: 'canonical input' }],
        source: 'prompt',
      },
      {
        role: 'assistant',
        id: 'a_canonical',
        timestamp: 2,
        content: [{ type: 'text', text: 'canonical output' }],
        model: MODEL.ref,
        stopReason: 'stop',
        usage: { input: 7, output: 3 },
      },
    ];
    const checkpoint: ThreadDriverCheckpoint = {
      frontend: {
        model: MODEL.ref,
        transcript,
        usage: {
          lastTurn: { input: 7, output: 3 },
          cumulative: { input: 7, output: 3 },
          turns: 1,
          contextTokens: 10,
        },
        queues: { steering: [], followUp: [] },
        plan: [],
        pendingControls: [],
      },
      execution: {},
    };
    const resumed = await factory.resume({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      model: MODEL,
      durableRef: created.durableRef,
      permissionCeiling: CEILING,
      committedCheckpoint: checkpoint,
      usedRequestIds: [],
    }, host().port);

    expect(resumed.initialCheckpoint).toEqual(checkpoint);
    expect(loadSession(dir, created.durableRef.key).messages).toEqual(transcript);
    await resumed.driver.close();

    const divergent = {
      ...checkpoint,
      frontend: { ...checkpoint.frontend, transcript: [] },
    };
    await expect(factory.resume({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      model: MODEL,
      durableRef: created.durableRef,
      permissionCeiling: CEILING,
      committedCheckpoint: divergent,
      usedRequestIds: [],
    }, host().port)).rejects.toBeInstanceOf(LegacySessionCheckpointMismatchError);
  });

  it('activate 前按 mailbox 顺序恢复未提交 queue effect，并保留 checkpoint queue seed', async () => {
    const dir = tempDir();
    const factory = createLegacySessionThreadDriverFactory({
      sessionDir: dir,
      configure: ({ model }) => ({
        sessionOptions: {
          agentConfig: {
            streamFn: createFauxStreamFn({ turns: [] }),
            model,
            tools: [],
            systemPrompt: 'test',
            cwd: dir,
          },
        },
      }),
    });
    const created = await factory.create({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      model: MODEL,
      permissionCeiling: CEILING,
      creationKey: 'queue-recovery-key',
    }, host().port);
    await created.driver.close();
    const checkpoint: ThreadDriverCheckpoint = {
      frontend: {
        ...created.initialCheckpoint.frontend,
        queues: {
          steering: [{ id: 'queued-before-crash', text: 'already durable', kind: 'steering' }],
          followUp: [],
        },
      },
      execution: created.initialCheckpoint.execution,
    };
    const observedHost = host();
    const resumed = await factory.resume({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      model: MODEL,
      durableRef: created.durableRef,
      permissionCeiling: CEILING,
      committedCheckpoint: checkpoint,
      usedRequestIds: [],
    }, observedHost.port);
    const recoveryOpId = 'op_e_77777777777777777777777777777777' as ExternalOpId;

    await resumed.driver.recover([{
      op: {
        type: 'steer',
        opId: recoveryOpId,
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        text: 'recover after crash',
      },
    }]);
    await resumed.driver.activate();

    expect(observedHost.events).toContainEqual({
      event: {
        type: 'queue_update',
        steering: [
          { id: 'queued-before-crash', text: 'already durable', kind: 'steering' },
          expect.objectContaining({ text: 'recover after crash', kind: 'steering' }),
        ],
        followUp: [],
      },
      opId: recoveryOpId,
    });
    await expect(resumed.driver.recover([])).rejects.toThrow(/exactly once/i);
    await resumed.driver.close();
  });

  it('FileRuntimeStorage 的真实 v1 import 使用 canonical ref 并可由 driver resume', async () => {
    const legacyDir = tempDir();
    const runtimeRoot = tempDir();
    const legacy = await Session.create({
      dir: legacyDir,
      agentConfig: {
        streamFn: createFauxStreamFn({ turns: [{ events: [{ kind: 'text', text: 'legacy answer' }] }] }),
        model: MODEL,
        tools: [],
        systemPrompt: 'test',
        cwd: legacyDir,
      },
    });
    await legacy.prompt('legacy input');
    const expectedTranscript = [...legacy.messages];
    await legacy.close();

    const storage = createFileRuntimeStorage({ root: runtimeRoot, legacySessionDir: legacyDir });
    const locator = (await storage.listStoredThreads())[0];
    if (locator === undefined) throw new Error('legacy locator missing');
    expect(locator.catalog.driverRef?.kind).toBe('session-v1');
    const factory = createLegacySessionThreadDriverFactory({
      sessionDir: legacyDir,
      configure: ({ model }) => ({
        sessionOptions: {
          agentConfig: {
            streamFn: createFauxStreamFn({ turns: [] }),
            model,
            tools: [],
            systemPrompt: 'test',
            cwd: legacyDir,
          },
        },
      }),
    });
    const runtime = await createRuntime({
      workspace: {
        cwd: locator.ownerRecordedCwd,
        workspaceId: locator.ownerWorkspaceId,
      },
      storage,
      modelResolver: { resolve: async () => ({ ok: true, model: MODEL }) },
      permissionPolicy: fixedPermissionPolicy(),
      threadDriverFactory: factory,
    });
    try {
      const receipt = await runtime.submit({
        type: 'thread_resume',
        opId: 'op_e_22222222222222222222222222222222' as ExternalOpId,
        workspaceId: runtime.workspaceId,
        threadId: locator.threadId,
        model: MODEL.ref,
      });
      expect(receipt.accepted).toBe(true);
      expect((await runtime.getThreadSnapshot(locator.threadId))?.transcript).toEqual(
        expectedTranscript,
      );
    } finally {
      await runtime.close().catch(() => undefined);
    }
  });

  it('真实 ThreadDriverHostController 保留 approval 调用 receiver 并完成 durable 决议', async () => {
    const dir = tempDir();
    let executed = false;
    const tool: ToolDefinition<{ value: string }> = {
      name: 'danger',
      description: 'approval receiver regression tool',
      parameters: z.object({ value: z.string() }),
      kind: 'execute',
      async execute() {
        executed = true;
        return { content: [{ type: 'text', text: 'executed' }] };
      },
    };
    const approvalAdapterFactory: LegacyApprovalAdapterFactory = {
      async open() {
        return {
          async preflight() {
            return {
              kind: 'ask',
              description: 'approve danger',
              proposal: { patterns: [], forceConfirm: true },
            };
          },
          async applyResponse(input) {
            return {
              ok: true,
              effectiveDecision: input.decision,
              persistedPatterns: [],
            };
          },
          async close() {},
        };
      },
    };
    const factory = createLegacySessionThreadDriverFactory({
      sessionDir: dir,
      approvalAdapterFactory,
      configure: ({ model }) => ({
        sessionOptions: {
          agentConfig: {
            streamFn: createFauxStreamFn({
              turns: [
                { events: [{ kind: 'tool_call', name: tool.name, args: { value: 'x' } }] },
                { events: [{ kind: 'text', text: 'done' }] },
              ],
            }),
            model,
            tools: [tool],
            systemPrompt: 'test',
            cwd: dir,
          },
        },
      }),
    });
    expect(factory.requirements).toEqual({
      approvalMode: 'durable_legacy_bridge',
      capabilityMode: 'static',
    });
    const runtime = await createRuntime({
      workspace: { cwd: dir, workspaceId: WORKSPACE_ID },
      storage: createMemoryRuntimeStorage(),
      modelResolver: { resolve: async () => ({ ok: true, model: MODEL }) },
      permissionPolicy: fixedPermissionPolicy(),
      threadDriverFactory: factory,
    });
    const threadId = runtime.newThreadId();
    const iterator = runtime.events({ threadIds: [threadId] })[Symbol.asyncIterator]();
    try {
      expect((await runtime.submit({
        type: 'thread_create',
        opId: runtime.newOpId(),
        workspaceId: WORKSPACE_ID,
        threadId,
        model: MODEL.ref,
      })).accepted).toBe(true);

      expect((await runtime.submit({
        type: 'prompt',
        opId: runtime.newOpId(),
        workspaceId: WORKSPACE_ID,
        threadId,
        text: 'run danger',
      })).accepted).toBe(true);
      const boundary = await nextRuntimeEvent(iterator, (envelope) =>
        envelope.event.type === 'control_request' || envelope.event.type === 'agent_end');
      expect(boundary.event.type).toBe('control_request');
      if (boundary.event.type !== 'control_request') throw new Error('approval request was skipped');
      expect(boundary.event.kind).toBe('approval');

      expect((await runtime.submit({
        type: 'control_response',
        opId: runtime.newOpId(),
        workspaceId: WORKSPACE_ID,
        threadId,
        requestId: boundary.event.requestId,
        decision: 'allow_once',
      })).accepted).toBe(true);
      await nextRuntimeEvent(iterator, (envelope) => envelope.event.type === 'agent_end');
      expect(executed).toBe(true);
      expect((await runtime.getThreadSnapshot(threadId))?.transcript).toContainEqual(
        expect.objectContaining({ role: 'tool_result', isError: false }),
      );
    } finally {
      await iterator.return?.();
      await runtime.close().catch(() => undefined);
    }
  });

  it('registry 新调用只走 runtime turn，legacy factory 仅供历史 approval 恢复', async () => {
    const dir = tempDir();
    const legacyStream = createFauxStreamFn({
      turns: [
        { events: [{ kind: 'tool_call', name: 'danger', args: { value: 'legacy' } }] },
        { events: [{ kind: 'text', text: 'legacy done' }] },
      ],
    });
    const registryStream = createFauxStreamFn({
      turns: [
        { events: [{ kind: 'tool_call', name: 'danger', args: { value: 'registry' } }] },
        { events: [{ kind: 'text', text: 'registry done' }] },
      ],
    });
    let legacyBeforeToolCalls = 0;
    let legacyToolExecutions = 0;
    let approvalOpens = 0;
    let approvalPreflights = 0;
    let approvalCloses = 0;
    let registryExecutions = 0;
    const legacyTool: ToolDefinition<{ value: string }> = {
      name: 'danger',
      description: 'legacy attachment tool',
      parameters: z.object({ value: z.string() }),
      kind: 'execute',
      async execute() {
        legacyToolExecutions++;
        return { content: [{ type: 'text', text: 'legacy executed' }] };
      },
    };
    const approvalAdapterFactory: LegacyApprovalAdapterFactory = {
      async open() {
        approvalOpens++;
        return {
          async preflight() {
            approvalPreflights++;
            return { kind: 'allow' };
          },
          async applyResponse(input) {
            return {
              ok: true,
              effectiveDecision: input.decision,
              persistedPatterns: [],
            };
          },
          async close() {
            approvalCloses++;
          },
        };
      },
    };
    const factory = createLegacySessionThreadDriverFactory({
      sessionDir: dir,
      capabilityMode: 'registry',
      approvalAdapterFactory,
      configure: ({ model }) => ({
        sessionOptions: {
          agentConfig: {
            streamFn: legacyStream,
            model,
            tools: [legacyTool],
            systemPrompt: 'legacy fallback',
            cwd: dir,
            beforeToolCall: async () => {
              legacyBeforeToolCalls++;
              return {};
            },
          },
        },
      }),
    });
    expect(factory.requirements).toEqual({
      approvalMode: 'legacy_session_edge',
      capabilityMode: 'registry',
    });

    const observedHost = host();
    const captures: Parameters<NonNullable<ThreadDriverHostServices['captureRuntimeTurn']>>[0][] = [];
    const attachment = await factory.create({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      model: MODEL,
      permissionCeiling: CEILING,
      creationKey: 'registry-with-historical-approval-factory',
    }, {
      ...observedHost.port,
      captureRuntimeTurn: async (input) => {
        captures.push(input);
        return {
          streamFn: registryStream,
          assemble: (outboundMessages) => ({
            ok: true,
            context: {
              systemPrompt: 'registry turn',
              messages: [...outboundMessages],
              tools: [],
            },
          }),
          prepareToolCall: async (call, sourceOrdinal) => {
            expect(call.name).toBe('danger');
            expect(sourceOrdinal).toBe(0);
            return {
              ok: true,
              args: call.arguments,
              executionMode: 'parallel',
              execute: async () => {
                registryExecutions++;
                return { content: [{ type: 'text', text: 'registry executed' }] };
              },
            };
          },
        };
      },
    });
    let historicalAdapter: Awaited<ReturnType<LegacyApprovalAdapterFactory['open']>> | undefined;
    try {
      expect(attachment.legacyApprovalAdapter).toBeUndefined();
      expect(approvalOpens).toBe(0);
      await attachment.driver.recover([]);
      await attachment.driver.activate();
      expect(await attachment.driver.dispatch({
        op: {
          type: 'prompt',
          opId: OP_ID,
          workspaceId: WORKSPACE_ID,
          threadId: THREAD_ID,
          text: 'run registry danger',
        },
        runId: RUN_ID,
        permissionCeiling: CEILING,
        resolvedInput: {
          kind: 'prompt_input',
          sourceOpId: OP_ID,
          text: 'run registry danger',
        },
      }).completion).toEqual({
        kind: 'activity',
        status: 'completed',
        terminalRunId: RUN_ID,
      });

      expect(captures).toHaveLength(2);
      expect(registryStream.calls).toHaveLength(2);
      expect(registryExecutions).toBe(1);
      expect(legacyStream.calls).toHaveLength(0);
      expect(legacyBeforeToolCalls).toBe(0);
      expect(legacyToolExecutions).toBe(0);
      expect(approvalOpens).toBe(0);
      expect(approvalPreflights).toBe(0);

      const openHistoricalAdapter = factory.openLegacyApprovalAdapter;
      expect(openHistoricalAdapter).toBeDefined();
      if (openHistoricalAdapter === undefined) throw new Error('historical adapter factory missing');
      historicalAdapter = await openHistoricalAdapter({
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        patterns: approvalPatterns(),
      });
      expect(approvalOpens).toBe(1);
    } finally {
      await historicalAdapter?.close();
      await attachment.driver.close();
    }
    expect(approvalCloses).toBe(1);
  });

  it('registry capture reservation 失败后用同一 ordinal 提交完整 error turn', async () => {
    const dir = tempDir();
    const stream = createFauxStreamFn({
      turns: [{ events: [{ kind: 'text', text: 'must not sample' }] }],
    });
    const factory = createLegacySessionThreadDriverFactory({
      sessionDir: dir,
      capabilityMode: 'registry',
      configure: ({ model }) => ({
        sessionOptions: {
          agentConfig: {
            streamFn: stream,
            model,
            tools: [],
            systemPrompt: 'reservation retry',
            cwd: dir,
          },
        },
      }),
    });
    const observedHost = host({ failFirstTurnReservation: true });
    const attachment = await factory.create({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      model: MODEL,
      permissionCeiling: CEILING,
      creationKey: 'registry-reservation-retry',
    }, {
      ...observedHost.port,
      captureRuntimeTurn: async () => {
        throw new Error('capture must not run after reservation failure');
      },
    });
    try {
      await attachment.driver.recover([]);
      await attachment.driver.activate();
      expect(await attachment.driver.dispatch({
        op: {
          type: 'prompt',
          opId: OP_ID,
          workspaceId: WORKSPACE_ID,
          threadId: THREAD_ID,
          text: 'go',
        },
        runId: RUN_ID,
        permissionCeiling: CEILING,
        resolvedInput: { kind: 'prompt_input', sourceOpId: OP_ID, text: 'go' },
      }).completion).toEqual({
        kind: 'activity',
        status: 'error',
        terminalRunId: RUN_ID,
      });
      expect(observedHost.turnOrdinals).toEqual([1, 1]);
      expect(stream.calls).toHaveLength(0);
      expect(observedHost.events.map((event) => event.event.type)).toEqual([
        'agent_start',
        'turn_start',
        'message_start',
        'message_end',
        'error',
        'message_start',
        'message_end',
        'usage_update',
        'turn_end',
        'agent_end',
      ]);
    } finally {
      await attachment.driver.close();
    }
  });

  it('registry capture gate 可被 run abort 唤醒且 driver idle/close 不挂', async () => {
    const dir = tempDir();
    const stream = createFauxStreamFn({
      turns: [{ events: [{ kind: 'text', text: 'must not sample' }] }],
    });
    const factory = createLegacySessionThreadDriverFactory({
      sessionDir: dir,
      capabilityMode: 'registry',
      configure: ({ model }) => ({
        sessionOptions: {
          agentConfig: {
            streamFn: stream,
            model,
            tools: [],
            systemPrompt: 'capture abort',
            cwd: dir,
          },
        },
      }),
    });
    const observedHost = host();
    const captureEntered = deferred<void>();
    const attachment = await factory.create({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      model: MODEL,
      permissionCeiling: CEILING,
      creationKey: 'registry-capture-abort',
    }, {
      ...observedHost.port,
      captureRuntimeTurn: async ({ signal }): Promise<never> => {
        captureEntered.resolve(undefined);
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('capture aborted')), { once: true });
        });
      },
    });
    try {
      await attachment.driver.recover([]);
      await attachment.driver.activate();
      const activity = attachment.driver.dispatch({
        op: {
          type: 'prompt',
          opId: OP_ID,
          workspaceId: WORKSPACE_ID,
          threadId: THREAD_ID,
          text: 'go',
        },
        runId: RUN_ID,
        permissionCeiling: CEILING,
        resolvedInput: { kind: 'prompt_input', sourceOpId: OP_ID, text: 'go' },
      }).completion;
      await captureEntered.promise;

      expect(await attachment.driver.dispatch({
        op: {
          type: 'abort',
          opId: 'op_e_92929292929292929292929292929292' as ExternalOpId,
          workspaceId: WORKSPACE_ID,
          threadId: THREAD_ID,
          expectedRunId: RUN_ID,
        },
        resolvedTarget: { kind: 'run', runId: RUN_ID },
      }).completion).toEqual({ kind: 'operation', outcome: 'applied' });
      expect(await activity).toEqual({
        kind: 'activity',
        status: 'aborted',
        terminalRunId: RUN_ID,
      });
      expect(stream.calls).toHaveLength(0);
      expect(observedHost.events.some((event) => event.event.type === 'turn_start')).toBe(true);
      expect(observedHost.events.some((event) => event.event.type === 'turn_end')).toBe(true);
      expect(observedHost.events.findLast((event) => event.event.type === 'agent_end')?.event)
        .toMatchObject({ type: 'agent_end', reason: 'aborted' });
    } finally {
      await attachment.driver.close();
    }
  });

  it('映射 run/turn 身份；authoritative commit 失败使 activity 拒绝且不采样 provider', async () => {
    const dir = tempDir();
    const streams: ReturnType<typeof createFauxStreamFn>[] = [];
    const factory = createLegacySessionThreadDriverFactory({
      sessionDir: dir,
      configure: ({ model }) => {
        const stream = createFauxStreamFn({ turns: [{ events: [{ kind: 'text', text: 'ok' }] }] });
        streams.push(stream);
        return {
          sessionOptions: {
            agentConfig: { streamFn: stream, model, tools: [], systemPrompt: 'test', cwd: dir },
          },
        };
      },
    });
    const failingHost = host({ failType: 'turn_start' });
    const attachment = await factory.create({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      model: MODEL,
      permissionCeiling: CEILING,
      creationKey: 'failing-key',
    }, failingHost.port);
    await attachment.driver.recover([]);
    await attachment.driver.activate();
    const completion = attachment.driver.dispatch({
      op: {
        type: 'prompt',
        opId: OP_ID,
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        text: 'go',
      },
      runId: RUN_ID,
      permissionCeiling: CEILING,
      resolvedInput: { kind: 'prompt_input', sourceOpId: OP_ID, text: 'go' },
    }).completion;

    await expect(completion).rejects.toThrow('commit failed: turn_start');
    expect(streams[0]?.calls).toHaveLength(0);
    expect(failingHost.events).toEqual([{
      event: { type: 'agent_start', reason: 'prompt' },
      runId: RUN_ID,
      opId: OP_ID,
    }]);
    expect(loadSession(dir, attachment.durableRef.key).messages).toEqual([]);
    await attachment.driver.close();
  });

  it('canonical 与 v1 mirror 使用同一份自定义 pricing 快照', async () => {
    const dir = tempDir();
    const pricing: ModelPricing = { inputPer1M: 2, outputPer1M: 3 };
    const observedHost = host();
    const factory = createLegacySessionThreadDriverFactory({
      sessionDir: dir,
      configure: ({ model }) => ({
        sessionOptions: {
          pricing,
          agentConfig: {
            streamFn: createFauxStreamFn({
              turns: [{
                events: [{ kind: 'text', text: 'priced' }],
                usage: { input: 100, output: 10 },
              }],
            }),
            model,
            tools: [],
            systemPrompt: 'test',
            cwd: dir,
          },
        },
      }),
    });
    const attachment = await factory.create({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      model: MODEL,
      permissionCeiling: CEILING,
      creationKey: 'pricing-key',
    }, observedHost.port);
    await attachment.driver.recover([]);
    await attachment.driver.activate();
    await attachment.driver.dispatch({
      op: {
        type: 'prompt',
        opId: OP_ID,
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        text: 'go',
      },
      runId: RUN_ID,
      permissionCeiling: CEILING,
      resolvedInput: { kind: 'prompt_input', sourceOpId: OP_ID, text: 'go' },
    }).completion;

    const canonicalMessage = observedHost.events.find((event) =>
      event.event.type === 'message_end' && event.event.message.role === 'assistant');
    expect(canonicalMessage?.event).toMatchObject({
      type: 'message_end',
      message: { usage: { input: 100, output: 10, costUSD: 0.00023 } },
    });
    expect(observedHost.batches).toContainEqual([
      expect.objectContaining({
        event: expect.objectContaining({ type: 'message_end', message: expect.objectContaining({ role: 'assistant' }) }),
      }),
      expect.objectContaining({ event: expect.objectContaining({ type: 'usage_update' }) }),
    ]);
    const mirrorAssistant = loadSession(dir, attachment.durableRef.key).messages
      .find((message) => message.role === 'assistant');
    expect(mirrorAssistant?.usage.costUSD).toBe(0.00023);
    await attachment.driver.close();
  });

  it('resume 在触碰 legacy mirror 前拒绝 circular canonical checkpoint', async () => {
    const dir = tempDir();
    const factory = createLegacySessionThreadDriverFactory({
      sessionDir: dir,
      configure: ({ model }) => ({
        sessionOptions: {
          agentConfig: {
            streamFn: createFauxStreamFn({ turns: [] }),
            model,
            tools: [],
            systemPrompt: 'test',
            cwd: dir,
          },
        },
      }),
    });
    const created = await factory.create({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      model: MODEL,
      permissionCeiling: CEILING,
      creationKey: 'circular-checkpoint-key',
    }, host().port);
    await created.driver.close();
    const before = Bun.file(path.join(dir, `${created.durableRef.key}.jsonl`)).text();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const checkpoint = {
      frontend: {
        model: MODEL.ref,
        transcript: [],
        usage: { cumulative: { input: 0, output: 0 }, turns: 0, contextTokens: 0 },
        queues: { steering: [], followUp: [] },
        plan: [{ step: 'invalid', status: 'pending', circular }],
        pendingControls: [],
      },
      execution: {},
    } as unknown as ThreadDriverCheckpoint;

    await expect(factory.resume({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      model: MODEL,
      durableRef: created.durableRef,
      permissionCeiling: CEILING,
      committedCheckpoint: checkpoint,
      usedRequestIds: [],
    }, host().port)).rejects.toThrow(/circular/i);
    expect(await Bun.file(path.join(dir, `${created.durableRef.key}.jsonl`)).text()).toBe(await before);
  });

  it('检测 claimed v1 backend 的外来追加并在下一次采样前 quarantine', async () => {
    const dir = tempDir();
    const runtimeStreams: ReturnType<typeof createFauxStreamFn>[] = [];
    const observedHost = host();
    const factory = createLegacySessionThreadDriverFactory({
      sessionDir: dir,
      configure: ({ model }) => {
        const stream = createFauxStreamFn({
          turns: [
            { events: [{ kind: 'text', text: 'runtime first' }] },
            { events: [{ kind: 'text', text: 'must not sample after foreign append' }] },
          ],
        });
        runtimeStreams.push(stream);
        return {
          sessionOptions: {
            agentConfig: { streamFn: stream, model, tools: [], systemPrompt: 'test', cwd: dir },
          },
        };
      },
    });
    const attachment = await factory.create({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      model: MODEL,
      permissionCeiling: CEILING,
      creationKey: 'fingerprint-key',
    }, observedHost.port);
    await attachment.driver.recover([]);
    await attachment.driver.activate();
    await attachment.driver.dispatch({
      op: {
        type: 'prompt',
        opId: OP_ID,
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        text: 'runtime',
      },
      runId: RUN_ID,
      permissionCeiling: CEILING,
      resolvedInput: { kind: 'prompt_input', sourceOpId: OP_ID, text: 'runtime' },
    }).completion;
    const canonicalTranscript = observedHost.events.flatMap((event) =>
      event.event.type === 'message_end' ? [event.event.message] : []);
    const canonicalUsage = observedHost.events.findLast((event) => event.event.type === 'usage_update');
    if (canonicalUsage?.event.type !== 'usage_update') throw new Error('missing canonical usage');
    const checkpoint: ThreadDriverCheckpoint = {
      frontend: {
        model: MODEL.ref,
        transcript: canonicalTranscript,
        usage: canonicalUsage.event.usage,
        queues: { steering: [], followUp: [] },
        plan: [],
        pendingControls: [],
      },
      execution: {},
    };

    const foreign = await Session.resume(attachment.durableRef.key, {
      dir,
      agentConfig: {
        streamFn: createFauxStreamFn({ turns: [{ events: [{ kind: 'text', text: 'foreign' }] }] }),
        model: MODEL,
        tools: [],
        systemPrompt: 'foreign',
        cwd: dir,
      },
    });
    await foreign.prompt('foreign append');
    await foreign.close();

    const secondOpId = 'op_e_55555555555555555555555555555555' as ExternalOpId;
    const secondRunId = 'run-second' as RunId;
    await expect(attachment.driver.dispatch({
      op: {
        type: 'prompt',
        opId: secondOpId,
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        text: 'runtime again',
      },
      runId: secondRunId,
      permissionCeiling: CEILING,
      resolvedInput: { kind: 'prompt_input', sourceOpId: secondOpId, text: 'runtime again' },
    }).completion).rejects.toThrow(/concurrent|fingerprint|quarantine/i);
    expect(runtimeStreams[0]?.calls).toHaveLength(1);
    expect(observedHost.events).toContainEqual(expect.objectContaining({
      event: expect.objectContaining({
        type: 'runtime_diagnostic',
        code: 'legacy_backend_concurrent_writer',
      }),
    }));
    await attachment.driver.close().catch(() => undefined);

    const sourceFile = path.join(dir, `${attachment.durableRef.key}.jsonl`);
    const foreignSource = await Bun.file(sourceFile).text();
    const resumedHost = host();
    const resumed = await factory.resume({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      model: MODEL,
      durableRef: attachment.durableRef,
      permissionCeiling: CEILING,
      committedCheckpoint: checkpoint,
      usedRequestIds: [],
    }, resumedHost.port);
    expect(resumed.initialCheckpoint).toEqual(checkpoint);
    await resumed.driver.recover([]);
    await resumed.driver.activate();
    expect(resumedHost.events).toContainEqual(expect.objectContaining({
      event: expect.objectContaining({
        type: 'runtime_diagnostic',
        code: 'legacy_backend_concurrent_writer',
      }),
    }));
    const resumedOpId = 'op_e_56565656565656565656565656565656' as ExternalOpId;
    await expect(resumed.driver.dispatch({
      op: {
        type: 'prompt',
        opId: resumedOpId,
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        text: 'private mirror only',
      },
      runId: 'run-private-mirror' as RunId,
      permissionCeiling: CEILING,
      resolvedInput: {
        kind: 'prompt_input',
        sourceOpId: resumedOpId,
        text: 'private mirror only',
      },
    }).completion).resolves.toMatchObject({ kind: 'activity', status: 'completed' });
    expect(runtimeStreams[1]?.calls).toHaveLength(1);
    expect(await Bun.file(sourceFile).text()).toBe(foreignSource);
    expect(readdirSync(dir).filter((name) => name.endsWith('.jsonl'))).toHaveLength(2);
    await resumed.driver.close();
  });

  it('abort 对 resolvedTarget 做 CAS，旧 run target 不得误杀当前 activity', async () => {
    const dir = tempDir();
    const gate = createGate();
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const factory = createLegacySessionThreadDriverFactory({
      sessionDir: dir,
      configure: ({ model }) => ({
        sessionOptions: {
          agentConfig: {
            streamFn: createFauxStreamFn({
              turns: [{ onRequest: resolveStarted, events: [{ kind: 'gate', gate }, { kind: 'text', text: 'done' }] }],
            }),
            model,
            tools: [],
            systemPrompt: 'test',
            cwd: dir,
          },
        },
      }),
    });
    const attachment = await factory.create({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      model: MODEL,
      permissionCeiling: CEILING,
      creationKey: 'abort-cas-key',
    }, host().port);
    await attachment.driver.recover([]);
    await attachment.driver.activate();
    const activity = attachment.driver.dispatch({
      op: {
        type: 'prompt',
        opId: OP_ID,
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        text: 'go',
      },
      runId: RUN_ID,
      permissionCeiling: CEILING,
      resolvedInput: { kind: 'prompt_input', sourceOpId: OP_ID, text: 'go' },
    }).completion;
    await started;
    const staleRunId = 'stale-run' as RunId;
    const abort = await attachment.driver.dispatch({
      op: {
        type: 'abort',
        opId: 'op_e_33333333333333333333333333333333' as ExternalOpId,
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        expectedRunId: staleRunId,
      },
      resolvedTarget: { kind: 'run', runId: staleRunId },
    }).completion;
    expect(abort).toEqual({ kind: 'operation', outcome: 'no_op' });
    expect(attachment.driver.interactionState()).toBe('running');
    gate.open();
    expect(await activity).toEqual({ kind: 'activity', status: 'completed', terminalRunId: RUN_ID });
    await attachment.driver.close();
  });

  it('compaction successor 在 predecessor agent_end commit 前只预留一次', async () => {
    const dir = tempDir();
    const model: ModelConfig = {
      ...MODEL,
      limits: { context: 100, output: 20 },
    };
    const observedHost = host();
    const factory = createLegacySessionThreadDriverFactory({
      sessionDir: dir,
      configure: ({ model: configuredModel }) => ({
        sessionOptions: {
          compaction: { threshold: 0.8, keepRatio: 0.5 },
          agentConfig: {
            streamFn: createFauxStreamFn({
              turns: [
                { events: [{ kind: 'text', text: 'hot' }], usage: { input: 90, output: 10 } },
                { events: [{ kind: 'text', text: 'summary' }] },
              ],
            }),
            model: configuredModel,
            tools: [],
            systemPrompt: 'test',
            cwd: dir,
          },
        },
      }),
    });
    const attachment = await factory.create({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      model,
      permissionCeiling: CEILING,
      creationKey: 'compaction-order-key',
    }, observedHost.port);
    await attachment.driver.recover([]);
    await attachment.driver.activate();
    const result = await attachment.driver.dispatch({
      op: {
        type: 'prompt',
        opId: OP_ID,
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        text: 'go',
      },
      runId: RUN_ID,
      permissionCeiling: CEILING,
      resolvedInput: { kind: 'prompt_input', sourceOpId: OP_ID, text: 'go' },
    }).completion;

    expect(result.kind).toBe('activity');
    expect(observedHost.actions.filter((action) => action === 'reserve:compaction')).toHaveLength(1);
    expect(observedHost.actions.indexOf('reserve:compaction')).toBeLessThan(
      observedHost.actions.indexOf('commit:agent_end'),
    );
    expect(observedHost.actions.indexOf('commit:agent_end')).toBeLessThan(
      observedHost.actions.indexOf('commit:compaction_start'),
    );
    await attachment.driver.close();
  });

  it('successor reserve 后 predecessor agent_end commit 前可按 successor RunId 取消', async () => {
    const dir = tempDir();
    const baseHost = host();
    const agentEndEntered = deferred<void>();
    const releaseAgentEnd = deferred<void>();
    const gatedHost: ThreadDriverHostServices = {
      ...baseHost.port,
      commitEvent: async (event, mutation) => {
        if (event.event.type === 'agent_end' && event.event.willRetry === true) {
          agentEndEntered.resolve();
          await releaseAgentEnd.promise;
        }
        await baseHost.port.commitEvent(event, mutation);
      },
    };
    const streams: ReturnType<typeof createFauxStreamFn>[] = [];
    const factory = createLegacySessionThreadDriverFactory({
      sessionDir: dir,
      configure: ({ model }) => {
        const stream = createFauxStreamFn({
          turns: [
            {
              error: {
                message: 'retry me',
                details: { kind: 'http', status: 500, retryable: true },
              },
            },
            { events: [{ kind: 'text', text: 'must not retry after successor abort' }] },
          ],
        });
        streams.push(stream);
        return {
          sessionOptions: {
            retry: {
              maxAttempts: 1,
              jitter: () => 0,
              sleep: async (_delayMs, signal) => signal.aborted,
            },
            agentConfig: { streamFn: stream, model, tools: [], systemPrompt: 'test', cwd: dir },
          },
        };
      },
    });
    const attachment = await factory.create({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      model: MODEL,
      permissionCeiling: CEILING,
      creationKey: 'successor-abort-window-key',
    }, gatedHost);
    await attachment.driver.recover([]);
    await attachment.driver.activate();
    const activity = attachment.driver.dispatch({
      op: {
        type: 'prompt',
        opId: OP_ID,
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        text: 'go',
      },
      runId: RUN_ID,
      permissionCeiling: CEILING,
      resolvedInput: { kind: 'prompt_input', sourceOpId: OP_ID, text: 'go' },
    }).completion;
    await agentEndEntered.promise;

    const successorRunId = 'successor-1' as RunId;
    const abort = attachment.driver.dispatch({
      op: {
        type: 'abort',
        opId: 'op_e_77777777777777777777777777777777' as ExternalOpId,
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        expectedRunId: successorRunId,
      },
      resolvedTarget: { kind: 'run', runId: successorRunId },
    }).completion;
    expect(await abort).toEqual({ kind: 'operation', outcome: 'applied' });
    releaseAgentEnd.resolve();
    await activity;
    expect(streams[0]?.calls).toHaveLength(1);
    expect(baseHost.actions.indexOf('reserve:retry')).toBeLessThan(
      baseHost.actions.indexOf('commit:agent_end'),
    );
    await attachment.driver.close();
  });

  it('retry_scheduled 后取消 successor 以 aborted 结案而不是沿用 predecessor error', async () => {
    const dir = tempDir();
    const observedHost = host();
    const sleepEntered = deferred<void>();
    const stream = createFauxStreamFn({
      turns: [
        {
          error: {
            message: 'retry me',
            details: { kind: 'http', status: 500, retryable: true },
          },
        },
        { events: [{ kind: 'text', text: 'must not run after successor abort' }] },
      ],
    });
    const factory = createLegacySessionThreadDriverFactory({
      sessionDir: dir,
      configure: ({ model }) => ({
        sessionOptions: {
          retry: {
            maxAttempts: 1,
            jitter: () => 0,
            sleep: async (_delayMs, signal) => {
              sleepEntered.resolve();
              if (!signal.aborted) {
                await new Promise<void>((resolve) => {
                  signal.addEventListener('abort', () => resolve(), { once: true });
                });
              }
              return true;
            },
          },
          agentConfig: { streamFn: stream, model, tools: [], systemPrompt: 'test', cwd: dir },
        },
      }),
    });
    const attachment = await factory.create({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      model: MODEL,
      permissionCeiling: CEILING,
      creationKey: 'successor-abort-after-retry-scheduled-key',
    }, observedHost.port);
    await attachment.driver.recover([]);
    await attachment.driver.activate();
    const activity = attachment.driver.dispatch({
      op: {
        type: 'prompt',
        opId: OP_ID,
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        text: 'go',
      },
      runId: RUN_ID,
      permissionCeiling: CEILING,
      resolvedInput: { kind: 'prompt_input', sourceOpId: OP_ID, text: 'go' },
    }).completion;
    await observedHost.waitForEventCount('retry_scheduled', 1);
    await sleepEntered.promise;

    const successorRunId = 'successor-1' as RunId;
    expect(await attachment.driver.dispatch({
      op: {
        type: 'abort',
        opId: 'op_e_78787878787878787878787878787878' as ExternalOpId,
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        expectedRunId: successorRunId,
      },
      resolvedTarget: { kind: 'run', runId: successorRunId },
    }).completion).toEqual({ kind: 'operation', outcome: 'applied' });
    expect(await activity).toEqual({
      kind: 'activity',
      status: 'aborted',
      terminalRunId: successorRunId,
    });
    expect(stream.calls).toHaveLength(1);
    await attachment.driver.close();
  });
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  return {
    promise: new Promise<T>((resolve) => {
      resolvePromise = resolve;
    }),
    resolve(value: T): void {
      if (resolvePromise === undefined) throw new Error('Deferred is not initialized');
      resolvePromise(value);
    },
  };
}

async function nextRuntimeEvent(
  iterator: AsyncIterator<Readonly<EventEnvelope>>,
  predicate: (envelope: Readonly<EventEnvelope>) => boolean,
): Promise<Readonly<EventEnvelope>> {
  for (;;) {
    const item = await iterator.next();
    if (item.done) throw new Error('Runtime event stream closed before the expected event');
    if (predicate(item.value)) return item.value;
  }
}

function deterministicSessionIdForTest(creationKey: string): string {
  return `runtime-${createHash('sha256').update(creationKey, 'utf8').digest('hex').slice(0, 40)}`;
}

function cleanupTestFactory(
  dir: string,
  approvalAdapterFactory: LegacyApprovalAdapterFactory,
) {
  return createLegacySessionThreadDriverFactory({
    sessionDir: dir,
    approvalAdapterFactory,
    configure: ({ model }) => ({
      sessionOptions: {
        agentConfig: {
          streamFn: createFauxStreamFn({ turns: [] }),
          model,
          tools: [],
          systemPrompt: 'cleanup test',
          cwd: dir,
        },
      },
    }),
  });
}

function approvalPatterns(): LegacyApprovalPatternRepositoryPort {
  return {
    workspaceId: WORKSPACE_ID,
    snapshot: async () => ({ revision: 'cleanup-test', patterns: [] }),
    commit: async () => ({ kind: 'applied', revision: 'cleanup-test' }),
  };
}

function trackedApprovalAdapterFactory(): {
  readonly factory: LegacyApprovalAdapterFactory;
  readonly opens: number;
  readonly closes: number;
} {
  let opens = 0;
  let closes = 0;
  return {
    get opens() {
      return opens;
    },
    get closes() {
      return closes;
    },
    factory: {
      async open() {
        opens++;
        let closed = false;
        return {
          preflight: async () => ({ kind: 'allow' }),
          applyResponse: async (input) => ({
            ok: true,
            effectiveDecision: input.decision,
            persistedPatterns: [],
          }),
          async close() {
            if (closed) throw new Error('approval adapter closed twice');
            closed = true;
            closes++;
          },
        };
      },
    },
  };
}
