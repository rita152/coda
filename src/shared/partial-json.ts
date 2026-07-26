// 容错 JSON 解析:流式期间对逐段生长的 arguments 字符串做尽力解析,
// 与真 adapter 的行为一致(docs/03-internal-protocol.md 2.2:ToolCallPart.arguments
// 在每个 delta 后被容错解析刷新)。解析不出时返回 {},绝不 throw。

export function parsePartialJson(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (trimmed === '') return {};
  const direct = tryParseObject(trimmed);
  if (direct !== undefined) return direct;

  // 修复:扫描字符串/括号状态,砍掉悬空转义,补闭合引号与括号。
  let inString = false;
  let escape = false;
  const closers: string[] = [];
  for (const ch of trimmed) {
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') closers.push('}');
    else if (ch === '[') closers.push(']');
    else if (ch === '}' || ch === ']') closers.pop();
  }
  let repaired = trimmed;
  if (escape) repaired = repaired.slice(0, -1);
  if (inString) repaired += '"';
  repaired = repaired.replace(/,\s*$/, '').replace(/:\s*$/, ':null');
  let closed = repaired;
  for (let i = closers.length - 1; i >= 0; i--) closed += closers[i];
  const parsed = tryParseObject(closed);
  if (parsed !== undefined) return parsed;
  // 仍失败:截断点落在 key 内或裸字面量内(如 '{"a":1,"old' / '{"flag":tr')。
  // 剥掉尾部悬空的 key/字面量片段后重试一次,保住已完成的前缀。
  const stripped = repaired.replace(/,?\s*"[^"]*"?\s*:?\s*[^",{}[\]]*$/, '');
  if (stripped !== repaired) {
    let retry = stripped.replace(/,\s*$/, '');
    for (let i = closers.length - 1; i >= 0; i--) retry += closers[i];
    const second = tryParseObject(retry);
    if (second !== undefined) return second;
  }
  return {};
}

function tryParseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
