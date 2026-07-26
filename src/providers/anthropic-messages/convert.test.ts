// 出站转换测试:逐 role 映射、system 顶层参数、图片原生进 tool_result、thinking 回传、
// 连续同 role 合并、参数裁剪(docs/04 §8)。
import { describe, expect, it } from 'vitest';
import type { Context, ModelConfig } from '../../protocol/index.js';
import { detectCompat } from './compat.js';
import { buildParams, convertMessages } from './convert.js';

const compat = detectCompat(undefined);   // Anthropic 官方全开
const model: ModelConfig = { ref: { provider: 'anthropic', api: 'anthropic-messages', model: 'claude-opus-5' } };

/**
 * 综合 Context:system + user(图) + assistant(thinking+text+2 toolCall) + 2 toolResult(其一带图)
 * + 空 assistant(aborted) + user(steering)。
 */
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
        { type: 'reasoning', text: '让我想想。', signature: 'SIG_abc' },
        { type: 'text', text: '好的,我来处理。' },
        { type: 'tool_call', id: 'toolu_1', name: 'read', arguments: { path: 'a.png' }, rawArguments: '{"path":"a.png"}' },
        { type: 'tool_call', id: 'toolu_2', name: 'read', arguments: { path: 'b.ts' }, rawArguments: '{"path":"b.ts"}' },
      ],
      model: model.ref, stopReason: 'tool_calls', usage: { input: 10, output: 5 },
    },
    {
      role: 'tool_result', id: 'tr1', timestamp: 3, toolCallId: 'toolu_1', toolName: 'read',
      content: [
        { type: 'text', text: '(image file)' },
        { type: 'image', data: 'cGljMQ==', mimeType: 'image/png' },
      ],
      isError: false,
      details: { diff: 'never-sent' },
    },
    {
      role: 'tool_result', id: 'tr2', timestamp: 4, toolCallId: 'toolu_2', toolName: 'read',
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
  it('综合 Context:逐 role 映射、空 assistant 跳过、图片原生进 tool_result、连续同 role 合并', () => {
    const wire = convertMessages(richContext, compat);
    expect(wire).toMatchSnapshot();

    // 空 assistant(a2)被跳过 → tr1/tr2(user)与 u2(user)合并为单条 user 消息,
    // 满足 Anthropic 的 user/assistant 严格交替
    expect(wire.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);

    // assistant:thinking 块带 signature 原样回传,排在文本/工具之前
    const assistant = wire[1];
    const aContent = assistant?.content as unknown as Array<Record<string, unknown>>;
    expect(aContent[0]).toEqual({ type: 'thinking', thinking: '让我想想。', signature: 'SIG_abc' });
    expect(aContent[2]).toMatchObject({ type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'a.png' } });

    // 合并后的 user 消息:tr1(含原生 image block)+ tr2 + steering 文本,共 3 个 block
    const merged = wire[2]?.content as unknown as Array<Record<string, unknown>>;
    expect(merged).toHaveLength(3);
    expect(merged[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1', is_error: false });
    const tr1Content = merged[0]?.['content'] as Array<Record<string, unknown>>;
    expect(tr1Content[1]).toEqual({    // 图片原生进 tool_result content(无 openai-chat 的抽出补丁)
      type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'cGljMQ==' },
    });
    expect(merged[2]).toEqual({ type: 'text', text: '继续' });

    // details 永不出站;source 不出站
    expect(JSON.stringify(wire)).not.toContain('never-sent');
    expect(JSON.stringify(wire)).not.toContain('steering');
  });

  it('user 图片进 image block(base64 source),纯文本进 text block', () => {
    const ctx: Context = {
      messages: [{ role: 'user', id: 'u', timestamp: 1, content: [
        { type: 'text', text: 'hi' },
        { type: 'image', data: 'QUJD', mimeType: 'image/jpeg' },
      ] }],
    };
    const wire = convertMessages(ctx, compat);
    expect(wire[0]?.content).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } },
    ]);
  });

  it('ReasoningPart 无 signature 时跳过(避免无签名 thinking 块 400)', () => {
    const ctx: Context = {
      messages: [{ role: 'assistant', id: 'a', timestamp: 1, content: [
        { type: 'reasoning', text: '无签名' },
        { type: 'text', text: 'answer' },
      ], model: model.ref, stopReason: 'stop', usage: { input: 0, output: 0 } }],
    };
    const wire = convertMessages(ctx, compat);
    expect(wire[0]?.content).toEqual([{ type: 'text', text: 'answer' }]);
  });

  it('supportsImageParts=false:图片降级为占位文本,不无声丢弃', () => {
    const noVision = { ...compat, supportsImageParts: false };
    const ctx: Context = {
      messages: [
        { role: 'user', id: 'u', timestamp: 1, content: [{ type: 'image', data: 'x', mimeType: 'image/png' }] },
        { role: 'assistant', id: 'a', timestamp: 2, content: [
          { type: 'tool_call', id: 't1', name: 'read', arguments: {}, rawArguments: '{}' },
        ], model: model.ref, stopReason: 'tool_calls', usage: { input: 0, output: 0 } },
        { role: 'tool_result', id: 'tr', timestamp: 3, toolCallId: 't1', toolName: 'read',
          content: [{ type: 'image', data: 'y', mimeType: 'image/png' }], isError: false },
      ],
    };
    const out = convertMessages(ctx, noVision);
    expect(out[0]?.content).toEqual([{ type: 'text', text: '[image omitted: image/png]' }]);
    const toolResult = (out[2]?.content as unknown as Array<Record<string, unknown>>)[0];
    expect(toolResult?.['content']).toEqual([{ type: 'text', text: '[image omitted: image/png]' }]);
  });
});

describe('buildParams(参数裁剪)', () => {
  it('system 顶层参数;max_tokens 缺省 defaultMaxTokens;tools 的 input_schema', () => {
    const ctx: Context = {
      systemPrompt: 'sys',
      messages: [{ role: 'user', id: 'u', timestamp: 1, content: [{ type: 'text', text: 'hi' }] }],
      tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
    };
    const params = buildParams(model, ctx, undefined, compat);
    expect(params.system).toBe('sys');            // 顶层 system,不是消息
    expect(params.max_tokens).toBe(4096);         // 缺省 defaultMaxTokens
    expect(params.stream).toBe(true);
    expect(params.tools).toEqual([
      { name: 'read', description: 'read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
    ]);
    expect(params.messages.map((m) => m.role)).toEqual(['user']);
  });

  it('thinking:supportsThinking + reasoningEffort → thinking 配置,不发 temperature', () => {
    const ctx: Context = { messages: [{ role: 'user', id: 'u', timestamp: 1, content: [{ type: 'text', text: 'hi' }] }] };
    const params = buildParams(model, ctx, { reasoningEffort: 'high', temperature: 0.7 }, compat);
    expect(params.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
    expect(params.temperature).toBeUndefined();   // thinking 开启时省略 temperature(Anthropic 约束)
    expect(params.max_tokens).toBeGreaterThan(2048);   // max_tokens 抬到 budget 之上
  });

  it('无 thinking:温度透传;maxOutputTokens 覆盖缺省', () => {
    const ctx: Context = { messages: [{ role: 'user', id: 'u', timestamp: 1, content: [{ type: 'text', text: 'hi' }] }] };
    const params = buildParams(model, ctx, { temperature: 0.3, maxOutputTokens: 1000 }, compat);
    expect(params.temperature).toBe(0.3);
    expect(params.max_tokens).toBe(1000);
    expect(params.thinking).toBeUndefined();
  });

  it('未识别端点(保守 profile):reasoningEffort 存在也不发 thinking', () => {
    const conservative = detectCompat('https://gateway.example.com/v1');
    const ctx: Context = { messages: [{ role: 'user', id: 'u', timestamp: 1, content: [{ type: 'text', text: 'hi' }] }] };
    const params = buildParams(model, ctx, { reasoningEffort: 'high' }, conservative);
    expect(params.thinking).toBeUndefined();
  });
});
