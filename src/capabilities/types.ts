import type {
  AgentMessage,
  Context,
  ExternalOpId,
  ImagePart,
  JSONSchema,
  ModelApi,
  ModelRef,
  OpId,
  PermissionCeilingSnapshot,
  PolicyGrantScope,
  RunId,
  StreamFn,
  TextPart,
  ThreadId,
  TurnId,
  WorkspaceId,
} from '../protocol/index.js';
import type { FileTrackerPort } from '../shared/index.js';

export type CapabilityValidation =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string };

export interface CapabilityResult {
  readonly content: (TextPart | ImagePart)[];
  readonly details?: unknown;
  readonly terminate?: boolean;
}

export type CapabilityValidator = (input: unknown) => CapabilityValidation;

export type CapabilityExecutor = (
  input: unknown,
  context: CapabilityExecutionContext,
) => Promise<CapabilityResult>;

export type CapabilityResourceType = 'filesystem' | 'command' | 'network' | 'other';
export type CapabilityResourceAccess = 'read' | 'write' | 'execute' | 'connect';

export interface CapabilityResourceSelector {
  readonly selectorId: string;
  readonly resourceType: CapabilityResourceType;
  readonly argumentPointer: string;
  readonly access: CapabilityResourceAccess;
  readonly required?: boolean;
}

export interface CapabilityPolicyDescriptor {
  readonly kind: 'read' | 'search' | 'edit' | 'execute' | 'plan';
  readonly resources: readonly CapabilityResourceSelector[];
  readonly attributes?: Readonly<Record<string, unknown>>;
}

export interface ResolvedCapabilityResource {
  readonly selectorId: string;
  readonly resourceType: CapabilityResourceType;
  readonly access: CapabilityResourceAccess;
  readonly canonicalTarget: string;
}

export type CapabilityAnalysisReasons = readonly [string, ...string[]];

/**
 * Resolver-owned, strict-JSON policy facts frozen into the PreparedInvocation.
 *
 * `resourceCoverage` describes whether every policy-relevant resource could be represented;
 * `grantability` independently records whether an otherwise complete invocation may be persisted;
 * and `safety` carries an authoritative capability-specific deny without asking generic policy to
 * reinterpret arguments. Adapter-specific presentation/compatibility facts live in `attributes`.
 */
export interface CapabilityInvocationAnalysis {
  readonly resourceCoverage:
    | { readonly kind: 'complete' }
    | { readonly kind: 'incomplete'; readonly reasons: CapabilityAnalysisReasons };
  readonly grantability:
    | { readonly kind: 'persistable' }
    | { readonly kind: 'once_only'; readonly reasons: CapabilityAnalysisReasons };
  readonly safety:
    | { readonly kind: 'eligible' }
    | {
        readonly kind: 'deny';
        readonly code: string;
        readonly reason: string;
      };
  readonly attributes: Readonly<Record<string, unknown>>;
}

export type CapabilityResourceResolution =
  | {
      readonly ok: true;
      readonly resources: readonly Readonly<ResolvedCapabilityResource>[];
      readonly analysis?: Readonly<CapabilityInvocationAnalysis>;
    }
  | {
      readonly ok: false;
      readonly code: 'resource_resolution_failed' | 'ambiguous_resource';
      readonly message: string;
    };

export type CapabilityResourceResolver = (
  args: unknown,
  context: Readonly<InvocationContext>,
) => Promise<CapabilityResourceResolution>;

export interface TurnPolicyContext {
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly turnId: TurnId;
  readonly cwd: string;
}

export interface RuleSnapshotBudget {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxBytes: number;
  readonly maxPromptTokens: number;
}

export interface RuleSnapshotDiagnostic {
  readonly code: 'rule_skipped' | 'rule_budget_exhausted' | 'rule_unreadable';
  readonly path?: string;
  readonly message: string;
}

export interface RuleSnapshot {
  readonly revision: string;
  readonly owner: Readonly<TurnPolicyContext>;
  readonly discovery: {
    readonly knownResourceScopes: readonly string[];
    readonly budget: Readonly<RuleSnapshotBudget>;
    readonly diagnostics: readonly Readonly<RuleSnapshotDiagnostic>[];
  };
  readonly files: readonly {
    readonly path: string;
    readonly scope: string;
    readonly contentDigest: string;
    readonly content: string;
  }[];
}

export type RuleSnapshotCaptureResult =
  | { readonly ok: true; readonly snapshot: Readonly<RuleSnapshot> }
  | {
      readonly ok: false;
      readonly code: 'rule_discovery_failed' | 'invalid_rule_snapshot';
      readonly message: string;
    };

export interface RuleSnapshotProvider {
  capture(input: {
    readonly context: Readonly<TurnPolicyContext>;
    readonly knownResourceScopes: readonly string[];
    readonly budget: Readonly<RuleSnapshotBudget>;
  }): Promise<RuleSnapshotCaptureResult>;
}

export interface BasePromptSnapshot {
  readonly owner: Readonly<TurnPolicyContext>;
  readonly model: Readonly<ModelRef>;
  readonly revision: string;
  readonly content: string;
}

export interface PromptModelView {
  readonly ref: Readonly<ModelRef>;
  readonly limits?: { readonly context: number; readonly output: number };
}

export interface BasePromptProvider {
  capture(input: {
    readonly context: Readonly<TurnPolicyContext>;
    readonly model: Readonly<PromptModelView>;
  }): Promise<Readonly<BasePromptSnapshot>>;
}

export interface EffectivePolicySnapshot {
  readonly context: Readonly<TurnPolicyContext>;
  readonly revision: string;
  readonly policyBasisRevision: string;
  readonly ceilingRevision: string;
  readonly grantRevision: string;
  readonly constraints: readonly Readonly<Record<string, unknown>>[];
  readonly rules: Readonly<RuleSnapshot>;
}

export interface InvocationContext {
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly turnId: TurnId;
  readonly opId?: OpId;
  readonly invocationId: string;
  readonly toolCallId: string;
  readonly capabilityId: string;
  readonly catalogRevision: number;
  readonly cwd: string;
}

export interface CapabilityExecutionServices {
  readonly fileTracker: FileTrackerPort;
}

export interface CapabilityExecutionContext extends InvocationContext {
  readonly signal: AbortSignal;
  readonly onUpdate: (update: Readonly<Record<string, unknown>>) => void;
  readonly services: CapabilityExecutionServices;
}

export interface CapabilityRegistration {
  readonly id: string;
  readonly version: string;
  readonly implementationDigest: string;
  readonly description: string;
  readonly inputSchema: JSONSchema;
  readonly promptSnippet?: string;
  readonly executionMode?: 'sequential';
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly policy: Readonly<CapabilityPolicyDescriptor>;
  readonly prepare?: (input: unknown) => unknown;
  readonly validate: CapabilityValidator;
  readonly resolveResources: CapabilityResourceResolver;
  readonly execute: CapabilityExecutor;
}

export type CapabilityCatalogEntry = Readonly<
  Omit<CapabilityRegistration, 'executionMode'> & {
    readonly executionMode: 'parallel' | 'sequential';
    readonly registrationDigest: string;
  }
>;

export type RegistryMutationResult =
  | { readonly ok: true; readonly revision: number }
  | {
      readonly ok: false;
      readonly code:
        | 'duplicate_capability'
        | 'capability_not_found'
        | 'revision_conflict'
        | 'invalid_registration';
      readonly message: string;
      readonly revision: number;
    };

export type PrepareInvocationResult =
  | { readonly ok: true; readonly invocation: Readonly<PreparedInvocation> }
  | {
      readonly ok: false;
      readonly code:
        | 'unknown_capability'
        | 'invalid_arguments'
        | 'prepare_failed'
        | 'resource_resolution_failed'
        | 'ambiguous_resource'
        | 'invalid_prepared_value'
        | 'invalid_invocation_context';
      readonly message: string;
    };

export interface CapabilityRegistry {
  register(registration: CapabilityRegistration): RegistryMutationResult;
  update(
    capabilityId: string,
    registration: CapabilityRegistration,
    options?: { readonly expectedRevision?: number },
  ): RegistryMutationResult;
  unregister(
    capabilityId: string,
    options?: { readonly expectedRevision?: number },
  ): RegistryMutationResult;
  snapshot(): ToolCatalogSnapshot;
}

export interface CapabilityRegistryReader {
  snapshot(): ToolCatalogSnapshot;
}

export interface ToolCatalogSnapshot {
  readonly revision: number;
  readonly entries: readonly CapabilityCatalogEntry[];
  resolve(capabilityId: string): CapabilityCatalogEntry | undefined;
  prepare(input: {
    readonly capabilityId: string;
    readonly rawArgs: unknown;
    readonly context: Readonly<InvocationContext>;
    readonly effectivePolicy: Readonly<EffectivePolicySnapshot>;
  }): Promise<PrepareInvocationResult>;
}

export interface PreparedInvocation {
  readonly capabilityVersion: string;
  readonly registrationDigest: string;
  readonly description: string;
  readonly inputSchema: Readonly<JSONSchema>;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly policy: Readonly<CapabilityPolicyDescriptor>;
  readonly effectivePolicy: Readonly<EffectivePolicySnapshot>;
  readonly executionMode: 'parallel' | 'sequential';
  readonly args: unknown;
  readonly resources: readonly Readonly<ResolvedCapabilityResource>[];
  readonly analysis: Readonly<CapabilityInvocationAnalysis>;
  readonly context: Readonly<InvocationContext>;
  readonly validator: CapabilityValidator;
  readonly executor: CapabilityExecutor;
}

export interface PromptAssemblyInput {
  readonly basePrompt: Readonly<BasePromptSnapshot>;
  readonly outboundMessages: readonly Readonly<AgentMessage>[];
  readonly effectivePolicy: Readonly<EffectivePolicySnapshot>;
  readonly model: Readonly<PromptModelView>;
  readonly catalog: ToolCatalogSnapshot;
}

export type PromptAssemblyResult =
  | { readonly ok: true; readonly context: Readonly<Context> }
  | {
      readonly ok: false;
      readonly code: 'invalid_prompt_context' | 'invalid_prompt_input';
      readonly message: string;
    };

export interface PromptAssembler {
  assemble(input: PromptAssemblyInput): PromptAssemblyResult;
}

export type PolicyDecision =
  | { readonly kind: 'allow'; readonly code: string; readonly reason: string }
  | {
      readonly kind: 'deny';
      readonly code: string;
      readonly reason: string;
      readonly recoverable: true;
    }
  | {
      readonly kind: 'ask';
      readonly code: string;
      readonly reason: string;
      readonly description: string;
      readonly grantProposal?: Readonly<PolicyGrantScope>;
    };

export interface PolicyGrant {
  readonly grantId: ExternalOpId;
  readonly workspaceId: WorkspaceId;
  readonly capabilityId: string;
  readonly capabilityVersion: string;
  readonly registrationDigest: string;
  readonly scope: Readonly<PolicyGrantScope>;
  readonly policyBasisRevision: string;
  readonly acceptedAt: number;
}

export interface PolicyGrantSnapshot {
  readonly workspaceId: WorkspaceId;
  readonly revision: string;
  readonly grants: readonly Readonly<PolicyGrant>[];
}

export type PolicyGrantCommitResult =
  | { readonly kind: 'applied' | 'duplicate'; readonly revision: string }
  | { readonly kind: 'definitely_not_applied'; readonly message: string }
  | { readonly kind: 'conflict'; readonly revision: string; readonly message: string }
  | {
      readonly kind: 'fenced';
      readonly code: 'stale_fence' | 'wrong_workspace';
      readonly message: string;
    };

export interface PolicyGrantRepositoryPort {
  readonly workspaceId: WorkspaceId;
  readonly mode: 'workspace';
  snapshot(): Promise<Readonly<PolicyGrantSnapshot>>;
  commitAllowAlways(grant: Readonly<PolicyGrant>): Promise<PolicyGrantCommitResult>;
}

export interface PolicyGrantRepository extends PolicyGrantRepositoryPort {
  startupDiagnostics?(): readonly { readonly code: string; readonly message: string }[];
  close(): Promise<void>;
}

export type RuleFreshnessResult =
  | { readonly fresh: true }
  | {
      readonly fresh: false;
      readonly code: 'rule_scope_missing';
      readonly missingScopes: readonly [string, ...string[]];
      readonly message: string;
    }
  | { readonly fresh: false; readonly code: 'rule_changed'; readonly message: string };

export interface RuleFreshnessPort {
  check(input: {
    readonly snapshot: Readonly<RuleSnapshot>;
    readonly context: Readonly<InvocationContext>;
    readonly resources: readonly Readonly<ResolvedCapabilityResource>[];
    readonly analysis: Readonly<CapabilityInvocationAnalysis>;
  }): Promise<RuleFreshnessResult>;
}

export interface ThreadPolicyEngine {
  capture(input: {
    readonly context: Readonly<TurnPolicyContext>;
    readonly workspaceCeiling: Readonly<PermissionCeilingSnapshot>;
    readonly runCeiling: Readonly<PermissionCeilingSnapshot>;
    readonly turnCeiling: Readonly<PermissionCeilingSnapshot>;
    readonly rules: Readonly<RuleSnapshot>;
    readonly grants: Readonly<PolicyGrantSnapshot>;
  }): Promise<Readonly<EffectivePolicySnapshot>>;
  evaluate(invocation: Readonly<PreparedInvocation>): Promise<PolicyDecision>;
  close(): Promise<void>;
}

export interface PolicyEngine {
  openThread(input: {
    readonly workspaceId: WorkspaceId;
    readonly threadId: ThreadId;
  }): Promise<ThreadPolicyEngine>;
}

/** Immutable host policy material included in every policy-basis revision from this factory. */
export interface PolicyEngineOptions {
  readonly configuration?: Readonly<Record<string, unknown>>;
}

export interface ProviderAdapterRegistration {
  readonly api: ModelApi;
  readonly version: string;
  readonly implementationDigest: string;
  readonly stream: StreamFn;
}

export type ProviderAdapterEntry = Readonly<ProviderAdapterRegistration> & {
  readonly registrationDigest: string;
};

export type ProviderRegistryMutationResult =
  | { readonly ok: true; readonly revision: number }
  | {
      readonly ok: false;
      readonly code:
        | 'duplicate_provider_adapter'
        | 'provider_adapter_not_found'
        | 'revision_conflict'
        | 'invalid_provider_adapter';
      readonly message: string;
      readonly revision: number;
    };

export interface ProviderAdapterSnapshot {
  readonly revision: number;
  readonly entries: readonly ProviderAdapterEntry[];
  resolve(api: ModelApi): ProviderAdapterEntry | undefined;
}

export interface ProviderAdapterRegistry {
  register(registration: ProviderAdapterRegistration): ProviderRegistryMutationResult;
  update(
    api: ModelApi,
    registration: ProviderAdapterRegistration,
    options?: { readonly expectedRevision?: number },
  ): ProviderRegistryMutationResult;
  unregister(
    api: ModelApi,
    options?: { readonly expectedRevision?: number },
  ): ProviderRegistryMutationResult;
  snapshot(): ProviderAdapterSnapshot;
}

export interface ProviderAdapterRegistryReader {
  snapshot(): ProviderAdapterSnapshot;
}

export interface RuntimeCapabilityServices {
  readonly capabilities: CapabilityRegistryReader;
  readonly providers: ProviderAdapterRegistryReader;
  readonly promptAssembler: PromptAssembler;
  readonly basePrompts: BasePromptProvider;
  readonly ruleSnapshots: RuleSnapshotProvider;
  readonly ruleBudget: Readonly<RuleSnapshotBudget>;
  readonly policyEngine: PolicyEngine;
  readonly ruleFreshness: RuleFreshnessPort;
  readonly grantMode: PolicyGrantRepository['mode'];
}
