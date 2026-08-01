import { describe, expect, test } from 'bun:test';

import {
  assertLegacyWorkspaceId,
  assertRunId,
  assertThreadId,
  assertTurnId,
  assertWorkspaceId,
  deriveInvocationId,
  deriveOpId,
  isDerivedOpId,
  isExternalOpId,
  isRunId,
  isThreadId,
  isTurnId,
  isWorkspaceId,
  legacyThreadId,
  legacyWorkspaceId,
  RuntimeIdentityValidationError,
} from './identity.js';

describe('runtime identities', () => {
  test('legacy identity golden vectors are byte-stable', () => {
    const alpha = legacyWorkspaceId('/work/alpha');
    expect(String(alpha)).toBe('ws_v1_33c68026e39376337b611a28b1e8f4625f1e0afe3fa140e3ab3b602ca944e5ee');
    expect(String(legacyWorkspaceId('/工作/甲'))).toBe(
      'ws_v1_b85604486dec545464d56c643ee14acee012d00576a42d3a7136127d5e3df119',
    );
    expect(String(legacyWorkspaceId('C:\\repo'))).toBe(
      'ws_v1_06ae402892a0930119b83e143b055d02fba6f2461ec9d6f471600ea3056bea27',
    );
    expect(String(legacyThreadId(alpha, '20250101-010203-abcd'))).toBe(
      'th_v1_5754738e401cada8c5130e7b6c381e19fb19542fa43f659db399c7f4c6cad782',
    );
  });

  test('legacy raw framing accepts empty, relative, NUL, and supplementary Unicode', () => {
    expect(legacyWorkspaceId('')).toMatch(/^ws_v1_[0-9a-f]{64}$/);
    expect(legacyWorkspaceId('../escape')).not.toBe(legacyWorkspaceId('/escape'));
    expect(legacyWorkspaceId('a\0b')).not.toBe(legacyWorkspaceId('a'));
    expect(legacyWorkspaceId('/repo/😀')).not.toBe(legacyWorkspaceId('/repo/�'));

    const workspace = legacyWorkspaceId('a\0b');
    expect(legacyThreadId(workspace, 'x\0y')).not.toBe(legacyThreadId(workspace, 'x'));
  });

  test('legacy thread mapping rejects a merely branded-looking general workspace value', () => {
    const workspace = assertWorkspaceId('workspace\0opaque');
    expect(() => legacyThreadId(workspace as never, 'session')).toThrow(RuntimeIdentityValidationError);
    expect(assertLegacyWorkspaceId(legacyWorkspaceId('/work'))).toBe(legacyWorkspaceId('/work'));
  });

  test('derived operation identities match all frozen golden vectors', () => {
    const workspaceId = assertWorkspaceId('ws_demo');
    expect(String(deriveOpId({
      purpose: 'cancel_target',
      workspaceId,
      parts: ['op_e_00000000000000000000000000000000', 'th_A'],
    }))).toBe('op_d_dcdea1751e98146913ba9f4ea6e2d82b021dd3863cfa9204b8d63125e971742c');
    expect(String(deriveOpId({
      purpose: 'control_recovery',
      workspaceId,
      parts: ['th_A', 'req_1'],
    }))).toBe('op_d_88bf94a9203f908053641af9283876a54b7cb9ea02aa3a4649a244132e780b47');
    expect(String(deriveOpId({
      purpose: 'thread_result',
      workspaceId,
      parts: ['th_parent', 'th_child', 'run_9'],
    }))).toBe('op_d_824809be668f4f8b9dbd6cbfbdc712840ac05586936fb5128a07b4f370442c05');
    expect(String(deriveOpId({
      purpose: 'thread_close_on_runtime_close',
      workspaceId,
      parts: ['th_A', 'op_e_11111111111111111111111111111111'],
    }))).toBe('op_d_108d0373c577a6437b9f141fd007ca7a434b3d757eaa0139e8ead4ea2c775df9');
  });

  test('length framing distinguishes embedded NUL and part boundaries', () => {
    const workspaceId = assertWorkspaceId('workspace\0😀');
    const left = deriveOpId({ purpose: 'thread_result', workspaceId, parts: ['a\0b', 'c'] });
    const right = deriveOpId({ purpose: 'thread_result', workspaceId, parts: ['a', 'b\0c'] });
    expect(left).not.toBe(right);
  });

  test('invocation identities use the frozen turn/ordinal framing', () => {
    const identity = {
      workspaceId: assertWorkspaceId('ws'),
      threadId: assertThreadId('th'),
      runId: assertRunId('run'),
      turnId: assertTurnId('turn'),
    };
    expect(deriveInvocationId({ ...identity, sourceOrdinal: 0 })).toBe(
      'inv_e954c16ff7aaa09d4f34a9c4abf128f94e95dee3bc98c458ea6f131e7d6ee44a',
    );
    expect(deriveInvocationId({ ...identity, sourceOrdinal: 1 })).not.toBe(
      deriveInvocationId({ ...identity, sourceOrdinal: 0 }),
    );
    expect(() => deriveInvocationId({ ...identity, sourceOrdinal: -1 })).toThrow(
      RuntimeIdentityValidationError,
    );
    expect(() => deriveInvocationId({ ...identity, sourceOrdinal: 0x1_0000_0000 })).toThrow(
      RuntimeIdentityValidationError,
    );
  });

  test('derived framing rejects sparse parts with a typed identity error', () => {
    const parts = new Array<string>(1);
    try {
      deriveOpId({
        purpose: 'thread_result',
        workspaceId: assertWorkspaceId('workspace'),
        parts,
      });
      throw new Error('expected sparse parts to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeIdentityValidationError);
      expect((error as RuntimeIdentityValidationError).code).toBe('invalid_legacy_identity_input');
      expect((error as RuntimeIdentityValidationError).field).toBe('parts[0]');
    }
  });

  test('origin namespaces are disjoint and opaque identities keep legal NUL/scalars', () => {
    expect(isExternalOpId('op_e_00000000000000000000000000000000')).toBe(true);
    expect(isExternalOpId('op_d_' + '0'.repeat(64))).toBe(false);
    expect(isDerivedOpId('op_d_' + '0'.repeat(64))).toBe(true);
    expect(isDerivedOpId('op_e_' + '0'.repeat(32))).toBe(false);
    expect(isExternalOpId('op_e_' + 'A'.repeat(32))).toBe(false);
    expect(isExternalOpId('op_e_0\0' + '0'.repeat(30))).toBe(false);

    for (const validator of [isWorkspaceId, isThreadId, isRunId, isTurnId]) {
      expect(validator('')).toBe(false);
      expect(validator('opaque\0😀')).toBe(true);
      expect(validator('\ud800')).toBe(false);
      expect(validator('\udc00')).toBe(false);
    }
  });

  test('hash inputs reject lone surrogates before UTF-8 encoding', () => {
    expect(() => legacyWorkspaceId('\ud800')).toThrow(RuntimeIdentityValidationError);
    expect(() => legacyThreadId(legacyWorkspaceId('/work'), '\udc00')).toThrow(
      RuntimeIdentityValidationError,
    );
    expect(() => deriveOpId({
      purpose: 'cancel_target',
      workspaceId: assertWorkspaceId('workspace'),
      parts: ['\ud800'],
    })).toThrow(RuntimeIdentityValidationError);
  });
});
