// 事件发射器:单一 promise 链把全部发射串行化(规格见 docs/05-agent-loop.md 第 7 节)。
// listener 逐个 await、订阅序执行——代价是慢 listener 拖慢 loop,换来确定性:
// 事件到达每个 listener 的顺序与产生顺序严格一致;agent_end 的 emit settle 之后
// Agent 才翻回 idle,waitForIdle() resolve 时一切副作用已尘埃落定。

import type { AgentEvent } from '../protocol/index.js';

export type AgentEventListener = (e: AgentEvent) => void | Promise<void>;

export class Emitter {
  private chain: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<AgentEventListener>();

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 全部发射走同一条链:loop 主路径 await emit(...) 获得背压;工具 onUpdate 用
   * void emit(...) 火后不理但仍进链,保证 parallel 工具的 update 不与其他事件交错。
   * listener 异常吞掉并诊断(绝不让 UI bug 打断 loop、绝不在此再 emit error——会递归)。
   */
  emit(e: AgentEvent): Promise<void> {
    this.chain = this.chain.then(async () => {
      for (const l of [...this.listeners]) {     // 快照:emit 期间订阅/退订安全
        try {
          await l(e);
        } catch (err) {
          reportListenerError(err);
        }
      }
    });
    return this.chain;
  }
}

function reportListenerError(err: unknown): void {
  // 诊断通道:listener 的 bug 不能静默,也不能打断 loop
  console.error('[agent] event listener threw (ignored):', err);
}
