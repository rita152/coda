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
import {
  createCapabilityRegistry,
  createPolicyEngine,
  createPromptAssembler,
  createProviderAdapterRegistry,
} from '../capabilities/index.js';
import type {
  PolicyEngine,
  PolicyGrantRepository,
  RuntimeCapabilityServices,
} from '../capabilities/index.js';
import { EventHub } from '../session/event-hub.js';
import { createMemoryRuntimeStorage } from './memory-storage.js';
import type {
  PermissionPolicyPort,
  PreparedThreadDriverCommand,
  RecoveryQueueCommand,
  RuntimeIdentityFactory,
  RuntimeJournalRecord,
  RuntimeStoragePort,
  RuntimeWorkspaceStoragePort,
  RuntimeThreadDriverAttachment,
  RuntimeThreadDriverFactory,
  SupervisorOpLedgerRecord,
  ThreadDriverCheckpoint,
  ThreadDriverCompletion,
  ThreadDriverHostServices,
  ThreadDriverPort,
  ThreadJournalPort,
  ThreadMetaRecord,
  ThreadSeedRecord,
} from './ports.js';
import { createRuntime as createCanonicalRuntime } from './supervisor.js';
import type { CreateRuntimeOptions } from './supervisor.js';
import { emptyCheckpoint, ThreadJournalWriter } from '../session/thread-journal.js';

const WORKSPACE_ID = 'workspace-supervisor-recovery' as WorkspaceId;
const CWD = '/runtime/supervisor-recovery';
const MODEL: ModelConfig = { ref: { provider: 'faux', api: 'faux', model: 'recovery' } };
const CEILING = { revision: 'test-ceiling', constraints: [] } as const;

type TestCreateRuntimeOptions = Omit<CreateRuntimeOptions, 'capabilityServices'> & {
  readonly capabilityServices?: Readonly<RuntimeCapabilityServices>;
};

function createRuntime(
  options: TestCreateRuntimeOptions,
): ReturnType<typeof createCanonicalRuntime> {
  return createCanonicalRuntime({
    capabilityServices: registryCapabilityServices(createPolicyEngine()),
    ...options,
  });
}

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

  test('exposes a frozen workspace permission snapshot without creating a thread', async () => {
    const policy: PermissionPolicyPort = {
      async snapshotWorkspaceCeiling() {
        return CEILING;
      },
      async snapshotWorkspacePermissionStatus() {
        return { mode: 'deny', policyRevision: 'test-policy-deny-v1' };
      },
      async resolveCeiling() {
        return CEILING;
      },
    };
    const runtime = await createRuntime({
      workspace: { cwd: CWD, workspaceId: WORKSPACE_ID },
      storage: createMemoryRuntimeStorage(),
      modelResolver: { async resolve(ref) { return { ok: true as const, model: { ...MODEL, ref } }; } },
      permissionPolicy: policy,
      threadDriverFactory: new RecordingDriverFactory(),
      identityFactory: new TestIdentityFactory(),
    });
    try {
      const workspace = await runtime.getWorkspaceSnapshot();
      expect(workspace).toEqual({
        workspaceId: WORKSPACE_ID,
        permissions: {
          mode: 'deny',
          policyRevision: 'test-policy-deny-v1',
          ceiling: CEILING,
        },
      });
      expect(Object.isFrozen(workspace)).toBe(true);
      expect(Object.isFrozen(workspace.permissions.ceiling)).toBe(true);
      expect(await runtime.listThreads()).toEqual([]);
    } finally {
      await runtime.close();
    }
  });

  test('keeps older permission ports compatible with an authoritative custom snapshot', async () => {
    const runtime = await createRuntime({
      workspace: { cwd: CWD, workspaceId: WORKSPACE_ID },
      storage: createMemoryRuntimeStorage(),
      modelResolver: { async resolve(ref) { return { ok: true as const, model: { ...MODEL, ref } }; } },
      permissionPolicy: new FixedPolicy(),
      threadDriverFactory: new RecordingDriverFactory(),
      identityFactory: new TestIdentityFactory(),
    });
    try {
      expect(await runtime.getWorkspaceSnapshot()).toMatchObject({
        workspaceId: WORKSPACE_ID,
        permissions: {
          mode: 'custom',
          policyRevision: CEILING.revision,
          ceiling: CEILING,
        },
      });
      expect(await runtime.listThreads()).toEqual([]);
    } finally {
      await runtime.close();
    }
  });

  test.each([
    ['unknown mode', { mode: 'sometimes', policyRevision: 'revision' }],
    ['empty revision', { mode: 'allow', policyRevision: '' }],
    ['extra field', { mode: 'allow', policyRevision: 'revision', extra: true }],
  ] as const)('rejects an invalid workspace permission status: %s', async (_name, status) => {
    const policy: PermissionPolicyPort = {
      async snapshotWorkspaceCeiling() {
        return CEILING;
      },
      async snapshotWorkspacePermissionStatus() {
        return status as never;
      },
      async resolveCeiling() {
        return CEILING;
      },
    };
    const runtime = await createRuntime({
      workspace: { cwd: CWD, workspaceId: WORKSPACE_ID },
      storage: createMemoryRuntimeStorage(),
      modelResolver: { async resolve(ref) { return { ok: true as const, model: { ...MODEL, ref } }; } },
      permissionPolicy: policy,
      threadDriverFactory: new RecordingDriverFactory(),
      identityFactory: new TestIdentityFactory(),
    });
    try {
      await expect(runtime.getWorkspaceSnapshot()).rejects.toBeInstanceOf(Error);
      expect(await runtime.listThreads()).toEqual([]);
    } finally {
      await runtime.close();
    }
  });

  test.each([
    ['thread', '', 'invalid_thread_id'],
    ['op', '', 'invalid_identity_input'],
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

  test('forks committed context, retries through one stable nested prompt, and exposes Runtime review facts', async () => {
    const baseStorage = createMemoryRuntimeStorage();
    const retryOpId = 'op_e_70000000000000000000000000000001' as ExternalOpId;
    const storage = failSupervisorFinalizeOnce(baseStorage, retryOpId);
    const drivers = new RecordingDriverFactory();
    const runtime = await createRuntime({
      workspace: { cwd: CWD, workspaceId: WORKSPACE_ID },
      storage,
      modelResolver: {
        async resolve(ref) { return { ok: true as const, model: { ...MODEL, ref } }; },
      },
      permissionPolicy: new FixedPolicy(),
      threadDriverFactory: drivers,
      workspaceReview: {
        async snapshotGit() { return { branch: 'codex/ux3', dirty: true }; },
        async snapshotDiff() {
          return [{
            path: 'src/review.ts',
            group: 'unstaged' as const,
            status: 'M',
            patch: 'diff --git a/src/review.ts b/src/review.ts\n',
          }];
        },
      },
      identityFactory: new TestIdentityFactory(),
      clock: { now: () => 2 },
    });
    const sourceThreadId = runtime.newThreadId();
    const forkThreadId = runtime.newThreadId();
    const retryThreadId = runtime.newThreadId();
    try {
      expect(await runtime.submit(createThreadOp(runtime.newOpId(), sourceThreadId)))
        .toMatchObject({ accepted: true, threadId: sourceThreadId });
      const sourceSnapshot = await runtime.getThreadSnapshot(sourceThreadId);
      if (sourceSnapshot === undefined) throw new Error('source snapshot is missing');
      const iterator = runtime.events({
        threadIds: [sourceThreadId],
        cursors: [{ threadId: sourceThreadId, afterSeq: sourceSnapshot.highWaterSeq }],
      })[Symbol.asyncIterator]();
      const sourcePrompt = prompt(runtime.newOpId(), sourceThreadId, 'inspect the runtime');
      const promptReceipt = await runtime.submit(sourcePrompt);
      if (!promptReceipt.accepted || promptReceipt.runId === undefined) {
        throw new Error('source prompt was not accepted');
      }
      expect(await runtime.submit({
        type: 'conversation_fork',
        opId: runtime.newOpId(),
        workspaceId: WORKSPACE_ID,
        sourceThreadId,
        threadId: runtime.newThreadId(),
        model: MODEL.ref,
      })).toMatchObject({ accepted: false, reason: 'source_thread_busy' });
      await drivers.materializeTurn(
        sourceThreadId,
        promptReceipt.runId,
        sourcePrompt.text,
        'runtime inspected',
      );
      const completed = nextEvent(iterator, (envelope) =>
        envelope.opId === sourcePrompt.opId && envelope.event.type === 'op_completed');
      drivers.complete(sourceThreadId, promptReceipt.runId, 'completed');
      await completed;
      await iterator.return?.();

      const forkOp = {
        type: 'conversation_fork',
        opId: runtime.newOpId(),
        workspaceId: WORKSPACE_ID,
        sourceThreadId,
        threadId: forkThreadId,
        model: MODEL.ref,
        title: 'Review fork',
      } as const;
      expect(await runtime.submit(forkOp)).toMatchObject({
        accepted: true,
        threadId: forkThreadId,
      });
      expect((await runtime.getThreadSnapshot(forkThreadId))?.transcript.map((message) =>
        [message.role, message.content[0]])).toEqual([
        ['user', { type: 'text', text: 'inspect the runtime' }],
        ['assistant', { type: 'text', text: 'runtime inspected' }],
      ]);
      expect((await runtime.getThreadSnapshot(sourceThreadId))?.transcript).toHaveLength(2);

      expect(await runtime.submit({
        type: 'thread_rename',
        opId: runtime.newOpId(),
        workspaceId: WORKSPACE_ID,
        threadId: forkThreadId,
        title: 'Renamed review fork',
      })).toMatchObject({ accepted: true });
      expect(await runtime.submit({
        type: 'thread_archive',
        opId: runtime.newOpId(),
        workspaceId: WORKSPACE_ID,
        threadId: forkThreadId,
        archived: true,
      })).toMatchObject({ accepted: true });
      expect((await runtime.listThreadDetails()).find((item) =>
        item.thread.threadId === forkThreadId)).toMatchObject({
        cwd: CWD,
        preview: 'runtime inspected',
        thread: { title: 'Renamed review fork', archivedAt: 2 },
      });

      const retryOp = {
        type: 'conversation_retry',
        opId: retryOpId,
        workspaceId: WORKSPACE_ID,
        sourceThreadId,
        threadId: retryThreadId,
        model: MODEL.ref,
      } as const;
      await expect(runtime.submit(retryOp)).rejects.toThrow('injected finalize failure');
      const retryReceipt = await runtime.submit(retryOp);
      expect(retryReceipt).toMatchObject({
        accepted: true,
        duplicate: true,
        threadId: retryThreadId,
        runId: expect.any(String),
      });
      expect(drivers.dispatches(retryThreadId).filter((command) => command.op.type === 'prompt'))
        .toHaveLength(1);
      expect(drivers.dispatches(retryThreadId).at(-1)?.op).toMatchObject({
        type: 'prompt',
        text: 'inspect the runtime',
      });
      expect(drivers.dispatches(retryThreadId).filter((command) => command.op.type === 'prompt'))
        .toHaveLength(1);
      expect((await runtime.getThreadSnapshot(sourceThreadId))?.transcript).toHaveLength(2);

      expect(await runtime.getWorkspaceSnapshot()).toMatchObject({
        git: { branch: 'codex/ux3', dirty: true },
      });
      expect(await runtime.getDiffSnapshot(sourceThreadId, 'workspace')).toMatchObject({
        scope: 'workspace',
        files: [{ path: 'src/review.ts', group: 'unstaged', status: 'M' }],
      });
      await expect(runtime.getDiffSnapshot(sourceThreadId, 'invalid' as 'turn'))
        .rejects.toThrow('Runtime diff scope must be turn or workspace');
      expect(await runtime.getReviewSnapshot(sourceThreadId)).toMatchObject({
        threadId: sourceThreadId,
        highWaterSeq: expect.any(Number),
        reasoning: [],
        tools: [],
      });
    } finally {
      await runtime.close().catch(() => undefined);
    }
  });

  test('turn diff follows the active turn before turn_end instead of showing the prior turn', async () => {
    const drivers = new RecordingDriverFactory();
    const runtime = await openRuntime(createMemoryRuntimeStorage(), drivers);
    const threadId = runtime.newThreadId();
    let iterator: AsyncIterator<import('../protocol/index.js').EventEnvelope> | undefined;
    try {
      expect(await runtime.submit(createThreadOp(runtime.newOpId(), threadId)))
        .toMatchObject({ accepted: true });
      const created = await runtime.getThreadSnapshot(threadId);
      if (created === undefined) throw new Error('created snapshot is missing');
      iterator = runtime.events({
        threadIds: [threadId],
        cursors: [{ threadId, afterSeq: created.highWaterSeq }],
      })[Symbol.asyncIterator]();
      const first = await runtime.submit(prompt(runtime.newOpId(), threadId, 'first turn'));
      if (!first.accepted || first.runId === undefined) throw new Error('first prompt failed');
      await drivers.materializeTurn(threadId, first.runId, 'first turn', 'first answer');
      const firstCompleted = nextEvent(iterator, (envelope) =>
        envelope.opId === first.opId && envelope.event.type === 'op_completed');
      drivers.complete(threadId, first.runId, 'completed');
      await firstCompleted;

      const second = await runtime.submit(prompt(runtime.newOpId(), threadId, 'edit now'));
      if (!second.accepted || second.runId === undefined) throw new Error('second prompt failed');
      await drivers.materializeToolDiff(
        threadId,
        second.runId,
        'src/active.ts',
        'diff --git a/src/active.ts b/src/active.ts\n+active turn\n',
      );
      expect(await runtime.getDiffSnapshot(threadId, 'turn')).toMatchObject({
        scope: 'turn',
        files: [{
          path: 'src/active.ts',
          group: 'turn',
          status: 'modified',
          patch: expect.stringContaining('+active turn'),
        }],
      });
      expect(await runtime.getReviewSnapshot(threadId)).toMatchObject({
        tools: [{ output: 'editing src/active.ts\ncomplete' }],
      });
      drivers.complete(threadId, second.runId, 'completed');
    } finally {
      await iterator?.return?.();
      await runtime.close().catch(() => undefined);
    }
  });

  test('fork seed preserves message-turn provenance across restart and remains retryable', async () => {
    const storage = createMemoryRuntimeStorage();
    const firstDrivers = new RecordingDriverFactory();
    const first = await openRuntime(storage, firstDrivers);
    const sourceThreadId = 'thread-fork-retry-source' as ThreadId;
    const forkThreadId = 'thread-fork-retry-copy' as ThreadId;
    const retryThreadId = 'thread-fork-retry-target' as ThreadId;
    const promptText = 'retry the prompt copied into this fork';
    try {
      expect(await first.submit(createThreadOp(first.newOpId(), sourceThreadId)))
        .toMatchObject({ accepted: true });
      const created = await first.getThreadSnapshot(sourceThreadId);
      if (created === undefined) throw new Error('source snapshot is missing');
      const iterator = first.events({
        threadIds: [sourceThreadId],
        cursors: [{ threadId: sourceThreadId, afterSeq: created.highWaterSeq }],
      })[Symbol.asyncIterator]();
      const promptOp = prompt(first.newOpId(), sourceThreadId, promptText);
      const promptReceipt = await first.submit(promptOp);
      if (!promptReceipt.accepted || promptReceipt.runId === undefined) {
        throw new Error('source prompt failed');
      }
      await firstDrivers.materializeTurn(
        sourceThreadId,
        promptReceipt.runId,
        promptText,
        'copied answer',
      );
      const completed = nextEvent(iterator, (envelope) =>
        envelope.opId === promptOp.opId && envelope.event.type === 'op_completed');
      firstDrivers.complete(sourceThreadId, promptReceipt.runId, 'completed');
      await completed;
      await iterator.return?.();
      expect(await first.submit({
        type: 'conversation_fork',
        opId: first.newOpId(),
        workspaceId: WORKSPACE_ID,
        sourceThreadId,
        threadId: forkThreadId,
        model: MODEL.ref,
      })).toMatchObject({ accepted: true, threadId: forkThreadId });
    } finally {
      await first.close();
    }

    expect((await loadThreadState(storage, forkThreadId)).messageTurnIds.size).toBe(2);

    const secondDrivers = new RecordingDriverFactory();
    const second = await createRuntime({
      ...constructionRuntimeOptions(storage, secondDrivers),
      identityFactory: new TestIdentityFactory(100),
      clock: { now: () => 2 },
    });
    try {
      expect(await second.submit({
        type: 'conversation_retry',
        opId: 'op_e_72000000000000000000000000000001' as ExternalOpId,
        workspaceId: WORKSPACE_ID,
        sourceThreadId: forkThreadId,
        threadId: retryThreadId,
        model: MODEL.ref,
      })).toMatchObject({ accepted: true, threadId: retryThreadId, runId: expect.any(String) });
      expect(secondDrivers.dispatches(retryThreadId).at(-1)?.op).toMatchObject({
        type: 'prompt',
        text: promptText,
      });
    } finally {
      await second.close().catch(() => undefined);
    }
  });

  test('retry recovery uses the prompt frozen before target creation even after the source advances', async () => {
    const baseStorage = createMemoryRuntimeStorage();
    const firstDrivers = new RecordingDriverFactory();
    const runtime = await openRuntime(baseStorage, firstDrivers);
    const sourceThreadId = 'thread-retry-freeze-source' as ThreadId;
    const targetThreadId = 'thread-retry-freeze-target' as ThreadId;
    const originalText = 'retry this original prompt';
    const newerText = 'a newer source prompt must not replace the retry input';
    const retryOp: Extract<RuntimeOp, { type: 'conversation_retry' }> = {
      type: 'conversation_retry',
      opId: 'op_e_71000000000000000000000000000001' as ExternalOpId,
      workspaceId: WORKSPACE_ID,
      sourceThreadId,
      threadId: targetThreadId,
      model: MODEL.ref,
    };
    try {
      expect(await runtime.submit(createThreadOp(runtime.newOpId(), sourceThreadId)))
        .toMatchObject({ accepted: true });
      const created = await runtime.getThreadSnapshot(sourceThreadId);
      if (created === undefined) throw new Error('source snapshot is missing');
      const iterator = runtime.events({
        threadIds: [sourceThreadId],
        cursors: [{ threadId: sourceThreadId, afterSeq: created.highWaterSeq }],
      })[Symbol.asyncIterator]();
      const original = await runtime.submit(prompt(runtime.newOpId(), sourceThreadId, originalText));
      if (!original.accepted || original.runId === undefined) throw new Error('original prompt failed');
      await firstDrivers.materializeTurn(
        sourceThreadId,
        original.runId,
        originalText,
        'original answer',
      );
      const originalCompleted = nextEvent(iterator, (envelope) =>
        envelope.opId === original.opId && envelope.event.type === 'op_completed');
      firstDrivers.complete(sourceThreadId, original.runId, 'completed');
      await originalCompleted;

      const newer = await runtime.submit(prompt(runtime.newOpId(), sourceThreadId, newerText));
      if (!newer.accepted || newer.runId === undefined) throw new Error('newer prompt failed');
      await firstDrivers.materializeTurn(sourceThreadId, newer.runId, newerText, 'newer answer');
      const newerCompleted = nextEvent(iterator, (envelope) =>
        envelope.opId === newer.opId && envelope.event.type === 'op_completed');
      firstDrivers.complete(sourceThreadId, newer.runId, 'completed');
      await newerCompleted;
      await iterator.return?.();
    } finally {
      await runtime.close();
    }

    const sourceState = await loadThreadState(baseStorage, sourceThreadId);
    const originalEnvelope = sourceState.envelopes.find((envelope) =>
      envelope.event.type === 'message_end'
      && envelope.event.message.role === 'user'
      && envelope.event.message.content.some((part) =>
        part.type === 'text' && part.text === originalText));
    if (originalEnvelope?.event.type !== 'message_end'
      || originalEnvelope.event.message.role !== 'user'
      || originalEnvelope.turnId === undefined) {
      throw new Error('original retry prompt identity is missing');
    }
    const originalMessageId = originalEnvelope.event.message.id;
    const originalTurnId = originalEnvelope.turnId;
    await seedRetryTargetCreationCrash(baseStorage, retryOp, {
      messageId: originalMessageId,
      turnId: originalTurnId,
      text: originalText,
    });

    const recoveryDrivers = new RecordingDriverFactory();
    const recovered = await openRuntime(baseStorage, recoveryDrivers);
    try {
      expect(recoveryDrivers.dispatches(targetThreadId).filter((command) =>
        command.op.type === 'prompt').map((command) => command.op)).toEqual([
        expect.objectContaining({ type: 'prompt', text: originalText }),
      ]);
      expect(baseStorage.inspectWorkspace(WORKSPACE_ID)?.ops.find((record) =>
        record.opId === retryOp.opId)).toMatchObject({
        state: 'final',
        retryPrompt: {
          messageId: originalMessageId,
          turnId: originalTurnId,
          text: originalText,
          digest: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
        receipt: { accepted: true, threadId: targetThreadId },
      });
    } finally {
      await recovered.close().catch(() => undefined);
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

  test('cold startup reads only recovery-required state and resume adds only its selected target', async () => {
    const reads: Array<{ readonly threadId: ThreadId; readonly kind: string }> = [];
    const storage = createMemoryRuntimeStorage({
      onJournalRead: (observation) => reads.push(observation),
    });
    const cleanThreadId = 'thread-lazy-clean' as ThreadId;
    const targetThreadId = 'thread-lazy-target' as ThreadId;
    const recoveryThreadId = 'thread-lazy-recovery' as ThreadId;
    const workspace = await storage.openWorkspace({ cwd: CWD, workspaceId: WORKSPACE_ID });
    const lease = await workspace.acquireSupervisorLease('seed-lazy-clean');
    await workspace.createThreadJournal(lease, {
      threadId: cleanThreadId,
      meta: threadMeta(
        cleanThreadId,
        'op_e_b1000000000000000000000000000001' as ExternalOpId,
      ),
    });
    await workspace.createThreadJournal(lease, {
      threadId: targetThreadId,
      meta: threadMeta(
        targetThreadId,
        'op_e_b2000000000000000000000000000002' as ExternalOpId,
      ),
    });
    await workspace.releaseSupervisorLease(lease);
    await workspace.close();
    await seedPromptCrash(
      storage,
      recoveryThreadId,
      prompt(
        'op_e_b3000000000000000000000000000003' as ExternalOpId,
        recoveryThreadId,
        'recover me',
      ),
      'accepted_pending',
    );
    reads.length = 0;

    const runtime = await openRuntime(storage, new RecordingDriverFactory());
    try {
      expect(reads).toEqual([{ threadId: recoveryThreadId, kind: 'state' }]);
      expect(await runtime.listThreads()).toHaveLength(3);
      expect(reads).toEqual([{ threadId: recoveryThreadId, kind: 'state' }]);

      const receipt = await runtime.submit({
        type: 'thread_resume',
        opId: 'op_e_b4000000000000000000000000000004' as ExternalOpId,
        workspaceId: WORKSPACE_ID,
        threadId: targetThreadId,
        model: MODEL.ref,
      });
      expect(receipt).toMatchObject({ accepted: true, threadId: targetThreadId });
      expect(reads).toEqual([
        { threadId: recoveryThreadId, kind: 'state' },
        { threadId: targetThreadId, kind: 'state' },
      ]);
      expect(reads.some((read) => read.threadId === cleanThreadId)).toBe(false);
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

      const state = await loadThreadState(storage, threadId);
      expect(state.inputOwners.has(original.opId)).toBe(false);
      expect(state.mailbox.get(original.opId)).toMatchObject({
        state: 'completed',
        outcome: 'interrupted',
      });
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

    const parentState = await loadThreadState(storage, parentThreadId);
    const childState = await loadThreadState(storage, childThreadId);
    const parentResults = [...parentState.threadResults.values()];
    const childPending = [...childState.pendingThreadResults.values()];
    expect(parentResults).toHaveLength(1);
    expect(childPending).toHaveLength(1);
    const pending = childPending[0];
    if (pending === undefined) throw new Error('child result outbox is missing');
    expect(childState.deliveredThreadResults).toEqual(new Set([pending.resultOpId]));
    expect(parentResults[0]).toMatchObject({
      event: {
        type: 'thread_result',
        resultOpId: pending.resultOpId,
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
    const parentState = await loadThreadState(storage, parentThreadId);
    const childState = await loadThreadState(storage, childThreadId);
    const parentResults = [...parentState.threadResults.values()];
    expect(parentResults).toHaveLength(1);
    expect(parentResults[0]).toMatchObject({
      seq: seeded.parentCommitSeq,
      event: { resultOpId: seeded.resultOpId },
    });
    expect(childState.deliveredThreadResults).toEqual(new Set([seeded.resultOpId]));
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
      const childBeforeResume = await loadThreadState(storage, childThreadId);
      expect(childBeforeResume.runs.get(seeded.childRunId)).toMatchObject({
        state: 'terminal',
        status: 'interrupted',
      });
      expect([...childBeforeResume.pendingThreadResults.values()]).toContainEqual(
        expect.objectContaining({
          type: 'thread_result_pending',
          parentThreadId,
          childThreadId,
          terminalRunId: seeded.childRunId,
          status: 'error',
        }),
      );
      expect((await loadThreadState(storage, parentThreadId)).threadResults.size).toBe(0);

      expect((await first.submit({
        type: 'thread_resume',
        opId: 'op_e_22000000000000000000000000000001' as ExternalOpId,
        workspaceId: WORKSPACE_ID,
        threadId: parentThreadId,
        model: MODEL.ref,
      })).accepted).toBe(true);
      const parentResults = [...(await loadThreadState(storage, parentThreadId)).threadResults.values()];
      expect(parentResults).toEqual([expect.objectContaining({
        event: expect.objectContaining({
          type: 'thread_result',
          childThreadId,
          terminalRunId: seeded.childRunId,
          status: 'error',
        }),
      })]);
      expect((await loadThreadState(storage, childThreadId)).deliveredThreadResults.size).toBe(1);
    } finally {
      await first.close();
    }

    const second = await openRuntime(storage, new RecordingDriverFactory());
    try {
      const parentResults = [...(await loadThreadState(storage, parentThreadId)).threadResults.values()];
      expect(parentResults).toHaveLength(1);
      expect((await loadThreadState(storage, childThreadId)).deliveredThreadResults.size).toBe(1);
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

        const state = await loadThreadState(storage, threadId);
        expect(state.mailbox.get(staleOp.opId)).toMatchObject({
          state: 'completed',
          outcome: 'superseded',
        });
        expect(state.checkpoint.frontend.model).toEqual(RESUME_MODEL.ref);
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
      const state = await loadThreadState(storage, threadId);
      expect(state.mailbox.get(staleOp.opId)).toMatchObject({ state: 'completed', outcome: 'applied' });
      expect(state.opTerminals.get(staleOp.opId)?.event).toMatchObject({
        type: 'op_completed',
        outcome: 'applied',
      });
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
        const folded = await loadThreadState(storage, threadId);
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
      const folded = await loadThreadState(storage, threadId);
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

  test('recovers a partial assistant/tool crash in one authoritative interruption commit', async () => {
    const storage = createMemoryRuntimeStorage();
    const threadId = 'thread-partial-tool-crash' as ThreadId;
    const seeded = await seedPartialToolCrash(storage, threadId);
    const drivers = new RecordingDriverFactory();
    const journalFixture = recordJournalAppends(storage);
    const runtime = await openRuntime(journalFixture.storage, drivers);
    try {
      const records = journalFixture.records(threadId);
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
      const folded = await loadThreadState(storage, threadId);
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

      const derivedAbort = (await loadThreadState(baseStorage, threadId)).envelopes.filter((envelope) =>
        envelope.event.type === 'op_completed' && envelope.event.opType === 'abort');
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
    await expect(runtime.getWorkspaceSnapshot()).rejects.toMatchObject({ code: 'runtime_closed' });
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
    const folded = await loadThreadState(baseStorage, threadId);
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

    const folded = await loadThreadState(storage, threadId);
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

  test('actively recovers a reserved create before admitting competitors', async () => {
    const storage = createMemoryRuntimeStorage();
    const threadId = 'thread-reserved-create-claim' as ThreadId;
    const original = createThreadOp(
      'op_e_a0000000000000000000000000000001' as ExternalOpId,
      threadId,
    );
    await seedReservedCreate(storage, original);
    const drivers = new RecordingDriverFactory();
    const runtime = await openRuntime(storage, drivers);
    try {
      expect(drivers.createCalls).toBe(1);
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
    await seedFinalCreateIntent(storage, createThreadOp(createOpId, threadId));
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
    await seedFinalCreateIntent(storage, createThreadOp(createOpId, threadId));
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
      const before = await loadThreadState(storage, threadId);
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
      const reopenedState = await loadThreadState(storage, threadId);
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
        const folded = await loadThreadState(storage, threadId);
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
    const folded = await loadThreadState(storage, threadId);
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

describe('Supervisor registry composition', () => {
  test('opens grants after the lease and owns one policy engine per thread', async () => {
    const actions: string[] = [];
    const storageProbe = observeRegistryStorage(createMemoryRuntimeStorage(), actions);
    const policyEngine = new RecordingRegistryPolicyEngine(actions);
    const drivers = new ConstructionDriverFactory();
    const runtime = await createRuntime({
      ...constructionRuntimeOptions(storageProbe.storage, drivers),
      capabilityServices: registryCapabilityServices(policyEngine),
    });
    expect(actions.slice(0, 4)).toEqual([
      'workspace:open',
      'lease:acquire',
      'lease:acquired',
      'grants:open',
    ]);
    expect(storageProbe.grantOpens).toBe(1);

    const threadIds = [
      'thread-registry-composition-a' as ThreadId,
      'thread-registry-composition-b' as ThreadId,
    ];
    try {
      for (const [index, threadId] of threadIds.entries()) {
        const receipt = await runtime.submit(createThreadOp(
          `op_e_d000000000000000000000000000000${index + 1}` as ExternalOpId,
          threadId,
        ));
        expect(receipt.accepted).toBe(true);
      }
      expect(policyEngine.opened).toEqual(threadIds);
      expect(drivers.attachments).toHaveLength(2);
    } finally {
      await runtime.close();
    }

    expect(policyEngine.closeCounts).toEqual(new Map(threadIds.map((threadId) => [threadId, 1])));
    expect(drivers.closeCounts).toEqual(new Map(threadIds.map((threadId) => [threadId, 1])));
    expect(storageProbe.grantCloses).toBe(1);
  });

  test('requires fenced policy grant storage and releases the acquired lease on failure', async () => {
    const actions: string[] = [];
    const storageProbe = observeRegistryStorage(createMemoryRuntimeStorage(), actions, {
      exposePolicyGrantRepository: false,
    });
    const policyEngine = new RecordingRegistryPolicyEngine(actions);
    const drivers = new ConstructionDriverFactory();
    await expect(createRuntime({
      ...constructionRuntimeOptions(storageProbe.storage, drivers),
      capabilityServices: registryCapabilityServices(policyEngine),
    })).rejects.toMatchObject({ code: 'policy_grant_storage_unavailable' });
    expect(actions).toEqual([
      'workspace:open',
      'lease:acquire',
      'lease:acquired',
      'lease:release',
      'workspace:close',
    ]);
    expect(drivers.createCalls).toBe(0);
    expect(policyEngine.opened).toEqual([]);
  });

  test.each([
    'own',
    'inherited',
    'non_enumerable',
  ] as const)('rejects a retired %s policy grant repository mode and releases storage', async (
    retiredGrantMode,
  ) => {
    const actions: string[] = [];
    const storageProbe = observeRegistryStorage(createMemoryRuntimeStorage(), actions, {
      retiredGrantMode,
    });
    const policyEngine = new RecordingRegistryPolicyEngine(actions);
    const drivers = new ConstructionDriverFactory();

    await expect(createRuntime({
      ...constructionRuntimeOptions(storageProbe.storage, drivers),
      capabilityServices: registryCapabilityServices(policyEngine),
    })).rejects.toMatchObject({
      code: 'policy_grant_storage_mismatch',
      message: 'Policy grant repository mode selector has been removed',
    });
    expect(actions).toEqual([
      'workspace:open',
      'lease:acquire',
      'lease:acquired',
      'grants:open',
      'grants:close',
      'lease:release',
      'workspace:close',
    ]);
    expect(storageProbe.grantOpens).toBe(1);
    expect(storageProbe.grantCloses).toBe(1);
    expect(drivers.createCalls).toBe(0);
    expect(policyEngine.opened).toEqual([]);
  });

  test('cleans earlier registry attachments when a later policy engine fails during Supervisor.open', async () => {
    const storage = createMemoryRuntimeStorage();
    const firstThreadId = 'thread-registry-open-cleanup-first' as ThreadId;
    const secondThreadId = 'thread-registry-open-cleanup-second' as ThreadId;
    await seedFinalCreateIntent(
      storage,
      createThreadOp('op_e_d1000000000000000000000000000001' as ExternalOpId, firstThreadId),
    );
    await seedFinalCreateIntent(
      storage,
      createThreadOp('op_e_d1000000000000000000000000000002' as ExternalOpId, secondThreadId),
    );
    const actions: string[] = [];
    const storageProbe = observeRegistryStorage(storage, actions);
    const policyEngine = new RecordingRegistryPolicyEngine(actions, {
      failOpenThreadId: secondThreadId,
    });
    const drivers = new ConstructionDriverFactory({
      failCloseThreadIds: new Set([firstThreadId]),
    });

    const failure = await createRuntime({
      ...constructionRuntimeOptions(storageProbe.storage, drivers),
      capabilityServices: registryCapabilityServices(policyEngine),
    }).then(
      async (runtime) => {
        await runtime.close();
        return new Error('Supervisor.open unexpectedly succeeded');
      },
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw new Error('expected aggregate open failure');
    expect(failure.errors[0]).toMatchObject({
      message: `injected policy open failure: ${secondThreadId}`,
    });
    expect(policyEngine.opened).toEqual([firstThreadId]);
    expect(policyEngine.closeCounts).toEqual(new Map([[firstThreadId, 1]]));
    expect(drivers.closeCounts).toEqual(new Map([
      [secondThreadId, 1],
      [firstThreadId, 1],
    ]));
    expect(storageProbe.grantCloses).toBe(1);
    expect(actions.filter((action) => action === 'lease:release')).toHaveLength(1);
    expect(actions.filter((action) => action === 'workspace:close')).toHaveLength(1);
    await assertWorkspaceAndJournalsReusable(storage, [firstThreadId, secondThreadId]);
  });

  test('fails closed for retired selectors and malformed canonical capability bundles', async () => {
    const completeServices = registryCapabilityServices(new RecordingRegistryPolicyEngine([]));
    const { ruleFreshness: _missingRuleFreshness, ...partialServices } = completeServices;
    void _missingRuleFreshness;
    const inheritedServices = Object.create(completeServices) as RuntimeCapabilityServices;
    const inheritedGrantModeServices = Object.assign(Object.create({
      grantMode: 'workspace',
    }) as object, completeServices) as RuntimeCapabilityServices;
    const nonEnumerableGrantModeServices = Object.defineProperty({
      ...completeServices,
    }, 'grantMode', { value: 'workspace' }) as RuntimeCapabilityServices;
    const invalidRuleBudget = { ...completeServices.ruleBudget } as Record<PropertyKey, unknown>;
    Object.defineProperty(invalidRuleBudget, Symbol('unknown-budget-field'), {
      value: 1,
      enumerable: true,
    });
    const scenarios: readonly {
      readonly name: string;
      readonly expected: string;
      readonly build: (storage: RuntimeStoragePort) => unknown;
    }[] = [
      {
        name: 'non-enumerable runtime capabilityMode selector',
        expected: 'Runtime capabilityMode selector has been removed',
        build: (storage) => Object.defineProperty({
          ...constructionRuntimeOptions(storage, new ConstructionDriverFactory()),
          capabilityServices: completeServices,
        }, 'capabilityMode', { value: 'static' }),
      },
      {
        name: 'inherited driver requirements selector',
        expected: 'Runtime ThreadDriverFactory requirements selector has been removed',
        build: (storage) => {
          const delegate = new ConstructionDriverFactory();
          const threadDriverFactory = Object.assign(Object.create({
            requirements: { capabilityMode: 'registry' },
          }) as object, {
            create: delegate.create.bind(delegate),
            resume: delegate.resume.bind(delegate),
          });
          return {
            ...constructionRuntimeOptions(storage, threadDriverFactory),
            capabilityServices: completeServices,
          };
        },
      },
      {
        name: 'partial registry bundle',
        expected: 'Registry capabilityServices has missing or unknown fields',
        build: (storage) => ({
          ...constructionRuntimeOptions(storage, new ConstructionDriverFactory()),
          capabilityServices: partialServices,
        }),
      },
      {
        name: 'inherited capabilityServices grantMode selector',
        expected: 'Runtime capabilityServices grantMode selector has been removed',
        build: (storage) => ({
          ...constructionRuntimeOptions(storage, new ConstructionDriverFactory()),
          capabilityServices: inheritedGrantModeServices,
        }),
      },
      {
        name: 'non-enumerable capabilityServices grantMode selector',
        expected: 'Runtime capabilityServices grantMode selector has been removed',
        build: (storage) => ({
          ...constructionRuntimeOptions(storage, new ConstructionDriverFactory()),
          capabilityServices: nonEnumerableGrantModeServices,
        }),
      },
      {
        name: 'prototype-inherited registry bundle',
        expected: 'Registry capabilityServices has missing or unknown fields',
        build: (storage) => ({
          ...constructionRuntimeOptions(storage, new ConstructionDriverFactory()),
          capabilityServices: inheritedServices,
        }),
      },
      {
        name: 'registry bundle with a symbol rule budget field',
        expected: 'Registry ruleBudget is invalid',
        build: (storage) => ({
          ...constructionRuntimeOptions(storage, new ConstructionDriverFactory()),
          capabilityServices: {
            ...completeServices,
            ruleBudget: invalidRuleBudget,
          },
        }),
      },
    ];

    for (const scenario of scenarios) {
      let workspaceOpens = 0;
      const storage: RuntimeStoragePort = {
        async listStoredThreads() { return []; },
        async openWorkspace() {
          workspaceOpens++;
          throw new Error('invalid composition must fail before storage opens');
        },
      };
      await expect(createCanonicalRuntime(
        scenario.build(storage) as Parameters<typeof createCanonicalRuntime>[0],
      )).rejects.toThrow(scenario.expected);
      expect({ name: scenario.name, workspaceOpens }).toEqual({
        name: scenario.name,
        workspaceOpens: 0,
      });
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
  const state = await journal.loadState();
  const events = new EventHub();
  events.registerThread(threadId);
  const writer = new ThreadJournalWriter({
    workspaceId: WORKSPACE_ID,
    threadId,
    journal,
    events,
    clock: { now: () => 1 },
    state,
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
  const state = await journal.loadState();
  const events = new EventHub();
  events.registerThread(threadId);
  const writer = new ThreadJournalWriter({
    workspaceId: WORKSPACE_ID,
    threadId,
    journal,
    events,
    clock: { now: () => 1 },
    state,
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
): Promise<{
  readonly requestId: string;
  readonly responseOpId: ExternalOpId;
}> {
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
  const state = await journal.loadState();
  const events = new EventHub();
  events.registerThread(threadId);
  const writer = new ThreadJournalWriter({
    workspaceId: WORKSPACE_ID,
    threadId,
    journal,
    events,
    clock: { now: () => 1 },
    state,
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
        presentation: approvalPresentation({
          requestId,
          threadId,
          runId,
          turnId,
          toolCallId: 'call-control-recovery',
          policyRevision: 'policy-control-recovery',
          description: 'recover me',
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
    decision: 'allow_once' as const,
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
  const state = await childJournal.loadState();
  const events = new EventHub();
  events.registerThread(childThreadId);
  const writer = new ThreadJournalWriter({
    workspaceId: WORKSPACE_ID,
    threadId: childThreadId,
    journal: childJournal,
    events,
    clock: { now: () => 1 },
    state,
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
  const state = await journal.loadState();
  const request = state.checkpoint.frontend.pendingControls.find((candidate) =>
    candidate.requestId === seeded.requestId);
  if (request === undefined) throw new Error('missing pending control request');
  if (request.kind !== 'approval') throw new Error('expected an approval request');
  const events = new EventHub();
  events.registerThread(threadId);
  events.seed(threadId, state.envelopes);
  const writer = new ThreadJournalWriter({
    workspaceId: WORKSPACE_ID,
    threadId,
    journal,
    events,
    clock: { now: () => 1 },
    state,
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
  const state = await journal.loadState();
  const events = new EventHub();
  events.registerThread(threadId);
  const writer = new ThreadJournalWriter({
    workspaceId: WORKSPACE_ID,
    threadId,
    journal,
    events,
    clock: { now: () => 1 },
    state,
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
        presentation: approvalPresentation({
          requestId,
          threadId,
          runId,
          turnId,
          toolCallId,
          policyRevision: 'policy-partial-crash',
          description: 'pending approval at crash',
        }),
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
  const state = await journal.loadState();
  const events = new EventHub();
  events.registerThread(threadId);
  events.seed(threadId, state.envelopes);
  const writer = new ThreadJournalWriter({
    workspaceId: WORKSPACE_ID,
    threadId,
    journal,
    events,
    clock: { now: () => 1 },
    state,
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
): Promise<void> {
  const workspace = await storage.openWorkspace({ cwd: CWD, workspaceId: WORKSPACE_ID });
  const lease = await workspace.acquireSupervisorLease('seed-reserved-create');
  await workspace.reserveSupervisorOp(lease, {
    opId: op.opId,
    op,
    payloadHash: runtimeOpPayloadHash(op),
    state: 'reserved',
  });
  await workspace.releaseSupervisorLease(lease);
  await workspace.close();
}

async function seedFinalCreateIntent(
  storage: RuntimeStoragePort,
  op: Extract<RuntimeOp, { type: 'thread_create' }>,
): Promise<void> {
  const workspace = await storage.openWorkspace({ cwd: CWD, workspaceId: WORKSPACE_ID });
  const lease = await workspace.acquireSupervisorLease('seed-final-create');
  const ledger: SupervisorOpLedgerRecord = {
    opId: op.opId,
    op,
    payloadHash: runtimeOpPayloadHash(op),
    state: 'reserved',
  };
  await workspace.reserveSupervisorOp(lease, ledger);
  const journal = await workspace.createThreadJournal(lease, {
    threadId: op.threadId,
    meta: threadMeta(op.threadId, op.opId),
  });
  await journal.acquireWriteLease(lease);
  const state = await journal.loadState();
  const events = new EventHub();
  events.registerThread(op.threadId);
  const writer = new ThreadJournalWriter({
    workspaceId: WORKSPACE_ID,
    threadId: op.threadId,
    journal,
    events,
    clock: { now: () => 1 },
    state,
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
  const state = await journal.loadState();
  const events = new EventHub();
  events.registerThread(threadId);
  events.seed(threadId, state.envelopes);
  const writer = new ThreadJournalWriter({
    workspaceId: WORKSPACE_ID,
    threadId,
    journal,
    events,
    clock: { now: () => 1 },
    state,
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
  await seedFinalCreateIntent(storage, createOp);
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
  const state = await journal.loadState();
  const events = new EventHub();
  events.registerThread(resume.threadId);
  events.seed(resume.threadId, state.envelopes);
  const writer = new ThreadJournalWriter({
    workspaceId: WORKSPACE_ID,
    threadId: resume.threadId,
    journal,
    events,
    clock: { now: () => 1 },
    state,
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
  const state = await journal.loadState();
  const events = new EventHub();
  events.registerThread(left);
  events.seed(left, state.envelopes);
  const writer = new ThreadJournalWriter({
    workspaceId: WORKSPACE_ID,
    threadId: left,
    journal,
    events,
    clock: { now: () => 1 },
    state,
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

async function seedRetryTargetCreationCrash(
  storage: RuntimeStoragePort,
  op: Extract<RuntimeOp, { type: 'conversation_retry' }>,
  retryPrompt: {
    readonly messageId: string;
    readonly turnId: import('../protocol/index.js').TurnId;
    readonly text: string;
  },
): Promise<void> {
  const workspace = await storage.openWorkspace({ cwd: CWD, workspaceId: WORKSPACE_ID });
  const lease = await workspace.acquireSupervisorLease('seed-retry-target-created');
  const retryPromptOpId = 'op_e_71000000000000000000000000000002' as ExternalOpId;
  const ledger: SupervisorOpLedgerRecord = {
    opId: op.opId,
    op,
    payloadHash: runtimeOpPayloadHash(op),
    retryPromptOpId,
    retryPrompt: {
      ...retryPrompt,
      digest: new Bun.CryptoHasher('sha256').update(retryPrompt.text).digest('hex'),
    },
    state: 'reserved',
  };
  await workspace.reserveSupervisorOp(lease, ledger);
  const seed: ThreadSeedRecord = {
    type: 'thread_seed',
    transcript: [],
    turnProvenance: [],
    usage: { cumulative: { input: 0, output: 0 }, turns: 0, contextTokens: 0 },
  };
  const journal = await workspace.createThreadJournal(lease, {
    threadId: op.threadId,
    meta: threadMeta(op.threadId, op.opId),
    initialRecords: [seed],
  });
  await journal.acquireWriteLease(lease);
  const state = await journal.loadState();
  const events = new EventHub();
  events.registerThread(op.threadId);
  const writer = new ThreadJournalWriter({
    workspaceId: WORKSPACE_ID,
    threadId: op.threadId,
    journal,
    events,
    clock: { now: () => 1 },
    state,
  });
  const summary = {
    threadId: op.threadId,
    createdAt: 1,
    updatedAt: 1,
    state: 'idle' as const,
  };
  await writer.commit([
    { event: { type: 'op_accepted', opType: 'conversation_retry' }, opId: op.opId },
    { event: { type: 'thread_created', thread: summary }, opId: op.opId },
    {
      event: { type: 'op_completed', opType: 'conversation_retry', outcome: 'applied' },
      opId: op.opId,
    },
  ], [{ type: 'model_selected', ownerOpId: op.opId, model: op.model }]);
  await writer.close();
  await workspace.releaseSupervisorLease(lease);
  await workspace.close();
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
  const events = new EventHub();
  events.registerThread(parentThreadId);
  events.registerThread(childThreadId);
  const parentState = await parentJournal.loadState();
  const childState = await childJournal.loadState();
  const parentWriter = new ThreadJournalWriter({
    workspaceId: WORKSPACE_ID,
    threadId: parentThreadId,
    journal: parentJournal,
    events,
    clock: { now: () => 1 },
    state: parentState,
  });
  const childWriter = new ThreadJournalWriter({
    workspaceId: WORKSPACE_ID,
    threadId: childThreadId,
    journal: childJournal,
    events,
    clock: { now: () => 1 },
    state: childState,
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
  drivers: RuntimeThreadDriverFactory,
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

function constructionRuntimeOptions(
  storage: RuntimeStoragePort,
  drivers: RuntimeThreadDriverFactory,
) {
  return {
    workspace: { cwd: CWD, workspaceId: WORKSPACE_ID },
    storage,
    modelResolver: {
      async resolve(ref: ModelRef): Promise<{ readonly ok: true; readonly model: ModelConfig }> {
        return { ok: true, model: { ...MODEL, ref } };
      },
    },
    permissionPolicy: new FixedPolicy(),
    threadDriverFactory: drivers,
    identityFactory: new TestIdentityFactory(),
    clock: { now: () => 3 },
  };
}

async function assertWorkspaceAndJournalsReusable(
  storage: RuntimeStoragePort,
  threadIds: readonly ThreadId[],
): Promise<void> {
  const workspace = await storage.openWorkspace({ cwd: CWD, workspaceId: WORKSPACE_ID });
  const lease = await workspace.acquireSupervisorLease('post-construction-cleanup-probe');
  try {
    for (const threadId of threadIds) {
      const journal = await workspace.openThreadJournal(threadId);
      if (journal === undefined) throw new Error(`missing cleanup probe journal: ${threadId}`);
      await journal.acquireWriteLease(lease);
      await journal.releaseWriteLease();
    }
  } finally {
    await workspace.releaseSupervisorLease(lease);
    await workspace.close();
  }
}

function registryCapabilityServices(policyEngine: PolicyEngine): RuntimeCapabilityServices {
  return {
    capabilities: createCapabilityRegistry(),
    providers: createProviderAdapterRegistry(),
    promptAssembler: createPromptAssembler(),
    basePrompts: {
      async capture(input) {
        return {
          owner: input.context,
          model: input.model.ref,
          revision: 'registry-composition-base-v1',
          content: 'registry composition test',
        };
      },
    },
    ruleSnapshots: {
      async capture(input) {
        return {
          ok: true,
          snapshot: {
            revision: 'registry-composition-rules-v1',
            owner: input.context,
            discovery: {
              knownResourceScopes: [...input.knownResourceScopes],
              budget: input.budget,
              diagnostics: [],
            },
            files: [],
          },
        };
      },
    },
    ruleBudget: {
      maxFiles: 4,
      maxFileBytes: 1_024,
      maxBytes: 4_096,
      maxPromptTokens: 1_024,
    },
    policyEngine,
    ruleFreshness: {
      async check() { return { fresh: true }; },
    },
  };
}

function observeRegistryStorage(
  base: RuntimeStoragePort,
  actions: string[],
  options: {
    readonly exposePolicyGrantRepository?: boolean;
    readonly retiredGrantMode?: 'own' | 'inherited' | 'non_enumerable';
  } = {},
): {
  readonly storage: RuntimeStoragePort;
  readonly grantOpens: number;
  readonly grantCloses: number;
} {
  let grantOpens = 0;
  let grantCloses = 0;
  return {
    get grantOpens() { return grantOpens; },
    get grantCloses() { return grantCloses; },
    storage: {
      listStoredThreads: () => base.listStoredThreads(),
      async openWorkspace(input): Promise<RuntimeWorkspaceStoragePort> {
        actions.push('workspace:open');
        const workspace = await base.openWorkspace(input);
        return new Proxy(workspace, {
          get(target, property, receiver) {
            if (property === 'acquireSupervisorLease') {
              return async (
                ...args: Parameters<RuntimeWorkspaceStoragePort['acquireSupervisorLease']>
              ) => {
                actions.push('lease:acquire');
                const lease = await target.acquireSupervisorLease(...args);
                actions.push('lease:acquired');
                return lease;
              };
            }
            if (property === 'releaseSupervisorLease') {
              return async (
                ...args: Parameters<RuntimeWorkspaceStoragePort['releaseSupervisorLease']>
              ) => {
                actions.push('lease:release');
                return target.releaseSupervisorLease(...args);
              };
            }
            if (property === 'openPolicyGrantRepository') {
              if (options.exposePolicyGrantRepository === false) return undefined;
              return async (
                ...args: Parameters<NonNullable<
                  RuntimeWorkspaceStoragePort['openPolicyGrantRepository']
                >>
              ): Promise<PolicyGrantRepository> => {
                actions.push('grants:open');
                const open = target.openPolicyGrantRepository;
                if (open === undefined) throw new Error('Policy grant repository is unavailable');
                const repository = await open.call(target, ...args);
                grantOpens++;
                let repositorySurface: object = repository;
                if (options.retiredGrantMode === 'inherited') {
                  repositorySurface = Object.create({ mode: 'thread' }) as object;
                } else if (options.retiredGrantMode !== undefined) {
                  repositorySurface = Object.defineProperty({}, 'mode', {
                    value: 'thread',
                    enumerable: options.retiredGrantMode === 'own',
                    configurable: true,
                  });
                }
                return new Proxy(repositorySurface as PolicyGrantRepository, {
                  get(_repositoryTarget, repositoryProperty, repositoryReceiver) {
                    if (repositoryProperty === 'mode') {
                      return Reflect.get(repositorySurface, repositoryProperty, repositoryReceiver) as unknown;
                    }
                    if (repositoryProperty === 'close') {
                      return async () => {
                        grantCloses++;
                        actions.push('grants:close');
                        return repository.close();
                      };
                    }
                    const value = Reflect.get(
                      repository,
                      repositoryProperty,
                      repository,
                    ) as unknown;
                    return typeof value === 'function' ? value.bind(repository) : value;
                  },
                });
              };
            }
            if (property === 'close') {
              return async () => {
                actions.push('workspace:close');
                return target.close();
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

class RecordingRegistryPolicyEngine implements PolicyEngine {
  readonly opened: ThreadId[] = [];
  readonly closeCounts = new Map<ThreadId, number>();
  readonly #delegate = createPolicyEngine();

  constructor(
    private readonly actions: string[],
    private readonly options: { readonly failOpenThreadId?: ThreadId } = {},
  ) {}

  async openThread(
    input: Parameters<PolicyEngine['openThread']>[0],
  ): ReturnType<PolicyEngine['openThread']> {
    this.actions.push(`policy:open:${input.threadId}`);
    if (input.threadId === this.options.failOpenThreadId) {
      throw new Error(`injected policy open failure: ${input.threadId}`);
    }
    this.opened.push(input.threadId);
    const delegate = await this.#delegate.openThread(input);
    return {
      capture: (captureInput) => delegate.capture(captureInput),
      evaluate: (invocation) => delegate.evaluate(invocation),
      close: async () => {
        this.closeCounts.set(input.threadId, (this.closeCounts.get(input.threadId) ?? 0) + 1);
        this.actions.push(`policy:close:${input.threadId}`);
        await delegate.close();
      },
    };
  }
}

class ConstructionDriverFactory implements RuntimeThreadDriverFactory {
  readonly attachments: RuntimeThreadDriverAttachment[] = [];
  readonly closeCounts = new Map<ThreadId, number>();
  createCalls = 0;

  constructor(
    private readonly options: {
      readonly failCloseThreadIds?: ReadonlySet<ThreadId>;
    } = {},
  ) {}

  async create(
    input: Parameters<RuntimeThreadDriverFactory['create']>[0],
  ): Promise<RuntimeThreadDriverAttachment> {
    this.createCalls++;
    return this.#attachment(
      input.threadId,
      input.initialCheckpoint ?? emptyCheckpoint(input.model.ref),
    );
  }

  async resume(
    input: Parameters<RuntimeThreadDriverFactory['resume']>[0],
  ): Promise<RuntimeThreadDriverAttachment> {
    return this.#attachment(input.threadId, input.committedCheckpoint);
  }

  #attachment(
    threadId: ThreadId,
    checkpoint: ThreadDriverCheckpoint,
  ): RuntimeThreadDriverAttachment {
    const attachment: RuntimeThreadDriverAttachment = {
      driver: new CloseOnlyDriver(() => {
        this.closeCounts.set(threadId, (this.closeCounts.get(threadId) ?? 0) + 1);
        if (this.options.failCloseThreadIds?.has(threadId) === true) {
          throw new Error(`injected attachment close failure: ${threadId}`);
        }
      }),
      initialCheckpoint: checkpoint,
    };
    this.attachments.push(attachment);
    return attachment;
  }
}

function threadMeta(threadId: ThreadId, createdByOpId: ExternalOpId): ThreadMetaRecord {
  return {
    type: 'thread_meta',
    version: 3,
    protocolVersion: PROTOCOL_VERSION,
    workspaceId: WORKSPACE_ID,
    threadId,
    createdByOpId,
    permissionCeiling: CEILING,
    createdAt: 1,
    cwd: CWD,
    model: MODEL.ref,
  };
}

function approvalPresentation(input: {
  readonly requestId: string;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly turnId: import('../protocol/index.js').TurnId;
  readonly toolCallId: string;
  readonly policyRevision: string;
  readonly description: string;
}) {
  return {
    requestId: input.requestId,
    target: {
      workspaceId: WORKSPACE_ID,
      threadId: input.threadId,
      runId: input.runId,
      turnId: input.turnId,
    },
    capability: {
      id: 'filesystem.edit',
      version: '1.0.0',
      registrationDigest: `capreg_v1_${'1'.repeat(64)}`,
    },
    normalizedResources: [{
      selectorId: 'target',
      resourceType: 'filesystem',
      access: 'write',
      canonicalTarget: '/workspace/file.txt',
    }],
    risk: {
      code: 'write_requires_approval',
      reason: 'write',
      description: input.description,
    },
    allowOnce: {
      invocationId: `invocation-${input.requestId}`,
      toolCallId: input.toolCallId,
    },
    revisions: {
      catalog: 1,
      effectivePolicy: input.policyRevision,
      policyBasis: input.policyRevision,
      ceiling: CEILING.revision,
      grants: 'grants-v1',
    },
  } as const;
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

async function loadThreadState(
  storage: RuntimeStoragePort,
  threadId: ThreadId,
): Promise<import('../session/thread-journal.js').FoldedThreadJournal> {
  const workspace = await storage.openWorkspace({ cwd: CWD, workspaceId: WORKSPACE_ID });
  try {
    const journal = await workspace.openThreadJournal(threadId);
    if (journal === undefined) throw new Error(`Missing thread journal ${threadId}`);
    return await journal.loadState();
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
  #op: number;
  #epoch = 0;

  constructor(initialOp = 0) {
    this.#op = initialOp;
  }

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

class RecordingDriverFactory implements RuntimeThreadDriverFactory {
  readonly #drivers = new Map<ThreadId, RecordingDriver>();
  closeCalls = 0;
  createCalls = 0;
  resumeCalls = 0;

  async create(
    input: Parameters<RuntimeThreadDriverFactory['create']>[0],
    host: ThreadDriverHostServices,
  ): Promise<RuntimeThreadDriverAttachment> {
    this.createCalls++;
    const attachment = this.#attachment(input.threadId, input.model.ref, host);
    return input.initialCheckpoint === undefined
      ? attachment
      : { ...attachment, initialCheckpoint: input.initialCheckpoint };
  }

  async resume(
    input: {
      readonly threadId: ThreadId;
      readonly model: ModelConfig;
      readonly committedCheckpoint: import('./ports.js').ThreadDriverCheckpoint;
    },
    host: ThreadDriverHostServices,
  ): Promise<RuntimeThreadDriverAttachment> {
    this.resumeCalls++;
    const attachment = this.#attachment(input.threadId, input.model.ref, host);
    return { ...attachment, initialCheckpoint: input.committedCheckpoint };
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

  async materializeTurn(
    threadId: ThreadId,
    runId: RunId,
    promptText: string,
    responseText: string,
  ): Promise<void> {
    const driver = this.#drivers.get(threadId);
    if (driver === undefined) throw new Error(`Missing driver for ${threadId}`);
    await driver.materializeTurn(runId, promptText, responseText);
  }

  async materializeToolDiff(
    threadId: ThreadId,
    runId: RunId,
    target: string,
    diff: string,
  ): Promise<void> {
    const driver = this.#drivers.get(threadId);
    if (driver === undefined) throw new Error(`Missing driver for ${threadId}`);
    await driver.materializeToolDiff(runId, target, diff);
  }

  #attachment(
    threadId: ThreadId,
    model: ModelRef,
    host: ThreadDriverHostServices,
  ): RuntimeThreadDriverAttachment {
    const driver = new RecordingDriver(host, () => { this.closeCalls++; });
    this.#drivers.set(threadId, driver);
    return {
      driver,
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
    if ((command.op.type === 'prompt'
      || command.op.type === 'continue'
      || command.op.type === 'compact') && 'runId' in command) {
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

  async materializeTurn(runId: RunId, promptText: string, responseText: string): Promise<void> {
    const turn = await this.#reserveCanonicalTurn(runId);
    await this.host.commitEvent({ event: { type: 'turn_start' }, runId, turnId: turn.turnId });
    await this.host.commitEvent({
      event: {
        type: 'message_end',
        message: {
          role: 'user',
          id: `user-${runId}`,
          timestamp: 1,
          source: 'prompt',
          content: [{ type: 'text', text: promptText }],
        },
      },
      runId,
      turnId: turn.turnId,
    });
    await this.host.commitEvent({
      event: {
        type: 'message_end',
        message: {
          role: 'assistant',
          id: `assistant-${runId}`,
          timestamp: 1,
          content: [{ type: 'text', text: responseText }],
          model: MODEL.ref,
          stopReason: 'stop',
          usage: { input: 3, output: 2 },
        },
      },
      runId,
      turnId: turn.turnId,
    });
  }

  async materializeToolDiff(runId: RunId, target: string, diff: string): Promise<void> {
    const turn = await this.#reserveCanonicalTurn(runId);
    const toolCallId = `tool-${runId}`;
    await this.host.commitEvent({ event: { type: 'turn_start' }, runId, turnId: turn.turnId });
    await this.host.commitEvent({
      event: {
        type: 'tool_execution_start',
        toolCallId,
        toolName: 'edit',
        args: { path: target },
      },
      runId,
      turnId: turn.turnId,
    });
    await this.host.commitEvent({
      event: {
        type: 'tool_execution_update',
        toolCallId,
        update: { output: `editing ${target}\n` },
      },
      runId,
      turnId: turn.turnId,
    });
    await this.host.commitEvent({
      event: {
        type: 'tool_execution_update',
        toolCallId,
        update: { output: `editing ${target}\ncomplete` },
      },
      runId,
      turnId: turn.turnId,
    });
    await this.host.commitEvent({
      event: {
        type: 'tool_execution_end',
        toolCallId,
        result: {
          role: 'tool_result',
          id: `result-${runId}`,
          timestamp: 1,
          toolCallId,
          toolName: 'edit',
          content: [{ type: 'text', text: 'edited' }],
          isError: false,
          details: { diff },
        },
      },
      runId,
      turnId: turn.turnId,
    });
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

  async #reserveCanonicalTurn(runId: RunId): Promise<{
    readonly turnId: import('../protocol/index.js').TurnId;
  }> {
    const turn = await this.host.reserveTurn({ runId, turnOrdinal: 1 });
    const rootCommand = this.commands.findLast((command) =>
      'runId' in command && command.runId === runId);
    if (rootCommand === undefined || !('runId' in rootCommand)) {
      throw new Error(`Missing root command for ${runId}`);
    }
    await this.host.captureRuntimeTurn?.({
      rootOpId: rootCommand.op.opId,
      runId,
      turnId: turn.turnId,
      model: MODEL,
      transcript: [],
      signal: new AbortController().signal,
    });
    return turn;
  }
}

class CheckpointMismatchFactory implements RuntimeThreadDriverFactory {
  resumeCalls = 0;
  closeCalls = 0;

  constructor(private readonly modes: Array<{
    readonly mismatch: boolean;
    readonly closeReject?: boolean;
  }>) {}

  async create(): Promise<RuntimeThreadDriverAttachment> {
    throw new Error('CheckpointMismatchFactory.create is not used');
  }

  async resume(
    input: Parameters<RuntimeThreadDriverFactory['resume']>[0],
  ): Promise<RuntimeThreadDriverAttachment> {
    this.resumeCalls++;
    const mode = this.modes.shift();
    if (mode === undefined) throw new Error('No checkpoint mismatch mode configured');
    const checkpoint = input.committedCheckpoint;
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
      initialCheckpoint,
    };
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

function recordJournalAppends(base: RuntimeStoragePort): {
  readonly storage: RuntimeStoragePort;
  records(threadId: ThreadId): readonly RuntimeJournalRecord[];
} {
  const appended = new Map<ThreadId, RuntimeJournalRecord[]>();
  const wrapJournal = (threadId: ThreadId, journal: ThreadJournalPort): ThreadJournalPort =>
    new Proxy(journal, {
      get(target, property, receiver) {
        if (property === 'append') {
          return async (...args: Parameters<ThreadJournalPort['append']>) => {
            const [records] = args;
            const captured = appended.get(threadId) ?? [];
            captured.push(...records);
            appended.set(threadId, captured);
            return target.append(...args);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  return {
    records: (threadId) => appended.get(threadId) ?? [],
    storage: {
      listStoredThreads: () => base.listStoredThreads(),
      async openWorkspace(input): Promise<RuntimeWorkspaceStoragePort> {
        const workspace = await base.openWorkspace(input);
        return new Proxy(workspace, {
          get(target, property, receiver) {
            if (property === 'createThreadJournal') {
              return async (...args: Parameters<RuntimeWorkspaceStoragePort['createThreadJournal']>) => {
                const journal = await target.createThreadJournal(...args);
                return wrapJournal(args[1].threadId, journal);
              };
            }
            if (property === 'openThreadJournal') {
              return async (...args: Parameters<RuntimeWorkspaceStoragePort['openThreadJournal']>) => {
                const journal = await target.openThreadJournal(...args);
                return journal === undefined ? undefined : wrapJournal(args[0], journal);
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
