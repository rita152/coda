import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import type {
  ExternalOpId,
  RunId,
  ThreadId,
  TurnId,
  WorkspaceId,
} from '../protocol/index.js';
import type {
  LegacyApprovalPatternCommitResult,
  LegacyApprovalPatternRepositoryPort,
} from '../runtime/index.js';
import type { ToolDefinition } from '../tools/types.js';
import { createStaticLegacyApprovalAdapterFactory } from './legacy-approval-adapter.js';

const WORKSPACE_ID = 'workspace-legacy-adapter' as WorkspaceId;
const THREAD_ID = 'thread-legacy-adapter' as ThreadId;
const RUN_ID = 'run-legacy-adapter' as RunId;
const TURN_ID = 'turn-legacy-adapter' as TurnId;

describe('static LegacyApprovalAdapter', () => {
  test('preflight reads the current pattern snapshot but owns no event or waiter', async () => {
    const repository = fakeRepository(['bash:npm *']);
    const adapter = await factory().open({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      patterns: repository.port,
    });
    await expect(adapter.preflight(invocation('bash', { command: 'npm test' }))).resolves.toEqual({
      kind: 'allow',
    });
    const ask = await adapter.preflight(invocation('bash', { command: 'git push' }));
    expect(ask).toMatchObject({
      kind: 'ask',
      proposal: { patterns: ['bash:git *'], forceConfirm: false },
    });
    expect(repository.commits).toEqual([]);
    await adapter.close();
  });

  test('allow_always waits for one atomic multi-pattern commit before it returns', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const repository = fakeRepository([], async () => {
      await gate;
      return { kind: 'applied', revision: 'after' };
    });
    const adapter = await factory().open({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      patterns: repository.port,
    });
    let settled = false;
    const applying = adapter.applyResponse({
      request: requestSnapshot(['edit:/project/**', 'bash:npm *']),
      responseOpId: 'op_e_b1000000000000000000000000000001' as ExternalOpId,
      acceptedAt: 11,
      decision: 'allow_always',
    }).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(repository.commits[0]?.patterns).toEqual(['bash:npm *', 'edit:/project/**']);
    release();
    await expect(applying).resolves.toEqual({
      ok: true,
      effectiveDecision: 'allow_always',
      persistedPatterns: ['bash:npm *', 'edit:/project/**'],
    });
  });

  test('force/empty allow_always normalizes once and repository failures stay typed', async () => {
    const repository = fakeRepository([], async () => ({
      kind: 'definitely_not_applied',
      message: 'disk remained unchanged',
    }));
    const adapter = await factory().open({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      patterns: repository.port,
    });
    await expect(adapter.applyResponse({
      request: { ...requestSnapshot(['bash:npm *']), proposal: { patterns: ['bash:npm *'], forceConfirm: true } },
      responseOpId: 'op_e_b2000000000000000000000000000002' as ExternalOpId,
      acceptedAt: 12,
      decision: 'allow_always',
    })).resolves.toEqual({
      ok: true,
      effectiveDecision: 'allow_once',
      persistedPatterns: [],
    });
    expect(repository.commits).toHaveLength(0);
    await expect(adapter.applyResponse({
      request: requestSnapshot(['bash:npm *']),
      responseOpId: 'op_e_b3000000000000000000000000000003' as ExternalOpId,
      acceptedAt: 13,
      decision: 'allow_always',
    })).resolves.toEqual({
      ok: false,
      code: 'legacy_approval_definitely_not_applied',
      message: 'disk remained unchanged',
    });
  });
});

function factory() {
  return createStaticLegacyApprovalAdapterFactory({
    mode: 'interactive',
    projectRoot: '/project',
    tools: [fakeTool('bash', 'execute'), fakeTool('edit', 'edit')],
  });
}

function invocation(toolName: string, args: Record<string, unknown>) {
  return {
    context: {
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      runId: RUN_ID,
      turnId: TURN_ID,
      toolCallId: 'call-1',
      toolName,
      cwd: '/project',
      policyRevision: 'policy-v1',
      permissionCeiling: { revision: 'ceiling-v1', constraints: [] },
    },
    args,
  };
}

function requestSnapshot(patterns: readonly string[]) {
  return {
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    requestId: 'request-1',
    owningRunId: RUN_ID,
    owningTurnId: TURN_ID,
    toolCallId: 'call-1',
    description: 'approve',
    policyRevision: 'policy-v1',
    proposal: { patterns, forceConfirm: false },
  };
}

function fakeRepository(
  initial: readonly string[],
  commit: () => Promise<LegacyApprovalPatternCommitResult> = async () => ({
    kind: 'applied',
    revision: 'next',
  }),
): {
  readonly port: LegacyApprovalPatternRepositoryPort;
  readonly commits: Array<{
    readonly responseOpId: ExternalOpId;
    readonly acceptedAt: number;
    readonly patterns: readonly [string, ...string[]];
  }>;
} {
  const commits: Array<{
    readonly responseOpId: ExternalOpId;
    readonly acceptedAt: number;
    readonly patterns: readonly [string, ...string[]];
  }> = [];
  return {
    commits,
    port: {
      workspaceId: WORKSPACE_ID,
      snapshot: async () => ({ revision: 'initial', patterns: initial }),
      commit: async (input) => {
        commits.push(input);
        return commit();
      },
    },
  };
}

function fakeTool(name: string, kind: ToolDefinition['kind']): ToolDefinition {
  return {
    name,
    kind,
    description: name,
    parameters: z.object({}).passthrough(),
    execute: async () => ({ content: [] }),
  };
}
