import { describe, expect, test } from 'bun:test';
import type {
  RunId,
  ThreadId,
  TurnId,
  WorkspaceId,
} from '../protocol/index.js';
import { createCapabilityRegistry } from './capability-registry.js';
import type {
  CapabilityRegistration,
  EffectivePolicySnapshot,
  InvocationContext,
  PrepareInvocationResult,
  ToolCatalogSnapshot,
  TurnPolicyContext,
} from './types.js';

const IMPLEMENTATION_0 = `impl_sha256_${'0'.repeat(64)}`;
const IMPLEMENTATION_1 = `impl_sha256_${'1'.repeat(64)}`;

describe('CapabilityRegistry mutations and snapshots', () => {
  test('uses success-only revisions, stable slots, and permanent version history', () => {
    const registry = createCapabilityRegistry();
    expect(registry.snapshot()).toMatchObject({ revision: 0, entries: [] });

    const aV1 = registration('a');
    const bV1 = registration('b');
    expect(registry.register(aV1)).toEqual({ ok: true, revision: 1 });
    expect(registry.register(bV1)).toEqual({ ok: true, revision: 2 });
    expect(registry.register(aV1)).toMatchObject({
      ok: false,
      code: 'duplicate_capability',
      revision: 2,
    });
    expect(registry.update('missing', registration('missing'))).toMatchObject({
      ok: false,
      code: 'capability_not_found',
      revision: 2,
    });
    expect(registry.update('a', registration('other'))).toMatchObject({
      ok: false,
      code: 'invalid_registration',
      revision: 2,
    });
    expect(registry.update('a', registration('a'), { expectedRevision: 1 })).toMatchObject({
      ok: false,
      code: 'revision_conflict',
      revision: 2,
    });

    const aV2 = registration('a', {
      version: '2',
      implementationDigest: IMPLEMENTATION_1,
      description: 'a version two',
    });
    expect(registry.update('a', aV2, { expectedRevision: 2 })).toEqual({ ok: true, revision: 3 });
    expect(registry.snapshot().entries.map((entry) => entry.id)).toEqual(['a', 'b']);

    expect(registry.unregister('a')).toEqual({ ok: true, revision: 4 });
    expect(registry.register(aV2)).toEqual({ ok: true, revision: 5 });
    expect(registry.snapshot().entries.map((entry) => entry.id)).toEqual(['b', 'a']);

    expect(registry.unregister('a')).toEqual({ ok: true, revision: 6 });
    expect(registry.register({ ...aV2, description: 'same version, changed registration' })).toMatchObject({
      ok: false,
      code: 'invalid_registration',
      revision: 6,
    });
    expect(registry.snapshot().entries.map((entry) => entry.id)).toEqual(['b']);
  });

  test('rejects malformed registrations atomically', () => {
    const registry = createCapabilityRegistry();
    const duplicateSelectors = registration('bad', {
      policy: {
        kind: 'read',
        resources: [fileSelector(), fileSelector()],
      },
    });

    expect(registry.register({
      ...registration('digest'),
      implementationDigest: 'not-a-digest',
    })).toMatchObject({ ok: false, code: 'invalid_registration', revision: 0 });
    expect(registry.register(duplicateSelectors)).toMatchObject({
      ok: false,
      code: 'invalid_registration',
      revision: 0,
    });
    expect(registry.register({
      ...registration('extra'),
      unknown: true,
    } as CapabilityRegistration)).toMatchObject({
      ok: false,
      code: 'invalid_registration',
      revision: 0,
    });
    expect(registry.register({
      ...registration('policy-typo'),
      policy: {
        kind: 'read',
        resources: [fileSelector()],
        attributtes: {},
      },
    } as unknown as CapabilityRegistration)).toMatchObject({
      ok: false,
      code: 'invalid_registration',
      revision: 0,
    });
    expect(registry.register({
      ...registration('selector-typo'),
      policy: {
        kind: 'read',
        resources: [{ ...fileSelector(), requird: false }],
      },
    } as unknown as CapabilityRegistration)).toMatchObject({
      ok: false,
      code: 'invalid_registration',
      revision: 0,
    });
    expect(registry.snapshot().entries).toEqual([]);
  });

  test('copies caller JSON and keeps old snapshots isolated from updates and unregister', async () => {
    const schema = { type: 'object', nested: { version: 1 } };
    const metadata = { release: { channel: 'stable' } };
    const attributes = { audit: { enabled: true } };
    let oldValidationCalls = 0;
    let oldResolutionCalls = 0;
    const oldExecutor = async () => ({ content: [] });
    const oldRegistration = registration('read', {
      inputSchema: schema,
      metadata,
      policy: {
        kind: 'read',
        resources: [fileSelector()],
        attributes,
      },
      validate: (input) => {
        oldValidationCalls++;
        return { ok: true, value: input };
      },
      resolveResources: async (args) => {
        oldResolutionCalls++;
        return {
          ok: true,
          resources: [resource('file', 'read', (args as { path: string }).path)],
        };
      },
      execute: oldExecutor,
    });
    const registry = createCapabilityRegistry();
    expect(registry.register(oldRegistration)).toEqual({ ok: true, revision: 1 });
    const oldSnapshot = registry.snapshot();

    schema.nested.version = 99;
    metadata.release.channel = 'mutated';
    attributes.audit.enabled = false;
    (oldRegistration as { execute: CapabilityRegistration['execute'] }).execute = async () => ({
      content: [],
      terminate: true,
    });

    const newExecutor = async () => ({ content: [], terminate: true });
    expect(registry.update('read', registration('read', {
      version: '2',
      implementationDigest: IMPLEMENTATION_1,
      description: 'new description',
      execute: newExecutor,
    }))).toEqual({ ok: true, revision: 2 });
    expect(registry.unregister('read')).toEqual({ ok: true, revision: 3 });

    const oldEntry = oldSnapshot.resolve('read');
    expect(oldEntry).toMatchObject({
      version: '1',
      description: 'read capability',
      inputSchema: { nested: { version: 1 } },
      metadata: { release: { channel: 'stable' } },
      policy: { attributes: { audit: { enabled: true } } },
    });
    expect(oldEntry?.execute).toBe(oldExecutor);
    expect(Object.isFrozen(oldSnapshot)).toBe(true);
    expect(Object.isFrozen(oldSnapshot.entries)).toBe(true);
    expect(Object.isFrozen(oldEntry?.inputSchema)).toBe(true);
    expect(() => {
      (oldEntry?.inputSchema.nested as { version: number }).version = 2;
    }).toThrow();

    const prepared = await oldSnapshot.prepare(prepareInput(oldSnapshot, 'read', { path: '/old' }));
    expectPrepared(prepared);
    expect(prepared.invocation.executor).toBe(oldExecutor);
    expect(prepared.invocation.capabilityVersion).toBe('1');
    expect(oldValidationCalls).toBe(1);
    expect(oldResolutionCalls).toBe(1);
    expect(registry.snapshot().resolve('read')).toBeUndefined();
  });
});

describe('ToolCatalogSnapshot.prepare', () => {
  test('runs the fixed pipeline, binds resources, sorts/deduplicates, and deeply freezes output', async () => {
    const executionCalls: unknown[] = [];
    let resolverSawFrozen = false;
    const validator = (input: unknown) => ({
      ok: true as const,
      value: { path: (input as { path: string }).path, normalized: true },
    });
    const executor = async (input: unknown) => {
      executionCalls.push(input);
      return { content: [] };
    };
    const registry = createCapabilityRegistry();
    expect(registry.register(registration('bound', {
      executionMode: 'sequential',
      prepare: (input) => {
        (input as { path: string; prepared?: boolean }).prepared = true;
        return input;
      },
      validate: validator,
      policy: {
        kind: 'read',
        resources: [
          fileSelector(),
          {
            selectorId: 'optional',
            resourceType: 'filesystem',
            argumentPointer: '/path',
            access: 'read',
            required: false,
          },
        ],
      },
      resolveResources: async (args, context) => {
        resolverSawFrozen = Object.isFrozen(args) && Object.isFrozen(context);
        return {
          ok: true,
          resources: [
            resource('optional', 'read', '/z'),
            resource('file', 'read', '/b'),
            resource('file', 'read', '/a'),
            resource('file', 'read', '/b'),
          ],
        };
      },
      execute: executor,
    }))).toEqual({ ok: true, revision: 1 });
    const snapshot = registry.snapshot();
    const raw = { path: '/input' };
    const effectivePolicy = policySnapshot(turnContext());

    const result = await snapshot.prepare(prepareInput(snapshot, 'bound', raw, effectivePolicy));
    expectPrepared(result);
    expect(raw).toEqual({ path: '/input' });
    expect(resolverSawFrozen).toBe(true);
    expect(result.invocation).toMatchObject({
      capabilityVersion: '1',
      executionMode: 'sequential',
      args: { path: '/input', normalized: true },
    });
    expect(result.invocation.resources).toEqual([
      resource('file', 'read', '/a'),
      resource('file', 'read', '/b'),
      resource('optional', 'read', '/z'),
    ]);
    expect(result.invocation.analysis).toEqual({
      resourceCoverage: { kind: 'complete' },
      grantability: { kind: 'persistable' },
      safety: { kind: 'eligible' },
      attributes: {},
    });
    expect(result.invocation.validator).toBe(validator);
    expect(result.invocation.executor).toBe(executor);
    expect(executionCalls).toEqual([]);
    expect(Object.isFrozen(result.invocation)).toBe(true);
    expect(Object.isFrozen(result.invocation.args)).toBe(true);
    expect(Object.isFrozen(result.invocation.resources)).toBe(true);
    expect(Object.isFrozen(result.invocation.analysis)).toBe(true);
    expect(Object.isFrozen(result.invocation.effectivePolicy.rules.discovery.budget)).toBe(true);

    (effectivePolicy as unknown as { constraints: Record<string, unknown>[] }).constraints[0] = {
      changed: true,
    };
    expect(result.invocation.effectivePolicy.constraints).toEqual([{ allow: true }]);
    expect(() => {
      (result.invocation.args as { path: string }).path = '/mutated';
    }).toThrow();
  });

  test('returns typed failures and never calls the executor', async () => {
    expect((await prepareCase({}, undefined, 'missing')).code).toBe('unknown_capability');

    const invalidContext = await prepareCase({}, {
      context: { catalogRevision: 99 },
    });
    expect(invalidContext).toMatchObject({ ok: false, code: 'invalid_invocation_context' });

    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(await prepareCase({}, { rawArgs: cycle })).toMatchObject({
      ok: false,
      code: 'invalid_arguments',
    });

    expect(await prepareCase({ prepare: () => { throw new Error('prepare'); } })).toMatchObject({
      ok: false,
      code: 'prepare_failed',
    });
    expect(await prepareCase({ validate: () => { throw new Error('validate'); } })).toMatchObject({
      ok: false,
      code: 'prepare_failed',
    });
    expect(await prepareCase({ validate: () => ({ ok: false, message: 'bad args' }) })).toMatchObject({
      ok: false,
      code: 'invalid_arguments',
      message: 'bad args',
    });
    expect(await prepareCase({ validate: () => ({ ok: true, value: undefined }) })).toMatchObject({
      ok: false,
      code: 'invalid_prepared_value',
    });
    expect(await prepareCase({
      resolveResources: async () => { throw new Error('resolver'); },
    })).toMatchObject({ ok: false, code: 'resource_resolution_failed' });
    expect(await prepareCase({
      resolveResources: async () => ({ ok: false, code: 'ambiguous_resource', message: 'many' }),
    })).toEqual({ ok: false, code: 'ambiguous_resource', message: 'many' });
    expect(await prepareCase({
      resolveResources: async () => ({
        ok: true,
        resources: [resource('unknown', 'read', '/x')],
      }),
    })).toMatchObject({ ok: false, code: 'resource_resolution_failed' });
    expect(await prepareCase({
      resolveResources: async () => ({ ok: true, resources: [] }),
    })).toMatchObject({ ok: false, code: 'resource_resolution_failed' });
    expect(await prepareCase({
      resolveResources: async () => ({
        ok: true,
        resources: [resource('file', 'write', '/x')],
      }),
    })).toMatchObject({ ok: false, code: 'resource_resolution_failed' });
    expect(await prepareCase({
      resolveResources: async () => ({
        ok: true,
        resources: [resource('file', 'read', '/x')],
        analysis: {
          resourceCoverage: { kind: 'complete', typo: true },
          grantability: { kind: 'persistable' },
          safety: { kind: 'eligible' },
          attributes: {},
        },
      } as unknown as Awaited<ReturnType<CapabilityRegistration['resolveResources']>>),
    })).toMatchObject({ ok: false, code: 'resource_resolution_failed' });
  });

  test('allows an empty result when the descriptor has no required selectors', async () => {
    const registry = createCapabilityRegistry();
    expect(registry.register(registration('plan', {
      policy: { kind: 'plan', resources: [] },
      resolveResources: async () => ({ ok: true, resources: [] }),
    }))).toEqual({ ok: true, revision: 1 });
    const snapshot = registry.snapshot();
    const result = await snapshot.prepare(prepareInput(snapshot, 'plan', {}));
    expectPrepared(result);
    expect(result.invocation.resources).toEqual([]);
  });
});

function registration(
  id: string,
  overrides: Partial<CapabilityRegistration> = {},
): CapabilityRegistration {
  return {
    id,
    version: '1',
    implementationDigest: IMPLEMENTATION_0,
    description: `${id} capability`,
    inputSchema: { type: 'object' },
    metadata: {},
    policy: { kind: 'read', resources: [fileSelector()] },
    validate: (input) => ({ ok: true, value: input }),
    resolveResources: async (args) => ({
      ok: true,
      resources: [resource('file', 'read', (args as { path?: string }).path ?? '/default')],
    }),
    execute: async () => ({ content: [] }),
    ...overrides,
  };
}

function fileSelector() {
  return {
    selectorId: 'file',
    resourceType: 'filesystem' as const,
    argumentPointer: '/path',
    access: 'read' as const,
  };
}

function resource(
  selectorId: string,
  access: 'read' | 'write',
  canonicalTarget: string,
) {
  return {
    selectorId,
    resourceType: 'filesystem' as const,
    access,
    canonicalTarget,
  };
}

function turnContext(): TurnPolicyContext {
  return {
    workspaceId: 'workspace' as WorkspaceId,
    threadId: 'thread' as ThreadId,
    runId: 'run' as RunId,
    turnId: 'turn' as TurnId,
    cwd: '/workspace',
  };
}

function invocationContext(
  snapshot: ToolCatalogSnapshot,
  capabilityId: string,
): InvocationContext {
  return {
    ...turnContext(),
    invocationId: 'invocation-1',
    toolCallId: 'provider-call-1',
    capabilityId,
    catalogRevision: snapshot.revision,
  };
}

function policySnapshot(context: TurnPolicyContext): EffectivePolicySnapshot {
  return {
    context: { ...context },
    revision: 'policy-revision',
    policyBasisRevision: 'basis-revision',
    ceilingRevision: 'ceiling-revision',
    grantRevision: 'grant-revision',
    constraints: [{ allow: true }],
    rules: {
      revision: 'rules-revision',
      owner: { ...context },
      discovery: {
        knownResourceScopes: ['/workspace'],
        budget: { maxFiles: 8, maxFileBytes: 1024, maxBytes: 4096, maxPromptTokens: 1024 },
        diagnostics: [],
      },
      files: [],
    },
  };
}

function prepareInput(
  snapshot: ToolCatalogSnapshot,
  capabilityId: string,
  rawArgs: unknown,
  effectivePolicy = policySnapshot(turnContext()),
): Parameters<ToolCatalogSnapshot['prepare']>[0] {
  return {
    capabilityId,
    rawArgs,
    context: invocationContext(snapshot, capabilityId),
    effectivePolicy,
  };
}

async function prepareCase(
  overrides: Partial<CapabilityRegistration>,
  inputOverrides: {
    readonly rawArgs?: unknown;
    readonly context?: Partial<InvocationContext>;
  } = {},
  requestedCapability = 'tool',
): Promise<Extract<PrepareInvocationResult, { readonly ok: false }>> {
  let executorCalls = 0;
  const registry = createCapabilityRegistry();
  expect(registry.register(registration('tool', {
    ...overrides,
    execute: async () => {
      executorCalls++;
      return { content: [] };
    },
  }))).toEqual({ ok: true, revision: 1 });
  const snapshot = registry.snapshot();
  const context = {
    ...invocationContext(snapshot, requestedCapability),
    ...inputOverrides.context,
  };
  const result = await snapshot.prepare({
    capabilityId: requestedCapability,
    rawArgs: Object.hasOwn(inputOverrides, 'rawArgs') ? inputOverrides.rawArgs : { path: '/x' },
    context,
    effectivePolicy: policySnapshot(turnContext()),
  });
  expect(executorCalls).toBe(0);
  if (result.ok) throw new Error('Expected prepare to fail.');
  return result;
}

function expectPrepared(
  result: PrepareInvocationResult,
): asserts result is Extract<PrepareInvocationResult, { readonly ok: true }> {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`Expected prepare success: ${result.message}`);
}
