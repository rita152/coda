// CLI-only view types. CliRuntimeEvent and its listener are human-frontend projections of
// EventEnvelope.event, never a machine transport. Machine output must subscribe to the complete
// identity-bearing EventEnvelope instead of treating this projection as a second Runtime protocol.

import type {
  ApprovalControlDecision,
  EventEnvelope,
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
export type CliRuntimeEnvelopeListener = (
  envelope: Readonly<EventEnvelope>,
) => void | Promise<void>;

/** Frontend action for submitting decisions for durable Runtime controls. */
export interface CliControlActions {
  resolveApproval: (requestId: string, decision: CliApprovalDecision) => void;
}
