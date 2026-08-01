// UX1 产品 CLI 边界：真实驱动 dist/main.js，验证薄 bootstrap、输出通道、
// RuntimePort session inventory 与 exec 别名。子进程 HOME 与凭据环境全部隔离。

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, expect, test } from 'bun:test';
import { buildE2eEnvironment, CASE_TIMEOUT_MS, DIST_MAIN, requireDist } from './harness.js';

interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const ownedDirectories: string[] = [];
const T = { timeout: CASE_TIMEOUT_MS };

beforeAll(() => {
  requireDist();
});

afterEach(() => {
  for (const directory of ownedDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('help/version/completion resolve in the side-effect-free bootstrap', () => {
  const root = temporaryRoot('coda-product-bootstrap-');
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'work');
  const codaDir = path.join(home, '.coda');
  mkdirSync(codaDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(path.join(codaDir, 'config.json'), '{invalid-config', 'utf8');
  writeFileSync(path.join(codaDir, 'providers.json'), '{invalid-provider', 'utf8');
  writeFileSync(path.join(codaDir, 'sentinel'), 'do-not-touch', 'utf8');
  const entriesBefore = readdirSync(codaDir).sort();

  const help = runCoda(['--help', '--api-key', 'must-not-be-read'], home, cwd);
  expect(help.code).toBe(0);
  expect(help.stderr).toBe('');
  expect(help.stdout).toContain('First run:');
  expect(help.stdout).toContain('coda auth login');
  expect(help.stdout).not.toContain('must-not-be-read');

  const version = runCoda(['--version', '--definitely-invalid'], home, cwd);
  expect(version).toEqual({ code: 0, stdout: 'coda 0.0.1\n', stderr: '' });

  const completion = runCoda(['completion', 'zsh'], home, cwd);
  expect(completion.code).toBe(0);
  expect(completion.stderr).toBe('');
  expect(completion.stdout).toContain('#compdef coda');
  expect(completion.stdout).toContain('_coda_candidates');
  expect(completion.stdout).toContain('login\nlogout\nstatus');

  expect(readdirSync(codaDir).sort()).toEqual(entriesBefore);
  expect(readFileSync(path.join(codaDir, 'config.json'), 'utf8')).toBe('{invalid-config');
  expect(readFileSync(path.join(codaDir, 'providers.json'), 'utf8')).toBe('{invalid-provider');
  expect(readFileSync(path.join(codaDir, 'sentinel'), 'utf8')).toBe('do-not-touch');

  const untouchedHome = path.join(root, 'untouched-home');
  const untouched = runCoda(['-V'], untouchedHome, cwd);
  expect(untouched).toEqual({ code: 0, stdout: 'coda 0.0.1\n', stderr: '' });
  expect(existsSync(untouchedHome)).toBe(false);

  const builtEntry = readFileSync(DIST_MAIN, 'utf8');
  expect(builtEntry).toMatch(/await import\("\.\/chunks\/main-/);
  expect(builtEntry).toContain('process.exitCode = await bootstrap(');
  expect(builtEntry).not.toContain('ProviderRegistry');
  expect(builtEntry).not.toMatch(/^import .*main-/mu);
}, T);

test('usage errors are stderr-only, actionable, and do not initialize coda state', () => {
  const root = temporaryRoot('coda-product-usage-');
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'work');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });

  const typo = runCoda(['--contine'], home, cwd);
  expect(typo.code).toBe(2);
  expect(typo.stdout).toBe('');
  expect(typo.stderr).toContain('did you mean --continue?');
  expect(typo.stderr).toContain('fix: coda --continue');

  const conflict = runCoda(['--continue', '--resume'], home, cwd);
  expect(conflict.code).toBe(2);
  expect(conflict.stdout).toBe('');
  expect(conflict.stderr).toContain('--continue and --resume are mutually exclusive');
  expect(conflict.stderr).toContain('coda --continue  # or: coda --resume');
  expect(readdirSync(home)).not.toContain('.coda');
}, T);

test('doctor/auth status/models are scriptable and read-only without configuration', () => {
  const root = temporaryRoot('coda-product-readonly-');
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'work');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });

  const doctor = runCoda(['doctor', '--json'], home, cwd);
  expect(doctor.code).toBe(0);
  expect(doctor.stderr).toBe('');
  expect(JSON.parse(doctor.stdout)).toMatchObject({ type: 'doctor', ok: true });

  const auth = runCoda(['auth', 'status', '--json'], home, cwd);
  expect(auth.code).toBe(0);
  expect(auth.stderr).toBe('');
  expect(JSON.parse(auth.stdout)).toEqual({
    type: 'auth_status',
    authenticated: [],
    selectedModel: null,
  });

  const models = runCoda(['models', '--json'], home, cwd);
  expect(models.code).toBe(0);
  expect(models.stderr).toBe('');
  expect(JSON.parse(models.stdout)).toEqual({ type: 'models', selected: null, models: [] });
  expect(readdirSync(home)).not.toContain('.coda');
}, T);

test('auth status, model selection, and logout share provider state without creating a thread', () => {
  const root = temporaryRoot('coda-product-provider-state-');
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'work');
  const codaDir = path.join(home, '.coda');
  const secret = 'provider-secret-never-print';
  mkdirSync(codaDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(path.join(codaDir, 'providers.json'), JSON.stringify({
    version: 1,
    providers: [{
      id: 'custom:openai',
      name: 'OpenAI',
      kind: 'custom',
      baseURL: 'https://api.openai.com/v1',
      api: 'openai-responses',
      models: [{ id: 'gpt-test', api: 'openai-responses' }],
    }],
  }), 'utf8');
  writeFileSync(path.join(codaDir, 'credentials.json'), JSON.stringify({
    version: 1,
    apiKeys: { 'custom:openai': secret },
  }), { encoding: 'utf8', mode: 0o600 });

  const status = runCoda(['auth', 'status', '--json'], home, cwd);
  expect(status.code).toBe(0);
  expect(status.stdout).not.toContain(secret);
  expect(JSON.parse(status.stdout)).toMatchObject({
    type: 'auth_status',
    authenticated: [{ providerId: 'custom:openai', providerName: 'OpenAI' }],
  });

  const select = runCoda(['models', '--select', 'custom:openai/gpt-test', '--json'], home, cwd);
  expect(select.code).toBe(0);
  expect(select.stderr).toBe('');
  expect(select.stdout).not.toContain(secret);
  expect(JSON.parse(select.stdout)).toMatchObject({
    type: 'models',
    selected: 'custom:openai/gpt-test',
  });
  expect(JSON.parse(readFileSync(path.join(codaDir, 'providers.json'), 'utf8'))).toMatchObject({
    selected: { providerId: 'custom:openai', model: 'gpt-test' },
  });
  expect(allRelativeFiles(codaDir).some((file) => /runtime|thread|journal/iu.test(file))).toBe(false);

  const logout = runCoda(['auth', 'logout', 'custom:openai', '--json'], home, cwd);
  expect(logout.code).toBe(0);
  expect(logout.stderr).toBe('');
  expect(JSON.parse(logout.stdout)).toEqual({
    type: 'auth_logout',
    ok: true,
    removed: true,
    providerId: 'custom:openai',
  });
  expect(readFileSync(path.join(codaDir, 'credentials.json'), 'utf8')).not.toContain(secret);
}, T);

test('auth login custom preset saves a secret, refreshes models, and reports the next step', async () => {
  const root = temporaryRoot('coda-product-auth-login-');
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'work');
  const secret = 'local-product-login-secret';
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  let requestedPath = '';
  let authorization = '';
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requestedPath = url.pathname;
      authorization = request.headers.get('authorization') ?? '';
      return Response.json({ data: [{ id: 'model-local' }] });
    },
  });

  try {
    const result = await runCodaAsync([
      'auth', 'login',
      '--preset', 'custom',
      '--name', 'Local Fixture',
      '--base-url', `http://127.0.0.1:${server.port}/v1`,
      '--api', 'openai-responses',
      '--api-key', secret,
      '--json',
    ], home, cwd);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).not.toContain(secret);
    expect(JSON.parse(result.stdout)).toMatchObject({
      type: 'auth_login',
      ok: true,
      saved: true,
      models: 1,
      provider: { name: 'Local Fixture' },
    });
    expect(requestedPath).toBe('/v1/models');
    expect(authorization).toBe(`Bearer ${secret}`);

    const models = runCoda(['models', '--json'], home, cwd);
    expect(JSON.parse(models.stdout)).toMatchObject({
      selected: null,
      models: [{ ref: 'custom:local%20fixture/model-local', api: 'openai-responses' }],
    });
    expect(allRelativeFiles(path.join(home, '.coda')).some((file) =>
      /thread|journal/iu.test(file))).toBe(false);
  } finally {
    server.stop(true);
  }
}, T);

test('sessions lists the current workspace through RuntimePort without creating a thread', () => {
  const root = temporaryRoot('coda-product-sessions-');
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'work');
  const legacySessions = path.join(root, 'legacy-sessions');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const staleTruncation = path.join(home, '.coda', 'truncated', 'old', 'spill.txt');
  mkdirSync(path.dirname(staleTruncation), { recursive: true });
  writeFileSync(staleTruncation, 'inventory must not delete this', 'utf8');
  const oldSeconds = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
  utimesSync(staleTruncation, oldSeconds, oldSeconds);

  const result = runCoda([
    'sessions',
    '--json',
    '--cwd', cwd,
    '--session-dir', legacySessions,
  ], home, cwd);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout)).toMatchObject({
    type: 'sessions',
    cwd: realpathSync(cwd),
    sessions: [],
  });
  expect(allRelativeFiles(home).some((file) => /thread|journal/iu.test(file))).toBe(false);
  const runtimeFiles = allRelativeFiles(legacySessions);
  expect(runtimeFiles.some((file) => /(?:^|\/)threads(?:\/|$)|journal|\.jsonl$/iu.test(file))).toBe(false);
  expect(runtimeFiles.some((file) => file.endsWith('/catalog.json'))).toBe(true);
  expect(existsSync(staleTruncation)).toBe(true);
}, T);

test('exec is an incremental alias for the legacy one-shot NDJSON mode', () => {
  const root = temporaryRoot('coda-product-exec-');
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'work');
  const sessionDir = path.join(root, 'sessions');
  const script = path.join(root, 'faux.json');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(script, JSON.stringify({
    turns: [{ events: [{ kind: 'text', text: 'exec alias answer' }] }],
    onExhausted: 'emptyStop',
  }), 'utf8');

  const result = runCoda([
    'exec',
    '--json',
    '--provider', 'faux',
    '--faux-script', script,
    '--session-dir', sessionDir,
    '--cwd', cwd,
    '-p', 'run through exec',
  ], home, cwd);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe('');
  const events = result.stdout.trimEnd().split('\n').map((line) => JSON.parse(line) as {
    readonly type: string;
    readonly message?: { readonly role?: string; readonly content?: readonly { readonly text?: string }[] };
    readonly reason?: string;
  });
  expect(events[0]?.type).toBe('protocol');
  expect(events.some((event) =>
    event.type === 'message_start' &&
    event.message?.role === 'user' &&
    event.message.content?.[0]?.text === 'run through exec')).toBe(true);
  expect(events.some((event) =>
    event.type === 'message_end' &&
    event.message?.role === 'assistant' &&
    event.message.content?.[0]?.text === 'exec alias answer')).toBe(true);
  expect(events.at(-1)).toMatchObject({ type: 'agent_end', reason: 'completed' });
}, T);

function temporaryRoot(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  ownedDirectories.push(directory);
  return directory;
}

function runCoda(
  args: readonly string[],
  home: string,
  cwd: string,
): CommandResult {
  const result = Bun.spawnSync(
    [Bun.argv[0] as string, '--no-env-file', DIST_MAIN, ...args],
    {
      cwd,
      stdin: new Uint8Array(),
      stdout: 'pipe',
      stderr: 'pipe',
      env: buildE2eEnvironment(Bun.env, home, { TERM: 'dumb', NO_COLOR: '1' }),
    },
  );
  const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
  return {
    code: result.exitCode,
    stdout: decode(result.stdout),
    stderr: decode(result.stderr),
  };
}

async function runCodaAsync(
  args: readonly string[],
  home: string,
  cwd: string,
): Promise<CommandResult> {
  const child = Bun.spawn(
    [Bun.argv[0] as string, '--no-env-file', DIST_MAIN, ...args],
    {
      cwd,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: buildE2eEnvironment(Bun.env, home, { TERM: 'dumb', NO_COLOR: '1' }),
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

function allRelativeFiles(root: string): string[] {
  try {
    const output: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(target);
        else output.push(path.relative(root, target));
      }
    };
    visit(root);
    return output.sort();
  } catch {
    return [];
  }
}
