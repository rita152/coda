// 内置 coding capability 的底层执行类型。schema、policy、identity 与 executor 的
// 原子绑定由 integrations/coding-capabilities 直接注册为 CapabilityRegistration；
// 本文件不再定义第二套工具注册协议。

import type { ImagePart, TextPart } from '../protocol/index.js';
import type { FileTrackerPort } from '../shared/index.js';

export interface ToolExecutionInput<P> {
  readonly id: string;
  readonly args: P;
}

export interface ToolContext {
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly onUpdate?: (update: Readonly<Record<string, unknown>>) => void;
  readonly fileTracker: FileTrackerPort;
}

export interface ToolOutput<D = unknown> {
  content: (TextPart | ImagePart)[];
  details?: D;                                    // 结构化细节(UI/持久化用,不发给模型)
  terminate?: boolean;                            // 批内全 terminate 才提前收尾(见 docs/05-agent-loop.md“工具”)
}

/**
 * details 的约定字段:工具自带截断(bash 的尾部截断)时打 truncated 标记,
 * 框架级截断 post-hook 看到即跳过,不做二次截断。
 */
export interface TruncatedDetails {
  truncated?: boolean;
  spilledPath?: string;                           // 全文落盘位置(有则 UI 可引导查看)
  [key: string]: unknown;
}
