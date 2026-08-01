// Agent 类:runLoop 纯函数的薄封装(规格见 docs/05-agent-loop.md §1)。
// 管理 state 翻转(running → finally 回 idle)、持有双队列与 taskAbort、
// 把 subscribe 的 listener 接到 emit。只有 idle/running 两个状态——abort 是
// 「请求」不是「瞬时动作」,想等中止真正完成用 waitForIdle()。

import type {
  AgentMessage,
  Context,
  ModelConfig,
  StreamFn,
  ToolCallPart,
  ToolResultMessage,
  UserMessage,
} from '../protocol/index.js';
import { FileTracker, truncationDir } from '../shared/index.js';
import type { ToolDefinition } from '../tools/types.js';
import type { AgentEventListener } from './events.js';
import { Emitter } from './events.js';
import { newMessageId } from './ids.js';
import type { LoopConfig, LoopSeed, RuntimeTurnProvider } from './loop.js';
import { runLoop } from './loop.js';
import type { DrainMode } from './queue.js';
import { PendingMessageQueue } from './queue.js';
import { renderToolSchemas } from './tool-schemas.js';

export interface AgentConfig {
  streamFn: StreamFn;
  model: ModelConfig;
  tools: ToolDefinition[];
  systemPrompt: string | (() => string);
  transformContext?: (ctx: Context) => Promise<Context>;        // 压缩/裁剪钩子(M7 compaction)
  beforeToolCall?: (call: ToolCallPart) => Promise<{ block: true; reason: string } | { block?: false }>;
  afterToolCall?: (call: ToolCallPart, result: ToolResultMessage) => Promise<ToolResultMessage>;
  shouldStopAfterTurn?: (ctx: Context) => Promise<boolean>;
  toolExecution?: 'sequential' | 'parallel';                     // 默认 parallel(工具可声明强制 sequential)
  cwd?: string;                                                  // 工具执行工作目录,默认 process.cwd()
  initialMessages?: AgentMessage[];                              // 恢复会话的初始转录(docs/08 §3.1;仅初始数据,agent 不感知恢复)
  /** @internal Runtime recovery seed; installed silently before any listener can observe a drain. */
  initialQueues?: {
    readonly steering: readonly UserMessage[];
    readonly followUp: readonly UserMessage[];
  };
  truncationScope?: string;                                      // 截断落盘目录 scope(session 注入 sessionId,docs/07 §1.6)
  /** @internal Canonical Runtime supplies one immutable registry environment per turn. */
  runtimeTurnProvider?: RuntimeTurnProvider;
}

export class Agent {
  steeringMode: DrainMode = 'one-at-a-time';
  followUpMode: DrainMode = 'one-at-a-time';

  readonly #emitter = new Emitter();
  readonly #steering = new PendingMessageQueue('steering');
  readonly #followUp = new PendingMessageQueue('follow_up');
  readonly #transcript: AgentMessage[];
  readonly #loopConfig: LoopConfig;
  #state: 'idle' | 'running' = 'idle';
  #taskAbort: AbortController | undefined;
  #runPromise: Promise<void> = Promise.resolve();

  constructor(config: AgentConfig) {
    this.#transcript = [...(config.initialMessages ?? [])];
    for (const message of config.initialQueues?.steering ?? []) this.#steering.enqueue(message);
    for (const message of config.initialQueues?.followUp ?? []) this.#followUp.enqueue(message);
    this.#loopConfig = {
      streamFn: config.streamFn,
      model: config.model,
      tools: config.tools,
      toolSchemas: renderToolSchemas(config.tools),   // 构造时一次性渲染并缓存
      systemPrompt: config.systemPrompt,
      cwd: config.cwd ?? process.cwd(),
      fileTracker: new FileTracker(),                 // 会话级 read-before-edit 登记表
      spillDir: truncationDir(config.truncationScope ?? `agent-${crypto.randomUUID().slice(0, 8)}`),
      transformContext: config.transformContext,
      beforeToolCall: config.beforeToolCall,
      afterToolCall: config.afterToolCall,
      shouldStopAfterTurn: config.shouldStopAfterTurn,
      toolExecution: config.toolExecution,
      steeringMode: () => this.steeringMode,
      followUpMode: () => this.followUpMode,
      runtimeTurnProvider: config.runtimeTurnProvider,
    };
  }

  get state(): 'idle' | 'running' {
    return this.#state;
  }

  /**
   * 切换下一次采样使用的完整模型配置。运行中的 loop 已经持有当前请求语义，
   * 因此只允许 idle 更新；既有 transcript（含每条 assistant 的 ModelRef）不改写。
   */
  setModel(model: ModelConfig): void {
    if (this.#state !== 'idle') {
      throw new Error('Agent is running; finish or abort before switching model');
    }
    this.#loopConfig.model = model;
  }

  /** 权威转录(只读视图;错误与中止也是一等消息,永远完整)。 */
  get transcript(): readonly AgentMessage[] {
    return this.#transcript;
  }

  subscribe(listener: AgentEventListener): () => void {
    return this.#emitter.subscribe(listener);
  }

  /**
   * 仅空闲时;运行中 throw——「运行中的新输入」存在 steer 与 followUp 两种意图,
   * API 层面替调用者猜必然猜错一半(pi:入口强制二选一)。
   */
  prompt(text: string): Promise<void> {
    if (this.#state === 'running') {
      throw new Error('Agent is running; use steer() or followUp()');
    }
    const message = toUserMessage(text, 'prompt');
    return this.#run('prompt', { initialPending: [message], skipInitialPoll: false });
  }

  /** 随时可调:入 steering 队列,turn 边界注入。空文本 no-op(docs/06 边界 11)。 */
  steer(msg: UserMessage | string): void {
    const message = normalizeQueuedMessage(msg, 'steering');
    if (message === undefined) return;
    this.#steering.enqueue(message);
    this.#emitQueueUpdate();
  }

  /** 随时可调:入 follow-up 队列,任务将结束时消费。空文本 no-op。 */
  followUp(msg: UserMessage | string): void {
    const message = normalizeQueuedMessage(msg, 'follow_up');
    if (message === undefined) return;
    this.#followUp.enqueue(message);
    this.#emitQueueUpdate();
  }

  /** 硬中断请求:队列不清空(清空是 clearQueues() 的显式动作)。idle 时 no-op。 */
  abort(): void {
    this.#taskAbort?.abort();
  }

  /**
   * abort/重试后续跑(docs/05 §1.2):steering 优先 → follow-up → 残局重采样 → throw。
   * 消费了排队消息 reason 为 'follow_up',纯重采样为 'continue'。
   */
  continue(): Promise<void> {
    if (this.#state === 'running') {
      throw new Error('Agent is running; use steer() or followUp()');
    }
    const steered = this.#steering.drain(this.steeringMode);
    if (steered.length > 0) {
      this.#emitQueueUpdate();   // emit 链 FIFO:queue_update 先于 agent_start 到达 listener
      return this.#run('follow_up', { initialPending: steered, skipInitialPoll: true });
    }
    const followUps = this.#followUp.drain(this.followUpMode);
    if (followUps.length > 0) {
      this.#emitQueueUpdate();
      return this.#run('follow_up', { initialPending: followUps, skipInitialPoll: true });
    }
    if (hasResidue(this.#transcript)) {
      // 重采样:残缺 assistant 被 transform 过滤、孤儿 toolCall 补合成结果,等价于「重试上一轮」
      return this.#run('continue', { initialPending: [], skipInitialPoll: true });
    }
    throw new Error('Nothing to continue');
  }

  /** 当前 run 的 agent_end 及全部 listener settle 后 resolve;idle 时立即 resolve。 */
  waitForIdle(): Promise<void> {
    return this.#runPromise.then(
      () => undefined,
      () => undefined,
    );
  }

  clearQueues(): void {
    this.#steering.clear();
    this.#followUp.clear();
    this.#emitQueueUpdate();   // 空快照(docs/06 §8.1)
  }

  #emitQueueUpdate(): void {
    void this.#emitter.emit({
      type: 'queue_update',
      steering: this.#steering.snapshot(),
      followUp: this.#followUp.snapshot(),
    });
  }

  #run(reason: 'prompt' | 'follow_up' | 'continue', seed: LoopSeed): Promise<void> {
    this.#state = 'running';
    const taskAbort = new AbortController();
    this.#taskAbort = taskAbort;
    const emit = (e: Parameters<Emitter['emit']>[0]): Promise<void> => this.#emitter.emit(e);

    const run = (async (): Promise<void> => {
      await emit({ type: 'agent_start', reason });
      await runLoop(
        this.#loopConfig,
        this.#transcript,
        { steering: this.#steering, followUp: this.#followUp },
        taskAbort.signal,
        emit,
        seed,
      );
    })();
    // agent_end 的 emit 在 runLoop 内被 await,settle 之后才翻回 idle——
    // waitForIdle() resolve 时一切副作用(持久化、渲染)已尘埃落定。
    this.#runPromise = run.finally(() => {
      this.#state = 'idle';
    });
    return this.#runPromise;
  }
}

function toUserMessage(text: string, source: NonNullable<UserMessage['source']>): UserMessage {
  return {
    role: 'user',
    id: newMessageId('u'),
    timestamp: Date.now(),
    content: [{ type: 'text', text }],
    source,
  };
}

/**
 * 入队消息归一:string 便利重载包装成 UserMessage;对象重载同样受空文本守卫
 * (纯空白文本且无图片 → no-op)并强制盖上队列对应的 source——队列 kind 与注入后
 * source 永不分叉(docs/03 UserMessage.source 语义,UI 徽标与统计都靠它)。
 */
function normalizeQueuedMessage(
  msg: UserMessage | string,
  source: 'steering' | 'follow_up',
): UserMessage | undefined {
  if (typeof msg === 'string') {
    if (msg.trim().length === 0) return undefined;
    return toUserMessage(msg, source);
  }
  const hasText = msg.content.some((p) => p.type === 'text' && p.text.trim().length > 0);
  const hasImage = msg.content.some((p) => p.type === 'image');
  if (!hasText && !hasImage) return undefined;
  return msg.source === source ? msg : { ...msg, source };
}

/**
 * 转录残局判定(continue() 第 3 路,含崩溃恢复):判据限定在**转录尾部**——
 * 末条消息非完结态(user / tool_result 收尾)、末条 assistant 为 aborted/error、
 * 或末条 assistant 自己的 toolCall 未配对(崩溃形态:stopReason 'tool_calls' 收尾)。
 * 不做全转录扫描:历史中段的孤儿(abort 留下、已由 transform 出站修复)是既成事实,
 * 不该让之后每次 continue() 都误判为「有残局」而重采样(核查发现的过宽判定)。
 * 导出仅为直接单测(崩溃恢复形态难以从公共 API 构造);非 Agent 公共 API。
 */
export function hasResidue(transcript: readonly AgentMessage[]): boolean {
  if (transcript.length === 0) return false;
  const last = transcript[transcript.length - 1] as AgentMessage;
  if (last.role === 'user' || last.role === 'tool_result') return true;
  if (last.role !== 'assistant') return false;
  if (last.stopReason === 'aborted' || last.stopReason === 'error') return true;
  // 末条 assistant 的 toolCall 未配对(其结果只可能出现在它之后——即没有)
  return last.content.some((p) => p.type === 'tool_call');
}
