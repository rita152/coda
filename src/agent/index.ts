// Agent 核心的公共出口。本目录不 import 任何 provider(经 StreamFn 注入)、
// 不 import 具体工具实现(仅 tools/types.ts)。规格:docs/05-agent-loop.md、docs/06-steering-following.md。
export { Agent } from './agent.js';
export type { AgentConfig } from './agent.js';
export type { AgentEventListener } from './events.js';
export { runLoop, streamAssistantResponse } from './loop.js';
export type {
  LoopConfig,
  LoopQueues,
  LoopSeed,
  RuntimeToolPreparation,
  RuntimeTurnPort,
  RuntimeTurnProvider,
} from './loop.js';
export { PendingMessageQueue } from './queue.js';
export type { DrainMode } from './queue.js';
export { convertContext, isSameModel, INTERRUPTED_RESULT_TEXT } from './transform.js';
export type { ConvertOptions } from './transform.js';
