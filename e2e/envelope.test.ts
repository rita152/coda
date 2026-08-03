// Canonical CLI transport gate: NDJSON stdin must remain a command stream in envelope mode.

import { afterEach, beforeAll, expect, test } from 'bun:test';
import type { CodaProc, Ev } from './harness.js';
import { CASE_TIMEOUT_MS, msgText, requireDist, startCoda } from './harness.js';

const WORKSPACE_ID = 'workspace-envelope-e2e';
const THREAD_ID = 'thread-envelope-e2e';
const CREATE_OP_ID = 'op_e_00000000000000000000000000000001';

beforeAll(() => requireDist());

const processes: CodaProc[] = [];
afterEach(() => {
  for (const process of processes.splice(0)) process.kill();
});

test('envelope mode reads RuntimeOps from piped stdin instead of consuming it as one-shot text', async () => {
  const process = startCoda({
    script: { turns: [], onExhausted: 'emptyStop' },
    extraArgs: ['--event-format=envelope', '--workspace', WORKSPACE_ID],
  });
  processes.push(process);

  const protocol = await process.waitForEvent((frame) => frame.type === 'protocol', 'envelope protocol');
  expect(protocol).toEqual({
    type: 'protocol',
    protocolVersion: '1.1.0',
    eventFormat: 'envelope',
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
  const created = await process.waitForEvent(isThreadCreatedEnvelope, 'thread_created envelope');
  expect(created).toMatchObject({
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    opId: CREATE_OP_ID,
    event: { type: 'thread_created', thread: { threadId: THREAD_ID, state: 'idle' } },
  });
  expect(Number.isSafeInteger(created.seq)).toBe(true);

  process.send({ type: 'transport_shutdown' });
  expect(await process.waitForExit()).toBe(0);
  expect(process.parseErrors).toEqual([]);
}, { timeout: CASE_TIMEOUT_MS });

test('legacy CLI resume adopts a crash-recovered Supervisor attachment', async () => {
  const first = startCoda({
    script: { turns: [], onExhausted: 'emptyStop' },
    extraArgs: ['--event-format=envelope', '--workspace', WORKSPACE_ID],
  });
  processes.push(first);
  await first.waitForEvent((frame) => frame.type === 'protocol', 'first protocol');
  first.send({
    type: 'thread_create',
    opId: CREATE_OP_ID,
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    model: { provider: 'faux', api: 'faux', model: 'faux' },
  });
  await first.waitForEvent(
    (frame) => frame.type === 'op_receipt' &&
      (frame.receipt as { accepted?: unknown } | undefined)?.accepted === true,
    'accepted create before crash',
  );
  first.kill();
  await first.waitForExit();

  const second = startCoda({
    script: {
      turns: [{ events: [{ kind: 'text', text: 'resumed after crash' }] }],
      onExhausted: 'emptyStop',
    },
    cwd: first.cwd,
    sessionDir: first.sessionDir,
    extraArgs: [`--resume=${THREAD_ID}`],
  });
  processes.push(second);
  await second.waitForEvent((frame) => frame.type === 'protocol', 'resumed protocol');
  second.send({ type: 'prompt', text: 'continue recovered attachment' });
  const answer = await second.waitForEvent(
    (frame) => frame.type === 'message_end' && msgText(frame) === 'resumed after crash',
    'answer after crash recovery',
  );
  expect(msgText(answer)).toBe('resumed after crash');
  await second.waitForEvent(
    (frame) => frame.type === 'agent_end' && frame.reason === 'completed',
    'terminal event after crash recovery',
  );
  second.send({ type: 'shutdown' });
  expect(await second.waitForExit()).toBe(0);
  expect(second.parseErrors).toEqual([]);
}, { timeout: CASE_TIMEOUT_MS });

function isThreadCreatedEnvelope(frame: Ev): boolean {
  return (frame.event as { type?: unknown } | undefined)?.type === 'thread_created';
}
