// Provider 产品动作的单一语义来源。CLI 子命令与各交互面只负责收集输入和展示；
// 内建 preset 以及 model 切换/最近选择持久化的顺序在此执行。

import type { ModelConfig } from '../protocol/index.js';
import { AUTH_PRESET_SPECS } from './command-catalog.js';
import type { InteractiveSession } from './interactive-runtime.js';
import type { ConfigureProviderResult } from './provider-registry.js';
import { ProviderRegistry } from './provider-registry.js';

export type BuiltInAuthPreset = 'opencode-go' | 'openai' | 'anthropic';

export interface ApplyProviderModelResult {
  readonly persistenceError?: unknown;
}

export async function applyProviderModelSelection(
  runtime: Pick<InteractiveSession, 'setModel'>,
  registry: ProviderRegistry,
  config: ModelConfig,
): Promise<ApplyProviderModelResult> {
  await runtime.setModel(config);
  try {
    registry.rememberSelection(config.ref.provider, config.ref.model);
    return {};
  } catch (persistenceError) {
    return { persistenceError };
  }
}

export function configureBuiltInProvider(
  registry: ProviderRegistry,
  presetId: BuiltInAuthPreset,
  apiKey: string,
  signal?: AbortSignal,
): Promise<ConfigureProviderResult> {
  if (presetId === 'opencode-go') {
    return registry.configureOpenCodeGo(apiKey, signal);
  }
  const preset = AUTH_PRESET_SPECS.find((candidate) => candidate.id === presetId);
  if (preset === undefined || !('baseURL' in preset) || !('api' in preset)) {
    return Promise.reject(new Error(`provider preset is invalid: ${presetId}`));
  }
  return registry.configureCustom(
    preset.label,
    preset.baseURL,
    apiKey,
    preset.api,
    signal,
  );
}
