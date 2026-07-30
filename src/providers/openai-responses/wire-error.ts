// SDK 抛错之外的 Responses SSE 终态错误。结构留在 adapter 内，不泄漏到 protocol/agent。

export class ResponsesWireError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'ResponsesWireError';
    this.code = code;
  }
}
