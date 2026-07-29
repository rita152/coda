// M4 demo(docs/11 M4 剧本,手动、不进 CI):真实模型上演示
// (1) 运行中注入 steering,模型下个 turn 改变方向;
// (2) abort() 之后 continue(),对话无缝续上且不炸 400(transform 层修复出站转录)。
// 用法:bun scripts/demo-m4.ts [--model kimi-k3]
import { Agent } from '../src/agent/index.js';
import type { ModelConfig } from '../src/protocol/index.js';
import { streamOpenAIChat } from '../src/providers/openai-chat/index.js';
import { createStdoutOutput } from '../src/shared/index.js';
import { createCodingTools } from '../src/tools/index.js';
import { loadEndpointEnv } from './env.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const modelName = ((): string => {
  const i = Bun.argv.indexOf('--model');
  return i >= 0 && Bun.argv[i + 1] ? (Bun.argv[i + 1] as string) : 'kimi-k3';
})();
const { baseURL, apiKey } = loadEndpointEnv();
if (apiKey === undefined) {
  console.error('no api key (.env api_key / OPENAI_API_KEY)');
  process.exit(1);
}

const model: ModelConfig = {
  ref: { provider: 'custom', api: 'openai-chat', model: modelName },
  baseURL,
  apiKey,
  compat: { supportsImageParts: true, supportsUsageInStreaming: true },
  defaults: { maxOutputTokens: 2048 },
};

const cwd = mkdtempSync(path.join(tmpdir(), 'coda-m4-demo-'));
const agent = new Agent({
  streamFn: streamOpenAIChat,
  model,
  tools: createCodingTools(),
  cwd,
  systemPrompt: `You are coda. Working directory: ${cwd}. Keep answers short.`,
});

const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;

let steered = false;
let abortArmed = false;
const stdout = createStdoutOutput();
agent.subscribe(async (e) => {
  switch (e.type) {
    case 'agent_start':
      console.log(bold(`\n[agent_start ${e.reason}]`));
      break;
    case 'message_update':
      if (e.event.type === 'text_delta') await stdout.write(e.event.delta);
      if (abortArmed && e.event.type === 'text_delta') {
        abortArmed = false;
        console.log(bold('\n>>> abort()(流式中途硬打断)'));
        agent.abort();
      }
      break;
    case 'tool_execution_start':
      console.log(bold(`\n→ ${e.toolName}(${JSON.stringify(e.args).slice(0, 120)})`));
      if (!steered) {
        steered = true;
        console.log(bold('>>> steer("文件内容改用全大写英文写")(工具执行中注入,不打断工具)'));
        agent.steer('改主意了:文件内容改用全大写英文写。');
      }
      break;
    case 'tool_execution_end': {
      const first = e.result.content[0];
      console.log(dim(`← ${e.result.isError ? 'ERROR ' : ''}${first?.type === 'text' ? first.text.split('\n')[0] : '[image]'}`));
      break;
    }
    case 'queue_update':
      console.log(dim(`[queue_update] steering=${e.steering.length} followUp=${e.followUp.length}`));
      break;
    case 'agent_end':
      console.log(bold(`\n[agent_end ${e.reason}]`));
      break;
  }
});

// ---- 场景 1:steering 改向 ----
console.log(bold('===== 场景 1:运行中 steering 注入 ====='));
await agent.prompt('用 write 工具在 notes.txt 写一句中文问候,然后 read 验证。');

// ---- 场景 2:abort → continue 无缝续上 ----
console.log(bold('\n===== 场景 2:abort 后 continue,不炸 400 ====='));
abortArmed = true;
try {
  await agent.prompt('给我讲讲这个目录下有什么文件,并解释每个文件的用途,说详细点。');
} catch {
  // prompt promise 在 abort 收尾后正常 resolve;此 catch 仅防御
}
console.log(bold('>>> continue()(重采样,transform 过滤 aborted assistant)'));
await agent.continue();
await stdout.drain();

const aborted = agent.transcript.filter((m) => m.role === 'assistant' && m.stopReason === 'aborted').length;
console.log(
  bold(
    `\n[demo done] transcript=${agent.transcript.length} 条(含 ${aborted} 条 aborted assistant 事实保留),` +
      ' 最后一次请求未发生 4xx——transform 修复生效',
  ),
);
