import {
  afterAll,
  describe,
  expect,
  it,
} from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type {
  BasePromptProvider,
  EffectivePolicySnapshot,
  RuleFreshnessPort,
  RuleSnapshot,
  RuleSnapshotBudget,
  RuleSnapshotProvider,
  ThreadPolicyEngine,
  TurnPolicyContext,
} from '../capabilities/index.js';
import type {
  RunId,
  ThreadId,
  TurnId,
  WorkspaceId,
} from '../protocol/index.js';
import { streamAnthropicMessages } from '../providers/anthropic-messages/index.js';
import { streamOpenAIChat } from '../providers/openai-chat/index.js';
import { streamOpenAIResponses } from '../providers/openai-responses/index.js';
import {
  createCliBasePromptProvider,
  createCliRegistryCapabilityServices,
} from './capability-services.js';
import type { StaticLegacyApprovalMode } from './legacy-approval-adapter.js';

const PROJECT_ROOT = mkdtempSync(path.join(tmpdir(), 'coda-cli-capabilities-'));
const WORKSPACE_ID = 'workspace-cli' as WorkspaceId;
const THREAD_ID = 'thread-cli' as ThreadId;
const RUN_ID = 'run-cli' as RunId;
const TURN_ID = 'turn-cli' as TurnId;
const RULE_BUDGET: RuleSnapshotBudget = {
  maxFiles: 8,
  maxFileBytes: 32_768,
  maxBytes: 65_536,
  maxPromptTokens: 16_384,
};

afterAll(() => {
  rmSync(PROJECT_ROOT, { recursive: true, force: true });
});

describe('CLI registry capability composition', () => {
  it('registers the exact legacy tool and provider tables in stable order', async () => {
    const ports = explicitPorts();
    const composition = createCliRegistryCapabilityServices({
      cwd: PROJECT_ROOT,
      approvalMode: 'interactive',
      ...ports,
      ruleBudget: RULE_BUDGET,
    });

    const catalog = composition.capabilityRegistry.snapshot();
    expect(catalog.revision).toBe(8);
    expect(catalog.entries.map((entry) => entry.id)).toEqual([
      'read',
      'ls',
      'glob',
      'grep',
      'bash',
      'edit',
      'write',
      'plan',
    ]);
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.entries)).toBe(true);
    for (const entry of catalog.entries) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.inputSchema)).toBe(true);
      expect(entry.registrationDigest).toMatch(/^capreg_v1_[0-9a-f]{64}$/);
    }

    const providers = composition.providerRegistry.snapshot();
    expect(providers.revision).toBe(4);
    expect(providers.entries.map((entry) => entry.api)).toEqual([
      'openai-chat',
      'openai-responses',
      'anthropic-messages',
      'faux',
    ]);
    expect(providers.resolve('openai-chat')?.stream).toBe(streamOpenAIChat);
    expect(providers.resolve('openai-responses')?.stream).toBe(streamOpenAIResponses);
    expect(providers.resolve('anthropic-messages')?.stream).toBe(streamAnthropicMessages);
    expect(Object.isFrozen(providers)).toBe(true);
    expect(Object.isFrozen(providers.entries)).toBe(true);

    const faux = providers.resolve('faux');
    if (faux === undefined) throw new Error('Expected faux provider registration');
    const unsupported = await faux.stream(
      { ref: { provider: 'faux', api: 'faux', model: 'fixture' } },
      { messages: [] },
    ).result();
    expect(unsupported.stopReason).toBe('error');
    expect(unsupported.errorMessage).toBe('faux provider 未配置脚本');
  });

  it('keeps all host ports explicit, detached, frozen, and side-effect free at construction', () => {
    const ports = explicitPorts();
    const mutableBudget = { ...RULE_BUDGET };
    const composition = createCliRegistryCapabilityServices({
      cwd: PROJECT_ROOT,
      approvalMode: 'interactive',
      ...ports,
      ruleBudget: mutableBudget,
    });

    expect(ports.calls).toEqual({ base: 0, rules: 0, freshness: 0 });
    expect(composition.services.capabilities).toBe(composition.capabilityRegistry);
    expect(composition.services.providers).toBe(composition.providerRegistry);
    expect(composition.services.basePrompts).toBe(ports.basePrompts);
    expect(composition.services.ruleSnapshots).toBe(ports.ruleSnapshots);
    expect(composition.services.ruleFreshness).toBe(ports.ruleFreshness);
    expect(composition.services.grantMode).toBe('legacy_global_approvals_v1');
    expect(Object.isFrozen(composition)).toBe(true);
    expect(Object.isFrozen(composition.services)).toBe(true);
    expect(Object.isFrozen(composition.services.ruleBudget)).toBe(true);

    mutableBudget.maxFiles = 99;
    expect(composition.services.ruleBudget.maxFiles).toBe(RULE_BUDGET.maxFiles);
    expect(() => createCliRegistryCapabilityServices({
      cwd: 'relative/workspace',
      approvalMode: 'interactive',
      ...ports,
      ruleBudget: RULE_BUDGET,
    })).toThrow('explicit absolute path');
  });

  it('captures a detached identity-bound base prompt with a material-stable revision', async () => {
    const provider = createCliBasePromptProvider({ content: 'system prompt' });
    const firstContext = turnContext();
    const firstModel = {
      ref: { provider: 'configured', api: 'openai-responses', model: 'gpt-test' },
      limits: { context: 1000, output: 100 },
    };
    const first = await provider.capture({ context: firstContext, model: firstModel });

    (firstContext as { cwd: string }).cwd = '/mutated';
    firstModel.ref.model = 'mutated';
    expect(first.owner.cwd).toBe(PROJECT_ROOT);
    expect(first.model.model).toBe('gpt-test');
    expect(first.content).toBe('system prompt');
    expectDeepFrozen(first);

    const second = await provider.capture({
      context: turnContext({
        runId: 'run-next' as RunId,
        turnId: 'turn-next' as TurnId,
      }),
      model: { ref: { provider: 'other', api: 'faux', model: 'fixture' } },
    });
    expect(second.revision).toBe(first.revision);
    expect(String(second.owner.runId)).toBe('run-next');
    expect(second.model.api).toBe('faux');
  });

  it('preserves allow and deny CLI modes while safe capabilities remain automatic', async () => {
    const allowed = await policyDecision('allow', 'write', {
      path: 'created.ts',
      content: 'export {};\n',
    });
    expect(allowed).toMatchObject({ kind: 'allow', code: 'cli_approval_mode_allow' });

    const denied = await policyDecision('deny', 'write', {
      path: 'created.ts',
      content: 'export {};\n',
    });
    expect(denied).toMatchObject({ kind: 'deny', code: 'cli_approval_mode_deny' });

    const read = await policyDecision('deny', 'read', { path: 'README.md' });
    expect(read).toMatchObject({ kind: 'allow', code: 'default_safe_capability' });
  });

  it('binds approval mode and canonical project root into the frozen policy basis', async () => {
    const interactiveComposition = compositionFor('interactive');
    const denyComposition = compositionFor('deny');
    const interactiveEngine = await interactiveComposition.services.policyEngine.openThread({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
    });
    const denyEngine = await denyComposition.services.policyEngine.openThread({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
    });
    const otherRoot = mkdtempSync(path.join(tmpdir(), 'coda-cli-capabilities-other-'));
    const otherComposition = compositionFor('interactive', otherRoot);
    const otherEngine = await otherComposition.services.policyEngine.openThread({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
    });
    try {
      const interactive = await capturePolicy(interactiveEngine);
      const denied = await capturePolicy(denyEngine);
      const other = await capturePolicy(otherEngine, [], otherRoot);
      expect(interactive.policyBasisRevision).not.toBe(denied.policyBasisRevision);
      expect(interactive.policyBasisRevision).not.toBe(other.policyBasisRevision);
    } finally {
      await interactiveEngine.close();
      await denyEngine.close();
      await otherEngine.close();
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it('projects interactive edits into durable legacy-global patterns and reuses snapshots', async () => {
    const expectedPattern = `write:${PROJECT_ROOT}/**`;
    const first = await policyDecision('interactive', 'write', {
      path: 'created.ts',
      content: 'export {};\n',
    });
    expect(first).toMatchObject({
      kind: 'ask',
      code: 'approval_required',
      grantProposal: {
        kind: 'legacy_global_approvals_v1',
        patterns: [expectedPattern],
      },
    });
    expectDeepFrozen(first);

    const remembered = await policyDecision(
      'interactive',
      'write',
      { path: 'created.ts', content: 'export {};\n' },
      [expectedPattern],
    );
    expect(remembered).toMatchObject({
      kind: 'allow',
      code: 'matching_legacy_global_approval',
    });
  });

  it('keeps unsafe or non-generalizable bash calls out of legacy grants', async () => {
    const dangerous = await policyDecision('interactive', 'bash', { command: 'rm -rf /' });
    expect(dangerous).toMatchObject({
      kind: 'deny',
      code: 'legacy_bash_command_denied',
    });

    const opaque = await policyDecision('interactive', 'bash', { command: 'echo $(pwd)' });
    expect(opaque).toMatchObject({ kind: 'ask' });
    expect(opaque).not.toHaveProperty('grantProposal');
    const rememberedOpaque = await policyDecision(
      'interactive',
      'bash',
      { command: 'echo $(pwd)' },
      ['bash:echo *'],
    );
    expect(rememberedOpaque).toMatchObject({ kind: 'ask' });
    expect(rememberedOpaque).not.toHaveProperty('grantProposal');

    const rememberedInterpreter = await policyDecision(
      'interactive',
      'bash',
      { command: 'python -c "open(\'created.ts\', \'w\').close()"' },
      ['bash:python *'],
    );
    expect(rememberedInterpreter).toMatchObject({ kind: 'ask' });
    expect(rememberedInterpreter).not.toHaveProperty('grantProposal');

    const safe = await policyDecision('interactive', 'bash', { command: 'bun test' });
    expect(safe).toMatchObject({
      kind: 'ask',
      grantProposal: {
        kind: 'legacy_global_approvals_v1',
        patterns: ['bash:bun *'],
      },
    });
    const rememberedSafe = await policyDecision(
      'interactive',
      'bash',
      { command: 'bun test' },
      ['bash:bun *'],
    );
    expect(rememberedSafe).toMatchObject({
      kind: 'allow',
      code: 'matching_legacy_global_approval',
    });
  });

  it('projects bash policy exclusively from the frozen resolver analysis, not reparsed args', async () => {
    const composition = compositionFor('interactive');
    const engine = await composition.services.policyEngine.openThread({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
    });
    try {
      const effectivePolicy = await capturePolicy(engine);
      const prepared = await prepareInvocation(composition, effectivePolicy, 'bash', {
        command: 'bun test',
        description: 'run frozen tests',
      });
      const decision = await engine.evaluate({
        ...prepared,
        args: { command: 'echo $(pwd)', description: 'mutated unfrozen view' },
      });
      expect(decision).toMatchObject({
        kind: 'ask',
        grantProposal: {
          kind: 'legacy_global_approvals_v1',
          patterns: ['bash:bun *'],
        },
      });
      if (decision.kind !== 'ask') throw new Error('Expected an approval');
      expect(decision.description).toContain('bun test');
      expect(decision.description).not.toContain('echo $(pwd)');
    } finally {
      await engine.close();
    }
  });

  it('retains per-thread doom-loop confirmation without a learnable proposal', async () => {
    const composition = compositionFor('interactive');
    const engine = await composition.services.policyEngine.openThread({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
    });
    try {
      const effectivePolicy = await capturePolicy(engine);
      const invocation = await prepareInvocation(composition, effectivePolicy, 'read', {
        path: 'README.md',
      });
      expect(await engine.evaluate(invocation)).toMatchObject({ kind: 'allow' });
      expect(await engine.evaluate(invocation)).toMatchObject({ kind: 'allow' });
      const third = await engine.evaluate(invocation);
      expect(third).toMatchObject({ kind: 'ask', code: 'doom_loop_confirmation_required' });
      expect(third).not.toHaveProperty('grantProposal');
    } finally {
      await engine.close();
    }
  });
});

function explicitPorts(): {
  readonly basePrompts: BasePromptProvider;
  readonly ruleSnapshots: RuleSnapshotProvider;
  readonly ruleFreshness: RuleFreshnessPort;
  readonly calls: { base: number; rules: number; freshness: number };
} {
  const calls = { base: 0, rules: 0, freshness: 0 };
  const basePrompts: BasePromptProvider = {
    async capture(input) {
      calls.base += 1;
      return createCliBasePromptProvider({ content: 'base' }).capture(input);
    },
  };
  const ruleSnapshots: RuleSnapshotProvider = {
    async capture(input) {
      calls.rules += 1;
      return {
        ok: true as const,
        snapshot: rules(input.context, input.budget, input.knownResourceScopes),
      };
    },
  };
  const ruleFreshness: RuleFreshnessPort = {
    async check() {
      calls.freshness += 1;
      return { fresh: true as const };
    },
  };
  return {
    calls,
    basePrompts: Object.freeze(basePrompts),
    ruleSnapshots: Object.freeze(ruleSnapshots),
    ruleFreshness: Object.freeze(ruleFreshness),
  };
}

function compositionFor(mode: StaticLegacyApprovalMode, cwd = PROJECT_ROOT) {
  const ports = explicitPorts();
  return createCliRegistryCapabilityServices({
    cwd,
    approvalMode: mode,
    ...ports,
    ruleBudget: RULE_BUDGET,
    fauxScript: { turns: [], onExhausted: 'emptyStop' },
  });
}

async function policyDecision(
  mode: StaticLegacyApprovalMode,
  capabilityId: string,
  rawArgs: unknown,
  patterns: readonly string[] = [],
) {
  const composition = compositionFor(mode);
  const engine = await composition.services.policyEngine.openThread({
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
  });
  try {
    const effectivePolicy = await capturePolicy(engine, patterns);
    const invocation = await prepareInvocation(
      composition,
      effectivePolicy,
      capabilityId,
      rawArgs,
    );
    return await engine.evaluate(invocation);
  } finally {
    await engine.close();
  }
}

async function capturePolicy(
  engine: ThreadPolicyEngine,
  patterns: readonly string[] = [],
  cwd = PROJECT_ROOT,
): Promise<Readonly<EffectivePolicySnapshot>> {
  const context = turnContext({ cwd });
  const ceiling = { revision: 'ceiling-v1', constraints: [] };
  return engine.capture({
    context,
    workspaceCeiling: ceiling,
    runCeiling: ceiling,
    turnCeiling: ceiling,
    rules: rules(context, RULE_BUDGET, [cwd]),
    grants: {
      workspaceId: WORKSPACE_ID,
      revision: `grants-v1-${patterns.length}`,
      grants: [],
      legacyGlobal: {
        revision: `legacy-v1-${patterns.length}`,
        patterns,
      },
    },
  });
}

async function prepareInvocation(
  composition: ReturnType<typeof compositionFor>,
  effectivePolicy: Readonly<EffectivePolicySnapshot>,
  capabilityId: string,
  rawArgs: unknown,
) {
  const catalog = composition.services.capabilities.snapshot();
  const prepared = await catalog.prepare({
    capabilityId,
    rawArgs,
    context: {
      ...effectivePolicy.context,
      invocationId: `invocation-${capabilityId}`,
      toolCallId: `call-${capabilityId}`,
      capabilityId,
      catalogRevision: catalog.revision,
    },
    effectivePolicy,
  });
  if (!prepared.ok) throw new Error(prepared.message);
  return prepared.invocation;
}

function turnContext(overrides: Partial<TurnPolicyContext> = {}): TurnPolicyContext {
  return {
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    runId: RUN_ID,
    turnId: TURN_ID,
    cwd: PROJECT_ROOT,
    ...overrides,
  };
}

function rules(
  owner: Readonly<TurnPolicyContext>,
  budget: Readonly<RuleSnapshotBudget>,
  knownResourceScopes: readonly string[] = [PROJECT_ROOT],
): Readonly<RuleSnapshot> {
  return {
    revision: 'rules-v1',
    owner,
    discovery: {
      knownResourceScopes,
      budget,
      diagnostics: [],
    },
    files: [],
  };
}

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}
