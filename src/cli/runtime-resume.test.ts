import { describe, expect, it } from 'bun:test';
import type { StoredThreadLocator, ThreadId, WorkspaceId } from '../runtime/index.js';
import {
  CliResumeSelectionError,
  selectCliResumeTarget,
} from './runtime-resume.js';

const THREAD_ID = 'same-thread' as ThreadId;

describe('runtime global resume selection', () => {
  it('keeps --continue global and chooses the newest catalog item', async () => {
    const old = locator('workspace-a', 'old-thread', 10, 'old-session');
    const recent = locator('workspace-b', 'new-thread', 20, 'new-session');
    expect(
      await selectCliResumeTarget([old, recent], {
        continue_: true,
      }),
    ).toBe(recent);
  });

  it('resolves a legacy id or a unique opaque thread id directly', async () => {
    const legacy = locator('workspace-a', 'thread-a', 10, 'legacy-session');
    expect(
      await selectCliResumeTarget([legacy], {
        continue_: false,
        resume: 'legacy-session',
      }),
    ).toBe(legacy);
    expect(
      await selectCliResumeTarget([legacy], {
        continue_: false,
        resume: 'thread-a',
      }),
    ).toBe(legacy);
  });

  it('requires a workspace when the same thread id appears in multiple workspaces', async () => {
    const left = locator('workspace-a', THREAD_ID, 10);
    const right = locator('workspace-b', THREAD_ID, 20);
    const ambiguous = selectCliResumeTarget([left, right], {
      continue_: false,
      resume: THREAD_ID,
    });
    await expect(ambiguous).rejects.toBeInstanceOf(CliResumeSelectionError);
    await expect(ambiguous).rejects.toMatchObject({ code: 'ambiguous_thread_id' });

    expect(
      await selectCliResumeTarget([left, right], {
        continue_: false,
        resume: THREAD_ID,
        workspace: 'workspace-a',
      }),
    ).toBe(left);
  });

  it('rejects an indexed legacy item whose recorded cwd is not executable', async () => {
    const invalid = locator('workspace-a', 'thread-a', 10, 'legacy-session', false);
    await expect(
      selectCliResumeTarget([invalid], {
        continue_: false,
        resume: 'legacy-session',
      }),
    ).rejects.toMatchObject({ code: 'invalid_legacy_workspace_cwd' });
  });
});

function locator(
  workspaceId: string,
  threadId: string,
  createdAt: number,
  sourceSessionId?: string,
  mutable = true,
): StoredThreadLocator {
  return {
    ...(sourceSessionId !== undefined && { sourceSessionId }),
    ownerWorkspaceId: workspaceId as WorkspaceId,
    ownerRecordedCwd: mutable ? `/work/${workspaceId}` : 'relative/cwd',
    threadId: threadId as ThreadId,
    catalog: {
      format: sourceSessionId === undefined ? 'runtime-v2' : 'session-v1',
      storageKey: `key-${workspaceId}-${threadId}`,
      summary: {
        threadId: threadId as ThreadId,
        createdAt,
        title: `title ${createdAt}`,
        state: 'idle',
      },
    },
    executionEligibility: mutable
      ? { kind: 'mutable' }
      : { kind: 'read_only', code: 'invalid_legacy_workspace_cwd' },
  };
}
