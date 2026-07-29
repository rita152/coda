// L5 e2e 用例 5(docs/10-testing.md §7):resume——会话 1 跑完退出,--resume <id> 起会话 2,
// 断言重放转录与会话 1 一致。断言设计(headless 不回显历史转录,faux 的 calls 又跨进程
// 不可见,故用两条同源证据):
// (a) JSONL 文件:会话 2 退出后,原会话 1 的全部记录逐字节原样保留为前缀(append-only,
//     resume 未改写历史),其后恰好追加会话 2 的新消息——两次进程写的是同一个会话;
// (b) usage_update 累计值:UsageTracker 恢复时从 loadSession 的 active 转录 seed
//     (docs/08 §7.2「统计与转录同源」),会话 2 第二次 prompt 后 cumulative 若等于
//     两条 assistant 之和,即证明会话 1 的转录被完整加载进了 agent。

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, expect, test } from 'bun:test';
import type { CodaProc } from './harness.js';
import { CASE_TIMEOUT_MS, msgRole, msgText, readJsonl, requireDist, startCoda } from './harness.js';

beforeAll(() => {
  requireDist();
});

const procs: CodaProc[] = [];
afterEach(() => {
  for (const p of procs.splice(0)) p.kill();
});
function track(p: CodaProc): CodaProc {
  procs.push(p);
  return p;
}

test('case 5: resume — session 2 replays session 1 transcript (JSONL prefix + seeded usage)', async () => {
  // ---- 会话 1:一问一答后 shutdown ----
  const s1 = track(
    startCoda({
      script: {
        turns: [{ events: [{ kind: 'text', text: 'answer one' }] }],
        onExhausted: 'emptyStop',
      },
    }),
  );
  s1.send({ type: 'prompt', text: 'first question' });
  const end1 = await s1.waitForEvent((e) => e.type === 'agent_end', 'session 1 agent_end');
  expect(end1['reason']).toBe('completed');
  s1.send({ type: 'shutdown' });
  expect(await s1.waitForExit()).toBe(0);

  // 会话 id 取自会话目录(仅一个 .jsonl)
  const files = readdirSync(s1.sessionDir).filter((f) => f.endsWith('.jsonl'));
  expect(files).toHaveLength(1);
  const id = (files[0] as string).slice(0, -'.jsonl'.length);
  const sessionFile = path.join(s1.sessionDir, files[0] as string);

  const records1 = readJsonl(sessionFile);
  expect(records1.map((r) => r['type'])).toEqual(['meta', 'message', 'message']);
  const [, user1, assistant1] = records1 as [unknown, { message: { role: string; content: { text?: string }[] } }, { message: { role: string; usage: { input: number; output: number } } }];
  expect(user1.message.role).toBe('user');
  expect(user1.message.content[0]?.text).toBe('first question');
  expect(assistant1.message.role).toBe('assistant');
  expect(assistant1.message.usage).toMatchObject({ input: 100, output: 10 }); // faux 缺省 usage

  // ---- 会话 2:--resume <id>,同一 session-dir,第二次 prompt ----
  const s2 = track(
    startCoda({
      script: {
        turns: [{ events: [{ kind: 'text', text: 'answer two' }] }],
        onExhausted: 'emptyStop',
      },
      resume: id,
      sessionDir: s1.sessionDir,
      cwd: s1.cwd,
    }),
  );
  await s2.waitForEvent((e) => e.type === 'protocol', 'session 2 protocol header');
  s2.send({ type: 'prompt', text: 'second question' });
  const end2 = await s2.waitForEvent((e) => e.type === 'agent_end', 'session 2 agent_end');
  expect(end2['reason']).toBe('completed');
  s2.send({ type: 'shutdown' });
  expect(await s2.waitForExit()).toBe(0);

  // (b) usage 同源断言:cumulative = 会话 1 assistant + 会话 2 assistant(100+100 / 10+10),
  // turns = 2——只有会话 1 转录被 seed 进来才可能成立
  const usageEvents = s2.events.filter((e) => e.type === 'usage_update');
  expect(usageEvents.length).toBeGreaterThan(0);
  const lastUsage = usageEvents[usageEvents.length - 1]?.['usage'] as {
    cumulative: { input: number; output: number };
    turns: number;
  };
  expect(lastUsage.cumulative).toMatchObject({ input: 200, output: 20 });
  expect(lastUsage.turns).toBe(2);

  // (a) JSONL 断言:会话 1 的记录原样保留为前缀,其后追加会话 2 的 user+assistant
  const records2 = readJsonl(sessionFile);
  expect(records2.slice(0, records1.length)).toEqual(records1);
  const appended = records2.slice(records1.length);
  expect(appended.map((r) => r['type'])).toEqual(['message', 'message']);
  const [user2, assistant2] = appended as [{ message: { role: string; source?: string; content: { text?: string }[] } }, { message: { role: string; content: { text?: string }[] } }];
  expect(user2.message.role).toBe('user');
  expect(user2.message.source).toBe('prompt');
  expect(user2.message.content[0]?.text).toBe('second question');
  expect(assistant2.message.role).toBe('assistant');
  expect(assistant2.message.content[0]?.text).toBe('answer two');

  // 会话 2 的事件流里,新 assistant 的终态文本正常到达(管道仍守纪律)
  const aEnd = s2.events.find((e) => e.type === 'message_end' && msgRole(e) === 'assistant');
  expect(msgText(aEnd)).toBe('answer two');
  expect(s1.parseErrors).toEqual([]);
  expect(s2.parseErrors).toEqual([]);
}, { timeout: CASE_TIMEOUT_MS });
