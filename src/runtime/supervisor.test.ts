import { describe, expect, test } from 'bun:test';
import {
  PROTOCOL_VERSION,
  deriveOpId,
  runtimeOpPayloadHash,
} from '../protocol/index.js';
import type {
  ExternalOpId,
  ModelConfig,
  ModelRef,
  PermissionCeilingSnapshot,
  RunId,
  RuntimeOp,
  ThreadId,
  WorkspaceId,
} from '../protocol/index.js';
import { WorkspaceEventStream } from './event-stream.js';
import { createMemoryRuntimeStorage } from './memory-storage.js';
import type {
  LegacyApprovalAdapter,
  LegacyApprovalInvocationResult,
  LegacyApprovalPatternRepository,
  PermissionPolicyPort,
  PreparedThreadDriverCommand,
  RecoveryQueueCommand,
  RuntimeIdentityFactory,
  RuntimeStoragePort,
  RuntimeWorkspaceStoragePort,
  SupervisorOpLedgerRecord,
  ThreadDriverAttachment,
  ThreadDriverCheckpoint,
  ThreadDriverCompletion,
  ThreadDriverFactory,
  ThreadDriverHostServices,
  ThreadDriverPort,
  ThreadJournalPort,
  ThreadMetaRecord,
} from './ports.js';
import { createRuntime } from './supervisor.js';
import { emptyCheckpoint, foldThreadJournal, ThreadJournalWriter } from './thread-journal.js';

const WORKSPACE_ID = 'workspace-supervisor-recovery' as WorkspaceId;
const CWD = '/runtime/supervisor-recovery';
const MODEL: ModelConfig = { ref: { provider: 'faux', api: 'faux', model: 'recovery' } };
const CEILING = { revision: 'test-ceiling', constraints: [] } as const;

describe('Supervisor recovery and idempotency', () => {
  test.each([
    ['empty cwd', ''],
    ['relative cwd', 'relative/workspace'],
    ['NUL cwd', '/runtime/invalid\u0000cwd'],
    ['lone-surrogate cwd', '/runtime/\ud800'],
  ] as const)('rejects %s before opening storage', async (_name, cwd) => {
    let storageCalls = 0;
    const storage: RuntimeStoragePort = {
      async listStoredThreads() { return []; },
      async openWorkspace() {
        storageCalls++;
        throw new Error('storage must not be called');
      },
    };
    await expect(createRuntime({
      workspace: { cwd },
      storage,
      modelResolver: { async resolve() { return { ok: true as const, model: MODEL }; } },
      permissionPolicy: new FixedPolicy(),
      threadDriverFactory: new RecordingDriverFactory(),
      identityFactory: new TestIdentityFactory(),
    })).rejects.toMatchObject({ code: 'invalid_workspace_cwd', field: 'workspace.cwd' });
    expect(storageCalls).toBe(0);
  });

  test.each([
    ['empty workspace id', ''],
    ['lone-surrogate workspace id', '\ud800'],
  ] as const)('rejects %s before opening storage', async (_name, workspaceId) => {
    let storageCalls = 0;
    const storage: RuntimeStoragePort = {
      async listStoredThreads() { return []; },
      async openWorkspace() {
        storageCalls++;
        throw new Error('storage must not be called');
      },
    };
    await expect(createRuntime({
      workspace: { cwd: CWD, workspaceId: workspaceId as WorkspaceId },
      storage,
      modelResolver: { async resolve() { return { ok: true as const, model: MODEL }; } },
      permissionPolicy: new FixedPolicy(),
      threadDriverFactory: new RecordingDriverFactory(),
      identityFactory: new TestIdentityFactory(),
    })).rejects.toMatchObject({ code: 'invalid_workspace_id', field: 'workspace.workspaceId' });
    expect(storageCalls).toBe(0);
  });

  test.each([
    ['numeric revision', { revision: 1, constraints: [] }],
    ['object constraints', { revision: 'malicious', constraints: {} }],
    ['unknown field', { revision: 'malicious', constraints: [], extra: true }],
    ['invalid inherited thread', {
      revision: 'malicious',
      constraints: [],
      inheritedFrom: { parentThreadId: '', parentCeilingRevision: 'parent' },
    }],
    ['invalid inherited run', {
      revision: 'malicious',
      constraints: [],
      inheritedFrom: {
        parentThreadId: 'thread-parent',
        parentRunId: '',
        parentCeilingRevision: 'parent',
      },
    }],
  ] as const)('fails closed on a permission port %s', async (_name, malicious) => {
    const drivers = new RecordingDriverFactory();
    const policy: PermissionPolicyPort = {
      async snapshotWorkspaceCeiling() {
        return malicious as unknown as PermissionCeilingSnapshot;
      },
      async resolveCeiling() {
        return malicious as unknown as PermissionCeilingSnapshot;
      },
    };
    const runtime = await createRuntime({
      workspace: { cwd: CWD, workspaceId: WORKSPACE_ID },
      storage: createMemoryRuntimeStorage(),
      modelResolver: {
        async resolve(ref) {
          return { ok: true as const, model: { ...MODEL, ref } };
        },
      },
      permissionPolicy: policy,
      threadDriverFactory: drivers,
      identityFactory: new TestIdentityFactory(),
      clock: { now: () => 1 },
    });
    try {
      const threadId = runtime.newThreadId();
      await expect(runtime.submit(createThreadOp(runtime.newOpId(), threadId))).rejects.toBeInstanceOf(Error);
      expect(drivers.createCalls).toBe(0);
      expect(await runtime.listThreads()).toEqual([]);
    } finally {
      await runtime.close().catch(() => undefined);
    }
  });

  test.each([
    ['thread', '', 'invalid_thread_id'],
    ['op', '', 'invalid_legacy_identity_input'],
  ] as const)('rejects an invalid identityFactory %s id at the public factory boundary', async (
    kind,
    value,
    code,
  ) => {
    const identity = new TestIdentityFactory();
    if (kind === 'thread') identity.newThreadId = () => value as ThreadId;
    else identity.newOpId = () => value as ExternalOpId;
    const runtime = await createRuntime({
      workspace: { cwd: CWD, workspaceId: WORKSPACE_ID },
      storage: createMemoryRuntimeStorage(),
      modelResolver: { async resolve(ref) { return { ok: true as const, model: { ...MODEL, ref } }; } },
      permissionPolicy: new FixedPolicy(),
      threadDriverFactory: new RecordingDriverFactory(),
      identityFactory: identity,
    });
    try {
      const invoke = (): unknown => kind === 'thread' ? runtime.newThreadId() : runtime.newOpId();
      expect(invoke).toThrow(expect.objectContaining({ code }));
    } finally {
      await runtime.close();
    }
  });

  test('finalizes a reserved ledger entry from a completed journal without redispatch', async () => {
    const storage = createMemoryRuntimeStorage();
    const threadId = 'thread-ledger-completed' as ThreadId;
    const op = prompt('op_e_10000000000000000000000000000001', threadId, 'durable');
    await seedPromptCrash(storage, threadId, op, 'completed');
    const drivers = new RecordingDriverFactory();
    const runtime = await openRuntime(storage, drivers);

    try {
      expect(onlyLedgerRecord(storage)).toMatchObject({
        opId: op.opId,
        state: 'final',
        receipt: { accepted: true, runId: RECOVERY_RUN_ID },
      });
      expect(await runtime.submit(op)).toMatchObject({
        accepted: true,
        duplicate: true,
        runId: RECOVERY_RUN_ID,
      });
      expect(await runtime.submit({ ...op, text: 'changed' })).toMatchObject({
        accepted: false,
        duplicate: false,
        reason: 'op_id_conflict',
      });
      expect(drivers.dispatches(threadId)).toEqual([]);
    } finally {
      await runtime.close();
    }
  });

  test('actively finalizes a journal-accepted prompt as suspended during open', async () => {
    const storage = createMemoryRuntimeStorage();
    const threadId = 'thread-ledger-accepted' as ThreadId;
    const op = prompt('op_e_10000000000000000000000000000002', threadId, 'queued-before-crash');
    await seedPromptCrash(storage, threadId, op, 'accepted_pending');
    const drivers = new RecordingDriverFactory();
    const runtime = await openRuntime(storage, drivers);

    try {
      expect(onlyLedgerRecord(storage)).toMatchObject({
        opId: op.opId,
        state: 'final',
        receipt: { accepted: true, runId: RECOVERY_RUN_ID },
      });
      expect((await runtime.listThreads())[0]).toMatchObject({
        threadId,
        state: 'suspended',
        suspendedWork: [{
          kind: 'interrupted',
          ownerOpId: op.opId,
          terminalRunId: RECOVERY_RUN_ID,
          inputOwnerOpId: op.opId,
        }],
      });
      expect(await runtime.submit(op)).toMatchObject({
        accepted: true,
        duplicate: true,
        runId: RECOVERY_RUN_ID,
      });
      expect(await runtime.submit({
        type: 'thread_resume',
        opId: 'op_e_10000000000000000000000000000007' as ExternalOpId,
        workspaceId: WORKSPACE_ID,
        threadId,
        model: MODEL.ref,
      })).toMatchObject({ accepted: true });
      expect(await runtime.submit(prompt(
        'op_e_10000000000000000000000000000008',
        threadId,
        'must not bypass accepted recovery',
      ))).toMatchObject({ accepted: false, reason: 'suspended_work_pending' });
      const continuation = await runtime.submit({
        type: 'continue',
        opId: 'op_e_10000000000000000000000000000009' as ExternalOpId,
        workspaceId: WORKSPACE_ID,
        threadId,
      });
      expect(continuation).toMatchObject({ accepted: true });
      if (!continuation.accepted) throw new Error('continue was not accepted');
      expect(drivers.dispatches(threadId).at(-1)).toMatchObject({
        op: { type: 'continue', opId: continuation.opId },
        runId: continuation.runId,
        resolvedInput: {
          kind: 'prompt_input',
          sourceOpId: op.opId,
          text: op.text,
        },
      });
      expect(drivers.resumeCalls).toBe(1);
    } finally {
      await runtime.close();
    }
  });

  test('resumed suspended work blocks prompt and continue transfers the oldest input to a fresh run', async () => {
    const storage = createMemoryRuntimeStorage();
    const threadId = 'thread-suspended-fifo' as ThreadId;
    const original = prompt('op_e_10000000000000000000000000000003', threadId, 'recover me');
    await seedPromptCrash(storage, threadId, original, 'started');
    const drivers = new RecordingDriverFactory();
    const runtime = await openRuntime(storage, drivers);

    try {
      const resume = await runtime.submit({
        type: 'thread_resume',
        opId: 'op_e_10000000000000000000000000000004' as ExternalOpId,
        workspaceId: WORKSPACE_ID,
        threadId,
        model: MODEL.ref,
      });
      expect(resume.accepted).toBe(true);

      const bypass = await runtime.submit(prompt(
        'op_e_10000000000000000000000000000005',
        threadId,
        'must not bypass',
      ));
      expect(bypass).toMatchObject({ accepted: false, reason: 'suspended_work_pending' });

      const continuation = await runtime.submit({
        type: 'continue',
        opId: 'op_e_10000000000000000000000000000006' as ExternalOpId,
        workspaceId: WORKSPACE_ID,
        threadId,
      });
      expect(continuation).toMatchObject({ accepted: true });
      if (!continuation.accepted) throw new Error('continue was not accepted');
      expect(continuation.runId).not.toBe(RECOVERY_RUN_ID);
      expect(drivers.dispatches(threadId).at(-1)).toMatchObject({
        op: { type: 'continue', opId: continuation.opId },
        runId: continuation.runId,
        resolvedInput: {
          kind: 'prompt_input',
          sourceOpId: original.opId,
          text: original.text,
        },
      });
    } finally {
      await runtime.close();
    }
  });

  test('workspace cancel resolves an unloaded suspended head instead of freezing no-current', async () => {
    const storage = createMemoryRuntimeStorage();
    const threadId = 'thread-unloaded-cancel' as ThreadId;
    const original = prompt('op_e_10000000000000000000000000000007', threadId, 'cancel me');
    await seedPromptCrash(storage, threadId, original, 'accepted_pending');
    const drivers = new RecordingDriverFactory();
    const runtime = await openRuntime(storage, drivers);

    try {
      const receipt = await runtime.submit({
        type: 'cancel_scope',
        opId: 'op_e_10000000000000000000000000000008' as ExternalOpId,
        workspaceId: WORKSPACE_ID,
        scope: 'workspace',
      });
      expect(receipt).toMatchObject({ accepted: true, targetThreadIds: [threadId] });
      expect((await runtime.getThreadSnapshot(threadId))?.thread).toMatchObject({
        threadId,
        state: 'idle',
      });
      expect((await runtime.getThreadSnapshot(threadId))?.thread.suspendedWork ?? []).toEqual([]);
      expect(drivers.resumeCalls).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  test('an attached suspended abort cancels owned input and removes the ready token', async () => {
    const storage = createMemoryRuntimeStorage();
    const threadId = 'thread-attached-suspended-abort' as ThreadId;
    const original = prompt('op_e_1000000000000000000000000000000b', threadId, 'cancel residue');
    await seedPromptCrash(storage, threadId, original, 'started');
    const runtime = await openRuntime(storage, new RecordingDriverFactory());

    try {
      expect((await runtime.submit({
        type: 'thread_resume',
        opId: 'op_e_1000000000000000000000000000000c' as ExternalOpId,
        workspaceId: WORKSPACE_ID,
        threadId,
        model: MODEL.ref,
      })).accepted).toBe(true);
      expect((await runtime.submit({
        type: 'abort',
        opId: 'op_e_1000000000000000000000000000000d' as ExternalOpId,
        workspaceId: WORKSPACE_ID,
        threadId,
      })).accepted).toBe(true);
      expect((await runtime.getThreadSnapshot(threadId))?.thread.suspendedWork ?? []).toEqual([]);

      const records = await loadThreadRecords(storage, threadId);
      const cancellations = records.flatMap((record) => record.type === 'commit'
        ? (record.mutations ?? []).filter((mutation) => mutation.type === 'input_cancelled')
        : []);
      expect(cancellations).toContainEqual(expect.objectContaining({ ownerOpId: original.opId }));
    } finally {
      await runtime.close();
    }
  });

  test('a closed thread can be explicitly reattached with a new lifecycle op', async () => {
    const storage = createMemoryRuntimeStorage();
    const drivers = new RecordingDriverFactory();
    const runtime = await openRuntime(storage, drivers);
    const threadId = runtime.newThreadId();

    try {
      expect((await runtime.submit(createThreadOp(runtime.newOpId(), threadId))).accepted).toBe(true);
      const iterator = runtime.events({ threadIds: [threadId] })[Symbol.asyncIterator]();
      const closeOpId = runtime.newOpId();
      expect((await runtime.submit({
        type: 'thread_close',
        opId: closeOpId,
        workspaceId: WORKSPACE_ID,
        threadId,
      })).accepted).toBe(true);
      await nextEvent(iterator, (event) => event.event.type === 'thread_closed');
      await iterator.return?.();

      const resume = await runtime.submit({
        type: 'thread_resume',
        opId: runtime.newOpId(),
        workspaceId: WORKSPACE_ID,
        threadId,
        model: MODEL.ref,
      });
      expect(resume).toMatchObject({ accepted: true, threadId });
      expect(drivers.resumeCalls).toBe(1);
    } finally {
      await runtime.close();
    }
  });

  test('an unloaded close remains closed after a Runtime restart', async () => {
    const storage = createMemoryRuntimeStorage();
    const threadId = 'thread-unloaded-close' as ThreadId;
    const original = prompt('op_e_10000000000000000000000000000009', threadId, 'already done');
    await seedPromptCrash(storage, threadId, original, 'completed');
    const first = await openRuntime(storage, new RecordingDriverFactory());
    const closeReceipt = await first.submit({
      type: 'thread_close',
      opId: 'op_e_1000000000000000000000000000000a' as ExternalOpId,
      workspaceId: WORKSPACE_ID,
      threadId,
    });
    expect(closeReceipt).toMatchObject({ accepted: true, threadId });
    await first.close();

    const second = await openRuntime(storage, new RecordingDriverFactory());
    try {
      expect((await second.listThreads())[0]).toMatchObject({ threadId, state: 'closed' });
    } finally {
      await second.close();
    }
  });

  test('persists and delivers a child terminal result exactly once to its parent', async () => {
    const storage = createMemoryRuntimeStorage();
    const drivers = new RecordingDriverFactory();
    const runtime = await openRuntime(storage, drivers);
    const parentThreadId = runtime.newThreadId();
    const childThreadId = runtime.newThreadId();
    expect((await runtime.submit(createThreadOp(runtime.newOpId(), parentThreadId))).accepted).toBe(true);
    const parentPrompt = await runtime.submit(prompt(runtime.newOpId(), parentThreadId, 'parent'));
    if (!parentPrompt.accepted || parentPrompt.runId === undefined) throw new Error('parent prompt failed');
    expect((await runtime.submit({
      ...createThreadOp(runtime.newOpId(), childThreadId),
      parentThreadId,
      createdByRunId: parentPrompt.runId,
    })).accepted).toBe(true);
    const childPrompt = await runtime.submit(prompt(runtime.newOpId(), childThreadId, 'child'));
    if (!childPrompt.accepted || childPrompt.runId === undefined) throw new Error('child prompt failed');
    drivers.complete(childThreadId, childPrompt.runId, 'completed');
    await runtime.close();

    const parentRecords = await loadThreadRecords(storage, parentThreadId);
    const childRecords = await loadThreadRecords(storage, childThreadId);
    const parentResults = parentRecords.flatMap((record) => record.type === 'commit'
      ? record.envelopes.filter((envelope) => envelope.event.type === 'thread_result')
      : []);
    const childPending = childRecords.flatMap((record) => record.type === 'commit'
      ? (record.mutations ?? []).filter((mutation) => mutation.type === 'thread_result_pending')
      : []);
    const childDelivered = childRecords.filter((record) => record.type === 'thread_result_delivered');
    expect(parentResults).toHaveLength(1);
    expect(childPending).toHaveLength(1);
    expect(childDelivered).toHaveLength(1);
    expect(parentResults[0]).toMatchObject({
      threadId: parentThreadId,
      opId: childPending[0]?.resultOpId,
      event: {
        type: 'thread_result',
        childThreadId,
        terminalRunId: childPrompt.runId,
        status: 'completed',
      },
    });
  });

  test('recovers the child outbox after parent commit but before child acknowledgement', async () => {
    const storage = createMemoryRuntimeStorage();
    const parentThreadId = 'thread-outbox-parent' as ThreadId;
    const childThreadId = 'thread-outbox-child' as ThreadId;
    const seeded = await seedParentCommitBeforeChildAck(storage, parentThreadId, childThreadId);

    const runtime = await openRuntime(storage, new RecordingDriverFactory());
    await runtime.close();
    const parentRecords = await loadThreadRecords(storage, parentThreadId);
    const childRecords = await loadThreadRecords(storage, childThreadId);
    const parentResults = parentRecords.flatMap((record) => record.type === 'commit'
      ? record.envelopes.filter((envelope) => envelope.event.type === 'thread_result')
      : []);
    const deliveries = childRecords.filter((record) => record.type === 'thread_result_delivered');
    expect(parentResults).toHaveLength(1);
    expect(parentResults[0]).toMatchObject({ opId: seeded.resultOpId, seq: seeded.parentCommitSeq });
    expect(deliveries).toEqual([expect.objectContaining({
      resultOpId: seeded.resultOpId,
      parentThreadId,
      parentCommitSeq: seeded.parentCommitSeq,
    })]);
  });

  test('does not backpressure child terminal or next admission on a gated parent result commit', async () => {
    const parentThreadId = 'thread-outbox-gated-parent' as ThreadId;
    const childThreadId = 'thread-outbox-gated-child' as ThreadId;
    const baseStorage = createMemoryRuntimeStorage();
    const gate = gateParentResultCommit(baseStorage, parentThreadId);
    const drivers = new RecordingDriverFactory();
    const runtime = await openRuntime(gate.storage, drivers);
    const childEvents = runtime.events({ threadIds: [childThreadId] })[Symbol.asyncIterator]();
    const parentEvents = runtime.events({ threadIds: [parentThreadId] })[Symbol.asyncIterator]();
    try {
      expect((await runtime.submit(createThreadOp(runtime.newOpId(), parentThreadId))).accepted).toBe(true);
      const parentPrompt = await runtime.submit(prompt(runtime.newOpId(), parentThreadId, 'parent active'));
      if (!parentPrompt.accepted || parentPrompt.runId === undefined) throw new Error('parent prompt failed');
      expect((await runtime.submit({
        ...createThreadOp(runtime.newOpId(), childThreadId),
        parentThreadId,
        createdByRunId: parentPrompt.runId,
      })).accepted).toBe(true);

      const first = await runtime.submit(prompt(runtime.newOpId(), childThreadId, 'first child result'));
      if (!first.accepted || first.runId === undefined) throw new Error('first child prompt failed');
      gate.arm();
      drivers.complete(childThreadId, first.runId, 'completed');
      await nextEvent(childEvents, (event) =>
        event.opId === first.opId && event.event.type === 'op_completed');
      await gate.entered.promise;

      const second = await runtime.submit(prompt(runtime.newOpId(), childThreadId, 'second child result'));
      if (!second.accepted || second.runId === undefined) throw new Error('second child prompt failed');
      drivers.complete(childThreadId, second.runId, 'completed');
      await nextEvent(childEvents, (event) =>
        event.opId === second.opId && event.event.type === 'op_completed');

      gate.release.resolve();
      const delivered: Readonly<import('../protocol/index.js').EventEnvelope>[] = [];
      while (delivered.length < 2) {
        delivered.push(await nextEvent(parentEvents, (event) => event.event.type === 'thread_result'));
      }
      expect(delivered.map((event) => event.event.type === 'thread_result'
        && event.event.childThreadId)).toEqual([childThreadId, childThreadId]);
    } finally {
      gate.release.resolve();
      await childEvents.return?.();
      await parentEvents.return?.();
      await runtime.close().catch(() => undefined);
    }
  });

  test('recovers a crash-started child as status:error outbox and delivers after parent resume once', async () => {
    const storage = createMemoryRuntimeStorage();
    const parentThreadId = 'thread-crash-parent-unloaded' as ThreadId;
    const childThreadId = 'thread-crash-child-started' as ThreadId;
    const seeded = await seedStartedChildCrash(storage, parentThreadId, childThreadId);
    const first = await openRuntime(storage, new RecordingDriverFactory());
    try {
      const childBeforeResume = await loadThreadRecords(storage, childThreadId);
      const terminalCommit = childBeforeResume.find((record) => record.type === 'commit'
        && record.envelopes.some((envelope) => envelope.opId === seeded.childOpId
          && envelope.event.type === 'op_completed'));
      expect(terminalCommit).toMatchObject({
        mutations: expect.arrayContaining([
          expect.objectContaining({
            type: 'thread_result_pending',
            parentThreadId,
            childThreadId,
            terminalRunId: seeded.childRunId,
            status: 'error',
          }),
        ]),
      });
      expect((await loadThreadRecords(storage, parentThreadId)).flatMap((record) =>
        record.type === 'commit'
          ? record.envelopes.filter((envelope) => envelope.event.type === 'thread_result')
          : [])).toEqual([]);

      expect((await first.submit({
        type: 'thread_resume',
        opId: 'op_e_22000000000000000000000000000001' as ExternalOpId,
        workspaceId: WORKSPACE_ID,
        threadId: parentThreadId,
        model: MODEL.ref,
      })).accepted).toBe(true);
      const parentResults = (await loadThreadRecords(storage, parentThreadId)).flatMap((record) =>
        record.type === 'commit'
          ? record.envelopes.filter((envelope) => envelope.event.type === 'thread_result')
          : []);
      expect(parentResults).toEqual([expect.objectContaining({
        event: expect.objectContaining({
          type: 'thread_result',
          childThreadId,
          terminalRunId: seeded.childRunId,
          status: 'error',
        }),
      })]);
      expect((await loadThreadRecords(storage, childThreadId)).filter((record) =>
        record.type === 'thread_result_delivered')).toHaveLength(1);
    } finally {
      await first.close();
    }

    const second = await openRuntime(storage, new RecordingDriverFactory());
    try {
      const parentResults = (await loadThreadRecords(storage, parentThreadId)).flatMap((record) =>
        record.type === 'commit'
          ? record.envelopes.filter((envelope) => envelope.event.type === 'thread_result')
          : []);
      expect(parentResults).toHaveLength(1);
      expect((await loadThreadRecords(storage, childThreadId)).filter((record) =>
        record.type === 'thread_result_delivered')).toHaveLength(1);
    } finally {
      await second.close();
    }
  });

  for (const phase of ['accepted_pending', 'started'] as const) {
    test(`supersedes a crash-${phase} set_model only in the explicit resume model commit`, async () => {
      const storage = createMemoryRuntimeStorage();
      const threadId = `thread-set-model-${phase}` as ThreadId;
      const staleOp = setModelOp(
        phase === 'accepted_pending'
          ? 'op_e_20000000000000000000000000000001'
          : 'op_e_20000000000000000000000000000002',
        threadId,
        STALE_MODEL.ref,
      );
      await seedSetModelCrash(storage, threadId, staleOp, phase);
      const drivers = new RecordingDriverFactory();
      const runtime = await openRuntime(storage, drivers);
      const resumeOpId = (phase === 'accepted_pending'
        ? 'op_e_20000000000000000000000000000003'
        : 'op_e_20000000000000000000000000000004') as ExternalOpId;
      try {
        expect((await runtime.getThreadSnapshot(threadId))?.model).toEqual(MODEL.ref);
        const resume = await runtime.submit({
          type: 'thread_resume',
          opId: resumeOpId,
          workspaceId: WORKSPACE_ID,
          threadId,
          model: RESUME_MODEL.ref,
        });
        expect(resume).toMatchObject({ accepted: true, threadId });
        expect((await runtime.getThreadSnapshot(threadId))?.model).toEqual(RESUME_MODEL.ref);
        expect(drivers.dispatches(threadId).filter((command) => command.op.type === 'set_model')).toEqual([]);

        const records = await loadThreadRecords(storage, threadId);
        const supersession = records.find((record) => record.type === 'commit'
          && (record.mutations ?? []).some((mutation) => mutation.type === 'completed'
            && mutation.opId === staleOp.opId && mutation.outcome === 'superseded')
          && (record.mutations ?? []).some((mutation) => mutation.type === 'model_selected'
            && mutation.ownerOpId === resumeOpId));
        expect(supersession).toBeDefined();
        expect(storage.inspectWorkspace(WORKSPACE_ID)?.ops.find((record) => record.opId === staleOp.opId))
          .toMatchObject({ state: 'final', receipt: { accepted: true } });
      } finally {
        await runtime.close().catch(() => undefined);
      }
    });
  }

  test('folds a completed set_model once and lets resume override it without redispatch', async () => {
    const storage = createMemoryRuntimeStorage();
    const threadId = 'thread-set-model-completed' as ThreadId;
    const staleOp = setModelOp(
      'op_e_20000000000000000000000000000005',
      threadId,
      STALE_MODEL.ref,
    );
    await seedSetModelCrash(storage, threadId, staleOp, 'completed');
    const drivers = new RecordingDriverFactory();
    const runtime = await openRuntime(storage, drivers);
    try {
      expect((await runtime.getThreadSnapshot(threadId))?.model).toEqual(STALE_MODEL.ref);
      expect((await runtime.submit({
        type: 'thread_resume',
        opId: 'op_e_20000000000000000000000000000006' as ExternalOpId,
        workspaceId: WORKSPACE_ID,
        threadId,
        model: RESUME_MODEL.ref,
      })).accepted).toBe(true);
      expect((await runtime.getThreadSnapshot(threadId))?.model).toEqual(RESUME_MODEL.ref);
      const records = await loadThreadRecords(storage, threadId);
      const oldTerminals = records.flatMap((record) => record.type === 'commit'
        ? (record.mutations ?? []).filter((mutation) => mutation.type === 'completed'
          && mutation.opId === staleOp.opId)
        : []);
      expect(oldTerminals).toEqual([{ type: 'completed', opId: staleOp.opId, outcome: 'applied' }]);
      expect(drivers.dispatches(threadId).filter((command) => command.op.type === 'set_model')).toEqual([]);
    } finally {
      await runtime.close().catch(() => undefined);
    }
  });

  for (const responsePhase of ['accepted_pending', 'started'] as const) {
    test(`recovers a ${responsePhase} control response with an aborted derived resolution`, async () => {
      const storage = createMemoryRuntimeStorage();
      const threadId = `thread-control-${responsePhase}` as ThreadId;
      const seeded = await seedControlResponseCrash(storage, threadId, responsePhase);
      const runtime = await openRuntime(storage, new RecordingDriverFactory());
      try {
        const records = await loadThreadRecords(storage, threadId);
        const folded = foldThreadJournal(records);
        expect(folded.checkpoint.frontend.pendingControls).toEqual([]);
        const resolution = folded.envelopes.find((envelope) =>
          envelope.event.type === 'control_resolved'
          && envelope.event.requestId === seeded.requestId);
        expect(resolution).toMatchObject({
          opId: deriveOpId({
            purpose: 'control_recovery',
            workspaceId: WORKSPACE_ID,
            parts: [threadId, seeded.requestId],
          }),
          event: { type: 'control_resolved', decision: 'aborted' },
        });
        expect(folded.mailbox.get(seeded.responseOpId)).toMatchObject({
          state: 'completed',
          outcome: 'interrupted',
        });
        if (responsePhase === 'accepted_pending') {
          expect(folded.controlClaims.has(seeded.requestId)).toBe(false);
        } else {
          expect(folded.controlClaims.get(seeded.requestId)).toMatchObject({
            responseOpId: seeded.responseOpId,
          });
        }
      } finally {
        await runtime.close();
      }
    });
  }

  test('finalizes a started response whose control_resolved was already durable without resolving twice', async () => {
    const storage = createMemoryRuntimeStorage();
    const threadId = 'thread-control-resolved-before-op-complete' as ThreadId;
    const seeded = await seedResolvedControlBeforeResponseCompletion(storage, threadId);
    const runtime = await openRuntime(storage, new RecordingDriverFactory());
    try {
      const folded = foldThreadJournal(await loadThreadRecords(storage, threadId));
      const resolutions = folded.envelopes.filter((envelope) =>
        envelope.event.type === 'control_resolved'
        && envelope.event.requestId === seeded.requestId);
      expect(resolutions).toHaveLength(1);
      expect(resolutions[0]).toMatchObject({
        opId: seeded.responseOpId,
        event: { type: 'control_resolved', decision: 'allow_once' },
      });
      expect(folded.mailbox.get(seeded.responseOpId)).toMatchObject({
        state: 'completed',
        outcome: 'applied',
      });
      expect(folded.controlClaims.get(seeded.requestId)).toMatchObject({
        responseOpId: seeded.responseOpId,
      });
      expect(folded.checkpoint.frontend.pendingControls).toEqual([]);
    } finally {
      await runtime.close();
    }
  });

  test('definitely-not-applied allow_always recovery aborts the request skipped by its durable claim', async () => {
    const storage = createMemoryRuntimeStorage();
    const threadId = 'thread-control-definitely-not-applied' as ThreadId;
    const seeded = await seedControlResponseCrash(storage, threadId, 'started', true);
    const runtime = await openRuntime(storage, new WorkspaceFatalApprovalFactory());
    try {
      const folded = foldThreadJournal(await loadThreadRecords(storage, threadId));
      expect(folded.checkpoint.frontend.pendingControls).toEqual([]);
      expect(folded.controlClaims.has(seeded.requestId)).toBe(false);
      expect(folded.envelopes.find((envelope) =>
        envelope.event.type === 'control_resolved'
        && envelope.event.requestId === seeded.requestId)).toMatchObject({
        opId: deriveOpId({
          purpose: 'control_recovery',
          workspaceId: WORKSPACE_ID,
          parts: [threadId, seeded.requestId],
        }),
        event: { type: 'control_resolved', decision: 'aborted' },
      });
      expect(folded.mailbox.get(seeded.responseOpId)).toMatchObject({
        state: 'completed',
        outcome: 'interrupted',
      });
    } finally {
      await runtime.close().catch(() => undefined);
    }
  });

  test('an approval fatal gates and synchronously cancels every active thread in the workspace', async () => {
    const drivers = new WorkspaceFatalApprovalFactory();
    const runtime = await openRuntime(createMemoryRuntimeStorage(), drivers);
    const firstThreadId = runtime.newThreadId();
    const secondThreadId = runtime.newThreadId();
    const iterator = runtime.events()[Symbol.asyncIterator]();
    try {
      expect((await runtime.submit(createThreadOp(runtime.newOpId(), firstThreadId))).accepted).toBe(true);
      expect((await runtime.submit(createThreadOp(runtime.newOpId(), secondThreadId))).accepted).toBe(true);
      const firstPrompt = await runtime.submit(prompt(runtime.newOpId(), firstThreadId, 'first active'));
      const secondPrompt = await runtime.submit(prompt(runtime.newOpId(), secondThreadId, 'second active'));
      if (!firstPrompt.accepted || firstPrompt.runId === undefined) throw new Error('first prompt failed');
      if (!secondPrompt.accepted || secondPrompt.runId === undefined) throw new Error('second prompt failed');

      const approval = drivers.requestApproval(firstThreadId, firstPrompt.runId);
      const request = await nextEvent(iterator, (envelope) =>
        envelope.threadId === firstThreadId && envelope.event.type === 'control_request');
      if (request.event.type !== 'control_request') throw new Error('missing approval request');
      const response = {
        type: 'control_response',
        opId: runtime.newOpId(),
        workspaceId: WORKSPACE_ID,
        threadId: firstThreadId,
        requestId: request.event.requestId,
        decision: 'allow_always',
      } as const;
      expect((await runtime.submit(response)).accepted).toBe(true);

      await expect(approval).resolves.toEqual({ kind: 'aborted' });
      expect(drivers.dispatches(firstThreadId).filter((command) => command.op.type === 'abort')).toHaveLength(1);
      expect(drivers.dispatches(secondThreadId).filter((command) => command.op.type === 'abort')).toHaveLength(1);
      await expect(drivers.requestApproval(secondThreadId, secondPrompt.runId)).rejects.toMatchObject({
        code: 'legacy_approval_conflict',
      });
      expect(await runtime.submit(response)).toMatchObject({
        accepted: true,
        duplicate: true,
        opId: response.opId,
      });
      expect(await runtime.submit({ ...response, decision: 'deny' })).toMatchObject({
        accepted: false,
        duplicate: false,
        reason: 'op_id_conflict',
      });
      await expect(runtime.submit(prompt(runtime.newOpId(), secondThreadId, 'must remain gated')))
        .rejects.toMatchObject({ code: 'legacy_approval_conflict' });
    } finally {
      await iterator.return?.();
      await runtime.close().catch(() => undefined);
    }
  });

  test('commits a tolerant-load approval warning once as a canonical runtime diagnostic', async () => {
    const base = createMemoryRuntimeStorage();
    const runtime = await openRuntime(withLegacyApprovalStartupDiagnostic(base), new WorkspaceFatalApprovalFactory());
    const firstThreadId = runtime.newThreadId();
    const secondThreadId = runtime.newThreadId();
    const iterator = runtime.events()[Symbol.asyncIterator]();
    try {
      expect((await runtime.submit(createThreadOp(runtime.newOpId(), firstThreadId))).accepted).toBe(true);
      const warning = await nextEvent(iterator, (envelope) =>
        envelope.threadId === firstThreadId
        && envelope.event.type === 'runtime_diagnostic'
        && envelope.event.code === 'legacy_approvals_invalid_ignored');
      expect(warning.event).toEqual({
        type: 'runtime_diagnostic',
        severity: 'warning',
        code: 'legacy_approvals_invalid_ignored',
        message: 'Invalid legacy approvals were ignored',
        scope: 'thread',
      });

      expect((await runtime.submit(createThreadOp(runtime.newOpId(), secondThreadId))).accepted).toBe(true);
      const records = [
        ...await loadThreadRecords(base, firstThreadId),
        ...await loadThreadRecords(base, secondThreadId),
      ];
      expect(records.flatMap((record) => record.type === 'commit' ? record.envelopes : [])
        .filter((envelope) => envelope.event.type === 'runtime_diagnostic'
          && envelope.event.code === 'legacy_approvals_invalid_ignored')).toHaveLength(1);
    } finally {
      await iterator.return?.();
      await runtime.close();
    }
  });

  test('recovers a partial assistant/tool crash in one authoritative interruption commit', async () => {
    const storage = createMemoryRuntimeStorage();
    const threadId = 'thread-partial-tool-crash' as ThreadId;
    const seeded = await seedPartialToolCrash(storage, threadId);
    const drivers = new RecordingDriverFactory();
    const runtime = await openRuntime(storage, drivers);
    try {
      const records = await loadThreadRecords(storage, threadId);
      const recoveryCommit = records.find((record) => record.type === 'commit'
        && (record.mutations ?? []).some((mutation) => mutation.type === 'activity_interrupted'));
      expect(recoveryCommit).toMatchObject({
        type: 'commit',
        envelopes: expect.arrayContaining([
          expect.objectContaining({
            opId: deriveOpId({
              purpose: 'control_recovery',
              workspaceId: WORKSPACE_ID,
              parts: [threadId, seeded.requestId],
            }),
            runId: seeded.runId,
            turnId: seeded.turnId,
            event: expect.objectContaining({
              type: 'control_resolved',
              requestId: seeded.requestId,
              decision: 'aborted',
            }),
          }),
          expect.objectContaining({
            opId: seeded.rootOpId,
            runId: seeded.runId,
            event: expect.objectContaining({
              type: 'op_completed',
              outcome: 'interrupted',
              terminalRunId: seeded.runId,
            }),
          }),
        ]),
        mutations: expect.arrayContaining([
          expect.objectContaining({
            type: 'control_resolved',
            resolution: expect.objectContaining({
              requestId: seeded.requestId,
              decision: 'aborted',
            }),
          }),
          expect.objectContaining({
            type: 'activity_interrupted',
            rootOpId: seeded.rootOpId,
            rootRunId: seeded.runId,
            terminalRunId: seeded.runId,
            terminalTurnId: seeded.turnId,
            discardedPartialAssistantId: seeded.assistantId,
            discardedStartedToolCallIds: [seeded.toolCallId],
          }),
        ]),
      });
      const snapshot = await runtime.getThreadSnapshot(threadId);
      expect(snapshot?.activity).toBeUndefined();
      expect(snapshot?.pendingControls).toEqual([]);
      expect(snapshot?.transcript.some((message) => message.id === seeded.assistantId)).toBe(false);
      expect((await runtime.submit(resumeOp(
        'op_e_2f000000000000000000000000000001',
        threadId,
      ))).accepted).toBe(true);
      expect(drivers.resumeCalls).toBe(1);
      expect(drivers.dispatches(threadId)).toEqual([]);
    } finally {
      await runtime.close();
    }
  });

  test.each([
    ['accepted_pending steer without effect', 'steer', 'accepted_pending', false],
    ['started follow_up without effect', 'follow_up', 'started', false],
    ['started steer with durable effect', 'steer', 'started', true],
  ] as const)('recovers %s exactly once before thread_resumed', async (
    _name,
    opType,
    phase,
    effectCommitted,
  ) => {
    const storage = createMemoryRuntimeStorage();
    const threadId = `thread-queue-recovery-${opType}-${phase}-${effectCommitted}` as ThreadId;
    const queueOpId = `op_e_3${opType === 'steer' ? '1' : '2'}${phase === 'started' ? '1' : '0'}${
      effectCommitted ? '1' : '0'
    }0000000000000000000000000000` as ExternalOpId;
    await seedQueueCrash(storage, threadId, queueOpId, opType, phase, effectCommitted);
    const drivers = new RecordingDriverFactory();
    const runtime = await openRuntime(storage, drivers);
    const resumeId = runtime.newOpId();
    try {
      expect((await runtime.getThreadSnapshot(threadId))?.thread.state).toBe('idle');
      expect((await runtime.submit({
        type: 'thread_resume',
        opId: resumeId,
        workspaceId: WORKSPACE_ID,
        threadId,
        model: MODEL.ref,
      })).accepted).toBe(true);

      expect(drivers.recoveries(threadId)).toEqual(effectCommitted
        ? [[]]
        : [[expect.objectContaining({ op: expect.objectContaining({ opId: queueOpId, type: opType }) })]]);
      const folded = foldThreadJournal(await loadThreadRecords(storage, threadId));
      expect(folded.mailbox.get(queueOpId)).toMatchObject({ state: 'completed', outcome: 'applied' });
      const queueEffects = folded.envelopes.filter((envelope) =>
        envelope.opId === queueOpId && envelope.event.type === 'queue_update');
      expect(queueEffects).toHaveLength(1);
      const completed = folded.envelopes.findLast((envelope) =>
        envelope.opId === queueOpId && envelope.event.type === 'op_completed');
      const resumed = folded.envelopes.find((envelope) =>
        envelope.opId === resumeId && envelope.event.type === 'thread_resumed');
      expect(completed?.seq).toBeLessThan(resumed?.seq ?? 0);
      const starts = folded.envelopes.filter((envelope) =>
        envelope.opId === queueOpId && envelope.event.type === 'op_started');
      expect(starts).toHaveLength(1);
      expect(starts[0]?.seq).toBeLessThan(queueEffects[0]?.seq ?? 0);
    } finally {
      await runtime.close();
    }

    const resumedDrivers = new RecordingDriverFactory();
    const restarted = await openRuntime(storage, resumedDrivers);
    try {
      restarted.newOpId(); // Skip the first-runtime resume id used by the deterministic test factory.
      expect((await restarted.submit({
        type: 'thread_resume',
        opId: restarted.newOpId(),
        workspaceId: WORKSPACE_ID,
        threadId,
        model: MODEL.ref,
      })).accepted).toBe(true);
      expect(resumedDrivers.recoveries(threadId)).toEqual([[]]);
    } finally {
      await restarted.close();
    }
  });

  test('freezes scope targets before dispatch and never retargets a successor run', async () => {
    const baseStorage = createMemoryRuntimeStorage();
    const gate = gateFirstDerivedReservation(baseStorage);
    const drivers = new RecordingDriverFactory();
    const runtime = await openRuntime(gate.storage, drivers);
    const threadId = runtime.newThreadId();
    const iterator = runtime.events({ threadIds: [threadId] })[Symbol.asyncIterator]();
    try {
      expect((await runtime.submit(createThreadOp(runtime.newOpId(), threadId))).accepted).toBe(true);
      const first = await runtime.submit(prompt(runtime.newOpId(), threadId, 'first'));
      if (!first.accepted || first.runId === undefined) throw new Error('first prompt failed');
      gate.arm();
      const cancel = runtime.submit({
        type: 'cancel_scope',
        opId: runtime.newOpId(),
        workspaceId: WORKSPACE_ID,
        scope: 'workspace',
      });
      await gate.entered.promise;

      drivers.complete(threadId, first.runId, 'completed');
      await nextEvent(iterator, (event) =>
        event.opId === first.opId && event.event.type === 'op_completed');
      const successor = await runtime.submit(prompt(runtime.newOpId(), threadId, 'successor'));
      if (!successor.accepted || successor.runId === undefined) throw new Error('successor prompt failed');
      gate.release.resolve();
      expect(await cancel).toMatchObject({ accepted: true, targetThreadIds: [threadId] });
      expect((await runtime.getThreadSnapshot(threadId))?.thread.activeRunId).toBe(successor.runId);

      const records = await loadThreadRecords(baseStorage, threadId);
      const derivedAbort = records.flatMap((record) => record.type === 'commit'
        ? record.envelopes.filter((envelope) => envelope.event.type === 'op_completed'
          && envelope.event.opType === 'abort')
        : []);
      expect(derivedAbort.at(-1)?.event).toMatchObject({ outcome: 'no_op' });
      drivers.complete(threadId, successor.runId, 'completed');
    } finally {
      gate.release.resolve();
      await iterator.return?.();
      await runtime.close().catch(() => undefined);
    }
  });

  test('releases a safely closed checkpoint-mismatch resume claim for a new OpId retry', async () => {
    const storage = createMemoryRuntimeStorage();
    const threadId = 'thread-resume-mismatch-safe-close' as ThreadId;
    await seedPromptCrash(
      storage,
      threadId,
      prompt('op_e_20000000000000000000000000000007', threadId, 'seed'),
      'completed',
    );
    const factory = new CheckpointMismatchFactory([{ mismatch: true, closeReject: false }, { mismatch: false }]);
    const runtime = await openRuntime(storage, factory);
    try {
      expect(await runtime.submit(resumeOp(
        'op_e_20000000000000000000000000000008',
        threadId,
      ))).toMatchObject({ accepted: false, reason: 'driver_checkpoint_mismatch' });
      expect((await runtime.submit(resumeOp(
        'op_e_20000000000000000000000000000009',
        threadId,
      ))).accepted).toBe(true);
      expect(factory.closeCalls).toBe(1);
    } finally {
      await runtime.close().catch(() => undefined);
    }
  });

  test('retains a checkpoint-mismatch resume claim when quarantined close rejects', async () => {
    const storage = createMemoryRuntimeStorage();
    const threadId = 'thread-resume-mismatch-close-unknown' as ThreadId;
    await seedPromptCrash(
      storage,
      threadId,
      prompt('op_e_2000000000000000000000000000000a', threadId, 'seed'),
      'completed',
    );
    const factory = new CheckpointMismatchFactory([{ mismatch: true, closeReject: true }]);
    const runtime = await openRuntime(storage, factory);
    try {
      await expect(runtime.submit(resumeOp(
        'op_e_2000000000000000000000000000000b',
        threadId,
      ))).rejects.toThrow('quarantined close failed');
      expect(await runtime.submit(resumeOp(
        'op_e_2000000000000000000000000000000c',
        threadId,
      ))).toMatchObject({ accepted: false, reason: 'thread_attach_in_progress' });
      expect(factory.resumeCalls).toBe(1);
    } finally {
      await runtime.close().catch(() => undefined);
    }
  });

  test('close aborts resolver signal, drains a pre-registered create, recomputes attachments, and seals public methods', async () => {
    const storage = createMemoryRuntimeStorage();
    const drivers = new RecordingDriverFactory();
    const resolverEntered = deferred<void>();
    const resolverRelease = deferred<void>();
    let resolverSignal: AbortSignal | undefined;
    const runtime = await createRuntime({
      workspace: { cwd: CWD, workspaceId: WORKSPACE_ID },
      storage,
      modelResolver: {
        async resolve(ref, context) {
          resolverSignal = context.signal;
          resolverEntered.resolve();
          await resolverRelease.promise;
          return { ok: true as const, model: { ...MODEL, ref } };
        },
      },
      permissionPolicy: new FixedPolicy(),
      threadDriverFactory: drivers,
      identityFactory: new TestIdentityFactory(),
      clock: { now: () => 2 },
    });
    const threadId = runtime.newThreadId();
    const create = runtime.submit(createThreadOp(runtime.newOpId(), threadId));
    await resolverEntered.promise;
    const closing = runtime.close();
    expect(runtime.close()).toBe(closing);
    expect(resolverSignal?.aborted).toBe(true);
    let closeSettled = false;
    void closing.finally(() => { closeSettled = true; }).catch(() => undefined);
    await Promise.resolve();
    expect(closeSettled).toBe(false);

    await expect(runtime.submit(createThreadOp(
      'op_e_90000000000000000000000000000001' as ExternalOpId,
      'thread-post-close-submit' as ThreadId,
    ))).rejects.toMatchObject({ code: 'runtime_closed' });
    expect(() => runtime.newThreadId()).toThrow(expect.objectContaining({ code: 'runtime_closed' }));
    expect(() => runtime.newOpId()).toThrow(expect.objectContaining({ code: 'runtime_closed' }));
    expect(() => runtime.events()).toThrow(expect.objectContaining({ code: 'runtime_closed' }));
    await expect(runtime.listThreads()).rejects.toMatchObject({ code: 'runtime_closed' });
    await expect(runtime.getThreadSnapshot(threadId)).rejects.toMatchObject({ code: 'runtime_closed' });

    resolverRelease.resolve();
    await expect(create).resolves.toMatchObject({ accepted: true, threadId });
    await closing;
    expect(drivers.createCalls).toBe(1);
    expect(drivers.closeCalls).toBe(1);
    expect(() => runtime.events()).toThrow(expect.objectContaining({ code: 'runtime_closed' }));
    await expect(runtime.listThreads()).rejects.toMatchObject({ code: 'runtime_closed' });
  });

  test('close repeatedly drains an unload registered by an already in-flight thread_close submit', async () => {
    const baseStorage = createMemoryRuntimeStorage();
    const threadId = 'thread-close-dynamic-drain' as ThreadId;
    const gated = gateThreadCloseAcceptance(baseStorage, threadId);
    const drivers = new RecordingDriverFactory();
    const runtime = await openRuntime(gated.storage, drivers);
    expect((await runtime.submit(createThreadOp(runtime.newOpId(), threadId))).accepted).toBe(true);
    gated.arm();
    const threadClose = runtime.submit({
      type: 'thread_close',
      opId: runtime.newOpId(),
      workspaceId: WORKSPACE_ID,
      threadId,
    });
    await gated.entered.promise;
    const runtimeClose = runtime.close();
    let runtimeCloseSettled = false;
    void runtimeClose.finally(() => { runtimeCloseSettled = true; }).catch(() => undefined);
    await Promise.resolve();
    expect(runtimeCloseSettled).toBe(false);
    gated.release.resolve();
    await expect(threadClose).resolves.toMatchObject({ accepted: true, threadId });
    await runtimeClose;
    expect(drivers.closeCalls).toBe(1);
    const folded = foldThreadJournal(await loadThreadRecords(baseStorage, threadId));
    expect(folded.summary.state).toBe('closed');
  });

  test('derives runtime-close identity from each attachment lifecycle across repeated reattach', async () => {
    const storage = createMemoryRuntimeStorage();
    const threadId = 'thread-derived-close-reattach' as ThreadId;
    const createOpId = 'op_e_90000000000000000000000000000002' as ExternalOpId;
    const resumeA = 'op_e_90000000000000000000000000000003' as ExternalOpId;
    const resumeB = 'op_e_90000000000000000000000000000004' as ExternalOpId;
    const lifecycleOps = [createOpId, resumeA, resumeB] as const;
    const factories: RecordingDriverFactory[] = [];

    for (let ordinal = 0; ordinal < lifecycleOps.length; ordinal++) {
      const factory = new RecordingDriverFactory();
      factories.push(factory);
      const runtime = await openRuntime(storage, factory);
      if (ordinal === 0) {
        expect((await runtime.submit(createThreadOp(createOpId, threadId))).accepted).toBe(true);
      } else {
        expect((await runtime.submit({
          type: 'thread_resume',
          opId: lifecycleOps[ordinal] as ExternalOpId,
          workspaceId: WORKSPACE_ID,
          threadId,
          model: MODEL.ref,
        })).accepted).toBe(true);
      }
      await runtime.close();
      expect(factory.closeCalls).toBe(1);
    }

    const folded = foldThreadJournal(await loadThreadRecords(storage, threadId));
    const expected = lifecycleOps.map((lifecycleOp) => deriveOpId({
      purpose: 'thread_close_on_runtime_close',
      workspaceId: WORKSPACE_ID,
      parts: [threadId, lifecycleOp],
    }));
    const closeAccepted = folded.envelopes.filter((envelope) =>
      envelope.event.type === 'op_accepted'
      && envelope.event.opType === 'thread_close'
      && expected.includes(envelope.opId as (typeof expected)[number]));
    expect(closeAccepted.map((envelope) => envelope.opId)).toEqual(expected);
    for (const opId of expected) {
      expect(closeAccepted.filter((envelope) => envelope.opId === opId)).toHaveLength(1);
    }
  });

  test('actively recovers a reserved create with its persisted creationKey before admitting competitors', async () => {
    const storage = createMemoryRuntimeStorage();
    const threadId = 'thread-reserved-create-claim' as ThreadId;
    const original = createThreadOp(
      'op_e_a0000000000000000000000000000001' as ExternalOpId,
      threadId,
    );
    const creationKey = 'creation-key-reserved-unknown';
    await seedReservedCreate(storage, original, creationKey);
    const drivers = new RecordingDriverFactory();
    const runtime = await openRuntime(storage, drivers);
    try {
      expect(drivers.createCalls).toBe(1);
      expect(drivers.creationKeys).toEqual([creationKey]);
      const competing = await runtime.submit(createThreadOp(
        'op_e_a0000000000000000000000000000002' as ExternalOpId,
        threadId,
      ));
      expect(competing.accepted).toBe(false);
      expect(await runtime.submit(original)).toMatchObject({
        accepted: true,
        duplicate: true,
        threadId,
      });
      expect(drivers.createCalls).toBe(1);
    } finally {
      await runtime.close();
    }
  });

  test('same-process create retry reconciles a canonical lifecycle after ledger finalize fails', async () => {
    const baseStorage = createMemoryRuntimeStorage();
    const threadId = 'thread-create-finalize-retry' as ThreadId;
    const op = createThreadOp(
      'op_e_a0000000000000000000000000000004' as ExternalOpId,
      threadId,
    );
    const storage = failSupervisorFinalizeOnce(baseStorage, op.opId);
    const drivers = new RecordingDriverFactory();
    const runtime = await openRuntime(storage, drivers);
    try {
      await expect(runtime.submit(op)).rejects.toThrow('injected finalize failure');
      expect(drivers.createCalls).toBe(1);
      expect(await runtime.submit(op)).toMatchObject({
        accepted: true,
        duplicate: true,
        threadId,
      });
      expect(drivers.createCalls).toBe(1);
    } finally {
      await runtime.close().catch(() => undefined);
    }
  });

  test('same-process resume retry reconciles an attached lifecycle after ledger finalize fails', async () => {
    const baseStorage = createMemoryRuntimeStorage();
    const threadId = 'thread-resume-finalize-retry' as ThreadId;
    const seeded = await openRuntime(baseStorage, new RecordingDriverFactory());
    expect((await seeded.submit(createThreadOp(
      'op_e_a0000000000000000000000000000005' as ExternalOpId,
      threadId,
    ))).accepted).toBe(true);
    await seeded.close();

    const resume = resumeOp('op_e_a0000000000000000000000000000006', threadId);
    const storage = failSupervisorFinalizeOnce(baseStorage, resume.opId);
    const drivers = new RecordingDriverFactory();
    const runtime = await openRuntime(storage, drivers);
    try {
      await expect(runtime.submit(resume)).rejects.toThrow('injected finalize failure');
      expect(drivers.resumeCalls).toBe(1);
      expect(await runtime.submit(resume)).toMatchObject({
        accepted: true,
        duplicate: true,
        threadId,
      });
      expect(drivers.resumeCalls).toBe(1);
    } finally {
      await runtime.close().catch(() => undefined);
    }
  });

  test('automatically reattaches the latest accepted create intent on Runtime restart', async () => {
    const storage = createMemoryRuntimeStorage();
    const threadId = 'thread-auto-attach-create' as ThreadId;
    const createOpId = 'op_e_a0000000000000000000000000000007' as ExternalOpId;
    await seedFinalCreateIntent(storage, createThreadOp(createOpId, threadId), 'auto-attach-key');
    const drivers = new RecordingDriverFactory();
    const resolved: ModelRef[] = [];
    const runtime = await createRuntime({
      workspace: { cwd: CWD, workspaceId: WORKSPACE_ID },
      storage,
      modelResolver: {
        async resolve(ref) {
          resolved.push(ref);
          return { ok: true as const, model: { ...MODEL, ref } };
        },
      },
      permissionPolicy: new FixedPolicy(),
      threadDriverFactory: drivers,
      identityFactory: new TestIdentityFactory(),
      clock: { now: () => 2 },
    });
    try {
      expect(resolved).toEqual([MODEL.ref]);
      expect(drivers.resumeCalls).toBe(1);
      const promptReceipt = await runtime.submit(prompt(
        'op_e_a0000000000000000000000000000008' as ExternalOpId,
        threadId,
        'auto-attached',
      ));
      expect(promptReceipt.accepted).toBe(true);
      if (promptReceipt.accepted && promptReceipt.runId !== undefined) {
        drivers.complete(threadId, promptReceipt.runId, 'completed');
      }
    } finally {
      await runtime.close().catch(() => undefined);
    }
  });

  test('credentials-unavailable auto-attach is durable, non-fatal, and leaves a fresh resume path', async () => {
    const storage = createMemoryRuntimeStorage();
    const threadId = 'thread-auto-attach-credentials' as ThreadId;
    const createOpId = 'op_e_a0000000000000000000000000000009' as ExternalOpId;
    await seedFinalCreateIntent(storage, createThreadOp(createOpId, threadId), 'credentials-key');
    const drivers = new RecordingDriverFactory();
    const restoredRef: ModelRef = { ...MODEL.ref, model: 'credentials-restored' };
    let resolverCalls = 0;
    const makeRuntime = () => createRuntime({
      workspace: { cwd: CWD, workspaceId: WORKSPACE_ID },
      storage,
      modelResolver: {
        async resolve(ref) {
          resolverCalls++;
          return ref.model === restoredRef.model
            ? { ok: true as const, model: { ...MODEL, ref } }
            : {
                ok: false as const,
                code: 'credentials_unavailable' as const,
                message: 'credentials unavailable during recovery',
              };
        },
      },
      permissionPolicy: new FixedPolicy(),
      threadDriverFactory: drivers,
      identityFactory: new TestIdentityFactory(),
      clock: { now: () => 2 },
    });
    const runtime = await makeRuntime();
    try {
      expect(resolverCalls).toBe(1);
      expect(drivers.resumeCalls).toBe(0);
      expect((await runtime.listThreads())[0]).toMatchObject({ threadId, state: 'closed' });
      const before = foldThreadJournal(await loadThreadRecords(storage, threadId));
      const diagnostics = before.envelopes.filter((envelope) =>
        envelope.event.type === 'runtime_diagnostic'
        && envelope.event.code === 'attachment_credentials_unavailable');
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).not.toHaveProperty('opId');
      expect(diagnostics[0]).not.toHaveProperty('runId');
      expect(diagnostics[0]).not.toHaveProperty('turnId');
      expect(before.envelopes.filter((envelope) =>
        envelope.event.type === 'thread_closed'
        && envelope.opId === createOpId)).toHaveLength(0);
      expect(await runtime.submit(createThreadOp(createOpId, threadId))).toMatchObject({
        accepted: true,
        duplicate: true,
        threadId,
      });
    } finally {
      await runtime.close().catch(() => undefined);
    }

    const reopened = await makeRuntime();
    try {
      expect(resolverCalls).toBe(1);
      const reopenedState = foldThreadJournal(await loadThreadRecords(storage, threadId));
      expect(reopenedState.envelopes.filter((envelope) =>
        envelope.event.type === 'runtime_diagnostic'
        && envelope.event.code === 'attachment_credentials_unavailable')).toHaveLength(1);
      expect((await reopened.submit({
        type: 'thread_resume',
        opId: 'op_e_a000000000000000000000000000000a' as ExternalOpId,
        workspaceId: WORKSPACE_ID,
        threadId,
        model: restoredRef,
      })).accepted).toBe(true);
      expect(drivers.resumeCalls).toBe(1);
    } finally {
      await reopened.close().catch(() => undefined);
    }
  });

  test('a fresh resume binds a credentials-interrupted create skeleton once before later resumes use its ref', async () => {
    const storage = createMemoryRuntimeStorage();
    const threadId = 'thread-no-ref-credentials-resume' as ThreadId;
    const createOpId = 'op_e_c000000000000000000000000000000b' as ExternalOpId;
    const firstResumeOpId = 'op_e_c000000000000000000000000000000c' as ExternalOpId;
    const secondResumeOpId = 'op_e_c000000000000000000000000000000d' as ExternalOpId;
    const creationKey = 'no-ref-credentials-resume-key';
    const restoredModel: ModelRef = { ...MODEL.ref, model: 'credentials-restored-no-ref' };
    await seedFinalCreateIntent(
      storage,
      createThreadOp(createOpId, threadId),
      creationKey,
      false,
    );
    const drivers = new RecordingDriverFactory();
    const makeRuntime = () => createRuntime({
      workspace: { cwd: CWD, workspaceId: WORKSPACE_ID },
      storage,
      modelResolver: {
        async resolve(ref) {
          return ref.model === restoredModel.model
            ? { ok: true as const, model: { ...MODEL, ref } }
            : {
                ok: false as const,
                code: 'credentials_unavailable' as const,
                message: 'credentials unavailable during no-ref recovery',
              };
        },
      },
      permissionPolicy: new FixedPolicy(),
      threadDriverFactory: drivers,
      identityFactory: new TestIdentityFactory(),
      clock: { now: () => 2 },
    });

    const first = await makeRuntime();
    try {
      expect(drivers.createCalls).toBe(0);
      expect(drivers.resumeCalls).toBe(0);
      const interrupted = foldThreadJournal(await loadThreadRecords(storage, threadId));
      expect(interrupted.envelopes.filter((envelope) =>
        envelope.event.type === 'runtime_diagnostic'
        && envelope.event.code === 'attachment_credentials_unavailable')).toHaveLength(1);
      expect((await first.listThreads())[0]).toMatchObject({ threadId, state: 'closed' });

      const receipt = await first.submit({
        type: 'thread_resume',
        opId: firstResumeOpId,
        workspaceId: WORKSPACE_ID,
        threadId,
        model: restoredModel,
      });
      expect(receipt).toMatchObject({ accepted: true, duplicate: false, threadId });
      expect(drivers.createCalls).toBe(1);
      expect(drivers.resumeCalls).toBe(0);
      expect(drivers.creationKeys).toEqual([creationKey]);
      const createRecord = storage.inspectWorkspace(WORKSPACE_ID)?.ops.find((record) =>
        record.opId === createOpId);
      expect(createRecord).toMatchObject({
        state: 'final',
        receipt: { accepted: true },
        driverCreation: {
          creationKey,
          driverRef: { kind: 'test-driver', key: threadId },
        },
      });
      const attached = foldThreadJournal(await loadThreadRecords(storage, threadId));
      expect(attached.checkpoint.frontend.model).toEqual(restoredModel);
      expect(attached.envelopes.filter((envelope) =>
        envelope.opId === firstResumeOpId
        && envelope.event.type === 'thread_resumed')).toHaveLength(1);
      expect(attached.envelopes.filter((envelope) =>
        envelope.event.type === 'runtime_diagnostic'
        && envelope.event.code === 'attachment_credentials_unavailable')).toHaveLength(1);
    } finally {
      await first.close().catch(() => undefined);
    }

    const reopened = await makeRuntime();
    try {
      expect(drivers.createCalls).toBe(1);
      expect(drivers.resumeCalls).toBe(0);
      expect((await reopened.submit({
        type: 'thread_resume',
        opId: secondResumeOpId,
        workspaceId: WORKSPACE_ID,
        threadId,
        model: restoredModel,
      })).accepted).toBe(true);
      expect(drivers.createCalls).toBe(1);
      expect(drivers.resumeCalls).toBe(1);
      const resumed = foldThreadJournal(await loadThreadRecords(storage, threadId));
      expect(resumed.envelopes.filter((envelope) =>
        envelope.opId === secondResumeOpId
        && envelope.event.type === 'thread_resumed')).toHaveLength(1);
    } finally {
      await reopened.close().catch(() => undefined);
    }
  });

  test('startup completes only the missing targets of a partially committed cancel_scope', async () => {
    const storage = createMemoryRuntimeStorage();
    const left = 'thread-cancel-recovery-left' as ThreadId;
    const right = 'thread-cancel-recovery-right' as ThreadId;
    const rootOpId = 'op_e_a000000000000000000000000000000b' as ExternalOpId;
    const seeded = await seedPartialCancelScope(storage, left, right, rootOpId);
    const runtime = await openRuntime(storage, new RecordingDriverFactory());
    try {
      const state = storage.inspectWorkspace(WORKSPACE_ID);
      expect(state?.ops.find((record) => record.opId === rootOpId)).toMatchObject({
        state: 'final',
        receipt: { accepted: true, targetThreadIds: [left, right] },
      });
      for (const [threadId, derivedOpId] of [
        [left, seeded.leftDerived],
        [right, seeded.rightDerived],
      ] as const) {
        const folded = foldThreadJournal(await loadThreadRecords(storage, threadId));
        expect(folded.mailbox.get(derivedOpId)).toMatchObject({ state: 'completed', outcome: 'no_op' });
        expect(folded.envelopes.filter((envelope) =>
          envelope.opId === derivedOpId && envelope.event.type === 'op_accepted')).toHaveLength(1);
      }
      expect(await runtime.submit({
        type: 'cancel_scope',
        opId: rootOpId,
        workspaceId: WORKSPACE_ID,
        scope: 'workspace',
      })).toMatchObject({ accepted: true, duplicate: true, targetThreadIds: [left, right] });
    } finally {
      await runtime.close();
    }
  });

  test('auto-attach chooses the latest accepted resume model and lifecycle identity', async () => {
    const storage = createMemoryRuntimeStorage();
    const threadId = 'thread-auto-attach-latest-resume' as ThreadId;
    const createOpId = 'op_e_c0000000000000000000000000000001' as ExternalOpId;
    const closeOpId = 'op_e_c0000000000000000000000000000002' as ExternalOpId;
    const resumeOpId = 'op_e_c0000000000000000000000000000003' as ExternalOpId;
    const resumeModel: ModelRef = { ...MODEL.ref, model: 'latest-resume-model' };
    await seedFinalResumeIntent(
      storage,
      createThreadOp(createOpId, threadId),
      closeOpId,
      { ...resumeOp(resumeOpId, threadId), model: resumeModel },
    );
    const drivers = new RecordingDriverFactory();
    const resolved: ModelRef[] = [];
    const runtime = await createRuntime({
      workspace: { cwd: CWD, workspaceId: WORKSPACE_ID },
      storage,
      modelResolver: {
        async resolve(ref) {
          resolved.push(ref);
          return { ok: true as const, model: { ...MODEL, ref } };
        },
      },
      permissionPolicy: new FixedPolicy(),
      threadDriverFactory: drivers,
      identityFactory: new TestIdentityFactory(),
      clock: { now: () => 2 },
    });
    await runtime.close();
    expect(resolved).toEqual([resumeModel]);
    expect(drivers.resumeCalls).toBe(1);
    expect(drivers.createCalls).toBe(0);
    const expectedCloseId = deriveOpId({
      purpose: 'thread_close_on_runtime_close',
      workspaceId: WORKSPACE_ID,
      parts: [threadId, resumeOpId],
    });
    const folded = foldThreadJournal(await loadThreadRecords(storage, threadId));
    expect(folded.envelopes.filter((envelope) =>
      envelope.opId === expectedCloseId
      && envelope.event.type === 'thread_closed')).toHaveLength(1);
  });

  test('a durable thread_close supersedes older accepted attachment intents during startup', async () => {
    const storage = createMemoryRuntimeStorage();
    const threadId = 'thread-auto-attach-suppressed-by-close' as ThreadId;
    await seedFinalCreateIntent(
      storage,
      createThreadOp('op_e_c0000000000000000000000000000004' as ExternalOpId, threadId),
      'closed-intent-key',
    );
    await appendFinalCloseIntent(
      storage,
      threadId,
      'op_e_c0000000000000000000000000000005' as ExternalOpId,
    );
    const drivers = new RecordingDriverFactory();
    let resolverCalls = 0;
    const runtime = await createRuntime({
      workspace: { cwd: CWD, workspaceId: WORKSPACE_ID },
      storage,
      modelResolver: {
        async resolve(ref) {
          resolverCalls++;
          return { ok: true as const, model: { ...MODEL, ref } };
        },
      },
      permissionPolicy: new FixedPolicy(),
      threadDriverFactory: drivers,
      identityFactory: new TestIdentityFactory(),
    });
    try {
      expect(resolverCalls).toBe(0);
      expect(drivers.createCalls).toBe(0);
      expect(drivers.resumeCalls).toBe(0);
      expect((await runtime.listThreads())[0]).toMatchObject({ threadId, state: 'closed' });
    } finally {
      await runtime.close();
    }
  });

  test('recovers a no-durableRef accepted create skeleton with create once and persists its binding', async () => {
    const storage = createMemoryRuntimeStorage();
    const threadId = 'thread-auto-create-skeleton' as ThreadId;
    const creationKey = 'accepted-create-skeleton-key';
    await seedFinalCreateIntent(
      storage,
      createThreadOp('op_e_c0000000000000000000000000000006' as ExternalOpId, threadId),
      creationKey,
      false,
    );
    const createDrivers = new RecordingDriverFactory();
    const first = await openRuntime(storage, createDrivers);
    try {
      expect(createDrivers.createCalls).toBe(1);
      expect(createDrivers.resumeCalls).toBe(0);
      expect(createDrivers.creationKeys).toEqual([creationKey]);
    } finally {
      await first.close();
    }

    const resumeDrivers = new RecordingDriverFactory();
    const second = await openRuntime(storage, resumeDrivers);
    try {
      expect((await second.submit(resumeOp(
        'op_e_c0000000000000000000000000000007',
        threadId,
      ))).accepted).toBe(true);
      expect(resumeDrivers.createCalls).toBe(0);
      expect(resumeDrivers.resumeCalls).toBe(1);
    } finally {
      await second.close();
    }
  });

  test('does not bind a no-durableRef create until the recovered checkpoint is proven', async () => {
    const storage = createMemoryRuntimeStorage();
    const threadId = 'thread-auto-create-skeleton-mismatch' as ThreadId;
    const createOpId = 'op_e_c000000000000000000000000000000a' as ExternalOpId;
    const creationKey = 'accepted-create-skeleton-mismatch-key';
    await seedFinalCreateIntent(
      storage,
      createThreadOp(createOpId, threadId),
      creationKey,
      false,
    );
    const factory = new CreateCheckpointMismatchFactory([true, false]);
    await expect(openRuntime(storage, factory)).rejects.toMatchObject({
      code: 'driver_checkpoint_mismatch',
    });
    expect(factory.createCalls).toBe(1);
    expect(factory.closeCalls).toBe(1);
    expect(factory.creationKeys).toEqual([creationKey]);
    const afterMismatch = storage.inspectWorkspace(WORKSPACE_ID)?.ops.find((record) =>
      record.opId === createOpId);
    expect(afterMismatch?.driverCreation).toEqual({ creationKey });

    const recovered = await openRuntime(storage, factory);
    try {
      expect(factory.createCalls).toBe(2);
      expect(factory.creationKeys).toEqual([creationKey, creationKey]);
    } finally {
      await recovered.close();
    }
  });

  test.each([
    ['safe quarantined close', false],
    ['unknown quarantined close', true],
  ] as const)('auto-attach releases storage fencing after %s so a new Supervisor can recover', async (
    _name,
    closeReject,
  ) => {
    const storage = createMemoryRuntimeStorage();
    const threadId = `thread-auto-attach-cleanup-${closeReject}` as ThreadId;
    await seedFinalCreateIntent(
      storage,
      createThreadOp(
        closeReject
          ? 'op_e_c0000000000000000000000000000008' as ExternalOpId
          : 'op_e_c0000000000000000000000000000009' as ExternalOpId,
        threadId,
      ),
      `cleanup-key-${closeReject}`,
    );
    const factory = new CheckpointMismatchFactory([
      { mismatch: true, closeReject },
      { mismatch: false },
    ]);
    await expect(openRuntime(storage, factory)).rejects.toBeInstanceOf(Error);
    expect(factory.resumeCalls).toBe(1);
    expect(factory.closeCalls).toBe(1);

    const recovered = await openRuntime(storage, factory);
    try {
      expect(factory.resumeCalls).toBe(2);
      expect((await recovered.listThreads())[0]).toMatchObject({ threadId, state: 'idle' });
    } finally {
      await recovered.close();
    }
  });
});

const RECOVERY_RUN_ID = 'run-recovery-root' as RunId;
const STALE_MODEL: ModelConfig = { ref: { provider: 'faux', api: 'faux', model: 'stale' } };
const RESUME_MODEL: ModelConfig = { ref: { provider: 'faux', api: 'faux', model: 'resume-new' } };

async function seedPromptCrash(
  storage: RuntimeStoragePort,
  threadId: ThreadId,
  op: Extract<RuntimeOp, { type: 'prompt' }>,
  phase: 'accepted_pending' | 'started' | 'completed',
): Promise<void> {
  const workspace = await storage.openWorkspace({ cwd: CWD, workspaceId: WORKSPACE_ID });
  const lease = await workspace.acquireSupervisorLease('seed-process');
  const ledger: SupervisorOpLedgerRecord = {
    opId: op.opId,
    op,
    payloadHash: runtimeOpPayloadHash(op),
    state: 'reserved',
  };
  await workspace.reserveSupervisorOp(lease, ledger);
  const meta = threadMeta(threadId, op.opId);
  const journal = await workspace.createThreadJournal(lease, { threadId, meta });
  await journal.acquireWriteLease(lease);
  const records = await journal.load();
  const events = new WorkspaceEventStream();
  events.registerThread(threadId);
  const writer = new ThreadJournalWriter({
    workspaceId: WORKSPACE_ID,
    threadId,
    journal,
    events,
    clock: { now: () => 1 },
    state: foldThreadJournal(records),
    records,
  });
  await writer.appendPrepare({ type: 'mailbox_prepare', opId: op.opId, op, timestamp: 1 });
  await writer.commit([{
    event: { type: 'op_accepted', opType: 'prompt' },
    opId: op.opId,
    runId: RECOVERY_RUN_ID,
  }], [
    { type: 'accepted_pending', opId: op.opId, opType: 'prompt' },
    {
      type: 'run_reserved',
      runId: RECOVERY_RUN_ID,
      ownerOpId: op.opId,
      reason: 'prompt',
      permissionCeiling: CEILING,
    },
  ]);
  if (phase === 'started' || phase === 'completed') {
    await writer.commit([{
      event: { type: 'op_started', opType: 'prompt' },
      opId: op.opId,
      runId: RECOVERY_RUN_ID,
    }], [
      { type: 'started', opId: op.opId },
      { type: 'run_started', runId: RECOVERY_RUN_ID },
    ]);
  }
  if (phase === 'completed') {
    await writer.commit([{
      event: {
        type: 'op_completed',
        opType: 'prompt',
        terminalRunId: RECOVERY_RUN_ID,
        outcome: 'applied',
      },
      opId: op.opId,
      runId: RECOVERY_RUN_ID,
    }], [
      { type: 'completed', opId: op.opId, outcome: 'applied' },
      { type: 'run_terminal', runId: RECOVERY_RUN_ID, status: 'completed' },
    ]);
  }
  await writer.close();
  await workspace.releaseSupervisorLease(lease);
  await workspace.close();
}

async function seedSetModelCrash(
  storage: RuntimeStoragePort,
  threadId: ThreadId,
  op: Extract<RuntimeOp, { type: 'set_model' }>,
  phase: 'accepted_pending' | 'started' | 'completed',
): Promise<void> {
  const workspace = await storage.openWorkspace({ cwd: CWD, workspaceId: WORKSPACE_ID });
  const lease = await workspace.acquireSupervisorLease(`seed-set-model-${phase}`);
  await workspace.reserveSupervisorOp(lease, {
    opId: op.opId,
    op,
    payloadHash: runtimeOpPayloadHash(op),
    state: 'reserved',
  });
  const journal = await workspace.createThreadJournal(lease, {
    threadId,
    meta: threadMeta(threadId, op.opId),
  });
  await journal.acquireWriteLease(lease);
  const records = await journal.load();
  const events = new WorkspaceEventStream();
  events.registerThread(threadId);
  const writer = new ThreadJournalWriter({
    workspaceId: WORKSPACE_ID,
    threadId,
    journal,
    events,
    clock: { now: () => 1 },
    state: foldThreadJournal(records),
    records,
  });
  await writer.appendPrepare({ type: 'mailbox_prepare', opId: op.opId, op, timestamp: 1 });
  await writer.commit([{
    event: { type: 'op_accepted', opType: 'set_model' },
    opId: op.opId,
  }], [{ type: 'accepted_pending', opId: op.opId, opType: 'set_model' }]);
  if (phase === 'started' || phase === 'completed') {
    await writer.commit([{
      event: { type: 'op_started', opType: 'set_model' },
      opId: op.opId,
    }], [{ type: 'started', opId: op.opId }]);
  }
  if (phase === 'completed') {
    await writer.commit([{
      event: { type: 'op_completed', opType: 'set_model', outcome: 'applied' },
      opId: op.opId,
    }], [
      { type: 'completed', opId: op.opId, outcome: 'applied' },
      { type: 'model_selected', ownerOpId: op.opId, model: op.model },
    ]);
  }
  await writer.close();
  await workspace.releaseSupervisorLease(lease);
  await workspace.close();
}

async function seedControlResponseCrash(
  storage: RuntimeStoragePort,
  threadId: ThreadId,
  responsePhase: 'accepted_pending' | 'started',
  durableAllowAlways = false,
): Promise<{ readonly requestId: string; readonly responseOpId: ExternalOpId }> {
  const promptOp = prompt(
    responsePhase === 'accepted_pending'
      ? 'op_e_21000000000000000000000000000001'
      : 'op_e_21000000000000000000000000000002',
    threadId,
    'approval crash',
  );
  const responseOpId = (responsePhase === 'accepted_pending'
    ? 'op_e_21000000000000000000000000000003'
    : 'op_e_21000000000000000000000000000004') as ExternalOpId;
  const runId = `${RECOVERY_RUN_ID}-${responsePhase}` as RunId;
  const turnId = `turn-control-${responsePhase}` as import('../protocol/index.js').TurnId;
  const requestId = `request-control-${responsePhase}`;
  const workspace = await storage.openWorkspace({ cwd: CWD, workspaceId: WORKSPACE_ID });
  const lease = await workspace.acquireSupervisorLease(`seed-control-${responsePhase}`);
  const journal = await workspace.createThreadJournal(lease, {
    threadId,
    meta: threadMeta(threadId, promptOp.opId),
  });
  await journal.acquireWriteLease(lease);
  const records = await journal.load();
  const events = new WorkspaceEventStream();
  events.registerThread(threadId);
  const writer = new ThreadJournalWriter({
    workspaceId: WORKSPACE_ID,
    threadId,
    journal,
    events,
    clock: { now: () => 1 },
    state: foldThreadJournal(records),
    records,
  });
  await writer.appendPrepare({
    type: 'mailbox_prepare',
    opId: promptOp.opId,
    op: promptOp,
    timestamp: 1,
  });
  await writer.commit([{
    event: { type: 'op_accepted', opType: 'prompt' },
    opId: promptOp.opId,
    runId,
  }], [
    { type: 'accepted_pending', opId: promptOp.opId, opType: 'prompt' },
    { type: 'run_reserved', runId, ownerOpId: promptOp.opId, reason: 'prompt', permissionCeiling: CEILING },
  ]);
  await writer.commit([{
    event: { type: 'op_started', opType: 'prompt' },
    opId: promptOp.opId,
    runId,
  }], [
    { type: 'started', opId: promptOp.opId },
    { type: 'run_started', runId },
  ]);
  await writer.appendPrepare({
    type: 'turn_prepare',
    runId,
    turnId,
    turnOrdinal: 1,
    workspaceCeiling: CEILING,
    runCeiling: CEILING,
    turnCeiling: CEILING,
    timestamp: 1,
  });
  await writer.commitDriverEvent({
    event: { type: 'turn_start' },
    runId,
    turnId,
  }, undefined, [{ type: 'turn_activated', runId, turnId, turnOrdinal: 1 }]);
  await writer.commitDriverEvent({
    event: {
      type: 'control_request',
      requestId,
      kind: 'approval',
      owningRunId: runId,
      owningTurnId: turnId,
      policyRevision: 'policy-control-recovery',
      payload: {
        toolCallId: 'call-control-recovery',
        description: 'recover me',
        ...(durableAllowAlways && {
          legacyProposal: { patterns: ['Edit(*)'] as [string], forceConfirm: false },
        }),
      },
    },
    runId,
    turnId,
  });
  const responseOp = {
    type: 'control_response',
    opId: responseOpId,
    workspaceId: WORKSPACE_ID,
    threadId,
    requestId,
    decision: durableAllowAlways ? 'allow_always' as const : 'allow_once' as const,
  } as const;
  await writer.appendPrepare({
    type: 'mailbox_prepare',
    opId: responseOpId,
    op: responseOp,
    timestamp: 1,
  });
  await writer.commit([{
    event: { type: 'op_accepted', opType: 'control_response' },
    opId: responseOpId,
  }], [
    { type: 'accepted_pending', opId: responseOpId, opType: 'control_response' },
    {
      type: 'control_response_claimed',
      requestId,
      responseOpId,
      decision: responseOp.decision,
      acceptedAt: 1,
    },
  ], 1);
  if (responsePhase === 'started') {
    await writer.commit([{
      event: { type: 'op_started', opType: 'control_response' },
      opId: responseOpId,
    }], [{ type: 'started', opId: responseOpId }]);
  }
  await writer.close();
  await workspace.releaseSupervisorLease(lease);
  await workspace.close();
  return { requestId, responseOpId };
}

async function seedStartedChildCrash(
  storage: RuntimeStoragePort,
  parentThreadId: ThreadId,
  childThreadId: ThreadId,
): Promise<{ readonly childOpId: ExternalOpId; readonly childRunId: RunId }> {
  const parentOpId = 'op_e_23000000000000000000000000000001' as ExternalOpId;
  const childOpId = 'op_e_23000000000000000000000000000002' as ExternalOpId;
  const childRunId = 'run-crash-child-started' as RunId;
  const workspace = await storage.openWorkspace({ cwd: CWD, workspaceId: WORKSPACE_ID });
  const lease = await workspace.acquireSupervisorLease('seed-started-child');
  await workspace.createThreadJournal(lease, {
    threadId: parentThreadId,
    meta: threadMeta(parentThreadId, parentOpId),
  });
  const childMeta: ThreadMetaRecord = {
    ...threadMeta(childThreadId, childOpId),
    parentThreadId,
    createdByRunId: 'run-parent-creation' as RunId,
  };
  const childJournal = await workspace.createThreadJournal(lease, {
    threadId: childThreadId,
    meta: childMeta,
  });
  await childJournal.acquireWriteLease(lease);
  const records = await childJournal.load();
  const events = new WorkspaceEventStream();
  events.registerThread(childThreadId);
  const writer = new ThreadJournalWriter({
    workspaceId: WORKSPACE_ID,
    threadId: childThreadId,
    journal: childJournal,
    events,
    clock: { now: () => 1 },
    state: foldThreadJournal(records),
    records,
  });
  const childPrompt = prompt(childOpId, childThreadId, 'crash child');
  await writer.appendPrepare({
    type: 'mailbox_prepare',
    opId: childOpId,
    op: childPrompt,
    timestamp: 1,
  });
  await writer.commit([{
    event: { type: 'op_accepted', opType: 'prompt' },
    opId: childOpId,
    runId: childRunId,
  }], [
    { type: 'accepted_pending', opId: childOpId, opType: 'prompt' },
    {
      type: 'run_reserved',
      runId: childRunId,
      ownerOpId: childOpId,
      reason: 'prompt',
      permissionCeiling: CEILING,
    },
  ]);
  await writer.commit([{
    event: { type: 'op_started', opType: 'prompt' },
    opId: childOpId,
    runId: childRunId,
  }], [
    { type: 'started', opId: childOpId },
    { type: 'run_started', runId: childRunId },
  ]);
  await writer.close();
  await workspace.releaseSupervisorLease(lease);
  await workspace.close();
  return { childOpId, childRunId };
}

async function seedResolvedControlBeforeResponseCompletion(
  storage: RuntimeStoragePort,
  threadId: ThreadId,
): Promise<{ readonly requestId: string; readonly responseOpId: ExternalOpId }> {
  const seeded = await seedControlResponseCrash(storage, threadId, 'started');
  const workspace = await storage.openWorkspace({ cwd: CWD, workspaceId: WORKSPACE_ID });
  const lease = await workspace.acquireSupervisorLease('seed-control-resolved');
  const journal = await workspace.openThreadJournal(threadId);
  if (journal === undefined) throw new Error('missing control recovery journal');
  await journal.acquireWriteLease(lease);
  const records = await journal.load();
  const state = foldThreadJournal(records);
  const request = state.checkpoint.frontend.pendingControls.find((candidate) =>
    candidate.requestId === seeded.requestId);
  if (request === undefined) throw new Error('missing pending control request');
  if (request.kind !== 'approval') throw new Error('expected an approval request');
  const events = new WorkspaceEventStream();
  events.registerThread(threadId);
  events.seed(threadId, state.envelopes);
  const writer = new ThreadJournalWriter({
    workspaceId: WORKSPACE_ID,
    threadId,
    journal,
    events,
    clock: { now: () => 1 },
    state,
    records,
  });
  await writer.commitDriverEvent({
    event: {
      type: 'control_resolved',
      requestId: request.requestId,
      kind: request.kind,
      owningRunId: request.owningRunId,
      owningTurnId: request.owningTurnId,
      policyRevision: request.policyRevision,
      decision: 'allow_once',
    },
    runId: request.owningRunId,
    turnId: request.owningTurnId,
    opId: seeded.responseOpId,
  });
  await writer.close();
  await workspace.releaseSupervisorLease(lease);
  await workspace.close();
  return seeded;
}

async function seedPartialToolCrash(
  storage: RuntimeStoragePort,
  threadId: ThreadId,
): Promise<{
  readonly rootOpId: ExternalOpId;
  readonly runId: RunId;
  readonly turnId: import('../protocol/index.js').TurnId;
  readonly assistantId: string;
  readonly toolCallId: string;
  readonly requestId: string;
}> {
  const rootOpId = 'op_e_2f000000000000000000000000000000' as ExternalOpId;
  const rootOp = prompt(rootOpId, threadId, 'partial tool crash');
  const runId = 'run-partial-tool-crash' as RunId;
  const turnId = 'turn-partial-tool-crash' as import('../protocol/index.js').TurnId;
  const assistantId = 'assistant-partial-crash';
  const toolCallId = 'tool-call-partial-crash';
  const requestId = 'request-partial-crash';
  const workspace = await storage.openWorkspace({ cwd: CWD, workspaceId: WORKSPACE_ID });
  const lease = await workspace.acquireSupervisorLease('seed-partial-tool');
  const ledger: SupervisorOpLedgerRecord = {
    opId: rootOpId,
    op: rootOp,
    payloadHash: runtimeOpPayloadHash(rootOp),
    state: 'reserved',
  };
  await workspace.reserveSupervisorOp(lease, ledger);
  const journal = await workspace.createThreadJournal(lease, {
    threadId,
    meta: threadMeta(threadId, rootOpId),
  });
  await journal.acquireWriteLease(lease);
  const records = await journal.load();
  const events = new WorkspaceEventStream();
  events.registerThread(threadId);
  const writer = new ThreadJournalWriter({
    workspaceId: WORKSPACE_ID,
    threadId,
    journal,
    events,
    clock: { now: () => 1 },
    state: foldThreadJournal(records),
    records,
  });
  await writer.appendPrepare({
    type: 'mailbox_prepare',
    opId: rootOpId,
    op: rootOp,
    timestamp: 1,
  });
  await writer.commit([{
    event: { type: 'op_accepted', opType: 'prompt' },
    opId: rootOpId,
    runId,
  }], [
    { type: 'accepted_pending', opId: rootOpId, opType: 'prompt' },
    { type: 'run_reserved', runId, ownerOpId: rootOpId, reason: 'prompt', permissionCeiling: CEILING },
  ]);
  await writer.commit([{
    event: { type: 'op_started', opType: 'prompt' },
    opId: rootOpId,
    runId,
  }], [
    { type: 'started', opId: rootOpId },
    { type: 'run_started', runId },
  ]);
  await writer.commitDriverEvent({
    event: { type: 'agent_start', reason: 'prompt' },
    runId,
    opId: rootOpId,
  });
  await writer.appendPrepare({
    type: 'turn_prepare',
    runId,
    turnId,
    turnOrdinal: 1,
    workspaceCeiling: CEILING,
    runCeiling: CEILING,
    turnCeiling: CEILING,
    timestamp: 1,
  });
  await writer.commitDriverEvent({
    event: { type: 'turn_start' },
    runId,
    turnId,
  }, undefined, [{ type: 'turn_activated', runId, turnId, turnOrdinal: 1 }]);
  await writer.commitDriverEvent({
    event: {
      type: 'message_start',
      message: {
        role: 'assistant',
        id: assistantId,
        timestamp: 1,
        content: [],
        model: MODEL.ref,
        stopReason: 'stop',
        usage: { input: 0, output: 0 },
      },
    },
    runId,
    turnId,
  });
  await writer.commitDriverEvent({
    event: {
      type: 'tool_execution_start',
      toolCallId,
      toolName: 'partial_tool',
      args: { value: 1 },
    },
    runId,
    turnId,
  });
  await writer.commitDriverEvent({
    event: {
      type: 'control_request',
      requestId,
      kind: 'approval',
      owningRunId: runId,
      owningTurnId: turnId,
      policyRevision: 'policy-partial-crash',
      payload: {
        toolCallId,
        description: 'pending approval at crash',
      },
    },
    runId,
    turnId,
  });
  await writer.close();
  await workspace.releaseSupervisorLease(lease);
  await workspace.close();
  return { rootOpId, runId, turnId, assistantId, toolCallId, requestId };
}

async function seedQueueCrash(
  storage: RuntimeStoragePort,
  threadId: ThreadId,
  queueOpId: ExternalOpId,
  opType: 'steer' | 'follow_up',
  phase: 'accepted_pending' | 'started',
  effectCommitted: boolean,
): Promise<void> {
  await seedPromptCrash(
    storage,
    threadId,
    prompt('op_e_3000000000000000000000000000000f', threadId, 'queue seed'),
    'completed',
  );
  const workspace = await storage.openWorkspace({ cwd: CWD, workspaceId: WORKSPACE_ID });
  const lease = await workspace.acquireSupervisorLease('seed-queue-crash');
  const journal = await workspace.openThreadJournal(threadId);
  if (journal === undefined) throw new Error('missing queue recovery journal');
  await journal.acquireWriteLease(lease);
  const records = await journal.load();
  const state = foldThreadJournal(records);
  const events = new WorkspaceEventStream();
  events.registerThread(threadId);
  events.seed(threadId, state.envelopes);
  const writer = new ThreadJournalWriter({
    workspaceId: WORKSPACE_ID,
    threadId,
    journal,
    events,
    clock: { now: () => 1 },
    state,
    records,
  });
  const queueOp = {
    type: opType,
    opId: queueOpId,
    workspaceId: WORKSPACE_ID,
    threadId,
    text: `recover ${opType}`,
  } as const;
  await writer.appendPrepare({
    type: 'mailbox_prepare',
    opId: queueOpId,
    op: queueOp,
    timestamp: 1,
  });
  await writer.commit([{
    event: { type: 'op_accepted', opType },
    opId: queueOpId,
  }], [{ type: 'accepted_pending', opId: queueOpId, opType }]);
  if (phase === 'started') {
    await writer.commit([{
      event: { type: 'op_started', opType },
      opId: queueOpId,
    }], [{ type: 'started', opId: queueOpId }]);
  }
  if (effectCommitted) {
    await writer.commitDriverEvent({
      event: {
        type: 'queue_update',
        steering: opType === 'steer'
          ? [{ id: `queue-${queueOpId}`, text: queueOp.text, kind: 'steering' }]
          : [],
        followUp: opType === 'follow_up'
          ? [{ id: `queue-${queueOpId}`, text: queueOp.text, kind: 'follow_up' }]
          : [],
      },
      opId: queueOpId,
    });
  }
  await writer.close();
  await workspace.releaseSupervisorLease(lease);
  await workspace.close();
}

async function seedReservedCreate(
  storage: RuntimeStoragePort,
  op: Extract<RuntimeOp, { type: 'thread_create' }>,
  creationKey: string,
): Promise<void> {
  const workspace = await storage.openWorkspace({ cwd: CWD, workspaceId: WORKSPACE_ID });
  const lease = await workspace.acquireSupervisorLease('seed-reserved-create');
  await workspace.reserveSupervisorOp(lease, {
    opId: op.opId,
    op,
    payloadHash: runtimeOpPayloadHash(op),
    driverCreation: { creationKey },
    state: 'reserved',
  });
  await workspace.releaseSupervisorLease(lease);
  await workspace.close();
}

async function seedFinalCreateIntent(
  storage: RuntimeStoragePort,
  op: Extract<RuntimeOp, { type: 'thread_create' }>,
  creationKey: string,
  includeDriverRef = true,
): Promise<void> {
  const workspace = await storage.openWorkspace({ cwd: CWD, workspaceId: WORKSPACE_ID });
  const lease = await workspace.acquireSupervisorLease('seed-final-create');
  const ledger: SupervisorOpLedgerRecord = {
    opId: op.opId,
    op,
    payloadHash: runtimeOpPayloadHash(op),
    driverCreation: {
      creationKey,
      ...(includeDriverRef && { driverRef: { kind: 'test-driver', key: op.threadId } }),
    },
    state: 'reserved',
  };
  await workspace.reserveSupervisorOp(lease, ledger);
  const completeMeta = threadMeta(op.threadId, op.opId);
  const { driverRef, ...metaWithoutDriverRef } = completeMeta;
  void driverRef;
  const meta: ThreadMetaRecord = includeDriverRef
    ? completeMeta
    : metaWithoutDriverRef;
  const journal = await workspace.createThreadJournal(lease, { threadId: op.threadId, meta });
  await journal.acquireWriteLease(lease);
  const records = await journal.load();
  const events = new WorkspaceEventStream();
  events.registerThread(op.threadId);
  const writer = new ThreadJournalWriter({
    workspaceId: WORKSPACE_ID,
    threadId: op.threadId,
    journal,
    events,
    clock: { now: () => 1 },
    state: foldThreadJournal(records),
    records,
  });
  await writer.commit([
    { event: { type: 'op_accepted', opType: 'thread_create' }, opId: op.opId },
    {
      event: {
        type: 'thread_created',
        thread: { threadId: op.threadId, createdAt: 1, state: 'idle' },
      },
      opId: op.opId,
    },
    { event: { type: 'op_completed', opType: 'thread_create', outcome: 'applied' }, opId: op.opId },
  ], [{ type: 'model_selected', ownerOpId: op.opId, model: op.model }]);
  await writer.close();
  await workspace.finalizeSupervisorOp(lease, {
    ...ledger,
    state: 'final',
    receipt: {
      accepted: true,
      opId: op.opId,
      duplicate: false,
      threadId: op.threadId,
    },
  });
  await workspace.releaseSupervisorLease(lease);
  await workspace.close();
}

async function appendFinalCloseIntent(
  storage: RuntimeStoragePort,
  threadId: ThreadId,
  closeOpId: ExternalOpId,
): Promise<void> {
  const op = {
    type: 'thread_close' as const,
    opId: closeOpId,
    workspaceId: WORKSPACE_ID,
    threadId,
  };
  const workspace = await storage.openWorkspace({ cwd: CWD, workspaceId: WORKSPACE_ID });
  const lease = await workspace.acquireSupervisorLease('seed-final-close');
  const ledger: SupervisorOpLedgerRecord = {
    opId: closeOpId,
    op,
    payloadHash: runtimeOpPayloadHash(op),
    state: 'reserved',
  };
  await workspace.reserveSupervisorOp(lease, ledger);
  const journal = await workspace.openThreadJournal(threadId);
  if (journal === undefined) throw new Error('missing final close journal');
  await journal.acquireWriteLease(lease);
  const records = await journal.load();
  const state = foldThreadJournal(records);
  const events = new WorkspaceEventStream();
  events.registerThread(threadId);
  events.seed(threadId, state.envelopes);
  const writer = new ThreadJournalWriter({
    workspaceId: WORKSPACE_ID,
    threadId,
    journal,
    events,
    clock: { now: () => 1 },
    state,
    records,
  });
  await writer.appendPrepare({
    type: 'mailbox_prepare',
    opId: closeOpId,
    op,
    timestamp: 1,
  });
  await writer.commit([
    { event: { type: 'op_accepted', opType: 'thread_close' }, opId: closeOpId },
    { event: { type: 'op_started', opType: 'thread_close' }, opId: closeOpId },
  ], [
    { type: 'accepted_pending', opId: closeOpId, opType: 'thread_close' },
    { type: 'started', opId: closeOpId },
  ]);
  await writer.commit([
    {
      event: { type: 'op_completed', opType: 'thread_close', outcome: 'applied' },
      opId: closeOpId,
    },
    { event: { type: 'thread_closed', threadId }, opId: closeOpId },
  ], [{ type: 'completed', opId: closeOpId, outcome: 'applied' }]);
  await writer.close();
  await workspace.finalizeSupervisorOp(lease, {
    ...ledger,
    state: 'final',
    receipt: { accepted: true, opId: closeOpId, duplicate: false, threadId },
  });
  await workspace.releaseSupervisorLease(lease);
  await workspace.close();
}

async function seedFinalResumeIntent(
  storage: RuntimeStoragePort,
  createOp: Extract<RuntimeOp, { type: 'thread_create' }>,
  closeOpId: ExternalOpId,
  resume: Extract<RuntimeOp, { type: 'thread_resume' }>,
): Promise<void> {
  await seedFinalCreateIntent(storage, createOp, 'latest-resume-create-key');
  await appendFinalCloseIntent(storage, createOp.threadId, closeOpId);
  const workspace = await storage.openWorkspace({ cwd: CWD, workspaceId: WORKSPACE_ID });
  const lease = await workspace.acquireSupervisorLease('seed-final-resume');
  const ledger: SupervisorOpLedgerRecord = {
    opId: resume.opId,
    op: resume,
    payloadHash: runtimeOpPayloadHash(resume),
    state: 'reserved',
  };
  await workspace.reserveSupervisorOp(lease, ledger);
  const journal = await workspace.openThreadJournal(resume.threadId);
  if (journal === undefined) throw new Error('missing final resume journal');
  await journal.acquireWriteLease(lease);
  const records = await journal.load();
  const state = foldThreadJournal(records);
  const events = new WorkspaceEventStream();
  events.registerThread(resume.threadId);
  events.seed(resume.threadId, state.envelopes);
  const writer = new ThreadJournalWriter({
    workspaceId: WORKSPACE_ID,
    threadId: resume.threadId,
    journal,
    events,
    clock: { now: () => 1 },
    state,
    records,
  });
  await writer.commit([
    { event: { type: 'op_accepted', opType: 'thread_resume' }, opId: resume.opId },
    {
      event: {
        type: 'thread_resumed',
        thread: {
          threadId: resume.threadId,
          createdAt: state.summary.createdAt,
          state: 'idle',
        },
      },
      opId: resume.opId,
    },
    { event: { type: 'op_completed', opType: 'thread_resume', outcome: 'applied' }, opId: resume.opId },
  ], [{ type: 'model_selected', ownerOpId: resume.opId, model: resume.model }]);
  await writer.close();
  await workspace.finalizeSupervisorOp(lease, {
    ...ledger,
    state: 'final',
    receipt: {
      accepted: true,
      opId: resume.opId,
      duplicate: false,
      threadId: resume.threadId,
    },
  });
  await workspace.releaseSupervisorLease(lease);
  await workspace.close();
}

async function seedPartialCancelScope(
  storage: RuntimeStoragePort,
  left: ThreadId,
  right: ThreadId,
  rootOpId: ExternalOpId,
): Promise<{
  readonly leftDerived: ReturnType<typeof deriveOpId>;
  readonly rightDerived: ReturnType<typeof deriveOpId>;
}> {
  await seedPromptCrash(
    storage,
    left,
    prompt('op_e_b0000000000000000000000000000001', left, 'left seed'),
    'completed',
  );
  await seedPromptCrash(
    storage,
    right,
    prompt('op_e_b0000000000000000000000000000002', right, 'right seed'),
    'completed',
  );
  const leftDerived = deriveOpId({
    purpose: 'cancel_target',
    workspaceId: WORKSPACE_ID,
    parts: [rootOpId, left],
  });
  const rightDerived = deriveOpId({
    purpose: 'cancel_target',
    workspaceId: WORKSPACE_ID,
    parts: [rootOpId, right],
  });
  const rootOp = {
    type: 'cancel_scope' as const,
    opId: rootOpId,
    workspaceId: WORKSPACE_ID,
    scope: 'workspace' as const,
  };
  const target = { kind: 'no_current_activity' as const };
  const workspace = await storage.openWorkspace({ cwd: CWD, workspaceId: WORKSPACE_ID });
  const lease = await workspace.acquireSupervisorLease('seed-partial-cancel');
  for (const [threadId, opId] of [[left, leftDerived], [right, rightDerived]] as const) {
    await workspace.reserveDerivedOpIdentity(lease, {
      opId,
      purpose: 'cancel_target',
      workspaceId: WORKSPACE_ID,
      parts: [rootOpId, threadId],
    });
  }
  await workspace.reserveSupervisorOp(lease, {
    opId: rootOpId,
    op: rootOp,
    payloadHash: runtimeOpPayloadHash(rootOp),
    targetThreadIds: [left, right],
    resolvedTargets: [
      { threadId: left, target, derivedOpId: leftDerived },
      { threadId: right, target, derivedOpId: rightDerived },
    ],
    state: 'reserved',
  });
  const journal = await workspace.openThreadJournal(left);
  if (journal === undefined) throw new Error('missing partial cancel target journal');
  await journal.acquireWriteLease(lease);
  const records = await journal.load();
  const state = foldThreadJournal(records);
  const events = new WorkspaceEventStream();
  events.registerThread(left);
  events.seed(left, state.envelopes);
  const writer = new ThreadJournalWriter({
    workspaceId: WORKSPACE_ID,
    threadId: left,
    journal,
    events,
    clock: { now: () => 1 },
    state,
    records,
  });
  const derived = {
    type: 'abort' as const,
    opId: leftDerived,
    workspaceId: WORKSPACE_ID,
    threadId: left,
    parentOpId: rootOpId,
    resolvedTarget: target,
  };
  await writer.appendPrepare({
    type: 'mailbox_prepare',
    opId: leftDerived,
    op: derived,
    timestamp: 1,
  });
  await writer.commit([
    {
      event: { type: 'op_accepted', opType: 'abort', parentOpId: rootOpId },
      opId: leftDerived,
    },
    {
      event: { type: 'op_started', opType: 'abort', parentOpId: rootOpId },
      opId: leftDerived,
    },
  ], [
    {
      type: 'accepted_pending',
      opId: leftDerived,
      opType: 'abort',
      resolvedTarget: target,
      parentOpId: rootOpId,
    },
    { type: 'started', opId: leftDerived },
  ]);
  await writer.commit([{
    event: { type: 'op_completed', opType: 'abort', outcome: 'no_op', parentOpId: rootOpId },
    opId: leftDerived,
  }], [{ type: 'completed', opId: leftDerived, outcome: 'no_op' }]);
  await writer.close();
  await workspace.releaseSupervisorLease(lease);
  await workspace.close();
  return { leftDerived, rightDerived };
}

function failSupervisorFinalizeOnce(
  base: RuntimeStoragePort,
  targetOpId: ExternalOpId,
): RuntimeStoragePort {
  let failed = false;
  return {
    listStoredThreads: () => base.listStoredThreads(),
    async openWorkspace(input): Promise<RuntimeWorkspaceStoragePort> {
      const workspace = await base.openWorkspace(input);
      return new Proxy(workspace, {
        get(target, property, receiver) {
          if (property === 'finalizeSupervisorOp') {
            return async (...args: Parameters<RuntimeWorkspaceStoragePort['finalizeSupervisorOp']>) => {
              if (!failed && args[1].opId === targetOpId) {
                failed = true;
                throw new Error('injected finalize failure');
              }
              return target.finalizeSupervisorOp(...args);
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
}

async function seedParentCommitBeforeChildAck(
  storage: RuntimeStoragePort,
  parentThreadId: ThreadId,
  childThreadId: ThreadId,
): Promise<{ readonly resultOpId: ReturnType<typeof deriveOpId>; readonly parentCommitSeq: number }> {
  const childOpId = 'op_e_1000000000000000000000000000000e' as ExternalOpId;
  const childRunId = 'run-outbox-child-terminal' as RunId;
  const resultOpId = deriveOpId({
    purpose: 'thread_result',
    workspaceId: WORKSPACE_ID,
    parts: [parentThreadId, childThreadId, childRunId],
  });
  const workspace = await storage.openWorkspace({ cwd: CWD, workspaceId: WORKSPACE_ID });
  const lease = await workspace.acquireSupervisorLease('seed-outbox-process');
  const parentJournal = await workspace.createThreadJournal(lease, {
    threadId: parentThreadId,
    meta: threadMeta(parentThreadId, 'op_e_1000000000000000000000000000000f' as ExternalOpId),
  });
  const childJournal = await workspace.createThreadJournal(lease, {
    threadId: childThreadId,
    meta: {
      ...threadMeta(childThreadId, childOpId),
      parentThreadId,
    },
  });
  await parentJournal.acquireWriteLease(lease);
  await childJournal.acquireWriteLease(lease);
  const events = new WorkspaceEventStream();
  events.registerThread(parentThreadId);
  events.registerThread(childThreadId);
  const parentRecords = await parentJournal.load();
  const childRecords = await childJournal.load();
  const parentWriter = new ThreadJournalWriter({
    workspaceId: WORKSPACE_ID,
    threadId: parentThreadId,
    journal: parentJournal,
    events,
    clock: { now: () => 1 },
    state: foldThreadJournal(parentRecords),
    records: parentRecords,
  });
  const childWriter = new ThreadJournalWriter({
    workspaceId: WORKSPACE_ID,
    threadId: childThreadId,
    journal: childJournal,
    events,
    clock: { now: () => 1 },
    state: foldThreadJournal(childRecords),
    records: childRecords,
  });
  const childOp = prompt(childOpId, childThreadId, 'child outbox');
  await childWriter.appendPrepare({ type: 'mailbox_prepare', opId: childOpId, op: childOp, timestamp: 1 });
  await childWriter.commit([{
    event: { type: 'op_accepted', opType: 'prompt' },
    opId: childOpId,
    runId: childRunId,
  }], [
    { type: 'accepted_pending', opId: childOpId, opType: 'prompt' },
    {
      type: 'run_reserved',
      runId: childRunId,
      ownerOpId: childOpId,
      reason: 'prompt',
      permissionCeiling: CEILING,
    },
  ]);
  await childWriter.commit([{
    event: { type: 'op_started', opType: 'prompt' },
    opId: childOpId,
    runId: childRunId,
  }], [
    { type: 'started', opId: childOpId },
    { type: 'run_started', runId: childRunId },
  ]);
  await childWriter.commit([{
    event: {
      type: 'op_completed',
      opType: 'prompt',
      terminalRunId: childRunId,
      outcome: 'applied',
    },
    opId: childOpId,
    runId: childRunId,
  }], [
    { type: 'completed', opId: childOpId, outcome: 'applied' },
    { type: 'run_terminal', runId: childRunId, status: 'completed' },
    {
      type: 'thread_result_pending',
      resultOpId,
      parentThreadId,
      childThreadId,
      terminalRunId: childRunId,
      status: 'completed',
    },
  ]);
  const parentEnvelope = await parentWriter.commit([{
    event: {
      type: 'thread_result',
      resultOpId,
      childThreadId,
      terminalRunId: childRunId,
      status: 'completed',
    },
    opId: resultOpId,
  }]);
  const parentCommitSeq = parentEnvelope[0]?.seq;
  if (parentCommitSeq === undefined) throw new Error('Parent result was not committed');
  await parentWriter.close();
  await childWriter.close();
  await workspace.releaseSupervisorLease(lease);
  await workspace.close();
  return { resultOpId, parentCommitSeq };
}

async function openRuntime(
  storage: RuntimeStoragePort,
  drivers: ThreadDriverFactory,
): Promise<Awaited<ReturnType<typeof createRuntime>>> {
  return createRuntime({
    workspace: { cwd: CWD, workspaceId: WORKSPACE_ID },
    storage,
    modelResolver: {
      async resolve(ref): Promise<{ readonly ok: true; readonly model: ModelConfig }> {
        return { ok: true, model: { ...MODEL, ref } };
      },
    },
    permissionPolicy: new FixedPolicy(),
    threadDriverFactory: drivers,
    identityFactory: new TestIdentityFactory(),
    clock: { now: () => 2 },
  });
}

function withLegacyApprovalStartupDiagnostic(base: RuntimeStoragePort): RuntimeStoragePort {
  return {
    listStoredThreads: () => base.listStoredThreads(),
    async openWorkspace(input): Promise<RuntimeWorkspaceStoragePort> {
      const workspace = await base.openWorkspace(input);
      return new Proxy(workspace, {
        get(target, property, receiver) {
          if (property === 'openLegacyApprovalPatternRepository') {
            return async (
              ...args: Parameters<NonNullable<
                RuntimeWorkspaceStoragePort['openLegacyApprovalPatternRepository']
              >>
            ): Promise<LegacyApprovalPatternRepository> => {
              const open = target.openLegacyApprovalPatternRepository;
              if (open === undefined) throw new Error('Legacy approval repository is unavailable');
              const repository = await open.call(target, ...args);
              return {
                workspaceId: repository.workspaceId,
                snapshot: () => repository.snapshot(),
                commit: (commitInput) => repository.commit(commitInput),
                startupDiagnostics: () => [{
                  code: 'legacy_approvals_invalid_ignored',
                  message: 'Invalid legacy approvals were ignored',
                }],
                close: () => repository.close(),
              };
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
}

function threadMeta(threadId: ThreadId, createdByOpId: ExternalOpId): ThreadMetaRecord {
  return {
    type: 'thread_meta',
    version: 2,
    protocolVersion: PROTOCOL_VERSION,
    workspaceId: WORKSPACE_ID,
    threadId,
    createdByOpId,
    permissionCeiling: CEILING,
    createdAt: 1,
    cwd: CWD,
    model: MODEL.ref,
    driverRef: { kind: 'test-driver', key: threadId },
  };
}

function prompt(
  opId: string | ExternalOpId,
  threadId: ThreadId,
  text: string,
): Extract<RuntimeOp, { type: 'prompt' }> {
  return { type: 'prompt', opId: opId as ExternalOpId, workspaceId: WORKSPACE_ID, threadId, text };
}

function setModelOp(
  opId: string,
  threadId: ThreadId,
  model: ModelRef,
): Extract<RuntimeOp, { type: 'set_model' }> {
  return {
    type: 'set_model',
    opId: opId as ExternalOpId,
    workspaceId: WORKSPACE_ID,
    threadId,
    model,
  };
}

function resumeOp(
  opId: string,
  threadId: ThreadId,
): Extract<RuntimeOp, { type: 'thread_resume' }> {
  return {
    type: 'thread_resume',
    opId: opId as ExternalOpId,
    workspaceId: WORKSPACE_ID,
    threadId,
    model: MODEL.ref,
  };
}

function createThreadOp(
  opId: ExternalOpId,
  threadId: ThreadId,
): Extract<RuntimeOp, { type: 'thread_create' }> {
  return { type: 'thread_create', opId, workspaceId: WORKSPACE_ID, threadId, model: MODEL.ref };
}

function onlyLedgerRecord(storage: ReturnType<typeof createMemoryRuntimeStorage>): SupervisorOpLedgerRecord {
  const records = storage.inspectWorkspace(WORKSPACE_ID)?.ops ?? [];
  expect(records).toHaveLength(1);
  const record = records[0];
  if (record === undefined) throw new Error('Missing ledger record');
  return record;
}

async function loadThreadRecords(
  storage: RuntimeStoragePort,
  threadId: ThreadId,
): Promise<readonly import('./ports.js').RuntimeJournalRecord[]> {
  const workspace = await storage.openWorkspace({ cwd: CWD, workspaceId: WORKSPACE_ID });
  try {
    return await (await workspace.openThreadJournal(threadId))?.load() ?? [];
  } finally {
    await workspace.close();
  }
}

async function nextEvent(
  iterator: AsyncIterator<Readonly<import('../protocol/index.js').EventEnvelope>>,
  predicate: (event: Readonly<import('../protocol/index.js').EventEnvelope>) => boolean,
): Promise<Readonly<import('../protocol/index.js').EventEnvelope>> {
  for (;;) {
    const item = await iterator.next();
    if (item.done) throw new Error('Event stream ended before the expected event');
    if (predicate(item.value)) return item.value;
  }
}

class TestIdentityFactory implements RuntimeIdentityFactory {
  #thread = 0;
  #run = 0;
  #turn = 0;
  #op = 0;
  #epoch = 0;

  newThreadId(): ThreadId { return `thread-generated-${++this.#thread}` as ThreadId; }
  newRunId(): RunId { return `run-generated-${++this.#run}` as RunId; }
  newTurnId(): import('../protocol/index.js').TurnId {
    return `turn-generated-${++this.#turn}` as import('../protocol/index.js').TurnId;
  }
  newOpId(): ExternalOpId {
    return `op_e_${(++this.#op).toString(16).padStart(32, '0')}` as ExternalOpId;
  }
  newProcessEpoch(): string { return `process-${++this.#epoch}`; }
  deriveOpId(input: Parameters<typeof deriveOpId>[0]): ReturnType<typeof deriveOpId> {
    return deriveOpId(input);
  }
}

class FixedPolicy implements PermissionPolicyPort {
  async snapshotWorkspaceCeiling(): Promise<typeof CEILING> { return CEILING; }
  async resolveCeiling(
    input: Parameters<PermissionPolicyPort['resolveCeiling']>[0],
  ): Promise<PermissionCeilingSnapshot> {
    return input.kind === 'child_thread'
      ? {
          ...CEILING,
          inheritedFrom: {
            parentThreadId: input.parentThreadId,
            ...(input.parentRunId !== undefined && { parentRunId: input.parentRunId }),
            parentCeilingRevision: input.parentCeiling.revision,
          },
        }
      : CEILING;
  }
}

class WorkspaceFatalApprovalFactory implements ThreadDriverFactory {
  readonly requirements = { approvalMode: 'durable_legacy_bridge' as const };
  readonly #base = new RecordingDriverFactory();
  readonly #hosts = new Map<ThreadId, ThreadDriverHostServices>();

  async create(
    input: Parameters<ThreadDriverFactory['create']>[0],
    host: ThreadDriverHostServices,
  ): Promise<ThreadDriverAttachment> {
    this.#hosts.set(input.threadId, host);
    return this.#withApproval(await this.#base.create(input, host));
  }

  async resume(
    input: Parameters<ThreadDriverFactory['resume']>[0],
    host: ThreadDriverHostServices,
  ): Promise<ThreadDriverAttachment> {
    this.#hosts.set(input.threadId, host);
    return this.#withApproval(await this.#base.resume(input, host));
  }

  dispatches(threadId: ThreadId): readonly PreparedThreadDriverCommand[] {
    return this.#base.dispatches(threadId);
  }

  async openLegacyApprovalAdapter(): Promise<LegacyApprovalAdapter> {
    return {
      async preflight() { return { kind: 'allow' }; },
      async applyResponse() {
        return {
          ok: false,
          code: 'legacy_approval_definitely_not_applied',
          message: 'recovery fixture did not apply a pattern',
        };
      },
      async close() {},
    };
  }

  async requestApproval(threadId: ThreadId, runId: RunId): Promise<LegacyApprovalInvocationResult> {
    const host = this.#hosts.get(threadId);
    if (host === undefined) throw new Error(`missing host for ${threadId}`);
    const turn = await host.reserveTurn({ runId, turnOrdinal: 1 });
    await host.commitEvent({
      event: { type: 'turn_start' },
      runId,
      turnId: turn.turnId,
    });
    if (host.requestLegacyApproval === undefined) throw new Error('approval host bridge is unavailable');
    return host.requestLegacyApproval({
      toolCallId: `call-${threadId}`,
      toolName: 'edit',
      cwd: CWD,
      args: { path: `${threadId}.ts` },
    });
  }

  #withApproval(attachment: ThreadDriverAttachment): ThreadDriverAttachment {
    const adapter: LegacyApprovalAdapter = {
      async preflight() {
        return {
          kind: 'ask',
          description: 'approve edit',
          proposal: { patterns: ['Edit(*)'], forceConfirm: false },
        };
      },
      async applyResponse() {
        return {
          ok: false,
          code: 'legacy_approval_conflict',
          message: 'conflicting durable approval receipt',
        };
      },
      async close() {},
    };
    return {
      ...attachment,
      legacyApprovalAdapter: adapter,
      legacyApprovalPolicyRevision: 'workspace-fatal-test',
    };
  }
}

class RecordingDriverFactory implements ThreadDriverFactory {
  readonly requirements = { approvalMode: 'legacy_session_edge' as const };
  readonly #drivers = new Map<ThreadId, RecordingDriver>();
  readonly creationKeys: string[] = [];
  closeCalls = 0;
  createCalls = 0;
  resumeCalls = 0;

  async create(
    input: Parameters<ThreadDriverFactory['create']>[0],
    host: ThreadDriverHostServices,
  ): Promise<ThreadDriverAttachment> {
    this.createCalls++;
    this.creationKeys.push(input.creationKey);
    return this.#attachment(input.threadId, input.model.ref, host);
  }

  async resume(
    input: {
      readonly threadId: ThreadId;
      readonly model: ModelConfig;
      readonly committedCheckpoint?: import('./ports.js').ThreadDriverCheckpoint;
    },
    host: ThreadDriverHostServices,
  ): Promise<ThreadDriverAttachment> {
    this.resumeCalls++;
    const attachment = this.#attachment(input.threadId, input.model.ref, host);
    return input.committedCheckpoint === undefined
      ? attachment
      : { ...attachment, initialCheckpoint: input.committedCheckpoint };
  }

  dispatches(threadId: ThreadId): readonly PreparedThreadDriverCommand[] {
    return this.#drivers.get(threadId)?.commands ?? [];
  }

  recoveries(threadId: ThreadId): readonly (readonly RecoveryQueueCommand[])[] {
    return this.#drivers.get(threadId)?.recoveries ?? [];
  }

  complete(threadId: ThreadId, runId: RunId, status: 'completed' | 'aborted' | 'error'): void {
    this.#drivers.get(threadId)?.complete(runId, status);
  }

  #attachment(
    threadId: ThreadId,
    model: ModelRef,
    host: ThreadDriverHostServices,
  ): ThreadDriverAttachment {
    const driver = new RecordingDriver(host, () => { this.closeCalls++; });
    this.#drivers.set(threadId, driver);
    return {
      driver,
      durableRef: { kind: 'test-driver', key: threadId },
      initialCheckpoint: emptyCheckpoint(model),
    };
  }
}

class RecordingDriver implements ThreadDriverPort {
  readonly commands: PreparedThreadDriverCommand[] = [];
  readonly recoveries: Array<readonly RecoveryQueueCommand[]> = [];
  readonly #pending = new Map<RunId, Deferred<ThreadDriverCompletion>>();

  constructor(
    private readonly host: ThreadDriverHostServices,
    private readonly onClose: () => void,
  ) {}

  async recover(commands: readonly RecoveryQueueCommand[]): Promise<void> {
    this.recoveries.push(commands);
    const steering: import('../protocol/index.js').QueuedMessage[] = [];
    const followUp: import('../protocol/index.js').QueuedMessage[] = [];
    for (const { op } of commands) {
      const queued = {
        id: `recovered-${op.opId}`,
        text: op.text,
        kind: op.type === 'steer' ? 'steering' as const : 'follow_up' as const,
      };
      if (op.type === 'steer') steering.push(queued);
      else followUp.push(queued);
      await this.host.commitEvent({
        event: { type: 'queue_update', steering: [...steering], followUp: [...followUp] },
        opId: op.opId,
      });
    }
  }
  async activate(): Promise<void> {}

  dispatch(command: PreparedThreadDriverCommand): { readonly completion: Promise<ThreadDriverCompletion> } {
    this.commands.push(command);
    if ((command.op.type === 'prompt' || command.op.type === 'continue') && 'runId' in command) {
      const completion = deferred<ThreadDriverCompletion>();
      this.#pending.set(command.runId, completion);
      return { completion: completion.promise };
    }
    if (command.op.type === 'abort' && 'resolvedTarget' in command
      && command.resolvedTarget.kind === 'run') {
      this.complete(command.resolvedTarget.runId, 'aborted');
    }
    return { completion: Promise.resolve({ kind: 'operation', outcome: 'applied' }) };
  }

  interactionState(): 'idle' | 'running' {
    return this.#pending.size === 0 ? 'idle' : 'running';
  }

  async close(): Promise<void> {
    this.onClose();
    for (const runId of [...this.#pending.keys()]) this.complete(runId, 'aborted');
  }

  complete(runId: RunId, status: 'completed' | 'aborted' | 'error'): void {
    const pending = this.#pending.get(runId);
    if (pending === undefined) return;
    this.#pending.delete(runId);
    pending.resolve({ kind: 'activity', status, terminalRunId: runId });
  }
}

class CheckpointMismatchFactory implements ThreadDriverFactory {
  readonly requirements = { approvalMode: 'legacy_session_edge' as const };
  resumeCalls = 0;
  closeCalls = 0;

  constructor(private readonly modes: Array<{
    readonly mismatch: boolean;
    readonly closeReject?: boolean;
  }>) {}

  async create(): Promise<ThreadDriverAttachment> {
    throw new Error('CheckpointMismatchFactory.create is not used');
  }

  async resume(
    input: Parameters<ThreadDriverFactory['resume']>[0],
  ): Promise<ThreadDriverAttachment> {
    this.resumeCalls++;
    const mode = this.modes.shift();
    if (mode === undefined) throw new Error('No checkpoint mismatch mode configured');
    const checkpoint = input.committedCheckpoint ?? emptyCheckpoint(input.model.ref);
    const initialCheckpoint: ThreadDriverCheckpoint = mode.mismatch
      ? {
          ...checkpoint,
          frontend: {
            ...checkpoint.frontend,
            plan: [...checkpoint.frontend.plan, { step: 'mismatch', status: 'pending' }],
          },
        }
      : checkpoint;
    return {
      driver: new CloseOnlyDriver(() => {
        this.closeCalls++;
        if (mode.closeReject === true) throw new Error('quarantined close failed');
      }),
      durableRef: input.durableRef,
      initialCheckpoint,
    };
  }
}

class CreateCheckpointMismatchFactory implements ThreadDriverFactory {
  readonly requirements = { approvalMode: 'legacy_session_edge' as const };
  readonly creationKeys: string[] = [];
  createCalls = 0;
  closeCalls = 0;

  constructor(private readonly mismatches: boolean[]) {}

  async create(
    input: Parameters<ThreadDriverFactory['create']>[0],
  ): Promise<ThreadDriverAttachment> {
    this.createCalls++;
    this.creationKeys.push(input.creationKey);
    const mismatch = this.mismatches.shift();
    if (mismatch === undefined) throw new Error('No create checkpoint mode configured');
    const checkpoint = emptyCheckpoint(input.model.ref);
    return {
      driver: new CloseOnlyDriver(() => { this.closeCalls++; }),
      durableRef: { kind: 'test-driver', key: input.threadId },
      initialCheckpoint: mismatch
        ? {
            ...checkpoint,
            frontend: {
              ...checkpoint.frontend,
              plan: [{ step: 'uncommitted create state', status: 'pending' }],
            },
          }
        : checkpoint,
    };
  }

  async resume(): Promise<ThreadDriverAttachment> {
    throw new Error('CreateCheckpointMismatchFactory.resume is not used');
  }
}

class CloseOnlyDriver implements ThreadDriverPort {
  constructor(private readonly onClose: () => void) {}

  async recover(): Promise<void> {}
  async activate(): Promise<void> {}

  dispatch(): { readonly completion: Promise<ThreadDriverCompletion> } {
    return { completion: Promise.resolve({ kind: 'operation', outcome: 'no_op' }) };
  }

  interactionState(): 'idle' { return 'idle'; }

  async close(): Promise<void> { this.onClose(); }
}

function gateFirstDerivedReservation(base: RuntimeStoragePort): {
  readonly storage: RuntimeStoragePort;
  readonly entered: Deferred<void>;
  readonly release: Deferred<void>;
  arm(): void;
} {
  const entered = deferred<void>();
  const release = deferred<void>();
  let armed = false;
  let blocked = false;
  return {
    entered,
    release,
    arm(): void { armed = true; },
    storage: {
      listStoredThreads: () => base.listStoredThreads(),
      async openWorkspace(input): Promise<RuntimeWorkspaceStoragePort> {
        const workspace = await base.openWorkspace(input);
        return new Proxy(workspace, {
          get(target, property, receiver) {
            if (property === 'reserveDerivedOpIdentity') {
              return async (...args: Parameters<RuntimeWorkspaceStoragePort['reserveDerivedOpIdentity']>) => {
                if (armed && !blocked) {
                  blocked = true;
                  entered.resolve();
                  await release.promise;
                }
                return target.reserveDerivedOpIdentity(...args);
              };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    },
  };
}

function gateParentResultCommit(
  base: RuntimeStoragePort,
  parentThreadId: ThreadId,
): {
  readonly storage: RuntimeStoragePort;
  readonly entered: Deferred<void>;
  readonly release: Deferred<void>;
  arm(): void;
} {
  const entered = deferred<void>();
  const release = deferred<void>();
  let armed = false;
  let blocked = false;
  const wrapJournal = (journal: ThreadJournalPort): ThreadJournalPort => new Proxy(journal, {
    get(target, property, receiver) {
      if (property === 'append') {
        return async (...args: Parameters<ThreadJournalPort['append']>) => {
          const [records] = args;
          if (armed && !blocked && records.some((record) => record.type === 'commit'
            && record.envelopes.some((envelope) => envelope.event.type === 'thread_result'))) {
            blocked = true;
            entered.resolve();
            await release.promise;
          }
          return target.append(...args);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    entered,
    release,
    arm(): void { armed = true; },
    storage: {
      listStoredThreads: () => base.listStoredThreads(),
      async openWorkspace(input): Promise<RuntimeWorkspaceStoragePort> {
        const workspace = await base.openWorkspace(input);
        return new Proxy(workspace, {
          get(target, property, receiver) {
            if (property === 'createThreadJournal') {
              return async (...args: Parameters<RuntimeWorkspaceStoragePort['createThreadJournal']>) => {
                const journal = await target.createThreadJournal(...args);
                return args[1].threadId === parentThreadId ? wrapJournal(journal) : journal;
              };
            }
            if (property === 'openThreadJournal') {
              return async (...args: Parameters<RuntimeWorkspaceStoragePort['openThreadJournal']>) => {
                const journal = await target.openThreadJournal(...args);
                return journal !== undefined && args[0] === parentThreadId ? wrapJournal(journal) : journal;
              };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    },
  };
}

function gateThreadCloseAcceptance(
  base: RuntimeStoragePort,
  threadId: ThreadId,
): {
  readonly storage: RuntimeStoragePort;
  readonly entered: Deferred<void>;
  readonly release: Deferred<void>;
  arm(): void;
} {
  const entered = deferred<void>();
  const release = deferred<void>();
  let armed = false;
  let blocked = false;
  const wrapJournal = (journal: ThreadJournalPort): ThreadJournalPort => new Proxy(journal, {
    get(target, property, receiver) {
      if (property === 'append') {
        return async (...args: Parameters<ThreadJournalPort['append']>) => {
          const [records] = args;
          if (armed && !blocked && records.some((record) => record.type === 'commit'
            && record.envelopes.some((envelope) =>
              envelope.event.type === 'op_accepted'
              && envelope.event.opType === 'thread_close'))) {
            blocked = true;
            entered.resolve();
            await release.promise;
          }
          return target.append(...args);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    entered,
    release,
    arm(): void { armed = true; },
    storage: {
      listStoredThreads: () => base.listStoredThreads(),
      async openWorkspace(input): Promise<RuntimeWorkspaceStoragePort> {
        const workspace = await base.openWorkspace(input);
        return new Proxy(workspace, {
          get(target, property, receiver) {
            if (property === 'createThreadJournal') {
              return async (...args: Parameters<RuntimeWorkspaceStoragePort['createThreadJournal']>) => {
                const journal = await target.createThreadJournal(...args);
                return args[1].threadId === threadId ? wrapJournal(journal) : journal;
              };
            }
            if (property === 'openThreadJournal') {
              return async (...args: Parameters<RuntimeWorkspaceStoragePort['openThreadJournal']>) => {
                const journal = await target.openThreadJournal(...args);
                return journal !== undefined && args[0] === threadId ? wrapJournal(journal) : journal;
              };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    },
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  return {
    promise: new Promise<T>((resolve) => { resolvePromise = resolve; }),
    resolve(value: T): void {
      if (resolvePromise === undefined) throw new Error('Deferred is not initialized');
      resolvePromise(value);
    },
  };
}
