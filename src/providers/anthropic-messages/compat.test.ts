// Anthropic endpoint/model compat profile 测试:模型级限制不得被 endpoint profile 粗暴覆盖。
import { describe, expect, it } from 'bun:test';
import { detectCompat, resolveCompat } from './compat.js';

function model(modelId: string, baseURL?: string) {
  return {
    ref: { provider: 'anthropic', api: 'anthropic-messages' as const, model: modelId },
    ...(baseURL !== undefined && { baseURL }),
  };
}

describe('Anthropic compat profile', () => {
  it('endpoint profile 默认保留 temperature 支持', () => {
    expect(detectCompat(undefined).supportsTemperature).toBe(true);
    expect(detectCompat('https://gateway.example.com/v1').supportsTemperature).toBe(true);
  });

  it('当前默认温度模型收窄 supportsTemperature,即使 compat 显式尝试放开', () => {
    const resolved = resolveCompat({
      ...model('claude-opus-5'),
      compat: { supportsTemperature: true },
    });
    expect(resolved.supportsTemperature).toBe(false);
  });

  it('兼容端点的未知/其它模型不被模型规则误伤', () => {
    const resolved = resolveCompat(model('minimax-m3', 'https://gateway.example.com/v1'));
    expect(resolved.supportsTemperature).toBe(true);
  });
});
