// /login、/model、/logout 的共用交互状态机。TUI/classic 只提供显示与输入遮罩；
// 所有步骤、回退语义、provider 解析和持久化动作都只定义一次。

import type { ModelConfig, ModelRef } from '../protocol/index.js';
import type { InteractiveSession } from './interactive-runtime.js';
import {
  type AvailableProviderModel,
  type ConfigureProviderResult,
  type ConfigurableModelApi,
  ProviderRegistry,
} from './provider-registry.js';

export type ProviderCommandName = 'login' | 'model' | 'logout';
export type ProviderCommandTone =
  | 'normal'
  | 'muted'
  | 'success'
  | 'warning'
  | 'danger';

export interface ProviderCommandChoice {
  value: string;
  label: string;
  description?: string;
}

export interface ProviderCommandView {
  println(text: string, tone?: ProviderCommandTone): void;
  setCommandPrompt(
    prompt: string | undefined,
    secret: boolean,
    choices?: readonly ProviderCommandChoice[],
  ): void;
  /** 只把非秘密模型展示信息交给 view，绝不把含 apiKey 的 ModelConfig 传进渲染层。 */
  setModel(model: ModelRef | undefined, contextLimit?: number): void;
}

interface InputStep {
  secret: boolean;
  submit(value: string): Promise<void>;
  back(): void;
}

interface CustomDraft {
  name?: string;
  baseURL?: string;
  apiKey?: string;
}

const PROTOCOL_CHOICES: readonly {
  label: string;
  api: ConfigurableModelApi;
}[] = [
  { label: 'OpenAI Chat Completions', api: 'openai-chat' },
  { label: 'OpenAI Responses', api: 'openai-responses' },
  { label: 'Anthropic Messages', api: 'anthropic-messages' },
];

const LOGIN_CHOICES: readonly ProviderCommandChoice[] = [
  {
    value: 'OAuth',
    label: 'OAuth',
    description: '尚未实现',
  },
  {
    value: 'API key',
    label: 'API key',
    description: '使用 provider API key',
  },
];

const API_KEY_PROVIDER_CHOICES: readonly ProviderCommandChoice[] = [
  {
    value: 'OpenCode Go',
    label: 'OpenCode Go',
    description: 'opencode-go · mixed protocol',
  },
  {
    value: 'Custom',
    label: 'Custom',
    description: '自定义 endpoint 与协议',
  },
];

export class ProviderCommandController {
  readonly #registry: ProviderRegistry;
  readonly #runtime: InteractiveSession;
  readonly #view: ProviderCommandView;
  readonly #abort = new AbortController();

  #step: InputStep | undefined;
  #draft: CustomDraft | undefined;
  #pending: Promise<void> = Promise.resolve();
  #closePromise: Promise<void> | undefined;
  #busy = false;
  #closed = false;

  constructor(
    registry: ProviderRegistry,
    runtime: InteractiveSession,
    view: ProviderCommandView,
  ) {
    this.#registry = registry;
    this.#runtime = runtime;
    this.#view = view;
  }

  get active(): boolean {
    return this.#step !== undefined;
  }

  get secret(): boolean {
    return this.#step?.secret === true;
  }

  get busy(): boolean {
    return this.#busy;
  }

  begin(command: ProviderCommandName): void {
    if (this.#closed) return;
    if (this.#busy) {
      this.#view.println('正在处理上一项 provider 操作，请稍候', 'warning');
      return;
    }
    if (this.#runtime.interactionState() !== 'idle') {
      this.#view.println('任务仍在运行；请先完成或 abort，再执行该命令', 'warning');
      return;
    }
    this.#finish();
    switch (command) {
      case 'login':
        this.#beginLogin();
        break;
      case 'model':
        this.#beginModel();
        break;
      case 'logout':
        this.#beginLogout();
        break;
    }
  }

  submit(value: string): Promise<void> {
    const step = this.#step;
    if (this.#closed || step === undefined || this.#busy) return Promise.resolve();
    this.#busy = true;
    this.#pending = Promise.resolve().then(async () => {
      try {
        if (this.#closed) return;
        await step.submit(value);
      } catch (error) {
        // Registry 的网络错误不携带响应正文，验证错误也从不拼接 API key。
        this.#view.println(safeErrorMessage(error), 'danger');
      } finally {
        this.#busy = false;
      }
    });
    return this.#pending;
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closePromise = this.#pending.finally(() => this.#finish());
    this.#closed = true;
    this.#abort.abort();
    return this.#closePromise;
  }

  back(): boolean {
    if (this.#closed) return false;
    if (this.#busy) {
      this.#view.println('provider 操作正在保存或刷新，完成后再继续', 'warning');
      return false;
    }
    const step = this.#step;
    if (step === undefined) return false;
    step.back();
    return true;
  }

  #beginLogin(): void {
    this.#setStep('选择登录方式（Esc 退出）', false, async (value) => {
      const selected = selectChoice(
        value,
        LOGIN_CHOICES.map((choice) => choice.label),
      );
      if (selected === undefined) {
        this.#invalidChoice(LOGIN_CHOICES.length);
        return;
      }
      if (selected === 0) {
        this.#finish();
        this.#view.println('OAuth 尚未实现', 'warning');
        return;
      }
      this.#beginApiKeyProvider();
    }, LOGIN_CHOICES);
  }

  #beginApiKeyProvider(): void {
    this.#setStep('选择 API key provider（Esc 返回）', false, async (value) => {
      const selected = selectChoice(
        value,
        API_KEY_PROVIDER_CHOICES.map((choice) => choice.label),
      );
      if (selected === undefined) {
        this.#invalidChoice(API_KEY_PROVIDER_CHOICES.length);
        return;
      }
      if (selected === 0) {
        this.#setStep(
          'OpenCode Go API key（秘密输入 · Esc 返回）',
          true,
          async (apiKey) => {
            await this.#configure(
              this.#runtime.currentModel(),
              () =>
                this.#registry.configureOpenCodeGo(
                  apiKey,
                  this.#abort.signal,
                ),
            );
          },
          undefined,
          () => this.#beginApiKeyProvider(),
        );
        return;
      }
      this.#draft = {};
      this.#beginCustomName();
    }, API_KEY_PROVIDER_CHOICES, () => this.#beginLogin());
  }

  #beginCustomName(): void {
    this.#draft ??= {};
    this.#setStep(
      'Custom provider name（Esc 返回）',
      false,
      async (name) => {
        const normalized = name.trim();
        if (normalized === '') {
          this.#view.println('provider name 不能为空', 'warning');
          return;
        }
        if (this.#draft !== undefined) this.#draft.name = name;
        this.#beginCustomBaseURL();
      },
      undefined,
      () => {
        this.#clearDraft();
        this.#beginApiKeyProvider();
      },
    );
  }

  #beginCustomBaseURL(): void {
    this.#setStep(
      'Custom base URL（Esc 返回）',
      false,
      async (baseURL) => {
        if (baseURL.trim() === '') {
          this.#view.println('base URL 不能为空', 'warning');
          return;
        }
        if (this.#draft !== undefined) this.#draft.baseURL = baseURL;
        this.#beginCustomApiKey();
      },
      undefined,
      () => this.#beginCustomName(),
    );
  }

  #beginCustomApiKey(): void {
    this.#setStep(
      'Custom API key（秘密输入 · Esc 返回）',
      true,
      async (apiKey) => {
        if (apiKey.trim() === '') {
          this.#view.println('API key 不能为空', 'warning');
          return;
        }
        if (this.#draft !== undefined) this.#draft.apiKey = apiKey;
        this.#beginProtocolChoice();
      },
      undefined,
      () => this.#beginCustomBaseURL(),
    );
  }

  #beginProtocolChoice(): void {
    const choices = PROTOCOL_CHOICES.map((choice) => ({
      value: choice.label,
      label: choice.label,
      description: choice.api,
    }));
    this.#setStep('选择 Custom provider 协议（Esc 返回）', false, async (value) => {
      const selected = selectChoice(
        value,
        PROTOCOL_CHOICES.map((choice) => choice.label),
      );
      if (selected === undefined) {
        this.#invalidChoice(PROTOCOL_CHOICES.length);
        return;
      }
      const draft = this.#draft;
      const choice = PROTOCOL_CHOICES[selected];
      if (
        draft?.name === undefined ||
        draft.baseURL === undefined ||
        draft.apiKey === undefined ||
        choice === undefined
      ) {
        this.#finish();
        this.#view.println('Custom provider 输入状态已失效，请重新运行 /login', 'danger');
        return;
      }
      const apiKey = draft.apiKey;
      draft.apiKey = '';
      await this.#configure(
        this.#runtime.currentModel(),
        () =>
          this.#registry.configureCustom(
            draft.name as string,
            draft.baseURL as string,
            apiKey,
            choice.api,
            this.#abort.signal,
          ),
      );
    }, choices, () => {
      if (this.#draft?.apiKey !== undefined) this.#draft.apiKey = '';
      this.#beginCustomApiKey();
    });
  }

  async #configure(
    previousModelRef: ModelRef | undefined,
    configure: () => Promise<ConfigureProviderResult>,
  ): Promise<void> {
    const previousModel =
      previousModelRef === undefined
        ? undefined
        : this.#registry.resolveModel(
            previousModelRef.provider,
            previousModelRef.model,
          );
    this.#view.setCommandPrompt('正在保存认证并刷新模型…', false);
    let result: ConfigureProviderResult;
    try {
      result = await configure();
    } catch (error) {
      this.#finish();
      throw error;
    }
    this.#finish();
    this.#view.println(`已保存 ${result.provider.name} 的认证配置`, 'success');
    if (result.refresh.ok) {
      this.#view.println(
        `模型列表已刷新：${result.refresh.models.length} 个可用模型`,
        'success',
      );
      if (result.refresh.ignoredUnknownModelIds.length > 0) {
        this.#view.println(
          `已忽略 ${result.refresh.ignoredUnknownModelIds.length} 个协议未知的模型：` +
            result.refresh.ignoredUnknownModelIds.join(', '),
          'warning',
        );
      }
    } else {
      this.#view.println(result.refresh.error, 'danger');
    }

    // /login 不选择新模型。若它只是更新当前 provider 的 key，则保留用户原先
    // 显式选择并换入新凭据；endpoint/api/可用性发生变化时退回未选择状态。
    if (previousModelRef?.provider !== result.provider.id) return;
    const nextModel = this.#registry.resolveModel(
      previousModelRef.provider,
      previousModelRef.model,
    );
    if (
      previousModel !== undefined &&
      nextModel !== undefined &&
      sameEndpointAndApi(previousModel, nextModel)
    ) {
      await this.#runtime.setModel(nextModel);
      this.#view.setModel(nextModel.ref, nextModel.limits?.context);
      return;
    }
    this.#runtime.clearModel();
    this.#view.setModel(undefined);
    this.#view.println('当前模型已不再有效；请重新运行 /model 选择', 'warning');
  }

  #beginModel(): void {
    const models = this.#registry.availableModels();
    if (models.length === 0) {
      this.#view.println(
        '没有已配置 provider 的可用模型；先运行 /login，并修复任何模型刷新错误',
        'warning',
      );
      return;
    }
    const choices = models.map((model) => ({
      value: model.ref,
      label: model.ref,
      description: `${model.providerName} · ${model.api}`,
    }));
    this.#setStep('选择模型（Esc 退出）', false, async (value) => {
      const model = selectModel(value, models);
      if (model === undefined) {
        this.#view.println(
          `无效选择；请从 ${models.length} 个候选中选择，或输入完整 provider/model`,
          'warning',
        );
        return;
      }
      const config = this.#registry.resolveModel(model.providerId, model.model);
      if (config === undefined) {
        this.#view.println('该模型已不可用；重新运行 /login 刷新后再试', 'warning');
        this.#finish();
        return;
      }
      await this.#runtime.setModel(config);
      let rememberError: unknown;
      try {
        this.#registry.rememberSelection(model.providerId, model.model);
      } catch (error) {
        rememberError = error;
      }
      this.#finish();
      this.#view.setModel(config.ref, config.limits?.context);
      if (rememberError !== undefined) {
        this.#view.println(
          `模型已切换，但未能持久化最近选择；下次启动可能不会恢复本次选择：` +
            safeErrorMessage(rememberError),
          'warning',
        );
      }
    }, choices);
  }

  #beginLogout(): void {
    const credentials = this.#registry.listCredentials();
    if (credentials.length === 0) {
      this.#view.println('没有已保存的 API key', 'muted');
      return;
    }
    const choices = credentials.map((credential) => ({
      value: credential.providerId,
      label: credential.providerName,
      description: credential.providerId,
    }));
    this.#setStep('选择要退出的 provider（Esc 退出）', false, async (value) => {
      const selected = selectCredential(value, credentials);
      if (selected === undefined) {
        this.#invalidChoice(credentials.length);
        return;
      }
      const current = this.#runtime.currentModel();
      const removed = this.#registry.logout(selected.providerId);
      if (!removed) {
        this.#finish();
        this.#view.println(`${selected.providerName} 没有已保存的 API key`, 'warning');
        return;
      }
      if (current?.provider === selected.providerId) {
        this.#runtime.clearModel();
        this.#view.setModel(undefined);
      }
      this.#finish();
      this.#view.println(`已退出 ${selected.providerName}`, 'success');
    }, choices);
  }

  #setStep(
    prompt: string,
    secret: boolean,
    submit: (value: string) => Promise<void>,
    choices?: readonly ProviderCommandChoice[],
    back?: () => void,
  ): void {
    this.#step = {
      secret,
      submit,
      back: back ?? (() => this.#finish()),
    };
    this.#view.setCommandPrompt(prompt, secret, choices);
  }

  #finish(): void {
    this.#clearDraft();
    this.#step = undefined;
    this.#view.setCommandPrompt(undefined, false);
  }

  #clearDraft(): void {
    if (this.#draft?.apiKey !== undefined) this.#draft.apiKey = '';
    this.#draft = undefined;
  }

  #invalidChoice(count: number): void {
    this.#view.println(
      `无效选择；请从 ${count} 个候选中选择，或输入选项名称`,
      'warning',
    );
  }
}

function selectChoice(value: string, labels: readonly string[]): number | undefined {
  const normalized = value.trim().toLocaleLowerCase('en-US');
  const number = Number(normalized);
  if (Number.isInteger(number) && number >= 1 && number <= labels.length) {
    return number - 1;
  }
  const index = labels.findIndex(
    (label) => label.toLocaleLowerCase('en-US') === normalized,
  );
  return index === -1 ? undefined : index;
}

function selectModel(
  value: string,
  models: readonly AvailableProviderModel[],
): AvailableProviderModel | undefined {
  const trimmed = value.trim();
  const number = Number(trimmed);
  if (Number.isInteger(number) && number >= 1 && number <= models.length) {
    return models[number - 1];
  }
  // provider id 已由 registry canonical 化；model id 是远端协议标识，可能大小写敏感。
  return models.find((model) => model.ref === trimmed);
}

function selectCredential(
  value: string,
  credentials: readonly { providerId: string; providerName: string }[],
): { providerId: string; providerName: string } | undefined {
  const trimmed = value.trim();
  const folded = trimmed.toLocaleLowerCase('en-US');
  const byId = credentials.find(
    (credential) =>
      credential.providerId.toLocaleLowerCase('en-US') === folded,
  );
  if (byId !== undefined) return byId;
  const number = Number(trimmed);
  if (
    Number.isInteger(number) &&
    number >= 1 &&
    number <= credentials.length
  ) {
    return credentials[number - 1];
  }
  const byName = credentials.filter(
    (credential) =>
      credential.providerName.toLocaleLowerCase('en-US') === folded,
  );
  return byName.length === 1 ? byName[0] : undefined;
}

function sameEndpointAndApi(a: ModelConfig, b: ModelConfig): boolean {
  return a.ref.api === b.ref.api && a.baseURL === b.baseURL;
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'provider 操作失败，请重试';
}
