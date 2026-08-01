import { describe, expect, test } from 'bun:test';
import type { CapabilityRegistration, ProviderAdapterRegistration } from './types.js';
import {
  computeCapabilityRegistrationDigest,
  computeProviderAdapterRegistrationDigest,
  IMPLEMENTATION_DIGEST_PATTERN,
} from './registration-digest.js';

const ZERO_IMPLEMENTATION = `impl_sha256_${'0'.repeat(64)}`;

describe('registration digests', () => {
  test('matches the frozen capability golden and normalizes defaults', () => {
    const golden = capabilityDigestInput({
      id: 'x',
      version: '1',
      implementationDigest: ZERO_IMPLEMENTATION,
      description: 'd',
      inputSchema: {},
      metadata: {},
      policy: { kind: 'plan', resources: [] },
    });

    expect(computeCapabilityRegistrationDigest(golden)).toBe(
      'capreg_v1_e37726242ad8b4c21c911c28032635f2baf9f555598d80067a59e0c584c594e6',
    );
    expect(IMPLEMENTATION_DIGEST_PATTERN.test(ZERO_IMPLEMENTATION)).toBe(true);
    expect(IMPLEMENTATION_DIGEST_PATTERN.test(`impl_sha256_${'A'.repeat(64)}`)).toBe(false);
  });

  test('is insertion-order independent and binds schema, policy, and implementation', () => {
    const first = capabilityDigestInput({
      id: 'read',
      version: '1',
      implementationDigest: ZERO_IMPLEMENTATION,
      description: 'read',
      inputSchema: { type: 'object', properties: { z: { type: 'string' }, a: { type: 'number' } } },
      metadata: { z: 2, a: 1 },
      policy: {
        kind: 'read',
        resources: [{
          selectorId: 'file',
          resourceType: 'filesystem',
          argumentPointer: '/path',
          access: 'read',
        }],
      },
    });
    const reordered = capabilityDigestInput({
      description: 'read',
      implementationDigest: ZERO_IMPLEMENTATION,
      version: '1',
      id: 'read',
      metadata: { a: 1, z: 2 },
      inputSchema: { properties: { a: { type: 'number' }, z: { type: 'string' } }, type: 'object' },
      policy: {
        resources: [{
          access: 'read',
          argumentPointer: '/path',
          resourceType: 'filesystem',
          selectorId: 'file',
          required: true,
        }],
        kind: 'read',
      },
    });

    const digest = computeCapabilityRegistrationDigest(first);
    expect(computeCapabilityRegistrationDigest(reordered)).toBe(digest);
    expect(computeCapabilityRegistrationDigest({
      ...first,
      inputSchema: { ...first.inputSchema, title: 'changed' },
    })).not.toBe(digest);
    expect(computeCapabilityRegistrationDigest({
      ...first,
      policy: { ...first.policy, attributes: { force: true } },
    })).not.toBe(digest);
    expect(computeCapabilityRegistrationDigest({
      ...first,
      implementationDigest: `impl_sha256_${'1'.repeat(64)}`,
    })).not.toBe(digest);
  });

  test('matches the frozen provider golden and hashes only provider identity fields', () => {
    const registration = {
      api: 'openai-chat',
      version: '1',
      implementationDigest: ZERO_IMPLEMENTATION,
    } as Pick<ProviderAdapterRegistration, 'api' | 'version' | 'implementationDigest'>;

    expect(computeProviderAdapterRegistrationDigest(registration)).toBe(
      'providerreg_v1_ef4b8b6c776430d60fdf3706175bd47c0b49f7c0b8f3fa8097dc3ff26ad3398d',
    );
  });
});

function capabilityDigestInput(
  value: Pick<
    CapabilityRegistration,
    | 'id'
    | 'version'
    | 'implementationDigest'
    | 'description'
    | 'inputSchema'
    | 'metadata'
    | 'policy'
  > & Partial<Pick<CapabilityRegistration, 'promptSnippet' | 'executionMode'>>,
): Parameters<typeof computeCapabilityRegistrationDigest>[0] {
  return value;
}
