// Native registrations for the eight built-in coding capabilities. Each registration binds its
// prompt schema, validator, policy/resource semantics and executor in one immutable value.

import { z } from 'zod';
import {
  BASH_DESCRIPTION,
  BASH_PROMPT_SNIPPET,
  EDIT_DESCRIPTION,
  EDIT_PROMPT_SNIPPET,
  GLOB_DESCRIPTION,
  GREP_DESCRIPTION,
  LS_DESCRIPTION,
  PLAN_DESCRIPTION,
  PLAN_PROMPT_SNIPPET,
  READ_DESCRIPTION,
  READ_PROMPT_SNIPPET,
  WRITE_DESCRIPTION,
  bashParameters,
  editParameters,
  executeBash,
  executeEdit,
  executeGlob,
  executeGrep,
  executeLs,
  executePlan,
  executeRead,
  executeWrite,
  globParameters,
  grepParameters,
  lsParameters,
  planParameters,
  prepareEditArguments,
  readParameters,
  writeParameters,
} from '../../tools/index.js';
import type {
  ToolContext,
  ToolExecutionInput,
  ToolOutput,
} from '../../tools/index.js';
import {
  sha256Hex,
  strictJsonSnapshot,
} from '../../protocol/index.js';
import type { JSONSchema } from '../../protocol/index.js';
import type {
  CapabilityExecutionContext,
  CapabilityPolicyDescriptor,
  CapabilityRegistration,
  CapabilityResourceResolver,
} from '../../capabilities/types.js';
import {
  bashResourceResolver,
  emptyResourceResolver,
  optionalRootResolver,
  requiredPathResolver,
} from './resource-resolvers.js';

const VERSION = '3';

interface CodingCapabilityInput<P> {
  readonly id: string;
  readonly description: string;
  readonly parameters: z.ZodType<P>;
  readonly promptSnippet?: string;
  readonly executionMode?: 'sequential';
  readonly prepare?: (input: unknown) => unknown;
  readonly policy: Readonly<CapabilityPolicyDescriptor>;
  readonly resolveResources: CapabilityResourceResolver;
  readonly execute: (
    call: ToolExecutionInput<P>,
    context: ToolContext,
  ) => Promise<ToolOutput>;
}

function implementationDigest(id: string): string {
  return `impl_sha256_${sha256Hex(`coda.coding-capability.${id}.v3`)}`;
}

function defineCodingCapability<P>(
  input: Readonly<CodingCapabilityInput<P>>,
): Readonly<CapabilityRegistration> {
  const parameters = input.parameters;
  const inputSchema = strictJsonSnapshot({
    ...z.toJSONSchema(parameters),
  }) as unknown as JSONSchema;
  const metadata = strictJsonSnapshot({
    source: 'coda-built-in',
    capabilityId: input.id,
  }) as Readonly<Record<string, unknown>>;
  const policy = strictJsonSnapshot(input.policy) as unknown as Readonly<CapabilityPolicyDescriptor>;
  const execute = input.execute;

  return Object.freeze({
    id: input.id,
    version: VERSION,
    implementationDigest: implementationDigest(input.id),
    description: input.description,
    inputSchema,
    ...(input.promptSnippet !== undefined && { promptSnippet: input.promptSnippet }),
    ...(input.executionMode !== undefined && { executionMode: input.executionMode }),
    metadata,
    policy,
    ...(input.prepare !== undefined && { prepare: input.prepare }),
    validate: (value: unknown) => {
      const result = parameters.safeParse(value);
      return result.success
        ? { ok: true as const, value: result.data }
        : {
            ok: false as const,
            message:
              `The ${input.id} capability was called with invalid arguments: ` +
              `${z.prettifyError(result.error)}. ` +
              'Please rewrite the input so it satisfies the expected schema.',
          };
    },
    resolveResources: input.resolveResources,
    execute: async (value: unknown, context: CapabilityExecutionContext) => execute(
      { id: context.toolCallId, args: value as P },
      {
        cwd: context.cwd,
        signal: context.signal,
        onUpdate: context.onUpdate,
        fileTracker: context.services.fileTracker,
      },
    ),
  });
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

/** Stable prompt/catalog order for the complete built-in coding capability set. */
export function createCodingCapabilityRegistrations(): readonly Readonly<CapabilityRegistration>[] {
  return Object.freeze([
    defineCodingCapability({
      id: 'read',
      description: READ_DESCRIPTION,
      parameters: readParameters,
      promptSnippet: READ_PROMPT_SNIPPET,
      policy: pathPolicy('read', 'file', 'read'),
      resolveResources: requiredPathResolver({ selectorId: 'file', access: 'read' }),
      execute: executeRead,
    }),
    defineCodingCapability({
      id: 'ls',
      description: LS_DESCRIPTION,
      parameters: lsParameters,
      policy: pathPolicy('read', 'root', 'read'),
      resolveResources: optionalRootResolver(),
      execute: executeLs,
    }),
    defineCodingCapability({
      id: 'glob',
      description: GLOB_DESCRIPTION,
      parameters: globParameters,
      policy: pathPolicy('search', 'root', 'read'),
      resolveResources: optionalRootResolver(),
      execute: executeGlob,
    }),
    defineCodingCapability({
      id: 'grep',
      description: GREP_DESCRIPTION,
      parameters: grepParameters,
      policy: pathPolicy('search', 'root', 'read'),
      resolveResources: optionalRootResolver(),
      execute: executeGrep,
    }),
    defineCodingCapability({
      id: 'bash',
      description: BASH_DESCRIPTION,
      parameters: bashParameters,
      promptSnippet: BASH_PROMPT_SNIPPET,
      executionMode: 'sequential',
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
      execute: executeBash,
    }),
    defineCodingCapability({
      id: 'edit',
      description: EDIT_DESCRIPTION,
      parameters: editParameters,
      promptSnippet: EDIT_PROMPT_SNIPPET,
      executionMode: 'sequential',
      prepare: prepareEditArguments,
      policy: pathPolicy('edit', 'file', 'write'),
      resolveResources: requiredPathResolver({ selectorId: 'file', access: 'write' }),
      execute: executeEdit,
    }),
    defineCodingCapability({
      id: 'write',
      description: WRITE_DESCRIPTION,
      parameters: writeParameters,
      executionMode: 'sequential',
      policy: pathPolicy('edit', 'file', 'write'),
      resolveResources: requiredPathResolver({ selectorId: 'file', access: 'write' }),
      execute: executeWrite,
    }),
    defineCodingCapability({
      id: 'plan',
      description: PLAN_DESCRIPTION,
      parameters: planParameters,
      promptSnippet: PLAN_PROMPT_SNIPPET,
      policy: { kind: 'plan', resources: [] },
      resolveResources: emptyResourceResolver,
      execute: executePlan,
    }),
  ]);
}

export {
  BASH_ANALYSIS_VERSION,
} from './bash-analyze.js';
export type {
  BashFilesystemTarget,
  BashInvocationAnalysisAttributes,
  FilesystemTarget,
} from './bash-analyze.js';
export {
  FILESYSTEM_ANALYSIS_VERSION,
} from './resource-resolvers.js';
export type {
  FilesystemInvocationAnalysisAttributes,
} from './resource-resolvers.js';
