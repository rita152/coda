// Canonical CLI transport gate: --json accepts full RuntimeOps and emits only canonical frames.

import { afterEach, beforeAll, expect, test } from 'bun:test';
import type { CodaProc } from './harness.js';
import { CASE_TIMEOUT_MS, requireDist, startCoda } from './harness.js';

const WORKSPACE_ID = 'workspace-envelope-e2e';
const THREAD_ID = 'thread-envelope-e2e';
const CREATE_OP_ID = 'op_e_00000000000000000000000000000001';

beforeAll(() => requireDist());

const processes: CodaProc[] = [];
afterEach(() => {
  for (const process of processes.splice(0)) process.kill();
});

test('canonical --json emits a 2.0 hello and full EventEnvelopes for RuntimeOps', async () => {
  const process = startCoda({
    script: { turns: [], onExhausted: 'emptyStop' },
    extraArgs: ['--workspace', WORKSPACE_ID],
  });
  processes.push(process);

  const protocol = await process.waitForEvent((frame) => frame.type === 'protocol', 'protocol hello');
  expect(protocol).toEqual({
    type: 'protocol',
    protocolVersion: '2.0.0',
    workspaceId: WORKSPACE_ID,
  });

  process.send({
    type: 'thread_create',
    opId: CREATE_OP_ID,
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    model: { provider: 'faux', api: 'faux', model: 'faux' },
  });

  const receipt = await process.waitForEvent(
    (frame) => frame.type === 'op_receipt',
    'thread_create receipt',
  );
  expect(receipt.receipt).toMatchObject({
    accepted: true,
    duplicate: false,
    opId: CREATE_OP_ID,
    threadId: THREAD_ID,
  });
  const created = await process.waitForEvent(
    (event) => event.type === 'thread_created',
    'thread_created envelope',
  );
  expect(created).toMatchObject({
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    opId: CREATE_OP_ID,
    thread: { threadId: THREAD_ID, state: 'idle' },
  });
  expect(Number.isSafeInteger(created.seq)).toBe(true);
  expect(process.frames.some((frame) => 'event' in frame && frame.event.type === 'thread_created')).toBe(true);
  expect(process.frames.every((frame) => {
    if ('event' in frame) return true;
    return frame.type === 'protocol' || frame.type === 'op_receipt' || frame.type === 'transport_error';
  })).toBe(true);

  process.endStdin();
  expect(await process.waitForExit()).toBe(0);
  expect(process.parseErrors).toEqual([]);
}, { timeout: CASE_TIMEOUT_MS });
