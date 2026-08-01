import { describe, expect, test } from 'bun:test';

import { assertExternalOpId, assertThreadId, assertWorkspaceId, deriveOpId } from './identity.js';
import {
  canonicalRuntimeOpJson,
  canonicalizeRuntimeOp,
  RuntimeOpValidationError,
  runtimeOpPayloadHash,
} from './runtime-ops.js';

const WORKSPACE = assertWorkspaceId('workspace\0😀');
const THREAD = assertThreadId('thread/../opaque\0😀');
const OP = assertExternalOpId('op_e_00000000000000000000000000000000');

function prompt(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    type: 'prompt',
    opId: OP,
    workspaceId: WORKSPACE,
    threadId: THREAD,
    text: '',
    ...overrides,
  };
}

describe('RuntimeOp canonical admission', () => {
  test('accepts opaque NUL identities and ordinary empty payload strings', () => {
    const op = canonicalizeRuntimeOp(prompt());
    expect(op).toMatchObject({ workspaceId: WORKSPACE, threadId: THREAD, text: '' });
    expect(Object.isFrozen(op)).toBe(true);
  });

  test('hash ignores insertion order and known top-level optional undefined', () => {
    const first = {
      type: 'abort',
      opId: OP,
      workspaceId: WORKSPACE,
      threadId: THREAD,
      expectedRunId: undefined,
    };
    const second = {
      threadId: THREAD,
      workspaceId: WORKSPACE,
      opId: OP,
      type: 'abort',
    };
    expect(canonicalRuntimeOpJson(first)).toBe(canonicalRuntimeOpJson(second));
    expect(runtimeOpPayloadHash(first)).toBe(runtimeOpPayloadHash(second));
    expect(canonicalizeRuntimeOp(first)).not.toHaveProperty('expectedRunId');
  });

  test('unknown and required fields never normalize undefined away', () => {
    for (const invalid of [
      prompt({ unknown: undefined }),
      { type: 'prompt', opId: OP, workspaceId: WORKSPACE, threadId: THREAD },
      prompt({ text: undefined }),
      prompt({ permissionNarrowing: { revision: 'r', constraints: [undefined] } }),
      prompt({ permissionNarrowing: { revision: 'r', constraints: [{ nested: undefined }] } }),
    ]) {
      expectInvalid(invalid, 'invalid_runtime_op');
    }
  });

  test('rejects strict JSON hazards before ledger hashing', () => {
    const cycle: Record<string, unknown> = prompt();
    cycle.self = cycle;
    const proxy = new Proxy(prompt(), {
      getOwnPropertyDescriptor() {
        throw new Error('trap');
      },
    });

    for (const invalid of [
      prompt({ text: '\ud800' }),
      prompt({ permissionNarrowing: { revision: 'r', constraints: [{ ['\udc00']: true }] } }),
      prompt({ permissionNarrowing: { revision: 'r', constraints: [{ value: 1n }] } }),
      prompt({ permissionNarrowing: { revision: 'r', constraints: [{ value: Number.NaN }] } }),
      cycle,
      proxy,
    ]) {
      expectInvalid(invalid, 'invalid_runtime_op');
    }
  });

  test('external namespace is mandatory even when TypeScript brands are bypassed', () => {
    const derived = deriveOpId({
      purpose: 'cancel_target',
      workspaceId: WORKSPACE,
      parts: ['root', THREAD],
    });
    for (const invalidOpId of [derived, '', 'op_e_' + 'A'.repeat(32), 'op_e_0\0' + '0'.repeat(30)]) {
      const error = captureValidationError(prompt({ opId: invalidOpId }));
      expect(error.code).toBe('invalid_external_op_id');
      expect(error.rawOpId).toBe(invalidOpId);
    }
  });

  test('rejects nested unknown fields and invalid scope framing', () => {
    expectInvalid({
      type: 'set_model',
      opId: OP,
      workspaceId: WORKSPACE,
      threadId: THREAD,
      model: { provider: 'p', api: 'faux', model: 'm', secret: 'no' },
    }, 'invalid_runtime_op');
    expectInvalid({
      type: 'cancel_scope',
      opId: OP,
      workspaceId: WORKSPACE,
      scope: 'workspace',
      rootThreadId: THREAD,
    }, 'invalid_runtime_op');
    expectInvalid({
      type: 'cancel_scope',
      opId: OP,
      workspaceId: WORKSPACE,
      scope: 'subtree',
    }, 'invalid_runtime_op');
  });

  test('canonical JSON preserves legal empty and magic nested keys', () => {
    const op = prompt({
      permissionNarrowing: {
        revision: '',
        constraints: [JSON.parse('{"__proto__":"safe","constructor":"also-safe","":true}')],
      },
    });
    const json = canonicalRuntimeOpJson(op);
    expect(json).toContain('"":true');
    expect(json).toContain('"__proto__":"safe"');
    expect(json).toContain('"constructor":"also-safe"');
  });
});

function expectInvalid(input: unknown, code: RuntimeOpValidationError['code']): void {
  expect(captureValidationError(input).code).toBe(code);
}

function captureValidationError(input: unknown): RuntimeOpValidationError {
  try {
    canonicalizeRuntimeOp(input);
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeOpValidationError);
    return error as RuntimeOpValidationError;
  }
  throw new Error('Expected RuntimeOp validation to fail');
}
