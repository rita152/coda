// 交互 CLI 的可空 Session 门面。没有有效模型时它保持完全无 Session 状态；
// 只有恢复了用户显式选择，或 /model 成功选中模型后，才调用工厂创建/恢复 Session。

import type {
  AgentMessage,
  ModelConfig,
  ModelRef,
  UserMessage,
} from '../protocol/index.js';
import type {
  CliInteractionState as SessionInteractionState,
  CliSessionEvent as SessionEvent,
  CliSessionListener as SessionListener,
  CliSessionUsage as SessionUsage,
} from './frontend-types.js';
import type { Session } from '../session/index.js';
import { sanitizeTerminalError } from './terminal-sanitize.js';

export interface InteractiveSession {
  interactionState(): SessionInteractionState;
  currentModel(): ModelRef | undefined;
  setModel(model: ModelConfig): void | Promise<void>;
  clearModel(): void;
  usage(): SessionUsage;
  readonly messages: readonly AgentMessage[];
  subscribe(listener: SessionListener): () => void;
  subscribeSessionAttached(
    listener: (messages: readonly AgentMessage[]) => void | Promise<void>,
  ): () => void;
  prompt(text: string): Promise<void>;
  steer(text: string | UserMessage): void;
  followUp(text: string | UserMessage): void;
  abort(): void;
  close(): Promise<void>;
}

/** TUI 控制器只依赖此公共门面；真实 Session 也结构化兼容，便于库级测试。 */
export type CliSession = Pick<
  InteractiveSession,
  | 'interactionState'
  | 'currentModel'
  | 'usage'
  | 'messages'
  | 'subscribe'
  | 'prompt'
  | 'steer'
  | 'followUp'
  | 'abort'
  | 'close'
>;

export interface InteractiveRuntimeOptions {
  initialModel?: ModelConfig;
  createSession: (model: ModelConfig) => Promise<Session>;
}

const EMPTY_USAGE: SessionUsage = {
  cumulative: { input: 0, output: 0 },
  turns: 0,
  contextTokens: 0,
};

class InteractiveRuntimeClosedError extends Error {
  constructor() {
    super('interactive runtime is closed');
  }
}

export class InteractiveRuntime implements InteractiveSession {
  readonly #createSession: InteractiveRuntimeOptions['createSession'];
  readonly #listeners = new Set<SessionListener>();
  readonly #attachmentListeners = new Set<
    (messages: readonly AgentMessage[]) => void | Promise<void>
  >();

  #model: ModelConfig | undefined;
  #session: Session | undefined;
  #sessionCreation: Promise<Session> | undefined;
  #unsubscribeSession: (() => void) | undefined;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(options: InteractiveRuntimeOptions) {
    this.#createSession = options.createSession;
    this.#model = options.initialModel;
  }

  /** 启动时只在确有有效的“最近显式选择”时装配 Session。 */
  async initialize(): Promise<void> {
    if (this.#model !== undefined) await this.#ensureSession(this.#model);
  }

  interactionState(): SessionInteractionState {
    return this.#session?.interactionState() ?? 'idle';
  }

  currentModel(): ModelRef | undefined {
    return this.#model === undefined ? undefined : { ...this.#model.ref };
  }

  async setModel(model: ModelConfig): Promise<void> {
    this.#assertOpen();
    if (this.interactionState() !== 'idle') {
      throw new Error('任务仍在运行；请先完成或 abort，再切换模型');
    }
    if (this.#session === undefined) {
      const session = await this.#ensureSession(model);
      this.#assertOpen();
      if (this.#model !== model) {
        if (this.interactionState() !== 'idle') {
          throw new Error('任务仍在运行；请先完成或 abort，再切换模型');
        }
        session.setModel(model);
        this.#model = model;
      }
      return;
    }
    this.#session.setModel(model);
    this.#model = model;
  }

  clearModel(): void {
    this.#assertOpen();
    if (this.interactionState() !== 'idle') {
      throw new Error('任务仍在运行；请先完成或 abort，再退出 provider');
    }
    this.#model = undefined;
  }

  usage(): SessionUsage {
    const usage = this.#session?.usage();
    return usage === undefined
      ? {
          ...EMPTY_USAGE,
          cumulative: { ...EMPTY_USAGE.cumulative },
        }
      : usage;
  }

  get messages(): readonly AgentMessage[] {
    return this.#session?.messages ?? [];
  }

  subscribe(listener: SessionListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  subscribeSessionAttached(
    listener: (messages: readonly AgentMessage[]) => void | Promise<void>,
  ): () => void {
    this.#attachmentListeners.add(listener);
    return () => {
      this.#attachmentListeners.delete(listener);
    };
  }

  async prompt(text: string): Promise<void> {
    this.#assertOpen();
    const model = this.#model;
    if (model === undefined) {
      throw new Error('尚未选择模型；请先运行 /login 配置 provider，再运行 /model');
    }
    const session = await this.#ensureSession(model);
    return session.prompt(text);
  }

  steer(text: string | UserMessage): void {
    this.#assertOpen();
    const session = this.#session;
    if (session === undefined || this.#model === undefined) {
      throw new Error('尚未选择模型；请先运行 /model');
    }
    session.steer(text);
  }

  followUp(text: string | UserMessage): void {
    this.#assertOpen();
    const session = this.#session;
    if (session === undefined || this.#model === undefined) {
      throw new Error('尚未选择模型；请先运行 /model');
    }
    session.followUp(text);
  }

  abort(): void {
    this.#session?.abort();
  }

  async close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = this.#finishClose();
    return this.#closePromise;
  }

  async #ensureSession(model: ModelConfig): Promise<Session> {
    this.#assertOpen();
    if (this.#session !== undefined) return this.#session;
    const pending = this.#sessionCreation;
    if (pending !== undefined) return pending;

    // 先发布 single-flight promise，再进用户工厂，避免工厂同步重入 close() 时漏等创建。
    const creation = Promise.resolve().then(() => this.#createAndAttach(model));
    this.#sessionCreation = creation;
    try {
      return await creation;
    } finally {
      if (this.#sessionCreation === creation) this.#sessionCreation = undefined;
    }
  }

  async #createAndAttach(model: ModelConfig): Promise<Session> {
    const session = await this.#createSession(model);
    if (this.#closed) {
      await session.close();
      throw new InteractiveRuntimeClosedError();
    }

    let unsubscribe: () => void;
    try {
      unsubscribe = session.subscribe((event: SessionEvent) =>
        this.#fanoutSessionEvent(event),
      );
    } catch (error) {
      await session.close();
      throw error;
    }
    if (this.#closed) {
      unsubscribe();
      await session.close();
      throw new InteractiveRuntimeClosedError();
    }

    // subscribe、Session/model 提交之间没有 await：close 不可能观察到半 attach 状态。
    this.#session = session;
    this.#unsubscribeSession = unsubscribe;
    this.#model = model;
    const messages = [...session.messages];
    for (const listener of [...this.#attachmentListeners]) {
      if (this.#closed) break;
      try {
        await listener(messages);
      } catch (error) {
        console.error(
          `[interactive runtime] attachment listener threw (ignored): ${sanitizeTerminalError(error)}`,
        );
      }
    }
    this.#assertOpen();
    return session;
  }

  async #fanoutSessionEvent(event: SessionEvent): Promise<void> {
    for (const listener of [...this.#listeners]) {
      try {
        await listener(event);
      } catch (error) {
        console.error(
          `[interactive runtime] session listener threw (ignored): ${sanitizeTerminalError(error)}`,
        );
      }
    }
  }

  async #finishClose(): Promise<void> {
    try {
      const session = this.#session;
      if (session !== undefined) {
        await session.close();
        return;
      }
      const creation = this.#sessionCreation;
      if (creation !== undefined) {
        try {
          await creation;
        } catch (error) {
          if (!(error instanceof InteractiveRuntimeClosedError)) throw error;
        }
      }
    } finally {
      this.#unsubscribeSession?.();
      this.#unsubscribeSession = undefined;
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new InteractiveRuntimeClosedError();
  }
}
