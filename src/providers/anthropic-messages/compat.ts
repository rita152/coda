// Anthropic Messages 私有 compat 结构(docs/04 §8 第 3 点:CompatFlags 是各 adapter 的私有类型,
// 不复用 openai-chat 的定义)。v1 保持最小:max_tokens 必填缺省、thinking 开关、视觉/温度开关。
// protocol 层的 ModelConfig.compat 是开放袋({ [key: string]: unknown }),在 resolveCompat 入口收窄。

import type { ModelConfig } from '../../protocol/index.js';

export interface AnthropicCompatFlags {
  defaultMaxTokens?: number;      // max_tokens 是 Anthropic 必填参数,缺省给此值
  supportsThinking?: boolean;     // true:reasoningEffort 存在时发 thinking 配置(第三方兼容端点大多不认)
  thinkingBudgetTokens?: number;  // thinking 开启时的 budget_tokens(须 ≥1024 且 < max_tokens)
  supportsImageParts?: boolean;   // user/tool_result 内可带 image block(Anthropic 原生支持,默认开)
  supportsTemperature?: boolean;  // 是否透传 temperature(thinking 开启时一律不发)
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
  return { ...detectCompat(model.baseURL), ...overrides };
}
