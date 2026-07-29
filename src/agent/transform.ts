// transform 层:每次出站请求前的固定清洗(规格:docs/04-provider-adapter.md §6、
// docs/06-steering-following.md §7)。产出出站副本,绝不改写权威转录——转录是事实日志
// (aborted/error 也是合法消息),清洗只发生在每次出站的视图上;不落盘、幂等、纯函数。
//
// 四步(顺序敏感:先滤 aborted 再补孤儿,被滤 assistant 的 toolResult 一并滤除):
//   1. aborted/error assistant 整条跳过不重放(不完整 turn 重放触发 API 报错);
//   2. 孤儿 toolCall 补 "[Tool execution was interrupted]" isError 合成结果(配对铁律);
//   3. 跨模型:ReasoningPart 降级 TextPart(剥 signature)、超长 toolCallId 归一化(≤40 字符);
//   4. 非视觉模型:ImagePart 降级占位文本。
//
// 结构:按「assistant 块」单遍扫描——每条 tool_result 只归属于其前方最近一条声明了
// 该 id 的 assistant(块内配对)。provider 跨 turn 复用 id(vLLM/llama.cpp 常发 call_0
// 这类确定性 id)时,全局 id 集合会把后 turn 的真实结果错配给前 turn 的孤儿/被滤块,
// 块归属是唯一正确的匹配维度。不属于任何块的 dangling tool_result 一并丢弃
// (转录事实层不会自产,但 transformContext 钩子可能产出;本层是出站合法性的最后一道)。

import type {
  AgentMessage,
  AssistantMessage,
  Context,
  ModelRef,
  TextPart,
  ToolResultMessage,
} from '../protocol/index.js';
import { newMessageId } from './ids.js';

export const isSameModel = (a: ModelRef, b: ModelRef): boolean =>
  a.provider === b.provider && a.api === b.api && a.model === b.model;

export const INTERRUPTED_RESULT_TEXT = '[Tool execution was interrupted]';

export interface ConvertOptions {
  /** 目标模型是否支持图片输入(来自 compat.supportsImageParts);缺省 true(不降级)。 */
  supportsImages?: boolean;
}

const MAX_TOOL_CALL_ID_LENGTH = 40;

export function convertContext(ctx: Context, target: ModelRef, opts?: ConvertOptions): Context {
  const supportsImages = opts?.supportsImages ?? true;

  // ---- 步骤 1 + 2:按 assistant 块扫描——滤除、块内配对、补孤儿、丢 dangling ----
  interface OpenBlock {
    assistant: AssistantMessage;
    callIds: string[];                              // tool_call 声明序
    results: Map<string, ToolResultMessage>;        // 块内已配对结果
    dropped: boolean;                               // aborted/error 块:自身与归属结果全滤
  }
  const repaired: AgentMessage[] = [];
  let block: OpenBlock | undefined;

  const closeBlock = (): void => {
    if (block === undefined) return;
    if (!block.dropped) {
      // 按 tool_calls 声明序输出:既有结果原样,缺失补合成——顺序与配对同时成立
      for (const id of block.callIds) {
        repaired.push(block.results.get(id) ?? syntheticInterruptedResult(block.assistant, id));
      }
    }
    block = undefined;
  };

  for (const m of ctx.messages) {
    if (m.role === 'assistant') {
      closeBlock();
      const dropped = m.stopReason === 'aborted' || m.stopReason === 'error';
      const callIds = m.content.filter((p) => p.type === 'tool_call').map((p) => p.id);
      if (callIds.length > 0) {
        block = { assistant: m, callIds, results: new Map(), dropped };
        if (!dropped) repaired.push(m);
        continue;
      }
      if (!dropped) repaired.push(m);
      continue;
    }
    if (m.role === 'tool_result') {
      // 只认归属于当前开放块的结果;块已关闭/无块/id 不在声明集 → dangling,丢弃
      if (block !== undefined && block.callIds.includes(m.toolCallId) && !block.results.has(m.toolCallId)) {
        if (!block.dropped) block.results.set(m.toolCallId, m);
        // dropped 块的归属结果:静默连带滤除(不 set 也不输出)
      }
      continue;
    }
    // user 消息:块的结果区结束(steering/follow-up 注入在 toolResults 之后)
    closeBlock();
    repaired.push(m);
  }
  closeBlock();

  // ---- 步骤 3 + 4:跨模型降级与图片降级(块归属的 id 映射,逐消息按需浅拷贝)----
  // 先按块收集「需要归一化的 assistant」的 id 映射,再统一施加到该块的 call 与 result。
  const idMap = new Map<string, string>();          // 仅收录跨模型块的超长 id
  for (const m of repaired) {
    if (m.role !== 'assistant' || isSameModel(m.model, target)) continue;
    for (const p of m.content) {
      if (p.type === 'tool_call' && p.id.length > MAX_TOOL_CALL_ID_LENGTH && !idMap.has(p.id)) {
        idMap.set(p.id, normalizeToolCallId(p.id));
      }
    }
  }

  // 块归属追踪:result 的 id 映射只在其归属 assistant 被归一化时施加
  let currentAssistantCross = false;
  const finalMessages = repaired.map((m) => {
    if (m.role === 'assistant') currentAssistantCross = !isSameModel(m.model, target);
    return transformMessage(m, target, supportsImages, idMap, m.role === 'tool_result' && currentAssistantCross);
  });

  return { ...ctx, messages: finalMessages };
}

function syntheticInterruptedResult(assistant: AssistantMessage, toolCallId: string): ToolResultMessage {
  const call = assistant.content.find((p) => p.type === 'tool_call' && p.id === toolCallId);
  return {
    role: 'tool_result',
    id: newMessageId('tr'),
    timestamp: assistant.timestamp,
    toolCallId,
    toolName: call?.type === 'tool_call' ? call.name : 'unknown',
    content: [{ type: 'text', text: INTERRUPTED_RESULT_TEXT }],
    isError: true,
  };
}

function transformMessage(
  m: AgentMessage,
  target: ModelRef,
  supportsImages: boolean,
  idMap: Map<string, string>,
  resultOwnerIsCrossModel: boolean,
): AgentMessage {
  if (m.role === 'user') {
    if (supportsImages || !m.content.some((p) => p.type === 'image')) return m;
    return { ...m, content: m.content.map((p) => (p.type === 'image' ? imagePlaceholder(p.mimeType) : p)) };
  }

  if (m.role === 'assistant') {
    const crossModel = !isSameModel(m.model, target);
    if (!crossModel) return m;
    const needsFix = m.content.some(
      (p) => p.type === 'reasoning' || (p.type === 'tool_call' && idMap.has(p.id)),
    );
    if (!needsFix) return m;
    return {
      ...m,
      content: m.content.map((p) => {
        if (p.type === 'reasoning') {
          // 跨模型:signature 无法被其它模型验证,整块降级为普通文本
          return { type: 'text', text: p.text } satisfies TextPart;
        }
        if (p.type === 'tool_call' && idMap.has(p.id)) {
          return { ...p, id: idMap.get(p.id) as string };
        }
        return p;
      }),
    };
  }

  // tool_result:id 映射仅当归属 assistant 是跨模型块;图片降级与模型无关
  const mappedId = resultOwnerIsCrossModel ? idMap.get(m.toolCallId) : undefined;
  const needsImageFix = !supportsImages && m.content.some((p) => p.type === 'image');
  if (mappedId === undefined && !needsImageFix) return m;
  return {
    ...m,
    ...(mappedId !== undefined && { toolCallId: mappedId }),
    ...(needsImageFix && {
      content: m.content.map((p) => (p.type === 'image' ? imagePlaceholder(p.mimeType) : p)),
    }),
  };
}

function imagePlaceholder(mimeType: string): TextPart {
  return { type: 'text', text: `[image omitted: ${mimeType}]` };
}

/** 超长 id 压到 ≤40 字符:'call_' + 内容哈希前 35 位,确定性映射(同 id 恒同像)。 */
function normalizeToolCallId(id: string): string {
  const digest = new Bun.CryptoHasher('sha256').update(id).digest('hex');
  return `call_${digest.slice(0, 35)}`;
}
