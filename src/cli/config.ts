// 配置解析(规格见 docs/09-cli.md §7):flags > 环境变量 > ~/.coda/config.json > 内置默认,
// 逐字段独立合并。缺 key 的报错必须给出可执行的修复提示。
// 密钥永远不进会话 JSONL、不出现在任何 AgentEvent(ModelConfig 不随事件外发)。

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { CompatFlags, ModelConfig } from '../protocol/index.js';

export interface CodaConfigFile {
  model?: string;
  baseURL?: string;
  apiKeyEnv?: string;          // 指向环境变量名,避免密钥落盘(推荐)
  apiKey?: string;             // 明文兜底;存在时启动打印警告
  defaults?: { temperature?: number; reasoningEffort?: string; maxOutputTokens?: number };
  compat?: CompatFlags;
}

/**
 * 审批模式(docs/07-tools.md §3、docs/09-cli.md §6.5):
 * interactive = beforeToolCall 挂 broker,edit/execute 弹审批;
 * allow = 不挂钩子全放行(headless/-p 默认——机器驱动场景由调用方自决信任边界);
 * deny = 静态拦截 edit/execute(只读探索),不建 broker。
 */
export type ApprovalMode = 'interactive' | 'allow' | 'deny';

export interface CliFlags {
  json: boolean;
  prompt?: string;             // -p 一次性模式
  continue_: boolean;          // --continue
  resume?: string | true;      // --resume [id](true = 列表选择)
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  provider?: 'openai-chat' | 'anthropic-messages' | 'faux';
  fauxScript?: string;         // --faux-script <path>(FauxScript 的可序列化子集)
  cwd?: string;
  sessionDir?: string;         // 测试/e2e 隔离用
  noColor: boolean;
  approvalMode?: ApprovalMode; // 缺省按形态定:交互 REPL → interactive,headless/-p → allow
}

/** 会话 id 形状(session/store.ts newSessionId:时间戳前缀 + 随机尾)。 */
const SESSION_ID_RE = /^\d{8}-\d{6}-/;

export function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = { json: false, continue_: false, noColor: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const next = (): string | undefined => argv[i + 1];
    const take = (): string => {
      const v = next();
      if (v === undefined || v.startsWith('--')) throw new Error(`flag ${a} requires a value`);
      i++;
      return v;
    };
    switch (a) {
      case '--json': flags.json = true; break;
      case '-p': case '--prompt': flags.prompt = take(); break;
      case '--continue': flags.continue_ = true; break;
      case '--resume': {
        // --resume 的可选值必须形如会话 id(YYYYMMDD-HHMMSS-…,见 store.newSessionId);
        // 否则视为无 id 的 --resume(列表选择),该值不吞——留在 argv 按裸 prompt 处理
        // (coda --resume "改个 bug" 的 "改个 bug" 是 prompt,不是 id)。
        const v = next();
        if (v !== undefined && SESSION_ID_RE.test(v)) { flags.resume = v; i++; }
        else flags.resume = true;
        break;
      }
      case '--model': flags.model = take(); break;
      case '--base-url': flags.baseUrl = take(); break;
      case '--api-key': flags.apiKey = take(); break;
      case '--provider': {
        const v = take();
        if (v !== 'openai-chat' && v !== 'anthropic-messages' && v !== 'faux') {
          throw new Error(`unknown provider: ${v}`);
        }
        flags.provider = v;
        break;
      }
      case '--faux-script': flags.fauxScript = take(); break;
      case '--approval-mode': {
        const v = take();
        if (v !== 'interactive' && v !== 'allow' && v !== 'deny') {
          throw new Error(`unknown approval mode: ${v} (expected interactive|allow|deny)`);
        }
        flags.approvalMode = v;
        break;
      }
      case '--cwd': flags.cwd = take(); break;
      case '--session-dir': flags.sessionDir = take(); break;
      case '--no-color': flags.noColor = true; break;
      default:
        if (a.startsWith('-')) throw new Error(`unknown flag: ${a}`);
        // 裸参数视为 -p 文本(便利:coda "做点什么")
        flags.prompt = flags.prompt === undefined ? a : `${flags.prompt} ${a}`;
    }
  }
  return flags;
}

export interface ResolvedConfig {
  modelConfig: ModelConfig;
  provider: 'openai-chat' | 'anthropic-messages' | 'faux';
  fauxScript?: string;
}

export function readConfigFile(file = path.join(homedir(), '.coda', 'config.json')): CodaConfigFile {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return {}; // 文件不存在:配置可选,静默
  }
  try {
    return JSON.parse(raw) as CodaConfigFile;
  } catch (err) {
    // 损坏的 config 不静默吞:用户改错一行会以为配置生效(docs/09 §7 缺 key 报错要可执行,
    // 同理坏文件要可见)。stderr 一行警告后按无配置继续,不阻断启动。
    console.error(
      `[coda] warning: ignoring invalid JSON in ${file}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {};
  }
}

export function resolveConfig(
  flags: CliFlags,
  env: NodeJS.ProcessEnv,
  file: CodaConfigFile,
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
  const model =
    flags.model ?? env['CODA_MODEL'] ?? file.model ?? (isAnthropic ? 'claude-opus-5' : 'gpt-5.2');
  const baseURL = flags.baseUrl ?? env['CODA_BASE_URL'] ?? file.baseURL ?? undefined;
  // anthropic 侧优先接受 ANTHROPIC_API_KEY;两 provider 都尊重 CODA_API_KEY 与 config 文件
  const apiKey =
    flags.apiKey ??
    env['CODA_API_KEY'] ??
    (isAnthropic ? env['ANTHROPIC_API_KEY'] : env['OPENAI_API_KEY']) ??
    (file.apiKeyEnv !== undefined ? env[file.apiKeyEnv] : file.apiKey) ??
    undefined;
  if (apiKey === undefined) {
    const keyVar = isAnthropic ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
    throw new Error(
      `未找到 API key:设置环境变量 ${keyVar}(或 CODA_API_KEY),` +
        '或在 ~/.coda/config.json 写入 { "apiKeyEnv": "MY_KEY_VAR" }',
    );
  }
  if (file.apiKey !== undefined) {
    console.error('[coda] warning: ~/.coda/config.json 中存在明文 apiKey,建议改用 apiKeyEnv');
  }
  return {
    provider,
    modelConfig: {
      ref: isAnthropic
        ? { provider: 'anthropic', api: 'anthropic-messages', model }
        : { provider: 'openai', api: 'openai-chat', model },
      baseURL,
      apiKey,
      compat: file.compat,
      defaults: file.defaults,
    },
  };
}
