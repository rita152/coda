// CLI-only view types. Human frontends receive the event payload projected from EventEnvelope;
// machine transports consume the complete identity-bearing envelope directly. This is not a
// second Runtime event protocol.

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

/** Frontend action for submitting decisions for durable Runtime controls. */
export interface CliControlActions {
  resolveApproval: (requestId: string, decision: CliApprovalDecision) => void;
}
