// Canonical Runtime operation wire types and discriminator-aware admission validation.

import type { ModelRef } from './messages.js';
import {
  isExternalOpId,
  isRunId,
  isThreadId,
  isWorkspaceId,
} from './identity.js';
import type {
  DerivedOpId,
  ExternalOpId,
  OpId,
  RunId,
  ThreadId,
  WorkspaceId,
} from './identity.js';
import {
  canonicalJson,
  canonicalJsonSha256,
  isWellFormedUnicode,
  strictJsonSnapshot,
} from './strict-json.js';
import type { StrictJsonValue } from './strict-json.js';

export type ApprovalControlDecision = 'allow_once' | 'allow_always' | 'deny';
export type ResourceConfirmationDecision = 'confirm' | 'deny';
export type ControlResponseDecision = ApprovalControlDecision | ResourceConfirmationDecision;

export interface PermissionNarrowing {
  readonly revision: string;
  readonly constraints: readonly Readonly<Record<string, unknown>>[];
}

export interface PermissionCeilingSnapshot {
  readonly revision: string;
  readonly constraints: readonly Readonly<Record<string, unknown>>[];
  readonly inheritedFrom?: {
    readonly parentThreadId: ThreadId;
    readonly parentRunId?: RunId;
    readonly parentCeilingRevision: string;
  };
}

export type RuntimeOp =
  | { type: 'thread_create'; opId: ExternalOpId; workspaceId: WorkspaceId; threadId: ThreadId;
      model: ModelRef; parentThreadId?: ThreadId; createdByRunId?: RunId;
      permissionNarrowing?: PermissionNarrowing }
  | { type: 'thread_resume'; opId: ExternalOpId; workspaceId: WorkspaceId; threadId: ThreadId;
      model: ModelRef }
  | { type: 'prompt'; opId: ExternalOpId; workspaceId: WorkspaceId; threadId: ThreadId; text: string;
      permissionNarrowing?: PermissionNarrowing }
  | { type: 'continue'; opId: ExternalOpId; workspaceId: WorkspaceId; threadId: ThreadId;
      permissionNarrowing?: PermissionNarrowing }
  | { type: 'steer'; opId: ExternalOpId; workspaceId: WorkspaceId; threadId: ThreadId; text: string }
  | { type: 'follow_up'; opId: ExternalOpId; workspaceId: WorkspaceId; threadId: ThreadId; text: string }
  | { type: 'set_model'; opId: ExternalOpId; workspaceId: WorkspaceId; threadId: ThreadId;
      model: ModelRef }
  | { type: 'abort'; opId: ExternalOpId; workspaceId: WorkspaceId; threadId: ThreadId;
      expectedRunId?: RunId }
  | { type: 'control_response'; opId: ExternalOpId; workspaceId: WorkspaceId; threadId: ThreadId;
      requestId: string; decision: ControlResponseDecision }
  | { type: 'thread_close'; opId: ExternalOpId; workspaceId: WorkspaceId; threadId: ThreadId }
  | { type: 'cancel_scope'; opId: ExternalOpId; workspaceId: WorkspaceId;
      scope: 'workspace' | 'subtree'; rootThreadId?: ThreadId };

export type ResolvedAbortTarget =
  | { readonly kind: 'run'; readonly runId: RunId }
  | { readonly kind: 'suspended'; readonly ownerOpId: OpId;
      readonly terminalRunId: RunId; readonly inputOwnerOpId?: OpId }
  | { readonly kind: 'no_current_activity' };

export type ResolvedRunInput =
  | { readonly kind: 'prompt_input'; readonly sourceOpId: OpId; readonly text: string }
  | { readonly kind: 'existing_residue' };

export type InternalThreadRuntimeOp =
  | { type: 'abort'; opId: DerivedOpId; workspaceId: WorkspaceId; threadId: ThreadId;
      parentOpId: ExternalOpId; resolvedTarget: ResolvedAbortTarget }
  | { type: 'thread_close'; opId: DerivedOpId; workspaceId: WorkspaceId; threadId: ThreadId;
      parentOpId?: ExternalOpId };

export type ExternalThreadRuntimeOp = Exclude<
  RuntimeOp,
  { type: 'thread_create' | 'thread_resume' | 'cancel_scope' }
>;

export type MailboxRuntimeOp = ExternalThreadRuntimeOp | InternalThreadRuntimeOp;

export type OpReceipt =
  | { accepted: true; opId: ExternalOpId; duplicate: boolean; threadId?: ThreadId; runId?: RunId;
      targetThreadIds?: readonly ThreadId[] }
  | { accepted: false; opId: ExternalOpId; duplicate: boolean; reason: string; threadId?: ThreadId };

export type InternalOpReceipt =
  | { accepted: true; opId: DerivedOpId; duplicate: boolean; threadId: ThreadId }
  | { accepted: false; opId: DerivedOpId; duplicate: boolean; reason: string; threadId: ThreadId };

export type RuntimeOpValidationCode = 'invalid_external_op_id' | 'invalid_runtime_op';

export class RuntimeOpValidationError extends TypeError {
  override readonly name = 'RuntimeOpValidationError';

  constructor(
    readonly code: RuntimeOpValidationCode,
    readonly rawOpId?: string,
  ) {
    super(code === 'invalid_external_op_id'
      ? 'Runtime operation has an invalid external operation id'
      : 'Runtime operation is not a canonical RuntimeOp');
  }
}

const REQUIRED_KEYS: Readonly<Record<RuntimeOp['type'], readonly string[]>> = {
  thread_create: ['type', 'opId', 'workspaceId', 'threadId', 'model'],
  thread_resume: ['type', 'opId', 'workspaceId', 'threadId', 'model'],
  prompt: ['type', 'opId', 'workspaceId', 'threadId', 'text'],
  continue: ['type', 'opId', 'workspaceId', 'threadId'],
  steer: ['type', 'opId', 'workspaceId', 'threadId', 'text'],
  follow_up: ['type', 'opId', 'workspaceId', 'threadId', 'text'],
  set_model: ['type', 'opId', 'workspaceId', 'threadId', 'model'],
  abort: ['type', 'opId', 'workspaceId', 'threadId'],
  control_response: ['type', 'opId', 'workspaceId', 'threadId', 'requestId', 'decision'],
  thread_close: ['type', 'opId', 'workspaceId', 'threadId'],
  cancel_scope: ['type', 'opId', 'workspaceId', 'scope'],
};

const OPTIONAL_KEYS: Readonly<Record<RuntimeOp['type'], readonly string[]>> = {
  thread_create: ['parentThreadId', 'createdByRunId', 'permissionNarrowing'],
  thread_resume: [],
  prompt: ['permissionNarrowing'],
  continue: ['permissionNarrowing'],
  steer: [],
  follow_up: [],
  set_model: [],
  abort: ['expectedRunId'],
  control_response: [],
  thread_close: [],
  cancel_scope: ['rootThreadId'],
};

/**
 * Validate and detach an external operation before ledger lookup.
 * Only known top-level optional fields normalize explicit undefined to omission.
 */
export function canonicalizeRuntimeOp(input: unknown): Readonly<RuntimeOp> {
  let rawOpId: unknown;
  try {
    rawOpId = extractRawOpId(input);
  } catch {
    throw new RuntimeOpValidationError('invalid_runtime_op');
  }
  if (!isExternalOpId(rawOpId)) {
    throw new RuntimeOpValidationError(
      'invalid_external_op_id',
      typeof rawOpId === 'string' ? rawOpId : undefined,
    );
  }

  try {
    const source = getPlainDataRecord(input);
    const typeValue = source.type;
    if (!isRuntimeOpType(typeValue)) throw new Error('unknown RuntimeOp type');
    const normalized = normalizeTopLevel(source, typeValue);
    const snapshot = strictJsonSnapshot(normalized);
    if (!isRecord(snapshot)) throw new Error('RuntimeOp must be an object');
    validateRuntimeOpRecord(snapshot, typeValue);
    return Object.freeze(snapshot) as Readonly<RuntimeOp>;
  } catch (error) {
    if (error instanceof RuntimeOpValidationError) throw error;
    throw new RuntimeOpValidationError(
      'invalid_runtime_op',
      typeof rawOpId === 'string' ? rawOpId : undefined,
    );
  }
}

/** Stable canonical bytes used by the workspace-wide operation ledger. */
export function canonicalRuntimeOpJson(input: unknown): string {
  return canonicalJson(canonicalizeRuntimeOp(input));
}

/** Full lowercase SHA-256 of a validated operation's canonical bytes. */
export function runtimeOpPayloadHash(input: unknown): string {
  return canonicalJsonSha256(canonicalizeRuntimeOp(input));
}

function extractRawOpId(input: unknown): unknown {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(input, 'opId');
  if (descriptor === undefined || !('value' in descriptor)) return undefined;
  return descriptor.value;
}

function getPlainDataRecord(input: unknown): Readonly<Record<string, unknown>> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('RuntimeOp must be a plain object');
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('RuntimeOp must be a plain object');
  }
  const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !isWellFormedUnicode(key)) throw new Error('Invalid RuntimeOp key');
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw new Error('RuntimeOp properties must be enumerable data properties');
    }
    record[key] = descriptor.value;
  }
  return record;
}

function normalizeTopLevel(
  source: Readonly<Record<string, unknown>>,
  type: RuntimeOp['type'],
): Record<string, unknown> {
  const required = new Set(REQUIRED_KEYS[type]);
  const optional = new Set(OPTIONAL_KEYS[type]);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) throw new Error(`Unknown RuntimeOp field: ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(source, key)) throw new Error(`Missing RuntimeOp field: ${key}`);
  }

  const normalized: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of [...REQUIRED_KEYS[type], ...OPTIONAL_KEYS[type]]) {
    if (!Object.hasOwn(source, key)) continue;
    const value = source[key];
    if (optional.has(key) && value === undefined) continue;
    normalized[key] = value;
  }
  return normalized;
}

function validateRuntimeOpRecord(
  op: Readonly<Record<string, StrictJsonValue>>,
  type: RuntimeOp['type'],
): void {
  if (op.type !== type) throw new Error('RuntimeOp discriminator changed');
  if (!isExternalOpId(op.opId)) throw new Error('Invalid external operation id');
  if (!isWorkspaceId(op.workspaceId)) throw new Error('Invalid workspace id');

  if (type !== 'cancel_scope') {
    if (!isThreadId(op.threadId)) throw new Error('Invalid thread id');
  }

  switch (type) {
    case 'thread_create':
      validateModelRef(op.model);
      validateOptionalThreadId(op.parentThreadId);
      validateOptionalRunId(op.createdByRunId);
      validateOptionalPermissionNarrowing(op.permissionNarrowing);
      break;
    case 'thread_resume':
    case 'set_model':
      validateModelRef(op.model);
      break;
    case 'prompt':
      requireString(op.text);
      validateOptionalPermissionNarrowing(op.permissionNarrowing);
      break;
    case 'continue':
      validateOptionalPermissionNarrowing(op.permissionNarrowing);
      break;
    case 'steer':
    case 'follow_up':
      requireString(op.text);
      break;
    case 'abort':
      validateOptionalRunId(op.expectedRunId);
      break;
    case 'control_response':
      requireString(op.requestId);
      if (!isControlResponseDecision(op.decision)) throw new Error('Invalid control decision');
      break;
    case 'thread_close':
      break;
    case 'cancel_scope':
      if (op.scope !== 'workspace' && op.scope !== 'subtree') throw new Error('Invalid cancel scope');
      if (op.scope === 'workspace' && op.rootThreadId !== undefined) {
        throw new Error('Workspace cancel cannot have a root thread');
      }
      if (op.scope === 'subtree' && !isThreadId(op.rootThreadId)) {
        throw new Error('Subtree cancel requires a root thread');
      }
      break;
  }
}

function validateModelRef(value: StrictJsonValue | undefined): void {
  if (!isRecord(value)) throw new Error('Invalid model reference');
  assertExactKeys(value, ['provider', 'api', 'model']);
  requireString(value.provider);
  requireString(value.api);
  requireString(value.model);
}

function validateOptionalPermissionNarrowing(value: StrictJsonValue | undefined): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new Error('Invalid permission narrowing');
  assertExactKeys(value, ['revision', 'constraints']);
  requireString(value.revision);
  if (!Array.isArray(value.constraints)) throw new Error('Invalid permission constraints');
  for (const constraint of value.constraints) {
    if (!isRecord(constraint)) throw new Error('Invalid permission constraint');
  }
}

function validateOptionalThreadId(value: StrictJsonValue | undefined): void {
  if (value !== undefined && !isThreadId(value)) throw new Error('Invalid thread id');
}

function validateOptionalRunId(value: StrictJsonValue | undefined): void {
  if (value !== undefined && !isRunId(value)) throw new Error('Invalid run id');
}

function assertExactKeys(
  value: Readonly<Record<string, StrictJsonValue>>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || expected.some((key) => !Object.hasOwn(value, key))) {
    throw new Error('Unexpected object fields');
  }
}

function requireString(value: StrictJsonValue | undefined): asserts value is string {
  if (typeof value !== 'string') throw new Error('Expected a string');
}

function isControlResponseDecision(value: StrictJsonValue | undefined): value is ControlResponseDecision {
  return value === 'allow_once'
    || value === 'allow_always'
    || value === 'deny'
    || value === 'confirm';
}

function isRuntimeOpType(value: unknown): value is RuntimeOp['type'] {
  return typeof value === 'string' && Object.hasOwn(REQUIRED_KEYS, value);
}

function isRecord(value: unknown): value is Readonly<Record<string, StrictJsonValue>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
