// 内置工具集出口(M3:七个;M6 增 plan)。工具不感知 agent loop,经 ToolContext 回调对外沟通。
// 规格见 docs/07-tools.md。注册顺序即 promptSnippet 拼装顺序(§1.5)。

import { bashTool } from './bash.js';
import { editTool } from './edit.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { lsTool } from './ls.js';
import { readTool } from './read.js';
import type { ToolDefinition } from './types.js';
import { writeTool } from './write.js';

export { bashTool } from './bash.js';
export { editTool } from './edit.js';
export { globTool } from './glob.js';
export { grepTool } from './grep.js';
export { lsTool } from './ls.js';
export { readTool } from './read.js';
export { writeTool } from './write.js';
export type { ToolContext, ToolDefinition, ToolKind, ToolOutput, TruncatedDetails } from './types.js';

/** 完整 coding 工具面(docs/07 §2 的七个;M6 加 plan)。 */
export function createCodingTools(): ToolDefinition[] {
  return [readTool, lsTool, globTool, grepTool, bashTool, editTool, writeTool];
}
