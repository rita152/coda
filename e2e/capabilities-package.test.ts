// Canonical package contract: external consumers compose through only the three declared entries.
import { afterEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const CAPABILITIES_JS = path.join(ROOT, 'dist', 'capabilities', 'index.js');
const CAPABILITIES_TYPES = path.join(ROOT, 'dist', 'capabilities', 'index.d.ts');
const CODING_CAPABILITIES_JS = path.join(ROOT, 'dist', 'coding-capabilities', 'index.js');
const CODING_CAPABILITIES_TYPES = path.join(
  ROOT,
  'dist',
  'integrations',
  'coding-capabilities',
  'index.d.ts',
);
const RUNTIME_JS = path.join(ROOT, 'dist', 'runtime', 'index.js');
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe('canonical capability package exports', () => {
  it('imports both ESM entries externally and registers exactly the eight explicit bindings', async () => {
    for (const artifact of [
      CAPABILITIES_JS,
      CAPABILITIES_TYPES,
      CODING_CAPABILITIES_JS,
      CODING_CAPABILITIES_TYPES,
    ]) {
      expect(existsSync(artifact)).toBe(true);
    }

    const consumerRoot = makeConsumerRoot();
    const probePath = path.join(consumerRoot, 'import-probe.mjs');
    writeFileSync(
      probePath,
      [
        "const capabilities = await import('coda/capabilities');",
        "const coding = await import('coda/coding-capabilities');",
        'const registry = capabilities.createCapabilityRegistry();',
        'const nativeRegistrations = coding.createCodingCapabilityRegistrations();',
        'const registrations = nativeRegistrations.map((registration) => registry.register(registration));',
        'console.log(JSON.stringify({',
        '  factoryKinds: [',
        '    capabilities.createCapabilityRegistry,',
        '    capabilities.createProviderAdapterRegistry,',
        '    capabilities.createPromptAssembler,',
        '    capabilities.createPolicyEngine,',
        '  ].map((factory) => typeof factory),',
        '  hasRemovedAdapter: Object.hasOwn(capabilities, "adaptLegacyTool"),',
        '  leaksConcreteTools: Object.hasOwn(capabilities, "createCodingCapabilityRegistrations"),',
        '  registrationNames: nativeRegistrations.map((registration) => registration.id),',
        '  registrations,',
        '  catalogNames: registry.snapshot().entries.map((entry) => entry.id),',
        '}));',
      ].join('\n'),
      'utf8',
    );

    const result = await run([bunExecutable(), '--no-env-file', probePath], consumerRoot);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout) as unknown).toEqual({
      factoryKinds: ['function', 'function', 'function', 'function'],
      hasRemovedAdapter: false,
      leaksConcreteTools: false,
      registrationNames: ['read', 'ls', 'glob', 'grep', 'bash', 'edit', 'write', 'plan'],
      registrations: [
        { ok: true, revision: 1 },
        { ok: true, revision: 2 },
        { ok: true, revision: 3 },
        { ok: true, revision: 4 },
        { ok: true, revision: 5 },
        { ok: true, revision: 6 },
        { ok: true, revision: 7 },
        { ok: true, revision: 8 },
      ],
      catalogNames: ['read', 'ls', 'glob', 'grep', 'bash', 'edit', 'write', 'plan'],
    });
    expect(readdirSync(path.join(consumerRoot, '.home'))).not.toContain('.coda');

    const providerImport = /(?:from\s*|import\()\s*["'](?:openai(?:\/[^"']*)?|@anthropic-ai\/sdk(?:\/[^"']*)?)["']/;
    expect(readFileSync(CAPABILITIES_JS, 'utf8')).not.toMatch(providerImport);
    expect(readFileSync(CODING_CAPABILITIES_JS, 'utf8')).not.toMatch(providerImport);
    expect(readFileSync(RUNTIME_JS, 'utf8')).not.toMatch(
      /(?:from\s*|import\()\s*["'](?:zod|openai(?:\/[^"']*)?|@anthropic-ai\/sdk(?:\/[^"']*)?)["']/,
    );
  });

  it('constructs and closes a registry Runtime externally through only the three public entries', async () => {
    const consumerRoot = makeConsumerRoot();
    const probePath = path.join(consumerRoot, 'runtime-probe.mjs');
    writeFileSync(
      probePath,
      [
        "const runtimeApi = await import('coda/runtime');",
        "const capabilities = await import('coda/capabilities');",
        "const coding = await import('coda/coding-capabilities');",
        'const capabilityRegistry = capabilities.createCapabilityRegistry();',
        'const registrations = coding.createCodingCapabilityRegistrations()',
        '  .map((registration) => capabilityRegistry.register(registration));',
        'if (registrations.some((result) => !result.ok)) throw new Error("capability registration failed");',
        'const providerRegistry = capabilities.createProviderAdapterRegistry();',
        'const unexpectedCalls = {',
        '  modelResolver: 0,',
        '  permissionPolicy: 0,',
        '  basePrompts: 0,',
        '  ruleSnapshots: 0,',
        '  ruleFreshness: 0,',
        '  driverCreate: 0,',
        '  driverResume: 0,',
        '};',
        'const unexpected = (name) => {',
        '  unexpectedCalls[name] += 1;',
        '  throw new Error(`unexpected package smoke call: ${name}`);',
        '};',
        'const runtime = await runtimeApi.createRuntime({',
        '  workspace: { cwd: process.cwd(), workspaceId: "package-external-workspace" },',
        '  storage: runtimeApi.createMemoryRuntimeStorage(),',
        '  modelResolver: { resolve: () => unexpected("modelResolver") },',
        '  permissionPolicy: {',
        '    snapshotWorkspaceCeiling: () => unexpected("permissionPolicy"),',
        '    resolveCeiling: () => unexpected("permissionPolicy"),',
        '  },',
        '  threadDriverFactory: {',
        '    create: () => unexpected("driverCreate"),',
        '    resume: () => unexpected("driverResume"),',
        '  },',
        '  capabilityServices: {',
        '    capabilities: capabilityRegistry,',
        '    providers: providerRegistry,',
        '    promptAssembler: capabilities.createPromptAssembler(),',
        '    basePrompts: { capture: () => unexpected("basePrompts") },',
        '    ruleSnapshots: { capture: () => unexpected("ruleSnapshots") },',
        '    ruleBudget: { maxFiles: 0, maxFileBytes: 0, maxBytes: 0, maxPromptTokens: 0 },',
        '    policyEngine: capabilities.createPolicyEngine(),',
        '    ruleFreshness: { check: () => unexpected("ruleFreshness") },',
        '  },',
        '});',
        'const threads = await runtime.listThreads();',
        'await runtime.close();',
        'console.log(JSON.stringify({',
        '  workspaceId: runtime.workspaceId,',
        '  registrationCount: registrations.length,',
        '  providerCount: providerRegistry.snapshot().entries.length,',
        '  threads,',
        '  unexpectedCalls,',
        '}));',
      ].join('\n'),
      'utf8',
    );

    const before = readdirSync(consumerRoot).sort();
    const result = await run([bunExecutable(), '--no-env-file', probePath], consumerRoot);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout) as unknown).toEqual({
      workspaceId: 'package-external-workspace',
      registrationCount: 8,
      providerCount: 0,
      threads: [],
      unexpectedCalls: {
        modelResolver: 0,
        permissionPolicy: 0,
        basePrompts: 0,
        ruleSnapshots: 0,
        ruleFreshness: 0,
        driverCreate: 0,
        driverResume: 0,
      },
    });
    expect(readdirSync(consumerRoot).sort()).toEqual(before);
    // Bun may create its own HOME/Library cache directory; the package must not create coda state.
    expect(readdirSync(path.join(consumerRoot, '.home'))).not.toContain('.coda');
    expect(existsSync(path.join(consumerRoot, '.coda'))).toBe(false);
  });

  it('resolves all three declarations for an external strict TypeScript consumer', async () => {
    const consumerRoot = makeConsumerRoot();
    const sourcePath = path.join(consumerRoot, 'consumer.ts');
    writeFileSync(
      sourcePath,
      [
        'import {',
        '  createCapabilityRegistry,',
        '  createPolicyEngine,',
        '  createPromptAssembler,',
        '  createProviderAdapterRegistry,',
        '  type RuleFreshnessResult as CapabilityRuleFreshnessResult,',
        '  type RuntimeCapabilityServices as CapabilityServices,',
        "} from 'coda/capabilities';",
        'import {',
        '  createCodingCapabilityRegistrations,',
        "} from 'coda/coding-capabilities';",
        'import type {',
        '  CreateRuntimeOptions,',
        '  PolicyGrantRepository,',
        '  RuleFreshnessResult as RuntimeRuleFreshnessResult,',
        '  RuntimeCapabilityServices as RuntimeServices,',
        '  RuntimeThreadDriverFactory,',
        '  ThreadDriverHostServices,',
        "} from 'coda/runtime';",
        'const capabilityRegistry = createCapabilityRegistry();',
        'const providerRegistry = createProviderAdapterRegistry();',
        'const promptAssembler = createPromptAssembler();',
        'const policyEngine = createPolicyEngine();',
        'const registration = createCodingCapabilityRegistrations()[0]!;',
        'capabilityRegistry.register(registration);',
        "const readers: Pick<RuntimeServices, 'capabilities' | 'providers' | 'promptAssembler' | 'policyEngine'> = {",
        '  capabilities: capabilityRegistry,',
        '  providers: providerRegistry,',
        '  promptAssembler,',
        '  policyEngine,',
        '};',
        "const sameSurface: Pick<CapabilityServices, keyof typeof readers> = readers;",
        "type RuntimeComposition = Pick<CreateRuntimeOptions, 'capabilityServices' | 'threadDriverFactory'>;",
        "type HasCapabilityMode = 'capabilityMode' extends keyof CreateRuntimeOptions ? true : false;",
        "type HasDriverRequirements = 'requirements' extends keyof RuntimeThreadDriverFactory ? true : false;",
        "type HasGrantMode = 'grantMode' extends keyof RuntimeServices ? true : false;",
        "type HasRepositoryMode = 'mode' extends keyof PolicyGrantRepository ? true : false;",
        'const driverFactory: RuntimeThreadDriverFactory | undefined = undefined;',
        'const driverHost: ThreadDriverHostServices | undefined = undefined;',
        'const hasCapabilityMode: HasCapabilityMode = false;',
        'const hasDriverRequirements: HasDriverRequirements = false;',
        'const hasGrantMode: HasGrantMode = false;',
        'const hasRepositoryMode: HasRepositoryMode = false;',
        '// @ts-expect-error removed runtime migration alias',
        "type RemovedRegistryOptions = import('coda/runtime').RegistryCreateRuntimeOptions;",
        '// @ts-expect-error removed runtime migration base interface',
        "type RemovedBaseOptions = import('coda/runtime').CreateRuntimeBaseOptions;",
        '// @ts-expect-error removed driver factory alias',
        "type RemovedDriverFactory = import('coda/runtime').ThreadDriverFactory;",
        '// @ts-expect-error removed driver host alias',
        "type RemovedDriverHost = import('coda/runtime').RuntimeThreadDriverHostServices;",
        '// @ts-expect-error removed unused fence authority',
        "type RemovedFenceAuthority = import('coda/runtime').WorkspaceWriteFenceAuthority;",
        'const freshnessFromCapabilities: CapabilityRuleFreshnessResult = { fresh: true };',
        'const freshnessFromRuntime: RuntimeRuleFreshnessResult = freshnessFromCapabilities;',
        'void sameSurface;',
        'void (undefined as RuntimeComposition | undefined);',
        'void driverFactory;',
        'void driverHost;',
        'void hasCapabilityMode;',
        'void hasDriverRequirements;',
        'void hasGrantMode;',
        'void hasRepositoryMode;',
        'void (undefined as RemovedRegistryOptions | undefined);',
        'void (undefined as RemovedBaseOptions | undefined);',
        'void (undefined as RemovedDriverFactory | undefined);',
        'void (undefined as RemovedDriverHost | undefined);',
        'void (undefined as RemovedFenceAuthority | undefined);',
        'void freshnessFromRuntime;',
      ].join('\n'),
      'utf8',
    );

    const result = await run([
      path.join(ROOT, 'node_modules', '.bin', 'tsc'),
      '--noEmit',
      '--strict',
      '--target',
      'ESNext',
      '--module',
      'ESNext',
      '--moduleResolution',
      'Bundler',
      sourcePath,
    ], consumerRoot);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });
});

function makeConsumerRoot(): string {
  const consumerRoot = mkdtempSync(path.join(tmpdir(), 'coda-capability-consumer-'));
  tempDirs.push(consumerRoot);
  const nodeModules = path.join(consumerRoot, 'node_modules');
  mkdirSync(nodeModules);
  mkdirSync(path.join(consumerRoot, '.home'));
  symlinkSync(ROOT, path.join(nodeModules, 'coda'), 'dir');
  return consumerRoot;
}

function bunExecutable(): string {
  const executable = Bun.argv[0];
  if (executable === undefined) throw new Error('cannot locate Bun executable');
  return executable;
}

async function run(
  argv: readonly string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([...argv], {
    cwd,
    env: {
      HOME: path.join(cwd, '.home'),
      PATH: Bun.env.PATH ?? '',
      TERM: 'dumb',
      NO_COLOR: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}
