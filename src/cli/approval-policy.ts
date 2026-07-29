// 审批策略层:beforeToolCall 钩子的完整实现(规格见 docs/07-tools.md §3、docs/05-agent-loop.md §4)。
// 权限不侵入工具本体也不侵入 loop:kind 直通 / doom-loop / bash 结构分析 / external-directory
// 全部收敛在这一个钩子里;决策委托 ApprovalBroker,持久化 allow_always 规则到 rulesFile。
// 时序纪律(风险 R7):abort 决议的工具结果必须是中断形态('[Tool execution was interrupted]'),
// 绝不以「拒绝」形态漏给模型;onAbort() 的调用时机必须在 session.abort() 之后(调用方纪律)。

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentConfig, ApprovalBroker } from '../agent/index.js';
import { INTERRUPTED_RESULT_TEXT } from '../agent/index.js';
import type { ToolCallPart } from '../protocol/index.js';
import { runtimeHomeDir } from '../shared/index.js';
import type { ToolDefinition } from '../tools/types.js';
import { analyzeBashCommand } from './bash-analyze.js';

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

/**
 * realpath 尽力解引用(docs/07 §3.3「resolve 后」):纯词法 path.relative 会被项目根内
 * 指向根外的符号链接绕过(link→/etc 时 edit link/passwd 词法判 inside)。此处对路径成分
 * 做 realpath 解引用后再交给 isInsideRoot。不存在的路径(新建文件)不能 throw:逐级向上
 * 取最近存在祖先的 realpath,再拼回未解引用的剩余成分。macOS 上 /var→/private/var 之类
 * 的根本身软链也一并归一(projectRoot 与目标都过这层,比较基底一致)。
 */
function realpathBestEffort(abs: string): string {
  const trailing: string[] = [];
  let current = abs;
  for (;;) {
    try {
      const real = realpathSync(current);
      return trailing.length === 0 ? real : path.join(real, ...trailing);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.join(current, ...trailing); // 触底(理论不可达)
      trailing.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** 重定向进这些丢弃/终端设备的目标即使落根外也不升级(与 bash-analyze 的 SYSTEM_PATH_EXEMPT 同义)。 */
const DISCARD_TARGETS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty', '/dev/zero']);

/**
 * 从 bash command 提取需做 external-directory 判定的路径候选(docs/07 §3.3「解析出的路径参数」)。
 * 与 bash-analyze 解耦——策略层自带正则兜底,不依赖其导出:
 *   ① 重定向目标:> >> 2> &> 等操作符后的目标 token(2>&1 之类 fd 复制不算路径);
 *   ② 位置路径参数:含 '/' 或以 '~' 起头的 token(cp a ../../../etc/x 的目的地也要盯)。
 * 剥引号、~ 展开为 home;丢弃目标(/dev/null 等)剔除。产出「疑似文件系统路径」的 token 交给
 * isInsideRoot,宁多勿漏(根内 token resolve 后仍 inside,不会误升级;根外才触发确认)。
 */
function extractPathCandidates(command: string): string[] {
  const raws: string[] = [];
  const unquote = (t: string): string =>
    t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
      ? t.slice(1, -1)
      : t;

  // ① 重定向目标:操作符(可选前导 fd 数字)= > / >> / &> / &>>;其后目标不得以 & 起头(fd 复制,如 2>&1)
  const redirectRe = /(?:\d*>>?|&>>?)\s*(?!&)("[^"]*"|'[^']*'|[^\s;|&<>()]+)/g;
  for (let m = redirectRe.exec(command); m !== null; m = redirectRe.exec(command)) {
    raws.push(unquote(m[1] as string));
  }

  // ② 位置路径参数:粗按空白拆,剥可能粘连的前导重定向操作符,取路径样 token
  for (const raw of command.split(/\s+/)) {
    if (raw === '') continue;
    const tok = unquote(raw.replace(/^(?:\d*>>?|&>>?|<)/, ''));
    if (tok !== '' && (tok.includes('/') || tok.startsWith('~'))) raws.push(tok);
  }

  // ~ 展开为 home(path.resolve 不认 ~,不展开会把 ~/.zshrc 误判为根内);再剔除丢弃目标
  return raws
    .map((t) => (t === '~' || t.startsWith('~/') ? path.join(runtimeHomeDir(), t.slice(1)) : t))
    .filter((t) => !DISCARD_TARGETS.has(t));
}

export function createApprovalPolicy(opts: ApprovalPolicyOptions): ApprovalPolicy {
  const { broker, requestAbort } = opts;
  const projectRoot = path.resolve(opts.projectRoot);
  // 比较基底同样过 realpath:项目根本身可能在软链下(macOS 的 /var→/private/var),
  // 只解引用目标却不解引用根会把根内一切误判为根外。
  const projectRootReal = realpathBestEffort(projectRoot);
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
    const real = realpathBestEffort(path.resolve(projectRoot, p));
    const rel = path.relative(projectRootReal, real);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
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
      // 路径约束(docs/07 §3.3):workdir 与命令里解析出的路径参数 resolve 后落项目根外
      // → external-directory 强制确认(不可 allow_always 泛化)。命令的相对路径按 workdir(缺省
      // 项目根)为 cwd 解析;analyzeBashCommand 只查 workdir 与系统前缀,漏掉 echo x >> ~/.zshrc /
      // cp a ../../../etc/x 这类根外目标,故在策略层用 extractPathCandidates 兜住。
      const externalWorkdir = typeof args.workdir === 'string' && !isInsideRoot(args.workdir);
      const cwd = typeof args.workdir === 'string' ? path.resolve(projectRoot, args.workdir) : projectRoot;
      const externalPath = extractPathCandidates(command).some((t) => !isInsideRoot(path.resolve(cwd, t)));
      const external = externalWorkdir || externalPath;
      const modelNote = typeof args.description === 'string' && args.description !== '' ? ` — ${args.description}` : '';
      return requestApproval(
        call,
        withLoopNote(`bash: ${command}${modelNote}${external ? ' (accesses paths outside project root)' : ''}`),
        analysis.patterns,
        analysis.forceConfirm || external || doomLoop,
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
