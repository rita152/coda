// steering / follow-up 双队列的载体(语义规格见 docs/06-steering-following.md)。
// 入队/drain 与 runLoop 的注入点遵循 docs/05 Agent Loop 与 docs/06 Steering / Follow-up。
// 队列元素是完整 UserMessage(id 已定):queue_update 快照与断言一律用 id,
// 不用文本匹配(pi 的教训:文本 indexOf 匹配会误伤重复文本)。

import type { QueuedMessage, UserMessage } from '../protocol/index.js';

export type DrainMode = 'one-at-a-time' | 'all';

export class PendingMessageQueue {
  private items: UserMessage[] = [];

  constructor(private readonly kind: 'steering' | 'follow_up') {}

  enqueue(message: UserMessage): void {
    this.items.push(message);
  }

  /** one-at-a-time 取最老一条,all 取空整个队列(docs/06 的两种 drain 模式)。 */
  drain(mode: DrainMode): UserMessage[] {
    if (this.items.length === 0) return [];
    if (mode === 'all') {
      const all = this.items;
      this.items = [];
      return all;
    }
    return [this.items.shift() as UserMessage];
  }

  get size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items = [];
  }

  /** queue_update payload snapshot used by the Runtime event projection. */
  snapshot(): QueuedMessage[] {
    return this.items.map((m) => ({
      id: m.id,
      text: m.content
        .map((p) => (p.type === 'text' ? p.text : `[${p.type}]`))
        .join(''),
      kind: this.kind === 'steering' ? 'steering' : 'follow_up',
    }));
  }
}
