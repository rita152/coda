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
import { killProcessTree } from '../src/shared/kill-process-tree.js';
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
    expect(
      match,
      `missing PTY termios ${marker.toLocaleLowerCase('en-US')} marker\n` +
        output.slice(-OUTPUT_PREVIEW_LIMIT),
    ).not.toBeNull();
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

function readPersistedUserTexts(root: string): readonly string[] {
  const texts: string[] = [];
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) collect(item);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    const record = value as Record<string, unknown>;
    if (record.role === 'user' && Array.isArray(record.content)) {
      const text = record.content
        .flatMap((part) => {
          if (typeof part !== 'object' || part === null) return [];
          const content = part as Record<string, unknown>;
          return content.type === 'text' && typeof content.text === 'string' ? [content.text] : [];
        })
        .join('');
      texts.push(text);
    }
    for (const child of Object.values(record)) collect(child);
  };
  const visit = (target: string): void => {
    if (!existsSync(target)) return;
    const stat = statSync(target);
    if (stat.isDirectory()) {
      for (const name of readdirSync(target)) visit(path.join(target, name));
      return;
    }
    if (!stat.isFile()) return;
    for (const line of readFileSync(target, 'utf8').split(/\r?\n/u)) {
      if (line.trim() === '') continue;
      try {
        collect(JSON.parse(line));
      } catch {
        // Presentation and auxiliary files may use pretty-printed JSON. Canonical Runtime
        // journals that own committed user messages are JSONL and are handled above.
      }
    }
  };
  visit(root);
  return texts;
}

function readWheelProbeRows(output: string): readonly (number | undefined)[] {
  const rows: (number | undefined)[] = [];
  const marker = /__CODA_WHEEL_SCREEN_(\d+)__/gu;
  let offset = 0;
  for (const match of output.matchAll(marker)) {
    const matchIndex = match.index;
    if (matchIndex === undefined) continue;
    const frame = output.slice(offset, matchIndex);
    const probeIndex = frame.lastIndexOf('wheelProbeComplete = true;');
    let probeRow: number | undefined;
    if (probeIndex >= 0) {
      const cursor = /\x1b\[(\d+);(\d+)H/gu;
      for (const cursorMatch of frame.slice(0, probeIndex).matchAll(cursor)) {
        const encodedRow = cursorMatch[1];
        if (encodedRow !== undefined) probeRow = Number(encodedRow);
      }
    }
    rows.push(probeRow);
    offset = matchIndex + match[0].length;
  }
  return rows;
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
  watchdogMs = WATCHDOG_MS,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill(9);
      reject(
        new Error(
          `watchdog: PTY did not exit within ${watchdogMs}ms\n` +
            output().slice(-OUTPUT_PREVIEW_LIMIT),
        ),
      );
    }, watchdogMs);
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
    readonly wheelProbe?: {
      readonly x: number;
      readonly y: number;
      readonly directions: readonly ('up' | 'down')[];
      readonly frameDelayMs?: number;
    };
    readonly afterWheelInput?: string;
    readonly exitMarker?: string;
    readonly exitJournalRoot?: string;
    readonly exitInput?: string;
    readonly exitDelayMs?: number;
    readonly watchdogMs?: number;
  } = {},
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const driverPath = path.join(root, `expect-${crypto.randomUUID()}.tcl`);
  const spawnedPidPath = path.join(root, `expect-child-${crypto.randomUUID()}.pid`);
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
    'set wheel_directions [lindex $argv 9]',
    'set mouse_x [lindex $argv 10]',
    'set mouse_y [lindex $argv 11]',
    'set wheel_frame_delay [lindex $argv 12]',
    'set after_wheel_payload [lindex $argv 13]',
    'set exit_ready [lindex $argv 14]',
    'set exit_journal_root [lindex $argv 15]',
    'set exit_payload [lindex $argv 16]',
    'set exit_delay [lindex $argv 17]',
    'set child_pid_file [lindex $argv 18]',
    'set command [lrange $argv 19 end]',
    'proc drain_pending_output {} {',
    '  set previous_timeout $::timeout',
    '  set ::timeout 0',
    '  expect {',
    '    -re {.+} { exp_continue }',
    '    timeout {}',
    '    eof {}',
    '  }',
    '  set ::timeout $previous_timeout',
    '}',
    'proc wait_for_render_frame {frame_delay} {',
    '  set previous_timeout $::timeout',
    '  set ::timeout 2',
    '  expect {',
    '    -exact "\\x1b\\[?2026l" {}',
    '    timeout { exit 126 }',
    '    eof { exit 125 }',
    '  }',
    '  set ::timeout $previous_timeout',
    '  after $frame_delay',
    '}',
    'proc mark_wheel_snapshot {index} {',
    '  puts -nonewline "__CODA_WHEEL_SCREEN_${index}__"',
    '  flush stdout',
    '}',
    'proc file_contains_ordered {target before after} {',
    '  if {[file isdirectory $target]} {',
    '    foreach child [glob -nocomplain -directory $target * .*] {',
    '      set name [file tail $child]',
    '      if {$name eq "." || $name eq ".."} { continue }',
    '      if {[file_contains_ordered $child $before $after]} { return 1 }',
    '    }',
    '    return 0',
    '  }',
    '  if {![file isfile $target]} { return 0 }',
    '  if {[catch {set handle [open $target r]}]} { return 0 }',
    '  fconfigure $handle -encoding utf-8 -translation binary',
    '  set data [read $handle]',
    '  close $handle',
    '  set before_index [string first $before $data]',
    '  if {$before_index < 0} { return 0 }',
    '  set after_index [string first $after $data [expr {$before_index + [string length $before]}]]',
    '  return [expr {$after_index >= 0}]',
    '}',
    'proc wait_for_journal_completion {root marker} {',
    '  set waited 0',
    '  while {![file_contains_ordered $root $marker {"type":"op_completed"}] && $waited < 15000} {',
    '    after 25',
    '    incr waited 25',
    '  }',
    '  if {![file_contains_ordered $root $marker {"type":"op_completed"}]} { exit 124 }',
    '}',
    'spawn -noecho /bin/sh -c {read _coda_start; "$@"; _coda_status=$?; printf "\\n__CODA_CHILD_EXITED__\\n"; read _coda_finish; exit $_coda_status} sh {*}$command',
    'set child_pid_handle [open $child_pid_file w]',
    'puts -nonewline $child_pid_handle [exp_pid]',
    'close $child_pid_handle',
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
    'if {$wheel_directions ne ""} {',
    '  wait_for_render_frame $wheel_frame_delay',
    '  drain_pending_output',
    '  set wheel_index 0',
    '  mark_wheel_snapshot $wheel_index',
    '  foreach direction [split $wheel_directions ""] {',
    '    if {$direction eq "u"} {',
    '      set button 64',
    '    } else {',
    '      set button 65',
    '    }',
    '    drain_pending_output',
    '    send -- "\\x1b\\[<${button};${mouse_x};${mouse_y}M"',
    '    wait_for_render_frame $wheel_frame_delay',
    '    drain_pending_output',
    '    incr wheel_index',
    '    mark_wheel_snapshot $wheel_index',
    '  }',
    '}',
    'if {$after_wheel_payload ne ""} {',
    '  send -- $after_wheel_payload',
    '  after $wheel_frame_delay',
    '  drain_pending_output',
    '}',
    'if {$final_payload ne ""} {',
    '  after $final_delay',
    '  send -- $final_payload',
    '}',
    'if {$exit_ready ne ""} {',
    '  expect {',
    '    -exact $exit_ready {',
    '      if {$exit_journal_root ne ""} { wait_for_journal_completion $exit_journal_root $exit_ready }',
    '      after $exit_delay',
    '      send -- $exit_payload',
    '    }',
    '    timeout { exit 124 }',
    '    eof {}',
    '  }',
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
      options.wheelProbe?.directions.map((direction) => direction[0]).join('') ?? '',
      options.wheelProbe === undefined ? '' : String(options.wheelProbe.x),
      options.wheelProbe === undefined ? '' : String(options.wheelProbe.y),
      String(options.wheelProbe?.frameDelayMs ?? 50),
      options.afterWheelInput ?? '',
      options.exitMarker ?? '',
      options.exitJournalRoot ?? '',
      options.exitInput ?? '',
      String(options.exitDelayMs ?? 0),
      spawnedPidPath,
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
  let terminalRestored = false;
  try {
    const code = await waitForPtyExit(
      completion,
      child,
      () => `stdout=${JSON.stringify(stdout)}\nstderr=${JSON.stringify(stderr)}`,
      options.watchdogMs,
    );
    expectPtyTermiosRestored(stdout);
    terminalRestored = true;
    return { code, stdout, stderr };
  } finally {
    if (!terminalRestored && existsSync(spawnedPidPath)) {
      const spawnedPid = Number.parseInt(readFileSync(spawnedPidPath, 'utf8'), 10);
      if (Number.isSafeInteger(spawnedPid) && spawnedPid > 0) {
        await killProcessTree(spawnedPid, { graceMs: 250 });
        try {
          process.kill(spawnedPid, 'SIGKILL');
        } catch {
          // The direct child normally exits with the process group; ESRCH is the expected case.
        }
      }
    }
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
      expect(readPersistedText(home)).toContain(
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
  '真实 PTY 逐帧处理鼠标滚轮 SGR，且不把转义序列写入 composer 或 transcript',
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'coda-tui-wheel-'));
    const home = path.join(root, '.home');
    const longAnswer = [
      '# Wheel probe',
      ...Array.from(
        { length: 50 },
        (_, index) => `wheel-line-${String(index).padStart(3, '0')} · const value = ${index};`,
      ),
      '',
      '```ts',
      'const wheelProbeComplete = true;',
      '```',
    ].join('\n');
    const scriptPath = writeFauxScript(root, {
      turns: [
        { events: [{ kind: 'text', text: longAnswer }] },
        { events: [{ kind: 'text', text: 'WHEEL_PROBE_SECOND_TURN_COMPLETE' }] },
      ],
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
      const draft = 'wheel-draft-safe';
      const result = await runPty(
        root,
        env,
        tuiArgs(root, scriptPath),
        'render a long wheel transcript\r',
        {
          readyMarker: 'Tips for getting started',
          nextMarker: '∙ done',
          nextInput: draft,
          wheelProbe: {
            // SGR coordinates are 1-based and stay inside the 80x24 transcript viewport.
            x: 10,
            y: 10,
            directions: ['up', 'up', 'up', 'down', 'down', 'down'],
            // Production is capped at 30 FPS. Expect waits for the synchronized-render frame
            // terminator, then this gap keeps the next wheel event in a separate frame.
            frameDelayMs: 50,
          },
          afterWheelInput: '\x1b[4~',
          finalInput: '\r',
          exitMarker: 'WHEEL_PROBE_SECOND_TURN_COMPLETE',
          exitJournalRoot: path.join(home, '.coda', 'runtime-v2'),
          exitInput: '/quit\r',
          watchdogMs: 30_000,
        },
      );
      expect(result.code, JSON.stringify(result).slice(-OUTPUT_PREVIEW_LIMIT)).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('WHEEL_PROBE_SECOND_TURN_COMPLETE');
      expect(result.stdout).not.toMatch(/(?:\x1b\[|\[)?<?6[45];\d+;\d+[Mm]/u);

      const probeRows = readWheelProbeRows(result.stdout);
      expect(probeRows).toHaveLength(7);
      expect(
        probeRows.every((row): row is number => row !== undefined),
        JSON.stringify({ probeRows }),
      ).toBe(true);
      const [
        atBottom,
        afterFirstUp,
        afterSecondUp,
        afterThirdUp,
        afterFirstDown,
        afterSecondDown,
        afterThirdDown,
      ] = probeRows as [
        number,
        number,
        number,
        number,
        number,
        number,
        number,
      ];
      // Scrolling the viewport upward moves a stable content row downward on screen. Every event
      // must advance it; a native-sticky bounce would repeat or reverse one of these inequalities.
      expect(afterFirstUp).toBeGreaterThan(atBottom);
      expect(afterSecondUp).toBeGreaterThan(afterFirstUp);
      expect(afterThirdUp).toBeGreaterThan(afterSecondUp);
      expect(afterFirstDown).toBeLessThan(afterThirdUp);
      expect(afterSecondDown).toBeLessThan(afterFirstDown);
      expect(afterThirdDown).toBeLessThan(afterSecondDown);
      expect(afterThirdDown).toBe(atBottom);

      const persistedRoot = home;
      const persisted = readPersistedText(persistedRoot);
      const persistedUserTexts = readPersistedUserTexts(persistedRoot);
      const submittedDrafts = persistedUserTexts.filter((text) => text.includes(draft));
      expect(submittedDrafts.length).toBeGreaterThan(0);
      expect(submittedDrafts.every((text) => text === draft)).toBe(true);
      expect(persistedUserTexts).not.toContainEqual(expect.stringMatching(/[\u0000-\u001f\u007f-\u009f]/u));
      expect(persisted).not.toMatch(/(?:\\u001b|\x1b)?(?:\\?\[)?<?6[45];\d+;\d+[Mm]/u);
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
          finalInput: '\x03\x03',
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
          nextMarker: 'Would you like to run the following command?',
          nextInput: '\x1b',
          finalInput: '/quit\r',
          finalDelayMs: 350,
        },
      );
      expect(result.code, JSON.stringify(result).slice(-OUTPUT_PREVIEW_LIMIT)).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('Would you like to run the following command?');
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
        ],
        'wait on the provider\r',
        {
          readyMarker: 'Tips for getting started',
          waitFile: requestMarker,
          nextInput: '\x1b',
          finalInput: '\x03\x03',
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
  'OpenTUI 初始化失败明确退出且不泄漏终端模式',
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'coda-tui-init-failure-'));
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
        '',
      );
      expect(result.code, JSON.stringify(result).slice(-OUTPUT_PREVIEW_LIMIT)).toBe(1);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('full-screen TUI unavailable');
      expectTerminalRestored(result.stdout, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  { timeout: CASE_TIMEOUT_MS },
);

test.skipIf(process.platform !== 'darwin')(
  'TUI-only 路由在 TERM=dumb 下明确失败',
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
      expect(result.stdout).toContain('requires TTY stdin/stdout and TERM other than dumb');
      expect(result.stdout).toContain('use a prompt, pipe stdin, or --json');
      expect(result.stdout).not.toContain('\x1b');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  { timeout: CASE_TIMEOUT_MS },
);
