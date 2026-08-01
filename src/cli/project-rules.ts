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
import type {
  CapabilityInvocationAnalysis,
  RuleFreshnessPort,
  RuleSnapshot as CapabilityRuleSnapshot,
  RuleSnapshotBudget,
  RuleSnapshotCaptureResult,
  RuleSnapshotDiagnostic,
  RuleSnapshotProvider,
  TurnPolicyContext,
} from '../capabilities/index.js';
import {
  canonicalJsonSha256,
  sha256Hex,
  strictJsonSnapshot,
} from '../protocol/index.js';
import type { ToolCallPart, Context } from '../protocol/index.js';
import {
  canonicalizePath,
  isPathInside,
} from '../shared/index.js';
import type { ToolDefinition } from '../tools/types.js';
import {
  LEGACY_BASH_ANALYSIS_VERSION,
  analyzeBashPaths,
} from './bash-analyze.js';
import type { LegacyBashFilesystemTarget } from './bash-analyze.js';
import { LEGACY_FILESYSTEM_ANALYSIS_VERSION } from '../integrations/legacy-coding-tools/resource-resolvers.js';

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
  content: string;
  contentDigest: string;
  byteLength: number;
  tokenUnits: number;
}

interface LegacyRuleSnapshot {
  rules: LoadedRule[];
  section: string;
}

interface TargetResolution {
  targets: Set<string>;
  incompleteReasons: string[];
}

interface CapabilityRuleScan {
  rules: LoadedRule[];
  diagnostics: readonly Readonly<RuleSnapshotDiagnostic>[];
}

interface CapabilityTargetResolution extends TargetResolution {
  leafScopes: Set<string>;
}

type GateDecision = { block: true; reason: string } | { block?: false };
type WarningListener = (message: string) => void;
type DiagnosticCollector = (diagnostic: Readonly<RuleSnapshotDiagnostic>) => void;

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
export class ProjectRules implements RuleSnapshotProvider, RuleFreshnessPort {
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

  /** Registry path: capture one detached rule snapshot from explicit turn hints and budget. */
  async capture(
    input: Parameters<RuleSnapshotProvider['capture']>[0],
  ): Promise<RuleSnapshotCaptureResult> {
    this.#warningKeys.clear();
    try {
      const context = snapshotTurnContext(input.context);
      this.#assertContextCwd(context);
      const budget = snapshotRuleBudget(input.budget);
      const knownResourceScopes = this.#normalizeKnownScopes(input.knownResourceScopes);
      const scan = await this.#scanCapability(
        new Set([this.cwd, ...knownResourceScopes]),
        budget,
      );
      const files = snapshotJson(scan.rules.map((rule) => ({
        path: rule.source,
        scope: scopePattern(rule.scope),
        contentDigest: rule.contentDigest,
        content: rule.content,
      }))) as CapabilityRuleSnapshot['files'];
      const discovery = snapshotJson({
        knownResourceScopes,
        budget,
        diagnostics: normalizedDiagnostics(scan.diagnostics),
      }) as CapabilityRuleSnapshot['discovery'];
      const snapshot = snapshotJson({
        revision: capabilityRuleRevision(discovery, files),
        owner: context,
        discovery,
        files,
      }) as Readonly<CapabilityRuleSnapshot>;
      return Object.freeze({ ok: true, snapshot });
    } catch (error) {
      return Object.freeze({
        ok: false,
        code: 'invalid_rule_snapshot',
        message: `Could not capture project rules: ${errorMessage(error)}`,
      });
    }
  }

  /** Registry path: compare only the frozen snapshot/resource view with current rule fingerprints. */
  async check(
    input: Parameters<RuleFreshnessPort['check']>[0],
  ): ReturnType<RuleFreshnessPort['check']> {
    try {
      const context = snapshotInvocationContext(input.context);
      const snapshot = snapshotCapabilityRules(input.snapshot);
      if (!sameTurnContext(snapshot.owner, context)) {
        return staleRules('Rule snapshot owner does not match the invocation context');
      }
      this.#assertContextCwd(snapshot.owner);
      if (snapshot.revision !== capabilityRuleRevision(snapshot.discovery, snapshot.files)) {
        return staleRules('Rule snapshot revision does not match its frozen material');
      }
      if (!GUARDED_TOOL_NAMES.has(context.capabilityId)) return FRESH_RULES;

      const analysis = snapshotCapabilityAnalysis(input.analysis);
      if (analysis.resourceCoverage.kind === 'incomplete') {
        return staleRules(
          'This capability contains filesystem paths that project-rule analysis cannot determine safely: ' +
            `${analysis.resourceCoverage.reasons.join('; ')}. ` +
            'Use an explicit workdir and literal paths.',
        );
      }

      const resolution = this.#resourceTargetDirectories(
        context.capabilityId,
        input.resources,
        analysis,
      );
      if (resolution.incompleteReasons.length > 0) {
        return staleRules(
          'This capability contains filesystem paths that project-rule analysis cannot determine safely: ' +
            `${resolution.incompleteReasons.join('; ')}. Use an explicit workdir and literal paths.`,
        );
      }
      if (resolution.targets.size === 0) return FRESH_RULES;

      const relevantSources = new Set(
        this.#candidates(resolution.targets).map((candidate) => candidate.source),
      );
      const frozenBudgetOmissions = new Set(snapshot.discovery.diagnostics
        .filter((diagnostic) => diagnostic.path !== undefined
          && relevantSources.has(diagnostic.path)
          && isSelectionBudgetDiagnostic(diagnostic))
        .map((diagnostic) => diagnostic.path as string));
      if (frozenBudgetOmissions.size > 0) {
        return staleRules(
          'Project rules for this resource were omitted from the frozen prompt by its rule budget. ' +
            'The capability cannot run without reviewing every applicable rule.',
        );
      }

      const current = await this.#scanCapability(resolution.targets, snapshot.discovery.budget);
      const frozenFiles = snapshot.files.filter((file) => relevantSources.has(file.path));
      const currentFiles = current.rules.map((rule) => ({
        path: rule.source,
        scope: scopePattern(rule.scope),
        contentDigest: rule.contentDigest,
        content: rule.content,
      }));

      const coveredSources = new Set(this.#candidates([
        this.cwd,
        ...snapshot.discovery.knownResourceScopes,
      ]).map((candidate) => candidate.source));
      const uncoveredCurrentSources = new Set(
        currentFiles
          .filter((file) => !coveredSources.has(file.path))
          .map((file) => file.path),
      );
      const currentBudgetOmissions = new Set(current.diagnostics
        .filter((diagnostic) => diagnostic.path !== undefined
          && relevantSources.has(diagnostic.path)
          && isSelectionBudgetDiagnostic(diagnostic))
        .map((diagnostic) => diagnostic.path as string));
      if (uncoveredCurrentSources.size > 0) {
        const missingScopes = this.#missingScopesForSources(resolution, uncoveredCurrentSources);
        if (missingScopes.length > 0) return missingScopeDecision(missingScopes);
      }
      if (currentBudgetOmissions.size > 0) {
        const uncoveredBudgetSources = new Set([...currentBudgetOmissions]
          .filter((source) => !coveredSources.has(source)));
        if (uncoveredBudgetSources.size > 0) {
          const missingScopes = this.#missingScopesForSources(
            resolution,
            uncoveredBudgetSources,
          );
          if (missingScopes.length > 0) return missingScopeDecision(missingScopes);
        }
        return staleRules(
          'Applicable project rules are not representable within the frozen rule budget. ' +
            'The capability cannot run without reviewing every applicable rule.',
        );
      }
      if (sameCapabilityFiles(frozenFiles, currentFiles)) return FRESH_RULES;
      return staleRules(
        'Project rules changed after the frozen turn snapshot was captured. ' +
          'They will be refreshed on the next turn; review them before retrying.',
      );
    } catch (error) {
      return staleRules(`Project-rule freshness check failed closed: ${errorMessage(error)}`);
    }
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

  #diagnose(
    collect: DiagnosticCollector | undefined,
    code: RuleSnapshotDiagnostic['code'],
    message: string,
    diagnosticPath?: string,
  ): void {
    this.#warn(message);
    collect?.(snapshotJson({
      code,
      ...(diagnosticPath !== undefined && { path: diagnosticPath }),
      message,
    }));
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

  #assertContextCwd(context: Readonly<TurnPolicyContext>): void {
    if (!path.isAbsolute(context.cwd) || canonicalizePath(context.cwd) !== this.cwd) {
      throw new TypeError('Turn context cwd does not match the configured project-rule cwd');
    }
  }

  #normalizeKnownScopes(scopes: readonly string[]): readonly string[] {
    if (!Array.isArray(scopes)) throw new TypeError('knownResourceScopes must be an array');
    const normalized: string[] = [];
    for (const scope of scopes) {
      if (typeof scope !== 'string' || scope.length === 0 || !path.isAbsolute(scope)) {
        throw new TypeError('knownResourceScopes must contain non-empty absolute paths');
      }
      const canonical = canonicalizePath(scope);
      if (!isPathInside(this.repositoryRoot, canonical)) {
        throw new TypeError(`Known project-rule scope is outside the repository root: ${canonical}`);
      }
      normalized.push(canonical);
    }
    return normalizedPaths(normalized);
  }

  #resourceTargetDirectories(
    capabilityId: string,
    resources: Parameters<RuleFreshnessPort['check']>[0]['resources'],
    analysis: Readonly<CapabilityInvocationAnalysis>,
  ): CapabilityTargetResolution {
    const targets = new Set<string>();
    const leafScopes = new Set<string>();
    const incompleteReasons: string[] = [];
    const filesystem = resources.filter((resource) => resource.resourceType === 'filesystem');
    const frozenKinds = capabilityId === 'bash'
      ? frozenBashFilesystemTargetKinds(analysis.attributes)
      : frozenFilesystemTargetKinds(analysis.attributes);
    const resourceTargets = new Set(filesystem.map((resource) => resource.canonicalTarget));
    if (frozenKinds.size !== resourceTargets.size
      || [...frozenKinds.keys()].some((target) => !resourceTargets.has(target))) {
      incompleteReasons.push('frozen filesystem target facts do not match capability resources');
      return { targets, leafScopes, incompleteReasons };
    }

    if (capabilityId === 'bash') {
      const workdir = filesystem.find((resource) => resource.selectorId === 'workdir')?.canonicalTarget;
      if (workdir === undefined
        || !path.isAbsolute(workdir)
        || frozenKinds.get(workdir) === 'file') {
        incompleteReasons.push('bash workdir resource is missing or not canonical');
        return { targets, leafScopes, incompleteReasons };
      }
      for (const resource of filesystem) {
        if (!path.isAbsolute(resource.canonicalTarget)) {
          incompleteReasons.push(`filesystem resource ${resource.selectorId} is not canonical`);
          continue;
        }
        const kind = frozenKinds.get(resource.canonicalTarget);
        if (kind === undefined) {
          incompleteReasons.push(`filesystem resource ${resource.selectorId} has no frozen target kind`);
          continue;
        }
        // Unknown is conservatively treated as a possible directory. A directory's candidate chain
        // is a strict superset of the file-parent chain, while remaining deterministic and FS-free.
        this.#addFrozenPathScopes(
          targets,
          resource.canonicalTarget,
          kind !== 'file',
          leafScopes,
        );
      }
      return { targets, leafScopes, incompleteReasons };
    }

    if (filesystem.length === 0) {
      incompleteReasons.push(`${capabilityId} filesystem resource is missing`);
      return { targets, leafScopes, incompleteReasons };
    }
    for (const resource of filesystem) {
      if (!path.isAbsolute(resource.canonicalTarget)) {
        incompleteReasons.push(`filesystem resource ${resource.selectorId} is not canonical`);
        continue;
      }
      const kind = frozenKinds.get(resource.canonicalTarget);
      if (kind === undefined) {
        incompleteReasons.push(`filesystem resource ${resource.selectorId} has no frozen target kind`);
        continue;
      }
      this.#addFrozenPathScopes(
        targets,
        resource.canonicalTarget,
        kind !== 'file',
        leafScopes,
      );
    }
    return { targets, leafScopes, incompleteReasons };
  }

  #missingScopesForSources(
    resolution: Readonly<CapabilityTargetResolution>,
    sources: ReadonlySet<string>,
  ): readonly string[] {
    const matching = maximalScopes([...resolution.leafScopes])
      .filter((scope) => this.#candidates([scope]).some((candidate) =>
        sources.has(candidate.source)));
    return normalizedPaths(matching.length > 0 ? matching : [...resolution.leafScopes]);
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

  /** Use only resolver-frozen path meaning; this method performs no metadata or realpath reads. */
  #addFrozenPathScopes(
    targets: Set<string>,
    targetPath: string,
    targetIsDirectory: boolean,
    leafScopes: Set<string>,
  ): void {
    const absolute = path.normalize(targetPath);
    const directory = targetIsDirectory ? absolute : path.dirname(absolute);
    if (!path.isAbsolute(absolute) || !isPathInside(this.repositoryRoot, directory)) return;

    const relative = path.relative(this.repositoryRoot, directory);
    const parts = relative === '' ? [] : relative.split(path.sep);
    let current = this.repositoryRoot;
    targets.add(current);
    for (const part of parts) {
      current = path.join(current, part);
      targets.add(current);
    }
    leafScopes.add(directory);
  }

  /**
   * 词法路径逐级解析：遇越界链接时保留链接前的安全祖先规则；文件 leaf 另行解析，
   * 因而 dangling leaf 指向仓库外既会 warning，也不会丢掉其所在目录 AGENTS.md。
   */
  #addPathScopes(
    targets: Set<string>,
    targetPath: string,
    targetIsDirectory: boolean,
    leafScopes?: Set<string>,
  ): void {
    const absolute = path.resolve(targetPath);
    const lexicalDirectory = targetIsDirectory ? absolute : path.dirname(absolute);
    let crossedBoundary = false;
    let deepestSafeScope: string | undefined;

    if (isPathInside(this.repositoryRoot, lexicalDirectory)) {
      const relative = path.relative(this.repositoryRoot, lexicalDirectory);
      const parts = relative === '' ? [] : relative.split(path.sep);
      let lexicalPrefix = this.repositoryRoot;
      targets.add(this.repositoryRoot);
      deepestSafeScope = this.repositoryRoot;
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
          deepestSafeScope = physicalPrefix;
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
        const physicalScope = targetIsDirectory ? physicalTarget : path.dirname(physicalTarget);
        targets.add(physicalScope);
        deepestSafeScope = physicalScope;
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
    if (deepestSafeScope !== undefined) leafScopes?.add(deepestSafeScope);
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
      (a, b) => a.depth - b.depth || compareUtf8(a.source, b.source),
    );
  }

  async #load(
    candidate: RuleCandidate,
    maxFileBytes = this.#maxFileBytes,
    collect?: DiagnosticCollector,
  ): Promise<LoadedRule | undefined> {
    try {
      lstatSync(candidate.source);
    } catch (error) {
      if (!isMissing(error)) {
        this.#diagnose(
          collect,
          'rule_unreadable',
          `could not inspect project rules ${candidate.source}: ${String(error)}`,
          candidate.source,
        );
      }
      return undefined;
    }

    let physicalSource: string;
    try {
      physicalSource = canonicalizePath(candidate.source);
    } catch (error) {
      if (!isMissing(error)) {
        this.#diagnose(
          collect,
          'rule_unreadable',
          `could not resolve project rules ${candidate.source}: ${String(error)}`,
          candidate.source,
        );
      }
      return undefined;
    }
    if (!isPathInside(this.repositoryRoot, physicalSource)) {
      this.#diagnose(
        collect,
        'rule_skipped',
        `ignored project rules ${candidate.source}: symlink resolves outside repository root ` +
          `${this.repositoryRoot}`,
        candidate.source,
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
      this.#diagnose(
        collect,
        'rule_unreadable',
        `could not open project rules ${candidate.source}: ${String(error)}`,
        candidate.source,
      );
      return undefined;
    }

    try {
      let before: BigIntStats;
      try {
        before = fstatSync(descriptor, { bigint: true });
      } catch (error) {
        this.#diagnose(
          collect,
          'rule_unreadable',
          `could not inspect project rules ${candidate.source}: ${String(error)}`,
          candidate.source,
        );
        return undefined;
      }
      if (!before.isFile()) {
        this.#diagnose(
          collect,
          'rule_skipped',
          `ignored project rules ${candidate.source}: not a regular file`,
          candidate.source,
        );
        return undefined;
      }
      if (before.size > BigInt(maxFileBytes)) {
        this.#diagnose(
          collect,
          'rule_budget_exhausted',
          `ignored project rules ${candidate.source}: ${before.size} bytes exceeds per-file limit ` +
            `${maxFileBytes}`,
          candidate.source,
        );
        return undefined;
      }

      let current: BigIntStats;
      try {
        const verifiedSource = canonicalizePath(candidate.source);
        if (!isPathInside(this.repositoryRoot, verifiedSource)) {
          this.#diagnose(
            collect,
            'rule_skipped',
            `ignored project rules ${candidate.source}: path changed to outside repository root while reading`,
            candidate.source,
          );
          return undefined;
        }
        current = statSync(verifiedSource, { bigint: true });
      } catch (error) {
        this.#diagnose(
          collect,
          'rule_unreadable',
          `could not verify project rules ${candidate.source}: ${String(error)}`,
          candidate.source,
        );
        return undefined;
      }
      if (before.dev !== current.dev || before.ino !== current.ino) {
        this.#diagnose(
          collect,
          'rule_skipped',
          `ignored project rules ${candidate.source}: file changed while opening`,
          candidate.source,
        );
        return undefined;
      }

      let bytes: Uint8Array;
      try {
        const readLimit = maxFileBytes === Number.MAX_SAFE_INTEGER
          ? maxFileBytes
          : maxFileBytes + 1;
        bytes = await Bun.file(descriptor).slice(0, readLimit).bytes();
      } catch (error) {
        this.#diagnose(
          collect,
          'rule_unreadable',
          `could not read project rules ${candidate.source}: ${String(error)}`,
          candidate.source,
        );
        return undefined;
      }
      let after: BigIntStats;
      try {
        after = fstatSync(descriptor, { bigint: true });
      } catch (error) {
        this.#diagnose(
          collect,
          'rule_unreadable',
          `could not verify project rules ${candidate.source}: ${String(error)}`,
          candidate.source,
        );
        return undefined;
      }
      if (!sameFileSnapshot(before, after)) {
        this.#diagnose(
          collect,
          'rule_skipped',
          `ignored project rules ${candidate.source}: file changed while reading`,
          candidate.source,
        );
        return undefined;
      }
      if (bytes.byteLength > maxFileBytes) {
        this.#diagnose(
          collect,
          'rule_budget_exhausted',
          `ignored project rules ${candidate.source}: ${bytes.byteLength} bytes exceeds per-file limit ` +
            `${maxFileBytes}`,
          candidate.source,
        );
        return undefined;
      }

      const content = UTF8_DECODER.decode(bytes);
      if (content.trim().length === 0) return undefined;
      const block = renderRuleBlock({ ...candidate, content });
      return {
        ...candidate,
        block,
        content,
        contentDigest: `sha256_${sha256Hex(bytes)}`,
        byteLength: bytes.byteLength,
        tokenUnits: tokenUnits(block),
      };
    } finally {
      try {
        closeSync(descriptor);
      } catch (error) {
        this.#diagnose(
          collect,
          'rule_unreadable',
          `could not close project rules ${candidate.source}: ${String(error)}`,
          candidate.source,
        );
      }
    }
  }

  async #scanCapability(
    targets: Iterable<string>,
    budget: Readonly<RuleSnapshotBudget>,
  ): Promise<CapabilityRuleScan> {
    const loaded: LoadedRule[] = [];
    const diagnostics: Readonly<RuleSnapshotDiagnostic>[] = [];
    const collect: DiagnosticCollector = (diagnostic) => diagnostics.push(diagnostic);
    for (const candidate of this.#candidates(targets)) {
      const rule = await this.#load(candidate, budget.maxFileBytes, collect);
      if (rule !== undefined) loaded.push(rule);
    }

    let usedBytes = 0;
    let usedUnits = 0;
    const selected = new Set<string>();
    const priority = [...loaded].sort(
      (left, right) => right.depth - left.depth || compareUtf8(left.source, right.source),
    );
    for (const rule of priority) {
      let reason: string | undefined;
      if (selected.size >= budget.maxFiles) {
        reason = `selected rule count would exceed maxFiles ${budget.maxFiles}`;
      } else if (usedBytes + rule.byteLength > budget.maxBytes) {
        reason = `selected rule bytes would exceed maxBytes ${budget.maxBytes}`;
      } else {
        const nextUnits =
          (selected.size === 0 ? tokenUnits(RULES_HEADER) : usedUnits + tokenUnits(RULE_SEPARATOR)) +
          rule.tokenUnits;
        if (Math.ceil(nextUnits / 4) > budget.maxPromptTokens) {
          reason = `rendered section would exceed ${budget.maxPromptTokens}-token estimate`;
        } else {
          usedBytes += rule.byteLength;
          usedUnits = nextUnits;
          selected.add(rule.source);
        }
      }
      if (reason !== undefined) {
        this.#diagnose(
          collect,
          'rule_budget_exhausted',
          `ignored project rules ${rule.source}: ${reason}`,
          rule.source,
        );
      }
    }
    return {
      rules: loaded.filter((rule) => selected.has(rule.source)),
      diagnostics: normalizedDiagnostics(diagnostics),
    };
  }

  async #scan(targets: Iterable<string>): Promise<LegacyRuleSnapshot> {
    const loaded: LoadedRule[] = [];
    for (const candidate of this.#candidates(targets)) {
      const rule = await this.#load(candidate);
      if (rule !== undefined) loaded.push(rule);
    }

    let usedUnits = 0;
    const selected = new Set<string>();
    const priority = [...loaded].sort(
      (a, b) => b.depth - a.depth || compareUtf8(a.source, b.source),
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

const FRESH_RULES = Object.freeze({ fresh: true as const });

function snapshotTurnContext(input: Readonly<TurnPolicyContext>): Readonly<TurnPolicyContext> {
  const snapshot = snapshotJson(input) as Readonly<TurnPolicyContext>;
  if (typeof snapshot.workspaceId !== 'string' || snapshot.workspaceId.length === 0
    || typeof snapshot.threadId !== 'string' || snapshot.threadId.length === 0
    || typeof snapshot.runId !== 'string' || snapshot.runId.length === 0
    || typeof snapshot.turnId !== 'string' || snapshot.turnId.length === 0
    || typeof snapshot.cwd !== 'string' || snapshot.cwd.length === 0
    || !path.isAbsolute(snapshot.cwd)) {
    throw new TypeError('Invalid project-rule turn context');
  }
  return snapshot;
}

function snapshotInvocationContext(
  input: Parameters<RuleFreshnessPort['check']>[0]['context'],
): Readonly<Parameters<RuleFreshnessPort['check']>[0]['context']> {
  const snapshot = snapshotJson(input) as Readonly<Parameters<RuleFreshnessPort['check']>[0]['context']>;
  snapshotTurnContext(snapshot);
  if (typeof snapshot.capabilityId !== 'string' || snapshot.capabilityId.length === 0) {
    throw new TypeError('Invalid project-rule invocation capability');
  }
  return snapshot;
}

function snapshotCapabilityAnalysis(
  input: Readonly<CapabilityInvocationAnalysis>,
): Readonly<CapabilityInvocationAnalysis> {
  const snapshot = snapshotJson(input) as unknown;
  if (!isRecord(snapshot)
    || !hasExactKeys(snapshot, ['resourceCoverage', 'grantability', 'safety', 'attributes'])) {
    throw new TypeError('Invalid frozen capability analysis');
  }
  const coverage = snapshot.resourceCoverage;
  if (!isRecord(coverage)
    || (coverage.kind === 'complete'
      ? !hasExactKeys(coverage, ['kind'])
      : coverage.kind !== 'incomplete'
        || !hasExactKeys(coverage, ['kind', 'reasons'])
        || !isNonEmptyStringArray(coverage.reasons))) {
    throw new TypeError('Invalid frozen capability resource coverage');
  }
  const grantability = snapshot.grantability;
  if (!isRecord(grantability)
    || (grantability.kind === 'persistable'
      ? !hasExactKeys(grantability, ['kind'])
      : grantability.kind !== 'once_only'
        || !hasExactKeys(grantability, ['kind', 'reasons'])
        || !isNonEmptyStringArray(grantability.reasons))) {
    throw new TypeError('Invalid frozen capability grantability');
  }
  const safety = snapshot.safety;
  if (!isRecord(safety)
    || (safety.kind === 'eligible'
      ? !hasExactKeys(safety, ['kind'])
      : safety.kind !== 'deny'
        || !hasExactKeys(safety, ['kind', 'code', 'reason'])
        || typeof safety.code !== 'string'
        || safety.code.length === 0
        || typeof safety.reason !== 'string'
        || safety.reason.length === 0)
    || !isRecord(snapshot.attributes)) {
    throw new TypeError('Invalid frozen capability safety analysis');
  }
  return snapshot as unknown as Readonly<CapabilityInvocationAnalysis>;
}

function frozenBashFilesystemTargetKinds(
  input: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, LegacyBashFilesystemTarget['kind']> {
  const attributes = snapshotJson(input) as Readonly<Record<string, unknown>>;
  const required = [
    'kind',
    'command',
    'patterns',
    'forceConfirm',
    'reasons',
    'accessesExternalProject',
    'filesystemTargets',
  ];
  const allowed = new Set([...required, 'modelDescription']);
  if (required.some((key) => !Object.hasOwn(attributes, key))
    || Object.keys(attributes).some((key) => !allowed.has(key))
    || attributes.kind !== LEGACY_BASH_ANALYSIS_VERSION
    || typeof attributes.command !== 'string'
    || attributes.command.length === 0
    || !Array.isArray(attributes.patterns)
    || !attributes.patterns.every((pattern) => typeof pattern === 'string' && pattern.length > 0)
    || typeof attributes.forceConfirm !== 'boolean'
    || !Array.isArray(attributes.reasons)
    || !attributes.reasons.every((reason) => typeof reason === 'string' && reason.length > 0)
    || typeof attributes.accessesExternalProject !== 'boolean'
    || (attributes.modelDescription !== undefined && typeof attributes.modelDescription !== 'string')
    || !Array.isArray(attributes.filesystemTargets)
    || attributes.filesystemTargets.length === 0) {
    throw new TypeError('Invalid frozen legacy bash analysis attributes');
  }

  const targets = new Map<string, LegacyBashFilesystemTarget['kind']>();
  let previous: string | undefined;
  for (const value of attributes.filesystemTargets) {
    if (!isRecord(value) || !hasExactKeys(value, ['canonicalTarget', 'kind'])) {
      throw new TypeError('Invalid frozen legacy bash filesystem target');
    }
    const canonicalTarget = value.canonicalTarget;
    const kind = value.kind;
    if (typeof canonicalTarget !== 'string'
      || canonicalTarget.length === 0
      || !path.isAbsolute(canonicalTarget)
      || path.normalize(canonicalTarget) !== canonicalTarget
      || (kind !== 'file' && kind !== 'directory' && kind !== 'unknown')
      || (previous !== undefined && compareUtf8(previous, canonicalTarget) >= 0)) {
      throw new TypeError('Invalid frozen legacy bash filesystem target');
    }
    targets.set(canonicalTarget, kind);
    previous = canonicalTarget;
  }
  return targets;
}

function frozenFilesystemTargetKinds(
  input: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, LegacyBashFilesystemTarget['kind']> {
  const attributes = snapshotJson(input) as Readonly<Record<string, unknown>>;
  if (!hasExactKeys(attributes, ['kind', 'filesystemTargets'])
    || attributes.kind !== LEGACY_FILESYSTEM_ANALYSIS_VERSION
    || !Array.isArray(attributes.filesystemTargets)) {
    throw new TypeError('Invalid frozen legacy filesystem analysis attributes');
  }

  const targets = new Map<string, LegacyBashFilesystemTarget['kind']>();
  let previous: string | undefined;
  for (const value of attributes.filesystemTargets) {
    if (!isRecord(value) || !hasExactKeys(value, ['canonicalTarget', 'kind'])) {
      throw new TypeError('Invalid frozen legacy filesystem target');
    }
    const canonicalTarget = value.canonicalTarget;
    const kind = value.kind;
    if (typeof canonicalTarget !== 'string'
      || canonicalTarget.length === 0
      || !path.isAbsolute(canonicalTarget)
      || path.normalize(canonicalTarget) !== canonicalTarget
      || (kind !== 'file' && kind !== 'directory' && kind !== 'unknown')
      || (previous !== undefined && compareUtf8(previous, canonicalTarget) >= 0)) {
      throw new TypeError('Invalid frozen legacy filesystem target');
    }
    targets.set(canonicalTarget, kind);
    previous = canonicalTarget;
  }
  return targets;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, required: readonly string[]): boolean {
  return Object.keys(value).length === required.length
    && required.every((key) => Object.hasOwn(value, key));
}

function isNonEmptyStringArray(value: unknown): value is readonly [string, ...string[]] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item) => typeof item === 'string' && item.length > 0);
}

function snapshotRuleBudget(input: Readonly<RuleSnapshotBudget>): Readonly<RuleSnapshotBudget> {
  const snapshot = snapshotJson(input) as Readonly<RuleSnapshotBudget>;
  if (Object.keys(snapshot).length !== 4
    || !Object.hasOwn(snapshot, 'maxFiles')
    || !Object.hasOwn(snapshot, 'maxFileBytes')
    || !Object.hasOwn(snapshot, 'maxBytes')
    || !Object.hasOwn(snapshot, 'maxPromptTokens')
    || !Object.values(snapshot).every((value) =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) {
    throw new TypeError('Invalid project-rule snapshot budget');
  }
  return snapshot;
}

function snapshotCapabilityRules(
  input: Readonly<CapabilityRuleSnapshot>,
): Readonly<CapabilityRuleSnapshot> {
  const snapshot = snapshotJson(input) as Readonly<CapabilityRuleSnapshot>;
  if (typeof snapshot.revision !== 'string' || snapshot.revision.length === 0
    || !Array.isArray(snapshot.discovery.knownResourceScopes)
    || !Array.isArray(snapshot.discovery.diagnostics)
    || !Array.isArray(snapshot.files)) {
    throw new TypeError('Invalid project-rule snapshot');
  }
  snapshotTurnContext(snapshot.owner);
  snapshotRuleBudget(snapshot.discovery.budget);
  if (snapshot.discovery.knownResourceScopes.some((scope) =>
    typeof scope !== 'string' || scope.length === 0 || !path.isAbsolute(scope))) {
    throw new TypeError('Invalid known project-rule scopes');
  }
  for (const diagnostic of snapshot.discovery.diagnostics) {
    if ((diagnostic.code !== 'rule_skipped'
      && diagnostic.code !== 'rule_budget_exhausted'
      && diagnostic.code !== 'rule_unreadable')
      || typeof diagnostic.message !== 'string'
      || (diagnostic.path !== undefined && typeof diagnostic.path !== 'string')) {
      throw new TypeError('Invalid project-rule diagnostic');
    }
  }
  for (const file of snapshot.files) {
    if (typeof file.path !== 'string' || file.path.length === 0
      || typeof file.scope !== 'string' || file.scope.length === 0
      || typeof file.contentDigest !== 'string' || file.contentDigest.length === 0
      || typeof file.content !== 'string') {
      throw new TypeError('Invalid project-rule file snapshot');
    }
  }
  return snapshot;
}

function capabilityRuleRevision(
  discovery: CapabilityRuleSnapshot['discovery'],
  files: CapabilityRuleSnapshot['files'],
): string {
  return `rule_snapshot_v1_${canonicalJsonSha256({ discovery, files })}`;
}

function sameTurnContext(
  left: Readonly<TurnPolicyContext>,
  right: Readonly<TurnPolicyContext>,
): boolean {
  return left.workspaceId === right.workspaceId
    && left.threadId === right.threadId
    && left.runId === right.runId
    && left.turnId === right.turnId
    && left.cwd === right.cwd;
}

function sameCapabilityFiles(
  left: CapabilityRuleSnapshot['files'],
  right: CapabilityRuleSnapshot['files'],
): boolean {
  return left.length === right.length && left.every((file, index) => {
    const other = right[index];
    return other !== undefined
      && file.path === other.path
      && file.scope === other.scope
      && file.contentDigest === other.contentDigest
      && file.content === other.content;
  });
}

function normalizedDiagnostics(
  diagnostics: readonly Readonly<RuleSnapshotDiagnostic>[],
): readonly Readonly<RuleSnapshotDiagnostic>[] {
  const unique = new Map<string, Readonly<RuleSnapshotDiagnostic>>();
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.code}\u0000${diagnostic.path ?? ''}\u0000${diagnostic.message}`;
    if (!unique.has(key)) unique.set(key, snapshotJson(diagnostic));
  }
  return Object.freeze([...unique.entries()]
    .sort(([left], [right]) => compareUtf8(left, right))
    .map(([, diagnostic]) => diagnostic));
}

function normalizedPaths(paths: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(paths)].sort(compareUtf8));
}

function maximalScopes(scopes: readonly string[]): readonly string[] {
  const normalized = normalizedPaths(scopes);
  return normalized.filter((scope) => !normalized.some((other) =>
    other !== scope && isPathInside(scope, other)));
}

function compareUtf8(left: string, right: string): number {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index++) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function staleRules(message: string): Awaited<ReturnType<RuleFreshnessPort['check']>> {
  return snapshotJson({
    fresh: false as const,
    code: 'rule_changed' as const,
    message,
  });
}

function missingScopeDecision(
  missingScopes: readonly string[],
): Awaited<ReturnType<RuleFreshnessPort['check']>> {
  return snapshotJson({
    fresh: false as const,
    code: 'rule_scope_missing' as const,
    missingScopes: missingScopes as readonly [string, ...string[]],
    message:
      'Project rules for this resource scope were not present in the frozen turn snapshot. ' +
      'They will be captured on the next turn; review them before retrying.',
  });
}

function isSelectionBudgetDiagnostic(
  diagnostic: Readonly<RuleSnapshotDiagnostic>,
): boolean {
  return diagnostic.code === 'rule_budget_exhausted'
    && !diagnostic.message.includes('per-file limit');
}

function snapshotJson<T>(value: T): Readonly<T> {
  return strictJsonSnapshot(value) as unknown as Readonly<T>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
