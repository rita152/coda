// Public protocol barrel: RuntimeOp and EventEnvelope are the canonical runtime boundary.
// Agent-loop payloads stay internal to the execution layer; this module has no runtime
// dependencies and may not import provider SDKs.
export * from './messages.js';
export * from './provider.js';
export type { PlanStep, QueuedMessage } from './agent-events.js';
export * from './event-stream.js';
export * from './strict-json.js';
export * from './identity.js';
export * from './runtime-ops.js';
export * from './runtime-events.js';
export * from './protocol-version.js';
