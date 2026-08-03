// Canonical --json transport: complete RuntimeOps, EventEnvelopes, duplicate OpId, and EOF.

import { afterEach, beforeAll, expect, test } from 'bun:test';
import type { CodaProc } from './harness.js';
import {
  assertSubsequence,
  CASE_TIMEOUT_MS,
  msgRole,
  msgText,
  requireDist,
  startCoda,
  typeSeq,
} from './harness.js';

const WORKSPACE_ID = 'workspace-headless-e2e';
const THREAD_ID = 'thread-headless-e2e';
const CREATE_OP_ID = 'op_e_00000000000000000000000000000011';
const PROMPT_OP_ID = 'op_e_00000000000000000000000000000012';

beforeAll(() => requireDist());

const procs: CodaProc[] = [];
afterEach(() => {
  for (const process of procs.splice(0)) process.kill();
});

function track(process: CodaProc): CodaProc {
  procs.push(process);
  return process;
}

function createThreadOp() {
  return {
    type: 'thread_create' as const,
    opId: CREATE_OP_ID,
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    model: { provider: 'faux', api: 'faux', model: 'faux' },
  };
}

function promptOp(text: string) {
  return {
    type: 'prompt' as const,
    opId: PROMPT_OP_ID,
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    text,
  };
}

test('create + prompt emits envelopes, and a duplicate external OpId is idempotent', async () => {
  const proc = track(startCoda({
    extraArgs: ['--workspace', WORKSPACE_ID],
    script: {
      turns: [{ events: [{ kind: 'text', text: 'Hello from faux!' }] }],
      onExhausted: 'emptyStop',
    },
  }));

  await proc.waitForEvent((event) => event.type === 'protocol', 'protocol hello');
  proc.send(createThreadOp());
  await proc.waitForEvent((event) => event.type === 'thread_created', 'thread_created');
  await proc.waitForEvent(
    (event) => event.type === 'op_receipt' &&
      (event.receipt as { opId?: unknown }).opId === CREATE_OP_ID,
    'thread_create receipt',
  );

  proc.send(promptOp('say hello'));
  const end = await proc.waitForEvent((event) => event.type === 'agent_end', 'agent_end');
  expect(end.reason).toBe('completed');
  const assistantEnd = proc.events.find((event) =>
    event.type === 'message_end' && msgRole(event) === 'assistant',
  );
  expect(msgText(assistantEnd)).toBe('Hello from faux!');

  proc.send(promptOp('say hello'));
  const duplicate = await proc.waitForEvent(
    (event) => event.type === 'op_receipt' &&
      (event.receipt as { duplicate?: unknown }).duplicate === true,
    'duplicate prompt receipt',
  );
  expect(duplicate.receipt).toMatchObject({ accepted: true, opId: PROMPT_OP_ID, duplicate: true });
  expect(proc.events.filter((event) => event.type === 'agent_start')).toHaveLength(1);

  proc.endStdin();
  expect(await proc.waitForExit()).toBe(0);
  assertSubsequence(typeSeq(proc.events), [
    'protocol',
    'thread_created',
    'op_receipt',
    'agent_start',
    'op_receipt',
    'message_start(user)',
    'message_end(assistant)',
    'agent_end',
    'op_receipt',
  ]);
  expect(proc.parseErrors).toEqual([]);
}, { timeout: CASE_TIMEOUT_MS });

test('invalid NDJSON becomes transport_error and a later full RuntimeOp still runs', async () => {
  const proc = track(startCoda({
    extraArgs: ['--workspace', WORKSPACE_ID],
    script: {
      turns: [{ events: [{ kind: 'text', text: 'still alive' }] }],
      onExhausted: 'emptyStop',
    },
  }));
  await proc.waitForEvent((event) => event.type === 'protocol', 'protocol hello');
  proc.sendRaw('not json\n');
  const invalid = await proc.waitForEvent(
    (event) => event.type === 'transport_error',
    'invalid input transport error',
  );
  expect(invalid).toMatchObject({ fatal: false, code: 'invalid_input' });

  proc.send(createThreadOp());
  await proc.waitForEvent((event) => event.type === 'thread_created', 'thread_created');
  proc.send(promptOp('continue after error'));
  await proc.waitForEvent((event) => event.type === 'agent_end', 'agent_end');

  proc.endStdin();
  expect(await proc.waitForExit()).toBe(0);
  expect(proc.parseErrors).toEqual([]);
}, { timeout: CASE_TIMEOUT_MS });
