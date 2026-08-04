// CLI 配置解析:flags > 环境变量 > ~/.coda/config.json,
// 逐字段独立合并。这里不再提供任何默认模型；交互启动的主路径由 provider registry
// 恢复最近一次用户显式选择，或保持未选择状态等待 /model。
// 密钥永远不进 Runtime journal，也不出现在任何 RuntimeEvent（ModelConfig 不随事件外发）。

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { CompatFlags, ModelConfig } from '../protocol/index.js';
import { runtimeHomeDir } from '../shared/index.js';
import { parseCliInvocation } from './command-catalog.js';
import type { CliFlags, CliProvider, CliUiMode } from './command-catalog.js';
import { sanitizeTerminalError, sanitizeTerminalLine } from './terminal-sanitize.js';
export type { ApprovalMode, CliFlags, CliProvider, CliUiMode } from './command-catalog.js';

export interface CodaConfigFile {
  model?: string;
  baseURL?: string;
  apiKeyEnv?: string;          // 指向环境变量名,避免密钥落盘(推荐)
  apiKey?: string;             // 明文兜底;存在时启动打印警告
  defaults?: { temperature?: number; reasoningEffort?: string; maxOutputTokens?: number };
  compat?: CompatFlags;
}

export function parseFlags(argv: string[]): CliFlags {
  return parseCliInvocation(argv).flags;
}

export interface ResolvedConfig {
  modelConfig?: ModelConfig;
  provider?: CliProvider;
  fauxScript?: string;
}

export interface ResolveConfigOptions {
  /** 只供 TUI 交互模式使用；可在无模型状态下通过 /login 配置。 */
  allowMissingApiKey?: boolean;
}

export interface TuiTerminalState {
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  term?: string;
}

export type InteractiveUiResolution =
  | { readonly ok: true; readonly surface: 'tui' }
  | { readonly ok: false; readonly message: string };

/** 显式 --ui 与 auto 共用的纯路由；只选择前端，不读取或改变 Runtime 状态。 */
export function resolveInteractiveUi(
  mode: CliUiMode,
  terminal: TuiTerminalState,
): InteractiveUiResolution {
  const fullTerminal = terminal.stdinIsTTY && terminal.stdoutIsTTY && terminal.term !== 'dumb';
  if (fullTerminal) return { ok: true, surface: 'tui' };
  const subject = mode === 'tui' ? '--ui=tui' : 'interactive mode';
  return {
    ok: false,
    message:
      `${subject} requires TTY stdin/stdout and TERM other than dumb; ` +
      'use a prompt, pipe stdin, or --json for non-interactive use',
  };
}

/** API key 边界统一去掉误带空白；全空白与未配置同义，不能遮蔽低优先级来源。 */
function normalizeApiKey(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === '' ? undefined : normalized;
}

/** 与 main.ts 的实际分派共用同一个纯判定，避免缺 key 策略和 UI 路由漂移。 */
export function isFullScreenTuiEligible(
  flags: Pick<CliFlags, 'json' | 'prompt'> & { readonly ui?: CliUiMode },
  terminal: TuiTerminalState,
): boolean {
  return (
    !flags.json &&
    flags.prompt === undefined &&
    (flags.ui === undefined || flags.ui === 'auto' || flags.ui === 'tui') &&
    terminal.stdinIsTTY &&
    terminal.stdoutIsTTY &&
    terminal.term !== 'dumb'
  );
}

/** 缺 key 的可执行提示；undefined 表示当前 provider 已可启动请求。 */
export function getMissingApiKeyMessage(config: ResolvedConfig): string | undefined {
  if (
    config.modelConfig === undefined ||
    config.provider === 'faux' ||
    normalizeApiKey(config.modelConfig.apiKey) !== undefined
  ) {
    return undefined;
  }
  const keyVar =
    config.provider === 'anthropic-messages' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
  return (
    `未找到 API key:设置环境变量 ${keyVar}(或 CODA_API_KEY),` +
    '或在 ~/.coda/config.json 写入 { "apiKeyEnv": "MY_KEY_VAR" }'
  );
}

export function readConfigFile(file = path.join(runtimeHomeDir(), '.coda', 'config.json')): CodaConfigFile {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return {}; // 文件不存在:配置可选,静默
  }
  try {
    return JSON.parse(raw) as CodaConfigFile;
  } catch (err) {
    // 损坏的 config 不静默吞:用户改错一行会以为配置生效(docs/09 的 CLI 错误纪律,
    // 同理坏文件要可见)。stderr 一行警告后按无配置继续,不阻断启动。
    console.error(
      `[coda] warning: ignoring invalid JSON in ${sanitizeTerminalLine(file)}: ${sanitizeTerminalError(err)}`,
    );
    return {};
  }
}

export function resolveConfig(
  flags: CliFlags,
  env: Readonly<Record<string, string | undefined>>,
  file: CodaConfigFile,
  options: ResolveConfigOptions = {},
): ResolvedConfig {
  const provider = flags.provider ?? 'openai-chat';
  if (provider === 'faux') {
    // faux 是正式 provider(e2e 用):无需 key/baseURL
    return {
      provider,
      fauxScript: flags.fauxScript,
      modelConfig: { ref: { provider: 'faux', api: 'faux', model: flags.model ?? 'faux' } },
    };
  }

  const isAnthropic = provider === 'anthropic-messages';
  const model = flags.model ?? env['CODA_MODEL'] ?? file.model;
  if (model === undefined || model.trim() === '') {
    if (normalizeApiKey(file.apiKey) !== undefined) {
      console.error('[coda] warning: ~/.coda/config.json 中存在明文 apiKey,建议改用 apiKeyEnv');
    }
    return flags.provider === undefined ? {} : { provider };
  }
  const baseURL = flags.baseUrl ?? env['CODA_BASE_URL'] ?? file.baseURL ?? undefined;
  // anthropic 侧优先接受 ANTHROPIC_API_KEY;两 provider 都尊重 CODA_API_KEY 与 config 文件
  const apiKeyEnv = file.apiKeyEnv?.trim();
  const fileApiKey =
    apiKeyEnv === undefined || apiKeyEnv === ''
      ? normalizeApiKey(file.apiKey)
      : normalizeApiKey(env[apiKeyEnv]);
  const apiKey =
    normalizeApiKey(flags.apiKey) ??
    normalizeApiKey(env['CODA_API_KEY']) ??
    normalizeApiKey(isAnthropic ? env['ANTHROPIC_API_KEY'] : env['OPENAI_API_KEY']) ??
    fileApiKey;
  const resolved: ResolvedConfig = {
    provider,
    modelConfig: {
      ref: isAnthropic
        ? { provider: 'anthropic', api: 'anthropic-messages', model }
        : {
            provider: 'openai',
            api: provider === 'openai-responses' ? 'openai-responses' : 'openai-chat',
            model,
          },
      baseURL,
      apiKey,
      compat: file.compat,
      defaults: file.defaults,
    },
  };
  const missingApiKey = getMissingApiKeyMessage(resolved);
  if (missingApiKey !== undefined && options.allowMissingApiKey !== true) {
    throw new Error(missingApiKey);
  }
  if (normalizeApiKey(file.apiKey) !== undefined) {
    console.error('[coda] warning: ~/.coda/config.json 中存在明文 apiKey,建议改用 apiKeyEnv');
  }
  return resolved;
}
