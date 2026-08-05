import { describe, expect, it } from 'bun:test';
import {
  CliUsageError,
  COMMAND_SPECS,
  commandPaletteEntries,
  findSlashCommand,
  OPTION_SPECS,
  parseCliInvocation,
  renderCliHelp,
  renderCliUsageError,
  renderCompletion,
  renderInteractiveHelp,
  SLASH_COMMAND_SPECS,
} from './command-catalog.js';
import { parseSlashCommand } from './tui-controls.js';

describe('canonical command catalog', () => {
  it('supports positional prompt, -p append, canonical resume, and headless flags', () => {
    const naked = parseCliInvocation(['fix', 'the', 'bug']);
    expect(naked.command).toEqual({ kind: 'run', explicitExec: false });
    expect(naked.flags.prompt).toBe('fix the bug');

    const explicit = parseCliInvocation([
      'exec',
      '-p',
      'first',
      'second',
      '--resume=opaque-thread',
      '--workspace=workspace-a',
      '--json',
    ]);
    expect(explicit.command).toEqual({ kind: 'run', explicitExec: true });
    expect(explicit.flags).toMatchObject({
      prompt: 'first second',
      resume: 'opaque-thread',
      workspace: 'workspace-a',
      json: true,
    });
  });

  it('recognizes product commands and command-specific values', () => {
    expect(parseCliInvocation(['doctor', '--json']).command).toEqual({ kind: 'doctor' });
    expect(parseCliInvocation(['completion', 'fish']).command).toEqual({ kind: 'completion', shell: 'fish' });
    expect(parseCliInvocation(['auth', 'login', '--preset', 'openai']).command).toEqual({
      kind: 'auth',
      operation: 'login',
      preset: 'openai',
    });
    expect(parseCliInvocation(['auth', 'logout', 'provider-a']).command).toEqual({
      kind: 'auth',
      operation: 'logout',
      providerId: 'provider-a',
    });
    expect(parseCliInvocation(['models', '--select', 'openai/gpt-5']).command).toEqual({
      kind: 'models',
      select: 'openai/gpt-5',
    });
    expect(parseCliInvocation(['sessions']).command).toEqual({ kind: 'sessions' });
  });

  it('handles help/version before any heavy CLI work and resolves help targets', () => {
    expect(parseCliInvocation(['--help', '--api-key', 'secret']).command).toEqual({ kind: 'help', commandPath: undefined });
    expect(parseCliInvocation(['auth', 'login', '--help']).command).toEqual({
      kind: 'help',
      commandPath: ['auth', 'login'],
    });
    expect(parseCliInvocation(['help', 'doctor']).command).toEqual({ kind: 'help', commandPath: ['doctor'] });
    expect(parseCliInvocation(['--version', '--not-a-real-flag']).command).toEqual({ kind: 'version' });
    expect(parseCliInvocation(['version']).command).toEqual({ kind: 'version' });
  });

  it('suggests misspelled flags and auth commands with executable fixes', () => {
    expectUsageError(['--contine'], 'unknown_flag', '--continue');
    expectUsageError(['auth', 'statsu'], 'unknown_subcommand', 'auth status');
  });

  it('rejects ambiguous combinations and options that a command cannot consume', () => {
    expectUsageError(['--continue', '--resume'], 'mutually_exclusive', 'or: coda --resume');
    expectUsageError(['--json', '--ui=tui'], 'mutually_exclusive', 'remove --ui');
    expectUsageError(['--ui=tui', 'run now'], 'mutually_exclusive', 'then enter the task');
    expectUsageError(['doctor', '--select', 'x/y'], 'unexpected_argument', 'doctor --help');
    expectUsageError(['doctor', '--cwd', '/tmp'], 'unexpected_argument', 'doctor --help');
    expectUsageError(['completion'], 'missing_value', 'completion bash');
    expectUsageError(
      ['auth', 'login', '--preset', 'openai', '--base-url', 'https://proxy.test'],
      'mutually_exclusive',
      '--preset custom',
    );
  });

  it('只接受 TUI-only 模式并保持 auto 默认值', () => {
    expect(parseCliInvocation([]).flags.ui).toBe('auto');
    expect(parseCliInvocation(['--ui=tui']).flags.ui).toBe('tui');
    expectUsageError(['--ui=graphical'], 'invalid_value', 'auto|tui');
  });

  it('parses opt-in output, theme, ASCII, ephemeral, and timeout flags', () => {
    expect(parseCliInvocation([
      'exec',
      '--output=stream-json',
      '--final-only',
      '--ephemeral',
      '--timeout=1.5s',
      '--theme=high-contrast',
      '--ascii',
      'run',
    ]).flags).toMatchObject({
      output: 'stream-json',
      finalOnly: true,
      ephemeral: true,
      timeoutMs: 1_500,
      theme: 'high-contrast',
      ascii: true,
      prompt: 'run',
    });
    expect(parseCliInvocation([]).flags).toMatchObject({
      theme: 'auto',
      ascii: false,
      finalOnly: false,
      ephemeral: false,
    });
    expectUsageError(['--timeout=0s'], 'invalid_value', 'greater than zero');
    expectUsageError(['--timeout=30'], 'invalid_value', '30s');
    expectUsageError(['--theme=sepia'], 'invalid_value', 'high-contrast');
    expectUsageError(['--json', '--output=json'], 'mutually_exclusive', 'canonical command stream');
    expectUsageError(['--json', '--timeout=1s'], 'mutually_exclusive', 'opt-in one-shot');
    expectUsageError(['--ephemeral', '--resume'], 'mutually_exclusive', 'cannot continue or resume');
  });

  it('generates help, completion, and slash help from the same catalog', () => {
    const help = renderCliHelp('1.2.3');
    const loginHelp = renderCliHelp('1.2.3', ['auth', 'login']);
    const doctorHelp = renderCliHelp('1.2.3', ['doctor']);
    const interactiveHelp = renderInteractiveHelp().join('\n');
    for (const command of COMMAND_SPECS) {
      if (command.cli !== undefined && command.cli.path[0] !== 'help' && command.cli.path[0] !== 'version') {
        expect(help).toContain(`coda ${command.cli.path.join(' ')}`);
      }
      if (command.slash !== undefined) {
        expect(interactiveHelp).toContain(`/${command.slash.name}`);
      }
    }
    for (const shell of ['bash', 'zsh', 'fish', 'powershell'] as const) {
      const completion = renderCompletion(shell);
      for (const option of OPTION_SPECS) {
        const long = option.flags.at(-1) as string;
        expect(completion).toContain(shell === 'fish' ? `-l ${long.slice(2)}` : long);
      }
      expect(completion).toContain('auth');
      expect(completion).toContain('login');
    }
    expect(SLASH_COMMAND_SPECS.map((command) => command.name)).toEqual([
      'help', 'insert-mode', 'status', 'login', 'model', 'logout', 'auth',
      'search', 'next', 'previous', 'latest', 'copy', 'export', 'vim', 'quit', 'doctor',
      'diff', 'review', 'permissions', 'compact', 'fork', 'new', 'sessions',
      'resume', 'switch', 'rename', 'archive',
    ]);
    expect(interactiveHelp).toContain('PageUp/PageDown: scroll output');
    expect(interactiveHelp).toContain('Up/Down: browse prompt history');
    expect(interactiveHelp).toContain('Ctrl+K: open command palette');
    expect(interactiveHelp).toContain('Ctrl+R: search prompt history');
    expect(interactiveHelp).toContain('Esc: abort the current run');
    expect(interactiveHelp).not.toContain('Ctrl+O');
    expect(interactiveHelp).not.toContain('Meta+S');
    expect(interactiveHelp).not.toContain('/abort');
    expect(interactiveHelp).not.toContain('/history');
    expect(interactiveHelp).not.toContain('/auth-status');
    expect(interactiveHelp).not.toMatch(/\/prev(?![a-z])/u);
    expect(interactiveHelp).not.toMatch(/\/q(?![a-z])/u);
    expect(loginHelp).toContain('--preset <name>');
    expect(loginHelp).toContain('--api-key <key>');
    expect(loginHelp).not.toContain('--select');
    expect(doctorHelp).toContain('--json');
    expect(doctorHelp).not.toContain('--cwd');
  });

  it('builds categorized fuzzy palette entries with state-derived availability', () => {
    const base = {
      phase: 'idle' as const,
      approvalPending: false,
      providerPromptActive: false,
      providerCommandsAvailable: true,
      hasModel: true,
      hasTranscript: true,
    };
    expect(commandPaletteEntries('srch', base)[0]?.command.name).toBe('search');
    expect(commandPaletteEntries('doctor', base)[0]?.command.actionId).toBe('doctor.run');
    expect(commandPaletteEntries('auth', base)[0]?.command.actionId).toBe('auth.status');
    expect(commandPaletteEntries('review', base).some(
      (entry) => entry.command.category === 'review',
    )).toBe(true);
    expect(commandPaletteEntries('quit', { ...base, phase: 'running' })[0]?.availability)
      .toEqual({
        kind: 'disabled',
        reason: 'finish or abort the current run first',
      });
    expect(commandPaletteEntries('model', { ...base, phase: 'compacting' })[0]?.availability)
      .toEqual({
        kind: 'disabled',
        reason: 'finish or abort the current run first',
      });
    expect(commandPaletteEntries('fork', { ...base, phase: 'running' })[0]?.availability)
      .toEqual({
        kind: 'disabled',
        reason: 'finish or abort the current run first',
      });
    expect(commandPaletteEntries('auth', { ...base, providerCommandsAvailable: false })[0]?.availability)
      .toEqual({
        kind: 'disabled',
        reason: 'provider management is unavailable on this surface',
      });
    expect(commandPaletteEntries('', { ...base, providerPromptActive: true })).toEqual([]);
  });

  it('abort/history/别名已从目录、帮助与补全中移除', () => {
    expect(findSlashCommand('abort')).toBeUndefined();
    expect(findSlashCommand('history')).toBeUndefined();
    expect(findSlashCommand('auth-status')).toBeUndefined();
    expect(findSlashCommand('prev')).toBeUndefined();
    expect(findSlashCommand('q')).toBeUndefined();
    expect(findSlashCommand('f')).toBeUndefined();
    expect(SLASH_COMMAND_SPECS.some((command) => command.actionId === 'task.abort')).toBe(false);
    expect(SLASH_COMMAND_SPECS.some((command) => command.actionId === 'history.search')).toBe(false);
    const help = renderInteractiveHelp().join('\n');
    expect(help).not.toContain('/abort');
    expect(help).not.toContain('/history');
    expect(help).not.toContain('/auth-status');
    expect(help).not.toMatch(/\/prev(?![a-z])/u);
    expect(help).not.toMatch(/\/q(?![a-z])/u);
    for (const shell of ['bash', 'zsh', 'fish', 'powershell'] as const) {
      expect(renderCompletion(shell)).not.toContain('/abort');
      expect(renderCompletion(shell)).not.toContain('/history');
    }
    for (const name of ['abort', 'history', 'auth-status', 'prev', 'q', 'f']) {
      expect(commandPaletteEntries(name, {
        phase: 'running',
        approvalPending: false,
        providerPromptActive: false,
        providerCommandsAvailable: true,
        hasModel: true,
        hasTranscript: true,
      }).some((entry) => entry.command.name === name)).toBe(false);
    }
    expect(findSlashCommand('auth')?.actionId).toBe('auth.status');
    expect(findSlashCommand('previous')?.actionId).toBe('transcript.previous');
    expect(findSlashCommand('quit')?.actionId).toBe('app.quit');
  });

  it('edit/files/stash/restore/draft/retry 已从目录、帮助、palette 与快捷键移除', () => {
    for (const name of ['edit', 'files', 'stash', 'restore', 'draft', 'retry']) {
      expect(findSlashCommand(name)).toBeUndefined();
      expect(SLASH_COMMAND_SPECS.some((command) => command.name === name)).toBe(false);
      expect(parseSlashCommand(`/${name}`)).toEqual({ cmd: 'unknown', input: `/${name}` });
      expect(commandPaletteEntries(name, {
        phase: 'running',
        approvalPending: false,
        providerPromptActive: false,
        providerCommandsAvailable: true,
        hasModel: true,
        hasTranscript: true,
      }).some((entry) => entry.command.name === name)).toBe(false);
    }
    expect(SLASH_COMMAND_SPECS.flatMap((command) => command.shortcuts))
      .not.toContain('Ctrl+O');
    expect(SLASH_COMMAND_SPECS.flatMap((command) => command.shortcuts))
      .not.toContain('Meta+S');
    expect(SLASH_COMMAND_SPECS.flatMap((command) => command.shortcuts))
      .not.toContain('Tab after @');
    const help = renderInteractiveHelp().join('\n');
    expect(help).not.toContain('/edit');
    expect(help).not.toContain('/files');
    expect(help).not.toContain('/stash');
    expect(help).not.toContain('/restore');
    expect(help).not.toContain('/draft');
    expect(help).not.toContain('/retry');
  });

  it('insert-mode 取代 queue/followup 进入目录且各 phase 均可用', () => {
    const insertMode = SLASH_COMMAND_SPECS.find(
      (command) => command.actionId === 'task.insert-mode',
    );
    expect(insertMode).toMatchObject({
      name: 'insert-mode',
      availableWhileRunning: true,
      category: 'task',
    });
    expect(SLASH_COMMAND_SPECS.some(
      (command) => command.actionId === 'task.queue' ||
        command.actionId === 'task.follow-up',
    )).toBe(false);
    const base = {
      phase: 'idle' as const,
      approvalPending: false,
      providerPromptActive: false,
      providerCommandsAvailable: true,
      hasModel: false,
      hasTranscript: false,
    };
    for (const phase of ['idle', 'running', 'compacting'] as const) {
      expect(commandPaletteEntries('insert-mode', { ...base, phase })[0]?.availability)
        .toEqual({ kind: 'enabled' });
    }
  });

  it('bash completion returns argv-level hierarchical tokens and option values', () => {
    const completion = renderCompletion('bash');
    const nested = runShell('bash', [
      completion,
      'COMP_WORDS=(coda auth "")',
      'COMP_CWORD=2',
      '_coda_complete',
      'printf \'%s\\n\' "${COMPREPLY[@]}"',
    ].join('\n'));
    expect(nested.code).toBe(0);
    expect(nested.stdout.trim().split('\n')).toEqual(['login', 'logout', 'status']);
    expect(nested.stdout).not.toContain('auth login');

    const option = runShell('bash', [
      completion,
      'COMP_WORDS=(coda auth login --pr)',
      'COMP_CWORD=3',
      '_coda_complete',
      'printf \'%s\\n\' "${COMPREPLY[@]}"',
    ].join('\n'));
    expect(option.stdout.trim()).toBe('--preset');

    const value = runShell('bash', [
      completion,
      'COMP_WORDS=(coda auth login --preset=o)',
      'COMP_CWORD=3',
      '_coda_complete',
      'printf \'%s\\n\' "${COMPREPLY[@]}"',
    ].join('\n'));
    expect(value.stdout.trim().split('\n')).toEqual([
      '--preset=opencode-go',
      '--preset=openai',
      '--preset=oauth',
    ]);
  });

  it('zsh completion returns separate auth subcommand tokens at the current argv position', () => {
    const completion = renderCompletion('zsh');
    const result = runShell('/bin/zsh', [
      'compdef() { :; }',
      'compadd() { local item; for item in "$@"; do [[ "$item" == -- ]] || print -r -- "$item"; done }',
      completion,
      'words=(coda auth "")',
      'CURRENT=3',
      '_coda',
    ].join('\n'));
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual(['login', 'logout', 'status']);
    expect(result.stdout).not.toContain('auth login');
  });
});

function runShell(shell: string, script: string): {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
} {
  const result = Bun.spawnSync([shell, '-c', script], { stdout: 'pipe', stderr: 'pipe' });
  const decode = (value: Uint8Array): string => new TextDecoder().decode(value);
  return { code: result.exitCode, stdout: decode(result.stdout), stderr: decode(result.stderr) };
}

function expectUsageError(
  argv: readonly string[],
  code: CliUsageError['code'],
  messagePart: string,
): void {
  try {
    parseCliInvocation(argv);
    throw new Error('expected parse failure');
  } catch (error) {
    expect(error).toBeInstanceOf(CliUsageError);
    const usage = error as CliUsageError;
    expect(usage.code).toBe(code);
    expect(renderCliUsageError(usage)).toContain(messagePart);
  }
}
