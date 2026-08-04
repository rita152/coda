// Internal canonical policy-grant validation shared by storage implementations. Transaction,
// fencing, durability, and failure-outcome semantics remain owned by each concrete boundary.

import type {
  PolicyGrant,
  PolicyGrantCommitResult,
  PolicyGrantSnapshot,
} from '../capabilities/types.js';
import {
  assertWorkspaceId,
  canonicalJson,
  canonicalJsonSha256,
  isExternalOpId,
  isWellFormedUnicode,
  strictJsonSnapshot,
} from '../protocol/index.js';
import type { WorkspaceId } from '../protocol/index.js';
import { compareUtf8, RuntimeStorageError } from '../shared/index.js';

export function validatePolicyGrant(
  input: unknown,
  workspaceId: WorkspaceId,
  code = 'invalid_policy_grant',
): Readonly<PolicyGrant> {
  let value: unknown;
  try {
    value = strictJsonSnapshot(input);
  } catch (error) {
    throw invalidPolicyGrant(code, error);
  }
  if (!isRecord(value)) throw invalidPolicyGrant(code);
  assertExactKeys(value, [
    'grantId',
    'workspaceId',
    'capabilityId',
    'capabilityVersion',
    'registrationDigest',
    'scope',
    'policyBasisRevision',
    'acceptedAt',
  ], code);
  if (!isExternalOpId(value.grantId)
    || !isWorkspaceIdValue(value.workspaceId)
    || value.workspaceId !== workspaceId
    || !isNonEmptyWellFormedString(value.capabilityId)
    || !isNonEmptyWellFormedString(value.capabilityVersion)
    || !isNonEmptyWellFormedString(value.registrationDigest)
    || !isNonEmptyWellFormedString(value.policyBasisRevision)
    || typeof value.acceptedAt !== 'number'
    || !Number.isSafeInteger(value.acceptedAt)
    || value.acceptedAt < 0) {
    throw invalidPolicyGrant(code);
  }
  validateCanonicalPolicyGrantScope(value.scope, code);
  return value as unknown as Readonly<PolicyGrant>;
}

export function workspacePolicyGrantSnapshot(
  workspaceId: WorkspaceId,
  grants: Iterable<Readonly<PolicyGrant>>,
): Readonly<PolicyGrantSnapshot> {
  const copied = [...grants].map((grant) => snapshot(grant));
  return snapshot({
    workspaceId,
    revision: `policy-grants-v1-${canonicalJsonSha256({ workspaceId, grants: copied })}`,
    grants: copied,
  });
}

export function policyGrantFenced(
  code: 'stale_fence' | 'wrong_workspace',
  message: string,
): Extract<PolicyGrantCommitResult, { kind: 'fenced' }> {
  return { kind: 'fenced', code, message };
}

function validateCanonicalPolicyGrantScope(input: unknown, code: string): void {
  if (!isRecord(input)) throw invalidPolicyGrant(code);
  assertExactKeys(input, ['kind', 'resourcePatterns', 'attributes'], code);
  if (input.kind !== 'canonical_resources_v1'
    || !Array.isArray(input.resourcePatterns)
    || input.resourcePatterns.length === 0
    || !isRecord(input.attributes)) {
    throw invalidPolicyGrant(code);
  }
  const canonicalPatterns: string[] = [];
  for (const pattern of input.resourcePatterns) {
    if (!isRecord(pattern)) throw invalidPolicyGrant(code);
    assertExactKeys(pattern, ['resourceType', 'access', 'matcher', 'pattern'], code);
    if (!isPolicyGrantResourceType(pattern.resourceType)
      || !isPolicyGrantResourceAccess(pattern.access)
      || pattern.matcher !== 'canonical_target_exact_v1'
      || !isNonEmptyWellFormedString(pattern.pattern)) {
      throw invalidPolicyGrant(code);
    }
    canonicalPatterns.push(canonicalJson(pattern));
  }
  for (let index = 1; index < canonicalPatterns.length; index++) {
    if (compareUtf8(canonicalPatterns[index - 1]!, canonicalPatterns[index]!) >= 0) {
      throw invalidPolicyGrant(code);
    }
  }
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  code: string,
): void {
  if (Object.keys(value).length !== required.length
    || required.some((key) => !Object.hasOwn(value, key))) {
    throw invalidPolicyGrant(code);
  }
}

function invalidPolicyGrant(code: string, error?: unknown): RuntimeStorageError {
  const detail = error instanceof Error ? `: ${error.message}` : '';
  return new RuntimeStorageError(code, `Invalid policy grant${detail}`);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isWorkspaceIdValue(value: unknown): value is WorkspaceId {
  try {
    assertWorkspaceId(value);
    return true;
  } catch {
    return false;
  }
}

function isNonEmptyWellFormedString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && isWellFormedUnicode(value);
}

function isPolicyGrantResourceType(value: unknown): boolean {
  return value === 'filesystem' || value === 'command' || value === 'network' || value === 'other';
}

function isPolicyGrantResourceAccess(value: unknown): boolean {
  return value === 'read' || value === 'write' || value === 'execute' || value === 'connect';
}

function snapshot<T>(value: T): T {
  return strictJsonSnapshot(value) as T;
}
