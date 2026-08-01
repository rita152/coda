// Public, embeddable Runtime entry. Keep this module declarative: importing coda/runtime must not
// inspect process state, touch storage, install signal handlers, or initialize concrete adapters.

export * from '../protocol/identity.js';
export * from '../protocol/runtime-ops.js';
export * from '../protocol/runtime-events.js';
export { PROTOCOL_VERSION } from '../protocol/protocol-version.js';
export type {
  AgentMessage,
  AssistantMessage,
  Context,
  ModelApi,
  ModelRef,
  ToolResultMessage,
  Usage,
  UserMessage,
} from '../protocol/messages.js';
export type { PlanStep, QueuedMessage } from '../protocol/agent-events.js';
export type { CompatFlags, ModelConfig } from '../protocol/provider.js';
export type {
  BasePromptProvider,
  BasePromptSnapshot,
  CapabilityAnalysisReasons,
  CapabilityInvocationAnalysis,
  CapabilityRegistryReader,
  EffectivePolicySnapshot,
  InvocationContext,
  PolicyDecision,
  PolicyEngine,
  PolicyEngineOptions,
  PolicyGrant,
  PolicyGrantCommitResult,
  PolicyGrantRepository,
  PolicyGrantRepositoryPort,
  PolicyGrantSnapshot,
  PreparedInvocation,
  PromptAssembler,
  PromptAssemblyInput,
  PromptAssemblyResult,
  PromptModelView,
  ProviderAdapterRegistryReader,
  ProviderAdapterSnapshot,
  ResolvedCapabilityResource,
  RuleFreshnessPort,
  RuleFreshnessResult,
  RuleSnapshot,
  RuleSnapshotBudget,
  RuleSnapshotCaptureResult,
  RuleSnapshotDiagnostic,
  RuleSnapshotProvider,
  RuntimeCapabilityServices,
  ThreadPolicyEngine,
  ToolCatalogSnapshot,
  TurnPolicyContext,
} from '../capabilities/types.js';

export * from './errors.js';
export type { EventSubscriptionOptions } from './event-stream.js';
export { createFileRuntimeStorage } from './file-storage.js';
export type { FileRuntimeStorageOptions } from './file-storage.js';
export { createMemoryRuntimeStorage } from './memory-storage.js';
export type { MemoryRuntimeStorage } from './memory-storage.js';
export * from './ports.js';
export { createRuntime } from './supervisor.js';
export type {
  CreateRuntimeBaseOptions,
  CreateRuntimeOptions,
  RegistryCreateRuntimeOptions,
  RuntimePort,
  StaticCreateRuntimeOptions,
} from './supervisor.js';
