// Provider 边界:ProviderEvent 流事件、StreamFn 契约、ModelConfig。
// 规格见 docs/04-provider-adapter.md“请求”与“流”;事件文法不变量如下:
//   stream   := start block* terminal
//   block    := text | reasoning | tool_call        (各自三段式 *_start *_delta* *_end)
//   terminal := done | error                        (恰好一个,且是最后一个事件)
// 铁律:StreamFn 一旦被调用绝不 throw、绝不 reject;一切错误编码为流内 error 事件。

import type { AssistantMessage, Context, ModelRef, ToolCallPart } from './messages.js';
import { EventStream } from './event-stream.js';
import { strictJsonSnapshot } from './strict-json.js';

export type ProviderEvent =
  | { type: 'start'; partial: AssistantMessage }
  | { type: 'text_start';      contentIndex: number; partial: AssistantMessage }
  | { type: 'text_delta';      contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: 'text_end';        contentIndex: number; content: string; partial: AssistantMessage }
  | { type: 'reasoning_start'; contentIndex: number; partial: AssistantMessage }
  | { type: 'reasoning_delta'; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: 'reasoning_end';   contentIndex: number; content: string; partial: AssistantMessage }
  | { type: 'tool_call_start'; contentIndex: number; partial: AssistantMessage }
  | { type: 'tool_call_delta'; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: 'tool_call_end';   contentIndex: number; toolCall: ToolCallPart; partial: AssistantMessage }
  | { type: 'done';  message: AssistantMessage }    // stopReason ∈ stop | length | tool_calls | content_filter
  | { type: 'error'; message: AssistantMessage };   // stopReason ∈ error | aborted

/**
 * Provider adapters deliberately grow one mutable assistant accumulator while parsing a wire
 * stream.  The queue cannot retain that accumulator by reference: a durable/event listener may be
 * awaiting an earlier event while the adapter advances later deltas.  Capture strict JSON at the
 * production boundary so every queued event denotes the partial that existed at push time.
 */
export class ProviderEventStream extends EventStream<ProviderEvent, AssistantMessage> {
  override push(event: ProviderEvent): void {
    super.push(strictJsonSnapshot(event) as unknown as ProviderEvent);
  }

  override end(result: AssistantMessage): void {
    super.end(strictJsonSnapshot(result) as unknown as AssistantMessage);
  }
}

/**
 * 方言开关的开放承载形态。具体字段是各 adapter 的私有契约(openai-chat 的完整定义见
 * 所属 adapter,由 adapter 导出精确类型并在入口处收窄;所有权见 docs/04-provider-adapter.md“请求”)。
 * protocol 层不为任何 adapter 的方言建模——依赖方向(protocol 零依赖)禁止在此
 * 引用 adapter 类型,这里只承载"透传给 adapter 的配置袋"。
 */
export type CompatFlags = { [key: string]: unknown };

export interface ModelConfig {
  ref: ModelRef;
  baseURL?: string; apiKey?: string; headers?: Record<string, string>;
  compat?: CompatFlags;      // 方言开关,见 docs/04-provider-adapter.md
  capabilities?: Readonly<Record<string, unknown>>; // provider model metadata,供参数协商
  limits?: { context: number; output: number };
  defaults?: { temperature?: number; reasoningEffort?: string; maxOutputTokens?: number };
}
export interface StreamOptions { signal?: AbortSignal; temperature?: number; maxOutputTokens?: number; reasoningEffort?: string }
export type StreamFn = (model: ModelConfig, context: Context, options?: StreamOptions) => ProviderEventStream;
