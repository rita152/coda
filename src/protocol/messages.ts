// 消息模型:会话数据层(canonical 类型,规格见 docs/03-internal-protocol.md 第 2、3 节)。
// 本文件是全项目的"事实存储"类型:JSONL 持久化按行存的就是 AgentMessage,恢复即重放。

export type StopReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error' | 'aborted';

export interface TextPart      { type: 'text'; text: string }
export type AssistantMessagePhase = 'commentary' | 'final_answer';
export interface AssistantTextPart extends TextPart {
  /**
   * provider 显式声明的可见文本阶段。缺省表示 provider 未标注；消费者不得根据
   * reasoning 或文本位置自行推断 commentary。
   */
  phase?: AssistantMessagePhase;
}
export interface ReasoningPart {
  type: 'reasoning';
  text: string;
  /** 仅显式标记为 summary 的文本可进入面向用户的临时 Working 投影。 */
  kind?: 'summary' | 'content';
  signature?: string;
}
export interface ImagePart     { type: 'image'; data: string /* base64 */; mimeType: string }
export interface ToolCallPart  {
  type: 'tool_call'; id: string; name: string;
  arguments: Record<string, unknown>;   // 解析后的参数(流式期间用容错 JSON 解析持续刷新)
  rawArguments?: string;                // 原始 JSON 字符串(截断诊断用)
}

/** 内置 adapter 名可自动补全；开放尾项保留第三方 adapter 的扩展能力。 */
export type ModelApi =
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'faux'
  | (string & {});

export interface ModelRef { provider: string; api: ModelApi; model: string }

export interface Usage {
  input: number;          // inclusive:含 cacheRead/cacheWrite
  output: number;         // inclusive:含 reasoning
  cacheRead?: number; cacheWrite?: number; reasoning?: number;
  costUSD?: number;
}

/**
 * adapter 填写的结构化错误分类(规格见 docs/08-session-persistence.md §5.1),
 * 供 session 层 retry/compaction 判定,免于对 errorMessage 做正则猜测。
 */
export interface ProviderErrorDetails {
  status?: number;            // HTTP 状态码
  code?: string;              // provider 错误码
  requestId?: string;
  kind: 'network' | 'http' | 'overflow' | 'auth' | 'rate_limit' | 'aborted' | 'unknown';
  retryable: boolean;         // adapter 的初判,session 可覆盖
  retryAfterMs?: number;      // 来自 Retry-After / ratelimit 头
}

export interface UserMessage {
  role: 'user'; id: string; timestamp: number;
  content: (TextPart | ImagePart)[];
  source?: 'prompt' | 'steering' | 'follow_up' | 'synthetic';  // synthetic = 系统合成(如 plan 批准注入)
}
export interface AssistantMessage {
  role: 'assistant'; id: string; timestamp: number;
  content: (AssistantTextPart | ReasoningPart | ToolCallPart)[];
  model: ModelRef;
  stopReason: StopReason; errorMessage?: string;   // error/aborted 也是一条合法消息,保留在转录中
  errorDetails?: ProviderErrorDetails;
  usage: Usage;
}
export interface ToolResultMessage {
  role: 'tool_result'; id: string; timestamp: number;
  toolCallId: string; toolName: string;
  content: (TextPart | ImagePart)[];   // 工具结果支持图片
  isError: boolean;
  details?: unknown;                    // 结构化细节(如 edit 的 diff),UI/持久化用,不发给模型
}
export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage;

/** JSON Schema 的开放承载形态(工具层用 z.toJSONSchema() 渲染,protocol 不依赖 zod)。 */
export type JSONSchema = { [key: string]: unknown };

export interface ToolSchema {
  name: string;
  description: string;
  parameters: JSONSchema;
}

/**
 * 一次 provider 请求的完整输入。值对象:agent 每次调用 StreamFn 前由 transformContext
 * 钩子与 transform 层重新构造,provider 不持有会话状态。
 */
export interface Context {
  systemPrompt?: string;
  messages: AgentMessage[];
  tools?: ToolSchema[];
}
