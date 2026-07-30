// REPL 可测内核单测(docs/09 §3):斜杠命令分发、Enter 分派、输入历史环、双击消歧、
// /status //queue 格式化。键位接线依赖真实 TTY,由 repl.ts 头部人工冒烟清单覆盖。
// 双击消歧用注入时间戳,零真实计时器(docs/10 §8 确定性守则)。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'bun:test';
import type { QueuedMessage } from '../protocol/index.js';
import { createFauxStreamFn } from '../providers/faux/index.js';
import { Session } from '../session/index.js';
import type { SessionEvent, SessionUsage } from '../session/index.js';
import { createOrderedOutput } from '../shared/index.js';
import { InteractiveRuntime } from './interactive-runtime.js';
import { ProviderRegistry } from './provider-registry.js';
import type { Renderer } from './renderer.js';
import {
  approvalKeyDecision,
  CTRL_C_EXIT_WINDOW_MS,
  decideEnter,
  DoublePress,
  ESC_EXIT_WINDOW_MS,
  ESC_TIMEOUT_MS,
  formatQueueLines,
  formatStatusLines,
  InputHistory,
  interactionCanAbort,
  interactionEnterState,
  parseSlashCommand,
  SLASH_COMMAND_SPECS,
  startRepl,
} from './repl.js';
import type { ReplApproval, ReplInput } from './repl.js';

class TestTtyInput extends PassThrough implements ReplInput {
  readonly isTTY = true;
  readonly rawModeChanges: boolean[] = [];

  setRawMode(enabled: boolean): void {
    this.rawModeChanges.push(enabled);
  }
}

describe('parseSlashCommand(docs/09 §3.2)', () => {
  it('识别 canonical 命令及 /q 短别名', () => {
    expect(parseSlashCommand('/quit')).toEqual({ cmd: 'quit' });
    expect(parseSlashCommand('/q')).toEqual({ cmd: 'quit' });
    expect(parseSlashCommand('/queue')).toEqual({ cmd: 'queue' });
    expect(parseSlashCommand('/status')).toEqual({ cmd: 'status' });
    expect(parseSlashCommand('/help')).toEqual({ cmd: 'help' });
    expect(parseSlashCommand('/login')).toEqual({ cmd: 'login' });
    expect(parseSlashCommand('/model')).toEqual({ cmd: 'model' });
    expect(parseSlashCommand('/logout')).toEqual({ cmd: 'logout' });
  });

  it('/f 与 /followup 携带文本(任何终端的全功能兜底路径)', () => {
    expect(parseSlashCommand('/f 顺便改下颜色')).toEqual({ cmd: 'follow_up', text: '顺便改下颜色' });
    expect(parseSlashCommand('/followup run tests')).toEqual({ cmd: 'follow_up', text: 'run tests' });
    expect(parseSlashCommand('/f')).toEqual({ cmd: 'follow_up', text: '' });
  });

  it('非斜杠返回 undefined;未知斜杠返回 unknown', () => {
    expect(parseSlashCommand('hello')).toBeUndefined();
    expect(parseSlashCommand('/wat now')).toEqual({ cmd: 'unknown', input: '/wat now' });
  });

  it('补全目录中的 canonical 命令与隐藏别名都由解析器识别', () => {
    for (const command of SLASH_COMMAND_SPECS) {
      const suffix = command.argumentHint === undefined ? '' : ' example';
      expect(parseSlashCommand(`/${command.name}${suffix}`)?.cmd).not.toBe('unknown');
      for (const alias of command.aliases ?? []) {
        expect(parseSlashCommand(`/${alias}${suffix}`)?.cmd).not.toBe('unknown');
      }
    }
  });
});

describe('decideEnter:键位表分派(docs/09 §3)', () => {
  it('空输入 → none(空闲与运行中一致)', () => {
    expect(decideEnter('idle', false, '')).toEqual({ kind: 'none' });
    expect(decideEnter('running', false, '   ')).toEqual({ kind: 'none' });
  });

  it('空闲 Enter=prompt;运行中 Enter=steer(风险最低的默认去向)', () => {
    expect(decideEnter('idle', false, '改一下')).toEqual({ kind: 'prompt', text: '改一下' });
    expect(decideEnter('running', false, '改一下')).toEqual({ kind: 'steer', text: '改一下' });
  });

  it('Alt+Enter(meta)= follow-up,空闲与运行中皆然', () => {
    expect(decideEnter('running', true, '收尾时跑测试')).toEqual({
      kind: 'follow_up',
      text: '收尾时跑测试',
    });
    expect(decideEnter('idle', true, 'x')).toEqual({ kind: 'follow_up', text: 'x' });
  });

  it('流式中 /f <text> 兜底 follow-up;/f 空文本 → none', () => {
    expect(decideEnter('running', false, '/f 顺便重命名')).toEqual({
      kind: 'follow_up',
      text: '顺便重命名',
    });
    expect(decideEnter('idle', false, '/f also idle ok')).toEqual({
      kind: 'follow_up',
      text: 'also idle ok',
    });
    expect(decideEnter('running', false, '/f')).toEqual({ kind: 'none' });
  });

  it('普通斜杠命令仅空闲时生效；provider 管理命令运行中仍进入控制器并给出安全提示', () => {
    expect(decideEnter('idle', false, '/status')).toEqual({
      kind: 'command',
      command: { cmd: 'status' },
    });
    expect(decideEnter('running', false, '/status')).toEqual({ kind: 'steer', text: '/status' });
    for (const cmd of ['login', 'model', 'logout'] as const) {
      expect(decideEnter('running', false, `/${cmd}`)).toEqual({
        kind: 'command',
        command: { cmd },
      });
    }
  });

  it('compacting 的 Enter 走 prompt/命令，但 Esc 仍可 abort', () => {
    const state = interactionEnterState('compacting');
    expect(state).toBe('idle');
    expect(interactionCanAbort('compacting')).toBe(true);
    expect(decideEnter(state, false, '压缩后继续')).toEqual({
      kind: 'prompt',
      text: '压缩后继续',
    });
    expect(decideEnter(state, false, '/quit')).toEqual({
      kind: 'command',
      command: { cmd: 'quit' },
    });
  });
});

describe('InputHistory:本会话输入历史环(↑/↓)', () => {
  it('↑ 依次回翻,到顶停住;↓ 翻回草稿', () => {
    const h = new InputHistory();
    h.push('first');
    h.push('second');
    expect(h.up('draft-in-progress')).toBe('second');
    expect(h.up('')).toBe('first');
    expect(h.up('')).toBe('first'); // 到顶停住
    expect(h.down()).toBe('second');
    expect(h.down()).toBe('draft-in-progress'); // 草稿还原
    expect(h.down()).toBe('draft-in-progress'); // 到底停住
  });

  it('空历史 ↑ 返回当前输入;空白提交不入历史;连续重复去重', () => {
    const h = new InputHistory();
    expect(h.up('keep me')).toBe('keep me');
    h.push('   ');
    expect(h.up('still me')).toBe('still me');
    h.push('same');
    h.push('same');
    expect(h.up('')).toBe('same');
    expect(h.up('')).toBe('same'); // 只存了一条
  });

  it('push 后重置到最新草稿位', () => {
    const h = new InputHistory();
    h.push('a');
    h.push('b');
    h.up('');
    h.up('');
    h.push('c');
    expect(h.up('')).toBe('c');
  });
});

describe('DoublePress:双击消歧状态机(注入时钟)', () => {
  it('窗口内第二击触发;触发后归零不连发', () => {
    const d = new DoublePress(500);
    expect(d.hit(1000)).toBe(false);
    expect(d.hit(1400)).toBe(true); // 400ms < 500ms
    expect(d.hit(1500)).toBe(false); // 已消费,第三击重新开窗
  });

  it('超窗不触发;reset 打断计数', () => {
    const d = new DoublePress(500);
    expect(d.hit(0)).toBe(false);
    expect(d.hit(600)).toBe(false); // 超窗:视为新的第一击
    expect(d.hit(700)).toBe(true);
    d.reset();
    expect(d.hit(701)).toBe(false); // reset 后需重新双击
  });

  it('窗口常量与规格一致(Esc 500ms / Ctrl+C 1.5s / 消歧 50ms)', () => {
    expect(ESC_EXIT_WINDOW_MS).toBe(500);
    expect(CTRL_C_EXIT_WINDOW_MS).toBe(1500);
    expect(ESC_TIMEOUT_MS).toBe(50);
  });
});

describe('/status 与 /queue 输出格式', () => {
  it('formatStatusLines 含模型、turns、token 累计与成本', () => {
    const usage: SessionUsage = {
      lastTurn: { input: 120, output: 31 },
      cumulative: { input: 2310, output: 95, costUSD: 0.0123, reasoning: 7 },
      turns: 3,
      contextTokens: 2405,
    };
    const lines = formatStatusLines(usage, 'gpt-5.2');
    expect(lines.join('\n')).toContain('model: gpt-5.2');
    expect(lines.join('\n')).toContain('turns: 3');
    expect(lines.join('\n')).toContain('tokens: 2310 in / 95 out (7 reasoning)');
    expect(lines.join('\n')).toContain('cost: $0.0123');
    expect(lines.join('\n')).toContain('last turn: 120 in / 31 out');
  });

  it('formatStatusLines 无定价/无模型时省略对应行(不渲染 0 成本)', () => {
    const usage: SessionUsage = { cumulative: { input: 10, output: 2 }, turns: 1, contextTokens: 12 };
    const joined = formatStatusLines(usage).join('\n');
    expect(joined).not.toContain('model:');
    expect(joined).not.toContain('cost:');
    expect(joined).toContain('tokens: 10 in / 2 out');
  });

  it('formatQueueLines:空队列提示;非空列出条目并截断长文本', () => {
    expect(formatQueueLines([], [])).toEqual(['queues empty']);
    const s: QueuedMessage[] = [{ id: 's1', text: 'a'.repeat(80), kind: 'steering' }];
    const f: QueuedMessage[] = [{ id: 'f1', text: 'short', kind: 'follow_up' }];
    const lines = formatQueueLines(s, f);
    expect(lines[0]).toBe('steering (1):');
    expect(lines[1]).toContain('…'); // 60 字符截断
    expect(lines).toContain('follow-up (1):');
    expect(lines).toContain('  1. short'); // 序号按各自队列内计
  });
});

describe('approvalKeyDecision:审批模式键位映射(M6,docs/09 §4)', () => {
  it('y=allow_once / a=allow_always / n=deny / Esc=abort', () => {
    expect(approvalKeyDecision('y')).toBe('allow_once');
    expect(approvalKeyDecision('a')).toBe('allow_always');
    expect(approvalKeyDecision('n')).toBe('deny');
    expect(approvalKeyDecision('escape')).toBe('abort');
  });

  it('其余键无审批动作(吞键由 repl 键位层负责,本映射只认四键)', () => {
    expect(approvalKeyDecision('return')).toBeUndefined();
    expect(approvalKeyDecision('q')).toBeUndefined();
    expect(approvalKeyDecision('')).toBeUndefined();
    expect(approvalKeyDecision('space')).toBeUndefined();
  });
});

describe('REPL 致命输出失败生命周期(docs/09 §1.3/§3)', () => {
  it('stdout 首次失败会 abort 会话与审批、清理 raw TTY 并 exit 1', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'coda-repl-output-failure-'));
    const session = await Session.create({
      dir,
      agentConfig: {
        streamFn: createFauxStreamFn({ turns: [], onExhausted: 'emptyStop' }),
        model: { ref: { provider: 'faux', api: 'faux', model: 'test' } },
        tools: [],
        systemPrompt: 'test',
        cwd: dir,
      },
    });
    const stdin = new TestTtyInput();
    const failure = new Error('broken stdout');
    const output = createOrderedOutput({
      write: () => {
        throw failure;
      },
      flush: () => 0,
    });
    let approvalListener: ((event: SessionEvent) => void) | undefined;
    let approvalAborts = 0;
    let approvalUnsubscribed = false;
    let approvalResolutions = 0;
    const approval: ReplApproval = {
      broker: {
        resolve: () => {
          approvalResolutions++;
        },
      },
      onAbort: () => {
        approvalAborts++;
      },
      subscribe: (listener) => {
        approvalListener = listener;
        return () => {
          approvalUnsubscribed = true;
        };
      },
    };
    let mounts = 0;
    let unmounts = 0;
    const renderer: Renderer = {
      render: () => undefined,
      replayTranscript: () => undefined,
      drain: () => Promise.resolve(),
      mount: () => {
        mounts++;
      },
      unmount: () => {
        unmounts++;
      },
    };

    try {
      const exit = startRepl(session, renderer, approval, {
        stdin,
        fatalSignal: output.failureSignal,
      });
      expect(stdin.rawModeChanges).toEqual([true]);
      expect(mounts).toBe(1);

      const emitApproval = approvalListener;
      if (emitApproval === undefined) throw new Error('approval listener was not registered');
      emitApproval({
        type: 'approval_request',
        approvalId: 'approval-1',
        toolCallId: 'call-1',
        description: 'bash: risky command',
      });

      await expect(output.write('trigger failure')).rejects.toBe(failure);
      await expect(exit).resolves.toBe(1);
      expect(approvalAborts).toBe(1);
      expect(approvalUnsubscribed).toBe(true);
      expect(approvalResolutions).toBe(0);
      expect(stdin.rawModeChanges).toEqual([true, false]);
      expect(stdin.listenerCount('keypress')).toBe(0);
      expect(unmounts).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('classic REPL 输入错误边界', () => {
  it('未选择模型时 Alt+Enter 与 /followup 只显示错误，不击穿 keypress listener', async () => {
    const runtime = new InteractiveRuntime({
      createSession: async () => {
        throw new Error('不应创建 Session');
      },
    });
    const stdin = new TestTtyInput();
    const printed: string[] = [];
    const renderer: Renderer = {
      render: () => undefined,
      replayTranscript: () => undefined,
      drain: () => Promise.resolve(),
      println: (text) => printed.push(text),
    };
    const type = (text: string): void => {
      for (const character of text) stdin.emit('keypress', character, { name: character });
    };
    const enter = (meta = false): void => {
      stdin.emit('keypress', undefined, { name: 'return', meta });
    };

    const exit = startRepl(runtime, renderer, undefined, { stdin });
    type('/followup first');
    enter();
    type('second');
    enter(true);
    expect(printed.filter((line) => line.includes('尚未选择模型'))).toHaveLength(2);
    expect(stdin.listenerCount('keypress')).toBe(1);
    type('/quit');
    enter();
    await expect(exit).resolves.toBe(0);
  });
});

describe('classic REPL provider 命令与秘密输入', () => {
  it('复用 /login 状态机，API key 只以掩码进入 renderer', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'coda-repl-provider-login-'));
    const registry = new ProviderRegistry({
      configPath: path.join(dir, 'providers.json'),
      credentialsPath: path.join(dir, 'credentials.json'),
      fetch: async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: 'grok-4.5' },
              { id: 'minimax-m3' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });
    const runtime = new InteractiveRuntime({
      createSession: async () => {
        throw new Error('/login 不得创建 Session');
      },
    });
    const stdin = new TestTtyInput();
    const inputLines: string[] = [];
    const statuses: Array<string | undefined> = [];
    const printed: string[] = [];
    const renderer: Renderer = {
      render: () => undefined,
      replayTranscript: () => undefined,
      drain: () => Promise.resolve(),
      setInputLine: (text) => inputLines.push(text),
      setStatus: (text) => statuses.push(text),
      println: (text) => printed.push(text),
    };
    const emitText = (text: string): void => {
      for (const character of text) {
        stdin.emit('keypress', character, { name: character });
      }
    };
    const enter = (): void => {
      stdin.emit('keypress', undefined, { name: 'return' });
    };
    const waitFor = async (predicate: () => boolean): Promise<void> => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (predicate()) return;
        await Promise.resolve();
      }
      throw new Error('provider command did not settle');
    };
    const escape = (): void => {
      stdin.emit('keypress', undefined, { name: 'escape' });
    };
    const cancelledSecret = 'sk-cancel-never-render';
    const secret = 'sk-classic-never-render';

    try {
      const exit = startRepl(runtime, renderer, undefined, {
        stdin,
        providerCommands: { registry, runtime },
      });

      emitText('/login');
      enter();
      await waitFor(() => statuses.at(-1)?.startsWith('选择登录方式') === true);
      emitText('2');
      enter();
      await waitFor(() =>
        statuses.at(-1)?.startsWith('选择 API key provider') === true,
      );
      emitText('1');
      enter();
      await waitFor(() => statuses.at(-1)?.startsWith('OpenCode Go API key') === true);

      emitText(cancelledSecret);
      escape();
      await waitFor(() =>
        statuses.at(-1)?.startsWith('选择 API key provider') === true,
      );
      expect([...inputLines, ...printed, ...statuses].join('\n')).not.toContain(cancelledSecret);
      expect(printed).not.toContain('已取消');

      escape();
      await waitFor(() => statuses.at(-1)?.startsWith('选择登录方式') === true);
      emitText('2');
      enter();
      await waitFor(() =>
        statuses.at(-1)?.startsWith('选择 API key provider') === true,
      );
      emitText('1');
      enter();
      await waitFor(() => statuses.at(-1)?.startsWith('OpenCode Go API key') === true);

      emitText(secret);
      expect(inputLines.at(-1)).toBe('•'.repeat(secret.length));
      expect([...inputLines, ...printed, ...statuses].join('\n')).not.toContain(secret);

      enter();
      await waitFor(() =>
        printed.some((line) => line.includes('已保存 OpenCode Go 的认证配置')),
      );
      expect([...inputLines, ...printed, ...statuses].join('\n')).not.toContain(secret);

      emitText('/quit');
      enter();
      await expect(exit).resolves.toBe(0);
      expect(stdin.rawModeChanges).toEqual([true, false]);
    } finally {
      await runtime.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
