// compaction 协作者(规格见 docs/08-session-persistence.md §6.3):切点选择 + 摘要生成。
// 两个纯粹的能力,不碰 agent、不碰磁盘——切点是纯函数,摘要是一次性 streamFn 调用。
// 生效机制(transformContext 折叠 + CompactionRecord 落盘)在 session.ts;本文件只产料。

import type {
  AgentMessage,
  Context,
  ModelConfig,
  StreamFn,
  UserMessage,
} from '../protocol/index.js';

export interface CompactionOptions {
  enabled?: boolean; // M7 起默认 true(仍需 model.limits.context 才会触发)
  threshold?: number; // 默认 0.8:contextTokens 超过 threshold*(context-reserveOutput) 触发
  keepRatio?: number; // 默认 0.25:保留尾部预算 = contextTokens * keepRatio
  summaryMaxTokens?: number; // 默认 2000:摘要请求的 maxOutputTokens
}

export type ResolvedCompactionOptions = Required<CompactionOptions>;

export const DEFAULT_COMPACTION_OPTIONS: ResolvedCompactionOptions = {
  enabled: true,
  threshold: 0.8,
  keepRatio: 0.25,
  summaryMaxTokens: 2000,
};

export function resolveCompactionOptions(opts?: CompactionOptions): ResolvedCompactionOptions {
  return { ...DEFAULT_COMPACTION_OPTIONS, ...opts };
}

/** overflow 摘要失败时的硬截断占位(docs/08 §6.5:信息有损但会话能活)。 */
export const HARD_TRUNCATION_SUMMARY = '[Earlier conversation truncated due to context limit]';

export const SUMMARIZE_PROMPT = [
  'You are summarizing an earlier portion of a coding-agent conversation so it can be',
  'dropped from the active context while preserving everything needed to continue the task.',
  'Write a dense, factual summary (no preamble, no chit-chat) covering:',
  '- Task goal: what the user asked for.',
  '- Done: what has already been accomplished.',
  '- Pending: what still needs to happen.',
  '- Key files and paths touched or referenced.',
  '- Important decisions, constraints, and gotchas discovered.',
  '- Next step: the immediate action to take when work resumes.',
  'Be specific with names, paths, and identifiers. Omit nothing load-bearing.',
].join('\n');

/** len(JSON)/4 粗估 token——compaction 不需要真 tokenizer(docs/08 §6.1/§6.3)。 */
function estimateTokens(m: AgentMessage): number {
  return Math.ceil(JSON.stringify(m).length / 4);
}

/** turn 起点:prompt/steering/follow_up 来源的 user 消息(synthetic 摘要不算切点)。 */
function isTurnStart(m: AgentMessage): boolean {
  return (
    m.role === 'user' &&
    (m.source === 'prompt' || m.source === 'steering' || m.source === 'follow_up')
  );
}

/**
 * 选择保留尾部的起始下标(docs/08 §6.3):
 *   从尾部向前累计估算 token 到 keepBudget → 得到粗切点;
 *   切点向前(向更早)对齐到最近一条 turn 起点 user 消息——保证不切开 assistant 的
 *   tool_call 与其 tool_result;找不到则退化为保留最后一整个 turn 并告警。
 * 返回下标 idx 表示 messages.slice(idx) 为保留尾部;0 表示不丢弃任何消息。
 */
export function selectTailStart(messages: readonly AgentMessage[], keepBudget: number): number {
  if (messages.length === 0) return 0;

  let acc = 0;
  let cut = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    acc += estimateTokens(messages[i] as AgentMessage);
    cut = i;
    if (acc >= keepBudget) break;
  }

  // 向更早对齐到最近的 turn 起点
  for (let i = cut; i >= 0; i--) {
    if (isTurnStart(messages[i] as AgentMessage)) return i;
  }

  // 找不到:退化保留最后一整个 turn(最靠尾部的 turn 起点)
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isTurnStart(messages[i] as AgentMessage)) {
      console.error('[compaction] no turn start before cut point; keeping only the last turn');
      return i;
    }
  }
  // 全程没有 turn 起点(极端):保留全部,不丢弃
  console.error('[compaction] no turn start found; keeping full transcript');
  return 0;
}

/**
 * 被丢弃前缀的文本化渲染:发给摘要模型的一次性 user 消息内容。
 * 超长时对中部做硬截断(首尾优先保留),避免摘要请求自身超限。
 */
export function renderForSummary(dropped: readonly AgentMessage[], maxChars = 24000): string {
  const lines: string[] = [];
  for (const m of dropped) {
    lines.push(renderMessage(m));
  }
  const text = lines.join('\n\n');
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head;
  return `${text.slice(0, head)}\n\n[... ${text.length - maxChars} chars of the middle omitted ...]\n\n${text.slice(-tail)}`;
}

function renderMessage(m: AgentMessage): string {
  if (m.role === 'user') {
    return `USER${m.source ? ` (${m.source})` : ''}: ${textOfParts(m.content)}`;
  }
  if (m.role === 'assistant') {
    const parts: string[] = [];
    for (const p of m.content) {
      if (p.type === 'text') parts.push(p.text);
      else if (p.type === 'reasoning') parts.push(`[reasoning] ${p.text}`);
      else if (p.type === 'tool_call') parts.push(`[tool_call ${p.name}] ${JSON.stringify(p.arguments)}`);
    }
    return `ASSISTANT: ${parts.join('\n')}`;
  }
  // tool_result
  return `TOOL_RESULT (${m.toolName}${m.isError ? ', error' : ''}): ${textOfParts(m.content)}`;
}

function textOfParts(content: { type: string; text?: string }[]): string {
  return content
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join(' ');
}

/**
 * 一次性摘要请求(docs/08 §6.3):不经过 agent,直接调 streamFn。挂 session 的 AbortSignal
 * 使 Esc 可取消。失败(error/aborted)抛出——由 session 决定降级(threshold 放弃 / overflow 硬截断)。
 */
export async function summarize(
  streamFn: StreamFn,
  model: ModelConfig,
  dropped: readonly AgentMessage[],
  opts: { summaryMaxTokens?: number; signal?: AbortSignal },
): Promise<string> {
  const user: UserMessage = {
    role: 'user',
    id: `u_compact_req_${Math.random().toString(36).slice(2, 10)}`,
    timestamp: Date.now(),
    content: [{ type: 'text', text: renderForSummary(dropped) }],
    source: 'synthetic',
  };
  const ctx: Context = { systemPrompt: SUMMARIZE_PROMPT, messages: [user], tools: [] };

  const stream = streamFn(model, ctx, {
    ...(opts.signal ? { signal: opts.signal } : {}),
    maxOutputTokens: opts.summaryMaxTokens ?? DEFAULT_COMPACTION_OPTIONS.summaryMaxTokens,
  });
  const msg = await stream.result(); // StreamFn 铁律:永不 reject,错误编码为消息
  if (msg.stopReason === 'error' || msg.stopReason === 'aborted') {
    throw new Error(msg.errorMessage ?? `summarization failed (stopReason '${msg.stopReason}')`);
  }
  const summary = msg.content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('')
    .trim();
  if (summary.length === 0) throw new Error('summarization returned empty text');
  return summary;
}
