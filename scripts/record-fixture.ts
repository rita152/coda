// SSE chunk fixture 录制(docs/10-testing.md §4.3):对真实 endpoint 发起流式请求,
// 把每条原始 chunk 存为 JSONL。手动运行、fixture 入库;CI 永不联网。
// 用法:bun run record:fixture -- --model kimi-k3 --scenario text --out src/providers/openai-chat/__fixtures__/kimi-text.jsonl
import { mkdirSync } from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line no-restricted-imports -- 录制脚本直接消费原始 wire chunk,是 openai 封锁的显式豁免点
import OpenAI from 'openai';
// eslint-disable-next-line no-restricted-imports -- 同上
import type { ChatCompletionCreateParamsStreaming } from 'openai/resources/chat/completions';
import { createStdoutOutput } from '../src/shared/index.js';
import { loadEndpointEnv } from './env.js';

function arg(name: string, fallback?: string): string {
  const i = Bun.argv.indexOf(`--${name}`);
  if (i >= 0 && Bun.argv[i + 1]) return Bun.argv[i + 1] as string;
  if (fallback !== undefined) return fallback;
  console.error(`missing --${name}`);
  process.exit(1);
}

const model = arg('model', 'kimi-k3');
const scenario = arg('scenario', 'text');
const out = arg('out', `src/providers/openai-chat/__fixtures__/recorded-${model}-${scenario}.jsonl`);

const SCENARIOS: Record<string, Partial<ChatCompletionCreateParamsStreaming>> = {
  text: {
    messages: [{ role: 'user', content: 'Reply with exactly: Hello from the fixture recorder.' }],
  },
  tool: {
    messages: [{ role: 'user', content: 'What time is it in Tokyo? Use the get_time tool.' }],
    tools: [{
      type: 'function',
      function: {
        name: 'get_time',
        description: 'Get the current time in a timezone',
        parameters: {
          type: 'object',
          properties: { timezone: { type: 'string', description: 'IANA timezone, e.g. Asia/Tokyo' } },
          required: ['timezone'],
        },
      },
    }],
  },
  reasoning: {
    messages: [{ role: 'user', content: 'What is 17 * 23? Think step by step, then answer.' }],
  },
};

const scenarioParams = SCENARIOS[scenario];
if (!scenarioParams) {
  console.error(`unknown scenario '${scenario}' (${Object.keys(SCENARIOS).join('|')})`);
  process.exit(1);
}

const { baseURL, apiKey } = loadEndpointEnv();
if (!apiKey) {
  console.error('no api key found (.env api_key / OPENAI_API_KEY)');
  process.exit(1);
}

const client = new OpenAI({ baseURL, apiKey });
const stream = await client.chat.completions.create({
  model,
  stream: true,
  stream_options: { include_usage: true },
  ...scenarioParams,
} as ChatCompletionCreateParamsStreaming);

const lines: string[] = [];
const stdout = createStdoutOutput();
for await (const chunk of stream) {
  lines.push(JSON.stringify(chunk));   // 原样入库(无 headers,无需脱敏;request id 可保留)
  await stdout.write('.');
}
mkdirSync(path.dirname(out), { recursive: true });
await Bun.write(out, lines.join('\n') + '\n');
console.log(`\nrecorded ${lines.length} chunks → ${out}`);
