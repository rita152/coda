import { describe, expect, it } from 'bun:test';
import {
  CliUsageError,
  COMMAND_SPECS,
  OPTION_SPECS,
  parseCliInvocation,
  renderCliHelp,
  renderCliUsageError,
  renderCompletion,
  renderInteractiveHelp,
  SLASH_COMMAND_SPECS,
} from './command-catalog.js';

describe('canonical command catalog', () => {
  it('preserves legacy naked prompt, -p append, resume, and headless flags', () => {
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
    expectUsageError(['--json', '--ui=plain'], 'mutually_exclusive', 'remove --ui');
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

  it('uses a valid explicit UI mode and keeps auto as the default', () => {
    expect(parseCliInvocation([]).flags.ui).toBe('auto');
    expect(parseCliInvocation(['--ui=accessible']).flags.ui).toBe('accessible');
    expectUsageError(['--ui=graphical'], 'invalid_value', 'auto|tui|classic|accessible|plain');
  });

  it('generates help, completion, and slash help from the same catalog', () => {
    const help = renderCliHelp('1.2.3');
    const loginHelp = renderCliHelp('1.2.3', ['auth', 'login']);
    const doctorHelp = renderCliHelp('1.2.3', ['doctor']);
    const interactiveHelp = renderInteractiveHelp('classic').join('\n');
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
      'help', 'queue', 'status', 'login', 'model', 'logout', 'followup', 'quit',
    ]);
    expect(renderInteractiveHelp('tui').join('\n')).toContain('PageUp/PageDown: scroll output');
    expect(renderInteractiveHelp('tui').join('\n')).toContain('Alt+Up/Down: browse prompt history');
    expect(renderInteractiveHelp('classic').join('\n')).toContain('Up/Down: move vertically');
    expect(renderInteractiveHelp('text').join('\n')).not.toContain('Shift+Enter');
    expect(renderInteractiveHelp('text').join('\n')).toContain('Ctrl+C: abort a run or exit while idle');
    expect(loginHelp).toContain('--preset <name>');
    expect(loginHelp).toContain('--api-key <key>');
    expect(loginHelp).not.toContain('--select');
    expect(doctorHelp).toContain('--json');
    expect(doctorHelp).not.toContain('--cwd');
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
