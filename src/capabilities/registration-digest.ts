import { canonicalJson, sha256Hex } from '../protocol/index.js';
import type {
  CapabilityPolicyDescriptor,
  CapabilityRegistration,
  ProviderAdapterRegistration,
} from './types.js';

const CAPABILITY_REGISTRATION_DOMAIN = 'coda.runtime.capability-registration.v1';
const PROVIDER_ADAPTER_REGISTRATION_DOMAIN = 'coda.runtime.provider-adapter-registration.v1';
const UTF8 = new TextEncoder();

export const IMPLEMENTATION_DIGEST_PATTERN = /^impl_sha256_[0-9a-f]{64}$/;

type CapabilityRegistrationDigestInput = Pick<
  CapabilityRegistration,
  | 'id'
  | 'version'
  | 'implementationDigest'
  | 'description'
  | 'inputSchema'
  | 'promptSnippet'
  | 'executionMode'
  | 'metadata'
  | 'policy'
>;

type ProviderAdapterRegistrationDigestInput = Pick<
  ProviderAdapterRegistration,
  'api' | 'version' | 'implementationDigest'
>;

/** Hash the canonical, JSON-only portion of one capability registration. */
export function computeCapabilityRegistrationDigest(
  registration: CapabilityRegistrationDigestInput,
): string {
  const payload = {
    id: registration.id,
    version: registration.version,
    implementationDigest: registration.implementationDigest,
    description: registration.description,
    inputSchema: registration.inputSchema,
    ...(registration.promptSnippet !== undefined && { promptSnippet: registration.promptSnippet }),
    executionMode: registration.executionMode ?? 'parallel',
    metadata: registration.metadata,
    policy: normalizedPolicy(registration.policy),
  };
  return `capreg_v1_${domainDigest(CAPABILITY_REGISTRATION_DOMAIN, payload)}`;
}

/** Hash the canonical identity of one provider adapter implementation. */
export function computeProviderAdapterRegistrationDigest(
  registration: ProviderAdapterRegistrationDigestInput,
): string {
  return `providerreg_v1_${domainDigest(PROVIDER_ADAPTER_REGISTRATION_DOMAIN, {
    api: registration.api,
    version: registration.version,
    implementationDigest: registration.implementationDigest,
  })}`;
}

function normalizedPolicy(policy: Readonly<CapabilityPolicyDescriptor>): unknown {
  return {
    kind: policy.kind,
    resources: policy.resources.map((selector) => ({
      selectorId: selector.selectorId,
      resourceType: selector.resourceType,
      argumentPointer: selector.argumentPointer,
      access: selector.access,
      required: selector.required ?? true,
    })),
    ...(policy.attributes !== undefined && { attributes: policy.attributes }),
  };
}

function domainDigest(domain: string, payload: unknown): string {
  return sha256Hex(UTF8.encode(`${domain}\0${canonicalJson(payload)}`));
}
