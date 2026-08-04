// detectCompat 规则表单测(见 docs/04-provider-adapter.md)。
import { describe, expect, it } from 'bun:test';
import { detectCompat, resolveCompat } from './compat.js';

describe('detectCompat', () => {
  it('未设置 baseURL → OpenAI 官方全开 profile', () => {
    const p = detectCompat(undefined);
    expect(p).toMatchObject({
      maxTokensField: 'max_completion_tokens',
      supportsDeveloperRole: true,
      supportsUsageInStreaming: true,
      supportsStrictTools: true,
      supportsReasoning: true,
    });
  });

  it('api.openai.com → 全开 profile', () => {
    expect(detectCompat('https://api.openai.com/v1')).toEqual(detectCompat(undefined));
  });

  it('api.deepseek.com → max_tokens + reasoning 读取 + strict/developer 关', () => {
    const p = detectCompat('https://api.deepseek.com/v1');
    expect(p).toMatchObject({
      maxTokensField: 'max_tokens',
      supportsDeveloperRole: false,
      supportsStrictTools: false,
      supportsUsageInStreaming: true,
      supportsReasoning: true,
    });
  });

  it('openrouter.ai → reasoning 读取 + usage 开 + strict 关 + 视觉开', () => {
    const p = detectCompat('https://openrouter.ai/api/v1');
    expect(p).toMatchObject({
      supportsStrictTools: false,
      supportsUsageInStreaming: true,
      supportsImageParts: true,
      supportsReasoning: true,
    });
  });

  it('localhost / 未识别 host / 非法 URL → 保守 profile', () => {
    for (const url of ['http://localhost:8000/v1', 'https://some.gateway.example/v1', 'not a url']) {
      const p = detectCompat(url);
      expect(p).toMatchObject({
        maxTokensField: 'max_tokens',
        supportsDeveloperRole: false,
        supportsUsageInStreaming: false,
        supportsStrictTools: false,
        supportsImageParts: false,
        supportsTemperature: false,
        supportsReasoning: true,
      });
    }
  });
});

describe('resolveCompat(白名单收窄:垃圾值不得直达 wire)', () => {
  it('非法值与未知键被丢弃并告警,合法覆盖照常生效', () => {
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (msg: string) => { warnings.push(msg); };
    try {
      const p = resolveCompat({
        ref: { provider: 'x', api: 'openai-chat', model: 'm' },
        baseURL: 'https://some.gateway.example/v1',
        compat: {
          maxTokensField: 'max_output_tokens',        // typo:非法枚举 → 丢弃
          supportsImageParts: 'false',                // 字符串布尔 → 丢弃(不得当 truthy)
          supportsReasoning: null,                     // null → 丢弃
          reasoningFormat: 'none',                     // 已移除的名义方言 → 按未知键丢弃
          totallyUnknownKey: true,                    // 未知键 → 丢弃
          supportsUsageInStreaming: true,             // 合法 → 生效
        },
      });
      expect(p.maxTokensField).toBe('max_tokens');    // 保守值保留,typo 未直达 wire 参数键
      expect(p.supportsImageParts).toBe(false);
      expect(p.supportsReasoning).toBe(true);
      expect(p.supportsUsageInStreaming).toBe(true);
      expect(warnings).toHaveLength(5);
    } finally {
      console.warn = orig;
    }
  });

  it('方言子串不误命中:后缀匹配防伪装 host', () => {
    expect(detectCompat('https://api.deepseek.com.evil.example/v1').supportsUsageInStreaming).toBe(false);
    expect(detectCompat('https://myproxy.example/openrouter.ai/v1').supportsImageParts).toBe(false);
  });
});

describe('resolveCompat(model.compat 显式覆盖)', () => {
  it('开放袋字段浅覆盖推断结果;undefined 值不覆盖', () => {
    const p = resolveCompat({
      ref: { provider: 'x', api: 'openai-chat', model: 'm' },
      baseURL: 'https://some.gateway.example/v1',
      compat: { supportsImageParts: true, supportsUsageInStreaming: true, maxTokensField: undefined },
    });
    expect(p.supportsImageParts).toBe(true);        // 覆盖生效
    expect(p.supportsUsageInStreaming).toBe(true);
    expect(p.maxTokensField).toBe('max_tokens');    // undefined 不覆盖,保守值保留
    expect(p.supportsStrictTools).toBe(false);      // 未覆盖字段维持推断
  });
});
