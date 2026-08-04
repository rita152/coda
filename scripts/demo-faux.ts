// Faux provider demo:在终端逐字打印一条流式 assistant 消息,全程无网络。
// 运行:bun run demo:faux
import { createFauxStreamFn } from '../src/providers/faux/index.js';
import { createStdoutOutput } from '../src/shared/index.js';

const streamFn = createFauxStreamFn({
  turns: [{
    events: [
      { kind: 'reasoning', text: '我用一句话证明流式管线在工作。', chunkSize: 6 },
      { kind: 'text', text: '你好!这条消息经由 内部协议 ProviderEvent 流逐字抵达终端——没有网络、没有计时器,只有微任务。', chunkSize: 4 },
    ],
    usage: { input: 42, output: 33, reasoning: 12 },
  }],
});

const stream = streamFn({ ref: { provider: 'faux', api: 'faux', model: 'demo' } }, { messages: [] });
const stdout = createStdoutOutput();

for await (const event of stream) {
  if (event.type === 'reasoning_start') await stdout.write('\x1b[2m[thinking] ');
  if (event.type === 'reasoning_delta' || event.type === 'text_delta') await stdout.write(event.delta);
  if (event.type === 'reasoning_end') await stdout.write('\x1b[0m\n');
  if (event.type === 'done') {
    const { stopReason, usage } = event.message;
    await stdout.write(`\n\n[done] stopReason=${stopReason} usage=${JSON.stringify(usage)}\n`);
  }
}
