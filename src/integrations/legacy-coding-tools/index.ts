import { sha256Hex } from '../../protocol/index.js';
import {
  bashTool,
  editTool,
  globTool,
  grepTool,
  lsTool,
  planTool,
  readTool,
  writeTool,
} from '../../tools/index.js';
import type { LegacyToolCapabilityBinding } from '../../capabilities/legacy-tool-adapter.js';
import type { CapabilityPolicyDescriptor } from '../../capabilities/types.js';
import {
  bashResourceResolver,
  emptyResourceResolver,
  optionalRootResolver,
  requiredPathResolver,
} from './resource-resolvers.js';

const VERSION = '2';

function implementationDigest(id: string): string {
  return `impl_sha256_${sha256Hex(`coda.legacy-coding-tool.${id}.v2`)}`;
}

function metadata(id: string): Readonly<Record<string, unknown>> {
  return Object.freeze({ adapter: 'legacy-coding-tools-v2', capabilityId: id });
}

function pathPolicy(
  kind: 'read' | 'search' | 'edit',
  selectorId: 'file' | 'root',
  access: 'read' | 'write',
  required = true,
): CapabilityPolicyDescriptor {
  return {
    kind,
    resources: [{
      selectorId,
      resourceType: 'filesystem',
      argumentPointer: '/path',
      access,
      required,
    }],
  };
}

export function createCodingToolCapabilityBindings(): readonly Readonly<LegacyToolCapabilityBinding>[] {
  return Object.freeze([
    {
      tool: readTool,
      version: VERSION,
      implementationDigest: implementationDigest('read'),
      metadata: metadata('read'),
      policy: pathPolicy('read', 'file', 'read'),
      resolveResources: requiredPathResolver({ selectorId: 'file', access: 'read' }),
    },
    {
      tool: lsTool,
      version: VERSION,
      implementationDigest: implementationDigest('ls'),
      metadata: metadata('ls'),
      policy: pathPolicy('read', 'root', 'read'),
      resolveResources: optionalRootResolver(),
    },
    {
      tool: globTool,
      version: VERSION,
      implementationDigest: implementationDigest('glob'),
      metadata: metadata('glob'),
      policy: pathPolicy('search', 'root', 'read'),
      resolveResources: optionalRootResolver(),
    },
    {
      tool: grepTool,
      version: VERSION,
      implementationDigest: implementationDigest('grep'),
      metadata: metadata('grep'),
      policy: pathPolicy('search', 'root', 'read'),
      resolveResources: optionalRootResolver(),
    },
    {
      tool: bashTool,
      version: VERSION,
      implementationDigest: implementationDigest('bash'),
      metadata: metadata('bash'),
      policy: {
        kind: 'execute',
        resources: [
          {
            selectorId: 'command',
            resourceType: 'command',
            argumentPointer: '/command',
            access: 'execute',
            required: true,
          },
          {
            selectorId: 'workdir',
            resourceType: 'filesystem',
            argumentPointer: '/workdir',
            access: 'read',
            required: true,
          },
          {
            selectorId: 'filesystem_read_target',
            resourceType: 'filesystem',
            argumentPointer: '/command',
            access: 'read',
            required: false,
          },
          {
            selectorId: 'filesystem_write_target',
            resourceType: 'filesystem',
            argumentPointer: '/command',
            access: 'write',
            required: false,
          },
        ],
      },
      resolveResources: bashResourceResolver,
    },
    {
      tool: editTool,
      version: VERSION,
      implementationDigest: implementationDigest('edit'),
      metadata: metadata('edit'),
      policy: pathPolicy('edit', 'file', 'write'),
      resolveResources: requiredPathResolver({ selectorId: 'file', access: 'write' }),
    },
    {
      tool: writeTool,
      version: VERSION,
      implementationDigest: implementationDigest('write'),
      metadata: metadata('write'),
      policy: pathPolicy('edit', 'file', 'write'),
      resolveResources: requiredPathResolver({ selectorId: 'file', access: 'write' }),
    },
    {
      tool: planTool,
      version: VERSION,
      implementationDigest: implementationDigest('plan'),
      metadata: metadata('plan'),
      policy: { kind: 'plan', resources: [] },
      resolveResources: emptyResourceResolver,
    },
  ]);
}

export type { LegacyToolCapabilityBinding } from '../../capabilities/legacy-tool-adapter.js';
export {
  LEGACY_FILESYSTEM_ANALYSIS_VERSION,
} from './resource-resolvers.js';
export type {
  LegacyFilesystemInvocationAnalysisAttributes,
} from './resource-resolvers.js';
