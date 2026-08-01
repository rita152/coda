// runLoop:双层循环(外层 follow-up 续命,内层工具循环 + steering)与
// streamAssistantResponse 流水线、工具执行三阶段调度(规格见 docs/05-agent-loop.md §2-§5)。
// 独立于 Agent 类的纯函数:faux provider 下全离线可测。
// 全部复杂度围绕一个目标:转录在任何时刻(abort/length/工具失败/provider 出错)完整可重放。

import { z } from 'zod';
import type {
  AgentEvent,
  AssistantMessage,
  Context,
  ModelConfig,
  StreamFn,
  ToolCallPart,
  ToolResultMessage,
  ToolSchema,
  UserMessage,
  AgentMessage,
} from '../protocol/index.js';
import type { FileTracker } from '../shared/index.js';
import type { ToolContext, ToolDefinition } from '../tools/types.js';
import { newMessageId } from './ids.js';
import type { DrainMode, PendingMessageQueue } from './queue.js';
import { errorToolResult, failTruncatedToolCalls, formatToolError, toToolResultMessage } from './tool-result.js';
import { convertContext, INTERRUPTED_RESULT_TEXT } from './transform.js';

export type Emit = (e: AgentEvent) => Promise<void>;

/** runLoop 的完整配置:AgentConfig 的钩子 + Agent 预解析的执行环境。 */
export interface LoopConfig {
  streamFn: StreamFn;
  model: ModelConfig;
  tools: ToolDefinition[];
  toolSchemas: ToolSchema[];
  systemPrompt: string | (() => string);
  cwd: string;
  fileTracker: FileTracker;
  spillDir: string;
  transformContext?: (ctx: Context) => Promise<Context>;
  beforeToolCall?: (call: ToolCallPart) => Promise<{ block: true; reason: string } | { block?: false }>;
  afterToolCall?: (call: ToolCallPart, result: ToolResultMessage) => Promise<ToolResultMessage>;
  shouldStopAfterTurn?: (ctx: Context) => Promise<boolean>;
  toolExecution?: 'sequential' | 'parallel';
  steeringMode: () => DrainMode;   // live 读取:运行中切换即时生效
  followUpMode: () => DrainMode;
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

export async function runLoop(
  cfg: LoopConfig,
  transcript: AgentMessage[],          // 权威转录,就地追加
  queues: LoopQueues,
  taskSignal: AbortSignal,
  emit: Emit,
  seed: LoopSeed,
): Promise<void> {
  const newMessages: AgentMessage[] = []; // 本 run 新增消息,agent_end 携带

  // queue_update:drain 消费时机的快照发射(docs/06 §8.1——注入消息的 message_start 之前)
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
      const assistant = await streamAssistantResponse(cfg, transcript, taskSignal, emit);
      transcript.push(assistant);
      newMessages.push(assistant);

      // [D] error/aborted → 直接收尾(重试是 session 层的策略问题,loop 保持哑;docs/05 §2.3)
      if (assistant.stopReason === 'error' || assistant.stopReason === 'aborted') {
        await emit({ type: 'turn_end', message: assistant, toolResults: [] });
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
          stop = await cfg.shouldStopAfterTurn(currentContext(cfg, transcript));
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
 * 转发为 message_update(docs/05 §3)。顺序决策:transformContext(用户钩子,看原貌)
 * 先于 convertContext(固定清洗,出站前最后一道合法性保证)。
 */
export async function streamAssistantResponse(
  cfg: LoopConfig,
  transcript: AgentMessage[],
  taskSignal: AbortSignal,
  emit: Emit,
): Promise<AssistantMessage> {
  let started = false;
  let lastPartial: AssistantMessage | undefined;   // 防御路径复用已宣布的消息 id 与已生成内容
  let stage = 'transformContext hook';             // 防御路径的错误归因标注
  try {
    let ctx: Context = currentContext(cfg, transcript);
    if (cfg.transformContext) ctx = await cfg.transformContext(ctx);
    stage = 'convertContext';
    // 视觉能力取 compat.supportsImageParts(CompatFlags 是开放袋,此处只认布尔 false)
    ctx = convertContext(ctx, cfg.model.ref, {
      supportsImages: cfg.model.compat?.['supportsImageParts'] !== false,
    });

    // 每次模型调用取 child signal(AbortController 树,docs/05 §6):
    // 未来单调用级取消不牵连整个 run,也避免向 taskSignal 反复 addEventListener 泄漏。
    const signal = AbortSignal.any([taskSignal]);

    // StreamFn 铁律:绝不 throw、绝不 reject。外层 try 只是协议 bug 的最后防线。
    stage = 'StreamFn (provider contract: never throw/reject)';
    const stream = cfg.streamFn(cfg.model, ctx, { signal, ...cfg.model.defaults });
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
    const message = await stream.result();
    await emit({ type: 'message_end', message });
    return message;
  } catch (err) {
    // 防御路径(docs/05 §8):钩子 bug 或违约 provider,合成 error assistant 收尾,
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

/** Context 组装:systemPrompt 每 turn 重新求值 + 工具 promptSnippet 拼装(docs/07 §1.5)。 */
function currentContext(cfg: LoopConfig, transcript: AgentMessage[]): Context {
  const base = typeof cfg.systemPrompt === 'function' ? cfg.systemPrompt() : cfg.systemPrompt;
  const snippets = cfg.tools
    .filter((t) => t.promptSnippet !== undefined && t.promptSnippet.length > 0)
    .map((t) => t.promptSnippet as string);
  const systemPrompt =
    snippets.length > 0 ? `${base}\n\n# Tool usage notes\n\n${snippets.join('\n\n')}` : base;
  // messages 给浅拷贝数组:transformContext 钩子(M7 compaction 的法定挂载点)对数组的
  // splice/push 不得触及权威转录本体——「转录任何时刻完整可重放」优先于一次数组分配。
  return { systemPrompt, messages: [...transcript], tools: cfg.toolSchemas };
}

// ---------- 工具执行三阶段 ----------

type Prepared =
  | { kind: 'ok'; call: ToolCallPart; tool: ToolDefinition; args: unknown }
  | { kind: 'reject'; call: ToolCallPart; result: ToolResultMessage }; // 直接就是回喂结果

/** 阶段 1:查找 → prepareArguments 修补 → zod 校验 → beforeToolCall 拦截。失败=回喂,不 throw。 */
async function prepareToolCall(cfg: LoopConfig, call: ToolCallPart): Promise<Prepared> {
  const tool = cfg.tools.find((t) => t.name === call.name);
  if (!tool) {
    return {
      kind: 'reject',
      call,
      result: errorToolResult(
        call,
        `Unknown tool "${call.name}". Available tools: ${cfg.tools.map((t) => t.name).join(', ')}.`,
      ),
    };
  }

  let raw: unknown = call.arguments;
  if (tool.prepareArguments) {
    try {
      raw = tool.prepareArguments(raw);
    } catch {
      raw = call.arguments;  // 修补器只做无损搬运,自身出错则退回原参数走正常校验
    }
  }

  const parsed = tool.parameters.safeParse(raw);
  if (!parsed.success) {
    return {
      kind: 'reject',
      call,
      result: errorToolResult(
        call,
        `The ${tool.name} tool was called with invalid arguments: ${z.prettifyError(parsed.error)}. ` +
          'Please rewrite the input so it satisfies the expected schema.',
      ),
    };
  }

  if (cfg.beforeToolCall) {
    // 钩子 throw 按 block 处理回喂(M6 approval 挂在此钩子:审批 Promise 被 reject
    // 是现实路径,不能让它穿透 runLoop 打断整个 run)
    try {
      const d = await cfg.beforeToolCall(call);
      if (d.block) return { kind: 'reject', call, result: errorToolResult(call, d.reason) };
    } catch (err) {
      return {
        kind: 'reject',
        call,
        result: errorToolResult(call, `Tool call was blocked: beforeToolCall hook failed (${formatToolError(err)}).`),
      };
    }
  }
  return { kind: 'ok', call, tool, args: parsed.data };
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
    const toolCtx: ToolContext = {
      cwd: cfg.cwd,
      signal: AbortSignal.any([taskSignal]),   // 工具级 child signal
      onUpdate: (u) => {
        void emit({ type: 'tool_execution_update', toolCallId: p.call.id, update: u });  // 火后不理,仍进链
      },
      fileTracker: cfg.fileTracker,
    };
    try {
      const output = await p.tool.execute({ id: p.call.id, args: p.args }, toolCtx);
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
  // plan_update 旁路事件:loop 在 finalize 识别 plan 形态的 details 后发出(docs/07 §2.8,
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
 * 批调度(docs/05 §5):preflight 一律按源顺序串行(审批 UI 逐个弹出、校验顺序确定);
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
  for (const call of toolCalls) {
    // ★ preflight 也要查 abort:beforeToolCall 是审批挂载点,abort 后再 prepare 下一个 call
    //   会向已清空的 broker 发起新审批请求 → 永不 resolve → waitForIdle 挂死(R7 死锁)。
    //   已 abort 则停止 prepare 剩余 call,它们成为孤儿由 transform 层补合成中断结果。
    if (taskSignal.aborted) break;
    prepared.push(await prepareToolCall(cfg, call));
  }

  const sequential =
    cfg.toolExecution === 'sequential' ||
    prepared.some((p) => p.kind === 'ok' && p.tool.executionMode === 'sequential');

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
