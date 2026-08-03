// Canonical resume: a later process reattaches a persisted thread with thread_resume RuntimeOp.

import { afterEach, beforeAll, expect, test } from 'bun:test';
import type { CodaProc } from './harness.js';
import { CASE_TIMEOUT_MS, msgRole, msgText, requireDist, startCoda } from './harness.js';

const WORKSPACE_ID = 'workspace-resume-e2e';
const THREAD_ID = 'thread-resume-e2e';

beforeAll(() => requireDist());

const processes: CodaProc[] = [];
afterEach(() => {
  for (const process of processes.splice(0)) process.kill();
});

function track(process: CodaProc): CodaProc {
  processes.push(process);
  return process;
}

test('thread_resume restores a persisted thread in a later canonical transport process', async () => {
  const first = track(startCoda({
    extraArgs: ['--workspace', WORKSPACE_ID],
    script: { turns: [{ events: [{ kind: 'text', text: 'answer one' }] }], onExhausted: 'emptyStop' },
  }));
  await first.waitForEvent((event) => event.type === 'protocol', 'first protocol hello');
  first.send({
    type: 'thread_create',
    opId: 'op_e_00000000000000000000000000000031',
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    model: { provider: 'faux', api: 'faux', model: 'faux' },
  });
  await first.waitForEvent((event) => event.type === 'thread_created', 'first thread_created');
  first.send({
    type: 'prompt',
    opId: 'op_e_00000000000000000000000000000032',
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    text: 'first question',
  });
  await first.waitForEvent((event) => event.type === 'agent_end', 'first agent_end');
  first.endStdin();
  expect(await first.waitForExit()).toBe(0);

  const second = track(startCoda({
    cwd: first.cwd,
    extraArgs: ['--workspace', WORKSPACE_ID],
    script: { turns: [{ events: [{ kind: 'text', text: 'answer two' }] }], onExhausted: 'emptyStop' },
  }));
  await second.waitForEvent((event) => event.type === 'protocol', 'second protocol hello');
  second.send({
    type: 'thread_resume',
    opId: 'op_e_00000000000000000000000000000033',
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    model: { provider: 'faux', api: 'faux', model: 'faux' },
  });
  const resumed = await second.waitForEvent((event) => event.type === 'thread_resumed', 'thread_resumed');
  expect(resumed).toMatchObject({ workspaceId: WORKSPACE_ID, threadId: THREAD_ID });
  second.send({
    type: 'prompt',
    opId: 'op_e_00000000000000000000000000000034',
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    text: 'second question',
  });
  const end = await second.waitForEvent((event) => event.type === 'agent_end', 'second agent_end');
  expect(end.reason).toBe('completed');
  const answer = second.events.find((event) =>
    event.type === 'message_end' && msgRole(event) === 'assistant',
  );
  expect(msgText(answer)).toBe('answer two');

  second.endStdin();
  expect(await second.waitForExit()).toBe(0);
  expect(first.parseErrors).toEqual([]);
  expect(second.parseErrors).toEqual([]);
}, { timeout: CASE_TIMEOUT_MS });
