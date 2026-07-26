// AgentEvent:agent → UI/客户端的事件面(canonical,规格见 docs/03-internal-protocol.md 第 7 节)。
// 生命周期文法:
//   run  := agent_start turn* agent_end
//   turn := turn_start injected-user-message* assistant-message tool-phase? turn_end
//   assistant-message := message_start message_update* message_end
//   tool-phase := (tool_execution_start tool_execution_update* tool_execution_end)+
//                 tool-result-message*        // message_start/message_end 对,按 assistant 源顺序
// queue_update / plan_update / approval_request / error(fatal:false) 是旁路事件,可出现在
// 骨架任意间隙——approval_request 发生在 prepare 阶段(tool_execution_start 之前),
// 且由权限层(ApprovalBroker)经宿主通道发出,不经过 agent 的 Emitter(loop 对审批零感知)。
// 消费端纪律:tolerant reader——未知 type 静默忽略,已知事件的未知字段忽略。

import type { AgentMessage, AssistantMessage, ToolResultMessage } from './messages.js';
import type { ProviderEvent } from './provider.js';

export interface QueuedMessage { id: string; text: string; kind: 'steering' | 'follow_up' }
export interface PlanStep { step: string; status: 'pending' | 'in_progress' | 'completed' }

export type AgentEvent =
  | { type: 'agent_start'; reason: 'prompt' | 'follow_up' | 'continue' }
  | { type: 'agent_end';   reason: 'completed' | 'aborted' | 'error'; messages: AgentMessage[] }
  | { type: 'turn_start' }
  | { type: 'turn_end'; message: AssistantMessage; toolResults: ToolResultMessage[] }
  | { type: 'message_start'; message: AgentMessage }                       // user / assistant / tool_result 都走此生命周期
  | { type: 'message_update'; messageId: string; event: ProviderEvent }    // 仅 assistant 流式期间(只搬运三段式块事件)
  | { type: 'message_end'; message: AgentMessage }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_execution_update'; toolCallId: string; update: { output?: string; [k: string]: unknown } }
  | { type: 'tool_execution_end'; toolCallId: string; result: ToolResultMessage }
  | { type: 'queue_update'; steering: QueuedMessage[]; followUp: QueuedMessage[] }
  | { type: 'plan_update'; steps: PlanStep[] }
  | { type: 'approval_request'; approvalId: string; toolCallId: string; description: string }   // M6
  | { type: 'error'; message: string; fatal: boolean };
