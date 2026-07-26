// UsageTracker:token/成本聚合(规格见 docs/08-session-persistence.md §7)。
// 口径铁律:Usage 是 inclusive 总量,session 及以上只做加法;可选字段「出现过才累加,
// 从未出现保持 undefined」——不把「provider 不上报」渲染成 0。

import type { AgentMessage, AssistantMessage, Usage } from '../protocol/index.js';

export interface SessionUsage {
  lastTurn?: Usage;          // 最近一条 assistant 的 usage(per-turn 视图)
  cumulative: Usage;         // 全会话累计:对每条 assistant 消息逐字段求和
  turns: number;             // assistant 消息条数(含 error/aborted)
  contextTokens: number;     // 最近一条成功 assistant 的 input + output(compaction 触发用,M7)
}

export interface ModelPricing {   // 每百万 token 美元价
  inputPer1M: number;
  outputPer1M: number;
  cacheReadPer1M?: number;
  cacheWritePer1M?: number;
}

export class UsageTracker {
  #cumulative: Usage = { input: 0, output: 0 };
  #lastTurn: Usage | undefined;
  #turns = 0;
  #contextTokens = 0;

  constructor(private readonly pricing?: ModelPricing) {}

  /** 恢复会话时从 initialMessages 重建(统计与转录同源,无独立状态文件)。 */
  seed(messages: readonly AgentMessage[]): void {
    for (const m of messages) {
      if (m.role === 'assistant') this.add(m);
    }
  }

  /**
   * message_end(assistant)时调用;error/aborted 也累加(钱已经花了)。返回本条 costUSD。
   * 消息自带 costUSD(session 回填过的落盘消息)优先——恢复时价格变动/缺 pricing 不漂移。
   */
  add(m: AssistantMessage): number | undefined {
    const u = m.usage;
    const cost = u.costUSD ?? this.cost(u);
    this.#turns++;
    this.#lastTurn = u;
    this.#cumulative = {
      input: this.#cumulative.input + u.input,
      output: this.#cumulative.output + u.output,
      ...addOptional(this.#cumulative, u, 'cacheRead'),
      ...addOptional(this.#cumulative, u, 'cacheWrite'),
      ...addOptional(this.#cumulative, u, 'reasoning'),
      ...(cost !== undefined || this.#cumulative.costUSD !== undefined
        ? { costUSD: (this.#cumulative.costUSD ?? 0) + (cost ?? 0) }
        : {}),
    };
    if (m.stopReason !== 'error' && m.stopReason !== 'aborted') {
      this.#contextTokens = u.input + u.output;
    }
    return cost;
  }

  /** inclusive 口径下的换算——session 层唯一做「减法」的地方,且只在此一处(docs/08 §7.3)。 */
  cost(u: Usage): number | undefined {
    if (!this.pricing) return undefined;
    const p = this.pricing;
    const cacheRead = u.cacheRead ?? 0;
    const cacheWrite = u.cacheWrite ?? 0;
    return (
      ((u.input - cacheRead - cacheWrite) * p.inputPer1M) / 1e6 +
      (cacheRead * (p.cacheReadPer1M ?? p.inputPer1M)) / 1e6 +
      (cacheWrite * (p.cacheWritePer1M ?? p.inputPer1M)) / 1e6 +
      (u.output * p.outputPer1M) / 1e6
    );
  }

  snapshot(): SessionUsage {
    return {
      ...(this.#lastTurn !== undefined && { lastTurn: this.#lastTurn }),
      cumulative: { ...this.#cumulative },
      turns: this.#turns,
      contextTokens: this.#contextTokens,
    };
  }
}

function addOptional(
  acc: Usage,
  u: Usage,
  key: 'cacheRead' | 'cacheWrite' | 'reasoning',
): Partial<Usage> {
  const a = acc[key];
  const b = u[key];
  if (a === undefined && b === undefined) return {};
  return { [key]: (a ?? 0) + (b ?? 0) };
}
