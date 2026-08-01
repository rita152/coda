// Direct-Session crash recovery must settle canonical activity before a replacement driver exists.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type {
  ExternalOpId,
  RunId,
  RuntimeEvent,
  TurnId,
} from '../src/protocol/index.js';
import { createFauxStreamFn } from '../src/providers/faux/index.js';
import { EventHub } from '../src/session/event-hub.js';
import { Session } from '../src/session/index.js';
import { StandaloneSessionLease } from '../src/session/standalone-session-lease.js';
import { StandaloneThreadJournalPort } from '../src/session/standalone-thread-journal.js';
import type { RuntimeJournalRecord } from '../src/session/thread-journal-records.js';
import { foldThreadJournal, ThreadJournalWriter } from '../src/session/thread-journal.js';
import { TEST_MODEL } from './helpers/agent-harness.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'coda-standalone-recovery-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function options(streamFn: ReturnType<typeof createFauxStreamFn>) {
  return {
    dir: root,
    compaction: { enabled: false },
    agentConfig: {
      streamFn,
      model: TEST_MODEL,
      tools: [],
      systemPrompt: 'standalone recovery test',
      cwd: root,
    },
  };
}

interface CrashedActivityFixture {
  readonly file: string;
  readonly opId: ExternalOpId;
  readonly runId: RunId;
  readonly requestId?: string;
}

async function seedCrashedActivity(
  sessionId: string,
  opType: 'prompt' | 'continue',
  withPendingControl: boolean,
): Promise<CrashedActivityFixture> {
  const lease = await StandaloneSessionLease.acquire(root, sessionId);
  const events = new EventHub();
  let writer: ThreadJournalWriter | undefined;
  let journal: StandaloneThreadJournalPort | undefined;
  try {
    journal = await StandaloneThreadJournalPort.open({
      dir: root,
      sessionId,
      recordedCwd: root,
      lease,
    });
    const records = await journal.load();
    const state = foldThreadJournal(records);
    events.seed(journal.threadId, state.envelopes);
    writer = new ThreadJournalWriter({
      workspaceId: journal.workspaceId,
      threadId: journal.threadId,
      journal,
      events,
      clock: { now: () => 1_800_000_000_000 },
      state,
      records,
    });

    const suffix = opType === 'prompt' ? '1' : '2';
    const opId = `op_e_${suffix.repeat(32)}` as ExternalOpId;
    const runId = `run_crashed_${opType}` as RunId;
    const turnId = `turn_crashed_${opType}` as TurnId;
    const op = opType === 'prompt'
      ? {
          type: 'prompt' as const,
          opId,
          workspaceId: journal.workspaceId,
          threadId: journal.threadId,
          text: 'recover this prompt',
        }
      : {
          type: 'continue' as const,
          opId,
          workspaceId: journal.workspaceId,
          threadId: journal.threadId,
        };
    await writer.appendPrepare({
      type: 'mailbox_prepare',
      opId,
      op,
      timestamp: 1_800_000_000_000,
    });
    await writer.commit([{
      event: { type: 'op_accepted', opType },
      opId,
      runId,
    }], [
      { type: 'accepted_pending', opId, opType },
      {
        type: 'run_reserved',
        runId,
        ownerOpId: opId,
        reason: opType,
        permissionCeiling: state.meta.permissionCeiling,
      },
    ]);
    await writer.commit([{
      event: { type: 'op_started', opType },
      opId,
      runId,
    }], [{ type: 'started', opId }]);
    await writer.commit([{
      event: { type: 'agent_start', reason: opType },
      opId,
      runId,
    }], [{ type: 'run_started', runId }]);
    await writer.appendPrepare({
      type: 'turn_prepare',
      runId,
      turnId,
      turnOrdinal: 1,
      workspaceCeiling: state.meta.permissionCeiling,
      runCeiling: state.meta.permissionCeiling,
      turnCeiling: state.meta.permissionCeiling,
      timestamp: 1_800_000_000_000,
    });
    await writer.commit([{
      event: { type: 'turn_start' },
      runId,
      turnId,
    }], [{ type: 'turn_activated', runId, turnId, turnOrdinal: 1 }]);

    const requestId = withPendingControl ? `approval-crashed-${opType}` : undefined;
    if (requestId !== undefined) {
      const request: Extract<RuntimeEvent, { type: 'control_request' }> = {
        type: 'control_request',
        requestId,
        kind: 'approval',
        owningRunId: runId,
        owningTurnId: turnId,
        policyRevision: 'standalone-test-v1',
        payload: { toolCallId: 'call-crashed', description: 'pending at process death' },
      };
      await writer.commit([{
        event: request,
        runId,
        turnId,
      }], [{ type: 'control_requested', request }]);
    }
    return { file: journal.file, opId, runId, ...(requestId !== undefined && { requestId }) };
  } finally {
    if (writer !== undefined) await writer.close();
    else if (journal !== undefined) await journal.releaseWriteLease();
    events.close();
    lease.release();
  }
}

function readFolded(file: string) {
  const records = readFileSync(file, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as RuntimeJournalRecord);
  return foldThreadJournal(records);
}

describe('StandaloneSessionHost startup recovery barrier', () => {
  test('interrupts a crashed prompt and aborts its pending control before attach', async () => {
    const seed = await Session.create(options(createFauxStreamFn({ turns: [] })));
    const id = seed.id;
    await seed.close();
    const crashed = await seedCrashedActivity(id, 'prompt', true);
    const resumedStream = createFauxStreamFn({
      turns: [{ events: [{ kind: 'text', text: 'continued on a fresh run' }] }],
    });

    const resumed = await Session.resume(id, options(resumedStream));
    expect(resumedStream.calls).toHaveLength(0);
    let folded = readFolded(crashed.file);
    expect(folded.mailbox.get(crashed.opId)).toMatchObject({
      state: 'completed',
      outcome: 'interrupted',
    });
    expect(folded.runs.get(crashed.runId)).toMatchObject({
      state: 'terminal',
      status: 'interrupted',
    });
    expect(folded.summary.activeRunId).toBeUndefined();
    expect(folded.checkpoint.frontend.activity).toBeUndefined();
    expect(folded.checkpoint.frontend.pendingControls).toEqual([]);
    expect(folded.envelopes).toContainEqual(expect.objectContaining({
      runId: crashed.runId,
      event: expect.objectContaining({
        type: 'control_resolved',
        requestId: crashed.requestId,
        decision: 'aborted',
      }),
    }));

    await resumed.continue();
    expect(resumedStream.calls).toHaveLength(1);
    folded = readFolded(crashed.file);
    const freshRun = folded.envelopes.findLast((envelope) =>
      envelope.event.type === 'agent_start')?.runId;
    expect(freshRun).toBeDefined();
    expect(freshRun).not.toBe(crashed.runId);
    await resumed.close();
  });

  test('interrupts a crashed continue without dispatching its old RunId', async () => {
    const seed = await Session.create(options(createFauxStreamFn({ turns: [] })));
    const id = seed.id;
    await seed.close();
    const crashed = await seedCrashedActivity(id, 'continue', false);
    const resumedStream = createFauxStreamFn({ turns: [] });

    const resumed = await Session.resume(id, options(resumedStream));
    const folded = readFolded(crashed.file);
    expect(resumedStream.calls).toHaveLength(0);
    expect(folded.mailbox.get(crashed.opId)).toMatchObject({
      state: 'completed',
      outcome: 'interrupted',
    });
    expect(folded.runs.get(crashed.runId)).toMatchObject({
      state: 'terminal',
      status: 'interrupted',
    });
    expect(folded.envelopes.findLast((envelope) =>
      envelope.opId === crashed.opId && envelope.event.type === 'op_completed'))
      .toMatchObject({
        runId: crashed.runId,
        event: {
          type: 'op_completed',
          opType: 'continue',
          terminalRunId: crashed.runId,
          outcome: 'interrupted',
        },
      });
    await resumed.close();
  });
});
