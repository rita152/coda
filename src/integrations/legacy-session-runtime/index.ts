// Phase-1 compatibility driver: adapt the existing single-Agent Session implementation to the
// identity-bearing RuntimePort without letting Runtime core import Session, tools, providers, or
// CLI policy code.

import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { INTERRUPTED_RESULT_TEXT } from '../../agent/index.js';
import type {
  ModelConfig,
  PermissionCeilingSnapshot,
  ThreadId,
  WorkspaceId,
} from '../../protocol/index.js';
import { canonicalJson, strictJsonSnapshot } from '../../protocol/index.js';
import type {
  LegacyApprovalAdapter,
  LegacyApprovalAdapterFactory,
  LegacyApprovalPatternRepositoryPort,
  ThreadDriverAttachment,
  ThreadDriverCheckpoint,
  ThreadDriverFactory,
  ThreadDriverHostServices,
} from '../../runtime/ports.js';
import {
  defaultSessionDir,
  loadSession,
  SessionStore,
  STORE_VERSION,
  PROTOCOL_VERSION,
  UsageTracker,
} from '../../session/index.js';
import type {
  MetaRecord,
  ModelPricing,
  SessionRecord,
} from '../../session/index.js';
import { LegacyThreadExecution } from '../../session/legacy-thread-execution.js';
import type {
  SessionOptions,
  SessionRuntimeMirrorGuard,
} from '../../session/legacy-thread-execution.js';
import {
  checkpointFromLegacySession,
  LegacySessionThreadDriver,
} from '../../session/legacy-session-thread-driver.js';

export interface LegacySessionAttachmentContext {
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly model: ModelConfig;
  readonly permissionCeiling: PermissionCeilingSnapshot;
}

export interface LegacySessionAttachmentConfiguration {
  readonly sessionOptions: Omit<
    SessionOptions,
    | 'dir'
    | 'authoritativeEventSink'
    | 'runtimeMirrorGuard'
    | 'runtimeQueueSeed'
    | 'observerPort'
    | 'legacyRuntimeAttachment'
  >;
  /** Revision of attachment-local legacy project/policy rules. */
  readonly policyRevision?: string;
}

export interface LegacySessionThreadDriverFactoryOptions {
  readonly sessionDir?: string;
  /** Called once per create/resume attachment; do not return shared mutable policy state. */
  readonly configure: (
    context: LegacySessionAttachmentContext,
  ) => LegacySessionAttachmentConfiguration;
  /**
   * Static policy bridge for new attachments. Registry mode keeps the factory available only for
   * recovering historical legacy approval responses.
   */
  readonly approvalAdapterFactory?: LegacyApprovalAdapterFactory;
  /** Canonical Runtime uses the same durable Session mirror with a registry-backed turn engine. */
  readonly capabilityMode?: 'static' | 'registry';
}

interface DriverConstructionInput {
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly model: ModelConfig;
  readonly permissionCeiling: PermissionCeilingSnapshot;
  readonly initialCheckpoint?: ThreadDriverCheckpoint;
  readonly sessionId: string;
  readonly create: boolean;
  readonly creationKey?: string;
  readonly legacyApprovalPatterns?: LegacyApprovalPatternRepositoryPort;
}

const DRIVER_REF_KIND = 'session-v1';
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class LegacySessionCheckpointMismatchError extends Error {
  override readonly name = 'LegacySessionCheckpointMismatchError';
  readonly code = 'legacy_session_checkpoint_mismatch' as const;

  constructor(readonly reason: string) {
    super(`Legacy Session checkpoint mismatch: ${reason}`);
  }
}

export class LegacySessionConcurrentWriterError extends Error {
  override readonly name = 'LegacySessionConcurrentWriterError';
  readonly code = 'legacy_backend_concurrent_writer' as const;

  constructor(readonly reason: string) {
    super(`Legacy Session mirror fingerprint mismatch; attachment quarantined: ${reason}`);
  }
}

export function createLegacySessionThreadDriverFactory(
  options: LegacySessionThreadDriverFactoryOptions,
): ThreadDriverFactory {
  const sessionDir = options.sessionDir ?? defaultSessionDir();
  const capabilityMode = options.capabilityMode ?? 'static';
  const installsLegacyApprovalBridge = capabilityMode === 'static'
    && options.approvalAdapterFactory !== undefined;
  return {
    requirements: {
      approvalMode: installsLegacyApprovalBridge ? 'durable_legacy_bridge' : 'legacy_session_edge',
      capabilityMode,
    },
    ...(options.approvalAdapterFactory !== undefined && {
      openLegacyApprovalAdapter: (input) => options.approvalAdapterFactory?.open(input)
        ?? Promise.reject(new Error('Legacy approval adapter factory is unavailable')),
    }),
    create: async (input, host) => constructDriver(
      options,
      sessionDir,
      {
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        model: input.model,
        permissionCeiling: input.permissionCeiling,
        sessionId: deterministicSessionId(input.creationKey),
        create: true,
        creationKey: input.creationKey,
        ...(input.legacyApprovalPatterns !== undefined && {
          legacyApprovalPatterns: input.legacyApprovalPatterns,
        }),
      },
      host,
    ),
    resume: async (input, host) => {
      assertDriverRef(input.durableRef);
      return constructDriver(
        options,
        sessionDir,
        {
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          model: input.model,
          permissionCeiling: input.permissionCeiling,
          ...(input.committedCheckpoint !== undefined && {
            initialCheckpoint: snapshotCheckpoint(input.committedCheckpoint),
          }),
          sessionId: input.durableRef.key,
          create: false,
          ...(input.legacyApprovalPatterns !== undefined && {
            legacyApprovalPatterns: input.legacyApprovalPatterns,
          }),
        },
        host,
      );
    },
  };
}

async function constructDriver(
  options: LegacySessionThreadDriverFactoryOptions,
  sessionDir: string,
  input: DriverConstructionInput,
  host: ThreadDriverHostServices,
): Promise<ThreadDriverAttachment> {
  const driverRef: { current?: LegacySessionThreadDriver } = {};
  const configured = options.configure({
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    model: input.model,
    permissionCeiling: input.permissionCeiling,
  });
  let approvalAdapter: LegacyApprovalAdapter | undefined;
  let session: LegacyThreadExecution | undefined;
  let driver: LegacySessionThreadDriver | undefined;
  try {
    if (options.capabilityMode !== 'registry' && options.approvalAdapterFactory !== undefined) {
      if (input.legacyApprovalPatterns === undefined) {
        throw new Error('Durable legacy approval storage is required before driver construction');
      }
      approvalAdapter = await options.approvalAdapterFactory.open({
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        patterns: input.legacyApprovalPatterns,
      });
    }
    const configuredBeforeToolCall = configured.sessionOptions.agentConfig.beforeToolCall;
    const sessionOptions: SessionOptions = {
      ...configured.sessionOptions,
      dir: sessionDir,
      legacyRuntimeAttachment: true,
      agentConfig: {
        ...configured.sessionOptions.agentConfig,
        model: input.model,
        ...(options.capabilityMode === 'registry' && {
          runtimeTurnProvider: {
            capture: (turnInput) => {
              const driver = driverRef.current;
              if (driver === undefined) throw new Error('Registry turn requested before driver construction');
              return driver.runtimeTurnProvider.capture(turnInput);
            },
          },
        }),
        ...(approvalAdapter !== undefined && {
          beforeToolCall: async (call) => {
            const configuredDecision = configuredBeforeToolCall === undefined
              ? undefined
              : await configuredBeforeToolCall(call);
            if (configuredDecision?.block === true) return configuredDecision;
            const driver = driverRef.current;
            if (driver === undefined) throw new Error('Legacy approval requested before driver construction');
            const decision = await driver.requestLegacyApproval(call);
            if (decision.kind === 'allow') return {};
            if (decision.kind === 'aborted') {
              return { block: true as const, reason: INTERRUPTED_RESULT_TEXT };
            }
            return { block: true as const, reason: decision.reason };
          },
        }),
      },
      authoritativeEventSink: (events) => {
        if (driverRef.current === undefined) {
          return Promise.reject(new Error('Legacy Session emitted before driver construction'));
        }
        return driverRef.current.commitSessionEvents(events);
      },
    };
    const mirror = new LegacySessionMirrorClaim({
      dir: sessionDir,
      sourceSessionId: input.sessionId,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      recordedCwd: sessionOptions.agentConfig.cwd ?? process.cwd(),
      model: input.model,
      ...(input.creationKey !== undefined && { creationKey: input.creationKey }),
    });
    let activeSessionId = input.sessionId;
    let createMeta: MetaRecord | undefined;
    if (!input.create && input.initialCheckpoint !== undefined) {
      activeSessionId = mirror.prepareResume(
        input.initialCheckpoint,
        configured.sessionOptions.pricing,
      );
    } else if (input.create) {
      const preparation = mirror.prepareCreate();
      activeSessionId = preparation.activeSessionId;
      createMeta = preparation.meta;
    }
    sessionOptions.runtimeMirrorGuard = mirror;
    if (input.initialCheckpoint !== undefined) {
      sessionOptions.runtimeQueueSeed = input.initialCheckpoint.frontend.queues;
    }
    session = input.create
      ? await LegacyThreadExecution.createWithId(activeSessionId, sessionOptions, createMeta)
      : await LegacyThreadExecution.resume(activeSessionId, sessionOptions);
    if (input.create) mirror.finishCreate(activeSessionId);
    driver = new LegacySessionThreadDriver({
      threadId: input.threadId,
      host,
      session,
      approvalAdapter,
      cwd: sessionOptions.agentConfig.cwd ?? process.cwd(),
      pendingMirrorDiagnostic: mirror.rebuiltAfterConcurrentWriter,
      isMirrorConcurrencyError: (error) => error instanceof LegacySessionConcurrentWriterError,
    });
    driverRef.current = driver;
    return {
      driver,
      durableRef: { kind: DRIVER_REF_KIND, key: input.sessionId },
      initialCheckpoint: input.initialCheckpoint ?? checkpointFromLegacySession(session),
      ...(approvalAdapter !== undefined && {
        legacyApprovalAdapter: approvalAdapter,
        legacyApprovalPolicyRevision: configured.policyRevision ?? 'legacy-session-policy-v2',
      }),
    };
  } catch (error) {
    const failures: unknown[] = [error];
    if (driver !== undefined) {
      try {
        await driver.close();
      } catch (closeError) {
        failures.push(closeError);
      }
    } else {
      if (session !== undefined) {
        try {
          await session.close();
        } catch (closeError) {
          failures.push(closeError);
        }
      }
      if (approvalAdapter !== undefined) {
        try {
          await approvalAdapter.close();
        } catch (closeError) {
          failures.push(closeError);
        }
      }
    }
    if (failures.length === 1) throw error;
    throw new AggregateError(failures, 'Legacy Session driver construction cleanup failed');
  }
}

function deterministicSessionId(creationKey: string): string {
  const digest = createHash('sha256').update(creationKey, 'utf8').digest('hex');
  return `runtime-${digest.slice(0, 40)}`;
}

function assertDriverRef(ref: { readonly kind: string; readonly key: string }): void {
  if (ref.kind !== DRIVER_REF_KIND || !SAFE_SESSION_ID.test(ref.key)) {
    throw new Error('Invalid legacy Session driver ref');
  }
}

interface MirrorTailFingerprint {
  readonly byteLength: number;
  readonly sha256: string;
}

interface PersistedLegacyMirrorClaim {
  readonly type: 'coda_runtime_legacy_mirror_claim';
  readonly version: 1;
  readonly sourceSessionId: string;
  readonly activeSessionId: string;
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly recordedCwd: string;
  readonly backendMeta: MetaRecord;
  readonly creationKey?: string;
  readonly generation: number;
  readonly expectedTail: MirrorTailFingerprint;
  readonly status: 'creating' | 'active' | 'quarantined';
}

class LegacySessionMirrorClaim implements SessionRuntimeMirrorGuard {
  readonly #dir: string;
  readonly #sourceSessionId: string;
  readonly #workspaceId: WorkspaceId;
  readonly #threadId: ThreadId;
  readonly #recordedCwd: string;
  readonly #model: ModelConfig;
  readonly #creationKey?: string;
  readonly #claimFile: string;
  #claim: PersistedLegacyMirrorClaim | undefined;
  #expectedAppend: Uint8Array | undefined;
  rebuiltAfterConcurrentWriter = false;

  constructor(input: {
    readonly dir: string;
    readonly sourceSessionId: string;
    readonly workspaceId: WorkspaceId;
    readonly threadId: ThreadId;
    readonly recordedCwd: string;
    readonly model: ModelConfig;
    readonly creationKey?: string;
  }) {
    this.#dir = input.dir;
    this.#sourceSessionId = input.sourceSessionId;
    this.#workspaceId = input.workspaceId;
    this.#threadId = input.threadId;
    this.#recordedCwd = input.recordedCwd;
    this.#model = input.model;
    this.#creationKey = input.creationKey;
    this.#claimFile = path.join(this.#dir, `${this.#sourceSessionId}.runtime-claim.json`);
    this.#claim = this.#loadClaim();
    if (this.#claim !== undefined) this.#validateContext(this.#claim);
  }

  prepareCreate(): { readonly activeSessionId: string; readonly meta: MetaRecord } {
    const claim = this.#claim;
    if (claim === undefined) {
      const mirrorFile = this.#mirrorFile(this.#sourceSessionId);
      if (existsSync(mirrorFile)) {
        throw new LegacySessionCheckpointMismatchError(
          'deterministic create backend exists without a matching persistent claim',
        );
      }
      const meta = this.#metaForPrivateMirror(this.#sourceSessionId);
      const expectedMeta = new TextEncoder().encode(`${JSON.stringify(meta)}\n`);
      this.#claim = {
        type: 'coda_runtime_legacy_mirror_claim',
        version: 1,
        sourceSessionId: this.#sourceSessionId,
        activeSessionId: this.#sourceSessionId,
        workspaceId: this.#workspaceId,
        threadId: this.#threadId,
        recordedCwd: this.#recordedCwd,
        backendMeta: meta,
        ...(this.#creationKey !== undefined && { creationKey: this.#creationKey }),
        generation: 0,
        expectedTail: fingerprintBytes(expectedMeta),
        status: 'creating',
      };
      // Persist the complete creation intent before the backend path can be created. A retry can
      // now prove an exact meta-only crash artifact; an unclaimed pre-existing file is never blessed.
      this.#persistClaim();
      return { activeSessionId: this.#sourceSessionId, meta };
    }
    if (claim.status === 'quarantined') {
      throw new LegacySessionConcurrentWriterError('existing create backend requires explicit resume recovery');
    }
    if (claim.status === 'active') this.assertCurrent();
    if (claim.status === 'creating') {
      const actual = fingerprintFileOrUndefined(this.#mirrorFile(claim.activeSessionId));
      if (actual !== undefined && !sameFingerprint(actual, claim.expectedTail)) {
        this.#quarantine('create backend does not match its persisted meta intent');
      }
    }
    return { activeSessionId: claim.activeSessionId, meta: normalizeMeta(claim.backendMeta) };
  }

  finishCreate(activeSessionId: string): void {
    const claim = this.#requireClaim();
    if (claim.activeSessionId !== activeSessionId) {
      throw new LegacySessionCheckpointMismatchError('create backend id diverges from persistent intent');
    }
    const actual = fingerprintFileOrUndefined(this.#mirrorFile(activeSessionId));
    if (actual === undefined || !sameFingerprint(actual, claim.expectedTail)) {
      this.#quarantine('created backend does not match its persisted meta intent');
    }
    this.#claim = { ...claim, status: 'active' };
    this.#persistClaim();
  }

  prepareResume(checkpoint: ThreadDriverCheckpoint, pricing?: ModelPricing): string {
    const canonical = snapshotCheckpoint(checkpoint);
    const claim = this.#claim;
    if (claim === undefined) {
      reconcileSessionMirror(this.#dir, this.#sourceSessionId, canonical, pricing);
      this.#claim = this.#newClaim(this.#sourceSessionId, 0);
      this.#persistClaim();
      return this.#sourceSessionId;
    }

    const actual = fingerprintFileOrUndefined(this.#mirrorFile(claim.activeSessionId));
    const expectedMatches = actual !== undefined && sameFingerprint(actual, claim.expectedTail);
    if (claim.status === 'creating' && (actual === undefined || expectedMatches)) {
      if (actual === undefined) {
        const initialized = SessionStore.initializeNamed(
          this.#dir,
          claim.activeSessionId,
          normalizeMeta(claim.backendMeta),
        );
        if (!initialized.created) {
          const raced = fingerprintFileOrUndefined(this.#mirrorFile(claim.activeSessionId));
          if (raced === undefined || !sameFingerprint(raced, claim.expectedTail)) {
            return this.#recoverIntoPrivateMirror(canonical, pricing);
          }
        }
      }
      try {
        reconcileSessionMirror(this.#dir, claim.activeSessionId, canonical, pricing);
        this.#refreshExpectedTail('active');
        return claim.activeSessionId;
      } catch (error) {
        if (!(error instanceof LegacySessionCheckpointMismatchError)) throw error;
        return this.#recoverIntoPrivateMirror(canonical, pricing);
      }
    }
    if (claim.status === 'active' && expectedMatches) {
      reconcileSessionMirror(this.#dir, claim.activeSessionId, canonical, pricing);
      this.#refreshExpectedTail('active');
      return claim.activeSessionId;
    }

    // A stale expected fingerprint can be our own canonical-before-claim crash. If the mirror is
    // still a canonical prefix, deterministic repair proves there was no foreign fact to absorb.
    if (claim.status === 'active') {
      try {
        reconcileSessionMirror(this.#dir, claim.activeSessionId, canonical, pricing);
        this.#refreshExpectedTail('active');
        return claim.activeSessionId;
      } catch (error) {
        if (!(error instanceof LegacySessionCheckpointMismatchError)) throw error;
      }
    }

    return this.#recoverIntoPrivateMirror(canonical, pricing);
  }

  assertCurrent(): void {
    const claim = this.#requireClaim();
    if (claim.status !== 'active') {
      throw new LegacySessionConcurrentWriterError('mirror claim is quarantined');
    }
    const actual = fingerprintFileOrUndefined(this.#mirrorFile(claim.activeSessionId));
    if (actual === undefined || !sameFingerprint(actual, claim.expectedTail)) {
      this.#quarantine('unexpected legacy mirror tail');
    }
  }

  beforeAppend(record: SessionRecord): void {
    this.assertCurrent();
    const claim = this.#requireClaim();
    const current = readFileSync(this.#mirrorFile(claim.activeSessionId));
    const suffix = new TextEncoder().encode(`${JSON.stringify(record)}\n`);
    const expected = new Uint8Array(current.byteLength + suffix.byteLength);
    expected.set(current, 0);
    expected.set(suffix, current.byteLength);
    this.#expectedAppend = expected;
  }

  afterAppend(record: SessionRecord): void {
    void record;
    const claim = this.#requireClaim();
    const expected = this.#expectedAppend;
    this.#expectedAppend = undefined;
    if (expected === undefined) this.#quarantine('mirror append completed without a guard snapshot');
    const actual = readFileSync(this.#mirrorFile(claim.activeSessionId));
    if (!bytesEqual(actual, expected)) this.#quarantine('concurrent write raced with mirror append');
    this.#claim = {
      ...claim,
      expectedTail: fingerprintBytes(actual),
      status: 'active',
    };
    this.#persistClaim();
  }

  #rebuildPrivateMirror(checkpoint: ThreadDriverCheckpoint, pricing?: ModelPricing): string {
    const prior = this.#requireClaim();
    for (let generation = prior.generation + 1; generation < Number.MAX_SAFE_INTEGER; generation++) {
      const sessionId = privateMirrorSessionId(
        this.#sourceSessionId,
        this.#workspaceId,
        this.#threadId,
        generation,
      );
      const store = new SessionStore(this.#dir, sessionId);
      if (existsSync(store.file)) {
        try {
          reconcileSessionMirror(this.#dir, sessionId, checkpoint, pricing);
          this.#claim = this.#newClaim(sessionId, generation);
          this.#persistClaim();
          return sessionId;
        } catch (error) {
          if (error instanceof LegacySessionCheckpointMismatchError) continue;
          throw error;
        }
      }
      const initialized = SessionStore.initializeNamed(
        this.#dir,
        sessionId,
        this.#metaForPrivateMirror(sessionId),
      );
      if (!initialized.created) continue;
      for (const message of checkpoint.frontend.transcript) {
        initialized.store.append({ type: 'message', message });
      }
      if (checkpoint.execution.compaction !== undefined) {
        initialized.store.append({
          type: 'compaction',
          ...checkpoint.execution.compaction,
        });
      }
      initialized.store.fsync();
      reconcileSessionMirror(this.#dir, sessionId, checkpoint, pricing);
      this.#claim = this.#newClaim(sessionId, generation);
      this.#persistClaim();
      return sessionId;
    }
    throw new LegacySessionConcurrentWriterError('unable to allocate a private mirror backend');
  }

  #recoverIntoPrivateMirror(checkpoint: ThreadDriverCheckpoint, pricing?: ModelPricing): string {
    const privateSessionId = this.#rebuildPrivateMirror(checkpoint, pricing);
    this.rebuiltAfterConcurrentWriter = true;
    return privateSessionId;
  }

  #metaForPrivateMirror(id: string): MetaRecord {
    return {
      type: 'meta',
      version: STORE_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      id,
      createdAt: Date.now(),
      cwd: this.#recordedCwd,
      model: this.#model.ref,
    };
  }

  #newClaim(activeSessionId: string, generation: number): PersistedLegacyMirrorClaim {
    return {
      type: 'coda_runtime_legacy_mirror_claim',
      version: 1,
      sourceSessionId: this.#sourceSessionId,
      activeSessionId,
      workspaceId: this.#workspaceId,
      threadId: this.#threadId,
      recordedCwd: this.#recordedCwd,
      backendMeta: loadSession(this.#dir, activeSessionId).meta,
      ...(this.#creationKey !== undefined && { creationKey: this.#creationKey }),
      generation,
      expectedTail: fingerprintFile(this.#mirrorFile(activeSessionId)),
      status: 'active',
    };
  }

  #refreshExpectedTail(status: PersistedLegacyMirrorClaim['status']): void {
    const claim = this.#requireClaim();
    this.#claim = {
      ...claim,
      expectedTail: fingerprintFile(this.#mirrorFile(claim.activeSessionId)),
      status,
    };
    this.#persistClaim();
  }

  #quarantine(reason: string): never {
    const claim = this.#requireClaim();
    this.#claim = { ...claim, status: 'quarantined' };
    this.#persistClaim();
    throw new LegacySessionConcurrentWriterError(reason);
  }

  #validateContext(claim: PersistedLegacyMirrorClaim): void {
    if (
      claim.sourceSessionId !== this.#sourceSessionId ||
      claim.workspaceId !== this.#workspaceId ||
      claim.threadId !== this.#threadId ||
      claim.recordedCwd !== this.#recordedCwd ||
      claim.backendMeta.cwd !== claim.recordedCwd ||
      (this.#creationKey !== undefined && claim.creationKey !== this.#creationKey)
    ) {
      throw new LegacySessionCheckpointMismatchError('persistent mirror claim context diverges');
    }
  }

  #loadClaim(): PersistedLegacyMirrorClaim | undefined {
    if (!existsSync(this.#claimFile)) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.#claimFile, 'utf8'));
    } catch (error) {
      throw new LegacySessionCheckpointMismatchError(`invalid persistent mirror claim: ${String(error)}`);
    }
    const detached = strictJsonSnapshot(parsed);
    if (detached === null || typeof detached !== 'object' || Array.isArray(detached)) {
      throw new LegacySessionCheckpointMismatchError('invalid persistent mirror claim fields');
    }
    const snapshot = detached as unknown as PersistedLegacyMirrorClaim;
    const validMeta = isValidMetaRecord(snapshot.backendMeta);
    if (
      snapshot.type !== 'coda_runtime_legacy_mirror_claim' ||
      snapshot.version !== 1 ||
      !SAFE_SESSION_ID.test(snapshot.sourceSessionId) ||
      !SAFE_SESSION_ID.test(snapshot.activeSessionId) ||
      typeof snapshot.workspaceId !== 'string' ||
      snapshot.workspaceId.length === 0 ||
      typeof snapshot.threadId !== 'string' ||
      snapshot.threadId.length === 0 ||
      typeof snapshot.recordedCwd !== 'string' ||
      (snapshot.creationKey !== undefined && typeof snapshot.creationKey !== 'string') ||
      !Number.isSafeInteger(snapshot.generation) ||
      snapshot.generation < 0 ||
      (snapshot.status !== 'creating' && snapshot.status !== 'active' && snapshot.status !== 'quarantined') ||
      !validMeta ||
      snapshot.backendMeta.id !== snapshot.activeSessionId ||
      snapshot.backendMeta.cwd !== snapshot.recordedCwd ||
      !Number.isSafeInteger(snapshot.expectedTail?.byteLength) ||
      snapshot.expectedTail.byteLength < 0 ||
      !/^[0-9a-f]{64}$/.test(snapshot.expectedTail.sha256)
    ) {
      throw new LegacySessionCheckpointMismatchError('invalid persistent mirror claim fields');
    }
    if (snapshot.status === 'creating') {
      const expectedMeta = fingerprintBytes(
        new TextEncoder().encode(`${JSON.stringify(normalizeMeta(snapshot.backendMeta))}\n`),
      );
      if (
        snapshot.activeSessionId !== snapshot.sourceSessionId ||
        snapshot.generation !== 0 ||
        snapshot.creationKey === undefined ||
        !sameFingerprint(snapshot.expectedTail, expectedMeta)
      ) {
        throw new LegacySessionCheckpointMismatchError('invalid persistent create intent');
      }
    }
    return snapshot;
  }

  #persistClaim(): void {
    const claim = strictJsonSnapshot(this.#requireClaim()) as unknown as PersistedLegacyMirrorClaim;
    mkdirSync(this.#dir, { recursive: true });
    const temporary = path.join(
      this.#dir,
      `.${this.#sourceSessionId}.${crypto.randomUUID()}.claim.tmp`,
    );
    try {
      writeFileSync(temporary, `${canonicalJson(claim)}\n`, { encoding: 'utf8', flag: 'wx' });
      const temporaryFd = openSync(temporary, 'r');
      try {
        fsyncSync(temporaryFd);
      } finally {
        closeSync(temporaryFd);
      }
      renameSync(temporary, this.#claimFile);
      const directoryFd = openSync(this.#dir, 'r');
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
    } finally {
      try {
        unlinkSync(temporary);
      } catch {
        // rename removes the temporary; failed creation may leave nothing to clean.
      }
    }
  }

  #requireClaim(): PersistedLegacyMirrorClaim {
    if (this.#claim === undefined) {
      throw new LegacySessionCheckpointMismatchError('persistent mirror claim is not initialized');
    }
    return this.#claim;
  }

  #mirrorFile(sessionId: string): string {
    return path.join(this.#dir, `${sessionId}.jsonl`);
  }
}

function isValidMetaRecord(value: unknown): value is MetaRecord {
  if (value === null || typeof value !== 'object') return false;
  const meta = value as Partial<MetaRecord>;
  const model = meta.model;
  return meta.type === 'meta'
    && meta.version === STORE_VERSION
    && typeof meta.protocolVersion === 'string'
    && meta.protocolVersion.length > 0
    && typeof meta.id === 'string'
    && SAFE_SESSION_ID.test(meta.id)
    && Number.isSafeInteger(meta.createdAt)
    && (meta.createdAt ?? -1) >= 0
    && typeof meta.cwd === 'string'
    && model !== null
    && typeof model === 'object'
    && typeof model.provider === 'string'
    && typeof model.api === 'string'
    && typeof model.model === 'string';
}

/** Restore SessionStore's frozen JSON field order after canonical claim JSON sorting. */
function normalizeMeta(meta: MetaRecord): MetaRecord {
  return {
    type: 'meta',
    version: STORE_VERSION,
    protocolVersion: meta.protocolVersion,
    id: meta.id,
    createdAt: meta.createdAt,
    cwd: meta.cwd,
    model: {
      provider: meta.model.provider,
      api: meta.model.api,
      model: meta.model.model,
    },
  };
}

function privateMirrorSessionId(
  sourceSessionId: string,
  workspaceId: WorkspaceId,
  threadId: ThreadId,
  generation: number,
): string {
  const hash = createHash('sha256')
    .update(canonicalJson([sourceSessionId, workspaceId, threadId]), 'utf8')
    .digest('hex')
    .slice(0, 32);
  return `runtime-private-${hash}-${generation.toString(36)}`;
}

function fingerprintFile(file: string): MirrorTailFingerprint {
  return fingerprintBytes(readFileSync(file));
}

function fingerprintFileOrUndefined(file: string): MirrorTailFingerprint | undefined {
  return existsSync(file) ? fingerprintFile(file) : undefined;
}

function fingerprintBytes(bytes: Uint8Array): MirrorTailFingerprint {
  return {
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function sameFingerprint(left: MirrorTailFingerprint, right: MirrorTailFingerprint): boolean {
  return left.byteLength === right.byteLength && left.sha256 === right.sha256;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * Canonical journal wins recovery. A legacy mirror may be a strict prefix when the process died
 * after host.commitEvent but before Session.append; append only that missing suffix. Any divergent
 * or unrepresentable executor state is quarantined instead of being disguised as a match.
 */
function reconcileSessionMirror(
  dir: string,
  id: string,
  checkpoint: ThreadDriverCheckpoint,
  pricing?: ModelPricing,
): void {
  if (
    checkpoint.frontend.pendingControls.length > 0
  ) {
    throw new LegacySessionCheckpointMismatchError(
      'legacy Session cannot hydrate pending controls',
    );
  }
  const store = new SessionStore(dir, id);
  store.repairTail();
  const loaded = loadSession(dir, id);
  const canonicalTranscript = checkpoint.frontend.transcript;
  if (loaded.messages.length > canonicalTranscript.length) {
    throw new LegacySessionCheckpointMismatchError('legacy transcript is ahead of canonical transcript');
  }
  for (let index = 0; index < loaded.messages.length; index++) {
    if (canonicalJson(loaded.messages[index]) !== canonicalJson(canonicalTranscript[index])) {
      throw new LegacySessionCheckpointMismatchError(`legacy transcript diverges at message ${index}`);
    }
  }
  for (const message of canonicalTranscript.slice(loaded.messages.length)) {
    store.append({ type: 'message', message });
  }

  const expectedCompaction = checkpoint.execution.compaction;
  if (expectedCompaction === undefined) {
    if (loaded.lastCompaction !== undefined) {
      throw new LegacySessionCheckpointMismatchError('legacy compaction is ahead of canonical checkpoint');
    }
  } else {
    const record = {
      type: 'compaction',
      id: expectedCompaction.id,
      timestamp: expectedCompaction.timestamp,
      tailStartId: expectedCompaction.tailStartId,
      summary: expectedCompaction.summary,
      ...(expectedCompaction.contextTokensBefore !== undefined && {
        contextTokensBefore: expectedCompaction.contextTokensBefore,
      }),
    } as const;
    if (loaded.lastCompaction === undefined) {
      store.append(record);
    } else if (canonicalJson(loaded.lastCompaction) !== canonicalJson(record)) {
      throw new LegacySessionCheckpointMismatchError('legacy compaction diverges from canonical checkpoint');
    }
  }
  store.fsync();

  const repaired = loadSession(dir, id);
  if (canonicalJson(repaired.messages) !== canonicalJson(canonicalTranscript)) {
    throw new LegacySessionCheckpointMismatchError('legacy transcript repair did not converge');
  }
  const usage = new UsageTracker(pricing);
  usage.seed(repaired.messages);
  if (canonicalJson(usage.snapshot()) !== canonicalJson(checkpoint.frontend.usage)) {
    throw new LegacySessionCheckpointMismatchError('legacy usage diverges from canonical checkpoint');
  }
  const repairedCompaction = repaired.lastCompaction;
  if (
    expectedCompaction === undefined
      ? repairedCompaction !== undefined
      : repairedCompaction === undefined ||
        canonicalJson({
          id: repairedCompaction.id,
          timestamp: repairedCompaction.timestamp,
          tailStartId: repairedCompaction.tailStartId,
          summary: repairedCompaction.summary,
          ...(repairedCompaction.contextTokensBefore !== undefined && {
            contextTokensBefore: repairedCompaction.contextTokensBefore,
          }),
        }) !== canonicalJson(expectedCompaction)
  ) {
    throw new LegacySessionCheckpointMismatchError('legacy compaction repair did not converge');
  }
}

function snapshotCheckpoint(checkpoint: ThreadDriverCheckpoint): ThreadDriverCheckpoint {
  return strictJsonSnapshot(checkpoint) as unknown as ThreadDriverCheckpoint;
}
