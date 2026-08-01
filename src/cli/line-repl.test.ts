// Accessible/plain 文本面 characterization：输入只通过 readline 完整行分派，
// 输出 append-only，不开 raw mode/鼠标/bracketed paste/alternate screen。

import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';
import type {
  ApprovalPresentation,
  AssistantMessage,
  ModelConfig,
  ThreadId,
  WorkspaceId,
} from '../protocol/index.js';
import type { InteractiveSession } from './interactive-runtime.js';
import { startLineRepl } from './line-repl.js';
import type { ProviderRegistry } from './provider-registry.js';
import type { RuntimeWorkspaceActions } from './runtime-frontend.js';
import { createRenderer } from './renderer.js';
import {
  persistableDraft,
  ThreadPresentationStore,
} from './presentation-state.js';

describe('accessible/plain append-only line REPL', () => {
  it('keeps a modern approval pending when Runtime provides no allow-always scope', async () => {
    const stdin = new PassThrough();
    const stderr = new PassThrough();
    const output: string[] = [];
    const resolutions: Array<{ readonly id: string; readonly decision: string }> = [];
    let listener: ((event: import('./frontend-types.js').CliSessionEvent) => void) | undefined;
    const session: InteractiveSession = {
      interactionState: () => 'idle',
      currentModel: () => ({ provider: 'faux', api: 'faux', model: 'test' }),
      setModel: () => undefined,
      clearModel: () => undefined,
      usage: () => ({ cumulative: { input: 0, output: 0 }, turns: 0, contextTokens: 0 }),
      messages: [],
      subscribe: (next) => {
        listener = next;
        return () => { listener = undefined; };
      },
      subscribeSessionAttached: () => () => undefined,
      prompt: async () => undefined,
      steer: () => undefined,
      followUp: () => undefined,
      abort: () => undefined,
      close: async () => undefined,
    };
    const presentation = lineApprovalPresentationWithoutAlways('line-approval');
    const renderer = createRenderer(
      { enqueue: (text) => output.push(text), drain: async () => undefined },
      { color: false, interactive: false },
    );
    const running = startLineRepl(session, renderer, {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      mode: 'accessible',
      workspace: lineApprovalWorkspace(presentation),
      approval: {
        broker: { resolve: (id, decision) => resolutions.push({ id, decision }) },
        onAbort: () => undefined,
        subscribe: () => () => undefined,
      },
    });
    listener?.({
      type: 'approval_request',
      approvalId: presentation.requestId,
      toolCallId: presentation.allowOnce.toolCallId,
      description: presentation.risk.description,
    });
    stdin.write('a\n');
    stdin.write('y\n');
    stdin.write('/quit\n');
    await expect(running).resolves.toBe(0);
    expect(resolutions).toEqual([{ id: presentation.requestId, decision: 'allow_once' }]);
    expect(output.join('')).toContain('Runtime provided no frozen scope');
    expect(output.join('')).not.toContain('a allow always');
  });

  it('提供文本命令 parity，不控制终端模式或泄漏控制序列', async () => {
    const stdin = new PassThrough();
    const stderr = new PassThrough();
    const stderrChunks: string[] = [];
    stderr.setEncoding('utf8');
    stderr.on('data', (chunk: string) => stderrChunks.push(chunk));

    const stdoutChunks: string[] = [];
    const renderer = createRenderer(
      {
        enqueue: (text) => stdoutChunks.push(text),
        drain: async () => undefined,
      },
      { color: false, interactive: false },
    );
    const prompts: string[] = [];
    const followUps: string[] = [];
    let closed = 0;
    const session: InteractiveSession = {
      interactionState: () => 'idle',
      currentModel: () => undefined,
      setModel: () => undefined,
      clearModel: () => undefined,
      usage: () => ({ cumulative: { input: 4, output: 2 }, turns: 1, contextTokens: 6 }),
      messages: [],
      subscribe: () => () => undefined,
      subscribeSessionAttached: () => () => undefined,
      prompt: async (text) => {
        prompts.push(text);
      },
      steer: () => undefined,
      followUp: (text) => {
        followUps.push(typeof text === 'string' ? text : '');
      },
      abort: () => undefined,
      close: async () => {
        closed++;
      },
    };

    const running = startLineRepl(session, renderer, {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      mode: 'accessible',
      version: 'test-version',
    });
    stdin.write('/help\n');
    stdin.write('/status\n');
    stdin.write('/doctor\n');
    stdin.write('/auth\n');
    stdin.write('/followup verify later\n');
    stdin.write('first task\n');
    stdin.write('/wat\x1b]52;c;hidden\x07\n');
    stdin.write('/quit\n');

    await expect(running).resolves.toBe(0);
    const stdout = stdoutChunks.join('');
    const terminalOutput = stdout + stderrChunks.join('');
    expect(stdout).toContain('Accessible mode: append-only output.');
    expect(stdout).toContain('Get started: 1) coda auth login');
    expect(stdout).toContain('/help: Show commands, options, and shortcuts');
    expect(stdout).toContain('tokens: 4 in / 2 out');
    expect(stdout).toContain('[ok] runtime: coda test-version');
    expect(stdout).toContain('/auth is unavailable in this mode.');
    expect(stdout).toContain('Unknown command: /wat');
    expect(stdout).not.toContain('hidden');
    expect(prompts).toEqual(['first task']);
    expect(followUps).toEqual(['verify later']);
    expect(closed).toBe(1);
    expect(terminalOutput).not.toContain('\x1b');
    expect(terminalOutput).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  });

  it('输出失败信号会 abort 当前 run、关闭会话并返回 1', async () => {
    const stdin = new PassThrough();
    const stderr = new PassThrough();
    const fatal = new AbortController();
    let aborts = 0;
    let closes = 0;
    const session: InteractiveSession = {
      interactionState: () => 'running',
      currentModel: () => ({ provider: 'faux', api: 'faux', model: 'test' }),
      setModel: () => undefined,
      clearModel: () => undefined,
      usage: () => ({ cumulative: { input: 0, output: 0 }, turns: 0, contextTokens: 0 }),
      messages: [],
      subscribe: () => () => undefined,
      subscribeSessionAttached: () => () => undefined,
      prompt: async () => undefined,
      steer: () => undefined,
      followUp: () => undefined,
      abort: () => {
        aborts++;
      },
      close: async () => {
        closes++;
      },
    };
    const renderer = createRenderer(
      { enqueue: () => undefined, drain: async () => undefined },
      { color: false, interactive: false },
    );

    const running = startLineRepl(session, renderer, {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      fatalSignal: fatal.signal,
      mode: 'plain',
    });
    fatal.abort(new Error('stdout failed'));

    await expect(running).resolves.toBe(1);
    expect(aborts).toBe(1);
    expect(closes).toBe(1);
  });

  it('run 进行中拒绝所有 provider 文本命令，不允许登出非当前 provider', async () => {
    const stdin = new PassThrough();
    const stderr = new PassThrough();
    const stdoutChunks: string[] = [];
    let resolveWarning: (() => void) | undefined;
    const warningSeen = new Promise<void>((resolve) => {
      resolveWarning = resolve;
    });
    let logouts = 0;
    let aborts = 0;
    const registry = {
      availableModels: () => [],
      listCredentials: () => [],
      logout: () => {
        logouts++;
        return true;
      },
    } as unknown as ProviderRegistry;
    const session: InteractiveSession = {
      interactionState: () => 'running',
      currentModel: () => ({ provider: 'current', api: 'faux', model: 'test' }),
      setModel: () => undefined,
      clearModel: () => undefined,
      usage: () => ({ cumulative: { input: 0, output: 0 }, turns: 0, contextTokens: 0 }),
      messages: [],
      subscribe: () => () => undefined,
      subscribeSessionAttached: () => () => undefined,
      prompt: async () => undefined,
      steer: () => undefined,
      followUp: () => undefined,
      abort: () => {
        aborts++;
      },
      close: async () => undefined,
    };
    const renderer = createRenderer(
      {
        enqueue: (text) => {
          stdoutChunks.push(text);
          if (text.includes('Task is still running')) resolveWarning?.();
        },
        drain: async () => undefined,
      },
      { color: false, interactive: false },
    );

    const running = startLineRepl(session, renderer, {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      mode: 'accessible',
      providerCommands: { registry, runtime: session },
    });
    stdin.write('/logout other-provider\n');
    await warningSeen;
    stdin.end();

    await expect(running).resolves.toBe(0);
    expect(logouts).toBe(0);
    expect(aborts).toBe(1);
    expect(stdoutChunks.join('')).toContain(
      'Task is still running; finish or abort before provider commands.',
    );
  });

  it('模型已切换但最近选择持久化失败时，明确保留成功语义并警告恢复风险', async () => {
    const stdin = new PassThrough();
    const stderr = new PassThrough();
    const stdoutChunks: string[] = [];
    let resolveWarning: (() => void) | undefined;
    const warningSeen = new Promise<void>((resolve) => {
      resolveWarning = resolve;
    });
    const config: ModelConfig = {
      ref: { provider: 'other', api: 'openai-chat', model: 'model' },
      baseURL: 'https://provider.invalid/v1',
      apiKey: 'test-only-secret',
    };
    let applied: ModelConfig | undefined;
    const registry = {
      availableModels: () => [{
        providerId: 'other',
        providerName: 'Other',
        model: 'model',
        api: 'openai-chat',
        ref: 'other/model',
      }],
      resolveModel: () => config,
      rememberSelection: () => {
        throw new Error('disk full');
      },
    } as unknown as ProviderRegistry;
    const session: InteractiveSession = {
      interactionState: () => 'idle',
      currentModel: () => ({ provider: 'current', api: 'openai-chat', model: 'old' }),
      setModel: (model) => {
        applied = model;
      },
      clearModel: () => undefined,
      usage: () => ({ cumulative: { input: 0, output: 0 }, turns: 0, contextTokens: 0 }),
      messages: [],
      subscribe: () => () => undefined,
      subscribeSessionAttached: () => () => undefined,
      prompt: async () => undefined,
      steer: () => undefined,
      followUp: () => undefined,
      abort: () => undefined,
      close: async () => undefined,
    };
    const renderer = createRenderer(
      {
        enqueue: (text) => {
          stdoutChunks.push(text);
          if (text.includes('next launch may not restore it')) resolveWarning?.();
        },
        drain: async () => undefined,
      },
      { color: false, interactive: false },
    );

    const running = startLineRepl(session, renderer, {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      mode: 'plain',
      providerCommands: { registry, runtime: session },
    });
    stdin.write('/model other/model\n');
    await warningSeen;
    stdin.write('/quit\n');

    await expect(running).resolves.toBe(0);
    expect(applied).toBe(config);
    const output = stdoutChunks.join('');
    expect(output).toContain('Selected other/model.');
    expect(output).toContain('Model changed, but the recent selection could not be saved');
    expect(output).toContain('disk full');
    expect(output).not.toContain('test-only-secret');
  });

  it('accessible 文本命令提供 draft/editor/files/search/copy/export 等价入口', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'coda-line-presentation-'));
    const store = new ThreadPresentationStore({
      root: path.join(root, 'state'),
      workspaceId: 'ws_line_presentation' as WorkspaceId,
      threadId: 'thr_line_presentation' as ThreadId,
    });
    store.setDraft(persistableDraft('restored accessible draft'));
    store.flush();
    writeFileSync(path.join(root, 'feature.ts'), 'export {};\n');
    const stdin = new PassThrough();
    const stderr = new PassThrough();
    const stdoutChunks: string[] = [];
    const copied: string[] = [];
    const prompts: string[] = [];
    const assistantMessage: AssistantMessage = {
      role: 'assistant',
      id: 'a-line-copy',
      timestamp: 1,
      model: { provider: 'faux', api: 'faux', model: 'test' },
      content: [{ type: 'text', text: 'copy accessible response' }],
      stopReason: 'stop',
      usage: { input: 1, output: 2 },
    };
    const session: InteractiveSession = {
      interactionState: () => 'idle',
      currentModel: () => ({ provider: 'faux', api: 'faux', model: 'test' }),
      setModel: () => undefined,
      clearModel: () => undefined,
      usage: () => ({ cumulative: { input: 0, output: 0 }, turns: 0, contextTokens: 0 }),
      messages: [assistantMessage],
      subscribe: () => () => undefined,
      subscribeSessionAttached: () => () => undefined,
      prompt: async (text) => { prompts.push(text); },
      steer: () => undefined,
      followUp: () => undefined,
      abort: () => undefined,
      close: async () => undefined,
    };
    let editorResolved: (() => void) | undefined;
    const editorDone = new Promise<void>((resolve) => { editorResolved = resolve; });
    const renderer = createRenderer(
      {
        enqueue: (text) => {
          stdoutChunks.push(text);
          if (text.includes('Draft returned from $EDITOR')) editorResolved?.();
        },
        drain: async () => undefined,
      },
      { color: false, interactive: false },
    );

    try {
      const running = startLineRepl(session, renderer, {
        stdin: stdin as unknown as NodeJS.ReadStream,
        stderr: stderr as unknown as NodeJS.WriteStream,
        mode: 'accessible',
        presentation: {
          store,
          cwd: root,
          editDraft: async (draft) => `${draft}\nedited accessibly`,
          copyText: async (text) => { copied.push(text); },
        },
      });
      stdin.write('/draft show\n');
      stdin.write('/stash text mode draft\n');
      stdin.write('/restore\n');
      stdin.write('/draft send\n');
      stdin.write('/search accessible\n');
      stdin.write('/copy raw\n');
      stdin.write('/files feature\n');
      stdin.write('/edit\n');
      await editorDone;
      stdin.write('/draft show\n');
      stdin.write('/export raw transcript.jsonl\n');
      stdin.write('/vim on\n');
      stdin.write('/quit\n');

      await expect(running).resolves.toBe(0);
      const output = stdoutChunks.join('');
      expect(output).toContain('A draft was restored for this thread.');
      expect(output).toContain('restored accessible draft');
      expect(output).toContain('match 1/1');
      expect(output).toContain('@feature.ts');
      expect(output).toContain('edited accessibly');
      expect(output).toContain('Vim preference enabled');
      expect(prompts).toEqual(['text mode draft']);
      expect(copied[0]).toContain('copy accessible response');
      expect(readFileSync(path.join(root, 'transcript.jsonl'), 'utf8')).toContain('a-line-copy');
    } finally {
      store.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accessible 文本面从同一 Runtime workspace 提供审阅、diff 与 session 操作', async () => {
    const stdin = new PassThrough();
    const stderr = new PassThrough();
    const stdoutChunks: string[] = [];
    const actions: string[] = [];
    let currentThreadId = 'thread-current' as ThreadId;
    const session: InteractiveSession = {
      interactionState: () => 'idle',
      currentModel: () => ({ provider: 'faux', api: 'faux', model: 'test' }),
      setModel: () => undefined,
      clearModel: () => undefined,
      usage: () => ({ cumulative: { input: 0, output: 0 }, turns: 0, contextTokens: 0 }),
      messages: [],
      subscribe: () => () => undefined,
      subscribeSessionAttached: () => () => undefined,
      prompt: async () => undefined,
      steer: () => undefined,
      followUp: () => undefined,
      abort: () => undefined,
      close: async () => undefined,
    };
    const workspace: RuntimeWorkspaceActions = {
      get currentThreadId() { return currentThreadId; },
      eventHighWaterSeq: () => 9,
      listSessions: async () => [{
        workspaceId: 'workspace-line' as WorkspaceId,
        cwd: '/workspace',
        updatedAt: 2,
        preview: 'listed preview',
        thread: {
          threadId: 'thread-listed' as ThreadId,
          createdAt: 1,
          state: 'idle',
          title: 'Listed target',
        },
      }],
      workspaceSnapshot: async () => ({
        workspaceId: 'workspace-line' as WorkspaceId,
        permissions: {
          mode: 'interactive',
          policyRevision: 'policy-line',
          ceiling: { revision: 'ceiling-line', constraints: [] },
        },
      }),
      switchSession: async (threadId) => {
        actions.push(`switch:${threadId}`);
        currentThreadId = threadId;
      },
      newSession: async () => {
        actions.push('new');
        currentThreadId = 'thread-new' as ThreadId;
        return currentThreadId;
      },
      renameSession: async (title) => { actions.push(`rename:${title}`); },
      archiveSession: async (archived) => { actions.push(`archive:${String(archived)}`); },
      compactConversation: async () => { actions.push('compact'); },
      forkConversation: async () => 'thread-fork' as ThreadId,
      retryConversation: async () => 'thread-retry' as ThreadId,
      reviewSnapshot: async () => ({
        workspaceId: 'workspace-line' as WorkspaceId,
        threadId: currentThreadId,
        highWaterSeq: 9,
        reasoning: [{
          key: 'reasoning-line',
          messageId: 'assistant-line',
          status: 'completed',
          startedAt: 1,
          endedAt: 3,
          durationMs: 2,
          content: 'full reasoning detail',
        }],
        tools: [],
      }),
      diffSnapshot: async (scope) => ({
        workspaceId: 'workspace-line' as WorkspaceId,
        threadId: currentThreadId,
        scope,
        generatedAt: 3,
        files: [{
          path: 'src/line.ts',
          group: 'unstaged',
          status: 'M',
          patch: '+ complete accessible diff',
        }],
      }),
      approvalPresentation: () => undefined,
      pendingApprovals: () => [],
    };
    const renderer = createRenderer(
      {
        enqueue: (text) => stdoutChunks.push(text),
        drain: async () => undefined,
      },
      { color: false, interactive: false },
    );

    const running = startLineRepl(session, renderer, {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      mode: 'accessible',
      workspace,
    });
    stdin.write('/review\n');
    stdin.write('/diff workspace\n');
    stdin.write('/permissions\n');
    stdin.write('/sessions listed\n');
    stdin.write('/rename Review target\n');
    stdin.write('/archive off\n');
    stdin.write('/compact\n');
    stdin.write('/new\n');
    stdin.write('/switch thread-listed\n');
    stdin.write('/quit\n');

    await expect(running).resolves.toBe(0);
    const output = stdoutChunks.join('');
    expect(output).toContain('Review · 1 reasoning block(s)');
    expect(output).toContain('full reasoning detail');
    expect(output).toContain('+ complete accessible diff');
    expect(output).toContain('Permissions · interactive');
    expect(output).toContain('Listed target');
    expect(actions).toEqual([
      'rename:Review target',
      'archive:false',
      'compact',
      'new',
      'switch:thread-listed',
    ]);
  });
});

function lineApprovalPresentationWithoutAlways(requestId: string): ApprovalPresentation {
  return {
    requestId,
    target: {
      workspaceId: 'workspace-line-approval' as WorkspaceId,
      threadId: 'thread-line-approval' as ThreadId,
      runId: 'run-line-approval' as never,
      turnId: 'turn-line-approval' as never,
    },
    capability: { id: 'shell', version: '1', registrationDigest: 'digest' },
    normalizedResources: [],
    risk: { code: 'ask', reason: 'execute', description: 'Run line command' },
    allowOnce: { invocationId: 'invocation-line', toolCallId: 'call-line' },
    revisions: {
      catalog: 1,
      effectivePolicy: 'effective',
      policyBasis: 'basis',
      ceiling: 'ceiling',
      grants: 'grants',
    },
  };
}

function lineApprovalWorkspace(presentation: ApprovalPresentation): RuntimeWorkspaceActions {
  return {
    currentThreadId: presentation.target.threadId,
    eventHighWaterSeq: () => 0,
    listSessions: async () => [],
    workspaceSnapshot: async () => ({
      workspaceId: presentation.target.workspaceId,
      permissions: {
        mode: 'interactive',
        policyRevision: 'policy',
        ceiling: { revision: 'ceiling', constraints: [] },
      },
    }),
    switchSession: async () => undefined,
    newSession: async () => presentation.target.threadId,
    renameSession: async () => undefined,
    archiveSession: async () => undefined,
    compactConversation: async () => undefined,
    forkConversation: async () => presentation.target.threadId,
    retryConversation: async () => presentation.target.threadId,
    reviewSnapshot: async () => undefined,
    diffSnapshot: async () => undefined,
    approvalPresentation: (requestId) => requestId === presentation.requestId
      ? presentation
      : undefined,
    pendingApprovals: () => [],
  };
}
