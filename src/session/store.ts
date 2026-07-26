// SessionStore:追加式 JSONL 读写(规格见 docs/08-session-persistence.md §3/§4)。
// 一个会话 = 一个文件 ~/.coda/sessions/<id>.jsonl,三种记录(meta/message/compaction),
// 存储 append-only、视图靠折叠;崩溃容忍:尾行半截 JSON 丢弃,中部损坏拒绝加载。

import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, truncateSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AgentMessage, ModelRef, UserMessage } from '../protocol/index.js';

export const STORE_VERSION = 1;
export const PROTOCOL_VERSION = '1.0.0';

export interface MetaRecord {
  type: 'meta';
  version: 1;                  // 存储格式版本(JSONL 记录结构本身)
  protocolVersion: string;     // AgentEvent/AgentMessage 协议版本(docs/03 §9.2)
  id: string;
  createdAt: number;
  cwd: string;                 // 创建会话时的工作目录,--resume 默认按 cwd 过滤
  model: ModelRef;
}
export interface MessageRecord { type: 'message'; message: AgentMessage }
export interface CompactionRecord {
  type: 'compaction';
  id: string;
  timestamp: number;
  tailStartId: string;         // 保留尾部的第一条消息 id
  summary: string;             // LLM 摘要全文
  contextTokensBefore?: number;
}
export type SessionRecord = MetaRecord | MessageRecord | CompactionRecord;

export interface LoadedSession {
  meta: MetaRecord;
  /** 全量转录(同 id 重复保留最后一条——防御性,正常流程不产生重复)。 */
  messages: AgentMessage[];
  /** 折叠 compaction 后的活动转录(synthetic summary + 尾部);无 compaction 时等于 messages。 */
  active: AgentMessage[];
  lastCompaction?: CompactionRecord;
  /** 尾行半截 JSON 被丢弃时为 true(告警用)。 */
  droppedCorruptTail: boolean;
}

export function defaultSessionDir(): string {
  return path.join(homedir(), '.coda', 'sessions');
}

export function newSessionId(now = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${rand}`;   // 时间前缀天然可按文件名排序
}

/** 追加式写入器:每条 message_end 即时 append(不等 agent_end——崩溃恢复到最后一条完整消息)。 */
export class SessionStore {
  readonly file: string;

  constructor(dir: string, readonly id: string) {
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `${id}.jsonl`);
  }

  /** 新会话:id 碰撞(同秒 + 随机撞车)时重试换 rand,防两个会话静默写同一文件。 */
  static createNew(dir: string): { id: string; store: SessionStore } {
    mkdirSync(dir, { recursive: true });
    for (let attempt = 0; ; attempt++) {
      const id = newSessionId();
      if (!existsSync(path.join(dir, `${id}.jsonl`))) {
        return { id, store: new SessionStore(dir, id) };
      }
      if (attempt >= 20) throw new Error('Unable to allocate a unique session id');
    }
  }

  append(record: SessionRecord): void {
    // 显式 \n 行尾(R3:JSONL 永远 LF);同步 append 保证事件监听 await 串行下的落盘确定性
    appendFileSync(this.file, `${JSON.stringify(record)}\n`, 'utf8');
  }

  /**
   * 崩溃尾修复(resume 时调用):文件末尾存在无换行收尾的残片时,直接 append 会把
   * 新记录粘在残片后形成「中部损坏行」——下次加载按规格拒绝。残片可解析则补换行保留,
   * 不可解析则截掉(与 loadSession 的丢弃语义一致)。
   */
  repairTail(): void {
    if (!existsSync(this.file)) return;
    const raw = readFileSync(this.file, 'utf8');
    if (raw.length === 0 || raw.endsWith('\n')) return;
    const lastNewline = raw.lastIndexOf('\n');
    const fragment = raw.slice(lastNewline + 1);
    try {
      JSON.parse(fragment);
      appendFileSync(this.file, '\n', 'utf8');   // 恰在 \n 前崩溃:记录完整,补行尾
    } catch {
      truncateSync(this.file, Buffer.byteLength(raw.slice(0, lastNewline + 1), 'utf8'));
    }
  }

  /** agent_end 时机的一次 fsync(默认依赖 OS 缓冲,不为每条消息付 fsync 代价)。 */
  fsync(): void {
    try {
      const fd = openSync(this.file, 'r+');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      // 文件尚不存在等:忽略
    }
  }
}

/** 加载会话文件:meta 校验、崩溃截断容忍、compaction 折叠(docs/08 §4.1)。 */
export function loadSession(dir: string, id: string): LoadedSession {
  const file = path.join(dir, `${id}.jsonl`);
  if (!existsSync(file)) throw new Error(`Session not found: ${id} (${file})`);
  const raw = readFileSync(file, 'utf8');
  const lines = raw.split('\n').filter((l) => l.length > 0);

  const records: SessionRecord[] = [];
  let droppedCorruptTail = false;
  for (let i = 0; i < lines.length; i++) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i] as string);
    } catch {
      parsed = undefined;
    }
    // 可 parse 但结构畸形(null、非对象、无 type)与不可 parse 同策:尾行丢弃,中部拒绝
    if (parsed === null || typeof parsed !== 'object' || typeof (parsed as { type?: unknown }).type !== 'string') {
      if (i === lines.length - 1) {
        droppedCorruptTail = true;   // 写半行被杀:静默丢弃尾行
        break;
      }
      throw new Error(`Session file corrupted at line ${i + 1}: ${id}.jsonl (refusing to load)`);
    }
    records.push(parsed as SessionRecord);
  }

  const meta = records[0];
  if (meta === undefined || meta.type !== 'meta') {
    throw new Error(`Session file has no meta header: ${id}.jsonl`);
  }
  if (meta.version !== STORE_VERSION) {
    throw new Error(`Session store version ${String(meta.version)} is not supported (expected ${STORE_VERSION})`);
  }

  // 同 id 重复保留最后一条;顺序按首次出现位置
  const byId = new Map<string, AgentMessage>();
  const order: string[] = [];
  let lastCompaction: CompactionRecord | undefined;
  for (const r of records) {
    if (r.type === 'message') {
      const m = r.message;
      validateMessage(m, id);
      if (!byId.has(m.id)) order.push(m.id);
      byId.set(m.id, m);
    } else if (r.type === 'compaction') {
      lastCompaction = r;
    }
  }
  const messages = order.map((mid) => byId.get(mid) as AgentMessage);

  let active = messages;
  if (lastCompaction) {
    const idx = messages.findIndex((m) => m.id === lastCompaction?.tailStartId);
    if (idx >= 0) {
      active = [syntheticSummaryMessage(lastCompaction.summary), ...messages.slice(idx)];
    }
    // tailStartId 找不到:忽略该 compaction 用全量转录(调用方告警)
  }

  return { meta, messages, active, lastCompaction, droppedCorruptTail };
}

/** 未知 role / part type(未来版本写的文件)→ 拒绝加载(docs/08 §8;v1 不做向前兼容)。 */
function validateMessage(m: AgentMessage, sessionId: string): void {
  const KNOWN_ROLES = ['user', 'assistant', 'tool_result'];
  const KNOWN_PARTS = ['text', 'reasoning', 'image', 'tool_call'];
  if (!KNOWN_ROLES.includes(m.role)) {
    throw new Error(`Session ${sessionId} contains unknown message role "${String(m.role)}" (version incompatible)`);
  }
  if (!Array.isArray(m.content)) {
    throw new Error(`Session ${sessionId} contains a message without content array (version incompatible)`);
  }
  for (const part of m.content as { type: string }[]) {
    if (!KNOWN_PARTS.includes(part.type)) {
      throw new Error(`Session ${sessionId} contains unknown part type "${part.type}" (version incompatible)`);
    }
  }
}

export function syntheticSummaryMessage(summary: string): UserMessage {
  return {
    role: 'user',
    id: `u_summary_${Math.random().toString(36).slice(2, 10)}`,
    timestamp: Date.now(),
    content: [{ type: 'text', text: `[Conversation summary]\n${summary}` }],
    source: 'synthetic',
  };
}

export interface SessionListItem {
  id: string;
  createdAt: number;
  cwd: string;
  model: ModelRef;
  title: string;              // 首条 user 消息截 80 字符
}

/**
 * 列出目录下全部会话:轻量读取——只 parse 到 meta + 首条 user 消息即停
 * (docs/08 §3.2「meta 头 + 首条 user 作标题」;不做全文件校验,长会话不拖慢列表)。
 * 坏文件跳过。新 → 旧。
 */
export function listSessions(dir: string): SessionListItem[] {
  if (!existsSync(dir)) return [];
  const items: SessionListItem[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const id = f.slice(0, -'.jsonl'.length);
    try {
      const raw = readFileSync(path.join(dir, f), 'utf8');
      let meta: MetaRecord | undefined;
      let title: string | undefined;
      for (const line of raw.split('\n')) {
        if (line.length === 0) continue;
        const r = JSON.parse(line) as SessionRecord;
        if (meta === undefined) {
          if (r.type !== 'meta' || r.version !== STORE_VERSION) throw new Error('bad meta');
          meta = r;
          continue;
        }
        if (r.type === 'message' && r.message.role === 'user') {
          title = r.message.content
            .filter((p) => p.type === 'text')
            .map((p) => p.text)
            .join(' ')
            .replaceAll('\n', ' ')
            .slice(0, 80);
          break;
        }
      }
      if (meta === undefined) continue;
      items.push({
        id,
        createdAt: meta.createdAt,
        cwd: meta.cwd,
        model: meta.model,
        title: title !== undefined && title.length > 0 ? title : '(empty)',
      });
    } catch {
      continue;   // 坏文件不阻塞列表
    }
  }
  return items.sort((a, b) => b.createdAt - a.createdAt);
}
