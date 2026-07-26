// Agent 类:runLoop 纯函数的薄封装(规格见 docs/05-agent-loop.md §1)。
// 管理 state 翻转(running → finally 回 idle)、持有双队列与 taskAbort、
// 把 subscribe 的 listener 接到 emit。只有 idle/running 两个状态——abort 是
// 「请求」不是「瞬时动作」,想等中止真正完成用 waitForIdle()。

import { randomUUID } from 'node:crypto';
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
import type { LoopConfig, LoopSeed } from './loop.js';
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
}

export class Agent {
  steeringMode: DrainMode = 'one-at-a-time';
  followUpMode: DrainMode = 'one-at-a-time';

  readonly #emitter = new Emitter();
  readonly #steering = new PendingMessageQueue('steering');
  readonly #followUp = new PendingMessageQueue('follow_up');
  readonly #transcript: AgentMessage[] = [];
  readonly #loopConfig: LoopConfig;
  #state: 'idle' | 'running' = 'idle';
  #taskAbort: AbortController | undefined;
  #runPromise: Promise<void> = Promise.resolve();

  constructor(config: AgentConfig) {
    this.#loopConfig = {
      streamFn: config.streamFn,
      model: config.model,
      tools: config.tools,
      toolSchemas: renderToolSchemas(config.tools),   // 构造时一次性渲染并缓存
      systemPrompt: config.systemPrompt,
      cwd: config.cwd ?? process.cwd(),
      fileTracker: new FileTracker(),                 // 会话级 read-before-edit 登记表
      spillDir: truncationDir(`agent-${randomUUID().slice(0, 8)}`),  // M5 起接 sessionId
      transformContext: config.transformContext,
      beforeToolCall: config.beforeToolCall,
      afterToolCall: config.afterToolCall,
      shouldStopAfterTurn: config.shouldStopAfterTurn,
      toolExecution: config.toolExecution,
      steeringMode: () => this.steeringMode,
      followUpMode: () => this.followUpMode,
    };
  }

  get state(): 'idle' | 'running' {
    return this.#state;
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

  /** 随时可调:入 steering 队列,turn 边界注入(完整语义矩阵与 queue_update 在 M4)。 */
  steer(msg: UserMessage | string): void {
    this.#steering.enqueue(typeof msg === 'string' ? toUserMessage(msg, 'steering') : msg);
  }

  /** 随时可调:入 follow-up 队列,任务将结束时消费(完整语义矩阵与 queue_update 在 M4)。 */
  followUp(msg: UserMessage | string): void {
    this.#followUp.enqueue(typeof msg === 'string' ? toUserMessage(msg, 'follow_up') : msg);
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
      return this.#run('follow_up', { initialPending: steered, skipInitialPoll: true });
    }
    const followUps = this.#followUp.drain(this.followUpMode);
    if (followUps.length > 0) {
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
 * 转录残局判定(continue() 第 3 路,含崩溃恢复):末条 assistant 为 aborted/error、
 * 存在未配对 toolCall、或末条消息非完结态(user / tool_result 收尾)。
 * 导出仅为直接单测(崩溃恢复形态难以从公共 API 构造);非 Agent 公共 API。
 */
export function hasResidue(transcript: readonly AgentMessage[]): boolean {
  if (transcript.length === 0) return false;
  const last = transcript[transcript.length - 1] as AgentMessage;
  if (last.role === 'user' || last.role === 'tool_result') return true;
  if (last.role === 'assistant' && (last.stopReason === 'aborted' || last.stopReason === 'error')) {
    return true;
  }
  // 未配对 toolCall:任何 assistant 的 tool_call 无对应 tool_result
  const answered = new Set<string>();
  for (const m of transcript) {
    if (m.role === 'tool_result') answered.add(m.toolCallId);
  }
  for (const m of transcript) {
    if (m.role !== 'assistant') continue;
    for (const part of m.content) {
      if (part.type === 'tool_call' && !answered.has(part.id)) return true;
    }
  }
  return false;
}
