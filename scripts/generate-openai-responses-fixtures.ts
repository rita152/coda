// OpenAI Responses adapter 的确定性离线 wire fixtures。
// 这些文件不是手写黄金输出；修改场景后运行 `bun run fixtures:openai-responses` 统一生成。

import { mkdirSync } from 'node:fs';
import path from 'node:path';

type WireEvent = Record<string, unknown>;

const fixturesDir = path.join(import.meta.dir, '..', 'src', 'providers', 'openai-responses', '__fixtures__');

function response(
  status: 'completed' | 'incomplete' | 'failed',
  output: unknown[],
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: `resp_${status}`,
    object: 'response',
    status,
    output,
    error: null,
    incomplete_details: null,
    ...extras,
  };
}

const textItem = {
  id: 'msg_text',
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text: 'Hello Responses.', annotations: [] }],
};

const reasoningItem = {
  id: 'rs_reasoning',
  type: 'reasoning',
  status: 'completed',
  summary: [{ type: 'summary_text', text: 'Checked the steps.' }],
  encrypted_content: 'enc_reasoning_fixture',
};

const reasoningTextItem = {
  id: 'msg_reasoning',
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text: 'The answer is 42.', annotations: [] }],
};

const toolItem = {
  id: 'fc_weather',
  type: 'function_call',
  status: 'completed',
  call_id: 'call_weather',
  name: 'get_weather',
  arguments: '{"city":"Paris"}',
};

const parallelItems = [
  {
    id: 'fc_first',
    type: 'function_call',
    status: 'completed',
    call_id: 'call_first',
    name: 'read',
    arguments: '{"path":"a.ts"}',
  },
  {
    id: 'fc_second',
    type: 'function_call',
    status: 'completed',
    call_id: 'call_second',
    name: 'read',
    arguments: '{"path":"b.ts"}',
  },
];

const fixtures: Record<string, WireEvent[]> = {
  text: [
    { type: 'response.created', sequence_number: 0, response: response('completed', []) },
    {
      type: 'response.output_item.added',
      sequence_number: 1,
      output_index: 0,
      item: { ...textItem, status: 'in_progress', content: [] },
    },
    {
      type: 'response.content_part.added',
      sequence_number: 2,
      item_id: 'msg_text',
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    },
    {
      type: 'response.output_text.delta',
      sequence_number: 3,
      item_id: 'msg_text',
      output_index: 0,
      content_index: 0,
      delta: 'Hello ',
      logprobs: [],
    },
    {
      type: 'response.output_text.delta',
      sequence_number: 4,
      item_id: 'msg_text',
      output_index: 0,
      content_index: 0,
      delta: 'Responses.',
      logprobs: [],
    },
    {
      type: 'response.output_text.done',
      sequence_number: 5,
      item_id: 'msg_text',
      output_index: 0,
      content_index: 0,
      text: 'Hello Responses.',
      logprobs: [],
    },
    { type: 'response.output_item.done', sequence_number: 6, output_index: 0, item: textItem },
    {
      type: 'response.completed',
      sequence_number: 7,
      response: response('completed', [textItem], {
        usage: {
          input_tokens: 8,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
          output_tokens: 4,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 12,
        },
      }),
    },
  ],
  reasoning: [
    {
      type: 'response.output_item.added',
      sequence_number: 0,
      output_index: 0,
      item: { ...reasoningItem, status: 'in_progress', summary: [], encrypted_content: null },
    },
    {
      type: 'response.reasoning_summary_part.added',
      sequence_number: 1,
      item_id: 'rs_reasoning',
      output_index: 0,
      summary_index: 0,
      part: { type: 'summary_text', text: '' },
    },
    {
      type: 'response.reasoning_summary_text.delta',
      sequence_number: 2,
      item_id: 'rs_reasoning',
      output_index: 0,
      summary_index: 0,
      delta: 'Checked ',
    },
    {
      type: 'response.reasoning_summary_text.delta',
      sequence_number: 3,
      item_id: 'rs_reasoning',
      output_index: 0,
      summary_index: 0,
      delta: 'the steps.',
    },
    {
      type: 'response.reasoning_summary_text.done',
      sequence_number: 4,
      item_id: 'rs_reasoning',
      output_index: 0,
      summary_index: 0,
      text: 'Checked the steps.',
    },
    { type: 'response.output_item.done', sequence_number: 5, output_index: 0, item: reasoningItem },
    {
      type: 'response.output_item.added',
      sequence_number: 6,
      output_index: 1,
      item: { ...reasoningTextItem, status: 'in_progress', content: [] },
    },
    {
      type: 'response.output_text.delta',
      sequence_number: 7,
      item_id: 'msg_reasoning',
      output_index: 1,
      content_index: 0,
      delta: 'The answer is 42.',
      logprobs: [],
    },
    {
      type: 'response.output_text.done',
      sequence_number: 8,
      item_id: 'msg_reasoning',
      output_index: 1,
      content_index: 0,
      text: 'The answer is 42.',
      logprobs: [],
    },
    { type: 'response.output_item.done', sequence_number: 9, output_index: 1, item: reasoningTextItem },
    {
      type: 'response.completed',
      sequence_number: 10,
      response: response('completed', [reasoningItem, reasoningTextItem], {
        usage: {
          input_tokens: 12,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
          output_tokens: 11,
          output_tokens_details: { reasoning_tokens: 5 },
          total_tokens: 23,
        },
      }),
    },
  ],
  'tool-call': [
    {
      type: 'response.output_item.added',
      sequence_number: 0,
      output_index: 0,
      item: { ...toolItem, status: 'in_progress', arguments: '' },
    },
    {
      type: 'response.function_call_arguments.delta',
      sequence_number: 1,
      item_id: 'fc_weather',
      output_index: 0,
      delta: '{"city":',
    },
    {
      type: 'response.function_call_arguments.delta',
      sequence_number: 2,
      item_id: 'fc_weather',
      output_index: 0,
      delta: '"Paris"}',
    },
    {
      type: 'response.function_call_arguments.done',
      sequence_number: 3,
      item_id: 'fc_weather',
      output_index: 0,
      name: 'get_weather',
      arguments: '{"city":"Paris"}',
    },
    { type: 'response.output_item.done', sequence_number: 4, output_index: 0, item: toolItem },
    {
      type: 'response.completed',
      sequence_number: 5,
      response: response('completed', [toolItem], {
        usage: {
          input_tokens: 15,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
          output_tokens: 8,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 23,
        },
      }),
    },
  ],
  'parallel-tool-calls': [
    {
      type: 'response.output_item.added',
      sequence_number: 0,
      output_index: 0,
      item: { ...parallelItems[0], status: 'in_progress', arguments: '' },
    },
    {
      type: 'response.output_item.added',
      sequence_number: 1,
      output_index: 1,
      item: { ...parallelItems[1], status: 'in_progress', arguments: '' },
    },
    {
      type: 'response.function_call_arguments.delta',
      sequence_number: 2,
      item_id: 'fc_first',
      output_index: 0,
      delta: '{"path":',
    },
    {
      type: 'response.function_call_arguments.delta',
      sequence_number: 3,
      item_id: 'fc_second',
      output_index: 1,
      delta: '{"path":',
    },
    {
      type: 'response.function_call_arguments.delta',
      sequence_number: 4,
      item_id: 'fc_first',
      output_index: 0,
      delta: '"a.ts"}',
    },
    {
      type: 'response.function_call_arguments.delta',
      sequence_number: 5,
      item_id: 'fc_second',
      output_index: 1,
      delta: '"b.ts"}',
    },
    {
      type: 'response.function_call_arguments.done',
      sequence_number: 6,
      item_id: 'fc_second',
      output_index: 1,
      name: 'read',
      arguments: '{"path":"b.ts"}',
    },
    {
      type: 'response.function_call_arguments.done',
      sequence_number: 7,
      item_id: 'fc_first',
      output_index: 0,
      name: 'read',
      arguments: '{"path":"a.ts"}',
    },
    { type: 'response.output_item.done', sequence_number: 8, output_index: 0, item: parallelItems[0] },
    { type: 'response.output_item.done', sequence_number: 9, output_index: 1, item: parallelItems[1] },
    {
      type: 'response.completed',
      sequence_number: 10,
      response: response('completed', parallelItems, {
        usage: {
          input_tokens: 18,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
          output_tokens: 14,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 32,
        },
      }),
    },
  ],
  usage: [
    {
      type: 'response.completed',
      sequence_number: 0,
      response: response('completed', [], {
        usage: {
          input_tokens: 120,
          input_tokens_details: { cached_tokens: 80, cache_write_tokens: 10 },
          output_tokens: 31,
          output_tokens_details: { reasoning_tokens: 7 },
          total_tokens: 151,
        },
      }),
    },
  ],
  abort: [
    {
      type: 'response.output_item.added',
      sequence_number: 0,
      output_index: 0,
      item: { ...textItem, status: 'in_progress', content: [] },
    },
    {
      type: 'response.output_text.delta',
      sequence_number: 1,
      item_id: 'msg_text',
      output_index: 0,
      content_index: 0,
      delta: 'partial',
      logprobs: [],
    },
  ],
  incomplete: [
    {
      type: 'response.output_item.added',
      sequence_number: 0,
      output_index: 0,
      item: { ...textItem, status: 'in_progress', content: [] },
    },
    {
      type: 'response.output_text.delta',
      sequence_number: 1,
      item_id: 'msg_text',
      output_index: 0,
      content_index: 0,
      delta: 'partial',
      logprobs: [],
    },
    {
      type: 'response.incomplete',
      sequence_number: 2,
      response: response(
        'incomplete',
        [{
          ...textItem,
          status: 'incomplete',
          content: [{ type: 'output_text', text: 'partial', annotations: [] }],
        }],
        {
          incomplete_details: { reason: 'max_output_tokens' },
          usage: {
            input_tokens: 9,
            input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
            output_tokens: 3,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 12,
          },
        },
      ),
    },
  ],
  'sse-error': [
    {
      type: 'response.output_text.delta',
      sequence_number: 0,
      item_id: 'msg_error',
      output_index: 0,
      content_index: 0,
      delta: 'before failure',
      logprobs: [],
    },
    {
      type: 'error',
      sequence_number: 1,
      code: 'server_error',
      message: 'temporary stream failure',
      param: null,
    },
  ],
  failed: [
    {
      type: 'response.output_text.delta',
      sequence_number: 0,
      item_id: 'msg_failed',
      output_index: 0,
      content_index: 0,
      delta: 'partial failure',
      logprobs: [],
    },
    {
      type: 'response.failed',
      sequence_number: 1,
      response: response(
        'failed',
        [{
          id: 'msg_failed',
          type: 'message',
          role: 'assistant',
          status: 'incomplete',
          content: [{ type: 'output_text', text: 'partial failure', annotations: [] }],
        }],
        {
          error: { code: 'invalid_prompt', message: 'prompt rejected' },
          usage: {
            input_tokens: 5,
            input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
            output_tokens: 2,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 7,
          },
        },
      ),
    },
  ],
};

mkdirSync(fixturesDir, { recursive: true });
await Promise.all(
  Object.entries(fixtures).map(([name, events]) =>
    Bun.write(
      path.join(fixturesDir, `${name}.jsonl`),
      `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
    ),
  ),
);
console.log(`generated ${Object.keys(fixtures).length} OpenAI Responses fixtures → ${fixturesDir}`);
