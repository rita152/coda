// ProviderEvent 文法校验器(docs/03-internal-protocol.md 4.2 的可执行形态)。
// 对 faux provider 与真实 adapter(M2 起)的事件流做同一套断言——
// faux 自己违反事件文法时,这里全线报警。校验失败直接 throw(bun:test 报为测试失败)。

import type { AssistantMessage, ProviderEvent, Usage } from '../../src/protocol/index.js';

const BLOCK_FAMILY = {
  text_start: 'text', text_delta: 'text', text_end: 'text',
  reasoning_start: 'reasoning', reasoning_delta: 'reasoning', reasoning_end: 'reasoning',
  tool_call_start: 'tool_call', tool_call_delta: 'tool_call', tool_call_end: 'tool_call',
} as const;

function fail(message: string, index: number, event: ProviderEvent): never {
  throw new Error(`[provider-events] ${message} (event #${index}: ${JSON.stringify(event.type)})`);
}

/**
 * 断言:start 开头、恰好一个终止事件且在最后、done 前所有块闭合、
 * contentIndex 与 partial.content 对齐、done/error 的 stopReason 划分正确。
 */
export function assertValidProviderEventSequence(events: ProviderEvent[]): void {
  if (events.length === 0) throw new Error('[provider-events] empty event sequence');
  if (events[0]?.type !== 'start') fail('first event must be start', 0, events[0] as ProviderEvent);

  const open = new Map<number, string>();   // contentIndex → family
  const closed = new Set<number>();
  const deltas = new Map<number, string>(); // contentIndex → 累积 delta(与 *_end.content 交叉校验)
  let started = 0;                          // 已开块数(append-only 检查)
  let terminalSeen = false;

  events.forEach((event, i) => {
    if (terminalSeen) fail('event after terminal', i, event);
    if (i > 0 && event.type === 'start') fail('duplicate start', i, event);

    if (event.type === 'done' || event.type === 'error') {
      terminalSeen = true;
      const sr = event.message.stopReason;
      if (event.type === 'done' && !['stop', 'length', 'tool_calls', 'content_filter'].includes(sr)) {
        fail(`done with invalid stopReason '${sr}'`, i, event);
      }
      if (event.type === 'error' && !['error', 'aborted'].includes(sr)) {
        fail(`error with invalid stopReason '${sr}'`, i, event);
      }
      if (event.type === 'done' && open.size > 0) {
        fail(`done with unclosed block(s): index ${[...open.keys()].join(',')}`, i, event);
      }
      assertUsageInvariants(event.message.usage);
      // 最终消息不变量:每个 tool_call part 的 arguments 必须等于 parse(rawArguments)
      // (raw 可解析为对象时;length 截断等不可解析场景豁免)——抓「迟到分片使二者脱节」类缺陷
      for (const part of event.message.content) {
        if (part.type === 'tool_call' && part.rawArguments !== undefined) {
          try {
            const parsed: unknown = JSON.parse(part.rawArguments);
            if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
              if (JSON.stringify(part.arguments) !== JSON.stringify(parsed)) {
                fail(`tool_call '${part.id}' arguments != parse(rawArguments)`, i, event);
              }
            }
          } catch {
            // 不可解析:豁免
          }
        }
      }
      return;
    }
    if (event.type === 'start') return;

    const family = BLOCK_FAMILY[event.type];
    const { contentIndex, partial } = event;
    if (event.type.endsWith('_start')) {
      if (open.has(contentIndex) || closed.has(contentIndex)) {
        fail(`block index ${contentIndex} reused`, i, event);
      }
      // append-only:块按 index 递增追加,contentIndex === 已开块数(docs/03 §4.2.4)
      if (contentIndex !== started) {
        fail(`block index ${contentIndex} not append-only (expected ${started})`, i, event);
      }
      started++;
      const part = partial.content[contentIndex];
      if (part === undefined) fail(`contentIndex ${contentIndex} out of partial.content`, i, event);
      if (part.type !== family) {
        fail(`partial.content[${contentIndex}].type '${part.type}' != '${family}'`, i, event);
      }
      open.set(contentIndex, family);
    } else {
      if (open.get(contentIndex) !== family) {
        fail(`${event.type} on block ${contentIndex} not open as '${family}'`, i, event);
      }
      if (event.type.endsWith('_delta') && 'delta' in event) {
        deltas.set(contentIndex, (deltas.get(contentIndex) ?? '') + event.delta);
      }
      if (event.type.endsWith('_end')) {
        open.delete(contentIndex);
        closed.add(contentIndex);
        const folded = deltas.get(contentIndex) ?? '';
        const part = partial.content[contentIndex];
        if (event.type === 'text_end' || event.type === 'reasoning_end') {
          // *_end.content 是该块完整文本 == 累积 delta == partial 中的块文本(docs/03 §4.2.6)
          if (event.content !== folded) {
            fail(`${event.type}.content != folded deltas ('${event.content}' vs '${folded}')`, i, event);
          }
          if (part !== undefined && 'text' in part && part.text !== event.content) {
            fail(`partial.content[${contentIndex}].text != ${event.type}.content`, i, event);
          }
        }
        if (event.type === 'tool_call_end') {
          // event.toolCall 是活引用,本校验发生在流结束后:交错 index 方言下已关闭槽位
          // 可能收到「迟到分片」(并入 raw 但不再发事件),因此不变量是前缀关系而非相等
          // ——每个 delta 都必须体现在 raw 中,raw 允许多出未发事件的尾部。
          if (event.toolCall.rawArguments !== undefined && !event.toolCall.rawArguments.startsWith(folded)) {
            fail(`tool_call_end: folded deltas not a prefix of rawArguments`, i, event);
          }
          // 自比较(toolCall vs partial.content[i])恒真无探测力,不做;
          // arguments 与 rawArguments 的最终一致性由终态检查承担。
        }
      }
    }
  });

  if (!terminalSeen) throw new Error('[provider-events] missing terminal event (done|error)');
}

export function assertUsageInvariants(usage: Usage): void {
  if ((usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) > usage.input) {
    throw new Error(`[provider-events] usage invariant violated: input(${usage.input}) < cacheRead+cacheWrite`);
  }
  if ((usage.reasoning ?? 0) > usage.output) {
    throw new Error(`[provider-events] usage invariant violated: output(${usage.output}) < reasoning`);
  }
}

/**
 * 从 delta 事件折叠出各内容块的文本(属性测试用:随机事件序列折叠后等于 done 消息,
 * 对应 opencode LLMResponse.reduce 的 reducer 思路)。
 */
export function foldDeltas(events: ProviderEvent[]): Map<number, string> {
  const folded = new Map<number, string>();
  for (const event of events) {
    if (event.type === 'text_delta' || event.type === 'reasoning_delta' || event.type === 'tool_call_delta') {
      folded.set(event.contentIndex, (folded.get(event.contentIndex) ?? '') + event.delta);
    }
  }
  return folded;
}

/** 消费整条流:收集全部事件 + 最终消息。 */
export async function collectStream(
  stream: AsyncIterable<ProviderEvent> & { result(): Promise<AssistantMessage> },
): Promise<{ events: ProviderEvent[]; final: AssistantMessage }> {
  const events: ProviderEvent[] = [];
  for await (const event of stream) events.push(event);
  return { events, final: await stream.result() };
}

/** 微任务级等待条件成立(不用计时器,保持确定性;上限防死等)。 */
export async function microtaskUntil(cond: () => boolean, limit = 10_000): Promise<void> {
  for (let i = 0; i < limit; i++) {
    if (cond()) return;
    await Promise.resolve();
  }
  throw new Error('[provider-events] microtaskUntil: condition not met within limit');
}
