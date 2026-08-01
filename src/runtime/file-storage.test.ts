import { afterEach, describe, expect, test } from 'bun:test';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ExternalOpId, ThreadId, WorkspaceId } from '../protocol/index.js';
import { runtimeOpPayloadHash, sha256Hex } from '../protocol/index.js';
import { RuntimeStorageError, WorkspaceBindingMismatchError, WorkspaceInUseError } from './errors.js';
import { createFileRuntimeStorage } from './file-storage.js';
import type { SupervisorLease, ThreadMetaRecord } from './ports.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('FileRuntimeStorage', () => {
  test('claims an immutable binding atomically and does not initialize mutable state before lease', async () => {
    const root = temporaryDirectory();
    const storage = createFileRuntimeStorage({ root });
    const workspaceId = 'ws_atomic_binding' as WorkspaceId;
    const cwdA = path.join(root, 'cwd-a');
    const cwdB = path.join(root, 'cwd-b');
    const [first, second] = await Promise.allSettled([
      storage.openWorkspace({ cwd: cwdA, workspaceId }),
      storage.openWorkspace({ cwd: cwdB, workspaceId }),
    ]);

    expect([first.status, second.status].sort()).toEqual(['fulfilled', 'rejected']);
    const rejection = first.status === 'rejected' ? first.reason : second.status === 'rejected' ? second.reason : undefined;
    expect(rejection).toBeInstanceOf(WorkspaceBindingMismatchError);
    const workspaceDir = workspacePath(root, workspaceId);
    expect(existsSync(path.join(workspaceDir, 'binding.json'))).toBe(true);
    expect(existsSync(path.join(workspaceDir, 'ledger.json'))).toBe(false);
    expect(existsSync(path.join(workspaceDir, 'catalog.json'))).toBe(false);
    expect(existsSync(path.join(workspaceDir, 'threads'))).toBe(false);
  });

  test('uses a kernel-held workspace lease and can recover after a holder is killed', async () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, 'cwd');
    const workspaceId = 'ws_process_crash_recovery' as WorkspaceId;
    const moduleUrl = pathToFileURL(path.join(import.meta.dir, 'file-storage.ts')).href;
    const childCode = `
      const { createFileRuntimeStorage } = await import(${JSON.stringify(moduleUrl)});
      const storage = createFileRuntimeStorage({ root: ${JSON.stringify(root)} });
      const workspace = await storage.openWorkspace({ cwd: ${JSON.stringify(cwd)}, workspaceId: ${JSON.stringify(workspaceId)} });
      await workspace.acquireSupervisorLease('child-process-epoch');
      console.log('READY');
      await new Promise(() => {});
    `;
    const child = Bun.spawn([process.execPath, '-e', childCode], { stdout: 'pipe', stderr: 'pipe' });
    const reader = child.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('READY');
    child.kill(9);
    await child.exited;

    const storage = createFileRuntimeStorage({ root });
    const workspace = await storage.openWorkspace({ cwd, workspaceId });
    const lease = await workspace.acquireSupervisorLease('successor-process-epoch');
    expect(lease.fencingToken).toBe('2');
    await workspace.releaseSupervisorLease(lease);
    await workspace.close();
  });

  test('fails closed when distinct workspace ids collide in the versioned authority port domain', async () => {
    const [workspaceIdA, workspaceIdB] = findPortCollision();
    const rootA = temporaryDirectory();
    const rootB = temporaryDirectory();
    const workspaceA = await createFileRuntimeStorage({ root: rootA }).openWorkspace({
      cwd: path.join(rootA, 'cwd'),
      workspaceId: workspaceIdA,
    });
    const workspaceB = await createFileRuntimeStorage({ root: rootB }).openWorkspace({
      cwd: path.join(rootB, 'cwd'),
      workspaceId: workspaceIdB,
    });
    const leaseA = await workspaceA.acquireSupervisorLease('collision-a');
    await expect(workspaceB.acquireSupervisorLease('collision-b')).rejects.toBeInstanceOf(WorkspaceInUseError);
    await workspaceA.releaseSupervisorLease(leaseA);
    await workspaceA.close();
    await workspaceB.close();
  });

  test('does not let a stale journal port unlink a successor owner lock', async () => {
    const fixture = await createJournalFixture();
    const first = fixture.journal;
    await first.releaseWriteLease();
    const second = await fixture.workspace.openThreadJournal(fixture.threadId);
    expect(second).toBeDefined();
    await second?.acquireWriteLease(fixture.lease);
    await first.releaseWriteLease();
    const contender = await fixture.workspace.openThreadJournal(fixture.threadId);
    await expect(contender?.acquireWriteLease(fixture.lease)).rejects.toMatchObject({ code: 'thread_in_use' });
    await second?.releaseWriteLease();
    await fixture.workspace.releaseSupervisorLease(fixture.lease);
    await fixture.workspace.close();
  });

  test('repairs an invalid tail before append and preserves a valid final record missing LF', async () => {
    const fixture = await createJournalFixture();
    const file = journalPath(fixture.root, fixture.workspaceId, fixture.threadId);
    appendFileSync(file, '{"type":"mailbox_prepare"', 'utf8');
    const afterInvalidTail = await fixture.journal.load();
    expect(afterInvalidTail).toHaveLength(1);
    expect(readFileSync(file, 'utf8').endsWith('\n')).toBe(true);

    const prepare = mailboxPrepare(
      'op_e_11111111111111111111111111111111' as ExternalOpId,
      fixture.workspaceId,
      fixture.threadId,
    );
    await fixture.journal.append([prepare], { flush: true });
    const bytes = readFileSync(file);
    truncateSync(file, bytes.length - 1);
    const withoutLf = await fixture.journal.load();
    expect(withoutLf).toHaveLength(2);
    expect(readFileSync(file, 'utf8').endsWith('\n')).toBe(true);
    const next = mailboxPrepare(
      'op_e_22222222222222222222222222222222' as ExternalOpId,
      fixture.workspaceId,
      fixture.threadId,
    );
    await fixture.journal.append([next], { flush: true });
    expect(await fixture.journal.load()).toHaveLength(3);

    await fixture.journal.releaseWriteLease();
    await fixture.workspace.releaseSupervisorLease(fixture.lease);
    await fixture.workspace.close();
  });

  test('repairs a torn tail while acquiring a successor runtime lease', async () => {
    const fixture = await createJournalFixture();
    const file = journalPath(fixture.root, fixture.workspaceId, fixture.threadId);
    await fixture.journal.releaseWriteLease();
    await fixture.workspace.releaseSupervisorLease(fixture.lease);
    await fixture.workspace.close();
    appendFileSync(file, '{"type":', 'utf8');

    const successor = await createFileRuntimeStorage({ root: fixture.root }).openWorkspace({
      cwd: fixture.cwd,
      workspaceId: fixture.workspaceId,
    });
    const lease = await successor.acquireSupervisorLease('tail-repair-successor');
    expect(readFileSync(file, 'utf8').endsWith('\n')).toBe(true);
    const journal = await successor.openThreadJournal(fixture.threadId);
    expect(await journal?.load()).toHaveLength(1);
    await successor.releaseSupervisorLease(lease);
    await successor.close();
  });

  test('rejects pre-positioned symlinks and lone-surrogate paths or identities', async () => {
    const parent = temporaryDirectory();
    const target = path.join(parent, 'escape-target');
    const root = path.join(parent, 'runtime-root');
    mkdirSync(target);
    mkdirSync(root);
    const workspaceId = 'ws_symlink_escape' as WorkspaceId;
    symlinkSync(target, workspacePath(root, workspaceId));
    const storage = createFileRuntimeStorage({ root });
    await expect(storage.openWorkspace({ cwd: path.join(parent, 'cwd'), workspaceId }))
      .rejects.toMatchObject({ code: 'unsafe_storage_key' });
    expect(() => createFileRuntimeStorage({ root: `${root}\ud800` })).toThrow(TypeError);
    await expect(storage.openWorkspace({
      cwd: path.join(parent, 'cwd'),
      workspaceId: '\ud800' as WorkspaceId,
    })).rejects.toThrow(TypeError);
  });

  test('reports malformed persisted JSON as typed storage errors', async () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, 'cwd');
    const workspaceId = 'ws_schema_validation' as WorkspaceId;
    const first = await createFileRuntimeStorage({ root }).openWorkspace({ cwd, workspaceId });
    const lease = await first.acquireSupervisorLease('schema-first');
    await first.releaseSupervisorLease(lease);
    await first.close();
    writeFileSync(path.join(workspacePath(root, workspaceId), 'catalog.json'), '{"version":99,"threads":[]}\n');

    const second = await createFileRuntimeStorage({ root }).openWorkspace({ cwd, workspaceId });
    await expect(second.acquireSupervisorLease('schema-second')).rejects.toBeInstanceOf(RuntimeStorageError);
    await second.close();
  });

  test('global read-only inventory closes journal/catalog crash gaps without taking a lease', async () => {
    const fixture = await createJournalFixture();
    const workspaceDir = workspacePath(fixture.root, fixture.workspaceId);
    writeFileSync(path.join(workspaceDir, 'catalog.json'), '{"version":1,"threads":[]}\n');
    const items = await createFileRuntimeStorage({ root: fixture.root }).listStoredThreads();
    expect(items.map((item) => item.threadId)).toEqual([fixture.threadId]);
    await fixture.journal.releaseWriteLease();
    await fixture.workspace.releaseSupervisorLease(fixture.lease);
    await fixture.workspace.close();
  });

  test('persists the one-way durableRef enrichment of a final accepted create skeleton', async () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, 'cwd');
    const workspaceId = 'ws_final_create_enrichment' as WorkspaceId;
    const threadId = 'thread-final-create-enrichment' as ThreadId;
    const opId = 'op_e_d0000000000000000000000000000001' as ExternalOpId;
    const workspace = await createFileRuntimeStorage({ root }).openWorkspace({ cwd, workspaceId });
    const lease = await workspace.acquireSupervisorLease('final-create-enrichment');
    const op = {
      type: 'thread_create' as const,
      opId,
      workspaceId,
      threadId,
      model: { provider: 'faux', api: 'faux', model: 'test' },
    };
    const meta: ThreadMetaRecord = {
      type: 'thread_meta',
      version: 2,
      protocolVersion: '1.0.0',
      workspaceId,
      threadId,
      createdByOpId: opId,
      permissionCeiling: { revision: 'test', constraints: [] },
      createdAt: 1,
      cwd,
      model: op.model,
    };
    await workspace.createThreadJournal(lease, { threadId, meta });
    const reserved = {
      opId,
      op,
      payloadHash: runtimeOpPayloadHash(op),
      driverCreation: { creationKey: 'persisted-create-key' },
      state: 'reserved' as const,
    };
    await workspace.reserveSupervisorOp(lease, reserved);
    const final = {
      ...reserved,
      state: 'final' as const,
      receipt: { accepted: true as const, opId, duplicate: false, threadId },
    };
    await workspace.finalizeSupervisorOp(lease, final);
    const driverRef = { kind: 'test-driver', key: 'persisted-backend' };
    const enriched = {
      ...final,
      driverCreation: { ...final.driverCreation, driverRef },
    };
    await workspace.finalizeSupervisorOp(lease, enriched);
    await workspace.finalizeSupervisorOp(lease, enriched);
    await expect(workspace.finalizeSupervisorOp(lease, {
      ...enriched,
      driverCreation: {
        ...enriched.driverCreation,
        driverRef: { kind: 'test-driver', key: 'different-backend' },
      },
    })).rejects.toMatchObject({ code: 'supervisor_op_conflict' });
    await expect(workspace.finalizeSupervisorOp(lease, {
      ...enriched,
      receipt: {
        accepted: false,
        opId,
        duplicate: false,
        reason: 'model_not_found',
        threadId,
      },
    })).rejects.toMatchObject({ code: 'supervisor_op_conflict' });
    expect((await workspace.loadSupervisorOps())[0]?.driverCreation).toEqual({
      creationKey: 'persisted-create-key',
      driverRef,
    });
    expect((await workspace.listThreads())[0]?.driverRef).toEqual(driverRef);
    await workspace.releaseSupervisorLease(lease);
    await workspace.close();

    const reopened = await createFileRuntimeStorage({ root }).openWorkspace({ cwd, workspaceId });
    const reopenedLease = await reopened.acquireSupervisorLease('final-create-enrichment-reopen');
    expect((await reopened.loadSupervisorOps())[0]?.driverCreation?.driverRef).toEqual(driverRef);
    expect((await reopened.listThreads())[0]?.driverRef).toEqual(driverRef);
    await reopened.releaseSupervisorLease(reopenedLease);
    await reopened.close();
    const inventory = await createFileRuntimeStorage({ root }).listStoredThreads();
    expect(inventory.find((item) => item.threadId === threadId)?.catalog.driverRef).toEqual(driverRef);
  });

  test('never overlays a rejected create ref and fails closed on an accepted non-owner ref', async () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, 'cwd');
    const workspaceId = 'ws_rejected_create_overlay' as WorkspaceId;
    const threadId = 'thread-rejected-create-overlay' as ThreadId;
    const ownerOpId = 'op_e_d0000000000000000000000000000002' as ExternalOpId;
    const rejectedOpId = 'op_e_d0000000000000000000000000000003' as ExternalOpId;
    const ownerRef = { kind: 'test-driver', key: 'owner-backend' };
    const competingRef = { kind: 'test-driver', key: 'competing-backend' };
    const workspace = await createFileRuntimeStorage({ root }).openWorkspace({ cwd, workspaceId });
    const lease = await workspace.acquireSupervisorLease('rejected-create-overlay');
    await workspace.createThreadJournal(lease, {
      threadId,
      meta: {
        type: 'thread_meta',
        version: 2,
        protocolVersion: '1.0.0',
        workspaceId,
        threadId,
        createdByOpId: ownerOpId,
        permissionCeiling: { revision: 'test', constraints: [] },
        createdAt: 1,
        cwd,
        model: { provider: 'faux', api: 'faux', model: 'test' },
        driverRef: ownerRef,
      },
    });
    const rejectedOp = {
      type: 'thread_create' as const,
      opId: rejectedOpId,
      workspaceId,
      threadId,
      model: { provider: 'faux', api: 'faux', model: 'test' },
    };
    const reserved = {
      opId: rejectedOpId,
      op: rejectedOp,
      payloadHash: runtimeOpPayloadHash(rejectedOp),
      driverCreation: { creationKey: 'competing-creation-key' },
      state: 'reserved' as const,
    };
    await workspace.reserveSupervisorOp(lease, reserved);
    const rejected = {
      ...reserved,
      state: 'final' as const,
      receipt: {
        accepted: false as const,
        opId: rejectedOpId,
        duplicate: false,
        reason: 'thread_already_exists',
        threadId,
      },
    };
    await workspace.finalizeSupervisorOp(lease, rejected);
    await expect(workspace.finalizeSupervisorOp(lease, {
      ...rejected,
      driverCreation: { ...rejected.driverCreation, driverRef: competingRef },
    })).rejects.toMatchObject({ code: 'supervisor_op_conflict' });
    expect((await workspace.listThreads())[0]?.driverRef).toEqual(ownerRef);
    await workspace.releaseSupervisorLease(lease);
    await workspace.close();
    const storage = createFileRuntimeStorage({ root });
    const inventory = await storage.listStoredThreads();
    expect(inventory.find((item) => item.threadId === threadId)?.catalog.driverRef).toEqual(ownerRef);

    const acceptedOpId = 'op_e_d0000000000000000000000000000004' as ExternalOpId;
    const acceptedOp = { ...rejectedOp, opId: acceptedOpId };
    const reopened = await storage.openWorkspace({ cwd, workspaceId });
    const reopenedLease = await reopened.acquireSupervisorLease('accepted-non-owner-overlay');
    const acceptedReserved = {
      opId: acceptedOpId,
      op: acceptedOp,
      payloadHash: runtimeOpPayloadHash(acceptedOp),
      driverCreation: { creationKey: 'accepted-non-owner-key' },
      state: 'reserved' as const,
    };
    await reopened.reserveSupervisorOp(reopenedLease, acceptedReserved);
    await reopened.finalizeSupervisorOp(reopenedLease, {
      ...acceptedReserved,
      driverCreation: { ...acceptedReserved.driverCreation, driverRef: competingRef },
      state: 'final',
      receipt: {
        accepted: true,
        opId: acceptedOpId,
        duplicate: false,
        threadId,
      },
    });
    await expect(reopened.listThreads()).rejects.toMatchObject({ code: 'thread_driver_ref_conflict' });
    await reopened.releaseSupervisorLease(reopenedLease);
    await reopened.close();
    await expect(storage.listStoredThreads()).rejects.toMatchObject({ code: 'thread_driver_ref_conflict' });
  });

  test('indexes v1 sessions read-only and imports the canonical seed without listening', async () => {
    const root = temporaryDirectory();
    const legacySessionDir = path.join(root, 'sessions');
    mkdirSync(legacySessionDir);
    const cwd = path.join(root, 'cwd');
    const sessionId = 'legacy-001';
    writeFileSync(path.join(legacySessionDir, `${sessionId}.jsonl`), [
      JSON.stringify({
        type: 'meta', version: 1, protocolVersion: '1.0.0', id: sessionId,
        createdAt: 10, cwd, model: { provider: 'faux', api: 'faux', model: 'test' },
      }),
      JSON.stringify({
        type: 'message',
        message: { role: 'user', id: 'u1', timestamp: 11, source: 'prompt', content: [{ type: 'text', text: 'hi' }] },
      }),
      '',
    ].join('\n'));
    const storage = createFileRuntimeStorage({ root: path.join(root, 'runtime'), legacySessionDir });
    const listed = await storage.listStoredThreads();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.sourceSessionId).toBe(sessionId);
    expect(existsSync(path.join(root, 'runtime'))).toBe(false);

    const locator = listed[0];
    expect(locator).toBeDefined();
    const workspace = await storage.openWorkspace({ cwd, workspaceId: locator?.ownerWorkspaceId });
    const lease = await workspace.acquireSupervisorLease('legacy-import');
    const imported = await workspace.importLegacyThread(lease, locator?.threadId as ThreadId);
    expect(imported?.seed).toMatchObject({ type: 'legacy_seed', sourceSessionId: sessionId });
    expect(imported?.seed.transcript).toHaveLength(1);
    await workspace.releaseSupervisorLease(lease);
    await workspace.close();
  });
});

async function createJournalFixture(): Promise<{
  root: string;
  cwd: string;
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  workspace: Awaited<ReturnType<ReturnType<typeof createFileRuntimeStorage>['openWorkspace']>>;
  lease: SupervisorLease;
  journal: Awaited<ReturnType<Awaited<ReturnType<ReturnType<typeof createFileRuntimeStorage>['openWorkspace']>>['createThreadJournal']>>;
}> {
  const root = temporaryDirectory();
  const cwd = path.join(root, 'cwd');
  const workspaceId = `ws_fixture_${crypto.randomUUID()}` as WorkspaceId;
  const threadId = `th_fixture_${crypto.randomUUID()}` as ThreadId;
  const workspace = await createFileRuntimeStorage({ root }).openWorkspace({ cwd, workspaceId });
  const lease = await workspace.acquireSupervisorLease(`epoch-${crypto.randomUUID()}`);
  const meta: ThreadMetaRecord = {
    type: 'thread_meta',
    version: 2,
    protocolVersion: '1.0.0',
    workspaceId,
    threadId,
    permissionCeiling: { revision: 'test', constraints: [] },
    createdAt: 1,
    cwd,
    model: { provider: 'faux', api: 'faux', model: 'test' },
    driverRef: { kind: 'test', key: threadId },
  };
  const journal = await workspace.createThreadJournal(lease, { threadId, meta });
  await journal.acquireWriteLease(lease);
  return { root, cwd, workspaceId, threadId, workspace, lease, journal };
}

function mailboxPrepare(opId: ExternalOpId, workspaceId: WorkspaceId, threadId: ThreadId): {
  type: 'mailbox_prepare'; opId: ExternalOpId;
  op: {
    type: 'prompt'; opId: ExternalOpId; workspaceId: WorkspaceId; threadId: ThreadId; text: string;
  }; timestamp: number;
} {
  return {
    type: 'mailbox_prepare',
    opId,
    op: { type: 'prompt', opId, workspaceId, threadId, text: 'x' },
    timestamp: 1,
  };
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

function authorityPort(workspaceId: WorkspaceId): number {
  const prefix = Number.parseInt(sha256Hex(`workspace-authority-v1\0${workspaceId}`).slice(0, 8), 16);
  return 30_000 + (prefix % 20_000);
}

function findPortCollision(): readonly [WorkspaceId, WorkspaceId] {
  const byPort = new Map<number, WorkspaceId>();
  for (let index = 0; index < 2_000; index++) {
    const workspaceId = `ws_collision_${index}` as WorkspaceId;
    const port = authorityPort(workspaceId);
    const previous = byPort.get(port);
    if (previous !== undefined) return [previous, workspaceId];
    byPort.set(port, workspaceId);
  }
  throw new Error('Unable to find deterministic authority-port collision');
}
