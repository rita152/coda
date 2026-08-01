import { afterEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentMessage, AssistantMessage, UserMessage } from '../protocol/index.js';
import {
  applyWorkspaceCompletion,
  editDraftWithExternalEditor,
  exportTranscript,
  latestAssistantText,
  MessageTranscriptSearch,
  promptHistoryEntries,
  transcriptContent,
  workspaceCompletionAtCursor,
  workspacePathCandidates,
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

  it('searches messages cyclically without exposing terminal controls', () => {
    const messages: AgentMessage[] = [
      user('u1', 'Needle one'),
      assistant('a1', 'middle'),
      assistant('a2', 'needle\u001b]52;c;bad\u0007 two'),
    ];
    const search = new MessageTranscriptSearch(() => messages);
    expect(search.setQuery('needle')).toMatchObject({
      messageId: 'u1',
      ordinal: 0,
      total: 2,
    });
    const next = search.move(1);
    expect(next).toMatchObject({ messageId: 'a2', ordinal: 1, total: 2 });
    expect(next?.snippet).not.toContain('\u001b');
    expect(search.move(1)?.messageId).toBe('u1');
  });

  it('rebuilds per-thread prompt history while excluding synthetic context', () => {
    const messages: AgentMessage[] = [
      user('u1', 'first'),
      { ...user('u2', 'steer\u001b[31m'), source: 'steering' },
      { ...user('u3', 'summary'), source: 'synthetic' },
    ];
    expect(promptHistoryEntries(messages)).toEqual(['first', 'steer']);
  });

  it('indexes files and directories for fuzzy @ completion without traversing symlinks', () => {
    const root = tempRoot();
    mkdirSync(path.join(root, 'src', 'nested'), { recursive: true });
    mkdirSync(path.join(root, 'node_modules', 'ignored'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'nested', 'feature.ts'), 'x');
    writeFileSync(path.join(root, 'src', 'other.ts'), 'x');
    writeFileSync(path.join(root, 'node_modules', 'ignored', 'secret.ts'), 'x');

    expect(workspacePathCandidates(root, 'sft')).toContain('src/nested/feature.ts');
    expect(workspacePathCandidates(root, '')).toContain('src/');
    expect(workspacePathCandidates(root, '').join('\n')).not.toContain('node_modules');

    const completion = workspaceCompletionAtCursor('inspect @src/nf', 15, root);
    expect(completion?.candidates).toContain('src/nested/feature.ts');
    expect(
      applyWorkspaceCompletion('inspect @src/nf', completion!, 'src/nested/feature.ts'),
    ).toEqual({
      text: 'inspect @src/nested/feature.ts',
      cursor: 'inspect @src/nested/feature.ts'.length,
    });
  });

  it('runs the configured editor, strips terminal controls, and removes its temporary file', async () => {
    const root = tempRoot();
    const editor = path.join(root, 'editor.sh');
    writeFileSync(
      editor,
      '#!/bin/sh\nprintf \'edited\\033[31m\\n\' > "$1"\n',
      { mode: 0o700 },
    );
    chmodSync(editor, 0o700);
    expect(await editDraftWithExternalEditor('before', {
      cwd: root,
      env: { EDITOR: editor, SHELL: '/bin/sh', PATH: Bun.env.PATH },
    })).toBe('edited');
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
