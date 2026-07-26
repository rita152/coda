// M5 store 层测试(docs/08-session-persistence.md §3.3/§4.1/§7/§8,docs/10 §5 末段):
// loadSession 的崩溃容忍与版本校验、compaction 折叠(M7 前置)、listSessions、UsageTracker。
// L4 纪律:真实 tmpdir 隔离 + afterEach 清理;无计时器、无网络。

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AgentMessage,
  AssistantMessage,
  ModelRef,
  StopReason,
  ToolResultMessage,
  Usage,
  UserMessage,
} from '../src/protocol/index.js';
import type { CompactionRecord, MessageRecord, MetaRecord, SessionRecord } from '../src/session/index.js';
import { listSessions, loadSession, PROTOCOL_VERSION, UsageTracker } from '../src/session/index.js';

const MODEL: ModelRef = { provider: 'faux', api: 'faux', model: 'test' };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'coda-store-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------- 记录构造 ----------

function meta(id: string, createdAt = 1_753_515_012_000): MetaRecord {
  return { type: 'meta', version: 1, protocolVersion: PROTOCOL_VERSION, id, createdAt, cwd: '/work/proj', model: MODEL };
}

function user(id: string, text: string): UserMessage {
  return { role: 'user', id, timestamp: 1, content: [{ type: 'text', text }], source: 'prompt' };
}

function assistant(id: string, text: string, o?: { usage?: Usage; stopReason?: StopReason }): AssistantMessage {
  return {
    role: 'assistant',
    id,
    timestamp: 2,
    content: [{ type: 'text', text }],
    model: MODEL,
    stopReason: o?.stopReason ?? 'stop',
    usage: o?.usage ?? { input: 100, output: 10 },
  };
}

const msg = (message: AgentMessage): MessageRecord => ({ type: 'message', message });

function compaction(tailStartId: string, summary: string, id = 'cmp_1'): CompactionRecord {
  return { type: 'compaction', id, timestamp: 1_753_518_800_000, tailStartId, summary };
}

/** 写会话文件:record 原样序列化;string 条目按原文写入(制造损坏行/半截行)。 */
function writeSession(id: string, records: (SessionRecord | string)[]): void {
  const lines = records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r)));
  writeFileSync(path.join(dir, `${id}.jsonl`), lines.join('\n'), 'utf8');   // 无尾换行:贴近写半行被杀的现场
}

// ---------- loadSession:崩溃容忍与版本校验 ----------

describe('loadSession:崩溃截断与版本校验(docs/08 §3.3/§8)', () => {
  it('尾行半截 JSON:静默丢弃,droppedCorruptTail 告警标记可观察', () => {
    writeSession('s1', [
      meta('s1'),
      msg(user('u1', 'hi')),
      msg(assistant('a1', 'hello')),
      '{"type":"message","message":{"role":"assis',   // 写半行被杀
    ]);
    const loaded = loadSession(dir, 's1');
    expect(loaded.droppedCorruptTail).toBe(true);
    expect(loaded.messages.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(loaded.meta.id).toBe('s1');
  });

  it('中部损坏行:拒绝加载,错误含 corrupted(文件真的坏了,不能装作没事)', () => {
    writeSession('s2', [meta('s2'), '{"broken', msg(user('u1', 'hi'))]);
    expect(() => loadSession(dir, 's2')).toThrow(/corrupted/);
  });

  it('未知 role:拒绝加载并提示版本不兼容', () => {
    const alien = { role: 'system', id: 'x1', timestamp: 1, content: [] } as unknown as AgentMessage;
    writeSession('s3', [meta('s3'), msg(alien)]);
    expect(() => loadSession(dir, 's3')).toThrow(/version incompatible/);
  });

  it('未知 part type:拒绝加载并提示版本不兼容', () => {
    const alien = {
      role: 'user', id: 'u1', timestamp: 1,
      content: [{ type: 'video', url: 'x' }],
    } as unknown as AgentMessage;
    writeSession('s4', [meta('s4'), msg(alien)]);
    expect(() => loadSession(dir, 's4')).toThrow(/version incompatible/);
  });

  it('meta.version 不兼容:拒绝加载', () => {
    writeSession('s5', [{ ...meta('s5'), version: 2 } as unknown as SessionRecord]);
    expect(() => loadSession(dir, 's5')).toThrow(/not supported/);
  });

  it('首行非 meta:拒绝加载', () => {
    writeSession('s6', [msg(user('u1', 'hi'))]);
    expect(() => loadSession(dir, 's6')).toThrow(/no meta header/);
  });

  it('只有 meta 行:合法,等价新会话(docs/08 §4.3)', () => {
    writeSession('s7', [meta('s7')]);
    const loaded = loadSession(dir, 's7');
    expect(loaded.messages).toEqual([]);
    expect(loaded.active).toEqual([]);
    expect(loaded.droppedCorruptTail).toBe(false);
  });

  it('同 id 重复:保留最后一条,顺序按首次出现(docs/08 §4.1)', () => {
    writeSession('s8', [
      meta('s8'),
      msg(user('u1', 'hi')),
      msg(assistant('a1', 'draft')),
      msg(assistant('a1', 'final')),
    ]);
    const loaded = loadSession(dir, 's8');
    expect(loaded.messages.map((m) => m.id)).toEqual(['u1', 'a1']);
    const a1 = loaded.messages[1] as AssistantMessage;
    expect(a1.content).toEqual([{ type: 'text', text: 'final' }]);
  });
});

// ---------- compaction 折叠(M7 前置,加载路径 M5 已在位) ----------

describe('compaction 折叠(docs/08 §4.1)', () => {
  const fourMessages = [user('u1', 'q1'), assistant('a1', 'r1'), user('u2', 'q2'), assistant('a2', 'r2')];

  it('active = synthetic summary + tailStartId 起的尾部;全量转录保留', () => {
    writeSession('c1', [meta('c1'), ...fourMessages.map(msg), compaction('u2', '早前对话摘要')]);
    const loaded = loadSession(dir, 'c1');
    expect(loaded.messages).toHaveLength(4);                       // 存储 append-only,历史完整
    expect(loaded.active).toHaveLength(3);
    const synth = loaded.active[0] as UserMessage;
    expect(synth.role).toBe('user');
    expect(synth.source).toBe('synthetic');
    expect(synth.content).toEqual([{ type: 'text', text: '[Conversation summary]\n早前对话摘要' }]);
    expect(loaded.active.slice(1).map((m) => m.id)).toEqual(['u2', 'a2']);
    expect(loaded.lastCompaction?.id).toBe('cmp_1');
  });

  it('多条 compaction 记录:取最后一条折叠', () => {
    writeSession('c2', [
      meta('c2'),
      ...fourMessages.map(msg),
      compaction('u2', 'S1', 'cmp_1'),
      compaction('a2', 'S2', 'cmp_2'),
    ]);
    const loaded = loadSession(dir, 'c2');
    expect(loaded.lastCompaction?.id).toBe('cmp_2');
    expect(loaded.active.map((m) => m.id).slice(1)).toEqual(['a2']);
    const synth = loaded.active[0] as UserMessage;
    expect(synth.content).toEqual([{ type: 'text', text: '[Conversation summary]\nS2' }]);
  });

  it('tailStartId 找不到:忽略该 record 用全量转录(lastCompaction 仍暴露供调用方告警)', () => {
    writeSession('c3', [meta('c3'), ...fourMessages.map(msg), compaction('ghost', 'S')]);
    const loaded = loadSession(dir, 'c3');
    expect(loaded.active).toEqual(loaded.messages);
    expect(loaded.active.some((m) => m.role === 'user' && m.source === 'synthetic')).toBe(false);
    expect(loaded.lastCompaction?.tailStartId).toBe('ghost');
  });
});

// ---------- listSessions ----------

describe('listSessions(docs/08 §2/§3.2)', () => {
  it('按 createdAt 新→旧;标题取首条 user 消息截 80 字符;坏文件与非 jsonl 跳过', () => {
    const longTitle = 'T'.repeat(100);
    writeSession('s-old', [meta('s-old', 1000), msg(user('u1', 'old task'))]);
    writeSession('s-new', [meta('s-new', 3000), msg(user('u1', longTitle))]);
    writeSession('s-mid', [meta('s-mid', 2000), msg(user('u1', 'mid task'))]);
    writeSession('s-empty', [meta('s-empty', 500)]);                          // 无 user 消息
    writeSession('s-bad', [meta('s-bad', 9999), '{{{corrupt', msg(user('u1', 'x'))]);   // 中部损坏 → 跳过
    writeFileSync(path.join(dir, 'notes.txt'), 'not a session', 'utf8');      // 非 .jsonl → 忽略

    const items = listSessions(dir);
    expect(items.map((i) => i.id)).toEqual(['s-new', 's-mid', 's-old', 's-empty']);
    expect(items[0]?.title).toHaveLength(80);
    expect(items[0]?.title).toBe(longTitle.slice(0, 80));
    expect(items[1]?.title).toBe('mid task');
    expect(items[3]?.title).toBe('(empty)');
    expect(items[0]?.model).toEqual(MODEL);
    expect(items[0]?.cwd).toBe('/work/proj');
  });

  it('目录不存在:返回空数组', () => {
    expect(listSessions(path.join(dir, 'nope'))).toEqual([]);
  });

  it('首条 user 是纯图片:标题 (empty);标题中换行替换为空格', () => {
    const imageOnly: UserMessage = {
      role: 'user', id: 'u1', timestamp: 1,
      content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
      source: 'prompt',
    };
    writeSession('s-img', [meta('s-img', 100), msg(imageOnly)]);
    writeSession('s-nl', [meta('s-nl', 200), msg(user('u1', '第一行\n第二行\n第三行'))]);

    const items = listSessions(dir);
    expect(items.find((i) => i.id === 's-img')?.title).toBe('(empty)');
    expect(items.find((i) => i.id === 's-nl')?.title).toBe('第一行 第二行 第三行');
  });

  it('轻量读取:首条 user 之后的损坏行不影响列出(只读到首 user 即停,不做全量校验)', () => {
    writeSession('s-late-corrupt', [
      meta('s-late-corrupt', 300),
      msg(user('u1', 'before corruption')),
      '{{{corrupt',                                   // 首 user 之后损坏:列表不应因此隐藏该会话
      msg(assistant('a1', 'x')),
    ]);
    const item = listSessions(dir).find((i) => i.id === 's-late-corrupt');
    expect(item).toBeDefined();
    expect(item?.title).toBe('before corruption');
    // list 的宽松只是轻量化,不改变加载语义:同一文件 loadSession 仍拒绝
    expect(() => loadSession(dir, 's-late-corrupt')).toThrow(/corrupted/);
  });
});

// ---------- loadSession:畸形记录(可 parse 但结构非法) ----------

describe('loadSession:畸形记录按损坏行策略(docs/08 §3.3)', () => {
  it('行内容 null(可 parse 非对象):尾行按崩溃残片丢弃', () => {
    writeSession('m1', [meta('m1'), msg(user('u1', 'hi')), 'null']);
    const loaded = loadSession(dir, 'm1');
    expect(loaded.droppedCorruptTail).toBe(true);
    expect(loaded.messages.map((m) => m.id)).toEqual(['u1']);
  });

  it('行内容 null 在中部:拒绝加载(文件真的坏了)', () => {
    writeSession('m2', [meta('m2'), 'null', msg(user('u1', 'hi'))]);
    expect(() => loadSession(dir, 'm2')).toThrow(/corrupted/);
  });

  it('message 缺 content 数组:version incompatible 拒绝(不得带着畸形消息继续跑)', () => {
    const noContent = { role: 'user', id: 'u1', timestamp: 1 } as unknown as AgentMessage;
    writeSession('m3', [meta('m3'), msg(noContent)]);
    expect(() => loadSession(dir, 'm3')).toThrow(/version incompatible/);
  });
});

// ---------- UsageTracker ----------

let seq = 0;
function am(usage: Usage, stopReason: StopReason = 'stop'): AssistantMessage {
  return { ...assistant(`am_${seq++}`, 'ok', { usage, stopReason }) };
}

describe('UsageTracker(docs/08 §7)', () => {
  it('可选字段:从未出现保持 undefined,出现过才累加(不把「不上报」渲染成 0)', () => {
    const t = new UsageTracker();
    t.add(am({ input: 100, output: 10 }));
    t.add(am({ input: 50, output: 5 }));
    let s = t.snapshot();
    expect(s.cumulative).toEqual({ input: 150, output: 15 });
    expect(s.cumulative.cacheRead).toBeUndefined();
    expect(s.cumulative.cacheWrite).toBeUndefined();
    expect(s.cumulative.reasoning).toBeUndefined();
    expect(s.cumulative.costUSD).toBeUndefined();

    t.add(am({ input: 30, output: 3, cacheRead: 8 }));
    s = t.snapshot();
    expect(s.cumulative.cacheRead).toBe(8);
    t.add(am({ input: 20, output: 2, cacheRead: 4, reasoning: 1 }));
    s = t.snapshot();
    expect(s.cumulative).toEqual({ input: 200, output: 20, cacheRead: 12, reasoning: 1 });
    expect(s.turns).toBe(4);
  });

  it('error/aborted 也累加(钱已经花了);contextTokens 只跟最近成功 turn', () => {
    const t = new UsageTracker();
    t.add(am({ input: 100, output: 10 }));
    t.add(am({ input: 40, output: 4 }, 'error'));
    t.add(am({ input: 30, output: 0 }, 'aborted'));
    const s = t.snapshot();
    expect(s.turns).toBe(3);
    expect(s.cumulative).toEqual({ input: 170, output: 14 });
    expect(s.contextTokens).toBe(110);                       // 后两条非成功 turn 不刷新
    expect(s.lastTurn).toEqual({ input: 30, output: 0 });    // per-turn 视图仍是最近一条
  });

  it('pricing 换算与手算一致(cacheRead/Write 拆分;docs/08 §7.3 公式)', () => {
    const t = new UsageTracker({ inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 });
    const cost1 = t.add(am({ input: 1000, output: 500, cacheRead: 200, cacheWrite: 100 }));
    const expected1 = ((1000 - 200 - 100) * 3 + 200 * 0.3 + 100 * 3.75 + 500 * 15) / 1e6;
    expect(cost1).toBeCloseTo(expected1, 12);
    expect(t.snapshot().cumulative.costUSD).toBeCloseTo(expected1, 12);

    const cost2 = t.add(am({ input: 1000, output: 100 }));   // 无 cache 字段:全按 input 价
    const expected2 = (1000 * 3 + 100 * 15) / 1e6;
    expect(cost2).toBeCloseTo(expected2, 12);
    expect(t.snapshot().cumulative.costUSD).toBeCloseTo(expected1 + expected2, 12);
  });

  it('无 pricing:costUSD 保持 undefined', () => {
    const t = new UsageTracker();
    expect(t.add(am({ input: 1000, output: 500, cacheRead: 200 }))).toBeUndefined();
    t.add(am({ input: 100, output: 10 }));
    expect(t.snapshot().cumulative.costUSD).toBeUndefined();
  });

  it('seed 重建与逐条 add 等价;非 assistant 消息忽略(统计与转录同源)', () => {
    const a1 = am({ input: 120, output: 15, cacheRead: 20 });
    const a2 = am({ input: 240, output: 30, reasoning: 5 });
    const tr: ToolResultMessage = {
      role: 'tool_result', id: 'tr1', timestamp: 3,
      toolCallId: 'c1', toolName: 'lookup',
      content: [{ type: 'text', text: 'r' }], isError: false,
    };
    const seeded = new UsageTracker();
    seeded.seed([user('u1', 'q'), a1, tr, a2]);
    const manual = new UsageTracker();
    manual.add(a1);
    manual.add(a2);
    expect(seeded.snapshot()).toEqual(manual.snapshot());
    expect(seeded.snapshot().cumulative).toEqual({ input: 360, output: 45, cacheRead: 20, reasoning: 5 });
  });
});
