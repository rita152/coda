// Responses reasoning item 的本地 replay 元数据。
// 只借用现有 ReasoningPart.signature 承载 adapter 私有信封；protocol/agent 不认识 wire 字段。

const PREFIX = 'openai-responses:v1:';

export interface ResponsesReasoningMetadata {
  itemId: string;
  kind: 'item' | 'summary' | 'content';
  index: number;
  encryptedContent?: string;
}

export function encodeReasoningMetadata(metadata: ResponsesReasoningMetadata): string {
  return `${PREFIX}${JSON.stringify(metadata)}`;
}

export function decodeReasoningMetadata(signature: string | undefined): ResponsesReasoningMetadata | undefined {
  if (signature === undefined || !signature.startsWith(PREFIX)) return undefined;
  try {
    const value = JSON.parse(signature.slice(PREFIX.length)) as Record<string, unknown>;
    const kind = value['kind'];
    if (
      typeof value['itemId'] !== 'string' ||
      value['itemId'].length === 0 ||
      (kind !== 'item' && kind !== 'summary' && kind !== 'content') ||
      typeof value['index'] !== 'number' ||
      !Number.isInteger(value['index']) ||
      value['index'] < 0 ||
      (value['encryptedContent'] !== undefined && typeof value['encryptedContent'] !== 'string')
    ) {
      return undefined;
    }
    return {
      itemId: value['itemId'],
      kind,
      index: value['index'],
      ...(typeof value['encryptedContent'] === 'string' && {
        encryptedContent: value['encryptedContent'],
      }),
    };
  } catch {
    return undefined;
  }
}
