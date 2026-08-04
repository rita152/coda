// CompatFlags:方言差异声明化为数据(规格见 docs/04-provider-adapter.md)。
// 本接口是 openai-chat 的私有精确类型;protocol 层的 ModelConfig.compat 是开放袋
// ({ [key: string]: unknown }),在 resolveCompat 入口处收窄。
// 蓝本:pi-mono 的 OpenAICompletionsCompat。

import type { ModelConfig } from '../../protocol/index.js';

export interface CompatFlags {
  maxTokensField?: 'max_completion_tokens' | 'max_tokens';  // max_tokens 已 deprecated 且与 o 系列不兼容
  supportsDeveloperRole?: boolean;          // true:systemPrompt 渲染为 developer(第三方大多只认 system)
  supportsUsageInStreaming?: boolean;       // true:发 stream_options:{include_usage:true}(有的端点见到即 400)
  supportsStrictTools?: boolean;            // true:工具 schema 附 strict:true(需子集清洗,见 convert.ts)
  supportsImageParts?: boolean;             // user content 可带 image_url part(视觉能力)
  supportsTemperature?: boolean;            // o 系列为 false(400 防线)
  supportsReasoningEffort?: boolean;        // 是否透传 reasoning_effort
  supportsReasoning?: boolean;              // 是否读取已知的 reasoning 扩展字段
  requiresToolResultName?: boolean;         // tool 消息须附 name 字段(个别方言)
  requiresAssistantAfterToolResult?: boolean; // tool 结果后必须跟 assistant 消息(插合成占位)
}

export type ResolvedCompat = Required<CompatFlags>;

/** OpenAI 官方端点:全开。 */
const OPENAI_PROFILE: ResolvedCompat = {
  maxTokensField: 'max_completion_tokens',
  supportsDeveloperRole: true,
  supportsUsageInStreaming: true,
  supportsStrictTools: true,
  supportsImageParts: true,
  supportsTemperature: true,
  supportsReasoningEffort: true,
  supportsReasoning: true,
  requiresToolResultName: false,
  requiresAssistantAfterToolResult: false,
};

/** 未识别端点:保守 profile——未知参数有的端点忽略、有的 400,宁可少发。 */
const CONSERVATIVE_PROFILE: ResolvedCompat = {
  maxTokensField: 'max_tokens',
  supportsDeveloperRole: false,
  supportsUsageInStreaming: false,
  supportsStrictTools: false,
  supportsImageParts: false,
  supportsTemperature: false,
  supportsReasoningEffort: false,
  supportsReasoning: true,                 // 只影响入站读取,读不到即忽略,无 400 风险
  requiresToolResultName: false,
  requiresAssistantAfterToolResult: false,
};

/** 推断规则表:数据驱动,新方言加一行(host 关键字 → profile 增量)。 */
const HOST_RULES: { match: string; profile: Partial<ResolvedCompat> }[] = [
  {
    match: 'api.deepseek.com',
    profile: {
      maxTokensField: 'max_tokens',
      supportsDeveloperRole: false,
      supportsStrictTools: false,
      supportsUsageInStreaming: true,
      supportsTemperature: true,
    },
  },
  {
    match: 'openrouter.ai',
    profile: {
      maxTokensField: 'max_tokens',
      supportsDeveloperRole: false,
      supportsStrictTools: false,
      supportsUsageInStreaming: true,
      supportsImageParts: true,
      supportsTemperature: true,
    },
  },
];

/**
 * 按 baseURL 推断完整 compat profile。未设置 baseURL 视为 OpenAI 官方端点;
 * 未识别 host 走保守 profile。
 */
export function detectCompat(baseURL: string | undefined): ResolvedCompat {
  if (!baseURL) return { ...OPENAI_PROFILE };
  let host: string;
  try {
    host = new URL(baseURL).host;
  } catch {
    return { ...CONSERVATIVE_PROFILE };
  }
  if (host === 'api.openai.com') return { ...OPENAI_PROFILE };
  for (const rule of HOST_RULES) {
    // 只做 host 精确/后缀匹配:子串匹配会被 api.deepseek.com.evil.example 或
    // 路径里的关键字误命中,给未知端点发激进参数(违背保守原则)
    if (host === rule.match || host.endsWith(`.${rule.match}`)) {
      return { ...CONSERVATIVE_PROFILE, ...rule.profile };
    }
  }
  return { ...CONSERVATIVE_PROFILE };
}

// 开放袋收窄的白名单:已知键 → 合法值校验器。非法值/未知键丢弃并 warn,
// 配置 typo 不得静默变成运行时协议错误(如 maxTokensField 拼错直达 wire 参数键)。
const FLAG_VALIDATORS: Record<keyof CompatFlags, (v: unknown) => boolean> = {
  maxTokensField: (v) => v === 'max_completion_tokens' || v === 'max_tokens',
  supportsDeveloperRole: isBoolean,
  supportsUsageInStreaming: isBoolean,
  supportsStrictTools: isBoolean,
  supportsImageParts: isBoolean,
  supportsTemperature: isBoolean,
  supportsReasoningEffort: isBoolean,
  supportsReasoning: isBoolean,
  requiresToolResultName: isBoolean,
  requiresAssistantAfterToolResult: isBoolean,
};

function isBoolean(v: unknown): boolean {
  return typeof v === 'boolean';
}

/** detectCompat 推断 + model.compat 显式字段浅覆盖(白名单收窄,见上)。 */
export function resolveCompat(model: ModelConfig): ResolvedCompat {
  const overrides: Partial<ResolvedCompat> = {};
  const bag = model.compat ?? {};
  for (const [key, value] of Object.entries(bag)) {
    if (value === undefined) continue;
    const validator = FLAG_VALIDATORS[key as keyof CompatFlags];
    if (validator === undefined) {
      console.warn(`[openai-chat] unknown compat key '${key}' ignored`);
      continue;
    }
    if (!validator(value)) {
      console.warn(`[openai-chat] invalid compat value for '${key}' (${JSON.stringify(value)}) ignored`);
      continue;
    }
    (overrides as Record<string, unknown>)[key] = value;
  }
  return { ...detectCompat(model.baseURL), ...overrides };
}
