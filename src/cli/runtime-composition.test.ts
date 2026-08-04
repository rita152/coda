import { describe, expect, it } from 'bun:test';
import type {
  ExternalOpId,
  ModelConfig,
  RunId,
  ThreadId,
  WorkspaceId,
} from '../protocol/index.js';
import {
  createCliRuntimeModelResolver,
  createCliPermissionPolicy,
} from './runtime-composition.js';

const MODEL: ModelConfig = {
  ref: { provider: 'configured', api: 'openai-responses', model: 'gpt-test' },
  apiKey: 'secret',
};
const WORKSPACE_ID = 'workspace' as WorkspaceId;
const THREAD_ID = 'thread' as ThreadId;
const OP_ID = 'op_e_00000000000000000000000000000001' as ExternalOpId;

describe('runtime CLI composition adapters', () => {
  it('resolves only a trusted exact ModelRef and never leaks it into the ref', async () => {
    const resolver = createCliRuntimeModelResolver({
      resolveModel: () => MODEL,
    });
    const context = {
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      opId: OP_ID,
      signal: new AbortController().signal,
    };
    expect(await resolver.resolve(MODEL.ref, context)).toEqual({ ok: true, model: MODEL });
    expect(
      await resolver.resolve({ ...MODEL.ref, api: 'openai-chat' }, context),
    ).toMatchObject({ ok: false, code: 'invalid_model' });

    const direct = createCliRuntimeModelResolver();
    direct.register(MODEL);
    expect(await direct.resolve(MODEL.ref, context)).toEqual({ ok: true, model: MODEL });
  });

  it('keeps permission derivation monotone across thread, run, and turn', async () => {
    const policy = createCliPermissionPolicy('deny');
    const workspace = await policy.snapshotWorkspaceCeiling({
      workspaceId: WORKSPACE_ID,
      cwd: '/workspace',
    });
    expect(await policy.snapshotWorkspacePermissionStatus?.({
      workspaceId: WORKSPACE_ID,
      cwd: '/workspace',
      workspaceCeiling: workspace,
    })).toEqual({ mode: 'deny', policyRevision: 'cli-permission-deny-v3' });
    const thread = await policy.resolveCeiling({
      kind: 'root_thread',
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      workspaceCeiling: workspace,
      requestedNarrowing: { revision: 'read-only-v1', constraints: [{ write: false }] },
    });
    const run = await policy.resolveCeiling({
      kind: 'run',
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      runId: 'run' as RunId,
      workspaceCeiling: workspace,
      threadCeiling: thread,
    });
    const turn = await policy.resolveCeiling({
      kind: 'turn',
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      runId: 'run' as RunId,
      turnId: 'turn' as never,
      workspaceCeiling: workspace,
      runCeiling: run,
    });

    expect(thread.constraints).toContainEqual({ write: false });
    expect(run.constraints).toContainEqual({ write: false });
    expect(turn.constraints).toContainEqual({ write: false });
    expect(Object.isFrozen(turn)).toBe(true);
    expect(turn.revision).not.toBe(thread.revision);
  });
});
