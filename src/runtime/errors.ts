// Runtime 边界的 typed failures。正常的业务拒绝使用 OpReceipt；只有构造、端口、
// 订阅与存储权威性故障经这些 error 传播（docs/12“Event subscription”与“Durability 与恢复”）。

import type { ExternalOpId, ThreadId, WorkspaceId } from '../protocol/index.js';

export {
  EventCursorValidationError,
  EventSubscriptionGapError,
  RuntimeEventStreamError,
} from '../session/event-errors.js';
export type { EventCursorValidationCode } from '../session/event-errors.js';

export { RuntimeIdentityValidationError } from '../protocol/index.js';
export type { RuntimeIdentityValidationCode } from '../protocol/index.js';

export { RuntimeStorageError } from '../shared/runtime-storage-error.js';

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
