// 阶段 0 characterization：冻结 legacy Session 的当前行为，作为多线程 Runtime 迁移护栏。
// 此处刻意创建两个独立 Session 来代表未来两个 ThreadRuntime；不引入 Supervisor 或新协议。

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { ApprovalBroker } from '../src/agent/index.js';
import type { SessionEvent } from '../src/session/index.js';
import { Session } from '../src/session/index.js';
import { createFauxStreamFn, createGate } from '../src/providers/faux/index.js';
import { makeTool, TEST_MODEL, textOutput } from './helpers/agent-harness.js';

let sessionDir: string;

beforeEach(() => {
  sessionDir = mkdtempSync(path.join(os.tmpdir(), 'coda-supervisor-baseline-'));
});

afterEach(() => {
  rmSync(sessionDir, { recursive: true, force: true });
});

interface ObservedSession {
  session: Session;
  events: SessionEvent[];
  waitForEvent(predicate: (event: SessionEvent) => boolean): Promise<SessionEvent>;
}

async function createObservedSession(
  streamFn: ReturnType<typeof createFauxStreamFn>,
): Promise<ObservedSession> {
  const session = await Session.create({
    dir: sessionDir,
    agentConfig: {
      streamFn,
      model: TEST_MODEL,
      tools: [],
      systemPrompt: 'characterize the legacy session boundary',
      cwd: sessionDir,
    },
  });
  const events: SessionEvent[] = [];
  const waiters: Array<{
    predicate: (event: SessionEvent) => boolean;
    resolve: (event: SessionEvent) => void;
  }> = [];
  session.subscribe((event) => {
    events.push(event);
    for (let i = waiters.length - 1; i >= 0; i--) {
      const waiter = waiters[i];
      if (waiter?.predicate(event)) {
        waiters.splice(i, 1);
        waiter.resolve(event);
      }
    }
  });
  return {
    session,
    events,
    waitForEvent: (predicate) =>
      new Promise<SessionEvent>((resolve) => {
        waiters.push({ predicate, resolve });
      }),
  };
}

describe('阶段 0：每线程单 active run 的 legacy 基线', () => {
  it('同一 Session 拒绝第二个 prompt，两个 Session 可同时运行且旧事件仍是裸 SessionEvent', async () => {
    const gateA = createGate();
    const gateB = createGate();
    const streamA = createFauxStreamFn({
      turns: [{ events: [{ kind: 'text', text: 'thread A' }, { kind: 'gate', gate: gateA }] }],
    });
    const streamB = createFauxStreamFn({
      turns: [{ events: [{ kind: 'text', text: 'thread B' }, { kind: 'gate', gate: gateB }] }],
    });
    const a = await createObservedSession(streamA);
    const b = await createObservedSession(streamB);
    const aStarted = a.waitForEvent((event) => event.type === 'message_update');
    const bStarted = b.waitForEvent((event) => event.type === 'message_update');

    const runA = a.session.prompt('prompt A');
    const runB = b.session.prompt('prompt B');
    await Promise.all([aStarted, bStarted]);

    expect(a.session.interactionState()).toBe('running');
    expect(b.session.interactionState()).toBe('running');
    await expect(a.session.prompt('second prompt A')).rejects.toThrow(/running|steer|followUp/i);

    gateA.open();
    await runA;
    expect(a.session.interactionState()).toBe('idle');
    expect(b.session.interactionState()).toBe('running');

    gateB.open();
    await runB;
    expect(streamA.calls).toHaveLength(1);
    expect(streamB.calls).toHaveLength(1);
    expect(a.session.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(b.session.messages.map((message) => message.role)).toEqual(['user', 'assistant']);

    const legacyStart = a.events.find((event) => event.type === 'agent_start');
    expect(legacyStart).toEqual({ type: 'agent_start', reason: 'prompt' });
    expect(legacyStart).not.toHaveProperty('workspaceId');
    expect(legacyStart).not.toHaveProperty('threadId');
    expect(legacyStart).not.toHaveProperty('runId');
    expect(legacyStart).not.toHaveProperty('turnId');
    expect(legacyStart).not.toHaveProperty('opId');
    expect(legacyStart).not.toHaveProperty('seq');
    expect(legacyStart).not.toHaveProperty('event');

    await Promise.all([a.session.close(), b.session.close()]);
  });

  it('abort 和 mailbox 都只影响目标 Session，另一 Session 的 run 继续等待', async () => {
    const gateA = createGate();
    const gateB = createGate();
    const streamA = createFauxStreamFn({
      turns: [
        { events: [{ kind: 'text', text: 'A working' }, { kind: 'gate', gate: gateA }] },
        { events: [{ kind: 'text', text: 'A resumed steering' }] },
        { events: [{ kind: 'text', text: 'A handled follow-up' }] },
      ],
    });
    const streamB = createFauxStreamFn({
      turns: [
        {
          events: [
            { kind: 'text', text: 'B working' },
            { kind: 'gate', gate: gateB },
            { kind: 'text', text: 'B done' },
          ],
        },
      ],
    });
    const a = await createObservedSession(streamA);
    const b = await createObservedSession(streamB);
    const aStarted = a.waitForEvent((event) => event.type === 'message_update');
    const bStarted = b.waitForEvent((event) => event.type === 'message_update');
    const runA = a.session.prompt('prompt A');
    const runB = b.session.prompt('prompt B');
    await Promise.all([aStarted, bStarted]);

    const aQueued = a.waitForEvent(
      (event) =>
        event.type === 'queue_update' &&
        event.steering.some((item) => item.text === 'A mailbox only') &&
        event.followUp.some((item) => item.text === 'A follow-up only'),
    );
    a.session.steer('A mailbox only');
    a.session.followUp('A follow-up only');
    await aQueued;
    expect(
      b.events.some(
        (event) =>
          event.type === 'queue_update' &&
          [...event.steering, ...event.followUp].some((item) => item.text === 'A mailbox only'),
      ),
    ).toBe(false);

    a.session.abort();
    await runA;
    expect(a.events.some((event) => event.type === 'agent_end' && event.reason === 'aborted')).toBe(true);
    expect(b.session.interactionState()).toBe('running');
    expect(b.session.messages).toHaveLength(1);

    gateB.open();
    await runB;
    expect(b.events.some((event) => event.type === 'agent_end' && event.reason === 'completed')).toBe(true);
    expect(
      streamB.calls.some((call) =>
        call.context.messages.some((message) =>
          message.content.some(
            (part) =>
              part.type === 'text' &&
              (part.text.includes('A mailbox only') || part.text.includes('A follow-up only')),
          ),
        ),
      ),
    ).toBe(false);

    const aResumed = a.waitForEvent(
      (event) => event.type === 'agent_start' && event.reason === 'follow_up',
    );
    const continuedA = a.session.continue();
    await aResumed;
    await continuedA;
    expect(streamA.calls).toHaveLength(3);
    expect(
      a.session.messages
        .filter((message) => message.role === 'user')
        .map((message) => message.source),
    ).toEqual(['prompt', 'steering', 'follow_up']);
    expect(
      b.session.messages.some((message) =>
        message.content.some(
          (part) =>
            part.type === 'text' &&
            (part.text.includes('A mailbox only') || part.text.includes('A follow-up only')),
        ),
      ),
    ).toBe(false);

    await Promise.all([a.session.close(), b.session.close()]);
  });

  it('legacy session picker 跨 cwd 列出会话，resume 使用本次调用方注入的执行配置', async () => {
    const recordedCwd = path.join(sessionDir, 'recorded-workspace');
    const invocationCwd = path.join(sessionDir, 'different-invocation-workspace');
    const original = await Session.create({
      dir: sessionDir,
      agentConfig: {
        streamFn: createFauxStreamFn({ turns: [] }),
        model: TEST_MODEL,
        tools: [],
        systemPrompt: `recorded:${recordedCwd}`,
        cwd: recordedCwd,
      },
    });
    const sessionId = original.id;
    await original.close();

    const listedFromAnotherCwd = await Session.list(sessionDir);
    expect(listedFromAnotherCwd.map((item) => item.id)).toContain(sessionId);
    expect(listedFromAnotherCwd.find((item) => item.id === sessionId)?.cwd).toBe(recordedCwd);

    let observedToolCwd: string | undefined;
    const whereTool = makeTool('where', async (_args, context) => {
      observedToolCwd = context.cwd;
      return textOutput(context.cwd);
    });
    const resumedStream = createFauxStreamFn({
      turns: [
        { events: [{ kind: 'tool_call', name: 'where', args: {}, id: 'where_1' }] },
        { events: [{ kind: 'text', text: 'resumed elsewhere' }] },
      ],
    });
    const resumed = await Session.resume(sessionId, {
      dir: sessionDir,
      agentConfig: {
        streamFn: resumedStream,
        model: TEST_MODEL,
        tools: [whereTool],
        systemPrompt: `invocation:${invocationCwd}`,
        cwd: invocationCwd,
      },
    });
    await resumed.prompt('continue from another cwd');
    expect(resumedStream.calls[0]?.context.systemPrompt).toBe(`invocation:${invocationCwd}`);
    expect(observedToolCwd).toBe(invocationCwd);
    await resumed.close();
  });

  it('approval_request 在对应 tool_execution_start 之前出现，决议前工具不会启动', async () => {
    const order: string[] = [];
    let resolveApprovalSeen: ((approvalId: string) => void) | undefined;
    const approvalSeen = new Promise<string>((resolve) => {
      resolveApprovalSeen = resolve;
    });
    const broker = new ApprovalBroker((event) => {
      if (event.type !== 'approval_request') return;
      order.push('approval_request');
      resolveApprovalSeen?.(event.approvalId);
    });
    let executions = 0;
    const danger = makeTool('danger', async () => {
      executions += 1;
      return textOutput('done');
    });
    const session = await Session.create({
      dir: sessionDir,
      agentConfig: {
        streamFn: createFauxStreamFn({
          turns: [
            {
              events: [
                { kind: 'tool_call', name: 'danger', args: { value: 'x' }, id: 'danger_1' },
              ],
            },
            { events: [{ kind: 'text', text: 'approved' }] },
          ],
        }),
        model: TEST_MODEL,
        tools: [danger],
        systemPrompt: 'characterize approval ordering',
        cwd: sessionDir,
        beforeToolCall: async (call) => {
          const outcome = await broker.request({
            toolCallId: call.id,
            description: call.name,
            patterns: [`${call.name}:*`],
          });
          return outcome.decision === 'deny'
            ? { block: true, reason: 'denied for characterization' }
            : {};
        },
      },
    });
    session.subscribe((event) => {
      if (event.type === 'tool_execution_start' && event.toolCallId === 'danger_1') {
        order.push('tool_execution_start');
      }
    });

    const run = session.prompt('run danger');
    const approvalId = await approvalSeen;
    expect(order).toEqual(['approval_request']);
    expect(executions).toBe(0);

    broker.resolve(approvalId, 'allow_once');
    await run;
    expect(order).toEqual(['approval_request', 'tool_execution_start']);
    expect(executions).toBe(1);
    await session.close();
  });
});
