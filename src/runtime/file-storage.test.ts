import { afterEach, describe, expect, test } from 'bun:test';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PolicyGrant } from '../capabilities/types.js';
import type {
  AgentMessage,
  ExternalOpId,
  RunId,
  ThreadId,
  TurnId,
  WorkspaceId,
} from '../protocol/index.js';
import { runtimeOpPayloadHash, sha256Hex } from '../protocol/index.js';
import type { RuntimeJournalRecord } from '../session/thread-journal-records.js';
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

  test('round-trips assistant text phases and reasoning kinds through the canonical journal', async () => {
    const fixture = await createJournalFixture();
    const runId = 'run_file_storage_reasoning' as RunId;
    const turnId = 'turn_file_storage_reasoning' as TurnId;
    const message: AgentMessage = {
      role: 'assistant',
      id: 'assistant-reasoning-kinds',
      timestamp: 2,
      content: [
        { type: 'text', text: 'visible progress', phase: 'commentary' },
        { type: 'text', text: 'final response', phase: 'final_answer' },
        { type: 'reasoning', kind: 'summary', text: 'safe summary' },
        { type: 'reasoning', kind: 'content', text: 'private content', signature: 'sig' },
        { type: 'reasoning', text: 'legacy reasoning' },
      ],
      model: { provider: 'openai', api: 'openai-responses', model: 'gpt-test' },
      stopReason: 'stop',
      usage: { input: 3, output: 2 },
    };
    const commit: RuntimeJournalRecord = {
      type: 'commit',
      firstSeq: 1,
      envelopes: [{
        workspaceId: fixture.workspaceId,
        threadId: fixture.threadId,
        runId,
        turnId,
        seq: 1,
        timestamp: 2,
        event: { type: 'message_end', message },
      }],
      mutations: [{ type: 'message_appended', message }],
    };

    await fixture.journal.append([commit], { flush: true });
    await fixture.journal.releaseWriteLease();
    await fixture.workspace.releaseSupervisorLease(fixture.lease);
    await fixture.workspace.close();

    const reopened = await createFileRuntimeStorage({ root: fixture.root }).openWorkspace({
      cwd: fixture.cwd,
      workspaceId: fixture.workspaceId,
    });
    const lease = await reopened.acquireSupervisorLease('reasoning-kind-reopen');
    const journal = await reopened.openThreadJournal(fixture.threadId);
    const records = await journal?.load();
    const persisted = records?.find((record) => record.type === 'commit');
    expect(persisted?.type === 'commit' ? persisted.mutations?.[0] : undefined).toEqual({
      type: 'message_appended',
      message,
    });
    await reopened.releaseSupervisorLease(lease);
    await reopened.close();
  });

  test('rejects unknown assistant presentation metadata at the storage boundary', async () => {
    const fixture = await createJournalFixture();
    const invalidParts = [
      { source: 'invalid-reasoning-kind', part: { type: 'reasoning', kind: 'unknown', text: 'not canonical' } },
      { source: 'invalid-assistant-phase', part: { type: 'text', text: 'not canonical', phase: 'thinking' } },
    ];
    for (const { source, part } of invalidParts) {
      const invalidSeed = {
        type: 'legacy_seed',
        sourceSessionId: source,
        transcript: [{
          role: 'assistant',
          id: `assistant-${source}`,
          timestamp: 2,
          content: [part],
          model: { provider: 'openai', api: 'openai-responses', model: 'gpt-test' },
          stopReason: 'stop',
          usage: { input: 1, output: 1 },
        }],
        usage: {
          cumulative: { input: 1, output: 1 },
          turns: 1,
          contextTokens: 2,
        },
      } as unknown as RuntimeJournalRecord;

      await expect(fixture.journal.append([invalidSeed], { flush: true }))
        .rejects.toBeInstanceOf(RuntimeStorageError);
    }
    expect(await fixture.journal.load()).toHaveLength(1);
    await fixture.journal.releaseWriteLease();
    await fixture.workspace.releaseSupervisorLease(fixture.lease);
    await fixture.workspace.close();
  });

  test('does not rescan validated journal history for each leased append', async () => {
    const root = temporaryDirectory();
    const moduleUrl = pathToFileURL(path.join(import.meta.dir, 'file-storage.ts')).href;
    const childCode = `
      const { mock } = await import('bun:test');
      const actualFs = await import('node:fs');
      const nativeReadFileSync = actualFs.readFileSync;
      let journalReads = 0;
      mock.module('node:fs', () => ({
        ...actualFs,
        readFileSync(file, ...args) {
          if (typeof file === 'string' && file.endsWith('.jsonl')) journalReads++;
          return nativeReadFileSync(file, ...args);
        },
      }));
      const { createFileRuntimeStorage } = await import(${JSON.stringify(moduleUrl)});
      const root = ${JSON.stringify(root)};
      const cwd = root + '/cwd';
      const workspaceId = 'ws_incremental_journal_append';
      const threadId = 'th_incremental_journal_append';
      const storage = createFileRuntimeStorage({ root });
      const workspace = await storage.openWorkspace({ cwd, workspaceId });
      const lease = await workspace.acquireSupervisorLease('incremental-journal-append');
      const journal = await workspace.createThreadJournal(lease, {
        threadId,
        meta: {
          type: 'thread_meta',
          version: 2,
          protocolVersion: '1.0.0',
          workspaceId,
          threadId,
          permissionCeiling: { revision: 'test', constraints: [] },
          createdAt: 1,
          cwd,
          model: { provider: 'faux', api: 'faux', model: 'test' },
        },
      });
      await journal.acquireWriteLease(lease);
      await journal.load();
      journalReads = 0;
      for (let index = 1; index <= 8; index++) {
        const suffix = String(index).padStart(32, '0');
        const opId = 'op_e_' + suffix;
        await journal.append([{
          type: 'mailbox_prepare',
          opId,
          op: { type: 'prompt', opId, workspaceId, threadId, text: 'x' },
          timestamp: index,
        }], { flush: true });
      }
      const appendJournalReads = journalReads;
      const journalFile = actualFs.readdirSync(root + '/ws-' + (await import(${JSON.stringify(
        pathToFileURL(path.join(import.meta.dir, '../protocol/index.ts')).href,
      )})).sha256Hex(workspaceId) + '/threads')
        .find((name) => name.endsWith('.jsonl'));
      const journalText = nativeReadFileSync(
        root + '/ws-' + (await import(${JSON.stringify(
          pathToFileURL(path.join(import.meta.dir, '../protocol/index.ts')).href,
        )})).sha256Hex(workspaceId) + '/threads/' + journalFile,
        'utf8',
      );
      await journal.releaseWriteLease();
      await workspace.releaseSupervisorLease(lease);
      await workspace.close();
      console.log(JSON.stringify({
        appendJournalReads,
        recordCount: journalText.trimEnd().split('\\n').length,
      }));
    `;
    const child = Bun.spawn([process.execPath, '-e', childCode], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });
    expect(JSON.parse(stdout)).toEqual({ appendJournalReads: 0, recordCount: 9 });
  });

  test('fails closed when a leased journal changes outside the active writer', async () => {
    const fixture = await createJournalFixture();
    const file = journalPath(fixture.root, fixture.workspaceId, fixture.threadId);
    await fixture.journal.load();
    const foreign = mailboxPrepare(
      'op_e_33333333333333333333333333333333' as ExternalOpId,
      fixture.workspaceId,
      fixture.threadId,
    );
    appendFileSync(file, `${JSON.stringify(foreign)}\n`, 'utf8');
    const local = mailboxPrepare(
      'op_e_44444444444444444444444444444444' as ExternalOpId,
      fixture.workspaceId,
      fixture.threadId,
    );

    await expect(fixture.journal.append([local], { flush: true }))
      .rejects.toMatchObject({ code: 'invalid_thread_journal' });
    expect(readFileSync(file, 'utf8').trimEnd().split('\n')).toHaveLength(2);

    await fixture.journal.releaseWriteLease();
    await fixture.workspace.releaseSupervisorLease(fixture.lease);
    await fixture.workspace.close();
  });

  test('rejects same-size journal replacement through the leased append descriptor', async () => {
    const fixture = await createJournalFixture();
    const file = journalPath(fixture.root, fixture.workspaceId, fixture.threadId);
    await fixture.journal.load();
    const original = readFileSync(file);
    const displaced = `${file}.displaced`;
    renameSync(file, displaced);
    writeFileSync(file, original);
    const local = mailboxPrepare(
      'op_e_55555555555555555555555555555555' as ExternalOpId,
      fixture.workspaceId,
      fixture.threadId,
    );

    await expect(fixture.journal.append([local], { flush: true }))
      .rejects.toMatchObject({ code: 'invalid_thread_journal' });
    expect(readFileSync(file)).toEqual(original);
    expect(readFileSync(displaced)).toEqual(original);

    await fixture.journal.releaseWriteLease();
    await fixture.workspace.releaseSupervisorLease(fixture.lease);
    await fixture.workspace.close();
  });

  test('isolates a failed incremental batch and lazily initializes an unloaded writer', async () => {
    const fixture = await createJournalFixture();
    const prepare = mailboxPrepare(
      'op_e_66666666666666666666666666666666' as ExternalOpId,
      fixture.workspaceId,
      fixture.threadId,
    );

    await expect(fixture.journal.append([prepare, prepare], { flush: true }))
      .rejects.toMatchObject({ code: 'invalid_thread_journal' });
    expect(await fixture.journal.load()).toHaveLength(1);
    await fixture.journal.append([prepare], { flush: true });
    expect(await fixture.journal.load()).toHaveLength(2);

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

  test('persists canonical policy grants with exact receipt idempotency across reopen', async () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, 'cwd');
    const workspaceId = 'ws_file_policy_grants' as WorkspaceId;
    const first = await createFileRuntimeStorage({ root }).openWorkspace({ cwd, workspaceId });
    const firstLease = await first.acquireSupervisorLease('file-policy-first');
    const firstRepository = await first.openPolicyGrantRepository(firstLease, 'workspace');
    const initialRevision = (await firstRepository.snapshot()).revision;
    const grant = policyGrant(workspaceId, 'op_e_c1000000000000000000000000000001');

    const applied = await firstRepository.commitAllowAlways(grant);
    expect(applied).toMatchObject({ kind: 'applied' });
    expect(applied.kind === 'applied' && applied.revision).not.toBe(initialRevision);
    expect(await firstRepository.commitAllowAlways(grant)).toEqual({
      kind: 'duplicate',
      revision: applied.kind === 'applied' ? applied.revision : '',
    });
    expect(await firstRepository.commitAllowAlways({ ...grant, policyBasisRevision: 'changed' }))
      .toMatchObject({
        kind: 'conflict',
        revision: applied.kind === 'applied' ? applied.revision : '',
      });
    await firstRepository.close();
    await first.releaseSupervisorLease(firstLease);
    await first.close();

    const second = await createFileRuntimeStorage({ root }).openWorkspace({ cwd, workspaceId });
    const secondLease = await second.acquireSupervisorLease('file-policy-second');
    const secondRepository = await second.openPolicyGrantRepository(secondLease, 'workspace');
    const recovered = await secondRepository.snapshot();
    expect(recovered).toMatchObject({
      workspaceId,
      revision: applied.kind === 'applied' ? applied.revision : '',
      grants: [grant],
    });
    expectDeepFrozen(recovered);
    expect(await secondRepository.commitAllowAlways(grant)).toMatchObject({ kind: 'duplicate' });
    await secondRepository.close();
    await second.releaseSupervisorLease(secondLease);
    await second.close();
  });

  test('fences invalid policy grant writers and fails closed on canonical store corruption', async () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, 'cwd');
    const workspaceId = 'ws_file_policy_fencing' as WorkspaceId;
    const first = await createFileRuntimeStorage({ root }).openWorkspace({ cwd, workspaceId });
    const firstLease = await first.acquireSupervisorLease('file-policy-fencing-first');
    const repository = await first.openPolicyGrantRepository(firstLease, 'workspace');

    expect(await repository.commitAllowAlways(policyGrant(
      'ws_file_policy_other' as WorkspaceId,
      'op_e_c2000000000000000000000000000002',
    ))).toMatchObject({ kind: 'fenced', code: 'wrong_workspace' });
    await expect(repository.commitAllowAlways({
      ...policyGrant(workspaceId, 'op_e_c3000000000000000000000000000003'),
      scope: { kind: 'legacy_global_approvals_v1', patterns: ['bash:*'] },
    })).rejects.toMatchObject({ code: 'invalid_policy_grant' });
    await expect(first.openPolicyGrantRepository(firstLease, 'legacy_global_approvals_v1'))
      .rejects.toMatchObject({ code: 'legacy_approval_storage_unavailable' });

    await first.releaseSupervisorLease(firstLease);
    expect(await repository.commitAllowAlways(policyGrant(
      workspaceId,
      'op_e_c4000000000000000000000000000004',
    ))).toMatchObject({ kind: 'fenced', code: 'stale_fence' });
    await repository.close();
    await first.close();

    const grantFile = path.join(workspacePath(root, workspaceId), 'policy-grants.json');
    writeFileSync(grantFile, `${JSON.stringify({ version: 1, workspaceId, grants: [{ invalid: true }] })}\n`);
    const second = await createFileRuntimeStorage({ root }).openWorkspace({ cwd, workspaceId });
    const secondLease = await second.acquireSupervisorLease('file-policy-fencing-second');
    await expect(second.openPolicyGrantRepository(secondLease, 'workspace'))
      .rejects.toMatchObject({ code: 'invalid_policy_grant_store' });
    await second.releaseSupervisorLease(secondLease);
    await second.close();
  });

  test('reports a pre-rename policy grant storage failure as definitely not applied', async () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, 'cwd');
    const workspaceId = 'ws_file_policy_not_applied' as WorkspaceId;
    const workspace = await createFileRuntimeStorage({ root }).openWorkspace({ cwd, workspaceId });
    const lease = await workspace.acquireSupervisorLease('file-policy-not-applied');
    const repository = await workspace.openPolicyGrantRepository(lease, 'workspace');
    const initial = await repository.snapshot();
    const workspaceDir = workspacePath(root, workspaceId);
    const originalMode = statSync(workspaceDir).mode & 0o777;
    let result;
    try {
      chmodSync(workspaceDir, 0o500);
      result = await repository.commitAllowAlways(policyGrant(
        workspaceId,
        'op_e_c5000000000000000000000000000005',
      ));
    } finally {
      chmodSync(workspaceDir, originalMode);
    }
    expect(result).toMatchObject({ kind: 'definitely_not_applied' });
    expect(await repository.snapshot()).toMatchObject({ revision: initial.revision, grants: [] });

    await repository.close();
    await workspace.releaseSupervisorLease(lease);
    await workspace.close();
  });

  test('persists exact legacy-global policy grants and projects the shared pattern snapshot', async () => {
    const root = temporaryDirectory();
    const approvals = path.join(root, 'approvals.json');
    const cwd = path.join(root, 'cwd');
    const workspaceId = 'ws_file_legacy_policy_grants' as WorkspaceId;
    const storage = createFileRuntimeStorage({ root, legacyApprovalFile: approvals });
    const first = await storage.openWorkspace({ cwd, workspaceId });
    const firstLease = await first.acquireSupervisorLease('legacy-policy-first');
    const firstRepository = await first.openPolicyGrantRepository(
      firstLease,
      'legacy_global_approvals_v1',
    );
    const grant = legacyPolicyGrant(
      workspaceId,
      'op_e_c6000000000000000000000000000006',
    );

    const applied = await firstRepository.commitAllowAlways(grant);
    expect(applied).toMatchObject({ kind: 'applied' });
    expect(await firstRepository.commitAllowAlways(grant)).toMatchObject({ kind: 'duplicate' });
    expect(await firstRepository.commitAllowAlways({
      ...grant,
      policyBasisRevision: 'changed',
    })).toMatchObject({ kind: 'conflict' });
    expect(await firstRepository.snapshot()).toMatchObject({
      workspaceId,
      grants: [grant],
      legacyGlobal: { patterns: ['bash:bun test'] },
    });
    await expect(firstRepository.commitAllowAlways(policyGrant(
      workspaceId,
      'op_e_c7000000000000000000000000000007',
    ))).rejects.toMatchObject({ code: 'invalid_policy_grant' });
    await firstRepository.close();
    await first.releaseSupervisorLease(firstLease);
    await first.close();

    const second = await storage.openWorkspace({ cwd, workspaceId });
    const secondLease = await second.acquireSupervisorLease('legacy-policy-second');
    const secondRepository = await second.openPolicyGrantRepository(
      secondLease,
      'legacy_global_approvals_v1',
    );
    expect(await secondRepository.snapshot()).toMatchObject({ grants: [grant] });
    expect(await secondRepository.commitAllowAlways(grant)).toMatchObject({ kind: 'duplicate' });
    const legacyPatterns = await second.openLegacyApprovalPatternRepository(secondLease);
    expect(await legacyPatterns.snapshot()).toMatchObject({ patterns: ['bash:bun test'] });
    await legacyPatterns.close();
    await secondRepository.close();
    await second.releaseSupervisorLease(secondLease);
    await second.close();
  });

  test('linearizes one grant receipt key across concurrent workspace and legacy-global repositories', async () => {
    for (const firstMode of ['workspace', 'legacy_global_approvals_v1'] as const) {
      const root = temporaryDirectory();
      const approvals = path.join(root, 'approvals.json');
      const cwd = path.join(root, 'cwd');
      const workspaceId = `ws_file_cross_mode_${firstMode}` as WorkspaceId;
      const workspace = await createFileRuntimeStorage({ root, legacyApprovalFile: approvals })
        .openWorkspace({ cwd, workspaceId });
      const lease = await workspace.acquireSupervisorLease(`cross-mode-${firstMode}`);
      const workspaceRepository = await workspace.openPolicyGrantRepository(lease, 'workspace');
      const legacyRepository = await workspace.openPolicyGrantRepository(
        lease,
        'legacy_global_approvals_v1',
      );
      const grantId = 'op_e_c6000000000000000000000000000006';
      const canonical = policyGrant(workspaceId, grantId);
      const legacy = legacyPolicyGrant(workspaceId, grantId);

      const results = firstMode === 'workspace'
        ? await Promise.all([
            workspaceRepository.commitAllowAlways(canonical),
            legacyRepository.commitAllowAlways(legacy),
          ])
        : await Promise.all([
            legacyRepository.commitAllowAlways(legacy),
            workspaceRepository.commitAllowAlways(canonical),
          ]);
      expect(results.map((result) => result.kind).sort()).toEqual(['applied', 'conflict']);
      expect((await workspaceRepository.snapshot()).grants).toEqual(
        firstMode === 'workspace' ? [canonical] : [],
      );
      expect((await legacyRepository.snapshot()).grants).toEqual(
        firstMode === 'legacy_global_approvals_v1' ? [legacy] : [],
      );

      await legacyRepository.close();
      await workspaceRepository.close();
      await workspace.releaseSupervisorLease(lease);
      await workspace.close();
    }
  });

  test('validates and persists legacy patterns in UTF-8 byte order', async () => {
    const root = temporaryDirectory();
    const approvals = path.join(root, 'approvals.json');
    const cwd = path.join(root, 'cwd');
    const workspaceId = 'ws_file_utf8_legacy_patterns' as WorkspaceId;
    const workspace = await createFileRuntimeStorage({ root, legacyApprovalFile: approvals })
      .openWorkspace({ cwd, workspaceId });
    const lease = await workspace.acquireSupervisorLease('file-utf8-legacy-patterns');
    const repository = await workspace.openPolicyGrantRepository(
      lease,
      'legacy_global_approvals_v1',
    );
    const patterns = ['\uE000', '𐀀'] as const;
    const wrongUtf16Order = [patterns[1], patterns[0]] as const;
    const grant = {
      ...legacyPolicyGrant(workspaceId, 'op_e_c7000000000000000000000000000007'),
      scope: { kind: 'legacy_global_approvals_v1' as const, patterns },
    };

    await expect(repository.commitAllowAlways({
      ...grant,
      grantId: 'op_e_c8000000000000000000000000000008' as ExternalOpId,
      scope: { ...grant.scope, patterns: wrongUtf16Order },
    })).rejects.toMatchObject({ code: 'invalid_policy_grant' });
    expect(await repository.commitAllowAlways(grant)).toMatchObject({ kind: 'applied' });
    expect(JSON.parse(readFileSync(approvals, 'utf8'))).toEqual(patterns);
    expect((await repository.snapshot()).legacyGlobal?.patterns).toEqual(patterns);

    await repository.close();
    await workspace.releaseSupervisorLease(lease);
    await workspace.close();
  });

  test('recovers a reserved legacy-global policy grant without misclassifying it as phase-2 work', async () => {
    const root = temporaryDirectory();
    const approvals = path.join(root, 'approvals.json');
    const cwd = path.join(root, 'cwd');
    const workspaceId = 'ws_file_legacy_policy_recovery' as WorkspaceId;
    const storage = createFileRuntimeStorage({ root, legacyApprovalFile: approvals });
    const first = await storage.openWorkspace({ cwd, workspaceId });
    const firstLease = await first.acquireSupervisorLease('legacy-policy-reserve');
    const initialized = await first.openPolicyGrantRepository(
      firstLease,
      'legacy_global_approvals_v1',
    );
    await initialized.close();
    await first.releaseSupervisorLease(firstLease);
    await first.close();

    const grant = legacyPolicyGrant(
      workspaceId,
      'op_e_c8000000000000000000000000000008',
    );
    const outboxFile = path.join(
      workspacePath(root, workspaceId),
      'legacy-approval-outbox.json',
    );
    writeFileSync(outboxFile, `${JSON.stringify({
      version: 1,
      receipts: [{
        responseOpId: grant.grantId,
        acceptedAt: grant.acceptedAt,
        patterns: grant.scope.kind === 'legacy_global_approvals_v1'
          ? grant.scope.patterns
          : [],
        state: 'reserved',
        policyGrant: grant,
      }],
    })}\n`);

    const second = await storage.openWorkspace({ cwd, workspaceId });
    const secondLease = await second.acquireSupervisorLease('legacy-policy-recover');
    expect(await second.inspectLegacyApprovalRecovery(secondLease)).toEqual({
      hasPendingReservedOutbox: false,
    });
    expect(existsSync(approvals)).toBe(false);
    const recovered = await second.openPolicyGrantRepository(
      secondLease,
      'legacy_global_approvals_v1',
    );
    expect(await second.inspectLegacyApprovalRecovery(secondLease)).toEqual({
      hasPendingReservedOutbox: false,
    });
    expect(await recovered.snapshot()).toMatchObject({
      grants: [grant],
      legacyGlobal: { patterns: ['bash:bun test'] },
    });
    await recovered.close();
    await second.releaseSupervisorLease(secondLease);
    await second.close();
  });

  test('commits legacy approval patterns once per exact workspace receipt and fences closed writers', async () => {
    const root = temporaryDirectory();
    const approvals = path.join(root, 'approvals.json');
    const cwd = path.join(root, 'cwd');
    const workspaceId = 'ws_legacy_approval_receipt' as WorkspaceId;
    const storage = createFileRuntimeStorage({ root, legacyApprovalFile: approvals });
    const workspace = await storage.openWorkspace({ cwd, workspaceId });
    const lease = await workspace.acquireSupervisorLease('legacy-approval-receipt');
    const repository = await workspace.openLegacyApprovalPatternRepository?.(lease);
    if (repository === undefined) throw new Error('legacy approval repository unavailable');
    const input = {
      responseOpId: 'op_e_a1000000000000000000000000000001' as ExternalOpId,
      acceptedAt: 10,
      patterns: ['bash:npm *', 'edit:/workspace/**'] as const,
    };
    expect((await repository.commit(input)).kind).toBe('applied');
    expect((await repository.commit(input)).kind).toBe('duplicate');
    expect(await repository.commit({ ...input, acceptedAt: 11 })).toMatchObject({ kind: 'conflict' });
    expect(JSON.parse(readFileSync(approvals, 'utf8'))).toEqual([
      'bash:npm *',
      'edit:/workspace/**',
    ]);
    await repository.close();
    expect(await repository.commit(input)).toMatchObject({ kind: 'fenced', code: 'stale_fence' });
    await workspace.releaseSupervisorLease(lease);
    await workspace.close();
  });

  test('reports a post-rename legacy outbox fsync failure as an unknown outcome', async () => {
    const root = temporaryDirectory();
    const moduleUrl = pathToFileURL(path.join(import.meta.dir, 'file-storage.ts')).href;
    const childCode = `
      const { mock } = await import('bun:test');
      const actualFs = await import('node:fs');
      const nativeFsyncSync = actualFs.fsyncSync;
      const nativeFstatSync = actualFs.fstatSync;
      const nativeReadFileSync = actualFs.readFileSync;
      let faultArmed = false;
      mock.module('node:fs', () => ({
        ...actualFs,
        fsyncSync(fd) {
          if (faultArmed && nativeFstatSync(fd).isDirectory()) {
            faultArmed = false;
            const error = new Error('injected post-rename directory fsync failure');
            error.code = 'EIO';
            throw error;
          }
          return nativeFsyncSync(fd);
        },
      }));
      const { createFileRuntimeStorage } = await import(${JSON.stringify(moduleUrl)});
      const { sha256Hex } = await import(${JSON.stringify(
        pathToFileURL(path.join(import.meta.dir, '../protocol/index.ts')).href,
      )});
      const path = await import('node:path');
      const storageRoot = path.join(${JSON.stringify(root)}, 'storage');
      const approvals = path.join(${JSON.stringify(root)}, 'approvals.json');
      const cwd = path.join(${JSON.stringify(root)}, 'cwd');
      const workspaceId = 'ws_legacy_post_rename_unknown';
      const storage = createFileRuntimeStorage({ root: storageRoot, legacyApprovalFile: approvals });
      const workspace = await storage.openWorkspace({ cwd, workspaceId });
      const lease = await workspace.acquireSupervisorLease('legacy-post-rename-unknown');
      const repository = await workspace.openLegacyApprovalPatternRepository(lease);
      faultArmed = true;
      let resultKind;
      let errorCode;
      try {
        const result = await repository.commit({
          responseOpId: 'op_e_a4000000000000000000000000000004',
          acceptedAt: 40,
          patterns: ['bash:bun test'],
        });
        resultKind = result.kind;
      } catch (error) {
        resultKind = 'rejected';
        errorCode = error?.code;
      }
      const outboxFile = path.join(
        storageRoot,
        'ws-' + sha256Hex(workspaceId),
        'legacy-approval-outbox.json',
      );
      const outbox = JSON.parse(nativeReadFileSync(outboxFile, 'utf8'));
      await repository.close();
      await workspace.releaseSupervisorLease(lease);
      await workspace.close();
      console.log(JSON.stringify({
        resultKind,
        errorCode,
        receiptState: outbox.receipts[0]?.state,
      }));
      process.exit(0);
    `;
    const child = Bun.spawn([process.execPath, '-e', childCode], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });
    expect(JSON.parse(stdout)).toEqual({
      resultKind: 'rejected',
      errorCode: 'legacy_approval_commit_outcome_unknown',
      receiptState: 'reserved',
    });
  });

  test('waits through ordinary global approval lock contention instead of degrading the workspace', async () => {
    const root = temporaryDirectory();
    const approvals = path.join(root, 'approvals.json');
    const workspaceId = 'ws_legacy_approval_lock_wait' as WorkspaceId;
    const workspace = await createFileRuntimeStorage({ root, legacyApprovalFile: approvals })
      .openWorkspace({ cwd: path.join(root, 'cwd'), workspaceId });
    const lease = await workspace.acquireSupervisorLease('legacy-approval-lock-wait');
    const repository = await workspace.openLegacyApprovalPatternRepository?.(lease);
    if (repository === undefined) throw new Error('legacy approval repository unavailable');
    const lockFile = `${approvals}.lock`;
    writeFileSync(lockFile, `${JSON.stringify({ version: 1, pid: process.pid, nonce: 'held-by-test' })}\n`);
    const release = setTimeout(() => { unlinkSync(lockFile); }, 40);

    try {
      await expect(repository.commit({
        responseOpId: 'op_e_a3000000000000000000000000000003' as ExternalOpId,
        acceptedAt: 30,
        patterns: ['bash:bun test'] as const,
      })).resolves.toMatchObject({ kind: 'applied' });
    } finally {
      clearTimeout(release);
    }
    await repository.close();
    await workspace.releaseSupervisorLease(lease);
    await workspace.close();
  });

  test('a lease lost while waiting for the global approval lock cannot update the shared Set', async () => {
    const root = temporaryDirectory();
    const approvals = path.join(root, 'approvals.json');
    const workspaceId = 'ws_legacy_approval_stale_waiter' as WorkspaceId;
    const workspace = await createFileRuntimeStorage({ root, legacyApprovalFile: approvals })
      .openWorkspace({ cwd: path.join(root, 'cwd'), workspaceId });
    const lease = await workspace.acquireSupervisorLease('legacy-approval-stale-waiter');
    const repository = await workspace.openLegacyApprovalPatternRepository?.(lease);
    if (repository === undefined) throw new Error('legacy approval repository unavailable');
    const lockFile = `${approvals}.lock`;
    writeFileSync(lockFile, `${JSON.stringify({ version: 1, pid: process.pid, nonce: 'held-by-test' })}\n`);

    const pending = repository.commit({
      responseOpId: 'op_e_a3000000000000000000000000000004' as ExternalOpId,
      acceptedAt: 31,
      patterns: ['bash:bun test stale'] as const,
    });
    await workspace.releaseSupervisorLease(lease);
    unlinkSync(lockFile);

    await expect(pending).resolves.toMatchObject({ kind: 'fenced', code: 'stale_fence' });
    expect(existsSync(approvals)).toBe(false);
    await repository.close();
    await workspace.close();
  });

  test('replays a reserved pattern outbox before returning the recovery repository', async () => {
    const root = temporaryDirectory();
    const approvals = path.join(root, 'approvals.json');
    const cwd = path.join(root, 'cwd');
    const workspaceId = 'ws_legacy_approval_recovery' as WorkspaceId;
    const storage = createFileRuntimeStorage({ root, legacyApprovalFile: approvals });
    const first = await storage.openWorkspace({ cwd, workspaceId });
    const firstLease = await first.acquireSupervisorLease('legacy-approval-crash-first');
    const firstRepository = await first.openLegacyApprovalPatternRepository?.(firstLease);
    await firstRepository?.close();
    await first.releaseSupervisorLease(firstLease);
    await first.close();

    const responseOpId = 'op_e_a2000000000000000000000000000002' as ExternalOpId;
    writeFileSync(path.join(workspacePath(root, workspaceId), 'legacy-approval-outbox.json'), `${JSON.stringify({
      version: 1,
      receipts: [{
        responseOpId,
        acceptedAt: 20,
        patterns: ['bash:bun test', 'edit:/project/**'],
        state: 'reserved',
      }],
    })}\n`);
    // Existing behavior is intentionally tolerant: a corrupt global Set is treated as empty,
    // then the fenced reserved outbox repairs it before any Runtime attachment can start.
    writeFileSync(approvals, '{bad json');

    const second = await storage.openWorkspace({ cwd, workspaceId });
    const secondLease = await second.acquireSupervisorLease('legacy-approval-crash-second');
    expect(await second.inspectLegacyApprovalRecovery(secondLease)).toEqual({
      hasPendingReservedOutbox: true,
    });
    const recovered = await second.openLegacyApprovalPatternRepository?.(secondLease);
    if (recovered === undefined) throw new Error('legacy approval repository unavailable');
    expect(recovered.startupDiagnostics?.()).toEqual([{
      code: 'legacy_approvals_invalid_ignored',
      message: 'Invalid legacy approvals file was ignored and treated as an empty pattern Set',
    }]);
    expect((await recovered.snapshot()).patterns).toEqual([
      'bash:bun test',
      'edit:/project/**',
    ]);
    expect(await second.inspectLegacyApprovalRecovery(secondLease)).toEqual({
      hasPendingReservedOutbox: false,
    });
    const outbox = JSON.parse(
      readFileSync(path.join(workspacePath(root, workspaceId), 'legacy-approval-outbox.json'), 'utf8'),
    ) as { receipts: Array<{ state: string }> };
    expect(outbox.receipts[0]?.state).toBe('applied');
    await recovered.close();
    await second.releaseSupervisorLease(secondLease);
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

  test('persists and validates the immutable retry prompt selected by the root ledger op', async () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, 'cwd');
    const workspaceId = 'ws_retry_prompt_freeze' as WorkspaceId;
    const sourceThreadId = 'thread-retry-source' as ThreadId;
    const targetThreadId = 'thread-retry-target' as ThreadId;
    const opId = 'op_e_d1000000000000000000000000000001' as ExternalOpId;
    const retryPromptOpId = 'op_e_d2000000000000000000000000000002' as ExternalOpId;
    const text = 'frozen retry prompt';
    const op = {
      type: 'conversation_retry' as const,
      opId,
      workspaceId,
      sourceThreadId,
      threadId: targetThreadId,
      model: { provider: 'faux', api: 'faux', model: 'test' },
    };
    const reserved = {
      opId,
      op,
      payloadHash: runtimeOpPayloadHash(op),
      driverCreation: { creationKey: 'retry-freeze-key' },
      retryPromptOpId,
      retryPrompt: {
        messageId: 'message-retry-source',
        turnId: 'turn-retry-source' as import('../protocol/index.js').TurnId,
        text,
        digest: sha256Hex(text),
      },
      state: 'reserved' as const,
    };
    const storage = createFileRuntimeStorage({ root });
    const workspace = await storage.openWorkspace({ cwd, workspaceId });
    const lease = await workspace.acquireSupervisorLease('retry-freeze');
    await workspace.reserveSupervisorOp(lease, reserved);
    expect((await workspace.loadSupervisorOps())[0]).toEqual(reserved);
    await workspace.releaseSupervisorLease(lease);
    await workspace.close();

    const reopened = await storage.openWorkspace({ cwd, workspaceId });
    const reopenedLease = await reopened.acquireSupervisorLease('retry-freeze-reopen');
    expect((await reopened.loadSupervisorOps())[0]?.retryPrompt).toEqual(reserved.retryPrompt);
    await reopened.releaseSupervisorLease(reopenedLease);
    await reopened.close();

    const ledgerPath = path.join(workspacePath(root, workspaceId), 'ledger.json');
    const corrupted = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    corrupted.ops[0].retryPrompt.text = 'changed after reservation';
    writeFileSync(ledgerPath, `${JSON.stringify(corrupted)}\n`);
    const invalid = await storage.openWorkspace({ cwd, workspaceId });
    await expect(invalid.acquireSupervisorLease('retry-freeze-invalid'))
      .rejects.toMatchObject({ code: 'invalid_supervisor_op' });
    await invalid.close();
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
    expect(imported?.seed.turnProvenance).toEqual([{
      messageId: 'u1',
      turnId: expect.stringMatching(/^turn_seed_v1_[0-9a-f]{64}$/),
    }]);
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

function policyGrant(workspaceId: WorkspaceId, grantId: string): PolicyGrant {
  return {
    grantId: grantId as ExternalOpId,
    workspaceId,
    capabilityId: 'bash',
    capabilityVersion: '1.0.0',
    registrationDigest: `capreg_v1_${'2'.repeat(64)}`,
    scope: {
      kind: 'canonical_resources_v1',
      resourcePatterns: [{
        resourceType: 'command',
        access: 'execute',
        matcher: 'canonical_target_exact_v1',
        pattern: 'bun test',
      }],
      attributes: { confirmation: 'required' },
    },
    policyBasisRevision: 'policy-basis-v1',
    acceptedAt: 20,
  };
}

function legacyPolicyGrant(workspaceId: WorkspaceId, grantId: string): PolicyGrant {
  return {
    ...policyGrant(workspaceId, grantId),
    scope: {
      kind: 'legacy_global_approvals_v1',
      patterns: ['bash:bun test'],
    },
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
