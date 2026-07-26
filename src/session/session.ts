// Session 编排(规格见 docs/08-session-persistence.md §1/§2):组装 Agent、订阅 AgentEvent、
// 落盘、透传 + 叠加 SessionEvent。agent 核心是无持久化/重试/压缩的纯执行引擎,session 的
// 全部能力走「钩子 + 事件」两条通道,绝不新增 agent 内部状态。本体只做编排(目标 <300 行);
// retry/compaction 协作者在 M7 接入。

import type {
  AgentEvent,
  AgentMessage,
  Context,
  UserMessage,
} from '../protocol/index.js';
import type { AgentConfig } from '../agent/index.js';
import { Agent } from '../agent/index.js';
import type { LoadedSession, SessionListItem } from './store.js';
import {
  defaultSessionDir,
  listSessions,
  loadSession,
  PROTOCOL_VERSION,
  SessionStore,
  STORE_VERSION,
} from './store.js';
import type { ModelPricing, SessionUsage } from './usage.js';
import { UsageTracker } from './usage.js';

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}
export interface CompactionOptions {
  enabled?: boolean;
  threshold?: number;
  keepRatio?: number;
  summaryMaxTokens?: number;
}

export interface SessionOptions {
  agentConfig: AgentConfig;          // streamFn/model/tools/systemPrompt 由 CLI 组装后传入
  dir?: string;                      // 默认 ~/.coda/sessions
  pricing?: ModelPricing;            // 成本计算;缺省则 costUSD 不计算
  retry?: RetryOptions;              // M7
  compaction?: CompactionOptions;    // M7
}

export type SessionEvent =
  | AgentEvent
  | { type: 'retry_scheduled'; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: 'compaction_start'; reason: 'threshold' | 'overflow' }
  | { type: 'compaction_end'; ok: boolean; droppedMessages: number }
  | { type: 'usage_update'; usage: SessionUsage };

export type SessionListener = (e: SessionEvent) => void | Promise<void>;

export class Session {
  readonly id: string;
  readonly agent: Agent;             // 暴露给需要直接访问的场景(测试);CLI 正常只用门面

  readonly #store: SessionStore;
  readonly #usage: UsageTracker;
  readonly #listeners = new Set<SessionListener>();
  #degraded = false;                 // 磁盘写失败后的内存模式(docs/08 §8)
  #closed = false;

  private constructor(id: string, store: SessionStore, agent: Agent, usage: UsageTracker) {
    this.id = id;
    this.#store = store;
    this.agent = agent;
    this.#usage = usage;

    // 落盘监听在透传渲染之前注册:agent 的 listener 串行 await,waitForIdle() 返回即全部落盘。
    // 旁路事件(usage_update/降级 error)与主事件走同一条 await 链:乱序/重入/close 不等待
    // 都是核查证实过的缺陷形态,保序是硬要求。
    this.agent.subscribe(async (e) => {
      const extras = this.#persist(e);
      await this.#fanout(e);
      for (const x of extras) await this.#fanout(x);
    });
  }

  static async create(opts: SessionOptions): Promise<Session> {
    const dir = opts.dir ?? defaultSessionDir();
    const { id, store } = SessionStore.createNew(dir);
    // meta 写失败直接 throw(fail-fast):会话尚未开始,静默内存模式会让用户事后
    // --resume 得到 Session not found 且毫无提示(核查发现);运行中失败才走降级路径。
    store.append({
      type: 'meta',
      version: STORE_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      id,
      createdAt: Date.now(),
      cwd: opts.agentConfig.cwd ?? process.cwd(),
      model: opts.agentConfig.model.ref,
    });
    const agent = new Agent(opts.agentConfig);
    return new Session(id, store, agent, new UsageTracker(opts.pricing));
  }

  static async resume(id: string, opts: SessionOptions): Promise<Session> {
    const dir = opts.dir ?? defaultSessionDir();
    const loaded: LoadedSession = loadSession(dir, id);
    const store = new SessionStore(dir, id);
    store.repairTail();              // 崩溃残片先修复,否则后续 append 会粘行成中部损坏
    if (loaded.droppedCorruptTail) {
      console.error(`[session] ${id}: dropped a corrupt trailing record (crash recovery)`);
    }
    if (loaded.lastCompaction !== undefined && loaded.active === loaded.messages) {
      console.error(`[session] ${id}: compaction record ignored (tailStartId not found)`);
    }
    const agent = new Agent({ ...opts.agentConfig, initialMessages: loaded.active });
    const usage = new UsageTracker(opts.pricing);
    usage.seed(loaded.active);       // 统计与转录同源
    return new Session(id, store, agent, usage);
  }

  static async list(dir?: string): Promise<SessionListItem[]> {
    return listSessions(dir ?? defaultSessionDir());
  }

  /**
   * 门面:M5 直接透传;M7 在 compaction 期间暂存(docs/08 §6.4)。
   * async 包装把 agent 的同步 throw 规范化为 rejection(Promise 契约);closed 后拒绝。
   */
  async prompt(text: string): Promise<void> {
    this.#assertOpen();
    return this.agent.prompt(text);
  }
  steer(text: string | UserMessage): void {
    this.#assertOpen();
    this.agent.steer(text);
  }
  followUp(text: string | UserMessage): void {
    this.#assertOpen();
    this.agent.followUp(text);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error(`Session ${this.id} is closed`);
  }
  abort(): void {
    this.agent.abort();              // M7:同时取消退避等待/压缩请求
  }

  usage(): SessionUsage {
    return this.#usage.snapshot();
  }

  get messages(): readonly AgentMessage[] {
    return this.agent.transcript;
  }

  subscribe(listener: SessionListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** flush 落盘 + 收尾:close() 后进程可安全退出(waitForIdle 返回即全部落盘)。 */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.agent.waitForIdle();
    this.#store.fsync();
  }

  // ---------- 内部 ----------

  /** 处理落盘与统计,返回随后要按序发出的旁路事件(在主事件 fanout 之后)。 */
  #persist(e: AgentEvent): SessionEvent[] {
    const extras: SessionEvent[] = [];
    // 每个 message_end 追加一条 MessageRecord(不等 agent_end——崩溃恢复到最后一条完整消息);
    // 流式期间(message_update)不落盘,message_end 一次性写终态。
    if (e.type === 'message_end') {
      let message = sanitizeForDisk(e.message);
      if (message.role === 'assistant') {
        // costUSD 回填到落盘消息(docs/08 §7.3):恢复时统计与转录同源,价格变动不漂移
        const cost = message.usage.costUSD ?? this.#usage.cost(message.usage);
        if (cost !== undefined && message.usage.costUSD === undefined) {
          message = { ...message, usage: { ...message.usage, costUSD: cost } };
        }
        this.#usage.add(message);
        extras.push({ type: 'usage_update', usage: this.#usage.snapshot() });
      }
      extras.push(...this.#append({ type: 'message', message }));
    }
    if (e.type === 'agent_end') this.#store.fsync();
    return extras;
  }

  #append(record: Parameters<SessionStore['append']>[0]): SessionEvent[] {
    if (this.#degraded) return [];
    try {
      this.#store.append(record);
      return [];
    } catch (err) {
      // 磁盘满等:降级为内存模式继续跑,发 non-fatal error(docs/08 §8)
      this.#degraded = true;
      return [
        {
          type: 'error',
          message: `session persistence failed, continuing in memory-only mode: ${String(err)}`,
          fatal: false,
        },
      ];
    }
  }

  async #fanout(e: SessionEvent): Promise<void> {
    for (const l of [...this.#listeners]) {
      try {
        await l(e);
      } catch (err) {
        console.error('[session] listener threw (ignored):', err);
      }
    }
  }
}

/** details 不可 JSON 序列化时置 undefined 并告警,不得让写盘失败(docs/08 §3.2)。 */
function sanitizeForDisk(m: AgentMessage): AgentMessage {
  if (m.role !== 'tool_result' || m.details === undefined) return m;
  try {
    JSON.stringify(m.details);
    return m;
  } catch {
    console.error(`[session] tool_result ${m.id} details not serializable, dropped from disk record`);
    return { ...m, details: undefined };
  }
}

/** compaction 折叠上下文的钩子形态(M7 接线);M5 导出仅为类型完整性。 */
export type TransformContextHook = (ctx: Context) => Promise<Context>;
