import { describe, expect, test } from 'bun:test';

import {
  assertExternalOpId,
  assertRunId,
  assertThreadId,
  assertTurnId,
  assertWorkspaceId,
  deriveOpId,
  RuntimeIdentityValidationError,
} from './identity.js';
import {
  EventEnvelopeValidationError,
  projectLegacySessionEvent,
  validateEventEnvelope,
} from './runtime-events.js';
import type { EventEnvelope } from './runtime-events.js';

const WORKSPACE = assertWorkspaceId('workspace');
const THREAD_A = assertThreadId('thread-A');
const THREAD_B = assertThreadId('thread-B');
const RUN = assertRunId('run-A');
const TURN = assertTurnId('turn-A');
const OP = assertExternalOpId('op_e_00000000000000000000000000000000');

function envelope(event: unknown, fields: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    workspaceId: WORKSPACE,
    threadId: THREAD_A,
    seq: 1,
    timestamp: 10,
    event,
    ...fields,
  };
}

describe('EventEnvelope validation', () => {
  test('the same seq is independently valid in different thread domains', () => {
    const a = validateEventEnvelope(envelope({ type: 'agent_start', reason: 'prompt' }, { runId: RUN }));
    const b = validateEventEnvelope({ ...a, threadId: THREAD_B });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(1);
    expect(a.threadId).not.toBe(b.threadId);
  });

  test('seq is positive and safe while turn identity always requires run identity', () => {
    for (const seq of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expectInvalid(envelope({ type: 'agent_start', reason: 'prompt' }, { runId: RUN, seq }));
    }
    expect(validateEventEnvelope(envelope(
      { type: 'agent_start', reason: 'prompt' },
      { runId: RUN, seq: Number.MAX_SAFE_INTEGER },
    )).seq).toBe(Number.MAX_SAFE_INTEGER);
    expectInvalid(envelope({ type: 'turn_start' }, { turnId: TURN }));
    expectInvalid(envelope({ type: 'turn_start' }, { runId: RUN }));
  });

  test('event-family presence and correlation fields are exact', () => {
    validateEventEnvelope(envelope({ type: 'turn_start' }, { runId: RUN, turnId: TURN }));
    validateEventEnvelope(envelope(
      { type: 'op_accepted', opType: 'prompt' },
      { runId: RUN, opId: OP },
    ));
    expectInvalid(envelope({ type: 'op_accepted', opType: 'prompt' }, { opId: OP }));
    expectInvalid(envelope(
      { type: 'op_rejected', opType: 'prompt', reason: 'busy' },
      { runId: RUN, opId: OP },
    ));

    validateEventEnvelope(envelope({
      type: 'control_request',
      requestId: 'req',
      kind: 'approval',
      owningRunId: RUN,
      owningTurnId: TURN,
      policyRevision: 'policy',
      payload: { toolCallId: 'call', description: 'approve' },
    }, { runId: RUN, turnId: TURN }));
    expectInvalid(envelope({
      type: 'control_request',
      requestId: 'req',
      kind: 'approval',
      owningRunId: assertRunId('other-run'),
      owningTurnId: TURN,
      policyRevision: 'policy',
      payload: { toolCallId: 'call', description: 'approve' },
    }, { runId: RUN, turnId: TURN }));

    expectInvalid(envelope({
      type: 'control_request',
      owningRunId: RUN,
      owningTurnId: TURN,
    }, { runId: RUN, turnId: TURN }));
    expectInvalid(envelope({
      type: 'control_resolved',
      requestId: 'req',
      kind: 'resource_confirmation',
      owningRunId: RUN,
      owningTurnId: TURN,
      policyRevision: 'policy',
      decision: 'allow_once',
    }, { runId: RUN, turnId: TURN, opId: OP }));
  });

  test('lifecycle payload thread identity must match the target envelope', () => {
    validateEventEnvelope(envelope({
      type: 'thread_created',
      thread: {
        threadId: THREAD_A,
        createdAt: 1,
        state: 'idle',
      },
    }, { opId: OP }));
    expectInvalid(envelope({
      type: 'thread_resumed',
      thread: {
        threadId: THREAD_B,
        createdAt: 1,
        state: 'idle',
      },
    }, { opId: OP }));
    expectInvalid(envelope({ type: 'thread_created', thread: { threadId: THREAD_A } }, { opId: OP }));
  });

  test('validates UX3 thread updates, manual compaction, and activity completion identities', () => {
    validateEventEnvelope(envelope({
      type: 'thread_updated',
      changed: 'title',
      thread: {
        threadId: THREAD_A,
        createdAt: 1,
        updatedAt: 10,
        title: 'Review',
        state: 'idle',
      },
    }, { opId: OP }));
    validateEventEnvelope(envelope({
      type: 'compaction_start',
      reason: 'manual',
      predecessorRunId: assertRunId('run-before-compact'),
      activityRunId: RUN,
    }, { runId: RUN }));
    validateEventEnvelope(envelope({
      type: 'op_completed',
      opType: 'compact',
      terminalRunId: RUN,
      outcome: 'applied',
    }, { runId: RUN, opId: OP }));
    expectInvalid(envelope({
      type: 'op_completed',
      opType: 'compact',
      outcome: 'applied',
    }, { runId: RUN, opId: OP }));
  });

  test('accepts only an identity-correlated authoritative approval presentation', () => {
    const scope = {
      kind: 'canonical_resources_v1' as const,
      resourcePatterns: [{
        resourceType: 'filesystem' as const,
        access: 'write' as const,
        matcher: 'canonical_target_exact_v1' as const,
        pattern: '/workspace/file.ts',
      }],
      attributes: {},
    };
    const presentation = {
      requestId: 'req-card',
      target: { workspaceId: WORKSPACE, threadId: THREAD_A, runId: RUN, turnId: TURN },
      capability: {
        id: 'filesystem.edit',
        version: '1',
        registrationDigest: 'capreg-v1',
      },
      normalizedResources: [{
        selectorId: 'target',
        resourceType: 'filesystem',
        access: 'write',
        canonicalTarget: '/workspace/file.ts',
      }],
      risk: { code: 'write_requires_approval', reason: 'write', description: 'Edit file' },
      allowOnce: { invocationId: 'invocation-1', toolCallId: 'call-card' },
      allowAlways: scope,
      revisions: {
        catalog: 4,
        effectivePolicy: 'effective-4',
        policyBasis: 'basis-4',
        ceiling: 'ceiling-4',
        grants: 'grants-4',
      },
    };
    validateEventEnvelope(envelope({
      type: 'control_request',
      requestId: 'req-card',
      kind: 'approval',
      owningRunId: RUN,
      owningTurnId: TURN,
      policyRevision: 'effective-4',
      payload: {
        toolCallId: 'call-card',
        description: 'Edit file',
        grantProposal: {
          capabilityId: 'filesystem.edit',
          capabilityVersion: '1',
          registrationDigest: 'capreg-v1',
          policyBasisRevision: 'basis-4',
          scope,
        },
        presentation,
      },
    }, { runId: RUN, turnId: TURN }));
    const payload = {
      toolCallId: 'call-card',
      description: 'Edit file',
      grantProposal: {
        capabilityId: 'filesystem.edit',
        capabilityVersion: '1',
        registrationDigest: 'capreg-v1',
        policyBasisRevision: 'basis-4',
        scope,
      },
      presentation,
    };
    const presentationWithoutAllowAlways: Partial<typeof presentation> = { ...presentation };
    delete presentationWithoutAllowAlways.allowAlways;
    const invalidPayloads = [
      { ...payload, description: 'Different description' },
      { ...payload, presentation: { ...presentation, requestId: 'different-request' } },
      { ...payload, presentation: { ...presentation, target: {
        ...presentation.target,
        workspaceId: assertWorkspaceId('workspace-other'),
      } } },
      { ...payload, presentation: { ...presentation, target: {
        ...presentation.target,
        threadId: assertThreadId('thread-other'),
      } } },
      { ...payload, presentation: { ...presentation, revisions: {
        ...presentation.revisions,
        effectivePolicy: 'effective-other',
      } } },
      { ...payload, presentation: { ...presentation, capability: {
        ...presentation.capability,
        id: 'filesystem.read',
      } } },
      { ...payload, presentation: { ...presentation, capability: {
        ...presentation.capability,
        version: '2',
      } } },
      { ...payload, presentation: { ...presentation, capability: {
        ...presentation.capability,
        registrationDigest: 'capreg-other',
      } } },
      { ...payload, presentation: { ...presentation, revisions: {
        ...presentation.revisions,
        policyBasis: 'basis-other',
      } } },
      { ...payload, presentation: { ...presentation, allowAlways: {
        ...scope,
        attributes: { cwd: '/other' },
      } } },
      { ...payload, presentation: presentationWithoutAllowAlways },
      { ...payload, grantProposal: undefined },
    ];
    for (const invalidPayload of invalidPayloads) {
      expectInvalid(envelope({
        type: 'control_request',
        requestId: 'req-card',
        kind: 'approval',
        owningRunId: RUN,
        owningTurnId: TURN,
        policyRevision: 'effective-4',
        payload: invalidPayload,
      }, { runId: RUN, turnId: TURN }));
    }
  });

  test('immediate op origin and parent links follow the event family', () => {
    const derivedAbort = deriveOpId({
      purpose: 'cancel_target',
      workspaceId: WORKSPACE,
      parts: [OP, THREAD_A],
    });
    const derivedClose = deriveOpId({
      purpose: 'thread_close_on_runtime_close',
      workspaceId: WORKSPACE,
      parts: [THREAD_A, OP],
    });
    const derivedRecovery = deriveOpId({
      purpose: 'control_recovery',
      workspaceId: WORKSPACE,
      parts: [THREAD_A, 'req'],
    });

    validateEventEnvelope(envelope(
      { type: 'op_accepted', opType: 'abort', parentOpId: OP },
      { opId: derivedAbort },
    ));
    expectInvalid(envelope({ type: 'op_accepted', opType: 'abort' }, { opId: derivedAbort }));
    expectInvalid(envelope(
      { type: 'op_accepted', opType: 'abort', parentOpId: OP },
      { opId: OP },
    ));
    validateEventEnvelope(envelope(
      { type: 'op_completed', opType: 'thread_close', outcome: 'applied' },
      { opId: derivedClose },
    ));

    for (const opType of [
      'thread_create',
      'thread_resume',
      'prompt',
      'continue',
      'steer',
      'follow_up',
      'set_model',
      'control_response',
    ]) {
      expectInvalid(envelope(
        { type: 'op_rejected', opType, reason: 'rejected' },
        { opId: derivedAbort },
      ));
    }

    expectInvalid(envelope({
      type: 'thread_created',
      thread: { threadId: THREAD_A, createdAt: 1, state: 'idle' },
    }, { opId: derivedClose }));
    validateEventEnvelope(envelope(
      { type: 'thread_closed', threadId: THREAD_A },
      { opId: derivedClose },
    ));
    expectInvalid(envelope(
      { type: 'agent_start', reason: 'prompt' },
      { runId: RUN, opId: derivedAbort },
    ));
    expectInvalid(envelope(
      { type: 'queue_update', steering: [], followUp: [] },
      { opId: derivedAbort },
    ));

    expectInvalid(envelope({
      type: 'control_resolved',
      requestId: 'req',
      kind: 'approval',
      owningRunId: RUN,
      owningTurnId: TURN,
      policyRevision: 'policy',
      decision: 'allow_once',
    }, { runId: RUN, turnId: TURN, opId: derivedRecovery }));
    validateEventEnvelope(envelope({
      type: 'control_resolved',
      requestId: 'req',
      kind: 'approval',
      owningRunId: RUN,
      owningTurnId: TURN,
      policyRevision: 'policy',
      decision: 'aborted',
    }, { runId: RUN, turnId: TURN, opId: derivedRecovery }));
  });

  test('message_update contentIndex and terminal block values match the partial', () => {
    const textPartial = assistant([{ type: 'text', text: 'hello' }]);
    validateEventEnvelope(messageUpdate({
      type: 'text_end',
      contentIndex: 0,
      content: 'hello',
      partial: textPartial,
    }));
    expectInvalid(messageUpdate({
      type: 'text_start',
      contentIndex: 1,
      partial: textPartial,
    }));
    expectInvalid(messageUpdate({
      type: 'reasoning_start',
      contentIndex: 0,
      partial: textPartial,
    }));
    validateEventEnvelope(messageUpdate({
      type: 'reasoning_end',
      contentIndex: 0,
      content: 'safe summary',
      partial: assistant([{ type: 'reasoning', kind: 'summary', text: 'safe summary' }]),
    }));
    expectInvalid(messageUpdate({
      type: 'reasoning_end',
      contentIndex: 0,
      content: 'unknown reasoning',
      partial: assistant([{ type: 'reasoning', kind: 'unknown', text: 'unknown reasoning' }]),
    }));
    expectInvalid(messageUpdate({
      type: 'text_end',
      contentIndex: 0,
      content: 'different',
      partial: textPartial,
    }));

    const toolCall = {
      type: 'tool_call',
      id: 'call',
      name: 'read',
      arguments: { path: '/tmp/a' },
    };
    validateEventEnvelope(messageUpdate({
      type: 'tool_call_end',
      contentIndex: 0,
      toolCall,
      partial: assistant([toolCall]),
    }));
    expectInvalid(messageUpdate({
      type: 'tool_call_end',
      contentIndex: 0,
      toolCall: { ...toolCall, arguments: { path: '/tmp/b' } },
      partial: assistant([toolCall]),
    }));
  });

  test('assistant text accepts only commentary/final phases without widening user text', () => {
    for (const phase of ['commentary', 'final_answer'] as const) {
      const partial = assistant([{ type: 'text', text: phase, phase }]);
      validateEventEnvelope(messageUpdate({
        type: 'text_end',
        contentIndex: 0,
        content: phase,
        partial,
      }));
    }

    expectInvalid(messageUpdate({
      type: 'text_end',
      contentIndex: 0,
      content: 'bad',
      partial: assistant([{ type: 'text', text: 'bad', phase: 'thinking' }]),
    }));
    expectInvalid(envelope({
      type: 'message_start',
      message: {
        role: 'user',
        id: 'user-with-phase',
        timestamp: 1,
        content: [{ type: 'text', text: 'not assistant commentary', phase: 'commentary' }],
      },
    }, { runId: RUN, turnId: TURN }));
  });

  test('rejects explicit undefined, unknown envelope fields, and ill-formed identities', () => {
    expectInvalid(envelope(
      { type: 'agent_start', reason: 'prompt' },
      { runId: RUN, turnId: undefined },
    ));
    expectInvalid(envelope(
      { type: 'agent_start', reason: 'prompt' },
      { runId: RUN, globalSeq: 1 },
    ));
    expectInvalid(envelope(
      { type: 'agent_start', reason: 'prompt' },
      { runId: '\ud800' },
    ));
  });

  test('thread results use the derived result id as the immediate envelope op id', () => {
    const resultOpId = deriveOpId({
      purpose: 'thread_result',
      workspaceId: WORKSPACE,
      parts: [THREAD_A, THREAD_B, RUN],
    });
    validateEventEnvelope(envelope({
      type: 'thread_result',
      resultOpId,
      childThreadId: THREAD_B,
      terminalRunId: RUN,
      status: 'completed',
    }, { opId: resultOpId }));
    expectInvalid(envelope({
      type: 'thread_result',
      resultOpId,
      childThreadId: THREAD_B,
      terminalRunId: RUN,
      status: 'completed',
    }, { opId: OP }));
  });
});

describe('legacy SessionEvent projection', () => {
  test('filters by thread and preserves canonical agent events', () => {
    const canonical = validateEventEnvelope(envelope(
      { type: 'agent_end', reason: 'completed', messages: [], willRetry: true },
      { runId: RUN },
    ));
    expect(projectLegacySessionEvent(canonical, { targetThreadId: THREAD_A })).toEqual({
      type: 'agent_end',
      reason: 'completed',
      messages: [],
      willRetry: true,
    });
    expect(projectLegacySessionEvent(canonical, { targetThreadId: THREAD_B })).toBeUndefined();
  });

  test('maps approval request fields and drops canonical-only control/lifecycle families', () => {
    const request = validateEventEnvelope(envelope({
      type: 'control_request',
      requestId: 'req-1',
      kind: 'approval',
      owningRunId: RUN,
      owningTurnId: TURN,
      policyRevision: 'policy',
      payload: { toolCallId: 'call-1', description: 'approve me' },
    }, { runId: RUN, turnId: TURN }));
    expect(projectLegacySessionEvent(request, { targetThreadId: THREAD_A })).toEqual({
      type: 'approval_request',
      approvalId: 'req-1',
      toolCallId: 'call-1',
      description: 'approve me',
    });

    const resolved = validateEventEnvelope(envelope({
      type: 'control_resolved',
      requestId: 'req-1',
      kind: 'approval',
      owningRunId: RUN,
      owningTurnId: TURN,
      policyRevision: 'policy',
      decision: 'deny',
    }, { runId: RUN, turnId: TURN, opId: OP }));
    expect(projectLegacySessionEvent(resolved, { targetThreadId: THREAD_A })).toBeUndefined();
  });

  test('strips successor/activity identities from coordinator events', () => {
    const successor = assertRunId('run-successor');
    const scheduled = validateEventEnvelope(envelope({
      type: 'retry_scheduled',
      attempt: 1,
      maxAttempts: 3,
      delayMs: 100,
      errorMessage: 'retry',
      predecessorRunId: RUN,
      successorRunId: successor,
    }, { runId: successor }));
    expect(projectLegacySessionEvent(scheduled, { targetThreadId: THREAD_A })).toEqual({
      type: 'retry_scheduled',
      attempt: 1,
      maxAttempts: 3,
      delayMs: 100,
      errorMessage: 'retry',
    });
  });

  test('validates the target identity synchronously', () => {
    const canonical = validateEventEnvelope(envelope(
      { type: 'agent_start', reason: 'prompt' },
      { runId: RUN },
    ));
    expect(() => projectLegacySessionEvent(canonical, { targetThreadId: '' as never })).toThrow(
      RuntimeIdentityValidationError,
    );
  });
});

function expectInvalid(input: unknown): void {
  expect(() => validateEventEnvelope(input)).toThrow(EventEnvelopeValidationError);
}

function assistant(content: readonly unknown[]): unknown {
  return {
    role: 'assistant',
    id: 'assistant-1',
    timestamp: 1,
    content,
    model: { provider: 'test', api: 'faux', model: 'model' },
    stopReason: 'stop',
    usage: { input: 0, output: 0 },
  };
}

function messageUpdate(providerEvent: unknown): unknown {
  return envelope({
    type: 'message_update',
    messageId: 'assistant-1',
    event: providerEvent,
  }, { runId: RUN, turnId: TURN });
}

// Compile-time witness for the public generic's default event type.
const _envelopeWitness: EventEnvelope = {
  workspaceId: WORKSPACE,
  threadId: THREAD_A,
  runId: RUN,
  seq: 1,
  timestamp: 0,
  event: { type: 'agent_start', reason: 'prompt' },
};
void _envelopeWitness;
