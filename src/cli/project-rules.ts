// 项目规则感知：从 cwd 所属仓库根发现分层 AGENTS.md，只增强出站 system prompt。
// edit/write/bash 在真正副作用前复检作用域；规则正文不进入 transcript 或核心协议。

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  statSync,
} from 'node:fs';
import type { BigIntStats } from 'node:fs';
import path from 'node:path';
import type { ToolCallPart, Context } from '../protocol/index.js';
import {
  canonicalizePath,
  isPathInside,
} from '../shared/index.js';
import type { ToolDefinition } from '../tools/types.js';
import { analyzeBashPaths } from './bash-analyze.js';

const MAX_PROJECT_RULE_FILE_BYTES = 32 * 1024;
const MAX_PROJECT_RULE_TOKENS = 16 * 1024;
const MAX_WARNING_HISTORY = 128;
const RULES_FILE_NAME = 'AGENTS.md';
const UTF8_DECODER = new TextDecoder();
const RULE_SEPARATOR = '\n\n';
const RULES_HEADER =
  '# Project rules\n\n' +
  'These repository instructions are ordered from broader to narrower scope. ' +
  'When instructions conflict, the later, narrower scope takes precedence.\n\n';

export interface ProjectRulesOptions {
  cwd: string;
  maxFileBytes?: number;
  maxTotalTokens?: number;
  onWarning?: (message: string) => void;
}

interface RuleCandidate {
  source: string;
  scope: string;
  depth: number;
}

interface LoadedRule extends RuleCandidate {
  block: string;
  tokenUnits: number;
}

interface RuleSnapshot {
  rules: LoadedRule[];
  section: string;
}

interface TargetResolution {
  targets: Set<string>;
  incompleteReasons: string[];
}

type GateDecision = { block: true; reason: string } | { block?: false };
type WarningListener = (message: string) => void;

const GUARDED_TOOL_NAMES = new Set(['edit', 'write', 'bash']);

function tokenUnits(text: string): number {
  let units = 0;
  for (let i = 0; i < text.length; i++) {
    units += text.charCodeAt(i) <= 0x7f ? 1 : 4;
  }
  return units;
}

/** ASCII 沿用 len/4；CJK/emoji 按 UTF-16 code unit 计一 token，避免系统性低估。 */
export function estimateProjectRuleTokens(text: string): number {
  return Math.ceil(tokenUnits(text) / 4);
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function hasRepositoryMarker(directory: string): boolean {
  try {
    lstatSync(path.join(directory, '.git'));
    return true;
  } catch {
    return false;
  }
}

/** 最近的 .git 文件/目录是仓库根；不在 Git 仓库时以物理 cwd 自身为根。 */
function findRepositoryRoot(cwd: string): string {
  let current = cwd;
  for (;;) {
    if (hasRepositoryMarker(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return cwd;
    current = parent;
  }
}

function xmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function scopePattern(scope: string): string {
  return scope.endsWith(path.sep) ? `${scope}**` : `${scope}${path.sep}**`;
}

function renderRuleBlock(rule: RuleCandidate & { content: string }): string {
  return (
    `<project_rule source="${xmlAttribute(rule.source)}" ` +
    `scope="${xmlAttribute(scopePattern(rule.scope))}">\n` +
    `${rule.content.trimEnd()}\n` +
    '</project_rule>'
  );
}

function renderRules(rules: readonly LoadedRule[]): string {
  if (rules.length === 0) return '';
  return RULES_HEADER + rules.map((rule) => rule.block).join(RULE_SEPARATOR);
}

function sameRules(left: readonly LoadedRule[], right: readonly LoadedRule[]): boolean {
  return (
    left.length === right.length &&
    left.every((rule, index) => rule.block === right[index]?.block)
  );
}

function sameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

/**
 * 只持有“上一请求真正注入的规则”和“本轮工具触达、下一请求仍需携带的目录”。
 * targets 不跨未使用 turn 永久累积，避免历史 sibling 抢占预算和 O(N²) 重扫。
 */
export class ProjectRules {
  readonly cwd: string;
  readonly repositoryRoot: string;

  readonly #maxFileBytes: number;
  readonly #maxTotalTokens: number;
  readonly #warningListeners = new Set<WarningListener>();
  readonly #warningHistory: string[] = [];
  readonly #warningKeys = new Set<string>();
  readonly #nextTargets = new Set<string>();
  #lastInjectedRules: LoadedRule[] = [];

  constructor(options: ProjectRulesOptions) {
    this.#maxFileBytes = options.maxFileBytes ?? MAX_PROJECT_RULE_FILE_BYTES;
    this.#maxTotalTokens = options.maxTotalTokens ?? MAX_PROJECT_RULE_TOKENS;
    if (options.onWarning !== undefined) this.#warningListeners.add(options.onWarning);

    try {
      this.cwd = canonicalizePath(options.cwd);
    } catch (error) {
      this.cwd = path.resolve(options.cwd);
      this.#warn(`could not resolve cwd ${this.cwd}: ${String(error)}`);
    }
    this.repositoryRoot = findRepositoryRoot(this.cwd);
  }

  /** CLI-local warning 旁路；replay 让 TUI 初始化失败后的 classic sink 不漏启动期告警。 */
  subscribeWarnings(listener: WarningListener): () => void {
    for (const warning of this.#warningHistory) {
      try {
        listener(warning);
      } catch {
        // 一个前端失败不能影响规则读取或其他前端。
      }
    }
    this.#warningListeners.add(listener);
    return () => {
      this.#warningListeners.delete(listener);
    };
  }

  /** AgentConfig.transformContext 挂载点：只改出站 Context 的 systemPrompt 副本。 */
  async inject(ctx: Context): Promise<Context> {
    // 新模型 turn 重新开放 warning；同一 turn 的 preflight + execute 复检只报告一次。
    this.#warningKeys.clear();
    const targets = new Set([this.cwd, ...this.#nextTargets]);
    const snapshot = await this.#scan(targets);
    this.#lastInjectedRules = snapshot.rules;
    this.#nextTargets.clear();
    if (snapshot.section === '') return ctx;
    return {
      ...ctx,
      systemPrompt:
        ctx.systemPrompt === undefined
          ? snapshot.section
          : `${ctx.systemPrompt}\n\n${snapshot.section}`,
    };
  }

  /**
   * 当前调用的规则链必须与最近出站 prompt 中对应 source 的快照一致；不一致就 block
   * 一轮。bash 同时覆盖 workdir、literal cd/-C、重定向与显式路径参数。
   */
  async beforeToolCall(call: ToolCallPart): Promise<GateDecision> {
    const resolution = this.#targetDirectories(call);
    if (resolution === undefined) return {};
    for (const target of resolution.targets) this.#nextTargets.add(target);

    const snapshot = await this.#scan(resolution.targets);
    const candidateSources = new Set(
      this.#candidates(resolution.targets).map((candidate) => candidate.source),
    );
    const injected = this.#lastInjectedRules.filter((rule) =>
      candidateSources.has(rule.source),
    );
    if (!sameRules(snapshot.rules, injected)) {
      return {
        block: true,
        reason:
          'Project rules for this path were loaded or changed after the last model context was built. ' +
          'They will be present in the next turn; review the scoped <project_rule> blocks, then retry this tool call.',
      };
    }
    if (resolution.incompleteReasons.length > 0) {
      return {
        block: true,
        reason:
          'This bash command contains filesystem paths that project-rule analysis cannot determine safely: ' +
          `${resolution.incompleteReasons.join('; ')}. ` +
          'Use an explicit workdir and literal paths, or split the operation into edit/write calls.',
      };
    }
    return {};
  }

  #warn(message: string): void {
    if (this.#warningKeys.has(message)) return;
    this.#warningKeys.add(message);
    this.#warningHistory.push(message);
    if (this.#warningHistory.length > MAX_WARNING_HISTORY) this.#warningHistory.shift();
    for (const listener of [...this.#warningListeners]) {
      try {
        listener(message);
      } catch {
        // 警告观察者不能把可恢复的规则问题升级成 agent fatal。
      }
    }
  }

  #targetDirectories(call: ToolCallPart): TargetResolution | undefined {
    if (call.name !== 'edit' && call.name !== 'write' && call.name !== 'bash') {
      return undefined;
    }
    const args =
      typeof call.arguments === 'object' && call.arguments !== null
        ? (call.arguments as Record<string, unknown>)
        : {};
    const targets = new Set<string>();
    const incompleteReasons: string[] = [];

    if (call.name === 'bash') {
      const analysis = analyzeBashPaths(
        typeof args.command === 'string' ? args.command : '',
        this.cwd,
        typeof args.workdir === 'string' ? args.workdir : undefined,
      );
      for (const target of analysis.targets) {
        const isDirectory =
          target.kind === 'directory' ||
          (target.kind === 'unknown' && this.#isExistingDirectory(target.path));
        this.#addPathScopes(targets, target.path, isDirectory);
      }
      if (!analysis.complete) incompleteReasons.push(...analysis.reasons);
      return { targets, incompleteReasons };
    }

    if (typeof args.path !== 'string') return { targets, incompleteReasons };
    this.#addPathScopes(targets, path.resolve(this.cwd, args.path), false);
    return { targets, incompleteReasons };
  }

  #isExistingDirectory(targetPath: string): boolean {
    try {
      const physical = canonicalizePath(targetPath);
      return (
        isPathInside(this.repositoryRoot, physical) &&
        statSync(physical).isDirectory()
      );
    } catch {
      return false;
    }
  }

  /**
   * 词法路径逐级解析：遇越界链接时保留链接前的安全祖先规则；文件 leaf 另行解析，
   * 因而 dangling leaf 指向仓库外既会 warning，也不会丢掉其所在目录 AGENTS.md。
   */
  #addPathScopes(
    targets: Set<string>,
    targetPath: string,
    targetIsDirectory: boolean,
  ): void {
    const absolute = path.resolve(targetPath);
    const lexicalDirectory = targetIsDirectory ? absolute : path.dirname(absolute);
    let crossedBoundary = false;

    if (isPathInside(this.repositoryRoot, lexicalDirectory)) {
      const relative = path.relative(this.repositoryRoot, lexicalDirectory);
      const parts = relative === '' ? [] : relative.split(path.sep);
      let lexicalPrefix = this.repositoryRoot;
      targets.add(this.repositoryRoot);
      for (const part of parts) {
        lexicalPrefix = path.join(lexicalPrefix, part);
        try {
          const physicalPrefix = canonicalizePath(lexicalPrefix);
          if (!isPathInside(this.repositoryRoot, physicalPrefix)) {
            crossedBoundary = true;
            this.#warn(
              `project rules stopped at ${lexicalPrefix}: path crosses a symlink outside ` +
                `repository root ${this.repositoryRoot}`,
            );
            break;
          }
          targets.add(physicalPrefix);
        } catch (error) {
          crossedBoundary = true;
          this.#warn(`could not resolve project-rule scope ${lexicalPrefix}: ${String(error)}`);
          break;
        }
      }
    }

    try {
      const physicalTarget = canonicalizePath(absolute);
      if (isPathInside(this.repositoryRoot, physicalTarget)) {
        targets.add(targetIsDirectory ? physicalTarget : path.dirname(physicalTarget));
      } else if (!crossedBoundary && isPathInside(this.repositoryRoot, absolute)) {
        this.#warn(
          `project rules not loaded for physical target ${physicalTarget}: ` +
            `path crosses a symlink outside repository root ${this.repositoryRoot}`,
        );
      }
    } catch (error) {
      if (!crossedBoundary && isPathInside(this.repositoryRoot, absolute)) {
        this.#warn(`could not resolve project-rule target ${absolute}: ${String(error)}`);
      }
    }
  }

  #candidates(targets: Iterable<string>): RuleCandidate[] {
    const bySource = new Map<string, RuleCandidate>();
    for (const target of targets) {
      if (!isPathInside(this.repositoryRoot, target)) continue;
      const relative = path.relative(this.repositoryRoot, target);
      const parts = relative === '' ? [] : relative.split(path.sep);
      let directory = this.repositoryRoot;
      const directories = [directory];
      for (const part of parts) {
        directory = path.join(directory, part);
        directories.push(directory);
      }
      for (let depth = 0; depth < directories.length; depth++) {
        const scope = directories[depth] as string;
        const source = path.join(scope, RULES_FILE_NAME);
        bySource.set(source, { source, scope, depth });
      }
    }
    return [...bySource.values()].sort(
      (a, b) => a.depth - b.depth || a.source.localeCompare(b.source),
    );
  }

  async #load(candidate: RuleCandidate): Promise<LoadedRule | undefined> {
    try {
      lstatSync(candidate.source);
    } catch (error) {
      if (!isMissing(error)) {
        this.#warn(`could not inspect project rules ${candidate.source}: ${String(error)}`);
      }
      return undefined;
    }

    let physicalSource: string;
    try {
      physicalSource = canonicalizePath(candidate.source);
    } catch (error) {
      if (!isMissing(error)) {
        this.#warn(`could not resolve project rules ${candidate.source}: ${String(error)}`);
      }
      return undefined;
    }
    if (!isPathInside(this.repositoryRoot, physicalSource)) {
      this.#warn(
        `ignored project rules ${candidate.source}: symlink resolves outside repository root ` +
          `${this.repositoryRoot}`,
      );
      return undefined;
    }

    let descriptor: number;
    try {
      descriptor = openSync(
        physicalSource,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      this.#warn(`could not open project rules ${candidate.source}: ${String(error)}`);
      return undefined;
    }

    try {
      let before: BigIntStats;
      try {
        before = fstatSync(descriptor, { bigint: true });
      } catch (error) {
        this.#warn(`could not inspect project rules ${candidate.source}: ${String(error)}`);
        return undefined;
      }
      if (!before.isFile()) {
        this.#warn(`ignored project rules ${candidate.source}: not a regular file`);
        return undefined;
      }
      if (before.size > BigInt(this.#maxFileBytes)) {
        this.#warn(
          `ignored project rules ${candidate.source}: ${before.size} bytes exceeds per-file limit ` +
            `${this.#maxFileBytes}`,
        );
        return undefined;
      }

      let current: BigIntStats;
      try {
        const verifiedSource = canonicalizePath(candidate.source);
        if (!isPathInside(this.repositoryRoot, verifiedSource)) {
          this.#warn(
            `ignored project rules ${candidate.source}: path changed to outside repository root while reading`,
          );
          return undefined;
        }
        current = statSync(verifiedSource, { bigint: true });
      } catch (error) {
        this.#warn(`could not verify project rules ${candidate.source}: ${String(error)}`);
        return undefined;
      }
      if (before.dev !== current.dev || before.ino !== current.ino) {
        this.#warn(`ignored project rules ${candidate.source}: file changed while opening`);
        return undefined;
      }

      let bytes: Uint8Array;
      try {
        bytes = await Bun.file(descriptor).slice(0, this.#maxFileBytes + 1).bytes();
      } catch (error) {
        this.#warn(`could not read project rules ${candidate.source}: ${String(error)}`);
        return undefined;
      }
      let after: BigIntStats;
      try {
        after = fstatSync(descriptor, { bigint: true });
      } catch (error) {
        this.#warn(`could not verify project rules ${candidate.source}: ${String(error)}`);
        return undefined;
      }
      if (!sameFileSnapshot(before, after)) {
        this.#warn(`ignored project rules ${candidate.source}: file changed while reading`);
        return undefined;
      }
      if (bytes.byteLength > this.#maxFileBytes) {
        this.#warn(
          `ignored project rules ${candidate.source}: ${bytes.byteLength} bytes exceeds per-file limit ` +
            `${this.#maxFileBytes}`,
        );
        return undefined;
      }

      const content = UTF8_DECODER.decode(bytes);
      if (content.trim().length === 0) return undefined;
      const block = renderRuleBlock({ ...candidate, content });
      return {
        ...candidate,
        block,
        tokenUnits: tokenUnits(block),
      };
    } finally {
      try {
        closeSync(descriptor);
      } catch (error) {
        this.#warn(`could not close project rules ${candidate.source}: ${String(error)}`);
      }
    }
  }

  async #scan(targets: Iterable<string>): Promise<RuleSnapshot> {
    const loaded: LoadedRule[] = [];
    for (const candidate of this.#candidates(targets)) {
      const rule = await this.#load(candidate);
      if (rule !== undefined) loaded.push(rule);
    }

    let usedUnits = 0;
    const selected = new Set<string>();
    const priority = [...loaded].sort(
      (a, b) => b.depth - a.depth || a.source.localeCompare(b.source),
    );
    for (const rule of priority) {
      const nextUnits =
        (selected.size === 0 ? tokenUnits(RULES_HEADER) : usedUnits + tokenUnits(RULE_SEPARATOR)) +
        rule.tokenUnits;
      if (Math.ceil(nextUnits / 4) > this.#maxTotalTokens) {
        this.#warn(
          `ignored project rules ${rule.source}: rendered section would exceed ` +
            `${this.#maxTotalTokens}-token estimate`,
        );
        continue;
      }
      usedUnits = nextUnits;
      selected.add(rule.source);
    }
    const rules = loaded.filter((rule) => selected.has(rule.source));
    return { rules, section: renderRules(rules) };
  }
}

/**
 * batch preflight 早于整批 execute；前一命令可能改写 AGENTS.md。三个副作用工具在真正
 * execute 边界复检一次，仍只通过普通工具失败回喂，不新增 agent/protocol 契约。
 */
export function guardProjectRuleExecutions(
  tools: readonly ToolDefinition[],
  rules: ProjectRules,
): ToolDefinition[] {
  return tools.map((tool) => {
    if (!GUARDED_TOOL_NAMES.has(tool.name)) return tool;
    return {
      ...tool,
      async execute(call, ctx) {
        const rawArgs: unknown = call.args;
        const args =
          typeof rawArgs === 'object' && rawArgs !== null && !Array.isArray(rawArgs)
            ? (rawArgs as Record<string, unknown>)
            : {};
        const decision = await rules.beforeToolCall({
          type: 'tool_call',
          id: call.id,
          name: tool.name,
          arguments: args,
        });
        if (decision.block) throw new Error(decision.reason);
        return tool.execute(call, ctx);
      },
    };
  });
}
