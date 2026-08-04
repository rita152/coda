// Opaque runtime identities and canonical length-framed hash algorithms.
// Brands prevent accidental TypeScript mixing; runtime validators remain the trust boundary.

import { isWellFormedUnicode } from './strict-json.js';

export type WorkspaceId = string & { readonly __brand: 'WorkspaceId' };
export type ThreadId = string & { readonly __brand: 'ThreadId' };
export type RunId = string & { readonly __brand: 'RunId' };
export type TurnId = string & { readonly __brand: 'TurnId' };
export type OpId = string & { readonly __brand: 'OpId' };
export type ExternalOpId = OpId & { readonly __origin: 'external' };
export type DerivedOpId = OpId & { readonly __origin: 'derived' };

export type DerivedOpPurpose =
  | 'cancel_target'
  | 'control_recovery'
  | 'thread_result'
  | 'thread_close_on_runtime_close';

export type RuntimeIdentityValidationCode =
  | 'invalid_workspace_id'
  | 'invalid_thread_id'
  | 'invalid_workspace_cwd'
  | 'invalid_identity_input';

export class RuntimeIdentityValidationError extends TypeError {
  override readonly name = 'RuntimeIdentityValidationError';

  constructor(
    readonly code: RuntimeIdentityValidationCode,
    readonly field: string,
  ) {
    super(`Invalid runtime identity input: ${field} (${code})`);
  }
}

const WORKSPACE_DOMAIN = 'coda.runtime.workspace.v2';
const DERIVED_OP_DOMAIN = 'coda.runtime.derived-op.v1';
const INVOCATION_DOMAIN = 'coda.runtime.invocation.v1';
const EXTERNAL_OP_PATTERN = /^op_e_[0-9a-f]{32}$/;
const DERIVED_OP_PATTERN = /^op_d_[0-9a-f]{64}$/;
const DERIVED_PURPOSES = new Set<DerivedOpPurpose>([
  'cancel_target',
  'control_recovery',
  'thread_result',
  'thread_close_on_runtime_close',
]);

export function isWorkspaceId(value: unknown): value is WorkspaceId {
  return isOpaqueIdentity(value);
}

export function isThreadId(value: unknown): value is ThreadId {
  return isOpaqueIdentity(value);
}

export function isRunId(value: unknown): value is RunId {
  return isOpaqueIdentity(value);
}

export function isTurnId(value: unknown): value is TurnId {
  return isOpaqueIdentity(value);
}

export function isExternalOpId(value: unknown): value is ExternalOpId {
  return typeof value === 'string' && EXTERNAL_OP_PATTERN.test(value);
}

export function isDerivedOpId(value: unknown): value is DerivedOpId {
  return typeof value === 'string' && DERIVED_OP_PATTERN.test(value);
}

export function isOpId(value: unknown): value is OpId {
  return isExternalOpId(value) || isDerivedOpId(value);
}

export function assertWorkspaceId(value: unknown, field = 'workspaceId'): WorkspaceId {
  if (!isWorkspaceId(value)) {
    throw new RuntimeIdentityValidationError('invalid_workspace_id', field);
  }
  return value;
}

export function assertThreadId(value: unknown, field = 'threadId'): ThreadId {
  if (!isThreadId(value)) {
    throw new RuntimeIdentityValidationError('invalid_thread_id', field);
  }
  return value;
}

export function assertRunId(value: unknown, field = 'runId'): RunId {
  if (!isRunId(value)) throw new RuntimeIdentityValidationError('invalid_identity_input', field);
  return value;
}

export function assertTurnId(value: unknown, field = 'turnId'): TurnId {
  if (!isTurnId(value)) throw new RuntimeIdentityValidationError('invalid_identity_input', field);
  return value;
}

export function assertExternalOpId(value: unknown, field = 'opId'): ExternalOpId {
  if (!isExternalOpId(value)) {
    throw new RuntimeIdentityValidationError('invalid_identity_input', field);
  }
  return value;
}

export function assertDerivedOpId(value: unknown, field = 'opId'): DerivedOpId {
  if (!isDerivedOpId(value)) {
    throw new RuntimeIdentityValidationError('invalid_identity_input', field);
  }
  return value;
}

export function assertOpId(value: unknown, field = 'opId'): OpId {
  if (!isOpId(value)) throw new RuntimeIdentityValidationError('invalid_identity_input', field);
  return value;
}

/** Deterministically bind an absolute recorded cwd to the canonical workspace namespace. */
export function workspaceIdFromCwd(recordedCwd: string): WorkspaceId {
  assertWellFormedString(recordedCwd, 'recordedCwd');
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(WORKSPACE_DOMAIN);
  hasher.update(NUL_BYTE);
  hasher.update(UTF8.encode(recordedCwd));
  return `ws_v2_${hasher.digest('hex')}` as WorkspaceId;
}

/** Frozen length-framed, domain-separated derived-operation identity algorithm. */
export function deriveOpId(input: {
  readonly purpose: DerivedOpPurpose;
  readonly workspaceId: WorkspaceId;
  readonly parts: readonly string[];
}): DerivedOpId {
  try {
    if (input === null || typeof input !== 'object' || !DERIVED_PURPOSES.has(input.purpose)) {
      throw new RuntimeIdentityValidationError('invalid_identity_input', 'purpose');
    }
    const workspaceId = assertWorkspaceId(input.workspaceId);
    const parts = readDenseStringParts(input.parts);
    const purposeBytes = frame(input.purpose, 'purpose');
    const workspaceBytes = frame(workspaceId, 'workspaceId');
    const partFrames = parts.map((part, index) => frame(part, `parts[${index}]`));
    const hasher = new Bun.CryptoHasher('sha256');
    hasher.update(DERIVED_OP_DOMAIN);
    hasher.update(NUL_BYTE);
    hasher.update(purposeBytes);
    hasher.update(workspaceBytes);
    hasher.update(uint32be(parts.length));
    for (const part of partFrames) hasher.update(part);
    return `op_d_${hasher.digest('hex')}` as DerivedOpId;
  } catch (error) {
    if (error instanceof RuntimeIdentityValidationError) throw error;
    throw new RuntimeIdentityValidationError('invalid_identity_input', 'deriveOpId');
  }
}

/** Frozen length-framed, domain-separated per-turn invocation identity algorithm. */
export function deriveInvocationId(input: {
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly turnId: TurnId;
  readonly sourceOrdinal: number;
}): string {
  try {
    const workspaceId = assertWorkspaceId(input.workspaceId);
    const threadId = assertThreadId(input.threadId);
    const runId = assertRunId(input.runId);
    const turnId = assertTurnId(input.turnId);
    if (!Number.isSafeInteger(input.sourceOrdinal)
      || input.sourceOrdinal < 0
      || input.sourceOrdinal > 0xffff_ffff) {
      throw new RuntimeIdentityValidationError('invalid_identity_input', 'sourceOrdinal');
    }
    const hasher = new Bun.CryptoHasher('sha256');
    hasher.update(INVOCATION_DOMAIN);
    hasher.update(NUL_BYTE);
    hasher.update(frame(workspaceId, 'workspaceId'));
    hasher.update(frame(threadId, 'threadId'));
    hasher.update(frame(runId, 'runId'));
    hasher.update(frame(turnId, 'turnId'));
    hasher.update(uint32be(input.sourceOrdinal));
    return `inv_${hasher.digest('hex')}`;
  } catch (error) {
    if (error instanceof RuntimeIdentityValidationError) throw error;
    throw new RuntimeIdentityValidationError('invalid_identity_input', 'deriveInvocationId');
  }
}

function isOpaqueIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && isWellFormedUnicode(value);
}

function assertWellFormedString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !isWellFormedUnicode(value)) {
    throw new RuntimeIdentityValidationError('invalid_identity_input', field);
  }
}

const UTF8 = new TextEncoder();
const NUL_BYTE = new Uint8Array([0]);

function frame(value: unknown, field: string): Uint8Array {
  assertWellFormedString(value, field);
  const bytes = UTF8.encode(value);
  if (bytes.length > 0xffff_ffff) {
    throw new RuntimeIdentityValidationError('invalid_identity_input', field);
  }
  const result = new Uint8Array(4 + bytes.length);
  result.set(uint32be(bytes.length), 0);
  result.set(bytes, 4);
  return result;
}

function readDenseStringParts(value: unknown): string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new RuntimeIdentityValidationError('invalid_identity_input', 'parts');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const parts: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined
      || !('value' in descriptor)
      || descriptor.enumerable !== true
      || typeof descriptor.value !== 'string') {
      throw new RuntimeIdentityValidationError(
        'invalid_identity_input',
        `parts[${index}]`,
      );
    }
    parts.push(descriptor.value);
  }
  return parts;
}

function uint32be(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}
