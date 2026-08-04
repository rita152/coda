// runLoop emits internal Agent-loop payloads; RuntimeThreadExecution wraps them in the
// identity-bearing Runtime event stream. The loop owns the double loop (follow-up + tools/steering),
// streamAssistantResponse 流水线、工具执行三阶段调度(规格见 docs/05-agent-loop.md)。
// 独立于 Agent 类的纯函数:faux provider 下全离线可测。
// 全部复杂度围绕一个目标:转录在任何时刻(abort/length/工具失败/provider 出错)完整可重放。

import type { AgentEvent } from '../protocol/agent-events.js';
import type {
  AssistantMessage,
  Context,
  ModelConfig,
  StreamFn,
  ToolCallPart,
  ToolResultMessage,
  UserMessage,
  AgentMessage,
} from '../protocol/index.js';
import type {
  CapabilityResult,
  PromptAssemblyResult,
} from '../capabilities/types.js';
import { newMessageId } from './ids.js';
import type { DrainMode, PendingMessageQueue } from './queue.js';
import { errorToolResult, failTruncatedToolCalls, formatToolError, toToolResultMessage } from './tool-result.js';
import { convertContext, INTERRUPTED_RESULT_TEXT } from './transform.js';

export type Emit = (e: AgentEvent) => Promise<void>;

export type RuntimeToolPreparation =
  | {
      readonly ok: true;
      readonly args: unknown;
      readonly executionMode: 'parallel' | 'sequential';
      execute(input: {
        readonly signal: AbortSignal;
        readonly onUpdate: (update: Readonly<Record<string, unknown>>) => void;
      }): Promise<CapabilityResult>;
    }
  | { readonly ok: false; readonly message: string };

export interface RuntimeTurnPort {
  readonly streamFn: StreamFn;
  assemble(outboundMessages: readonly Readonly<AgentMessage>[]): PromptAssemblyResult;
  prepareToolCall(
    call: Readonly<ToolCallPart>,
    sourceOrdinal: number,
    signal: AbortSignal,
  ): Promise<RuntimeToolPreparation>;
}

export interface RuntimeTurnProvider {
  capture(input: {
    readonly model: Readonly<ModelConfig>;
    readonly transcript: readonly Readonly<AgentMessage>[];
    readonly signal: AbortSignal;
  }): Promise<RuntimeTurnPort>;
}

/** runLoop 的完整配置:AgentConfig 的钩子 + Agent 预解析的执行环境。 */
export interface LoopConfig {
  model: ModelConfig;
  spillDir: string;
  transformContext?: (ctx: Context) => Promise<Context>;
  afterToolCall?: (call: ToolCallPart, result: ToolResultMessage) => Promise<ToolResultMessage>;
  shouldStopAfterTurn?: (ctx: Context) => Promise<boolean>;
  steeringMode: () => DrainMode;   // live 读取:运行中切换即时生效
  followUpMode: () => DrainMode;
  runtimeTurnProvider: RuntimeTurnProvider;
  /** @internal One Agent run is serial, so this value is scoped to the current turn only. */
  activeRuntimeTurn?: RuntimeTurnPort;
}

export interface LoopQueues {
  steering: PendingMessageQueue;
  followUp: PendingMessageQueue;
}

export interface LoopSeed {
  /** 以注入消息形态进入首 turn(prompt 的 user 消息 / continue() 预 drain 的队列消息)。 */
  initialPending: UserMessage[];
  /** continue() 已自行 drain 时跳过起跑 poll,防止双重消费。 */
  skipInitialPoll: boolean;
}

type RuntimeTurnCapture =
  | { readonly ok: true; readonly runtimeTurn: RuntimeTurnPort }
  | { readonly ok: false; readonly error: unknown };

export async function runLoop(
  cfg: LoopConfig,
  transcript: AgentMessage[],          // 权威转录,就地追加
  queues: LoopQueues,
  taskSignal: AbortSignal,
  emit: Emit,
  seed: LoopSeed,
): Promise<void> {
  const newMessages: AgentMessage[] = []; // 本 run 新增消息,agent_end 携带

  // queue_update:drain 消费时机的快照发射(docs/06 §3——注入消息的 message_start 之前)
  const emitQueueUpdate = (): Promise<void> =>
    emit({
      type: 'queue_update',
      steering: queues.steering.snapshot(),
      followUp: queues.followUp.snapshot(),
    });

  // [A] 起跑前 poll 一次 steering:用户在上一个回答期间就可能已输入。
  //     seed.initialPending(prompt 消息 / continue 预 drain)排在最前。
  const initialDrained = seed.skipInitialPoll ? [] : queues.steering.drain(cfg.steeringMode());
  let pendingMessages: UserMessage[] = [...seed.initialPending, ...initialDrained];
  if (initialDrained.length > 0) await emitQueueUpdate();

  outer: while (true) {                  // ── 外层:follow-up 续命 ──
    let hasMoreToolCalls = true;         // 初始 true:即使无 pending 也要采样一次
    while (hasMoreToolCalls || pendingMessages.length > 0) {  // ── 内层:工具循环 + steering ──
      // Registry Runtime 必须先完成该 turn 的全部依赖快照，再允许权威
      // turn_start 落盘。捕获失败也在这里先被观察，随后交给采样防御路径
      // 合成完整的 error turn，不让事件文法断裂。
      cfg.activeRuntimeTurn = undefined;
      const runtimeTurnCapture = await captureRuntimeTurn(cfg, transcript, taskSignal);
      await emit({ type: 'turn_start' });

      // [B] 注入排队消息:逐条走 message_start/end 生命周期,追加进转录。
      for (const m of pendingMessages) {
        await emit({ type: 'message_start', message: m });
        transcript.push(m);
        newMessages.push(m);
        await emit({ type: 'message_end', message: m });
      }
      pendingMessages = [];

      // [C] 采样:transformContext → convertContext → StreamFn → 消费事件流
      const assistant = await streamAssistantResponseWithCapture(
        cfg,
        transcript,
        taskSignal,
        emit,
        runtimeTurnCapture,
      );
      transcript.push(assistant);
      newMessages.push(assistant);

      // error/aborted → 直接收尾；重试由 session 层处理，agent loop 不负责重试。
      if (assistant.stopReason === 'error' || assistant.stopReason === 'aborted') {
        await emit({ type: 'turn_end', message: assistant, toolResults: [] });
        cfg.activeRuntimeTurn = undefined;
        await emit({
          type: 'agent_end',
          reason: assistant.stopReason === 'aborted' ? 'aborted' : 'error',
          messages: newMessages,
        });
        return;
      }

      // [E] 工具执行
      const toolCalls = assistant.content.filter((p): p is ToolCallPart => p.type === 'tool_call');
      let toolResults: ToolResultMessage[] = [];
      if (toolCalls.length > 0) {
        let terminate = false;
        if (assistant.stopReason === 'length') {
          // [E1] length 截断 ⇒ 参数可能不完整,全批合成 isError,不执行(不可动摇规则)
          toolResults = failTruncatedToolCalls(toolCalls);
        } else {
          ({ toolResults, terminate } = await executeToolCalls(cfg, toolCalls, taskSignal, emit));
        }
        // [F] 回填:严格按 assistant 内 toolCall 的源顺序,每条走 message_start/end
        for (const r of toolResults) {
          await emit({ type: 'message_start', message: r });
          transcript.push(r);
          newMessages.push(r);
          await emit({ type: 'message_end', message: r });
        }
        // terminate:批内全部结果 terminate 才停;length 合成批永远不 terminate
        hasMoreToolCalls = !terminate;
      } else {
        hasMoreToolCalls = false;        // 纯文本回复:内层是否继续取决于 steering
      }

      await emit({ type: 'turn_end', message: assistant, toolResults });
      cfg.activeRuntimeTurn = undefined;

      // [G] abort 检查:工具批次执行中被 abort(流采样中的 abort 已在 [D] 收尾)。
      //     显式检查而非等下一次 StreamFn 返回 aborted——转录更干净。
      if (taskSignal.aborted) {
        await emit({ type: 'agent_end', reason: 'aborted', messages: newMessages });
        return;
      }

      // [H] 优雅停:shouldStopAfterTurn 优先级高于两个队列——返回 true 直接结束,不 poll。
      //     队列残留保留,由 session 层检查后决定是否 continue()。
      //     钩子 throw 走防御收尾(fatal 事件 + agent_end),不让异常穿透 runLoop。
      if (cfg.shouldStopAfterTurn) {
        let stop = false;
        try {
          stop = await cfg.shouldStopAfterTurn(outboundContext(transcript));
        } catch (err) {
          await emit({ type: 'error', message: `shouldStopAfterTurn hook threw: ${formatToolError(err)}`, fatal: true });
          await emit({ type: 'agent_end', reason: 'error', messages: newMessages });
          return;
        }
        if (stop) {
          await emit({ type: 'agent_end', reason: 'completed', messages: newMessages });
          return;
        }
      }

      // [I] ★ steering 注入点:每个 turn 结束后。队列非空即「续命」——
      //     即使 assistant 没发工具调用,内层循环也继续。
      pendingMessages = queues.steering.drain(cfg.steeringMode());
      if (pendingMessages.length > 0) await emitQueueUpdate();
    }

    // [J] ★ follow-up 注入点:agent 本来要停止时(无 toolCall、无 steering)才 poll。
    const followUps = queues.followUp.drain(cfg.followUpMode());
    if (followUps.length > 0) {
      await emitQueueUpdate();
      pendingMessages = followUps;
      continue outer;
    }
    break;
  }
  await emit({ type: 'agent_end', reason: 'completed', messages: newMessages });
}

// ---------- 采样 ----------

/**
 * 把「当前转录」变成「一条完整落地的 AssistantMessage」,途中把 provider 流事件
 * 转发为 message_update(docs/05 Agent Loop)。顺序决策:transformContext(用户钩子,看原貌)
 * 先于 convertContext(固定清洗,出站前最后一道合法性保证)。
 */
export async function streamAssistantResponse(
  cfg: LoopConfig,
  transcript: AgentMessage[],
  taskSignal: AbortSignal,
  emit: Emit,
): Promise<AssistantMessage> {
  return streamAssistantResponseWithCapture(cfg, transcript, taskSignal, emit);
}

async function streamAssistantResponseWithCapture(
  cfg: LoopConfig,
  transcript: AgentMessage[],
  taskSignal: AbortSignal,
  emit: Emit,
  capturedRuntimeTurn?: RuntimeTurnCapture,
): Promise<AssistantMessage> {
  let started = false;
  let lastPartial: AssistantMessage | undefined;   // 防御路径复用已宣布的消息 id 与已生成内容
  let stage = 'transformContext hook';             // 防御路径的错误归因标注
  try {
    const capture = capturedRuntimeTurn ?? await captureRuntimeTurn(cfg, transcript, taskSignal);
    if (!capture.ok) {
      if (taskSignal.aborted) return emitAbortedAssistant(cfg, emit);
      stage = 'RuntimeTurnProvider.capture';
      throw capture.error;
    }
    const runtimeTurn = capture.runtimeTurn;
    cfg.activeRuntimeTurn = runtimeTurn;
    if (taskSignal.aborted) {
      return emitAbortedAssistant(cfg, emit);
    }
    let ctx: Context = outboundContext(transcript);
    if (cfg.transformContext) ctx = await cfg.transformContext(ctx);
    stage = 'PromptAssembler';
    const assembly = runtimeTurn.assemble(ctx.messages);
    if (!assembly.ok) throw new Error(`${assembly.code}: ${assembly.message}`);
    ctx = assembly.context as Context;
    stage = 'convertContext';
    // 视觉能力取 compat.supportsImageParts(CompatFlags 是开放袋,此处只认布尔 false)
    ctx = convertContext(ctx, cfg.model.ref, {
      supportsImages: cfg.model.compat?.['supportsImageParts'] !== false,
    });

    // 每次模型调用取 child signal(AbortController 树,docs/05 取消与背压):
    // 未来单调用级取消不牵连整个 run,也避免向 taskSignal 反复 addEventListener 泄漏。
    const signal = AbortSignal.any([taskSignal]);

    // StreamFn 铁律:绝不 throw、绝不 reject。外层 try 只是协议 bug 的最后防线。
    stage = 'StreamFn (provider contract: never throw/reject)';
    const stream = runtimeTurn.streamFn(cfg.model, ctx, {
      signal,
      ...cfg.model.defaults,
    });
    for await (const ev of stream) {
      if (ev.type === 'start') {
        started = true;
        lastPartial = ev.partial;
        await emit({ type: 'message_start', message: ev.partial });  // 宣布 assistant 消息诞生
        continue;
      }
      if (ev.type === 'done' || ev.type === 'error') continue;       // 终态由 message_end 承载
      lastPartial = ev.partial;
      await emit({ type: 'message_update', messageId: ev.partial.id, event: ev });
    }
    const message = rejectDuplicateToolCallIds(await stream.result());
    await emit({ type: 'message_end', message });
    return message;
  } catch (err) {
    // 防御路径(docs/05 取消与背压):钩子 bug 或违约 provider,合成 error assistant 收尾,
    // 不让异常穿透 runLoop——事件文法(run 必以 agent_end 闭合)与转录完整性优先。
    const errorMessage = `[protocol bug] ${stage} threw: ${formatToolError(err)}`;
    // 已宣布过 message_start 则复用同一消息(id 与已生成 content 保留),start/end 同 id
    const message: AssistantMessage = lastPartial !== undefined
      ? { ...lastPartial, stopReason: 'error', errorMessage }
      : {
          role: 'assistant',
          id: newMessageId('a'),
          timestamp: Date.now(),
          content: [],
          model: cfg.model.ref,
          stopReason: 'error',
          errorMessage,
          usage: { input: 0, output: 0 },
        };
    await emit({ type: 'error', message: errorMessage, fatal: true });
    if (!started) await emit({ type: 'message_start', message });
    await emit({ type: 'message_end', message });
    return message;
  }
}

async function captureRuntimeTurn(
  cfg: LoopConfig,
  transcript: AgentMessage[],
  signal: AbortSignal,
): Promise<RuntimeTurnCapture> {
  try {
    return {
      ok: true,
      runtimeTurn: await cfg.runtimeTurnProvider.capture({ model: cfg.model, transcript, signal }),
    };
  } catch (error) {
    return { ok: false, error };
  }
}

async function emitAbortedAssistant(
  cfg: LoopConfig,
  emit: Emit,
): Promise<AssistantMessage> {
  const message: AssistantMessage = {
    role: 'assistant',
    id: newMessageId('a'),
    timestamp: Date.now(),
    content: [],
    model: cfg.model.ref,
    stopReason: 'aborted',
    errorDetails: { kind: 'aborted', retryable: false },
    usage: { input: 0, output: 0 },
  };
  await emit({ type: 'message_start', message });
  await emit({ type: 'message_end', message });
  return message;
}

function rejectDuplicateToolCallIds(message: AssistantMessage): AssistantMessage {
  const seen = new Set<string>();
  let duplicate: string | undefined;
  for (const part of message.content) {
    if (part.type !== 'tool_call') continue;
    if (seen.has(part.id)) {
      duplicate = part.id;
      break;
    }
    seen.add(part.id);
  }
  if (duplicate === undefined) return message;
  return {
    ...message,
    content: message.content.filter((part) => part.type !== 'tool_call'),
    stopReason: 'error',
    errorMessage: `duplicate_tool_call_id: provider reused ${JSON.stringify(duplicate)} in one assistant message`,
    errorDetails: { kind: 'unknown', retryable: false, code: 'duplicate_tool_call_id' },
  };
}

/** Build the mutable outbound message view consumed by compaction before registry assembly. */
function outboundContext(transcript: AgentMessage[]): Context {
  // messages 给浅拷贝数组:transformContext 钩子(compaction 的挂载点)对数组的
  // splice/push 不得触及权威转录本体——「转录任何时刻完整可重放」优先于一次数组分配。
  return { messages: [...transcript] };
}

// ---------- 工具执行三阶段 ----------

type Prepared =
  | {
      kind: 'ok';
      call: ToolCallPart;
      args: unknown;
      executionMode: 'parallel' | 'sequential';
      execute(input: {
        readonly signal: AbortSignal;
        readonly onUpdate: (update: Readonly<Record<string, unknown>>) => void;
      }): Promise<CapabilityResult>;
    }
  | { kind: 'reject'; call: ToolCallPart; result: ToolResultMessage }; // 直接就是回喂结果

/** Phase 1 delegates lookup, argument repair, validation and policy to the captured runtime turn. */
async function prepareToolCall(
  cfg: LoopConfig,
  call: ToolCallPart,
  sourceOrdinal: number,
  taskSignal: AbortSignal,
): Promise<Prepared> {
  const runtimeTurn = cfg.activeRuntimeTurn;
  if (runtimeTurn === undefined) {
    return {
      kind: 'reject',
      call,
      result: errorToolResult(call, 'Capability turn snapshot is unavailable'),
    };
  }
  let prepared: RuntimeToolPreparation;
  try {
    prepared = await runtimeTurn.prepareToolCall(call, sourceOrdinal, taskSignal);
  } catch (error) {
    return {
      kind: 'reject',
      call,
      result: errorToolResult(
        call,
        `Capability preflight failed: ${formatToolError(error)}`,
      ),
    };
  }
  if (!prepared.ok) {
    return { kind: 'reject', call, result: errorToolResult(call, prepared.message) };
  }
  return {
    kind: 'ok',
    call,
    args: prepared.args,
    executionMode: prepared.executionMode,
    execute: prepared.execute,
  };
}

/** 阶段 2+3:execute(throw=失败)→ afterToolCall 改写 → tool_execution_end。 */
async function runOne(
  cfg: LoopConfig,
  p: Prepared,
  taskSignal: AbortSignal,
  emit: Emit,
): Promise<
  | { kind: 'completed'; result: ToolResultMessage; terminate: boolean }
  | { kind: 'aborted_before_execute' }
> {
  // reject 结果同样发 start/end 对(UI 一致性;args 用原始 call.arguments)
  const args = p.kind === 'ok' ? p.args : p.call.arguments;
  const abortedBeforeStart = taskSignal.aborted;
  await emit({ type: 'tool_execution_start', toolCallId: p.call.id, toolName: p.call.name, args });
  // tool_execution_start 是权威背压边界；等待提交时可能已收到 abort。
  // 若 cancellation 正是在等待该提交时发生，未执行的 call 保持孤儿事实；若它在进入
  // start 边界前已发生（例如 approval 返回 abort），则保留既有的中断结果投影。
  if (taskSignal.aborted && !abortedBeforeStart) return { kind: 'aborted_before_execute' };

  let result: ToolResultMessage;
  let terminate = false;
  if (taskSignal.aborted) {
    result = errorToolResult(p.call, INTERRUPTED_RESULT_TEXT);
  } else if (p.kind === 'reject') {
    result = p.result;
  } else {
    try {
      const output = await p.execute({
        signal: AbortSignal.any([taskSignal]),
        onUpdate: (update) => {
          void emit({ type: 'tool_execution_update', toolCallId: p.call.id, update });
        },
      });
      result = toToolResultMessage(p.call, output, cfg.spillDir);
      terminate = output.terminate === true;
    } catch (err) {
      result = errorToolResult(p.call, formatToolError(err));
    }
  }

  if (cfg.afterToolCall) {
    // 改写钩子失败:保留原始结果(丢结果比丢改写更糟),旁路事件报告钩子 bug
    try {
      result = await cfg.afterToolCall(p.call, result);
    } catch (err) {
      void emit({ type: 'error', message: `afterToolCall hook threw (result kept as-is): ${formatToolError(err)}`, fatal: false });
    }
  }
  await emit({ type: 'tool_execution_end', toolCallId: p.call.id, result });
  // plan_update 旁路事件:loop 在 finalize 识别 plan 形态的 details 后发出(docs/07 §2,
  // 工具不依赖事件总线,保持 tools → protocol 的依赖方向)。整表替换语义,快照即全量。
  const planSteps = extractPlanSteps(result);
  if (planSteps !== undefined) await emit({ type: 'plan_update', steps: planSteps });
  return { kind: 'completed', result, terminate };
}

/** plan 工具 details 的鸭子识别:非 isError 且 details.steps 是 PlanStep 数组形态。 */
function extractPlanSteps(result: ToolResultMessage): { step: string; status: 'pending' | 'in_progress' | 'completed' }[] | undefined {
  if (result.isError) return undefined;
  const details = result.details as { steps?: unknown } | undefined;
  if (details === undefined || !Array.isArray(details.steps)) return undefined;
  const ok = details.steps.every(
    (s: unknown) =>
      typeof s === 'object' &&
      s !== null &&
      typeof (s as { step?: unknown }).step === 'string' &&
      ['pending', 'in_progress', 'completed'].includes((s as { status?: string }).status ?? ''),
  );
  return ok ? (details.steps as { step: string; status: 'pending' | 'in_progress' | 'completed' }[]) : undefined;
}

/**
 * 批调度(docs/07 §4):preflight 一律按源顺序串行(审批 UI 逐个弹出、校验顺序确定);
 * 任一被调用工具声明 executionMode:'sequential' ⇒ 整批退化顺序执行;
 * 回填按 assistant 源顺序,不按完成顺序——转录顺序必须确定。
 */
async function executeToolCalls(
  cfg: LoopConfig,
  toolCalls: ToolCallPart[],
  taskSignal: AbortSignal,
  emit: Emit,
): Promise<{ toolResults: ToolResultMessage[]; terminate: boolean }> {
  const prepared: Prepared[] = [];
  for (const [sourceOrdinal, call] of toolCalls.entries()) {
    // Preflight can wait on Runtime policy/control. Once aborted, preparing another call could
    // create control work that no caller remains responsible for resolving.
    //   已 abort 则停止 prepare 剩余 call,它们成为孤儿由 transform 层补合成中断结果。
    if (taskSignal.aborted) break;
    prepared.push(await prepareToolCall(cfg, call, sourceOrdinal, taskSignal));
  }

  const sequential = prepared.some(
    (p) => p.kind === 'ok' && p.executionMode === 'sequential',
  );

  const results = new Map<string, ToolResultMessage>();
  let allTerminate = true;

  if (sequential) {
    for (const p of prepared) {
      const r = await runOne(cfg, p, taskSignal, emit);
      if (r.kind === 'aborted_before_execute') break;
      results.set(p.call.id, r.result);
      allTerminate &&= r.terminate;
      if (taskSignal.aborted) break;   // ★ 每个工具后检查;剩余不执行、不伪造结果,成为孤儿
    }
  } else {
    await Promise.all(
      prepared.map(async (p) => {      // 并发执行;tool_execution_end 按完成顺序发出
        const r = await runOne(cfg, p, taskSignal, emit);
        if (r.kind === 'aborted_before_execute') return;
        results.set(p.call.id, r.result);
        allTerminate &&= r.terminate;
      }),
    );
  }

  // ★ 回填按 assistant 源顺序
  const ordered = toolCalls
    .map((c) => results.get(c.id))
    .filter((r): r is ToolResultMessage => r !== undefined);
  return {
    toolResults: ordered,
    terminate: allTerminate && ordered.length === toolCalls.length,
  };
}
