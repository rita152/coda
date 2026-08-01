// Validate untrusted policy-port snapshots before they reach durable state or a driver.

import {
  isRunId,
  isThreadId,
  strictJsonSnapshot,
} from '../protocol/index.js';
import type {
  PermissionCeilingSnapshot,
  RunId,
  ThreadId,
} from '../protocol/index.js';

export interface ExpectedPermissionInheritance {
  readonly parentThreadId: ThreadId;
  readonly parentRunId?: RunId;
  readonly parentCeilingRevision: string;
}

export function validatePermissionCeilingSnapshot(
  value: unknown,
  expectedInheritance?: ExpectedPermissionInheritance,
): PermissionCeilingSnapshot {
  const snapshot = strictJsonSnapshot(value);
  if (!isRecord(snapshot)) throw new TypeError('Permission ceiling must be an object');
  assertExactKeys(snapshot, ['revision', 'constraints'], ['inheritedFrom']);
  if (!isNonEmptyString(snapshot.revision)) {
    throw new TypeError('Permission ceiling revision must be a non-empty string');
  }
  if (!Array.isArray(snapshot.constraints) || !snapshot.constraints.every(isRecord)) {
    throw new TypeError('Permission ceiling constraints must be an array of objects');
  }
  const inherited = snapshot.inheritedFrom;
  if (inherited !== undefined) {
    if (!isRecord(inherited)) throw new TypeError('Permission ceiling inheritance must be an object');
    assertExactKeys(inherited, ['parentThreadId', 'parentCeilingRevision'], ['parentRunId']);
    if (!isThreadId(inherited.parentThreadId)
      || (inherited.parentRunId !== undefined && !isRunId(inherited.parentRunId))
      || !isNonEmptyString(inherited.parentCeilingRevision)) {
      throw new TypeError('Permission ceiling inheritance has invalid identity');
    }
  }
  if (expectedInheritance !== undefined) {
    if (inherited === undefined
      || inherited.parentThreadId !== expectedInheritance.parentThreadId
      || inherited.parentRunId !== expectedInheritance.parentRunId
      || inherited.parentCeilingRevision !== expectedInheritance.parentCeilingRevision) {
      throw new TypeError('Permission ceiling inheritance does not match its parent input');
    }
  }
  return snapshot as Readonly<PermissionCeilingSnapshot>;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError('Permission ceiling has invalid fields');
  }
}
