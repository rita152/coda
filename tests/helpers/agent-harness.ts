// L4 loop 测试的公共 harness:测试工具构造、AgentEvent 收集与等待、事件序列归一化。
// 纪律(docs/10 §5/§8):时序控制只用 faux 的 gate 与事件等待,禁止计时器;
// 断言出站转录一律用 faux 的 calls,不猜 agent 内部状态。

import { z } from 'zod';
import { Agent } from '../../src/agent/index.js';
import type { AgentConfig } from '../../src/agent/index.js';
import type { AgentEvent, AgentMessage, ModelConfig } from '../../src/protocol/index.js';
import { createFauxStreamFn } from '../../src/providers/faux/index.js';
import type { FauxScript } from '../../src/providers/faux/index.js';
import type { ToolContext, ToolDefinition, ToolOutput } from '../../src/tools/types.js';

export const TEST_MODEL: ModelConfig = {
  ref: { provider: 'faux', api: 'faux', model: 'test' },
};

/** 极简测试工具:单 value 字段 schema,execute 可注入(第 2 参拿 ToolContext,可观测 signal)。 */
export function makeTool(
  name: string,
  execute: (args: { value?: string }, ctx: ToolContext) => Promise<ToolOutput>,
  opts?: { executionMode?: 'sequential' },
): ToolDefinition {
  return {
    name,
    description: `test tool ${name}`,
    parameters: z.object({
      value: z.string().optional().describe('test value'),
    }),
    executionMode: opts?.executionMode,
    execute: async (call, ctx) => execute(call.args as { value?: string }, ctx),
  };
}

/**
 * 内部消息 → wire 形状(assistant.tool_calls / tool.tool_call_id)的最小映射,
 * 供复用 M2 的配对断言 assertToolCallPairing 直接验 transform 产物(docs/11 M4 验收 3)。
 * 真正的 wire 渲染在 adapter(tests zone 禁 import openai-chat),此映射只保留配对结构。
 */
export function toWireShape(messages: readonly AgentMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'assistant') {
      const toolCalls = m.content.filter((p) => p.type === 'tool_call').map((p) => ({ id: p.id }));
      return toolCalls.length > 0 ? { role: 'assistant', tool_calls: toolCalls } : { role: 'assistant' };
    }
    if (m.role === 'tool_result') return { role: 'tool', tool_call_id: m.toolCallId };
    return { role: m.role };
  });
}

export function textOutput(text: string): ToolOutput {
  return { content: [{ type: 'text', text }] };
}

export interface Harness {
  agent: Agent;
  events: AgentEvent[];
  streamFn: ReturnType<typeof createFauxStreamFn>;
  /** 等待谓词命中的下一个事件(含未来事件;不含已收集的历史)。 */
  waitForEvent: (pred: (e: AgentEvent) => boolean) => Promise<AgentEvent>;
}

export function makeHarness(
  script: FauxScript,
  cfg?: Partial<Omit<AgentConfig, 'streamFn' | 'model'>>,
): Harness {
  const streamFn = createFauxStreamFn(script);
  const agent = new Agent({
    streamFn,
    model: TEST_MODEL,
    tools: [],
    systemPrompt: 'You are a test agent.',
    ...cfg,
  });
  const events: AgentEvent[] = [];
  const waiters: { pred: (e: AgentEvent) => boolean; resolve: (e: AgentEvent) => void }[] = [];
  agent.subscribe((e) => {
    events.push(e);
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i] as (typeof waiters)[number];
      if (w.pred(e)) {
        waiters.splice(i, 1);
        w.resolve(e);
      }
    }
  });
  return {
    agent,
    events,
    streamFn,
    waitForEvent: (pred) =>
      new Promise<AgentEvent>((resolve) => {
        waiters.push({ pred, resolve });
      }),
  };
}

/** 归一化快照:剥 id/timestamp/内容,只留事件 type 序列(message_* 附角色标注)。 */
export function typeSequence(events: AgentEvent[]): string[] {
  return events.map((e) => {
    if (e.type === 'message_start' || e.type === 'message_end') {
      return `${e.type}(${e.message.role})`;
    }
    if (e.type === 'agent_start') return `agent_start(${e.reason})`;
    if (e.type === 'agent_end') return `agent_end(${e.reason})`;
    return e.type;
  });
}
