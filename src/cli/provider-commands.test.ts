// /login、/model、/logout 共用状态机测试；view/runtime 都是内存实现，零 TTY、零网络。

import {
  afterEach,
  describe,
  expect,
  it,
} from 'bun:test';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AgentMessage,
  ModelConfig,
  ModelRef,
  UserMessage,
} from '../protocol/index.js';
import type {
  SessionInteractionState,
  SessionListener,
  SessionUsage,
} from '../session/index.js';
import type { InteractiveSession } from './interactive-runtime.js';
import {
  ProviderCommandController,
  type ProviderCommandChoice,
  type ProviderCommandTone,
  type ProviderCommandView,
} from './provider-commands.js';
import { ProviderRegistry } from './provider-registry.js';

interface ModelsFixture {
  openCodeGoMixed: unknown;
  custom: unknown;
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

class MemoryRuntime implements InteractiveSession {
  state: SessionInteractionState = 'idle';
  model: ModelRef | undefined;
  readonly selectedConfigs: ModelConfig[] = [];
  clearCount = 0;
  readonly messages: readonly AgentMessage[] = [];

  interactionState(): SessionInteractionState {
    return this.state;
  }

  currentModel(): ModelRef | undefined {
    return this.model;
  }

  setModel(model: ModelConfig): void {
    this.selectedConfigs.push(model);
    this.model = model.ref;
  }

  clearModel(): void {
    this.clearCount++;
    this.model = undefined;
  }

  usage(): SessionUsage {
    return {
      cumulative: { input: 0, output: 0 },
      turns: 0,
      contextTokens: 0,
    };
  }

  subscribe(listener: SessionListener): () => void {
    void listener;
    return () => {};
  }

  subscribeSessionAttached(
    listener: (messages: readonly AgentMessage[]) => void | Promise<void>,
  ): () => void {
    void listener;
    return () => {};
  }

  prompt(text: string): Promise<void> {
    void text;
    return Promise.resolve();
  }

  steer(text: string | UserMessage): void {
    void text;
  }
  followUp(text: string | UserMessage): void {
    void text;
  }
  abort(): void {}
  close(): Promise<void> {
    return Promise.resolve();
  }
}

class MemoryView implements ProviderCommandView {
  readonly lines: { text: string; tone?: ProviderCommandTone }[] = [];
  readonly prompts: {
    prompt?: string;
    secret: boolean;
    choices?: readonly ProviderCommandChoice[];
  }[] = [];
  readonly models: (ModelRef | undefined)[] = [];
  readonly contextLimits: (number | undefined)[] = [];
  onCommandPrompt?: (prompt: string | undefined) => void;

  println(text: string, tone?: ProviderCommandTone): void {
    this.lines.push({
      text,
      ...(tone !== undefined && { tone }),
    });
  }

  setCommandPrompt(
    prompt: string | undefined,
    secret: boolean,
    choices?: readonly ProviderCommandChoice[],
  ): void {
    this.prompts.push({
      ...(prompt !== undefined && { prompt }),
      secret,
      ...(choices !== undefined && { choices }),
    });
    this.onCommandPrompt?.(prompt);
  }

  setModel(model: ModelRef | undefined, contextLimit?: number): void {
    this.models.push(model);
    this.contextLimits.push(contextLimit);
  }
}

function setup(
  fetchBody: unknown = fixture.custom,
  fetchImpl?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
): {
  controller: ProviderCommandController;
  registry: ProviderRegistry;
  runtime: MemoryRuntime;
  view: MemoryView;
  configPath: string;
  credentialsPath: string;
} {
  const dir = mkdtempSync(path.join(tmpdir(), 'coda-provider-commands-'));
  tempDirs.push(dir);
  const configPath = path.join(dir, 'providers.json');
  const credentialsPath = path.join(dir, 'credentials.json');
  const registry = new ProviderRegistry({
    configPath,
    credentialsPath,
    fetch:
      fetchImpl ??
      (async () => new Response(JSON.stringify(fetchBody), { status: 200 })),
  });
  const runtime = new MemoryRuntime();
  const view = new MemoryView();
  return {
    controller: new ProviderCommandController(registry, runtime, view),
    registry,
    runtime,
    view,
    configPath,
    credentialsPath,
  };
}

async function loginOpenCode(
  controller: ProviderCommandController,
  apiKey: string,
): Promise<void> {
  controller.begin('login');
  await controller.submit('2');
  await controller.submit('1');
  await controller.submit(apiKey);
}

async function loginCustom(
  controller: ProviderCommandController,
  values: {
    name: string;
    baseURL: string;
    apiKey: string;
    protocol: string;
  },
): Promise<void> {
  controller.begin('login');
  await controller.submit('2');
  await controller.submit('2');
  await controller.submit(values.name);
  await controller.submit(values.baseURL);
  await controller.submit(values.apiKey);
  await controller.submit(values.protocol);
}

describe('/login', () => {
  it('先显示 OAuth/API key；OAuth 仅提示尚未实现并安全返回', async () => {
    const { controller, registry, view } = setup();

    controller.begin('login');
    expect(view.lines).toEqual([]);
    expect(view.prompts.at(-1)).toEqual({
      prompt: '选择登录方式（Esc 退出）',
      secret: false,
      choices: [
        { value: 'OAuth', label: 'OAuth', description: '尚未实现' },
        {
          value: 'API key',
          label: 'API key',
          description: '使用 provider API key',
        },
      ],
    });
    await controller.submit('OAuth');

    expect(controller.active).toBe(false);
    expect(view.lines.at(-1)?.text).toBe('OAuth 尚未实现');
    expect(registry.listProviders()).toEqual([]);
    expect(registry.listCredentials()).toEqual([]);
  });

  it('OpenCode Go 秘密输入后立即刷新，但 /login 不自动选择模型且 key 不进入输出/公共配置', async () => {
    const secret = 'opencode-key-never-echo';
    const {
      controller,
      registry,
      runtime,
      view,
      configPath,
      credentialsPath,
    } = setup(fixture.openCodeGoMixed);

    await loginOpenCode(controller, secret);

    expect(controller.active).toBe(false);
    expect(view.prompts.some((prompt) => prompt.secret)).toBe(true);
    expect(runtime.selectedConfigs).toEqual([]);
    expect(runtime.currentModel()).toBeUndefined();
    expect(registry.availableModels()).toHaveLength(3);
    expect(view.lines.some((line) => line.text.includes('模型列表已刷新'))).toBe(true);
    expect(JSON.stringify({ lines: view.lines, prompts: view.prompts })).not.toContain(secret);
    expect(readFileSync(configPath, 'utf8')).not.toContain(secret);
    expect(readFileSync(credentialsPath, 'utf8')).toContain(secret);
  });

  it('模型刷新失败仍保留配置与 key，并把可执行错误显示给用户且不回显秘密', async () => {
    const secret = 'refresh-failure-secret';
    const {
      controller,
      registry,
      view,
      configPath,
      credentialsPath,
    } = setup(fixture.openCodeGoMixed, async () => {
      throw new Error(`network reflected ${secret}`);
    });

    await loginOpenCode(controller, secret);

    expect(controller.active).toBe(false);
    expect(registry.listConfiguredProviders()).toHaveLength(1);
    const output = view.lines.map((line) => line.text).join('\n');
    expect(output).toContain('无法连接 https://opencode.ai/zen/go/v1/models');
    expect(output).toContain('重新运行 /login');
    expect(output).not.toContain(secret);
    expect(readFileSync(configPath, 'utf8')).not.toContain(secret);
    expect(readFileSync(credentialsPath, 'utf8')).toContain(secret);
  });

  it('Custom 严格按 name → base URL → secret key → 固定协议，拒绝自由协议并按名称更新', async () => {
    const {
      controller,
      registry,
      runtime,
      view,
    } = setup();
    controller.begin('login');
    await controller.submit('API key');
    await controller.submit('Custom');
    await controller.submit('Example');
    await controller.submit('https://example.test/v1');
    await controller.submit('custom-key');

    expect(view.prompts.at(-1)).toEqual({
      prompt: '选择 Custom provider 协议（Esc 返回）',
      secret: false,
      choices: [
        {
          value: 'OpenAI Chat Completions',
          label: 'OpenAI Chat Completions',
          description: 'openai-chat',
        },
        {
          value: 'OpenAI Responses',
          label: 'OpenAI Responses',
          description: 'openai-responses',
        },
        {
          value: 'Anthropic Messages',
          label: 'Anthropic Messages',
          description: 'anthropic-messages',
        },
      ],
    });
    await controller.submit('some-made-up-protocol');
    expect(controller.active).toBe(true);
    expect(registry.listProviders()).toEqual([]);

    await controller.submit('OpenAI Responses');
    expect(controller.active).toBe(false);
    expect(registry.listProviders()[0]).toMatchObject({
      id: 'custom:example',
      api: 'openai-responses',
    });
    expect(runtime.currentModel()).toBeUndefined();

    await loginCustom(controller, {
      name: 'eXAMPLE',
      baseURL: 'https://example.test/v1',
      apiKey: 'updated-key',
      protocol: '2',
    });
    await loginCustom(controller, {
      name: 'Second',
      baseURL: 'https://second.test',
      apiKey: 'second-key',
      protocol: '3',
    });
    expect(registry.listProviders()).toHaveLength(2);
    expect(registry.listCredentials()).toHaveLength(2);
  });

  it('Esc 逐级静默返回，根步骤退出；任务运行中给出先完成或 abort 的提示', async () => {
    const { controller, runtime, view } = setup();

    controller.begin('login');
    await controller.submit('2');
    expect(view.prompts.at(-1)?.prompt).toBe(
      '选择 API key provider（Esc 返回）',
    );
    expect(controller.back()).toBe(true);
    expect(view.prompts.at(-1)?.prompt).toBe('选择登录方式（Esc 退出）');
    expect(controller.active).toBe(true);
    expect(controller.back()).toBe(true);
    expect(controller.active).toBe(false);
    expect(view.prompts.at(-1)).toEqual({ secret: false });
    expect(view.lines.some((line) => line.text === '已取消')).toBe(false);

    controller.begin('login');
    await controller.submit('2');
    await controller.submit('2');
    await controller.submit('Example');
    await controller.submit('https://example.test/v1');
    await controller.submit('custom-secret-to-clear');
    expect(view.prompts.at(-1)?.prompt).toBe(
      '选择 Custom provider 协议（Esc 返回）',
    );
    expect(controller.back()).toBe(true);
    expect(controller.secret).toBe(true);
    expect(view.prompts.at(-1)?.prompt).toBe(
      'Custom API key（秘密输入 · Esc 返回）',
    );
    expect(controller.back()).toBe(true);
    expect(view.prompts.at(-1)?.prompt).toBe('Custom base URL（Esc 返回）');
    expect(controller.back()).toBe(true);
    expect(view.prompts.at(-1)?.prompt).toBe(
      'Custom provider name（Esc 返回）',
    );
    expect(controller.back()).toBe(true);
    expect(view.prompts.at(-1)?.prompt).toBe(
      '选择 API key provider（Esc 返回）',
    );
    expect(controller.back()).toBe(true);
    expect(view.prompts.at(-1)?.prompt).toBe('选择登录方式（Esc 退出）');
    expect(controller.back()).toBe(true);
    expect(controller.active).toBe(false);
    expect(view.prompts.at(-1)).toEqual({ secret: false });
    expect(
      JSON.stringify({ lines: view.lines, prompts: view.prompts }),
    ).not.toContain('custom-secret-to-clear');
    expect(view.lines.some((line) => line.text === '已取消')).toBe(false);

    for (const state of ['running', 'retrying', 'compacting'] as const) {
      runtime.state = state;
      controller.begin('model');
      expect(view.lines.at(-1)?.text).toContain('完成或 abort');
      expect(controller.active).toBe(false);
    }
  });

  it('保存/刷新进行中不能用 Esc 返回并制造随后保存的竞态', async () => {
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const { controller, view } = setup(
      fixture.openCodeGoMixed,
      async () => {
        markFetchStarted();
        await fetchGate;
        return new Response(JSON.stringify(fixture.openCodeGoMixed), {
          status: 200,
        });
      },
    );
    controller.begin('login');
    await controller.submit('2');
    await controller.submit('1');
    const saving = controller.submit('busy-secret');
    await fetchStarted;

    expect(controller.back()).toBe(false);
    expect(controller.active).toBe(true);
    expect(view.lines.at(-1)?.text).toContain('正在保存或刷新');

    releaseFetch();
    await saving;
    expect(controller.active).toBe(false);
    expect(view.lines.some((line) => line.text.includes('已保存 OpenCode Go'))).toBe(true);
  });

  it('close 取消并等待在途模型刷新', async () => {
    let refreshSignal: AbortSignal | undefined;
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const { controller } = setup(
      fixture.openCodeGoMixed,
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          refreshSignal = init?.signal ?? undefined;
          markFetchStarted();
          refreshSignal?.addEventListener(
            'abort',
            () => reject(refreshSignal?.reason),
            { once: true },
          );
        }),
    );
    controller.begin('login');
    await controller.submit('2');
    await controller.submit('1');
    const saving = controller.submit('busy-secret');
    await fetchStarted;

    await controller.close();
    await saving;
    expect(refreshSignal?.aborted).toBe(true);
    expect(controller.active).toBe(false);
    expect(controller.busy).toBe(false);
  });

  it('view 在 submit 中重入 close 仍等待当前操作', async () => {
    let releaseFetch!: (response: Response) => void;
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const response = new Promise<Response>((resolve) => {
      releaseFetch = resolve;
    });
    const { controller, view } = setup(
      fixture.openCodeGoMixed,
      () => {
        markFetchStarted();
        return response;
      },
    );
    controller.begin('login');
    await controller.submit('2');
    await controller.submit('1');

    let closing: Promise<void> | undefined;
    let closeSettled = false;
    view.onCommandPrompt = (prompt) => {
      if (prompt !== '正在保存认证并刷新模型…') return;
      closing = controller.close().finally(() => {
        closeSettled = true;
      });
    };
    const saving = controller.submit('busy-secret');
    await fetchStarted;
    const close = closing;
    if (close === undefined) throw new Error('expected reentrant close');
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    expect(closeSettled).toBe(false);
    expect(controller.busy).toBe(true);

    releaseFetch(
      new Response(JSON.stringify(fixture.openCodeGoMixed), { status: 200 }),
    );
    await close;
    await saving;
    expect(controller.busy).toBe(false);
    expect(controller.active).toBe(false);
  });
});

describe('/model 与 /logout', () => {
  it('/model 仅列已认证 provider 缓存模型，以 provider/model 选择后才切换并记忆', async () => {
    const {
      controller,
      registry,
      runtime,
      view,
    } = setup(fixture.openCodeGoMixed);
    await loginOpenCode(controller, 'key');

    controller.begin('model');
    expect(
      view.lines.some((line) => line.text.includes('unknown-future-model')),
    ).toBe(true); // /login 明确报告被忽略
    const modelChoices = view.prompts.at(-1)?.choices ?? [];
    expect(
      modelChoices.map((choice) => choice.value),
    ).toEqual([
      'opencode-go/kimi-k3',
      'opencode-go/minimax-m3',
      'opencode-go/deepseek-v4-flash',
    ]);
    expect(
      modelChoices.filter((choice) =>
        choice.value.includes('unknown-future-model'),
      ),
    ).toEqual([]);

    await controller.submit('opencode-go/minimax-m3');

    expect(runtime.currentModel()).toEqual({
      provider: 'opencode-go',
      api: 'anthropic-messages',
      model: 'minimax-m3',
    });
    expect(runtime.selectedConfigs[0]).toMatchObject({
      baseURL: 'https://opencode.ai/zen/go/v1',
      apiKey: 'key',
      limits: { context: 1_000_000, output: 131_072 },
    });
    expect(view.contextLimits.at(-1)).toBe(1_000_000);
    expect(
      view.lines.some((line) => line.text.startsWith('已选择 ')),
    ).toBe(false);
    expect(registry.selectedModel()).toEqual({
      providerId: 'opencode-go',
      model: 'minimax-m3',
    });
  });

  it('/logout 按 provider 名称移除 key；若为当前 provider 则退回未选择，但保留非秘密配置', async () => {
    const {
      controller,
      registry,
      runtime,
    } = setup(fixture.openCodeGoMixed);
    await loginOpenCode(controller, 'logout-key');
    controller.begin('model');
    await controller.submit('1');
    expect(runtime.currentModel()?.provider).toBe('opencode-go');

    controller.begin('logout');
    await controller.submit('OpenCode Go');

    expect(runtime.currentModel()).toBeUndefined();
    expect(runtime.clearCount).toBe(1);
    expect(registry.listCredentials()).toEqual([]);
    expect(registry.listProviders()).toHaveLength(1);
    expect(registry.availableModels()).toEqual([]);
    expect(registry.selectedModel()).toBeUndefined();
  });

  it('/logout 优先匹配 provider id，歧义名称不删除任一 key', async () => {
    const {
      controller,
      registry,
      view,
    } = setup(fixture.openCodeGoMixed);
    await loginOpenCode(controller, 'opencode-key');
    await loginCustom(controller, {
      name: 'OpenCode Go',
      baseURL: 'https://custom.example/v1',
      apiKey: 'custom-key',
      protocol: '1',
    });

    controller.begin('logout');
    await controller.submit('OpenCode Go');
    expect(controller.active).toBe(true);
    expect(registry.listCredentials()).toHaveLength(2);
    expect(view.lines.at(-1)?.text).toContain('无效选择');

    await controller.submit('opencode-go');
    expect(controller.active).toBe(false);
    expect(registry.listCredentials()).toEqual([
      {
        providerId: 'custom:opencode%20go',
        providerName: 'OpenCode Go',
      },
    ]);
  });
});
