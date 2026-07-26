// ApprovalBroker:审批的 resolver 注册表(规格见 docs/07-tools.md §3.1/§3.2)。
// 权限不侵入工具本体:整个系统挂在 beforeToolCall 钩子上,loop 对审批零感知。
// 时序纪律(codex 教训,风险 R7):abort 时先让任务观察到 cancellation,再以 abort
// 决议清空 pending——顺序反了,悬着的审批会以「拒绝」形态先漏给模型。

import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '../protocol/index.js';

export type ApprovalDecision = 'allow_once' | 'allow_always' | 'deny' | 'abort';

export interface ApprovalRequest {
  toolCallId: string;
  description: string;      // 面向人的一行描述(bash 的 command+描述、edit 的 diff 摘要)
  patterns: string[];       // allow_always 命中/记忆的规则 pattern(如 'bash:npm *')
}

export interface ApprovalOutcome {
  decision: ApprovalDecision;
  /** allow_always 时新记入的 patterns(调用方负责持久化)。 */
  learned?: string[];
}

export class ApprovalBroker {
  readonly #pending = new Map<string, (d: ApprovalDecision) => void>();
  readonly #alwaysRules: Set<string>;
  readonly #emit: (e: AgentEvent) => void;

  constructor(emit: (e: AgentEvent) => void, initialRules: Iterable<string> = []) {
    this.#emit = emit;
    this.#alwaysRules = new Set(initialRules);
  }

  get rules(): readonly string[] {
    return [...this.#alwaysRules];
  }

  /**
   * 发起审批:patterns 全部命中 alwaysRules → 直接放行;否则发 approval_request 事件,
   * 挂起等 resolve()。forceConfirm(doom-loop / $() 升级)绕过 alwaysRules 直通。
   */
  async request(req: ApprovalRequest, opts?: { forceConfirm?: boolean }): Promise<ApprovalOutcome> {
    if (
      opts?.forceConfirm !== true &&
      req.patterns.length > 0 &&
      req.patterns.every((p) => this.#alwaysRules.has(p))
    ) {
      return { decision: 'allow_once' };
    }
    const approvalId = `ap_${randomUUID().slice(0, 8)}`;
    const decision = await new Promise<ApprovalDecision>((resolve) => {
      this.#pending.set(approvalId, resolve);
      this.#emit({ type: 'approval_request', approvalId, toolCallId: req.toolCallId, description: req.description });
    });
    if (decision === 'allow_always') {
      // $() 类强制确认不允许 always 泛化(docs/07 §3.3):forceConfirm 时不记忆
      if (opts?.forceConfirm !== true) {
        for (const p of req.patterns) this.#alwaysRules.add(p);
        return { decision, learned: req.patterns };
      }
      return { decision: 'allow_once' };
    }
    return { decision };
  }

  /** CLI/headless 客户端回调。未知 id 忽略(重复决议/过期)。 */
  resolve(approvalId: string, decision: ApprovalDecision): void {
    const resolver = this.#pending.get(approvalId);
    if (resolver === undefined) return;
    this.#pending.delete(approvalId);
    resolver(decision);
  }

  /**
   * abort 收尾:以 'abort' 决议所有 pending,不留悬挂 Promise(docs/07 §4)。
   * 调用时机必须在任务已观察到 cancellation 之后(调用方纪律,风险 R7)。
   */
  abortAll(): void {
    for (const [id, resolver] of [...this.#pending]) {
      this.#pending.delete(id);
      resolver('abort');
    }
  }

  get pendingCount(): number {
    return this.#pending.size;
  }
}
