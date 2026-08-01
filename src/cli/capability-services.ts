// CLI-owned registry composition. Every filesystem/prompt/rule dependency is supplied by the
// caller; constructing this bundle never consults process.cwd(), HOME, or mutable runtime state.

import path from 'node:path';
import {
  adaptLegacyTool,
  createCapabilityRegistry,
  createPolicyEngine,
  createPromptAssembler,
  createProviderAdapterRegistry,
} from '../capabilities/index.js';
import type {
  BasePromptProvider,
  PolicyDecision,
  PolicyEngine,
  PolicyGrantSnapshot,
  PreparedInvocation,
  ProviderAdapterRegistry,
  RuleFreshnessPort,
  RuleSnapshotBudget,
  RuleSnapshotProvider,
  RuntimeCapabilityServices,
  ThreadPolicyEngine,
} from '../capabilities/index.js';
import { createCodingToolCapabilityBindings } from '../integrations/legacy-coding-tools/index.js';
import {
  LEGACY_BASH_ANALYSIS_VERSION,
} from '../integrations/legacy-coding-tools/bash-analyze.js';
import type {
  LegacyBashInvocationAnalysisAttributes,
} from '../integrations/legacy-coding-tools/bash-analyze.js';
import {
  canonicalJsonSha256,
  sha256Hex,
  strictJsonSnapshot,
} from '../protocol/index.js';
import type { ModelApi, PolicyGrantScope, StreamFn } from '../protocol/index.js';
import { createFauxStreamFn } from '../providers/faux/index.js';
import type { FauxScript } from '../providers/faux/index.js';
import { streamAnthropicMessages } from '../providers/anthropic-messages/index.js';
import { streamOpenAIChat } from '../providers/openai-chat/index.js';
import { streamOpenAIResponses } from '../providers/openai-responses/index.js';
import { canonicalizePath, isPathInside } from '../shared/index.js';
import type { StaticLegacyApprovalMode } from './legacy-approval-adapter.js';
import { createProviderStreamFn } from './provider-stream.js';

const PROVIDER_VERSION = '1';
const PROVIDER_APIS = Object.freeze([
  'openai-chat',
  'openai-responses',
  'anthropic-messages',
  'faux',
] as const satisfies readonly ModelApi[]);

export interface CliRegistryCapabilityServiceOptions {
  /** Explicit absolute CLI workspace root. Relative paths are rejected instead of using ambient cwd. */
  readonly cwd: string;
  readonly approvalMode: StaticLegacyApprovalMode;
  readonly basePrompts: BasePromptProvider;
  readonly ruleSnapshots: RuleSnapshotProvider;
  readonly ruleFreshness: RuleFreshnessPort;
  readonly ruleBudget: Readonly<RuleSnapshotBudget>;
  readonly fauxScript?: FauxScript;
}

export interface CliRegistryCapabilityComposition {
  /** Mutable host-owned registry. Runtime turns only receive immutable snapshots through services. */
  readonly capabilityRegistry: ReturnType<typeof createCapabilityRegistry>;
  /** Mutable host-owned registry. Runtime turns only receive immutable snapshots through services. */
  readonly providerRegistry: ProviderAdapterRegistry;
  readonly services: Readonly<RuntimeCapabilityServices>;
}

export interface CliBasePromptProviderOptions {
  readonly content: string;
}

/** Create an explicit, side-effect-free base prompt source for CLI composition. */
export function createCliBasePromptProvider(
  options: CliBasePromptProviderOptions,
): BasePromptProvider {
  if (typeof options.content !== 'string') throw new TypeError('Base prompt content must be a string');
  const content = snapshotJson(options.content);
  const revision = `cli_base_prompt_v1_${canonicalJsonSha256({ content })}`;
  const provider: BasePromptProvider = {
    async capture(input) {
      return snapshotJson({
        owner: input.context,
        model: input.model.ref,
        revision,
        content,
      });
    },
  };
  return Object.freeze(provider);
}

/**
 * Build the phase-3 registry services used by the legacy CLI surface.
 *
 * Project rule discovery/freshness remains an explicit host responsibility so this factory can be
 * embedded and tested without filesystem or environment reads.
 */
export function createCliRegistryCapabilityServices(
  options: CliRegistryCapabilityServiceOptions,
): Readonly<CliRegistryCapabilityComposition> {
  const projectRoot = explicitAbsoluteRoot(options.cwd);
  requireMethod(options.basePrompts, 'capture', 'basePrompts');
  requireMethod(options.ruleSnapshots, 'capture', 'ruleSnapshots');
  requireMethod(options.ruleFreshness, 'check', 'ruleFreshness');
  const ruleBudget = snapshotRuleBudget(options.ruleBudget);

  const capabilityRegistry = createCapabilityRegistry();
  for (const binding of createCodingToolCapabilityBindings()) {
    const result = capabilityRegistry.register(adaptLegacyTool(binding));
    if (!result.ok) {
      throw new TypeError(`Failed to register CLI capability ${JSON.stringify(binding.tool.name)}: ${result.message}`);
    }
  }

  const providerRegistry = createProviderAdapterRegistry();
  const providerStreams = providerAdapterStreams(options.fauxScript);
  for (const api of PROVIDER_APIS) {
    const result = providerRegistry.register({
      api,
      version: PROVIDER_VERSION,
      implementationDigest: providerImplementationDigest(api),
      stream: providerStreams[api],
    });
    if (!result.ok) {
      throw new TypeError(`Failed to register CLI provider adapter ${JSON.stringify(api)}: ${result.message}`);
    }
  }

  const services: Readonly<RuntimeCapabilityServices> = Object.freeze({
    capabilities: capabilityRegistry,
    providers: providerRegistry,
    promptAssembler: createPromptAssembler(),
    basePrompts: options.basePrompts,
    ruleSnapshots: options.ruleSnapshots,
    ruleBudget,
    policyEngine: createCliLegacyPolicyEngine({
      approvalMode: options.approvalMode,
      projectRoot,
    }),
    ruleFreshness: options.ruleFreshness,
    grantMode: 'legacy_global_approvals_v1',
  });

  return Object.freeze({ capabilityRegistry, providerRegistry, services });
}

function createCliLegacyPolicyEngine(input: {
  readonly approvalMode: StaticLegacyApprovalMode;
  readonly projectRoot: string;
}): PolicyEngine {
  if (input.approvalMode !== 'interactive'
    && input.approvalMode !== 'allow'
    && input.approvalMode !== 'deny') {
    throw new TypeError('Invalid CLI approval mode');
  }
  const projectRootReal = canonicalizePath(input.projectRoot);
  const delegate = createPolicyEngine({
    configuration: {
      kind: 'cli_legacy_policy_v1',
      approvalMode: input.approvalMode,
      projectRoot: input.projectRoot,
      projectRootReal,
      bashAnalysisVersion: LEGACY_BASH_ANALYSIS_VERSION,
    },
  });
  const policyEngine: PolicyEngine = {
    async openThread(owner) {
      const engine = await delegate.openThread(owner);
      return Object.freeze(new CliLegacyThreadPolicyEngine({
        engine,
        approvalMode: input.approvalMode,
        projectRoot: input.projectRoot,
        projectRootReal,
      }));
    },
  };
  return Object.freeze(policyEngine);
}

class CliLegacyThreadPolicyEngine implements ThreadPolicyEngine {
  readonly #engine: ThreadPolicyEngine;
  readonly #approvalMode: StaticLegacyApprovalMode;
  readonly #projectRoot: string;
  readonly #projectRootReal: string;
  #legacyPatterns = new Set<string>();
  #closed = false;

  constructor(input: {
    readonly engine: ThreadPolicyEngine;
    readonly approvalMode: StaticLegacyApprovalMode;
    readonly projectRoot: string;
    readonly projectRootReal: string;
  }) {
    this.#engine = input.engine;
    this.#approvalMode = input.approvalMode;
    this.#projectRoot = input.projectRoot;
    this.#projectRootReal = input.projectRootReal;
  }

  async capture(input: Parameters<ThreadPolicyEngine['capture']>[0]) {
    // Detach once before crossing the delegate's async boundary so the wrapper matches exactly the
    // legacy material captured into this policy revision, even if a caller later mutates its input.
    const grants = snapshotJson(input.grants) as Readonly<PolicyGrantSnapshot>;
    const policy = await this.#engine.capture({ ...input, grants });
    this.#legacyPatterns = new Set(legacyPatterns(grants));
    return policy;
  }

  async evaluate(invocation: Readonly<PreparedInvocation>): Promise<PolicyDecision> {
    const decision = await this.#engine.evaluate(invocation);
    if (decision.kind !== 'ask') return decision;

    // The old --approval-mode allow/deny switch happened before interactive analyzers. Preserve
    // that behavior while retaining the generic engine's identity and ceiling denials above.
    if (this.#approvalMode === 'allow') {
      return snapshotJson({
        kind: 'allow',
        code: 'cli_approval_mode_allow',
        reason: 'CLI approval mode allows capabilities that otherwise require approval',
      });
    }
    if (this.#approvalMode === 'deny') {
      return snapshotJson({
        kind: 'deny',
        code: 'cli_approval_mode_deny',
        reason:
          `Tool "${invocation.context.capabilityId}" requires approval, but approvals are disabled ` +
          '(--approval-mode deny). Use read-only tools, or ask the user to rerun without deny mode.',
        recoverable: true as const,
      });
    }

    if (invocation.context.capabilityId === 'bash') {
      return this.#evaluateInteractiveBash(invocation, decision);
    }
    if (decision.code === 'doom_loop_confirmation_required') return decision;
    if (invocation.policy.kind === 'edit') {
      return this.#evaluateInteractiveEdit(invocation, decision);
    }
    return decisionWithoutProposal(decision);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#legacyPatterns.clear();
    await this.#engine.close();
  }

  #evaluateInteractiveBash(
    invocation: Readonly<PreparedInvocation>,
    decision: Extract<PolicyDecision, { readonly kind: 'ask' }>,
  ): PolicyDecision {
    const analysis = frozenLegacyBashAnalysis(invocation.analysis.attributes);
    if (analysis === undefined) {
      return snapshotJson({
        kind: 'deny',
        code: 'invalid_legacy_bash_analysis',
        reason: 'The prepared bash invocation is missing its frozen authoritative analysis',
        recoverable: true as const,
      });
    }
    if (decision.code === 'doom_loop_confirmation_required') return decision;

    const modelNote = analysis.modelDescription === undefined
      ? ''
      : ` — ${analysis.modelDescription}`;
    const description =
      `bash: ${analysis.command}${modelNote}` +
      `${analysis.accessesExternalProject ? ' (accesses paths outside project root)' : ''}` +
      `${invocation.analysis.resourceCoverage.kind === 'complete'
        ? ''
        : ' (contains paths that could not be fully analyzed)'}`;
    if (analysis.forceConfirm
      || invocation.analysis.resourceCoverage.kind === 'incomplete'
      || invocation.analysis.grantability.kind === 'once_only'
      || analysis.accessesExternalProject) {
      return askWithoutProposal(decision, description);
    }
    return this.#matchOrAsk(decision, description, analysis.patterns);
  }

  #evaluateInteractiveEdit(
    invocation: Readonly<PreparedInvocation>,
    decision: Extract<PolicyDecision, { readonly kind: 'ask' }>,
  ): PolicyDecision {
    const resources = invocation.resources;
    const learnable = resources.length > 0 && resources.every((resource) =>
      resource.resourceType === 'filesystem'
      && resource.access === 'write'
      && this.#isInsideProject(resource.canonicalTarget));
    const target = resources[0]?.canonicalTarget;
    const description = target === undefined
      ? decision.description
      : `${invocation.context.capabilityId} ${target}${learnable ? '' : ' (outside project root)'}`;
    if (!learnable) return askWithoutProposal(decision, description);
    return this.#matchOrAsk(
      decision,
      description,
      [`${invocation.context.capabilityId}:${this.#projectRoot}/**`],
    );
  }

  #matchOrAsk(
    decision: Extract<PolicyDecision, { readonly kind: 'ask' }>,
    description: string,
    patterns: readonly string[],
  ): PolicyDecision {
    const normalized = normalizedPatterns(patterns);
    if (normalized.length === 0) return askWithoutProposal(decision, description);
    if (normalized.every((pattern) => this.#legacyPatterns.has(pattern))) {
      return snapshotJson({
        kind: 'allow',
        code: 'matching_legacy_global_approval',
        reason: 'The legacy global approval snapshot matches this invocation',
      });
    }
    const grantProposal: PolicyGrantScope = {
      kind: 'legacy_global_approvals_v1',
      patterns: normalized as [string, ...string[]],
    };
    return snapshotJson({ ...decision, description, grantProposal });
  }

  #isInsideProject(candidate: string): boolean {
    if (!path.isAbsolute(candidate)) return false;
    try {
      return isPathInside(this.#projectRootReal, path.normalize(candidate));
    } catch {
      return false;
    }
  }
}

function frozenLegacyBashAnalysis(
  value: Readonly<Record<string, unknown>>,
): Readonly<LegacyBashInvocationAnalysisAttributes> | undefined {
  const snapshot = snapshotJson(value) as Readonly<Record<string, unknown>>;
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
  if (required.some((key) => !Object.hasOwn(snapshot, key))
    || Object.keys(snapshot).some((key) => !allowed.has(key))
    || snapshot.kind !== LEGACY_BASH_ANALYSIS_VERSION
    || typeof snapshot.command !== 'string'
    || !Array.isArray(snapshot.patterns)
    || !snapshot.patterns.every((pattern) => typeof pattern === 'string' && pattern.length > 0)
    || typeof snapshot.forceConfirm !== 'boolean'
    || !Array.isArray(snapshot.reasons)
    || !snapshot.reasons.every((reason) => typeof reason === 'string' && reason.length > 0)
    || typeof snapshot.accessesExternalProject !== 'boolean'
    || !validFrozenFilesystemTargets(snapshot.filesystemTargets)
    || (snapshot.modelDescription !== undefined && typeof snapshot.modelDescription !== 'string')) {
    return undefined;
  }
  return snapshot as unknown as Readonly<LegacyBashInvocationAnalysisAttributes>;
}

function validFrozenFilesystemTargets(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  let previous: string | undefined;
  for (const target of value) {
    if (target === null || typeof target !== 'object' || Array.isArray(target)) return false;
    const snapshot = target as Readonly<Record<string, unknown>>;
    const keys = Object.keys(snapshot);
    if (keys.length !== 2
      || !Object.hasOwn(snapshot, 'canonicalTarget')
      || !Object.hasOwn(snapshot, 'kind')
      || typeof snapshot.canonicalTarget !== 'string'
      || snapshot.canonicalTarget.length === 0
      || !path.isAbsolute(snapshot.canonicalTarget)
      || path.normalize(snapshot.canonicalTarget) !== snapshot.canonicalTarget
      || (snapshot.kind !== 'file' && snapshot.kind !== 'directory' && snapshot.kind !== 'unknown')) {
      return false;
    }
    if (previous !== undefined && compareUtf8(previous, snapshot.canonicalTarget) >= 0) return false;
    previous = snapshot.canonicalTarget;
  }
  return true;
}

function providerAdapterStreams(
  fauxScript: FauxScript | undefined,
): Readonly<Record<(typeof PROVIDER_APIS)[number], StreamFn>> {
  // createProviderStreamFn preserves the existing in-stream error when the CLI has no faux script.
  const faux = fauxScript === undefined ? createProviderStreamFn() : createFauxStreamFn(fauxScript);
  return Object.freeze({
    'openai-chat': streamOpenAIChat,
    'openai-responses': streamOpenAIResponses,
    'anthropic-messages': streamAnthropicMessages,
    faux,
  });
}

function providerImplementationDigest(api: ModelApi): string {
  return `impl_sha256_${sha256Hex(`coda.cli.provider-adapter.${api}.v1`)}`;
}

function explicitAbsoluteRoot(input: string): string {
  if (typeof input !== 'string'
    || input.length === 0
    || input.includes('\u0000')
    || !input.isWellFormed()
    || !path.isAbsolute(input)) {
    throw new TypeError('CLI registry cwd must be an explicit absolute path');
  }
  return path.normalize(input);
}

function snapshotRuleBudget(input: Readonly<RuleSnapshotBudget>): Readonly<RuleSnapshotBudget> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('CLI rule budget must be an object');
  }
  const keys = Object.keys(input);
  const expected = ['maxFiles', 'maxFileBytes', 'maxBytes', 'maxPromptTokens'];
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw new TypeError('CLI rule budget has missing or unknown fields');
  }
  const budget = snapshotJson({
    maxFiles: input.maxFiles,
    maxFileBytes: input.maxFileBytes,
    maxBytes: input.maxBytes,
    maxPromptTokens: input.maxPromptTokens,
  });
  if (!Object.values(budget).every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new TypeError('CLI rule budget values must be non-negative safe integers');
  }
  return budget;
}

function requireMethod(value: unknown, method: string, label: string): void {
  if (value === null
    || typeof value !== 'object'
    || typeof (value as Readonly<Record<string, unknown>>)[method] !== 'function') {
    throw new TypeError(`CLI registry ${label} must provide ${method}()`);
  }
}

function legacyPatterns(snapshot: Readonly<PolicyGrantSnapshot>): readonly string[] {
  return snapshot.legacyGlobal?.patterns ?? [];
}

function normalizedPatterns(patterns: readonly string[]): readonly string[] {
  return [...new Set(patterns.filter((pattern) => pattern.length > 0))].sort(compareUtf8);
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

function askWithoutProposal(
  decision: Extract<PolicyDecision, { readonly kind: 'ask' }>,
  description = decision.description,
): PolicyDecision {
  return snapshotJson({
    kind: 'ask',
    code: decision.code,
    reason: decision.reason,
    description,
  });
}

function decisionWithoutProposal(
  decision: Extract<PolicyDecision, { readonly kind: 'ask' }>,
): PolicyDecision {
  return decision.grantProposal === undefined ? decision : askWithoutProposal(decision);
}

function snapshotJson<T>(value: T): Readonly<T> {
  return strictJsonSnapshot(value) as unknown as Readonly<T>;
}
