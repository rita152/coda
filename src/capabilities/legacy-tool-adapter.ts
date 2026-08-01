import { strictJsonSnapshot } from '../protocol/index.js';
import type { JSONSchema } from '../protocol/index.js';
import type { ToolDefinition } from '../tools/types.js';
import { z } from 'zod';
import type {
  CapabilityExecutionContext,
  CapabilityPolicyDescriptor,
  CapabilityRegistration,
  CapabilityResourceResolver,
} from './types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- legacy ToolDefinition arrays are heterogeneous.
export interface LegacyToolCapabilityBinding<P = any, D = unknown> {
  readonly tool: ToolDefinition<P, D>;
  readonly version: string;
  readonly implementationDigest: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly policy: Readonly<CapabilityPolicyDescriptor>;
  readonly resolveResources: CapabilityResourceResolver;
}

/**
 * Mechanically wrap one explicitly bound legacy tool. Policy and resource semantics always come from
 * the binding; this adapter deliberately does not inspect tool.name or tool.kind to invent them.
 */
export function adaptLegacyTool(
  binding: Readonly<LegacyToolCapabilityBinding>,
): CapabilityRegistration {
  if (binding === null || typeof binding !== 'object') {
    throw new TypeError('A legacy capability binding is required.');
  }
  const tool = binding.tool;
  if (tool === null || typeof tool !== 'object') throw new TypeError('binding.tool is required.');
  if (typeof tool.name !== 'string' || tool.name.length === 0) {
    throw new TypeError('binding.tool.name must be a non-empty string.');
  }
  if (typeof tool.description !== 'string') {
    throw new TypeError('binding.tool.description must be a string.');
  }
  if (typeof binding.version !== 'string' || binding.version.length === 0) {
    throw new TypeError('binding.version must be a non-empty string.');
  }
  if (typeof binding.implementationDigest !== 'string') {
    throw new TypeError('binding.implementationDigest must be a string.');
  }
  if (typeof binding.resolveResources !== 'function') {
    throw new TypeError('binding.resolveResources must be a function.');
  }
  if (tool.parameters === undefined || typeof tool.parameters.safeParse !== 'function') {
    throw new TypeError('binding.tool.parameters must be a Zod schema.');
  }
  if (typeof tool.execute !== 'function') throw new TypeError('binding.tool.execute must be a function.');

  const toolName = tool.name;
  const toolDescription = tool.description;
  const promptSnippet = tool.promptSnippet;
  const executionMode = tool.executionMode;
  const parameters = tool.parameters;
  const legacyPrepare = tool.prepareArguments?.bind(tool);
  const legacyExecute = tool.execute.bind(tool);
  const resolveResources = binding.resolveResources;
  // Zod attaches a non-enumerable Standard Schema helper to the root result. It is not JSON Schema
  // data and JSON serialization intentionally omits it, so detach the enumerable schema fields first.
  const inputSchema = strictJsonSnapshot({ ...z.toJSONSchema(parameters) }) as unknown as JSONSchema;
  const metadata = strictJsonSnapshot(binding.metadata ?? {}) as Readonly<Record<string, unknown>>;
  const policy = strictJsonSnapshot(binding.policy) as unknown as Readonly<CapabilityPolicyDescriptor>;

  return Object.freeze({
    id: toolName,
    version: binding.version,
    implementationDigest: binding.implementationDigest,
    description: toolDescription,
    inputSchema,
    ...(promptSnippet !== undefined && { promptSnippet }),
    ...(executionMode !== undefined && { executionMode }),
    metadata,
    policy,
    ...(legacyPrepare !== undefined && {
      prepare: (input: unknown): unknown => legacyPrepare(input),
    }),
    validate: (input: unknown) => {
      const result = parameters.safeParse(input);
      return result.success
        ? { ok: true as const, value: result.data }
        : {
            ok: false as const,
            message: `The ${toolName} tool was called with invalid arguments: ${z.prettifyError(result.error)}. `
              + 'Please rewrite the input so it satisfies the expected schema.',
          };
    },
    resolveResources,
    execute: async (input: unknown, context: CapabilityExecutionContext) => legacyExecute(
      { id: context.toolCallId, args: input },
      {
        cwd: context.cwd,
        signal: context.signal,
        onUpdate: (update) => context.onUpdate(update),
        fileTracker: context.services.fileTracker,
      },
    ),
  });
}
