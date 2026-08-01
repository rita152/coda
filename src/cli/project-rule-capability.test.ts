import {
  afterEach,
  describe,
  expect,
  it,
} from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type {
  CapabilityInvocationAnalysis,
  InvocationContext,
  ResolvedCapabilityResource,
  RuleSnapshot,
  RuleSnapshotBudget,
  TurnPolicyContext,
} from '../capabilities/index.js';
import type {
  RunId,
  ThreadId,
  TurnId,
  WorkspaceId,
} from '../protocol/index.js';
import {
  LEGACY_BASH_ANALYSIS_VERSION,
  type LegacyBashFilesystemTarget,
} from './bash-analyze.js';
import { LEGACY_FILESYSTEM_ANALYSIS_VERSION } from '../integrations/legacy-coding-tools/index.js';
import { ProjectRules } from './project-rules.js';

const WORKSPACE = 'workspace-rules' as WorkspaceId;
const THREAD = 'thread-rules' as ThreadId;
const RUN = 'run-rules' as RunId;
const TURN = 'turn-rules' as TurnId;
const BUDGET: RuleSnapshotBudget = {
  maxFiles: 32,
  maxFileBytes: 32 * 1024,
  maxBytes: 256 * 1024,
  maxPromptTokens: 16 * 1024,
};
const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

describe('ProjectRules registry snapshot adapter', () => {
  it('captures root-to-cwd files with canonical fields and an owner-independent revision', async () => {
    const root = makeRepository();
    const cwd = path.join(root, 'packages', 'app');
    mkdirSync(cwd, { recursive: true });
    const rootFile = write(root, 'AGENTS.md', 'ROOT_RULE');
    const packageFile = write(root, 'packages/AGENTS.md', 'PACKAGE_RULE');
    const appFile = write(root, 'packages/app/AGENTS.md', 'APP_RULE');
    const rules = new ProjectRules({ cwd });

    const first = await capture(rules, turnContext(cwd));
    expect(first.files.map((file) => file.path)).toEqual([rootFile, packageFile, appFile]);
    expect(first.files.map((file) => file.content)).toEqual([
      'ROOT_RULE',
      'PACKAGE_RULE',
      'APP_RULE',
    ]);
    expect(first.files[2]?.scope).toBe(`${cwd}${path.sep}**`);
    expect(first.files.every((file) => /^sha256_[0-9a-f]{64}$/.test(file.contentDigest))).toBe(true);
    expect(first.discovery).toEqual({
      knownResourceScopes: [],
      budget: BUDGET,
      diagnostics: [],
    });
    expectDeepFrozen(first);

    const second = await capture(rules, turnContext(cwd, {
      threadId: 'thread-other' as ThreadId,
      runId: 'run-other' as RunId,
      turnId: 'turn-other' as TurnId,
    }));
    expect(second.revision).toBe(first.revision);
    expect(second.owner).not.toEqual(first.owner);
  });

  it('returns a canonical missing scope, then includes it only on the next capture', async () => {
    const root = makeRepository();
    const nested = path.join(root, 'nested');
    mkdirSync(nested);
    write(root, 'AGENTS.md', 'ROOT_RULE');
    write(root, 'nested/AGENTS.md', 'NESTED_RULE');
    const rules = new ProjectRules({ cwd: root });
    const firstContext = turnContext(root);
    const first = await capture(rules, firstContext);
    expect(first.files.map((file) => file.content)).toEqual(['ROOT_RULE']);

    const missing = await rules.check({
      snapshot: first,
      context: invocationContext(firstContext, 'write'),
      analysis: filesystemAnalysis(path.join(nested, 'out.ts')),
      resources: [filesystemResource('file', 'write', path.join(nested, 'out.ts'))],
    });
    expect(missing).toEqual({
      fresh: false,
      code: 'rule_scope_missing',
      missingScopes: [nested],
      message:
        'Project rules for this resource scope were not present in the frozen turn snapshot. ' +
        'They will be captured on the next turn; review them before retrying.',
    });
    expect(first.files.map((file) => file.content)).toEqual(['ROOT_RULE']);

    const nextContext = turnContext(root, {
      runId: 'run-next' as RunId,
      turnId: 'turn-next' as TurnId,
    });
    const next = await capture(rules, nextContext, [nested]);
    expect(next.discovery.knownResourceScopes).toEqual([nested]);
    expect(next.files.map((file) => file.content)).toEqual(['ROOT_RULE', 'NESTED_RULE']);
    expect(await rules.check({
      snapshot: next,
      context: invocationContext(nextContext, 'write'),
      analysis: filesystemAnalysis(path.join(nested, 'out.ts')),
      resources: [filesystemResource('file', 'write', path.join(nested, 'out.ts'))],
    })).toEqual({ fresh: true });
  });

  it('does not consume another turn when a newly touched directory has no valid rule', async () => {
    const root = makeRepository();
    const nested = path.join(root, 'nested');
    mkdirSync(nested);
    write(root, 'AGENTS.md', 'ROOT_RULE');
    const rules = new ProjectRules({ cwd: root });
    const context = turnContext(root);
    const snapshot = await capture(rules, context);

    expect(await rules.check({
      snapshot,
      context: invocationContext(context, 'write'),
      analysis: filesystemAnalysis(path.join(nested, 'out.ts')),
      resources: [filesystemResource('file', 'write', path.join(nested, 'out.ts'))],
    })).toEqual({ fresh: true });

    const hinted = await capture(rules, context, [nested]);
    expect(hinted.files).toEqual(snapshot.files);
    expect(hinted.revision).not.toBe(snapshot.revision);
  });

  it('detects rule changes at both preflight and execute checks without replacing the snapshot', async () => {
    const root = makeRepository();
    const file = write(root, 'AGENTS.md', 'BEFORE');
    const rules = new ProjectRules({ cwd: root });
    const context = turnContext(root);
    const snapshot = await capture(rules, context);
    const checkInput = {
      snapshot,
      context: invocationContext(context, 'write'),
      analysis: filesystemAnalysis(path.join(root, 'out.ts')),
      resources: [filesystemResource('file', 'write', path.join(root, 'out.ts'))],
    };

    expect(await rules.check(checkInput)).toEqual({ fresh: true });
    writeFileSync(file, 'AFTER');
    const preflight = await rules.check(checkInput);
    const execute = await rules.check(checkInput);
    expect(preflight).toMatchObject({ fresh: false, code: 'rule_changed' });
    expect(execute).toEqual(preflight);
    expect(snapshot.files[0]?.content).toBe('BEFORE');
    expectDeepFrozen(snapshot);
  });

  it('enforces all four budget dimensions, prefers narrow rules, and records diagnostics', async () => {
    const root = makeRepository();
    const child = path.join(root, 'child');
    mkdirSync(child);
    write(root, 'AGENTS.md', 'ROOT');
    write(root, 'child/AGENTS.md', 'CHILD');
    const rules = new ProjectRules({ cwd: child });
    const context = turnContext(child);

    const maxFiles = await capture(rules, context, [], { ...BUDGET, maxFiles: 1 });
    expect(maxFiles.files.map((file) => file.content)).toEqual(['CHILD']);
    expect(maxFiles.discovery.diagnostics.some((diagnostic) =>
      diagnostic.code === 'rule_budget_exhausted'
      && diagnostic.message.includes('maxFiles 1'))).toBe(true);
    const omittedRoot = await rules.check({
      snapshot: maxFiles,
      context: invocationContext(context, 'write'),
      analysis: filesystemAnalysis(path.join(root, 'out.ts')),
      resources: [filesystemResource('file', 'write', path.join(root, 'out.ts'))],
    });
    expect(omittedRoot).toMatchObject({ fresh: false, code: 'rule_changed' });
    if (omittedRoot.fresh) throw new Error('Expected an omitted applicable rule to fail closed');
    expect(omittedRoot.message).toContain('omitted from the frozen prompt');

    const maxBytes = await capture(rules, context, [], { ...BUDGET, maxBytes: 5 });
    expect(maxBytes.files.map((file) => file.content)).toEqual(['CHILD']);
    expect(maxBytes.discovery.diagnostics.some((diagnostic) =>
      diagnostic.message.includes('maxBytes 5'))).toBe(true);

    const maxPromptTokens = await capture(rules, context, [], {
      ...BUDGET,
      maxPromptTokens: 0,
    });
    expect(maxPromptTokens.files).toEqual([]);
    expect(maxPromptTokens.discovery.diagnostics).toHaveLength(2);

    const maxFileBytes = await capture(rules, context, [], { ...BUDGET, maxFileBytes: 4 });
    expect(maxFileBytes.files.map((file) => file.content)).toEqual(['ROOT']);
    expect(maxFileBytes.discovery.diagnostics.some((diagnostic) =>
      diagnostic.message.includes('per-file limit 4'))).toBe(true);

    expect(maxFiles.revision).not.toBe(maxBytes.revision);
    expect(maxBytes.revision).not.toBe(maxPromptTokens.revision);
    expect(maxPromptTokens.revision).not.toBe(maxFileBytes.revision);
  });

  it('emits structured skip diagnostics and never reads an out-of-repository rule symlink', async () => {
    const root = makeRepository();
    const outside = makeDirectory('coda-capability-rules-outside-');
    const outsideRule = write(outside, 'rules.md', 'MUST_NOT_LEAK');
    symlinkSync(outsideRule, path.join(root, 'AGENTS.md'));
    const rules = new ProjectRules({ cwd: root });

    const snapshot = await capture(rules, turnContext(root));
    expect(snapshot.files).toEqual([]);
    expect(snapshot.discovery.diagnostics).toHaveLength(1);
    expect(snapshot.discovery.diagnostics[0]).toMatchObject({
      code: 'rule_skipped',
      path: path.join(root, 'AGENTS.md'),
    });
    expect(JSON.stringify(snapshot)).not.toContain('MUST_NOT_LEAK');
  });

  it('fails closed for opaque bash paths using only frozen analysis and resources', async () => {
    const root = makeRepository();
    write(root, 'AGENTS.md', 'ROOT');
    const rules = new ProjectRules({ cwd: root });
    const context = turnContext(root);
    const snapshot = await capture(rules, context);
    const result = await rules.check({
      snapshot,
      context: invocationContext(context, 'bash'),
      analysis: {
        resourceCoverage: {
          kind: 'incomplete',
          reasons: ['command substitution hides nested filesystem paths'],
        },
        grantability: {
          kind: 'once_only',
          reasons: ['command substitution hides nested filesystem paths'],
        },
        safety: { kind: 'eligible' },
        attributes: {},
      },
      resources: [
        {
          selectorId: 'command',
          resourceType: 'command',
          access: 'execute',
          canonicalTarget: 'echo $(pwd)',
        },
        filesystemResource('workdir', 'read', root),
      ],
    });

    expect(result).toMatchObject({ fresh: false, code: 'rule_changed' });
    if (result.fresh) throw new Error('Expected opaque bash paths to fail closed');
    expect(result.message).toContain('cannot determine safely');
  });

  it('derives bash rule scopes from frozen filesystem resources without a command parser', async () => {
    const root = makeRepository();
    const nested = path.join(root, 'nested');
    mkdirSync(nested);
    write(root, 'AGENTS.md', 'ROOT');
    write(root, 'nested/AGENTS.md', 'NESTED');
    const rules = new ProjectRules({ cwd: root });
    const context = turnContext(root);
    const snapshot = await capture(rules, context);
    const result = await rules.check({
      snapshot,
      context: invocationContext(context, 'bash'),
      analysis: bashAnalysis([
        { canonicalTarget: root, kind: 'directory' },
        { canonicalTarget: path.join(nested, 'out.ts'), kind: 'file' },
      ]),
      resources: [
        filesystemResource('workdir', 'read', root),
        filesystemResource('filesystem_write_target', 'write', path.join(nested, 'out.ts')),
      ],
    });

    expect(result).toMatchObject({
      fresh: false,
      code: 'rule_scope_missing',
      missingScopes: [nested],
    });
  });

  it('uses only frozen bash target kinds and treats unknown as a possible directory', async () => {
    const root = makeRepository();
    const nested = path.join(root, 'nested');
    mkdirSync(nested);
    write(root, 'AGENTS.md', 'ROOT');
    write(root, 'nested/AGENTS.md', 'NESTED');
    const rules = new ProjectRules({ cwd: root });
    const context = turnContext(root);
    const snapshot = await capture(rules, context);
    const resources = [
      filesystemResource('workdir', 'read', root),
      filesystemResource('filesystem_write_target', 'write', nested),
    ];

    // The live target is a directory, but the resolver-frozen file fact makes its parent the scope.
    // A freshness check that stats the live target would incorrectly discover NESTED here.
    expect(await rules.check({
      snapshot,
      context: invocationContext(context, 'bash'),
      analysis: bashAnalysis([
        { canonicalTarget: root, kind: 'directory' },
        { canonicalTarget: nested, kind: 'file' },
      ]),
      resources,
    })).toEqual({ fresh: true });

    const unknown = await rules.check({
      snapshot,
      context: invocationContext(context, 'bash'),
      analysis: bashAnalysis([
        { canonicalTarget: root, kind: 'directory' },
        { canonicalTarget: nested, kind: 'unknown' },
      ]),
      resources,
    });
    expect(unknown).toMatchObject({
      fresh: false,
      code: 'rule_scope_missing',
      missingScopes: [nested],
    });
  });

  it('fails closed when a guarded built-in omits or mismatches frozen target facts', async () => {
    const root = makeRepository();
    write(root, 'AGENTS.md', 'ROOT');
    const rules = new ProjectRules({ cwd: root });
    const context = turnContext(root);
    const snapshot = await capture(rules, context);
    const target = path.join(root, 'out.ts');
    const resource = filesystemResource('file', 'write', target);

    const missingShape = await rules.check({
      snapshot,
      context: invocationContext(context, 'write'),
      analysis: {
        resourceCoverage: { kind: 'complete' },
        grantability: { kind: 'persistable' },
        safety: { kind: 'eligible' },
        attributes: {},
      },
      resources: [resource],
    });
    expect(missingShape).toMatchObject({ fresh: false, code: 'rule_changed' });
    if (missingShape.fresh) throw new Error('Expected missing target facts to fail closed');
    expect(missingShape.message).toContain('Invalid frozen legacy filesystem analysis');

    const mismatched = await rules.check({
      snapshot,
      context: invocationContext(context, 'write'),
      analysis: filesystemAnalysis(path.join(root, 'other.ts')),
      resources: [resource],
    });
    expect(mismatched).toMatchObject({ fresh: false, code: 'rule_changed' });
    if (mismatched.fresh) throw new Error('Expected mismatched target facts to fail closed');
    expect(mismatched.message).toContain('target facts do not match');
  });

  it('returns typed capture failures for invalid budgets and freshness fails closed on owner mismatch', async () => {
    const root = makeRepository();
    const rules = new ProjectRules({ cwd: root });
    const context = turnContext(root);
    const invalid = await rules.capture({
      context,
      knownResourceScopes: [],
      budget: { ...BUDGET, maxFiles: -1 },
    });
    expect(invalid).toMatchObject({ ok: false, code: 'invalid_rule_snapshot' });

    const snapshot = await capture(rules, context);
    const mismatch = await rules.check({
      snapshot,
      context: invocationContext(turnContext(root, { turnId: 'different' as TurnId }), 'write'),
      analysis: filesystemAnalysis(path.join(root, 'out.ts')),
      resources: [filesystemResource('file', 'write', path.join(root, 'out.ts'))],
    });
    expect(mismatch).toMatchObject({ fresh: false, code: 'rule_changed' });
  });
});

async function capture(
  rules: ProjectRules,
  context: Readonly<TurnPolicyContext>,
  knownResourceScopes: readonly string[] = [],
  budget: Readonly<RuleSnapshotBudget> = BUDGET,
): Promise<Readonly<RuleSnapshot>> {
  const result = await rules.capture({ context, knownResourceScopes, budget });
  if (!result.ok) throw new Error(result.message);
  return result.snapshot;
}

function makeDirectory(prefix: string): string {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  temporaryDirectories.push(directory);
  return directory;
}

function makeRepository(): string {
  const root = makeDirectory('coda-capability-rules-');
  mkdirSync(path.join(root, '.git'));
  return root;
}

function write(root: string, relative: string, content: string): string {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

function turnContext(
  cwd: string,
  overrides: Partial<TurnPolicyContext> = {},
): TurnPolicyContext {
  return {
    workspaceId: WORKSPACE,
    threadId: THREAD,
    runId: RUN,
    turnId: TURN,
    cwd,
    ...overrides,
  };
}

function invocationContext(
  turn: Readonly<TurnPolicyContext>,
  capabilityId: string,
): InvocationContext {
  return {
    ...turn,
    invocationId: `invocation-${capabilityId}`,
    toolCallId: `call-${capabilityId}`,
    capabilityId,
    catalogRevision: 1,
  };
}

function filesystemResource(
  selectorId: string,
  access: 'read' | 'write',
  canonicalTarget: string,
): ResolvedCapabilityResource {
  return {
    selectorId,
    resourceType: 'filesystem',
    access,
    canonicalTarget,
  };
}

function filesystemAnalysis(canonicalTarget: string): CapabilityInvocationAnalysis {
  return {
    resourceCoverage: { kind: 'complete' },
    grantability: { kind: 'persistable' },
    safety: { kind: 'eligible' },
    attributes: {
      kind: LEGACY_FILESYSTEM_ANALYSIS_VERSION,
      filesystemTargets: [{ canonicalTarget, kind: 'file' }],
    },
  };
}

function bashAnalysis(
  filesystemTargets: readonly LegacyBashFilesystemTarget[],
): CapabilityInvocationAnalysis {
  const sortedTargets = [...filesystemTargets].sort((left, right) =>
    Buffer.compare(Buffer.from(left.canonicalTarget), Buffer.from(right.canonicalTarget)));
  return {
    resourceCoverage: { kind: 'complete' },
    grantability: { kind: 'persistable' },
    safety: { kind: 'eligible' },
    attributes: {
      kind: LEGACY_BASH_ANALYSIS_VERSION,
      command: 'fixture command',
      patterns: ['bash:fixture *'],
      forceConfirm: false,
      reasons: [],
      accessesExternalProject: false,
      filesystemTargets: sortedTargets,
    },
  };
}

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}
