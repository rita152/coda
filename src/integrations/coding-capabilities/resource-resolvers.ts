// Resource resolvers for the eight native coding capability registrations.
import path from 'node:path';
import type {
  CapabilityInvocationAnalysis,
  CapabilityResourceResolution,
  CapabilityResourceResolver,
  ResolvedCapabilityResource,
} from '../../capabilities/types.js';
import {
  canonicalizePath,
  compareUtf8,
  isPathInside,
  resolveToolWorkdir,
} from '../../shared/index.js';
import {
  BASH_ANALYSIS_VERSION,
  analyzeBashCommand,
  analyzeBashPaths,
} from './bash-analyze.js';
import type { FilesystemTarget } from './bash-analyze.js';

type JsonArgs = Readonly<Record<string, unknown>>;

export const FILESYSTEM_ANALYSIS_VERSION = 'filesystem_analysis_v2';

export interface FilesystemInvocationAnalysisAttributes {
  readonly kind: typeof FILESYSTEM_ANALYSIS_VERSION;
  readonly filesystemTargets: readonly Readonly<FilesystemTarget>[];
}

export function requiredPathResolver(input: {
  readonly selectorId: string;
  readonly access: 'read' | 'write';
}): CapabilityResourceResolver {
  return async (args, context) => {
    const pathValue = asArgs(args).path;
    if (typeof pathValue !== 'string' || pathValue.length === 0) {
      return failed(`The ${input.selectorId} path is missing`);
    }
    const canonicalTarget = canonicalPath(context.cwd, pathValue);
    return resolved(
      [filesystem(input.selectorId, input.access, canonicalTarget)],
      filesystemAnalysis([{ canonicalTarget, kind: 'file' }]),
    );
  };
}

export function optionalRootResolver(): CapabilityResourceResolver {
  return async (args, context) => {
    const pathValue = asArgs(args).path;
    if (pathValue !== undefined && typeof pathValue !== 'string') {
      return failed('The root path must be a string when present');
    }
    const canonicalTarget = canonicalPath(context.cwd, pathValue ?? '.');
    return resolved(
      [filesystem('root', 'read', canonicalTarget)],
      filesystemAnalysis([{ canonicalTarget, kind: 'directory' }]),
    );
  };
}

export const emptyResourceResolver: CapabilityResourceResolver = async () =>
  resolved([], filesystemAnalysis([]));

export const bashResourceResolver: CapabilityResourceResolver = async (args, context) => {
  const record = asArgs(args);
  if (typeof record.command !== 'string' || record.command.length === 0) {
    return failed('The command is missing');
  }
  if (record.workdir !== undefined && typeof record.workdir !== 'string') {
    return failed('The command workdir must be a string when present');
  }
  let projectRoot: string;
  let workdir: string;
  let pathAnalysis: ReturnType<typeof analyzeBashPaths>;
  try {
    projectRoot = canonicalizePath(context.cwd);
    workdir = resolveToolWorkdir(context.cwd, record.workdir);
    pathAnalysis = analyzeBashPaths(record.command, context.cwd, record.workdir);
  } catch (error) {
    return failed(`The command workdir could not be canonicalized: ${errorMessage(error)}`);
  }

  const commandAnalysis = analyzeBashCommand(record.command);
  const coverageReasons = new Set(pathAnalysis.reasons);
  const onceOnlyReasons = new Set<string>();
  if (!pathAnalysis.complete) {
    for (const reason of pathAnalysis.reasons) onceOnlyReasons.add(reason);
  }
  if (commandAnalysis.denied) {
    onceOnlyReasons.add('denied commands cannot produce persistent grants');
  } else if (commandAnalysis.forceConfirm) {
    for (const reason of commandAnalysis.reasons) onceOnlyReasons.add(reason);
  }

  const resources: ResolvedCapabilityResource[] = [
    {
      selectorId: 'command',
      resourceType: 'command',
      access: 'execute',
      canonicalTarget: record.command,
    },
    filesystem('workdir', 'read', workdir),
  ];
  const filesystemTargetKinds = new Map<string, FilesystemTarget['kind']>([
    [workdir, 'directory'],
  ]);

  let accessesExternalProject = false;
  for (const target of pathAnalysis.targets) {
    if (target.source === 'workdir') {
      mergeTargetKind(filesystemTargetKinds, workdir, target.kind);
      continue;
    }
    let canonicalTarget: string;
    try {
      canonicalTarget = canonicalizePath(target.path);
    } catch (error) {
      const reason = `filesystem target could not be canonicalized: ${errorMessage(error)}`;
      coverageReasons.add(reason);
      onceOnlyReasons.add(reason);
      continue;
    }
    if (!isPathInside(projectRoot, canonicalTarget)) {
      accessesExternalProject = true;
      onceOnlyReasons.add(`filesystem target is outside the project root: ${canonicalTarget}`);
    }
    mergeTargetKind(filesystemTargetKinds, canonicalTarget, target.kind);
    // The frozen shell analyzer identifies all literal targets but cannot soundly infer an arbitrary
    // program's access mode. Bind both sides so an exact grant can never omit a possible mutation.
    resources.push(filesystem('filesystem_read_target', 'read', canonicalTarget));
    resources.push(filesystem('filesystem_write_target', 'write', canonicalTarget));
  }
  if (!isPathInside(projectRoot, workdir)) {
    accessesExternalProject = true;
    onceOnlyReasons.add(`command workdir is outside the project root: ${workdir}`);
  }

  const attributes = {
    kind: BASH_ANALYSIS_VERSION,
    command: record.command,
    forceConfirm: commandAnalysis.denied ? true : commandAnalysis.forceConfirm,
    reasons: commandAnalysis.denied
      ? [commandAnalysis.reason]
      : [...new Set([...commandAnalysis.reasons, ...pathAnalysis.reasons])],
    accessesExternalProject,
    filesystemTargets: [...filesystemTargetKinds.entries()]
      .sort(([left], [right]) => compareUtf8(left, right))
      .map(([canonicalTarget, kind]) => ({ canonicalTarget, kind })),
    ...(typeof record.description === 'string' && record.description.length > 0
      ? { modelDescription: record.description }
      : {}),
  };
  const analysis: CapabilityInvocationAnalysis = {
    resourceCoverage: coverageReasons.size === 0
      ? { kind: 'complete' }
      : { kind: 'incomplete', reasons: [...coverageReasons] as [string, ...string[]] },
    grantability: onceOnlyReasons.size === 0
      ? { kind: 'persistable' }
      : { kind: 'once_only', reasons: [...onceOnlyReasons] as [string, ...string[]] },
    safety: commandAnalysis.denied
      ? {
          kind: 'deny',
          code: 'bash_command_denied',
          reason: deniedReason(commandAnalysis.reason),
        }
      : { kind: 'eligible' },
    attributes,
  };
  return resolved(resources, analysis);
};

function mergeTargetKind(
  targets: Map<string, FilesystemTarget['kind']>,
  canonicalTarget: string,
  kind: FilesystemTarget['kind'],
): void {
  const current = targets.get(canonicalTarget);
  if (current === undefined) {
    targets.set(canonicalTarget, kind);
  } else if (current !== kind) {
    targets.set(canonicalTarget, 'unknown');
  }
}

function filesystemAnalysis(
  filesystemTargets: readonly Readonly<FilesystemTarget>[],
): CapabilityInvocationAnalysis {
  return {
    resourceCoverage: { kind: 'complete' },
    grantability: { kind: 'persistable' },
    safety: { kind: 'eligible' },
    attributes: {
      kind: FILESYSTEM_ANALYSIS_VERSION,
      filesystemTargets: [...filesystemTargets]
        .sort((left, right) => compareUtf8(left.canonicalTarget, right.canonicalTarget)),
    },
  };
}

function canonicalPath(cwd: string, value: string): string {
  return canonicalizePath(path.resolve(cwd, value));
}

function filesystem(
  selectorId: string,
  access: 'read' | 'write',
  canonicalTarget: string,
): ResolvedCapabilityResource {
  return { selectorId, resourceType: 'filesystem', access, canonicalTarget };
}

function resolved(
  resources: readonly ResolvedCapabilityResource[],
  analysis?: Readonly<CapabilityInvocationAnalysis>,
): CapabilityResourceResolution {
  return { ok: true, resources, ...(analysis === undefined ? {} : { analysis }) };
}

function failed(message: string): CapabilityResourceResolution {
  return { ok: false, code: 'resource_resolution_failed', message };
}

function asArgs(value: unknown): JsonArgs {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonArgs
    : {};
}

function deniedReason(detail: string): string {
  return `User denied permission: ${detail}. Do not retry the same call; ask the user or take a different approach.`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
