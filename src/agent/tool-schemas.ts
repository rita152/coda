// ToolDefinition → ToolSchema 渲染:Agent 构造时一次性 z.toJSONSchema() 并缓存
// (docs/05-agent-loop.md §3、docs/07-tools.md §1.2)。strict 清洗是 adapter 的职责,
// 这里保持原始 JSON Schema。unrepresentable 类型(z.date 等)在此即刻 throw——
// 工具作者的错误要在构造期暴露,不能等到第一次请求。

import { z } from 'zod';
import type { JSONSchema, ToolSchema } from '../protocol/index.js';
import type { ToolDefinition } from '../tools/types.js';

export function renderToolSchemas(tools: ToolDefinition[]): ToolSchema[] {
  const names = new Set<string>();
  return tools.map((t) => {
    if (names.has(t.name)) throw new Error(`Duplicate tool name: "${t.name}"`);
    names.add(t.name);
    return {
      name: t.name,
      description: t.description,
      parameters: z.toJSONSchema(t.parameters) as JSONSchema,
    };
  });
}
