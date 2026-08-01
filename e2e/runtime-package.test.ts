// Phase 1 package-level contract: a consumer outside the repository can resolve
// `coda/runtime` (JavaScript + declarations), and importing it performs no host IO.
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
const RUNTIME_JS = path.join(ROOT, 'dist', 'runtime', 'index.js');
const RUNTIME_TYPES = path.join(ROOT, 'dist', 'runtime', 'index.d.ts');
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe('coda/runtime package export', () => {
  it('is an inert ESM import from an external consumer', async () => {
    expect(existsSync(RUNTIME_JS)).toBe(true);
    expect(existsSync(RUNTIME_TYPES)).toBe(true);

    const consumerRoot = makeConsumerRoot();
    const probePath = path.join(consumerRoot, 'import-probe.mjs');
    writeFileSync(
      probePath,
      [
        "import fs from 'node:fs';",
        "import { syncBuiltinESMExports } from 'node:module';",
        "const effects = [];",
        "for (const method of ['access', 'accessSync', 'appendFile', 'appendFileSync', 'lstat', 'lstatSync', 'mkdir', 'mkdirSync', 'open', 'openSync', 'readFile', 'readFileSync', 'readdir', 'readdirSync', 'realpath', 'realpathSync', 'stat', 'statSync', 'writeFile', 'writeFileSync']) {",
        "  const original = fs[method].bind(fs);",
        "  fs[method] = (...args) => { effects.push(`fs:${method}`); return original(...args); };",
        "}",
        "for (const method of ['access', 'appendFile', 'lstat', 'mkdir', 'open', 'readFile', 'readdir', 'realpath', 'stat', 'writeFile']) {",
        "  const original = fs.promises[method].bind(fs.promises);",
        "  fs.promises[method] = (...args) => { effects.push(`fs.promises:${method}`); return original(...args); };",
        "}",
        "syncBuiltinESMExports();",
        "process.env = new Proxy({}, {",
        "  get(_target, key) { effects.push(`env:${String(key)}`); return undefined; },",
        "  ownKeys() { effects.push('env:*'); return []; },",
        "  getOwnPropertyDescriptor() { return { enumerable: true, configurable: true }; },",
        "});",
        "for (const method of ['on', 'once', 'addListener']) {",
        "  const original = process[method];",
        "  process[method] = function (event, ...args) {",
        "    if (typeof event === 'string' && event.startsWith('SIG')) effects.push(`signal:${event}`);",
        "    return original.call(this, event, ...args);",
        "  };",
        "}",
        "const originalFile = Bun.file;",
        "Bun.file = (...args) => { effects.push('file'); return originalFile(...args); };",
        "const originalWrite = Bun.write;",
        "Bun.write = (...args) => { effects.push('write'); return originalWrite(...args); };",
        "const originalSpawn = Bun.spawn;",
        "Bun.spawn = (...args) => { effects.push('spawn'); return originalSpawn(...args); };",
        "for (const method of ['connect', 'listen', 'serve']) {",
        "  if (typeof Bun[method] !== 'function') continue;",
        "  const original = Bun[method];",
        "  Bun[method] = (...args) => { effects.push(method); return original(...args); };",
        "}",
        "const originalFetch = globalThis.fetch;",
        "globalThis.fetch = (...args) => { effects.push('fetch'); return originalFetch(...args); };",
        "const imported = await import('coda/runtime');",
        "console.log(JSON.stringify({",
        "  effects,",
        "  hasFactory: typeof imported.createRuntime === 'function',",
        "  hasSupervisor: Object.hasOwn(imported, 'Supervisor'),",
        "}));",
      ].join('\n'),
      'utf8',
    );

    const result = await run([bunExecutable(), '--no-env-file', probePath], consumerRoot);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout) as unknown).toEqual({
      effects: [],
      hasFactory: true,
      hasSupervisor: false,
    });
    expect(readdirSync(path.join(consumerRoot, '.home'))).toEqual([]);

    const builtSource = readFileSync(RUNTIME_JS, 'utf8');
    expect(builtSource).not.toContain('Bun.env');
    expect(builtSource).not.toMatch(
      /(?:from\s*|import\()\s*["'](?:@opentui\/core|openai(?:\/[^"']*)?|@anthropic-ai\/sdk(?:\/[^"']*)?|node:(?:readline|tty))["']/,
    );
  });

  it('resolves declarations for an external strict TypeScript consumer', async () => {
    const consumerRoot = makeConsumerRoot();
    const sourcePath = path.join(consumerRoot, 'consumer.ts');
    writeFileSync(
      sourcePath,
      [
        "import * as runtime from 'coda/runtime';",
        "import { createRuntime, type CreateRuntimeOptions, type RuntimePort } from 'coda/runtime';",
        'interface ExtendedRuntimeOptions extends CreateRuntimeOptions { readonly hostTag?: string }',
        "type RuntimeFactory = (options: Parameters<typeof createRuntime>[0]) => Promise<RuntimePort>;",
        "const registryMode: ExtendedRuntimeOptions['capabilityMode'] = 'registry';",
        "type HasSupervisor = 'Supervisor' extends keyof typeof runtime ? true : false;",
        "const factory: RuntimeFactory = createRuntime;",
        "const hasSupervisor: HasSupervisor = false;",
        'void factory;',
        'void registryMode;',
        'void hasSupervisor;',
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
  const consumerRoot = mkdtempSync(path.join(tmpdir(), 'coda-runtime-consumer-'));
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
