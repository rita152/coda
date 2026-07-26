// 7 工具聚合 schema 验收(docs/07 §2、docs/05 §3):createCodingTools() 全量渲染
// 不 throw、每个参数字段带非空 description(模型可读性验收);重名与 unrepresentable
// 类型在构造期即 throw(工具作者的错误不许活到第一次请求)。

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { renderToolSchemas } from '../src/agent/index.js';
import { createCodingTools } from '../src/tools/index.js';
import type { ToolDefinition } from '../src/tools/types.js';

/** 递归收集 JSON Schema 的全部 property(含嵌套 object 与数组 items)。 */
function collectProperties(
  schema: Record<string, unknown>,
  prefix: string,
): { path: string; description: unknown }[] {
  const out: { path: string; description: unknown }[] = [];
  const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (props) {
    for (const [key, sub] of Object.entries(props)) {
      const path = `${prefix}.${key}`;
      out.push({ path, description: sub.description });
      out.push(...collectProperties(sub, path));
    }
  }
  const items = schema.items as Record<string, unknown> | undefined;
  if (items) out.push(...collectProperties(items, `${prefix}[]`));
  return out;
}

describe('renderToolSchemas × createCodingTools(7 工具聚合验收)', () => {
  it('恰好 7 个工具,渲染不 throw,名称与形态齐全', () => {
    const schemas = renderToolSchemas(createCodingTools());   // unrepresentable 类型在此会 throw
    expect(schemas.map((s) => s.name).sort()).toEqual(
      ['bash', 'edit', 'glob', 'grep', 'ls', 'read', 'write'],
    );
    for (const s of schemas) {
      expect(s.description.length, `${s.name} description`).toBeGreaterThan(0);
      expect(s.parameters.type, `${s.name} parameters.type`).toBe('object');
    }
  });

  it('每个 schema 的每个 property(含嵌套)都有非空 description', () => {
    const schemas = renderToolSchemas(createCodingTools());
    for (const s of schemas) {
      const props = collectProperties(s.parameters, s.name);
      expect(props.length, `${s.name} 应至少有一个参数字段`).toBeGreaterThan(0);
      for (const p of props) {
        expect(typeof p.description, `${p.path} description 缺失`).toBe('string');
        expect((p.description as string).length, `${p.path} description 为空`).toBeGreaterThan(0);
      }
    }
  });

  it('重名工具:构造期 throw Duplicate tool name', () => {
    const mk = (name: string): ToolDefinition => ({
      name,
      description: 'd',
      parameters: z.object({}),
      execute: async () => ({ content: [] }),
    });
    expect(() => renderToolSchemas([mk('same'), mk('same')])).toThrow('Duplicate tool name');
  });

  it('unrepresentable 参数类型(z.date):构造期即 throw', () => {
    const bad: ToolDefinition = {
      name: 'bad',
      description: 'd',
      parameters: z.object({ when: z.date().describe('when') }),
      execute: async () => ({ content: [] }),
    };
    expect(() => renderToolSchemas([bad])).toThrow();
  });
});
