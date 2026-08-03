// Anthropic redacted_thinking 的 adapter 私有 replay 信封。
// canonical protocol 复用 ReasoningPart.signature 承载 provider 元数据；data 本身始终只作为
// opaque string 保存和取出，不在 adapter 内解密、解析或生成用户可见文本。

const PREFIX = 'anthropic-messages:redacted-thinking:v1:';

interface RedactedThinkingEnvelope {
  type: 'redacted_thinking';
  data: string;
}

export function encodeRedactedThinking(data: string): string {
  const envelope: RedactedThinkingEnvelope = { type: 'redacted_thinking', data };
  return `${PREFIX}${JSON.stringify(envelope)}`;
}

export function decodeRedactedThinking(signature: string | undefined): string | undefined {
  if (signature === undefined || !signature.startsWith(PREFIX)) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(signature.slice(PREFIX.length)) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)
    || Object.keys(parsed).length !== 2
    || parsed.type !== 'redacted_thinking'
    || typeof parsed.data !== 'string') {
    return undefined;
  }
  return parsed.data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
