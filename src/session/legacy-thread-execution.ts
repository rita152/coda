// Legacy Agent execution adapter used by the standalone ThreadRuntime composition. Persistence,
// retry and compaction decisions are delegated to narrow collaborators; this class preserves the
// v1 Agent settlement/JSONL projection while canonical mailbox identity lives in ThreadRuntime.

import type {
  AgentEvent,
  AgentMessage,
  AssistantMessage,
  Context,
  ModelConfig,
  ModelRef,
  QueuedMessage,
  StreamFn,
  ToolResultMessage,
  UserMessage,
} from '../protocol/index.js';
import { strictJsonSnapshot } from '../protocol/index.js';
import type { AgentConfig } from '../agent/index.js';
import { Agent } from '../agent/index.js';
import type { CompactionRecord, LoadedSession, MetaRecord, SessionRecord } from './store.js';
import {
  defaultSessionDir,
  loadSession,
  PROTOCOL_VERSION,
  SessionStore,
  STORE_VERSION,
} from './store.js';
import type { ModelPricing, SessionUsage } from './usage.js';
import { UsageTracker } from './usage.js';
import type { RetryOptions } from './retry.js';
import { RetryCoordinator } from './retry-coordinator.js';
import type { CompactionOptions } from './compactor.js';
import { HARD_TRUNCATION_SUMMARY } from './compactor.js';
import { CompactionCoordinator } from './compaction-coordinator.js';
import type { SessionObserverPort } from './standalone-session-events.js';

export type { RetryOptions } from './retry.js';
export type { CompactionOptions } from './compactor.js';

export interface SessionOptions {
  agentConfig: AgentConfig;          // streamFn/model/tools/systemPrompt 由 CLI 组装后传入
  dir?: string;                      // 默认 ~/.coda/sessions
  pricing?: ModelPricing;            // 成本计算;缺省则 costUSD 不计算
  retry?: RetryOptions;              // M7,见 docs/08 §5
  compaction?: CompactionOptions;    // M7,见 docs/08 §6
  /** @internal Runtime legacy driver 的 awaited canonical-before-mirror gate；普通调用方勿用。 */
  authoritativeEventSink?: (events: SessionAuthoritativeEventBatch) => Promise<void>;
  /** @internal Runtime-only guard for detecting writes outside the canonical mirror path. */
  runtimeMirrorGuard?: SessionRuntimeMirrorGuard;
  /** @internal Canonical queue snapshot restored silently before attachment activation. */
  runtimeQueueSeed?: {
    readonly steering: readonly QueuedMessage[];
    readonly followUp: readonly QueuedMessage[];
  };
  /** @internal Private standalone observer pump; never used as an authoritative writer. */
  observerPort?: SessionObserverPort;
  /** @internal Preserve canonical legacy-driver audit usage while direct v1 resume keeps its view. */
  legacyRuntimeAttachment?: boolean;
}

export interface SessionRuntimeMirrorGuard {
  assertCurrent(): void;
  beforeAppend(record: SessionRecord): void;
  afterAppend(record: SessionRecord): void;
}

export type SessionEvent =
  | (AgentEvent & { willRetry?: boolean })              // 透传(agent_end 可注解 willRetry,docs/08 §5.3)
  | { type: 'retry_scheduled'; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: 'compaction_start'; reason: 'threshold' | 'overflow' }
  | { type: 'compaction_end'; ok: boolean; droppedMessages: number }
  | { type: 'usage_update'; usage: SessionUsage };

export type SessionListener = (e: SessionEvent) => void | Promise<void>;
export type SessionInteractionState = 'idle' | 'running' | 'retrying' | 'compacting';
export type SessionAuthoritativeEventBatch = readonly [SessionEvent, ...SessionEvent[]];

/** Narrow execution surface composed by StandaloneSessionHost and the canonical legacy driver. */
export interface LegacyThreadExecutionPort {
  readonly id: string;
  readonly messages: readonly AgentMessage[];
  prompt(text: string): Promise<void>;
  continue(): Promise<void>;
  steer(text: string | UserMessage): void;
  followUp(text: string | UserMessage): void;
  abort(): void;
  usage(): SessionUsage;
  interactionState(): SessionInteractionState;
  runtimeFollowUpState(): 'idle' | 'retrying' | 'compacting';
  /** @internal Canonical mailbox owns the activity that must follow the current compaction. */
  deferCompactionResumeToMailbox?(): void;
  currentModel(): ModelRef;
  setModel(model: ModelConfig): void;
  status(): { usage: SessionUsage; model: ModelRef; sessionId: string };
  compactionCheckpoint(): Readonly<CompactionRecord> | undefined;
  close(): Promise<void>;
  waitForIdle(): Promise<void>;
}

/** session 安装到 Agent 的钩子宿主:create/resume 先建 Agent(钩子委托到这里),再由 Session 构造时回填。 */
interface HookHost {
  transform?: (ctx: Context) => Promise<Context>;
  shouldStop?: (ctx: Context) => Promise<boolean>;
}

interface SessionInit {
  id: string;
  store: SessionStore;
  agent: Agent;
  usage: UsageTracker;
  model: ModelConfig;
  streamFn: StreamFn;
  retry: RetryCoordinator;
  compaction: CompactionCoordinator;
  hooks: HookHost;
  userTransform?: (ctx: Context) => Promise<Context>;
  userShouldStop?: (ctx: Context) => Promise<boolean>;
  authoritativeEventSink?: (events: SessionAuthoritativeEventBatch) => Promise<void>;
  runtimeMirrorGuard?: SessionRuntimeMirrorGuard;
  observerPort?: SessionObserverPort;
}

export class LegacyThreadExecution implements LegacyThreadExecutionPort {
  readonly id: string;
  readonly #agent: Agent;
  readonly #store: SessionStore;
  readonly #usage: UsageTracker;
  #model: ModelConfig;
  readonly #streamFn: StreamFn;
  readonly #retry: RetryCoordinator;
  readonly #compaction: CompactionCoordinator;
  readonly #userTransform?: (ctx: Context) => Promise<Context>;
  readonly #userShouldStop?: (ctx: Context) => Promise<boolean>;
  readonly #authoritativeEventSink?: (events: SessionAuthoritativeEventBatch) => Promise<void>;
  readonly #runtimeMirrorGuard?: SessionRuntimeMirrorGuard;
  readonly #observerPort?: SessionObserverPort;

  #degraded = false;                 // 磁盘写失败后的内存模式(docs/08 §8)
  #closed = false;
  #authoritativeFailure: Error | undefined;

  // ---- retry 状态 ----
  // ---- compaction 状态 ----
  #compacting = false;               // 压缩进行中:prompt() 暂存(docs/08 §6.4)
  #stashedPrompts: string[] = [];

  // ---- detached op 链(退避睡眠 / 摘要 + 续跑)----
  #opChain: Promise<void> = Promise.resolve();
  #opController: AbortController | undefined;
  #followUpState: 'idle' | 'retrying' | 'compacting' = 'idle';
  #mailboxOwnsNextActivity = false;

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
    this.#authoritativeEventSink = init.authoritativeEventSink;
    this.#runtimeMirrorGuard = init.runtimeMirrorGuard;
    this.#observerPort = init.observerPort;

    // 回填钩子(此刻起 agent 的每次采样/turn 边界都经过 session)
    init.hooks.transform = (ctx) => this.#transformContext(ctx);
    init.hooks.shouldStop = (ctx) => this.#shouldStopAfterTurn(ctx);

    // 落盘监听在透传渲染之前注册:agent 的 listener 串行 await,waitForIdle() 返回即全部落盘。
    this.#agent.subscribe(async (e) => {
      if (this.#authoritativeEventSink !== undefined) {
        // Runtime path:authoritative commit must precede the v1 mirror and public observers.
        // Agent 的通用 Emitter 会隔离 listener 异常，因此这里必须把提交失败收进一条
        // Session 自己拥有的 fatal lane；否则 Runtime 会把失败误判成一次成功的 run。
        try {
          this.#throwAuthoritativeFailure();
          // Runtime canonical and the legacy JSONL mirror must be derived from exactly the
          // same JSON-safe, pricing-complete snapshot. Commit both the primary event and its
          // usage projection before appending the mirror so a crash cannot leave canonical
          // state behind a mirror record it already exposed.
          const prepared = this.#prepareForPersistence(e);
          if (prepared.event.type === 'message_end') {
            const committed: SessionAuthoritativeEventBatch = [prepared.event, ...prepared.extras];
            await this.#commitAuthoritative(committed);
            this.#throwAuthoritativeFailure();
            const persistenceErrors = this.#persistPrepared(prepared.event);
            this.#notifyListeners(committed);
            for (const error of persistenceErrors) await this.#fanout(error);
          } else {
            await this.#onAgentEvent(prepared.event, prepared.extras);
            this.#throwAuthoritativeFailure();
            const persistenceErrors = this.#persistPrepared(prepared.event);
            for (const error of persistenceErrors) await this.#fanout(error);
          }
        } catch (error) {
          this.#recordAuthoritativeFailure(error);
        }
        return;
      }
      const extras = this.#persist(e);
      await this.#onAgentEvent(e, extras);
    });
  }

  /**
   * @internal Runtime legacy adapter only. Stable ids make driver create idempotent across a
   * create-backend -> bind crash window; ordinary callers should keep using create().
   */
  static async createWithId(
    id: string,
    opts: SessionOptions,
    runtimeMeta?: MetaRecord,
  ): Promise<LegacyThreadExecution> {
    const dir = opts.dir ?? defaultSessionDir();
    const meta = runtimeMeta ?? {
      type: 'meta' as const,
      version: STORE_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      id,
      createdAt: Date.now(),
      cwd: opts.agentConfig.cwd ?? process.cwd(),
      model: opts.agentConfig.model.ref,
    };
    if (meta.id !== id || meta.type !== 'meta' || meta.version !== STORE_VERSION) {
      throw new Error('Runtime Session meta does not match its deterministic id');
    }
    const claimed = SessionStore.initializeNamed(dir, id, meta);
    if (!claimed.created) return LegacyThreadExecution.resume(id, opts);
    const hooks: HookHost = {};
    const agent = new Agent(withSessionHooks(
      opts.agentConfig,
      id,
      hooks,
      opts.runtimeQueueSeed,
      opts.runtimeMirrorGuard,
    ));
    return new LegacyThreadExecution(buildInit(
      opts,
      id,
      claimed.store,
      agent,
      new UsageTracker(opts.pricing),
      hooks,
    ));
  }

  static async resume(id: string, opts: SessionOptions): Promise<LegacyThreadExecution> {
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
    const agent = new Agent({
      ...withSessionHooks(opts.agentConfig, id, hooks, opts.runtimeQueueSeed, opts.runtimeMirrorGuard),
      initialMessages: loaded.active,
    });
    const usage = new UsageTracker(opts.pricing);
    // Standalone keeps the exported v1 observable baseline; Runtime canonical recovery needs
    // full audit usage because its checkpoint transcript is the source of truth.
    usage.seed(opts.legacyRuntimeAttachment === true ? loaded.messages : loaded.active);

    const session = new LegacyThreadExecution(buildInit(opts, id, store, agent, usage, hooks));
    // 恢复既有 compaction:折叠状态与运行路径共用同一 transformContext(docs/08 §4.1/§6.2)。
    if (loaded.lastCompaction !== undefined && loaded.active !== loaded.messages) {
      session.#compaction.restore(loaded.lastCompaction);
    }
    return session;
  }

  /**
   * 门面:compaction 期间暂存(docs/08 §6.4),其余透传 agent.prompt。
   * async 包装把 agent 的同步 throw 规范化为 rejection(Promise 契约);closed 后拒绝。
   */
  async prompt(text: string): Promise<void> {
    this.#assertOperational();
    if (this.#compacting) {
      this.#stashedPrompts.push(text);   // 压缩完成后重放(先 prompt,隐含开跑)
      return;
    }
    if (this.#followUpState === 'retrying') {
      throw new Error('任务正在重试；请使用 steer() 或 followUp()');
    }
    await this.#agent.prompt(text);
    this.#throwAuthoritativeFailure();
  }

  async continue(): Promise<void> {
    this.#assertOperational();
    if (this.interactionState() !== 'idle') {
      throw new Error('任务仍在运行；请先完成或 abort，再继续');
    }
    await this.#agent.continue();
    this.#throwAuthoritativeFailure();
  }

  steer(text: string | UserMessage): void {
    this.#assertOperational();
    this.#agent.steer(text);            // 压缩期间直接透传:agent 队列即暂存区,continue 后自然消费
  }
  followUp(text: string | UserMessage): void {
    this.#assertOperational();
    this.#agent.followUp(text);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error(`Session ${this.id} is closed`);
  }
  #assertOperational(): void {
    this.#assertOpen();
    this.#throwAuthoritativeFailure();
    this.#runtimeMirrorGuard?.assertCurrent();
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

  /** @internal Runtime driver decision hint; not a replacement for public interactionState(). */
  runtimeFollowUpState(): 'idle' | 'retrying' | 'compacting' {
    return this.#followUpState;
  }

  /**
   * The canonical ThreadRuntime has already committed a prompt into its own FIFO. Suppress only
   * the implicit empty compaction continue; the runtime will dispatch that prompt with its durable
   * OpId/RunId after the current causal activity closes.
   */
  deferCompactionResumeToMailbox(): void {
    // `#followUpState` remains compacting for one microtask after the resume decision. Checking
    // the narrower flag prevents ThreadRuntime's post-accept notification from re-arming a token
    // that this compaction has already consumed.
    if (this.#compacting) this.#mailboxOwnsNextActivity = true;
  }

  currentModel(): ModelRef {
    return { ...this.#model.ref };
  }

  /**
   * 仅空闲时切换完整 ModelConfig。meta 与历史消息保持原样；下一条 assistant
   * 由实际 adapter 写入新的 ModelRef，因此恢复与审计不会丢失跨模型边界。
   */
  setModel(model: ModelConfig): void {
    this.#assertOperational();
    if (this.interactionState() !== 'idle') {
      throw new Error('任务仍在运行；请先完成或 abort，再切换模型');
    }
    this.#agent.setModel(model);
    this.#model = model;
    this.#retry.resetForModelChange();
    this.#compaction.resetForModelChange();
  }

  /** CLI /status 渲染用(docs/08 §7):累计成本 + input/output/cacheRead 都在 usage 里。 */
  status(): { usage: SessionUsage; model: ModelRef; sessionId: string } {
    return { usage: this.#usage.snapshot(), model: this.#model.ref, sessionId: this.id };
  }

  get messages(): readonly AgentMessage[] {
    return this.#agent.transcript;
  }

  /** @internal Runtime checkpoint bridge; returns a detached legacy compaction record. */
  compactionCheckpoint(): Readonly<CompactionRecord> | undefined {
    return this.#compaction.checkpoint();
  }

  subscribe(listener: SessionListener): () => void {
    if (this.#observerPort === undefined) {
      throw new Error('ThreadRuntime has no observer port');
    }
    return this.#observerPort.subscribe(listener);
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
      if (op === this.#opChain && this.interactionState() === 'idle') {
        this.#throwAuthoritativeFailure();
        if (!this.#closed) this.#runtimeMirrorGuard?.assertCurrent();
        return;
      }
    }
  }

  // ---------- 钩子(session 安装到 Agent)----------

  /** 出站折叠(docs/08 §6.2):compactionState 存在时前缀换成合成摘要;再链用户钩子。convertContext 在 agent 侧接着跑。 */
  async #transformContext(ctx: Context): Promise<Context> {
    this.#throwAuthoritativeFailure();
    this.#runtimeMirrorGuard?.assertCurrent();
    let out = this.#compaction.transform(ctx);
    if (this.#userTransform) out = await this.#userTransform(out);
    // Keep the check adjacent to provider sampling even when a user transform awaited arbitrary
    // work (or itself touched the legacy backend).
    this.#runtimeMirrorGuard?.assertCurrent();
    return out;
  }

  /** threshold 检测(docs/08 §6.1):超阈值设 pendingCompaction 并让 agent 在 turn 边界体面停下。 */
  async #shouldStopAfterTurn(ctx: Context): Promise<boolean> {
    this.#throwAuthoritativeFailure();
    if (this.#userShouldStop && (await this.#userShouldStop(ctx))) return true;
    const contextTokens = this.#usage.snapshot().contextTokens;
    return this.#compaction.shouldStopAfterTurn(this.#model, contextTokens);
  }

  // ---------- 事件处理:落盘 + 透传 + 重试/压缩决策 ----------

  async #onAgentEvent(e: AgentEvent, extras: SessionEvent[]): Promise<void> {
    // 任何成功 turn(turn_end 且 stopReason 非 error)重置重试与 overflow 压缩计数(docs/08 §5.3/§8)
    if (e.type === 'turn_end' && e.message.stopReason !== 'error') {
      this.#retry.observeSuccessfulTurn();
      this.#compaction.observeSuccessfulTurn();
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
    const last = lastAssistant(e.messages);
    const compact = this.#compaction.decideRunEnd(e.reason, last, this.#model);
    if (compact.kind === 'compact') {
      return {
        kind: 'compaction',
        reason: compact.reason,
        ...(compact.hardTruncate && { hardTruncate: true }),
      };
    }
    if (compact.kind === 'fatal') return compact;
    if (e.reason !== 'error') return { kind: 'none' };
    const d = this.#retry.decide(last);
    if (d.retry) {
      return {
        kind: 'retry',
        attempt: d.attempt,
        delayMs: d.delayMs,
        errorMessage: d.errorMessage,
      };
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
    this.#runtimeMirrorGuard?.assertCurrent();
    await this.#fanout({ type: 'compaction_start', reason });

    const contextTokens = this.#usage.snapshot().contextTokens;
    const plan = this.#compaction.plan(this.#agent.transcript, contextTokens);
    const tailMsg = plan.tailMessage;
    const dropped = plan.dropped;

    let summary: string;
    if (hardTruncate) {
      // 压缩后仍 overflow:不再 summarize(会再吃一次超限上下文),直接硬截断降级
      summary = HARD_TRUNCATION_SUMMARY;
    } else {
      // Compaction bypasses Agent.transformContext and calls StreamFn directly.
      this.#runtimeMirrorGuard?.assertCurrent();
      try {
        summary = await this.#compaction.summarize(
          this.#streamFn,
          this.#model,
          dropped,
          signal,
          false,
        );
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
    this.#compaction.install(record);
    if (this.#authoritativeEventSink !== undefined) {
      // Runtime path: expose the pending checkpoint to the adapter, durably commit the
      // compaction event + mutation, and only then advance the legacy mirror.
      const event = { type: 'compaction_end', ok: true, droppedMessages: dropped.length } as const;
      await this.#commitAuthoritative([event]);
      const persistExtras = this.#append(record);
      this.#notifyListeners([event]);
      for (const x of persistExtras) await this.#fanout(x);
      // Ordinary observers remain non-authoritative and are never awaited. Yielding one microtask
      // only lets their synchronous prefix enqueue a mailbox prompt before the compatibility
      // adapter decides whether it must issue an implicit continue.
      await Promise.resolve();
    } else {
      // Standalone Session keeps its historical mirror-before-observer ordering.
      const persistExtras = this.#append(record);
      for (const x of persistExtras) await this.#fanout(x);
      await this.#fanout({ type: 'compaction_end', ok: true, droppedMessages: dropped.length });
    }
    this.#compacting = false;
    await this.#resumeAfterCompaction();
  }

  /** 压缩收尾:优先重放暂存 prompt,否则 continue 续跑(自然结束的 turn 则无需续跑)。 */
  async #resumeAfterCompaction(continueIfEmpty = true): Promise<void> {
    const stashed = this.#stashedPrompts;
    this.#stashedPrompts = [];
    const mailboxOwnsNextActivity = this.#mailboxOwnsNextActivity;
    this.#mailboxOwnsNextActivity = false;
    if (stashed.length > 0) {
      for (const text of stashed) {
        if (this.#closed) return;
        await this.#agent.prompt(text);
      }
      return;
    }
    if (mailboxOwnsNextActivity) return;
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
    const prepared = this.#prepareForPersistence(e);
    return [...prepared.extras, ...this.#persistPrepared(prepared.event)];
  }

  #prepareForPersistence(e: AgentEvent): { event: AgentEvent; extras: SessionEvent[] } {
    if (e.type === 'tool_execution_end') {
      // Runtime commits this event before the same result later reaches message_end. Project
      // arbitrary adapter/tool details through the identical strict-JSON boundary now, otherwise
      // canonical tool_end can fail or diverge from the transcript/mirror projection.
      const result = strictJsonSnapshot(sanitizeForDisk(e.result, false)) as unknown as ToolResultMessage;
      return { event: { ...e, result }, extras: [] };
    }
    if (e.type === 'message_start' && e.message.role === 'tool_result') {
      const message = strictJsonSnapshot(sanitizeForDisk(e.message, false)) as unknown as ToolResultMessage;
      return { event: { ...e, message }, extras: [] };
    }
    if (e.type === 'turn_end') {
      const toolResults = e.toolResults.map((result) =>
        strictJsonSnapshot(sanitizeForDisk(result, false)) as unknown as ToolResultMessage);
      return { event: { ...e, toolResults }, extras: [] };
    }
    if (e.type === 'agent_end') {
      const messages = e.messages.map((message) =>
        strictJsonSnapshot(sanitizeForDisk(message, false)) as unknown as AgentMessage);
      return { event: { ...e, messages }, extras: [] };
    }
    if (e.type !== 'message_end') return { event: e, extras: [] };
    let message = sanitizeForDisk(e.message);
    const extras: SessionEvent[] = [];
    if (message.role === 'assistant') {
      const cost = message.usage.costUSD ?? this.#usage.cost(message.usage);
      if (cost !== undefined && message.usage.costUSD === undefined) {
        message = { ...message, usage: { ...message.usage, costUSD: cost } };
      }
      message = strictJsonSnapshot(message) as unknown as AssistantMessage;
      this.#usage.add(message);
      extras.push({ type: 'usage_update', usage: this.#usage.snapshot() });
    } else {
      message = strictJsonSnapshot(message) as unknown as AgentMessage;
    }
    return { event: { ...e, message }, extras };
  }

  #persistPrepared(e: AgentEvent): SessionEvent[] {
    if (e.type === 'message_end') return this.#append({ type: 'message', message: e.message });
    if (e.type === 'agent_end') this.#store.fsync();
    return [];
  }

  #append(record: Parameters<SessionStore['append']>[0]): SessionEvent[] {
    if (this.#degraded) return [];
    this.#runtimeMirrorGuard?.beforeAppend(record);
    try {
      this.#store.append(record);
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
    this.#runtimeMirrorGuard?.afterAppend(record);
    return [];
  }

  async #fanout(e: SessionEvent): Promise<void> {
    this.#throwAuthoritativeFailure();
    await this.#commitAuthoritative([e]);
    this.#notifyListeners([e]);
  }

  async #commitAuthoritative(events: SessionAuthoritativeEventBatch): Promise<void> {
    if (this.#authoritativeEventSink === undefined) return;
    try {
      await this.#authoritativeEventSink(events);
    } catch (error) {
      this.#recordAuthoritativeFailure(error);
      throw this.#authoritativeFailure;
    }
  }

  #notifyListeners(events: SessionAuthoritativeEventBatch): void {
    this.#observerPort?.publish(events);
  }

  #recordAuthoritativeFailure(error: unknown): void {
    if (this.#authoritativeFailure !== undefined) return;
    this.#authoritativeFailure =
      error instanceof Error ? error : new Error(`authoritative event commit failed: ${String(error)}`);
    this.#opController?.abort();
    this.#agent.abort();
  }

  #throwAuthoritativeFailure(): void {
    if (this.#authoritativeFailure !== undefined) throw this.#authoritativeFailure;
  }
}

// ---------- 装配辅助 ----------

/** 用 session 的钩子委托覆盖 agentConfig 的 transformContext/shouldStopAfterTurn(用户自带的钩子被 session 链式保留)。 */
function withSessionHooks(
  agentConfig: AgentConfig,
  id: string,
  hooks: HookHost,
  queueSeed?: SessionOptions['runtimeQueueSeed'],
  mirrorGuard?: SessionRuntimeMirrorGuard,
): AgentConfig {
  const userBeforeToolCall = agentConfig.beforeToolCall;
  return {
    ...agentConfig,
    truncationScope: id,   // 落盘 scope = sessionId(docs/07 §1.6)
    transformContext: (ctx) => (hooks.transform ? hooks.transform(ctx) : Promise.resolve(ctx)),
    shouldStopAfterTurn: (ctx) => (hooks.shouldStop ? hooks.shouldStop(ctx) : Promise.resolve(false)),
    ...(mirrorGuard !== undefined && {
      beforeToolCall: async (call) => {
        mirrorGuard.assertCurrent();
        const decision = await (userBeforeToolCall?.(call) ?? {});
        // Approval/policy hooks may await user input for an arbitrary duration. Revalidate at the
        // actual tool boundary so a writer that appeared while waiting cannot gain a tool effect.
        mirrorGuard.assertCurrent();
        return decision;
      },
    }),
    ...(queueSeed !== undefined && {
      initialQueues: {
        steering: queueSeed.steering.map((message) => queuedUserMessage(message, 'steering')),
        followUp: queueSeed.followUp.map((message) => queuedUserMessage(message, 'follow_up')),
      },
    }),
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
    retry: new RetryCoordinator(opts.retry),
    compaction: new CompactionCoordinator(opts.compaction),
    hooks,
  };
  if (opts.agentConfig.transformContext) init.userTransform = opts.agentConfig.transformContext;
  if (opts.agentConfig.shouldStopAfterTurn) init.userShouldStop = opts.agentConfig.shouldStopAfterTurn;
  if (opts.authoritativeEventSink !== undefined) init.authoritativeEventSink = opts.authoritativeEventSink;
  if (opts.runtimeMirrorGuard !== undefined) init.runtimeMirrorGuard = opts.runtimeMirrorGuard;
  if (opts.observerPort !== undefined) init.observerPort = opts.observerPort;
  return init;
}

function queuedUserMessage(
  message: QueuedMessage,
  source: 'steering' | 'follow_up',
): UserMessage {
  if (message.kind !== source) throw new Error(`Runtime queue kind mismatch: ${message.kind}`);
  return {
    role: 'user',
    id: message.id,
    timestamp: 0,
    content: [{ type: 'text', text: message.text }],
    source,
  };
}

function lastAssistant(messages: readonly AgentMessage[]): AssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as AgentMessage;
    if (m.role === 'assistant') return m;
  }
  return undefined;
}

/** details 不可 JSON 序列化时置 undefined 并告警,不得让写盘失败(docs/08 §3.2)。 */
function sanitizeForDisk(m: ToolResultMessage, warn?: boolean): ToolResultMessage;
function sanitizeForDisk(m: AgentMessage, warn?: boolean): AgentMessage;
function sanitizeForDisk(m: AgentMessage, warn = true): AgentMessage {
  if (m.role !== 'tool_result') return m;
  if (m.details === undefined) return withoutToolResultDetails(m);
  try {
    return { ...m, details: strictJsonSnapshot(m.details) };
  } catch {
    if (warn) {
      console.error(`[session] tool_result ${m.id} details not serializable, dropped from disk record`);
    }
    return withoutToolResultDetails(m);
  }
}

function withoutToolResultDetails(
  message: Extract<AgentMessage, { role: 'tool_result' }>,
): Extract<AgentMessage, { role: 'tool_result' }> {
  const { details, ...withoutDetails } = message;
  void details;
  return withoutDetails;
}
