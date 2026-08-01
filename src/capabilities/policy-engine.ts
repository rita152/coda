// Per-thread conservative permission evaluation over frozen turn snapshots and prepared invocations.
// Unknown ceiling material always fails closed; canonical grants never broaden their exact resource scope.

import {
  canonicalJson,
  canonicalJsonSha256,
  isExternalOpId,
  isOpId,
  isRunId,
  isThreadId,
  isTurnId,
  isWellFormedUnicode,
  isWorkspaceId,
  strictJsonSnapshot,
} from '../protocol/index.js';
import type {
  PermissionCeilingSnapshot,
  PolicyGrantScope,
  StrictJsonValue,
  ThreadId,
  WorkspaceId,
} from '../protocol/index.js';
import type {
  CapabilityInvocationAnalysis,
  CapabilityPolicyDescriptor,
  EffectivePolicySnapshot,
  InvocationContext,
  PolicyDecision,
  PolicyEngine,
  PolicyEngineOptions,
  PolicyGrant,
  PolicyGrantSnapshot,
  PreparedInvocation,
  ResolvedCapabilityResource,
  RuleSnapshot,
  ThreadPolicyEngine,
  TurnPolicyContext,
} from './types.js';

const POLICY_ENGINE_CONFIG = 'coda.policy-engine.conservative.v1';
const POLICY_BASIS_PREFIX = 'policy_basis_v1_';
const EFFECTIVE_POLICY_PREFIX = 'policy_v1_';
const DOOM_LOOP_DOMAIN = 'coda.policy-engine.doom-loop.v1';
const DOOM_LOOP_THRESHOLD = 3;
const DOOM_LOOP_NOTE = 'This exact call has been attempted 3 times in a row — possible loop.';

type JsonRecord = Readonly<Record<string, StrictJsonValue>>;

interface CapturedPolicyState {
  readonly revision: string;
  readonly grants: Readonly<PolicyGrantSnapshot>;
  readonly grantsCanonical: string;
  readonly policyCanonical: string;
}

class ConservativePolicyEngine implements PolicyEngine {
  readonly #configuration: JsonRecord;

  constructor(options: Readonly<PolicyEngineOptions>) {
    this.#configuration = snapshotPolicyEngineOptions(options);
  }

  async openThread(input: {
    readonly workspaceId: WorkspaceId;
    readonly threadId: ThreadId;
  }): Promise<ThreadPolicyEngine> {
    const owner = snapshotOpenThreadInput(input);
    return Object.freeze(new ConservativeThreadPolicyEngine(owner, this.#configuration));
  }
}

class ConservativeThreadPolicyEngine implements ThreadPolicyEngine {
  readonly #owner: Readonly<Pick<TurnPolicyContext, 'workspaceId' | 'threadId'>>;
  readonly #configuration: JsonRecord;
  #captured: CapturedPolicyState | undefined;
  #lastInvocationDigest: string | undefined;
  #repeatCount = 0;
  #closed = false;

  constructor(
    owner: Readonly<Pick<TurnPolicyContext, 'workspaceId' | 'threadId'>>,
    configuration: JsonRecord,
  ) {
    this.#owner = owner;
    this.#configuration = configuration;
  }

  async capture(input: {
    readonly context: Readonly<TurnPolicyContext>;
    readonly workspaceCeiling: Readonly<PermissionCeilingSnapshot>;
    readonly runCeiling: Readonly<PermissionCeilingSnapshot>;
    readonly turnCeiling: Readonly<PermissionCeilingSnapshot>;
    readonly rules: Readonly<RuleSnapshot>;
    readonly grants: Readonly<PolicyGrantSnapshot>;
  }): Promise<Readonly<EffectivePolicySnapshot>> {
    this.#assertOpen();
    const capturedInput = snapshotRecord(input, 'capture input');
    assertExactKeys(capturedInput, [
      'context',
      'workspaceCeiling',
      'runCeiling',
      'turnCeiling',
      'rules',
      'grants',
    ], 'capture input');

    const context = snapshotTurnContext(capturedInput.context, 'context');
    assertThreadOwner(context, this.#owner, 'capture context');
    const workspaceCeiling = snapshotCeiling(capturedInput.workspaceCeiling, 'workspaceCeiling');
    const runCeiling = snapshotCeiling(capturedInput.runCeiling, 'runCeiling');
    const turnCeiling = snapshotCeiling(capturedInput.turnCeiling, 'turnCeiling');
    const rules = snapshotRules(capturedInput.rules);
    assertSameTurnContext(rules.owner, context, 'rules.owner');
    const grants = snapshotGrants(capturedInput.grants);
    if (grants.workspaceId !== context.workspaceId) {
      throw new TypeError('Policy grant snapshot belongs to a different workspace');
    }

    const constraints = snapshotEffectiveConstraints([
      workspaceCeiling,
      runCeiling,
      turnCeiling,
    ]);
    const policyBasisRevision = computePolicyBasisRevision({
      ceilingRevision: turnCeiling.revision,
      constraints,
      ruleRevision: rules.revision,
      configuration: this.#configuration,
    });
    const revision = computeEffectivePolicyRevision({
      policyBasisRevision,
      grantRevision: grants.revision,
      context,
    });
    const result = snapshotJson<EffectivePolicySnapshot>({
      context,
      revision,
      policyBasisRevision,
      ceilingRevision: turnCeiling.revision,
      grantRevision: grants.revision,
      constraints,
      rules,
    });

    const grantsCanonical = canonicalJson(grants);
    const policyCanonical = canonicalJson(result);
    if (this.#captured?.revision === revision
      && (this.#captured.grantsCanonical !== grantsCanonical
        || this.#captured.policyCanonical !== policyCanonical)) {
      throw new TypeError('Policy revision aliases different policy material');
    }
    this.#captured = Object.freeze({ revision, grants, grantsCanonical, policyCanonical });
    return result;
  }

  async evaluate(invocation: Readonly<PreparedInvocation>): Promise<PolicyDecision> {
    if (this.#closed) {
      return deny('policy_engine_closed', 'The thread policy engine is closed');
    }

    const checked = validateInvocation(invocation, this.#owner, this.#configuration);
    if (!checked.ok) return deny('invalid_policy_invocation', checked.message);

    const captured = this.#captured;
    if (captured === undefined || captured.revision !== checked.effectivePolicy.revision) {
      return deny(
        'uncaptured_policy_snapshot',
        'The invocation does not use the currently captured policy snapshot',
      );
    }

    if (checked.effectivePolicy.constraints.length > 0) {
      return deny(
        'unknown_permission_constraint',
        'The permission ceiling contains a constraint this policy engine does not recognize',
      );
    }

    if (checked.analysis.safety.kind === 'deny') {
      return deny(checked.analysis.safety.code, checked.analysis.safety.reason);
    }

    const invocationDigest = `${DOOM_LOOP_DOMAIN}:${canonicalJsonSha256([
      checked.context.capabilityId,
      checked.capabilityVersion,
      checked.registrationDigest,
      checked.args,
    ])}`;
    if (invocationDigest === this.#lastInvocationDigest) this.#repeatCount += 1;
    else {
      this.#lastInvocationDigest = invocationDigest;
      this.#repeatCount = 1;
    }
    if (this.#repeatCount >= DOOM_LOOP_THRESHOLD) {
      return ask(
        'doom_loop_confirmation_required',
        'This exact invocation has been attempted at least three times in a row',
        `${approvalDescription(checked.description, checked.context.capabilityId, checked.args)}\n${DOOM_LOOP_NOTE}`,
      );
    }

    const proposal = checked.analysis.resourceCoverage.kind === 'complete'
      && checked.analysis.grantability.kind === 'persistable'
      ? canonicalGrantProposal(checked.policy, checked.resources)
      : undefined;
    if (proposal !== undefined && captured.grants.grants.some((grant) =>
      grantMatches(grant, checked, proposal))) {
      return allow('matching_policy_grant', 'A canonical workspace grant exactly matches this invocation');
    }

    switch (checked.policy.kind) {
      case 'read':
      case 'search':
      case 'plan':
        return allow('default_safe_capability', `Capability kind ${checked.policy.kind} is allowed by default`);
      case 'edit':
      case 'execute':
        return ask(
          'approval_required',
          `Capability kind ${checked.policy.kind} requires approval`,
          approvalDescription(checked.description, checked.context.capabilityId, checked.args),
          proposal,
        );
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#captured = undefined;
    this.#lastInvocationDigest = undefined;
    this.#repeatCount = 0;
  }

  #assertOpen(): void {
    if (this.#closed) throw new TypeError('Thread policy engine is closed');
  }
}

/** Create a stateless factory; each opened thread receives isolated capture and doom-loop state. */
export function createPolicyEngine(options: Readonly<PolicyEngineOptions> = {}): PolicyEngine {
  return Object.freeze(new ConservativePolicyEngine(options));
}

function computePolicyBasisRevision(input: {
  readonly ceilingRevision: string;
  readonly constraints: readonly Readonly<Record<string, unknown>>[];
  readonly ruleRevision: string;
  readonly configuration: JsonRecord;
}): string {
  return `${POLICY_BASIS_PREFIX}${canonicalJsonSha256({
    engine: POLICY_ENGINE_CONFIG,
    ...(Object.keys(input.configuration).length === 0
      ? {}
      : { configuration: input.configuration }),
    ceilingRevision: input.ceilingRevision,
    constraints: input.constraints,
    ruleRevision: input.ruleRevision,
  })}`;
}

function computeEffectivePolicyRevision(input: {
  readonly policyBasisRevision: string;
  readonly grantRevision: string;
  readonly context: Readonly<TurnPolicyContext>;
}): string {
  return `${EFFECTIVE_POLICY_PREFIX}${canonicalJsonSha256({
    policyBasisRevision: input.policyBasisRevision,
    grantRevision: input.grantRevision,
    context: input.context,
  })}`;
}

function snapshotPolicyEngineOptions(input: unknown): JsonRecord {
  const options = snapshotRecord(input, 'policy engine options');
  assertExactKeys(options, [], 'policy engine options', ['configuration']);
  if (options.configuration === undefined) return snapshotJson({}) as JsonRecord;
  const configuration = snapshotRecord(options.configuration, 'policy engine configuration');
  return snapshotJson(configuration) as JsonRecord;
}

function snapshotOpenThreadInput(input: unknown): Readonly<Pick<TurnPolicyContext, 'workspaceId' | 'threadId'>> {
  const snapshot = snapshotRecord(input, 'openThread input');
  assertExactKeys(snapshot, ['workspaceId', 'threadId'], 'openThread input');
  if (!isWorkspaceId(snapshot.workspaceId)) throw new TypeError('Invalid policy workspaceId');
  if (!isThreadId(snapshot.threadId)) throw new TypeError('Invalid policy threadId');
  return snapshotJson({ workspaceId: snapshot.workspaceId, threadId: snapshot.threadId });
}

function snapshotTurnContext(input: unknown, field: string): Readonly<TurnPolicyContext> {
  const snapshot = snapshotRecord(input, field);
  assertExactKeys(snapshot, ['workspaceId', 'threadId', 'runId', 'turnId', 'cwd'], field);
  if (!isWorkspaceId(snapshot.workspaceId)
    || !isThreadId(snapshot.threadId)
    || !isRunId(snapshot.runId)
    || !isTurnId(snapshot.turnId)
    || !isNonEmptyString(snapshot.cwd)) {
    throw new TypeError(`${field} contains invalid identity`);
  }
  return snapshot as unknown as Readonly<TurnPolicyContext>;
}

function snapshotInvocationContext(input: unknown): Readonly<InvocationContext> {
  const snapshot = snapshotRecord(input, 'invocation.context');
  assertExactKeys(snapshot, [
    'workspaceId',
    'threadId',
    'runId',
    'turnId',
    'invocationId',
    'toolCallId',
    'capabilityId',
    'catalogRevision',
    'cwd',
  ], 'invocation.context', ['opId']);
  if (!isWorkspaceId(snapshot.workspaceId)
    || !isThreadId(snapshot.threadId)
    || !isRunId(snapshot.runId)
    || !isTurnId(snapshot.turnId)
    || (snapshot.opId !== undefined && !isOpId(snapshot.opId))
    || !isNonEmptyString(snapshot.invocationId)
    || !isNonEmptyString(snapshot.toolCallId)
    || !isNonEmptyString(snapshot.capabilityId)
    || !isNonNegativeSafeInteger(snapshot.catalogRevision)
    || !isNonEmptyString(snapshot.cwd)) {
    throw new TypeError('Invocation context contains invalid identity');
  }
  return snapshot as unknown as Readonly<InvocationContext>;
}

function snapshotCeiling(input: unknown, field: string): Readonly<PermissionCeilingSnapshot> {
  const snapshot = snapshotRecord(input, field);
  assertExactKeys(snapshot, ['revision', 'constraints'], field, ['inheritedFrom']);
  if (!isNonEmptyString(snapshot.revision) || !Array.isArray(snapshot.constraints)) {
    throw new TypeError(`${field} is invalid`);
  }
  for (const constraint of snapshot.constraints) {
    if (!isRecord(constraint)) throw new TypeError(`${field} contains an invalid constraint`);
  }
  if (snapshot.inheritedFrom !== undefined) {
    const inherited = asRecord(snapshot.inheritedFrom, `${field}.inheritedFrom`);
    assertExactKeys(
      inherited,
      ['parentThreadId', 'parentCeilingRevision'],
      `${field}.inheritedFrom`,
      ['parentRunId'],
    );
    if (!isThreadId(inherited.parentThreadId)
      || (inherited.parentRunId !== undefined && !isRunId(inherited.parentRunId))
      || !isNonEmptyString(inherited.parentCeilingRevision)) {
      throw new TypeError(`${field} contains invalid inheritance`);
    }
  }
  return snapshot as unknown as Readonly<PermissionCeilingSnapshot>;
}

function snapshotRules(input: unknown): Readonly<RuleSnapshot> {
  const snapshot = snapshotRecord(input, 'rules');
  assertExactKeys(snapshot, ['revision', 'owner', 'discovery', 'files'], 'rules');
  if (!isNonEmptyString(snapshot.revision) || !Array.isArray(snapshot.files)) {
    throw new TypeError('Invalid rule snapshot');
  }
  const owner = snapshotTurnContext(snapshot.owner, 'rules.owner');
  const discovery = asRecord(snapshot.discovery, 'rules.discovery');
  assertExactKeys(
    discovery,
    ['knownResourceScopes', 'budget', 'diagnostics'],
    'rules.discovery',
  );
  if (!Array.isArray(discovery.knownResourceScopes)
    || !discovery.knownResourceScopes.every(isNonEmptyString)
    || !Array.isArray(discovery.diagnostics)) {
    throw new TypeError('Invalid rule discovery snapshot');
  }
  validateRuleBudget(discovery.budget);
  for (const diagnostic of discovery.diagnostics) validateRuleDiagnostic(diagnostic);
  for (const file of snapshot.files) validateRuleFile(file);
  return snapshotJson({
    revision: snapshot.revision,
    owner,
    discovery,
    files: snapshot.files,
  }) as unknown as Readonly<RuleSnapshot>;
}

function validateRuleBudget(input: unknown): void {
  const budget = asRecord(input, 'rules.discovery.budget');
  assertExactKeys(
    budget,
    ['maxFiles', 'maxFileBytes', 'maxBytes', 'maxPromptTokens'],
    'rules.discovery.budget',
  );
  if (!isNonNegativeSafeInteger(budget.maxFiles)
    || !isNonNegativeSafeInteger(budget.maxFileBytes)
    || !isNonNegativeSafeInteger(budget.maxBytes)
    || !isNonNegativeSafeInteger(budget.maxPromptTokens)) {
    throw new TypeError('Invalid rule snapshot budget');
  }
}

function validateRuleDiagnostic(input: unknown): void {
  const diagnostic = asRecord(input, 'rules.discovery.diagnostics[]');
  assertExactKeys(diagnostic, ['code', 'message'], 'rules.discovery.diagnostics[]', ['path']);
  if (diagnostic.code !== 'rule_skipped'
    && diagnostic.code !== 'rule_budget_exhausted'
    && diagnostic.code !== 'rule_unreadable') {
    throw new TypeError('Invalid rule diagnostic code');
  }
  if (!isString(diagnostic.message)
    || (diagnostic.path !== undefined && !isNonEmptyString(diagnostic.path))) {
    throw new TypeError('Invalid rule diagnostic');
  }
}

function validateRuleFile(input: unknown): void {
  const file = asRecord(input, 'rules.files[]');
  assertExactKeys(file, ['path', 'scope', 'contentDigest', 'content'], 'rules.files[]');
  if (!isNonEmptyString(file.path)
    || !isNonEmptyString(file.scope)
    || !isNonEmptyString(file.contentDigest)
    || !isString(file.content)) {
    throw new TypeError('Invalid rule file');
  }
}

function snapshotGrants(input: unknown): Readonly<PolicyGrantSnapshot> {
  const snapshot = snapshotRecord(input, 'grants');
  assertExactKeys(snapshot, ['workspaceId', 'revision', 'grants'], 'grants', ['legacyGlobal']);
  if (!isWorkspaceId(snapshot.workspaceId)
    || !isNonEmptyString(snapshot.revision)
    || !Array.isArray(snapshot.grants)) {
    throw new TypeError('Invalid policy grant snapshot');
  }
  const seenGrantIds = new Set<string>();
  for (const grant of snapshot.grants) {
    validateGrant(grant, snapshot.workspaceId);
    const grantId = asRecord(grant, 'grants.grants[]').grantId as string;
    if (seenGrantIds.has(grantId)) throw new TypeError('Duplicate policy grant id');
    seenGrantIds.add(grantId);
  }
  if (snapshot.legacyGlobal !== undefined) validateLegacyGlobalSnapshot(snapshot.legacyGlobal);
  return snapshot as unknown as Readonly<PolicyGrantSnapshot>;
}

function validateGrant(input: unknown, workspaceId: StrictJsonValue): void {
  const grant = asRecord(input, 'grants.grants[]');
  assertExactKeys(grant, [
    'grantId',
    'workspaceId',
    'capabilityId',
    'capabilityVersion',
    'registrationDigest',
    'scope',
    'policyBasisRevision',
    'acceptedAt',
  ], 'grants.grants[]');
  if (!isExternalOpId(grant.grantId)
    || grant.workspaceId !== workspaceId
    || !isWorkspaceId(grant.workspaceId)
    || !isNonEmptyString(grant.capabilityId)
    || !isNonEmptyString(grant.capabilityVersion)
    || !isNonEmptyString(grant.registrationDigest)
    || !isNonEmptyString(grant.policyBasisRevision)
    || !isNonNegativeSafeInteger(grant.acceptedAt)) {
    throw new TypeError('Invalid policy grant');
  }
  validateGrantScope(grant.scope);
}

function validateGrantScope(input: unknown): void {
  const scope = asRecord(input, 'grant.scope');
  if (scope.kind === 'canonical_resources_v1') {
    assertExactKeys(scope, ['kind', 'resourcePatterns', 'attributes'], 'grant.scope');
    if (!Array.isArray(scope.resourcePatterns) || scope.resourcePatterns.length === 0
      || !isRecord(scope.attributes)) {
      throw new TypeError('Invalid canonical policy grant scope');
    }
    const keys: string[] = [];
    for (const inputPattern of scope.resourcePatterns) {
      const pattern = asRecord(inputPattern, 'grant.scope.resourcePatterns[]');
      assertExactKeys(
        pattern,
        ['resourceType', 'access', 'matcher', 'pattern'],
        'grant.scope.resourcePatterns[]',
      );
      if (!isResourceType(pattern.resourceType)
        || !isResourceAccess(pattern.access)
        || pattern.matcher !== 'canonical_target_exact_v1'
        || !isNonEmptyString(pattern.pattern)) {
        throw new TypeError('Invalid canonical policy grant resource pattern');
      }
      keys.push(canonicalJson(pattern));
    }
    assertCanonicalUniqueOrder(keys, 'Canonical policy grant resource patterns');
    return;
  }
  if (scope.kind === 'legacy_global_approvals_v1') {
    assertExactKeys(scope, ['kind', 'patterns'], 'grant.scope');
    if (!Array.isArray(scope.patterns) || scope.patterns.length === 0
      || !scope.patterns.every(isNonEmptyString)) {
      throw new TypeError('Invalid legacy policy grant scope');
    }
    assertCanonicalUniqueOrder(scope.patterns, 'Legacy policy grant patterns');
    return;
  }
  throw new TypeError('Unknown policy grant scope');
}

function validateLegacyGlobalSnapshot(input: unknown): void {
  const snapshot = asRecord(input, 'grants.legacyGlobal');
  assertExactKeys(snapshot, ['revision', 'patterns'], 'grants.legacyGlobal');
  if (!isNonEmptyString(snapshot.revision)
    || !Array.isArray(snapshot.patterns)
    || !snapshot.patterns.every(isNonEmptyString)) {
    throw new TypeError('Invalid legacy approval pattern snapshot');
  }
  assertCanonicalUniqueOrder(snapshot.patterns, 'Legacy approval snapshot patterns');
}

function snapshotEffectiveConstraints(
  ceilings: readonly Readonly<PermissionCeilingSnapshot>[],
): readonly Readonly<Record<string, unknown>>[] {
  const byCanonical = new Map<string, Readonly<Record<string, unknown>>>();
  for (const ceiling of ceilings) {
    for (const constraint of ceiling.constraints) {
      const key = canonicalJson(constraint);
      if (!byCanonical.has(key)) byCanonical.set(key, constraint);
    }
  }
  return snapshotJson(
    [...byCanonical.entries()]
      .sort(([left], [right]) => compareUtf8(left, right))
      .map(([, constraint]) => constraint),
  ) as unknown as readonly Readonly<Record<string, unknown>>[];
}

type CheckedInvocation =
  | {
      readonly ok: true;
      readonly capabilityVersion: string;
      readonly registrationDigest: string;
      readonly description: string;
      readonly policy: Readonly<CapabilityPolicyDescriptor>;
      readonly context: Readonly<InvocationContext>;
      readonly effectivePolicy: Readonly<EffectivePolicySnapshot>;
      readonly args: StrictJsonValue;
      readonly resources: readonly Readonly<ResolvedCapabilityResource>[];
      readonly analysis: Readonly<CapabilityInvocationAnalysis>;
    }
  | { readonly ok: false; readonly message: string };

function validateInvocation(
  invocation: Readonly<PreparedInvocation>,
  owner: Readonly<Pick<TurnPolicyContext, 'workspaceId' | 'threadId'>>,
  configuration: JsonRecord,
): CheckedInvocation {
  try {
    if (!isRecord(invocation)) throw new TypeError('Invocation must be an object');
    const capabilityVersion = invocation.capabilityVersion;
    const registrationDigest = invocation.registrationDigest;
    const description = invocation.description;
    if (!isNonEmptyString(capabilityVersion)
      || !isNonEmptyString(registrationDigest)
      || !isString(description)) {
      throw new TypeError('Invocation capability identity is invalid');
    }
    const context = snapshotInvocationContext(invocation.context);
    assertThreadOwner(context, owner, 'invocation context');
    const effectivePolicy = snapshotEffectivePolicy(invocation.effectivePolicy);
    assertSameTurnContext(effectivePolicy.context, context, 'effectivePolicy.context');
    const expectedBasis = computePolicyBasisRevision({
      ceilingRevision: effectivePolicy.ceilingRevision,
      constraints: effectivePolicy.constraints,
      ruleRevision: effectivePolicy.rules.revision,
      configuration,
    });
    if (effectivePolicy.policyBasisRevision !== expectedBasis) {
      throw new TypeError('Effective policy basis revision is invalid');
    }
    const expectedRevision = computeEffectivePolicyRevision({
      policyBasisRevision: effectivePolicy.policyBasisRevision,
      grantRevision: effectivePolicy.grantRevision,
      context: effectivePolicy.context,
    });
    if (effectivePolicy.revision !== expectedRevision) {
      throw new TypeError('Effective policy combined revision is invalid');
    }
    const policy = snapshotPolicyDescriptor(invocation.policy);
    const args = strictJsonSnapshot(invocation.args);
    const resources = snapshotResources(invocation.resources);
    const analysis = snapshotInvocationAnalysis(invocation.analysis);
    if (policy.kind !== invocation.policy.kind) throw new TypeError('Invocation policy changed during validation');
    return {
      ok: true,
      capabilityVersion,
      registrationDigest,
      description,
      policy,
      context,
      effectivePolicy,
      args,
      resources,
      analysis,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Invalid prepared invocation',
    };
  }
}

function snapshotEffectivePolicy(input: unknown): Readonly<EffectivePolicySnapshot> {
  const snapshot = snapshotRecord(input, 'effectivePolicy');
  assertExactKeys(snapshot, [
    'context',
    'revision',
    'policyBasisRevision',
    'ceilingRevision',
    'grantRevision',
    'constraints',
    'rules',
  ], 'effectivePolicy');
  if (!isNonEmptyString(snapshot.revision)
    || !isNonEmptyString(snapshot.policyBasisRevision)
    || !isNonEmptyString(snapshot.ceilingRevision)
    || !isNonEmptyString(snapshot.grantRevision)
    || !Array.isArray(snapshot.constraints)
    || !snapshot.constraints.every(isRecord)) {
    throw new TypeError('Invalid effective policy snapshot');
  }
  const context = snapshotTurnContext(snapshot.context, 'effectivePolicy.context');
  const rules = snapshotRules(snapshot.rules);
  assertSameTurnContext(rules.owner, context, 'effectivePolicy.rules.owner');
  return snapshotJson({ ...snapshot, context, rules }) as unknown as Readonly<EffectivePolicySnapshot>;
}

function snapshotPolicyDescriptor(input: unknown): Readonly<CapabilityPolicyDescriptor> {
  const snapshot = snapshotRecord(input, 'invocation.policy');
  assertExactKeys(snapshot, ['kind', 'resources'], 'invocation.policy', ['attributes']);
  if (snapshot.kind !== 'read'
    && snapshot.kind !== 'search'
    && snapshot.kind !== 'edit'
    && snapshot.kind !== 'execute'
    && snapshot.kind !== 'plan') {
    throw new TypeError('Unknown capability policy kind');
  }
  if (!Array.isArray(snapshot.resources)) throw new TypeError('Invalid capability policy resources');
  const selectorIds = new Set<string>();
  for (const inputSelector of snapshot.resources) {
    const selector = asRecord(inputSelector, 'invocation.policy.resources[]');
    assertExactKeys(
      selector,
      ['selectorId', 'resourceType', 'argumentPointer', 'access'],
      'invocation.policy.resources[]',
      ['required'],
    );
    if (!isNonEmptyString(selector.selectorId)
      || !isResourceType(selector.resourceType)
      || !isString(selector.argumentPointer)
      || !isResourceAccess(selector.access)
      || (selector.required !== undefined && typeof selector.required !== 'boolean')
      || selectorIds.has(selector.selectorId)) {
      throw new TypeError('Invalid capability policy selector');
    }
    selectorIds.add(selector.selectorId);
  }
  if (snapshot.attributes !== undefined && !isRecord(snapshot.attributes)) {
    throw new TypeError('Invalid capability policy attributes');
  }
  return snapshot as unknown as Readonly<CapabilityPolicyDescriptor>;
}

function snapshotResources(input: unknown): readonly Readonly<ResolvedCapabilityResource>[] {
  if (!Array.isArray(input)) throw new TypeError('Invocation resources must be an array');
  const snapshot = strictJsonSnapshot(input);
  if (!Array.isArray(snapshot)) throw new TypeError('Invocation resources must be an array');
  for (const inputResource of snapshot) {
    const resource = asRecord(inputResource, 'invocation.resources[]');
    assertExactKeys(
      resource,
      ['selectorId', 'resourceType', 'access', 'canonicalTarget'],
      'invocation.resources[]',
    );
    if (!isNonEmptyString(resource.selectorId)
      || !isResourceType(resource.resourceType)
      || !isResourceAccess(resource.access)
      || !isNonEmptyString(resource.canonicalTarget)) {
      throw new TypeError('Invalid invocation resource');
    }
  }
  return snapshot as unknown as readonly Readonly<ResolvedCapabilityResource>[];
}

function snapshotInvocationAnalysis(input: unknown): Readonly<CapabilityInvocationAnalysis> {
  const analysis = snapshotRecord(input, 'invocation.analysis');
  assertExactKeys(
    analysis,
    ['resourceCoverage', 'grantability', 'safety', 'attributes'],
    'invocation.analysis',
  );

  const resourceCoverage = asRecord(
    analysis.resourceCoverage,
    'invocation.analysis.resourceCoverage',
  );
  if (resourceCoverage.kind === 'complete') {
    assertExactKeys(
      resourceCoverage,
      ['kind'],
      'invocation.analysis.resourceCoverage',
    );
  } else if (resourceCoverage.kind === 'incomplete') {
    assertExactKeys(
      resourceCoverage,
      ['kind', 'reasons'],
      'invocation.analysis.resourceCoverage',
    );
    validateAnalysisReasons(resourceCoverage.reasons, 'invocation.analysis.resourceCoverage.reasons');
  } else {
    throw new TypeError('Invocation resource coverage is invalid');
  }

  const grantability = asRecord(analysis.grantability, 'invocation.analysis.grantability');
  if (grantability.kind === 'persistable') {
    assertExactKeys(grantability, ['kind'], 'invocation.analysis.grantability');
  } else if (grantability.kind === 'once_only') {
    assertExactKeys(grantability, ['kind', 'reasons'], 'invocation.analysis.grantability');
    validateAnalysisReasons(grantability.reasons, 'invocation.analysis.grantability.reasons');
  } else {
    throw new TypeError('Invocation grantability is invalid');
  }

  const safety = asRecord(analysis.safety, 'invocation.analysis.safety');
  if (safety.kind === 'eligible') {
    assertExactKeys(safety, ['kind'], 'invocation.analysis.safety');
  } else if (safety.kind === 'deny') {
    assertExactKeys(safety, ['kind', 'code', 'reason'], 'invocation.analysis.safety');
    if (!isNonEmptyString(safety.code) || !isNonEmptyString(safety.reason)) {
      throw new TypeError('Invocation safety denial is invalid');
    }
  } else {
    throw new TypeError('Invocation safety analysis is invalid');
  }

  if (!isRecord(analysis.attributes)) {
    throw new TypeError('Invocation analysis attributes are invalid');
  }
  return analysis as unknown as Readonly<CapabilityInvocationAnalysis>;
}

function validateAnalysisReasons(input: unknown, field: string): void {
  if (!Array.isArray(input) || input.length === 0 || !input.every(isNonEmptyString)) {
    throw new TypeError(`${field} must be a non-empty string array`);
  }
  assertCanonicalUniqueOrder(input, field);
}

function canonicalGrantProposal(
  policy: Readonly<CapabilityPolicyDescriptor>,
  resources: readonly Readonly<ResolvedCapabilityResource>[],
): Readonly<PolicyGrantScope> | undefined {
  if (resources.length === 0) return undefined;
  try {
    const attributes = strictJsonSnapshot(policy.attributes ?? {});
    if (!isRecord(attributes)) return undefined;
    const patternsByCanonical = new Map<string, StrictJsonValue>();
    for (const resource of resources) {
      const pattern = strictJsonSnapshot({
        resourceType: resource.resourceType,
        access: resource.access,
        matcher: 'canonical_target_exact_v1',
        pattern: resource.canonicalTarget,
      });
      const key = canonicalJson(pattern);
      if (!patternsByCanonical.has(key)) patternsByCanonical.set(key, pattern);
    }
    const resourcePatterns = [...patternsByCanonical.entries()]
      .sort(([left], [right]) => compareUtf8(left, right))
      .map(([, pattern]) => pattern);
    if (resourcePatterns.length === 0) return undefined;
    return snapshotJson({
      kind: 'canonical_resources_v1',
      resourcePatterns,
      attributes,
    }) as unknown as Readonly<PolicyGrantScope>;
  } catch {
    return undefined;
  }
}

function grantMatches(
  grant: Readonly<PolicyGrant>,
  invocation: Extract<CheckedInvocation, { readonly ok: true }>,
  proposal: Readonly<PolicyGrantScope>,
): boolean {
  return grant.workspaceId === invocation.context.workspaceId
    && grant.capabilityId === invocation.context.capabilityId
    && grant.capabilityVersion === invocation.capabilityVersion
    && grant.registrationDigest === invocation.registrationDigest
    && grant.policyBasisRevision === invocation.effectivePolicy.policyBasisRevision
    && grant.scope.kind === 'canonical_resources_v1'
    && canonicalJson(grant.scope) === canonicalJson(proposal);
}

function approvalDescription(
  description: string,
  capabilityId: string,
  args: StrictJsonValue,
): string {
  const label = description.length > 0 ? description : capabilityId;
  return `${label}: ${canonicalJson(args)}`;
}

function allow(code: string, reason: string): PolicyDecision {
  return snapshotJson({ kind: 'allow', code, reason }) as PolicyDecision;
}

function deny(code: string, reason: string): PolicyDecision {
  return snapshotJson({ kind: 'deny', code, reason, recoverable: true }) as PolicyDecision;
}

function ask(
  code: string,
  reason: string,
  description: string,
  grantProposal?: Readonly<PolicyGrantScope>,
): PolicyDecision {
  return snapshotJson({
    kind: 'ask',
    code,
    reason,
    description,
    ...(grantProposal === undefined ? {} : { grantProposal }),
  }) as PolicyDecision;
}

function assertThreadOwner(
  context: Readonly<Pick<TurnPolicyContext, 'workspaceId' | 'threadId'>>,
  owner: Readonly<Pick<TurnPolicyContext, 'workspaceId' | 'threadId'>>,
  field: string,
): void {
  if (context.workspaceId !== owner.workspaceId || context.threadId !== owner.threadId) {
    throw new TypeError(`${field} belongs to a different thread`);
  }
}

function assertSameTurnContext(
  actual: Readonly<TurnPolicyContext>,
  expected: Readonly<TurnPolicyContext>,
  field: string,
): void {
  if (actual.workspaceId !== expected.workspaceId
    || actual.threadId !== expected.threadId
    || actual.runId !== expected.runId
    || actual.turnId !== expected.turnId
    || actual.cwd !== expected.cwd) {
    throw new TypeError(`${field} does not match the turn policy context`);
  }
}

function snapshotRecord(input: unknown, field: string): JsonRecord {
  const snapshot = strictJsonSnapshot(input);
  return asRecord(snapshot, field);
}

function asRecord(input: unknown, field: string): JsonRecord {
  if (!isRecord(input)) throw new TypeError(`${field} must be an object`);
  return input as JsonRecord;
}

function snapshotJson<T>(input: unknown): Readonly<T> {
  return strictJsonSnapshot(input) as unknown as Readonly<T>;
}

function assertExactKeys(
  input: JsonRecord,
  required: readonly string[],
  field: string,
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(input, key))
    || Object.keys(input).some((key) => !allowed.has(key))) {
    throw new TypeError(`${field} contains invalid fields`);
  }
}

function assertCanonicalUniqueOrder(values: readonly string[], field: string): void {
  for (let index = 1; index < values.length; index++) {
    if (compareUtf8(values[index - 1]!, values[index]!) >= 0) {
      throw new TypeError(`${field} must be unique and UTF-8 sorted`);
    }
  }
}

function compareUtf8(left: string, right: string): number {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index++) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && isWellFormedUnicode(value);
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.length > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isResourceType(value: unknown): boolean {
  return value === 'filesystem' || value === 'command' || value === 'network' || value === 'other';
}

function isResourceAccess(value: unknown): boolean {
  return value === 'read' || value === 'write' || value === 'execute' || value === 'connect';
}
