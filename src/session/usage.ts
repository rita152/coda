// Canonical thread-checkpoint usage projection. Usage uses inclusive totals and only accumulates;
// optional fields remain undefined until a provider reports them instead of rendering absence as 0.

import type { AgentMessage, AssistantMessage, ThreadUsage, Usage } from '../protocol/index.js';

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

  /** 仅供从消息导入新 transcript 时计算初始 usage；恢复必须使用 canonical checkpoint。 */
  seed(messages: readonly AgentMessage[]): void {
    for (const m of messages) {
      if (m.role === 'assistant') this.add(m);
    }
  }

  /** 原样恢复 journal 已提交的 usage 投影，避免从 transcript 建立第二套恢复事实。 */
  restore(usage: Readonly<ThreadUsage>): void {
    this.#cumulative = { ...usage.cumulative };
    this.#lastTurn = usage.lastTurn === undefined ? undefined : { ...usage.lastTurn };
    this.#turns = usage.turns;
    this.#contextTokens = usage.contextTokens;
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

  /** Inclusive pricing conversion; cache tokens are subtracted only at this conversion boundary. */
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

  snapshot(): ThreadUsage {
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
