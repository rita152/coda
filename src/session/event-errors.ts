// Session-layer event channel failures. Runtime re-exports these classes so public callers keep
// stable instanceof semantics while the EventHub remains independent of the workspace Supervisor.

import type { ThreadId } from '../protocol/index.js';

export type EventCursorValidationCode =
  | 'invalid_thread_id'
  | 'duplicate_thread_filter'
  | 'empty_thread_filter'
  | 'duplicate_cursor'
  | 'cursor_outside_filter'
  | 'invalid_after_seq'
  | 'cursor_ahead';

export class EventCursorValidationError extends Error {
  override readonly name = 'EventCursorValidationError';

  constructor(
    readonly code: EventCursorValidationCode,
    readonly threadId?: ThreadId,
  ) {
    super(threadId === undefined ? code : `${code}: ${threadId}`);
  }
}

export class EventSubscriptionGapError extends Error {
  override readonly name = 'EventSubscriptionGapError';
  readonly code = 'event_subscription_gap' as const;

  constructor(
    readonly threadId: ThreadId,
    readonly lastDeliveredSeq: number,
    readonly nextAvailableSeq?: number,
  ) {
    super(`Event subscription for ${threadId} has a gap after seq ${lastDeliveredSeq}`);
  }
}

export class RuntimeEventStreamError extends Error {
  override readonly name = 'RuntimeEventStreamError';
  readonly code = 'runtime_event_stream_fatal' as const;

  constructor(
    readonly causeCode: string,
    readonly threadId?: ThreadId,
  ) {
    super(threadId === undefined
      ? `Runtime event stream failed: ${causeCode}`
      : `Runtime event stream for ${threadId} failed: ${causeCode}`);
  }
}
