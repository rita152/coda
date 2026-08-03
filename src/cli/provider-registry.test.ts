// Provider registry 全部使用注入 fetch + 生成 fixture，默认测试零网络、零真实密钥。

import {
  afterEach,
  describe,
  expect,
  it,
} from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  customProviderId,
  modelsEndpoint,
  OPENCODE_GO_BASE_URL,
  ProviderRegistry,
  type CachedProviderModel,
} from './provider-registry.js';

interface ModelsFixture {
  openCodeGoMixed: unknown;
  custom: unknown;
  anthropic: unknown;
}

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '__fixtures__',
  'provider-models.json',
);
const fixture = (await Bun.file(fixturePath).json()) as ModelsFixture;
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function paths(): { dir: string; configPath: string; credentialsPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'coda-provider-registry-'));
  tempDirs.push(dir);
  return {
    dir,
    configPath: path.join(dir, '.coda', 'providers.json'),
    credentialsPath: path.join(dir, '.coda', 'credentials.json'),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('OpenCode Go 混合协议模型发现', () => {
  it('固定 id/base URL，纳入当前 active 模型并排除 deprecated/未知模型', async () => {
    const files = paths();
    const calls: { url: string; authorization: string | null }[] = [];
    const registry = new ProviderRegistry({
      ...files,
      now: () => 1234,
      fetch: async (input, init) => {
        calls.push({
          url: String(input),
          authorization: new Headers(init?.headers).get('authorization'),
        });
        return jsonResponse(fixture.openCodeGoMixed);
      },
    });

    const result = await registry.configureOpenCodeGo('  secret-opencode-key  ');

    expect(result.provider).toMatchObject({
      id: 'opencode-go',
      name: 'OpenCode Go',
      kind: 'opencode-go',
      baseURL: OPENCODE_GO_BASE_URL,
      refreshedAt: 1234,
    });
    expect(result.refresh).toEqual({
      ok: true,
      providerId: 'opencode-go',
      models: [
        { id: 'kimi-k3', api: 'openai-chat' },
        { id: 'minimax-m3', api: 'anthropic-messages' },
        { id: 'deepseek-v4-flash', api: 'openai-chat' },
        { id: 'qwen3.8-max', api: 'anthropic-messages' },
        { id: 'gpt-5.6-luna', api: 'openai-responses' },
      ],
      ignoredUnknownModelIds: [
        'minimax-m2.5',
        'remote-active-but-local-unknown',
      ],
    });
    expect(calls).toEqual([
      {
        url: 'https://opencode.ai/zen/go/v1/models',
        authorization: 'Bearer secret-opencode-key',
      },
    ]);
    expect(registry.availableModels().map((model) => [model.ref, model.api])).toEqual([
      ['opencode-go/kimi-k3', 'openai-chat'],
      ['opencode-go/minimax-m3', 'anthropic-messages'],
      ['opencode-go/deepseek-v4-flash', 'openai-chat'],
      ['opencode-go/qwen3.8-max', 'anthropic-messages'],
      ['opencode-go/gpt-5.6-luna', 'openai-responses'],
    ]);
    expect(
      registry.resolveModel('opencode-go', 'deepseek-v4-flash'),
    ).toMatchObject({
      ref: {
        provider: 'opencode-go',
        api: 'openai-chat',
        model: 'deepseek-v4-flash',
      },
      limits: { context: 1_000_000, output: 384_000 },
    });
    expect(registry.resolveModel('opencode-go', 'qwen3.8-max')).toMatchObject({
      ref: {
        provider: 'opencode-go',
        api: 'anthropic-messages',
        model: 'qwen3.8-max',
      },
      limits: { context: 1_000_000, output: 131_072 },
    });
    expect(registry.resolveModel('opencode-go', 'gpt-5.6-luna')).toMatchObject({
      ref: {
        provider: 'opencode-go',
        api: 'openai-responses',
        model: 'gpt-5.6-luna',
      },
      limits: { context: 1_050_000, output: 128_000 },
    });
    expect(registry.resolveModel('opencode-go', 'minimax-m2.5')).toBeUndefined();
    expect(
      registry.resolveModel('opencode-go', 'remote-active-but-local-unknown'),
    ).toBeUndefined();

    const publicConfig = readFileSync(files.configPath, 'utf8');
    const credentials = readFileSync(files.credentialsPath, 'utf8');
    expect(publicConfig).not.toContain('secret-opencode-key');
    expect(credentials).toContain('secret-opencode-key');
    expect(statSync(files.credentialsPath).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(files.credentialsPath)).mode & 0o777).toBe(0o700);
  });

  it('远端宣称可用但本地未收录的模型保留 ignored 提示，不会静默消失', async () => {
    const files = paths();
    const registry = new ProviderRegistry({
      ...files,
      fetch: async () => jsonResponse(fixture.openCodeGoMixed),
    });

    const result = await registry.configureOpenCodeGo('key');

    expect(result.refresh).toMatchObject({
      ok: true,
      ignoredUnknownModelIds: [
        'minimax-m2.5',
        'remote-active-but-local-unknown',
      ],
    });
    expect(
      registry.availableModels().some(
        (model) => model.model === 'remote-active-but-local-unknown',
      ),
    ).toBe(false);
  });
});

describe('Custom provider 管理', () => {
  it('名称大小写不敏感且 id 稳定；支持多个 provider 与三个固定协议的标准 models endpoint', async () => {
    const files = paths();
    const calls: {
      url: string;
      authorization: string | null;
      anthropicKey: string | null;
      anthropicVersion: string | null;
    }[] = [];
    const registry = new ProviderRegistry({
      ...files,
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        calls.push({
          url: String(input),
          authorization: headers.get('authorization'),
          anthropicKey: headers.get('x-api-key'),
          anthropicVersion: headers.get('anthropic-version'),
        });
        return jsonResponse(fixture.custom);
      },
    });

    const acme = await registry.configureCustom(
      'Acme Gateway',
      'https://openai.example/v1/',
      'acme-key',
      'openai-responses',
    );
    const beta = await registry.configureCustom(
      'Beta',
      'https://anthropic.example',
      'beta-key',
      'anthropic-messages',
    );
    const updated = await registry.configureCustom(
      'aCME gATEWAY',
      'https://openai.example/v1',
      'acme-key-2',
      'openai-responses',
    );

    expect(acme.provider.id).toBe('custom:acme%20gateway');
    expect(updated.provider.id).toBe(acme.provider.id);
    expect(beta.provider.id).toBe('custom:beta');
    expect(registry.listProviders()).toHaveLength(2);
    expect(registry.listCredentials()).toHaveLength(2);
    expect(
      registry
        .availableModels()
        .filter((model) => model.providerId === acme.provider.id)
        .every((model) => model.api === 'openai-responses'),
    ).toBe(true);
    expect(
      registry
        .availableModels()
        .filter((model) => model.providerId === beta.provider.id)
        .every((model) => model.api === 'anthropic-messages'),
    ).toBe(true);
    expect(
      registry.resolveModel(acme.provider.id, 'custom-alpha')?.limits,
    ).toBeUndefined();

    expect(calls[0]).toEqual({
      url: 'https://openai.example/v1/models',
      authorization: 'Bearer acme-key',
      anthropicKey: null,
      anthropicVersion: null,
    });
    expect(calls[1]).toEqual({
      url: 'https://anthropic.example/v1/models',
      authorization: null,
      anthropicKey: 'beta-key',
      anthropicVersion: '2023-06-01',
    });
    expect(calls[2]?.authorization).toBe('Bearer acme-key-2');
  });

  it('Anthropic models endpoint 按 after_id 分页并跨页去重', async () => {
    const files = paths();
    const pages: unknown[] = [
      {
        data: [{ id: 'first' }, { id: 'duplicate' }],
        has_more: true,
        last_id: 'cursor-1',
      },
      {
        data: [{ id: 'duplicate' }, { id: 'second' }],
        has_more: false,
      },
    ];
    const calls: {
      url: string;
      apiKey: string | null;
      version: string | null;
    }[] = [];
    const registry = new ProviderRegistry({
      ...files,
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        calls.push({
          url: String(input),
          apiKey: headers.get('x-api-key'),
          version: headers.get('anthropic-version'),
        });
        const page = pages.shift();
        if (page === undefined) throw new Error('unexpected models page');
        return jsonResponse(page);
      },
    });

    const result = await registry.configureCustom(
      'Anthropic',
      'https://anthropic.example',
      'anthropic-key',
      'anthropic-messages',
    );

    expect(result.refresh).toEqual({
      ok: true,
      providerId: 'custom:anthropic',
      models: [
        { id: 'first', api: 'anthropic-messages' },
        { id: 'duplicate', api: 'anthropic-messages' },
        { id: 'second', api: 'anthropic-messages' },
      ],
      ignoredUnknownModelIds: [],
    });
    expect(calls).toEqual([
      {
        url: 'https://anthropic.example/v1/models',
        apiKey: 'anthropic-key',
        version: '2023-06-01',
      },
      {
        url: 'https://anthropic.example/v1/models?after_id=cursor-1',
        apiKey: 'anthropic-key',
        version: '2023-06-01',
      },
    ]);
  });

  it('Anthropic models 空页可成功清空缓存且不继续请求', async () => {
    const files = paths();
    const calls: string[] = [];
    const registry = new ProviderRegistry({
      ...files,
      fetch: async (input) => {
        calls.push(String(input));
        return jsonResponse({ data: [], has_more: false });
      },
    });

    const result = await registry.configureCustom(
      'Empty Anthropic',
      'https://anthropic.example',
      'anthropic-key',
      'anthropic-messages',
    );

    expect(result.refresh).toMatchObject({
      ok: true,
      models: [],
      ignoredUnknownModelIds: [],
    });
    expect(calls).toEqual(['https://anthropic.example/v1/models']);
  });

  it('Anthropic models 缺少 next cursor 时拒绝继续分页', async () => {
    const files = paths();
    const calls: string[] = [];
    const registry = new ProviderRegistry({
      ...files,
      fetch: async (input) => {
        calls.push(String(input));
        return jsonResponse({
          data: [{ id: 'first' }],
          has_more: true,
        });
      },
    });

    const result = await registry.configureCustom(
      'Malformed Anthropic',
      'https://anthropic.example',
      'anthropic-key',
      'anthropic-messages',
    );

    expect(result.refresh.ok).toBe(false);
    expect(calls).toEqual(['https://anthropic.example/v1/models']);
  });

  it('Anthropic models 重复 next cursor 时停止而不陷入循环', async () => {
    const files = paths();
    const calls: string[] = [];
    let page = 0;
    const registry = new ProviderRegistry({
      ...files,
      fetch: async (input) => {
        calls.push(String(input));
        page += 1;
        return page === 1
          ? jsonResponse({
              data: [{ id: 'first' }],
              has_more: true,
              last_id: 'same-cursor',
            })
          : jsonResponse({
              data: [{ id: 'second' }],
              has_more: true,
              last_id: 'same-cursor',
            });
      },
    });

    const result = await registry.configureCustom(
      'Looping Anthropic',
      'https://anthropic.example',
      'anthropic-key',
      'anthropic-messages',
    );

    expect(result.refresh.ok).toBe(false);
    expect(calls).toEqual([
      'https://anthropic.example/v1/models',
      'https://anthropic.example/v1/models?after_id=same-cursor',
    ]);
  });

  it('保留 Anthropic 模型能力与 token limits，且缓存重载后仍可 resolve', async () => {
    const files = paths();
    const registry = new ProviderRegistry({
      ...files,
      now: () => 5678,
      fetch: async () => jsonResponse(fixture.anthropic),
    });

    const configured = await registry.configureCustom(
      'Anthropic',
      'https://api.anthropic.com',
      'anthropic-key',
      'anthropic-messages',
    );
    const expectedModel: CachedProviderModel = {
      id: 'claude-opus-4-6',
      api: 'anthropic-messages',
      capabilities: {
        image_input: { supported: true },
        thinking: {
          supported: true,
          types: { enabled: { supported: true } },
        },
        future_capability: { supported: true, rollout: 'preview' },
      },
      limits: { context: 200_000, output: 64_000 },
    };
    expect(configured.refresh).toEqual({
      ok: true,
      providerId: 'custom:anthropic',
      models: [
        expectedModel,
        { id: 'claude-legacy', api: 'anthropic-messages' },
      ],
      ignoredUnknownModelIds: [],
    });
    expect(configured.provider.models).toEqual([
      expectedModel,
      { id: 'claude-legacy', api: 'anthropic-messages' },
    ]);

    const nonAnthropicFiles = paths();
    const nonAnthropic = new ProviderRegistry({
      ...nonAnthropicFiles,
      fetch: async () => jsonResponse(fixture.anthropic),
    });
    await nonAnthropic.configureCustom(
      'OpenAI Gateway',
      'https://openai.example/v1',
      'openai-key',
      'openai-responses',
    );
    expect(
      nonAnthropic.resolveModel('custom:openai%20gateway', 'claude-opus-4-6'),
    ).toMatchObject({
      ref: {
        provider: 'custom:openai%20gateway',
        api: 'openai-responses',
        model: 'claude-opus-4-6',
      },
    });
    expect(
      nonAnthropic.resolveModel('custom:openai%20gateway', 'claude-opus-4-6')?.limits,
    ).toBeUndefined();
    expect(
      nonAnthropic.resolveModel('custom:openai%20gateway', 'claude-opus-4-6')?.capabilities,
    ).toBeUndefined();

    const persisted = JSON.parse(readFileSync(files.configPath, 'utf8')) as {
      providers: Array<{ models: unknown }>;
    };
    expect(persisted.providers[0]?.models).toEqual([
      expectedModel,
      { id: 'claude-legacy', api: 'anthropic-messages' },
    ]);

    const restored = new ProviderRegistry({
      ...files,
      fetch: async () => jsonResponse({ data: [] }),
    });
    expect(restored.listProviders()[0]?.models).toEqual([
      expectedModel,
      { id: 'claude-legacy', api: 'anthropic-messages' },
    ]);
    expect(
      restored.resolveModel('custom:anthropic', 'claude-opus-4-6'),
    ).toMatchObject({
      ref: {
        provider: 'custom:anthropic',
        api: 'anthropic-messages',
        model: 'claude-opus-4-6',
      },
      capabilities: expectedModel.capabilities,
      limits: { context: 200_000, output: 64_000 },
    });
    expect(
      restored.resolveModel('custom:anthropic', 'claude-legacy'),
    ).toMatchObject({
      ref: {
        provider: 'custom:anthropic',
        api: 'anthropic-messages',
        model: 'claude-legacy',
      },
    });
    expect(
      restored.resolveModel('custom:anthropic', 'claude-legacy')?.limits,
    ).toBeUndefined();
  });

  it('接受旧的仅含 id/api 缓存格式', async () => {
    const files = paths();
    mkdirSync(path.dirname(files.configPath), { recursive: true });
    writeFileSync(
      files.configPath,
      JSON.stringify({
        version: 1,
        providers: [
          {
            id: 'custom:legacy',
            name: 'Legacy',
            kind: 'custom',
            baseURL: 'https://legacy.example/v1',
            api: 'anthropic-messages',
            models: [{ id: 'legacy-model', api: 'anthropic-messages' }],
          },
        ],
      }),
    );
    writeFileSync(
      files.credentialsPath,
      JSON.stringify({ version: 1, apiKeys: { 'custom:legacy': 'legacy-key' } }),
    );

    const registry = new ProviderRegistry({
      ...files,
      fetch: async () => jsonResponse({ data: [] }),
    });
    expect(registry.resolveModel('custom:legacy', 'legacy-model')).toMatchObject({
      ref: {
        provider: 'custom:legacy',
        api: 'anthropic-messages',
        model: 'legacy-model',
      },
      apiKey: 'legacy-key',
    });
    expect(
      registry.resolveModel('custom:legacy', 'legacy-model')?.limits,
    ).toBeUndefined();
  });

  it('id 生成先 NFKC/折叠空白/小写，并拒绝空名称与危险 base URL', () => {
    expect(customProviderId('  ＡＣＭＥ   Team ')).toBe('custom:acme%20team');
    expect(() => customProviderId('  ')).toThrow(/不能为空/);
    expect(() =>
      modelsEndpoint('https://user:password@example.test/v1'),
    ).toThrow(/用户名或密码/);
  });
});

describe('刷新失败、恢复与 logout', () => {
  it('多个旧 registry 合并写入，后续写入不会复活已 logout 的 key', async () => {
    const files = paths();
    const options = {
      ...files,
      fetch: async (): Promise<Response> => jsonResponse(fixture.custom),
    };
    const first = new ProviderRegistry(options);
    const second = new ProviderRegistry(options);

    const alpha = await first.configureCustom(
      'Alpha',
      'https://alpha.example/v1',
      'alpha-key',
      'openai-chat',
    );
    const beta = await second.configureCustom(
      'Beta',
      'https://beta.example/v1',
      'beta-key',
      'openai-chat',
    );

    const logout = new ProviderRegistry(options);
    const staleWriter = new ProviderRegistry(options);
    expect(logout.logout(alpha.provider.id)).toBe(true);
    const gamma = await staleWriter.configureCustom(
      'Gamma',
      'https://gamma.example/v1',
      'gamma-key',
      'openai-chat',
    );

    const persisted = new ProviderRegistry(options);
    expect(persisted.listProviders().map((provider) => provider.id)).toEqual([
      alpha.provider.id,
      beta.provider.id,
      gamma.provider.id,
    ]);
    expect(
      persisted.listCredentials().map((credential) => credential.providerId),
    ).toEqual([beta.provider.id, gamma.provider.id]);
  });

  it('较早的慢刷新不会回滚同一 provider 的新 endpoint 与 key', async () => {
    const files = paths();
    let releaseOld!: (response: Response) => void;
    let markOldStarted!: () => void;
    const oldStarted = new Promise<void>((resolve) => {
      markOldStarted = resolve;
    });
    const oldResponse = new Promise<Response>((resolve) => {
      releaseOld = resolve;
    });
    const oldRegistry = new ProviderRegistry({
      ...files,
      fetch: () => {
        markOldStarted();
        return oldResponse;
      },
    });
    const oldLogin = oldRegistry.configureCustom(
      'Shared',
      'https://old.example/v1',
      'old-key',
      'openai-chat',
    );
    await oldStarted;

    const newRegistry = new ProviderRegistry({
      ...files,
      fetch: async () => jsonResponse({ data: [{ id: 'new-only' }] }),
    });
    await newRegistry.configureCustom(
      'Shared',
      'https://new.example/v1',
      'new-key',
      'openai-chat',
    );
    releaseOld(jsonResponse({ data: [{ id: 'old-only' }] }));
    const stale = await oldLogin;
    expect(stale.refresh.ok).toBe(false);
    if (stale.refresh.ok) throw new Error('expected stale refresh rejection');
    expect(stale.refresh.error).toContain('已忽略过期');

    const persisted = new ProviderRegistry(files);
    expect(
      persisted.resolveModel('custom:shared', 'new-only'),
    ).toMatchObject({
      baseURL: 'https://new.example/v1',
      apiKey: 'new-key',
    });
    expect(
      persisted.resolveModel('custom:shared', 'old-only'),
    ).toBeUndefined();
  });

  it('网络失败保留配置、key 和既有缓存，错误可执行且绝不回显 key', async () => {
    const files = paths();
    let fail = false;
    const registry = new ProviderRegistry({
      ...files,
      fetch: async () => {
        if (fail) throw new Error('reflected super-secret-key');
        return jsonResponse(fixture.custom);
      },
    });
    await registry.configureCustom(
      'Stable',
      'https://stable.example/v1',
      'old-key',
      'openai-chat',
    );
    fail = true;

    const result = await registry.configureCustom(
      'stable',
      'https://stable.example/v1',
      'super-secret-key',
      'openai-chat',
    );

    expect(result.refresh.ok).toBe(false);
    if (result.refresh.ok) throw new Error('expected refresh failure');
    expect(result.refresh.error).toContain('检查网络');
    expect(result.refresh.error).toContain('已保留');
    expect(result.refresh.error).not.toContain('super-secret-key');
    expect(result.provider.models.map((model) => model.id)).toEqual([
      'custom-alpha',
      'org/custom-beta',
    ]);
    expect(readFileSync(files.credentialsPath, 'utf8')).toContain('super-secret-key');
    expect(readFileSync(files.configPath, 'utf8')).not.toContain('super-secret-key');
  });

  it('只恢复仍有 credential 且仍在缓存中的显式选择；logout 清 key 与当前选择但保留 provider 配置', async () => {
    const files = paths();
    let responseBody: unknown = fixture.custom;
    const registry = new ProviderRegistry({
      ...files,
      fetch: async () => jsonResponse(responseBody),
    });
    const configured = await registry.configureCustom(
      'Restore Me',
      'https://restore.example/v1',
      'restore-key',
      'openai-chat',
    );
    registry.rememberSelection(configured.provider.id, 'custom-alpha');

    const restored = new ProviderRegistry({
      ...files,
      fetch: async () => jsonResponse(responseBody),
    });
    expect(restored.selectedModel()).toEqual({
      providerId: configured.provider.id,
      model: 'custom-alpha',
    });
    expect(restored.resolveSelectedModel()?.ref).toEqual({
      provider: configured.provider.id,
      api: 'openai-chat',
      model: 'custom-alpha',
    });

    responseBody = { data: [] };
    await restored.refreshProvider(configured.provider.id);
    expect(restored.selectedModel()).toBeUndefined();
    expect(restored.resolveSelectedModel()).toBeUndefined();

    responseBody = fixture.custom;
    await restored.refreshProvider(configured.provider.id);
    expect(restored.selectedModel()).toBeUndefined();
    expect(
      JSON.parse(readFileSync(files.configPath, 'utf8')).selected,
    ).toBeUndefined();

    expect(restored.logout(configured.provider.id)).toBe(true);
    expect(restored.listCredentials()).toEqual([]);
    expect(restored.listProviders()).toHaveLength(1);
    expect(readFileSync(files.credentialsPath, 'utf8')).not.toContain('restore-key');
  });
});
