// 审批策略层:beforeToolCall 钩子的完整实现(规格见 docs/07-tools.md §3、docs/05-agent-loop.md §4)。
// 权限不侵入工具本体也不侵入 loop:kind 直通 / doom-loop / bash 结构分析 / external-directory
// 全部收敛在这一个钩子里;决策委托 ApprovalBroker,持久化 allow_always 规则到 rulesFile。
// 时序纪律(风险 R7):abort 决议的工具结果必须是中断形态('[Tool execution was interrupted]'),
// 绝不以「拒绝」形态漏给模型;onAbort() 的调用时机必须在 session.abort() 之后(调用方纪律)。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentConfig, ApprovalBroker } from '../agent/index.js';
import { INTERRUPTED_RESULT_TEXT } from '../agent/index.js';
import type { ToolCallPart } from '../protocol/index.js';
import {
  canonicalizePath,
  isPathInside,
  resolveToolWorkdir,
  runtimeHomeDir,
} from '../shared/index.js';
import type { ToolDefinition } from '../tools/types.js';
import { analyzeBashCommand, analyzeBashPaths } from './bash-analyze.js';

export interface ApprovalPolicyOptions {
  broker: ApprovalBroker;
  projectRoot: string;
  /** 工具表:beforeToolCall 只拿到 ToolCallPart,kind 分级从这里查(缺省视为 'execute')。 */
  tools: ToolDefinition[];
  /** allow_always 规则的持久化位置,默认 ~/.coda/approvals.json(JSON string[])。 */
  rulesFile?: string;
  /** abort 决议时通知宿主中止任务(CLI 侧接 session.abort())。 */
  requestAbort: () => void;
}

export interface ApprovalPolicy {
  beforeToolCall: NonNullable<AgentConfig['beforeToolCall']>;
  /** abort 收尾:以 'abort' 决议全部 pending 审批。必须在任务已观察到 cancellation 之后调(R7)。 */
  onAbort(): void;
}

/** 同 hash 连续出现 3 次 → 强制审批(docs/07 §3.4)。 */
export const DOOM_LOOP_THRESHOLD = 3;
export const DOOM_LOOP_NOTE = 'This exact call has been attempted 3 times in a row — possible loop.';

export function defaultRulesFile(): string {
  return path.join(runtimeHomeDir(), '.coda', 'approvals.json');
}

/**
 * 读取持久化规则(缺文件/坏 JSON → 空:损坏的规则文件不该让 CLI 起不来,
 * 代价只是多问几次)。也可供集成方在构造 ApprovalBroker 时作 initialRules 注入。
 */
export function loadPersistedRules(rulesFile: string): string[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(rulesFile, 'utf8'));
    return Array.isArray(raw) ? raw.filter((r): r is string => typeof r === 'string') : [];
  } catch {
    return [];
  }
}

/** 键序无关的稳定序列化:doom-loop 的 hash 基底(docs/07 §3.4 的 stableStringify)。 */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const body = Object.keys(record)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`)
    .join(',');
  return `{${body}}`;
}

/** deny 的回喂文案形态(docs/07 §3.2):引导模型换路,不终止任务。 */
function deniedReason(detail: string): string {
  return `User denied permission: ${detail}. Do not retry the same call; ask the user or take a different approach.`;
}

export function createApprovalPolicy(opts: ApprovalPolicyOptions): ApprovalPolicy {
  const { broker, requestAbort } = opts;
  const projectRoot = path.resolve(opts.projectRoot);
  // 比较基底同样过 realpath:项目根本身可能在软链下(macOS 的 /var→/private/var),
  // 只解引用目标却不解引用根会把根内一切误判为根外。
  const projectRootReal = canonicalizePath(projectRoot);
  const rulesFile = opts.rulesFile ?? defaultRulesFile();
  // ApprovalBroker 的 alwaysRules 构造后不可注入,持久规则由策略层持有;
  // 直通判定取 persisted ∪ broker.rules 并集(并集 ⊇ broker 内部检查,行为一致)。
  const persisted = new Set(loadPersistedRules(rulesFile));
  const kinds = new Map(opts.tools.map((t) => [t.name, t.kind ?? 'execute']));

  // doom-loop 计数器:per policy 实例;任何不同调用清零(docs/07 §3.4)
  let lastHash: string | undefined;
  let repeatCount = 0;

  const persist = (): void => {
    const all = [...new Set([...persisted, ...broker.rules])].sort();
    mkdirSync(path.dirname(rulesFile), { recursive: true });
    writeFileSync(rulesFile, `${JSON.stringify(all, null, 2)}\n`);
  };

  const isInsideRoot = (p: string): boolean => {
    // 先 realpath 解引用再做词法 relative:堵住「根内软链指向根外」的绕过(docs/07 §3.3)。
    try {
      return isPathInside(projectRootReal, canonicalizePath(path.resolve(projectRoot, p)));
    } catch {
      return false;
    }
  };

  /** 审批公共路径:并集直通 → broker.request → 四值决议映射。 */
  const requestApproval = async (
    call: ToolCallPart,
    description: string,
    patterns: string[],
    forceConfirm: boolean,
  ): Promise<{ block: true; reason: string } | { block?: false }> => {
    if (!forceConfirm && patterns.length > 0) {
      const known = new Set([...persisted, ...broker.rules]);
      if (patterns.every((p) => known.has(p))) return {};
    }
    const outcome = await broker.request({ toolCallId: call.id, description, patterns }, { forceConfirm });
    switch (outcome.decision) {
      case 'allow_always':
        // broker 已记忆;forceConfirm 场景 broker 自行降级为 allow_once,不会走到这里
        persist();
        return {};
      case 'allow_once':
        return {};
      case 'abort':
        // R7:先请求任务中止(工具/流观察到 cancellation),结果文案必须是中断形态而非拒绝
        requestAbort();
        return { block: true, reason: INTERRUPTED_RESULT_TEXT };
      case 'deny':
        return { block: true, reason: deniedReason(`the user rejected this ${call.name} call in the approval prompt`) };
    }
  };

  const beforeToolCall: NonNullable<AgentConfig['beforeToolCall']> = async (call) => {
    // ① doom-loop 计数:命中阈值 → 强制审批,绕过 kind 直通与 alwaysRules
    const hash = call.name + stableStringify(call.arguments);
    if (hash === lastHash) repeatCount += 1;
    else { lastHash = hash; repeatCount = 1; }
    const doomLoop = repeatCount >= DOOM_LOOP_THRESHOLD;
    const withLoopNote = (d: string): string => (doomLoop ? `${d}\n${DOOM_LOOP_NOTE}` : d);

    // ② kind 直通:read/search/plan 默认不产生 approval(docs/07 §3.1)
    const kind = kinds.get(call.name) ?? 'execute';
    if (!doomLoop && (kind === 'read' || kind === 'search' || kind === 'plan')) return {};

    // ③ bash:denylist 先行 → 结构分析产出 patterns / forceConfirm
    if (call.name === 'bash') {
      const args = call.arguments as { command?: unknown; workdir?: unknown; description?: unknown };
      const command = typeof args.command === 'string' ? args.command : String(args.command ?? '');
      const analysis = analyzeBashCommand(command);
      if (analysis.denied) return { block: true, reason: deniedReason(analysis.reason) };
      // 路径约束(docs/07 §3.3):workdir 与共享 path analyzer 产出的静态目标落项目根外
      // → external-directory 强制确认；不完整分析同样禁止 allow_always。
      const workdir =
        typeof args.workdir === 'string'
          ? resolveToolWorkdir(projectRoot, args.workdir)
          : projectRoot;
      const pathAnalysis = analyzeBashPaths(
        command,
        projectRoot,
        typeof args.workdir === 'string' ? args.workdir : undefined,
      );
      const external = !isInsideRoot(workdir) ||
        pathAnalysis.targets.some((target) => !isInsideRoot(target.path));
      const modelNote = typeof args.description === 'string' && args.description !== '' ? ` — ${args.description}` : '';
      return requestApproval(
        call,
        withLoopNote(
          `bash: ${command}${modelNote}` +
          `${external ? ' (accesses paths outside project root)' : ''}` +
          `${pathAnalysis.complete ? '' : ' (contains paths that could not be fully analyzed)'}`,
        ),
        analysis.patterns,
        analysis.forceConfirm || !pathAnalysis.complete || external || doomLoop,
      );
    }

    // ④ edit/write:项目根内整体放行的泛化 pattern;路径越出 projectRoot → external-directory 强制确认
    if (kind === 'edit') {
      const rawPath = (call.arguments as { path?: unknown }).path;
      const target = typeof rawPath === 'string' ? path.resolve(projectRoot, rawPath) : undefined;
      const inside = target !== undefined && isInsideRoot(target);
      return requestApproval(
        call,
        withLoopNote(`${call.name} ${target ?? stableStringify(call.arguments)}${inside ? '' : ' (outside project root)'}`),
        [`${call.name}:${projectRoot}/**`],
        !inside || doomLoop,
      );
    }

    // ⑤ 其余(非 bash 的 execute、doom-loop 触发的 read/search/plan):无泛化形态,逐次确认
    return requestApproval(call, withLoopNote(`${call.name} ${stableStringify(call.arguments)}`), [], doomLoop);
  };

  return { beforeToolCall, onAbort: () => broker.abortAll() };
}
