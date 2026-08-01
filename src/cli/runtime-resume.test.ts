import { describe, expect, it } from 'bun:test';
import type { StoredThreadLocator, ThreadId, WorkspaceId } from '../runtime/index.js';
import {
  CliResumeSelectionError,
  pickRuntimeThreadInteractive,
  selectCliResumeTarget,
} from './runtime-resume.js';
import { PassThrough } from 'node:stream';

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

  it('sanitizes every persisted locator field before rendering the interactive picker', async () => {
    const attack = '\x1b]52;c;RECOVERY_SECRET\x07\x1b[31mvisible\x1b[0m\x1bPpayload\x1b\\';
    const base = locator('workspace-a', 'thread-a', 10, 'legacy-session');
    const unsafe: StoredThreadLocator = {
      ...base,
      sourceSessionId: `session-${attack}`,
      ownerWorkspaceId: `workspace-${attack}` as WorkspaceId,
      ownerRecordedCwd: `/work/${attack}`,
      catalog: {
        ...base.catalog,
        summary: { ...base.catalog.summary, title: `title-${attack}` },
      },
    };
    const input = new PassThrough() as PassThrough & { isTTY?: boolean };
    input.isTTY = false;
    const output = new PassThrough();
    let written = '';
    output.on('data', (chunk: Buffer) => {
      written += chunk.toString('utf8');
    });

    await expect(pickRuntimeThreadInteractive([unsafe], { input, output })).resolves.toBeUndefined();
    expect(written).toContain('visible');
    expect(written).not.toContain('RECOVERY_SECRET');
    expect(written).not.toContain('\x1b');
    expect(written).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
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
