// tool_calls / tool 配对断言(docs/04 Provider Adapter 的请求契约)。
// 结构化读取 wire 消息,不 import openai 类型。校验失败 throw(bun:test 报为测试失败)。

interface WireToolCall { id?: string }
interface WireMessage {
  role?: string;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
}

/**
 * 断言:每个 assistant.tool_calls[].id 有恰好一条 role:'tool' 消息紧跟其后(连续、
 * 顺序一致);不存在无前置 assistant(tool_calls) 的孤儿 tool 消息。
 */
export function assertToolCallPairing(messages: unknown[]): void {
  const msgs = messages as WireMessage[];
  let i = 0;
  while (i < msgs.length) {
    const m = msgs[i] as WireMessage;
    if (m.role === 'tool') {
      throw new Error(`[wire-pairing] orphan tool message at #${i} (no preceding assistant tool_calls)`);
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const expected = m.tool_calls.map((tc) => tc.id);
      for (const id of expected) {
        if (typeof id !== 'string' || id.length === 0) {
          throw new Error(`[wire-pairing] assistant #${i} has tool_call with empty/missing id(兜底失效)`);
        }
      }
      if (new Set(expected).size !== expected.length) {
        throw new Error(`[wire-pairing] assistant #${i} has duplicate tool_call ids: ${expected.join(',')}`);
      }
      for (let k = 0; k < expected.length; k++) {
        const follower = msgs[i + 1 + k];
        if (follower?.role !== 'tool') {
          throw new Error(
            `[wire-pairing] assistant #${i} expects ${expected.length} tool message(s) immediately after; ` +
            `#${i + 1 + k} is role '${follower?.role ?? 'missing'}'`,
          );
        }
        if (follower.tool_call_id !== expected[k]) {
          throw new Error(
            `[wire-pairing] tool message #${i + 1 + k} answers '${follower.tool_call_id ?? 'missing'}', ` +
            `expected '${expected[k]}' (order must match tool_calls)`,
          );
        }
      }
      i += 1 + expected.length;
      continue;
    }
    i++;
  }
}
