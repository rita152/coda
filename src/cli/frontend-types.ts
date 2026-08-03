// CLI-only view types. Human frontends consume canonical Runtime event payloads; machine
// transports consume the complete identity-bearing EventEnvelope directly.

import type {
  ApprovalControlDecision,
  RuntimeEvent,
  ThreadUsage,
} from '../protocol/index.js';

export type CliRuntimeEvent = RuntimeEvent;
export type CliThreadUsage = ThreadUsage;
export type CliInteractionState = 'idle' | 'running' | 'retrying' | 'compacting';
export type CliApprovalDecision = ApprovalControlDecision | 'abort';
export type CliRuntimeEventListener = (
  event: CliRuntimeEvent,
) => void | Promise<void>;

/** Frontend action for resolving durable approval controls. */
export interface CliApprovalBridge {
  resolve: (requestId: string, decision: CliApprovalDecision) => void;
}
