// Explicit adapters owned by the CLI composition root. Runtime core receives these narrow ports
// and never reads provider credentials, HOME, cwd, or approval flags on its own.

import path from 'node:path';
import type { ModelConfig, ModelRef, RuntimePermissionMode } from '../protocol/index.js';
import { canonicalJsonSha256, strictJsonSnapshot } from '../protocol/index.js';
import type {
  ModelResolution,
  PermissionCeilingSnapshot,
  PermissionNarrowing,
  PermissionPolicyPort,
  RuntimeModelResolver,
} from '../runtime/index.js';

export interface RuntimeStorageRoots {
  readonly runtimeRoot: string;
  readonly legacySessionDir: string;
}

export function resolveRuntimeStorageRoots(input: {
  readonly homeDir: string;
  readonly legacySessionDir?: string;
}): RuntimeStorageRoots {
  const legacySessionDir = input.legacySessionDir ?? path.join(input.homeDir, '.coda', 'sessions');
  return {
    legacySessionDir,
    runtimeRoot: input.legacySessionDir === undefined
      ? path.join(input.homeDir, '.coda', 'runtime-v2')
      : path.join(legacySessionDir, '.runtime-v2'),
  };
}

export interface LegacyModelLookup {
  resolveModel(providerId: string, modelId: string): ModelConfig | undefined;
}

export interface CliRuntimeModelResolver extends RuntimeModelResolver {
  register(model: ModelConfig): void;
}

export function createCliRuntimeModelResolver(
  lookup?: LegacyModelLookup,
): CliRuntimeModelResolver {
  const trusted = new Map<string, ModelConfig>();
  return {
    register(model): void {
      trusted.set(modelKey(model.ref), model);
    },

    async resolve(ref, context): Promise<ModelResolution> {
      if (context.signal.aborted) {
        return {
          ok: false,
          code: 'credentials_unavailable',
          message: 'model resolution was cancelled',
        };
      }
      const registered = trusted.get(modelKey(ref));
      if (registered !== undefined) return { ok: true, model: registered };

      const discovered = lookup?.resolveModel(ref.provider, ref.model);
      if (discovered === undefined) {
        return { ok: false, code: 'model_not_found', message: `model not found: ${displayRef(ref)}` };
      }
      if (!sameRef(discovered.ref, ref)) {
        return {
          ok: false,
          code: 'invalid_model',
          message: `model protocol mismatch: ${displayRef(ref)}`,
        };
      }
      trusted.set(modelKey(ref), discovered);
      return { ok: true, model: discovered };
    },
  };
}

export function createLegacyPermissionPolicy(
  mode: Exclude<RuntimePermissionMode, 'custom'> = 'interactive',
): PermissionPolicyPort {
  const workspace = ceiling('workspace', [], []);
  return {
    async snapshotWorkspaceCeiling(): Promise<PermissionCeilingSnapshot> {
      return workspace;
    },

    async snapshotWorkspacePermissionStatus() {
      return {
        mode,
        policyRevision: `legacy-cli-${mode}-v2`,
      };
    },

    async resolveCeiling(input): Promise<PermissionCeilingSnapshot> {
      switch (input.kind) {
        case 'root_thread':
          return narrow(input.workspaceCeiling, input.requestedNarrowing);
        case 'child_thread': {
          const combined = combine(
            'child_thread',
            [input.workspaceCeiling, input.parentCeiling],
            input.requestedNarrowing,
          );
          return snapshotCeiling({
            ...combined,
            inheritedFrom: {
              parentThreadId: input.parentThreadId,
              ...(input.parentRunId !== undefined && { parentRunId: input.parentRunId }),
              parentCeilingRevision: input.parentCeiling.revision,
            },
          });
        }
        case 'run':
          return combine(
            'run',
            [
              input.workspaceCeiling,
              input.threadCeiling,
              ...(input.predecessorCeiling === undefined ? [] : [input.predecessorCeiling]),
            ],
            input.requestedNarrowing,
          );
        case 'turn':
          return combine('turn', [input.workspaceCeiling, input.runCeiling]);
      }
    },
  };
}

function narrow(
  base: PermissionCeilingSnapshot,
  narrowing?: PermissionNarrowing,
): PermissionCeilingSnapshot {
  return narrowing === undefined ? snapshotCeiling(base) : combine('narrow', [base], narrowing);
}

function combine(
  domain: string,
  bases: readonly PermissionCeilingSnapshot[],
  narrowing?: PermissionNarrowing,
): PermissionCeilingSnapshot {
  const constraints = [
    ...bases.flatMap((base) => base.constraints),
    ...(narrowing?.constraints ?? []),
  ];
  return ceiling(
    domain,
    bases.map((base) => base.revision),
    constraints,
    narrowing?.revision,
  );
}

function ceiling(
  domain: string,
  baseRevisions: readonly string[],
  constraints: readonly Readonly<Record<string, unknown>>[],
  narrowingRevision?: string,
): PermissionCeilingSnapshot {
  return snapshotCeiling({
    revision: `legacy-v1-${canonicalJsonSha256({
      domain,
      baseRevisions,
      constraints,
      ...(narrowingRevision !== undefined && { narrowingRevision }),
    })}`,
    constraints,
  });
}

function snapshotCeiling(input: PermissionCeilingSnapshot): PermissionCeilingSnapshot {
  return strictJsonSnapshot(input) as unknown as PermissionCeilingSnapshot;
}

function sameRef(left: ModelRef, right: ModelRef): boolean {
  return (
    left.provider === right.provider &&
    left.api === right.api &&
    left.model === right.model
  );
}

function modelKey(ref: ModelRef): string {
  return JSON.stringify([ref.provider, ref.api, ref.model]);
}

function displayRef(ref: ModelRef): string {
  return `${ref.provider}/${ref.model} (${ref.api})`;
}
