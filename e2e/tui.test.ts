// L5 e2e:在真实伪终端中启动构建产物，覆盖 createCliRenderer/native framebuffer
// 的 ANSI 输出路径。macOS `script` 提供双 TTY；显式移除 COLORTERM，验证透明
// framebuffer 使用终端默认背景，而不是量化出任意 indexed/truecolor 实色背景。

import {
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, expect, test } from 'bun:test';
import {
  assertSanitizedTestEnvironment,
  sanitizedTestEnvironment,
} from '../scripts/test-environment.js';
import {
  CASE_TIMEOUT_MS,
  DIST_MAIN,
  requireDist,
  WATCHDOG_MS,
} from './harness.js';

const OUTPUT_PREVIEW_LIMIT = 2_000;

async function pumpText(
  stream: ReadableStream<Uint8Array>,
  onChunk: (text: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk(decoder.decode(value, { stream: true }));
    }
    const tail = decoder.decode();
    if (tail !== '') onChunk(tail);
  } finally {
    reader.releaseLock();
  }
}

function waitForPtyExit(
  completion: Promise<number>,
  child: ReturnType<typeof Bun.spawn>,
  output: () => string,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill(9);
      reject(
        new Error(
          `watchdog: PTY did not exit within ${WATCHDOG_MS}ms\n` +
            output().slice(-OUTPUT_PREVIEW_LIMIT),
        ),
      );
    }, WATCHDOG_MS);
    timer.unref();

    void completion.then(
      (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(exitCode);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function runPty(
  root: string,
  env: Record<string, string>,
  args: readonly string[],
  input: string,
  readyMarker?: string,
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const driverPath = path.join(root, `expect-${crypto.randomUUID()}.tcl`);
  writeFileSync(driverPath, [
    'set timeout 15',
    'set ready [lindex $argv 0]',
    'set payload [lindex $argv 1]',
    'set command [lrange $argv 2 end]',
    'spawn -noecho {*}$command',
    'if {$ready ne ""} {',
    '  expect {',
    '    -exact $ready { send -- $payload }',
    '    timeout { exit 124 }',
    '    eof {}',
    '  }',
    '} elseif {$payload ne ""} {',
    '  send -- $payload',
    '}',
    'expect eof',
    'set status [wait]',
    'exit [lindex $status 3]',
    '',
  ].join('\n'), 'utf8');
  const child = Bun.spawn(
    [
      '/usr/bin/expect',
      '-f',
      driverPath,
      readyMarker ?? '',
      input,
      Bun.argv[0] as string,
      '--no-env-file',
      DIST_MAIN,
      ...args,
    ],
    {
      cwd: root,
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );

  let stdout = '';
  let stderr = '';
  const stdoutDone = pumpText(child.stdout, (chunk) => {
    stdout += chunk;
  });
  const stderrDone = pumpText(child.stderr, (chunk) => {
    stderr += chunk;
  });
  const completion = Promise.all([child.exited, stdoutDone, stderrDone]).then(
    ([exitCode]) => exitCode,
  );
  void completion.catch(() => undefined);
  try {
    const code = await waitForPtyExit(
      completion,
      child,
      () => `stdout=${JSON.stringify(stdout)}\nstderr=${JSON.stringify(stderr)}`,
    );
    return { code, stdout, stderr };
  } finally {
    child.kill();
  }
}

beforeAll(() => {
  requireDist();
});

test.skipIf(process.platform !== 'darwin')(
  'auth login 的 preset、普通字段和秘密字段都可用 Ctrl+D 取消并返回 130',
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'coda-auth-eof-'));
    const home = path.join(root, '.home');
    const env: Record<string, string> = {
      ...sanitizedTestEnvironment(Bun.env),
      HOME: home,
      USERPROFILE: home,
      TERM: 'xterm-256color',
      NO_COLOR: '1',
    };
    assertSanitizedTestEnvironment(env);

    try {
      const cases = [
        { args: ['auth', 'login'], marker: 'Preset number or name' },
        { args: ['auth', 'login', '--preset', 'custom'], marker: 'Provider name' },
        { args: ['auth', 'login', '--preset', 'openai'], marker: 'API key' },
      ] as const;
      for (const item of cases) {
        const result = await runPty(root, env, item.args, '\x04', item.marker);
        expect(result.code, JSON.stringify(result)).toBe(130);
        expect(result.stderr).toBe('');
        expect(result.stdout).toContain('[coda] login cancelled');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  { timeout: CASE_TIMEOUT_MS },
);

test.skipIf(process.platform !== 'darwin')(
  '无 COLORTERM 的真实 PTY 使用 SGR 49 透明背景',
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'coda-tui-pty-'));
    const home = path.join(root, '.home');
    const env: Record<string, string> = {
      ...sanitizedTestEnvironment(Bun.env),
      HOME: home,
      USERPROFILE: home,
      TERM: 'xterm-256color',
      COLUMNS: '100',
      LINES: '30',
    };
    delete env.COLORTERM;
    delete env.NO_COLOR;
    assertSanitizedTestEnvironment(env);

    const inputPath = path.join(root, 'stdin');
    writeFileSync(inputPath, '/quit\r', 'utf8');
    const inputFd = openSync(inputPath, 'r');
    const child = Bun.spawn(
      [
        '/usr/bin/script',
        '-q',
        '/dev/null',
        Bun.argv[0] as string,
        '--no-env-file',
        DIST_MAIN,
        '--provider',
        'faux',
        '--approval-mode',
        'allow',
        '--cwd',
        root,
        '--session-dir',
        path.join(root, 'sessions'),
      ],
      {
        cwd: root,
        env,
        stdin: inputFd,
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    closeSync(inputFd);

    try {
      let stdout = '';
      let stderr = '';
      const stdoutDone = pumpText(child.stdout, (chunk) => {
        stdout += chunk;
      });
      const stderrDone = pumpText(child.stderr, (chunk) => {
        stderr += chunk;
      });
      const completion = Promise.all([child.exited, stdoutDone, stderrDone]).then(
        ([exitCode]) => exitCode,
      );
      // watchdog 可能先结束等待；提前接住 completion 的后续 rejection。
      void completion.catch(() => undefined);
      const exitCode = await waitForPtyExit(
        completion,
        child,
        () =>
          `stdout=${JSON.stringify(stdout)}\n` +
          `stderr=${JSON.stringify(stderr)}`,
      );

      expect(
        exitCode,
        `PTY process failed\nstdout=${JSON.stringify(stdout)}\nstderr=${JSON.stringify(stderr)}`,
      ).toBe(0);
      expect(stderr).toBe('');
      expect(stdout).toContain('\x1b[49m');
      expect(stdout).toContain('\x1b[38;5;125m');
      expect(stdout).toContain('─');
      expect(stdout).not.toMatch(/\x1b\[[0-9;]*48;(?:2|5);/);
      expect(stdout).toContain('\x1b]12;#c94740\x07');
      expect(stdout).not.toContain('\x1b]12;#ffffff\x07');
      expect(stdout).toContain('\x1b[5 q');
      expect(stdout).toContain('\x1b]0;coda · ');

      const promptTopMatch = stdout.match(
        /\x1b\[(\d+);2H\x1b\[38;5;125m\x1b\[49m─/,
      );
      expect(promptTopMatch).not.toBeNull();
      const promptTop = Number(promptTopMatch?.[1]);
      expect(promptTop).toBeGreaterThan(1);
    } finally {
      child.kill();
      rmSync(root, { recursive: true, force: true });
    }
  },
  { timeout: CASE_TIMEOUT_MS },
);

test.skipIf(process.platform !== 'darwin')(
  'TERM=dumb auto 使用无控制序列的 append-only accessible 面',
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'coda-accessible-pty-'));
    const home = path.join(root, '.home');
    const env: Record<string, string> = {
      ...sanitizedTestEnvironment(Bun.env),
      HOME: home,
      USERPROFILE: home,
      TERM: 'dumb',
      NO_COLOR: '1',
      COLUMNS: '80',
      LINES: '24',
    };
    assertSanitizedTestEnvironment(env);

    try {
      const result = await runPty(
        root,
        env,
        [
          '--provider', 'faux',
          '--approval-mode', 'allow',
          '--cwd', root,
          '--session-dir', path.join(root, 'sessions'),
        ],
        '/help\r/quit\r',
        'Accessible mode:',
      );
      expect(result.code, JSON.stringify(result)).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('Accessible mode: append-only output.');
      expect(result.stdout).toContain('Ctrl+C: abort a run or exit while idle');
      expect(result.stdout).not.toContain('Shift+Enter');
      expect(result.stdout).not.toContain('PageUp/PageDown');
      expect(result.stdout).not.toContain('\x1b');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  { timeout: CASE_TIMEOUT_MS },
);

test.skipIf(process.platform !== 'darwin')(
  '显式 --ui=tui 在 TERM=dumb 下明确失败且不静默降级',
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'coda-explicit-tui-pty-'));
    const home = path.join(root, '.home');
    const env: Record<string, string> = {
      ...sanitizedTestEnvironment(Bun.env),
      HOME: home,
      USERPROFILE: home,
      TERM: 'dumb',
      NO_COLOR: '1',
    };
    assertSanitizedTestEnvironment(env);

    try {
      const result = await runPty(root, env, ['--ui=tui'], '');
      expect(result.code, JSON.stringify(result)).toBe(2);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('--ui=tui requires TTY stdin/stdout and TERM other than dumb');
      expect(result.stdout).not.toContain('Accessible mode:');
      expect(result.stdout).not.toContain('\x1b');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  { timeout: CASE_TIMEOUT_MS },
);
