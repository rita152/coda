import {
  canonicalJson,
  cloneStrictJsonValue,
  isOpId,
  strictJsonSnapshot,
} from '../protocol/index.js';
import type {
  CapabilityCatalogEntry,
  CapabilityInvocationAnalysis,
  CapabilityPolicyDescriptor,
  CapabilityRegistration,
  CapabilityRegistry,
  CapabilityResourceAccess,
  CapabilityResourceSelector,
  CapabilityResourceType,
  EffectivePolicySnapshot,
  InvocationContext,
  PreparedInvocation,
  PrepareInvocationResult,
  RegistryMutationResult,
  ResolvedCapabilityResource,
  ToolCatalogSnapshot,
} from './types.js';
import {
  computeCapabilityRegistrationDigest,
  IMPLEMENTATION_DIGEST_PATTERN,
} from './registration-digest.js';

const RESOURCE_TYPES = new Set<CapabilityResourceType>([
  'filesystem',
  'command',
  'network',
  'other',
]);
const RESOURCE_ACCESSES = new Set<CapabilityResourceAccess>([
  'read',
  'write',
  'execute',
  'connect',
]);
const POLICY_KINDS = new Set<CapabilityPolicyDescriptor['kind']>([
  'read',
  'search',
  'edit',
  'execute',
  'plan',
]);
const UTF8 = new TextEncoder();

export function createCapabilityRegistry(): CapabilityRegistry {
  return new DefaultCapabilityRegistry();
}

class DefaultCapabilityRegistry implements CapabilityRegistry {
  readonly #entries: CapabilityCatalogEntry[] = [];
  readonly #indices = new Map<string, number>();
  readonly #history = new Map<string, string>();
  #revision = 0;

  register(registration: CapabilityRegistration): RegistryMutationResult {
    const normalized = this.#normalize(registration);
    if (!normalized.ok) return normalized.result;
    const entry = normalized.entry;
    if (this.#indices.has(entry.id)) {
      return this.#failure('duplicate_capability', `Capability "${entry.id}" is already registered.`);
    }
    const historyFailure = this.#checkHistory(entry);
    if (historyFailure !== undefined) return historyFailure;

    this.#indices.set(entry.id, this.#entries.length);
    this.#entries.push(entry);
    this.#history.set(historyKey(entry.id, entry.version), entry.registrationDigest);
    return mutationSuccess(++this.#revision);
  }

  update(
    capabilityId: string,
    registration: CapabilityRegistration,
    options?: { readonly expectedRevision?: number },
  ): RegistryMutationResult {
    if (options?.expectedRevision !== undefined && options.expectedRevision !== this.#revision) {
      return this.#failure(
        'revision_conflict',
        `Expected registry revision ${options.expectedRevision}, current revision is ${this.#revision}.`,
      );
    }
    const index = this.#indices.get(capabilityId);
    if (index === undefined) {
      return this.#failure('capability_not_found', `Capability "${capabilityId}" is not registered.`);
    }
    const normalized = this.#normalize(registration);
    if (!normalized.ok) return normalized.result;
    const entry = normalized.entry;
    if (entry.id !== capabilityId) {
      return this.#failure(
        'invalid_registration',
        `Updated registration id "${entry.id}" does not match "${capabilityId}".`,
      );
    }
    const historyFailure = this.#checkHistory(entry);
    if (historyFailure !== undefined) return historyFailure;

    this.#entries[index] = entry;
    this.#history.set(historyKey(entry.id, entry.version), entry.registrationDigest);
    return mutationSuccess(++this.#revision);
  }

  unregister(
    capabilityId: string,
    options?: { readonly expectedRevision?: number },
  ): RegistryMutationResult {
    if (options?.expectedRevision !== undefined && options.expectedRevision !== this.#revision) {
      return this.#failure(
        'revision_conflict',
        `Expected registry revision ${options.expectedRevision}, current revision is ${this.#revision}.`,
      );
    }
    const index = this.#indices.get(capabilityId);
    if (index === undefined) {
      return this.#failure('capability_not_found', `Capability "${capabilityId}" is not registered.`);
    }
    this.#entries.splice(index, 1);
    this.#rebuildIndices();
    return mutationSuccess(++this.#revision);
  }

  snapshot(): ToolCatalogSnapshot {
    const revision = this.#revision;
    const entries = Object.freeze([...this.#entries]);
    const index = new Map(entries.map((entry) => [entry.id, entry]));
    return Object.freeze({
      revision,
      entries,
      resolve: (capabilityId: string): CapabilityCatalogEntry | undefined => index.get(capabilityId),
      prepare: (
        input: Parameters<ToolCatalogSnapshot['prepare']>[0],
      ): Promise<PrepareInvocationResult> => prepareInvocation(revision, index, input),
    });
  }

  #normalize(registration: CapabilityRegistration):
    | { readonly ok: true; readonly entry: CapabilityCatalogEntry }
    | { readonly ok: false; readonly result: RegistryMutationResult } {
    try {
      return { ok: true, entry: normalizeRegistration(registration) };
    } catch (error) {
      return {
        ok: false,
        result: this.#failure('invalid_registration', `Invalid capability registration: ${errorMessage(error)}`),
      };
    }
  }

  #checkHistory(entry: CapabilityCatalogEntry): RegistryMutationResult | undefined {
    const prior = this.#history.get(historyKey(entry.id, entry.version));
    if (prior !== undefined && prior !== entry.registrationDigest) {
      return this.#failure(
        'invalid_registration',
        `Capability "${entry.id}" version "${entry.version}" was already bound to a different registration digest.`,
      );
    }
    return undefined;
  }

  #failure(
    code: Extract<RegistryMutationResult, { readonly ok: false }>['code'],
    message: string,
  ): RegistryMutationResult {
    return Object.freeze({ ok: false, code, message, revision: this.#revision });
  }

  #rebuildIndices(): void {
    this.#indices.clear();
    for (let index = 0; index < this.#entries.length; index++) {
      const entry = this.#entries[index];
      if (entry !== undefined) this.#indices.set(entry.id, index);
    }
  }
}

function normalizeRegistration(registration: CapabilityRegistration): CapabilityCatalogEntry {
  const fields = dataProperties(registration, 'registration');
  assertRegistrationKeys(fields);
  const id = nonEmptyString(fields['id'], 'id');
  const version = nonEmptyString(fields['version'], 'version');
  const implementationDigest = nonEmptyString(fields['implementationDigest'], 'implementationDigest');
  if (!IMPLEMENTATION_DIGEST_PATTERN.test(implementationDigest)) {
    throw new TypeError('implementationDigest must match impl_sha256_<64 lowercase hex>.');
  }
  const description = stringValue(fields['description'], 'description');
  const promptSnippet = optionalString(fields['promptSnippet'], 'promptSnippet');
  const executionMode = fields['executionMode'];
  if (executionMode !== undefined && executionMode !== 'sequential') {
    throw new TypeError('executionMode must be "sequential" when present.');
  }
  const inputSchema = jsonObjectSnapshot(fields['inputSchema'], 'inputSchema');
  const metadata = jsonObjectSnapshot(fields['metadata'], 'metadata');
  const policy = normalizePolicy(fields['policy']);
  const prepare = optionalFunction(fields['prepare'], 'prepare');
  const validate = requiredFunction(fields['validate'], 'validate');
  const resolveResources = requiredFunction(fields['resolveResources'], 'resolveResources');
  const execute = requiredFunction(fields['execute'], 'execute');

  const registrationDigest = computeCapabilityRegistrationDigest({
    id,
    version,
    implementationDigest,
    description,
    inputSchema,
    ...(promptSnippet !== undefined && { promptSnippet }),
    executionMode,
    metadata,
    policy,
  });
  return Object.freeze({
    id,
    version,
    implementationDigest,
    description,
    inputSchema,
    ...(promptSnippet !== undefined && { promptSnippet }),
    executionMode: executionMode ?? 'parallel',
    metadata,
    policy,
    ...(prepare !== undefined && { prepare }),
    validate,
    resolveResources,
    execute,
    registrationDigest,
  }) as CapabilityCatalogEntry;
}

function assertRegistrationKeys(fields: Record<PropertyKey, unknown>): void {
  const required = [
    'id',
    'version',
    'implementationDigest',
    'description',
    'inputSchema',
    'metadata',
    'policy',
    'validate',
    'resolveResources',
    'execute',
  ];
  const allowed = new Set([...required, 'promptSnippet', 'executionMode', 'prepare']);
  const keys = Reflect.ownKeys(fields);
  if (required.some((key) => !Object.hasOwn(fields, key))
    || keys.some((key) => typeof key !== 'string' || !allowed.has(key))) {
    throw new TypeError('registration has missing or unknown fields.');
  }
}

function normalizePolicy(value: unknown): Readonly<CapabilityPolicyDescriptor> {
  const snapshot = jsonObjectSnapshot(value, 'policy');
  assertJsonKeys(snapshot, ['kind', 'resources'], 'policy', ['attributes']);
  const kind = snapshot['kind'];
  if (typeof kind !== 'string' || !POLICY_KINDS.has(kind as CapabilityPolicyDescriptor['kind'])) {
    throw new TypeError('policy.kind is invalid.');
  }
  const resources = snapshot['resources'];
  if (!Array.isArray(resources)) throw new TypeError('policy.resources must be an array.');
  const selectorIds = new Set<string>();
  const normalizedResources = resources.map((resource, index) => {
    const selector = normalizeSelector(resource, index);
    if (selectorIds.has(selector.selectorId)) {
      throw new TypeError(`policy.resources contains duplicate selectorId "${selector.selectorId}".`);
    }
    selectorIds.add(selector.selectorId);
    return selector;
  });
  const attributesValue = snapshot['attributes'];
  const attributes = attributesValue === undefined
    ? undefined
    : jsonObjectSnapshot(attributesValue, 'policy.attributes');
  return Object.freeze({
    kind: kind as CapabilityPolicyDescriptor['kind'],
    resources: Object.freeze(normalizedResources),
    ...(attributes !== undefined && { attributes }),
  });
}

function normalizeSelector(value: unknown, index: number): Readonly<CapabilityResourceSelector> {
  const selector = jsonObjectSnapshot(value, `policy.resources[${index}]`);
  assertJsonKeys(
    selector,
    ['selectorId', 'resourceType', 'argumentPointer', 'access'],
    `policy.resources[${index}]`,
    ['required'],
  );
  const selectorId = nonEmptyString(selector['selectorId'], `policy.resources[${index}].selectorId`);
  const resourceType = selector['resourceType'];
  const access = selector['access'];
  if (typeof resourceType !== 'string' || !RESOURCE_TYPES.has(resourceType as CapabilityResourceType)) {
    throw new TypeError(`policy.resources[${index}].resourceType is invalid.`);
  }
  if (typeof access !== 'string' || !RESOURCE_ACCESSES.has(access as CapabilityResourceAccess)) {
    throw new TypeError(`policy.resources[${index}].access is invalid.`);
  }
  return Object.freeze({
    selectorId,
    resourceType: resourceType as CapabilityResourceType,
    argumentPointer: stringValue(
      selector['argumentPointer'],
      `policy.resources[${index}].argumentPointer`,
    ),
    access: access as CapabilityResourceAccess,
    required: selector['required'] === undefined
      ? true
      : booleanValue(selector['required'], `policy.resources[${index}].required`),
  });
}

async function prepareInvocation(
  revision: number,
  entries: ReadonlyMap<string, CapabilityCatalogEntry>,
  input: Parameters<ToolCatalogSnapshot['prepare']>[0],
): Promise<PrepareInvocationResult> {
  let capabilityId: string;
  try {
    capabilityId = input.capabilityId;
  } catch (error) {
    return prepareFailure('invalid_invocation_context', `Cannot read capability id: ${errorMessage(error)}`);
  }
  const entry = entries.get(capabilityId);
  if (entry === undefined) {
    return prepareFailure('unknown_capability', `Unknown capability "${capabilityId}".`);
  }

  let contextInput: Readonly<InvocationContext>;
  let policyInput: Readonly<EffectivePolicySnapshot>;
  try {
    contextInput = input.context;
    policyInput = input.effectivePolicy;
  } catch (error) {
    return prepareFailure(
      'invalid_invocation_context',
      `Cannot read invocation context: ${errorMessage(error)}`,
    );
  }
  const captured = captureInvocationInputs(revision, capabilityId, contextInput, policyInput);
  if (!captured.ok) return captured.result;

  let rawArgs: unknown;
  try {
    rawArgs = cloneStrictJsonValue(input.rawArgs);
  } catch (error) {
    return prepareFailure('invalid_arguments', `Arguments are not strict JSON: ${errorMessage(error)}`);
  }

  let preparedValue = rawArgs;
  if (entry.prepare !== undefined) {
    try {
      preparedValue = entry.prepare(rawArgs);
    } catch (error) {
      return prepareFailure('prepare_failed', `Argument preparation failed: ${errorMessage(error)}`);
    }
  }

  let validation: ReturnType<typeof entry.validate>;
  try {
    validation = entry.validate(preparedValue);
  } catch (error) {
    return prepareFailure('prepare_failed', `Argument validator threw: ${errorMessage(error)}`);
  }
  let validationSnapshot: unknown;
  try {
    validationSnapshot = strictJsonSnapshot(validation);
  } catch (error) {
    return prepareFailure(
      'invalid_prepared_value',
      `Argument validator returned an invalid result: ${errorMessage(error)}`,
    );
  }
  if (!isPlainRecord(validationSnapshot) || typeof validationSnapshot['ok'] !== 'boolean') {
    return prepareFailure('invalid_prepared_value', 'Argument validator returned an invalid result.');
  }
  if (validationSnapshot['ok'] === false) {
    return typeof validationSnapshot['message'] === 'string'
      ? prepareFailure('invalid_arguments', validationSnapshot['message'])
      : prepareFailure('invalid_prepared_value', 'Argument validator failure is missing a message.');
  }

  let args: unknown;
  try {
    args = strictJsonSnapshot(validationSnapshot['value']);
  } catch (error) {
    return prepareFailure(
      'invalid_prepared_value',
      `Validated arguments are not strict JSON: ${errorMessage(error)}`,
    );
  }

  let resolution: unknown;
  try {
    resolution = await entry.resolveResources(args, captured.context);
  } catch (error) {
    return prepareFailure(
      'resource_resolution_failed',
      `Resource resolver threw: ${errorMessage(error)}`,
    );
  }
  const resources = normalizeResolution(entry, resolution);
  if (!resources.ok) return resources.result;

  const invocation: PreparedInvocation = Object.freeze({
    capabilityVersion: entry.version,
    registrationDigest: entry.registrationDigest,
    description: entry.description,
    inputSchema: entry.inputSchema,
    metadata: entry.metadata,
    policy: entry.policy,
    effectivePolicy: captured.effectivePolicy,
    executionMode: entry.executionMode,
    args,
    resources: resources.resources,
    analysis: resources.analysis,
    context: captured.context,
    validator: entry.validate,
    executor: entry.execute,
  });
  return Object.freeze({ ok: true, invocation });
}

function captureInvocationInputs(
  revision: number,
  capabilityId: string,
  contextInput: Readonly<InvocationContext>,
  policyInput: Readonly<EffectivePolicySnapshot>,
):
  | {
      readonly ok: true;
      readonly context: Readonly<InvocationContext>;
      readonly effectivePolicy: Readonly<EffectivePolicySnapshot>;
    }
  | { readonly ok: false; readonly result: PrepareInvocationResult } {
  try {
    const context = strictJsonSnapshot(contextInput) as unknown as Readonly<InvocationContext>;
    const effectivePolicy = strictJsonSnapshot(policyInput) as unknown as Readonly<EffectivePolicySnapshot>;
    if (!validInvocationContext(context)
      || context.capabilityId !== capabilityId
      || context.catalogRevision !== revision
      || !sameTurnContext(context, effectivePolicy.context)) {
      return {
        ok: false,
        result: prepareFailure(
          'invalid_invocation_context',
          'Invocation, catalog, and effective-policy identities do not match.',
        ),
      };
    }
    return { ok: true, context, effectivePolicy };
  } catch (error) {
    return {
      ok: false,
      result: prepareFailure(
        'invalid_invocation_context',
        `Invocation context is not valid strict JSON: ${errorMessage(error)}`,
      ),
    };
  }
}

function normalizeResolution(
  entry: CapabilityCatalogEntry,
  value: unknown,
):
  | {
      readonly ok: true;
      readonly resources: readonly Readonly<ResolvedCapabilityResource>[];
      readonly analysis: Readonly<CapabilityInvocationAnalysis>;
    }
  | { readonly ok: false; readonly result: PrepareInvocationResult } {
  let snapshot: unknown;
  try {
    snapshot = strictJsonSnapshot(value);
  } catch (error) {
    return {
      ok: false,
      result: prepareFailure(
        'resource_resolution_failed',
        `Resource resolver returned invalid strict JSON: ${errorMessage(error)}`,
      ),
    };
  }
  if (!isPlainRecord(snapshot) || typeof snapshot['ok'] !== 'boolean') {
    return {
      ok: false,
      result: prepareFailure('resource_resolution_failed', 'Resource resolver returned an invalid result.'),
    };
  }
  if (snapshot['ok'] === false) {
    if (!hasExactJsonKeys(snapshot, ['ok', 'code', 'message'])) {
      return {
        ok: false,
        result: prepareFailure('resource_resolution_failed', 'Resource resolver returned an invalid failure.'),
      };
    }
    const code = snapshot['code'];
    const message = snapshot['message'];
    if ((code === 'resource_resolution_failed' || code === 'ambiguous_resource')
      && typeof message === 'string') {
      return { ok: false, result: prepareFailure(code, message) };
    }
    return {
      ok: false,
      result: prepareFailure('resource_resolution_failed', 'Resource resolver returned an invalid failure.'),
    };
  }
  if (!hasExactJsonKeys(snapshot, ['ok', 'resources'], ['analysis'])) {
    return {
      ok: false,
      result: prepareFailure('resource_resolution_failed', 'Resource resolver returned invalid fields.'),
    };
  }
  if (!Array.isArray(snapshot['resources'])) {
    return {
      ok: false,
      result: prepareFailure('resource_resolution_failed', 'Resource resolver did not return a resource array.'),
    };
  }

  const selectors = new Map(entry.policy.resources.map((selector) => [selector.selectorId, selector]));
  const resources: Readonly<ResolvedCapabilityResource>[] = [];
  for (let index = 0; index < snapshot['resources'].length; index++) {
    const item = snapshot['resources'][index];
    if (!isPlainRecord(item)) {
      return {
        ok: false,
        result: prepareFailure('resource_resolution_failed', `Resource ${index} is not an object.`),
      };
    }
    if (!hasExactJsonKeys(item, ['selectorId', 'resourceType', 'access', 'canonicalTarget'])) {
      return {
        ok: false,
        result: prepareFailure('resource_resolution_failed', `Resource ${index} has invalid fields.`),
      };
    }
    const selectorId = item['selectorId'];
    const resourceType = item['resourceType'];
    const access = item['access'];
    const canonicalTarget = item['canonicalTarget'];
    if (typeof selectorId !== 'string' || selectorId.length === 0
      || typeof resourceType !== 'string' || !RESOURCE_TYPES.has(resourceType as CapabilityResourceType)
      || typeof access !== 'string' || !RESOURCE_ACCESSES.has(access as CapabilityResourceAccess)
      || typeof canonicalTarget !== 'string' || canonicalTarget.length === 0) {
      return {
        ok: false,
        result: prepareFailure('resource_resolution_failed', `Resource ${index} has invalid fields.`),
      };
    }
    const selector = selectors.get(selectorId);
    if (selector === undefined
      || selector.resourceType !== resourceType
      || selector.access !== access) {
      return {
        ok: false,
        result: prepareFailure(
          'resource_resolution_failed',
          `Resource ${index} does not match selector "${selectorId}".`,
        ),
      };
    }
    resources.push(Object.freeze({
      selectorId,
      resourceType: resourceType as CapabilityResourceType,
      access: access as CapabilityResourceAccess,
      canonicalTarget,
    }));
  }

  resources.sort(compareResources);
  const deduplicated: Readonly<ResolvedCapabilityResource>[] = [];
  for (const resource of resources) {
    const prior = deduplicated.at(-1);
    if (prior === undefined || compareResources(prior, resource) !== 0) deduplicated.push(resource);
  }
  const boundSelectors = new Set(deduplicated.map((resource) => resource.selectorId));
  for (const selector of entry.policy.resources) {
    if ((selector.required ?? true) && !boundSelectors.has(selector.selectorId)) {
      return {
        ok: false,
        result: prepareFailure(
          'resource_resolution_failed',
          `Required selector "${selector.selectorId}" did not resolve a resource.`,
        ),
      };
    }
  }
  const analysis = normalizeInvocationAnalysis(snapshot['analysis']);
  if (!analysis.ok) return { ok: false, result: analysis.result };
  return {
    ok: true,
    resources: Object.freeze(deduplicated),
    analysis: analysis.analysis,
  };
}

function normalizeInvocationAnalysis(value: unknown):
  | { readonly ok: true; readonly analysis: Readonly<CapabilityInvocationAnalysis> }
  | { readonly ok: false; readonly result: PrepareInvocationResult } {
  if (value === undefined) {
    return {
      ok: true,
      analysis: strictJsonSnapshot({
        resourceCoverage: { kind: 'complete' },
        grantability: { kind: 'persistable' },
        safety: { kind: 'eligible' },
        attributes: {},
      }) as unknown as Readonly<CapabilityInvocationAnalysis>,
    };
  }
  try {
    const analysis = jsonObjectSnapshot(value, 'resource analysis');
    assertJsonKeys(
      analysis,
      ['resourceCoverage', 'grantability', 'safety', 'attributes'],
      'resource analysis',
    );
    const resourceCoverage = normalizeCoverage(analysis['resourceCoverage']);
    const grantability = normalizeGrantability(analysis['grantability']);
    const safety = normalizeSafety(analysis['safety']);
    const attributes = jsonObjectSnapshot(analysis['attributes'], 'resource analysis.attributes');
    return {
      ok: true,
      analysis: strictJsonSnapshot({
        resourceCoverage,
        grantability,
        safety,
        attributes,
      }) as unknown as Readonly<CapabilityInvocationAnalysis>,
    };
  } catch (error) {
    return {
      ok: false,
      result: prepareFailure(
        'resource_resolution_failed',
        `Resource resolver returned invalid analysis: ${errorMessage(error)}`,
      ),
    };
  }
}

function normalizeCoverage(value: unknown): CapabilityInvocationAnalysis['resourceCoverage'] {
  const coverage = jsonObjectSnapshot(value, 'resource analysis.resourceCoverage');
  if (coverage['kind'] === 'complete') {
    assertJsonKeys(coverage, ['kind'], 'resource analysis.resourceCoverage');
    return { kind: 'complete' };
  }
  if (coverage['kind'] === 'incomplete') {
    assertJsonKeys(coverage, ['kind', 'reasons'], 'resource analysis.resourceCoverage');
    return { kind: 'incomplete', reasons: normalizeReasons(coverage['reasons'], 'resource coverage') };
  }
  throw new TypeError('resource analysis.resourceCoverage.kind is invalid.');
}

function normalizeGrantability(value: unknown): CapabilityInvocationAnalysis['grantability'] {
  const grantability = jsonObjectSnapshot(value, 'resource analysis.grantability');
  if (grantability['kind'] === 'persistable') {
    assertJsonKeys(grantability, ['kind'], 'resource analysis.grantability');
    return { kind: 'persistable' };
  }
  if (grantability['kind'] === 'once_only') {
    assertJsonKeys(grantability, ['kind', 'reasons'], 'resource analysis.grantability');
    return { kind: 'once_only', reasons: normalizeReasons(grantability['reasons'], 'grantability') };
  }
  throw new TypeError('resource analysis.grantability.kind is invalid.');
}

function normalizeSafety(value: unknown): CapabilityInvocationAnalysis['safety'] {
  const safety = jsonObjectSnapshot(value, 'resource analysis.safety');
  if (safety['kind'] === 'eligible') {
    assertJsonKeys(safety, ['kind'], 'resource analysis.safety');
    return { kind: 'eligible' };
  }
  if (safety['kind'] === 'deny') {
    assertJsonKeys(safety, ['kind', 'code', 'reason'], 'resource analysis.safety');
    return {
      kind: 'deny',
      code: nonEmptyString(safety['code'], 'resource analysis.safety.code'),
      reason: nonEmptyString(safety['reason'], 'resource analysis.safety.reason'),
    };
  }
  throw new TypeError('resource analysis.safety.kind is invalid.');
}

function normalizeReasons(value: unknown, label: string): readonly [string, ...string[]] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} reasons must be a non-empty array.`);
  }
  const unique = [...new Set(value.map((reason, index) =>
    nonEmptyString(reason, `${label} reasons[${index}]`)))].sort(compareUtf8);
  return unique as [string, ...string[]];
}

function validInvocationContext(context: Readonly<InvocationContext>): boolean {
  return nonEmptyRuntimeString(context.workspaceId)
    && nonEmptyRuntimeString(context.threadId)
    && nonEmptyRuntimeString(context.runId)
    && nonEmptyRuntimeString(context.turnId)
    && (context.opId === undefined || isOpId(context.opId))
    && nonEmptyRuntimeString(context.invocationId)
    && nonEmptyRuntimeString(context.toolCallId)
    && nonEmptyRuntimeString(context.capabilityId)
    && Number.isSafeInteger(context.catalogRevision)
    && context.catalogRevision >= 0
    && nonEmptyRuntimeString(context.cwd);
}

function sameTurnContext(
  invocation: Readonly<InvocationContext>,
  policy: Readonly<EffectivePolicySnapshot>['context'],
): boolean {
  return isPlainRecord(policy)
    && invocation.workspaceId === policy.workspaceId
    && invocation.threadId === policy.threadId
    && invocation.runId === policy.runId
    && invocation.turnId === policy.turnId
    && invocation.cwd === policy.cwd;
}

function compareResources(
  left: Readonly<ResolvedCapabilityResource>,
  right: Readonly<ResolvedCapabilityResource>,
): number {
  return compareUtf8(left.selectorId, right.selectorId)
    || compareUtf8(left.resourceType, right.resourceType)
    || compareUtf8(left.access, right.access)
    || compareUtf8(left.canonicalTarget, right.canonicalTarget);
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = UTF8.encode(left);
  const rightBytes = UTF8.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index++) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function prepareFailure(
  code: Extract<PrepareInvocationResult, { readonly ok: false }>['code'],
  message: string,
): PrepareInvocationResult {
  return Object.freeze({ ok: false, code, message });
}

function mutationSuccess(revision: number): RegistryMutationResult {
  return Object.freeze({ ok: true, revision });
}

function dataProperties(value: unknown, label: string): Record<PropertyKey, unknown> {
  if (!isPlainRecord(value)) throw new TypeError(`${label} must be a plain object.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = Object.create(null) as Record<PropertyKey, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === 'symbol') throw new TypeError(`${label} cannot contain symbol keys.`);
    const descriptor = descriptors[key];
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${label}.${key} must be a data property.`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function jsonObjectSnapshot(value: unknown, label: string): Readonly<Record<string, unknown>> {
  const snapshot = strictJsonSnapshot(value);
  if (!isPlainRecord(snapshot)) throw new TypeError(`${label} must be a plain JSON object.`);
  return snapshot;
}

function assertJsonKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  label: string,
  optional: readonly string[] = [],
): void {
  if (!hasExactJsonKeys(value, required, optional)) {
    throw new TypeError(`${label} has missing or unknown fields.`);
  }
}

function hasExactJsonKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nonEmptyString(value: unknown, label: string): string {
  const result = stringValue(value, label);
  if (result.length === 0) throw new TypeError(`${label} must not be empty.`);
  return result;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string.`);
  strictJsonSnapshot(value);
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : stringValue(value, label);
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean.`);
  return value;
}

function requiredFunction(value: unknown, label: string): (...args: never[]) => unknown {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function.`);
  return value as (...args: never[]) => unknown;
}

function optionalFunction(value: unknown, label: string): ((...args: never[]) => unknown) | undefined {
  return value === undefined ? undefined : requiredFunction(value, label);
}

function nonEmptyRuntimeString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function historyKey(id: string, version: string): string {
  return canonicalJson([id, version]);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'unknown error';
}
