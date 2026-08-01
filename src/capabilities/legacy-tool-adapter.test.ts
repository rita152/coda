import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import type {
  RunId,
  ThreadId,
  TurnId,
  WorkspaceId,
} from '../protocol/index.js';
import type { FileTrackerPort } from '../shared/index.js';
import type { ToolDefinition } from '../tools/types.js';
import {
  adaptLegacyTool,
  type LegacyToolCapabilityBinding,
} from './legacy-tool-adapter.js';
import type { CapabilityExecutionContext } from './types.js';

const IMPLEMENTATION = `impl_sha256_${'a'.repeat(64)}`;

describe('adaptLegacyTool', () => {
  test('captures schema/validator/executor and copies only explicit policy/resource binding', async () => {
    const executionRecords: unknown[] = [];
    const tracker = new FakeFileTracker();
    const updates: Readonly<Record<string, unknown>>[] = [];
    const policy = {
      kind: 'plan' as const,
      resources: [] as const,
      attributes: { source: { name: 'explicit-binding' } },
    };
    const metadata = { release: { version: 1 } };
    const resolver = async () => ({ ok: true as const, resources: [] });
    const originalExecute: ToolDefinition<{ value: string }>['execute'] = async (call, context) => {
      executionRecords.push({ call, context });
      context.onUpdate?.({ output: 'progress' });
      return {
        content: [{ type: 'text', text: call.args.value }],
        details: { trackerMatched: context.fileTracker === tracker },
        terminate: true,
      };
    };
    const tool: ToolDefinition<{ value: string }> = {
      name: 'explicit',
      description: 'explicit legacy tool',
      parameters: z.object({ value: z.string().describe('Value') }),
      kind: 'execute',
      executionMode: 'sequential',
      promptSnippet: 'Use explicitly.',
      prepareArguments: (input) => ({
        value: (input as { value: string }).value.trim(),
      }),
      execute: originalExecute,
    };
    const registration = adaptLegacyTool({
      tool,
      version: '1',
      implementationDigest: IMPLEMENTATION,
      metadata,
      policy,
      resolveResources: resolver,
    });

    metadata.release.version = 99;
    policy.attributes.source.name = 'mutated';
    tool.parameters = z.object({ value: z.number() }) as unknown as typeof tool.parameters;
    tool.execute = async () => ({ content: [] });

    expect(registration).toMatchObject({
      id: 'explicit',
      version: '1',
      implementationDigest: IMPLEMENTATION,
      description: 'explicit legacy tool',
      executionMode: 'sequential',
      promptSnippet: 'Use explicitly.',
      metadata: { release: { version: 1 } },
      policy: { kind: 'plan', resources: [], attributes: { source: { name: 'explicit-binding' } } },
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string', description: 'Value' } },
      },
    });
    expect(registration.resolveResources).toBe(resolver);
    expect(Object.isFrozen(registration)).toBe(true);
    expect(Object.isFrozen(registration.policy.attributes?.['source'])).toBe(true);

    expect(registration.prepare?.({ value: '  kept  ' })).toEqual({ value: 'kept' });
    expect(registration.validate({ value: 'valid' })).toEqual({
      ok: true,
      value: { value: 'valid' },
    });
    expect(registration.validate({ value: 1 })).toMatchObject({ ok: false });

    const context = executionContext(tracker, (update) => updates.push(update));
    const output = await registration.execute({ value: 'result' }, context);
    expect(output).toEqual({
      content: [{ type: 'text', text: 'result' }],
      details: { trackerMatched: true },
      terminate: true,
    });
    expect(updates).toEqual([{ output: 'progress' }]);
    expect(executionRecords).toHaveLength(1);
    expect(executionRecords[0]).toMatchObject({
      call: { id: 'raw-provider-tool-call', args: { value: 'result' } },
      context: {
        cwd: '/workspace',
        fileTracker: tracker,
        signal: context.signal,
      },
    });
  });

  test('requires an explicit complete binding instead of inferring policy from name or kind', () => {
    const tool: ToolDefinition = {
      name: 'read',
      description: 'read',
      parameters: z.object({}),
      kind: 'read',
      execute: async () => ({ content: [] }),
    };

    expect(() => adaptLegacyTool({
      tool,
      version: '1',
      implementationDigest: IMPLEMENTATION,
      policy: { kind: 'read', resources: [] },
    } as unknown as LegacyToolCapabilityBinding)).toThrow('resolveResources');
    expect(() => adaptLegacyTool({
      tool,
      version: '1',
      implementationDigest: IMPLEMENTATION,
      resolveResources: async () => ({ ok: true, resources: [] }),
    } as unknown as LegacyToolCapabilityBinding)).toThrow();
  });
});

class FakeFileTracker implements FileTrackerPort {
  readonly #reads = new Map<string, number>();

  markRead(path: string, mtimeMs: number): void {
    this.#reads.set(path, mtimeMs);
  }

  assertFresh(path: string, currentMtimeMs: number) {
    const prior = this.#reads.get(path);
    if (prior === undefined) return { ok: false as const, reason: 'never_read' as const };
    if (currentMtimeMs > prior) return { ok: false as const, reason: 'stale' as const };
    return { ok: true as const };
  }

  hasRead(path: string): boolean {
    return this.#reads.has(path);
  }
}

function executionContext(
  fileTracker: FileTrackerPort,
  onUpdate: (update: Readonly<Record<string, unknown>>) => void,
): CapabilityExecutionContext {
  return {
    workspaceId: 'workspace' as WorkspaceId,
    threadId: 'thread' as ThreadId,
    runId: 'run' as RunId,
    turnId: 'turn' as TurnId,
    invocationId: 'invocation-id',
    toolCallId: 'raw-provider-tool-call',
    capabilityId: 'explicit',
    catalogRevision: 1,
    cwd: '/workspace',
    signal: new AbortController().signal,
    onUpdate,
    services: { fileTracker },
  };
}
