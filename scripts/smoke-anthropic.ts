// M7 Anthropic 冒烟(docs/11 M7,手动、不进 CI):经 streamAnthropicMessages 完整管线对真实
// Messages 端点跑一轮带工具调用的流式往返(claude-opus-5)。tool_result block 原生支持图片,
// 不需要 openai-chat 的抽出补丁——这是协议表达力的验证点。
// 用法:npm run smoke:anthropic -- [--model claude-opus-5] [--vision]
import type { AgentMessage, Context, ModelConfig } from '../src/protocol/index.js';
import { streamAnthropicMessages } from '../src/providers/anthropic-messages/index.js';
import { loadAnthropicEnv } from './env.js';

const modelName = ((): string => {
  const i = process.argv.indexOf('--model');
  return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : 'claude-opus-5';
})();
const vision = process.argv.includes('--vision');

const { baseURL, apiKey } = loadAnthropicEnv();
if (!apiKey) {
  console.error('no api key (.env claude_api_key / ANTHROPIC_API_KEY)');
  process.exit(1);
}

const model: ModelConfig = {
  ref: { provider: 'anthropic', api: 'anthropic-messages', model: modelName },
  baseURL,
  apiKey,
  defaults: { maxOutputTokens: 2048 },
};

async function runTurn(label: string, ctx: Context): Promise<AgentMessage> {
  console.log(`\n===== ${label} =====`);
  const stream = streamAnthropicMessages(model, ctx);
  for await (const e of stream) {
    if (e.type === 'reasoning_delta') process.stdout.write(`\x1b[2m${e.delta}\x1b[0m`);
    if (e.type === 'text_delta') process.stdout.write(e.delta);
    if (e.type === 'tool_call_end') {
      process.stdout.write(`\n[tool_call] ${e.toolCall.name}(${JSON.stringify(e.toolCall.arguments)}) id=${e.toolCall.id}`);
    }
  }
  const msg = await stream.result();
  console.log(`\n[${label}] stopReason=${msg.stopReason} usage=${JSON.stringify(msg.usage)}`);
  if (msg.stopReason === 'error' || msg.stopReason === 'aborted') {
    console.error(`[${label}] FAILED: ${msg.errorMessage ?? '(aborted)'}`, msg.errorDetails ?? '');
    process.exit(1);
  }
  return msg;
}

// ---- 场景 1:带工具调用的完整 turn 往返 ----
const toolCtx: Context = {
  systemPrompt: 'You are coda, a coding agent. Use tools when asked.',
  messages: [
    {
      role: 'user',
      id: 'u1',
      timestamp: Date.now(),
      content: [{ type: 'text', text: 'What time is it in Tokyo right now? You MUST call the get_time tool.' }],
    },
  ],
  tools: [
    {
      name: 'get_time',
      description: 'Get the current time in a timezone',
      parameters: {
        type: 'object',
        properties: { timezone: { type: 'string', description: 'IANA timezone, e.g. Asia/Tokyo' } },
        required: ['timezone'],
      },
    },
  ],
};

const first = await runTurn('turn 1 (expect tool_calls)', toolCtx);
if (first.role === 'assistant' && first.stopReason === 'tool_calls') {
  const call = first.content.find((p) => p.type === 'tool_call');
  if (!call) throw new Error('tool_calls stopReason but no tool_call part');
  const roundTrip: Context = {
    ...toolCtx,
    messages: [
      ...toolCtx.messages,
      first,
      {
        role: 'tool_result',
        id: 'tr1',
        timestamp: Date.now(),
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: 'text', text: '2026-07-27 09:15 JST' }],
        isError: false,
      },
    ],
  };
  const second = await runTurn('turn 2 (tool result → final answer)', roundTrip);
  if (second.role === 'assistant' && second.stopReason !== 'stop') {
    console.error('unexpected second-turn stopReason');
    process.exit(1);
  }
  console.log('\n[smoke] tool roundtrip OK — no 400, tool_use/tool_result pairing accepted by Messages endpoint');
} else {
  console.error('\n[smoke] FAILED: model did not call the tool');
  process.exit(2);
}

// ---- 场景 2(可选):视觉(tool_result 原生图片)----
if (vision) {
  const redPng =
    'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC';
  const visionCtx: Context = {
    messages: [
      {
        role: 'user',
        id: 'v1',
        timestamp: Date.now(),
        content: [
          { type: 'text', text: 'What is the dominant color of this image? Answer with one word.' },
          { type: 'image', data: redPng, mimeType: 'image/png' },
        ],
      },
    ],
  };
  const vmsg = await runTurn('vision (image in user message)', visionCtx);
  const text = vmsg.role === 'assistant' ? vmsg.content.filter((p) => p.type === 'text').map((p) => p.text).join('') : '';
  console.log(`\n[smoke] vision answer: ${text.trim()}`);
}
