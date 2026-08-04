// CLI-owned registry composition. Every filesystem/prompt/rule dependency is supplied by the
// caller; constructing this bundle never consults process.cwd(), HOME, or mutable runtime state.

import path from 'node:path';
import {
  createCapabilityRegistry,
  createPolicyEngine,
  createPromptAssembler,
  createProviderAdapterRegistry,
} from '../capabilities/index.js';
import type {
  BasePromptProvider,
  PolicyDecision,
  PolicyEngine,
  PreparedInvocation,
  ProviderAdapterRegistry,
  RuleFreshnessPort,
  RuleSnapshotBudget,
  RuleSnapshotProvider,
  RuntimeCapabilityServices,
  ThreadPolicyEngine,
} from '../capabilities/index.js';
import {
  BASH_ANALYSIS_VERSION,
  createCodingCapabilityRegistrations,
} from '../integrations/coding-capabilities/index.js';
import type {
  BashInvocationAnalysisAttributes,
} from '../integrations/coding-capabilities/index.js';
import {
  canonicalJsonSha256,
  ProviderEventStream,
  sha256Hex,
  strictJsonSnapshot,
} from '../protocol/index.js';
import type {
  AssistantMessage,
  ModelApi,
  StreamFn,
} from '../protocol/index.js';
import { createFauxStreamFn } from '../providers/faux/index.js';
import type { FauxScript } from '../providers/faux/index.js';
import { streamAnthropicMessages } from '../providers/anthropic-messages/index.js';
import { streamOpenAIChat } from '../providers/openai-chat/index.js';
import { streamOpenAIResponses } from '../providers/openai-responses/index.js';

const PROVIDER_VERSION = '1';
const PROVIDER_APIS = Object.freeze([
  'openai-chat',
  'openai-responses',
  'anthropic-messages',
  'faux',
] as const satisfies readonly ModelApi[]);

export type CliApprovalMode = 'interactive' | 'allow' | 'deny';

export interface CliRegistryCapabilityServiceOptions {
  /** Explicit absolute CLI workspace root. Relative paths are rejected instead of using ambient cwd. */
  readonly cwd: string;
  readonly approvalMode: CliApprovalMode;
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

/** Build the native registry services used by the CLI Runtime composition. */
export function createCliRegistryCapabilityServices(
  options: CliRegistryCapabilityServiceOptions,
): Readonly<CliRegistryCapabilityComposition> {
  const projectRoot = explicitAbsoluteRoot(options.cwd);
  requireMethod(options.basePrompts, 'capture', 'basePrompts');
  requireMethod(options.ruleSnapshots, 'capture', 'ruleSnapshots');
  requireMethod(options.ruleFreshness, 'check', 'ruleFreshness');
  const ruleBudget = snapshotRuleBudget(options.ruleBudget);

  const capabilityRegistry = createCapabilityRegistry();
  for (const registration of createCodingCapabilityRegistrations()) {
    const result = capabilityRegistry.register(registration);
    if (!result.ok) {
      throw new TypeError(
        `Failed to register CLI capability ${JSON.stringify(registration.id)}: ${result.message}`,
      );
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
    policyEngine: createCliPolicyEngine({
      approvalMode: options.approvalMode,
      projectRoot,
    }),
    ruleFreshness: options.ruleFreshness,
  });

  return Object.freeze({ capabilityRegistry, providerRegistry, services });
}

function createCliPolicyEngine(input: {
  readonly approvalMode: CliApprovalMode;
  readonly projectRoot: string;
}): PolicyEngine {
  if (input.approvalMode !== 'interactive'
    && input.approvalMode !== 'allow'
    && input.approvalMode !== 'deny') {
    throw new TypeError('Invalid CLI approval mode');
  }
  const delegate = createPolicyEngine({
    configuration: {
      kind: 'cli_policy_v2',
      approvalMode: input.approvalMode,
      projectRoot: input.projectRoot,
      bashAnalysisVersion: BASH_ANALYSIS_VERSION,
    },
  });
  const policyEngine: PolicyEngine = {
    async openThread(owner) {
      const engine = await delegate.openThread(owner);
      return Object.freeze(new CliThreadPolicyEngine(engine, input.approvalMode));
    },
  };
  return Object.freeze(policyEngine);
}

class CliThreadPolicyEngine implements ThreadPolicyEngine {
  #closed = false;

  constructor(
    readonly engine: ThreadPolicyEngine,
    readonly approvalMode: CliApprovalMode,
  ) {}

  async capture(input: Parameters<ThreadPolicyEngine['capture']>[0]) {
    return this.engine.capture(input);
  }

  async evaluate(invocation: Readonly<PreparedInvocation>): Promise<PolicyDecision> {
    const decision = await this.engine.evaluate(invocation);
    if (decision.kind !== 'ask') return decision;

    // The CLI mode only resolves an otherwise-ask decision. Safety and ceiling denials remain
    // authoritative because the generic engine evaluates them before this wrapper is reached.
    if (this.approvalMode === 'allow') {
      return snapshotJson({
        kind: 'allow',
        code: 'cli_approval_mode_allow',
        reason: 'CLI approval mode allows capabilities that otherwise require approval',
      });
    }
    if (this.approvalMode === 'deny') {
      return snapshotJson({
        kind: 'deny',
        code: 'cli_approval_mode_deny',
        reason:
          `Capability "${invocation.context.capabilityId}" requires approval, but approvals are disabled ` +
          '(--approval-mode deny). Use read-only capabilities, or rerun without deny mode.',
        recoverable: true as const,
      });
    }

    if (decision.code === 'doom_loop_confirmation_required'
      || invocation.context.capabilityId !== 'bash') {
      return decision;
    }
    return describeInteractiveBash(invocation, decision);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.engine.close();
  }
}

function describeInteractiveBash(
  invocation: Readonly<PreparedInvocation>,
  decision: Extract<PolicyDecision, { readonly kind: 'ask' }>,
): PolicyDecision {
  const analysis = frozenBashAnalysis(invocation.analysis.attributes);
  if (analysis === undefined) {
    return snapshotJson({
      kind: 'deny',
      code: 'invalid_bash_analysis',
      reason: 'The prepared bash invocation is missing its frozen authoritative analysis',
      recoverable: true as const,
    });
  }

  const modelNote = analysis.modelDescription === undefined
    ? ''
    : ` — ${analysis.modelDescription}`;
  const description =
    `bash: ${analysis.command}${modelNote}` +
    `${analysis.accessesExternalProject ? ' (accesses paths outside project root)' : ''}` +
    `${invocation.analysis.resourceCoverage.kind === 'complete'
      ? ''
      : ' (contains paths that could not be fully analyzed)'}`;
  const mayPersist = !analysis.forceConfirm
    && !analysis.accessesExternalProject
    && invocation.analysis.resourceCoverage.kind === 'complete'
    && invocation.analysis.grantability.kind === 'persistable';
  return snapshotJson({
    kind: 'ask',
    code: decision.code,
    reason: decision.reason,
    description,
    ...(mayPersist && decision.grantProposal !== undefined
      ? { grantProposal: decision.grantProposal }
      : {}),
  });
}

function frozenBashAnalysis(
  value: Readonly<Record<string, unknown>>,
): Readonly<BashInvocationAnalysisAttributes> | undefined {
  const snapshot = snapshotJson(value) as Readonly<Record<string, unknown>>;
  const required = [
    'kind',
    'command',
    'forceConfirm',
    'reasons',
    'accessesExternalProject',
    'filesystemTargets',
  ];
  const allowed = new Set([...required, 'modelDescription']);
  if (required.some((key) => !Object.hasOwn(snapshot, key))
    || Object.keys(snapshot).some((key) => !allowed.has(key))
    || snapshot.kind !== BASH_ANALYSIS_VERSION
    || typeof snapshot.command !== 'string'
    || typeof snapshot.forceConfirm !== 'boolean'
    || !Array.isArray(snapshot.reasons)
    || !snapshot.reasons.every((reason) => typeof reason === 'string' && reason.length > 0)
    || typeof snapshot.accessesExternalProject !== 'boolean'
    || !validFrozenFilesystemTargets(snapshot.filesystemTargets)
    || (snapshot.modelDescription !== undefined && typeof snapshot.modelDescription !== 'string')) {
    return undefined;
  }
  return snapshot as unknown as Readonly<BashInvocationAnalysisAttributes>;
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
  return Object.freeze({
    'openai-chat': streamOpenAIChat,
    'openai-responses': streamOpenAIResponses,
    'anthropic-messages': streamAnthropicMessages,
    faux: fauxScript === undefined ? unconfiguredFauxStream : createFauxStreamFn(fauxScript),
  });
}

const unconfiguredFauxStream: StreamFn = (model) => {
  const stream = new ProviderEventStream();
  const message: AssistantMessage = {
    role: 'assistant',
    id: `a_${crypto.randomUUID()}`,
    timestamp: Date.now(),
    content: [],
    model: { ...model.ref },
    stopReason: 'error',
    errorMessage: 'faux provider 未配置脚本',
    errorDetails: { kind: 'unknown', retryable: false },
    usage: { input: 0, output: 0 },
  };
  stream.push({ type: 'start', partial: message });
  stream.push({ type: 'error', message });
  stream.end(message);
  return stream;
};

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

function snapshotJson<T>(value: T): Readonly<T> {
  return strictJsonSnapshot(value) as unknown as Readonly<T>;
}
