import { afterEach, describe, expect, it } from 'bun:test';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  AgentMessage,
  AssistantMessage,
  ThreadId,
  UserMessage,
} from '../protocol/index.js';
import {
  exportTranscript,
  latestAssistantText,
  promptHistoryEntries,
  runThreadPresentationTransition,
  transcriptContent,
} from './presentation-actions.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'coda-presentation-actions-'));
  roots.push(root);
  return root;
}

function user(id: string, text: string): UserMessage {
  return {
    role: 'user',
    id,
    timestamp: 1,
    source: 'prompt',
    content: [{ type: 'text', text }],
  };
}

function assistant(id: string, text: string): AssistantMessage {
  return {
    role: 'assistant',
    id,
    timestamp: 2,
    model: { provider: 'test', api: 'openai-chat', model: 'model' },
    content: [{ type: 'text', text }],
    stopReason: 'stop',
    usage: { input: 1, output: 1 },
  };
}

describe('presentation transcript actions', () => {
  it('does not switch Runtime or presentation when the source durability barrier fails', async () => {
    const source = 'thread-source' as ThreadId;
    const target = 'thread-target' as ThreadId;
    let currentThreadId = source;
    let visibleThreadId = source;
    let approvals = ['approval-source'];
    let transitionCalls = 0;
    const navigator = {
      get currentThreadId() { return currentThreadId; },
      switchSession: async (threadId: ThreadId) => { currentThreadId = threadId; },
    };
    await expect(runThreadPresentationTransition(
      navigator,
      { flush: () => { throw new Error('presentation path is unwritable'); } },
      async () => {
        transitionCalls++;
        currentThreadId = target;
      },
      () => {
        visibleThreadId = currentThreadId;
        approvals = [`approval-${currentThreadId}`];
      },
    )).rejects.toThrow('presentation path is unwritable');
    expect({ currentThreadId, visibleThreadId, approvals, transitionCalls }).toEqual({
      currentThreadId: source,
      visibleThreadId: source,
      approvals: ['approval-source'],
      transitionCalls: 0,
    });
  });

  it('rolls Runtime and presentation back when projecting the target fails', async () => {
    const source = 'thread-source' as ThreadId;
    const target = 'thread-target' as ThreadId;
    let currentThreadId = source;
    let visibleThreadId = source;
    const switches: ThreadId[] = [];
    await expect(runThreadPresentationTransition(
      {
        get currentThreadId() { return currentThreadId; },
        switchSession: async (threadId) => {
          switches.push(threadId);
          currentThreadId = threadId;
        },
      },
      { flush: () => undefined },
      async () => { currentThreadId = target; },
      () => {
        if (currentThreadId === target) throw new Error('target presentation failed');
        visibleThreadId = currentThreadId;
      },
    )).rejects.toThrow('target presentation failed');
    expect({ currentThreadId, visibleThreadId, switches }).toEqual({
      currentThreadId: source,
      visibleThreadId: source,
      switches: [source],
    });
  });

  it('selects the latest assistant text and offers stable text/raw projections', () => {
    const messages: AgentMessage[] = [
      user('u1', 'hello'),
      assistant('a1', 'first'),
      user('u2', 'again'),
      assistant('a2', 'final\u001b[31m answer'),
    ];
    expect(latestAssistantText(messages)).toBe('final answer');
    expect(transcriptContent(messages, 'text')).toContain('you\nhello');
    expect(transcriptContent(messages, 'text')).not.toContain('\u001b');
    const raw = transcriptContent(messages, 'raw');
    expect(raw.split('\n').filter(Boolean)).toHaveLength(4);
    expect(raw).toContain('\\u001b');
  });

  it('rebuilds per-thread prompt history while excluding synthetic context', () => {
    const messages: AgentMessage[] = [
      user('u1', 'first'),
      { ...user('u2', 'steer\u001b[31m'), source: 'steering' },
      { ...user('u3', 'summary'), source: 'synthetic' },
    ];
    expect(promptHistoryEntries(messages)).toEqual(['first', 'steer']);
  });

  it('exports with exclusive creation, mode 0600, and never overwrites', () => {
    const root = tempRoot();
    const messages: AgentMessage[] = [assistant('a1', 'safe\u001b[31m text')];
    const destination = exportTranscript(messages, {
      cwd: root,
      destination: 'review.txt',
      mode: 'text',
    });
    expect(readFileSync(destination, 'utf8')).toBe('coda\nsafe text\n');
    expect(statSync(destination).mode & 0o777).toBe(0o600);
    expect(() => exportTranscript(messages, {
      cwd: root,
      destination: 'review.txt',
      mode: 'text',
    })).toThrow();
  });
});
