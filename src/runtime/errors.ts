// Runtime 边界的 typed failures。正常的业务拒绝使用 OpReceipt；只有构造、端口、
// 订阅与存储权威性故障经这些 error 传播（docs/12 §3.1）。

import type { ExternalOpId, ThreadId, WorkspaceId } from '../protocol/index.js';

export { RuntimeIdentityValidationError } from '../protocol/index.js';
export type { RuntimeIdentityValidationCode } from '../protocol/index.js';

export class RuntimeClosedError extends Error {
  override readonly name = 'RuntimeClosedError';
  readonly code = 'runtime_closed' as const;

  constructor() {
    super('Runtime is closing or closed');
  }
}

export class WorkspaceInUseError extends Error {
  override readonly name = 'WorkspaceInUseError';
  readonly code = 'workspace_in_use' as const;

  constructor(readonly workspaceId: WorkspaceId) {
    super(`Workspace ${workspaceId} already has a mutable Runtime`);
  }
}

export class WorkspaceBindingMismatchError extends Error {
  override readonly name = 'WorkspaceBindingMismatchError';
  readonly code = 'workspace_binding_mismatch' as const;

  constructor(
    readonly workspaceId: WorkspaceId,
    readonly recordedCwd: string,
    readonly requestedCwd: string,
  ) {
    super(`Workspace ${workspaceId} is bound to a different cwd`);
  }
}

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

export class RuntimeScopeDispatchError extends Error {
  override readonly name = 'RuntimeScopeDispatchError';
  readonly code = 'scope_dispatch_failed' as const;
  readonly retryable = true as const;

  constructor(
    readonly opId: ExternalOpId,
    readonly failedThreadIds: readonly ThreadId[],
  ) {
    super(`Scope operation ${opId} failed to reach ${failedThreadIds.length} thread(s)`);
  }
}

export class RuntimeStorageError extends Error {
  override readonly name = 'RuntimeStorageError';

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
