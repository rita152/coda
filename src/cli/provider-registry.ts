// CLI provider 注册表：持久化非秘密 provider 配置与模型缓存，并把 API key 隔离到
// 独立的 0600 凭据文件。模型发现只接受三个既有 adapter 的协议；OpenCode Go 的
// model→api 以官方 endpoint 目录为权威，实时 /models 只决定当前可用集合。

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { ModelApi, ModelConfig } from '../protocol/index.js';
import { runtimeHomeDir } from '../shared/index.js';

export const OPENCODE_GO_ID = 'opencode-go';
export const OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go/v1';

export type ConfigurableModelApi =
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic-messages';

export interface CachedProviderModel {
  id: string;
  api: ConfigurableModelApi;
}

export interface StoredProvider {
  id: string;
  name: string;
  kind: 'opencode-go' | 'custom';
  baseURL: string;
  /** Custom provider 的固定协议；OpenCode Go 按 model 显式映射，不设置此字段。 */
  api?: ConfigurableModelApi;
  models: CachedProviderModel[];
  refreshedAt?: number;
  /** 每次 /login 变更，用于丢弃较早请求迟到的模型刷新结果。 */
  revision?: string;
}

export interface ProviderSelection {
  providerId: string;
  model: string;
}

interface ProviderConfigData {
  version: 1;
  providers: StoredProvider[];
  selected?: ProviderSelection;
}

interface CredentialData {
  version: 1;
  apiKeys: Record<string, string>;
}

export interface AvailableProviderModel {
  providerId: string;
  providerName: string;
  model: string;
  api: ConfigurableModelApi;
  ref: string;
}

export type ProviderRefreshResult =
  | {
      ok: true;
      providerId: string;
      models: CachedProviderModel[];
      ignoredUnknownModelIds: string[];
    }
  | {
      ok: false;
      providerId: string;
      error: string;
    };

export interface ConfigureProviderResult {
  provider: StoredProvider;
  refresh: ProviderRefreshResult;
}

export interface ProviderCredentialInfo {
  providerId: string;
  providerName: string;
}

export interface ProviderRegistryOptions {
  configPath?: string;
  credentialsPath?: string;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  refreshTimeoutMs?: number;
}

interface OpenCodeGoModelMetadata {
  api: ConfigurableModelApi;
  limits: Readonly<{ context: number; output: number }>;
}

/**
 * OpenCode Go 的协议来自官方 endpoint 目录，limits 来自 OpenCode 自身使用的
 * models.dev provider 目录。实时 /models 只返回 id，故必须与本表求交；这里不做
 * 任何模型名前缀推断，也不把表外模型暴露给用户。
 */
export const OPENCODE_GO_MODELS: Readonly<
  Record<string, OpenCodeGoModelMetadata>
> = {
  'grok-4.5': {
    api: 'openai-chat',
    limits: { context: 500_000, output: 500_000 },
  },
  'glm-5.2': {
    api: 'openai-chat',
    limits: { context: 1_000_000, output: 131_072 },
  },
  'glm-5.1': {
    api: 'openai-chat',
    limits: { context: 202_752, output: 32_768 },
  },
  'kimi-k3': {
    api: 'openai-chat',
    limits: { context: 1_048_576, output: 131_072 },
  },
  'kimi-k2.7-code': {
    api: 'openai-chat',
    limits: { context: 262_144, output: 262_144 },
  },
  'kimi-k2.6': {
    api: 'openai-chat',
    limits: { context: 262_144, output: 65_536 },
  },
  'deepseek-v4-pro': {
    api: 'openai-chat',
    limits: { context: 1_000_000, output: 384_000 },
  },
  'deepseek-v4-flash': {
    api: 'openai-chat',
    limits: { context: 1_000_000, output: 384_000 },
  },
  'mimo-v2.5': {
    api: 'openai-chat',
    limits: { context: 1_000_000, output: 128_000 },
  },
  'mimo-v2.5-pro': {
    api: 'openai-chat',
    limits: { context: 1_048_576, output: 128_000 },
  },
  'minimax-m3': {
    api: 'anthropic-messages',
    limits: { context: 1_000_000, output: 131_072 },
  },
  'minimax-m2.7': {
    api: 'anthropic-messages',
    limits: { context: 204_800, output: 131_072 },
  },
  'minimax-m2.5': {
    api: 'anthropic-messages',
    limits: { context: 204_800, output: 65_536 },
  },
  'qwen3.7-max': {
    api: 'anthropic-messages',
    limits: { context: 1_000_000, output: 65_536 },
  },
  'qwen3.7-plus': {
    api: 'anthropic-messages',
    limits: { context: 1_000_000, output: 65_536 },
  },
  'qwen3.6-plus': {
    api: 'anthropic-messages',
    limits: { context: 1_000_000, output: 65_536 },
  },
  hy3: {
    api: 'openai-chat',
    limits: { context: 256_000, output: 64_000 },
  },
};

const EMPTY_CONFIG: ProviderConfigData = { version: 1, providers: [] };
const EMPTY_CREDENTIALS: CredentialData = { version: 1, apiKeys: {} };

export class ProviderRegistry {
  readonly configPath: string;
  readonly credentialsPath: string;

  readonly #fetch: NonNullable<ProviderRegistryOptions['fetch']>;
  readonly #now: () => number;
  readonly #refreshTimeoutMs: number;
  #config: ProviderConfigData;
  #credentials: CredentialData;

  constructor(options: ProviderRegistryOptions = {}) {
    const codaDir = path.join(runtimeHomeDir(), '.coda');
    this.configPath = options.configPath ?? path.join(codaDir, 'providers.json');
    this.credentialsPath = options.credentialsPath ?? path.join(codaDir, 'credentials.json');
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? Date.now;
    this.#refreshTimeoutMs = options.refreshTimeoutMs ?? 15_000;
    this.#config = readProviderConfig(this.configPath);
    this.#credentials = readCredentials(this.credentialsPath);
  }

  listProviders(): StoredProvider[] {
    return this.#config.providers.map(cloneProvider);
  }

  listConfiguredProviders(): StoredProvider[] {
    return this.#config.providers
      .filter((provider) => this.#apiKey(provider.id) !== undefined)
      .map(cloneProvider);
  }

  listCredentials(): ProviderCredentialInfo[] {
    return Object.keys(this.#credentials.apiKeys)
      .filter((providerId) => this.#apiKey(providerId) !== undefined)
      .map((providerId) => {
        const provider = this.#findProvider(providerId);
        return {
          providerId,
          providerName: provider?.name ?? providerId,
        };
      })
      .sort((a, b) => a.providerName.localeCompare(b.providerName));
  }

  availableModels(): AvailableProviderModel[] {
    const out: AvailableProviderModel[] = [];
    for (const provider of this.#config.providers) {
      if (this.#apiKey(provider.id) === undefined) continue;
      for (const cached of provider.models) {
        const api =
          provider.kind === 'opencode-go'
            ? OPENCODE_GO_MODELS[cached.id]?.api
            : provider.api;
        if (api === undefined || api !== cached.api) continue;
        out.push({
          providerId: provider.id,
          providerName: provider.name,
          model: cached.id,
          api,
          ref: `${provider.id}/${cached.id}`,
        });
      }
    }
    return out;
  }

  selectedModel(): ProviderSelection | undefined {
    const selected = this.#config.selected;
    if (selected === undefined) return undefined;
    return this.availableModels().some(
      (model) =>
        model.providerId === selected.providerId &&
        model.model === selected.model,
    )
      ? { ...selected }
      : undefined;
  }

  resolveSelectedModel(): ModelConfig | undefined {
    const selected = this.selectedModel();
    return selected === undefined
      ? undefined
      : this.resolveModel(selected.providerId, selected.model);
  }

  resolveModel(providerId: string, modelId: string): ModelConfig | undefined {
    const provider = this.#findProvider(providerId);
    const apiKey = this.#apiKey(providerId);
    if (provider === undefined || apiKey === undefined) return undefined;
    const cached = provider.models.find((model) => model.id === modelId);
    if (cached === undefined) return undefined;
    const metadata =
      provider.kind === 'opencode-go'
        ? OPENCODE_GO_MODELS[modelId]
        : undefined;
    const api =
      provider.kind === 'opencode-go'
        ? metadata?.api
        : provider.api;
    if (api === undefined || cached.api !== api) return undefined;
    return {
      ref: { provider: provider.id, api, model: modelId },
      baseURL: provider.baseURL,
      apiKey,
      ...(metadata !== undefined && {
        limits: { ...metadata.limits },
      }),
    };
  }

  rememberSelection(providerId: string, model: string): void {
    if (this.resolveModel(providerId, model) === undefined) {
      throw new Error(`模型不可用: ${providerId}/${model}`);
    }
    this.#writeConfig((config) => ({
      ...config,
      selected: { providerId, model },
    }));
  }

  clearSelection(): void {
    this.#writeConfig((config) => ({
      version: 1,
      providers: config.providers,
    }));
  }

  async configureOpenCodeGo(
    apiKey: string,
    signal?: AbortSignal,
  ): Promise<ConfigureProviderResult> {
    const normalizedKey = requireApiKey(apiKey);
    const previous = this.#findProvider(OPENCODE_GO_ID);
    const provider: StoredProvider = {
      id: OPENCODE_GO_ID,
      name: 'OpenCode Go',
      kind: 'opencode-go',
      baseURL: OPENCODE_GO_BASE_URL,
      revision: crypto.randomUUID(),
      models:
        previous?.kind === 'opencode-go' &&
        previous.baseURL === OPENCODE_GO_BASE_URL
          ? previous.models
          : [],
      ...(previous?.refreshedAt !== undefined && {
        refreshedAt: previous.refreshedAt,
      }),
    };
    this.#upsertProvider(provider);
    this.#setApiKey(provider.id, normalizedKey);
    const refresh = await this.refreshProvider(provider.id, signal);
    return {
      provider: cloneProvider(this.#findProvider(provider.id) ?? provider),
      refresh,
    };
  }

  async configureCustom(
    name: string,
    baseURL: string,
    apiKey: string,
    api: ConfigurableModelApi,
    signal?: AbortSignal,
  ): Promise<ConfigureProviderResult> {
    const normalizedName = normalizeProviderName(name);
    const id = customProviderId(normalizedName);
    const normalizedBaseURL = normalizeBaseURL(baseURL);
    const normalizedKey = requireApiKey(apiKey);
    const previous = this.#findProvider(id);
    const sameEndpoint =
      previous?.kind === 'custom' &&
      previous.baseURL === normalizedBaseURL &&
      previous.api === api;
    const provider: StoredProvider = {
      id,
      name: normalizedName,
      kind: 'custom',
      baseURL: normalizedBaseURL,
      api,
      revision: crypto.randomUUID(),
      models: sameEndpoint ? previous.models : [],
      ...(sameEndpoint &&
        previous.refreshedAt !== undefined && {
          refreshedAt: previous.refreshedAt,
        }),
    };
    this.#upsertProvider(provider);
    this.#setApiKey(provider.id, normalizedKey);
    const refresh = await this.refreshProvider(provider.id, signal);
    return {
      provider: cloneProvider(this.#findProvider(provider.id) ?? provider),
      refresh,
    };
  }

  async refreshProvider(
    providerId: string,
    signal?: AbortSignal,
  ): Promise<ProviderRefreshResult> {
    const provider = this.#findProvider(providerId);
    const apiKey = this.#apiKey(providerId);
    if (provider === undefined) {
      return { ok: false, providerId, error: `provider 未配置: ${providerId}` };
    }
    if (apiKey === undefined) {
      return {
        ok: false,
        providerId,
        error: `provider ${provider.name} 没有已保存的 API key；请重新运行 /login`,
      };
    }

    let url: string;
    try {
      url = modelsEndpoint(
        provider.baseURL,
        provider.kind === 'custom' ? provider.api : undefined,
      );
    } catch {
      return {
        ok: false,
        providerId,
        error:
          `provider ${provider.name} 的 base URL 无效；重新运行 /login 更新配置。` +
          'provider 配置和 API key 已保留',
      };
    }
    let response: Response;
    try {
      // Header 构造也可能因非 ByteString 输入抛错；与 fetch 异常一样收敛为静态错误，
      // 绝不让平台错误把 header value（API key）带回 UI/日志。
      const headers = new Headers();
      if (provider.kind === 'opencode-go' || provider.api !== 'anthropic-messages') {
        headers.set('Authorization', `Bearer ${apiKey}`);
      } else {
        headers.set('x-api-key', apiKey);
        headers.set('anthropic-version', '2023-06-01');
      }
      const timeout = AbortSignal.timeout(this.#refreshTimeoutMs);
      response = await this.#fetch(url, {
        method: 'GET',
        headers,
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      });
    } catch {
      return {
        ok: false,
        providerId,
        error:
          `无法连接 ${url}；检查网络与 base URL 后重新运行 /login。` +
          'provider 配置和 API key 已保留',
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        providerId,
        error:
          `${url} 返回 HTTP ${response.status}；检查 API key、base URL 和协议后重新运行 /login。` +
          'provider 配置和 API key 已保留',
      };
    }

    let ids: string[];
    try {
      ids = modelIdsFromPayload(await response.json());
    } catch {
      return {
        ok: false,
        providerId,
        error:
          `${url} 返回的 models JSON 不符合标准 { data: [{ id }] }；` +
          '修正 endpoint 后重新运行 /login。provider 配置和 API key 已保留',
      };
    }

    const ignoredUnknownModelIds: string[] = [];
    const models: CachedProviderModel[] = [];
    for (const id of ids) {
      const api =
        provider.kind === 'opencode-go'
          ? OPENCODE_GO_MODELS[id]?.api
          : provider.api;
      if (api === undefined) {
        ignoredUnknownModelIds.push(id);
        continue;
      }
      models.push({ id, api });
    }

    const updated: StoredProvider = {
      ...provider,
      models,
      refreshedAt: this.#now(),
    };
    if (!this.#upsertProvider(updated, provider)) {
      return {
        ok: false,
        providerId,
        error:
          `provider ${provider.name} 已被另一项登录更新；` +
          '已忽略过期的模型刷新结果，请重新运行 /login',
      };
    }
    return {
      ok: true,
      providerId,
      models: models.map((model) => ({ ...model })),
      ignoredUnknownModelIds,
    };
  }

  logout(providerId: string): boolean {
    let removed = false;
    this.#writeCredentials((credentials) => {
      const apiKeys = { ...credentials.apiKeys };
      removed = this.#apiKeyFrom(credentials, providerId) !== undefined;
      delete apiKeys[providerId];
      return { version: 1, apiKeys };
    });
    if (!removed) return false;
    const revision = crypto.randomUUID();
    this.#writeConfig((config) => ({
      version: 1,
      providers: config.providers.map((provider) =>
        provider.id === providerId
          ? { ...provider, revision }
          : provider,
      ),
      ...(config.selected?.providerId !== providerId &&
        config.selected !== undefined && { selected: config.selected }),
    }));
    return removed;
  }

  #findProvider(providerId: string): StoredProvider | undefined {
    return this.#config.providers.find((provider) => provider.id === providerId);
  }

  #apiKey(providerId: string): string | undefined {
    return this.#apiKeyFrom(this.#credentials, providerId);
  }

  #apiKeyFrom(
    credentials: CredentialData,
    providerId: string,
  ): string | undefined {
    const value = credentials.apiKeys[providerId]?.trim();
    return value === undefined || value === '' ? undefined : value;
  }

  #upsertProvider(
    provider: StoredProvider,
    expected?: StoredProvider,
  ): boolean {
    let applied = false;
    this.#writeConfig((config) => {
      if (
        expected !== undefined &&
        !sameProviderRevision(
          config.providers.find((candidate) => candidate.id === provider.id),
          expected,
        )
      ) {
        return config;
      }
      const providers = config.providers.filter(
        (candidate) => candidate.id !== provider.id,
      );
      providers.push(cloneProvider(provider));
      providers.sort((a, b) => a.name.localeCompare(b.name));
      const selected = config.selected;
      const keepSelection =
        selected === undefined ||
        selected.providerId !== provider.id ||
        provider.models.some((model) => {
          if (model.id !== selected.model) return false;
          const api =
            provider.kind === 'opencode-go'
              ? OPENCODE_GO_MODELS[model.id]?.api
              : provider.api;
          return api !== undefined && model.api === api;
        });
      applied = true;
      return {
        version: 1,
        providers,
        ...(keepSelection && selected !== undefined && { selected }),
      };
    });
    return applied;
  }

  #setApiKey(providerId: string, apiKey: string): void {
    this.#writeCredentials((credentials) => ({
      version: 1,
      apiKeys: { ...credentials.apiKeys, [providerId]: apiKey },
    }));
  }

  #writeConfig(
    update: (config: ProviderConfigData) => ProviderConfigData,
  ): void {
    this.#config = lockedUpdateJson(
      this.configPath,
      readProviderConfig,
      update,
    );
  }

  #writeCredentials(
    update: (credentials: CredentialData) => CredentialData,
  ): void {
    this.#credentials = lockedUpdateJson(
      this.credentialsPath,
      readCredentials,
      update,
    );
  }
}

export function customProviderId(name: string): string {
  const canonical = canonicalProviderName(name);
  if (canonical === '') throw new Error('provider name 不能为空');
  return `custom:${encodeURIComponent(canonical)}`;
}

export function normalizeBaseURL(input: string): string {
  const trimmed = input.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('base URL 无效；请输入完整的 http:// 或 https:// URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('base URL 仅支持 http:// 或 https://');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('base URL 不得包含用户名或密码');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error('base URL 不得包含 query 或 fragment');
  }
  return url.toString().replace(/\/+$/u, '');
}

export function modelsEndpoint(
  baseURL: string,
  api?: ConfigurableModelApi,
): string {
  const normalized = normalizeBaseURL(baseURL);
  if (api === 'anthropic-messages' && !/\/v1$/u.test(new URL(normalized).pathname)) {
    return `${normalized}/v1/models`;
  }
  return `${normalized}/models`;
}

function normalizeProviderName(name: string): string {
  const normalized = name.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (normalized === '') throw new Error('provider name 不能为空');
  if (normalized.length > 128) throw new Error('provider name 最长为 128 个字符');
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) {
    throw new Error('provider name 不得包含控制字符');
  }
  return normalized;
}

function canonicalProviderName(name: string): string {
  return normalizeProviderName(name).toLocaleLowerCase('en-US');
}

function requireApiKey(apiKey: string): string {
  const normalized = apiKey.trim();
  if (normalized === '') throw new Error('API key 不能为空');
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) {
    throw new Error('API key 不得包含控制字符或换行');
  }
  return normalized;
}

function modelIdsFromPayload(payload: unknown): string[] {
  if (!isRecord(payload) || !Array.isArray(payload['data'])) {
    throw new Error('invalid models payload');
  }
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of payload['data']) {
    if (!isRecord(item) || typeof item['id'] !== 'string') {
      throw new Error('invalid model entry');
    }
    const id = item['id'].trim();
    if (id === '' || seen.has(id)) continue;
    if (
      id.length > 512 ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(id)
    ) {
      throw new Error('invalid model id');
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function readProviderConfig(file: string): ProviderConfigData {
  if (!existsSync(file)) return { ...EMPTY_CONFIG, providers: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`provider 配置文件损坏: ${file}`);
  }
  if (!isRecord(parsed) || parsed['version'] !== 1 || !Array.isArray(parsed['providers'])) {
    throw new Error(`provider 配置文件版本或结构无效: ${file}`);
  }
  const providers = parsed['providers'].map((value) => parseStoredProvider(value, file));
  const ids = new Set<string>();
  for (const provider of providers) {
    if (ids.has(provider.id)) throw new Error(`provider 配置包含重复 id: ${file}`);
    ids.add(provider.id);
  }
  const selected = parseSelection(parsed['selected'], file);
  return {
    version: 1,
    providers,
    ...(selected !== undefined && { selected }),
  };
}

function readCredentials(file: string): CredentialData {
  if (!existsSync(file)) return { ...EMPTY_CREDENTIALS, apiKeys: {} };
  // 即使文件由旧版本/手工创建，也在读取时收紧权限；不得相信既有 mode。
  if (lstatSync(file).isSymbolicLink()) {
    throw new Error(`拒绝读取符号链接 API key 凭据文件: ${file}`);
  }
  chmodSync(file, 0o600);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`API key 凭据文件损坏: ${file}`);
  }
  if (!isRecord(parsed) || parsed['version'] !== 1 || !isRecord(parsed['apiKeys'])) {
    throw new Error(`API key 凭据文件版本或结构无效: ${file}`);
  }
  const apiKeys: Record<string, string> = {};
  for (const [providerId, value] of Object.entries(parsed['apiKeys'])) {
    if (typeof value !== 'string' || !isStoredProviderId(providerId)) {
      throw new Error(`API key 凭据文件包含无效记录: ${file}`);
    }
    apiKeys[providerId] = value;
  }
  return { version: 1, apiKeys };
}

function parseStoredProvider(value: unknown, file: string): StoredProvider {
  if (
    !isRecord(value) ||
    typeof value['id'] !== 'string' ||
    typeof value['name'] !== 'string' ||
    (value['kind'] !== 'opencode-go' && value['kind'] !== 'custom') ||
    typeof value['baseURL'] !== 'string' ||
    !Array.isArray(value['models'])
  ) {
    throw new Error(`provider 配置包含无效记录: ${file}`);
  }
  const api = value['api'];
  if (api !== undefined && !isConfigurableApi(api)) {
    throw new Error(`provider 配置包含未知协议: ${file}`);
  }
  if (value['kind'] === 'custom' && api === undefined) {
    throw new Error(`custom provider 缺少协议: ${file}`);
  }
  if (value['kind'] === 'opencode-go' && api !== undefined) {
    throw new Error(`OpenCode Go 不得设置单一协议: ${file}`);
  }
  const models = value['models'].map((model) => parseCachedModel(model, file));
  const refreshedAt = value['refreshedAt'];
  if (
    refreshedAt !== undefined &&
    (typeof refreshedAt !== 'number' || !Number.isFinite(refreshedAt))
  ) {
    throw new Error(`provider 配置包含无效刷新时间: ${file}`);
  }
  const revision = value['revision'];
  if (
    revision !== undefined &&
    (typeof revision !== 'string' ||
      revision === '' ||
      revision.length > 128 ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(revision))
  ) {
    throw new Error(`provider 配置包含无效 revision: ${file}`);
  }
  const name = parseStoredProviderName(value['name'], file);
  if (
    (value['kind'] === 'opencode-go' &&
      (value['id'] !== OPENCODE_GO_ID ||
        value['baseURL'] !== OPENCODE_GO_BASE_URL)) ||
    (value['kind'] === 'custom' &&
      value['id'] !== customProviderId(name))
  ) {
    throw new Error(`provider 配置包含不一致的 id 或固定 endpoint: ${file}`);
  }
  return {
    id: value['id'],
    name,
    kind: value['kind'],
    baseURL: parseStoredBaseURL(value['baseURL'], file),
    ...(api !== undefined && { api }),
    models,
    ...(refreshedAt !== undefined && { refreshedAt }),
    ...(revision !== undefined && { revision }),
  };
}

function parseCachedModel(value: unknown, file: string): CachedProviderModel {
  if (
    !isRecord(value) ||
    typeof value['id'] !== 'string' ||
    !isConfigurableApi(value['api'])
  ) {
    throw new Error(`provider 配置包含无效模型缓存: ${file}`);
  }
  if (
    value['id'].trim() === '' ||
    value['id'].length > 512 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value['id'])
  ) {
    throw new Error(`provider 配置包含无效模型 id: ${file}`);
  }
  return { id: value['id'], api: value['api'] };
}

function parseSelection(value: unknown, file: string): ProviderSelection | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    typeof value['providerId'] !== 'string' ||
    typeof value['model'] !== 'string'
  ) {
    throw new Error(`provider 配置包含无效模型选择: ${file}`);
  }
  return { providerId: value['providerId'], model: value['model'] };
}

function parseStoredBaseURL(value: string, file: string): string {
  try {
    return normalizeBaseURL(value);
  } catch {
    throw new Error(`provider 配置包含无效 base URL: ${file}`);
  }
}

function parseStoredProviderName(value: string, file: string): string {
  try {
    return normalizeProviderName(value);
  } catch {
    throw new Error(`provider 配置包含无效名称: ${file}`);
  }
}

function isStoredProviderId(value: string): boolean {
  return value === OPENCODE_GO_ID || /^custom:[^\u0000-\u0020\u007f-\u009f]+$/u.test(value);
}

function isConfigurableApi(value: unknown): value is ConfigurableModelApi {
  return (
    value === 'openai-chat' ||
    value === 'openai-responses' ||
    value === 'anthropic-messages'
  );
}

function cloneProvider(provider: StoredProvider): StoredProvider {
  return {
    ...provider,
    models: provider.models.map((model) => ({ ...model })),
  };
}

function sameProviderRevision(
  current: StoredProvider | undefined,
  expected: StoredProvider,
): boolean {
  return (
    current !== undefined &&
    current.id === expected.id &&
    current.name === expected.name &&
    current.kind === expected.kind &&
    current.baseURL === expected.baseURL &&
    current.api === expected.api &&
    current.revision === expected.revision
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function lockedUpdateJson<T>(
  file: string,
  read: (file: string) => T,
  update: (value: T) => T,
): T {
  return withFileLock(file, () => {
    const current = read(file);
    const value = update(current);
    if (value !== current) atomicWriteJson(file, value);
    return value;
  });
}

function withFileLock<T>(file: string, action: () => T): T {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const lock = `${file}.lock`;
  const deadline = Date.now() + 5_000;
  let fd: number;
  while (true) {
    try {
      fd = openSync(lock, 'wx', 0o600);
      break;
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) throw error;
      if (removeDeadLock(lock)) continue;
      if (Date.now() >= deadline) {
        throw new Error(`等待 provider 配置锁超时: ${file}`);
      }
      Bun.sleepSync(5);
    }
  }
  try {
    writeFileSync(fd, `${process.pid}\n`, 'utf8');
    return action();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lock);
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) throw error;
    }
  }
}

function removeDeadLock(lock: string): boolean {
  let owner: number;
  try {
    owner = Number(readFileSync(lock, 'utf8').trim());
  } catch (error) {
    return hasErrorCode(error, 'ENOENT');
  }
  if (!Number.isSafeInteger(owner) || owner <= 0) {
    try {
      if (Date.now() - statSync(lock).mtimeMs < 5_000) return false;
    } catch (error) {
      return hasErrorCode(error, 'ENOENT');
    }
  } else {
    try {
      process.kill(owner, 0);
      return false;
    } catch (error) {
      if (!hasErrorCode(error, 'ESRCH')) return false;
    }
  }
  try {
    unlinkSync(lock);
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) return false;
  }
  return true;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error['code'] === code;
}

/**
 * 凭据写入必须同时满足权限与原子替换，故这里使用 node:fs 的 open(mode)/fsync/rename
 * 系统边界；普通业务文件内容 I/O 仍优先 Bun API。临时文件与目标位于同一目录。
 */
function atomicWriteJson(file: string, value: unknown): void {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const temp = path.join(
    dir,
    `.${path.basename(file)}.${crypto.randomUUID()}.tmp`,
  );
  const fd = openSync(temp, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, file);
    chmodSync(file, 0o600);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // 若 rename 已成功，temp 已不存在；若清理本身失败，原始写入错误优先。
    }
    throw error;
  }
}

/** 编译期守卫：可配置 API 必须始终是 protocol ModelApi 的子集。 */
const _CONFIGURABLE_API_IS_MODEL_API: Record<ConfigurableModelApi, ModelApi> = {
  'openai-chat': 'openai-chat',
  'openai-responses': 'openai-responses',
  'anthropic-messages': 'anthropic-messages',
};
void _CONFIGURABLE_API_IS_MODEL_API;
