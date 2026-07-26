// 工具框架类型(canonical,规格见 docs/07-tools.md §1.1)。
// 本文件是 agent 目录对 tools 的唯一合法 import(ESLint zone 白名单,见 docs/02-architecture.md):
// 只放框架契约,不放任何具体工具实现。

import type { z } from 'zod';
import type { ImagePart, TextPart } from '../protocol/index.js';
import type { FileTracker } from '../shared/index.js';

export type ToolKind = 'read' | 'search' | 'edit' | 'execute' | 'plan';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- P 默认 any:异构 ToolDefinition[] 的既定形态(docs/07 §1.1)
export interface ToolDefinition<P = any, D = unknown> {
  name: string;
  description: string;
  parameters: z.ZodType<P>;                       // z.toJSONSchema() 渲染进 Context.tools
  executionMode?: 'sequential';                   // 声明则整批退化为顺序执行(bash/edit/write 声明)
  promptSnippet?: string;                         // 拼进 system prompt 的使用指引
  kind?: ToolKind;                                // 权限分级用(M6),缺省视为 'execute'
  prepareArguments?: (raw: unknown) => unknown;   // zod 校验前的无损结构修补(docs/07 §1.4)
  execute(call: { id: string; args: P }, ctx: ToolContext): Promise<ToolOutput<D>>;
}

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  onUpdate?: (u: { output?: string }) => void;    // 流式进度(bash 100ms 节流),火后不理
  fileTracker: FileTracker;
}

export interface ToolOutput<D = unknown> {
  content: (TextPart | ImagePart)[];
  details?: D;                                    // 结构化细节(UI/持久化用,不发给模型)
  terminate?: boolean;                            // 批内全 terminate 才提前收尾(docs/05 §4)
}

/**
 * details 的约定字段:工具自带截断(bash 的尾部截断)时打 truncated 标记,
 * 框架级截断 post-hook(docs/07 §1.6)看到即跳过,不做二次截断。
 */
export interface TruncatedDetails {
  truncated?: boolean;
  spilledPath?: string;                           // 全文落盘位置(有则 UI 可引导查看)
  [key: string]: unknown;
}
