// OpenAI Chat 冒烟(手动、不进 CI):经 streamOpenAIChat 完整管线
// 对真实 endpoint 跑 (1) 带工具调用的流式往返 (2) 可选视觉测试。
// 用法:bun run smoke -- [--model kimi-k3] [--vision]
import type { AgentMessage, Context, ModelConfig } from '../src/protocol/index.js';
import { streamOpenAIChat } from '../src/providers/openai-chat/index.js';
import { createStdoutOutput } from '../src/shared/index.js';
import { loadEndpointEnv } from './env.js';

const modelName = ((): string => {
  const i = Bun.argv.indexOf('--model');
  return i >= 0 && Bun.argv[i + 1] ? (Bun.argv[i + 1] as string) : 'kimi-k3';
})();
const vision = Bun.argv.includes('--vision');

const { baseURL, apiKey } = loadEndpointEnv();
if (!apiKey) {
  console.error('no api key (.env api_key / OPENAI_API_KEY)');
  process.exit(1);
}

const model: ModelConfig = {
  ref: { provider: 'custom', api: 'openai-chat', model: modelName },
  baseURL,
  apiKey,
  // 未识别端点走保守 profile;kimi-k3 具备视觉能力,显式覆盖开启;usage 试探开启
  compat: { supportsImageParts: true, supportsUsageInStreaming: true },
  defaults: { maxOutputTokens: 2048 },
};
const stdout = createStdoutOutput();

async function runTurn(label: string, ctx: Context): Promise<AgentMessage> {
  console.log(`\n===== ${label} =====`);
  const stream = streamOpenAIChat(model, ctx);
  for await (const e of stream) {
    if (e.type === 'reasoning_start') await stdout.write('\x1b[2m[thinking] ');
    if (e.type === 'reasoning_delta') await stdout.write(e.delta);
    if (e.type === 'reasoning_end') await stdout.write('\x1b[0m\n');
    if (e.type === 'text_delta') await stdout.write(e.delta);
    if (e.type === 'tool_call_end') {
      await stdout.write(
        `\n[tool_call] ${e.toolCall.name}(${JSON.stringify(e.toolCall.arguments)}) id=${e.toolCall.id}`,
      );
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
  messages: [{
    role: 'user', id: 'u1', timestamp: Date.now(),
    content: [{ type: 'text', text: 'What time is it in Tokyo right now? You MUST call the get_time tool.' }],
  }],
  tools: [{
    name: 'get_time',
    description: 'Get the current time in a timezone',
    parameters: {
      type: 'object',
      properties: { timezone: { type: 'string', description: 'IANA timezone, e.g. Asia/Tokyo' } },
      required: ['timezone'],
    },
  }],
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
        role: 'tool_result', id: 'tr1', timestamp: Date.now(),
        toolCallId: call.id, toolName: call.name,
        content: [{ type: 'text', text: '2026-07-27 09:15 JST' }], isError: false,
      },
    ],
  };
  const second = await runTurn('turn 2 (tool result → final answer)', roundTrip);
  if (second.role === 'assistant' && second.stopReason !== 'stop') {
    console.error('unexpected second-turn stopReason');
    process.exit(1);
  }
  console.log('\n[smoke] tool roundtrip OK — no 400, pairing accepted by endpoint');
} else {
  console.error('\n[smoke] FAILED: model did not call the tool — tool roundtrip unverified');
  process.exit(2);   // 区分「端点可达但工具路径未验证」
}

// ---- 场景 2(可选):视觉 ----
if (vision) {
  // 64x64 纯红色 PNG(实测:部分上游拒绝过小图片,8x8 会 400,64x64 通过)
  const redPng =
    'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC';
  const visionCtx: Context = {
    messages: [{
      role: 'user', id: 'v1', timestamp: Date.now(),
      content: [
        { type: 'text', text: 'What is the dominant color of this image? Answer with one word.' },
        { type: 'image', data: redPng, mimeType: 'image/png' },
      ],
    }],
  };
  const answer = await runTurn('vision', visionCtx);
  const text = answer.role === 'assistant'
    ? answer.content.filter((p) => p.type === 'text').map((p) => p.text).join('')
    : '';
  console.log(`\n[smoke] vision answer: ${JSON.stringify(text.trim())}`);
}

console.log('\n[smoke] all scenarios passed');
await stdout.drain();
