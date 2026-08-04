import { afterEach, describe, expect, test } from 'bun:test';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PolicyGrant } from '../capabilities/types.js';
import type {
  ExternalOpId,
  ThreadId,
  TurnId,
  WorkspaceId,
} from '../protocol/index.js';
import { PROTOCOL_VERSION, runtimeOpPayloadHash, sha256Hex } from '../protocol/index.js';
import { RuntimeStorageError, WorkspaceBindingMismatchError, WorkspaceInUseError } from './errors.js';
import { createFileRuntimeStorage } from './file-storage.js';
import type { SupervisorOpLedgerRecord, ThreadMetaRecord, ThreadSeedRecord } from './ports.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('FileRuntimeStorage canonical persistence', () => {
  test('claims an immutable workspace binding before initializing mutable state', async () => {
    const root = temporaryDirectory();
    const storage = createFileRuntimeStorage({ root });
    const workspaceId = 'ws_atomic_binding' as WorkspaceId;
    const cwdA = path.join(root, 'cwd-a');
    const cwdB = path.join(root, 'cwd-b');
    const first = await storage.openWorkspace({ cwd: cwdA, workspaceId });

    await expect(storage.openWorkspace({ cwd: cwdB, workspaceId }))
      .rejects.toBeInstanceOf(WorkspaceBindingMismatchError);
    const workspaceDir = workspacePath(root, workspaceId);
    expect(existsSync(path.join(workspaceDir, 'binding.json'))).toBe(true);
    expect(existsSync(path.join(workspaceDir, 'ledger.json'))).toBe(false);
    expect(existsSync(path.join(workspaceDir, 'catalog.json'))).toBe(false);
    expect(existsSync(path.join(workspaceDir, 'threads'))).toBe(false);
    await first.close();
  });

  test('uses an exclusive workspace lease and fences a stale holder', async () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, 'cwd');
    const workspaceId = 'ws_exclusive_lease' as WorkspaceId;
    const storage = createFileRuntimeStorage({ root });
    const first = await storage.openWorkspace({ cwd, workspaceId });
    const second = await storage.openWorkspace({ cwd, workspaceId });
    const firstLease = await first.acquireSupervisorLease('first-holder');

    await expect(second.acquireSupervisorLease('second-holder'))
      .rejects.toBeInstanceOf(WorkspaceInUseError);
    await first.releaseSupervisorLease(firstLease);
    const secondLease = await second.acquireSupervisorLease('second-holder');
    expect(await first.validateWriteFence(firstLease)).toEqual({ current: false, code: 'stale_fence' });
    await second.releaseSupervisorLease(secondLease);
    await first.close();
    await second.close();
  });

  test('round-trips canonical metadata and a canonical thread seed across reopen', async () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, 'cwd');
    const workspaceId = 'ws_thread_seed_roundtrip' as WorkspaceId;
    const threadId = 'thread-seed-roundtrip' as ThreadId;
    const storage = createFileRuntimeStorage({ root });
    const workspace = await storage.openWorkspace({ cwd, workspaceId });
    const lease = await workspace.acquireSupervisorLease('thread-seed-first');
    const meta = threadMeta({ workspaceId, threadId, cwd });
    const seed = threadSeed();
    const journal = await workspace.createThreadJournal(lease, {
      threadId,
      meta,
      initialRecords: [seed],
    });

    expect(await journal.load()).toEqual([meta, seed]);
    expect(await workspace.listThreads()).toEqual([{
      summary: { threadId, createdAt: 1, state: 'idle' },
      format: 'runtime-v2',
      storageKey: `th-${sha256Hex(threadId)}.jsonl`,
    }]);
    await workspace.releaseSupervisorLease(lease);
    await workspace.close();

    const locators = await storage.listStoredThreads();
    expect(locators).toEqual([{
      ownerWorkspaceId: workspaceId,
      ownerRecordedCwd: cwd,
      threadId,
      catalog: {
        summary: { threadId, createdAt: 1, state: 'idle' },
        format: 'runtime-v2',
        storageKey: `th-${sha256Hex(threadId)}.jsonl`,
      },
    }]);
    expectDeepFrozen(locators);

    const reopened = await storage.openWorkspace({ cwd, workspaceId });
    const reopenedLease = await reopened.acquireSupervisorLease('thread-seed-second');
    expect(await (await reopened.openThreadJournal(threadId))?.load()).toEqual([meta, seed]);
    await reopened.releaseSupervisorLease(reopenedLease);
    await reopened.close();
  });

  test('writes only the canonical protocol version while reading compatible patch journals', async () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, 'cwd');
    const workspaceId = 'ws_protocol_patch' as WorkspaceId;
    const threadId = 'thread-protocol-patch' as ThreadId;
    const workspace = await createFileRuntimeStorage({ root }).openWorkspace({ cwd, workspaceId });
    const lease = await workspace.acquireSupervisorLease('protocol-patch');

    await expect(workspace.createThreadJournal(lease, {
      threadId,
      meta: threadMeta({ workspaceId, threadId, cwd, protocolVersion: '2.0.7' }),
    })).rejects.toMatchObject({
      name: 'RuntimeStorageError',
      code: 'protocol_version_write_mismatch',
    });
    expect(existsSync(journalPath(root, workspaceId, threadId))).toBe(false);

    const meta = threadMeta({ workspaceId, threadId, cwd });
    await workspace.createThreadJournal(lease, { threadId, meta });
    rewriteJournal(journalPath(root, workspaceId, threadId), '2.0.7');
    expect((await (await workspace.openThreadJournal(threadId))?.load())?.[0])
      .toEqual({ ...meta, protocolVersion: '2.0.7' });

    await workspace.releaseSupervisorLease(lease);
    await workspace.close();
  });

  test.each([
    ['not-semver', 'malformed_protocol_version'],
    ['1.9.9', 'retired_protocol_major'],
    ['3.0.0', 'unsupported_protocol_major'],
    ['2.1.0', 'unsupported_protocol_minor'],
  ] as const)('reports %s compatibility failures on the resume/open path', async (
    protocolVersion,
    code,
  ) => {
    const root = temporaryDirectory();
    const cwd = path.join(root, 'cwd');
    const workspaceId = `ws_protocol_resume_${code}` as WorkspaceId;
    const threadId = `thread-protocol-resume-${code}` as ThreadId;
    const workspace = await createFileRuntimeStorage({ root }).openWorkspace({ cwd, workspaceId });
    const lease = await workspace.acquireSupervisorLease(`protocol-resume-${protocolVersion}`);
    await workspace.createThreadJournal(lease, {
      threadId,
      meta: threadMeta({ workspaceId, threadId, cwd }),
    });
    rewriteJournal(journalPath(root, workspaceId, threadId), protocolVersion);

    await expect(workspace.openThreadJournal(threadId)).rejects.toMatchObject({
      name: 'RuntimeStorageError',
      code,
      message: expect.stringContaining(protocolVersion),
    });

    await workspace.releaseSupervisorLease(lease);
    await workspace.close();
  });

  test('checks an existing journal version before its damaged body on create', async () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, 'cwd');
    const workspaceId = 'ws_protocol_create' as WorkspaceId;
    const threadId = 'thread-protocol-create' as ThreadId;
    const workspace = await createFileRuntimeStorage({ root }).openWorkspace({ cwd, workspaceId });
    const lease = await workspace.acquireSupervisorLease('protocol-create');
    const meta = threadMeta({ workspaceId, threadId, cwd });
    await workspace.createThreadJournal(lease, { threadId, meta });
    rewriteJournal(journalPath(root, workspaceId, threadId), '2.1.0', '{damaged body}\n');

    await expect(workspace.createThreadJournal(lease, { threadId, meta })).rejects.toMatchObject({
      name: 'RuntimeStorageError',
      code: 'unsupported_protocol_minor',
      message: expect.stringContaining('2.1.0'),
    });

    await workspace.releaseSupervisorLease(lease);
    await workspace.close();
  });

  test('checks protocol compatibility before damaged-body recovery on workspace reopen', async () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, 'cwd');
    const workspaceId = 'ws_protocol_reopen' as WorkspaceId;
    const threadId = 'thread-protocol-reopen' as ThreadId;
    const storage = createFileRuntimeStorage({ root });
    const first = await storage.openWorkspace({ cwd, workspaceId });
    const firstLease = await first.acquireSupervisorLease('protocol-reopen-first');
    await first.createThreadJournal(firstLease, {
      threadId,
      meta: threadMeta({ workspaceId, threadId, cwd }),
    });
    await first.releaseSupervisorLease(firstLease);
    await first.close();
    rewriteJournal(journalPath(root, workspaceId, threadId), '3.0.0', '{damaged body}\n');

    const reopened = await storage.openWorkspace({ cwd, workspaceId });
    await expect(reopened.acquireSupervisorLease('protocol-reopen-second')).rejects.toMatchObject({
      name: 'RuntimeStorageError',
      code: 'unsupported_protocol_major',
      message: expect.stringContaining('3.0.0'),
    });
    await reopened.close();
  });

  test('keeps record schema version separate from protocol compatibility', async () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, 'cwd');
    const workspaceId = 'ws_record_schema_version' as WorkspaceId;
    const threadId = 'thread-record-schema-version' as ThreadId;
    const workspace = await createFileRuntimeStorage({ root }).openWorkspace({ cwd, workspaceId });
    const lease = await workspace.acquireSupervisorLease('record-schema-version');
    const meta = {
      ...threadMeta({ workspaceId, threadId, cwd }),
      version: 3,
    } as unknown as ThreadMetaRecord;

    await expect(workspace.createThreadJournal(lease, { threadId, meta })).rejects.toMatchObject({
      name: 'RuntimeStorageError',
      code: 'invalid_thread_meta',
    });

    await workspace.releaseSupervisorLease(lease);
    await workspace.close();
  });

  test('rejects malformed seed provenance before creating a journal', async () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, 'cwd');
    const workspaceId = 'ws_invalid_thread_seed' as WorkspaceId;
    const threadId = 'thread-invalid-seed' as ThreadId;
    const workspace = await createFileRuntimeStorage({ root }).openWorkspace({ cwd, workspaceId });
    const lease = await workspace.acquireSupervisorLease('invalid-thread-seed');
    const invalid = {
      ...threadSeed(),
      turnProvenance: [{ messageId: 'different-message', turnId: 'turn-seed' as TurnId }],
    };

    await expect(workspace.createThreadJournal(lease, {
      threadId,
      meta: threadMeta({ workspaceId, threadId, cwd }),
      initialRecords: [invalid],
    })).rejects.toMatchObject({ code: 'invalid_thread_seed' });
    expect(existsSync(journalPath(root, workspaceId, threadId))).toBe(false);

    await workspace.releaseSupervisorLease(lease);
    await workspace.close();
  });

  test('repairs a torn journal tail when a writer loads it', async () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, 'cwd');
    const workspaceId = 'ws_torn_tail_repair' as WorkspaceId;
    const threadId = 'thread-torn-tail' as ThreadId;
    const storage = createFileRuntimeStorage({ root });
    const first = await storage.openWorkspace({ cwd, workspaceId });
    const firstLease = await first.acquireSupervisorLease('torn-tail-first');
    await first.createThreadJournal(firstLease, {
      threadId,
      meta: threadMeta({ workspaceId, threadId, cwd }),
      initialRecords: [threadSeed()],
    });
    await first.releaseSupervisorLease(firstLease);
    await first.close();
    const file = journalPath(root, workspaceId, threadId);
    appendFileSync(file, '{"type":"thread_seed"');

    const second = await storage.openWorkspace({ cwd, workspaceId });
    const secondLease = await second.acquireSupervisorLease('torn-tail-second');
    const journal = await second.openThreadJournal(threadId);
    if (journal === undefined) throw new Error('journal missing');
    await journal.acquireWriteLease(secondLease);
    expect(await journal.load()).toEqual([
      threadMeta({ workspaceId, threadId, cwd }),
      threadSeed(),
    ]);
    expect(readFileSync(file, 'utf8')).not.toContain('{"type":"thread_seed"');
    await journal.releaseWriteLease();
    await second.releaseSupervisorLease(secondLease);
    await second.close();
  });

  test('persists canonical policy grants with exact receipt idempotency', async () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, 'cwd');
    const workspaceId = 'ws_file_policy_grants' as WorkspaceId;
    const storage = createFileRuntimeStorage({ root });
    const first = await storage.openWorkspace({ cwd, workspaceId });
    const firstLease = await first.acquireSupervisorLease('policy-first');
    const repository = await first.openPolicyGrantRepository(firstLease);
    const initialRevision = (await repository.snapshot()).revision;
    const grant = policyGrant(workspaceId, 'op_e_c1000000000000000000000000000001');

    const applied = await repository.commitAllowAlways(grant);
    expect(applied).toMatchObject({ kind: 'applied' });
    expect(applied.kind === 'applied' && applied.revision).not.toBe(initialRevision);
    expect(await repository.commitAllowAlways(grant)).toMatchObject({ kind: 'duplicate' });
    expect(await repository.commitAllowAlways({ ...grant, policyBasisRevision: 'changed' }))
      .toMatchObject({ kind: 'conflict' });
    expect(await repository.commitAllowAlways(policyGrant(
      'ws_file_policy_other' as WorkspaceId,
      'op_e_c2000000000000000000000000000002',
    ))).toMatchObject({ kind: 'fenced', code: 'wrong_workspace' });
    await expect(repository.commitAllowAlways({
      ...grant,
      grantId: 'op_e_c3000000000000000000000000000003' as ExternalOpId,
      scope: { kind: 'removed_scope' },
    } as unknown as PolicyGrant)).rejects.toMatchObject({ code: 'invalid_policy_grant' });
    await repository.close();
    await first.releaseSupervisorLease(firstLease);
    await first.close();

    const second = await storage.openWorkspace({ cwd, workspaceId });
    const secondLease = await second.acquireSupervisorLease('policy-second');
    const recoveredRepository = await second.openPolicyGrantRepository(secondLease);
    expect(await recoveredRepository.snapshot()).toMatchObject({ workspaceId, grants: [grant] });
    await recoveredRepository.close();
    await second.releaseSupervisorLease(secondLease);
    await second.close();
  });

  test('validates canonical resource patterns using UTF-8 byte order', async () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, 'cwd');
    const workspaceId = 'ws_file_utf8_patterns' as WorkspaceId;
    const workspace = await createFileRuntimeStorage({ root }).openWorkspace({ cwd, workspaceId });
    const lease = await workspace.acquireSupervisorLease('utf8-patterns');
    const repository = await workspace.openPolicyGrantRepository(lease);
    const first = resourcePattern('\uE000');
    const second = resourcePattern('𐀀');
    const base = policyGrant(workspaceId, 'op_e_c4000000000000000000000000000004');

    await expect(repository.commitAllowAlways({
      ...base,
      scope: {
        kind: 'canonical_resources_v1',
        resourcePatterns: [second, first],
        attributes: {},
      },
    })).rejects.toMatchObject({ code: 'invalid_policy_grant' });
    expect(await repository.commitAllowAlways({
      ...base,
      scope: {
        kind: 'canonical_resources_v1',
        resourcePatterns: [first, second],
        attributes: {},
      },
    })).toMatchObject({ kind: 'applied' });

    await repository.close();
    await workspace.releaseSupervisorLease(lease);
    await workspace.close();
  });

  test('persists the canonical retry freeze and rejects post-reservation changes', async () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, 'cwd');
    const workspaceId = 'ws_retry_prompt_freeze' as WorkspaceId;
    const opId = 'op_e_d1000000000000000000000000000001' as ExternalOpId;
    const retryPromptOpId = 'op_e_d2000000000000000000000000000002' as ExternalOpId;
    const text = 'frozen retry prompt';
    const op = {
      type: 'conversation_retry' as const,
      opId,
      workspaceId,
      sourceThreadId: 'thread-retry-source' as ThreadId,
      threadId: 'thread-retry-target' as ThreadId,
      model: { provider: 'faux', api: 'faux', model: 'test' },
    };
    const reserved: SupervisorOpLedgerRecord = {
      opId,
      op,
      payloadHash: runtimeOpPayloadHash(op),
      retryPromptOpId,
      retryPrompt: {
        messageId: 'message-retry-source',
        turnId: 'turn-retry-source' as TurnId,
        text,
        digest: sha256Hex(text),
      },
      state: 'reserved',
    };
    const storage = createFileRuntimeStorage({ root });
    const workspace = await storage.openWorkspace({ cwd, workspaceId });
    const lease = await workspace.acquireSupervisorLease('retry-freeze');
    expect(await workspace.reserveSupervisorOp(lease, reserved)).toMatchObject({ kind: 'reserved' });
    await workspace.releaseSupervisorLease(lease);
    await workspace.close();

    const reopened = await storage.openWorkspace({ cwd, workspaceId });
    const reopenedLease = await reopened.acquireSupervisorLease('retry-freeze-reopen');
    expect((await reopened.loadSupervisorOps())[0]).toEqual(reserved);
    await reopened.releaseSupervisorLease(reopenedLease);
    await reopened.close();

    const ledgerPath = path.join(workspacePath(root, workspaceId), 'ledger.json');
    const corrupted = JSON.parse(readFileSync(ledgerPath, 'utf8')) as {
      ops: Array<{ retryPrompt: { text: string } }>;
    };
    corrupted.ops[0]!.retryPrompt.text = 'changed after reservation';
    writeFileSync(ledgerPath, `${JSON.stringify(corrupted)}\n`);
    const invalid = await storage.openWorkspace({ cwd, workspaceId });
    await expect(invalid.acquireSupervisorLease('retry-freeze-invalid'))
      .rejects.toMatchObject({ code: 'invalid_supervisor_op' });
    await invalid.close();
  });

  test('rejects catalog entries and metadata with unknown protocol fields', async () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, 'cwd');
    const workspaceId = 'ws_schema_validation' as WorkspaceId;
    const threadId = 'thread-schema-validation' as ThreadId;
    const storage = createFileRuntimeStorage({ root });
    const first = await storage.openWorkspace({ cwd, workspaceId });
    const lease = await first.acquireSupervisorLease('schema-first');
    await first.createThreadJournal(lease, {
      threadId,
      meta: threadMeta({ workspaceId, threadId, cwd }),
    });
    await first.releaseSupervisorLease(lease);
    await first.close();

    const catalogFile = path.join(workspacePath(root, workspaceId), 'catalog.json');
    const catalog = JSON.parse(readFileSync(catalogFile, 'utf8')) as {
      threads: Array<Record<string, unknown>>;
    };
    catalog.threads[0]!.removedBinding = { kind: 'removed', key: 'value' };
    writeFileSync(catalogFile, `${JSON.stringify(catalog)}\n`);
    const invalid = await storage.openWorkspace({ cwd, workspaceId });
    await expect(invalid.acquireSupervisorLease('schema-second'))
      .rejects.toBeInstanceOf(RuntimeStorageError);
    await invalid.close();
  });

  test('rejects pre-positioned symlinks and unsafe root paths', async () => {
    const parent = temporaryDirectory();
    const target = path.join(parent, 'target');
    const root = path.join(parent, 'runtime');
    writeFileSync(target, '{}');
    symlinkSync(target, root);
    const storage = createFileRuntimeStorage({ root });

    await expect(storage.openWorkspace({
      cwd: path.join(parent, 'cwd'),
      workspaceId: 'ws_symlink_root' as WorkspaceId,
    })).rejects.toMatchObject({ code: 'unsafe_storage_key' });
    expect(() => createFileRuntimeStorage({ root: 'relative/path' })).toThrow(TypeError);
    expect(() => createFileRuntimeStorage({ root: `${parent}\ud800` })).toThrow(TypeError);
  });
});

function threadMeta(input: {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  cwd: string;
  protocolVersion?: string;
}): ThreadMetaRecord {
  return {
    type: 'thread_meta',
    version: 2,
    protocolVersion: input.protocolVersion ?? PROTOCOL_VERSION,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    permissionCeiling: { revision: 'test', constraints: [] },
    createdAt: 1,
    cwd: input.cwd,
    model: { provider: 'faux', api: 'faux', model: 'test' },
  };
}

function threadSeed(): ThreadSeedRecord {
  return {
    type: 'thread_seed',
    transcript: [{
      role: 'user',
      id: 'message-seed',
      timestamp: 1,
      source: 'prompt',
      content: [{ type: 'text', text: 'seed' }],
    }],
    turnProvenance: [{ messageId: 'message-seed', turnId: 'turn-seed' as TurnId }],
    usage: { cumulative: { input: 0, output: 0 }, turns: 0, contextTokens: 0 },
  };
}

function policyGrant(workspaceId: WorkspaceId, grantId: string): PolicyGrant {
  return {
    grantId: grantId as ExternalOpId,
    workspaceId,
    capabilityId: 'bash',
    capabilityVersion: '1.0.0',
    registrationDigest: `capreg_v1_${'2'.repeat(64)}`,
    scope: {
      kind: 'canonical_resources_v1',
      resourcePatterns: [resourcePattern('bun test')],
      attributes: { confirmation: 'required' },
    },
    policyBasisRevision: 'policy-basis-v1',
    acceptedAt: 20,
  };
}

function resourcePattern(pattern: string) {
  return {
    resourceType: 'command' as const,
    access: 'execute' as const,
    matcher: 'canonical_target_exact_v1' as const,
    pattern,
  };
}

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'coda-runtime-storage-'));
  temporaryRoots.push(directory);
  return directory;
}

function workspacePath(root: string, workspaceId: WorkspaceId): string {
  return path.join(root, `ws-${sha256Hex(workspaceId)}`);
}

function journalPath(root: string, workspaceId: WorkspaceId, threadId: ThreadId): string {
  return path.join(workspacePath(root, workspaceId), 'threads', `th-${sha256Hex(threadId)}.jsonl`);
}

function rewriteJournal(
  file: string,
  protocolVersion: string,
  body?: string,
): void {
  const [header, ...existingBody] = readFileSync(file, 'utf8').split('\n');
  if (header === undefined) throw new Error('journal has no header');
  const meta = JSON.parse(header) as Record<string, unknown>;
  meta.protocolVersion = protocolVersion;
  writeFileSync(file, `${JSON.stringify(meta)}\n${body ?? existingBody.join('\n')}`);
}
