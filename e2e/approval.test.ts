// Canonical headless control flow: wait for Runtime control_request and answer with RuntimeOp.

import { afterEach, beforeAll, expect, test } from 'bun:test';
import type { CodaProc } from './harness.js';
import {
  CASE_TIMEOUT_MS,
  requireDist,
  resultText,
  startCoda,
} from './harness.js';

const WORKSPACE_ID = 'workspace-control-e2e';
const THREAD_ID = 'thread-control-e2e';
const CREATE_OP_ID = 'op_e_00000000000000000000000000000021';
const PROMPT_OP_ID = 'op_e_00000000000000000000000000000022';
const RESPONSE_OP_ID = 'op_e_00000000000000000000000000000023';

beforeAll(() => requireDist());

const processes: CodaProc[] = [];
afterEach(() => {
  for (const process of processes.splice(0)) process.kill();
});

test('approval control_request is answered by a fully identified control_response', async () => {
  const process = startCoda({
    extraArgs: ['--workspace', WORKSPACE_ID, '--approval-mode', 'interactive'],
    script: {
      turns: [
        { events: [{ kind: 'tool_call', name: 'bash', args: { command: 'echo approved-run' } }] },
        { events: [{ kind: 'text', text: 'approved and completed' }] },
      ],
      onExhausted: 'emptyStop',
    },
  });
  processes.push(process);

  await process.waitForEvent((event) => event.type === 'protocol', 'protocol hello');
  process.send({
    type: 'thread_create',
    opId: CREATE_OP_ID,
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    model: { provider: 'faux', api: 'faux', model: 'faux' },
  });
  await process.waitForEvent((event) => event.type === 'thread_created', 'thread_created');
  process.send({
    type: 'prompt',
    opId: PROMPT_OP_ID,
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    text: 'run the command',
  });

  const request = await process.waitForEvent(
    (event) => event.type === 'control_request' && event.kind === 'approval',
    'approval control_request',
  );
  expect(typeof request.requestId).toBe('string');
  expect(typeof request.owningRunId).toBe('string');
  expect(typeof request.owningTurnId).toBe('string');
  expect(request.workspaceId).toBe(WORKSPACE_ID);
  expect(request.threadId).toBe(THREAD_ID);

  process.send({
    type: 'control_response',
    opId: RESPONSE_OP_ID,
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    requestId: request.requestId as string,
    decision: 'allow_once',
  });
  const receipt = await process.waitForEvent(
    (event) => event.type === 'op_receipt' &&
      (event.receipt as { opId?: unknown }).opId === RESPONSE_OP_ID,
    'control_response receipt',
  );
  expect(receipt.receipt).toMatchObject({ accepted: true, opId: RESPONSE_OP_ID });

  const resolved = await process.waitForEvent(
    (event) => event.type === 'control_resolved' && event.requestId === request.requestId,
    'control_resolved',
  );
  expect(resolved).toMatchObject({ decision: 'allow_once', owningRunId: request.owningRunId });
  const toolEnd = await process.waitForEvent((event) => event.type === 'tool_execution_end', 'tool end');
  expect(resultText(toolEnd)).toContain('approved-run');
  const end = await process.waitForEvent((event) => event.type === 'agent_end', 'agent_end');
  expect(end.reason).toBe('completed');

  process.endStdin();
  expect(await process.waitForExit()).toBe(0);
  expect(process.parseErrors).toEqual([]);
}, { timeout: CASE_TIMEOUT_MS });
