import { describe, expect, it } from 'bun:test';
import type { ModelApi, StreamFn } from '../protocol/index.js';
import { createProviderAdapterRegistry } from './provider-registry.js';
import type { ProviderAdapterRegistration } from './types.js';

const ZERO_DIGEST = `impl_sha256_${'0'.repeat(64)}`;
const ONE_DIGEST = `impl_sha256_${'1'.repeat(64)}`;
const TWO_DIGEST = `impl_sha256_${'2'.repeat(64)}`;
const streamA: StreamFn = () => {
  throw new Error('not invoked');
};
const streamB: StreamFn = () => {
  throw new Error('not invoked');
};

function registration(
  api: ModelApi,
  version = '1',
  implementationDigest = ZERO_DIGEST,
  stream: StreamFn = streamA,
): ProviderAdapterRegistration {
  return { api, version, implementationDigest, stream };
}

describe('ProviderAdapterRegistry', () => {
  it('matches the frozen provider registration digest golden vector', () => {
    const registry = createProviderAdapterRegistry();
    expect(registry.register(registration('openai-chat'))).toEqual({ ok: true, revision: 1 });
    expect(registry.snapshot().resolve('openai-chat')?.registrationDigest).toBe(
      'providerreg_v1_ef4b8b6c776430d60fdf3706175bd47c0b49f7c0b8f3fa8097dc3ff26ad3398d',
    );
  });

  it('advances revision only for successful mutations and preserves stable slots', () => {
    const registry = createProviderAdapterRegistry();
    expect(registry.snapshot()).toMatchObject({ revision: 0, entries: [] });

    expect(registry.register(registration('openai-chat'))).toEqual({ ok: true, revision: 1 });
    expect(registry.register(registration('openai-chat', '2', ONE_DIGEST))).toMatchObject({
      ok: false,
      code: 'duplicate_provider_adapter',
      revision: 1,
    });
    expect(registry.update('faux', registration('faux'))).toMatchObject({
      ok: false,
      code: 'provider_adapter_not_found',
      revision: 1,
    });
    expect(registry.update('openai-chat', registration('faux'))).toMatchObject({
      ok: false,
      code: 'invalid_provider_adapter',
      revision: 1,
    });
    expect(
      registry.update('openai-chat', registration('openai-chat', '2', ONE_DIGEST), {
        expectedRevision: 0,
      }),
    ).toMatchObject({ ok: false, code: 'revision_conflict', revision: 1 });
    expect(registry.unregister('faux')).toMatchObject({
      ok: false,
      code: 'provider_adapter_not_found',
      revision: 1,
    });
    expect(registry.unregister('openai-chat', { expectedRevision: 0 })).toMatchObject({
      ok: false,
      code: 'revision_conflict',
      revision: 1,
    });

    expect(
      registry.update('openai-chat', registration('openai-chat', '2', ONE_DIGEST, streamB), {
        expectedRevision: 1,
      }),
    ).toEqual({ ok: true, revision: 2 });
    expect(registry.register(registration('faux'))).toEqual({ ok: true, revision: 3 });
    expect(registry.snapshot().entries.map((entry) => entry.api)).toEqual(['openai-chat', 'faux']);

    expect(registry.unregister('openai-chat')).toEqual({ ok: true, revision: 4 });
    expect(registry.register(registration('openai-chat', '3', TWO_DIGEST))).toEqual({
      ok: true,
      revision: 5,
    });
    expect(registry.snapshot().entries.map((entry) => entry.api)).toEqual(['faux', 'openai-chat']);
  });

  it('keeps old snapshots and captured StreamFn references isolated from live mutations', () => {
    const registry = createProviderAdapterRegistry();
    const source = registration('openai-chat');
    expect(registry.register(source)).toEqual({ ok: true, revision: 1 });
    const oldSnapshot = registry.snapshot();
    const oldEntry = oldSnapshot.resolve('openai-chat');
    expect(oldEntry?.stream).toBe(streamA);

    (source as { version: string }).version = 'mutated';
    (source as { implementationDigest: string }).implementationDigest = TWO_DIGEST;
    expect(registry.snapshot().resolve('openai-chat')).toMatchObject({
      version: '1',
      implementationDigest: ZERO_DIGEST,
    });

    expect(registry.update('openai-chat', registration('openai-chat', '2', ONE_DIGEST, streamB))).toEqual({
      ok: true,
      revision: 2,
    });
    expect(registry.unregister('openai-chat')).toEqual({ ok: true, revision: 3 });

    expect(oldSnapshot.revision).toBe(1);
    expect(oldSnapshot.entries).toHaveLength(1);
    expect(oldSnapshot.resolve('openai-chat')).toBe(oldEntry);
    expect(oldSnapshot.resolve('openai-chat')?.stream).toBe(streamA);
    expect(Object.isFrozen(oldSnapshot)).toBe(true);
    expect(Object.isFrozen(oldSnapshot.entries)).toBe(true);
    expect(Object.isFrozen(oldEntry)).toBe(true);
    expect(registry.snapshot().resolve('openai-chat')).toBeUndefined();
  });

  it('retains implementation history across update and unregister', () => {
    const registry = createProviderAdapterRegistry();
    expect(registry.register(registration('openai-chat', '1', ZERO_DIGEST))).toEqual({
      ok: true,
      revision: 1,
    });
    expect(registry.update('openai-chat', registration('openai-chat', '2', ONE_DIGEST))).toEqual({
      ok: true,
      revision: 2,
    });
    expect(registry.unregister('openai-chat')).toEqual({ ok: true, revision: 3 });

    expect(registry.register(registration('openai-chat', '1', TWO_DIGEST))).toMatchObject({
      ok: false,
      code: 'invalid_provider_adapter',
      revision: 3,
    });
    expect(registry.register(registration('openai-chat', '1', ZERO_DIGEST))).toEqual({
      ok: true,
      revision: 4,
    });
  });

  it('rejects malformed registrations without changing state', () => {
    const registry = createProviderAdapterRegistry();
    const accessor = { ...registration('openai-chat') } as Record<string, unknown>;
    Object.defineProperty(accessor, 'version', { enumerable: true, get: () => '1' });
    const invalid: unknown[] = [
      registration('' as ModelApi),
      registration('openai-chat', ''),
      registration('openai-chat', '1', 'sha256_bad'),
      { ...registration('openai-chat'), stream: 1 },
      registration('\ud800' as ModelApi),
      accessor,
      { ...registration('openai-chat'), unknown: true },
    ];

    for (const candidate of invalid) {
      expect(registry.register(candidate as ProviderAdapterRegistration)).toMatchObject({
        ok: false,
        code: 'invalid_provider_adapter',
        revision: 0,
      });
    }
    expect(registry.snapshot()).toMatchObject({ revision: 0, entries: [] });
  });
});
