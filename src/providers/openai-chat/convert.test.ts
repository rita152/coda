// 出站转换测试:逐 role 映射、配对纪律、strict 清洗、参数裁剪(见 docs/04-provider-adapter.md)。
import { describe, expect, it } from 'bun:test';
import type { Context, ModelConfig } from '../../protocol/index.js';
import { assertToolCallPairing } from '../../../tests/helpers/wire-pairing.js';
import { detectCompat } from './compat.js';
import { buildParams, convertMessages, toStrictSchema } from './convert.js';

const compat = detectCompat(undefined);   // OpenAI 全开
const model: ModelConfig = { ref: { provider: 'openai', api: 'openai-chat', model: 'gpt-test' } };

/** 综合 Context:system + user(图) + assistant(text+2 toolCall) + 2 toolResult(其一带图)。 */
const richContext: Context = {
  systemPrompt: 'You are coda.',
  messages: [
    {
      role: 'user', id: 'u1', timestamp: 1,
      content: [
        { type: 'text', text: '看看这张图,再读两个文件' },
        { type: 'image', data: 'aW1n', mimeType: 'image/png' },
      ],
      source: 'prompt',
    },
    {
      role: 'assistant', id: 'a1', timestamp: 2,
      content: [
        { type: 'text', text: '好的,我来处理。' },
        { type: 'tool_call', id: 'tc1', name: 'read', arguments: { path: 'a.png' }, rawArguments: '{"path":"a.png"}' },
        { type: 'tool_call', id: 'tc2', name: 'read', arguments: { path: 'b.ts' }, rawArguments: '{"path":"b.ts"}' },
      ],
      model: model.ref, stopReason: 'tool_calls', usage: { input: 10, output: 5 },
    },
    {
      role: 'tool_result', id: 'tr1', timestamp: 3, toolCallId: 'tc1', toolName: 'read',
      content: [
        { type: 'text', text: '(image file)' },
        { type: 'image', data: 'cGljMQ==', mimeType: 'image/png' },
      ],
      isError: false,
      details: { diff: 'never-sent' },
    },
    {
      role: 'tool_result', id: 'tr2', timestamp: 4, toolCallId: 'tc2', toolName: 'read',
      content: [{ type: 'text', text: 'file contents here' }], isError: false,
    },
    {
      role: 'assistant', id: 'a2', timestamp: 5, content: [],       // 空 assistant(aborted 后无内容)
      model: model.ref, stopReason: 'aborted', usage: { input: 0, output: 0 },
    },
    {
      role: 'user', id: 'u2', timestamp: 6,
      content: [{ type: 'text', text: '继续' }], source: 'steering',
    },
  ],
};

describe('convertMessages(出站快照)', () => {
  it('综合 Context:逐 role 映射、空 assistant 跳过、图片工具结果批后抽出、配对紧邻序一致', () => {
    const wire = convertMessages(richContext, compat);
    expect(wire).toMatchSnapshot();

    const roles = wire.map((m) => m.role);
    // OpenAI 全开 profile:supportsDeveloperRole=true,systemPrompt 渲染为 developer
    expect(roles).toEqual(['developer', 'user', 'assistant', 'tool', 'tool', 'user', 'user']);
    // 空 assistant(a2)被跳过;tool 消息紧跟 assistant 连续排列;图片 user 在整批 tool 之后
    assertToolCallPairing(wire);
    // details 永不出站
    expect(JSON.stringify(wire)).not.toContain('never-sent');
    // steering 消息就是普通 user 消息(source 不出站)
    expect(JSON.stringify(wire)).not.toContain('steering');
  });

  it('developer role:supportsDeveloperRole 时 systemPrompt 渲染为 developer', () => {
    const wire = convertMessages(richContext, { ...compat, supportsDeveloperRole: true });
    expect(wire[0]?.role).toBe('developer');
    const wire2 = convertMessages(richContext, { ...compat, supportsDeveloperRole: false });
    expect(wire2[0]?.role).toBe('system');
  });

  it('纯文本 user 输出字符串而非数组;不支持视觉时忽略 image part', () => {
    const ctx: Context = {
      messages: [{
        role: 'user', id: 'u', timestamp: 1,
        content: [{ type: 'text', text: 'hi' }],
      }],
    };
    expect(convertMessages(ctx, compat)[0]?.content).toBe('hi');

    const noVision = convertMessages(richContext, { ...compat, supportsImageParts: false });
    // user 消息降为纯文本 + 占位(与 transform 层形态对齐,不无声丢弃);工具结果图片不补 user 消息
    expect(noVision[1]?.content).toContain('[image omitted: image/png]');
    expect(noVision.filter((m) => m.role === 'user')).toHaveLength(2);   // u1 与 u2,无图片附加消息
  });

  it('data-URI 形态与 tool content 的显式锁定(不依赖快照)', () => {
    const wire = convertMessages(richContext, compat);
    const imgUser = wire.at(-2) as { content: { type: string; image_url?: { url: string } }[] };
    expect(imgUser.content[1]?.image_url?.url).toBe('data:image/png;base64,cGljMQ==');
    const tools = wire.filter((m) => m.role === 'tool') as { content: string }[];
    expect(tools[0]?.content).toBe('(image file)');
    expect(tools[1]?.content).toBe('file contents here');
  });

  it('requiresAssistantAfterToolResult + 带图工具结果:占位在图片 user 消息之前(wire 相邻决策)', () => {
    const ctx: Context = {
      messages: [
        {
          role: 'assistant', id: 'a', timestamp: 1,
          content: [{ type: 'tool_call', id: 't1', name: 'read', arguments: {} }],
          model: model.ref, stopReason: 'tool_calls', usage: { input: 0, output: 0 },
        },
        {
          role: 'tool_result', id: 'r', timestamp: 2, toolCallId: 't1', toolName: 'read',
          content: [{ type: 'image', data: 'aW1n', mimeType: 'image/png' }], isError: false,
        },
      ],
    };
    const wire = convertMessages(ctx, { ...compat, requiresAssistantAfterToolResult: true });
    // tool 之后的第一条 user(图片合成消息)之前必须先插合成 assistant
    expect(wire.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant', 'user']);
  });

  it('requiresAssistantAfterToolResult + 被跳过的空 assistant:按 wire 相邻插入(转录相邻会绕过)', () => {
    const ctx: Context = {
      messages: [
        {
          role: 'assistant', id: 'a', timestamp: 1,
          content: [{ type: 'tool_call', id: 't1', name: 'read', arguments: {} }],
          model: model.ref, stopReason: 'tool_calls', usage: { input: 0, output: 0 },
        },
        { role: 'tool_result', id: 'r', timestamp: 2, toolCallId: 't1', toolName: 'read', content: [], isError: false },
        {
          role: 'assistant', id: 'a2', timestamp: 3, content: [],   // 空 assistant:wire 上被跳过
          model: model.ref, stopReason: 'stop', usage: { input: 0, output: 0 },
        },
        { role: 'user', id: 'u', timestamp: 4, content: [{ type: 'text', text: 'next' }] },
      ],
    };
    const wire = convertMessages(ctx, { ...compat, requiresAssistantAfterToolResult: true });
    expect(wire.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant', 'user']);
  });

  it('tool 批在转录末尾:不追加占位(正常工具往返的标准形态)', () => {
    const ctx: Context = {
      messages: [
        {
          role: 'assistant', id: 'a', timestamp: 1,
          content: [{ type: 'tool_call', id: 't1', name: 'read', arguments: {} }],
          model: model.ref, stopReason: 'tool_calls', usage: { input: 0, output: 0 },
        },
        { role: 'tool_result', id: 'r', timestamp: 2, toolCallId: 't1', toolName: 'read', content: [], isError: false },
      ],
    };
    const wire = convertMessages(ctx, { ...compat, requiresAssistantAfterToolResult: true });
    expect(wire.map((m) => m.role)).toEqual(['assistant', 'tool']);   // 末尾无 user,不插占位
  });

  it('assistant 的 arguments 优先 rawArguments(保留原始键序/截断现场)', () => {
    const ctx: Context = {
      messages: [{
        role: 'assistant', id: 'a', timestamp: 1,
        content: [{ type: 'tool_call', id: 't1', name: 'edit', arguments: { a: 1 }, rawArguments: '{"a":1,"trunc' }],
        model: model.ref, stopReason: 'length', usage: { input: 0, output: 0 },
      }],
    };
    const wire = convertMessages(ctx, compat);
    const assistant = wire[0] as { tool_calls?: { function: { arguments: string } }[] };
    expect(assistant.tool_calls?.[0]?.function.arguments).toBe('{"a":1,"trunc');
  });

  it('requiresToolResultName / requiresAssistantAfterToolResult 方言开关', () => {
    const ctx: Context = {
      messages: [
        {
          role: 'assistant', id: 'a', timestamp: 1,
          content: [{ type: 'tool_call', id: 't1', name: 'read', arguments: {} }],
          model: model.ref, stopReason: 'tool_calls', usage: { input: 0, output: 0 },
        },
        { role: 'tool_result', id: 'r', timestamp: 2, toolCallId: 't1', toolName: 'read', content: [], isError: false },
        { role: 'user', id: 'u', timestamp: 3, content: [{ type: 'text', text: 'next' }], source: 'steering' },
      ],
    };
    const wire = convertMessages(ctx, {
      ...compat, requiresToolResultName: true, requiresAssistantAfterToolResult: true,
    });
    const tool = wire.find((m) => m.role === 'tool') as { name?: string; content: string };
    expect(tool.name).toBe('read');
    expect(tool.content).toBe('(no output)');                       // 空结果占位
    expect(wire.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant', 'user']);   // 合成占位在 user 前
  });
});

describe('toStrictSchema(strict 子集清洗快照)', () => {
  it('additionalProperties:false、全属性入 required、可选属性 type 加 null、递归嵌套', () => {
    const raw = {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'file path' },
        offset: { type: 'number' },                                 // 可选 → ['number','null']
        nested: {
          type: 'object',
          properties: { flag: { type: 'boolean' } },
          required: [],
        },
        list: { type: 'array', items: { type: 'object', properties: { x: { type: 'string' } } } },
      },
      required: ['path'],
    };
    const cleaned = toStrictSchema(raw);
    expect(cleaned).toMatchSnapshot();
    expect(cleaned['additionalProperties']).toBe(false);
    expect(cleaned['required']).toEqual(['path', 'offset', 'nested', 'list']);
    const props = cleaned['properties'] as Record<string, Record<string, unknown>>;
    expect(props['path']?.['type']).toBe('string');                 // 原 required 不动
    expect(props['offset']?.['type']).toEqual(['number', 'null']);  // 原可选加 null
    expect(props['nested']?.['additionalProperties']).toBe(false);  // 递归
    expect(raw.properties.offset.type).toBe('number');              // 不改原对象
  });
});

describe('toStrictSchema(zod v4 产出形态)', () => {
  it('$defs/$ref 递归 schema:内层同样清洗;可选 $ref 包 anyOf 加 null', () => {
    const cleaned = toStrictSchema({
      type: 'object',
      properties: { node: { $ref: '#/$defs/TreeNode' } },
      required: [],
      $defs: {
        TreeNode: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      },
    });
    const defs = cleaned['$defs'] as Record<string, Record<string, unknown>>;
    expect(defs['TreeNode']?.['additionalProperties']).toBe(false);   // $defs 内层被清洗
    const node = (cleaned['properties'] as Record<string, unknown>)['node'] as Record<string, unknown>;
    expect(node['anyOf']).toEqual([{ $ref: '#/$defs/TreeNode' }, { type: 'null' }]);   // 可选 $ref
  });

  it('prefixItems 元组与 items 数组:逐元素清洗', () => {
    const cleaned = toStrictSchema({
      type: 'object',
      properties: {
        pair: { type: 'array', prefixItems: [{ type: 'object', properties: { x: { type: 'number' } } }] },
      },
      required: ['pair'],
    });
    const pair = (cleaned['properties'] as Record<string, unknown>)['pair'] as Record<string, unknown>;
    const first = (pair['prefixItems'] as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(first['additionalProperties']).toBe(false);
  });

  it('可选 enum 属性:enum 同步加 null(不产出自相矛盾 schema);const 转 enum', () => {
    const cleaned = toStrictSchema({
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['fast', 'slow'] },
        tag: { const: 'v1' },
      },
      required: [],
    });
    const props = cleaned['properties'] as Record<string, Record<string, unknown>>;
    expect(props['mode']?.['type']).toEqual(['string', 'null']);
    expect(props['mode']?.['enum']).toEqual(['fast', 'slow', null]);
    expect(props['tag']?.['enum']).toEqual(['v1', null]);
  });

  it('裸 object 与 record 形态:补空 properties;additionalProperties 为 schema 时递归保留', () => {
    const cleaned = toStrictSchema({
      type: 'object',
      properties: {
        bare: { type: 'object' },
        rec: { type: 'object', additionalProperties: { type: 'object', properties: { v: { type: 'string' } } } },
      },
      required: ['bare', 'rec'],
    });
    const props = cleaned['properties'] as Record<string, Record<string, unknown>>;
    expect(props['bare']?.['properties']).toEqual({});
    expect(props['bare']?.['required']).toEqual([]);
    const recAp = props['rec']?.['additionalProperties'] as Record<string, unknown>;
    expect(recAp['additionalProperties']).toBe(false);   // record 值 schema 被递归清洗而非覆盖为 false
  });
});

describe('buildParams(参数裁剪)', () => {
  const ctx: Context = {
    messages: [{ role: 'user', id: 'u', timestamp: 1, content: [{ type: 'text', text: 'hi' }] }],
    tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object', properties: {} } }],
  };

  it('OpenAI profile:stream_options、max_completion_tokens、strict tools', () => {
    const p = buildParams(model, ctx, { maxOutputTokens: 1000, temperature: 0.7 }, compat);
    expect(p.stream).toBe(true);
    expect(p.stream_options).toEqual({ include_usage: true });
    expect(p.max_completion_tokens).toBe(1000);
    expect('max_tokens' in p).toBe(false);
    expect(p.temperature).toBe(0.7);
    const tool = p.tools?.[0] as { function: { strict?: boolean; parameters: Record<string, unknown> } };
    expect(tool.function.strict).toBe(true);
    expect(tool.function.parameters['additionalProperties']).toBe(false);
  });

  it('保守 profile:不发可选参数,max_tokens 字段,原始 schema', () => {
    const conservative = detectCompat('https://unknown.example.com/v1');
    const p = buildParams(model, ctx, { maxOutputTokens: 500, temperature: 0.7 }, conservative);
    expect('stream_options' in p).toBe(false);
    expect(p.max_tokens).toBe(500);
    expect('max_completion_tokens' in p).toBe(false);
    expect('temperature' in p).toBe(false);                         // supportsTemperature: false
    const tool = p.tools?.[0] as { function: { strict?: boolean } };
    expect(tool.function.strict).toBeUndefined();
  });

  it('tools 为空数组:整个 tools 字段省略', () => {
    const p = buildParams(model, { messages: [], tools: [] }, undefined, compat);
    expect('tools' in p).toBe(false);
  });

  it('model.defaults 兜底,options 优先', () => {
    const m: ModelConfig = { ...model, defaults: { maxOutputTokens: 2000, temperature: 0.1 } };
    const p1 = buildParams(m, ctx, undefined, compat);
    expect(p1.max_completion_tokens).toBe(2000);
    expect(p1.temperature).toBe(0.1);
    const p2 = buildParams(m, ctx, { maxOutputTokens: 100 }, compat);
    expect(p2.max_completion_tokens).toBe(100);
  });

  it('按已知模型精确裁剪 temperature 与 reasoning effort', () => {
    const cases = [
      { id: 'gpt-4o', effort: 'high', expectedTemperature: 0.7, expectedEffort: undefined },
      { id: 'o3-mini', effort: 'high', expectedTemperature: undefined, expectedEffort: 'high' },
      { id: 'gpt-5', effort: 'minimal', expectedTemperature: undefined, expectedEffort: 'minimal' },
      { id: 'gpt-5.4-2026-03-05', effort: 'xhigh', expectedTemperature: undefined, expectedEffort: 'xhigh' },
      { id: 'gpt-5.6-luna', effort: 'max', expectedTemperature: undefined, expectedEffort: 'max' },
      { id: 'gpt-test', effort: 'provider-specific', expectedTemperature: 0.7, expectedEffort: undefined },
    ] as const;

    for (const testCase of cases) {
      const params = buildParams(
        { ref: { provider: 'openai', api: 'openai-chat', model: testCase.id } },
        { messages: [] },
        { temperature: 0.7, reasoningEffort: testCase.effort },
        compat,
      );
      expect(params.temperature).toBe(testCase.expectedTemperature);
      expect(params.reasoning_effort).toBe(testCase.expectedEffort);
    }
  });

  it('相似命名变体不继承基础模型能力,且越界 temperature 被省略', () => {
    const variant = buildParams(
      { ref: { provider: 'openai', api: 'openai-chat', model: 'gpt-5-chat-latest' } },
      { messages: [] },
      { temperature: 0.7, reasoningEffort: 'xhigh' },
      compat,
    );
    expect(variant.temperature).toBe(0.7);
    expect(variant.reasoning_effort).toBe('xhigh');

    const invalidTemperature = buildParams(
      { ref: { provider: 'openai', api: 'openai-chat', model: 'gpt-4o' } },
      { messages: [] },
      { temperature: 2.1 },
      compat,
    );
    expect(invalidTemperature.temperature).toBeUndefined();
  });
});
