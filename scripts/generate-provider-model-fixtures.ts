// CLI provider discovery 的确定性离线 fixture。
// 修改场景后运行 `bun run fixtures:provider-models`，不要手改生成的 JSON。

import { mkdirSync } from 'node:fs';
import path from 'node:path';

const output = path.join(
  import.meta.dir,
  '..',
  'src',
  'cli',
  '__fixtures__',
  'provider-models.json',
);

const fixture = {
  openCodeGoMixed: {
    data: [
      { id: 'kimi-k3', object: 'model' },
      { id: 'minimax-m3', object: 'model' },
      { id: 'deepseek-v4-flash', object: 'model' },
      { id: 'unknown-future-model', object: 'model' },
    ],
  },
  custom: {
    data: [
      { id: 'custom-alpha', object: 'model' },
      { id: 'org/custom-beta', object: 'model' },
    ],
  },
  anthropic: {
    data: [
      {
        id: 'claude-opus-4-6',
        type: 'model',
        display_name: 'Claude Opus 4.6',
        created_at: '2026-02-04T00:00:00Z',
        capabilities: {
          image_input: { supported: true },
          thinking: {
            supported: true,
            types: { enabled: { supported: true } },
          },
          future_capability: { supported: true, rollout: 'preview' },
        },
        max_input_tokens: 200_000,
        max_tokens: 64_000,
        future_metadata: { retained: false },
      },
      {
        id: 'claude-legacy',
        type: 'model',
        capabilities: null,
        max_input_tokens: null,
        max_tokens: null,
      },
    ],
  },
};

mkdirSync(path.dirname(output), { recursive: true });
await Bun.write(output, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`wrote ${path.relative(path.join(import.meta.dir, '..'), output)}`);
