import { describe, expect, test } from 'bun:test';
import type { PolicyGrant } from '../capabilities/types.js';
import type { ExternalOpId, ThreadId, TurnId, WorkspaceId } from '../protocol/index.js';
import type { ThreadMetaRecord, ThreadSeedRecord } from './ports.js';
import { createMemoryRuntimeStorage } from './memory-storage.js';

describe('MemoryRuntimeStorage canonical persistence', () => {
  test('commits a workspace policy grant exactly once and fences stale writers', async () => {
    const storage = createMemoryRuntimeStorage();
    const workspaceId = 'ws_memory_policy_grants' as WorkspaceId;
    const workspace = await storage.openWorkspace({ cwd: '/workspace', workspaceId });
    const lease = await workspace.acquireSupervisorLease('memory-policy-grants');
    const repository = await workspace.openPolicyGrantRepository(lease);
    const initial = await repository.snapshot();
    const grant = policyGrant(workspaceId, 'op_e_b1000000000000000000000000000001');

    const applied = await repository.commitAllowAlways(grant);
    expect(applied).toMatchObject({ kind: 'applied' });
    expect(applied.kind === 'applied' && applied.revision).not.toBe(initial.revision);
    expect(await repository.commitAllowAlways(grant)).toEqual({
      kind: 'duplicate',
      revision: applied.kind === 'applied' ? applied.revision : '',
    });
    expect(await repository.commitAllowAlways({ ...grant, acceptedAt: grant.acceptedAt + 1 }))
      .toMatchObject({ kind: 'conflict' });
    expect(await repository.commitAllowAlways(policyGrant(
      'ws_different_policy_scope' as WorkspaceId,
      'op_e_b2000000000000000000000000000002',
    ))).toMatchObject({ kind: 'fenced', code: 'wrong_workspace' });

    const current = await repository.snapshot();
    expect(current.grants).toEqual([grant]);
    expectDeepFrozen(current);

    await workspace.releaseSupervisorLease(lease);
    const successor = await workspace.acquireSupervisorLease('memory-policy-successor');
    expect(await repository.commitAllowAlways(policyGrant(
      workspaceId,
      'op_e_b3000000000000000000000000000003',
    ))).toMatchObject({ kind: 'fenced', code: 'stale_fence' });
    await repository.close();
    await workspace.releaseSupervisorLease(successor);
    await workspace.close();
  });

  test('accepts only canonical resource scopes in UTF-8 byte order', async () => {
    const storage = createMemoryRuntimeStorage();
    const workspaceId = 'ws_memory_policy_scope' as WorkspaceId;
    const workspace = await storage.openWorkspace({ cwd: '/workspace', workspaceId });
    const lease = await workspace.acquireSupervisorLease('memory-policy-scope');
    const repository = await workspace.openPolicyGrantRepository(lease);
    const initialRevision = (await repository.snapshot()).revision;
    const first = resourcePattern('\uE000');
    const second = resourcePattern('𐀀');
    const base = policyGrant(workspaceId, 'op_e_b4000000000000000000000000000004');

    await expect(repository.commitAllowAlways({
      ...base,
      scope: {
        kind: 'canonical_resources_v1',
        resourcePatterns: [second, first],
        attributes: {},
      },
    })).rejects.toMatchObject({ code: 'invalid_policy_grant' });
    await expect(repository.commitAllowAlways({
      ...base,
      scope: { kind: 'removed_scope' },
    } as unknown as PolicyGrant)).rejects.toMatchObject({ code: 'invalid_policy_grant' });
    expect(await repository.snapshot()).toMatchObject({ revision: initialRevision, grants: [] });

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

  test('stores only canonical thread metadata, seed records, and catalog locators', async () => {
    const storage = createMemoryRuntimeStorage();
    const workspaceId = 'ws_memory_thread_seed' as WorkspaceId;
    const threadId = 'thread-memory-seed' as ThreadId;
    const workspace = await storage.openWorkspace({ cwd: '/workspace', workspaceId });
    const lease = await workspace.acquireSupervisorLease('memory-thread-seed');
    const meta: ThreadMetaRecord = {
      type: 'thread_meta',
      version: 3,
      protocolVersion: '2.0.0',
      workspaceId,
      threadId,
      permissionCeiling: { revision: 'test', constraints: [] },
      createdAt: 1,
      cwd: '/workspace',
      model: { provider: 'faux', api: 'faux', model: 'test' },
    };
    const seed: ThreadSeedRecord = {
      type: 'thread_seed',
      transcript: [{
        role: 'user',
        id: 'message-seed',
        timestamp: 1,
        source: 'prompt',
        content: [{ type: 'text', text: 'seed' }],
      }],
      turnProvenance: [{
        messageId: 'message-seed',
        turnId: 'turn-memory-seed' as TurnId,
      }],
      usage: { cumulative: { input: 0, output: 0 }, turns: 0, contextTokens: 0 },
    };

    const journal = await workspace.createThreadJournal(lease, {
      threadId,
      meta,
      initialRecords: [seed],
    });
    const state = await journal.loadState();
    expect(state.meta).toEqual(meta);
    expect(state.checkpoint.frontend.transcript).toEqual(seed.transcript);
    expect([...state.messageTurnIds]).toEqual(seed.turnProvenance.map((entry) => [
      entry.messageId,
      entry.turnId,
    ]));
    expect(await workspace.listThreads()).toEqual([{
      summary: { threadId, createdAt: 1, state: 'idle' },
      format: 'runtime-v2',
      storageKey: `memory:${workspaceId}:${threadId}`,
      meta,
      journal: {
        version: 3,
        size: 2,
        snapshotSize: 2,
        highWaterSeq: 0,
        replayStartSeq: 1,
        recoveryRequired: false,
      },
      updatedAt: 1,
    }]);
    expect(await storage.listStoredThreads()).toEqual([{
      ownerWorkspaceId: workspaceId,
      ownerRecordedCwd: '/workspace',
      threadId,
      catalog: (await workspace.listThreads())[0]!,
    }]);

    await workspace.releaseSupervisorLease(lease);
    await workspace.close();
  });
});

function policyGrant(workspaceId: WorkspaceId, grantId: string): PolicyGrant {
  return {
    grantId: grantId as ExternalOpId,
    workspaceId,
    capabilityId: 'bash',
    capabilityVersion: '1.0.0',
    registrationDigest: `capreg_v1_${'1'.repeat(64)}`,
    scope: {
      kind: 'canonical_resources_v1',
      resourcePatterns: [resourcePattern('npm test')],
      attributes: { confirmation: 'required' },
    },
    policyBasisRevision: 'policy-basis-v1',
    acceptedAt: 10,
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
