// Canonical CLI/slash command specification. This module is intentionally pure and has no
// filesystem, process-signal, provider, Runtime, or OpenTUI imports: the executable bootstrap
// may parse help/version/completion before loading the product runtime.

export type CommandCategory =
  | 'task'
  | 'session'
  | 'review'
  | 'provider'
  | 'settings'
  | 'help';

export type InteractiveHelpSurface = 'tui' | 'classic' | 'text';

export type ApprovalMode = 'interactive' | 'allow' | 'deny';
export type CliProvider =
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'faux';
export type CliUiMode = 'auto' | 'tui' | 'classic' | 'accessible' | 'plain';
export type CompletionShell = 'bash' | 'zsh' | 'fish' | 'powershell';
export type ConfigurableCliApi =
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic-messages';

export const AUTH_PRESET_SPECS = [
  {
    id: 'opencode-go',
    label: 'OpenCode Go',
    description: 'Hosted mixed-protocol model catalog',
    enabled: true,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    description: 'api.openai.com · Responses API',
    enabled: true,
    baseURL: 'https://api.openai.com/v1',
    api: 'openai-responses',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    description: 'api.anthropic.com · Messages API',
    enabled: true,
    baseURL: 'https://api.anthropic.com',
    api: 'anthropic-messages',
  },
  {
    id: 'custom',
    label: 'Custom',
    description: 'Custom endpoint and supported protocol',
    enabled: true,
  },
  {
    id: 'oauth',
    label: 'OAuth',
    description: 'Coming soon · disabled',
    enabled: false,
  },
] as const;

export type AuthPreset = typeof AUTH_PRESET_SPECS[number]['id'];

export interface OptionSpec {
  readonly id: string;
  readonly flags: readonly string[];
  readonly valueHint?: string;
  readonly summary: string;
  readonly choices?: readonly string[];
  readonly hidden?: boolean;
}

export interface CommandSpec {
  readonly id: string;
  readonly category: CommandCategory;
  readonly summary: string;
  readonly cli?: {
    readonly path: readonly string[];
    readonly usage?: string;
    readonly optionIds?: readonly string[];
  };
  readonly slash?: {
    readonly name: string;
    readonly aliases?: readonly string[];
    readonly argumentHint?: string;
    readonly availableWhileRunning: boolean;
    readonly order: number;
  };
  readonly shortcuts?: readonly {
    readonly keys: string;
    readonly summary: string;
    readonly surfaces?: readonly InteractiveHelpSurface[];
  }[];
}

export interface InteractiveCommandContext {
  readonly phase: 'idle' | 'running' | 'retrying' | 'compacting';
  readonly approvalPending: boolean;
  readonly providerPromptActive: boolean;
  readonly providerCommandsAvailable: boolean;
  readonly hasModel: boolean;
  readonly hasTranscript: boolean;
  readonly hasStash: boolean;
}

export type CommandAvailability =
  | { readonly kind: 'enabled' }
  | { readonly kind: 'disabled'; readonly reason: string }
  | { readonly kind: 'hidden' };

export interface CommandPaletteEntry {
  readonly command: SlashCommandSpec;
  readonly availability: CommandAvailability;
  readonly score: number;
}

export const OPTION_SPECS: readonly OptionSpec[] = [
  { id: 'help', flags: ['-h', '--help'], summary: 'Show help and exit' },
  { id: 'version', flags: ['-V', '--version'], summary: 'Show version and exit' },
  { id: 'prompt', flags: ['-p', '--prompt'], valueHint: '<text>', summary: 'Run one prompt and exit' },
  { id: 'continue', flags: ['--continue'], summary: 'Continue the most recent session' },
  { id: 'resume', flags: ['--resume'], valueHint: '[thread]', summary: 'Resume a session (picker when omitted)' },
  { id: 'workspace', flags: ['--workspace'], valueHint: '<id>', summary: 'Disambiguate a workspace identity' },
  { id: 'model', flags: ['--model'], valueHint: '<id>', summary: 'Use an explicit model id' },
  { id: 'base-url', flags: ['--base-url'], valueHint: '<url>', summary: 'Override the provider base URL' },
  { id: 'api-key', flags: ['--api-key'], valueHint: '<key>', summary: 'Use an API key (interactive login is safer)' },
  { id: 'provider', flags: ['--provider'], valueHint: '<api>', summary: 'Select a legacy provider adapter', choices: ['openai-chat', 'openai-responses', 'anthropic-messages', 'faux'] },
  { id: 'faux-script', flags: ['--faux-script'], valueHint: '<path>', summary: 'Load an offline faux-provider script', hidden: true },
  { id: 'approval-mode', flags: ['--approval-mode'], valueHint: '<mode>', summary: 'Set approval behavior', choices: ['interactive', 'allow', 'deny'] },
  { id: 'cwd', flags: ['--cwd'], valueHint: '<path>', summary: 'Set the workspace directory' },
  { id: 'session-dir', flags: ['--session-dir'], valueHint: '<path>', summary: 'Override legacy session storage', hidden: true },
  { id: 'no-color', flags: ['--no-color'], summary: 'Disable semantic colors' },
  { id: 'json', flags: ['--json'], summary: 'Use the legacy NDJSON transport' },
  { id: 'event-format', flags: ['--event-format'], valueHint: '<format>', summary: 'Select headless event framing', choices: ['legacy', 'envelope'] },
  { id: 'ui', flags: ['--ui'], valueHint: '<mode>', summary: 'Select the terminal surface', choices: ['auto', 'tui', 'classic', 'accessible', 'plain'] },
  { id: 'preset', flags: ['--preset'], valueHint: '<name>', summary: 'Select an authentication preset', choices: AUTH_PRESET_SPECS.map((preset) => preset.id) },
  { id: 'name', flags: ['--name'], valueHint: '<name>', summary: 'Set a custom provider name' },
  { id: 'api', flags: ['--api'], valueHint: '<api>', summary: 'Select a custom provider protocol', choices: ['openai-chat', 'openai-responses', 'anthropic-messages'] },
  { id: 'select', flags: ['--select'], valueHint: '<provider/model>', summary: 'Select a model after listing it' },
] as const;

const RUN_OPTION_IDS = [
  'json',
  'prompt',
  'continue',
  'resume',
  'workspace',
  'model',
  'base-url',
  'api-key',
  'provider',
  'faux-script',
  'approval-mode',
  'cwd',
  'session-dir',
  'no-color',
  'event-format',
  'ui',
] as const;

export const COMMAND_SPECS: readonly CommandSpec[] = [
  {
    id: 'help.show', category: 'help', summary: 'Show commands, options, and shortcuts',
    cli: { path: ['help'], usage: '[command]' },
    slash: { name: 'help', availableWhileRunning: true, order: 0 },
  },
  {
    id: 'version.show', category: 'help', summary: 'Show the coda version',
    cli: { path: ['version'] },
  },
  {
    id: 'doctor.run', category: 'help', summary: 'Diagnose the local terminal and configuration',
    cli: { path: ['doctor'], usage: '[--json]', optionIds: ['json'] },
    slash: { name: 'doctor', availableWhileRunning: true, order: 22 },
  },
  {
    id: 'completion.generate', category: 'help', summary: 'Generate shell completion',
    cli: { path: ['completion'], usage: '<bash|zsh|fish|powershell>' },
  },
  {
    id: 'auth.login', category: 'provider', summary: 'Add or update provider API-key authentication',
    cli: {
      path: ['auth', 'login'],
      usage: '[--preset <name>]',
      optionIds: ['preset', 'name', 'api', 'base-url', 'api-key', 'json'],
    },
    slash: { name: 'login', availableWhileRunning: false, order: 3 },
  },
  {
    id: 'auth.logout', category: 'provider', summary: 'Remove a saved provider API key',
    cli: { path: ['auth', 'logout'], usage: '[provider]', optionIds: ['json'] },
    slash: { name: 'logout', availableWhileRunning: false, order: 5 },
  },
  {
    id: 'auth.status', category: 'provider', summary: 'Show saved authentication without secrets',
    cli: { path: ['auth', 'status'], optionIds: ['json'] },
    slash: { name: 'auth', aliases: ['auth-status'], availableWhileRunning: true, order: 6 },
  },
  {
    id: 'models.list', category: 'provider', summary: 'List cached models or explicitly select one',
    cli: {
      path: ['models'],
      usage: '[--select <provider/model>] [--json]',
      optionIds: ['select', 'json'],
    },
    slash: { name: 'model', availableWhileRunning: false, order: 4 },
  },
  {
    id: 'sessions.list', category: 'session', summary: 'List resumable sessions',
    cli: {
      path: ['sessions'],
      usage: '[--cwd <path>] [--workspace <id>] [--json]',
      optionIds: ['json', 'cwd', 'workspace', 'session-dir'],
    },
  },
  {
    id: 'task.exec', category: 'task', summary: 'Run the existing one-shot mode explicitly',
    cli: { path: ['exec'], usage: '[options] [prompt]', optionIds: RUN_OPTION_IDS },
    shortcuts: [
      { keys: 'Enter', summary: 'send when idle; steer while running' },
      { keys: 'Shift+Enter', summary: 'insert a newline', surfaces: ['tui', 'classic'] },
      { keys: 'Up/Down', summary: 'move vertically or browse single-line history', surfaces: ['classic'] },
      { keys: 'Alt+Up/Down', summary: 'browse prompt history', surfaces: ['tui'] },
    ],
  },
  {
    id: 'transcript.scroll', category: 'review', summary: 'Scroll the transcript without moving input focus',
    shortcuts: [{ keys: 'PageUp/PageDown', summary: 'scroll output', surfaces: ['tui'] }],
  },
  {
    id: 'review.diff', category: 'review', summary: 'Open the complete turn or workspace diff',
    slash: { name: 'diff', argumentHint: '[turn|workspace]', availableWhileRunning: true, order: 23 },
  },
  {
    id: 'review.inspect', category: 'review', summary: 'Inspect reasoning and tool execution details',
    slash: { name: 'review', availableWhileRunning: true, order: 24 },
  },
  {
    id: 'review.permissions', category: 'review', summary: 'Show authoritative permission scope and revision',
    slash: { name: 'permissions', availableWhileRunning: true, order: 25 },
  },
  {
    id: 'conversation.compact', category: 'task', summary: 'Compact the current conversation context',
    slash: { name: 'compact', availableWhileRunning: false, order: 26 },
  },
  {
    id: 'conversation.retry', category: 'task', summary: 'Retry the latest user turn in a safe fork',
    slash: { name: 'retry', argumentHint: '[turn-id]', availableWhileRunning: false, order: 27 },
  },
  {
    id: 'conversation.fork', category: 'session', summary: 'Fork committed conversation context',
    slash: { name: 'fork', argumentHint: '[turn-id]', availableWhileRunning: false, order: 28 },
  },
  {
    id: 'session.new', category: 'session', summary: 'Create and switch to a new session',
    slash: { name: 'new', availableWhileRunning: true, order: 29 },
  },
  {
    id: 'session.list', category: 'session', summary: 'Search sessions with status and workspace context',
    slash: { name: 'sessions', argumentHint: '[query]', availableWhileRunning: true, order: 30 },
  },
  {
    id: 'session.resume', category: 'session', summary: 'Resume or pick a session',
    slash: { name: 'resume', argumentHint: '[thread-id]', availableWhileRunning: true, order: 31 },
  },
  {
    id: 'session.switch', category: 'session', summary: 'Switch the visible session without stopping background work',
    slash: { name: 'switch', argumentHint: '<thread-id>', availableWhileRunning: true, order: 32 },
  },
  {
    id: 'session.rename', category: 'session', summary: 'Rename the current session',
    slash: { name: 'rename', argumentHint: '<title>', availableWhileRunning: true, order: 33 },
  },
  {
    id: 'session.archive', category: 'session', summary: 'Archive or restore the current session',
    slash: { name: 'archive', argumentHint: '[on|off]', availableWhileRunning: true, order: 34 },
  },
  {
    id: 'palette.open', category: 'help', summary: 'Open the searchable command palette',
    shortcuts: [{ keys: 'Ctrl+K', summary: 'open command palette', surfaces: ['tui', 'classic'] }],
  },
  {
    id: 'history.search', category: 'task', summary: 'Search this thread prompt history',
    slash: { name: 'history', argumentHint: '[query]', availableWhileRunning: true, order: 14 },
    shortcuts: [{ keys: 'Ctrl+R', summary: 'search prompt history', surfaces: ['tui', 'classic'] }],
  },
  {
    id: 'draft.edit', category: 'task', summary: 'Edit the current draft with $VISUAL or $EDITOR',
    slash: { name: 'edit', availableWhileRunning: true, order: 15 },
    shortcuts: [{ keys: 'Ctrl+O', summary: 'edit draft in $EDITOR', surfaces: ['tui', 'classic'] }],
  },
  {
    id: 'draft.files', category: 'task', summary: 'Complete workspace files and directories',
    slash: { name: 'files', argumentHint: '[query]', availableWhileRunning: true, order: 16 },
    shortcuts: [{ keys: 'Tab after @', summary: 'complete workspace path', surfaces: ['tui', 'classic'] }],
  },
  {
    id: 'draft.stash', category: 'task', summary: 'Stash the current thread draft durably',
    slash: { name: 'stash', argumentHint: '[text]', availableWhileRunning: true, order: 17 },
    shortcuts: [{ keys: 'Meta+S', summary: 'stash this thread draft', surfaces: ['tui', 'classic'] }],
  },
  {
    id: 'draft.restore', category: 'task', summary: 'Restore this thread’s stashed draft',
    slash: { name: 'restore', availableWhileRunning: true, order: 18 },
  },
  {
    id: 'settings.vim', category: 'settings', summary: 'Enable or disable optional Vim composer keys',
    slash: { name: 'vim', argumentHint: '<on|off>', availableWhileRunning: true, order: 20 },
  },
  {
    id: 'draft.manage', category: 'task', summary: 'Show, send, or clear this thread’s durable draft',
    slash: { name: 'draft', argumentHint: '<show|send|clear>', availableWhileRunning: true, order: 19 },
  },
  {
    id: 'transcript.search', category: 'review', summary: 'Search the current transcript',
    slash: { name: 'search', argumentHint: '<query>', availableWhileRunning: true, order: 8 },
    shortcuts: [{ keys: 'Ctrl+F', summary: 'search transcript', surfaces: ['tui', 'classic'] }],
  },
  {
    id: 'transcript.next', category: 'review', summary: 'Jump to the next transcript search match',
    slash: { name: 'next', availableWhileRunning: true, order: 9 },
  },
  {
    id: 'transcript.previous', category: 'review', summary: 'Jump to the previous transcript search match',
    slash: { name: 'previous', aliases: ['prev'], availableWhileRunning: true, order: 10 },
  },
  {
    id: 'transcript.latest', category: 'review', summary: 'Jump to the latest output and clear unread',
    slash: { name: 'latest', availableWhileRunning: true, order: 11 },
    shortcuts: [{ keys: 'End', summary: 'jump to latest output', surfaces: ['tui'] }],
  },
  {
    id: 'content.copy', category: 'review', summary: 'Copy the latest response or raw transcript',
    slash: { name: 'copy', argumentHint: '[latest|raw]', availableWhileRunning: true, order: 12 },
  },
  {
    id: 'content.export', category: 'review', summary: 'Safely export transcript content without overwriting',
    slash: { name: 'export', argumentHint: '[text|raw|latest] [path]', availableWhileRunning: true, order: 13 },
  },
  {
    id: 'task.queue', category: 'task', summary: 'Show steering and follow-up queues',
    slash: { name: 'queue', availableWhileRunning: true, order: 1 },
  },
  {
    id: 'task.status', category: 'task', summary: 'Show model, usage, and token status',
    slash: { name: 'status', availableWhileRunning: true, order: 2 },
  },
  {
    id: 'task.follow-up', category: 'task', summary: 'Queue a follow-up after the current task',
    slash: { name: 'followup', aliases: ['f'], argumentHint: '<text>', availableWhileRunning: true, order: 6 },
    shortcuts: [{
      keys: 'Alt+Enter',
      summary: 'queue the current draft as follow-up',
      surfaces: ['tui', 'classic'],
    }],
  },
  {
    id: 'task.abort', category: 'task', summary: 'Abort only the current run',
    slash: { name: 'abort', availableWhileRunning: true, order: 7 },
    shortcuts: [{ keys: 'Esc', summary: 'abort the current run', surfaces: ['tui', 'classic'] }],
  },
  {
    id: 'app.quit', category: 'help', summary: 'Exit coda cleanly',
    slash: { name: 'quit', aliases: ['q'], availableWhileRunning: false, order: 21 },
    shortcuts: [
      { keys: 'Esc Esc', summary: 'exit', surfaces: ['tui', 'classic'] },
      { keys: 'Ctrl+C Ctrl+C', summary: 'exit', surfaces: ['tui', 'classic'] },
      { keys: 'Ctrl+D', summary: 'exit while idle with an empty draft', surfaces: ['tui', 'classic'] },
      { keys: 'Ctrl+C', summary: 'abort a run or exit while idle', surfaces: ['text'] },
      { keys: 'Ctrl+D/EOF', summary: 'abort a run and exit', surfaces: ['text'] },
    ],
  },
] as const;

export interface CliFlags {
  json: boolean;
  eventFormat: 'legacy' | 'envelope';
  prompt?: string;
  continue_: boolean;
  resume?: string | true;
  workspace?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  provider?: CliProvider;
  fauxScript?: string;
  cwd?: string;
  sessionDir?: string;
  noColor: boolean;
  approvalMode?: ApprovalMode;
  ui: CliUiMode;
}

export type CliCommand =
  | { readonly kind: 'run'; readonly explicitExec: boolean }
  | { readonly kind: 'help'; readonly commandPath?: readonly string[] }
  | { readonly kind: 'version' }
  | { readonly kind: 'doctor' }
  | { readonly kind: 'completion'; readonly shell: CompletionShell }
  | {
      readonly kind: 'auth';
      readonly operation: 'login' | 'logout' | 'status';
      readonly providerId?: string;
      readonly preset?: AuthPreset;
      readonly name?: string;
      readonly api?: ConfigurableCliApi;
    }
  | { readonly kind: 'models'; readonly select?: string }
  | { readonly kind: 'sessions' };

export interface CliInvocation {
  readonly command: CliCommand;
  readonly flags: CliFlags;
}

export type CliUsageErrorCode =
  | 'unknown_flag'
  | 'missing_value'
  | 'invalid_value'
  | 'missing_command'
  | 'unknown_subcommand'
  | 'unexpected_argument'
  | 'mutually_exclusive';

export class CliUsageError extends Error {
  override readonly name = 'CliUsageError';

  constructor(
    readonly code: CliUsageErrorCode,
    message: string,
    readonly fix?: string,
  ) {
    super(message);
  }
}

const SESSION_ID_RE = /^(?:\d{8}-\d{6}-|runtime-[0-9a-f]{40}$)/;
const COMPLETION_SHELLS: readonly CompletionShell[] = ['bash', 'zsh', 'fish', 'powershell'];
const UI_MODES: readonly CliUiMode[] = ['auto', 'tui', 'classic', 'accessible', 'plain'];
const PRESETS: readonly AuthPreset[] = AUTH_PRESET_SPECS.map((preset) => preset.id);
const CONFIGURABLE_APIS: readonly ConfigurableCliApi[] = [
  'openai-chat', 'openai-responses', 'anthropic-messages',
];

export function parseCliInvocation(argv: readonly string[]): CliInvocation {
  const helpIndex = argv.findIndex((value) => value === '-h' || value === '--help');
  if (helpIndex !== -1) {
    return {
      command: { kind: 'help', commandPath: helpTarget(argv, helpIndex) },
      flags: defaultFlags(),
    };
  }
  if (argv.some((value) => value === '-V' || value === '--version')) {
    return { command: { kind: 'version' }, flags: defaultFlags() };
  }

  const args = [...argv];
  const command = parseCommandPrefix(args);
  const flags = defaultFlags();
  let preset: typeof PRESETS[number] | undefined;
  let providerName: string | undefined;
  let providerApi: ConfigurableCliApi | undefined;
  let selectedModel: string | undefined;
  const seenOptions = new Set<string>();
  const positional: string[] = [];

  for (let index = 0; index < args.length; index++) {
    const argument = args[index] as string;
    const take = (): string => {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new CliUsageError(
          'missing_value',
          `flag ${quote(argument)} requires a value`,
          `coda ${commandExample(command)} ${argument} <value>`.trim(),
        );
      }
      index++;
      return value;
    };
    const equals = splitLongOption(argument);
    const name = equals?.name ?? argument;
    const takeOption = (): string => equals === undefined ? take() : requireEqualsValue(name, equals.value);

    switch (name) {
      case '--json': rejectEquals(name, equals); flags.json = true; seenOptions.add('json'); break;
      case '-p':
      case '--prompt': flags.prompt = name === '-p' ? take() : takeOption(); seenOptions.add('prompt'); break;
      case '--continue': rejectEquals(name, equals); flags.continue_ = true; seenOptions.add('continue'); break;
      case '--resume': {
        seenOptions.add('resume');
        if (equals !== undefined) {
          flags.resume = requireEqualsValue(name, equals.value);
          break;
        }
        const value = args[index + 1];
        if (value !== undefined && SESSION_ID_RE.test(value)) {
          flags.resume = value;
          index++;
        } else {
          flags.resume = true;
        }
        break;
      }
      case '--workspace': flags.workspace = takeOption(); seenOptions.add('workspace'); break;
      case '--model': flags.model = takeOption(); seenOptions.add('model'); break;
      case '--base-url': flags.baseUrl = takeOption(); seenOptions.add('base-url'); break;
      case '--api-key': flags.apiKey = takeOption(); seenOptions.add('api-key'); break;
      case '--provider': flags.provider = parseChoice(takeOption(), ['openai-chat', 'openai-responses', 'anthropic-messages', 'faux'], 'provider'); seenOptions.add('provider'); break;
      case '--faux-script': flags.fauxScript = takeOption(); seenOptions.add('faux-script'); break;
      case '--approval-mode': flags.approvalMode = parseChoice(takeOption(), ['interactive', 'allow', 'deny'], 'approval mode'); seenOptions.add('approval-mode'); break;
      case '--cwd': flags.cwd = takeOption(); seenOptions.add('cwd'); break;
      case '--session-dir': flags.sessionDir = takeOption(); seenOptions.add('session-dir'); break;
      case '--no-color': rejectEquals(name, equals); flags.noColor = true; seenOptions.add('no-color'); break;
      case '--event-format': {
        const value = equals === undefined ? take() : equals.value;
        flags.eventFormat = parseChoice(value, ['legacy', 'envelope'], 'event format');
        seenOptions.add('event-format');
        break;
      }
      case '--ui': flags.ui = parseChoice(takeOption(), UI_MODES, 'UI mode'); seenOptions.add('ui'); break;
      case '--preset': preset = parseChoice(takeOption(), PRESETS, 'auth preset'); seenOptions.add('preset'); break;
      case '--name': providerName = takeOption(); seenOptions.add('name'); break;
      case '--api': providerApi = parseChoice(takeOption(), CONFIGURABLE_APIS, 'provider API'); seenOptions.add('api'); break;
      case '--select': selectedModel = takeOption(); seenOptions.add('select'); break;
      default:
        if (argument.startsWith('-')) throw unknownFlag(name);
        positional.push(argument);
    }
  }

  const finalized = finalizeCommand(command, positional, { preset, providerName, providerApi, selectedModel });
  validateCommandOptions(command, seenOptions);
  validateAuthPresetOptions(finalized, seenOptions);
  if (finalized.kind === 'run') appendLegacyPrompt(flags, positional);
  validateGlobalCombinations(flags);
  return {
    command: finalized,
    flags,
  };
}

function validateAuthPresetOptions(
  command: CliCommand,
  seen: ReadonlySet<string>,
): void {
  if (
    command.kind !== 'auth' ||
    command.operation !== 'login' ||
    !['name', 'base-url', 'api'].some((option) => seen.has(option)) ||
    command.preset === 'custom'
  ) {
    return;
  }
  throw new CliUsageError(
    'mutually_exclusive',
    '--name, --base-url, and --api are only valid with --preset custom',
    'coda auth login --preset custom --name <name> --base-url <url> --api <api>',
  );
}

function defaultFlags(): CliFlags {
  return {
    json: false,
    eventFormat: 'legacy',
    continue_: false,
    noColor: false,
    ui: 'auto',
  };
}

type CommandPrefix =
  | { kind: 'run'; explicitExec: boolean }
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'doctor' }
  | { kind: 'completion' }
  | { kind: 'auth'; operation: 'login' | 'logout' | 'status' }
  | { kind: 'models' }
  | { kind: 'sessions' };

function parseCommandPrefix(args: string[]): CommandPrefix {
  const first = args[0];
  switch (first) {
    case 'exec': args.shift(); return { kind: 'run', explicitExec: true };
    case 'help': args.shift(); return { kind: 'help' };
    case 'version': args.shift(); return { kind: 'version' };
    case 'doctor': args.shift(); return { kind: 'doctor' };
    case 'completion': args.shift(); return { kind: 'completion' };
    case 'models': args.shift(); return { kind: 'models' };
    case 'sessions': args.shift(); return { kind: 'sessions' };
    case 'auth': {
      args.shift();
      const operation = args.shift();
      if (operation === undefined) {
        throw new CliUsageError('missing_command', 'auth requires login, logout, or status', 'coda auth status');
      }
      if (operation !== 'login' && operation !== 'logout' && operation !== 'status') {
        const suggestion = nearest(operation, ['login', 'logout', 'status']);
        throw new CliUsageError(
          'unknown_subcommand',
          `unknown auth command ${quote(operation)}${suggestion === undefined ? '' : `; did you mean ${quote(suggestion)}?`}`,
          `coda auth ${suggestion ?? 'status'}`,
        );
      }
      return { kind: 'auth', operation };
    }
    default: return { kind: 'run', explicitExec: false };
  }
}

function finalizeCommand(
  prefix: CommandPrefix,
  positional: readonly string[],
  values: {
    readonly preset?: typeof PRESETS[number];
    readonly providerName?: string;
    readonly providerApi?: ConfigurableCliApi;
    readonly selectedModel?: string;
  },
): CliCommand {
  switch (prefix.kind) {
    case 'run':
      return { kind: 'run', explicitExec: prefix.explicitExec };
    case 'help': {
      if (positional.length > 2) {
        throw new CliUsageError(
          'unexpected_argument',
          'help accepts at most a two-part command path',
          'coda help auth login',
        );
      }
      return {
        kind: 'help',
        ...(positional.length === 0 ? {} : { commandPath: positional }),
      };
    }
    case 'version':
      requireNoPositionals('version', positional);
      return { kind: 'version' };
    case 'doctor':
      requireNoPositionals('doctor', positional);
      return { kind: 'doctor' };
    case 'completion': {
      if (positional.length !== 1) {
        throw new CliUsageError(
          positional.length === 0 ? 'missing_value' : 'unexpected_argument',
          'completion requires exactly one shell: bash, zsh, fish, or powershell',
          'coda completion bash',
        );
      }
      return { kind: 'completion', shell: parseChoice(positional[0] as string, COMPLETION_SHELLS, 'completion shell') };
    }
    case 'models':
      requireNoPositionals('models', positional);
      return { kind: 'models', ...(values.selectedModel === undefined ? {} : { select: values.selectedModel }) };
    case 'sessions':
      requireNoPositionals('sessions', positional);
      return { kind: 'sessions' };
    case 'auth': {
      if (prefix.operation !== 'logout') requireNoPositionals(`auth ${prefix.operation}`, positional);
      if (prefix.operation === 'logout' && positional.length > 1) {
        throw new CliUsageError('unexpected_argument', 'auth logout accepts at most one provider id', 'coda auth logout <provider>');
      }
      return {
        kind: 'auth',
        operation: prefix.operation,
        ...(positional[0] === undefined ? {} : { providerId: positional[0] }),
        ...(values.preset === undefined ? {} : { preset: values.preset }),
        ...(values.providerName === undefined ? {} : { name: values.providerName }),
        ...(values.providerApi === undefined ? {} : { api: values.providerApi }),
      };
    }
  }
}

function requireNoPositionals(command: string, values: readonly string[]): void {
  if (values.length === 0) return;
  throw new CliUsageError(
    'unexpected_argument',
    `${command} does not accept argument ${quote(values[0] as string)}`,
    `coda ${command} --help`,
  );
}

function validateGlobalCombinations(flags: CliFlags): void {
  if (flags.continue_ && flags.resume !== undefined) {
    throw new CliUsageError(
      'mutually_exclusive',
      '--continue and --resume are mutually exclusive',
      'coda --continue  # or: coda --resume',
    );
  }
  if (flags.eventFormat === 'envelope' && !flags.json) {
    throw new CliUsageError('mutually_exclusive', '--event-format=envelope requires --json', 'coda --json --event-format=envelope');
  }
  if (flags.json && flags.ui !== 'auto') {
    throw new CliUsageError('mutually_exclusive', '--json and an explicit --ui mode are mutually exclusive', 'coda --json  # remove --ui');
  }
  if (flags.ui === 'tui' && flags.prompt !== undefined) {
    throw new CliUsageError('mutually_exclusive', '--ui=tui cannot be combined with a one-shot prompt', 'coda --ui=tui  # then enter the task');
  }
}

function validateCommandOptions(command: CommandPrefix, seen: ReadonlySet<string>): void {
  const allowed = new Set(commandOptionIds(command));
  const unexpected = [...seen].find((id) => !allowed.has(id));
  if (unexpected === undefined) return;
  const option = OPTION_SPECS.find((candidate) => candidate.id === unexpected);
  const flag = option?.flags.at(-1) ?? `--${unexpected}`;
  throw new CliUsageError(
    'unexpected_argument',
    `${flag} is not valid for coda ${commandExample(command)}`.trim(),
    `coda ${commandExample(command)} --help`.trim(),
  );
}

function commandOptionIds(command: CommandPrefix): readonly string[] {
  if (command.kind === 'run') return RUN_OPTION_IDS;
  const path = command.kind === 'auth'
    ? ['auth', command.operation]
    : [command.kind];
  return COMMAND_SPECS.find((candidate) => arraysEqual(candidate.cli?.path, path))?.cli?.optionIds ?? [];
}

function helpTarget(argv: readonly string[], helpIndex: number): readonly string[] | undefined {
  const candidate = helpIndex === 0 ? argv.slice(1) : argv.slice(0, helpIndex);
  const paths = COMMAND_SPECS
    .flatMap((command) => command.cli === undefined ? [] : [command.cli.path])
    .sort((left, right) => right.length - left.length);
  return paths.find((path) => path.every((segment, index) => candidate[index] === segment));
}

function appendLegacyPrompt(flags: CliFlags, positional: readonly string[]): void {
  if (positional.length === 0) return;
  const text = positional.join(' ');
  flags.prompt = flags.prompt === undefined ? text : `${flags.prompt} ${text}`;
}

/** Public parser with legacy naked-prompt projection. */
export function parseCommandLine(argv: readonly string[]): CliInvocation {
  return parseCliInvocation(argv);
}

function splitLongOption(argument: string): { name: string; value: string } | undefined {
  if (!argument.startsWith('--')) return undefined;
  const index = argument.indexOf('=');
  return index === -1 ? undefined : { name: argument.slice(0, index), value: argument.slice(index + 1) };
}

function requireEqualsValue(name: string, value: string): string {
  if (value !== '') return value;
  if (name === '--resume' || name === '--workspace') {
    throw new CliUsageError('missing_value', `flag ${name} requires a non-empty value after =`, `coda ${name}=<value>`);
  }
  throw new CliUsageError('missing_value', `flag ${name} requires a value`, `coda ${name}=<value>`);
}

function rejectEquals(
  name: string,
  equals: { readonly name: string; readonly value: string } | undefined,
): void {
  if (equals === undefined) return;
  throw new CliUsageError(
    'unexpected_argument',
    `${name} does not accept a value`,
    `coda ${name}`,
  );
}

function parseChoice<const T extends string>(value: string, choices: readonly T[], label: string): T {
  if ((choices as readonly string[]).includes(value)) return value as T;
  throw new CliUsageError(
    'invalid_value',
    `unknown ${label}: ${safeToken(value)} (expected ${choices.join('|')})`,
  );
}

function unknownFlag(value: string): CliUsageError {
  const candidates = OPTION_SPECS.flatMap((option) => option.flags);
  const suggestion = nearest(value, candidates);
  return new CliUsageError(
    'unknown_flag',
    `unknown flag: ${safeToken(value)}${suggestion === undefined ? '' : `; did you mean ${suggestion}?`}`,
    suggestion === undefined ? 'coda --help' : `coda ${suggestion}`,
  );
}

function nearest(input: string, candidates: readonly string[]): string | undefined {
  const ranked = candidates
    .map((candidate) => ({ candidate, distance: editDistance(input, candidate) }))
    .sort((left, right) => left.distance - right.distance || left.candidate.localeCompare(right.candidate));
  const best = ranked[0];
  if (best === undefined) return undefined;
  return best.distance <= Math.max(2, Math.floor(input.length * 0.35)) ? best.candidate : undefined;
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex++) {
    const current = [leftIndex + 1];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex++) {
      current.push(Math.min(
        (current[rightIndex] as number) + 1,
        (previous[rightIndex + 1] as number) + 1,
        (previous[rightIndex] as number) + (left[leftIndex] === right[rightIndex] ? 0 : 1),
      ));
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] as number;
}

function commandExample(command: CommandPrefix): string {
  switch (command.kind) {
    case 'run': return command.explicitExec ? 'exec' : '';
    case 'auth': return `auth ${command.operation}`;
    default: return command.kind;
  }
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function safeToken(value: string): string {
  return /^[a-zA-Z0-9._:/=@+-]+$/.test(value) ? value : JSON.stringify(value);
}

export function renderCliHelp(version: string, commandPath?: readonly string[]): string {
  const command = commandPath === undefined
    ? undefined
    : COMMAND_SPECS.find((candidate) => arraysEqual(candidate.cli?.path, commandPath));
  if (command !== undefined && command.cli !== undefined) {
    const path = command.cli.path.join(' ');
    const optionLines = renderOptionLines(command.cli.optionIds ?? []);
    return [
      `coda ${version} · ${command.summary}`,
      '',
      `Usage: coda ${path}${command.cli.usage === undefined ? '' : ` ${command.cli.usage}`}`,
      ...(optionLines.length === 0 ? [] : ['', 'Options:', ...optionLines]),
      '',
      'Run `coda --help` for all commands and run options.',
    ].join('\n');
  }

  const commands = COMMAND_SPECS
    .filter((candidate) => candidate.cli !== undefined && candidate.cli.path[0] !== 'help' && candidate.cli.path[0] !== 'version')
    .map((candidate) => {
      const usage = candidate.cli?.usage === undefined ? '' : ` ${candidate.cli.usage}`;
      return `  ${pad(`coda ${candidate.cli?.path.join(' ')}${usage}`, 48)}${candidate.summary}`;
    });
  const options = renderOptionLines(['help', 'version', ...RUN_OPTION_IDS]);
  return [
    `coda ${version} · terminal coding agent`,
    '',
    'Usage:',
    '  coda [options] [prompt]',
    '  coda exec [options] [prompt]',
    '  coda <command> [options]',
    '',
    'First run:',
    '  1. coda auth login',
    '  2. coda models --select <provider/model>',
    '  3. coda "describe your task"',
    '',
    'Commands:',
    ...commands,
    '',
    'Run options:',
    ...options,
    '',
    'Interactive: /help shows slash commands and keyboard shortcuts.',
  ].join('\n');
}

function renderOptionLines(optionIds: readonly string[]): string[] {
  const allowed = new Set(optionIds);
  return OPTION_SPECS
    .filter((option) => allowed.has(option.id) && option.hidden !== true)
    .map((option) => {
      const flags = option.flags.join(', ');
      return `  ${pad(`${flags}${option.valueHint === undefined ? '' : ` ${option.valueHint}`}`, 32)}${option.summary}`;
    });
}

export function renderCliUsageError(error: CliUsageError): string {
  return [
    `[coda] ${error.code}: ${error.message}`,
    ...(error.fix === undefined ? [] : [`[coda] fix: ${error.fix}`]),
  ].join('\n');
}

export interface SlashCommandSpec {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly description: string;
  readonly category: CommandCategory;
  readonly argumentHint?: string;
  readonly availableWhileRunning: boolean;
  readonly actionId: string;
  readonly shortcuts: readonly string[];
}

export const SLASH_COMMAND_SPECS: readonly SlashCommandSpec[] = COMMAND_SPECS
  .flatMap((command): (SlashCommandSpec & { readonly order: number })[] =>
    command.slash === undefined ? [] : [{
      name: command.slash.name,
      ...(command.slash.aliases === undefined ? {} : { aliases: command.slash.aliases }),
      description: command.summary,
      category: command.category,
      ...(command.slash.argumentHint === undefined ? {} : { argumentHint: command.slash.argumentHint }),
      availableWhileRunning: command.slash.availableWhileRunning,
      actionId: command.id,
      shortcuts: (command.shortcuts ?? []).map((shortcut) => shortcut.keys),
      order: command.slash.order,
    }])
  .sort((left, right) => left.order - right.order)
  .map((command) => ({
    name: command.name,
    ...(command.aliases === undefined ? {} : { aliases: command.aliases }),
    description: command.description,
    category: command.category,
    ...(command.argumentHint === undefined ? {} : { argumentHint: command.argumentHint }),
    availableWhileRunning: command.availableWhileRunning,
    actionId: command.actionId,
    shortcuts: command.shortcuts,
  }));

export function findSlashCommand(name: string): SlashCommandSpec | undefined {
  const folded = name.toLocaleLowerCase('en-US');
  return SLASH_COMMAND_SPECS.find(
    (command) => command.name === folded || command.aliases?.includes(folded) === true,
  );
}

/** One availability function feeds palette rendering and controller admission hints. */
export function interactiveCommandAvailability(
  command: SlashCommandSpec,
  context: InteractiveCommandContext,
): CommandAvailability {
  if (context.providerPromptActive) return { kind: 'hidden' };
  if (context.approvalPending) {
    return command.actionId === 'task.abort'
      ? { kind: 'enabled' }
      : { kind: 'disabled', reason: 'approval is waiting; answer or abort first' };
  }
  const busy = context.phase !== 'idle';
  if (busy && !command.availableWhileRunning) {
    return { kind: 'disabled', reason: 'finish or abort the current run first' };
  }
  if (
    (command.actionId === 'auth.login' ||
      command.actionId === 'auth.status' ||
      command.actionId === 'auth.logout' ||
      command.actionId === 'models.list') &&
    !context.providerCommandsAvailable
  ) {
    return { kind: 'disabled', reason: 'provider management is unavailable on this surface' };
  }
  if (command.actionId === 'task.follow-up' && !context.hasModel) {
    return { kind: 'disabled', reason: 'select a model first' };
  }
  if (command.actionId === 'task.abort' && context.phase === 'idle') {
    return { kind: 'disabled', reason: 'no active run' };
  }
  if (
    (command.actionId === 'transcript.search' ||
      command.actionId === 'transcript.next' ||
      command.actionId === 'transcript.previous' ||
      command.actionId === 'transcript.latest' ||
      command.actionId === 'content.copy' ||
      command.actionId === 'content.export') &&
    !context.hasTranscript
  ) {
    return { kind: 'disabled', reason: 'the transcript is empty' };
  }
  if (command.actionId === 'draft.restore' && !context.hasStash) {
    return { kind: 'disabled', reason: 'no stashed draft for this thread' };
  }
  return { kind: 'enabled' };
}

/** Categorized fuzzy palette. Name/alias matches outrank description/category subsequences. */
export function commandPaletteEntries(
  query: string,
  context: InteractiveCommandContext,
): readonly CommandPaletteEntry[] {
  const folded = query.replace(/^\//u, '').toLocaleLowerCase('en-US');
  return SLASH_COMMAND_SPECS.flatMap((command): CommandPaletteEntry[] => {
    const availability = interactiveCommandAvailability(command, context);
    if (availability.kind === 'hidden') return [];
    const score = fuzzyCommandScore(command, folded);
    return score === undefined ? [] : [{ command, availability, score }];
  }).sort((left, right) => left.score - right.score ||
    left.command.name.localeCompare(right.command.name, 'en'));
}

export function fuzzyCommandScore(
  command: SlashCommandSpec,
  query: string,
): number | undefined {
  if (query === '') return SLASH_COMMAND_SPECS.indexOf(command) * 10;
  const names = [command.name, ...(command.aliases ?? [])];
  const catalogOrder = Math.max(0, SLASH_COMMAND_SPECS.indexOf(command));
  let best = Number.POSITIVE_INFINITY;
  for (const name of names) {
    if (name === query) best = Math.min(best, 0);
    else if (name.startsWith(query)) best = Math.min(best, 10 + catalogOrder);
    const direct = name.indexOf(query);
    if (direct >= 0) best = Math.min(best, 40 + direct * 5 + name.length);
    const subsequence = subsequenceScore(name, query);
    if (subsequence !== undefined) best = Math.min(best, 50 + subsequence);
  }
  for (const text of [command.description, command.category]) {
    const subsequence = subsequenceScore(text.toLocaleLowerCase('en-US'), query);
    if (subsequence !== undefined) best = Math.min(best, 200 + subsequence);
  }
  return Number.isFinite(best) ? best : undefined;
}

function subsequenceScore(candidate: string, query: string): number | undefined {
  let cursor = 0;
  let score = candidate.length;
  let previous = -2;
  for (const character of query) {
    const found = candidate.indexOf(character, cursor);
    if (found < 0) return undefined;
    score += found === previous + 1 ? 0 : found + 4;
    previous = found;
    cursor = found + 1;
  }
  return score;
}

export function renderInteractiveHelp(
  surface: InteractiveHelpSurface = 'classic',
): readonly string[] {
  const shortcuts = COMMAND_SPECS
    .flatMap((command) => command.shortcuts ?? [])
    .filter((shortcut) => shortcut.surfaces === undefined || shortcut.surfaces.includes(surface))
    .map((shortcut) => `${shortcut.keys}: ${shortcut.summary}`);
  const slash = SLASH_COMMAND_SPECS.map((command) =>
    `/${command.name}${command.argumentHint === undefined ? '' : ` ${command.argumentHint}`}: ${command.description}`);
  return [...shortcuts, ...slash];
}

export function renderCompletion(shell: CompletionShell): string {
  switch (shell) {
    case 'bash':
      return renderBashCompletion();
    case 'zsh':
      return renderZshCompletion();
    case 'fish':
      return renderFishCompletion();
    case 'powershell':
      return renderPowerShellCompletion();
  }
}

function renderBashCompletion(): string {
  return [
    renderPosixCompletionCandidates(),
    '_coda_complete() {',
    '  local cur option prefix candidate index',
    '  local -a before=()',
    '  cur="${COMP_WORDS[COMP_CWORD]}"',
    '  for ((index = 1; index < COMP_CWORD; index++)); do',
    '    before+=("${COMP_WORDS[index]}")',
    '  done',
    '  COMPREPLY=()',
    '  if [[ "$cur" == --*=* ]]; then',
    '    option="${cur%%=*}"',
    '    prefix="${cur#*=}"',
    '    while IFS= read -r candidate; do',
    '      [[ "$candidate" == "$prefix"* ]] && COMPREPLY+=("$option=$candidate")',
    '    done < <(_coda_candidates "${before[@]}" "$option")',
    '    return',
    '  fi',
    '  while IFS= read -r candidate; do',
    '    [[ "$candidate" == "$cur"* ]] && COMPREPLY+=("$candidate")',
    '  done < <(_coda_candidates "${before[@]}")',
    '}',
    'complete -F _coda_complete coda',
  ].join('\n');
}

function renderZshCompletion(): string {
  return [
    '#compdef coda',
    renderPosixCompletionCandidates(),
    '_coda() {',
    '  local cur option prefix candidate index',
    '  local -a before matches',
    '  cur="${words[CURRENT]}"',
    '  for ((index = 2; index < CURRENT; index++)); do',
    '    before+=("${words[index]}")',
    '  done',
    '  if [[ "$cur" == --*=* ]]; then',
    '    option="${cur%%=*}"',
    '    prefix="${cur#*=}"',
    '    while IFS= read -r candidate; do',
    '      [[ "$candidate" == "$prefix"* ]] && matches+=("$option=$candidate")',
    '    done < <(_coda_candidates "${before[@]}" "$option")',
    '  else',
    '    while IFS= read -r candidate; do',
    '      [[ "$candidate" == "$cur"* ]] && matches+=("$candidate")',
    '    done < <(_coda_candidates "${before[@]}")',
    '  fi',
    '  compadd -- "${matches[@]}"',
    '}',
    'compdef _coda coda',
  ].join('\n');
}

/** bash/zsh 共用：输入是光标前已经完成的 argv token，每行返回一个完整 token。 */
function renderPosixCompletionCandidates(): string {
  const choiceOptions = OPTION_SPECS.filter((option) => option.choices !== undefined);
  const valueOnlyOptions = OPTION_SPECS.filter(
    (option) => option.valueHint !== undefined && option.choices === undefined,
  );
  const pathCases = cliSpecs().map((command) => {
    const path = command.cli?.path ?? [];
    const key = `${path[0] ?? ''}:${path[1] ?? ''}`;
    return `    ${shellQuote(key)}) candidates=${shellCompletionList(completionFlags(command))} ;;`;
  });
  const lines = [
    '_coda_candidates() {',
    '  local first="${1-}" second="${2-}" previous="" item candidates=""',
    '  for item in "$@"; do previous="$item"; done',
    '  case "$previous" in',
  ];
  for (const option of choiceOptions) {
    lines.push(
      `    ${option.flags.join('|')}) candidates=${shellCompletionList(option.choices ?? [])}; ` +
      'printf \'%s\\n\' "$candidates"; return ;;',
    );
  }
  if (valueOnlyOptions.length > 0) {
    lines.push(`    ${valueOnlyOptions.flatMap((option) => option.flags).join('|')}) return ;;`);
  }
  lines.push(
    '  esac',
    `  if [ "$#" -eq 0 ]; then candidates=${shellCompletionList(rootCompletionTokens())}`,
    `  elif [ "$first" = auth ] && [ "$#" -eq 1 ]; then candidates=${shellCompletionList(childCommands('auth'))}`,
    `  elif [ "$first" = completion ] && [ "$#" -eq 1 ]; then candidates=${shellCompletionList(COMPLETION_SHELLS)}`,
    `  elif [ "$first" = help ] && [ "$#" -eq 1 ]; then candidates=${shellCompletionList(topLevelCommands())}`,
    '  else',
    '    case "$first:$second" in',
    ...pathCases,
    '    esac',
    '  fi',
    '  [ -z "$candidates" ] || printf \'%s\\n\' "$candidates"',
    '}',
  );
  return lines.join('\n');
}

function renderFishCompletion(): string {
  const top = topLevelCommands();
  const lines = ['complete -c coda -f'];
  for (const command of top) {
    lines.push(`complete -c coda -n '__fish_use_subcommand' -a ${shellQuote(command)}`);
  }
  const children = childCommands('auth');
  for (const command of children) {
    lines.push(
      `complete -c coda -n '__fish_seen_subcommand_from auth; and not ` +
      `__fish_seen_subcommand_from ${children.join(' ')}' -a ${shellQuote(command)}`,
    );
  }
  lines.push(
    `complete -c coda -n '__fish_seen_subcommand_from completion' -a ` +
    shellQuote(COMPLETION_SHELLS.join(' ')),
  );
  for (const command of cliSpecs()) {
    const path = command.cli?.path ?? [];
    const condition = path
      .map((part) => `__fish_seen_subcommand_from ${part}`)
      .join('; and ');
    for (const option of completionOptions(command)) {
      const flags = option.flags.map((flag) =>
        flag.startsWith('--') ? `-l ${flag.slice(2)}` : `-s ${flag.slice(1)}`).join(' ');
      const values = option.choices === undefined ? '' : ` -xa ${shellQuote(option.choices.join(' '))}`;
      const requiresValue = option.valueHint !== undefined && !option.valueHint.startsWith('[') ? ' -r' : '';
      lines.push(
        `complete -c coda -n ${shellQuote(condition)} ${flags}${requiresValue}${values} ` +
        `-d ${shellQuote(option.summary)}`,
      );
    }
  }
  return lines.join('\n');
}

function renderPowerShellCompletion(): string {
  const pathCases = cliSpecs().map((command) => {
    const path = command.cli?.path ?? [];
    const key = `${path[0] ?? ''}:${path[1] ?? ''}`;
    return `      '${key}' { $candidates = @(${powerShellArray(completionFlags(command))}) }`;
  });
  const choiceCases = OPTION_SPECS.filter((option) => option.choices !== undefined).flatMap((option) =>
    option.flags.map((flag) =>
      `    '${flag}' { $candidates = @(${powerShellArray(option.choices ?? [])}); $valueOption = $true }`));
  const valueOnlyCases = OPTION_SPECS
    .filter((option) => option.valueHint !== undefined && option.choices === undefined)
    .flatMap((option) => option.flags.map((flag) => `    '${flag}' { return }`));
  return [
    'Register-ArgumentCompleter -Native -CommandName coda -ScriptBlock {',
    '  param($wordToComplete, $commandAst)',
    '  $elements = @($commandAst.CommandElements | ForEach-Object { $_.Extent.Text })',
    '  $arguments = if ($elements.Count -le 1) { @() } else { @($elements[1..($elements.Count - 1)]) }',
    '  if ($wordToComplete -ne "" -and $arguments.Count -gt 0 -and $arguments[-1] -eq $wordToComplete) {',
    '    $arguments = if ($arguments.Count -eq 1) { @() } else { @($arguments[0..($arguments.Count - 2)]) }',
    '  }',
    '  $first = if ($arguments.Count -gt 0) { $arguments[0] } else { "" }',
    '  $second = if ($arguments.Count -gt 1) { $arguments[1] } else { "" }',
    '  $previous = if ($arguments.Count -gt 0) { $arguments[-1] } else { "" }',
    '  $candidates = @()',
    '  $valueOption = $false',
    '  switch ($previous) {',
    ...choiceCases,
    ...valueOnlyCases,
    '  }',
    '  if (-not $valueOption) {',
    `    if ($arguments.Count -eq 0) { $candidates = @(${powerShellArray(rootCompletionTokens())}) }`,
    `    elseif ($first -eq 'auth' -and $arguments.Count -eq 1) { $candidates = @(${powerShellArray(childCommands('auth'))}) }`,
    `    elseif ($first -eq 'completion' -and $arguments.Count -eq 1) { $candidates = @(${powerShellArray(COMPLETION_SHELLS)}) }`,
    `    elseif ($first -eq 'help' -and $arguments.Count -eq 1) { $candidates = @(${powerShellArray(topLevelCommands())}) }`,
    '    else {',
    '      switch ("${first}:${second}") {',
    ...pathCases,
    '      }',
    '    }',
    '  }',
    '  $candidates | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {',
    '    [System.Management.Automation.CompletionResult]::new($_, $_, "ParameterValue", $_)',
    '  }',
    '}',
  ].join('\n');
}

function cliSpecs(): readonly CommandSpec[] {
  return COMMAND_SPECS.filter((command) => command.cli !== undefined);
}

function topLevelCommands(): readonly string[] {
  return [...new Set(cliSpecs().map((command) => command.cli?.path[0]).filter(
    (value): value is string => value !== undefined,
  ))];
}

function childCommands(parent: string): readonly string[] {
  return cliSpecs()
    .filter((command) => command.cli?.path[0] === parent && command.cli.path.length > 1)
    .map((command) => command.cli?.path[1])
    .filter((value): value is string => value !== undefined);
}

function completionOptions(command: CommandSpec): readonly OptionSpec[] {
  const ids = new Set(['help', 'version', ...(command.cli?.optionIds ?? [])]);
  return OPTION_SPECS.filter((option) => ids.has(option.id));
}

function completionFlags(command: CommandSpec): readonly string[] {
  return completionOptions(command).flatMap((option) => option.flags);
}

function rootCompletionTokens(): readonly string[] {
  const run = COMMAND_SPECS.find((command) => command.id === 'task.exec');
  return [...topLevelCommands(), ...(run === undefined ? [] : completionFlags(run))];
}

function powerShellArray(values: readonly string[]): string {
  return values.map((value) => `'${value.replaceAll("'", "''")}'`).join(', ');
}

function shellCompletionList(values: readonly string[]): string {
  return shellQuote(values.join('\n'));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? `${value} ` : value.padEnd(width, ' ');
}

function arraysEqual(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return left !== undefined && left.length === right.length && left.every((value, index) => value === right[index]);
}
