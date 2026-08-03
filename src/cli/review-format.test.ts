import { describe, expect, it } from 'bun:test';
import type {
  ApprovalPresentation,
  RuntimeReviewSnapshot,
  RuntimeThreadListItem,
} from '../protocol/index.js';
import {
  approvalAllowsAlways,
  filterSessionItems,
  formatApprovalPresentation,
  formatReviewSnapshot,
} from './review-format.js';

describe('UX3 review formatting', () => {
  it('searches session identity, state, time, workspace, cwd, and preview before newest-first display', () => {
    const items = [
      sessionItem('thread-old', 1, 'idle', 'older summary'),
      sessionItem('thread-new', 2, 'running', 'needle preview', 2),
    ];
    expect(filterSessionItems(items, 'archived needle /workspace').map((item) =>
      String(item.thread.threadId))).toEqual(['thread-new']);
  });

  it('prints full explicit review details while stripping terminal controls', () => {
    const review: RuntimeReviewSnapshot = {
      workspaceId: 'workspace-review' as never,
      threadId: 'thread-review' as never,
      highWaterSeq: 4,
      reasoning: [{
        key: 'reasoning-1',
        messageId: 'assistant-1',
        status: 'completed',
        startedAt: 1,
        endedAt: 3,
        durationMs: 2,
        content: `full reasoning\u001b]0;bad\u0007`,
      }],
      tools: [{
        key: 'tool-1',
        toolCallId: 'call-1',
        name: 'edit',
        target: 'src/file.ts',
        status: 'succeeded',
        startedAt: 1,
        endedAt: 3,
        durationMs: 2,
        args: { path: 'src/file.ts' },
        output: 'complete streamed output',
        result: {
          role: 'tool_result',
          id: 'result-1',
          timestamp: 3,
          toolCallId: 'call-1',
          toolName: 'edit',
          isError: false,
          content: [{ type: 'text', text: 'complete result' }],
        },
      }],
    };
    const reviewText = formatReviewSnapshot(review).join('\n');
    expect(reviewText).toContain('full reasoning');
    expect(reviewText).toContain('complete streamed output');
    expect(reviewText).toContain('complete result');
    expect(reviewText).not.toContain('\u001b');
  });

  it('renders only Runtime-authored approval scope and marks legacy scope unavailable', () => {
    const presentation: ApprovalPresentation = {
      requestId: 'request-1',
      target: {
        workspaceId: 'workspace-review' as never,
        threadId: 'thread-review' as never,
        runId: 'run-review' as never,
        turnId: 'turn-review' as never,
      },
      capability: { id: 'shell', version: '1', registrationDigest: 'digest' },
      normalizedResources: [{
        selectorId: 'command', resourceType: 'command', access: 'execute', canonicalTarget: 'bun test',
      }],
      risk: { code: 'ask', reason: 'execute', description: 'Run tests' },
      allowOnce: { invocationId: 'invocation-1', toolCallId: 'call-1' },
      allowAlways: { kind: 'legacy_global_approvals_v1', patterns: ['Bash(bun test)'] },
      revisions: {
        catalog: 1,
        effectivePolicy: 'effective',
        policyBasis: 'basis',
        ceiling: 'ceiling',
        grants: 'grants',
      },
    };
    const card = formatApprovalPresentation(presentation, 'ignored').join('\n');
    expect(card).toContain('bun test');
    expect(card).toContain('allow always scope');
    expect(formatApprovalPresentation(undefined, 'legacy command').join('\n'))
      .toContain('scope is unavailable');
    expect(approvalAllowsAlways(presentation)).toBe(true);
    const { allowAlways: _allowAlways, ...withoutAlways } = presentation;
    void _allowAlways;
    expect(approvalAllowsAlways(withoutAlways)).toBe(false);
    expect(approvalAllowsAlways(undefined)).toBe(true);
  });
});

function sessionItem(
  threadId: string,
  updatedAt: number,
  state: RuntimeThreadListItem['thread']['state'],
  preview: string,
  archivedAt?: number,
): RuntimeThreadListItem {
  return {
    workspaceId: 'workspace-review' as never,
    cwd: '/workspace/review',
    thread: {
      threadId: threadId as never,
      createdAt: 1,
      updatedAt,
      state,
      ...(archivedAt === undefined ? {} : { archivedAt }),
    },
    preview,
    updatedAt,
  };
}
