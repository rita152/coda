import { describe, expect, test } from 'bun:test';
import type {
  ExternalOpId,
  PermissionCeilingSnapshot,
  PolicyGrantScope,
  RunId,
  ThreadId,
  TurnId,
  WorkspaceId,
} from '../protocol/index.js';
import { createPolicyEngine } from './policy-engine.js';
import type {
  EffectivePolicySnapshot,
  PolicyDecision,
  PolicyGrant,
  PolicyGrantSnapshot,
  PreparedInvocation,
  RuleSnapshot,
  ThreadPolicyEngine,
  TurnPolicyContext,
} from './types.js';

const WORKSPACE = 'workspace-a' as WorkspaceId;
const OTHER_WORKSPACE = 'workspace-b' as WorkspaceId;
const THREAD = 'thread-a' as ThreadId;
const OTHER_THREAD = 'thread-b' as ThreadId;
const RUN = 'run-a' as RunId;
const TURN = 'turn-a' as TurnId;
const GRANT_ID = 'op_e_00000000000000000000000000000000' as ExternalOpId;

describe('conservative PolicyEngine', () => {
  test('captures detached frozen snapshots with stable basis and context-bound combined revisions', async () => {
    const engine = await openEngine();
    const firstContext = turnContext();
    const mutableFiles = [{
      path: '/workspace/AGENTS.md',
      scope: '/workspace',
      contentDigest: 'rules-digest',
      content: 'rules',
    }];
    const first = await engine.capture(captureInput({
      context: firstContext,
      rules: rules(firstContext, 'rules-v1', mutableFiles),
    }));

    mutableFiles[0]!.content = 'mutated after capture';
    expect(first.rules.files[0]?.content).toBe('rules');
    expectDeepFrozen(first);
    expect(first.ceilingRevision).toBe('turn-ceiling-v1');
    expect(first.policyBasisRevision).toBe(
      'policy_basis_v1_c5c8e4698bbe9edff59c6c87b7783a493644f151f7a2b0f416ccb29674a874ca',
    );
    expect(first.revision).toBe(
      'policy_v1_74570265f8ac00761fa22db14eff339c46d0079e515d65ccaf2bb27347cac0b6',
    );

    const nextContext = turnContext({ runId: 'run-b' as RunId, turnId: 'turn-b' as TurnId });
    const newIdentity = await engine.capture(captureInput({
      context: nextContext,
      rules: rules(nextContext, 'rules-v1'),
    }));
    expect(newIdentity.policyBasisRevision).toBe(first.policyBasisRevision);
    expect(newIdentity.revision).not.toBe(first.revision);

    const newGrants = await engine.capture(captureInput({
      context: nextContext,
      rules: rules(nextContext, 'rules-v1'),
      grants: grantSnapshot('grants-v2'),
    }));
    expect(newGrants.policyBasisRevision).toBe(first.policyBasisRevision);
    expect(newGrants.grantRevision).toBe('grants-v2');
    expect(newGrants.revision).not.toBe(newIdentity.revision);

    const newRules = await engine.capture(captureInput({
      context: nextContext,
      rules: rules(nextContext, 'rules-v2'),
      grants: grantSnapshot('grants-v2'),
    }));
    expect(newRules.policyBasisRevision).not.toBe(first.policyBasisRevision);

    const newCeiling = await engine.capture(captureInput({
      context: nextContext,
      rules: rules(nextContext, 'rules-v1'),
      turnCeiling: ceiling('turn-ceiling-v2', []),
      grants: grantSnapshot('grants-v2'),
    }));
    expect(newCeiling.policyBasisRevision).not.toBe(first.policyBasisRevision);

    const newConstraint = await engine.capture(captureInput({
      context: nextContext,
      rules: rules(nextContext, 'rules-v1'),
      workspaceCeiling: ceiling('workspace-ceiling-v1', [{ z: 1, a: true }]),
      grants: grantSnapshot('grants-v2'),
    }));
    expect(newConstraint.policyBasisRevision).not.toBe(first.policyBasisRevision);
  });

  test('binds explicit host configuration into the policy basis and rejects cross-config snapshots', async () => {
    const interactive = await createPolicyEngine({
      configuration: {
        kind: 'cli_legacy_policy_v1',
        approvalMode: 'interactive',
        projectRoot: '/workspace',
        analyzerVersion: 'v1',
      },
    }).openThread({ workspaceId: WORKSPACE, threadId: THREAD });
    const denied = await createPolicyEngine({
      configuration: {
        kind: 'cli_legacy_policy_v1',
        approvalMode: 'deny',
        projectRoot: '/workspace',
        analyzerVersion: 'v1',
      },
    }).openThread({ workspaceId: WORKSPACE, threadId: THREAD });
    const interactivePolicy = await interactive.capture(captureInput());
    const deniedPolicy = await denied.capture(captureInput());
    expect(interactivePolicy.policyBasisRevision).not.toBe(deniedPolicy.policyBasisRevision);
    expect(await denied.evaluate(invocation(interactivePolicy, { kind: 'read' }))).toMatchObject({
      kind: 'deny',
      code: 'invalid_policy_invocation',
    });
    await interactive.close();
    await denied.close();
  });

  test('allows safe kinds, asks for mutating kinds, and constructs only canonical frozen proposals', async () => {
    const engine = await openEngine();
    const policy = await engine.capture(captureInput());

    const readDecision = await engine.evaluate(invocation(policy, { kind: 'read' }));
    expect(readDecision).toMatchObject({ kind: 'allow', code: 'default_safe_capability' });
    expectDeepFrozen(readDecision);

    const editDecision = await engine.evaluate(invocation(policy, {
      kind: 'edit',
      attributes: { z: 2, a: { safe: true } },
      resources: [
        resource('destination', '/workspace/z.txt'),
        resource('source', '/workspace/a.txt'),
        resource('alias', '/workspace/a.txt'),
      ],
    }));
    expect(editDecision.kind).toBe('ask');
    if (editDecision.kind !== 'ask') throw new Error('Expected an approval decision');
    expect(editDecision.grantProposal).toEqual({
      kind: 'canonical_resources_v1',
      resourcePatterns: [
        {
          resourceType: 'filesystem',
          access: 'write',
          matcher: 'canonical_target_exact_v1',
          pattern: '/workspace/a.txt',
        },
        {
          resourceType: 'filesystem',
          access: 'write',
          matcher: 'canonical_target_exact_v1',
          pattern: '/workspace/z.txt',
        },
      ],
      attributes: { a: { safe: true }, z: 2 },
    });
    expectDeepFrozen(editDecision);

    const planDecision = await engine.evaluate(invocation(policy, {
      capabilityId: 'plan',
      kind: 'plan',
      resources: [],
    }));
    expect(planDecision).toMatchObject({ kind: 'allow' });

    const executeWithoutResources = await engine.evaluate(invocation(policy, {
      capabilityId: 'opaque-execute',
      kind: 'execute',
      resources: [],
    }));
    expect(executeWithoutResources).toMatchObject({ kind: 'ask' });
    expect(executeWithoutResources).not.toHaveProperty('grantProposal');

    const onceOnly = await engine.evaluate(invocation(policy, {
      capabilityId: 'opaque-once-only',
      kind: 'execute',
      args: { command: 'echo $(pwd)' },
      analysis: {
        resourceCoverage: {
          kind: 'incomplete',
          reasons: ['command substitution hides nested resources'],
        },
        grantability: {
          kind: 'once_only',
          reasons: ['command substitution cannot be persisted'],
        },
        safety: { kind: 'eligible' },
        attributes: {},
      },
    }));
    expect(onceOnly).toMatchObject({ kind: 'ask', code: 'approval_required' });
    expect(onceOnly).not.toHaveProperty('grantProposal');

    const unsafe = await engine.evaluate(invocation(policy, {
      capabilityId: 'unsafe-command',
      kind: 'execute',
      args: { command: 'danger' },
      analysis: {
        resourceCoverage: { kind: 'complete' },
        grantability: { kind: 'persistable' },
        safety: {
          kind: 'deny',
          code: 'capability_specific_denial',
          reason: 'The authoritative resolver denied this operation',
        },
        attributes: {},
      },
    }));
    expect(unsafe).toEqual({
      kind: 'deny',
      code: 'capability_specific_denial',
      reason: 'The authoritative resolver denied this operation',
      recoverable: true,
    });
  });

  test('fails closed on every non-empty unknown ceiling before grants or approval', async () => {
    const engine = await openEngine();
    const unknownConstraint = { version: 'future-v9', effect: 'allow' };
    const basis = await engine.capture(captureInput({
      turnCeiling: ceiling('turn-unknown', [unknownConstraint]),
    }));
    const pending = invocation(basis, { kind: 'edit' });
    const proposal: PolicyGrantScope = {
      kind: 'canonical_resources_v1',
      resourcePatterns: [{
        resourceType: 'filesystem',
        access: 'write',
        matcher: 'canonical_target_exact_v1',
        pattern: '/workspace/file.txt',
      }],
      attributes: {},
    };
    const grant = exactGrant(pending, basis, proposal);

    const policy = await engine.capture(captureInput({
      turnCeiling: ceiling('turn-unknown', [unknownConstraint]),
      grants: grantSnapshot('grants-v2', [grant]),
    }));
    const decision = await engine.evaluate(invocation(policy, { kind: 'edit' }));
    expect(decision).toEqual({
      kind: 'deny',
      code: 'unknown_permission_constraint',
      reason: 'The permission ceiling contains a constraint this policy engine does not recognize',
      recoverable: true,
    });
    expectDeepFrozen(decision);
  });

  test('allows only a complete exact grant bound to workspace, implementation, scope, and basis', async () => {
    const engine = await openEngine();
    const initialPolicy = await engine.capture(captureInput());
    const initialInvocation = invocation(initialPolicy, {
      kind: 'edit',
      attributes: { mode: 'replace' },
      resources: [resource('file', '/workspace/file.txt')],
    });
    const proposal = requireProposal(await engine.evaluate(initialInvocation));
    const grant = exactGrant(initialInvocation, initialPolicy, proposal);

    const grantedPolicy = await engine.capture(captureInput({
      grants: grantSnapshot('grants-v2', [grant]),
    }));
    const granted = await engine.evaluate(invocation(grantedPolicy, {
      kind: 'edit',
      attributes: { mode: 'replace' },
      resources: [resource('file', '/workspace/file.txt')],
    }));
    expect(granted).toMatchObject({ kind: 'allow', code: 'matching_policy_grant' });

    const differentTarget = await engine.evaluate(invocation(grantedPolicy, {
      kind: 'edit',
      attributes: { mode: 'replace' },
      args: { path: '/workspace/other.txt' },
      resources: [resource('file', '/workspace/other.txt')],
    }));
    expect(differentTarget).toMatchObject({ kind: 'ask', code: 'approval_required' });

    const differentAttributes = await engine.evaluate(invocation(grantedPolicy, {
      kind: 'edit',
      attributes: { mode: 'append' },
      resources: [resource('file', '/workspace/file.txt')],
    }));
    expect(differentAttributes).toMatchObject({ kind: 'ask', code: 'approval_required' });
  });

  test('forces the third consecutive invocation to ask without a proposal and isolates thread state', async () => {
    const factory = createPolicyEngine();
    const first = await factory.openThread({ workspaceId: WORKSPACE, threadId: THREAD });
    const second = await factory.openThread({ workspaceId: WORKSPACE, threadId: OTHER_THREAD });
    const firstPolicy = await first.capture(captureInput());
    const secondContext = turnContext({ threadId: OTHER_THREAD });
    const secondPolicy = await second.capture(captureInput({
      context: secondContext,
      rules: rules(secondContext),
    }));
    const repeated = invocation(firstPolicy, { kind: 'read' });

    expect(await first.evaluate(repeated)).toMatchObject({ kind: 'allow' });
    expect(await first.evaluate(repeated)).toMatchObject({ kind: 'allow' });
    const third = await first.evaluate(repeated);
    expect(third).toMatchObject({ kind: 'ask', code: 'doom_loop_confirmation_required' });
    expect(third).not.toHaveProperty('grantProposal');
    if (third.kind !== 'ask') throw new Error('Expected doom-loop approval');
    expect(third.description).toContain('attempted 3 times in a row');
    expectDeepFrozen(third);

    expect(await second.evaluate(invocation(secondPolicy, { kind: 'read' }))).toMatchObject({
      kind: 'allow',
    });
    expect(await first.evaluate(invocation(firstPolicy, {
      kind: 'read',
      args: { path: '/workspace/different.txt' },
    }))).toMatchObject({ kind: 'allow' });
  });

  test('rejects owner, workspace, context, and revision mismatches without throwing from evaluate', async () => {
    const engine = await openEngine();
    const foreignContext = turnContext({ threadId: OTHER_THREAD });
    await expect(engine.capture(captureInput({
      context: foreignContext,
      rules: rules(foreignContext),
    }))).rejects.toThrow('different thread');
    await expect(engine.capture(captureInput({
      grants: grantSnapshot('grants-v1', [], OTHER_WORKSPACE),
    }))).rejects.toThrow('different workspace');
    await expect(engine.capture(captureInput({
      turnCeiling: ceiling('', []),
    }))).rejects.toThrow('turnCeiling is invalid');

    const policy = await engine.capture(captureInput());
    const tampered = {
      ...policy,
      revision: 'policy_v1_' + '0'.repeat(64),
    } as EffectivePolicySnapshot;
    const decision = await engine.evaluate(invocation(tampered, { kind: 'read' }));
    expect(decision).toMatchObject({ kind: 'deny', code: 'invalid_policy_invocation' });

    const aliasEngine = await openEngine();
    await aliasEngine.capture(captureInput({
      rules: rules(turnContext(), 'rules-v1', [{
        path: '/workspace/AGENTS.md',
        scope: '/workspace',
        contentDigest: 'digest-a',
        content: 'a',
      }]),
    }));
    await expect(aliasEngine.capture(captureInput({
      rules: rules(turnContext(), 'rules-v1', [{
        path: '/workspace/AGENTS.md',
        scope: '/workspace',
        contentDigest: 'digest-b',
        content: 'b',
      }]),
    }))).rejects.toThrow('aliases different policy material');
  });

  test('closes idempotently, clears state, and permanently fails closed', async () => {
    const engine = await openEngine();
    const policy = await engine.capture(captureInput());
    await engine.close();
    await engine.close();

    const decision = await engine.evaluate(invocation(policy, { kind: 'read' }));
    expect(decision).toMatchObject({ kind: 'deny', code: 'policy_engine_closed' });
    expectDeepFrozen(decision);
    await expect(engine.capture(captureInput())).rejects.toThrow('closed');
  });
});

async function openEngine(): Promise<ThreadPolicyEngine> {
  const factory = createPolicyEngine();
  expect(Object.isFrozen(factory)).toBe(true);
  const engine = await factory.openThread({ workspaceId: WORKSPACE, threadId: THREAD });
  expect(Object.isFrozen(engine)).toBe(true);
  return engine;
}

function turnContext(overrides: Partial<TurnPolicyContext> = {}): TurnPolicyContext {
  return {
    workspaceId: WORKSPACE,
    threadId: THREAD,
    runId: RUN,
    turnId: TURN,
    cwd: '/workspace',
    ...overrides,
  };
}

function ceiling(
  revision: string,
  constraints: readonly Readonly<Record<string, unknown>>[],
): PermissionCeilingSnapshot {
  return { revision, constraints };
}

function rules(
  owner: TurnPolicyContext,
  revision = 'rules-v1',
  files: RuleSnapshot['files'] = [],
): RuleSnapshot {
  return {
    revision,
    owner,
    discovery: {
      knownResourceScopes: ['/workspace'],
      budget: { maxFiles: 8, maxFileBytes: 4096, maxBytes: 8192, maxPromptTokens: 2048 },
      diagnostics: [],
    },
    files,
  };
}

function grantSnapshot(
  revision = 'grants-v1',
  grants: readonly Readonly<PolicyGrant>[] = [],
  workspaceId = WORKSPACE,
): PolicyGrantSnapshot {
  return { workspaceId, revision, grants };
}

function captureInput(overrides: {
  readonly context?: TurnPolicyContext;
  readonly workspaceCeiling?: PermissionCeilingSnapshot;
  readonly runCeiling?: PermissionCeilingSnapshot;
  readonly turnCeiling?: PermissionCeilingSnapshot;
  readonly rules?: RuleSnapshot;
  readonly grants?: PolicyGrantSnapshot;
} = {}): Parameters<ThreadPolicyEngine['capture']>[0] {
  const context = overrides.context ?? turnContext();
  return {
    context,
    workspaceCeiling: overrides.workspaceCeiling ?? ceiling('workspace-ceiling-v1', []),
    runCeiling: overrides.runCeiling ?? ceiling('run-ceiling-v1', []),
    turnCeiling: overrides.turnCeiling ?? ceiling('turn-ceiling-v1', []),
    rules: overrides.rules ?? rules(context),
    grants: overrides.grants ?? grantSnapshot(),
  };
}

function resource(selectorId: string, canonicalTarget: string) {
  return {
    selectorId,
    resourceType: 'filesystem' as const,
    access: 'write' as const,
    canonicalTarget,
  };
}

function invocation(
  effectivePolicy: Readonly<EffectivePolicySnapshot>,
  overrides: {
    readonly capabilityId?: string;
    readonly capabilityVersion?: string;
    readonly registrationDigest?: string;
    readonly kind?: PreparedInvocation['policy']['kind'];
    readonly attributes?: Readonly<Record<string, unknown>>;
    readonly args?: unknown;
    readonly resources?: PreparedInvocation['resources'];
    readonly analysis?: PreparedInvocation['analysis'];
  } = {},
): PreparedInvocation {
  const capabilityId = overrides.capabilityId ?? 'edit-file';
  const resources = overrides.resources ?? [resource('file', '/workspace/file.txt')];
  return {
    capabilityVersion: overrides.capabilityVersion ?? '1.0.0',
    registrationDigest: overrides.registrationDigest ?? 'capreg_v1_' + '1'.repeat(64),
    description: 'Edit a file',
    inputSchema: { type: 'object' },
    metadata: {},
    policy: {
      kind: overrides.kind ?? 'edit',
      resources: resources.map((item) => ({
        selectorId: item.selectorId,
        resourceType: item.resourceType,
        argumentPointer: '/path',
        access: item.access,
      })),
      ...(overrides.attributes === undefined ? {} : { attributes: overrides.attributes }),
    },
    effectivePolicy,
    executionMode: 'sequential',
    args: overrides.args ?? { path: '/workspace/file.txt' },
    resources,
    analysis: overrides.analysis ?? {
      resourceCoverage: { kind: 'complete' },
      grantability: { kind: 'persistable' },
      safety: { kind: 'eligible' },
      attributes: {},
    },
    context: {
      ...effectivePolicy.context,
      invocationId: 'invocation-1',
      toolCallId: 'tool-call-1',
      capabilityId,
      catalogRevision: 1,
    },
    validator: (value) => ({ ok: true, value }),
    executor: async () => ({ content: [] }),
  };
}

function requireProposal(decision: PolicyDecision): Readonly<PolicyGrantScope> {
  expect(decision.kind).toBe('ask');
  if (decision.kind !== 'ask' || decision.grantProposal === undefined) {
    throw new Error('Expected a canonical grant proposal');
  }
  return decision.grantProposal;
}

function exactGrant(
  invocation: Readonly<PreparedInvocation>,
  policy: Readonly<EffectivePolicySnapshot>,
  scope: Readonly<PolicyGrantScope>,
): PolicyGrant {
  return {
    grantId: GRANT_ID,
    workspaceId: invocation.context.workspaceId,
    capabilityId: invocation.context.capabilityId,
    capabilityVersion: invocation.capabilityVersion,
    registrationDigest: invocation.registrationDigest,
    scope,
    policyBasisRevision: policy.policyBasisRevision,
    acceptedAt: 1,
  };
}

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}
