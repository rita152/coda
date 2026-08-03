// Responses 出站转换测试：transcript 全量 replay、工具输出配对、参数裁剪。

import { describe, expect, it } from 'bun:test';
import type { Context, ModelConfig } from '../../protocol/index.js';
import { buildParams, convertInput } from './convert.js';

const model: ModelConfig = {
  ref: { provider: 'openai', api: 'openai-responses', model: 'gpt-test' },
  defaults: { temperature: 0.2, reasoningEffort: 'medium', maxOutputTokens: 100 },
};

describe('convertInput', () => {
  it('逐 role 映射；assistant tool call 与 function_call_output 用同一 call_id', () => {
    const context: Context = {
      messages: [
        {
          role: 'user',
          id: 'u1',
          timestamp: 1,
          source: 'steering',
          content: [
            { type: 'text', text: 'inspect' },
            { type: 'image', data: 'aW1n', mimeType: 'image/png' },
          ],
        },
        {
          role: 'assistant',
          id: 'a1',
          timestamp: 2,
          model: model.ref,
          stopReason: 'tool_calls',
          usage: { input: 1, output: 1 },
          content: [
            { type: 'text', text: 'I will inspect it.' },
            {
              type: 'tool_call',
              id: 'call_read',
              name: 'read',
              arguments: { path: 'a.ts' },
              rawArguments: '{"path":"a.ts"}',
            },
          ],
        },
        {
          role: 'tool_result',
          id: 'tr1',
          timestamp: 3,
          toolCallId: 'call_read',
          toolName: 'read',
          content: [
            { type: 'text', text: 'contents' },
            { type: 'image', data: 'cGlj', mimeType: 'image/jpeg' },
          ],
          isError: false,
          details: { never: 'sent' },
        },
      ],
    };

    const input = convertInput(context);
    expect(input).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'inspect' },
          { type: 'input_image', detail: 'auto', image_url: 'data:image/png;base64,aW1n' },
        ],
      },
      { role: 'assistant', content: 'I will inspect it.' },
      {
        type: 'function_call',
        call_id: 'call_read',
        name: 'read',
        arguments: '{"path":"a.ts"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_read',
        output: [
          { type: 'input_text', text: 'contents' },
          { type: 'input_image', detail: 'auto', image_url: 'data:image/jpeg;base64,cGlj' },
        ],
      },
    ]);
    expect(JSON.stringify(input)).not.toContain('never');
    expect(JSON.stringify(input)).not.toContain('steering');
  });

  it('空工具结果给稳定占位；空 assistant 不产生 wire item', () => {
    const context: Context = {
      messages: [
        {
          role: 'assistant',
          id: 'a',
          timestamp: 1,
          model: model.ref,
          stopReason: 'aborted',
          usage: { input: 0, output: 0 },
          content: [],
        },
        {
          role: 'tool_result',
          id: 'tr',
          timestamp: 2,
          toolCallId: 'call_x',
          toolName: 'x',
          content: [],
          isError: true,
        },
      ],
    };
    expect(convertInput(context)).toEqual([
      {
        type: 'function_call_output',
        call_id: 'call_x',
        output: 'Error (no output)',
      },
    ]);
  });

  it('assistant 文本按 phase 边界分组并原样回传', () => {
    const context: Context = {
      messages: [{
        role: 'assistant',
        id: 'a-phases',
        timestamp: 1,
        model: model.ref,
        stopReason: 'stop',
        usage: { input: 1, output: 1 },
        content: [
          { type: 'text', text: 'Inspecting ', phase: 'commentary' },
          { type: 'text', text: 'the logs.', phase: 'commentary' },
          { type: 'text', text: 'Root cause found.', phase: 'final_answer' },
          { type: 'text', text: ' Legacy text stays unlabeled.' },
        ],
      }],
    };

    expect(convertInput(context)).toEqual([
      { role: 'assistant', content: 'Inspecting the logs.', phase: 'commentary' },
      { role: 'assistant', content: 'Root cause found.', phase: 'final_answer' },
      { role: 'assistant', content: ' Legacy text stays unlabeled.' },
    ]);
  });
});

describe('buildParams', () => {
  it('映射 instructions/input/tools/options，且不发送 previous_response_id', () => {
    const context: Context = {
      systemPrompt: 'You are coda.',
      messages: [{
        role: 'user',
        id: 'u',
        timestamp: 1,
        content: [{ type: 'text', text: 'hello' }],
      }],
      tools: [{
        name: 'read',
        description: 'Read a file',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      }],
    };
    const params = buildParams(model, context, {
      temperature: 0.7,
      reasoningEffort: 'high',
      maxOutputTokens: 50,
    });

    expect(params).toMatchObject({
      model: 'gpt-test',
      instructions: 'You are coda.',
      input: [{ role: 'user', content: 'hello' }],
      tools: [{
        type: 'function',
        name: 'read',
        description: 'Read a file',
        strict: false,
      }],
      stream: true,
      include: ['reasoning.encrypted_content'],
      temperature: 0.7,
      max_output_tokens: 50,
      reasoning: { effort: 'high', summary: 'auto' },
    });
    expect('previous_response_id' in params).toBe(false);
  });

  it('options 缺失时使用 model defaults；工具 schema 不被 adapter 改写', () => {
    const parameters = { type: 'object', properties: { optional: { type: 'string' } } };
    const params = buildParams(model, {
      messages: [],
      tools: [{ name: 'x', description: 'x', parameters }],
    });
    expect(params.temperature).toBe(0.2);
    expect(params.max_output_tokens).toBe(100);
    expect(params.reasoning).toEqual({ effort: 'medium', summary: 'auto' });
    expect(params.tools?.[0]).toMatchObject({ parameters, strict: false });
    expect(parameters).toEqual({ type: 'object', properties: { optional: { type: 'string' } } });
  });

  it('未配置 reasoning effort 时仍请求 auto summary', () => {
    const params = buildParams(
      { ref: { provider: 'openai', api: 'openai-responses', model: 'gpt-test' } },
      { messages: [], tools: [] },
    );
    expect(params.reasoning).toEqual({ summary: 'auto' });
  });

  it('按已知模型精确裁剪 temperature、reasoning 与 include', () => {
    const context: Context = { messages: [], tools: [] };
    const cases = [
      { id: 'gpt-4o', effort: 'high', temperature: 0.7, reasoning: undefined, include: false },
      { id: 'gpt-5.6-luna', effort: 'max', temperature: undefined, reasoning: { effort: 'max', summary: 'auto' }, include: true },
      { id: 'gpt-5.3-codex', effort: 'xhigh', temperature: undefined, reasoning: { effort: 'xhigh', summary: 'auto' }, include: true },
      { id: 'gpt-5.3-codex', effort: 'minimal', temperature: undefined, reasoning: { summary: 'auto' }, include: true },
      { id: 'gpt-5.5-pro', effort: 'low', temperature: undefined, reasoning: { summary: 'auto' }, include: true },
      { id: 'gpt-test', effort: 'provider-specific', temperature: 0.7, reasoning: { summary: 'auto' }, include: true },
    ] as const;

    for (const testCase of cases) {
      const params = buildParams(
        { ref: { provider: 'openai', api: 'openai-responses', model: testCase.id } },
        context,
        { temperature: 0.7, reasoningEffort: testCase.effort },
      );
      expect(params.temperature).toBe(testCase.temperature);
      expect(params.reasoning).toEqual(testCase.reasoning);
      expect('include' in params).toBe(testCase.include);
    }
  });

  it('基础模型不会吞掉命名变体,且越界 temperature 被省略', () => {
    const variant = buildParams(
      { ref: { provider: 'openai', api: 'openai-responses', model: 'gpt-5.4-pro' } },
      { messages: [], tools: [] },
      { reasoningEffort: 'low' },
    );
    expect(variant.reasoning).toEqual({ summary: 'auto' });

    const invalidTemperature = buildParams(
      { ref: { provider: 'openai', api: 'openai-responses', model: 'gpt-4o' } },
      { messages: [], tools: [] },
      { temperature: Number.NaN },
    );
    expect(invalidTemperature.temperature).toBeUndefined();
  });
});
