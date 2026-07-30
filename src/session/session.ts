// Session 编排(规格见 docs/08-session-persistence.md §1/§2):组装 Agent、订阅 AgentEvent、
// 落盘、透传 + 叠加 SessionEvent。agent 核心是无持久化/重试/压缩的纯执行引擎,session 的
// 全部能力走「钩子 + 事件」两条通道,绝不新增 agent 内部状态。
// M7 增量:auto-retry(§5)、compaction(§6)、成本/status(§7)。重试与压缩都不阻塞
// agent 的 emit 链——决策在 agent_end listener 里同步作出,真正的睡眠/摘要/续跑放进
// 一条 detached 串行 op 链(#scheduleOp),否则会与 agent.continue() 死锁。

import type {
  AgentEvent,
  AgentMessage,
  AssistantMessage,
  Context,
  ModelConfig,
  ModelRef,
  StreamFn,
  UserMessage,
} from '../protocol/index.js';
import type { AgentConfig } from '../agent/index.js';
import { Agent } from '../agent/index.js';
import type { CompactionRecord, LoadedSession, SessionListItem } from './store.js';
import {
  defaultSessionDir,
  listSessions,
  loadSession,
  PROTOCOL_VERSION,
  SessionStore,
  STORE_VERSION,
  syntheticSummaryMessage,
} from './store.js';
import type { ModelPricing, SessionUsage } from './usage.js';
import { UsageTracker } from './usage.js';
import type { RetryOptions, ResolvedRetryOptions } from './retry.js';
import { decideRetry, resolveRetryOptions } from './retry.js';
import type { CompactionOptions, ResolvedCompactionOptions } from './compactor.js';
import { HARD_TRUNCATION_SUMMARY, resolveCompactionOptions, selectTailStart, summarize } from './compactor.js';

export type { RetryOptions } from './retry.js';
export type { CompactionOptions } from './compactor.js';

export interface SessionOptions {
  agentConfig: AgentConfig;          // streamFn/model/tools/systemPrompt 由 CLI 组装后传入
  dir?: string;                      // 默认 ~/.coda/sessions
  pricing?: ModelPricing;            // 成本计算;缺省则 costUSD 不计算
  retry?: RetryOptions;              // M7,见 docs/08 §5
  compaction?: CompactionOptions;    // M7,见 docs/08 §6
}

export type SessionEvent =
  | (AgentEvent & { willRetry?: boolean })              // 透传(agent_end 可注解 willRetry,docs/08 §5.3)
  | { type: 'retry_scheduled'; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: 'compaction_start'; reason: 'threshold' | 'overflow' }
  | { type: 'compaction_end'; ok: boolean; droppedMessages: number }
  | { type: 'usage_update'; usage: SessionUsage };

export type SessionListener = (e: SessionEvent) => void | Promise<void>;
export type SessionInteractionState = 'idle' | 'running' | 'retrying' | 'compacting';

/** session 安装到 Agent 的钩子宿主:create/resume 先建 Agent(钩子委托到这里),再由 Session 构造时回填。 */
interface HookHost {
  transform?: (ctx: Context) => Promise<Context>;
  shouldStop?: (ctx: Context) => Promise<boolean>;
}

/** compaction 生效状态(docs/08 §6.2):transformContext 折叠时把前缀替换为该合成摘要。 */
interface CompactionState {
  tailStartId: string;
  synthetic: UserMessage;
}

interface SessionInit {
  id: string;
  store: SessionStore;
  agent: Agent;
  usage: UsageTracker;
  model: ModelConfig;
  streamFn: StreamFn;
  retry: ResolvedRetryOptions;
  compaction: ResolvedCompactionOptions;
  hooks: HookHost;
  userTransform?: (ctx: Context) => Promise<Context>;
  userShouldStop?: (ctx: Context) => Promise<boolean>;
}

export class Session {
  readonly id: string;
  readonly #agent: Agent;
  readonly #store: SessionStore;
  readonly #usage: UsageTracker;
  #model: ModelConfig;
  readonly #streamFn: StreamFn;
  readonly #retry: ResolvedRetryOptions;
  readonly #compaction: ResolvedCompactionOptions;
  readonly #userTransform?: (ctx: Context) => Promise<Context>;
  readonly #userShouldStop?: (ctx: Context) => Promise<boolean>;
  readonly #listeners = new Set<SessionListener>();

  #degraded = false;                 // 磁盘写失败后的内存模式(docs/08 §8)
  #closed = false;

  // ---- retry 状态 ----
  #attempt = 0;                      // 已重试次数;任何成功 turn 归零(docs/08 §5.3)
  #overflowCompactions = 0;          // 连续 overflow 压缩次数;成功 turn 归零(docs/08 §8 无限循环护栏)

  // ---- compaction 状态 ----
  #pendingCompaction: { reason: 'threshold'; contextTokens: number } | undefined;
  #compactionState: CompactionState | undefined;
  #compacting = false;               // 压缩进行中:prompt() 暂存(docs/08 §6.4)
  #stashedPrompts: string[] = [];

  // ---- detached op 链(退避睡眠 / 摘要 + 续跑)----
  #opChain: Promise<void> = Promise.resolve();
  #opController: AbortController | undefined;
  #followUpState: 'idle' | 'retrying' | 'compacting' = 'idle';

  private constructor(init: SessionInit) {
    this.id = init.id;
    this.#agent = init.agent;
    this.#store = init.store;
    this.#usage = init.usage;
    this.#model = init.model;
    this.#streamFn = init.streamFn;
    this.#retry = init.retry;
    this.#compaction = init.compaction;
    this.#userTransform = init.userTransform;
    this.#userShouldStop = init.userShouldStop;

    // 回填钩子(此刻起 agent 的每次采样/turn 边界都经过 session)
    init.hooks.transform = (ctx) => this.#transformContext(ctx);
    init.hooks.shouldStop = (ctx) => this.#shouldStopAfterTurn(ctx);

    // 落盘监听在透传渲染之前注册:agent 的 listener 串行 await,waitForIdle() 返回即全部落盘。
    this.#agent.subscribe(async (e) => {
      const extras = this.#persist(e);
      await this.#onAgentEvent(e, extras);
    });
  }

  static async create(opts: SessionOptions): Promise<Session> {
    const dir = opts.dir ?? defaultSessionDir();
    const { id, store } = SessionStore.createNew(dir);
    // meta 写失败直接 throw(fail-fast):会话尚未开始,静默内存模式会让用户事后 --resume 无迹可寻。
    store.append({
      type: 'meta',
      version: STORE_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      id,
      createdAt: Date.now(),
      cwd: opts.agentConfig.cwd ?? process.cwd(),
      model: opts.agentConfig.model.ref,
    });
    const hooks: HookHost = {};
    const agent = new Agent(withSessionHooks(opts.agentConfig, id, hooks));
    return new Session(buildInit(opts, id, store, agent, new UsageTracker(opts.pricing), hooks));
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
    const hooks: HookHost = {};
    const agent = new Agent({ ...withSessionHooks(opts.agentConfig, id, hooks), initialMessages: loaded.active });
    const usage = new UsageTracker(opts.pricing);
    usage.seed(loaded.active);       // 统计与转录同源

    const session = new Session(buildInit(opts, id, store, agent, usage, hooks));
    // 恢复既有 compaction:折叠状态与运行路径共用同一 transformContext(docs/08 §4.1/§6.2)。
    if (loaded.lastCompaction !== undefined && loaded.active !== loaded.messages) {
      session.#compactionState = {
        tailStartId: loaded.lastCompaction.tailStartId,
        synthetic: syntheticSummaryMessage(loaded.lastCompaction.summary),
      };
    }
    return session;
  }

  static async list(dir?: string): Promise<SessionListItem[]> {
    return listSessions(dir ?? defaultSessionDir());
  }

  /**
   * 门面:compaction 期间暂存(docs/08 §6.4),其余透传 agent.prompt。
   * async 包装把 agent 的同步 throw 规范化为 rejection(Promise 契约);closed 后拒绝。
   */
  async prompt(text: string): Promise<void> {
    this.#assertOpen();
    if (this.#compacting) {
      this.#stashedPrompts.push(text);   // 压缩完成后重放(先 prompt,隐含开跑)
      return;
    }
    if (this.#followUpState === 'retrying') {
      throw new Error('任务正在重试；请使用 steer() 或 followUp()');
    }
    return this.#agent.prompt(text);
  }

  async continue(): Promise<void> {
    this.#assertOpen();
    if (this.interactionState() !== 'idle') {
      throw new Error('任务仍在运行；请先完成或 abort，再继续');
    }
    return this.#agent.continue();
  }

  steer(text: string | UserMessage): void {
    this.#assertOpen();
    this.#agent.steer(text);            // 压缩期间直接透传:agent 队列即暂存区,continue 后自然消费
  }
  followUp(text: string | UserMessage): void {
    this.#assertOpen();
    this.#agent.followUp(text);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error(`Session ${this.id} is closed`);
  }
  abort(): void {
    this.#opController?.abort();        // 取消退避等待 / 摘要请求
    this.#agent.abort();
  }

  usage(): SessionUsage {
    return this.#usage.snapshot();
  }

  /** CLI 命令门禁的权威状态；retry/compaction 期间 Agent 可能短暂为 idle。 */
  interactionState(): SessionInteractionState {
    if (this.#agent.state === 'running') return 'running';
    return this.#followUpState;
  }

  currentModel(): ModelRef {
    return { ...this.#model.ref };
  }

  /**
   * 仅空闲时切换完整 ModelConfig。meta 与历史消息保持原样；下一条 assistant
   * 由实际 adapter 写入新的 ModelRef，因此恢复与审计不会丢失跨模型边界。
   */
  setModel(model: ModelConfig): void {
    this.#assertOpen();
    if (this.interactionState() !== 'idle') {
      throw new Error('任务仍在运行；请先完成或 abort，再切换模型');
    }
    this.#agent.setModel(model);
    this.#model = model;
    this.#attempt = 0;
    this.#overflowCompactions = 0;
  }

  /** CLI /status 渲染用(docs/08 §7):累计成本 + input/output/cacheRead 都在 usage 里。 */
  status(): { usage: SessionUsage; model: ModelRef; sessionId: string } {
    return { usage: this.#usage.snapshot(), model: this.#model.ref, sessionId: this.id };
  }

  get messages(): readonly AgentMessage[] {
    return this.#agent.transcript;
  }

  subscribe(listener: SessionListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** flush 落盘 + 收尾:取消在途 op、等 op 链与 agent 落定,fsync。之后进程可安全退出。 */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#opController?.abort();        // 唤醒退避睡眠 / 取消摘要,让 op 链尽快收束
    await this.#opChain.catch(() => undefined);
    await this.#agent.waitForIdle();
    this.#store.fsync();
  }

  async waitForIdle(): Promise<void> {
    while (true) {
      const op = this.#opChain;
      await Promise.all([op, this.#agent.waitForIdle()]);
      if (op === this.#opChain && this.interactionState() === 'idle') return;
    }
  }

  // ---------- 钩子(session 安装到 Agent)----------

  /** 出站折叠(docs/08 §6.2):compactionState 存在时前缀换成合成摘要;再链用户钩子。convertContext 在 agent 侧接着跑。 */
  async #transformContext(ctx: Context): Promise<Context> {
    let out = ctx;
    const state = this.#compactionState;
    if (state) {
      const idx = ctx.messages.findIndex((m) => m.id === state.tailStartId);
      if (idx >= 0) {
        out = { ...ctx, messages: [state.synthetic, ...ctx.messages.slice(idx)] };
      }
    }
    if (this.#userTransform) out = await this.#userTransform(out);
    return out;
  }

  /** threshold 检测(docs/08 §6.1):超阈值设 pendingCompaction 并让 agent 在 turn 边界体面停下。 */
  async #shouldStopAfterTurn(ctx: Context): Promise<boolean> {
    if (this.#userShouldStop && (await this.#userShouldStop(ctx))) return true;
    if (!this.#compaction.enabled) return false;
    const limits = this.#model.limits;
    if (!limits || !limits.context) return false;   // 无 context 上限:threshold 无从计算(M7 默认不触发)
    const reserveOutput = this.#model.defaults?.maxOutputTokens ?? 0;
    const budget = this.#compaction.threshold * (limits.context - reserveOutput);
    const contextTokens = this.#usage.snapshot().contextTokens;
    if (contextTokens > budget) {
      this.#pendingCompaction = { reason: 'threshold', contextTokens };
      return true;
    }
    return false;
  }

  // ---------- 事件处理:落盘 + 透传 + 重试/压缩决策 ----------

  async #onAgentEvent(e: AgentEvent, extras: SessionEvent[]): Promise<void> {
    // 任何成功 turn(turn_end 且 stopReason 非 error)重置重试与 overflow 压缩计数(docs/08 §5.3/§8)
    if (e.type === 'turn_end' && e.message.stopReason !== 'error') {
      this.#attempt = 0;
      this.#overflowCompactions = 0;
    }

    if (e.type === 'agent_end') {
      await this.#onAgentEnd(e, extras);
      return;
    }

    await this.#fanout(e);
    for (const x of extras) await this.#fanout(x);
  }

  async #onAgentEnd(e: Extract<AgentEvent, { type: 'agent_end' }>, extras: SessionEvent[]): Promise<void> {
    const decision = this.#decideFollowUp(e);

    // 先同步登记 op(设 #opController)再 fanout:否则监听 willRetry/retry_scheduled 的 UI 一旦
    // 立即 abort,会在 #opController 尚未赋值的窗口里落空(op 已排队但 sleep 停在 waitForIdle 后)。
    if (decision.kind === 'retry') {
      this.#scheduleOp('retrying', (signal) => this.#runRetry(decision.delayMs, signal));
    } else if (decision.kind === 'compaction') {
      this.#compacting = true;
      const hard = decision.hardTruncate === true;
      this.#scheduleOp(
        'compacting',
        (signal) => this.#runCompaction(decision.reason, signal, hard),
      );
    } else if (decision.kind === 'fatal') {
      // overflow 无限循环护栏(docs/08 §8):压缩+硬截断后仍 overflow → 报 fatal 停,
      // 透传原 agent_end(error)后追一条 fatal error 事件说明不可恢复。
      await this.#fanout(e);
      for (const x of extras) await this.#fanout(x);
      await this.#fanout({ type: 'error', message: decision.message, fatal: true });
      return;
    }

    if (decision.kind === 'retry') {
      // 透传注解版 agent_end(willRetry)→ retry_scheduled;真正的睡眠 + continue 已进 op 链
      await this.#fanout({ ...e, willRetry: true });
      for (const x of extras) await this.#fanout(x);
      await this.#fanout({
        type: 'retry_scheduled',
        attempt: decision.attempt,
        maxAttempts: this.#retry.maxAttempts,
        delayMs: decision.delayMs,
        errorMessage: decision.errorMessage,
      });
      return;
    }

    // compaction(threshold: agent_end=completed;overflow: agent_end=error)照常透传,压缩在 op 内进行
    await this.#fanout(e);
    for (const x of extras) await this.#fanout(x);
  }

  #decideFollowUp(
    e: Extract<AgentEvent, { type: 'agent_end' }>,
  ):
    | { kind: 'none' }
    | { kind: 'retry'; attempt: number; delayMs: number; errorMessage: string }
    | { kind: 'compaction'; reason: 'threshold' | 'overflow'; hardTruncate?: boolean }
    | { kind: 'fatal'; message: string } {
    if (e.reason === 'completed') {
      const pending = this.#pendingCompaction;
      this.#pendingCompaction = undefined;
      return pending ? { kind: 'compaction', reason: pending.reason } : { kind: 'none' };
    }
    if (e.reason === 'aborted') {
      this.#pendingCompaction = undefined;
      return { kind: 'none' };
    }
    // reason === 'error'
    this.#pendingCompaction = undefined;
    const last = lastAssistant(e.messages);
    if (last === undefined) return { kind: 'none' };
    // overflow → 被动压缩(不重试,docs/08 §6.1);前提:压缩启用且模型有 context 上限。
    // 无限循环护栏(docs/08 §8):overflow error 不更新 contextTokens,若尾部单 turn 过大,
    // 压缩落在同一切点、dropped 前缀不变 → 每轮重压缩同样内容无限循环。升级序列:
    // 第 1 次 summarize 压缩 → 仍 overflow 则第 2 次强制硬截断一次 → 仍 overflow 则 fatal。
    if (last.errorDetails?.kind === 'overflow' && this.#compaction.enabled && this.#model.limits?.context) {
      this.#overflowCompactions++;
      if (this.#overflowCompactions >= 3) {
        return {
          kind: 'fatal',
          message:
            'Context overflow persists after compaction and hard truncation. ' +
            'The remaining conversation is too large for this model — switch to a model with a larger context window.',
        };
      }
      return { kind: 'compaction', reason: 'overflow', hardTruncate: this.#overflowCompactions >= 2 };
    }
    const d = decideRetry(last, this.#attempt, this.#retry);
    if (d.retry) {
      const attempt = ++this.#attempt;
      return { kind: 'retry', attempt, delayMs: d.delayMs, errorMessage: last.errorMessage ?? 'provider error' };
    }
    return { kind: 'none' };
  }

  // ---------- detached op(脱离 emit 链,避免与 continue() 死锁)----------

  #scheduleOp(
    state: 'retrying' | 'compacting',
    fn: (signal: AbortSignal) => Promise<void>,
  ): void {
    const controller = new AbortController();
    this.#opController = controller;
    this.#followUpState = state;
    const prev = this.#opChain;
    this.#opChain = (async () => {
      await prev.catch(() => undefined);          // 串行:上一个 op 收束后再动作
      try {
        // 只在 closed 时早退;aborted 不早退——交给 fn 处理(#runRetry 的 sleep 会立即
        // 返回 aborted 并补发「retry cancelled」error 事件,docs/08 §5.3;早退会漏发该事件,
        // 让监听 willRetry 的 UI 永久停在「重试中」)。
        if (this.#closed) return;
        await this.#agent.waitForIdle();           // 触发本 op 的那次 run 落定 → idle
        if (this.#closed) return;
        await fn(controller.signal);
      } catch (err) {
        await this.#fanout({ type: 'error', message: `session follow-up failed: ${String(err)}`, fatal: false });
      } finally {
        if (this.#opController === controller) {
          this.#opController = undefined;
          this.#followUpState = 'idle';
        }
      }
    })();
  }

  /** 退避睡眠后 continue(重试 = continue,docs/08 §5.3);退避期间 abort → 补发 error 事件说明重试已取消。 */
  async #runRetry(delayMs: number, signal: AbortSignal): Promise<void> {
    let aborted: boolean;
    try {
      aborted = await this.#retry.sleep(delayMs, signal);
    } catch (err) {
      await this.#fanout({
        type: 'error',
        message: `retry sleep failed: ${String(err)}`,
        fatal: true,
      });
      return;
    }
    if (aborted) {
      if (!this.#closed) {
        await this.#fanout({ type: 'error', message: 'retry cancelled by abort', fatal: false });
      }
      return;
    }
    if (this.#closed) return;
    await this.#agent.continue();
  }

  /** 摘要 → 追加 CompactionRecord + 设 compactionState → 续跑(docs/08 §6.3/§6.5)。
   *  hardTruncate:overflow 压缩后仍 overflow 的第二次,跳过 summarize 直接硬截断(§8)。 */
  async #runCompaction(reason: 'threshold' | 'overflow', signal: AbortSignal, hardTruncate = false): Promise<void> {
    await this.#fanout({ type: 'compaction_start', reason });

    const transcript = [...this.#agent.transcript];
    const contextTokens = this.#usage.snapshot().contextTokens;
    const keepBudget = contextTokens * this.#compaction.keepRatio;
    const tailStart = selectTailStart(transcript, keepBudget);
    const tailMsg = transcript[tailStart];
    const dropped = transcript.slice(0, tailStart);

    let summary: string;
    if (hardTruncate) {
      // 压缩后仍 overflow:不再 summarize(会再吃一次超限上下文),直接硬截断降级
      summary = HARD_TRUNCATION_SUMMARY;
    } else {
      try {
        summary = await summarize(this.#streamFn, this.#model, dropped, {
          summaryMaxTokens: this.#compaction.summaryMaxTokens,
          signal,
        });
      } catch (err) {
        if (signal.aborted) {
          // abort:放弃本次压缩,状态回滚不写 record(docs/08 §6.4)
          this.#stashedPrompts = [];
          await this.#fanout({ type: 'compaction_end', ok: false, droppedMessages: 0 });
          this.#compacting = false;
          await this.#resumeAfterCompaction(false);
          return;
        }
        if (reason === 'threshold') {
          // 主动触发失败:放弃,原上下文继续(docs/08 §6.5),下次 turn_end 会再触发
          console.error(`[compaction] threshold summarize failed, abandoning: ${String(err)}`);
          await this.#fanout({ type: 'compaction_end', ok: false, droppedMessages: 0 });
          this.#compacting = false;
          await this.#resumeAfterCompaction();
          return;
        }
        // overflow 被动失败:不能用原上下文(会再 400)→ 硬截断(docs/08 §6.5)
        console.error(`[compaction] overflow summarize failed, hard-truncating: ${String(err)}`);
        summary = HARD_TRUNCATION_SUMMARY;
      }
    }

    if (tailMsg === undefined) {
      // 空转录极端:无可折叠,放弃
      await this.#fanout({ type: 'compaction_end', ok: false, droppedMessages: 0 });
      this.#compacting = false;
      await this.#resumeAfterCompaction();
      return;
    }

    const record: CompactionRecord = {
      type: 'compaction',
      id: `cmp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      tailStartId: tailMsg.id,
      summary,
      contextTokensBefore: contextTokens,
    };
    const persistExtras = this.#append(record);
    this.#compactionState = { tailStartId: tailMsg.id, synthetic: syntheticSummaryMessage(summary) };
    for (const x of persistExtras) await this.#fanout(x);
    await this.#fanout({ type: 'compaction_end', ok: true, droppedMessages: dropped.length });
    this.#compacting = false;
    await this.#resumeAfterCompaction();
  }

  /** 压缩收尾:优先重放暂存 prompt,否则 continue 续跑(自然结束的 turn 则无需续跑)。 */
  async #resumeAfterCompaction(continueIfEmpty = true): Promise<void> {
    const stashed = this.#stashedPrompts;
    this.#stashedPrompts = [];
    if (stashed.length > 0) {
      for (const text of stashed) {
        if (this.#closed) return;
        await this.#agent.prompt(text);
      }
      return;
    }
    if (this.#closed || !continueIfEmpty) return;
    try {
      await this.#agent.continue();
    } catch (err) {
      if (!/nothing to continue/i.test(String(err))) throw err;
      // 压缩发生在自然结束的 turn 之后:无残局可续,折叠对下一次输入生效
    }
  }

  // ---------- 落盘 ----------

  /** 处理落盘与统计,返回随后要按序发出的旁路事件(在主事件 fanout 之后)。 */
  #persist(e: AgentEvent): SessionEvent[] {
    const extras: SessionEvent[] = [];
    if (e.type === 'message_end') {
      let message = sanitizeForDisk(e.message);
      if (message.role === 'assistant') {
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

// ---------- 装配辅助 ----------

/** 用 session 的钩子委托覆盖 agentConfig 的 transformContext/shouldStopAfterTurn(用户自带的钩子被 session 链式保留)。 */
function withSessionHooks(agentConfig: AgentConfig, id: string, hooks: HookHost): AgentConfig {
  return {
    ...agentConfig,
    truncationScope: id,   // 落盘 scope = sessionId(docs/07 §1.6)
    transformContext: (ctx) => (hooks.transform ? hooks.transform(ctx) : Promise.resolve(ctx)),
    shouldStopAfterTurn: (ctx) => (hooks.shouldStop ? hooks.shouldStop(ctx) : Promise.resolve(false)),
  };
}

function buildInit(
  opts: SessionOptions,
  id: string,
  store: SessionStore,
  agent: Agent,
  usage: UsageTracker,
  hooks: HookHost,
): SessionInit {
  const init: SessionInit = {
    id,
    store,
    agent,
    usage,
    model: opts.agentConfig.model,
    streamFn: opts.agentConfig.streamFn,
    retry: resolveRetryOptions(opts.retry),
    compaction: resolveCompactionOptions(opts.compaction),
    hooks,
  };
  if (opts.agentConfig.transformContext) init.userTransform = opts.agentConfig.transformContext;
  if (opts.agentConfig.shouldStopAfterTurn) init.userShouldStop = opts.agentConfig.shouldStopAfterTurn;
  return init;
}

function lastAssistant(messages: readonly AgentMessage[]): AssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as AgentMessage;
    if (m.role === 'assistant') return m;
  }
  return undefined;
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
