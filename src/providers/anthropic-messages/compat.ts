// Anthropic Messages 私有 compat 结构(见 docs/04-provider-adapter.md:CompatFlags 是各 adapter 的私有类型,
// 不复用 openai-chat 的定义)。当前只承载 max_tokens、thinking、视觉/温度开关；thinking 的
// 具体模式还要按官方 model id 判定，不能仅凭 endpoint 支持就把所有模型当成同一种方言。
// protocol 层的 ModelConfig.compat 是开放袋({ [key: string]: unknown }),在 resolveCompat 入口收窄。

import type { ModelConfig } from '../../protocol/index.js';

export interface AnthropicCompatFlags {
  defaultMaxTokens?: number;      // max_tokens 是 Anthropic 必填参数,缺省给此值
  supportsThinking?: boolean;     // endpoint 允许 thinking;具体 mode 仍按官方 model id 收窄
  thinkingBudgetTokens?: number;  // enabled 模式的 budget_tokens(须 ≥1024 且 < max_tokens)
  supportsImageParts?: boolean;   // user/tool_result 内可带 image block(Anthropic 原生支持,默认开)
  supportsTemperature?: boolean;  // endpoint 是否接受 temperature(模型限制在 resolveCompat 再收窄)
}

export type ResolvedAnthropicCompat = Required<AnthropicCompatFlags>;

/** Anthropic 官方端点:全开。 */
const OFFICIAL_PROFILE: ResolvedAnthropicCompat = {
  defaultMaxTokens: 4096,
  supportsThinking: true,
  thinkingBudgetTokens: 2048,
  supportsImageParts: true,
  supportsTemperature: true,
};

/** 未识别端点:保守 profile——thinking 关闭(第三方兼容网关见到即 400 的高发项),其余保守保留。 */
const CONSERVATIVE_PROFILE: ResolvedAnthropicCompat = {
  defaultMaxTokens: 4096,
  supportsThinking: false,
  thinkingBudgetTokens: 2048,
  supportsImageParts: true,   // Anthropic 兼容协议原生带图,读不到也无 400 风险
  supportsTemperature: true,
};

/** 推断规则表:数据驱动,新方言加一行(host 关键字 → profile 增量)。 */
const HOST_RULES: { match: string; profile: Partial<ResolvedAnthropicCompat> }[] = [];

// Anthropic 的 Messages API 目前同时存在两代 thinking 协议。这里使用 SDK 当前列出的
// 官方 model id 做保守 allowlist；未知 id 不发 thinking 字段，避免把 adaptive 或 enabled
// 猜测到不支持该模式的模型上。模型发现/能力查询不属于 adapter 的同步请求路径。
const ADAPTIVE_THINKING_MODELS: ReadonlySet<string> = new Set([
  'claude-fable-5',
  'claude-mythos-5',
  'claude-mythos-preview',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
]);

const ENABLED_THINKING_MODELS: ReadonlySet<string> = new Set([
  'claude-3-7-sonnet-latest',
  'claude-3-7-sonnet-20250219',
  'claude-opus-4-1',
  'claude-opus-4-1-20250805',
  'claude-opus-4',
  'claude-opus-4-0',
  'claude-opus-4-20250514',
  'claude-opus-4-5',
  'claude-opus-4-5-20251101',
  'claude-sonnet-4',
  'claude-sonnet-4-0',
  'claude-sonnet-4-20250514',
  'claude-sonnet-4-5',
  'claude-sonnet-4-5-20250929',
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
]);

const XHIGH_EFFORT_MODELS: ReadonlySet<string> = new Set([
  'claude-fable-5',
  'claude-mythos-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-sonnet-5',
]);

export type AnthropicThinkingMode = 'adaptive' | 'enabled' | 'unsupported';

export function thinkingModeForModel(model: string): AnthropicThinkingMode {
  if (ADAPTIVE_THINKING_MODELS.has(model)) return 'adaptive';
  if (ENABLED_THINKING_MODELS.has(model)) return 'enabled';
  return 'unsupported';
}

/** Claude Opus 4.5 is the one enabled-mode model that also accepts output_config.effort. */
export function supportsEffortWithEnabledThinking(model: string): boolean {
  return model === 'claude-opus-4-5' || model === 'claude-opus-4-5-20251101';
}

export function supportsEffortForModel(model: string, effort: string): boolean {
  const mode = thinkingModeForModel(model);
  if (mode === 'unsupported') return false;
  if (effort === 'xhigh') return XHIGH_EFFORT_MODELS.has(model);
  if (effort === 'max') return mode === 'adaptive';
  return mode === 'adaptive' || supportsEffortWithEnabledThinking(model);
}

// Claude Opus 4.7 及后续模型和 Mythos Preview 对非默认 sampling 参数返回 400。
// 这里只维护官方当前精确 model id；未知模型继续遵守 endpoint profile。
const DEFAULT_TEMPERATURE_ONLY_MODELS: ReadonlySet<string> = new Set([
  'claude-fable-5',
  'claude-mythos-5',
  'claude-mythos-preview',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-sonnet-5',
]);

export function isDefaultTemperatureOnlyModel(model: string): boolean {
  return DEFAULT_TEMPERATURE_ONLY_MODELS.has(model);
}

/**
 * 按 baseURL 推断完整 compat profile。未设置 baseURL 视为 Anthropic 官方端点;
 * 未识别 host 走保守 profile。
 */
export function detectCompat(baseURL: string | undefined): ResolvedAnthropicCompat {
  if (!baseURL) return { ...OFFICIAL_PROFILE };
  let host: string;
  try {
    host = new URL(baseURL).host;
  } catch {
    return { ...CONSERVATIVE_PROFILE };
  }
  if (host === 'api.anthropic.com') return { ...OFFICIAL_PROFILE };
  for (const rule of HOST_RULES) {
    // 只做 host 精确/后缀匹配:子串匹配会被 api.anthropic.com.evil.example 误命中
    if (host === rule.match || host.endsWith(`.${rule.match}`)) {
      return { ...CONSERVATIVE_PROFILE, ...rule.profile };
    }
  }
  return { ...CONSERVATIVE_PROFILE };
}

// 开放袋收窄的白名单:已知键 → 合法值校验器。非法值/未知键丢弃并 warn,
// 配置 typo 不得静默变成运行时协议错误。
const FLAG_VALIDATORS: Record<keyof AnthropicCompatFlags, (v: unknown) => boolean> = {
  defaultMaxTokens: isPositiveInt,
  supportsThinking: isBoolean,
  thinkingBudgetTokens: isPositiveInt,
  supportsImageParts: isBoolean,
  supportsTemperature: isBoolean,
};

function isBoolean(v: unknown): boolean {
  return typeof v === 'boolean';
}

function isPositiveInt(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/** detectCompat 推断 + model.compat 显式字段浅覆盖(白名单收窄,见上)。 */
export function resolveCompat(model: ModelConfig): ResolvedAnthropicCompat {
  const overrides: Partial<ResolvedAnthropicCompat> = {};
  const bag = model.compat ?? {};
  for (const [key, value] of Object.entries(bag)) {
    if (value === undefined) continue;
    const validator = FLAG_VALIDATORS[key as keyof AnthropicCompatFlags];
    if (validator === undefined) {
      console.warn(`[anthropic-messages] unknown compat key '${key}' ignored`);
      continue;
    }
    if (!validator(value)) {
      console.warn(`[anthropic-messages] invalid compat value for '${key}' (${JSON.stringify(value)}) ignored`);
      continue;
    }
    (overrides as Record<string, unknown>)[key] = value;
  }
  const resolved = { ...detectCompat(model.baseURL), ...overrides };
  return isDefaultTemperatureOnlyModel(model.ref.model)
    ? { ...resolved, supportsTemperature: false }
    : resolved;
}
