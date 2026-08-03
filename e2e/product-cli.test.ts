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
  ], home, cwd);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout)).toMatchObject({
    type: 'sessions',
    cwd: realpathSync(cwd),
    sessions: [],
  });
  expect(allRelativeFiles(home).some((file) => /thread|journal/iu.test(file))).toBe(false);
  expect(existsSync(staleTruncation)).toBe(true);
}, T);

test('exec --json uses the canonical one-shot NDJSON transport', () => {
  const root = temporaryRoot('coda-product-exec-');
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'work');
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
    '--cwd', cwd,
    '-p', 'run through exec',
  ], home, cwd);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe('');
  const frames = result.stdout.trimEnd().split('\n').map((line) => JSON.parse(line) as {
    readonly type?: string;
    readonly protocolVersion?: string;
    readonly event?: {
      readonly type?: string;
      readonly message?: { readonly role?: string; readonly content?: readonly { readonly text?: string }[] };
      readonly reason?: string;
    };
  });
  expect(frames[0]).toMatchObject({ type: 'protocol', protocolVersion: '2.0.0' });
  expect(frames.some((frame) =>
    frame.event?.type === 'message_start' &&
    frame.event.message?.role === 'user' &&
    frame.event.message.content?.[0]?.text === 'run through exec')).toBe(true);
  expect(frames.some((frame) =>
    frame.event?.type === 'message_end' &&
    frame.event.message?.role === 'assistant' &&
    frame.event.message.content?.[0]?.text === 'exec alias answer')).toBe(true);
  expect(frames.some((frame) =>
    frame.event?.type === 'agent_end' && frame.event.reason === 'completed')).toBe(true);
}, T);

test('opt-in output formats keep final stdout stable and text progress on stderr', () => {
  const root = temporaryRoot('coda-product-output-');
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'work');
  const script = path.join(root, 'faux.json');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(script, JSON.stringify({
    turns: [{ events: [{ kind: 'text', text: 'automation answer' }] }],
    onExhausted: 'emptyStop',
  }), 'utf8');
  const base = [
    'exec', '--provider', 'faux', '--faux-script', script, '--cwd', cwd,
    '-p', 'automation task',
  ] as const;

  const text = runCoda([...base, '--output=text'], home, cwd);
  expect(text).toEqual({
    code: 0,
    stdout: 'automation answer\n',
    stderr: '[coda] running\n',
  });

  const json = runCoda([...base, '--output=json'], home, cwd);
  expect(json.code).toBe(0);
  expect(json.stderr).toBe('');
  expect(JSON.parse(json.stdout)).toMatchObject({
    type: 'result',
    version: 1,
    status: 'completed',
    exitCode: 0,
    text: 'automation answer',
  });

  const stream = runCoda([...base, '--output=stream-json'], home, cwd);
  expect(stream.code).toBe(0);
  expect(stream.stderr).toBe('');
  const records = stream.stdout.trimEnd().split('\n').map((line) => JSON.parse(line) as {
    readonly type: string;
    readonly status?: string;
  });
  expect(records[0]?.type).toBe('stream_start');
  expect(records.some((record) => record.type === 'event')).toBe(true);
  expect(records.at(-1)).toMatchObject({ type: 'result', status: 'completed' });

  const finalOnly = runCoda([
    ...base, '--output=stream-json', '--final-only',
  ], home, cwd);
  expect(finalOnly.code).toBe(0);
  expect(finalOnly.stdout.trimEnd().split('\n')).toHaveLength(1);
  expect(JSON.parse(finalOnly.stdout)).toMatchObject({ type: 'result', status: 'completed' });
}, T);

test('stream-json broken pipe aborts the run before a delayed tool side effect', async () => {
  const root = temporaryRoot('coda-product-broken-pipe-');
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'work');
  const script = path.join(root, 'faux.json');
  const marker = path.join(cwd, 'must-not-exist');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(script, JSON.stringify({
    turns: [{ events: [{
      kind: 'tool_call',
      name: 'bash',
      args: { command: 'sleep 0.5; touch must-not-exist' },
    }] }],
    onExhausted: 'emptyStop',
  }), 'utf8');

  const result = await runCodaClosingStdoutAfterFirstLine([
    'exec', '--provider', 'faux', '--faux-script', script, '--cwd', cwd,
    '--ephemeral', '--output=stream-json', '-p', 'stop when stdout closes',
  ], home, cwd);

  expect(JSON.parse(result.stdout.split('\n')[0] as string)).toMatchObject({
    type: 'stream_start',
  });
  expect(result.code).toBe(1);
  expect(result.stderr.match(/stdout write failed/gu)).toHaveLength(1);
  await Bun.sleep(600);
  expect(existsSync(marker)).toBe(false);
}, T);

test('ephemeral one-shot leaves no Runtime/session journal and timeout exits 124', () => {
  const root = temporaryRoot('coda-product-ephemeral-');
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'work');
  const successScript = path.join(root, 'success.json');
  const timeoutScript = path.join(root, 'timeout.json');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(successScript, JSON.stringify({
    turns: [{ events: [{ kind: 'text', text: 'temporary answer' }] }],
    onExhausted: 'emptyStop',
  }), 'utf8');
  writeFileSync(timeoutScript, JSON.stringify({
    turns: [{ events: [{
      kind: 'tool_call',
      name: 'bash',
      args: { command: 'sleep 2' },
    }] }],
    onExhausted: 'emptyStop',
  }), 'utf8');

  const success = runCoda([
    'exec', '--provider', 'faux', '--faux-script', successScript,
    '--cwd', cwd,
    '--ephemeral', '--output=json', '-p', 'temporary task',
  ], home, cwd);
  expect(success.code).toBe(0);
  expect(JSON.parse(success.stdout)).toMatchObject({ status: 'completed' });
  expect(allRelativeFiles(home).some((file) => /thread|journal|runtime/iu.test(file))).toBe(false);

  const timeout = runCoda([
    'exec', '--provider', 'faux', '--faux-script', timeoutScript,
    '--cwd', cwd,
    '--ephemeral', '--output=json', '--timeout=50ms', '-p', 'wait too long',
  ], home, cwd);
  expect(timeout.code).toBe(124);
  expect(timeout.stderr).toBe('');
  expect(JSON.parse(timeout.stdout)).toMatchObject({
    type: 'result',
    status: 'timeout',
    exitCode: 124,
  });
  expect(allRelativeFiles(home).some((file) => /thread|journal|runtime/iu.test(file))).toBe(false);
}, T);

test('provider HTTP failures survive the strict Runtime boundary and explain machine failure', async () => {
  const root = temporaryRoot('coda-product-provider-error-');
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'work');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => Response.json(
      { error: { message: 'regional opt-in required', type: 'permission_denied' } },
      { status: 403 },
    ),
  });
  try {
    const result = await runCodaAsync([
      'exec', '--provider', 'openai-chat', '--model', 'error-fixture',
      '--base-url', `http://127.0.0.1:${server.port}/v1`, '--api-key', 'local-fixture-key',
      '--cwd', cwd, '--ephemeral', '--output=json', '-p', 'fail with details',
    ], home, cwd);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      type: 'result',
      status: 'error',
      exitCode: 1,
      error: expect.stringMatching(/403.*regional opt-in required/iu),
    });
  } finally {
    server.stop(true);
  }
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

async function runCodaClosingStdoutAfterFirstLine(
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
  const stderrPromise = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let stdout = '';
  try {
    while (!stdout.includes('\n')) {
      const { done, value } = await reader.read();
      if (done) break;
      stdout += decoder.decode(value, { stream: true });
    }
    await reader.cancel();
  } finally {
    reader.releaseLock();
  }

  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await Promise.race([
      child.exited,
      new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(() => {
          child.kill(9);
          reject(new Error('broken-pipe child did not exit'));
        }, 5_000);
      }),
    ]);
    return { code, stdout, stderr: await stderrPromise };
  } finally {
    if (watchdog !== undefined) clearTimeout(watchdog);
    child.kill();
  }
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
