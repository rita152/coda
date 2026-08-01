// Accessible/plain 文本面 characterization：输入只通过 readline 完整行分派，
// 输出 append-only，不开 raw mode/鼠标/bracketed paste/alternate screen。

import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'bun:test';
import type { ModelConfig } from '../protocol/index.js';
import type { InteractiveSession } from './interactive-runtime.js';
import { startLineRepl } from './line-repl.js';
import type { ProviderRegistry } from './provider-registry.js';
import { createRenderer } from './renderer.js';

describe('accessible/plain append-only line REPL', () => {
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
    });
    stdin.write('/help\n');
    stdin.write('/status\n');
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
});
