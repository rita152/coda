// Standalone product commands that do not attach a thread. Provider configuration remains at
// the CLI edge; session inventory is handled separately through RuntimePort in main.ts.

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import * as readline from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { runtimeHomeDir } from '../shared/index.js';
import {
  AUTH_PRESET_SPECS,
  type AuthPreset,
  type CliCommand,
  type CliFlags,
  type CliInvocation,
  type ConfigurableCliApi,
} from './command-catalog.js';
import {
  type ConfigureProviderResult,
  ProviderRegistry,
} from './provider-registry.js';
import { configureBuiltInProvider } from './provider-actions.js';
import { sanitizeTerminalLine } from './terminal-sanitize.js';

export interface DoctorCheck {
  readonly id: string;
  readonly status: 'ok' | 'warning' | 'error';
  readonly message: string;
}

export interface DoctorReport {
  readonly ok: boolean;
  readonly checks: readonly DoctorCheck[];
}

interface ProductIo {
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;
  readonly stderr: NodeJS.WriteStream;
}

type AuthCommand = Extract<CliCommand, { readonly kind: 'auth' }>;
interface CustomLoginFields {
  readonly name: string;
  readonly baseURL: string;
  readonly api: ConfigurableCliApi;
}

class LoginCancelledError extends Error {
  constructor() {
    super('login cancelled');
  }
}

export async function runStandaloneProductCommand(
  invocation: CliInvocation,
  version: string,
  io: ProductIo = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr },
): Promise<number | undefined> {
  switch (invocation.command.kind) {
    case 'doctor':
      return runDoctor(invocation.flags.json, version, io);
    case 'auth':
      return runAuth(invocation, io);
    case 'models':
      return runModels(invocation, io);
    default:
      return undefined;
  }
}

function runDoctor(json: boolean, version: string, io: ProductIo): number {
  const report = collectDoctorReport(version, io);
  if (json) {
    writeJson(io.stdout, { type: 'doctor', ...report });
  } else {
    for (const line of formatDoctorReportLines(report)) writeHuman(io.stdout, line);
  }
  return report.ok ? 0 : 1;
}

export function collectDoctorReport(
  version: string,
  io: Pick<ProductIo, 'stdin' | 'stdout'> = {
    stdin: process.stdin,
    stdout: process.stdout,
  },
): DoctorReport {
  const home = runtimeHomeDir();
  const codaDir = path.join(home, '.coda');
  const checks: DoctorCheck[] = [
    { id: 'runtime', status: 'ok', message: `coda ${version} · Bun ${Bun.version}` },
    {
      id: 'terminal',
      status: Bun.env.TERM === 'dumb' ? 'warning' : 'ok',
      message: terminalDescription(io),
    },
    inspectJsonFile('config', path.join(codaDir, 'config.json'), false),
    inspectJsonFile('providers', path.join(codaDir, 'providers.json'), false),
    inspectJsonFile('credentials', path.join(codaDir, 'credentials.json'), true),
    inspectPath('runtime-storage', path.join(codaDir, 'runtime-v2')),
  ];
  const ok = checks.every((check) => check.status !== 'error');
  return { ok, checks };
}

export function formatDoctorReportLines(report: DoctorReport): readonly string[] {
  return [
    ...report.checks.map((check) => {
      const marker = check.status === 'ok'
        ? '[ok]'
        : check.status === 'warning' ? '[warn]' : '[error]';
      return `${marker} ${check.id}: ${check.message}`;
    }),
    report.ok ? 'doctor: ready' : 'doctor: action required',
  ];
}

export function formatAuthStatusLines(registry: ProviderRegistry): readonly string[] {
  const credentials = registry.listCredentials();
  const selected = registry.selectedModel();
  if (credentials.length === 0) {
    return ['No saved provider credentials. Next: coda auth login'];
  }
  return [
    ...credentials.map((credential) =>
      `[authenticated] ${credential.providerName} (${credential.providerId})`),
    selected === undefined
      ? 'Selected model: none · next: coda models --select <provider/model>'
      : `Selected model: ${selected.providerId}/${selected.model}`,
  ];
}

function inspectJsonFile(id: string, file: string, credentials: boolean): DoctorCheck {
  if (!existsSync(file)) {
    return { id, status: 'warning', message: `not configured (${file})` };
  }
  try {
    JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (credentials && process.platform !== 'win32') {
      const mode = statSync(file).mode & 0o777;
      if ((mode & 0o077) !== 0) {
        return {
          id,
          status: 'error',
          message: `${file} permissions are ${mode.toString(8)}; run chmod 600 ${JSON.stringify(file)}`,
        };
      }
    }
    return { id, status: 'ok', message: file };
  } catch (error) {
    return {
      id,
      status: 'error',
      message: `${file}: ${safeError(error)}`,
    };
  }
}

function inspectPath(id: string, target: string): DoctorCheck {
  if (!existsSync(target)) return { id, status: 'warning', message: `not created yet (${target})` };
  try {
    return statSync(target).isDirectory()
      ? { id, status: 'ok', message: target }
      : { id, status: 'error', message: `${target} is not a directory` };
  } catch (error) {
    return { id, status: 'error', message: `${target}: ${safeError(error)}` };
  }
}

function terminalDescription(io: Pick<ProductIo, 'stdin' | 'stdout'>): string {
  const term = Bun.env.TERM ?? 'unset';
  const noColor = Bun.env.NO_COLOR === undefined ? 'off' : 'on';
  return `stdin=${io.stdin.isTTY === true ? 'tty' : 'pipe'} ` +
    `stdout=${io.stdout.isTTY === true ? 'tty' : 'pipe'} TERM=${term} NO_COLOR=${noColor}`;
}

async function runAuth(invocation: CliInvocation, io: ProductIo): Promise<number> {
  if (invocation.command.kind !== 'auth') return 2;
  let registry: ProviderRegistry;
  try {
    registry = new ProviderRegistry();
  } catch (error) {
    return commandFailure(io, invocation.flags.json, 'auth', safeError(error), 2);
  }
  switch (invocation.command.operation) {
    case 'status': {
      const credentials = registry.listCredentials();
      const selected = registry.selectedModel();
      if (invocation.flags.json) {
        writeJson(io.stdout, {
          type: 'auth_status',
          authenticated: credentials,
          selectedModel: selected === undefined ? null : `${selected.providerId}/${selected.model}`,
        });
      } else {
        for (const line of formatAuthStatusLines(registry)) writeHuman(io.stdout, line);
      }
      return 0;
    }
    case 'logout':
      return runLogout(registry, invocation.command, invocation.flags, io);
    case 'login': {
      try {
        return await runLogin(registry, invocation.command, invocation.flags, io);
      } catch (error) {
        return commandFailure(
          io,
          invocation.flags.json,
          'auth_login',
          safeError(error),
          error instanceof LoginCancelledError ? 130 : 2,
        );
      }
    }
  }
}

async function runLogin(
  registry: ProviderRegistry,
  command: AuthCommand,
  flags: CliFlags,
  io: ProductIo,
): Promise<number> {
  let preset = command.preset;
  if (preset === undefined) {
    if (io.stdin.isTTY !== true) {
      return commandFailure(
        io,
        flags.json,
        'auth_login',
        'non-interactive login requires --preset and --api-key',
        2,
      );
    }
    writeHuman(io.stderr, 'Login preset:');
    AUTH_PRESET_SPECS.forEach((item, index) => {
      writeHuman(
        io.stderr,
        `  ${index + 1}. ${item.label} · ${item.description}${item.enabled ? '' : ' [disabled]'}`,
      );
    });
    const answer = await readLine(io, 'Preset number or name (Ctrl+C/Ctrl+D cancels): ');
    preset = selectPreset(answer);
    if (preset === undefined) {
      return commandFailure(io, flags.json, 'auth_login', 'unknown login preset', 2);
    }
  }
  if (preset === 'oauth') {
    return commandFailure(io, flags.json, 'auth_login', 'OAuth is coming soon and is currently disabled', 2);
  }
  const definition = AUTH_PRESET_SPECS.find((candidate) => candidate.id === preset);
  if (definition?.enabled !== true) {
    return commandFailure(
      io,
      flags.json,
      'auth_login',
      'OAuth is coming soon and is currently disabled',
      2,
    );
  }

  let customFields: CustomLoginFields | undefined;
  if (preset === 'custom') {
    const name = command.name ?? await requireInteractiveField(
      io,
      'Custom · [field 1/4] Provider name (Ctrl+C/Ctrl+D cancels): ',
      '--name',
    );
    const baseURL = flags.baseUrl ?? await requireInteractiveField(
      io,
      `Custom · name=${sanitizeTerminalLine(name)} · [field 2/4] Base URL (Ctrl+C/Ctrl+D cancels): `,
      '--base-url',
    );
    const api = command.api ?? await requireProtocol(io, name, baseURL);
    customFields = { name, baseURL, api };
  }

  let apiKey = flags.apiKey;
  if (apiKey === undefined) {
    if (io.stdin.isTTY !== true) {
      return commandFailure(io, flags.json, 'auth_login', '--api-key is required without a TTY', 2);
    }
    const secretPrompt = customFields === undefined
      ? `${definition.label} · [field 2/2] API key (secret · Ctrl+C/Ctrl+D cancels): `
      : `Custom · name=${sanitizeTerminalLine(customFields.name)} · ` +
        `baseURL=${sanitizeTerminalLine(customFields.baseURL)} · api=${customFields.api} · ` +
        '[field 4/4] API key (secret · Ctrl+C/Ctrl+D cancels): ';
    apiKey = await readSecretLine(io, secretPrompt);
  }

  writeHuman(io.stderr, `Authenticating ${definition.label}; refreshing models…`);
  let result: ConfigureProviderResult;
  try {
    result = await configurePreset(registry, preset, apiKey, customFields);
  } catch (error) {
    return commandFailure(io, flags.json, 'auth_login', safeError(error), 1);
  } finally {
    apiKey = '';
  }

  const refreshOk = result.refresh.ok;
  if (flags.json) {
    writeJson(io.stdout, {
      type: 'auth_login',
      ok: refreshOk,
      saved: true,
      provider: { id: result.provider.id, name: result.provider.name },
      models: refreshOk ? result.refresh.models.length : 0,
      ...(refreshOk ? {} : { error: result.refresh.error }),
    });
  } else {
    writeHuman(io.stdout, `Saved credentials for ${result.provider.name} (${result.provider.id}).`);
    if (refreshOk) {
      writeHuman(io.stdout, `Discovered ${result.refresh.models.length} models.`);
      writeHuman(io.stdout, 'Next: coda models --select <provider/model>');
    } else {
      writeHuman(io.stderr, result.refresh.error);
    }
  }
  return refreshOk ? 0 : 1;
}

async function configurePreset(
  registry: ProviderRegistry,
  preset: Exclude<AuthPreset, 'oauth'>,
  apiKey: string,
  customFields?: CustomLoginFields,
): Promise<ConfigureProviderResult> {
  switch (preset) {
    case 'opencode-go':
    case 'openai':
    case 'anthropic':
      return configureBuiltInProvider(registry, preset, apiKey);
    case 'custom': {
      if (customFields === undefined) throw new Error('custom provider fields are incomplete');
      return registry.configureCustom(
        customFields.name,
        customFields.baseURL,
        apiKey,
        customFields.api,
      );
    }
  }
}

async function requireInteractiveField(
  io: ProductIo,
  prompt: string,
  flag: '--name' | '--base-url' | '--api',
): Promise<string> {
  if (io.stdin.isTTY !== true) {
    throw new Error(
      `${flag} is required for non-interactive custom login; ` +
      'run coda auth login --preset custom --name <name> --base-url <url> --api <api> --api-key <key>',
    );
  }
  return readLine(io, prompt);
}

async function requireProtocol(
  io: ProductIo,
  name: string,
  baseURL: string,
): Promise<ConfigurableCliApi> {
  const value = await requireInteractiveField(
    io,
    `Custom · name=${sanitizeTerminalLine(name)} · baseURL=${sanitizeTerminalLine(baseURL)} · ` +
      '[field 3/4] Protocol (openai-chat|openai-responses|anthropic-messages; Ctrl+C/Ctrl+D cancels): ',
    '--api',
  );
  if (value === 'openai-chat' || value === 'openai-responses' || value === 'anthropic-messages') return value;
  throw new Error('unknown provider protocol');
}

async function runLogout(
  registry: ProviderRegistry,
  command: AuthCommand,
  flags: CliFlags,
  io: ProductIo,
): Promise<number> {
  const credentials = registry.listCredentials();
  if (credentials.length === 0) {
    if (flags.json) writeJson(io.stdout, { type: 'auth_logout', ok: true, removed: false });
    else writeHuman(io.stdout, 'No saved provider credentials.');
    return 0;
  }
  let providerId = command.providerId;
  if (providerId === undefined && credentials.length === 1) providerId = credentials[0]?.providerId;
  if (providerId === undefined && io.stdin.isTTY === true) {
    credentials.forEach((credential, index) => {
      writeHuman(io.stderr, `  ${index + 1}. ${credential.providerName} (${credential.providerId})`);
    });
    const answer = await readLine(io, 'Provider to log out: ');
    const index = Number(answer) - 1;
    providerId = credentials[index]?.providerId ?? answer.trim();
  }
  if (providerId === undefined) {
    return commandFailure(io, flags.json, 'auth_logout', 'provider id is required', 2);
  }
  const known = credentials.find((credential) => credential.providerId === providerId);
  const removed = registry.logout(providerId);
  if (!removed) return commandFailure(io, flags.json, 'auth_logout', `no saved credentials for ${providerId}`, 1);
  if (flags.json) {
    writeJson(io.stdout, { type: 'auth_logout', ok: true, removed: true, providerId });
  } else {
    writeHuman(io.stdout, `Logged out ${known?.providerName ?? providerId}.`);
  }
  return 0;
}

function runModels(invocation: CliInvocation, io: ProductIo): number {
  if (invocation.command.kind !== 'models') return 2;
  const command = invocation.command;
  let registry: ProviderRegistry;
  try {
    registry = new ProviderRegistry();
  } catch (error) {
    return commandFailure(io, invocation.flags.json, 'models', safeError(error), 2);
  }
  const models = registry.availableModels();
  if (command.select !== undefined) {
    const selected = models.find((model) => model.ref === command.select);
    if (selected === undefined) {
      return commandFailure(
        io,
        invocation.flags.json,
        'models_select',
        `model is not available: ${command.select}`,
        2,
      );
    }
    try {
      registry.rememberSelection(selected.providerId, selected.model);
    } catch (error) {
      return commandFailure(io, invocation.flags.json, 'models_select', safeError(error), 1);
    }
  }
  const selected = registry.selectedModel();
  const selectedRef = selected === undefined ? undefined : `${selected.providerId}/${selected.model}`;
  if (invocation.flags.json) {
    writeJson(io.stdout, {
      type: 'models',
      selected: selectedRef ?? null,
      models: models.map((model) => ({
        ref: model.ref,
        provider: model.providerName,
        api: model.api,
      })),
    });
  } else if (models.length === 0) {
    writeHuman(io.stdout, 'No cached models. Next: coda auth login');
  } else {
    for (const model of models) {
      writeHuman(
        io.stdout,
        `${model.ref === selectedRef ? '*' : ' '} ${model.ref} · ${model.providerName} · ${model.api}`,
      );
    }
    if (command.select === undefined) {
      writeHuman(io.stdout, 'Select: coda models --select <provider/model>');
    } else {
      writeHuman(io.stdout, `Selected ${selectedRef}. Next: coda "describe your task"`);
    }
  }
  return 0;
}

function selectPreset(value: string): AuthPreset | undefined {
  const trimmed = value.trim().toLocaleLowerCase('en-US');
  const index = Number(trimmed) - 1;
  if (Number.isInteger(index) && index >= 0) return AUTH_PRESET_SPECS[index]?.id;
  return AUTH_PRESET_SPECS.find((preset) =>
    preset.id === trimmed || preset.label.toLocaleLowerCase('en-US') === trimmed)?.id;
}

async function readLine(io: ProductIo, prompt: string): Promise<string> {
  const rl = createInterface({ input: io.stdin, output: io.stderr, terminal: true });
  const abort = new AbortController();
  let answered = false;
  const onInterrupt = (): void => {
    abort.abort(new LoginCancelledError());
  };
  let rejectClosed: ((error: Error) => void) | undefined;
  const closed = new Promise<never>((_resolve, reject) => {
    rejectClosed = reject;
  });
  const onClose = (): void => {
    if (!answered) rejectClosed?.(new LoginCancelledError());
  };
  rl.once('SIGINT', onInterrupt);
  rl.once('close', onClose);
  try {
    const answer = await Promise.race([
      rl.question(prompt, { signal: abort.signal }),
      closed,
    ]);
    answered = true;
    return answer;
  } catch (error) {
    if (abort.signal.aborted || error instanceof LoginCancelledError) {
      throw new LoginCancelledError();
    }
    throw error;
  } finally {
    rl.removeListener('SIGINT', onInterrupt);
    rl.removeListener('close', onClose);
    rl.close();
  }
}

async function readSecretLine(io: ProductIo, prompt: string): Promise<string> {
  const stdin = io.stdin;
  if (stdin.isTTY !== true || typeof stdin.setRawMode !== 'function') {
    throw new Error('secret input requires a TTY; pass --api-key from a protected environment');
  }
  io.stderr.write(prompt);
  readline.emitKeypressEvents(stdin);
  const wasRaw = stdin.isRaw === true;
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let secret = '';
    const finish = (error?: Error): void => {
      stdin.removeListener('keypress', onKeypress);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      io.stderr.write('\n');
      if (error === undefined) resolve(secret);
      else reject(error);
      secret = '';
    };
    const onKeypress = (text: string | undefined, key: readline.Key | undefined): void => {
      const name = key?.name;
      if (key?.ctrl === true && name === 'c') {
        finish(new LoginCancelledError());
      } else if (key?.ctrl === true && name === 'd') {
        finish(new LoginCancelledError());
      } else if (name === 'return' || name === 'enter') {
        finish();
      } else if (name === 'backspace') {
        secret = Array.from(secret).slice(0, -1).join('');
      } else if (text !== undefined && !/[\u0000-\u001f\u007f-\u009f]/u.test(text)) {
        secret += text;
      }
    };
    stdin.on('keypress', onKeypress);
  });
}

function commandFailure(
  io: ProductIo,
  json: boolean,
  type: string,
  message: string,
  code: number,
): number {
  if (json) writeJson(io.stdout, { type, ok: false, error: sanitizeTerminalLine(message) });
  else writeHuman(io.stderr, `[coda] ${message}`);
  return code;
}

function writeHuman(output: NodeJS.WriteStream, text: string): void {
  output.write(`${sanitizeTerminalLine(text)}\n`);
}

function writeJson(output: NodeJS.WriteStream, value: unknown): void {
  output.write(`${JSON.stringify(value)}\n`);
}

function safeError(error: unknown): string {
  return sanitizeTerminalLine(error instanceof Error ? error.message : String(error));
}
