// M3 集成脚本(docs/11-roadmap.md M3 验收 3,手动、不进 CI):真实模型驱动完整 agent loop,
// 对真实文件执行工具往返。用法:
//   bun scripts/dev-run.ts "把 fixtures/a.txt 里的 foo 改成 bar" [--model kimi-k3] [--cwd DIR]
import { Agent } from '../src/agent/index.js';
import type { ModelConfig } from '../src/protocol/index.js';
import { streamOpenAIChat } from '../src/providers/openai-chat/index.js';
import { createStdoutOutput } from '../src/shared/index.js';
import { createCodingTools } from '../src/tools/index.js';
import { loadEndpointEnv } from './env.js';

function flag(name: string): string | undefined {
  const i = Bun.argv.indexOf(`--${name}`);
  return i >= 0 ? Bun.argv[i + 1] : undefined;
}
const modelName = flag('model') ?? 'kimi-k3';
const cwd = flag('cwd') ?? process.cwd();
const promptText = Bun.argv
  .slice(2)
  .filter((a, i, arr) => !a.startsWith('--') && arr[i - 1] !== '--model' && arr[i - 1] !== '--cwd')
  .join(' ');

if (promptText.length === 0) {
  console.error('usage: bun scripts/dev-run.ts "<task>" [--model m] [--cwd dir]');
  process.exit(1);
}
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
  defaults: { maxOutputTokens: 4096 },
};

const agent = new Agent({
  streamFn: streamOpenAIChat,
  model,
  tools: createCodingTools(),
  cwd,
  systemPrompt: () =>
    `You are coda, a terminal coding agent. Working directory: ${cwd}\n` +
    'Use the provided tools to complete the task. Read files before editing them. ' +
    'When done, summarize what you changed in one short sentence.',
});

const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;
const stdout = createStdoutOutput();

agent.subscribe(async (e) => {
  switch (e.type) {
    case 'message_update': {
      const ev = e.event;
      if (ev.type === 'text_delta') await stdout.write(ev.delta);
      if (ev.type === 'reasoning_delta') await stdout.write(dim(ev.delta));
      if (ev.type === 'reasoning_end' || ev.type === 'text_end') await stdout.write('\n');
      break;
    }
    case 'tool_execution_start':
      console.log(bold(`\n→ ${e.toolName}(${JSON.stringify(e.args)})`));
      break;
    case 'tool_execution_end': {
      const first = e.result.content[0];
      const preview = first?.type === 'text' ? first.text.split('\n').slice(0, 5).join('\n') : '[image]';
      console.log(dim(`← ${e.result.isError ? 'ERROR ' : ''}${preview}`));
      const details = e.result.details as { diff?: string } | undefined;
      if (details?.diff !== undefined) console.log(details.diff);
      break;
    }
    case 'agent_end': {
      const usage = e.messages
        .filter((m) => m.role === 'assistant')
        .reduce(
          (acc, m) => ({ input: acc.input + m.usage.input, output: acc.output + m.usage.output }),
          { input: 0, output: 0 },
        );
      console.log(
        `\n${bold(`[agent_end ${e.reason}]`)} turns=${e.messages.filter((m) => m.role === 'assistant').length} usage=${JSON.stringify(usage)}`,
      );
      break;
    }
  }
});

await agent.prompt(promptText);
await stdout.drain();
