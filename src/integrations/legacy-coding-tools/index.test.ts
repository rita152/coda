import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { strictJsonSnapshot } from '../../protocol/index.js';
import type { InvocationContext } from '../../capabilities/types.js';
import type { LegacyBashInvocationAnalysisAttributes } from './bash-analyze.js';
import {
  createCodingToolCapabilityBindings,
  LEGACY_FILESYSTEM_ANALYSIS_VERSION,
} from './index.js';
import type { LegacyFilesystemInvocationAnalysisAttributes } from './index.js';

const context = strictJsonSnapshot({
  workspaceId: 'ws_binding_test',
  threadId: 'th_binding_test',
  runId: 'run_binding_test',
  turnId: 'turn_binding_test',
  invocationId: 'invocation-1',
  toolCallId: 'call-1',
  capabilityId: 'bash',
  catalogRevision: 1,
  cwd: process.cwd(),
}) as unknown as InvocationContext;
const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

describe('legacy coding tool capability bindings', () => {
  test('exposes exactly the eight explicit bindings in stable prompt order', () => {
    const bindings = createCodingToolCapabilityBindings();
    expect(bindings.map((binding) => binding.tool.name)).toEqual([
      'read', 'ls', 'glob', 'grep', 'bash', 'edit', 'write', 'plan',
    ]);
    expect(bindings.every((binding) => binding.policy.kind === binding.tool.kind)).toBe(true);
    expect(bindings.map((binding) => binding.version)).toEqual([
      '2', '2', '2', '2', '2', '2', '2', '2',
    ]);
    expect(Object.isFrozen(bindings)).toBe(true);
  });

  test('freezes exact target kinds for every non-bash built-in resolver', async () => {
    const bindings = createCodingToolCapabilityBindings();
    for (const fixture of [
      { name: 'read', args: { path: 'nested/item.ts' }, kind: 'file' as const },
      { name: 'ls', args: { path: 'nested' }, kind: 'directory' as const },
      { name: 'glob', args: { path: 'nested' }, kind: 'directory' as const },
      { name: 'grep', args: { path: 'nested' }, kind: 'directory' as const },
      { name: 'edit', args: { path: 'nested/item.ts' }, kind: 'file' as const },
      { name: 'write', args: { path: 'nested/item.ts' }, kind: 'file' as const },
    ]) {
      const binding = bindings.find((candidate) => candidate.tool.name === fixture.name);
      if (binding === undefined) throw new Error(`missing ${fixture.name} binding`);
      const result = await binding.resolveResources(fixture.args, context);
      expect(result.ok, fixture.name).toBe(true);
      if (!result.ok) continue;
      const attributes = result.analysis?.attributes as unknown as LegacyFilesystemInvocationAnalysisAttributes;
      expect(attributes, fixture.name).toEqual({
        kind: LEGACY_FILESYSTEM_ANALYSIS_VERSION,
        filesystemTargets: [{
          canonicalTarget: path.join(context.cwd, ...fixture.args.path.split('/')),
          kind: fixture.kind,
        }],
      });
    }

    const plan = bindings.find((candidate) => candidate.tool.name === 'plan');
    if (plan === undefined) throw new Error('missing plan binding');
    const result = await plan.resolveResources({}, context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.analysis?.attributes).toEqual({
      kind: LEGACY_FILESYSTEM_ANALYSIS_VERSION,
      filesystemTargets: [],
    });
  });

  test('keeps the two same-type bash selectors distinct and permits multiple targets', async () => {
    const bash = createCodingToolCapabilityBindings().find((binding) => binding.tool.name === 'bash');
    if (bash === undefined) throw new Error('missing bash binding');
    const result = await bash.resolveResources({
      command: 'cp ./a.txt ./b.txt && cat ./c.txt > ./d.txt',
    }, context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const read = result.resources.filter((resource) => resource.selectorId === 'filesystem_read_target');
    const write = result.resources.filter((resource) => resource.selectorId === 'filesystem_write_target');
    expect(read.length).toBeGreaterThanOrEqual(2);
    expect(write.length).toBeGreaterThanOrEqual(2);
    expect(result.resources.some((resource) => resource.selectorId === 'command')).toBe(true);
    expect(result.resources.some((resource) => resource.selectorId === 'workdir')).toBe(true);
  });

  test('uses one authoritative cwd chain for literal cd, -C, redirects, and bare filenames', async () => {
    const bash = bashBinding();
    const cd = await bash.resolveResources({
      command: 'cd ./packages/app && rm generated.txt',
    }, context);
    expect(cd.ok).toBe(true);
    if (!cd.ok) return;
    expect(cd.resources).toContainEqual(expect.objectContaining({
      selectorId: 'filesystem_write_target',
      canonicalTarget: path.join(context.cwd, 'packages', 'app', 'generated.txt'),
    }));
    expect(cd.resources).toContainEqual(expect.objectContaining({
      selectorId: 'filesystem_read_target',
      canonicalTarget: path.join(context.cwd, 'packages', 'app'),
    }));
    expect(cd.analysis?.resourceCoverage).toEqual({ kind: 'complete' });
    const frozenAnalysis = cd.analysis?.attributes as unknown as LegacyBashInvocationAnalysisAttributes;
    const frozenTargets = frozenAnalysis.filesystemTargets;
    expect(frozenTargets).toEqual(expect.arrayContaining([
      {
        canonicalTarget: context.cwd,
        kind: 'directory',
      },
      {
        canonicalTarget: path.join(context.cwd, 'packages', 'app'),
        kind: 'directory',
      },
      {
        canonicalTarget: path.join(context.cwd, 'packages', 'app', 'generated.txt'),
        kind: 'unknown',
      },
    ]));
    expect([...frozenTargets].sort((left, right) =>
      Buffer.compare(Buffer.from(left.canonicalTarget), Buffer.from(right.canonicalTarget))))
      .toEqual([...frozenTargets]);

    const directoryOption = await bash.resolveResources({
      command: 'git -C ./packages/app status > report.txt',
    }, context);
    expect(directoryOption.ok).toBe(true);
    if (!directoryOption.ok) return;
    expect(directoryOption.resources).toContainEqual(expect.objectContaining({
      selectorId: 'filesystem_read_target',
      canonicalTarget: path.join(context.cwd, 'packages', 'app'),
    }));
    expect(directoryOption.resources).toContainEqual(expect.objectContaining({
      selectorId: 'filesystem_write_target',
      canonicalTarget: path.join(context.cwd, 'report.txt'),
    }));
  });

  test('freezes opaque and external bash calls as once-only while retaining an askable resolution', async () => {
    const bash = bashBinding();
    for (const command of [
      'echo $(pwd)',
      'echo `pwd`',
      'diff <(sort a.txt) <(sort b.txt)',
      'eval "cat ./policy.txt"',
      'if test -f a.txt; then cat a.txt; fi',
      'cat ~/secret.txt',
    ]) {
      const result = await bash.resolveResources({ command }, context);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.analysis?.resourceCoverage.kind).toBe('incomplete');
      expect(result.analysis?.grantability.kind).toBe('once_only');
      expect(result.analysis?.safety.kind).toBe('eligible');
    }

    const external = await bash.resolveResources({ command: 'cat ../outside.txt' }, context);
    expect(external.ok).toBe(true);
    if (!external.ok) return;
    expect(external.analysis?.resourceCoverage).toEqual({ kind: 'complete' });
    expect(external.analysis?.grantability.kind).toBe('once_only');
    expect(external.analysis?.attributes).toMatchObject({ accessesExternalProject: true });
  });

  test('freezes interpreter inline/script entry points as incomplete and once-only', async () => {
    for (const command of [
      'python -c "open(\'nested/out\', \'w\').close()"',
      'node -e "require(\'fs\').writeFileSync(\'nested/out\', \'x\')"',
      'python ./scripts/generate.py',
      'bun run ./scripts/generate.ts',
      'sudo -u root python -c "open(\'nested/out\', \'w\').close()"',
    ]) {
      const result = await bashBinding().resolveResources({ command }, context);
      expect(result.ok, command).toBe(true);
      if (!result.ok) continue;
      expect(result.analysis?.resourceCoverage.kind, command).toBe('incomplete');
      expect(result.analysis?.grantability.kind, command).toBe('once_only');
      expect(result.analysis?.attributes, command).toMatchObject({ forceConfirm: true });
    }
  });

  test('freezes conflicting and unknown target evidence as unknown', async () => {
    for (const command of [
      'printf x > .',
      'cat nested; cd nested',
    ]) {
      const result = await bashBinding().resolveResources({ command }, context);
      expect(result.ok, command).toBe(true);
      if (!result.ok) continue;
      const attributes = result.analysis?.attributes as unknown as LegacyBashInvocationAnalysisAttributes;
      const expectedTarget = command.startsWith('printf')
        ? context.cwd
        : path.join(context.cwd, 'nested');
      expect(attributes.filesystemTargets, command).toContainEqual({
        canonicalTarget: expectedTarget,
        kind: 'unknown',
      });
    }
  });

  test('marks incomplete canonicalization once-only instead of failing the askable invocation', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'coda-bash-resolver-'));
    temporaryDirectories.push(root);
    symlinkSync('loop', path.join(root, 'loop'));
    const result = await bashBinding().resolveResources(
      { command: 'cat ./loop/file.txt' },
      { ...context, cwd: root },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.analysis?.resourceCoverage.kind).toBe('incomplete');
    expect(result.analysis?.grantability.kind).toBe('once_only');
    expect(result.analysis?.resourceCoverage).toMatchObject({
      reasons: [expect.stringContaining('could not be canonicalized')],
    });
  });

  test('carries authoritative denylist decisions in frozen generic safety analysis', async () => {
    const result = await bashBinding().resolveResources({ command: 'rm -rf /' }, context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.analysis?.safety).toMatchObject({
      kind: 'deny',
      code: 'legacy_bash_command_denied',
    });
    expect(result.analysis?.grantability.kind).toBe('once_only');
  });

  test('denies lexical root aliases and multi-call applets before approval', async () => {
    for (const command of [
      'rm -rf --no-preserve-root //',
      'rm -rf /./*',
      'rm -rf ${HOME}/./*',
      'busybox rm -rf /',
      'toybox dd if=/dev/zero of=/dev/sda',
    ]) {
      const result = await bashBinding().resolveResources({ command }, context);
      expect(result.ok, command).toBe(true);
      if (!result.ok) continue;
      expect(result.analysis?.safety.kind, command).toBe('deny');
      expect(result.analysis?.grantability.kind, command).toBe('once_only');
    }
  });
});

function bashBinding() {
  const bash = createCodingToolCapabilityBindings().find((binding) => binding.tool.name === 'bash');
  if (bash === undefined) throw new Error('missing bash binding');
  return bash;
}
