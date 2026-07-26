// Anthropic Messages SSE fixture 录制(M7,docs/10 §4.3 同思路):对真实 Messages 端点
// 发起流式请求,把每条原始 SSE 事件存为 JSONL。手动运行、fixture 入库;CI 永不联网。
// 用法:npm run record:anthropic -- --scenario text|tool|thinking --out src/providers/anthropic-messages/__fixtures__/xxx.jsonl
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line no-restricted-imports -- 录制脚本直接消费原始 wire 事件,是 @anthropic-ai/sdk 封锁的显式豁免点
import Anthropic from '@anthropic-ai/sdk';
// eslint-disable-next-line no-restricted-imports -- 同上
import type { MessageCreateParamsStreaming } from '@anthropic-ai/sdk/resources/messages';
import { loadAnthropicEnv } from './env.js';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1] as string;
  if (fallback !== undefined) return fallback;
  console.error(`missing --${name}`);
  process.exit(1);
}

const model = arg('model', 'claude-opus-5');
const scenario = arg('scenario', 'text');
const out = arg('out', `src/providers/anthropic-messages/__fixtures__/${scenario}.jsonl`);

const SCENARIOS: Record<string, Partial<MessageCreateParamsStreaming>> = {
  text: {
    messages: [{ role: 'user', content: 'Reply with exactly: Hello from the fixture recorder.' }],
  },
  tool: {
    messages: [{ role: 'user', content: 'What time is it in Tokyo? You must use the get_time tool.' }],
    tools: [
      {
        name: 'get_time',
        description: 'Get the current time in a timezone',
        input_schema: {
          type: 'object',
          properties: { timezone: { type: 'string', description: 'IANA timezone, e.g. Asia/Tokyo' } },
          required: ['timezone'],
        },
      },
    ],
  },
  thinking: {
    messages: [{ role: 'user', content: 'What is 17 * 23? Think through it, then give the answer.' }],
    thinking: { type: 'enabled', budget_tokens: 1024 },
  },
};

const scenarioParams = SCENARIOS[scenario];
if (!scenarioParams) {
  console.error(`unknown scenario '${scenario}' (${Object.keys(SCENARIOS).join('|')})`);
  process.exit(1);
}

const { baseURL, apiKey } = loadAnthropicEnv();
if (!apiKey) {
  console.error('no api key found (.env claude_api_key / ANTHROPIC_API_KEY)');
  process.exit(1);
}

const client = new Anthropic({ baseURL, apiKey });
const params: MessageCreateParamsStreaming = {
  model,
  stream: true,
  max_tokens: scenario === 'thinking' ? 2048 : 1024,
  ...scenarioParams,
} as MessageCreateParamsStreaming;

const stream = client.messages.stream(params);
const lines: string[] = [];
for await (const event of stream) {
  lines.push(JSON.stringify(event));   // 原样入库(SDK 已解析出的 wire 事件对象)
  process.stdout.write('.');
}
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, lines.join('\n') + '\n', 'utf8');
console.log(`\nrecorded ${lines.length} events → ${out}`);
