import { describe, expect, test } from 'bun:test';
import type { PolicyGrant } from '../capabilities/types.js';
import type { ExternalOpId, WorkspaceId } from '../protocol/index.js';
import { createMemoryRuntimeStorage } from './memory-storage.js';

describe('MemoryRuntimeStorage policy grants', () => {
  test('commits a canonical grant exactly once and retains the receipt on conflict', async () => {
    const storage = createMemoryRuntimeStorage();
    const workspaceId = 'ws_memory_policy_grants' as WorkspaceId;
    const workspace = await storage.openWorkspace({ cwd: '/workspace', workspaceId });
    const lease = await workspace.acquireSupervisorLease('memory-policy-grants');
    const repository = await workspace.openPolicyGrantRepository(lease, 'workspace');
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
      .toMatchObject({
        kind: 'conflict',
        revision: applied.kind === 'applied' ? applied.revision : '',
      });

    const current = await repository.snapshot();
    expect(current.grants).toEqual([grant]);
    expect(current.revision).toBe(applied.kind === 'applied' ? applied.revision : '');
    expectDeepFrozen(current);

    await repository.close();
    expect(await repository.commitAllowAlways(grant)).toMatchObject({
      kind: 'fenced',
      code: 'stale_fence',
    });
    await workspace.releaseSupervisorLease(lease);
    await workspace.close();
  });

  test('rejects cross-workspace and non-canonical grants without reserving a receipt', async () => {
    const storage = createMemoryRuntimeStorage();
    const workspaceId = 'ws_memory_policy_scope' as WorkspaceId;
    const workspace = await storage.openWorkspace({ cwd: '/workspace', workspaceId });
    const lease = await workspace.acquireSupervisorLease('memory-policy-scope');
    const repository = await workspace.openPolicyGrantRepository(lease, 'workspace');
    const initialRevision = (await repository.snapshot()).revision;

    expect(await repository.commitAllowAlways(policyGrant(
      'ws_different_policy_scope' as WorkspaceId,
      'op_e_b2000000000000000000000000000002',
    ))).toMatchObject({ kind: 'fenced', code: 'wrong_workspace' });
    const legacyGrant: PolicyGrant = {
      ...policyGrant(workspaceId, 'op_e_b3000000000000000000000000000003'),
      scope: { kind: 'legacy_global_approvals_v1', patterns: ['bash:*'] },
    };
    await expect(repository.commitAllowAlways(legacyGrant)).rejects.toMatchObject({
      code: 'invalid_policy_grant',
    });
    expect(await repository.snapshot()).toMatchObject({ revision: initialRevision, grants: [] });
    const legacyRepository = await workspace.openPolicyGrantRepository(
      lease,
      'legacy_global_approvals_v1',
    );
    const legacy = legacyPolicyGrant(
      workspaceId,
      'op_e_b5000000000000000000000000000005',
    );
    expect(await legacyRepository.commitAllowAlways(legacy)).toMatchObject({ kind: 'applied' });
    expect(await legacyRepository.commitAllowAlways(legacy)).toMatchObject({ kind: 'duplicate' });
    expect(await legacyRepository.commitAllowAlways({
      ...legacy,
      capabilityVersion: 'changed',
    })).toMatchObject({ kind: 'conflict' });
    expect(await legacyRepository.snapshot()).toMatchObject({
      workspaceId,
      grants: [legacy],
      legacyGlobal: { patterns: ['bash:npm test'] },
    });
    await legacyRepository.close();

    await workspace.releaseSupervisorLease(lease);
    const successor = await workspace.acquireSupervisorLease('memory-policy-successor');
    expect(await repository.commitAllowAlways(policyGrant(
      workspaceId,
      'op_e_b4000000000000000000000000000004',
    ))).toMatchObject({ kind: 'fenced', code: 'stale_fence' });
    await repository.close();
    await workspace.releaseSupervisorLease(successor);
    await workspace.close();
  });

  test('uses UTF-8 byte order for every legacy approval pattern boundary', async () => {
    const storage = createMemoryRuntimeStorage();
    const workspaceId = 'ws_memory_utf8_legacy_patterns' as WorkspaceId;
    const workspace = await storage.openWorkspace({ cwd: '/workspace', workspaceId });
    const lease = await workspace.acquireSupervisorLease('memory-utf8-legacy-patterns');
    const patterns = ['\uE000', '𐀀'] as const;
    const wrongUtf16Order = [patterns[1], patterns[0]] as const;
    const policyRepository = await workspace.openPolicyGrantRepository(
      lease,
      'legacy_global_approvals_v1',
    );
    const grant = {
      ...legacyPolicyGrant(workspaceId, 'op_e_b6000000000000000000000000000006'),
      scope: { kind: 'legacy_global_approvals_v1' as const, patterns },
    };

    await expect(policyRepository.commitAllowAlways({
      ...grant,
      grantId: 'op_e_b7000000000000000000000000000007' as ExternalOpId,
      scope: { ...grant.scope, patterns: wrongUtf16Order },
    })).rejects.toMatchObject({ code: 'invalid_policy_grant' });
    expect(await policyRepository.commitAllowAlways(grant)).toMatchObject({ kind: 'applied' });
    expect((await policyRepository.snapshot()).legacyGlobal?.patterns).toEqual(patterns);

    const openLegacy = workspace.openLegacyApprovalPatternRepository;
    if (openLegacy === undefined) throw new Error('legacy approval repository unavailable');
    const legacyRepository = await openLegacy.call(workspace, lease);
    expect(await legacyRepository.commit({
      responseOpId: 'op_e_b8000000000000000000000000000008' as ExternalOpId,
      acceptedAt: 1,
      patterns,
    })).toMatchObject({ kind: 'applied' });
    await expect(legacyRepository.commit({
      responseOpId: 'op_e_b9000000000000000000000000000009' as ExternalOpId,
      acceptedAt: 1,
      patterns: wrongUtf16Order,
    })).rejects.toMatchObject({ code: 'invalid_legacy_approval_receipt' });
    expect((await legacyRepository.snapshot()).patterns).toEqual(patterns);

    await legacyRepository.close();
    await policyRepository.close();
    await workspace.releaseSupervisorLease(lease);
    await workspace.close();
  });
});

function legacyPolicyGrant(workspaceId: WorkspaceId, grantId: string): PolicyGrant {
  return {
    ...policyGrant(workspaceId, grantId),
    scope: {
      kind: 'legacy_global_approvals_v1',
      patterns: ['bash:npm test'],
    },
  };
}

function policyGrant(workspaceId: WorkspaceId, grantId: string): PolicyGrant {
  return {
    grantId: grantId as ExternalOpId,
    workspaceId,
    capabilityId: 'bash',
    capabilityVersion: '1.0.0',
    registrationDigest: `capreg_v1_${'1'.repeat(64)}`,
    scope: {
      kind: 'canonical_resources_v1',
      resourcePatterns: [{
        resourceType: 'command',
        access: 'execute',
        matcher: 'canonical_target_exact_v1',
        pattern: 'npm test',
      }],
      attributes: { confirmation: 'required' },
    },
    policyBasisRevision: 'policy-basis-v1',
    acceptedAt: 10,
  };
}

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}
