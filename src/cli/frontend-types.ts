// CLI-only view types. Frontends consume the legacy event projection, but they do not
// depend on Session: a RuntimePort facade and the exported Session can both implement
// these structurally compatible values during the Phase-1 migration.

import type {
  ApprovalControlDecision,
  LegacySessionEvent,
  ThreadUsage,
} from '../protocol/index.js';

export type CliSessionEvent = LegacySessionEvent;
export type CliSessionUsage = ThreadUsage;
export type CliInteractionState = 'idle' | 'running' | 'retrying' | 'compacting';
export type CliApprovalDecision = ApprovalControlDecision | 'abort';
export type CliSessionListener = (
  event: CliSessionEvent,
) => void | Promise<void>;
