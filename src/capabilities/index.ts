// Public capability composition surface. Concrete tools and providers stay behind explicit adapters.

export { createCapabilityRegistry } from './capability-registry.js';
export { createPolicyEngine } from './policy-engine.js';
export { createPromptAssembler } from './prompt-assembler.js';
export { createProviderAdapterRegistry } from './provider-registry.js';
export type * from './types.js';
