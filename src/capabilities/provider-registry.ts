import { isWellFormedUnicode } from '../protocol/index.js';
import type { ModelApi } from '../protocol/index.js';
import {
  IMPLEMENTATION_DIGEST_PATTERN,
  computeProviderAdapterRegistrationDigest,
} from './registration-digest.js';
import type {
  ProviderAdapterEntry,
  ProviderAdapterRegistration,
  ProviderAdapterRegistry,
  ProviderAdapterSnapshot,
  ProviderRegistryMutationResult,
} from './types.js';

export function createProviderAdapterRegistry(): ProviderAdapterRegistry {
  return new MutableProviderAdapterRegistry();
}

class MutableProviderAdapterRegistry implements ProviderAdapterRegistry {
  #revision = 0;
  readonly #entries: ProviderAdapterEntry[] = [];
  readonly #byApi = new Map<ModelApi, ProviderAdapterEntry>();
  readonly #implementationHistory = new Map<string, string>();

  register(registration: ProviderAdapterRegistration): ProviderRegistryMutationResult {
    const normalized = normalizeRegistration(registration, this.#revision);
    if (!normalized.ok) return normalized.result;
    const entry = normalized.entry;
    if (this.#byApi.has(entry.api)) {
      return failure(
        'duplicate_provider_adapter',
        `Provider adapter ${JSON.stringify(entry.api)} is already registered`,
        this.#revision,
      );
    }
    const historyFailure = this.#checkHistory(entry);
    if (historyFailure !== undefined) return historyFailure;

    this.#entries.push(entry);
    this.#byApi.set(entry.api, entry);
    this.#remember(entry);
    return success(++this.#revision);
  }

  update(
    api: ModelApi,
    registration: ProviderAdapterRegistration,
    options?: { readonly expectedRevision?: number },
  ): ProviderRegistryMutationResult {
    if (options?.expectedRevision !== undefined && options.expectedRevision !== this.#revision) {
      return failure(
        'revision_conflict',
        `Expected provider registry revision ${options.expectedRevision}, current revision is ${this.#revision}`,
        this.#revision,
      );
    }
    const slot = this.#entries.findIndex((entry) => entry.api === api);
    if (slot < 0) {
      return failure(
        'provider_adapter_not_found',
        `Provider adapter ${JSON.stringify(api)} is not registered`,
        this.#revision,
      );
    }

    const normalized = normalizeRegistration(registration, this.#revision);
    if (!normalized.ok) return normalized.result;
    const entry = normalized.entry;
    if (entry.api !== api) {
      return failure(
        'invalid_provider_adapter',
        `Provider adapter update key ${JSON.stringify(api)} does not match registration api ${JSON.stringify(entry.api)}`,
        this.#revision,
      );
    }
    const historyFailure = this.#checkHistory(entry);
    if (historyFailure !== undefined) return historyFailure;

    this.#entries[slot] = entry;
    this.#byApi.set(api, entry);
    this.#remember(entry);
    return success(++this.#revision);
  }

  unregister(
    api: ModelApi,
    options?: { readonly expectedRevision?: number },
  ): ProviderRegistryMutationResult {
    if (options?.expectedRevision !== undefined && options.expectedRevision !== this.#revision) {
      return failure(
        'revision_conflict',
        `Expected provider registry revision ${options.expectedRevision}, current revision is ${this.#revision}`,
        this.#revision,
      );
    }
    const slot = this.#entries.findIndex((entry) => entry.api === api);
    if (slot < 0) {
      return failure(
        'provider_adapter_not_found',
        `Provider adapter ${JSON.stringify(api)} is not registered`,
        this.#revision,
      );
    }

    this.#entries.splice(slot, 1);
    this.#byApi.delete(api);
    return success(++this.#revision);
  }

  snapshot(): ProviderAdapterSnapshot {
    const entries = Object.freeze([...this.#entries]);
    const index = new Map(entries.map((entry) => [entry.api, entry]));
    return Object.freeze({
      revision: this.#revision,
      entries,
      resolve(api: ModelApi): ProviderAdapterEntry | undefined {
        return index.get(api);
      },
    });
  }

  #checkHistory(entry: ProviderAdapterEntry): ProviderRegistryMutationResult | undefined {
    const previous = this.#implementationHistory.get(historyKey(entry.api, entry.version));
    if (previous === undefined || previous === entry.implementationDigest) return undefined;
    return failure(
      'invalid_provider_adapter',
      `Provider adapter (${JSON.stringify(entry.api)}, ${JSON.stringify(entry.version)}) ` +
        'cannot change implementationDigest within one registry history',
      this.#revision,
    );
  }

  #remember(entry: ProviderAdapterEntry): void {
    this.#implementationHistory.set(
      historyKey(entry.api, entry.version),
      entry.implementationDigest,
    );
  }
}

type NormalizedRegistration =
  | { readonly ok: true; readonly entry: ProviderAdapterEntry }
  | { readonly ok: false; readonly result: ProviderRegistryMutationResult };

function normalizeRegistration(
  registration: ProviderAdapterRegistration,
  revision: number,
): NormalizedRegistration {
  try {
    const fields = dataProperties(registration);
    const expectedKeys = ['api', 'version', 'implementationDigest', 'stream'];
    if (Object.keys(fields).length !== expectedKeys.length
      || expectedKeys.some((key) => !Object.hasOwn(fields, key))) {
      return invalidRegistration(
        'Provider adapter registration has missing or unknown fields',
        revision,
      );
    }
    const api = fields['api'];
    const version = fields['version'];
    const implementationDigest = fields['implementationDigest'];
    const stream = fields['stream'];
    if (typeof api !== 'string' || api.length === 0 || !isWellFormedUnicode(api)) {
      return invalidRegistration('Provider adapter api must be a non-empty well-formed string', revision);
    }
    if (typeof version !== 'string' || version.length === 0 || !isWellFormedUnicode(version)) {
      return invalidRegistration('Provider adapter version must be a non-empty well-formed string', revision);
    }
    if (
      typeof implementationDigest !== 'string' ||
      !IMPLEMENTATION_DIGEST_PATTERN.test(implementationDigest)
    ) {
      return invalidRegistration(
        'Provider adapter implementationDigest must match impl_sha256_<64 lowercase hex>',
        revision,
      );
    }
    if (typeof stream !== 'function') {
      return invalidRegistration('Provider adapter stream must be a function', revision);
    }
    const streamFn = stream as ProviderAdapterRegistration['stream'];

    const registrationDigest = computeProviderAdapterRegistrationDigest({
      api,
      version,
      implementationDigest,
    });
    return {
      ok: true,
      entry: Object.freeze({
        api,
        version,
        implementationDigest,
        stream: streamFn,
        registrationDigest,
      }),
    };
  } catch (error) {
    return invalidRegistration(`Invalid provider adapter registration: ${formatError(error)}`, revision);
  }
}

function invalidRegistration(message: string, revision: number): NormalizedRegistration {
  return {
    ok: false,
    result: failure('invalid_provider_adapter', message, revision),
  };
}

function success(revision: number): ProviderRegistryMutationResult {
  return Object.freeze({ ok: true, revision });
}

function failure(
  code: Extract<ProviderRegistryMutationResult, { readonly ok: false }>['code'],
  message: string,
  revision: number,
): ProviderRegistryMutationResult {
  return Object.freeze({ ok: false, code, message, revision });
}

function historyKey(api: ModelApi, version: string): string {
  return JSON.stringify([api, version]);
}

function dataProperties(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError('Provider adapter registration must be a plain object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const fields: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === 'symbol') {
      throw new TypeError('Provider adapter registration cannot contain symbol keys');
    }
    const descriptor = descriptors[key];
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`Provider adapter registration.${key} must be a data property`);
    }
    fields[key] = descriptor.value;
  }
  return fields;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
