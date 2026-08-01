// L5 e2e:在真实伪终端中启动构建产物，覆盖 createCliRenderer/native framebuffer
// 的 ANSI 输出路径。macOS `script` 提供双 TTY；显式移除 COLORTERM，验证透明
// framebuffer 使用终端默认背景，而不是量化出任意 indexed/truecolor 实色背景。

import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
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

const TERMINAL_MODES = [
  ['alternate screen', '\x1b[?1049h', '\x1b[?1049l'],
  ['bracketed paste', '\x1b[?2004h', '\x1b[?2004l'],
  ['mouse click', '\x1b[?1000h', '\x1b[?1000l'],
  ['mouse drag', '\x1b[?1002h', '\x1b[?1002l'],
  ['mouse motion', '\x1b[?1003h', '\x1b[?1003l'],
  ['mouse SGR', '\x1b[?1006h', '\x1b[?1006l'],
] as const;

function expectTerminalRestored(output: string, requireEntered = true): void {
  for (const [label, enter, leave] of TERMINAL_MODES) {
    const enterIndex = output.indexOf(enter);
    if (requireEntered) expect(enterIndex, `${label} was never enabled`).toBeGreaterThanOrEqual(0);
    if (enterIndex < 0) continue;
    expect(output.indexOf(leave, enterIndex + enter.length), `${label} leaked`).toBeGreaterThan(
      enterIndex,
    );
  }
  const titleIndex = output.indexOf('\x1b]0;coda · ');
  if (requireEntered) expect(titleIndex, 'terminal title was never set').toBeGreaterThanOrEqual(0);
  if (titleIndex >= 0) {
    expect(output.indexOf('\x1b]0;\x07', titleIndex + 1), 'terminal title leaked').toBeGreaterThan(
      titleIndex,
    );
  }
  if (requireEntered) expect(output).toContain('\x1b[0 q');
}

function expectPtyTermiosRestored(output: string): void {
  const readMode = (marker: string): string => {
    const match = new RegExp(`__CODA_TERMIOS_${marker}__([^\\r\\n]+)`, 'u').exec(output);
    expect(match, `missing PTY termios ${marker.toLocaleLowerCase('en-US')} marker`).not.toBeNull();
    return match?.[1]?.trim() ?? '';
  };
  const before = readMode('BEFORE');
  const after = readMode('AFTER');
  expect(after, 'PTY termios/raw mode leaked across process exit').toBe(before);
}

function writeFauxScript(root: string, script: unknown): string {
  const scriptPath = path.join(root, `faux-${crypto.randomUUID()}.json`);
  writeFileSync(scriptPath, JSON.stringify(script), 'utf8');
  return scriptPath;
}

function tuiArgs(
  root: string,
  scriptPath: string,
  approvalMode: 'allow' | 'interactive' = 'allow',
): string[] {
  return [
    '--provider', 'faux',
    '--faux-script', scriptPath,
    '--approval-mode', approvalMode,
    '--cwd', root,
    '--session-dir', path.join(root, 'sessions'),
  ];
}

function readPersistedText(root: string): string {
  const chunks: string[] = [];
  const visit = (target: string): void => {
    if (!existsSync(target)) return;
    const stat = statSync(target);
    if (stat.isDirectory()) {
      for (const name of readdirSync(target)) visit(path.join(target, name));
      return;
    }
    if (stat.isFile()) chunks.push(readFileSync(target, 'utf8'));
  };
  visit(root);
  return chunks.join('\n');
}

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
  options: {
    readonly readyMarker?: string;
    readonly nextMarker?: string;
    readonly nextInput?: string;
    readonly finalInput?: string;
    readonly finalDelayMs?: number;
    readonly resize?: { readonly columns: number; readonly rows: number };
    readonly waitFile?: string;
  } = {},
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const driverPath = path.join(root, `expect-${crypto.randomUUID()}.tcl`);
  writeFileSync(driverPath, [
    'set timeout 15',
    'set ready [lindex $argv 0]',
    'set payload [lindex $argv 1]',
    'set next_ready [lindex $argv 2]',
    'set next_payload [lindex $argv 3]',
    'set final_payload [lindex $argv 4]',
    'set final_delay [lindex $argv 5]',
    'set columns [lindex $argv 6]',
    'set rows [lindex $argv 7]',
    'set wait_file [lindex $argv 8]',
    'set command [lrange $argv 9 end]',
    'spawn -noecho /bin/sh -c {read _coda_start; "$@"; _coda_status=$?; printf "\\n__CODA_CHILD_EXITED__\\n"; read _coda_finish; exit $_coda_status} sh {*}$command',
    'set pty_name $spawn_out(slave,name)',
    'exec /bin/sh -c "stty sane < $pty_name"',
    'set termios_before [exec /bin/sh -c "stty -g < $pty_name"]',
    'send -- "\\n"',
    'if {$ready ne ""} {',
    '  expect {',
    '    -exact $ready {',
    '      if {$columns ne ""} {',
    '        stty rows $rows columns $columns < $pty_name',
    '        puts "__CODA_RESIZED_${columns}x${rows}__"',
    '      }',
    '      send -- $payload',
    '    }',
    '    timeout { exit 124 }',
    '    eof {}',
    '  }',
    '} elseif {$payload ne ""} {',
    '  send -- $payload',
    '}',
    'if {$wait_file ne ""} {',
    '  set waited 0',
    '  while {![file exists $wait_file] && $waited < 15000} {',
    '    after 25',
    '    incr waited 25',
    '  }',
    '  if {![file exists $wait_file]} { exit 124 }',
    '  send -- $next_payload',
    '} elseif {$next_ready ne ""} {',
    '  expect {',
    '    -exact $next_ready { send -- $next_payload }',
    '    timeout { exit 124 }',
    '    eof {}',
    '  }',
    '}',
    'if {$final_payload ne ""} {',
    '  after $final_delay',
    '  send -- $final_payload',
    '}',
    'expect {',
    '  -exact "__CODA_CHILD_EXITED__" {}',
    '  timeout { exit 124 }',
    '  eof { exit 125 }',
    '}',
    'set termios_after [exec /bin/sh -c "stty -g < $pty_name"]',
    'puts "__CODA_TERMIOS_BEFORE__$termios_before"',
    'puts "__CODA_TERMIOS_AFTER__$termios_after"',
    'send -- "\\n"',
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
      options.readyMarker ?? '',
      input,
      options.nextMarker ?? '',
      options.nextInput ?? '',
      options.finalInput ?? '',
      String(options.finalDelayMs ?? 0),
      options.resize === undefined ? '' : String(options.resize.columns),
      options.resize === undefined ? '' : String(options.resize.rows),
      options.waitFile ?? '',
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
    expectPtyTermiosRestored(stdout);
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
        const result = await runPty(root, env, item.args, '\x04', {
          readyMarker: item.marker,
        });
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
      expectTerminalRestored(stdout);

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
  '真实 PTY resize 后 bracketed paste 作为一个多行 prompt 持久化且正常退出',
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'coda-tui-paste-'));
    const home = path.join(root, '.home');
    const scriptPath = writeFauxScript(root, {
      turns: [{ events: [{ kind: 'text', text: 'pasted answer' }] }],
      onExhausted: 'emptyStop',
    });
    const env: Record<string, string> = {
      ...sanitizedTestEnvironment(Bun.env),
      HOME: home,
      USERPROFILE: home,
      TERM: 'xterm-256color',
      NO_COLOR: '1',
      COLUMNS: '80',
      LINES: '24',
    };
    assertSanitizedTestEnvironment(env);

    try {
      const result = await runPty(
        root,
        env,
        tuiArgs(root, scriptPath),
        '\x1b[200~first line\nsecond line\x1b[201~\r',
        {
          readyMarker: 'Tips for getting started',
          nextMarker: '∙ done',
          nextInput: '/quit\r',
          resize: { columns: 40, rows: 10 },
        },
      );
      expect(result.code, JSON.stringify(result).slice(-OUTPUT_PREVIEW_LIMIT)).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('__CODA_RESIZED_40x10__');
      expect(readPersistedText(path.join(root, 'sessions'))).toContain(
        '"text":"first line\\nsecond line"',
      );
      expectTerminalRestored(result.stdout);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  { timeout: CASE_TIMEOUT_MS },
);

test.skipIf(process.platform !== 'darwin')(
  '真实 PTY 在运行中 Esc abort 后恢复终端模式',
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'coda-tui-run-abort-'));
    const home = path.join(root, '.home');
    const scriptPath = writeFauxScript(root, {
      turns: [{ events: [{ kind: 'tool_call', name: 'bash', args: { command: 'sleep 5' } }] }],
      onExhausted: 'emptyStop',
    });
    const env: Record<string, string> = {
      ...sanitizedTestEnvironment(Bun.env),
      HOME: home,
      USERPROFILE: home,
      TERM: 'xterm-256color',
      NO_COLOR: '1',
    };
    assertSanitizedTestEnvironment(env);

    try {
      const result = await runPty(
        root,
        env,
        tuiArgs(root, scriptPath),
        'run the slow tool\r',
        {
          readyMarker: 'Tips for getting started',
          nextMarker: 'bash running',
          nextInput: '\x1b',
          finalInput: '\x1b',
          finalDelayMs: 350,
        },
      );
      expect(result.code, JSON.stringify(result).slice(-OUTPUT_PREVIEW_LIMIT)).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('bash running');
      expect(result.stdout).toMatch(/abort(?:ing|ed)/u);
      expectTerminalRestored(result.stdout);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  { timeout: CASE_TIMEOUT_MS },
);

test.skipIf(process.platform !== 'darwin')(
  '真实 PTY 在审批中 Esc abort 后恢复终端模式',
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'coda-tui-approval-abort-'));
    const home = path.join(root, '.home');
    const scriptPath = writeFauxScript(root, {
      turns: [{ events: [{ kind: 'tool_call', name: 'bash', args: { command: 'touch denied.txt' } }] }],
      onExhausted: 'emptyStop',
    });
    const env: Record<string, string> = {
      ...sanitizedTestEnvironment(Bun.env),
      HOME: home,
      USERPROFILE: home,
      TERM: 'xterm-256color',
      NO_COLOR: '1',
    };
    assertSanitizedTestEnvironment(env);

    try {
      const result = await runPty(
        root,
        env,
        tuiArgs(root, scriptPath, 'interactive'),
        'request approval\r',
        {
          readyMarker: 'Tips for getting started',
          nextMarker: 'approval required',
          nextInput: '\x1b',
          finalInput: '/quit\r',
          finalDelayMs: 350,
        },
      );
      expect(result.code, JSON.stringify(result).slice(-OUTPUT_PREVIEW_LIMIT)).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('approval required');
      expect(existsSync(path.join(root, 'denied.txt'))).toBe(false);
      expectTerminalRestored(result.stdout);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  { timeout: CASE_TIMEOUT_MS },
);

test.skipIf(process.platform !== 'darwin')(
  '真实 PTY fatal 事件自动退出 1 并恢复终端模式',
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'coda-tui-fatal-'));
    const home = path.join(root, '.home');
    // `turns:null` makes the formal faux adapter throw synchronously at its protocol boundary,
    // exercising Agent's genuine fatal envelope instead of a UI-only injected error.
    const scriptPath = writeFauxScript(root, { turns: null });
    const env: Record<string, string> = {
      ...sanitizedTestEnvironment(Bun.env),
      HOME: home,
      USERPROFILE: home,
      TERM: 'xterm-256color',
      NO_COLOR: '1',
    };
    assertSanitizedTestEnvironment(env);

    try {
      const result = await runPty(
        root,
        env,
        tuiArgs(root, scriptPath),
        'trigger fatal\r',
        { readyMarker: 'Tips for getting started' },
      );
      expect(result.code, JSON.stringify(result).slice(-OUTPUT_PREVIEW_LIMIT)).toBe(1);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('fatal');
      expect(result.stdout).toContain('[protocol bug]');
      expectTerminalRestored(result.stdout);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  { timeout: CASE_TIMEOUT_MS },
);

test.skipIf(process.platform !== 'darwin')(
  '真实 PTY 在 provider HTTP 请求悬挂时退出并恢复终端模式',
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'coda-tui-provider-exit-'));
    const home = path.join(root, '.home');
    const requestMarker = path.join(root, 'provider-request-started');
    let releaseRequest: (() => void) | undefined;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        writeFileSync(requestMarker, request.url, 'utf8');
        return new Promise<Response>((resolve) => {
          let settled = false;
          const finish = (): void => {
            if (settled) return;
            settled = true;
            resolve(Response.json({ error: { message: 'request released' } }, { status: 503 }));
          };
          releaseRequest = finish;
          request.signal.addEventListener('abort', finish, { once: true });
        });
      },
    });
    const env: Record<string, string> = {
      ...sanitizedTestEnvironment(Bun.env),
      HOME: home,
      USERPROFILE: home,
      TERM: 'xterm-256color',
      NO_COLOR: '1',
    };
    assertSanitizedTestEnvironment(env);

    try {
      const result = await runPty(
        root,
        env,
        [
          '--provider', 'openai-chat',
          '--api-key', 'pty-test-key',
          '--base-url', `http://127.0.0.1:${server.port}/v1`,
          '--model', 'pty-hanging-provider',
          '--approval-mode', 'allow',
          '--cwd', root,
          '--session-dir', path.join(root, 'sessions'),
        ],
        'wait on the provider\r',
        {
          readyMarker: 'Tips for getting started',
          waitFile: requestMarker,
          nextInput: '\x1b',
          finalInput: '\x1b',
          finalDelayMs: 350,
        },
      );
      expect(result.code, JSON.stringify(result).slice(-OUTPUT_PREVIEW_LIMIT)).toBe(0);
      expect(result.stderr).toBe('');
      expect(readFileSync(requestMarker, 'utf8')).toContain('/v1/chat/completions');
      expectTerminalRestored(result.stdout);
    } finally {
      releaseRequest?.();
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  },
  { timeout: CASE_TIMEOUT_MS },
);

test.skipIf(process.platform !== 'darwin')(
  'OpenTUI 初始化失败在 auto 模式降级 classic 且不泄漏终端模式',
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'coda-tui-init-fallback-'));
    const home = path.join(root, '.home');
    const scriptPath = writeFauxScript(root, { turns: [], onExhausted: 'emptyStop' });
    const env: Record<string, string> = {
      ...sanitizedTestEnvironment(Bun.env),
      HOME: home,
      USERPROFILE: home,
      TERM: 'xterm-256color',
      NO_COLOR: '1',
      // OpenTUI validates this during lazy initialization. A relative path is deliberately invalid.
      OTUI_ASSET_ROOT: 'relative-path-is-invalid',
    };
    assertSanitizedTestEnvironment(env);

    try {
      const result = await runPty(
        root,
        env,
        tuiArgs(root, scriptPath),
        '/quit\r',
        { readyMarker: 'using classic mode' },
      );
      expect(result.code, JSON.stringify(result).slice(-OUTPUT_PREVIEW_LIMIT)).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('full-screen TUI unavailable, using classic mode');
      expectTerminalRestored(result.stdout, false);
    } finally {
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
        { readyMarker: 'Accessible mode:' },
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
